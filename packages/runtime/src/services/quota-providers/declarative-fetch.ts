/**
 * 声明式引擎请求执行层（2026-10 从 declarative-engine.ts 抽取，该文件行数门 ≤540）：
 * 主请求 + 辅助请求并行。method/body 来自请求条目声明（传输层扩展）；statusMap 特判 +
 * 统一 redirect:'manual' + statusToReason 3xx 判据都在此收敛。
 */

import type { QuotaFetchFailureReason } from './types.js'
import { isRecord, statusToReason } from './types.js'
import type { DeclarativeFetcherConfig } from './declarative-engine.js'

const REQUEST_TIMEOUT_MS = 8000

/** 引擎自管的主请求（fetchQuotaJson 骨架只有 reason 通道，statusMap 需要原始 HTTP 状态）。
 *  method/body 来自请求条目声明（2026-10 传输层扩展：POST + 静态 body；缺省 GET）。 */
export async function fetchPrimary(
  config: DeclarativeFetcherConfig,
  def: DeclarativeFetcherConfig['requests'][number],
  headers: Record<string, string>,
  doFetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: QuotaFetchFailureReason }> {
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
  if (!resp.ok) {
    void resp.body?.cancel()
    const mapped = config.statusMap?.[String(resp.status)]
    return { ok: false, reason: mapped ?? statusToReason(resp.status) }
  }
  try {
    const data: unknown = await resp.json()
    if (!isRecord(data)) return { ok: false, reason: 'parse' }
    return { ok: true, data }
  } catch {
    return { ok: false, reason: 'parse' }
  }
}

/** 辅助请求并行 + 独立 fail-safe（mimo detail：失败仅 resetSec 降级，不影响主数据）。
 *  allSettled 表达「独立数据源允许部分降级」：单请求失败不拖垮其余辅助请求。 */
export async function fetchAuxiliaryRequests(
  config: DeclarativeFetcherConfig,
  primaryDef: DeclarativeFetcherConfig['requests'][number],
  headers: Record<string, string>,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  reqs: { primaryName: string; byName: Record<string, unknown> },
): Promise<void> {
  await Promise.allSettled(config.requests.filter(r => r !== primaryDef).map(async (def) => {
    const r = await fetchPrimary(config, def, headers, fetchImpl)
    if (r.ok) reqs.byName[def.name] = r.data
  }))
}
