/**
 * Quota fetcher 声明式执行引擎（remote-config 域 2：quota-fetchers.json）。
 *
 * 设计：.tmp/tech-design/remote-config-and-quota.md §5。5 家现行 TS fetcher 的逻辑
 * 抽成声明式配置（基线 = baseline-fetchers.json 随发版更新；远程配置同 fetcherId
 * 整体覆盖），本引擎按配置执行。受限声明式原语集，非图灵完备——第 6 家新平台
 * 覆盖不住时按裁决回退「该 fetcher 留内置 TS」的混合形态，不为个案扩语言。
 *
 * 引擎内建纪律（配置无法关闭，RT-7#5「不可知纪律」的引擎化）：
 * - 字段缺失 → 该数据位 null（INFINITE_WIN 语义），绝不产假 0%/假 100%；
 * - 字段存在但形态漂移（数值字段拿到不可归一值）→ 整查询归 parse（fail-visible，
 *   不静默降级——对齐各家现行 shape guard 的「漂移可见」语义）；
 * - redirect:'manual' + 3xx → unauthorized（会话过期 302 到登录流的判据，mimo 实测）；
 * - label 插值路径缺失 → 去掉插值段并 strip 尾部分隔符（zhipu `Z.ai-{{level}}` 缺
 *   level → `Z.ai`）。
 */

import type { NormalizedQuotaRow, QuotaAuthKind, QuotaFetchFailureReason, QuotaFetchOutcome, QuotaWindow } from '@taiji/shared'
import { INFINITE_WIN, isRecord, isoResetRemaining, normalizeCookieHeader, numericField, statusToReason } from './types.js'
import { extractQuotaWorkspaceId } from '@taiji/shared'
import type { ProviderQuotaFetcher } from './types.js'

const REQUEST_TIMEOUT_MS = 8000
const SEC_PER_DAY = 86400
const SEC_PER_HOUR = 3600
const SEC_PER_MIN = 60
const PERCENT_SCALE = 100
const MS_PER_SEC = 1000

// ── 配置类型 ────────────────────────────────────────────────

export type QuotaSlot = 'fiveHour' | 'week' | 'month' // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
export type QuotaCredentialMode = 'bearer' | 'raw' | 'cookie' // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
export type ResetSecMode = 'iso' | 'epochMs' | 'relativeLabel' | 'zonelessUtcWallClock' | 'epochMsElseRelativeLabel' | 'relativeMs' // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
export type PctVia = 'direct' | 'percent01to100' | 'usedOverLimit' | 'remainingToUsed' // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）

/** 声明式窗口原语（字段语义见 baseline-fetchers.json 内逐家注释）。 */
export interface DeclarativeWindow { // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
  slot: QuotaSlot
  /** pct/usedLimit/resetSec 的默认源请求（单请求场景缺省 = 唯一请求）。 */
  fromRequest?: string
  /** 选取无命中升级语义（minimax find general 失败 → 整查询失败）。 */
  gate?: { path: string; missing: 'query-fail' | 'infinite-win' }
  /** 字段值门控：取值 !== equals → 本窗 INFINITE_WIN（minimax status 门控）。 */
  gateValue?: { path: string; equals: number }
  pct?: { path: string; via: PctVia }
  resetSec?: { path: string; mode: ResetSecMode; /** 覆写窗级 fromRequest（mimo resetSec 来自辅助请求）。 */ fromRequest?: string }
  usedLimit?: { used: string; limit: string; remaining?: string; unit: 'requests' | 'tokens' | 'credits';
    /** false = 仅用于派生 pct（usedOverLimit），不输出绝对量（opencode：micro-cents 比值中单位约掉，不做金额换算）。 */
    output?: boolean }
}

export interface DeclarativeFetcherConfig { // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
  /** NormalizedQuotaRow.label；`{{path}}` 单层插值，路径缺失 → strip 插值段（引擎纪律）。 */
  label: string
  auth: readonly QuotaAuthKind[]
  credential: QuotaCredentialMode
  /** true = 数值字段只接受原生 number（字符串数值归 parse）——各家 guard 严格度的配置化
   *  表达（zhipu/minimax/mimo 实测 guard 严格；kimi/opencode 实测数值串合法，缺省宽容）。 */
  strictNumbers?: boolean
  extraHeaders?: Record<string, string>
  /** 请求前置（opencode workspace 提取）：提取失败 → failReason，不发任何请求。 */
  precondition?: { from: 'workspaceUrl'; extractor: 'quotaWorkspaceId'; header: string; failReason: QuotaFetchFailureReason }
  requests: Array<{ name: string; url: string; role?: 'primary' | 'auxiliary' }>
  /** HTTP 状态特判（opencode 404）；未命中表 → 默认 statusToReason。 */
  statusMap?: Record<string, QuotaFetchFailureReason>
  /** 在体业务码：body[path] === success 放行；map[值] 分派；其余 → else（缺省 no-subscription）。
   *  successRequires：成功响应必须存在的对象路径（缺失/非对象 → parse——mimo 现行 guard
   *  「code=0 且 data 缺席」归 parse 的等价表达）。 */
  bodyCode?: { path: string; success: number | boolean; map?: Record<string, QuotaFetchFailureReason>; else?: QuotaFetchFailureReason; successRequires?: string }
  /** 数据源存在性：列出的顶层路径全部缺失/为空数组 → no-subscription（kimi/opencode）。 */
  requires?: string[]
  windows: DeclarativeWindow[]
}

// ── 配置 guard（字段级，拒绝即整体拒用回退基线）──────────────────

const CREDENTIAL_MODES: readonly QuotaCredentialMode[] = ['bearer', 'raw', 'cookie']
const SLOTS: readonly QuotaSlot[] = ['fiveHour', 'week', 'month']
const RESET_MODES: readonly ResetSecMode[] = ['iso', 'epochMs', 'relativeLabel', 'zonelessUtcWallClock', 'epochMsElseRelativeLabel', 'relativeMs']
const PCT_VIAS: readonly PctVia[] = ['direct', 'percent01to100', 'usedOverLimit', 'remainingToUsed']
const FAIL_REASONS: readonly string[] = ['unauthorized', 'network', 'no-subscription', 'parse', 'not_configured', 'no-credential', 'credential-unavailable', 'credential-unsupported']

function isFailReason(v: unknown): v is QuotaFetchFailureReason {
  return typeof v === 'string' && (FAIL_REASONS as readonly string[]).includes(v)
}

function isWindowValid(w: unknown): boolean {
  if (!isRecord(w)) return false
  if (typeof w['slot'] !== 'string' || !(SLOTS as readonly string[]).includes(w['slot'])) return false
  if (w['fromRequest'] !== undefined && typeof w['fromRequest'] !== 'string') return false
  if (w['gate'] !== undefined) {
    const g = w['gate']
    if (!isRecord(g) || typeof g['path'] !== 'string' || g['path'] === '') return false
    if (g['missing'] !== 'query-fail' && g['missing'] !== 'infinite-win') return false
  }
  if (w['gateValue'] !== undefined) {
    const g = w['gateValue']
    if (!isRecord(g) || typeof g['path'] !== 'string' || g['path'] === '' || typeof g['equals'] !== 'number') return false
  }
  if (w['pct'] !== undefined) {
    const p = w['pct']
    if (!isRecord(p)) return false
    // usedOverLimit 的 pct 由 usedLimit 派生，无独立字段路径
    const pathRequired = p['via'] !== 'usedOverLimit'
    if (typeof p['via'] !== 'string' || !(PCT_VIAS as readonly string[]).includes(p['via'])) return false
    if (pathRequired && (typeof p['path'] !== 'string' || p['path'] === '')) return false
  }
  if (w['resetSec'] !== undefined) {
    const r = w['resetSec']
    if (!isRecord(r) || typeof r['path'] !== 'string' || r['path'] === '') return false
    if (typeof r['mode'] !== 'string' || !(RESET_MODES as readonly string[]).includes(r['mode'])) return false
    if (r['fromRequest'] !== undefined && typeof r['fromRequest'] !== 'string') return false
  }
  if (w['usedLimit'] !== undefined) {
    const u = w['usedLimit']
    if (!isRecord(u) || typeof u['used'] !== 'string' || typeof u['limit'] !== 'string') return false
    if (u['remaining'] !== undefined && typeof u['remaining'] !== 'string') return false
    if (u['unit'] !== undefined && typeof u['unit'] !== 'string') return false
  }
  return true
}

/** 声明式配置形状 guard（决策依赖字段全字段级校验；拒绝 = 整体拒用）。 */
export function isDeclarativeFetcherConfig(v: unknown): v is DeclarativeFetcherConfig {
  if (!isRecord(v)) return false
  if (typeof v['label'] !== 'string' || v['label'] === '') return false
  if (!Array.isArray(v['auth']) || !(v['auth'] as unknown[]).every(a => typeof a === 'string')) return false
  if (typeof v['credential'] !== 'string' || !(CREDENTIAL_MODES as readonly string[]).includes(v['credential'])) return false
  if (v['strictNumbers'] !== undefined && typeof v['strictNumbers'] !== 'boolean') return false
  if (v['extraHeaders'] !== undefined && !isRecord(v['extraHeaders'])) return false
  if (v['precondition'] !== undefined) {
    const p = v['precondition']
    if (!isRecord(p)) return false
    if (p['from'] !== 'workspaceUrl' || p['extractor'] !== 'quotaWorkspaceId') return false
    if (typeof p['header'] !== 'string' || p['header'] === '') return false
    if (!isFailReason(p['failReason'])) return false
  }
  if (!Array.isArray(v['requests']) || (v['requests'] as unknown[]).length === 0) return false
  for (const r of v['requests'] as unknown[]) {
    if (!isRecord(r) || typeof r['name'] !== 'string' || r['name'] === '' || typeof r['url'] !== 'string' || r['url'] === '') return false
    if (r['role'] !== undefined && r['role'] !== 'primary' && r['role'] !== 'auxiliary') return false
  }
  if (v['statusMap'] !== undefined) {
    if (!isRecord(v['statusMap'])) return false
    if (!Object.values(v['statusMap']).every(isFailReason)) return false
  }
  if (v['bodyCode'] !== undefined) {
    const b = v['bodyCode']
    if (!isRecord(b) || typeof b['path'] !== 'string' || b['path'] === '') return false
    if (typeof b['success'] !== 'number' && typeof b['success'] !== 'boolean') return false
    if (b['map'] !== undefined && !isRecord(b['map'])) return false
    if (b['else'] !== undefined && !isFailReason(b['else'])) return false
    if (b['successRequires'] !== undefined && (typeof b['successRequires'] !== 'string' || b['successRequires'] === '')) return false
  }
  if (v['requires'] !== undefined && !Array.isArray(v['requires'])) return false
  if (!Array.isArray(v['windows']) || (v['windows'] as unknown[]).length === 0) return false
  return (v['windows'] as unknown[]).every(isWindowValid)
}

// ── 字段路径原语 ────────────────────────────────────────────

/** 路径段：`name` | `name[0]`（下标）| `name[k=v]`（条件选取首命中）。
 * 语义对齐各家现行 shape guard：字段缺失合法（undefined 透传）；**期望容器处拿到非容器**
 * （非对象上取属性 / 非数组上下标选取）= wire 形态漂移 → WireDriftError（fail-visible 归
 * parse，不静默当缺失降级）。 */
function pickPath(data: unknown, path: string): unknown {
  let cur: unknown = data
  for (const seg of path.split('.')) {
    if (cur === undefined || cur === null) return undefined
    const m = seg.match(/^([^\[]+)((?:\[[^\]]*\])?)$/)
    if (!m) return undefined
    const [, key, bracket] = m
    if (typeof cur !== 'object' || cur === null) {
      throw new WireDriftError(`container expected at '${key}' in '${path}'`)
    }
    cur = (cur as Record<string, unknown>)[key]
    if (!bracket) continue
    const idx = bracket.match(/^\[(\d+)\]$/)
    if (idx) {
      if (!Array.isArray(cur)) {
        if (cur === undefined || cur === null) return undefined
        throw new WireDriftError(`array expected at '${key}${bracket}' in '${path}'`)
      }
      cur = cur[Number(idx[1])]
      continue
    }
    const cond = bracket.match(/^\[([^=\]]+)=([^\]]+)\]$/)
    if (cond) {
      if (!Array.isArray(cur)) {
        if (cur === undefined || cur === null) return undefined
        throw new WireDriftError(`array expected at '${key}${bracket}' in '${path}'`)
      }
      // 严格 string 比较（与各家现行 find(m => m[k] === 'v') 逐字对齐）；数组非空但无命中、
      // 且存在条目的条件字段为非 string 类型 = 类型漂移致无命中 → parse（fail-visible，
      // 对齐 minimax guard 的 model_name 字段级类型校验——正常无命中（值不同）才降级缺失）
      const hit = cur.find((e) => isRecord(e) && (e as Record<string, unknown>)[cond[1]] === cond[2])
      if (!hit && cur.length > 0) {
        const drifted = cur.some((e) => {
          if (!isRecord(e)) return true
          const v = (e as Record<string, unknown>)[cond[1]]
          return typeof v !== 'string'
        })
        if (drifted) throw new WireDriftError(`condition field type drift at '${key}${bracket}' in '${path}'`)
      }
      cur = hit
      continue
    }
    return undefined
  }
  return cur
}

/** 归一失败信号（引擎纪律：字段存在但不可归一 → parse，fail-visible）。 */
class WireDriftError extends Error {}

/** wire 数值归一：缺失合法；存在则必须可归一，否则漂移归 parse。strict = 只接受原生
 * number（字符串数值归 parse，per-fetcher strictNumbers 承载各家 guard 严格度差异）。 */
function strictNumeric(v: unknown, strict = false): number | undefined {
  if (v === undefined || v === null) return undefined
  if (strict && typeof v !== 'number') throw new WireDriftError(`non-number field: ${JSON.stringify(v)}`)
  const n = numericField(v)
  if (n === undefined) throw new WireDriftError(`unparseable numeric field: ${JSON.stringify(v)}`)
  return n
}

function strictString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new WireDriftError(`non-string field: ${JSON.stringify(v)}`)
  return v
}

// ── 原语求值 ────────────────────────────────────────────────

function parseRelativeLabel(label: string): number {
  const d = label.match(/(\d+)d/)
  const h = label.match(/(\d+)h/)
  const m = label.match(/(\d+)m/)
  let sec = 0
  if (d) sec += Number(d[1]) * SEC_PER_DAY
  if (h) sec += Number(h[1]) * SEC_PER_HOUR
  if (m) sec += Number(m[1]) * SEC_PER_MIN
  return sec
}

/** resetSec 各模式（语义见 DeclarativeWindow.resetSec 注释）。返回 null = 无重置信息。 */
function evalResetSec(raw: unknown, mode: ResetSecMode): number | null {
  const epochOf = (s: string): number | null => {
    const ms = Number(s)
    if (!ms || Number.isNaN(ms)) return null
    const rem = Math.floor(ms / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
    return rem > 0 ? rem : null
  }
  if (mode === 'iso') {
    const s = strictString(raw)
    return s ? isoResetRemaining(s) : null
  }
  if (mode === 'epochMs') {
    const n = strictNumeric(raw)
    if (n === undefined) return null
    const rem = Math.floor(n / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
    return rem > 0 ? rem : null
  }
  if (mode === 'relativeLabel') {
    const s = strictString(raw)
    return s ? parseRelativeLabel(s) : null
  }
  if (mode === 'zonelessUtcWallClock') {
    const s = strictString(raw)
    if (!s) return null
    // 无时区标记串按 UTC 解析（与固定发送的 x-timezone: UTC 强一致，mimo 实测）；带标记串 Date.parse 直解
    const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)
    const t = zoneless ? Date.parse(`${s.replace(' ', 'T')}Z`) : Date.parse(s)
    if (Number.isNaN(t)) return null
    const sec = Math.floor((t - Date.now()) / MS_PER_SEC)
    return sec > 0 ? sec : null
  }
  if (mode === 'relativeMs') {
    const n = strictNumeric(raw)
    return n !== undefined && n > 0 ? Math.ceil(n / MS_PER_SEC) : null
  }
  // epochMsElseRelativeLabel：number/数值串走 epoch；非数值串走相对 label（zhipu 双格式）
  if (typeof raw === 'number') return evalResetSec(raw, 'epochMs')
  const s = strictString(raw)
  if (s === undefined) return null
  return epochOf(s) ?? parseRelativeLabel(s)
}

/** label 模板插值：`{{path}}` 替换；任一路径缺失 → strip 全部插值段 + strip 尾部 `- `。 */
function evalLabel(template: string, data: unknown): string {
  if (!template.includes('{{')) return template
  const segs = template.match(/\{\{([^}]+)\}\}/g) ?? []
  console.error('PROBE label:', template, 'segs:', JSON.stringify(segs), 'level:', JSON.stringify(pickPath(data, 'level')))
  const allPresent = segs.every((s) => pickPath(data, s.slice(2, -2)) !== undefined)
  if (allPresent) {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, p: string) => String(pickPath(data, p) ?? ''))
  }
  return template.replace(/\{\{[^}]+\}\}/g, '').replace(/[-\s]+$/, '')
}

/** 请求结果按名索引（主请求与辅助请求同一名空间——window fromRequest 可引用任一）。 */
interface ResolvedRequests { // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
  primaryName: string
  byName: Record<string, unknown>
}

/** requires 判定：路径取值 undefined/null 或空数组 = 缺；全部缺 → true。 */
function allRequiresMissing(data: unknown, requires: string[]): boolean {
  return requires.every((p) => {
    const v = pickPath(data, p)
    return v === undefined || v === null || (Array.isArray(v) && v.length === 0)
  })
}

function evalWindow(
  win: DeclarativeWindow,
  reqs: ResolvedRequests,
  strict: boolean,
): { win: QuotaWindow; queryFail?: true } {
  const source = win.fromRequest ? reqs.byName[win.fromRequest] : reqs.byName[reqs.primaryName]

  if (win.gate) {
    const hit = pickPath(source, win.gate.path)
    if (hit === undefined || hit === null) {
      if (win.gate.missing === 'query-fail') return { win: INFINITE_WIN, queryFail: true }
      return { win: INFINITE_WIN }
    }
  }
  if (win.gateValue) {
    const v = strictNumeric(pickPath(source, win.gateValue.path), strict)
    if (v !== undefined && v !== win.gateValue.equals) return { win: INFINITE_WIN }
  }

  // 绝对量（usedLimit）：used 折算内建（used ?? limit−remaining，均缺不输出）
  let usedLimit: { used: number; limit: number; unit: NonNullable<QuotaWindow['unit']> } | undefined
  if (win.usedLimit) {
    const limit = strictNumeric(pickPath(source, win.usedLimit.limit), strict)
    const usedRaw = strictNumeric(pickPath(source, win.usedLimit.used), strict)
    const remaining = win.usedLimit.remaining ? strictNumeric(pickPath(source, win.usedLimit.remaining), strict) : undefined
    const used = usedRaw ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
    if (limit !== undefined && used !== undefined && limit > 0) {
      usedLimit = { used, limit, unit: (win.usedLimit.unit ?? 'requests') as NonNullable<QuotaWindow['unit']> }
    }
  }

  // pct
  let pct: number | null = null
  if (win.pct && win.pct.path) {
    const raw = strictNumeric(pickPath(source, win.pct.path), strict)
    if (raw !== undefined) {
      if (win.pct.via === 'direct') pct = raw
      else if (win.pct.via === 'percent01to100') pct = raw * PERCENT_SCALE
      else if (win.pct.via === 'remainingToUsed') pct = Math.max(0, Math.min(PERCENT_SCALE, PERCENT_SCALE - raw))
      // usedOverLimit：pct 由 usedLimit 派生（下方）
    }
  }
  // pct direct 缺失 = 主数据不可知 → 整窗 INFINITE_WIN（resetSec 同折 null，zhipu 现行
  // 语义「TOKENS_LIMIT percentage 缺失 → INFINITE_WIN」；percent01to100/remainingToUsed
  // 的主数据是 percent 本身，缺失仅 pct=null、resetSec 独立输出——mimo/minimax 现行）
  if (win.pct?.via === 'direct' && pct === null) return { win: INFINITE_WIN }
  if (win.pct?.via === 'usedOverLimit') {
    // pct 由绝对量派生时，绝对量缺失 = 主数据不可知 → 整窗 INFINITE_WIN（resetSec 同折 null，
    // 对齐 opencode/kimi 现行语义——与 mimo「pct 缺失仅 pct=null、resetSec 独立输出」相区分）
    if (!usedLimit) return { win: INFINITE_WIN }
    pct = Math.round((usedLimit.used / usedLimit.limit) * PERCENT_SCALE)
  }

  // resetSec 源：可覆写窗级源请求（mimo resetSec 来自辅助 detail 请求）
  const resetSrc = win.resetSec?.fromRequest ? reqs.byName[win.resetSec.fromRequest] : source
  const resetSec = win.resetSec ? evalResetSec(pickPath(resetSrc, win.resetSec.path), win.resetSec.mode) : null

  if (usedLimit && win.usedLimit?.output !== false) {
    return { win: { pct, used: usedLimit.used, limit: usedLimit.limit, unit: usedLimit.unit, resetSec } }
  }
  return { win: { pct, resetSec } }
}

/** 盲跑全部窗口声明路径（只验形态不消费值；辅助请求路径缺失合法跳过）。 */
function prevalidateWindowPaths(config: DeclarativeFetcherConfig, primary: unknown): void {
  const primaryDef = config.requests.find(r => r.role !== 'auxiliary') ?? config.requests[0]
  for (const win of config.windows) {
    const source = win.fromRequest ? reqsByName(primary, primaryDef.name, win.fromRequest) : primary
    const touch = (p: string | undefined): void => {
      if (p) pickPath(source, p)
    }
    if (win.gate) touch(win.gate.path)
    if (win.gateValue) touch(win.gateValue.path)
    if (win.pct?.path) touch(win.pct.path)
    if (win.resetSec) touch(win.resetSec.path)
    if (win.usedLimit) {
      touch(win.usedLimit.used)
      touch(win.usedLimit.limit)
      if (win.usedLimit.remaining) touch(win.usedLimit.remaining)
    }
  }
}

/** window 路径的请求源解析（辅助请求缺失/未成功 = 该窗数据不可知，路径盲跑跳过）。 */
function reqsByName(primary: unknown, primaryName: string, name: string | undefined): unknown {
  if (name === undefined || name === primaryName) return primary
  return undefined
}

/** 构造 credential header（引擎统一 redirect:'manual' + statusToReason 3xx 判据）。 */
function buildHeaders(config: DeclarativeFetcherConfig, credential: string, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json, text/plain, */*', ...extra }
  if (config.credential === 'bearer') headers['authorization'] = `Bearer ${credential}`
  else if (config.credential === 'raw') headers['authorization'] = credential
  else headers['cookie'] = normalizeCookieHeader(credential)
  return headers
}

/** 引擎自管的主请求（fetchQuotaJson 骨架只有 reason 通道，statusMap 需要原始 HTTP 状态）。 */
async function fetchPrimary(
  config: DeclarativeFetcherConfig,
  url: string,
  headers: Record<string, string>,
  doFetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: QuotaFetchFailureReason }> {
  let resp: Response
  try {
    resp = await doFetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'manual' })
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

/**
 * 执行声明式 fetcher（ProviderQuotaFetcher.fetchQuota 的引擎实现）。
 * doFetch 注入参数供测试；生产走全局 fetch。
 */
export async function runDeclarativeFetcher(
  config: DeclarativeFetcherConfig,
  credential: string,
  fetcherConfig?: { workspaceUrl?: string },
  doFetch?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<QuotaFetchOutcome> {
  if (!credential) return { ok: false, reason: 'unauthorized' }

  const extra = { ...(config.extraHeaders ?? {}) }
  if (config.precondition) {
    const from = fetcherConfig?.[config.precondition.from]
    const value = from && config.precondition.extractor === 'quotaWorkspaceId' ? extractQuotaWorkspaceId(from) : undefined
    if (!value) return { ok: false, reason: config.precondition.failReason }
    extra[config.precondition.header] = value
  }
  const headers = buildHeaders(config, credential, extra)

  const fetchImpl = doFetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const primaryDef = config.requests.find(r => r.role !== 'auxiliary') ?? config.requests[0]
  const primary = await fetchPrimary(config, primaryDef.url, headers, fetchImpl)
  if (!primary.ok) return primary
  const reqs: ResolvedRequests = { primaryName: primaryDef.name, byName: { [primaryDef.name]: primary.data } }
  // 辅助请求并行 + 独立 fail-safe（mimo detail：失败仅 resetSec 降级，不影响主数据）
  await Promise.all(config.requests.filter(r => r !== primaryDef).map(async (def) => {
    const r = await fetchPrimary(config, def.url, headers, fetchImpl)
    if (r.ok) reqs.byName[def.name] = r.data
  }))

  // 求值段（业务码/存在性/窗口/label）：任何 wire 形态漂移（WireDriftError）→ parse，
  // fail-visible 不静默降级（对齐各家现行 shape guard 的「漂移可见」语义）。
  // 预校验：现行 guard 是全表面预校验（任一字段漂移即整体拒收），引擎按需求值会让
  // bodyCode/requires 提前短路遮蔽后续路径的漂移——先盲跑全部窗口路径的形态检查再进业务判定。
  try {
    prevalidateWindowPaths(config, reqs.byName[reqs.primaryName])
    // 在体业务码（mimo code / minimax base_resp.status_code / zhipu success boolean）
    if (config.bodyCode) {
      const rawCode = pickPath(reqs.byName[reqs.primaryName], config.bodyCode.path)
      // 现状各家 guard 均要求 code 原生 number/boolean（字符串形态 = 漂移归 parse，
      // 防 "401" 绕过类型检查命中 map）
      if (rawCode !== undefined && rawCode !== null && typeof rawCode !== 'number' && typeof rawCode !== 'boolean') {
        throw new WireDriftError(`non-numeric body code: ${JSON.stringify(rawCode)}`)
      }
      const code = rawCode
      if (code !== config.bodyCode.success) {
        const reason = (typeof code === 'string' || typeof code === 'number')
          ? config.bodyCode.map?.[String(code)]
          : undefined
        return { ok: false, reason: reason ?? config.bodyCode.else ?? 'no-subscription' }
      }
      if (config.bodyCode.successRequires !== undefined) {
        const required = pickPath(reqs.byName[reqs.primaryName], config.bodyCode.successRequires)
        if (!isRecord(required)) return { ok: false, reason: 'parse' }
      }
    }

    // 数据源存在性（kimi limits/usage、opencode 三 meter 对象级）
    if (config.requires && allRequiresMissing(reqs.byName[reqs.primaryName], config.requires)) {
      return { ok: false, reason: 'no-subscription' }
    }

    // 窗口装配（未声明的 slot 恒 INFINITE_WIN）
    const wins: Record<QuotaSlot, QuotaWindow> = { fiveHour: INFINITE_WIN, week: INFINITE_WIN, month: INFINITE_WIN }
    for (const win of config.windows) {
      const r = evalWindow(win, reqs, config.strictNumbers === true)
      if (r.queryFail) return { ok: false, reason: 'no-subscription' }
      wins[win.slot] = r.win
    }

    return { ok: true, data: { label: evalLabel(config.label, reqs.byName[reqs.primaryName]), wins: [wins.fiveHour, wins.week, wins.month] } }
  } catch (e) {
    if (e instanceof WireDriftError) return { ok: false, reason: 'parse' }
    throw e
  }
}
