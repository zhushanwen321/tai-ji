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
//   engine_model_not_in_snapshot  setModel 目标模型不在子进程快照 → 宿主写覆盖意图
//                               （模型本身有效，下一轮 spawn 现取目录）
//   engine_credential_missing   setModel 子进程凭据校验失败（checkAuth 权威兜底）→
//                               宿主按校验型失败处置（chat 单成员不写意图；run 级聚合
//                               列失败名单、run 级意图照写——设计 §7.5 凭据行）
//   engine_state_readback_failed  setModel 命令已发出但回读无回执、生效值未知 →
//                               宿主写覆盖意图 + 错误应答（不虚构生效值）
//   engine_run_not_active       setModel 目标 run 无活跃子进程（§7.3 全部竞态窗口内
//                               退出同一处置——定位时/命令写入/读应答/回读期间）→
//                               宿主转纯记账路径（chat 已记账型应答 / 聚合 not-active
//                               成员态——非失败分型，不进 SET_MODEL_ERROR_CODES）
//   其余 engine_*               引擎在 error 帧原样给出 → core 透传，文案契约不变
//
// [登记非实装·透传面新码] engine_method_unsupported——未知成员宽容语义②（条文权威
// = ADR-0071）：新宿主派本引擎未知的正向 method → 引擎回 error 帧，旧宿主经
// isEngineErrorPassthroughCode 原样透传不崩。实装码现状：两引擎 server（pi/zcode
// dispatch 表落空分支）对未知 method 回的是 engine_protocol_unknown_method（同为
// engine_ 前缀透传面，非本码）；本码刻意不进下方 ENGINE_PROTOCOL_ERROR_CODES
// 消费词表（该集是 core 消费集；C 型「无消费方不进协议」纪律——当前全仓零消费方，
// 故只登记不实装）；引擎应答义务成文 =
// docs/extensions/subagents/engine-development-guide.md（未知 method 必回透传面
// 错误码 + conformance 用例）。

// ============================================================
// setModel 方法错误码子词表（设计 subagent-model-switch §7.3/§7.5；
// setModel 应答错误 envelope 的分型值域——宿主编排层按分型裁决持久化意图处置）
// ============================================================

/**
 * setModel 正向方法的错误码三型（引擎 error 帧给出；宿主消费分型）。
 * 追加进 ENGINE_PROTOCOL_ERROR_CODES 主词表（成员清单单源 = 本数组，主词表 spread）。
 *
 * 三型定名经 ADR-0071 评审（u-foundation 实施期裁决）：统一 engine_ 前缀——
 * 协议 error 帧的 code 词法约束是 ^engine_（schema.ts protocolErrorSchema pattern，
 * 全部引擎应答错误共用），且现役词表 9 码全部 engine_ 前缀（error-codes.ts 头注
 * 「对齐现役错误码词表风格」）；设计文档 §7.3 的第一型字面名 model_not_in_snapshot
 * 不满足 pattern，按约束加前缀定名 engine_model_not_in_snapshot。第三型采纳设计
 * 候选名 engine_state_readback_failed。
 */
export const SET_MODEL_ERROR_CODES = [
  /** 目标模型不在当前进程快照（子进程模型快照冻结于 spawn 时刻——模型本身有效，
   *  下一轮 spawn 现取目录即可用；宿主按「写覆盖意图」处置，设计 §7.2 快照型失败行）。 */
  "engine_model_not_in_snapshot",
  /** 凭据校验失败（子进程 set_model checkAuth 抛错——宿主预检通过后 registry 态漂移
   *  的权威兜底；宿主按校验型失败处置，设计 §7.5 凭据行）。 */
  "engine_credential_missing",
  /** 命令已发出（set_model 可能已执行）但读应答 / get_state 回读无回执、生效值未知
   *  （非进程退出情形——退出归无活进程路径；宿主按「写覆盖意图 + 错误应答」处置，
   *  设计 §7.5 回读失败行）。 */
  "engine_state_readback_failed",
] as const;

/** setModel 错误分型值域（聚合失败名单 reason 字段的类型源；词表扩位时同步跟随）。 */
export type SetModelErrorCode = (typeof SET_MODEL_ERROR_CODES)[number];

/**
 * setModel「无活进程」应答码（设计 §7.3/§7.5：定位时 / 命令写入 / 读应答 / 回读
 * 四个竞态窗口内发现子进程已退出——**同一处置**按无活进程形态应答，引擎回本码
 * error 帧）。进主词表的依据与 SET_MODEL_ERROR_CODES 三型相同：宿主消费分型
 * （chat 域转已记账型应答 / run 级聚合落 not-active 成员态，§7.2 处置表），不是
 * 「core 不解释文案」的纯透传面。刻意**不进** SET_MODEL_ERROR_CODES：聚合失败
 * 名单的分型值域只收「转发失败」三型，无活进程是成员三态之一（not-active），
 * 不是失败——两值域语义正交。
 */
export const SET_MODEL_NOT_ACTIVE_CODE = "engine_run_not_active";

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
  ...SET_MODEL_ERROR_CODES,
  SET_MODEL_NOT_ACTIVE_CODE,
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
// conversation gate 位负向：manifest 能力轴（message 资格 / 「怎么续」形态轴）
// ============================================================

/**
 * 引擎 conversation 位拒绝的具名错误（[modeless 波2] 语义：无 resume 续聊通道的
 * 引擎，message 续聊资格被拒——manifest conversation 能力轴消费；[modeless 波5
 * 收尾] core capability-gate 的显式参数分支随派发参数删除退役，本构造器消费方 =
 * 引擎侧 resume gate（assertChatConversationSupported）与 message 资格门）。
 * 文案契约：错误码 engine_capability_unsupported + 「换引擎续聊 / 修 manifest /
 * 升级引擎包」恢复指引，两侧一致防漂移。
 */
export function engineConversationUnsupportedError(engineId: string): EngineSdkError {
  return new EngineSdkError(
    "engine_capability_unsupported",
    `engine '${engineId}' 不支持 resume 续聊（capabilities.conversation = 'unsupported'，` +
      `manifest 无 conversation gate 位）`,
    `改用声明 conversation 能力的引擎续聊（或以新任务重派），或修 manifest capabilities / 升级引擎包（若引擎实际支持该能力）`,
    { engineId, capability: "conversation", declared: "unsupported" },
  );
}

/**
 * resume 会话形态（run.params.resume——唯一会话形态键）派发前的同步 gate：
 * manifest conversation 位 unsupported 即抛 engineConversationUnsupportedError
 * ——进程/record 创建前同步拒（A6 方向防御：manifest/实装漂移时引擎侧自拒，
 * 与 core capability-gate 同一能力位，防两侧判据漂移）。[modeless 波2] 协议
 * task 的 conversation 键已删，本 gate 只对 resume 形态键生效。
 */
export function assertChatConversationSupported(
  engineId: string,
  capabilities: Pick<EngineCapabilities, "conversation">,
): void {
  if (capabilities.conversation === "unsupported") {
    throw engineConversationUnsupportedError(engineId);
  }
}

/**
 * 引擎 setModel 能力位负向的具名错误（A6 方向防御同族——对照
 * engineConversationUnsupportedError 先例）：引擎 server 收到 setModel 请求但本引擎
 * capabilities.setModel 非 'native'（含缺省 undefined = unsupported）时同步拒。
 * 宿主侧发送前预检（§7.2 步骤②）正常不会发出该调用——本错误是 manifest/实装漂移
 * 时引擎侧的自拒兜底，契约行为 = 结构化错误帧而非崩溃。
 */
export function engineSetModelUnsupportedError(
  engineId: string,
  declared: EngineCapabilities["setModel"],
): EngineSdkError {
  return new EngineSdkError(
    "engine_capability_unsupported",
    `engine '${engineId}' does not support hot model switching (capabilities.setModel = ` +
      `${declared ?? "unsupported (undeclared)"}); the host pre-check (design §7.2 step 2) must not dispatch setModel to it`,
    `Route the switch to an engine that declares capabilities.setModel = 'native', or record the override for the next run instead. ` +
      `If this engine actually supports hot switching, fix the manifest capabilities declaration.`,
    { engineId, capability: "setModel", declared: declared ?? "unsupported" },
  );
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
