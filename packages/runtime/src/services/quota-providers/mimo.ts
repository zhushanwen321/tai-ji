/**
 * 小米 MiMo Coding Plan 额度 fetcher。
 *
 * API: GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage（用量）
 *      GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail（订阅周期，并行拉取，
 *      失败只降级 resetSec=null 不影响用量主数据）
 * Auth: Cookie header（经 normalizeCookieHeader 归一化粘贴伪影）
 * 窗口：仅 month（平台无 5h/weekly 窗口数据——usage/monthUsage 两组均为月级量级，
 * 已被 Mimo-Usage 截图与 CodexBar 实现双重印证，5h/week 恒 INFINITE_WIN）
 *
 * 关键点：
 * - percent 是 0~1 小数，需 ×100 转为百分比
 * - monthUsage.items[0].used/limit 为 token 绝对量（CodexBar/Mimo-Usage 同源证据）
 * - currentPeriodEnd 为 "yyyy-MM-dd HH:mm:ss" 无时区标记串，按 UTC 解析（查询固定发
 *   x-timezone: UTC；CodexBar 实测平台返回 UTC 墙钟）
 * - 凭证过期三种形态均归 unauthorized：HTTP 401/403、3xx 重定向（redirect:'manual'
 *   下可见，CodexBar 同判据）、HTTP 200 + body code=401/403
 */

import type { ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchOutcome, QuotaWindow } from './types.js'
import type { QuotaFetchFailureReason } from './types.js'
import { INFINITE_WIN, fetchQuotaJson, isOptionalField, isRecord, normalizeCookieHeader } from './types.js'
import { logger } from '../../infra/logger.js'
import { toErrorMessage } from '../../utils/errors.js'

const FETCH_TIMEOUT_MS = 5000
const PERCENT_SCALE = 100
const MS_PER_SECOND = 1000
const MIMO_API_BASE = 'https://platform.xiaomimimo.com/api/v1/tokenPlan'
/**
 * 固定时区：浏览器查询会带 x-timezone，平台返回的 currentPeriodEnd 不带时区标记，
 * 固定 UTC 使「发送的时区」与「解析假定的时区」强一致，不随部署/请求地区漂移。
 */
const MIMO_TIMEZONE = 'UTC'
/** 平台 WAF 按非浏览器 UA 拦截时的防御（对齐 Mimo-Usage/CodexBar 的浏览器 UA）。 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

/** 在体凭证过期业务码（HTTP 200 + body code，Mimo-Usage proxy / CodexBar 同判据）。 */
const MIMO_CODE_UNAUTHORIZED = 401
const MIMO_CODE_FORBIDDEN = 403
/** fetchQuotaJson 契约外逃逸异常（Promise.allSettled rejected）的兜底失败态。 */
const FAILED_NETWORK: MimoEndpointResult = { ok: false, reason: 'network' }

/** 单端点原始结果形态：fetchQuotaJson<MimoApiResponse> 的返回（QuotaFetchOutcome 的
 * ok 分支 data 是 NormalizedQuotaRow，不适用于端点级中间态）。 */
type MimoEndpointResult = { ok: true; data: MimoApiResponse } | { ok: false; reason: QuotaFetchFailureReason }

function buildHeaders(cookie: string): Record<string, string> {
  return {
    accept: 'application/json',
    cookie,
    'user-agent': BROWSER_UA,
    'x-timezone': MIMO_TIMEZONE,
  }
}

interface MimoUsageItem {
  used: number
  limit: number
}

interface MimoUsageGroup {
  percent: number
  items: MimoUsageItem[]
}

interface MimoApiResponse {
  code: number
  message: string
  data: {
    monthUsage: MimoUsageGroup
    usage: MimoUsageGroup
  }
}

/** items[] 条目形态：used/limit 可选 number（token 绝对量字段）。 */
function isMimoUsageItem(item: unknown): boolean {
  if (!isRecord(item)) return false
  return isOptionalField(item.used, 'number') && isOptionalField(item.limit, 'number')
}

/** usage 组形态（monthUsage / usage 同构）：percent 可选 number，items 可选数组。 */
function isMimoUsageGroup(group: unknown): boolean {
  if (!isRecord(group)) return false
  if (!isOptionalField(group.percent, 'number')) return false
  if (group.items === undefined) return true
  if (!Array.isArray(group.items)) return false
  return group.items.every(isMimoUsageItem)
}

/**
 * JSON 边界轻量 shape guard：只校验决策分支依赖的字段类型（code 判定、
 * data.monthUsage 解构）。字段缺失是合法业务态，字段类型漂移归 parse
 * （RT-7#5：guard 收到字段级——防 `"401"` 等字符串 code 绕过 `!== 0` 判定产出错数据）。
 * usage 与 detail 两端点信封同构（{code,message,data}），共用此 guard。
 *
 * RT-7#6：code=0（成功响应）时 data 必须在且是对象——原 `data === undefined` 放行会让
 * buildMonthWindow 读 undefined 抛 TypeError，被 quota-service 误归 network（成因仅
 * debug，打包态不可见）。code 非 0 = 在体错误响应（mapNonZeroCodeOutcome 域：
 * 401/403 → unauthorized，其余 → no-subscription），data 可缺席。
 */
function isMimoResponse(v: unknown): v is MimoApiResponse {
  if (!isRecord(v)) return false
  const o = v
  if (typeof o.code !== 'number') return false
  if (o.code !== 0 && o.data === undefined) return true
  if (!isRecord(o.data)) return false
  const d = o.data
  return (
    (d.monthUsage === undefined || isMimoUsageGroup(d.monthUsage)) &&
    (d.usage === undefined || isMimoUsageGroup(d.usage))
  )
}

/**
 * currentPeriodEnd → month 窗口 resetSec。平台返回 "yyyy-MM-dd HH:mm:ss" 无时区标记
 * （CodexBar 实测），按 UTC 解析（与固定发送的 x-timezone: UTC 一致）；带时区标记的
 * ISO 串 Date.parse 直接处理。解析失败或已过期 → null（降级为无重置信息）。
 */
function extractPeriodResetSec(resp: unknown): number | null {
  if (!isRecord(resp) || !isRecord(resp.data)) return null
  const end = resp.data.currentPeriodEnd
  if (typeof end !== 'string') return null
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(end)
  const t = zoneless ? Date.parse(`${end.replace(' ', 'T')}Z`) : Date.parse(end)
  if (Number.isNaN(t)) return null
  const sec = Math.floor((t - Date.now()) / MS_PER_SECOND)
  return sec > 0 ? sec : null
}

/** 单端点请求形态：usage 与 detail 信封同构（同一 guard + headers + timeout + manual redirect），仅 logTag 与 path 不同。 */
function fetchTokenPlanEndpoint(label: string, path: string, cookie: string): Promise<MimoEndpointResult> {
  return fetchQuotaJson(
    label,
    () =>
      fetch(`${MIMO_API_BASE}${path}`, {
        headers: buildHeaders(cookie),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
      }),
    isMimoResponse,
  )
}

/** allSettled 结果提取：fetchQuotaJson 契约不 throw，rejected 属逃逸异常兜底 → network。 */
function settleEndpoint(settled: PromiseSettledResult<MimoEndpointResult>): MimoEndpointResult {
  return settled.status === 'fulfilled' ? settled.value : FAILED_NETWORK
}

/** 响应可解析但 code 非 0 的归并：在体 401/403（Mimo-Usage proxy 判 code===401 触发刷新、
 * CodexBar 判 401/403 为登录态失效）→ unauthorized，cookie 失效不应被引导去检查订阅；
 * 其余 = 无订阅数据 → no-subscription。 */
function mapNonZeroCodeOutcome(code: number): QuotaFetchOutcome {
  if (code === MIMO_CODE_UNAUTHORIZED || code === MIMO_CODE_FORBIDDEN) {
    return { ok: false, reason: 'unauthorized' }
  }
  return { ok: false, reason: 'no-subscription' }
}

/** month 窗口构建：percent 主数据 + detail 端点重置时间（detail 失败降级 resetSec=null，
 * 不影响用量主数据）。RT-7#5：percent 缺失（平台未提供该窗口数据）→ pct=null
 * （不可知，前端整行隐藏）——原 `?? 0` 会产 pct=0 假未用。 */
function buildMonthWindow(usageData: MimoApiResponse['data'], detailResult: MimoEndpointResult): QuotaWindow {
  const monthResetSec = detailResult.ok ? extractPeriodResetSec(detailResult.data) : null
  const monthWin: QuotaWindow = {
    pct: typeof usageData.monthUsage?.percent === 'number'
      ? usageData.monthUsage.percent * PERCENT_SCALE
      : null,
    resetSec: monthResetSec,
  }
  // token 绝对量：取 monthUsage.items[0]（CodexBar/Mimo-Usage 同款取法），used/limit
  // 为 token 数（CodexBar parseTokenPlanUsage 与 Mimo-Usage formatTokens 展示双重印证；
  // 原 A2-3「字段语义未实测不编造」据此解除）。limit≤0 视为无效数据不输出绝对量。
  const item = usageData.monthUsage?.items?.[0]
  if (item && typeof item.used === 'number' && typeof item.limit === 'number' && item.limit > 0) {
    monthWin.used = item.used
    monthWin.limit = item.limit
    monthWin.unit = 'tokens'
  }
  return monthWin
}

export const mimoFetcher: ProviderQuotaFetcher = {
  id: 'mimo',
  auth: ['cookie'],

  async fetchQuota(credential: string, _kind: QuotaAuthKind): Promise<QuotaFetchOutcome> {
    const cookie = normalizeCookieHeader(credential)
    if (!cookie) return { ok: false, reason: 'unauthorized' }

    // usage（主数据）与 detail（重置时间）两独立源并行，allSettled 允许 detail 单独降级
    // （失败归 network 失败态，主数据不受影响）。redirect:'manual'：会话过期时平台把
    // API 302 到登录流，自动跟随会拿到登录 HTML 被 guard 归 parse 误报，
    // manual + statusToReason 归 unauthorized。
    const [usageSettled, detailSettled] = await Promise.allSettled([
      fetchTokenPlanEndpoint('quota:mimo', '/usage', cookie),
      fetchTokenPlanEndpoint('quota:mimo:detail', '/detail', cookie),
    ])
    // RT-7#6：归一化构造段异常（guard 放行后的形态漂移逃逸等）归 parse 非 network——
    // 数据形态问题被归网络错误会误导排障方向（fetchQuotaJson 契约外异常同理只兜底网络段）。
    try {
      const usageResult = settleEndpoint(usageSettled)
      const detailResult = settleEndpoint(detailSettled)
      if (!usageResult.ok) return usageResult
      // code 非 0 = 响应可解析但无订阅数据（在体凭证过期例外，见 mapNonZeroCodeOutcome）。
      if (usageResult.data.code !== 0) return mapNonZeroCodeOutcome(usageResult.data.code)

      return {
        ok: true,
        data: {
          label: 'MiMo Coding',
          wins: [INFINITE_WIN, INFINITE_WIN, buildMonthWindow(usageResult.data.data, detailResult)],
        },
      }
    } catch (err) {
      logger.warn('[quota:mimo] normalize failed', { error: toErrorMessage(err) })
      return { ok: false, reason: 'parse' }
    }
  }
}
