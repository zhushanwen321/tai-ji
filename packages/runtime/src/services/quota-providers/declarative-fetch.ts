/**
 * 声明式引擎请求执行层（2026-10 从 declarative-engine.ts 抽取，该文件行数门 ≤540）：
 * 主请求 + 辅助请求并行。method/body 来自请求条目声明（传输层扩展）；statusMap 特判 +
 * 统一 redirect:'manual' + statusToReason 3xx 判据都在此收敛。
 */

import type { QuotaFetchFailureReason } from './types.js'
import { isRecord, statusToReason } from './types.js'
import type { DeclarativeFetcherConfig } from './declarative-engine.js'

const REQUEST_TIMEOUT_MS = 8000

/** 单请求结果（fetchPrimary）：setCookies = 该响应捕获的原始 Set-Cookie 行（无则缺省）。 */
export type FetchPrimaryResult =
  | { ok: true; data: unknown; setCookies?: string[] }
  | { ok: false; reason: QuotaFetchFailureReason; setCookies?: string[] }

/** 读取响应全部 Set-Cookie 行（undici/Node 18.14+ 的 getSetCookie 逐条返回）。
 *  无 Set-Cookie 时返回 undefined（不带空数组——outcome 不得物化 setCookies 空键）。 */
function readSetCookies(resp: Response): string[] | undefined {
  const lines = resp.headers.getSetCookie().filter((line) => line !== '')
  return lines.length > 0 ? lines : undefined
}

/** 引擎自管的主请求（fetchQuotaJson 骨架只有 reason 通道，statusMap 需要原始 HTTP 状态）。
 *  method/body 来自请求条目声明（2026-10 传输层扩展：POST + 静态 body；缺省 GET）。
 *  拿到响应即捕获 Set-Cookie（含 !resp.ok 分支——服务端滑动续期常伴随 3xx/401 出现，
 *  消费与否由 service 按凭证形态裁决，引擎只透传不解释）。 */
export async function fetchPrimary(
  config: DeclarativeFetcherConfig,
  def: DeclarativeFetcherConfig['requests'][number],
  headers: Record<string, string>,
  doFetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<FetchPrimaryResult> {
  let resp: Response
  try {
    resp = await doFetch(def.url, {
      headers,
      ...(def.method !== undefined ? { method: def.method } : {}),
      ...(def.body !== undefined ? { body: def.body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  const setCookies = readSetCookies(resp)
  if (!resp.ok) {
    void resp.body?.cancel()
    const mapped = config.statusMap?.[String(resp.status)]
    return { ok: false, reason: mapped ?? statusToReason(resp.status), ...(setCookies && { setCookies }) }
  }
  try {
    const data: unknown = await resp.json()
    if (!isRecord(data)) return { ok: false, reason: 'parse', ...(setCookies && { setCookies }) }
    return { ok: true, data, ...(setCookies && { setCookies }) }
  } catch {
    return { ok: false, reason: 'parse', ...(setCookies && { setCookies }) }
  }
}

/** 辅助请求并行 + 独立 fail-safe（mimo detail：失败仅 resetSec 降级，不影响主数据）。
 *  allSettled 表达「独立数据源允许部分降级」：单请求失败不拖垮其余辅助请求。
 *  各响应捕获的 Set-Cookie（成功/失败分支均可能携带）合并返回，与主请求的合并后由
 *  service 消费。 */
export async function fetchAuxiliaryRequests(
  config: DeclarativeFetcherConfig,
  primaryDef: DeclarativeFetcherConfig['requests'][number],
  headers: Record<string, string>,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  reqs: { primaryName: string; byName: Record<string, unknown> },
): Promise<string[]> {
  const collected: string[] = []
  await Promise.allSettled(config.requests.filter(r => r !== primaryDef).map(async (def) => {
    const r = await fetchPrimary(config, def, headers, fetchImpl)
    if (r.ok) reqs.byName[def.name] = r.data
    if (r.setCookies) collected.push(...r.setCookies)
  }))
  return collected
}
