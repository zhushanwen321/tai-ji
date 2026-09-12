// src/protocol/error-codes.ts
//
// 协议错误码表（impl-plan §2.1「错误码表」逐项）+ 结构化错误载体 + kill-chain 消费的
// 具名错误文案构造器（自 core execution/engine/common/errors.ts 迁入 SDK 的引擎面
// 子集；core 侧错误 SSOT 留守，双侧错误码词表由测试互证）。
//
// 错误码语义与 core 侧处置（设计 §3.3 错误码表）：
//   engine_not_found            配置/清单里的 id 无对应包 → 列出已发现引擎 + 配置路径
//   engine_protocol_mismatch    握手版本越界 → 该引擎不可用；升级 core 或引擎包
//   engine_capability_unsupported  core 的 gate 同步拦（manifest 少声明被 gate 四类之一）
//                               ——core 生成，不属「引擎 error 帧透传」
//   engine_capability_mismatch  manifest 声明 ≠ 握手能力位（被 gate 位多声明 → run 失败
//                               + 清理前置副作用；非 gate 位不一致 → 仅 warn）
//   engine_model_unknown        validateModel 未命中且 dynamic=false → 同步拒（record 不创建）
//   engine_model_mismatch       dynamic=true 运行期引擎拒绝 → run 失败 + record 标 failed
//   engine_handshake_timeout    initialize 超时（HANDSHAKE_TIMEOUT_MS=10s）→ 引擎不可用
//   engine_crashed              进程意外退出 → 在途 run 失败（附 stderr 尾
//                               STDERR_TAIL_CHARS=400 字符）；重建最多 3 次退避 1s/2s/4s
//   engine_probe_failed         probe 失败 → 既有 fallback 三守卫不变
//   其余 engine_*               引擎在 error 帧原样给出 → core 透传，文案契约不变

/** 协议核心错误码（引擎 error 帧 + core 同步拦截共用的固定词表）。 */
export const ENGINE_PROTOCOL_ERROR_CODES = [
  "engine_not_found",
  "engine_protocol_mismatch",
  "engine_capability_unsupported",
  "engine_capability_mismatch",
  "engine_model_unknown",
  "engine_model_mismatch",
  "engine_handshake_timeout",
  "engine_crashed",
  "engine_probe_failed",
] as const;

export type EngineProtocolErrorCode = (typeof ENGINE_PROTOCOL_ERROR_CODES)[number];

/** unknown → 协议错误码收窄（外部输入携带错误码时的运行时 guard；其余 engine_* 走透传）。 */
export function isEngineProtocolErrorCode(value: unknown): value is EngineProtocolErrorCode {
  return (
    typeof value === "string" &&
    (ENGINE_PROTOCOL_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** 其余引擎自报错误码的前缀契约（透传面；core 不解释文案）。 */
export const ENGINE_ERROR_CODE_PREFIX = "engine_";

export function isEngineErrorPassthroughCode(value: string): boolean {
  return (
    !isEngineProtocolErrorCode(value) && value.startsWith(ENGINE_ERROR_CODE_PREFIX)
  );
}

// ============================================================
// 结构化错误载体（协议 ProtocolError 的 TS 异常形态）
// ============================================================

import type { ProtocolError } from "./frames.ts";
import { SUPPORTED_PROTOCOL_RANGE } from "./engine-protocol.ts";
import type { EngineCapabilities } from "./contract-types.ts";

/**
 * 结构化引擎错误（message 恒为 `<code>: <detail>` 前缀格式——AgentOutcome.error 与
 * 协议 error 帧共用的错误码前缀约定）；recovery 指向恢复动作。
 * toStructured() 产出即协议 ProtocolError 形态（error 帧载荷直用）。
 */
export class EngineSdkError extends Error {
  readonly code: string;
  readonly recovery: string;
  readonly data?: Record<string, unknown>;

  constructor(code: string, detail: string, recovery: string, data?: Record<string, unknown>) {
    super(`${code}: ${detail}`);
    this.name = "EngineSdkError";
    this.code = code;
    this.recovery = recovery;
    this.data = data;
  }

  /** 协议 error 帧载荷投影。 */
  toStructured(): ProtocolError {
    return { code: this.code, message: this.message, recovery: this.recovery, data: this.data };
  }
}

// ============================================================
// engine_protocol_mismatch 具名构造器（版本协商失败：含双方版本 + 升级指引）
// ============================================================

export function engineProtocolMismatchError(engineVersion: number): EngineSdkError {
  return new EngineSdkError(
    "engine_protocol_mismatch",
    `engine speaks protocol v${engineVersion}, host supports [${SUPPORTED_PROTOCOL_RANGE.min}, ${SUPPORTED_PROTOCOL_RANGE.max})`,
    "Upgrade the engine package (or the host) so both sides speak a protocol version in the supported range, then re-run the task. The engine is marked unavailable until then.",
    {
      engineProtocolVersion: engineVersion,
      supportedMin: SUPPORTED_PROTOCOL_RANGE.min,
      supportedMaxExclusive: SUPPORTED_PROTOCOL_RANGE.max,
    },
  );
}

// ============================================================
// [v1.x] conversation gate 位负向：conversation 请求（resume 续聊会话形态）同步拒
// ============================================================

/**
 * [v1.x] resume 会话形态（run.params.resume）的 gate 拒绝具名错误（chat-domain
 * 设计 §3.2 D1-A + 验收 A6：manifest 无 conversation gate 位的引擎收到
 * conversation 请求 → 同步拒；[H1] 文案随 D5 语义收窄——续聊 = resume 续聊）。
 * 文案契约对齐 core capability-gate.ts conversation 分支（错误码
 * engine_capability_unsupported + 「去掉参数 / 修 manifest / 升级引擎包」恢复指引）
 * ——W3 chat 路由切协议客户端时以本构造器替换 core 内联文案，保持两侧一致。
 */
export function engineConversationUnsupportedError(engineId: string): EngineSdkError {
  return new EngineSdkError(
    "engine_capability_unsupported",
    `engine '${engineId}' 不支持 resume 续聊（capabilities.conversation = 'unsupported'，` +
      `manifest 无 conversation gate 位）`,
    `去掉 conversation 参数（一次性任务默认形态），或修 manifest capabilities / 升级引擎包（若引擎实际支持该能力）`,
    { engineId, capability: "conversation", declared: "unsupported" },
  );
}

/**
 * [v1.x] resume 会话形态（run.params.resume / task.conversation=true）派发前的同步 gate：
 * manifest conversation 位 unsupported 即抛 engineConversationUnsupportedError——
 * 进程/record 创建前同步拒（A6：run 域不受影响，仅 chat 面被拦）。
 * 判据单源：core 侧 capability-gate.assertTaskShapeSupported 的 conversation 分支
 * 覆盖同一能力位，协议客户端路径（W3 接线）消费本函数，防两处判据漂移。
 */
export function assertChatConversationSupported(
  engineId: string,
  capabilities: Pick<EngineCapabilities, "conversation">,
): void {
  if (capabilities.conversation === "unsupported") {
    throw engineConversationUnsupportedError(engineId);
  }
}

// ============================================================
// kill-chain 消费的引擎面错误文案（自 core errors.ts 迁入，逐字等价）
// ============================================================

/** 错误回显长度上限（截断长输出，避免错误消息爆炸）。 */
const DETAIL_ECHO_MAX_CHARS = 200;

/** stdout 尾部回显上限（engine_timeout / engine_run_failed 的错误规格载体系数）。 */
export const STDOUT_TAIL_ECHO_CHARS = 2000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** engine_timeout 的恢复指引（kill-chain 超时杀链收尾文案）。 */
export const ENGINE_TIMEOUT_RECOVERY =
  "The engine was killed by the host timeout chain. Inspect the captured stdout tail, then re-run with a larger " +
  "timeout, a narrower task, or `engine: pi`.";

/**
 * engine_timeout 的 outcome.error 文案：含 stdout 尾部 2000 字 + 恢复指引
 * （kill-chain synthesizeTimeoutOutcome 消费；与 core errors.ts engineTimeoutDetail 逐字等价）。
 */
export function engineTimeoutDetail(stdoutTail: string): string {
  return (
    `host timeout chain exhausted (SIGTERM -> grace -> SIGKILL). ` +
    `Stdout tail (last ${STDOUT_TAIL_ECHO_CHARS} chars): ${truncate(stdoutTail, STDOUT_TAIL_ECHO_CHARS)}. ` +
    `Recovery: ${ENGINE_TIMEOUT_RECOVERY}`
  );
}

/** schema_emulation_failed 的终报文案（宿主编排层「重试一次仍失败」后消费）。 */
export function schemaEmulationFailedDetail(error: string, tail: string): string {
  return (
    `structured output emulation failed after tolerant extraction and one host-side retry: ${error}. ` +
    `Raw output tail: ${truncate(tail, DETAIL_ECHO_MAX_CHARS)}. ` +
    `Recovery: retry with a strengthened prompt or relax the schema; if it still fails switch to a ` +
    `schema-native engine (engine: pi).`
  );
}
