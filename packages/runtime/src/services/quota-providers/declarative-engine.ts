/**
 * Quota fetcher 声明式执行引擎（remote-config 域 2：quota-fetchers.json）。
 *
 * 设计：.tmp/tech-design/remote-config-and-quota.md §5。5 家现行 TS fetcher 的逻辑
 * 抽成声明式配置（基线 = baseline-fetchers.json 随发版更新；远程配置同 fetcherId
 * 整体覆盖），本引擎按配置执行。受限声明式原语集，非图灵完备——第 6 家新平台
 * 覆盖不住时按裁决回退「该 fetcher 留内置 TS」的混合形态，不为个案扩语言。
 *
 * 引擎内建纪律（配置无法关闭，RT-7#5「不可知纪律」的引擎化）：
 * - 字段缺失 → 该数据位 null（INFINITE_WIN 语义），绝不产假 0%/假 100%；bodyCode 决策
 *   字段缺失按 bodyCode.missing 归口（缺省业务失败 else——minimax/zhipu 现行；'parse' =
 *   漂移可见——mimo 现行 guard 要求 code 必在）；
 * - 字段存在但形态漂移（数值字段拿到不可归一值）→ 整查询归 parse（fail-visible，
 *   不静默降级——对齐各家现行 shape guard 的「漂移可见」语义）；唯一例外：独立降级源
 *   （辅助请求）的 resetSec 字段漂移仅降级该数据位 null——请求级失败已由 allSettled
 *   独立降级（fetchAuxiliaryRequests），字段级同语义，辅助端点故障不拖垮主数据（mimo）；
 * - redirect:'manual' + 3xx → unauthorized（会话过期 302 到登录流的判据，mimo 实测）；
 * - label 插值路径缺失 → 去掉插值段并 strip 尾部分隔符（zhipu `Z.ai-{{level}}` 缺
 *   level → `Z.ai`）。
 */

import type { QuotaAuthKind, QuotaFetchFailureReason, QuotaFetchOutcome, QuotaWindow } from '@taiji/shared'
import { INFINITE_WIN, isFailReason, isRecord, isoResetRemaining, numericField } from './types.js'
import { isHeaderFromsValid, resolveHeaderFroms, type HeaderFrom } from './header-froms.js'
import { fetchAuxiliaryRequests, fetchPrimary } from './declarative-fetch.js'
import { normalizeCookieHeader } from '@taiji/shared'

/** 动态请求头来源（2026-10 泛化，替代原 precondition 单通道；实现与 guard 在 header-froms.ts）。 */
export type DeclarativeHeaderFrom = HeaderFrom

const SEC_PER_DAY = 86400
const SEC_PER_HOUR = 3600
const SEC_PER_MIN = 60
const PERCENT_SCALE = 100
const MS_PER_SEC = 1000
/** epoch 单位消歧阈值：秒级戳恒 < 1e11，毫秒级戳恒 > 1e11（见 evalEpochSecOrMsReset）。 */
const EPOCH_MS_THRESHOLD = 1e11
/** label 插值定界符 `{{` / `}}` 的长度（slice 剥壳用）。 */
const LABEL_DELIM_LEN = 2

// ── 配置类型 ────────────────────────────────────────────────

export type QuotaSlot = 'fiveHour' | 'week' | 'month' // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
export type QuotaCredentialMode = 'bearer' | 'raw' | 'cookie' // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
export type ResetSecMode = 'iso' | 'epochMs' | 'relativeLabel' | 'zonelessUtcWallClock' | 'epochMsElseRelativeLabel' | 'relativeMs' | 'epochSecOrMs' // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
export type PctVia = 'direct' | 'percent01to100' | 'usedOverLimit' | 'remainingToUsed' | 'fractionRemainingToUsed' // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
/** HTTP 方法（2026-10 传输层扩展：请求条目可声明 POST + 静态 body；缺省 GET 保持存量语义）。 */
export type QuotaRequestMethod = 'GET' | 'POST' // oe-exempt:20261026:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
/** bodyCode.success 合法元素（protojson 枚举可为名称串或数值——双形态兼容）。 */
export type BodyCodeSuccess = string | number | boolean // oe-exempt:20261026:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）

/** 声明式窗口原语（字段语义见 baseline-fetchers.json 内逐家注释）。 */
export interface DeclarativeWindow { // oe-exempt:20261019:framework:taiji 远程配置域内形状——接口先立单实现常态（本仓架构偏好）
  slot: QuotaSlot
  /** pct/usedLimit/resetSec 的默认源请求（单请求场景缺省 = 唯一请求）。 */
  fromRequest?: string
  /** 选取无命中升级语义（minimax find general 失败 → 整查询失败）。 */
  gate?: { path: string; missing: 'query-fail' | 'infinite-win' }
  /** 字段值门控：取值 !== equals（含字段缺失 = 状态不可知）→ 本窗 INFINITE_WIN（minimax status 门控）；
   *  notEquals 反义门控（stepfun plan_family：TOKEN 家族不展示 5h/周窗口——平台前端同判据）；
   *  equals 与 notEquals 至少声明一个（guard 强制）。 */
  gateValue?: { path: string | string[]; equals?: number; notEquals?: number }
  pct?: { path: string | string[]; via: PctVia }
  resetSec?: { path: string | string[]; mode: ResetSecMode; /** 覆写窗级 fromRequest（mimo resetSec 来自辅助请求）。 */ fromRequest?: string }
  usedLimit?: { used: string | string[]; limit: string | string[]; remaining?: string | string[]; unit: 'requests' | 'tokens' | 'credits';
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
  /**
   * 动态请求头来源列表（2026-10 泛化，替代原 precondition 单通道）：params 源实现
   * 用户维度参数注入（opencode workspace id → x-org-id），cookie 源实现凭据派生头
   * （stepfun Oasis-Webid → oasis-webid）。缺失 failReason 的条目 = best-effort。
   */
  headerFroms?: DeclarativeHeaderFrom[]
  requests: Array<{ name: string; url: string; role?: 'primary' | 'auxiliary'; method?: QuotaRequestMethod; body?: string }>
  /** HTTP 状态特判（opencode 404）；未命中表 → 默认 statusToReason。 */
  statusMap?: Record<string, QuotaFetchFailureReason>
  /** 在体业务码：body[path] === success 放行；map[值] 分派；其余 → else（缺省 no-subscription）。
   *  successRequires：成功响应必须存在的对象路径（缺失/非对象 → parse——mimo 现行 guard
   *  「code=0 且 data 缺席」归 parse 的等价表达）。
   *  missing：决策字段本身缺失（undefined/null）的归口——'parse' = 形态漂移可见（mimo 现行
   *  guard `typeof o.code !== 'number'` 即拒收，字段消失不能被 else 引导为「查订阅」）；
   *  缺省 'else' = 业务失败（minimax/zhipu 现行「决策字段缺席 = 无订阅数据」语义）。
   *  success：标量或数组（2026-10 protojson 枚举双形态——'CODE_OK' 名称串或数值 1 任一命中即放行）。 */
  bodyCode?: { path: string | string[]; success: BodyCodeSuccess | readonly BodyCodeSuccess[]; map?: Record<string, QuotaFetchFailureReason>; else?: QuotaFetchFailureReason; successRequires?: string | string[]; missing?: 'else' | 'parse' }
  /** 数据源存在性：列出的顶层路径全部缺失/为空数组 → no-subscription（kimi/opencode）。 */
  requires?: string[]
  windows: DeclarativeWindow[]
}

// ── 配置 guard（字段级，拒绝即整体拒用回退基线）──────────────────

const CREDENTIAL_MODES: readonly QuotaCredentialMode[] = ['bearer', 'raw', 'cookie']
const SLOTS: readonly QuotaSlot[] = ['fiveHour', 'week', 'month']
const RESET_MODES: readonly ResetSecMode[] = ['iso', 'epochMs', 'relativeLabel', 'zonelessUtcWallClock', 'epochMsElseRelativeLabel', 'relativeMs', 'epochSecOrMs']
const PCT_VIAS: readonly PctVia[] = ['direct', 'percent01to100', 'usedOverLimit', 'remainingToUsed', 'fractionRemainingToUsed']
const REQUEST_METHODS: readonly QuotaRequestMethod[] = ['GET', 'POST']

/** 路径字段形态：单路径串或双形态数组（protojson camelCase / snake_case 皆合法，首命中生效）。 */
function isPathValid(v: unknown): boolean {
  if (typeof v === 'string') return v !== ''
  return Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string' && p !== '')
}

// 窗口 guard 按子对象分组（每组只对一组决策依赖字段负责；分组本身 = DeclarativeWindow
// 的可选字段清单，主 guard 逐字段调子 guard）。

function isGateValid(g: unknown): boolean {
  if (!isRecord(g) || typeof g['path'] !== 'string' || g['path'] === '') return false
  return g['missing'] === 'query-fail' || g['missing'] === 'infinite-win'
}

function isGateValueValid(g: unknown): boolean {
  if (!isRecord(g) || !isPathValid(g['path'])) return false
  const hasEquals = typeof g['equals'] === 'number'
  const hasNotEquals = typeof g['notEquals'] === 'number'
  // equals / notEquals 至少一个（且类型为 number）——全缺 = 恒真门控无意义，拒
  return hasEquals || hasNotEquals
}

function isPctValid(p: unknown): boolean {
  if (!isRecord(p)) return false
  // usedOverLimit 的 pct 由 usedLimit 派生，无独立字段路径
  const pathRequired = p['via'] !== 'usedOverLimit'
  if (typeof p['via'] !== 'string' || !(PCT_VIAS as readonly string[]).includes(p['via'])) return false
  return !pathRequired || isPathValid(p['path'])
}

function isResetSecValid(r: unknown): boolean {
  if (!isRecord(r) || !isPathValid(r['path'])) return false
  if (typeof r['mode'] !== 'string' || !(RESET_MODES as readonly string[]).includes(r['mode'])) return false
  return r['fromRequest'] === undefined || typeof r['fromRequest'] === 'string'
}

function isUsedLimitValid(u: unknown): boolean {
  if (!isRecord(u) || !isPathValid(u['limit'])) return false
  // used 可选：used 直给 ∵ limit−remaining 折算两种派生源至少其一（stepfun 月度 credit 只有
  // total+residual——残值是剩余量，used 由引擎折算，禁止把残值当 used 的倒置映射）
  if (u['used'] !== undefined && !isPathValid(u['used'])) return false
  if (u['remaining'] !== undefined && !isPathValid(u['remaining'])) return false
  const hasUsed = u['used'] !== undefined
  const hasRemaining = u['remaining'] !== undefined
  if (!(hasUsed || hasRemaining)) return false
  return u['unit'] === undefined || typeof u['unit'] === 'string'
}

/** 窗口基础字段（slot + fromRequest）。 */
function isWindowBaseFieldsValid(w: Record<string, unknown>): boolean {
  if (typeof w['slot'] !== 'string' || !(SLOTS as readonly string[]).includes(w['slot'])) return false
  if (w['fromRequest'] !== undefined && typeof w['fromRequest'] !== 'string') return false
  return true
}

/** 可选子对象字段统一形态：未定义合法（缺省跳过），已定义必须过子 guard。 */
function isOptionalSubObjectValid(w: Record<string, unknown>, key: string, guard: (x: unknown) => boolean): boolean {
  return w[key] === undefined || guard(w[key])
}

function isWindowValid(w: unknown): boolean {
  if (!isRecord(w)) return false
  if (!isWindowBaseFieldsValid(w)) return false
  return (
    isOptionalSubObjectValid(w, 'gate', isGateValid) &&
    isOptionalSubObjectValid(w, 'gateValue', isGateValueValid) &&
    isOptionalSubObjectValid(w, 'pct', isPctValid) &&
    isOptionalSubObjectValid(w, 'resetSec', isResetSecValid) &&
    isOptionalSubObjectValid(w, 'usedLimit', isUsedLimitValid)
  )
}

// 顶层 guard 按字段段分组（分组本身 = DeclarativeFetcherConfig 的字段清单：必选标量段 /
// 可选段 / requests 段 / windows 段）。

function isAuthArrayValid(v: unknown[]): boolean {
  return v.every(a => typeof a === 'string')
}

function isRequestEntryValid(r: unknown): boolean {
  if (!isRecord(r) || typeof r['name'] !== 'string' || r['name'] === '' || typeof r['url'] !== 'string' || r['url'] === '') return false
  if (r['role'] !== undefined && r['role'] !== 'primary' && r['role'] !== 'auxiliary') return false
  if (r['method'] !== undefined && !(REQUEST_METHODS as readonly string[]).includes(r['method'] as string)) return false
  return r['body'] === undefined || typeof r['body'] === 'string'
}

function isStatusMapValid(m: unknown): boolean {
  return isRecord(m) && Object.values(m).every(isFailReason)
}

/** bodyCode.success 词表元素合法性（protojson 枚举可为名称串或数值——双形态兼容）。 */
function isBodyCodeSuccessElementValid(s: unknown): boolean {
  return typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean'
}

/** bodyCode.success 合法性：标量或非空数组（protojson 枚举双形态）。 */
function isBodyCodeSuccessValid(success: unknown): boolean {
  if (Array.isArray(success)) return success.length > 0 && success.every(isBodyCodeSuccessElementValid)
  return isBodyCodeSuccessElementValid(success)
}

function isBodyCodeValid(b: unknown): boolean {
  if (!isRecord(b) || !isPathValid(b['path'])) return false
  if (!isBodyCodeSuccessValid(b['success'])) return false
  if (b['map'] !== undefined && !isRecord(b['map'])) return false
  if (b['else'] !== undefined && !isFailReason(b['else'])) return false
  if (b['missing'] !== undefined && b['missing'] !== 'else' && b['missing'] !== 'parse') return false
  return b['successRequires'] === undefined || isPathValid(b['successRequires'])
}

function isRequiredScalarFieldsValid(v: Record<string, unknown>): boolean {
  if (typeof v['label'] !== 'string' || v['label'] === '') return false
  if (!Array.isArray(v['auth']) || !isAuthArrayValid(v['auth'])) return false
  if (typeof v['credential'] !== 'string' || !(CREDENTIAL_MODES as readonly string[]).includes(v['credential'])) return false
  return true
}

function isOptionalFieldsValid(v: Record<string, unknown>): boolean {
  if (v['strictNumbers'] !== undefined && typeof v['strictNumbers'] !== 'boolean') return false
  if (v['extraHeaders'] !== undefined && !isRecord(v['extraHeaders'])) return false
  if (v['headerFroms'] !== undefined && !isHeaderFromsValid(v['headerFroms'])) return false
  if (v['statusMap'] !== undefined && !isStatusMapValid(v['statusMap'])) return false
  if (v['bodyCode'] !== undefined && !isBodyCodeValid(v['bodyCode'])) return false
  if (v['requires'] !== undefined && !Array.isArray(v['requires'])) return false
  return true
}

function isRequestsSectionValid(v: Record<string, unknown>): boolean {
  if (!Array.isArray(v['requests']) || (v['requests'] as unknown[]).length === 0) return false
  return (v['requests'] as unknown[]).every(isRequestEntryValid)
}

function isWindowsSectionValid(v: Record<string, unknown>): boolean {
  if (!Array.isArray(v['windows']) || (v['windows'] as unknown[]).length === 0) return false
  return (v['windows'] as unknown[]).every(isWindowValid)
}

/** 声明式配置形状 guard（决策依赖字段全字段级校验；拒绝 = 整体拒用）。 */
export function isDeclarativeFetcherConfig(v: unknown): v is DeclarativeFetcherConfig {
  if (!isRecord(v)) return false
  return (
    isRequiredScalarFieldsValid(v) &&
    isOptionalFieldsValid(v) &&
    isRequestsSectionValid(v) &&
    isWindowsSectionValid(v)
  )
}

// ── 字段路径原语 ────────────────────────────────────────────

/** 路径段：`name` | `name[0]`（下标）| `name[k=v]`（条件选取首命中）。
 * 语义对齐各家现行 shape guard：字段缺失合法（undefined 透传）；**期望容器处拿到非容器**
 * （非对象上取属性 / 非数组上下标选取）= wire 形态漂移 → WireDriftError（fail-visible 归
 * parse，不静默当缺失降级）。 */
/** 下标选取 `[N]`：数组上下标选取；期望数组处拿到非容器 = 漂移。 */
function pickBracketIndexed(cur: unknown, idx: RegExpMatchArray, path: string, key: string): unknown {
  if (!Array.isArray(cur)) {
    if (cur === undefined || cur === null) return undefined
    throw new WireDriftError(`array expected at '${key}${idx[0]}' in '${path}'`)
  }
  return cur[Number(idx[1])]
}

/** 条件选取无命中时判定是否类型漂移：数组非空但无命中、且存在条目的条件字段为非 string
 * 类型 = 类型漂移致无命中 → parse（fail-visible，对齐 minimax guard 的 model_name 字段级
 * 类型校验——正常无命中（值不同）才降级缺失）。 */
/** 条件选取无命中时判定是否类型漂移。判据锚定**配置侧声明的条件值形态**：
 *  - 条件值为数值形态（"1"）而条目字段是 number → 合法数值枚举比较，值不中 = 正常未命中
 *    （线上实测 stepfun creditBuckets type=1 数值下发）；
 *  - 条件值为非数值形态（"general"）而条目字段是 number → 该字段语义是 string，数值 = 漂移
 *    （minimax model_name 字段级 guard 语义保持）；
 *  - 条目非对象 / 字段既非 string 也非 number → 漂移。 */
function isConditionalMissByDrift(cur: unknown[], field: string, configValue: string): boolean {
  const numericConfig = /^\d+$/.test(configValue)
  return cur.some((e) => {
    if (!isRecord(e)) return true
    const v = (e as Record<string, unknown>)[field]
    if (typeof v === 'string') return false
    if (typeof v === 'number') return !numericConfig
    return true
  })
}

/** 条件选取 `[k=v]`：首命中。比较含数值容忍——protojson 枚举可为数值（线上实测
 *  stepfun creditBuckets type=1），配置侧写串 "1"；条目字段为 number 时按字符串化比较，
 *  其余严格 string 比较（与各家现行 find(m => m[k] === 'v') 语义对齐）。 */
function pickBracketConditional(cur: unknown, cond: RegExpMatchArray, path: string, key: string): unknown {
  if (!Array.isArray(cur)) {
    if (cur === undefined || cur === null) return undefined
    throw new WireDriftError(`array expected at '${key}${cond[0]}' in '${path}'`)
  }
  const [, field, value] = cond
  const hit = cur.find((e) => isRecord(e) && conditionMatches((e as Record<string, unknown>)[field], value))
  if (!hit && cur.length > 0 && isConditionalMissByDrift(cur, field, value)) {
    throw new WireDriftError(`condition field type drift at '${key}${cond[0]}' in '${path}'`)
  }
  return hit
}

/** 条件值比较：string 条目严格相等；number 条目仅在配置条件值为数值形态时按字符串化比较
 *  （protojson 数值枚举 vs 配置串的真实二元性——非数值条件值对 number 字段不命中）。 */
function conditionMatches(entryValue: unknown, configValue: string): boolean {
  if (typeof entryValue === 'number') return /^\d+$/.test(configValue) && String(entryValue) === configValue
  return entryValue === configValue
}

/** 单路径段：`name` | `name[0]`（下标）| `name[k=v]`（条件选取首命中）。
 * 语义对齐各家现行 shape guard：字段缺失合法（undefined 透传）；**期望容器处拿到非容器**
 * （非对象上取属性 / 非数组上下标选取）= wire 形态漂移 → WireDriftError（fail-visible 归
 * parse，不静默当缺失降级）。 */
function pickSegment(cur: unknown, seg: string, path: string): unknown {
  if (cur === undefined || cur === null) return undefined
  const m = seg.match(/^([^\[]+)((?:\[[^\]]*\])?)$/)
  if (!m) return undefined
  const [, key, bracket] = m
  if (typeof cur !== 'object' || cur === null) {
    throw new WireDriftError(`container expected at '${key}' in '${path}'`)
  }
  const next: unknown = (cur as Record<string, unknown>)[key]
  if (!bracket) return next
  const idx = bracket.match(/^\[(\d+)\]$/)
  if (idx) return pickBracketIndexed(next, idx, path, key)
  const cond = bracket.match(/^\[([^=\]]+)=([^\]]+)\]$/)
  if (cond) return pickBracketConditional(next, cond, path, key)
  return undefined
}

/**
 * 路径求值：单路径串或双形态数组（protojson camelCase / snake_case 皆合法——首命中生效）。
 * 语义：按序尝试，首个取值 !== undefined 的路径命中（含 null：JSON null 是「字段存在」，
 * 由消费侧 numericField 归为缺失）；全部 undefined = 缺失；任一路径形态漂移（期望容器处
 * 拿到非容器）照常上抛 WireDriftError——双形态不放过漂移。
 */
function pickPath(data: unknown, path: string | string[]): unknown {
  if (typeof path === 'string') return pickSinglePath(data, path)
  for (const p of path) {
    const v = pickSinglePath(data, p)
    if (v !== undefined) return v
  }
  return undefined
}

function pickSinglePath(data: unknown, path: string): unknown {
  let cur: unknown = data
  for (const seg of path.split('.')) {
    cur = pickSegment(cur, seg, path)
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

/** resetSec 各模式求值器（语义见 DeclarativeWindow.resetSec 注释）。返回 null = 无重置信息。 */

function evalIsoReset(raw: unknown): number | null {
  const s = strictString(raw)
  return s ? isoResetRemaining(s) : null
}

function evalEpochMsReset(raw: unknown): number | null {
  const n = strictNumeric(raw)
  if (n === undefined) return null
  const rem = Math.floor(n / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
  return rem > 0 ? rem : null
}

function evalRelativeLabelReset(raw: unknown): number | null {
  const s = strictString(raw)
  return s ? parseRelativeLabel(s) : null
}

function evalZonelessUtcReset(raw: unknown): number | null {
  const s = strictString(raw)
  if (!s) return null
  // 无时区标记串按 UTC 解析（与固定发送的 x-timezone: UTC 强一致，mimo 实测）；带标记串 Date.parse 直解
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)
  const t = zoneless ? Date.parse(`${s.replace(' ', 'T')}Z`) : Date.parse(s)
  if (Number.isNaN(t)) return null
  const sec = Math.floor((t - Date.now()) / MS_PER_SEC)
  return sec > 0 ? sec : null
}

function evalRelativeMsReset(raw: unknown): number | null {
  const n = strictNumeric(raw)
  return n !== undefined && n > 0 ? Math.ceil(n / MS_PER_SEC) : null
}

// epochMsElseRelativeLabel：number/数值串走 epoch；非数值串走相对 label（zhipu 双格式）
function evalEpochMsElseRelativeLabelReset(raw: unknown): number | null {
  if (typeof raw === 'number') return evalEpochMsReset(raw)
  const s = strictString(raw)
  if (s === undefined) return null
  const ms = Number(s)
  if (ms && !Number.isNaN(ms)) {
    const rem = Math.floor(ms / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
    if (rem > 0) return rem
  }
  return parseRelativeLabel(s)
}

// epochSecOrMs：protojson int64 单位二义（秒级戳 ~1.8e9 / 毫秒级戳 ~1.8e12）按量级消歧——
// 阈值 1e11：秒级戳（公元 5138 前）恒小于它，毫秒级戳（1973 后）恒大于它。
function evalEpochSecOrMsReset(raw: unknown): number | null {
  const n = strictNumeric(raw)
  if (n === undefined || n <= 0) return null
  const ms = n > EPOCH_MS_THRESHOLD ? n : n * MS_PER_SEC
  const rem = Math.floor(ms / MS_PER_SEC) - Math.floor(Date.now() / MS_PER_SEC)
  return rem > 0 ? rem : null
}

const RESET_EVALUATORS: Readonly<Record<ResetSecMode, (raw: unknown) => number | null>> = {
  iso: evalIsoReset,
  epochMs: evalEpochMsReset,
  relativeLabel: evalRelativeLabelReset,
  zonelessUtcWallClock: evalZonelessUtcReset,
  epochMsElseRelativeLabel: evalEpochMsElseRelativeLabelReset,
  relativeMs: evalRelativeMsReset,
  epochSecOrMs: evalEpochSecOrMsReset,
}

function evalResetSec(raw: unknown, mode: ResetSecMode): number | null {
  return RESET_EVALUATORS[mode](raw)
}

/** label 模板插值：`{{path}}` 替换；任一路径缺失 → strip 全部插值段 + strip 尾部 `- `。
 *  插值源缺失（undefined/null）合法走 strip；**存在但非 string = 形态漂移** →
 *  WireDriftError 整查询归 parse（对齐迁移前 zhipu guard `isOptionalField(d.level, 'string')`
 *  ——`data.level` 为 number 时旧实现归 parse，引擎不得静默 stringify 出 `Z.ai-123`）。 */
function evalLabel(template: string, data: unknown): string {
  if (!template.includes('{{')) return template
  const segs = template.match(/\{\{([^}]+)\}\}/g) ?? []
  const paths = segs.map((s) => s.slice(LABEL_DELIM_LEN, -LABEL_DELIM_LEN))
  const values = paths.map((p) => strictString(pickPath(data, p)))
  if (values.every((v) => v !== undefined)) {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, p: string) => strictString(pickPath(data, p)) ?? '')
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

/** 窗口门控求值（gate 存在性 + gateValue 取值门控）；返回非 null = 整窗提前返回。 */
function evalWindowGate(
  win: DeclarativeWindow,
  source: unknown,
  strict: boolean,
): { win: QuotaWindow; queryFail?: true } | null {
  if (win.gate) {
    const hit = pickPath(source, win.gate.path)
    if (hit === undefined || hit === null) {
      return win.gate.missing === 'query-fail' ? { win: INFINITE_WIN, queryFail: true } : { win: INFINITE_WIN }
    }
  }
  if (win.gateValue) {
    const v = strictNumeric(pickPath(source, win.gateValue.path), strict)
    // equals 门控：决策字段缺失（undefined/null）= 状态不可知 → INFINITE_WIN（对齐 minimax 现行
    // isActive「非 1 即无限」——undefined !== 1 同走该分支），不放行继续求 pct 产假可用态
    if (win.gateValue.equals !== undefined && v !== win.gateValue.equals) return { win: INFINITE_WIN }
    // notEquals 反义门控（stepfun plan_family=TOKEN → 该窗不适用）；缺失不等于任何值 → 放行
    if (win.gateValue.notEquals !== undefined && v === win.gateValue.notEquals) return { win: INFINITE_WIN }
  }
  return null
}

/** 绝对量求值（usedLimit）：used 折算内建（used ?? limit−remaining，均缺不输出）。 */
function evalUsedLimit(
  win: DeclarativeWindow,
  source: unknown,
  strict: boolean,
): { used: number; limit: number; unit: NonNullable<QuotaWindow['unit']> } | undefined {
  if (!win.usedLimit) return undefined
  const limit = strictNumeric(pickPath(source, win.usedLimit.limit), strict)
  const usedRaw = win.usedLimit.used !== undefined ? strictNumeric(pickPath(source, win.usedLimit.used), strict) : undefined
  const remaining = win.usedLimit.remaining !== undefined ? strictNumeric(pickPath(source, win.usedLimit.remaining), strict) : undefined
  const used = usedRaw ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
  if (limit === undefined || used === undefined || limit <= 0) return undefined
  return { used, limit, unit: (win.usedLimit.unit ?? 'requests') as NonNullable<QuotaWindow['unit']> }
}

/** pct.raw 经 via 变换（raw 已解析时调用）；usedOverLimit 无独立字段值 → null（由 usedLimit 派生）。 */
function pctFromVia(via: PctVia, raw: number): number | null {
  switch (via) {
    case 'direct':
      return raw
    case 'percent01to100':
      return raw * PERCENT_SCALE
    case 'remainingToUsed':
      return Math.max(0, Math.min(PERCENT_SCALE, PERCENT_SCALE - raw))
    // fractionRemainingToUsed：输入是 0..1 剩余比例（stepfun leftRate），已用% = (1 - rate) * 100
    case 'fractionRemainingToUsed':
      return Math.round((1 - Math.max(0, Math.min(1, raw))) * PERCENT_SCALE * PERCENT_SCALE) / PERCENT_SCALE
    // usedOverLimit：pct 由 usedLimit 派生（调用侧）
    case 'usedOverLimit':
      return null
  }
}

/** 整窗 INFINITE_WIN 判定（主数据不可知 = 该窗 pct 的事实源缺席）。 */
function isInfiniteWinFromPct(
  win: DeclarativeWindow,
  pct: number | null,
  usedLimit: { used: number; limit: number } | undefined,
): boolean {
  // pct direct / fractionRemainingToUsed 缺失 = 主数据不可知 → 整窗 INFINITE_WIN（resetSec
  // 同折 null，zhipu 现行语义「TOKENS_LIMIT percentage 缺失 → INFINITE_WIN」；percent01to100/
  // remainingToUsed 的主数据是 percent 本身，缺失仅 pct=null、resetSec 独立输出——mimo/minimax 现行）
  if ((win.pct?.via === 'direct' || win.pct?.via === 'fractionRemainingToUsed') && pct === null) return true
  // pct 由绝对量派生时，绝对量缺失 = 主数据不可知 → 整窗 INFINITE_WIN（resetSec 同折 null，
  // 对齐 opencode/kimi 现行语义——与 mimo「pct 缺失仅 pct=null、resetSec 独立输出」相区分）
  return win.pct?.via === 'usedOverLimit' && !usedLimit
}

/** pct 求值；`infiniteWin` = 主数据不可知整窗 INFINITE_WIN（direct/usedOverLimit 派生链）。 */
function evalWindowPct(
  win: DeclarativeWindow,
  source: unknown,
  strict: boolean,
  usedLimit: { used: number; limit: number } | undefined,
): { pct: number | null; infiniteWin?: true } {
  let pct: number | null = null
  if (win.pct?.path) {
    const raw = strictNumeric(pickPath(source, win.pct.path), strict)
    if (raw !== undefined) pct = pctFromVia(win.pct.via, raw)
  }
  if (isInfiniteWinFromPct(win, pct, usedLimit)) return { pct, infiniteWin: true }
  if (win.pct?.via === 'usedOverLimit' && usedLimit) pct = Math.round((usedLimit.used / usedLimit.limit) * PERCENT_SCALE)
  return { pct }
}

/** resetSec 求值（源可覆写：mimo resetSec 来自辅助 detail 请求）。
 *  独立降级源（fromRequest 指向非主请求——该请求本就走 allSettled 请求级独立降级，见
 *  fetchAuxiliaryRequests）的字段级漂移同语义只降级该数据位 null：仅 reset 信息缺失、
 *  pct/usedLimit 主数据保留（对齐 mimo 现行 extractPeriodResetSec「非 string 仅 return
 *  null」）；主请求源的字段级漂移照常上抛整查询归 parse（漂移可见不变）。 */
function evalWindowResetSec(
  win: DeclarativeWindow,
  reqs: ResolvedRequests,
  source: unknown,
  failSafeSources: ReadonlySet<string>,
): number | null {
  if (!win.resetSec) return null
  const overrideName = win.resetSec.fromRequest
  const resetSrc = overrideName ? reqs.byName[overrideName] : source
  if (overrideName === undefined || !failSafeSources.has(overrideName)) {
    return evalResetSec(pickPath(resetSrc, win.resetSec.path), win.resetSec.mode)
  }
  try {
    return evalResetSec(pickPath(resetSrc, win.resetSec.path), win.resetSec.mode)
  } catch (e) {
    if (e instanceof WireDriftError) return null
    throw e
  }
}

function evalWindow(
  win: DeclarativeWindow,
  reqs: ResolvedRequests,
  strict: boolean,
  failSafeSources: ReadonlySet<string>,
): { win: QuotaWindow; queryFail?: true } {
  const source = win.fromRequest ? reqs.byName[win.fromRequest] : reqs.byName[reqs.primaryName]

  const gate = evalWindowGate(win, source, strict)
  if (gate) return gate

  const usedLimit = evalUsedLimit(win, source, strict)
  const { pct, infiniteWin } = evalWindowPct(win, source, strict, usedLimit)
  if (infiniteWin) return { win: INFINITE_WIN }

  const resetSec = evalWindowResetSec(win, reqs, source, failSafeSources)

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
    const touch = (p: string | string[] | undefined): void => { if (p) pickPath(source, p) }
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

/** 构造 credential header（引擎统一 redirect:'manual' + statusToReason 3xx 判据）。
 *  cookie 模式的 credential 必须已由调用方归一（runDeclarativeFetcher 的空判据判的是归一
 *  后的值——见 normalizeCookieHeader 契约「归一后为空 → 调用方按 cookie-invalid-format 处理」）。
 *  body 声明存在时自动带 content-type: application/json（body 原语即 JSON——漏头 = 服务端
 * *  415；extraHeaders 可覆写，默认值在 spread 前）。 */
function buildHeaders(config: DeclarativeFetcherConfig, credential: string, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    ...(config.requests.some((r) => r.body !== undefined) ? { 'content-type': 'application/json' } : {}),
    ...extra,
  }
  if (config.credential === 'bearer') headers['authorization'] = `Bearer ${credential}`
  else if (config.credential === 'raw') headers['authorization'] = credential
  else headers['cookie'] = credential
  return headers
}

type DeclarativeBodyCode = NonNullable<DeclarativeFetcherConfig['bodyCode']>

/** 决策字段形态归口（缺失/类型非法 → fail-visible，不静默当业务失败降级）：
 *  - 缺失（undefined/null）按 missing 归口：'parse' = 漂移可见（mimo 现行 guard 拒收，
 *    字段消失引导「查订阅」会误导排障）；缺省 'else' = 业务失败（minimax/zhipu 现行
 *    「决策字段缺席 = 无订阅数据」语义）——缺失形态放行，由成功判定落 else。
 *  - 存在但类型非法恒 parse（防对象/数组绕过类型检查命中 map）；string 仅在 success 词表
 *    含字符串元素时合法（protojson 枚举名形态，词表即 wire 类型声明）。 */
function assertBodyCodeUsable(code: unknown, bodyCode: DeclarativeBodyCode, allowsStringCode: boolean): void {
  if (code === undefined || code === null) {
    if (bodyCode.missing === 'parse') throw new WireDriftError(`missing body code at '${JSON.stringify(bodyCode.path)}'`)
    return
  }
  const legal = typeof code === 'string' ? allowsStringCode : typeof code === 'number' || typeof code === 'boolean'
  if (!legal) throw new WireDriftError(`illegal body code: ${JSON.stringify(code)}`)
}

/** 业务失败 reason 分派：map[码] 命中优先（仅标量码可作 map 键），缺省 else，末档 no-subscription。 */
function bodyCodeMappedFailureReason(code: unknown, bodyCode: DeclarativeBodyCode): QuotaFetchFailureReason {
  const mapped = (typeof code === 'string' || typeof code === 'number') ? bodyCode.map?.[String(code)] : undefined
  return mapped ?? bodyCode.else ?? 'no-subscription'
}

/** 在体业务码判定（mimo code / minimax base_resp.status_code / zhipu success boolean /
 *  stepfun protojson 枚举名 'CODE_OK'）；返回非 null = 提前返回。 */
function evaluateBodyCode(config: DeclarativeFetcherConfig, primaryData: unknown): { ok: false; reason: QuotaFetchFailureReason } | null {
  const bodyCode = config.bodyCode
  if (!bodyCode) return null
  const code = pickPath(primaryData, bodyCode.path)
  const successValues = Array.isArray(bodyCode.success) ? bodyCode.success : [bodyCode.success]
  // success 词表含字符串元素 = 该平台的业务码是 protojson 枚举名形态（stepfun 'CODE_OK'）——
  // 字符串 code 合法；否则（mimo/minimax/zhipu 的数值码）字符串 code = 类型漂移 → parse
  // （各配置的 success 词表即 wire 类型声明，不全局放宽也不全局收紧）。
  const allowsStringCode = successValues.some((s) => typeof s === 'string')
  assertBodyCodeUsable(code, bodyCode, allowsStringCode)
  const isSuccess = code !== undefined && code !== null && successValues.some((s) => s === code)
  if (!isSuccess) return { ok: false, reason: bodyCodeMappedFailureReason(code, bodyCode) }
  if (bodyCode.successRequires !== undefined && !isRecord(pickPath(primaryData, bodyCode.successRequires))) return { ok: false, reason: 'parse' }
  return null
}

/** 数据源存在性判定（kimi limits/usage、opencode 三 meter 对象级）。 */
function evaluateRequires(config: DeclarativeFetcherConfig, primaryData: unknown): { ok: false; reason: QuotaFetchFailureReason } | null {
  if (config.requires && allRequiresMissing(primaryData, config.requires)) return { ok: false, reason: 'no-subscription' }
  return null
}

/** 把捕获的 Set-Cookie 行附加到 outcome（空则原样返回——不加 setCookies 键，既有
 *  outcome 逐字断言与「无续期」语义的消费者零扰动）。 */
function attachSetCookies(outcome: QuotaFetchOutcome, setCookies: string[]): QuotaFetchOutcome {
  return setCookies.length > 0 ? { ...outcome, setCookies } : outcome
}

/** 窗口装配（未声明的 slot 恒 INFINITE_WIN）。 */
function assembleWindows(config: DeclarativeFetcherConfig, reqs: ResolvedRequests, primaryData: unknown): QuotaFetchOutcome {
  const wins: Record<QuotaSlot, QuotaWindow> = { fiveHour: INFINITE_WIN, week: INFINITE_WIN, month: INFINITE_WIN }
  // 独立降级源集合（除主请求外全部——与 fetchAuxiliaryRequests 的 allSettled fail-safe
  // 集合同一口径），辅助源 resetSec 字段漂移按该集合降级
  const primaryDef = config.requests.find(r => r.role !== 'auxiliary') ?? config.requests[0]
  const failSafeSources = new Set(config.requests.filter(r => r !== primaryDef).map(r => r.name))
  for (const win of config.windows) {
    const r = evalWindow(win, reqs, config.strictNumbers === true, failSafeSources)
    if (r.queryFail) return { ok: false, reason: 'no-subscription' }
    wins[win.slot] = r.win
  }
  return { ok: true, data: { label: evalLabel(config.label, primaryData), wins: [wins.fiveHour, wins.week, wins.month] } }
}

/**
 * 执行声明式 fetcher（ProviderQuotaFetcher.fetchQuota 的引擎实现）。
 * doFetch 注入参数供测试；生产走全局 fetch。
 */
export async function runDeclarativeFetcher(
  config: DeclarativeFetcherConfig,
  credential: string,
  fetcherConfig?: { quotaParams?: Record<string, string> },
  doFetch?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<QuotaFetchOutcome> {
  // cookie 模式的空判据必须判**归一后**的值：`';'` / `' ; '` 等无任何 k=v 对的粘贴伪影原文
  // 非空，归一后为空串——按原文判空会带着空 cookie 头真发一次请求（normalizeCookieHeader
  // 契约：归一后为空 → 调用方按 cookie-invalid-format 处理，与「服务端拒绝」的 unauthorized
  // 分流——前者根本没发出 HTTP 请求，恢复动作是「换正确的复制路径重贴」）。
  const resolvedCredential = config.credential === 'cookie' ? normalizeCookieHeader(credential) : credential
  if (!resolvedCredential) return { ok: false, reason: config.credential === 'cookie' ? 'cookie-invalid-format' : 'unauthorized' }

  const extra = { ...(config.extraHeaders ?? {}) }
  const resolvedHeaders = resolveHeaderFroms(config.headerFroms ?? [], resolvedCredential, fetcherConfig?.quotaParams)
  if ('failure' in resolvedHeaders) return { ok: false, reason: resolvedHeaders.failure }
  const headers = buildHeaders(config, resolvedCredential, { ...extra, ...resolvedHeaders.headers })

  const fetchImpl = doFetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const primaryDef = config.requests.find(r => r.role !== 'auxiliary') ?? config.requests[0]
  const primary = await fetchPrimary(config, primaryDef, headers, fetchImpl)
  if (!primary.ok) return attachSetCookies(primary, primary.setCookies ?? [])
  const reqs: ResolvedRequests = { primaryName: primaryDef.name, byName: { [primaryDef.name]: primary.data } }
  const auxSetCookies = await fetchAuxiliaryRequests(config, primaryDef, headers, fetchImpl, reqs)
  // 全部出口统一附加（主请求在前、辅助请求在后）——续期语义与查询成败无关（unauthorized
  // 分支的 Set-Cookie 同样要给 service 回写）
  const setCookies = [...(primary.setCookies ?? []), ...auxSetCookies]

  // 求值段（业务码/存在性/窗口/label）：任何 wire 形态漂移（WireDriftError）→ parse，
  // fail-visible 不静默降级（对齐各家现行 shape guard 的「漂移可见」语义）。
  // 预校验：现行 guard 是全表面预校验（任一字段漂移即整体拒收），引擎按需求值会让
  // bodyCode/requires 提前短路遮蔽后续路径的漂移——先盲跑全部窗口路径的形态检查再进业务判定。
  try {
    prevalidateWindowPaths(config, reqs.byName[reqs.primaryName])
    const primaryData = reqs.byName[reqs.primaryName]
    const bodyResult = evaluateBodyCode(config, primaryData)
    if (bodyResult) return attachSetCookies(bodyResult, setCookies)
    const requiresResult = evaluateRequires(config, primaryData)
    if (requiresResult) return attachSetCookies(requiresResult, setCookies)
    return attachSetCookies(assembleWindows(config, reqs, primaryData), setCookies)
  } catch (e) {
    if (e instanceof WireDriftError) return attachSetCookies({ ok: false, reason: 'parse' }, setCookies)
    throw e
  }
}
