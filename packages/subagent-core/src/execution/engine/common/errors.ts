// src/execution/engine/common/errors.ts
//
// 引擎层错误 SSOT（P2 公共降级层）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md §3.3.3 错误规格全表（11 条）。
//
// 为什么集中一处：错误文案契约（code + 恢复指引）被三层消费——公共降级层
// （prompt_too_large / nested_spawn_rejected / engine_timeout）、后续 wave 的路由与
// 探针（engine_not_found / engine_probe_failed / model_not_available）、引擎适配器
// （engine_run_failed / engine_session_not_resumable）。散落各处会漂移成同一错误
// 多种文案，GUI 无法按 code 分流。
//
// 与 registry.ts 的 EngineNotFoundError 的关系：那是 P1 随注册表落地的
// engine_not_found 错误类（getEngine 抛出），本文件不复制其类定义、只对齐 code
// 字面量——后续 wave 统一收敛时以本表为 SSOT。

// ============================================================
// 错误码全集（§3.3.3 表 code 列，顺序与设计文档一致）
// ============================================================

export const ENGINE_ERROR_CODES = [
  "engine_not_found",
  "engine_probe_failed",
  "engine_credential_missing",
  "nested_spawn_rejected",
  "schema_emulation_failed",
  "engine_timeout",
  "engine_capability_unsupported",
  "engine_capability_mismatch",
  "engine_session_not_resumable",
  "model_not_available",
  "prompt_too_large",
  "engine_run_failed",
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

/** unknown → EngineErrorCode 收窄（外部输入携带错误码时的运行时 guard）。 */
export function isEngineErrorCode(value: unknown): value is EngineErrorCode {
  return typeof value === "string" && (ENGINE_ERROR_CODES as readonly string[]).includes(value);
}

// ============================================================
// 错误类（code + 恢复指引的结构化载体）
// ============================================================

/**
 * 引擎层结构化错误。message 恒为 `<code>: <detail>` 前缀格式（AgentOutcome.error
 * 的错误码前缀约定，§3.3.5）；recovery 指向恢复动作（全局规则：错误信息必须可操作）。
 */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** 恢复指引：指向具体下一步（命令 / 配置路径 / 替代方案），非安慰性文案。 */
  readonly recovery: string;

  constructor(code: EngineErrorCode, detail: string, recovery: string) {
    super(`${code}: ${detail}`);
    this.name = "EngineError";
    this.code = code;
    this.recovery = recovery;
  }

  /** 结构化投影（code/message 与 GUI 警告条共用形态）。 */
  toStructured(): { code: EngineErrorCode; message: string; recovery: string } {
    return { code: this.code, message: this.message, recovery: this.recovery };
  }
}

// ============================================================
// 默认恢复指引模板（§3.3.3 恢复指引列的静态部分）
// ============================================================

/**
 * 11 条错误的默认恢复指引。Record<EngineErrorCode, string> 使 TS 强制全集覆盖——
 * 新增错误码漏写模板会在此处编译失败，而不是运行时空指引。
 * 含动态参数的恢复指引（版本命令 / 模型清单 / 字节数）用下方具名构造器，不走此表。
 */
export const DEFAULT_RECOVERY_HINTS: Record<EngineErrorCode, string> = {
  engine_not_found:
    "Check the engine id in the agent .md frontmatter (engine: field) against the registered engine list, " +
    "fix the typo, or install/register the engine first.",
  engine_probe_failed:
    "Confirm the engine version (e.g. `<engine> --version`), then re-run the engine probe. " +
    "For contract drift, see docs/research/agent-engine-*.md for the expected output format.",
  engine_credential_missing:
    "Configure the engine credentials (see the engine credential section of docs/research/agent-engine-*.md), " +
    "then retry — the preparer cannot synthesize credentials it has no source for.",
  nested_spawn_rejected:
    "Subagents must not spawn further subagents (unbounded recursion guard). " +
    "Do the work directly inside the current task instead of delegating.",
  schema_emulation_failed:
    "The model output failed JSON extraction or schema validation. Retry once with a strengthened prompt " +
    "(buildSchemaEmulationSegment output + the error tail); if it still fails, relax the schema or switch to a " +
    "schema-native engine (engine: pi).",
  engine_timeout:
    "The engine was killed by the host timeout chain. Inspect the captured stdout tail, then re-run with a larger " +
    "timeout, a narrower task, or `engine: pi`.",
  engine_capability_unsupported:
    "This engine declares the capability unsupported. Adjust the task parameters, " +
    "or fix the manifest capabilities / upgrade the engine package if it actually supports it.",
  engine_capability_mismatch:
    "The engine manifest declares a capability its initialize handshake did not confirm. " +
    "Fix the manifest capabilities (align with actual engine behavior) or upgrade the engine package.",
  engine_session_not_resumable:
    "Idle-process reuse does not survive a main-session reload. Use a cold resume path " +
    "(engine --resume / --session with the recorded session reference), or start a new subagent.",
  model_not_available:
    "The requested model is not resolvable in this engine's provider system. Pick a model from the engine's " +
    "available model list — the host never swaps engines implicitly on model mismatch.",
  prompt_too_large:
    "Shorten the task text, move the persona to the file channel, or use an engine with a stdin prompt channel.",
  engine_run_failed:
    "The engine process failed at runtime (parse failure / non-zero exit / contract drift). " +
    "Check the captured stdout tail and exit code, confirm the engine version, re-run the probe, or retry with `engine: pi`.",
};

// ============================================================
// P2 消费的具名构造器（动态参数进 detail/recovery）
// ============================================================

/** truncate(text, max)：尾部截断 + 省略号标记（模板共用）。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * prompt_too_large（persona-router 的 argv 预算拦截消费）：仅 argv 投递的引擎在
 * prepare 期报——禁止 spawn 后撞 E2BIG 才失败（§3.3.3 第 10 行）。
 */
export function promptTooLargeError(actualBytes: number, limitBytes: number): EngineError {
  return new EngineError(
    "prompt_too_large",
    `estimated argv size ${actualBytes} bytes exceeds the ${limitBytes}-byte budget`,
    DEFAULT_RECOVERY_HINTS.prompt_too_large,
  );
}

/** stdout 尾部回显上限（engine_timeout / engine_run_failed 的错误规格载体系数）。 */
export const STDOUT_TAIL_ECHO_CHARS = 2000;

/**
 * engine_timeout 的 outcome.error 文案（kill-chain 的 synthesizeTimeoutOutcome 消费）：
 * 含 stdout 尾部 2000 字 + 「可用 engine: pi 重跑」建议（§3.3.3 第 6 行）。
 */
export function engineTimeoutDetail(stdoutTail: string): string {
  return (
    `host timeout chain exhausted (SIGTERM -> grace -> SIGKILL). ` +
    `Stdout tail (last ${STDOUT_TAIL_ECHO_CHARS} chars): ${truncate(stdoutTail, STDOUT_TAIL_ECHO_CHARS)}. ` +
    `Recovery: ${DEFAULT_RECOVERY_HINTS.engine_timeout}`
  );
}

/**
 * engine_run_failed 的 outcome.error 文案：含 stdout 尾部 2000 字 + exit code +
 * 恢复指引（版本确认 + 探针重跑 / engine: pi 重跑，§3.3.3 第 11 行）。
 */
export function engineRunFailedDetail(reason: string, exitCode: number | null, stdoutTail: string): string {
  const exit = exitCode === null ? "killed by signal" : `exit code ${exitCode}`;
  return (
    `engine failed at runtime: ${reason} (${exit}). ` +
    `Stdout tail (last ${STDOUT_TAIL_ECHO_CHARS} chars): ${truncate(stdoutTail, STDOUT_TAIL_ECHO_CHARS)}. ` +
    `Recovery: ${DEFAULT_RECOVERY_HINTS.engine_run_failed}`
  );
}

// schema_emulation_failed 的终报文案（schemaEmulationFailedDetail）已随 schema-emulation
// 死镜像收口删除：活体单源 SDK error-codes.ts（emulated 引擎的宿主编排层经 SDK 消费），
// core 侧此前仅剩自身测试引用（test-only）。
