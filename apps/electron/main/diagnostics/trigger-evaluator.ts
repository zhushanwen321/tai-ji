/**
 * 重审触发条件评估器——纯函数窗口统计（crash-forensics-and-watchdog §3.3 D2 暗债根修，
 * 条件清单 SSOT = 附录 A 20 条）。
 *
 * 【职责】两份设计文档 + 架构文档登记的全部「数据驱动重审」触发条件在此集中计算
 * （G-B）：此前 20 条散在文档里零跟踪（§2.3 投影②），条件触发了没人知道。
 *
 * 【纯度边界】无 electron / node:fs / 定时器依赖——输入 = 两本台账的 JSONL 行数组 +
 * 当前时刻（唯一输入，不解析任何日志文本行，设计 D2 被否③），输出 = 20 条状态表。
 * main 池 vitest 直接单测（内存行数组 fixture，无文件 IO）。
 *
 * 【输入闭合性】计数类（#1/2/3/7/8/9/10/16）全部数台账事件（D1 条件信号事件化的直接
 * 消费）；趋势类（#4/#5）消费 watermark-daily 聚合事件（coverage<50% 的日降权标注）；
 * #17 判据在 60s 采样环内存态不落台账 → 恒 no-data，标注消费方 = Gate W 人工复审；
 * 用户反馈型（#6/11/12/13/14/15/18/19/20）requires-user-report 恒 no-data 但显式列出
 * ——「列出」本身即消费（消灭触发词散在文档里无人汇总的暗债形态）。
 *
 * 【出口】恰两个（D2，不加第三个）：
 *   ① main 每日巡检（./trigger-patrol.ts）：任一 tripped → WARN 摘要行 + 台账
 *      trigger-review 事件（带条件 id）；
 *   ② 诊断导出（u3a export-diagnostic-bundle）：状态表进 summary.md。
 *
 * 【窗口语义】周 = 滚动 7 天、月 = 滚动 30 天（自然滚动窗，非自然周/自然月）。锚定
 * 「现在」= 显式注入 now（epoch ms），缺省锚定两本台账末事件时刻（台账是「现在」的
 * 最新知识）；两本台账全空且未注入 now → 无锚点，全部窗口条件 no-data（非静默：
 * rows note + skippedLineCount + parsedEventCount 可辨）。
 *
 * 【「周均/月均」口径】直接数滚动窗口内事件条数与阈值比较，不做窗口覆盖不足的外推
 * （外推会把「3 天 8 条」放大成周均 18，把短期风暴与持续高频混同，且阈值语义从
 * 「窗口计数」漂移为「速率」）；数据跨度不足整窗时在该行 note 显式标注。
 *
 * 【坏行】JSON.parse 失败 / 非对象（含数组与标量）/ ts 缺失或不可解析 → 跳过并计数
 * （skippedLineCount，非静默——设计 §3.1 失败路径「数据缺失显式标注而非静默空白」）；
 * 纯空白行是换行切分伪影（尾随换行），静默丢弃不计数。ts 是窗口统计唯一时间轴，
 * writer 恒补落盘时刻（u1c），缺 ts 即畸形数据。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 时间单位与窗口
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * MS_PER_MINUTE
const BYTES_PER_MB = 1_048_576
/** 百分比换算基数（占比 → 人读百分数）。 */
const PERCENT_SCALE = 100

/** 滚动窗口（附录 A：周 = 7 天、月 = 30 天）。 */
const DAYS_PER_WEEK = 7
const DAYS_PER_MONTH = 30
const WEEK_MS = DAYS_PER_WEEK * MS_PER_DAY
const MONTH_MS = DAYS_PER_MONTH * MS_PER_DAY

// ─────────────────────────────────────────────────────────────────────────────
// 附录 A 条件 id 注册表（评估器输出契约：消费方与测试按 id 引用，与附录 A 序号一一对应）
// ─────────────────────────────────────────────────────────────────────────────

const COND_TRUNC_WARN = 1 // #1 出站截断告警周均 >10
const COND_REGISTRY_MISS = 2 // #2 出站注册表 miss 任何一次
const COND_SUPERVISOR_RESTART = 3 // #3 supervisor 重启频率显著上升
const COND_WATERMARK_TREND = 4 // #4 水位长期不回落
const COND_BASE64_ATTRIBUTION = 5 // #5 base64 水位归因
const COND_TRACE_DEGRADED = 6 // #6 活跃态 Trace 降级
const COND_AUTO_RESPAWN = 7 // #7 auto-respawn 周均 >5
const COND_ROLLING_RESTART = 8 // #8 滚动重启四子句
const COND_RENDERER_RELOAD = 9 // #9 renderer reload 月均 >4
const COND_EXT_CRASH = 10 // #10 第三方扩展崩溃月均 >2
const COND_CRASH_REPORTER = 11 // #11 白屏无记录 → crashReporter
const COND_DRAFT_LOSS = 12 // #12 reload 丢草稿
const COND_LIVE_RELOAD_DIFF = 13 // #13 live/reload 大文本差异
const COND_PAGINATION = 14 // #14 「加载更早」翻页抱怨
const COND_TRACE_FIRST_HIT = 15 // #15 Trace 首个真实命中
const COND_E2_COLLATERAL = 16 // #16 E2 型连坐复发
const COND_RELIEF_REBOUND = 17 // #17 降级反弹
const COND_MISSED_DEFER = 18 // #18 漏推迟首案例
const COND_PTY_SURVIVAL = 19 // #19 终端终止抱怨
const COND_REDACTED_EXPORT = 20 // #20 脱敏版诊断导出

/** 条件总数（附录 A SSOT = 20；全量清单断言与消费方遍历用）。 */
export const TRIGGER_CONDITION_COUNT = 20

/** requires-user-report 型条件 id（恒 no-data 显式列出——D2「其余 requires-user-report」）。 */
export const TRIGGER_USER_REPORT_IDS: readonly number[] = [
  COND_TRACE_DEGRADED,
  COND_CRASH_REPORTER,
  COND_DRAFT_LOSS,
  COND_LIVE_RELOAD_DIFF,
  COND_PAGINATION,
  COND_TRACE_FIRST_HIT,
  COND_MISSED_DEFER,
  COND_PTY_SURVIVAL,
  COND_REDACTED_EXPORT,
]

// ─────────────────────────────────────────────────────────────────────────────
// 阈值（附录 A 给了数字的照抄；未给数字的取值依据随行注释）
// ─────────────────────────────────────────────────────────────────────────────

const T1_TRUNC_WARN_WEEKLY_MAX = 10 // #1 出站截断告警周均 >10（crash-resilience D3 代价 A 原文）
// #3「显著上升」源文档无绝对阈值（crash-resilience.md:260 基线「现状一周数次以内」），
// 取基线上界 3 次/周为判线：低于 supervisor 放弃线（MAX 5 连续重启）又高于单次自愈常态。
const T3_RUNTIME_CRASH_WEEKLY_MAX = 3
const T7_AUTO_RESPAWN_WEEKLY_MAX = 5 // #7 auto-respawn 周均 >5（architecture D2 代价原文）
const T8_ROLLING_RESTART_WEEKLY_MAX = 1 // #8a 滚动重启 >周 1（原文）
const T8_DEFERRED_MONTHLY_MAX = 10 // #8b 推迟月均 >10（原文）
const T8_FORCED_MONTHLY_MAX = 3 // #8c forced 月均 >3（原文）
const T8_DEFER_LIMIT_RATIO_MAX = 0.3 // #8d defer-limit 占 forced >30%（原文）
// #8d absent-report 关联窗（分钟）：errs 推迟上限 30min（D5）+ 30min 观测余量，同 session
// 的 deferred(absent-report) 先于 forced(defer-limit) 落在该窗内即判为 errs 兼容形态。
const T8_ABSENT_REPORT_CORRELATION_MIN = 60
const T8_ABSENT_REPORT_CORRELATION_MS = T8_ABSENT_REPORT_CORRELATION_MIN * MS_PER_MINUTE
const T9_RELOAD_MONTHLY_MAX = 4 // #9 renderer reload 月均 >4（architecture D4 代价原文）
const T10_EXT_CRASH_MONTHLY_MAX = 2 // #10 第三方扩展崩溃月均 >2（architecture D5 代价原文）
const T16_SAME_SECOND_SESSIONS_MIN = 3 // #16 ≥3 session 同秒 exit（原文）
// #16 计划内关联窗（秒）：shutdown 杀链发起（D1 挂点）与 pi exit 的真实时差远小于秒级，
// 5s 容忍时钟取整与落盘时序偏差。
const T16_PLANNED_CORRELATION_SEC = 5
const T16_PLANNED_CORRELATION_MS = T16_PLANNED_CORRELATION_SEC * MS_PER_SECOND
const T4_MIN_COVERED_DAYS = 5 // #4 趋势判定最小有效覆盖天数（Gate W 校准前工作定义）
const T4_COVERAGE_WEIGHT_MIN = 0.5 // coverage <50% 降权（D1 watermark-daily 行原文）
const T4_RATCHET_RISE_RATIO = 1.2 // #4 棘轮上行：末日峰值 ≥ 首日 120%（Gate W 校准前工作定义）
const T4_NO_DROP_RATIO = 0.85 // #4 无单日回落 >15%（同上）

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerConditionStatus = 'tripped' | 'ok' | 'no-data'

/** 状态表单行（D2 输出契约：每条 条件/当前值/阈值/状态 + 可选标注）。 */
export interface TriggerConditionRow {
  /** 附录 A 条件序号（1-20）。 */
  id: number
  /** 条件描述（附录 A 原文 + 来源文档）。 */
  description: string
  /** 阈值（人读，进 summary.md / WARN 摘要）。 */
  threshold: string
  /** 当前值（人读）。 */
  currentValue: string
  status: TriggerConditionStatus
  /** 用户反馈型条件：恒 no-data，显式列出。 */
  requiresUserReport?: boolean
  /** 标注（coverage 降权 / Gate W 消费方 / 数据缺失原因 / 窗口覆盖不足等）。 */
  note?: string
}

export interface TriggerEvaluationResult {
  /** 实际使用的锚定时刻（ISO）；两本台账全空且未注入 now 时为 null。 */
  nowIso: string | null
  /** 20 条状态表（id 升序，与附录 A 一一对应）。 */
  rows: TriggerConditionRow[]
  /** status=tripped 的条件 id（巡检 WARN 与 trigger-review 事件的驱动源）。 */
  trippedIds: number[]
  /** 两本台账各自解析成功的事件数（no-data 判定的数据面证据）。 */
  parsedEventCount: { main: number; runtime: number }
  /** 两本台账各自的坏行数（JSON 解析失败/非对象/缺 ts——非静默，见文件头【坏行】）。 */
  skippedLineCount: { main: number; runtime: number }
}

export interface EvaluateTriggerConditionsInput {
  /** main.jsonl 的行数组（writer 落盘的 JSONL 行，含尾部空串也无害）。 */
  mainLines?: string[]
  /** runtime.jsonl 的行数组。 */
  runtimeLines?: string[]
  /** 锚定「现在」（epoch ms）；缺省 = 两本台账末事件时刻。 */
  now?: number
}

/** 带解析时间轴的台账事件。字段经 unknown 守卫访问（台账开放枚举，畸形值不炸评估器）。 */
export interface DatedEvent {
  raw: Record<string, unknown>
  tsMs: number
}

export interface ParsedJournal {
  events: DatedEvent[]
  skipped: number
  lastTsMs: number | null
}

// ─────────────────────────────────────────────────────────────────────────────
// 条件描述目录（附录 A 20 条 SSOT 的描述列；测试全量清单断言的数据源）
// ─────────────────────────────────────────────────────────────────────────────

const CONDITION_DESCRIPTIONS: Readonly<Record<number, string>> = {
  [COND_TRUNC_WARN]: '出站截断告警周均 >10 次（crash-resilience §3.3 D3 代价 A）',
  [COND_REGISTRY_MISS]: '出站注册表 miss 任何一次（crash-resilience §3.3 D3 代价 B）——inbound-frame-dropped 关联佐证',
  [COND_SUPERVISOR_RESTART]: 'supervisor 重启频率显著上升（crash-resilience §3.3 D7 代价 B）——main.jsonl runtime crash 窗口计数',
  [COND_WATERMARK_TREND]: '回收态存量致水位长期不回落（idle-pi-reclamation 代价声明 1）——watermark-daily 趋势，coverage<50% 的日降权标注',
  [COND_BASE64_ATTRIBUTION]: 'base64 证明为主要压力源·水位归因（crash-resilience v9 两步走）——人工归因型，watermark-daily 数据就绪标注',
  [COND_TRACE_DEGRADED]: '活跃态 Trace 降级重审（crash-resilience §3.4）',
  [COND_AUTO_RESPAWN]: 'auto-respawn 周均 >5 次（long-run-stability-architecture D2 代价）',
  [COND_ROLLING_RESTART]:
    '滚动重启 >周 1 / 推迟月均 >10 / forced 月均 >3 / defer-limit 占 forced >30%（architecture D3 代价 + 本文 D5 缺席语义⑤；占比分子排除 reason=absent-report）',
  [COND_RENDERER_RELOAD]: 'renderer reload 月均 >4（long-run-stability-architecture D4 代价）',
  [COND_EXT_CRASH]: '第三方扩展崩溃月均 >2（long-run-stability-architecture D5 代价）——crash 事件扩展归因分类计数',
  [COND_CRASH_REPORTER]: '白屏但两侧日志无记录 → crashReporter 立项（crash-resilience D2 代价 A）',
  [COND_DRAFT_LOSS]: 'reload 丢草稿反馈 → 草稿持久化立项（crash-resilience D2 代价 B）',
  [COND_LIVE_RELOAD_DIFF]: 'live/reload 大文本可见差异反馈（crash-resilience D3 代价 C）',
  [COND_PAGINATION]: '「加载更早」翻页高频抱怨（crash-resilience D4）',
  [COND_TRACE_FIRST_HIT]: 'Trace 首个真实命中 / cache size 帽占位真实出现（crash-resilience D5/D6）',
  [COND_E2_COLLATERAL]:
    'E2 型连坐复发 → dev/prod 隔离升级立项（crash-resilience D6 代价）——同秒 ≥3 session exit 且非计划内（shutdown 杀链发起事件时间窗关联排除）',
  [COND_RELIEF_REBOUND]: '降级反弹：memory-relief 执行后 10min 内水位不降反升 >5% 的比例周均 >30%（本文 D4 降级代价）',
  [COND_MISSED_DEFER]: '漏推迟首案例：滚动重启时有在途但未推迟·在途被杀（本文 D5 缺席语义⑤偏低方向）',
  [COND_PTY_SURVIVAL]: '终端终止抱怨随滚动重启出现 → PTY 独立存活（setsid）立项评估（本文 D5 家族表 terminal PTY 行）',
  [COND_REDACTED_EXPORT]: '用户反馈需要脱敏版诊断导出 → 可选项评估（本文 D6 隐私判定）',
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析与小工具
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function toEpochMs(v: unknown): number | null {
  const s = str(v)
  if (s === undefined || s.trim() === '') return null
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms
}

/**
 * JSONL 行数组 → 带时间轴事件 + 坏行计数（口径见文件头【坏行】）。
 * 导出供测试/导出侧复用同一解析口径。
 */
export function parseJournalLines(lines?: readonly string[]): ParsedJournal {
  const events: DatedEvent[] = []
  let skipped = 0
  let lastTsMs: number | null = null
  for (const rawLine of lines ?? []) {
    if (rawLine.trim() === '') continue // 换行切分伪影（尾随空行），非坏行
    let parsed: unknown
    try {
      parsed = JSON.parse(rawLine)
    } catch {
      skipped++ // 坏行：不可解析，跳过并计数（非静默）
      continue
    }
    if (!isRecord(parsed)) {
      skipped++ // 坏行：合法 JSON 但非对象（数组/标量）
      continue
    }
    const tsMs = toEpochMs(parsed.ts)
    if (tsMs === null) {
      skipped++ // 坏行：时间轴缺行（writer 恒补 ts，缺即畸形）
      continue
    }
    events.push({ raw: parsed, tsMs })
    if (lastTsMs === null || tsMs > lastTsMs) lastTsMs = tsMs
  }
  return { events, skipped, lastTsMs }
}

/** 左开右闭滚动窗 (now - window, now]。 */
function inWindow(tsMs: number, nowMs: number, windowMs: number): boolean {
  return tsMs > nowMs - windowMs && tsMs <= nowMs
}

/** 无锚定时刻（空台账）时窗口选择恒空集——配合 noDataReason 让行落入 no-data 分支。 */
function selectInWindow(
  events: readonly DatedEvent[],
  match: (raw: Record<string, unknown>) => boolean,
  nowMs: number | null,
  windowMs: number | null, // null = 全时段（#2「任何一次」）
): DatedEvent[] {
  if (nowMs === null) return []
  return events.filter((d) => match(d.raw) && (windowMs === null || inWindow(d.tsMs, nowMs, windowMs)))
}

// ── 事件谓词（台账事件名/层/reason 匹配口径集中登记，附录 A「评估形态」列的代码化）──

const isWarnTierTruncation = (e: Record<string, unknown>): boolean =>
  str(e.event) === 'frame-truncated' && str(e.reason) === 'warn-tier'
const isRuntimeCrash = (e: Record<string, unknown>): boolean => str(e.event) === 'crash' && str(e.layer) === 'runtime'
const isRespawnIncident = (e: Record<string, unknown>): boolean =>
  str(e.event) === 'auto-respawn' && str(e.reason) === 'scheduled'
const isExtensionCrash = (e: Record<string, unknown>): boolean =>
  str(e.event) === 'crash' && (str(e.reason) === 'extension-stale-ctx' || str(e.layer) === 'plugin-worker')
const isPiCrash = (e: Record<string, unknown>): boolean => str(e.event) === 'crash' && str(e.layer) === 'pi'
const isPlannedShutdown = (e: Record<string, unknown>): boolean => str(e.event) === 'shutdown'
const isReload = (e: Record<string, unknown>): boolean => str(e.event) === 'reload'
const isRegistryMiss = (e: Record<string, unknown>): boolean => str(e.event) === 'registry-miss'
const isWatermarkDaily = (e: Record<string, unknown>): boolean => str(e.event) === 'watermark-daily'
const isRollingRestart = (e: Record<string, unknown>): boolean => str(e.event) === 'rolling-restart'
const isRollingDeferred = (e: Record<string, unknown>): boolean => str(e.event) === 'rolling-restart-deferred'
const isRollingForced = (e: Record<string, unknown>): boolean => str(e.event) === 'rolling-restart-forced'

function fmtBytes(n: number): string {
  return n >= BYTES_PER_MB ? `${(n / BYTES_PER_MB).toFixed(1)}MB` : `${n}B`
}

function joinNotes(parts: readonly (string | undefined)[]): string | undefined {
  const joined = parts.filter((p): p is string => p !== undefined).join('；')
  return joined === '' ? undefined : joined
}

function windowDesc(ms: number): string {
  return ms === WEEK_MS ? '7 天' : '30 天'
}

// ─────────────────────────────────────────────────────────────────────────────
// 行构造器
// ─────────────────────────────────────────────────────────────────────────────

interface CountingRowSpec {
  id: number
  threshold: string
  windowMs: number
  maxCount: number
  matches: readonly DatedEvent[]
  nowMs: number
  /** 有值 = 该行数据源台账无事件 → no-data（显式原因，非静默）。 */
  noDataReason?: string
  note?: string
}

function countingRow(spec: CountingRowSpec): TriggerConditionRow {
  const description = CONDITION_DESCRIPTIONS[spec.id]
  if (spec.noDataReason !== undefined) {
    return { id: spec.id, description, threshold: spec.threshold, status: 'no-data', currentValue: '台账无事件', note: spec.noDataReason }
  }
  const count = spec.matches.length
  const status: TriggerConditionStatus = count > spec.maxCount ? 'tripped' : 'ok'
  // 窗口覆盖不足标注：最早命中事件落在窗口起点之后 = 数据未覆盖完整窗口，计数偏少
  const earliest = spec.matches.length > 0 ? Math.min(...spec.matches.map((m) => m.tsMs)) : undefined
  const spanInsufficient = earliest !== undefined && earliest > spec.nowMs - spec.windowMs
  return {
    id: spec.id,
    description,
    threshold: spec.threshold,
    status,
    currentValue: `${count} 次（滚动 ${windowDesc(spec.windowMs)}窗口）`,
    note: joinNotes([
      spec.note,
      spanInsufficient ? `数据跨度不足一个完整 ${windowDesc(spec.windowMs)}窗口，按现有数据计数` : undefined,
    ]),
  }
}

/** 用户反馈型行（恒 no-data 显式列出——D2「标注 requires-user-report 恒 no-data 但显式列出」）。 */
function userReportRow(id: number): TriggerConditionRow {
  return {
    id,
    description: CONDITION_DESCRIPTIONS[id],
    threshold: '用户反馈触发重审',
    status: 'no-data',
    currentValue: '待用户反馈',
    requiresUserReport: true,
    note: 'requires-user-report：台账无机判数据源，恒 no-data 但入清单显式列出（D2）',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// watermark-daily 样本抽取（#4/#5 数据源；u1e 生产者容错解析）
// ─────────────────────────────────────────────────────────────────────────────

interface WatermarkDaySample {
  tsMs: number
  /** 当日 heap 峰值（bytes）：digest JSON heapMax ?? 事件 heapUsed ?? digest rssMax ?? 事件 rss。 */
  peakHeap: number | null
  /** 当日覆盖度（0-1）；null = 未声明（不降权——降权需 <50% 的证据，D1）。 */
  coverageFraction: number | null
}

/**
 * 容错抽取 watermark-daily 单日样本。D1 契约：自然日窗口一条，携带 rss/heapUsed
 * min/max/avg + coverage 起止时间戳——schema 顶层只有单值 rss/heapUsed 字段，聚合形态
 * 约定走 detailDigest JSON（{heapMax?, rssMax?, coveragePct?} 或
 * {coverageStart?, coverageEnd?} ISO 对）；digest 缺失/不可解析时退回顶层单值字段，
 * coverage 未知则不降权（默认全权重——降权是例外，需 <50% 证据）。
 */
/** detailDigest JSON 容错解析：非字符串 / 非 `{` 开头 / 坏 JSON / 非对象 → null（digest 缺失退回顶层字段）。 */
function parseDetailDigest(raw: unknown): Record<string, unknown> | null {
  const digestRaw = str(raw)
  if (digestRaw === undefined || !digestRaw.trim().startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(digestRaw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null // digest 坏行不致命：退回顶层字段
  }
}

/** coverage 两形态 → 覆盖度分数：coveragePct（>1 按 0-100 百分比缩放）或 coverage 起止时间对占当日比例；两者皆缺 → null（未声明不降权——降权需 <50% 的证据，D1）。 */
function coverageFractionOf(digest: Record<string, unknown>): number | null {
  const pct = num(digest.coveragePct)
  if (pct !== undefined) {
    return Math.min(1, Math.max(0, pct > 1 ? pct / PERCENT_SCALE : pct))
  }
  const startMs = toEpochMs(digest.coverageStart)
  const endMs = toEpochMs(digest.coverageEnd)
  if (startMs !== null && endMs !== null && endMs > startMs) {
    return Math.min(1, (endMs - startMs) / MS_PER_DAY)
  }
  return null
}

function extractWatermarkSample(d: DatedEvent): WatermarkDaySample {
  const digest = parseDetailDigest(d.raw.detailDigest)
  const peakHeap = num(digest?.heapMax) ?? num(d.raw.heapUsed) ?? num(digest?.rssMax) ?? num(d.raw.rss) ?? null
  return { tsMs: d.tsMs, peakHeap, coverageFraction: digest === null ? null : coverageFractionOf(digest) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 评估器主入口
// ─────────────────────────────────────────────────────────────────────────────

/** 评估 20 条触发条件（唯一输入 = 两本台账行数组 + 当前时刻，见文件头）。 */
export function evaluateTriggerConditions(input: EvaluateTriggerConditionsInput = {}): TriggerEvaluationResult {
  const main = parseJournalLines(input.mainLines)
  const runtime = parseJournalLines(input.runtimeLines)
  const nowMs = input.now ?? (main.lastTsMs ?? runtime.lastTsMs)

  const noAnchor = nowMs === null
  const mainNoData = main.events.length === 0 ? 'main 台账无事件（文件缺失或空）' : undefined
  const runtimeNoData = runtime.events.length === 0 ? 'runtime 台账无事件（文件缺失或空）' : undefined
  const anchorNoData = (): string | undefined => (noAnchor ? '空台账无锚定时刻' : undefined)
  const at = nowMs ?? 0 // 无锚点时行落 no-data 分支，不消费该值

  const row1 = countingRow({
    id: COND_TRUNC_WARN,
    threshold: `> ${T1_TRUNC_WARN_WEEKLY_MAX} 次/7 天（reason=warn-tier 档）`,
    windowMs: WEEK_MS,
    maxCount: T1_TRUNC_WARN_WEEKLY_MAX,
    matches: selectInWindow(runtime.events, isWarnTierTruncation, nowMs, WEEK_MS),
    nowMs: at,
    noDataReason: anchorNoData() ?? runtimeNoData,
  })

  // #2 全时段出现即触发；inbound-frame-dropped（main 台账）作 D8 哨兵佐证
  const registryMisses = selectInWindow(runtime.events, isRegistryMiss, nowMs, null)
  const inboundDropped = selectInWindow(main.events, (e) => str(e.event) === 'inbound-frame-dropped', nowMs, null)
  const row2 = buildRegistryMissRow(registryMisses, inboundDropped, noAnchor, runtimeNoData)

  const row3 = countingRow({
    id: COND_SUPERVISOR_RESTART,
    threshold: `> ${T3_RUNTIME_CRASH_WEEKLY_MAX} 次/7 天（源文档无绝对阈值，取基线「一周数次以内」上界）`,
    windowMs: WEEK_MS,
    maxCount: T3_RUNTIME_CRASH_WEEKLY_MAX,
    matches: selectInWindow(main.events, isRuntimeCrash, nowMs, WEEK_MS),
    nowMs: at,
    noDataReason: anchorNoData() ?? mainNoData,
  })

  const row4 = buildWatermarkTrendRow(
    selectInWindow(runtime.events, isWatermarkDaily, nowMs, MONTH_MS),
    nowMs,
    runtimeNoData,
  )

  // #5 人工归因型：恒 no-data + watermark 数据就绪标注
  const row5 = buildBase64ReadinessRow(selectInWindow(runtime.events, isWatermarkDaily, nowMs, MONTH_MS), nowMs)

  const row7 = countingRow({
    id: COND_AUTO_RESPAWN,
    threshold: `> ${T7_AUTO_RESPAWN_WEEKLY_MAX} 次/7 天（按 reason=scheduled 事故计数）`,
    windowMs: WEEK_MS,
    maxCount: T7_AUTO_RESPAWN_WEEKLY_MAX,
    matches: selectInWindow(runtime.events, isRespawnIncident, nowMs, WEEK_MS),
    nowMs: at,
    noDataReason: anchorNoData() ?? runtimeNoData,
    note: '一次 respawn 事故产生 scheduled/attempt/succeeded 多条状态事件，按 scheduled 去重',
  })

  const row8 = buildRollingRestartRow(main.events, runtime.events, nowMs, mainNoData, runtimeNoData)

  const row9 = countingRow({
    id: COND_RENDERER_RELOAD,
    threshold: `> ${T9_RELOAD_MONTHLY_MAX} 次/30 天`,
    windowMs: MONTH_MS,
    maxCount: T9_RELOAD_MONTHLY_MAX,
    matches: selectInWindow(main.events, isReload, nowMs, MONTH_MS),
    nowMs: at,
    noDataReason: anchorNoData() ?? mainNoData,
  })

  const row10 = countingRow({
    id: COND_EXT_CRASH,
    threshold: `> ${T10_EXT_CRASH_MONTHLY_MAX} 次/30 天（reason=extension-stale-ctx 或 layer=plugin-worker）`,
    windowMs: MONTH_MS,
    maxCount: T10_EXT_CRASH_MONTHLY_MAX,
    matches: selectInWindow(runtime.events, isExtensionCrash, nowMs, MONTH_MS),
    nowMs: at,
    noDataReason: anchorNoData() ?? runtimeNoData,
  })

  // 用户反馈型 9 条：恒 no-data 显式列出（D2）
  const [row6, row11, row12, row13, row14, row15, row18, row19, row20] = TRIGGER_USER_REPORT_IDS.map(userReportRow)

  const row16 = buildE2CollateralRow(runtime.events, nowMs, runtimeNoData)

  // #17 降级反弹：恒 no-data，消费方 = Gate W 人工复审
  const row17: TriggerConditionRow = {
    id: COND_RELIEF_REBOUND,
    description: CONDITION_DESCRIPTIONS[COND_RELIEF_REBOUND],
    threshold: '周均 >30%（人工复审判据）',
    status: 'no-data',
    currentValue: '不可机判——判据需 memory-relief 前后水位对比（60s 采样环内存态不落台账）',
    note: '消费方 = Gate W（u8）人工复审；水位 5min 明细行在 runtime 日志供人工深查（D4 降级代价）',
  }

  const rows = [
    row1, row2, row3, row4, row5, row6, row7, row8, row9, row10,
    row11, row12, row13, row14, row15, row16, row17, row18, row19, row20,
  ]
  return {
    nowIso: nowMs === null ? null : new Date(nowMs).toISOString(),
    rows,
    trippedIds: rows.filter((r) => r.status === 'tripped').map((r) => r.id),
    parsedEventCount: { main: main.events.length, runtime: runtime.events.length },
    skippedLineCount: { main: main.skipped, runtime: runtime.skipped },
  }
}

// ── #4：水位长期不回落（棘轮上行工作定义，Gate W 校准前）─────────────────────
function buildWatermarkTrendRow(
  wm: readonly DatedEvent[],
  nowMs: number | null,
  runtimeNoData: string | undefined,
): TriggerConditionRow {
  const base = { id: COND_WATERMARK_TREND, description: CONDITION_DESCRIPTIONS[COND_WATERMARK_TREND] }
  const threshold =
    `棘轮上行：末≥首×${Math.round(T4_RATCHET_RISE_RATIO * PERCENT_SCALE)}% ` +
    `且无单日回落>${Math.round((1 - T4_NO_DROP_RATIO) * PERCENT_SCALE)}%，有效覆盖≥${T4_MIN_COVERED_DAYS} 天（Gate W 校准前工作定义）`
  if (nowMs === null) {
    return { ...base, threshold, status: 'no-data', currentValue: '台账无事件', note: '空台账无锚定时刻' }
  }
  if (runtimeNoData !== undefined) {
    return { ...base, threshold, status: 'no-data', currentValue: '台账无事件', note: runtimeNoData }
  }
  const samples = wm.map(extractWatermarkSample).sort((a, b) => a.tsMs - b.tsMs)
  const covered = samples.filter((s) => s.coverageFraction === null || s.coverageFraction >= T4_COVERAGE_WEIGHT_MIN)
  const downweighted = samples.length - covered.length
  const peaks = covered.map((s) => s.peakHeap).filter((p): p is number => p !== null)
  if (peaks.length < T4_MIN_COVERED_DAYS) {
    return {
      ...base,
      threshold,
      status: 'no-data',
      currentValue: `有效覆盖 ${peaks.length}/${T4_MIN_COVERED_DAYS} 天`,
      note: joinNotes([downweighted > 0 ? `coverage<50% 降权 ${downweighted} 天` : undefined, '有效覆盖天数不足，趋势不可判']),
    }
  }
  const first = peaks[0]
  const last = peaks[peaks.length - 1]
  let noDrop = true
  for (let i = 1; i < peaks.length; i++) {
    if (peaks[i] < peaks[i - 1] * T4_NO_DROP_RATIO) {
      noDrop = false
      break
    }
  }
  const tripped = noDrop && first > 0 && last >= first * T4_RATCHET_RISE_RATIO
  return {
    ...base,
    threshold,
    status: tripped ? 'tripped' : 'ok',
    currentValue: `有效覆盖 ${peaks.length} 天（降权 ${downweighted} 天），heap 峰值 ${fmtBytes(first)} → ${fmtBytes(last)}`,
    note: joinNotes([
      downweighted > 0
        ? `coverage<50% 降权 ${downweighted} 天（滚动重启水位重置会掩盖不回落形态，coverage 是判别依据，D1）`
        : undefined,
      '明细 5min 水位行在 runtime 日志供深查',
    ]),
  }
}

// ── #5：base64 归因就绪标注（恒 no-data）────────────────────────────────────
function buildBase64ReadinessRow(wm: readonly DatedEvent[], nowMs: number | null): TriggerConditionRow {
  const samples = nowMs === null ? [] : wm.map(extractWatermarkSample)
  const covered = samples.filter((s) => s.coverageFraction === null || s.coverageFraction >= T4_COVERAGE_WEIGHT_MIN)
  return {
    id: COND_BASE64_ATTRIBUTION,
    description: CONDITION_DESCRIPTIONS[COND_BASE64_ATTRIBUTION],
    threshold: '人工归因',
    status: 'no-data',
    currentValue:
      samples.length > 0
        ? `watermark-daily 数据已就绪（窗口内 ${samples.length} 日，有效覆盖 ${covered.length} 日）`
        : 'watermark-daily 数据未就绪（窗口内 0 日）',
    note: '人工归因型：数据就绪后仍需人工归因 base64 压力源占比（明细 5min 行在 runtime 日志供深查）',
  }
}

// ── #8：滚动重启四子句 ──────────────────────────────────────────────────────
function buildRollingRestartRow(
  mainEvents: readonly DatedEvent[],
  runtimeEvents: readonly DatedEvent[],
  nowMs: number | null,
  mainNoData: string | undefined,
  runtimeNoData: string | undefined,
): TriggerConditionRow {
  const base = { id: COND_ROLLING_RESTART, description: CONDITION_DESCRIPTIONS[COND_ROLLING_RESTART] }
  const threshold =
    `滚动重启 >${T8_ROLLING_RESTART_WEEKLY_MAX}/周 ∨ 推迟 >${T8_DEFERRED_MONTHLY_MAX}/月 ∨ ` +
    `forced >${T8_FORCED_MONTHLY_MAX}/月 ∨ defer-limit 占 forced >${T8_DEFER_LIMIT_RATIO_MAX * PERCENT_SCALE}%（分子排除 absent-report）`
  if (nowMs === null) {
    return { ...base, threshold, status: 'no-data', currentValue: '台账无事件', note: '空台账无锚定时刻' }
  }
  if (mainEvents.length === 0 && runtimeEvents.length === 0) {
    return { ...base, threshold, status: 'no-data', currentValue: '台账无事件', note: joinNotes([mainNoData, runtimeNoData]) }
  }
  // rolling-restart 事件族全由 runtime writer 写：runtime 台账缺失时双空判据会漏判
  // （main 非空 → 四子句全 0 判 ok），主数据源缺失必须独立呈现 no-data
  if (runtimeEvents.length === 0 && runtimeNoData !== undefined) {
    return { ...base, threshold, status: 'no-data', currentValue: 'runtime 台账缺失', note: joinNotes([runtimeNoData, mainNoData]) }
  }
  const merged = [...mainEvents, ...runtimeEvents]
  const restarts = selectInWindow(merged, isRollingRestart, nowMs, WEEK_MS)
  const deferred = selectInWindow(merged, isRollingDeferred, nowMs, MONTH_MS)
  const forced = selectInWindow(merged, isRollingForced, nowMs, MONTH_MS)
  // 子句 d：分子（defer-limit forced）排除与 absent-report deferred 同 session 且落在关联
  // 窗内的 errs 兼容形态（无 sessionId 无法关联 → 不能证明是 absent-report → 计入）
  const absentDeferred = deferred.filter((d) => str(d.raw.reason) === 'absent-report')
  const deferLimitForced = forced.filter((f) => str(f.raw.reason) === 'defer-limit')
  const genuineDeferLimit = deferLimitForced.filter((f) => {
    const sid = str(f.raw.sessionId)
    if (sid === undefined) return true
    return !absentDeferred.some(
      (d) => str(d.raw.sessionId) === sid && f.tsMs - d.tsMs >= 0 && f.tsMs - d.tsMs <= T8_ABSENT_REPORT_CORRELATION_MS,
    )
  })
  const tripped =
    restarts.length > T8_ROLLING_RESTART_WEEKLY_MAX ||
    deferred.length > T8_DEFERRED_MONTHLY_MAX ||
    forced.length > T8_FORCED_MONTHLY_MAX ||
    (forced.length > 0 && genuineDeferLimit.length / forced.length > T8_DEFER_LIMIT_RATIO_MAX)
  const ratio = forced.length > 0 ? genuineDeferLimit.length / forced.length : null
  return {
    ...base,
    threshold,
    status: tripped ? 'tripped' : 'ok',
    currentValue:
      `滚动重启 ${restarts.length}/7天 · 推迟 ${deferred.length}/30天 · forced ${forced.length}/30天 · ` +
      `defer-limit 占比 ${ratio === null ? '不适用（无 forced）' : `${Math.round(ratio * PERCENT_SCALE)}%`}`,
    note: joinNotes([
      `分子排除 absent-report 关联 ${deferLimitForced.length - genuineDeferLimit.length} 条；absent-report 推迟单列观测 ${absentDeferred.length} 条（D5 缺席语义⑤）`,
      'rolling-restart 事件族武装后产生（Gate W 前），本条非武装门本身（D5）',
    ]),
  }
}

// ── #2：出站注册表 miss（任何一次即触发；inbound-frame-dropped 作 D8 哨兵佐证）──
function buildRegistryMissRow(
  registryMisses: readonly DatedEvent[],
  inboundDropped: readonly DatedEvent[],
  noAnchor: boolean,
  runtimeNoData: string | undefined,
): TriggerConditionRow {
  // no-data 分支 note = 原 `anchorNoData() ?? runtimeNoData`：入分支时 noAnchor 真 → 首值；
  // 否则 runtimeNoData 必有值（分支条件保证），等价展开。
  if (noAnchor || runtimeNoData !== undefined) {
    return {
      id: COND_REGISTRY_MISS,
      description: CONDITION_DESCRIPTIONS[COND_REGISTRY_MISS],
      threshold: '> 0 次（任何一次即触发）',
      status: 'no-data',
      currentValue: '台账无事件',
      note: noAnchor ? '空台账无锚定时刻' : runtimeNoData,
    }
  }
  return {
    id: COND_REGISTRY_MISS,
    description: CONDITION_DESCRIPTIONS[COND_REGISTRY_MISS],
    threshold: '> 0 次（任何一次即触发）',
    status: registryMisses.length > 0 ? 'tripped' : 'ok',
    currentValue:
      `${registryMisses.length} 次（台账留存全期，出现即触发）` +
      (inboundDropped.length > 0 ? `；inbound-frame-dropped 佐证 ${inboundDropped.length} 条` : ''),
    note: inboundDropped.length > 0 ? '入站丢弃 = 出站守卫被绕过的哨兵信号（D8 哨兵语义）' : undefined,
  }
}

// ── #16：E2 型连坐（同秒多 SIGTERM 形态）───────────────────────────────────
function buildE2CollateralRow(runtimeEvents: readonly DatedEvent[], nowMs: number | null, runtimeNoData: string | undefined): TriggerConditionRow {
  const base = { id: COND_E2_COLLATERAL, description: CONDITION_DESCRIPTIONS[COND_E2_COLLATERAL] }
  const threshold = `≥ ${T16_SAME_SECOND_SESSIONS_MIN} 个不同 session 同秒非计划内 exit（30 天窗口）`
  if (nowMs === null) {
    return { ...base, threshold, status: 'no-data', currentValue: '台账无事件', note: '空台账无锚定时刻' }
  }
  if (runtimeNoData !== undefined) {
    return { ...base, threshold, status: 'no-data', currentValue: '台账无事件', note: runtimeNoData }
  }
  const piCrashes = selectInWindow(runtimeEvents, isPiCrash, nowMs, MONTH_MS)
  const shutdowns = selectInWindow(runtimeEvents, isPlannedShutdown, nowMs, MONTH_MS)
  // 计划内排除：crash 与同 session 的 shutdown（kill 发起事件，D1 shutdown 行挂点）
  // 时间差在关联窗内 → 判为计划内（destroyAll 连坐杀链），不计入
  const unplanned = piCrashes.filter((c) => {
    const sid = str(c.raw.sessionId)
    if (sid === undefined) return true // 无 sessionId 无法关联 → 保守计入
    return !shutdowns.some((s) => str(s.raw.sessionId) === sid && Math.abs(c.tsMs - s.tsMs) <= T16_PLANNED_CORRELATION_MS)
  })
  const buckets = new Map<number, Set<string>>()
  let missingSessionId = 0
  for (const c of unplanned) {
    const sid = str(c.raw.sessionId)
    if (sid === undefined) {
      missingSessionId++ // 「≥3 session」判定无法归因，排除出桶计数并在 note 显式
      continue
    }
    const second = Math.floor(c.tsMs / MS_PER_SECOND)
    const bucket = buckets.get(second) ?? new Set<string>()
    bucket.add(sid)
    buckets.set(second, bucket)
  }
  let peakSameSecond = 0
  for (const bucket of buckets.values()) peakSameSecond = Math.max(peakSameSecond, bucket.size)
  return {
    ...base,
    threshold,
    status: peakSameSecond >= T16_SAME_SECOND_SESSIONS_MIN ? 'tripped' : 'ok',
    currentValue:
      `峰值同秒 ${peakSameSecond} session（30 天窗口，计划内已排除）` +
      (missingSessionId > 0 ? `；无 sessionId ${missingSessionId} 条未计入` : ''),
    note: `计划内以 shutdown 杀链发起事件 ±${T16_PLANNED_CORRELATION_SEC}s 时间窗关联排除（D1 shutdown 行挂点）`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 静态自检（附录 A 全量登记防线：描述目录必须 20 条齐整且 id 连续）
// ─────────────────────────────────────────────────────────────────────────────

const _catalogIds = Object.keys(CONDITION_DESCRIPTIONS)
  .map(Number)
  .sort((a, b) => a - b)
if (
  _catalogIds.length !== TRIGGER_CONDITION_COUNT ||
  _catalogIds.some((id, i) => id !== i + 1 || CONDITION_DESCRIPTIONS[id] === undefined)
) {
  throw new Error(`CONDITION_DESCRIPTIONS 必须恰好连续登记 ${TRIGGER_CONDITION_COUNT} 条，实际 [${_catalogIds.join(',')}]`)
}
