/**
 * 声明式引擎动态请求头（headerFroms）——guard + 解析（2026-10 quota-params 泛化波次
 * 从 declarative-engine.ts 抽取，该文件行数门 ≤540）。
 *
 * 两种来源：
 * - params：取用户配置的 quotaParams[key]（可经 extractor 反提取）——用户维度隔离参数
 *   注入（opencode workspace id → x-org-id）；缺失 → failReason 失败（不发请求）；
 * - cookie：从用户粘贴的 cookie 派生字段值（stepfun Oasis-Webid → oasis-webid）；
 *   缺失该对 = 不置头（best-effort，无 failReason）。
 */

import type { QuotaFetchFailureReason } from './types.js'
import { extractQuotaWorkspaceId } from '@taiji/shared'
import { isFailReason, isRecord } from './types.js'

/** headerFroms 元素（与 declarative-engine DeclarativeHeaderFrom 同构；经 engine 类型再导出）。 */
export interface HeaderFrom { // oe-exempt:20261025:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好），与 declarative-engine 各 Declarative* 形状同族
  from: 'params' | 'cookie'
  /** params 键名 / cookie 字段名。 */
  key: string
  extractor?: 'quotaWorkspaceId'
  /** 注入的请求头名。 */
  header: string
  /** params 缺失时的失败 reason（不发请求）；缺省 = best-effort 不置该头。 */
  failReason?: QuotaFetchFailureReason
}

const HEADER_FROM_SOURCES: readonly string[] = ['params', 'cookie']

/** headerFroms 元素 guard：来源封闭词表 + key/header 非空 + extractor 封闭词表 + failReason 合法。 */
export function isHeaderFromValid(h: unknown): boolean {
  if (!isRecord(h)) return false
  if (typeof h['from'] !== 'string' || !HEADER_FROM_SOURCES.includes(h['from'])) return false
  if (typeof h['key'] !== 'string' || h['key'] === '') return false
  if (typeof h['header'] !== 'string' || h['header'] === '') return false
  if (h['extractor'] !== undefined && h['extractor'] !== 'quotaWorkspaceId') return false
  // cookie 源是 best-effort 语义（缺失不置头），failReason 仅 params 源有意义
  if (h['failReason'] !== undefined && !isFailReason(h['failReason'])) return false
  return h['from'] === 'cookie' || h['failReason'] !== undefined
}

/** headerFroms 段 guard（数组 + 元素逐个过 guard）。 */
export function isHeaderFromsValid(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isHeaderFromValid))
}

/** 从归一化 cookie 串取指定字段值（缺失/空值 = undefined）。 */
export function extractCookieField(cookie: string, field: string): string | undefined {
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq).trim().toLowerCase() === field.toLowerCase()) {
      const value = pair.slice(eq + 1).trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/**
 * 动态请求头解析：params 源缺失/反提取失败 → failReason（整体失败，不发请求）；
 * cookie 源缺失 → 不置该头。返回 failure = 调用方整体落该 reason。
 */
export function resolveHeaderFroms(
  headerFroms: readonly HeaderFrom[],
  credential: string,
  quotaParams?: Record<string, string>,
): { headers: Record<string, string> } | { failure: QuotaFetchFailureReason } {
  const headers: Record<string, string> = {}
  for (const hf of headerFroms) {
    if (hf.from === 'params') {
      const raw = quotaParams?.[hf.key]
      if (raw === undefined || raw === '') {
        if (hf.failReason !== undefined) return { failure: hf.failReason }
        continue
      }
      const value = hf.extractor === 'quotaWorkspaceId' ? extractQuotaWorkspaceId(raw) : raw
      if (value === null) {
        if (hf.failReason !== undefined) return { failure: hf.failReason }
        continue
      }
      headers[hf.header] = value
    } else {
      const value = extractCookieField(credential, hf.key)
      if (value !== undefined) headers[hf.header] = value
    }
  }
  return { headers }
}
