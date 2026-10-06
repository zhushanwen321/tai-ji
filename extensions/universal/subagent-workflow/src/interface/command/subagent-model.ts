// src/interface/command/subagent-model.ts
//
// /subagent-model 命令——subagent/workflow run 执行模型切换的宿主触达通道消费端
// （subagent-model-switch §7.1.1 通道，U6）。内部 RPC 命令：runtime 网关适配器经
// client.prompt("/subagent-model <单行JSON>") 短路本 handler（不经主 agent LLM，
// pi _tryExecuteExtensionCommand 主路径对 / 前缀先行执行）。
//
// 通道契约（§7.1.1 四要素）：
// - 载荷 = 单行 JSON {requestId, recordId?|runId?, provider, modelId, thinkingLevel?}；
// - 执行 = 本进程直调宿主 setModel 编排（service.setModel，§7.2 单一三步）；
// - 回执 = 一切结果（SetModelReply 三 scope / 错误 envelope）写结果文件
//   `<subagent 数据根>/model-switch/<requestId>.json` 后正常返回——**全程不抛**；
//   runtime 出站点在 handler 返回后读文件一次（写后读，无轮询无监视）。
// - 结果文件承载 core SetModelReply 形状（scope 判别）——extension 不依赖
//   @taiji/shared，wire 三形态映射归 runtime 适配器（依赖方向的唯一合法位置）。
//
// TUI 分支不存在：本命令是 GUI 通道专用内部命令，非交互入口（照 /subagents RPC
// verb 的 GUI 屏蔽先例，TUI 手敲仅得指引提示）。

import * as path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  ENV_ROOT_CWD,
  getSubagentModelSwitchResultsDir,
  getSubagentService,
  writeAtomicFileSync,
} from "@zhushanwen/subagent-core";
import type { ModelSwitchTarget, SetModelReply } from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

const logger = getLogger("subagents");

/**
 * requestId 文件名白名单：`[\w-]{1,128}`（与 core record id 白名单同式——防路径穿越；
 * 生产源 = runtime randomUUID，字符集 ⊆ 白名单，本式仅防御畸形通道输入）。
 */
const REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

/** 错误 envelope 形状（结果文件内的失败承载；code 值域 = 本文件错误分型常量族）。
 *  scope: "error" = 网关 mapResultFileToWireReply 的分派判别键（D3-A4 缺陷修复：
 *  缺 scope 时域内失败被「scope 未知」通道错误吞掉，真实 code/recovery 丢失）。 */
interface SubagentModelEnvelope { // oe-exempt:20261006:framework:通道结果信封契约形状（单命令单载体，单实现常态）
  scope: "error";
  error: { code: string; message: string; recovery: string };
}

/** /subagent-model 命令的依赖注入面（注册点装配生产实现，单测注入桩）。 */
export interface SubagentModelCommandDeps { // oe-exempt:20261006:framework:命令 handler 依赖注入面（注册点装配，单实现常态）
  /** 宿主 setModel 编排单例（session_start 前 null——envelope 分型承接）。 */
  getService: () => ReturnType<typeof getSubagentService>;
  /** agentDir 锚（pi SDK 活源，与 session-lifecycle 装配同源）。 */
  resolveAgentDir: () => string;
  /** 树根主 cwd（session-baselines rootCwd 同式推导，见 registerSubagentModelCommand）。 */
  resolveRootCwd: () => string;
}

/** 载荷解析三态（显式判别：无 requestId = 无法命名结果文件，与字段校验失败分流）。 */
type ParsedPayload =
  | { ok: true; requestId: string; payload: SubagentModelPayload }
  | { ok: false; requestIdMissing: true }
  | { ok: false; requestIdMissing: false; requestId: string; validationMessage: string };

/** 载荷结构（wire 契约 §7.1.1：recordId/runId 二选一，provider/modelId 必填）。
 *  字段经逐项 typeof 抽取组装（JSON 边界不落地 unknown 断言）。 */
interface SubagentModelPayload { // oe-exempt:20261006:framework:通道载荷契约形状（单命令单载体，单实现常态）
  requestId: string;
  recordId?: string;
  runId?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/** 非空字符串字段抽取（undefined = 缺失或类型不符，二者同判缺失）。 */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * 解析单行 JSON 载荷（§7.1.1 要素 1）。requestId 缺失/非法 → requestIdMissing（无法
 * 命名结果文件，本侧零回执——runtime 出站点超时路径承接通道失败，仅日志留痕）；
 * 其余字段校验失败在 requestId 在场时落 envelope（invalid_payload 分型）。
 */
function parsePayload(argsStr: string): ParsedPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(argsStr.trim());
  } catch {
    return { ok: false, requestIdMissing: true };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, requestIdMissing: true };
  const obj = raw as Record<string, unknown>;
  const requestId = nonEmptyString(obj.requestId);
  if (requestId === undefined || !REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, requestIdMissing: true };
  }
  const payload: SubagentModelPayload = {
    requestId,
    recordId: nonEmptyString(obj.recordId),
    runId: nonEmptyString(obj.runId),
    provider: nonEmptyString(obj.provider),
    modelId: nonEmptyString(obj.modelId),
    thinkingLevel: nonEmptyString(obj.thinkingLevel),
  };
  const validationMessage = validatePayload(payload);
  if (validationMessage !== undefined) {
    return { ok: false, requestIdMissing: false, requestId, validationMessage };
  }
  return { ok: true, requestId, payload };
}

/** 载荷字段校验（requestId 之外的域内畸形 → envelope invalid_payload 的 message 文案）。 */
function validatePayload(payload: SubagentModelPayload): string | undefined {
  if ((payload.recordId !== undefined) === (payload.runId !== undefined)) {
    return "payload 需要 recordId（chat 域）或 runId（workflow run 级）二选一";
  }
  if (payload.provider === undefined) {
    return "payload 缺 provider（canonical ref 的 provider 段）";
  }
  if (payload.modelId === undefined) {
    return "payload 缺 modelId（canonical ref 的 modelId 段）";
  }
  return undefined;
}

/**
 * 结果文件写入（唯一出站原语，永不抛）：writeAtomicFileSync（tmp+rename，防 runtime
 * 读到半文件）+ 目录递归建。写失败 = 通道回执丢失（runtime 超时路径承接），日志留痕。
 */
function writeResultFile(resultsFile: string, content: string): void {
  try {
    writeAtomicFileSync(resultsFile, content);
  } catch (err) {
    logger.warn(`[subagent-model] result file write failed (runtime will report channel timeout): ${toErrorMessage(err)}`, {
      resultsFile,
    });
  }
}

/** 提取引擎分型错误码（EngineError 载荷 .code——分型值域校验交由 runtime 侧）。 */
function errorCodeOf(err: unknown): string | undefined {
  // `in` 收窄（TS 4.9+）：Error & Record<"code", unknown>，零断言读载荷。
  if (!(err instanceof Error) || !("code" in err)) return undefined;
  const code: unknown = err.code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * RPC 执行体（§7.1.1 要素 2）：payload 校验 → 宿主 setModel → 结果文件。
 * **全程不抛**——一切异常 catch 后落错误 envelope；校验失败同落 envelope。
 */
export async function runSubagentModelRpc(
  deps: SubagentModelCommandDeps,
  argsStr: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parsePayload(argsStr);
  if (!parsed.ok) {
    if (parsed.requestIdMissing) {
      // requestId 不可用 = 无关联回执面：日志留痕即可，runtime 超时按通道失败应答
      //（结果文件名 = requestId，载荷缺失时本侧无从落文件）。
      logger.warn("[subagent-model] payload unparseable or requestId missing — no result file, runtime timeout path will report");
      ctx.ui.notify("/subagent-model payload requires requestId — request dropped", "warning");
      return;
    }
    // requestId 在场 + 字段校验失败：envelope 落盘（invalid_payload 分型）。
    const invalidFile = path.join(
      getSubagentModelSwitchResultsDir(deps.resolveAgentDir(), deps.resolveRootCwd()),
      `${parsed.requestId}.json`,
    );
    writeResultFile(
      invalidFile,
      JSON.stringify({
        scope: "error",
        error: {
          code: "invalid_payload",
          message: parsed.validationMessage,
          recovery: "修正 subagent.setModel 载荷后重试（runtime 协议面问题，正常使用不可达）",
        },
      } satisfies SubagentModelEnvelope),
    );
    return;
  }
  const { requestId, payload } = parsed;
  const resultsFile = path.join(
    getSubagentModelSwitchResultsDir(deps.resolveAgentDir(), deps.resolveRootCwd()),
    `${requestId}.json`,
  );

  try {
    const service = deps.getService();
    if (!service) {
      writeResultFile(
        resultsFile,
        JSON.stringify({
          scope: "error",
          error: {
            code: "subagent_runtime_not_ready",
            message: "subagent 执行运行时未就绪（session 未启动或已 dispose）",
            recovery: "先在该会话派发一条消息启动 subagent 运行时，再重试切换",
          },
        } satisfies SubagentModelEnvelope),
      );
      return;
    }

    // 目标组装（§6.1 作用域分流）：recordId → chat 域（getRecordForAction 同 message/close
    // 的统一入口——含归属校验与冷查）；runId → run 级（终局/成员清单校验在编排步骤①）。
    let target: ModelSwitchTarget;
    if (typeof payload.recordId === "string") {
      target = { domain: "chat", record: service.chatActions.getRecordForAction(payload.recordId) };
    } else {
      target = { domain: "workflow-run", runId: payload.runId as string };
    }

    const thinkingLevel = payload.thinkingLevel as string | undefined;
    const reply: SetModelReply = await service.setModel(
      target,
      { provider: payload.provider as string, modelId: payload.modelId as string },
      thinkingLevel,
    );
    // 应答三 scope 原样落文件（scope 判别由 runtime 适配器消费——core 形状是唯一权威）。
    writeResultFile(resultsFile, JSON.stringify(reply));
  } catch (err) {
    // §7.5 通道行同族语义：handler 域内失败如实落 envelope（生效状态未知不虚构——
    // 消息携带宿主编排错误原文，恢复动作照通道行）。
    writeResultFile(
      resultsFile,
      JSON.stringify({
        scope: "error",
        error: {
          code: errorCodeOf(err) ?? "subagent_model_switch_failed",
          message: toErrorMessage(err),
          recovery: "重试切换（覆盖替换幂等）；当前生效状态以面板与记录链为准",
        },
      } satisfies SubagentModelEnvelope),
    );
  }
}

/** 注册 /subagent-model 命令（内部 RPC 通道，taiji GUI 专用）。 */
export function registerSubagentModelCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagent-model", {
    description: "Internal RPC: switch subagent/workflow-run model (single-line JSON payload)",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "rpc") {
        ctx.ui.notify("/subagent-model is an internal taiji GUI channel — switch models from the subagent panel", "warning");
        return;
      }
      // rootCwd 与 session-baselines 构造推导同式（env PI_SUBAGENT_ROOT_CWD 贯穿 ||
      // ctx.cwd）——保证结果目录与 records 落同一 enc 段（enc 段不变量，path-encoding
      // 头注同族约束）。本命令只在主进程执行（子进程无 / 命令通道），env 恒缺省。
      await runSubagentModelRpc(
        {
          getService: getSubagentService,
          resolveAgentDir: getAgentDir,
          resolveRootCwd: () => process.env[ENV_ROOT_CWD] || ctx.cwd,
        },
        argsStr,
        ctx,
      );
    },
  });
}
