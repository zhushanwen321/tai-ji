/**
 * MiniMax Coding Plan 额度 fetcher。
 *
 * API: GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
 * Auth: Bearer <API_KEY>
 * 窗口：5h + week（month = ∞）
 *
 * 关键点：API 返回的是**剩余百分比**，需反转为已用百分比。
 * status=1 表示已订阅，其他值视为无限。
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome } from './types.js'
import { INFINITE_WIN, fetchQuotaJson, isRecord } from './types.js'

const FETCH_TIMEOUT_MS = 5000
const PERCENT_SCALE = 100
const MS_PER_SEC = 1000

interface MinimaxBaseResp {
  status_code?: number
}

interface MinimaxModelRemains {
  model_name: string
  current_interval_remaining_percent: number
  current_interval_status: number
  remains_time: number
  current_weekly_remaining_percent: number
  current_weekly_status: number
  weekly_remains_time: number
  [key: string]: unknown
}

interface MinimaxApiResponse {
  base_resp?: MinimaxBaseResp
  model_remains?: MinimaxModelRemains[]
}

/**
 * JSON 边界轻量 shape guard：只校验决策分支依赖的字段类型（base_resp.status_code 判定、
 * model_remains 数组迭代）。字段缺失是合法业务态（→ no-subscription），
 * 字段类型漂移归 parse（防 `base_resp: "err"` 等形态在 string 上取属性静默走错分支）。
 */
function isMinimaxResponse(v: unknown): v is MinimaxApiResponse {
  if (!isRecord(v)) return false
  const o = v
  if (o.base_resp !== undefined && (typeof o.base_resp !== 'object' || o.base_resp === null)) return false
  if (o.model_remains !== undefined && !Array.isArray(o.model_remains)) return false
  return true
}

/** status 字段语义：1=正常订阅；其他值当无限 */
const isActive = (s: number | undefined): boolean => s === 1

/**
 * 把 API 的"剩余百分比"反转为"已用百分比"，并判断是否无限。
 */
function toWindow(
  remainingPercent: number | undefined,
  status: number | undefined,
  remainsMs: number | undefined,
): { pct: number | null; resetSec: number | null } {
  if (!isActive(status)) return INFINITE_WIN
  const rem = Number(remainingPercent ?? 0)
  const used = Math.max(0, Math.min(PERCENT_SCALE, PERCENT_SCALE - rem))
  const resetSec = remainsMs && remainsMs > 0 ? Math.ceil(remainsMs / MS_PER_SEC) : null
  return { pct: used, resetSec }
}

export const minimaxFetcher: ProviderQuotaFetcher = {
  id: 'minimax',
  auth: ['api-key'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind): Promise<QuotaFetchOutcome> {
    if (!credential) return { ok: false, reason: 'unauthorized' }

    const result = await fetchQuotaJson(
      'quota:minimax',
      () =>
        fetch('https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains', {
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
      isMinimaxResponse,
    )
    if (!result.ok) return result
    const data = result.data
    // base_resp 非 0 / 无模型数据 / 无 general 条目 = 响应可解析但无订阅数据
    if (data?.base_resp?.status_code !== 0) return { ok: false, reason: 'no-subscription' }

    const models = data.model_remains ?? []
    if (models.length === 0) return { ok: false, reason: 'no-subscription' }

    // 只关注 model_name === "general"（文本/LLM 用量）
    const general = models.find((m) => m.model_name === 'general')
    if (!general) return { ok: false, reason: 'no-subscription' }

    const win5h = toWindow(
      general.current_interval_remaining_percent,
      general.current_interval_status,
      general.remains_time,
    )
    const winWk = toWindow(
      general.current_weekly_remaining_percent,
      general.current_weekly_status,
      general.weekly_remains_time,
    )

    // [A2-3] 平台 API 仅提供剩余百分比 + 时间（无总量字段），不编造 used/limit/unit
    // （待验证检查点 4 实测后跟进）
    return {
      ok: true,
      data: {
        label: 'MiniMax Coding',
        wins: [win5h, winWk, INFINITE_WIN],
      },
    }
  },
}
