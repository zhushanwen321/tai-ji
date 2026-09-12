/**
 * opencode.go 额度 fetcher。
 *
 * API: GET https://opencode.ai/workspace/<wrk_id>/go（workspace 由用户配置注入，D1-1——
 * timeout-audit-hygiene-batch：workspace 是 per-account 资产，禁止硬编码任何 id）
 * Auth: Cookie + redirect:manual
 * 窗口：5h + week + month（全部支持）
 *
 * 关键点：SSR HTML 中嵌入数据（非 JSON），用正则解析。
 * HTTP 302 = cookie 过期。
 * 未配置 workspace → not_configured（不发任何请求，D1-3）。
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome, QuotaFetcherConfig } from './types.js'
import { INFINITE_WIN, normalizeCookieHeader, statusToReason } from './types.js'
import { logger } from '../../infra/logger.js'
import { toErrorMessage } from '../../utils/errors.js'

const FETCH_TIMEOUT_MS = 8000
const HTTP_OK = 200

interface WindowUsage {
  status: string
  usagePercent: number
  resetInSec: number
}

function extractWindow(html: string, name: string): WindowUsage | null {
  const re = new RegExp(`${name}:\\$R\\[\\d+\\]=\\{([^}]+)\\}`)
  const m = html.match(re)
  if (!m?.[1]) return null

  const obj = m[1]
  const statusM = obj.match(/status:"([^"]+)"/)
  const resetM = obj.match(/resetInSec:(\d+)/)
  const pctM = obj.match(/usagePercent:(\d+)/)
  if (!statusM || !resetM || !pctM) return null

  return {
    status: statusM[1],
    resetInSec: Number(resetM[1]),
    usagePercent: Number(pctM[1]),
  }
}

function toWin(u: WindowUsage): { pct: number | null; resetSec: number | null } {
  return {
    pct: u.usagePercent,
    resetSec: u.resetInSec > 0 ? u.resetInSec : null,
  }
}

export const opencodeFetcher: ProviderQuotaFetcher = {
  id: 'opencode-go',
  auth: ['cookie'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind, config?: QuotaFetcherConfig): Promise<QuotaFetchOutcome> {
    const cookie = normalizeCookieHeader(credential)
    if (!cookie) return { ok: false, reason: 'unauthorized' }

    // D1-3：未配置 workspace = 可区分失败 not_configured，不发任何 HTTP 请求——
    // 绝不 fallback 别的页面/缓存（G1：未配置得到明确指引，不查他人数据）
    const workspaceUrl = config?.workspaceUrl
    if (!workspaceUrl) {
      logger.debug('[quota:opencode] workspace not configured, skipping fetch')
      return { ok: false, reason: 'not_configured' }
    }

    try {
      const resp = await fetch(
        workspaceUrl,
        {
          headers: {
            accept: 'text/html',
            cookie,
            'user-agent': 'Mozilla/5.0',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: 'manual',
        },
      )
      // 3xx（实际为 302 到登录页）= cookie 过期（statusToReason 统一映射，A2-1）
      if (resp.status !== HTTP_OK) return { ok: false, reason: statusToReason(resp.status) }

      let html: string
      try {
        html = await resp.text()
      } catch {
        return { ok: false, reason: 'parse' }
      }

      const rolling = extractWindow(html, 'rollingUsage')
      const weekly = extractWindow(html, 'weeklyUsage')
      const monthly = extractWindow(html, 'monthlyUsage')
      // 三窗口全缺 = 无订阅数据；部分缺失容忍（上游改名单窗口字段名时降级少显示，
      // 不让整个查询失败——对齐 dsh-opencode-go-usage 的逐窗口可选解析）
      if (!rolling && !weekly && !monthly) return { ok: false, reason: 'no-subscription' }

      return {
        ok: true,
        data: {
          label: 'opencode.go',
          wins: [
            rolling ? toWin(rolling) : INFINITE_WIN,
            weekly ? toWin(weekly) : INFINITE_WIN,
            monthly ? toWin(monthly) : INFINITE_WIN,
          ],
        },
      }
    } catch (err) {
      // fetch 网络异常 / 超时 → network（架构约定 #4 落盘，禁止静默 catch）
      const msg = toErrorMessage(err)
      logger.debug('[quota:opencode] fetch failed', { error: msg })
      return { ok: false, reason: 'network' }
    }
  },
}
