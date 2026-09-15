/**
 * LLM 重试配置域（设计 docs/design/llm-retry-settings.md §3.4 类型 + §3.3 D8 数值合法域）。
 * 校验域定在 shared：renderer 表单与 runtime 写入侧共用同一套域常量，杜绝两端漂移。
 */

/** provider 层（单请求级）重试配置；undefined = 采纳 pi 默认语义。 */
export interface LlmRetryProviderConfig {
  /** 未设 = 跟随全局 httpIdleTimeoutMs；禁止 0（0 会原样透传成 0ms 立即超时，见设计 §2.2） */
  timeoutMs?: number
  /** 未设 = 0（不重试） */
  maxRetries?: number
  /** 未设 = 60000；0 = 不限制 */
  maxRetryDelayMs?: number
}

/** agent 层重试配置（pi settings.json `retry` 域）。 */
export interface LlmRetryConfig {
  enabled: boolean
  /** pi 默认 3 */
  maxRetries: number
  /** pi 默认 2000 */
  baseDelayMs: number
  provider?: LlmRetryProviderConfig
}

/** D8 数值合法域（设计 §3.3 D8 表，唯一依据）。 */
export const LLM_RETRY_DOMAIN = {
  maxRetries: { min: 0, max: 20 },
  baseDelayMs: { min: 0, max: 600000 },
  providerTimeoutMs: { min: 1, max: 600000 },
  providerMaxRetries: { min: 0, max: 10 },
  providerMaxRetryDelayMs: { min: 0, max: 3600000, minNonZero: 1000 },
} as const

/** 校验结果信封：ok 或含字段名/合法范围/当前值的 error（同 setTerminalConfig 错误信封范式）。 */
type LlmRetryValidationResult = { ok: true } | { ok: false; error: string }

/** 整数闭区间域判定（D8 通用式：整数 + [min, max]）。 */
function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

/** maxRetryDelayMs 特殊域（D8）：0（不限制）或 [minNonZero, max]，无普通下限。 */
function isValidMaxRetryDelayMs(value: number): boolean {
  return (
    Number.isInteger(value) &&
    (value === 0 ||
      (value >= LLM_RETRY_DOMAIN.providerMaxRetryDelayMs.minNonZero &&
        value <= LLM_RETRY_DOMAIN.providerMaxRetryDelayMs.max))
  )
}

/** provider 域校验（agent 层字段已在前置校验通过，本函数只管 provider 域）。 */
function validateProviderConfig(provider: LlmRetryProviderConfig): LlmRetryValidationResult {
  // 对象性守卫：null 解构抛 TypeError（写路径校验在 try 外，会以 handler_error 逃逸而非
  // set_retry_config_failed 信封）；string/array 解构静默得 undefined，被当「全未设」丢字段。
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
    return { ok: false, error: `provider 类型必须是对象或未设: ${String(provider)}` }
  }
  const { timeoutMs, maxRetries: pMaxRetries, maxRetryDelayMs } = provider
  if (
    timeoutMs !== undefined &&
    !isIntegerInRange(
      timeoutMs,
      LLM_RETRY_DOMAIN.providerTimeoutMs.min,
      LLM_RETRY_DOMAIN.providerTimeoutMs.max,
    )
  ) {
    return { ok: false, error: `provider.timeoutMs 超出范围(整数 1-600000 或未设，禁止 0): ${String(timeoutMs)}` }
  }
  if (
    pMaxRetries !== undefined &&
    !isIntegerInRange(
      pMaxRetries,
      LLM_RETRY_DOMAIN.providerMaxRetries.min,
      LLM_RETRY_DOMAIN.providerMaxRetries.max,
    )
  ) {
    return { ok: false, error: `provider.maxRetries 超出范围(整数 0-10 或未设): ${String(pMaxRetries)}` }
  }
  if (maxRetryDelayMs !== undefined && !isValidMaxRetryDelayMs(maxRetryDelayMs)) {
    return {
      ok: false,
      error: `provider.maxRetryDelayMs 超出范围(整数 0(不限制) 或 1000-3600000): ${String(maxRetryDelayMs)}`,
    }
  }
  return { ok: true }
}

/** LLM 重试配置校验：agent 层（enabled/maxRetries/baseDelayMs）→ provider 层逐域短路，
 *  规则集与错误消息与历史版本逐字一致。 */
export function validateLlmRetryConfig(config: LlmRetryConfig): LlmRetryValidationResult {
  if (typeof config.enabled !== 'boolean') {
    return { ok: false, error: `enabled 类型必须是 boolean: ${String(config.enabled)}` }
  }
  const { maxRetries, baseDelayMs, provider } = config
  if (!isIntegerInRange(maxRetries, LLM_RETRY_DOMAIN.maxRetries.min, LLM_RETRY_DOMAIN.maxRetries.max)) {
    return { ok: false, error: `maxRetries 超出范围(整数 0-20): ${String(maxRetries)}` }
  }
  if (!isIntegerInRange(baseDelayMs, LLM_RETRY_DOMAIN.baseDelayMs.min, LLM_RETRY_DOMAIN.baseDelayMs.max)) {
    return { ok: false, error: `baseDelayMs 超出范围(整数 0-600000): ${String(baseDelayMs)}` }
  }
  if (provider !== undefined) {
    return validateProviderConfig(provider)
  }
  return { ok: true }
}
