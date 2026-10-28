/**
 * OpenDesign Coding Plan 额度 fetcher。
 *
 * API: GET https://amr-api.open-design.ai/api/v1/workspaces/<id>/billing/coding-plan-usage
 *      （workspace 归一化 URL 由用户配置注入——workspace 是 per-account 资产，禁止硬编码 id）
 * Auth: better-auth 会话 cookie（2026-10-18 实测：sk-amr API Key 不被此端点接受，
 *      Bearer / x-api-key 均 401；x-vela-workspace-id 请求头非必需，workspace 由路径决定）
 * 窗口：5h + 7d 两个 anchored 窗口（durationSeconds 18000 / 604800），month 槽无数据
 *
 * 响应为 JSON（区别于 opencode 的 SSR HTML 正则解析），走 fetchQuotaJson 共用骨架。
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome, QuotaFetcherConfig } from './types.js'
import { INFINITE_WIN, fetchQuotaJson, isRecord, numericField } from './types.js'
import { normalizeCookieHeader } from '@taiji/shared'

const FETCH_TIMEOUT_MS = 8000

/** 百分比换算基数（used/limit → 0-100）。 */
const PERCENT_SCALE = 100
/** ms → s 换算（resetsAt ISO 时间戳 → resetSec）。 */
const MS_PER_SEC = 1000

/** 5h 窗口长度（秒，实测 durationSeconds=18000）。 */
const FIVE_HOUR_SECONDS = 18000
/** 7 天窗口长度（秒，实测 durationSeconds=604800）。 */
const WEEK_SECONDS = 604800

/** coding-plan-usage 单窗口 wire 形态（shape guard 逐字段收窄，RT-7#5）。 */
interface OpendesignWindow { // oe-exempt:20261018:framework:wire 数据形态描述（非 ports 契约），与 kimi/minimax/mimo 等 fetcher 的 named wire interface 同构
  durationSeconds: number
  usedCredits: number
  limitCredits: number
  remainingCredits: number
  resetSec: number | null
}

/** numericField 包装：credits 以字符串数值下发（实测 "1402"），数值/数值串均收。 */
function numericMember(v: unknown): boolean {
  return numericField(v) !== undefined
}

/** coding-plan-usage 响应 shape guard：窗口数组按字段收窄，非法窗口项丢弃（不整单拒绝）。 */
function isOpendesignUsage(v: unknown): v is { windows: OpendesignWindow[] } {
  if (!isRecord(v) || !Array.isArray(v.windows)) return false
  const windows: OpendesignWindow[] = []
  for (const raw of v.windows) {
    if (!isRecord(raw)) continue
    if (!numericMember(raw.durationSeconds) || !numericMember(raw.usedCredits) || !numericMember(raw.limitCredits)) continue
    windows.push({
      durationSeconds: numericField(raw.durationSeconds) as number,
      usedCredits: numericField(raw.usedCredits) as number,
      limitCredits: numericField(raw.limitCredits) as number,
      remainingCredits: numericField(raw.remainingCredits) ?? 0,
      resetSec: parseResetSec(raw.resetsAt),
    })
  }
  ;(v as { windows: OpendesignWindow[] }).windows = windows
  return true
}

/** resetsAt（ISO 时间戳）→ 距今秒数（下取整，过去时刻取 0）；缺失/非法 = null。 */
function parseResetSec(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null
  const ms = Date.parse(v)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor((ms - Date.now()) / MS_PER_SEC))
}

/** 单窗口 → QuotaWindow 槽位数据：pct = used/limit（limit 0 视为不可知 → pct null）。 */
function toWin(w: OpendesignWindow): { pct: number | null; used: number; limit: number; unit: 'credits'; resetSec: number | null } {
  const pct = w.limitCredits > 0 ? Math.min(PERCENT_SCALE, (w.usedCredits / w.limitCredits) * PERCENT_SCALE) : null
  return { pct, used: w.usedCredits, limit: w.limitCredits, unit: 'credits', resetSec: w.resetSec }
}

export const opendesignFetcher: ProviderQuotaFetcher = {
  id: 'opendesign',
  auth: ['cookie'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind, config?: QuotaFetcherConfig): Promise<QuotaFetchOutcome> {
    const cookie = normalizeCookieHeader(credential)
    if (!cookie) return { ok: false, reason: 'unauthorized' }

    // 未配置 workspace 参数 = 可区分失败 not_configured，不发任何 HTTP 请求（对齐 opencode D1-3）
    const workspaceUrl = config?.quotaParams?.workspaceUrl
    if (!workspaceUrl) return { ok: false, reason: 'not_configured' }

    const result = await fetchQuotaJson(
      'quota:opendesign',
      () =>
        fetch(workspaceUrl, {
          headers: {
            accept: 'application/json',
            cookie,
            'user-agent': 'Mozilla/5.0',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
      isOpendesignUsage,
    )
    if (!result.ok) return result

    const byDuration = new Map<number, OpendesignWindow>(
      result.data.windows.map((w) => [w.durationSeconds, w]),
    )
    const fiveHour = byDuration.get(FIVE_HOUR_SECONDS)
    const week = byDuration.get(WEEK_SECONDS)
    // 两窗口全缺 = 无订阅数据（eligible:false 等同形态——有响应结构但无可用窗口）
    if (!fiveHour && !week) return { ok: false, reason: 'no-subscription' }

    return {
      ok: true,
      data: {
        label: 'OpenDesign Coding Plan',
        wins: [
          fiveHour ? toWin(fiveHour) : INFINITE_WIN,
          week ? toWin(week) : INFINITE_WIN,
          INFINITE_WIN,
        ],
      },
    }
  },
}
