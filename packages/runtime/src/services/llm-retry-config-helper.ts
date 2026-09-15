/**
 * LLM 重试配置 helper（设计 docs/design/llm-retry-settings.md §3.3 D3/D7/D8）。
 *
 * 承载 retry 域读写两侧的纯函数：缺省合并/坏值回落/置configured 判定（读侧）与
 * D3 嵌套键级 merge（写侧）。抽出原因：控 config-service max-lines 500
 *（先例 terminal-config-helper.ts）；纯函数零 I/O，infra 实现与单测共用同一份逻辑。
 */
import type { LlmRetryConfig } from '@taiji/shared'
import { validateLlmRetryConfig } from '@taiji/shared'
import type { LlmRetryConfigSnapshot } from './ports/llm-retry-settings.js'

/** pi 默认值（§2.2 实装核实：settings-manager.js:581-596/:610-615）。 */
export const PI_RETRY_DEFAULTS = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
  providerMaxRetries: 0,
  providerMaxRetryDelayMs: 60000,
  // provider.timeoutMs 无默认：未设 = 跟随全局 httpIdleTimeoutMs
} as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 数值键：文件值是 number（含超域存量值，原样返回）则用之，否则回落 pi 默认（D7 坏值承接）。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 有限正数判定（provider.timeoutMs 读侧专用）：0 是写侧必拒值（合法域 1-600000），读侧清为未设。 */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 读侧解析（D7）：把文件 retry 域（可能缺省/坏值/非对象）合并为完整 LlmRetryConfig。
 * - configured = 六已知键（enabled/maxRetries/baseDelayMs/provider.timeoutMs/
 *   provider.maxRetries/provider.maxRetryDelayMs）任一显式存在（`in` 判定），
 *   键在值类型不符仍计 true——表达「文件里有显式配置意图」。
 * - 缺省键合并为 pi 默认值；provider.timeoutMs 未设时不出键（undefined 语义）。
 */
export function resolveRetryConfig(raw: unknown): LlmRetryConfigSnapshot {
  const retry = isPlainObject(raw) ? raw : {}
  const providerRaw = isPlainObject(retry['provider']) ? retryRawProvider(retry) : undefined
  const configured =
    'enabled' in retry ||
    'maxRetries' in retry ||
    'baseDelayMs' in retry ||
    (providerRaw !== undefined &&
      ('timeoutMs' in providerRaw || 'maxRetries' in providerRaw || 'maxRetryDelayMs' in providerRaw))

  const provider: LlmRetryConfig['provider'] = {
    maxRetries: numberOr(providerRaw?.['maxRetries'], PI_RETRY_DEFAULTS.providerMaxRetries),
    maxRetryDelayMs: numberOr(providerRaw?.['maxRetryDelayMs'], PI_RETRY_DEFAULTS.providerMaxRetryDelayMs),
  }
  const timeoutMs = providerRaw?.['timeoutMs']
  // 0 特判（isPositiveFiniteNumber）：写侧 validateLlmRetryConfig 必拒 0（合法域整数
  // 1-600000），0 不是合法超域值而是「写侧不可能产出」的值——读侧清为未设（不出现
  // 键 = 跟随全局 httpIdleTimeoutMs 语义），闭合写读往返对称；>600000 的超域存量值
  // 仍按 D7 原样返回不改。
  if (isPositiveFiniteNumber(timeoutMs)) {
    provider.timeoutMs = timeoutMs
  }

  return {
    configured,
    config: {
      enabled: typeof retry['enabled'] === 'boolean' ? retry['enabled'] : PI_RETRY_DEFAULTS.enabled,
      maxRetries: numberOr(retry['maxRetries'], PI_RETRY_DEFAULTS.maxRetries),
      baseDelayMs: numberOr(retry['baseDelayMs'], PI_RETRY_DEFAULTS.baseDelayMs),
      provider,
    },
  }
}

/** resolveRetryConfig 内部用：provider 层已知是 plain object 后取其原始键表。 */
function retryRawProvider(retry: Record<string, unknown>): Record<string, unknown> {
  return retry['provider'] as Record<string, unknown>
}

/**
 * 写侧 merge（D3）：把校验通过的 config 合入文件当前 retry 域，返回新对象。
 * - 任意层级遇非 plain object（string/number/boolean/array/null）→ 该层不 merge，
 *   直接以仅含该层已知键的新对象整体替换（禁止对非对象 spread）。
 * - 六已知键：入参显式给值的覆盖，undefined（未设）的从结果中删除（= 采纳 pi 默认语义）。
 * - pi 未来新增的 retry 子字段（未知键）原样保留。
 */
export function mergeRetryConfig(current: unknown, config: LlmRetryConfig): Record<string, unknown> {
  // 非 plain object（含缺省/字符串/数组/null）→ 整体替换为仅含已知键的新对象
  const base: Record<string, unknown> = isPlainObject(current) ? { ...current } : {}
  base['enabled'] = config.enabled
  base['maxRetries'] = config.maxRetries
  base['baseDelayMs'] = config.baseDelayMs

  const providerSrc = isPlainObject(current) ? current['provider'] : undefined
  const provider: Record<string, unknown> = isPlainObject(providerSrc) ? { ...providerSrc } : {}
  const providerCfg = config.provider
  patchKey(provider, 'timeoutMs', providerCfg?.timeoutMs)
  patchKey(provider, 'maxRetries', providerCfg?.maxRetries)
  patchKey(provider, 'maxRetryDelayMs', providerCfg?.maxRetryDelayMs)
  base['provider'] = provider
  return base
}

/** 已知键 patch：显式值覆盖；undefined 删除该键（未设 = pi 默认语义）。 */
function patchKey(target: Record<string, unknown>, key: string, value: number | undefined): void {
  if (value === undefined) {
    delete target[key]
  } else {
    target[key] = value
  }
}

/**
 * 写入前全量校验（D8）：委托 shared validateLlmRetryConfig，合法域是 GUI 的写入契约。
 * 失败返回 { ok:false, error }（错误信封含字段/范围/当前值），调用方据此不落盘。
 */
export function validateRetryConfigForWrite(config: LlmRetryConfig): { ok: true } | { ok: false; error: string } {
  return validateLlmRetryConfig(config)
}
