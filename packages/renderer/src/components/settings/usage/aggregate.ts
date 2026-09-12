/**
 * 用量统计前端聚合工具。
 *
 * 从 UsageRow[] 行集切片聚合出七个子组件所需的视图数据。
 * 移植自用量设计提案 demo 的 aggregate() 逻辑（提案文档 usage-dashboard.md 已删除，git 可追溯）。
 *
 * totalTokens 口径：input + output + cacheRead + cacheWrite 四项，不含 reasoning。
 * pi 落盘的 totalTokens 含 reasoning，本模块按四项和计算，与 demo 对齐。
 */
import type { UsageRow } from '@xyz-agent/shared'

/* ── 聚合后指标（与 UsageMetrics 对齐，但 cost 字段名不同） ── */
export interface AggMetrics {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  messages: number
}

/** provider 颜色阶梯上限 */
const MAX_PROVIDER_COLORS = 5

/**
 * 按使用量降序分配 provider 色阶梯（p1 占比最高），返回颜色映射。
 *
 * 颜色归属随 aggregate() 结果返回（审计候选 9 修复）：禁止恢复
 * 「模块级可变 PROVIDER_COLORS + 无参 getProviderColor 全局读」的旧契约——
 * 那会让 aggregate() 带隐藏副作用，多实例（split mode 两个 UsagePage）互相覆盖取色。
 */
function buildProviderColors(perProv: Record<string, AggMetrics>): Record<string, string> {
  const colors: Record<string, string> = {}
  const sorted = Object.keys(perProv)
    .sort((a, b) => totalTokens(perProv[b]) - totalTokens(perProv[a]))
  sorted.forEach((pid, i) => {
    colors[pid] = `var(--chart-p${Math.min(i + 1, MAX_PROVIDER_COLORS)})`
  })
  return colors
}

/** 获取 provider 对应的 chart 色变量（colors = aggregate() 结果的 providerColors 映射） */
export function getProviderColor(colors: Record<string, string>, pid: string): string {
  return colors[pid] ?? 'var(--chart-p5)'
}

/* ── 工具函数 ── */

export function newMetrics(): AggMetrics {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 }
}

export function accumulate(target: AggMetrics, source: AggMetrics): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.cost += source.cost
  target.messages += source.messages
}

/** 总 token = input + output + cacheRead + cacheWrite */
export function totalTokens(u: AggMetrics): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

/** 指标值：根据 metric 选择 token 总量或费用 */
export function metricValue(u: AggMetrics, metric: 'tokens' | 'cost'): number {
  return metric === 'cost' ? u.cost : totalTokens(u)
}

/* ── 格式化 ── */

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

const MILLION = 1e6
const TEN_MILLION = 1e7
const THOUSAND = 1e3

export function fmtCompact(n: number): string {
  if (n >= MILLION) return (n / MILLION).toFixed(n >= TEN_MILLION ? 0 : 1) + 'M'
  if (n >= THOUSAND) return (n / THOUSAND).toFixed(0) + 'k'
  return String(Math.round(n))
}

const COST_TINY_DECIMALS = 3
const COST_SMALL_THRESHOLD = 0.01
const COST_MEDIUM_THRESHOLD = 100
const COST_NORMAL_DECIMALS = 2

export function fmtUSD(n: number): string {
  if (!n) return '—'
  if (n < COST_SMALL_THRESHOLD) return '$' + n.toFixed(COST_TINY_DECIMALS)
  if (n < COST_MEDIUM_THRESHOLD) return '$' + n.toFixed(COST_NORMAL_DECIMALS)
  return '$' + Math.round(n).toLocaleString('en-US')
}

const PERCENT_MULTIPLIER = 100

export function fmtPct(x: number): string {
  return (x * PERCENT_MULTIPLIER).toFixed(1) + '%'
}

const LOG_BASE = 10
// eslint-disable-next-line no-magic-numbers -- 「nice number」算法规范值（Heckbert 1990），不可语义化
const NICE_FACTORS = [1, 2, 2.5, 5, 10] as const
// eslint-disable-next-line no-magic-numbers -- 同上，与 NICE_FACTORS 对齐的分档阈值
const NICE_THRESHOLDS = [1, 2, 2.5, 5] as const

export function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const f = v / Math.pow(LOG_BASE, exp)
  let nf = NICE_FACTORS[NICE_FACTORS.length - 1]
  for (let i = 0; i < NICE_THRESHOLDS.length; i++) {
    if (f <= NICE_THRESHOLDS[i]) {
      nf = NICE_FACTORS[i]
      break
    }
  }
  return nf * Math.pow(LOG_BASE, exp)
}

/* ── 日期工具（本地时区） ── */

export function toLocalDate(dateStr: string): Date {
  // dateStr 是 'YYYY-MM-DD' 本地时区字符串
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function fmtMMDD(d: Date): string {
  return `${String(d.getMonth() + 1)}/${String(d.getDate())}`
}

export function fmtISO(d: Date): string {
  const y = d.getFullYear()
  const PAD_WIDTH = 2
  const m = String(d.getMonth() + 1).padStart(PAD_WIDTH, '0')
  const day = String(d.getDate()).padStart(PAD_WIDTH, '0')
  return `${y}-${m}-${day}`
}

// fmtWeekday 已随 i18n 收口（设计 D6）迁往 UsageDailyChart 组件层用 t() 渲染（复用 heatWeek* keys）

/* ── 过滤器状态 ── */

export interface FilterState {
  /** 关闭的 provider 集合 */
  offProv: Set<string>
  /** 单看模型（null = 不单看） */
  isolate: string | null
  /** 时间范围：7 / 30 / 90 / 0(全部) */
  range: number
  /** 指标：token 总量 or 费用 */
  metric: 'tokens' | 'cost'
}

/* ── 每日视图行 ── */

export interface DayView {
  date: Date
  dateStr: string
  provs: Record<string, AggMetrics>
  dTot: AggMetrics
}

/* ── 排名行 ── */

export interface RankRow {
  name: string
  metrics: AggMetrics
  provider?: string
  provs?: Record<string, AggMetrics>
}

/** perModel 值结构：一行 = 一个 provider×model 组合（key = `${provider}/${model}` 复合键，设计决策点四 A） */
export interface PerModelEntry {
  provider: string
  model: string
  u: AggMetrics
}

/* ── 聚合结果 ── */

/**
 * 聚合结果（含 provider 颜色映射）。
 * 不导出（清理点 #11：投机导出，外部零消费方）——外部经 aggregate() 返回值推断类型，
 * 消费组件取色用 getProviderColor(data.providerColors, pid)。
 */
interface AggregatedData {
  perDay: DayView[]
  perModel: Record<string, PerModelEntry>
  perProv: Record<string, AggMetrics>
  /** 全量 provider 聚合：尊重 range、忽略 offProv/isolate（图例恒显数据源，设计 D1） */
  perProvFull: Record<string, AggMetrics>
  /** provider 颜色映射（pid -> CSS 变量），按全量 rows 用量降序分配，未命中回退 chart-p5 */
  providerColors: Record<string, string>
  tot: AggMetrics
  msgs: number
  activeDays: number
  peak: { v: number; d: string | null }
  nDays: number
}

/* ── 核心聚合 ── */

/** UsageRow → AggMetrics 字段映射（costUSD → cost） */
function rowToMetrics(row: UsageRow): AggMetrics {
  return {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    cost: row.costUSD,
    messages: row.messages,
  }
}

/** 按 date 分组 */
function groupByDate(rows: UsageRow[]): Map<string, UsageRow[]> {
  const byDate = new Map<string, UsageRow[]>()
  for (const row of rows) {
    const arr = byDate.get(row.date) ?? []
    arr.push(row)
    byDate.set(row.date, arr)
  }
  return byDate
}

/** 以全量 rows 构建全量 provider 指标（provider 色序以此为准，过滤变化不重排） */
function buildFullPerProv(rows: UsageRow[]): Record<string, AggMetrics> {
  const fullPerProv: Record<string, AggMetrics> = {}
  for (const row of rows) {
    if (!fullPerProv[row.provider]) fullPerProv[row.provider] = newMetrics()
    accumulate(fullPerProv[row.provider], rowToMetrics(row))
  }
  return fullPerProv
}

/** 确定日期范围：range>0 时今天往回构造完整日历，否则有数日期全集 */
function buildDateRange(
  filter: Pick<FilterState, 'range'>,
  sortedDates: string[],
): { sliceDates: string[]; nDays: number } {
  if (filter.range > 0) {
    // 构造完整日历日序列（今天往回 range 天，本地时区）
    const today = new Date()
    const dates: string[] = []
    for (let i = filter.range - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      dates.push(fmtISO(d))
    }
    return { sliceDates: dates, nDays: filter.range }
  }
  // 全部：维持有数日期全集
  return { sliceDates: sortedDates, nDays: sortedDates.length }
}

/* aggregate 跨日累加器（aggregateDay 就地累计） */
interface AggAccumulator {
  perModel: Record<string, PerModelEntry>
  perProv: Record<string, AggMetrics>
  perProvFull: Record<string, AggMetrics>
  tot: AggMetrics
  msgs: number
  activeDays: number
  peak: { v: number; d: string | null }
}

/** 单日聚合：过滤后累计到 acc，返回该日视图行 */
function aggregateDay(
  dateStr: string,
  dayRows: UsageRow[],
  filter: FilterState,
  acc: AggAccumulator,
): DayView {
  const date = toLocalDate(dateStr)
  const provs: Record<string, AggMetrics> = {}
  const dTot = newMetrics()
  let has = false

  for (const row of dayRows) {
    const u = rowToMetrics(row)

    // 全量累加器：尊重 range（本函数仅处理窗口内日期）、忽略 offProv/isolate（图例恒显，D1）
    if (!acc.perProvFull[row.provider]) acc.perProvFull[row.provider] = newMetrics()
    accumulate(acc.perProvFull[row.provider], u)

    if (filter.offProv.has(row.provider)) continue
    // isolate 键语义 = 复合键 `${provider}/${model}`（设计 §3.3 ⑤）：裸 model 比较会让跨 provider 同名模型互相误命中
    if (filter.isolate && `${row.provider}/${row.model}` !== filter.isolate) continue

    has = true
    acc.msgs += row.messages

    if (!provs[row.provider]) provs[row.provider] = newMetrics()
    accumulate(provs[row.provider], u)
    accumulate(dTot, u)

    if (!acc.perModel[`${row.provider}/${row.model}`]) {
      acc.perModel[`${row.provider}/${row.model}`] = { provider: row.provider, model: row.model, u: newMetrics() }
    }
    accumulate(acc.perModel[`${row.provider}/${row.model}`].u, u)

    if (!acc.perProv[row.provider]) acc.perProv[row.provider] = newMetrics()
    accumulate(acc.perProv[row.provider], u)
  }

  if (has) {
    acc.activeDays++
    accumulate(acc.tot, dTot)
    const v = metricValue(dTot, filter.metric)
    if (v > acc.peak.v) {
      acc.peak.v = v
      acc.peak.d = dateStr
    }
  }

  return { date, dateStr, provs, dTot }
}

/**
 * 从 UsageRow[] 聚合出全部视图数据。
 *
 * @param rows - 原始行集（date × provider × model × project）
 * @param filter - 过滤器状态
 * @param allDateStrs - 全量日期字符串数组（用于热力日历，传入全部 rows 的去重日期）
 */
export function aggregate(
  rows: UsageRow[],
  filter: FilterState,
): AggregatedData {
  const byDate = groupByDate(rows)
  // 以全量 rows 计算 provider 色序（过滤变化不重排）；色序派生源与 perProvFull 不同：
  // perProvFull 只累计 range 窗口内数据，色序必须全量否则切 range 时阶梯重排
  const providerColors = buildProviderColors(buildFullPerProv(rows))

  const sortedDates = [...byDate.keys()].sort()
  const { sliceDates, nDays } = buildDateRange(filter, sortedDates)

  const acc: AggAccumulator = {
    perModel: {},
    perProv: {},
    perProvFull: {},
    tot: newMetrics(),
    msgs: 0,
    activeDays: 0,
    peak: { v: 0, d: null },
  }
  const perDay: DayView[] = []
  for (const dateStr of sliceDates) {
    perDay.push(aggregateDay(dateStr, byDate.get(dateStr) ?? [], filter, acc))
  }

  return {
    perDay,
    perModel: acc.perModel,
    perProv: acc.perProv,
    perProvFull: acc.perProvFull,
    providerColors,
    tot: acc.tot,
    msgs: acc.msgs,
    activeDays: acc.activeDays,
    peak: acc.peak,
    nDays,
  }
}

/**
 * 热力日历聚合：独立于 range，使用全量日期数据。
 * 返回 { dateStr -> totalTokens } 映射。
 */
export function aggregateHeatmap(
  rows: UsageRow[],
  filter: Pick<FilterState, 'offProv' | 'isolate'>,
): Map<string, number> {
  const result = new Map<string, number>()
  for (const row of rows) {
    if (filter.offProv.has(row.provider)) continue
    // isolate 复合键比较（设计 §3.3 ⑤，与 aggregateDay 同款）
    if (filter.isolate && `${row.provider}/${row.model}` !== filter.isolate) continue
    const prev = result.get(row.date) ?? 0
    result.set(row.date, prev + row.input + row.output + row.cacheRead + row.cacheWrite)
  }
  return result
}

/**
 * 项目谱聚合：按 project × provider 聚合。
 */
const TOP_PROJECTS = 8

export function aggregateProjects(
  rows: UsageRow[],
  filter: Pick<FilterState, 'offProv' | 'isolate' | 'range' | 'metric'>,
): RankRow[] {
  const byDate = groupByDate(rows)
  const sortedDates = [...byDate.keys()].sort()
  const { sliceDates } = buildDateRange(filter, sortedDates)

  const projMap = new Map<string, { provs: Record<string, AggMetrics>; total: AggMetrics }>()
  for (const dateStr of sliceDates) {
    for (const row of byDate.get(dateStr) ?? []) {
      if (filter.offProv.has(row.provider)) continue
      // isolate 复合键比较（设计 §3.3 ⑤，与 aggregateDay 同款）
      if (filter.isolate && `${row.provider}/${row.model}` !== filter.isolate) continue
      const key = row.project
      if (!projMap.has(key)) projMap.set(key, { provs: {}, total: newMetrics() })
      const entry = projMap.get(key)!
      if (!entry.provs[row.provider]) entry.provs[row.provider] = newMetrics()
      const u = rowToMetrics(row)
      accumulate(entry.provs[row.provider], u)
      accumulate(entry.total, u)
    }
  }

  return [...projMap.entries()]
    .map(([name, { provs, total }]) => ({ name, metrics: total, provs }))
    // metric 贯穿（G4）：项目谱 TOP8 排序按当前指标（token 或费用）
    .sort((a, b) => metricValue(b.metrics, filter.metric) - metricValue(a.metrics, filter.metric))
    .slice(0, TOP_PROJECTS)
}

/**
 * 缓存构成聚合：按 model 聚合 cacheRead / input / output+cacheWrite。
 *
 * TOP-4 排序切片恒用 totalTokens（token 域例外，设计 §3.3 ⑤：缓存构成本质是 token 比例概念，
 * 不随 metric 切换口径；G4「metric 贯穿」范围不含缓存构成）。
 */
const TOP_CACHE_MODELS = 4

export function aggregateCacheMix(
  perModel: Record<string, PerModelEntry>,
): { provider: string; model: string; hit: number; newIn: number; out: number; hitRate: number }[] {
  return Object.entries(perModel)
    .filter(([, entry]) => entry.u.cacheRead + entry.u.input > 0)
    .sort((a, b) => totalTokens(b[1].u) - totalTokens(a[1].u))
    .slice(0, TOP_CACHE_MODELS)
    .map(([, entry]) => {
      const u = entry.u
      const base = u.cacheRead + u.input + u.output + u.cacheWrite
      return {
        provider: entry.provider,
        model: entry.model,
        hit: base ? u.cacheRead / base : 0,
        newIn: base ? u.input / base : 0,
        out: base ? (u.output + u.cacheWrite) / base : 0,
        hitRate: u.cacheRead + u.input > 0 ? u.cacheRead / (u.cacheRead + u.input) : 0,
      }
    })
}

/**
 * 明细台账分组：按 provider 分组，每组内按当前指标降序。
 *
 * @param metric - 当前指标（组间与组内排序口径，G4 metric 贯穿）
 */
export function aggregateDetailGroups(
  perProv: Record<string, AggMetrics>,
  perModel: Record<string, PerModelEntry>,
  rows: UsageRow[],
  metric: FilterState['metric'],
): { pid: string; u: AggMetrics; models: { model: string; u: AggMetrics }[] }[] {
  // 复合键 -> provider 映射：派生源必须 = 全量 rows（与过滤无关，设计 §3.3 ⑤；
  // 禁止从过滤后 perModel/perProvFull 派生——键会随过滤消失，归属判定失义）
  const modelProv = new Map<string, string>()
  for (const row of rows) {
    const key = `${row.provider}/${row.model}`
    if (!modelProv.has(key)) modelProv.set(key, row.provider)
  }

  const provs = Object.keys(perProv)
    .map((pid) => {
      const models = Object.entries(perModel)
        .filter(([key]) => modelProv.get(key) === pid)
        .sort((a, b) => metricValue(b[1].u, metric) - metricValue(a[1].u, metric))
        .map(([, entry]) => ({ model: entry.model, u: entry.u }))
      return { pid, u: perProv[pid], models }
    })
    .sort((a, b) => metricValue(b.u, metric) - metricValue(a.u, metric))

  return provs
}
