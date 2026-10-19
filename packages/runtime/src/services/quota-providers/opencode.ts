/**
 * opencode.go 额度 fetcher。
 *
 * API: GET https://opencode.ai/console/api/go/status（JSON）
 * Auth: Cookie（__Host-console_session）+ `x-org-id` header（workspace id，从已配置的
 *   workspaceUrl 提取——workspace 是 per-account 资产，禁止硬编码任何 id，D1-4）
 * 窗口：fiveHour + week + month（→ [5h 滚动, 本周, 本月]）
 *
 * wire 形态实测锚点（2026-10-19，console/api/go/status 真响应）：
 * - limitMicroCents / usedMicroCents 以字符串数值下发（micro-cents，百万分之一美分）；
 *   pct 为比值，单位在比值中约掉，不做金额换算
 * - month 窗口无 startsAt 字段（仅 fiveHour / week 有），resetsAt 三窗口均有
 * - 凭证失效 = 401 {"_tag":"Unauthorized"}（非 302，无需 redirect:'manual'）
 * - workspace id 不属于该账号 = 404 {"_tag":"NotFound"} → 归 no-subscription
 *   （配置错误/已删除，恢复指引是核对配置而非重试）
 *
 * 未配置 workspace / id 不可提取 → not_configured（不发任何请求，D1-3）。
 */

import { extractQuotaWorkspaceId } from '@taiji/shared'
import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome, QuotaFetcherConfig, QuotaWindow } from './types.js'
import { INFINITE_WIN, isOptionalField, isOptionalNumericField, isRecord, isoResetRemaining, normalizeCookieHeader, numericField, statusToReason } from './types.js'
import { logger } from '../../infra/logger.js'
import { toErrorMessage } from '../../utils/errors.js'

const FETCH_TIMEOUT_MS = 8000
const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const PERCENT_SCALE = 100

/** console API 端点（平台常量，与 kimi 等账号维度 fetcher 同性质；org id 走 header 注入）。 */
const OPENCODE_STATUS_URL = 'https://opencode.ai/console/api/go/status'

/** wire 数值字段：实测以字符串数值下发（`"1200000000"`），number 形态兼容。 */
type OpencodeWireNumber = number | string

/** 单窗口 meter（micro-cents 计数）。resetsAt 缺失 = 该窗口重置时间不可知。 */
interface GoMeter {
  resetsAt?: string
  limitMicroCents?: OpencodeWireNumber
  usedMicroCents?: OpencodeWireNumber
}

interface GoStatusResponse {
  access?: { meters?: { fiveHour?: GoMeter; week?: GoMeter; month?: GoMeter } }
}

/** meter guard：字段缺失合法（该窗口不可知），存在则必须匹配形态（防漂移产错数据）。 */
function isGoMeter(v: unknown): boolean {
  if (!isRecord(v)) return false
  return (
    isOptionalField(v.resetsAt, 'string') &&
    isOptionalNumericField(v.limitMicroCents) &&
    isOptionalNumericField(v.usedMicroCents)
  )
}

/**
 * JSON 边界轻量 shape guard：只校验决策分支依赖的字段（meters 三窗口对象解构）。
 * access / meters / 单窗口缺失是合法业务态（→ no-subscription / INFINITE_WIN），
 * 字段类型漂移归 parse（RT-7#5：guard 收到字段级）。
 */
function isGoStatusResponse(v: unknown): v is GoStatusResponse {
  if (!isRecord(v)) return false
  const access = v.access
  if (access === undefined) return true
  if (!isRecord(access)) return false
  const meters = access.meters
  if (meters === undefined) return true
  if (!isRecord(meters)) return false
  for (const key of ['fiveHour', 'week', 'month'] as const) {
    const meter = meters[key]
    if (meter !== undefined && !isGoMeter(meter)) return false
  }
  return true
}

/**
 * 窗口构造：limit/used 均可解析且 limit > 0 → pct = used/limit（limit≤0 视为无限，
 * 兼防除零）；否则 INFINITE_WIN（pct:null 前端整行隐藏，不产假 0% / 假 100%）。
 */
function buildWin(meter: GoMeter | undefined): QuotaWindow {
  const limit = numericField(meter?.limitMicroCents)
  const used = numericField(meter?.usedMicroCents)
  if (limit === undefined || used === undefined || limit <= 0) return INFINITE_WIN
  return {
    pct: Math.round((used / limit) * PERCENT_SCALE),
    resetSec: meter?.resetsAt !== undefined ? isoResetRemaining(meter.resetsAt) : null,
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
    const orgId = extractQuotaWorkspaceId(workspaceUrl)
    if (!orgId) {
      logger.warn('[quota:opencode] workspace id not extractable from configured url', { workspaceUrl })
      return { ok: false, reason: 'not_configured' }
    }

    try {
      const resp = await fetch(OPENCODE_STATUS_URL, {
        headers: {
          cookie,
          'x-org-id': orgId,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      // 非 2xx 提前 return 不读 body——显式 cancel 释放连接（对齐 fetchQuotaJson 骨架惯例）。
      if (resp.status === HTTP_NOT_FOUND) {
        void resp.body?.cancel()
        return { ok: false, reason: 'no-subscription' }
      }
      if (resp.status !== HTTP_OK) {
        void resp.body?.cancel()
        return { ok: false, reason: statusToReason(resp.status) }
      }

      let data: GoStatusResponse
      try {
        data = (await resp.json()) as GoStatusResponse
      } catch {
        return { ok: false, reason: 'parse' }
      }
      if (!isGoStatusResponse(data)) return { ok: false, reason: 'parse' }

      const { fiveHour, week, month } = data.access?.meters ?? {}
      // 三窗口全缺 = 无订阅数据；部分缺失容忍（上游改名单窗口字段名时降级少显示，
      // 不让整个查询失败）
      if (!fiveHour && !week && !month) return { ok: false, reason: 'no-subscription' }

      return {
        ok: true,
        data: {
          label: 'opencode.go',
          wins: [buildWin(fiveHour), buildWin(week), buildWin(month)],
        },
      }
    } catch (err) {
      // fetch 网络异常 / 超时 → network（架构约定 #4 落盘，禁止静默 catch）。
      // debug → warn：打包态 info 级会过滤 debug，生产不可见（对齐 fetchQuotaJson 骨架）。
      const msg = toErrorMessage(err)
      logger.warn('[quota:opencode] fetch failed', { error: msg })
      return { ok: false, reason: 'network' }
    }
  },
}
