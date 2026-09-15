/**
 * Kimi Coding Plan 额度 fetcher。
 *
 * API: GET https://api.kimi.com/coding/v1/usages
 * Auth: Bearer <API_KEY>
 * 窗口：5h + week（month = ∞）
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome, QuotaWindow } from './types.js'
import { INFINITE_WIN, fetchQuotaJson, isRecord } from './types.js'

const FETCH_TIMEOUT_MS = 5000
const PERCENT_SCALE = 100
const MS_PER_SEC = 1000

interface KimiLimitDetail {
  limit?: number
  remaining?: number
  resetTime?: string
}

interface KimiLimit {
  detail?: KimiLimitDetail
}

interface KimiUsage {
  limit?: number
  used?: number
  resetTime?: string
}

interface KimiApiResponse {
  limits?: KimiLimit[]
  usage?: KimiUsage
}

/**
 * JSON 边界轻量 shape guard：只校验决策分支依赖的字段类型（limits 数组迭代判定、
 * usage 对象解构）。字段缺失是合法业务态（→ no-subscription），字段类型漂移归 parse
 * （防 `{"limits":"abc"}` 时 string.length truthy 绕过 no-subscription 检查产出错数据）。
 */
function isKimiResponse(v: unknown): v is KimiApiResponse {
  if (!isRecord(v)) return false
  const o = v
  if (o.limits !== undefined && !Array.isArray(o.limits)) return false
  if (o.usage !== undefined && (typeof o.usage !== 'object' || o.usage === null)) return false
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

/** 5h 滚动窗口（limit − remaining 折算 used） */
function buildWin5h(data: KimiApiResponse): QuotaWindow {
  const winDetail = data?.limits?.[0]?.detail
  const winLimit = Number(winDetail?.limit ?? 0)
  const winRemaining = Number(winDetail?.remaining ?? 0)
  return requestsWindow(
    winLimit,
    winLimit - winRemaining,
    winDetail?.resetTime ? isoResetRemaining(winDetail.resetTime) : null,
  )
}

/** 每日/周窗口（usage 字段，绝对量直出） */
function buildWinWk(data: KimiApiResponse): QuotaWindow {
  const dailyLimit = Number(data?.usage?.limit ?? 0)
  const dailyUsed = Number(data?.usage?.used ?? 0)
  return requestsWindow(
    dailyLimit,
    dailyUsed,
    data?.usage?.resetTime ? isoResetRemaining(data.usage.resetTime) : null,
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
