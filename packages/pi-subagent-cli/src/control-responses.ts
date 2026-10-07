// src/control-responses.ts
//
// [subagent-model-switch §7.3] setModel 子进程控制面通路（引擎进程级，run 生命周期外）：
//   ① 控制命令应答等待表（进程级「请求 id → settle」）；
//   ② setModelOnActiveChild 转发编排（定位活跃子进程 → stdin `set_model` → 读应答 →
//      `get_state` 回读生效值 → 原始结局上浮；错误码映射归 pi-engine）。
//
// 背景：子进程 stdout 的 response 帧由 per-run 的 spawn-run-pump 消费，身份回填走
// SessionIdentityTracker 的 per-run 监听表——setModel 是 run 生命周期外的控制面操作
// （引擎进程收到协议 setModel 请求时，目标子进程的 run 早已在 pump 内自转），需要
// 一张**进程级**等待表承接同一些 response 帧（分发接线 = spawn-run-pump response
// 分支的 dispatchControlResponse 调用，与 per-run 表并行，各按 id 一次性消费）。
//
// 落点说明：编排在本模块而非 spawn-runner.ts——spawn-runner 职责 = spawn 执行与 run
// 生命周期，模型热切控制面与其正交（移入即越该文件 max-lines 上限）；接线原语全部
// 复用：stdin-writer sendSetModelCommand / sendGetStateCommand（帧组装在 pi-rpc
// buildSetModelCommandFrame）+ active-children 活跃子进程记账表。
//
// 竞态窗口语义（设计 §7.3）：命令与回读全程带存活检查，四个窗口（定位时 / 命令写入 /
// 读应答 / 回读）内发现子进程退出 → 「无活进程」结局（宿主按记账型应答）；进程存活
// 但超时无应答 → 回读失败结局（宿主按 engine_state_readback_failed 应答）——两种
// 处置严格互斥不可混淆。

import type { ChildProcess } from "node:child_process";

import { SET_MODEL_STAGE_TIMEOUT_MS, type ModelRef } from "@zhushanwen/subagent-engine-sdk";

import { getActiveChild } from "./active-children.ts";
import { sendGetStateCommand, sendSetModelCommand } from "./stdin-writer.ts";

// ============================================================
// ① 控制命令应答等待表
// ============================================================

/** 控制命令等待的结局（response / 子进程退出 / 阶段超时三出口，调用方分派）。 */
export type ControlResponseOutcome =
  | { kind: "response"; success: boolean; data: unknown; error: string | undefined }
  | { kind: "child-exited" }
  | { kind: "timeout" };

/** 进程级等待表：请求 id → settle（一次性消费）。 */
const pending = new Map<string, (outcome: ControlResponseOutcome) => void>();

/**
 * 登记等待并等该请求 id 的 response 帧（或子进程退出 / 超时，先到先收敛）。
 *
 * 调用契约：同一 tick 内已向同一 child 的 stdin 写入携带 requestId 的命令（本表
 * 不负责发送——见 stdin-writer 的 sendSetModelCommand / sendGetStateCommand）。
 * 注册时序安全性：stdin.write 同步 + 本表登记同步（同一 tick），stdout data 事件
 * 最早也要下一个 tick 才投递——不存在「应答先于登记到达」的窗口。
 * 收敛唯一出口 settle 幂等：response / close / error / timeout 四条入口竞争，
 * 首到生效，其余清理后丢弃（timer 反注册 + 监听摘除 + 表项删除一次完成）。
 * close 与 error 都按「子进程退出」收敛（error = spawn 失败，子进程从未运行——
 * 对控制面同样是「无活进程」语义）。
 */
export function awaitControlResponse(
  child: ChildProcess,
  requestId: string,
  timeoutMs: number,
): Promise<ControlResponseOutcome> {
  return new Promise<ControlResponseOutcome>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    function settle(outcome: ControlResponseOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      pending.delete(requestId);
      resolve(outcome);
    }
    function onClose(): void {
      settle({ kind: "child-exited" });
    }
    function onError(): void {
      settle({ kind: "child-exited" });
    }

    pending.set(requestId, settle);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

/**
 * response 帧分发（spawn-run-pump 的 line consumer 在 response 分支调用，与
 * per-run 的 identity.dispatchStateResponse 并行——两表按 id 各自一次性消费，互不
 * 干扰：本表未登记的 id 自弃）。id 缺席（畸形帧）同样自弃。
 */
export function dispatchControlResponse(
  id: string | undefined,
  success: boolean,
  data: unknown,
  error: string | undefined,
): void {
  if (id === undefined) return;
  const settle = pending.get(id);
  if (settle === undefined) return;
  settle({ kind: "response", success, data, error });
}

// ============================================================
// ② setModel 转发编排
// ============================================================

/**
 * setModel 转发的原始结局（引擎进程内的分派形态；错误码映射归 pi-engine——本模块
 * 只认「发生了什么」，不认协议词表）。五支与设计 §7.3/§7.5 的处置行一一对应：
 *   - switched：set_model 成功且 get_state 回读到手（生效值 = 回读值，非命令应答转述）；
 *   - not-active：定位 / 命令写入 / 读应答 / 回读四个竞态窗口内任一时点发现子进程
 *     已死（§7.5「子进程已退出」行——四窗口同一处置，无活进程形态）；
 *   - model-not-in-snapshot：pi 快照查找失败（快照冻结于 spawn 时刻，模型本身有效）；
 *   - credential-missing：pi checkAuth 失败（宿主预检通过后 registry 态漂移的权威兜底）；
 *   - readback-failed：进程存活但读应答 / get_state 回读超时无回执、生效值未知
 *     （§7.5「回读失败」行——与无活进程形态严格互斥）。
 */
export type SetModelForwardOutcome =
  | { kind: "switched"; effectiveModel: ModelRef; effectiveThinkingLevel: string }
  | { kind: "not-active" }
  | { kind: "model-not-in-snapshot"; detail: string }
  | { kind: "credential-missing"; detail: string }
  | { kind: "readback-failed"; stage: "set-model-response" | "state-readback"; detail: string };

/** 子进程存活判定（控制面各阶段检查共用）：pid 在场且 exit/signal 均未发生。 */
function isChildAlive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/** 错误文本归一（空/缺省 → fallback 文案；两阶段失败 detail 共用）。 */
function errorTextOr(error: string | undefined, fallback: string): string {
  return error !== undefined && error !== "" ? error : fallback;
}

/**
 * set_model 错误应答 → 转发结局分派。pi 实装的两条已知失败路径（1.0.0 实装探针
 * P1-②：快照查找 `Model not found: <p>/<id>`；session.setModel checkAuth
 * `No API key for <p>/<id>`——两错误经 rpc-mode 外层 catch 以 response success:false
 * + error 文本到达）按设计 §7.5 映射；快照查找与 checkAuth 之外的残余消息 = pi
 * 内部异常，生效状态不可信——按回读失败形态收口（三型词表封闭映射：宿主处置 =
 * 错误应答 + 重试恢复，不虚构生效值）。checkAuth 词形是本分型的承重前提，已登记
 * docs/pi-semantics.json PS-75（pi bump 门禁重验集——pi 词形漂移时先同步本分型前缀）。
 */
function classifySetModelFailure(error: string | undefined): SetModelForwardOutcome {
  const detail = errorTextOr(error, "set_model failed without an error message");
  if (detail.startsWith("Model not found")) return { kind: "model-not-in-snapshot", detail };
  if (detail.startsWith("No API key")) return { kind: "credential-missing", detail };
  return { kind: "readback-failed", stage: "set-model-response", detail };
}

/**
 * 单阶段等待结局（等待窗三分诊后的收敛形态：无活进程 / 回读失败 / 应答在手——
 * 前两支即 SetModelForwardOutcome 的同形成员，调用方原样上浮）。
 */
type StageAckOutcome =
  | { kind: "not-active" }
  | { kind: "readback-failed"; stage: "set-model-response" | "state-readback"; detail: string }
  | { kind: "response"; success: boolean; data: unknown; error: string | undefined };

/**
 * 单阶段控制应答等待 + 退出/超时三分诊（③ 读应答窗与 ⑤ 回读窗共用）：子进程退出 →
 * 无活进程；超时且仍存活 → 回读失败（stage + commandLabel 定语区分两阶段文案）；
 * 超时窗内已退出 → 无活进程。「退出」与「超时」两种结局严格互斥，不混淆。
 */
async function awaitStageAck(
  child: ChildProcess,
  requestId: string,
  stage: "set-model-response" | "state-readback",
  commandLabel: string,
): Promise<StageAckOutcome> {
  const ack = await awaitControlResponse(child, requestId, SET_MODEL_STAGE_TIMEOUT_MS);
  if (ack.kind === "child-exited") return { kind: "not-active" };
  if (ack.kind === "timeout") {
    return isChildAlive(child)
      ? {
        kind: "readback-failed",
        stage,
        detail: `${commandLabel} not received within ${SET_MODEL_STAGE_TIMEOUT_MS}ms (child alive)`,
      }
      : { kind: "not-active" };
  }
  return { kind: "response", success: ack.success, data: ack.data, error: ack.error };
}

/**
 * get_state 应答 data（pi RpcSessionState）→ 生效模型与档位提取（提取规则单一来源；
 * model 形状 = pi Model 对象 `{provider, id, ...}`——pi 快照条目自报，缺任一字段
 * 视为状态不完整，由调用方按回读失败处置）。
 */
function extractPiStateSnapshot(data: unknown): {
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
} {
  const out: { modelProvider?: string; modelId?: string; thinkingLevel?: string } = {};
  if (data === null || typeof data !== "object") return out;
  const d = data as Record<string, unknown>;
  const model = d["model"];
  if (model !== null && typeof model === "object") {
    const m = model as Record<string, unknown>;
    if (typeof m["provider"] === "string") out.modelProvider = m["provider"];
    if (typeof m["id"] === "string") out.modelId = m["id"];
  }
  if (typeof d["thinkingLevel"] === "string") out.thinkingLevel = d["thinkingLevel"];
  return out;
}

/**
 * [subagent-model-switch §7.3] setModel 引擎侧通路：定位活跃子进程（runId =
 * registerActiveChild 的 recordId 锚）→ stdin 写一条 `set_model` 命令（pi-rpc
 * buildSetModelCommandFrame 组帧，stdin-writer 既有原语裸写）→ 读应答 →
 * `get_state` 回读生效模型与 thinkingLevel（不信 set_model 应答即真——pi 快照
 * 条目是意图回显非生效值，探针 P1-⑤）→ 结局上浮。
 *
 * 竞态窗口全覆盖（设计 §7.3）：命令与回读全程带存活检查——①定位时 ②命令写入
 * （投递判别式，stdin 死 = 进程死）③读应答等待 ④回读前复检 ⑤回读等待——任一
 * 时点发现退出即按「无活进程」形态收口；单阶段等待超时（SET_MODEL_STAGE_TIMEOUT_MS，
 * 秒级控制面单请求粒度，锚 CANCEL_SETTLE_GRACE_MS 量级）且进程仍存活才落回读
 * 失败形态——「退出」与「超时」两种结局严格互斥，不混淆。不悬挂（每阶段有界）、
 * 不部分生效（pi 侧 set_model 是原子命令，失败即未切换）。
 *
 * 档位语义：pi set_model 无档位参数，热切档位由 pi 按新模型档位表联动重设（设计
 * §6.4——热切档位以联动值为生效事实，生效值经 get_state 回读应答宿主；用户显式
 * 档位经覆盖记账在下一轮 spawn 由解析链裁决，跨轮边界档位以解析链为准）。
 */
/**
 * ⑤ get_state 回读生效状态（回读前复检 + 回读窗 + 快照完整性检查；set_model 成功后
 * 的回读段独立成段——与读应答窗共用 awaitStageAck 三分诊）。
 */
async function readbackEffectiveState(child: ChildProcess): Promise<SetModelForwardOutcome> {
  // ④ 回读前复检（set_model 成功后、get_state 写入前的间隙退出 = 回读期间退出窗口）
  if (!isChildAlive(child) || child.stdin === null || child.stdin === undefined || child.stdin.destroyed) {
    return { kind: "not-active" };
  }

  // ⑤ get_state 回读（回读窗口；get_state 投递失败路径由 close 收敛或超时存活复检兜住）
  const stateRequestId = sendGetStateCommand(child);
  const stateAck = await awaitStageAck(child, stateRequestId, "state-readback", "get_state readback");
  if (stateAck.kind !== "response") return stateAck;
  if (!stateAck.success) {
    return {
      kind: "readback-failed",
      stage: "state-readback",
      detail: errorTextOr(stateAck.error, "get_state failed without an error message"),
    };
  }
  const snapshot = extractPiStateSnapshot(stateAck.data);
  if (
    snapshot.modelProvider === undefined ||
    snapshot.modelId === undefined ||
    snapshot.thinkingLevel === undefined
  ) {
    return {
      kind: "readback-failed",
      stage: "state-readback",
      detail: "get_state returned without a complete model/thinkingLevel state",
    };
  }
  return {
    kind: "switched",
    effectiveModel: { provider: snapshot.modelProvider, modelId: snapshot.modelId },
    effectiveThinkingLevel: snapshot.thinkingLevel,
  };
}

export async function setModelOnActiveChild(
  runId: string,
  model: ModelRef,
): Promise<SetModelForwardOutcome> {
  // ① 定位（定位时已退出 → 无活进程）
  const child = getActiveChild(runId);
  if (child === undefined || !isChildAlive(child)) return { kind: "not-active" };

  // ② 命令写入（写入窗口退出——stdin 缺失/已毁/EPIPE 均为无活形态）
  const sent = sendSetModelCommand(child, { provider: model.provider, modelId: model.modelId });
  if (!sent.delivered) return { kind: "not-active" };

  // ③ 读应答（读应答窗口：退出 → 无活进程；超时且仍存活 → 回读失败——两结局互斥）
  const ack = await awaitStageAck(child, sent.requestId, "set-model-response", "set_model response");
  if (ack.kind !== "response") return ack;
  if (!ack.success) return classifySetModelFailure(ack.error);

  // ④⑤ 回读前复检 + get_state 回读（readbackEffectiveState）
  return readbackEffectiveState(child);
}
