/**
 * Kimi Coding Plan 额度 fetcher。
 *
 * API: GET https://api.kimi.com/coding/v1/usages
 * Auth: Bearer <API_KEY>
 * 窗口：5h + week（month = ∞）
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome, QuotaWindow } from './types.js'
import { INFINITE_WIN, fetchQuotaJson, isOptionalField, isOptionalNumericField, isRecord, numericField } from './types.js'

const FETCH_TIMEOUT_MS = 5000
const PERCENT_SCALE = 100
const MS_PER_SEC = 1000

/** wire 数值字段（limit/used/remaining）：实测以字符串数值下发（`"100"`），历史形态为 number。 */
type KimiWireNumber = number | string

/** 窗口用量字段形态（limits[].detail 与 usage 同构的数据位）：limit/used/remaining 可选 wire 数值、resetTime 可选 string。 */
interface KimiUsageFields {
  limit?: KimiWireNumber
  used?: KimiWireNumber
  remaining?: KimiWireNumber
  resetTime?: string
}

interface KimiLimit {
  detail?: KimiUsageFields
}

interface KimiApiResponse {
  limits?: KimiLimit[]
  usage?: KimiUsageFields
}

/** 窗口用量字段 guard（limits[].detail 与 usage 共用，两处字段同构）。 */
function isKimiUsageFields(v: unknown): boolean {
  if (!isRecord(v)) return false
  return (
    isOptionalNumericField(v.limit) &&
    isOptionalNumericField(v.used) &&
    isOptionalNumericField(v.remaining) &&
    isOptionalField(v.resetTime, 'string')
  )
}

/** limits[] 条目形态：detail 缺失合法（该条目无 5h 窗口数据）。 */
function isKimiLimitEntry(v: unknown): boolean {
  if (!isRecord(v)) return false
  return v.detail === undefined || isKimiUsageFields(v.detail)
}

/**
 * JSON 边界轻量 shape guard：只校验决策分支依赖的字段类型（limits 数组迭代判定、
 * usage 对象解构）。字段缺失是合法业务态（→ no-subscription / 该窗口不可知），字段
 * 类型漂移归 parse（RT-7#5：guard 收到字段级——防 `{"limits":"abc"}` 时 string.length
 * truthy 绕过 no-subscription 检查）。
 *
 * wire 形态实测锚点（2026-09-24，api.kimi.com/coding/v1/usages 真响应）：数值字段以字符串
 * 数值下发（`"100"`）、`detail` 提供 `used` 而非 `remaining`——数值可解析性由
 * isOptionalNumericField 判定（拒 `"abc"` 类漂移归 parse），字符串数值是合法 wire 形态。
 */
function isKimiResponse(v: unknown): v is KimiApiResponse {
  if (!isRecord(v)) return false
  const o = v
  if (o.limits !== undefined) {
    if (!Array.isArray(o.limits)) return false
    if (!o.limits.every(isKimiLimitEntry)) return false
  }
  if (o.usage !== undefined && !isKimiUsageFields(o.usage)) return false
  return true
}

/** ISO 时间戳 → 剩余秒 */
function isoResetRemaining(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.max(0, Math.floor(ms / MS_PER_SEC))
}

/** requests 类窗口构造（A2-3：绝对量直出，limit/remaining 已从 API 拿到；limit≤0 视为无限）。 */
function requestsWindow(limit: number, used: number, resetSec: number | null): QuotaWindow {
  return limit > 0
    ? {
      pct: Math.round((used / limit) * PERCENT_SCALE),
      used,
      limit,
      unit: 'requests' as const,
      resetSec,
    }
    : INFINITE_WIN
}

/**
 * 窗口 used 解析（实测 wire 形态 + RT-7#5 语义合一）：显式 `used` 优先（实测 limits[].detail /
 * usage 均提供 limit/used，无 remaining），缺失时用 `limit − remaining` 折算（remaining 形态
 * 端点），两者皆缺 = 不可知 → undefined——不产 used=limit 的 100% 假耗尽、也不产 pct=0 假未用。
 */
function resolveUsed(limit: number | undefined, used: number | undefined, remaining: number | undefined): number | undefined {
  if (used !== undefined) return used
  if (limit !== undefined && remaining !== undefined) return limit - remaining
  return undefined
}

/** 5h 滚动窗口（detail 字段）。limit/used 不可知 → INFINITE_WIN（pct:null 整行隐藏）。 */
function buildWin5h(data: KimiApiResponse): QuotaWindow {
  const winDetail = data?.limits?.[0]?.detail
  const winLimit = numericField(winDetail?.limit)
  const winUsed = resolveUsed(winLimit, numericField(winDetail?.used), numericField(winDetail?.remaining))
  if (winLimit === undefined || winUsed === undefined) return INFINITE_WIN
  return requestsWindow(
    winLimit,
    winUsed,
    winDetail?.resetTime ? isoResetRemaining(winDetail.resetTime) : null,
  )
}

/** 每日/周窗口（usage 字段，绝对量直出）。limit/used 不可知 → INFINITE_WIN（RT-7#5：不再产
 * pct=0 假未用）。 */
function buildWinWk(data: KimiApiResponse): QuotaWindow {
  const usage = data?.usage
  const dailyLimit = numericField(usage?.limit)
  const dailyUsed = resolveUsed(dailyLimit, numericField(usage?.used), numericField(usage?.remaining))
  if (dailyLimit === undefined || dailyUsed === undefined) return INFINITE_WIN
  return requestsWindow(
    dailyLimit,
    dailyUsed,
    usage?.resetTime ? isoResetRemaining(usage.resetTime) : null,
  )
}

export const kimiFetcher: ProviderQuotaFetcher = {
  id: 'kimi-coding',
  // usages API 与 oauth 同域同 Bearer（pi 侧 kimi oauth 的 toAuth 即 Bearer access），
  // 故声明双形态，优先 api-key（§3.4）
  auth: ['api-key', 'oauth'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind): Promise<QuotaFetchOutcome> {
    if (!credential) return { ok: false, reason: 'unauthorized' }

    const result = await fetchQuotaJson('quota:kimi', () =>
      fetch('https://api.kimi.com/coding/v1/usages', {
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
    isKimiResponse)
    if (!result.ok) return result
    const data = result.data
    // limits 与 usage 均缺失 = 响应可解析但无订阅数据
    if (!data?.limits?.length && !data?.usage) return { ok: false, reason: 'no-subscription' }

    return {
      ok: true,
      data: {
        label: 'Kimi Coding',
        wins: [buildWin5h(data), buildWinWk(data), INFINITE_WIN],
      },
    }
  },
}
