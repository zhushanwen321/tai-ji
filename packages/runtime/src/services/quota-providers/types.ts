/**
 * Quota provider 类型 — runtime 实现层。
 *
 * re-export shared 类型 + 添加 runtime 专用常量。
 * 设计文档：docs/page-design/archive/v3/coding-plan-quota/design.md
 */

import type { QuotaWindow, QuotaWins, NormalizedQuotaRow, ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchFailureReason, QuotaFetchOutcome, QuotaFetcherConfig } from '@xyz-agent/shared'
import { logger } from '../../infra/logger.js'
import { toErrorMessage } from '../../utils/errors.js'

/** 无限窗口（未订阅/不支持）。pct=null 前端整行隐藏。 */
export const INFINITE_WIN: QuotaWindow = { pct: null, resetSec: null }

export type { QuotaWindow, QuotaWins, NormalizedQuotaRow, ProviderQuotaFetcher, QuotaAuthKind, QuotaFetchFailureReason, QuotaFetchOutcome, QuotaFetcherConfig }

/** HTTP 401/403：凭证无效/过期（unauthorized 判定）。 */
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
/** HTTP 3xx 区间（redirect:'manual' 下可见的会话过期重定向段，上界排他）。 */
const HTTP_REDIRECT_MIN = 300
const HTTP_REDIRECT_MAX = 400

/**
 * HTTP 状态 → 失败 reason 的统一映射（A2-1 错误通道）。
 * - 401/403 → unauthorized（凭证无效/过期，D6 恢复指引场景）
 * - 3xx（仅 redirect:'manual' 下可见）→ unauthorized：会话过期时平台把 API 请求
 *   302 到登录流（CodexBar MiMo 实测同判据），自动跟随会落到登录 HTML → parse 误报
 * - 其余非 2xx（5xx/404/429 等）→ network（基础设施层失败，与 fetch 异常同归——
 *   二者对用户的恢复动作相同：检查网络/稍后重试，不涉及凭证操作）
 */
export function statusToReason(status: number): QuotaFetchFailureReason {
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return 'unauthorized'
  if (status >= HTTP_REDIRECT_MIN && status < HTTP_REDIRECT_MAX) return 'unauthorized'
  return 'network'
}

/**
 * 归一化用户粘贴的 cookie 字符串为合法 Cookie 头形态。处理三类常见粘贴伪影
 * （形态清单来自 CodexBar CookieHeaderNormalizer / Mimo-Usage 的实测用户输入）：
 * ① curl 命令 / `Cookie:` 前缀整段粘贴 → 提取头值；
 * ② 键值对内空白（`k = v; k2 = v2`）→ 去除；
 * ③ 整串被单双引号包裹 → 去包裹。
 * 键值对内值的引号不动（`k="v"` 是浏览器线上真实传输形态，剥引号反而破坏鉴权）。
 * 归一化后为空（无任何有效键值对）返回空串，由调用方按 unauthorized 处理。
 */
/**
 * 归一化用户粘贴 cookie 的分隔空白伪影（`k = v ;  k2 = v2` → `k=v; k2=v2`）。
 * 只做空白修剪：键值对内值的引号原样保留（`k="v"` 是浏览器线上传输形态，动了反而破坏鉴权）。
 * 归一化后为空（无任何 k=v 对）返回空串，调用方按 unauthorized 处理。
 */
export function normalizeCookieHeader(raw: string): string {
  return raw
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return ''
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      return name ? `${name}=${value}` : ''
    })
    .filter((pair) => pair !== '')
    .join('; ')
}

/** shape guard 公共前置：v 是非 null 对象（各平台 guard 首行统一用）。 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * JSON fetcher 共用骨架：凭证检查 → HTTP 状态归类 → JSON 解析 + shape guard →
 * 网络异常归类（logger.debug 落盘，禁止静默 catch）。doFetch 返回的 Response 由
 * 骨架消费 json()；guard 失败 / 解析失败归 parse。AbortSignal.timeout 由各
 * fetcher 在 doFetch 闭包内自带。
 */
export async function fetchQuotaJson<T>(
  logTag: string,
  doFetch: () => Promise<Response>,
  guard: (v: unknown) => v is T,
): Promise<{ ok: true; data: T } | { ok: false; reason: QuotaFetchFailureReason }> {
  try {
    const resp = await doFetch()
    if (!resp.ok) return { ok: false, reason: statusToReason(resp.status) }

    let data: T
    try {
      data = (await resp.json()) as T
    } catch {
      return { ok: false, reason: 'parse' }
    }
    if (!guard(data)) return { ok: false, reason: 'parse' }
    return { ok: true, data }
  } catch (err) {
    // fetch 网络异常 / 超时 → network（架构约定 #4 落盘，禁止静默 catch）
    const msg = toErrorMessage(err)
    logger.debug(`[${logTag}] fetch failed`, { error: msg })
    return { ok: false, reason: 'network' }
  }
}
