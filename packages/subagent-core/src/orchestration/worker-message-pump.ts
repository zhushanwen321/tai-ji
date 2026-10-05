/**
 * Workflow Extension — worker-message-pump（原 error-recovery，D5-① 更名）
 *
 * Worker 消息泵 free functions（D-12）。[D15]（workflow-run-resume-revision）
 * 后本文件薄化为「消息路由」单职责：
 * 1. 消息路由：handleWorkerMessage 分发 agent-call / return / error / log / phase
 * 2. IPC 序列化防御：postMessage 的 DataCloneError 拦截 + fallback 回发（W2）
 *
 * [ADR-0112] 失败显式上报：原「worker/script 错误指数退避重试 + rebuildRuntime
 * 整重建」重试矩阵已删——worker/script 错误一次即 finalizeRun done,failed 显式
 * 上报，修复由用户重新发起 run 承接（resume 通道按 record replay 已完成 call，
 * 不重复耗 token）。[HISTORICAL] 原 G3-001 整重建 / OR-2 回灌 / 退避测试通道
 * 随矩阵一并删除。
 *
 * 原 run 事件投递域（dispatchRunTrigger 单写者链 + 事件派发包装）与终态化域
 * （finalizeRun 五步 coda）已迁入 terminal-actions.ts（[D15] 终局编排单一入口，
 * 五路收敛——pump → terminal-actions 单向依赖，终态路径经彼处 coda 收敛）。
 *
 * 关键不变式：
 * - handleWorkerExit 检查 handle.isCurrent（G-025：stale exit 事件丢弃）。
 *
 * 层归属：Engine。依赖 ports + WorkflowRun + executeAgentCall + terminal-actions。
 */

import { getLogger } from "../core/logger.ts";

import { canonicalJsonHash } from "./canonical-json.ts";

import { resolveAgentOpts } from "./agent-opts-resolver.ts";
import { executeAgentCall } from "./execute-agent-call.ts";
import { AgentCall } from "./models/agent-call.ts";
import type { AgentRunner, LifecycleDeps, WorkerHandlers } from "./models/ports.ts";
// [D15] 投递域与终态编排自 terminal-actions 消费（单向依赖——pump 不再承载
// journal 单写者链与 finalizeRun，消息面终态路径全部经彼处 coda）。
import {
  dispatchAgentSettled,
  dispatchAgentSettledFailed,
  dispatchAgentStarted,
  dispatchPhaseSettled,
  dispatchPhaseStarted,
  isRunSettled,
  memberReusePoolIo,
  notePhaseDispatched,
  settlePhaseLedger,
} from "./terminal-actions.ts";
import { appendRunDiagnosticEvent, finalizeRun } from "./terminal-actions.ts";
import type { WorkerLogEntry } from "./models/types.ts";
import type {
  AgentCallOpts,
  AgentResult,
} from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkerHandle } from "./worker-handle.ts";
import { toErrorMessage } from "../core/error-message.ts";

const logger = getLogger("subagents");

import {
  MALFORMED_MSG_LOG_PREVIEW_CHARS,
  MAX_ERROR_LOGS,
  WORKER_EXITED_WITHOUT_RESULT_MSG,
} from "./worker-message-pump-constants.ts";

// ── Worker 消息类型（与 worker-script-builder.ts WorkerInMsg 对齐） ──

interface AgentCallMsg {
  type: "agent-call";
  callId: number;
  opts: {
    prompt: string;
    schema?: unknown;
    model?: string;
    scene?: string;
    description?: string;
    agent?: string;
    skill?: string;
    timeoutMs?: number;
    cwd?: string; // ADR-029 决策 1：per-call cwd（worktree 隔离）
  };
  phase?: string;
}

interface ReturnMsg {
  type: "return";
  result: unknown;
  workerLogs?: WorkerLogEntry[];
}

interface ErrorMsg {
  type: "error";
  error: string;
  workerLogs?: WorkerLogEntry[];
}

/** 脚本 log() 全局发出的独立诊断消息（协议见 worker-script-builder 头注释，OR-6）。 */
interface LogMsg {
  type: "log";
  phase?: string;
  message: string;
}

/** [D3] 脚本 phase() 切换消息（模板事件化——壳侧承接经 dispatchPhaseStarted 落 record）。 */
interface PhaseMsg {
  type: "phase";
  phase: string;
}

type WorkerMsg = AgentCallMsg | ReturnMsg | ErrorMsg | LogMsg | PhaseMsg;

// ── 内部 helper ──────────────────────────────────────────────

/**
 * 孤儿 call 判定：dispatch 时捕获的 call 实例是否已不是 calls Map 中该 callId
 * 的当前条目。
 *
 * 为何需要实例级比对（而非只查 run 状态）：既有的终态 stale 守卫拦不住旧代际的
 * 迟到 completion。只有新一代 dispatch（set 新实例）会改变「callId → 实例」映射，
 * 故实例不等 ⟺ 本 completion 属于被替换的旧代际（S7-second 竞态：旧失败结果经
 * postAgentResult 投给新 worker 的同 callId pending，劫持重跑调用为假失败/空串
 * 假成功）。[HISTORICAL] 原另一写点 discardInFlightCalls 的 delete 随重试矩阵删除
 * （ADR-0112），谓词保留为接管形态的防御面。
 *
 * 运行期 calls Map 写点为 dispatchAgentCall 的 set（jsonl-run-store 的 set 在离线
 * 重水合路径，无在飞 promise），正常（非孤儿）路径下实例恒等，无误判。
 */
function isOrphanedCall(run: WorkflowRun, callId: number, call: AgentCall): boolean {
  return run.state.calls.get(callId) !== call;
}

// ── [D3] phase 收束判定（phase-settled 的壳侧裁决面）─────────────
// 账本状态与记账原语（notePhaseDispatched / settlePhaseLedger / forgetPhaseSettlement
// / resetPhaseSettlementTrackerForTest）在 terminal-actions 投递域宿主侧——本侧
// 只保留消息路由消费（派发记账 + 收束判定落帧），见下方消费点。

// ── [U2] canonical JSON 工具（场景 13：schema 哈希稳定）─────────

// 实装与设计说明已抽至 ./canonical-json.ts（第二消费方 terminal-actions 的
// agent-started 入参落账出现后，工具留在本文件会形成 pump ↔ terminal-actions
// 反向 import 成环）。此处 re-export 维持既有 import 路径（测试与下游消费方
// 不变），语义与落位理由见该模块头注。
export { canonicalJsonStringify, canonicalJsonHash } from "./canonical-json.ts";

// ── handleWorkerMessage（消息路由） ──────────────────────────

/**
 * 路由 worker → main 的业务消息。
 *
 * agent-call → 派发 executeAgentCall（异步，不 await——立即返回让 worker 继续发消息）
 * return → finalizeRun done,completed（脚本正常返回；[D15] 经 terminal-actions coda）
 * error → handleScriptError（脚本主动抛错）
 * log → 计入 run.state.errorLogs + debug 留痕（[OR-6/T7④]）
 * phase → [D3] dispatchPhaseStarted 落 record（phase 状态机转移事件）
 * default → warn 留痕后丢弃（[OR-6/T7④] 协议漂移防线）
 *
 * 终态（done）下的 stale 消息丢弃（P0-1）。
 */
/** [handleWorkerMessage 拆分] 终态 stale 消息留痕丢弃（P0-1；type 自 raw 安全提取）。 */
function dropStaleWorkerMessage(run: WorkflowRun, raw: unknown): void {
  const type = typeof raw === "object" && raw !== null
    ? (raw as { type?: unknown }).type
    : null;
  logger.debug(
    `[workflow] stale worker message dropped on terminal run (runId=${run.runId}, type=${JSON.stringify(type)})`,
  );
}

/** [handleWorkerMessage 拆分] [F1] 标记本 runtime 代际已收到终态消息：WorkerHandle.isCurrent
 * 守卫保证消息必来自当前代际 worker。handleWorkerExit 的 exit(0) 无终态判定据此区分——
 * 「已交付但 run 仍 running」（script-error 重试退避窗口）不得误判 failed。 */
function markTerminalMessageDelivered(run: WorkflowRun): void {
  if (run.runtime) run.runtime.receivedTerminalMessage = true;
}

/** [handleWorkerMessage 拆分] [OR-6/T7④] 协议漂移防线：未知消息类型 warn 留痕后丢弃。
 * 畸形消息（M7 形状校验之上、已知类型之外的 type）此前静默穿过 switch——协议注释
 * 新增消息类型而主线程未接线时，这里提供可观测信号（而非零痕迹丢弃）。 */
function logUnknownWorkerMessageType(run: WorkflowRun, msg: WorkerMsg, deps: LifecycleDeps): void {
  logger.warn(
    `[workflow] unknown worker message type dropped (runId=${run.runId}): ` +
      `${JSON.stringify((msg as { type?: unknown }).type)}`,
  );
  deps.log?.("warn", "workflow:worker-message-pump", "unknown worker message type", {
    runId: run.runId,
    type: (msg as { type?: unknown }).type,
  });
}

export async function handleWorkerMessage(
  run: WorkflowRun,
  raw: unknown,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  // 终态（done）丢弃 stale 消息（P0-1）——[加固] debug 留痕（原静默 return）。
  if (isRunSettled(run)) {
    dropStaleWorkerMessage(run, raw);
    return;
  }

  // M7: 形状校验——防畸形 IPC 消息（worker 崩溃/发非对象）导致下游 TypeError
  if (typeof raw !== "object" || raw === null) return;
  const msg = raw as WorkerMsg;
  switch (msg.type) {
    case "agent-call":
      dispatchAgentCall(run, msg, deps);
      return;
    case "return":
      markTerminalMessageDelivered(run);
      await handleReturn(run, msg, deps);
      return;
    case "error":
      // M1: 传 handlers（rebuildRuntime 需要）
      markTerminalMessageDelivered(run);
      await handleScriptError(
        run,
        msg.error,
        msg.workerLogs ?? [],
        deps,
        handlers,
      );
      return;
    case "log":
      handleWorkerLog(run, msg, deps);
      return;
    case "phase":
      // [D3] phase() 切换消息：模板 postMessage 通道 → phase-started 转移事件落
      // record。postMessage 异步丢失窗口（worker 死于消息送达前）由 fold 自愈规则
      // 承接（agent-started 载荷的 phase 字段驱动 pending → running——转移事件缺失
      // 不判损坏）。
      if (typeof msg.phase === "string" && msg.phase !== "") {
        dispatchPhaseStarted(run, msg.phase);
      }
      return;
    default:
      logUnknownWorkerMessageType(run, msg, deps);
      return;
  }
}

/**
 * 消费 worker 的独立 log 消息（[OR-6/T7④] 主线程半边）。
 *
 * 计入 run.state.errorLogs（与 workerLogs 通路的 L9 追加/上限语义一致）+ deps.log
 * debug 留痕。终态守卫（isRunSettled）已由 handleWorkerMessage 前置——此处只管写入。
 */
/**
 * errorLogs 追加 + 诊断落账（[§2.1 errorLogs 持久化] ADR-0093）。
 *
 * 活体写入与落账的唯一单点：追加语义 + 尾部上限裁剪（`MAX_ERROR_LOGS`）与
 * `errorLogsFromEvents` 重建面同构；落账经 terminal-actions 的
 * `appendRunDiagnosticEvent`（journal 单写者纪律）。
 */
function appendErrorLogs(run: WorkflowRun, entries: readonly WorkerLogEntry[]): void {
  if (entries.length === 0) return;
  run.state.errorLogs.push(...entries);
  if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
    run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
  }
  for (const entry of entries) appendRunDiagnosticEvent(run.runId, entry);
}

function handleWorkerLog(run: WorkflowRun, msg: LogMsg, deps: LifecycleDeps): void {
  const message = typeof msg.message === "string" ? msg.message : String(msg.message);
  appendErrorLogs(run, [{ level: "log", message }]);
  deps.log?.("debug", "workflow:worker-message-pump", "worker log", {
    runId: run.runId,
    phase: msg.phase,
    message,
  });
}

/**
 * 派发 agent 调用：构建 AgentCall + trace 节点，异步触发 executeAgentCall。
 *
 * 异步触发（不 await）——立即返回，让 worker 能继续发后续 agent-call（parallel 场景）。
 * executeAgentCall 内部完成 markDone + trace.update。
 *
 * **C-3 修复**：executeAgentCall 经 dispatchCall 异步触发——原 gate.withSlot 包装已随
 * 并发门闩 gate 抽象删除（no-op），并发调度归 SubagentService ConcurrencyPool。
 *
 * **C-2 修复**：call 完成后检查 `budget.isExceeded` → abortRun(budget_limited)，
 * 终止整个 run。
 *
 * **stale 完成守卫（两层）**：completion 到达时——
 * 1. isRunSettled recheck：run 终止（abort/terminate）后到达的 call 完成不写
 *    run.state.calls / 不 postAgentResult（终态快照不被迟到结果污染）；
 * 2. 孤儿 call 实例比对（isOrphanedCall）：rebuildRuntime 后旧代际 dispatch 的
 *    completion 不投递。
 */
/**
 * M4: agent-call 消息 IPC 字段校验谓词——畸形（opts 非对象/缺失、callId 非数字、
 * prompt 缺失）= true。提取为谓词保持 dispatchAgentCall 主流程可读（圈复杂度门禁）。
 */
/**
 * agent-call 入参的 schema 形状检查（IPC 边界；调用方错误 = fail-fast 明确报错，
 * 不静默降级成文本调用）。
 *
 * 判定：undefined / null = 未提供（兼容动态脚本的 falsy 写法）；非对象（字符串 /
 * 数字 / 布尔等）与数组 = 调用方错误；其余对象放行（「无关键字 / 不可编译」的
 * schema 归子进程 structured-output 明确报错：no recognized keyword /
 * Invalid JSON Schema）。
 *
 * @returns 错误文案（含恢复指引）或 undefined（形状可接受）。
 */
function describeSchemaParamError(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    const hint = typeof raw === "string" ? " (a JSON string is not a schema — JSON.parse it first)" : "";
    return `Invalid schema param at the agent-call IPC boundary: expected a JSON Schema object, got ${typeof raw}${hint}. Recovery: pass an object schema, or omit schema to run in text mode; retrying the same call fails the same way.`;
  }
  if (Array.isArray(raw)) {
    return "Invalid schema param at the agent-call IPC boundary: expected a JSON Schema object, got an array. Recovery: pass an object schema, or omit schema to run in text mode; retrying the same call fails the same way.";
  }
  return undefined;
}

function isMalformedAgentCallMsg(msg: AgentCallMsg): boolean {
  return typeof msg.callId !== "number" || !Number.isFinite(msg.callId) ||
    typeof msg.opts !== "object" || msg.opts === null ||
    typeof msg.opts.prompt !== "string";
}

/**
 * [U2 校验增强] cached replay 命中的输入一致性判定（机制文档 D3 的可比形态收窄）：
 * 历史 call.opts 与本次消息 opts 经同一 resolveAgentOpts 管道规范化后做 canonical
 * JSON 哈希比对（管道对称消除 skill→skillPath / schema→appendSystemPrompt 的转换
 * 差异，canonical 键序消除 IPC/重建往返的形态漂移——场景 13 零误报）。
 *
 * 跳过比对（返回 false）的三形态——比对即假 mismatch：
 * 1. 占位 opts（resume/重水合重建的 call 无可比数据面时：旧格式 record 流的
 *    agent-started 帧不携带入参全文（input 载荷为 [U13] 补齐，写侧随本设计
 *    落地）——新帧有 input 的重建走 opts 恢复，比对正常执行）；
 * 2. 失败历史（cached.result.error 在场——失败也是真实历史结果，重跑不保证更对
 *    且机制文档 D5 裁决「含失败的 done 保留回放」）；
 * 3. 本次 resolve 失败（skill 丢失等——错误结果回放路径，非漂移信号）。
 */
function detectReplayInputMismatch(cached: AgentCall, currentRaw: AgentCallMsg["opts"]): boolean {
  // opts 缺省容错（mock/残缺形态）：无可比数据面即跳过比对
  if (cached.opts === undefined || cached.opts === null) return false;
  const recorded = cached.opts as unknown as Record<string, unknown>;
  const recordedKeys = Object.keys(recorded).filter((k) => recorded[k] !== undefined);
  if (cached.opts.prompt === "" && recordedKeys.length <= 1) return false; // 占位形态
  if (cached.result?.error !== undefined) return false; // 失败历史照放
  // schema 形状非法：本次调用已 done，回放照走历史结果，但不参与哈希比对——否则
  // 会被误报成「脚本非确定性漂移」；调用方错误在正常派发路径由 describeSchemaParamError
  // fail-fast 报出，此处只留痕。
  if (describeSchemaParamError(currentRaw.schema) !== undefined) {
    logger.warn(
      `[workflow] replay hit with a malformed schema param — skipping input comparison (callId=${cached.id})`,
    );
    return false;
  }
  const current = resolveAgentOpts({
    ...currentRaw,
    schema:
      currentRaw.schema === undefined || currentRaw.schema === null
        ? undefined
        : (currentRaw.schema as Record<string, unknown>),
  });
  if (current.error) return false; // 本次 resolve 失败——错误结果回放路径
  return canonicalJsonHash(cached.opts) !== canonicalJsonHash(current.opts);
}

/** [dispatchAgentCall 拆分] M4 畸形 agent-call 消息拒绝（不写 trace / 不建 call）。
 * [加固] callId 合法（worker 侧有对应 pending）时回发可克隆 error result 让 worker
 * 内 agent() pending 收敛（原仅日志 return = pending 永挂）；callId 非法无法定向
 * 回发，仅日志。 */
function rejectMalformedAgentCall(run: WorkflowRun, msg: AgentCallMsg): void {
  logger.error(`[workflow] malformed agent-call message: callId=${JSON.stringify(msg.callId)}, opts=${JSON.stringify(msg.opts)?.slice(0, MALFORMED_MSG_LOG_PREVIEW_CHARS)}`);
  if (typeof msg.callId === "number" && Number.isFinite(msg.callId)) {
    const dropped = "malformed message dropped: agent-call IPC fields invalid (worker/main module mismatch suspected)";
    postAgentResult(run, msg.callId, { content: "", error: dropped }, false);
  }
}

/**
 * [dispatchAgentCall 拆分] 已缓存调用（done 终态）的 replay 半边。返回 true =
 * 已处理（replay 回话或 mismatch 终局），调用方直接 return；false = 无 done
 * 缓存，走正常派发。
 *
 * [U2 校验增强] 可比形态下做 canonical JSON 输入一致性比对（机制文档 D3）：
 * 历史入参与本次调用入参哈希不一致 = 脚本非确定性漂移（Date.now()/外部 IO 进了
 * prompt）——静默命中错误结果继续跑违背「错了明说」，转 failed 终局（诊断含
 * callId 与恢复指引）。不可比形态（占位 opts / 失败历史 / resolve 失败）跳过
 * 比对——详见 detectReplayInputMismatch 注释（场景 13 的「零误报」约束）。
 */
function tryReplayCachedCall(run: WorkflowRun, msg: AgentCallMsg, deps: LifecycleDeps): boolean {
  const cached = run.state.calls.get(msg.callId);
  if (!cached || cached.status !== "done") return false;
  if (detectReplayInputMismatch(cached, msg.opts)) {
    const mismatch = `Resume replay input mismatch at call #${msg.callId}: the script produced a ` +
      `different input than the recorded call (nondeterministic source detected, e.g. Date.now()/` +
      `Math.random()/external IO in prompt construction). Recovery: make the script deterministic ` +
      `up to the resume point, then start a new run — the replayed prefix cost zero tokens.`;
    logger.error(`[workflow] ${mismatch} (runId=${run.runId})`);
    run.state.error = run.state.error ?? mismatch;
    // 终局处置：[D2] 状态机无 running → interrupted 的人工回退转移（机制文档
    // 「run 保持 interrupted」写于 terminal[interrupted] 旧形态）——按可行性形态
    // 收敛 failed 终局（不回话错误结果——worker pending 由 finalizeRun 内
    // releaseRuntime 的 terminate 收敛）。
    void finalizeRun(run, deps, "failed", { context: "replay input mismatch (resume)" }).catch(
      (err: unknown) => {
        logger.error(`[workflow] replay mismatch finalize failed: ${toErrorMessage(err)}`);
      },
    );
    return true;
  }
  postAgentResult(run, msg.callId, cached.result!, true);
  return true;
}

function dispatchAgentCall(
  run: WorkflowRun,
  msg: AgentCallMsg,
  deps: LifecycleDeps,
): void {
  // M4: IPC 字段校验——畸形 agent-call 消息不写 trace / 不建 call（worker/main 模块
  // 不匹配疑号）。
  if (isMalformedAgentCallMsg(msg)) {
    rejectMalformedAgentCall(run, msg);
    return;
  }

  // 已缓存的调用直接 replay（跨 rebuild / 跨 resume——崩溃重建或 resume 重跑脚本后，
  // 已完成调用按 callId 命中缓存零 token 回话）。
  if (tryReplayCachedCall(run, msg, deps)) return;

  // 构建 trace 节点（[H2 W3] trace.live 退役——实时进度改由 views 经 store 订阅）。
  const agentName = msg.opts.description ?? msg.opts.agent ?? "unknown";
  const now = new Date().toISOString();
  // 未显式指定 model 的展示口径。
  const model = msg.opts.model ?? "default";
  const node = {
    stepIndex: msg.callId,
    agent: agentName,
    task: msg.opts.prompt,
    model,
    status: "running" as const,
    phase: msg.phase,
    startedAt: now,
  };
  run.state.trace.append(node);

  // [D3] phase 收束账本记账（phase-settled 判定的派发半边；无 phase 归属的 call
  // 不入账——phase-settled 只对显式 phase 落账，空值守卫在 notePhaseDispatched 内）。
  notePhaseDispatched(run.runId, msg.phase);

  // 构建 AgentCall（opts 形状对齐 AgentCallOpts；schema: unknown → Record）
  // 跨进程 IPC 边界的 schema 为 unknown：非对象类型（字符串/数字/布尔/数组）是调用方
  // 错误，fail-fast 拒绝，不静默降级为文本调用——结果形态不得静默漂移；undefined /
  // null 视为「未提供」（兼容动态脚本的 falsy 写法）。schema 是对象但无关键字 /
  // 不可编译的情形归子进程 structured-output 明确报错（no recognized keyword /
  // Invalid JSON Schema）。
  const rawSchema = msg.opts.schema;
  const schemaParamError = describeSchemaParamError(rawSchema);
  const opts: AgentCallOpts = {
    ...msg.opts,
    schema:
      schemaParamError === undefined && rawSchema !== null && rawSchema !== undefined
        ? (rawSchema as Record<string, unknown>)
        : undefined,
  };

  // BL-1：解析 skill/schema → skillPath / appendSystemPrompt。
  // 解析失败（skill 未找到）或 schema 入参形状非法走 error 路径，不发 slot、不 spawn。
  const resolved = resolveAgentOpts(opts);
  const earlyError = schemaParamError ?? resolved.error;
  if (earlyError) {
    const call = new AgentCall(msg.callId, opts, node);
    call.markRunning();
    const errorResult: AgentResult = { content: "", error: earlyError };
    call.markDone(errorResult);
    run.state.calls.set(msg.callId, call);
    run.state.trace.update(msg.callId, {
      status: "failed",
      result: errorResult,
      completedAt: new Date().toISOString(),
    });
    // [P1b-1] agent-settled(failed) 落账（派发前置失败形态：attempt 恒 1）。result
    // 随帧携带（errorResult 同源——record 恢复读面拒绝缺 result 的 settled 帧）。
    dispatchAgentSettledFailed(run, msg.callId, errorResult);
    postAgentResult(run, msg.callId, errorResult, false);
    deps.store.save(run).catch((e: unknown) => {
      logger.error(`[workflow] store.save failed (resolveAgentOpts): ${toErrorMessage(e)}`);
    });
    return;
  }

  const call = new AgentCall(msg.callId, resolved.opts, node);
  run.state.calls.set(msg.callId, call);
  // [P1b-1] agent-started 落账（编排层事件源，D5 载荷表；taskIndex = callId 单源）。
  // phase 透传（[D3] call 归属快照）；memberRecordId 透传（[D6] 绑定字段化——
  // 续写帧携带既有成员 record id，首派缺省；绑定登记的真相面在 workflow-dispatch，
  // 此处从复用池活体缓存取值随帧落账，跨崩溃重建由 fold 消费本字段）；opts 落
  // 入参全文（设计 §3.1 载荷表 agent-started 行「入参」——canonical 序列化，
  // resume 重建回放集 call 的 opts 恢复源，detectReplayInputMismatch 比对由此可比）。
  const boundRecordId = lookupBoundRecordIdSync(run.runId, agentName);
  dispatchAgentStarted(run, msg.callId, agentName, msg.phase, boundRecordId, resolved.opts);

  // [GUI 步骤实时可见 2026-09-14] 启动即持久化（[D1] 后 save 为壳侧 no-op 契约，
  // 调用保留 = RunStore port 契约面）。火后模式与下方 .catch 同款。
  deps.store.save(run).catch((e: unknown) => {
    logger.error(`[workflow] store.save failed (dispatch trace stamp): ${toErrorMessage(e)}`);
  });

  // C-3：agent call 执行入口。executeAgentCall 管 retry/budget/stale-context；
  // runner（runner.run）管 spawn pi 子进程。
  const runtime = run.runtime!;
  const signal = runtime.controller.signal;
  // [H2 W3] 执行 port 切换（设计 §3.5 终态数据流）。未注入时（旧测试 deps）回退
  // deps.runner——生产装配恒注入 dispatch（extension index.ts makeDeps），回退分支
  // 生产不可达。
  const dispatch = deps.workflowAgentDispatch;
  // [W0 / D1] stepIndex = msg.callId（taskIndex 单源，与 agent-started 落账同源）。
  const innerRunner: AgentRunner = dispatch
    ? { run: (rOpts, rSignal) => dispatch(rOpts, run.runId, rSignal, msg.callId) }
    : deps.runner;
  // [ADR-0112] 无重试——runner 直用 innerRunner（原 agent-retrying 落账包装随
  // 重试矩阵删除；agent-retrying 事件类型保留为 journal 词表兼容，仅历史记录含此帧）。
  const runner: AgentRunner = innerRunner;
  // 原 gate.withSlot(fn, signal) 语义内联：pre-aborted 时 reject AbortError。
  const dispatchCall = async (): Promise<void> => {
    if (signal.aborted) {
      const abortErr = new Error("Operation aborted before start");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    // OB2（S7 残留）：isOrphaned 谓词注入——旧代际 finalize 在 trace.update 前被
    // 拦截。onEvent/stream 两实参显式 undefined 占位（[H2 W3] 位置参数不得前移）。
    await executeAgentCall(call, runner, run.state.budget, signal, run.state.trace, undefined, undefined, () => isOrphanedCall(run, msg.callId, call));
  };
  void dispatchCall()
    .then(() => {
      // run 终止（终态）后到达的 stale completion 不写 state。
      // [W2/V1] 终局判据换源 isRunSettled。
      if (isRunSettled(run)) return;
      // 孤儿 call 守卫（S7-second 竞态）：重跑 dispatch 已用新实例替换同 callId
      // 条目时，本 completion 属于旧代际——跳过投递 / budget 同步 / 持久化，仅留日志。
      if (isOrphanedCall(run, msg.callId, call)) {
        deps.log?.("debug", "workflow:worker-message-pump", "orphan agent call completion dropped", { runId: run.runId, callId: msg.callId });
        return;
      }
      if (call.result) postAgentResult(run, msg.callId, call.result, false);
      // [P1b-1] agent-settled 落账（引擎终态应答，D5 载荷表；置于 budget 终局检查
      // 之前——record 序 = agent-settled 先、budget 的 run-settled 后）。signal abort
      // = agent 粒度 cancelled。落账后进行 [D3] phase 收束判定（账本 settled 计数
      // 追平 dispatched 即落 phase-settled——先于 run-settled 帧，phase 收束语义
      // 先于 run 终局）。
      dispatchAgentSettled(run, call, signal.aborted);
      settlePhaseIfComplete(run, msg.phase);
      // D-12 regression fix (round-2 #1)：executeAgentCall 内 consume/incrementCallCount
      // 后同步 worker $BUDGET（否则 $BUDGET.spent()/remaining() 恒为 0）
      postBudgetUpdate(run);
      deps.store.save(run).catch((e: unknown) => {
        const m = toErrorMessage(e);
        logger.error(`[workflow] store.save failed (agent call ${msg.callId}): ${m}`);
      });

      // C-2：budget 超限 → 终止整个 run（避免继续 spawn 烧预算）
      // 内联 terminate（不调 lifecycle.abortRun 避免 engine 内循环依赖）：
      // finalizeRun 内含终局让位守卫。
      if (run.state.budget.isExceeded()) {
        run.state.error = run.state.error ?? "Budget exceeded";
        deps.log?.("debug", "workflow:worker-message-pump", "budget exceeded, finalizing run", { runId: run.runId });
        void finalizeRun(run, deps, "budget_limited", { context: "agent call budget done" });
      }
    })
    .catch((err: unknown) => {
      // pre-abort 检查（原 gate.withSlot 语义）在 dispatchCall 入口 reject AbortError——预期，不记错。
      if (err instanceof Error && err.name === "AbortError") return;
      const message = toErrorMessage(err);
      logger.error(`[workflow] agent call ${msg.callId} failed: ${message}`);
      // 兜底回发：executeAgentCall 抛非 Abort 异常时构造 failed AgentResult
      // postAgentResult 回 worker，让 pending Promise resolve（结果为 error），脚本
      // 可继续或失败退出。孤儿 call 守卫（与 .then 对称）：rebuild 后本 call 已被
      // discard 移除/替换——全部跳过。
      if (isOrphanedCall(run, msg.callId, call)) {
        deps.log?.("debug", "workflow:worker-message-pump", "orphan agent call failure dropped", { runId: run.runId, callId: msg.callId });
        return;
      }
      const errorResult: AgentResult = { content: "", error: message };
      // call 已 done（executeAgentCall 内 finalizeCall 已 markDone）时跳过，避免重复 markDone。
      if (call.status !== "done") {
        if (call.status === "pending") call.markRunning();
        call.markDone(errorResult);
      }
      // state 一致性三件套（与 resolveAgentOpts 失败 / .then 路径对等）：
      // trace 标 failed + 持久化（catch 恰是最需留证的场景）。
      run.state.trace.update(msg.callId, {
        status: "failed",
        result: errorResult,
        completedAt: new Date().toISOString(),
      });
      // [P1b-1] agent-settled(failed) 落账（executeAgentCall 兜底异常路径——非 Abort
      // 异常，aborted=false；终局尝试序号 = call.attempts）。
      dispatchAgentSettled(run, call, false);
      settlePhaseIfComplete(run, msg.phase);
      postAgentResult(run, msg.callId, errorResult, false);
      // S2: 与 .then 对称——catch 路径也同步 worker $BUDGET（幂等）
      postBudgetUpdate(run);
      deps.store.save(run).catch((e: unknown) => {
        logger.error(`[workflow] store.save failed (catch fallback): ${toErrorMessage(e)}`);
      });
    });
}

/**
 * [D6] 绑定字段读取（agent-started 载荷的 memberRecordId 供源）：同名 agent 的
 * 绑定真相面在 workflow-dispatch 登记链（registerMemberRecord），本读取经复用池
 * 活体缓存同步取值（首派/降级形态返回 undefined——字段缺省即首派语义）。同步形态
 * 限制：dispatchAgentCall 主链无 await 点，活体缓存命中即取、miss 不阻塞派发
 * （首派帧本就无绑定可携；降级空池的续写帧缺绑定字段由 fold 侧按「无绑定」消费，
 * 与 member-reuse-pool 的降级语义一致）。
 */
function lookupBoundRecordIdSync(runId: string, name: string): string | undefined {
  return peekMemberRecordId(runId, name, memberReusePoolIo);
}

/**
 * [D3] phase 收束判定与落账：该 phase 账本 settled 计数追平 dispatched 时落
 * phase-settled 帧并清账（账本与记账原语在 terminal-actions——settlePhaseLedger
 * 含空串守卫与无条目 false，语义同前：仅显式 phase 参与、无 phase 归属的 call
 * 落定不影响任何账本）。竞态说明：账本是过程内派发/落定序的镜像（同 runId 内
 * dispatchAgentCall 与其完成链天然按事件循环序推进），终局/中断路径不经此判定
 * （phase-settled 只在 running/settling 自环行合法——落账于 run-settled 之前的
 * 调用序构造性满足表内转移；让位形态（IllegalTransitionError）由 reportDispatchFailure
 * 的 debug 分支吸收）。
 */
function settlePhaseIfComplete(run: WorkflowRun, phase: string | undefined): void {
  if (phase === undefined || phase === "") return;
  if (settlePhaseLedger(run.runId, phase)) dispatchPhaseSettled(run, phase);
}

/**
 * postMessage 序列化失败时回发的 fallback result（必可克隆），让 worker pending resolve。
 *
 * prefix 参数由调用方传入（当前唯一消费方 postAgentResult 用 "Result serialization
 * failed" 前缀）；返回 shape `{content:"", error:"<prefix>: <errMsg>"}` 恒定。
 *
 * W2 防御关键纯函数——export 供独立单测（worker-message-pump-serialize-failed-result.test.ts）验证
 * 返回 shape。
 */
export function makeSerializeFailedResult(
  prefix: string,
  errMsg: string,
): { content: string; error: string } {
  return { content: "", error: `${prefix}: ${errMsg}` };
}

/**
 * 回发 agent-result 给 worker（worker 内 pending Promise 据此 resolve）。
 *
 * W2 主线程防御：result 是 agent 返回值，含不可克隆成员（function/Symbol/循环引用）时
 * postMessage 同步抛 DataCloneError。若冒泡到 dispatchAgentCall 的 .then 回调，会中断
 * 后续 postBudgetUpdate/store.save/budget 检查，run 卡在 running。故内部 try/catch：
 * 失败时记录诊断 + 回发纯字符串 fallback result（必可克隆），让 worker pending resolve。
 */
function postAgentResult(
  run: WorkflowRun,
  callId: number,
  result: AgentResult,
  cached: boolean,
): void {
  try {
    run.runtime?.worker.postMessage({ type: "agent-result", callId, result, cached });
  } catch (err) {
    const msg = toErrorMessage(err);
    logger.error(`[workflow] postAgentResult failed (callId=${callId}): ${msg}. Result likely contains non-cloneable value.`);
    // 回发纯字符串 fallback result（必可克隆），让 worker pending resolve（避免永久挂起）
    try {
      run.runtime?.worker.postMessage({
        type: "agent-result",
        callId,
        result: makeSerializeFailedResult("Result serialization failed", msg),
        // 原 result 不可克隆时 cached 透传原值含义失真（fallback result 非缓存命中）→ 固定 false
        cached: false,
      });
    } catch {
      // fallback 也失败——worker 此 callId 的 pending 只能靠 timeout/exit 兜底
      logger.error(`[workflow] postAgentResult fallback also failed (callId=${callId}): worker pending will hang until timeout`);
    }
  }
}

/**
 * 回发 budget-update 给 worker（$BUDGET 据 worker-script-builder 的 budget-update 分支
 * 更新 spent()/remaining()）。每次 agent 调用消费 usage 后发送，保持 worker 内 $BUDGET
 * 与主线程 Budget 值对象同步。
 */
export function postBudgetUpdate(run: WorkflowRun): void {
  try {
    run.runtime?.worker.postMessage({
      type: "budget-update",
      budget: {
        usedTokens: run.state.budget.usedTokens,
        usedCost: run.state.budget.usedCost,
      },
    });
  } catch (err) {
    const msg = toErrorMessage(err);
    // budget 是纯 number 不太可能失败，但防御性兜底——budget 同步非关键（worker 仍可
    // 基于 $BUDGET.spent() 自行累计），失败仅记日志，不中断调用方流程。
    logger.error(`[workflow] postBudgetUpdate failed: ${msg}. Budget sync to worker skipped (non-critical).`);
  }
}

/**
 * 处理脚本的 return 消息：finalizeRun done,completed + 持久化。
 */
async function handleReturn(
  run: WorkflowRun,
  msg: ReturnMsg,
  deps: LifecycleDeps,
): Promise<void> {
  deps.log?.("debug", "workflow:worker-message-pump", "handleReturn", { runId: run.runId });
  // 捕获 worker 诊断日志（P2-2）
  // L9: 追加而非覆盖——保留重试历史的诊断日志（各 worker 实例的 console 输出）
  if (msg.workerLogs && msg.workerLogs.length > 0) {
    appendErrorLogs(run, msg.workerLogs);
  }
  run.state.scriptResult = msg.result;
  // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  // （[D15] coda 收敛为 terminal-actions.finalizeRun 单写点，含 SW-DATA-3 save 兜底）
  await finalizeRun(run, deps, "completed", { context: "handleReturn (done,completed)" });
}

// ── handleWorkerError ────────────────────────────────────────

/**
 * 处理 worker 线程 uncaught error（ADR-0112：一次即终态，无自动重建）。
 *
 * worker 崩溃 → finalizeRun done,failed 显式上报（错误信息含 err.message）；
 * 修复由用户重新发起 run 承接（resume 通道按 record replay 已完成 call）。
 *
 * [R4-F1] 同代际幂等：复用 receivedTerminalMessage 代际标志（见函数体注释）——
 * worker 崩溃时 error + exit(1) 双事件只处理一次（第二个事件直接跳过）。
 *
 * @throws 不抛错——所有失败路径转 transition 或日志
 */
export async function handleWorkerError(
  run: WorkflowRun,
  err: Error,
  deps: LifecycleDeps,
  _handlers: WorkerHandlers,
): Promise<void> {
  // 与 handleWorkerMessage 对称——终态（done）丢弃 stale error。[加固] debug 留痕。
  if (isRunSettled(run)) {
    logger.debug(
      `[workflow] stale worker error dropped on terminal run (runId=${run.runId}, event=worker-error, message=${JSON.stringify(err.message)})`,
    );
    return;
  }

  // [R4-F1] 同代际幂等守卫：worker 崩溃时 error + exit(1) 双事件各派发一次
  // handleWorkerError（onError 先到，exit 非 0 经 handleWorkerExit 委托二次到达）。
  // 复用 receivedTerminalMessage 代际标志：进入处理前置 true 标记「本代际已有
  // error/terminal 处理」，第二个事件命中标志直接跳过。
  if (run.runtime?.receivedTerminalMessage) return;
  if (run.runtime) run.runtime.receivedTerminalMessage = true;

  run.state.error = err.message;
  deps.log?.("debug", "workflow:worker-message-pump", "worker error, finalizing run", { runId: run.runId });
  await finalizeRun(run, deps, "failed", { context: "handleWorkerError (done,failed)" });
}

// ── handleWorkerExit ─────────────────────────────────────────

/**
 * 处理 worker 线程 exit。
 *
 * code === 0：
 * - 本代际已收到终态消息（return/error）→ no-op（正常收尾退出）
 * - 本代际未收到任何终态消息 → [F1] 转 done,failed（WORKER_EXITED_WITHOUT_RESULT_MSG）。
 * code !== 0 → 委托 handleWorkerError（非零 exit 视为崩溃，一次即 done,failed，ADR-0112）
 *
 * **G-025 竞态防护**：检查 handle.isCurrent——stale exit 事件（已 terminate 的旧
 * worker 的 exit）直接丢弃，不影响当前 runtime 的新 worker。
 */
export async function handleWorkerExit(
  run: WorkflowRun,
  code: number,
  handle: WorkerHandle,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
  // G-025: stale exit 事件丢弃（handle 已不是当前 runtime 的 worker）——[加固] debug
  // 留痕（原静默 return，丢弃不可观测）。
  if (!handle.isCurrent) {
    logger.debug(
      `[workflow] stale worker exit dropped (runId=${run.runId}, event=worker-exit, code=${code}, handle not current generation)`,
    );
    return;
  }
  if (isRunSettled(run)) {
    logger.debug(
      `[workflow] stale worker exit dropped on terminal run (runId=${run.runId}, event=worker-exit, code=${code})`,
    );
    return;
  }

  if (code === 0) {
    // 本代际已交付终态消息 → 正常收尾，no-op
    if (run.runtime?.receivedTerminalMessage) return;

    // [F1] 无终态消息的 exit(0) = worker 静默退出（不可克隆 return 被吞 / 脚本直调
    // process.exit(0) 等）。置 failed 保证 run 必有终态（显式归因，不重跑）。
    deps.log?.("debug", "workflow:worker-message-pump", "worker exited without terminal message, finalizing run", { runId: run.runId });
    run.state.error = WORKER_EXITED_WITHOUT_RESULT_MSG;
    await finalizeRun(run, deps, "failed", { context: "handleWorkerExit (done,failed, no terminal message)" });
    return;
  }

  // 非零 exit → 委托 handleWorkerError（C.3: onExit 传 handle 用于竞态防护）
  await handleWorkerError(
    run,
    new Error(`Worker exited with code ${code}`),
    deps,
    handlers,
  );
}

// ── handleScriptError ────────────────────────────────────────

/**
 * 处理脚本主动抛出的 error（type:"error" from worker）。
 *
 * ADR-0112：一次即 finalizeRun done,failed 显式上报（脚本错误重跑同输入同结果，
 * 无自动重建）；修复由用户改脚本后重新发起 run 承接。
 *
 * @param workerLogs worker console.* 捕获（P2-2，存 run.state.errorLogs 供 TUI 展示）
 */
export async function handleScriptError(
  run: WorkflowRun,
  errorMsg: string,
  workerLogs: WorkerLogEntry[],
  deps: LifecycleDeps,
  _handlers: WorkerHandlers,
): Promise<void> {
  // 与 handleWorkerMessage/handleWorkerError 对称——终态守卫前置。
  if (isRunSettled(run)) return;

  // P2-2: 捕获 worker 诊断日志
  // L9: 追加而非覆盖
  if (workerLogs.length > 0) {
    appendErrorLogs(run, workerLogs);
  }

  run.state.error = errorMsg;
  deps.log?.("debug", "workflow:worker-message-pump", "script error, finalizing run", { runId: run.runId });
  await finalizeRun(run, deps, "failed", { context: "handleScriptError (done,failed)" });
}

// ── [D6] 复用池活体缓存的同步读取面 ─────────────────────────

import { peekMemberRecordId } from "../execution/service/member-reuse-pool.ts";
