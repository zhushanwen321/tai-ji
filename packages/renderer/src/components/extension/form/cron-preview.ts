/**
 * cron / duration 下次运行预览引擎（ScheduleCreateOverlay 迁移原样抽出，行为零变化）。
 *
 * 纯前端轻量解析子集（cron 分钟步进穷举 + duration 步进），不引入 croner 等 renderer
 * 新依赖；解析是后端 croner 的子集（5/6 段 + 周域英文名），预览失败仅显示非阻塞警示、
 * 不禁止提交（表达式由创建端 parseSchedule/croner 验证——canSubmit 与预览解耦）。
 *
 * 从 ScheduleForm（原 ScheduleCreateOverlay）抽出以满足 script 行数上限：本模块是
 * 无状态纯函数集，抽出零耦合（设计 ui-presentation-protocol u3）。
 */

// ── 时长进率常量（单一声明处）：duration 解析与 ScheduleForm 预览/初值计算共用 ──
export const MS_PER_MINUTE = 60_000
export const MS_PER_HOUR = 3_600_000
export const MS_PER_DAY = 86_400_000

type CronField = Set<number> | null // null = 通配

// cron 五域上限（分 0-59 / 时 0-23 / 日 1-31 / 月 1-12 / 周 0-7；周域 7 = 周日惯例，与 0 等价）
const CRON_MINUTE_MAX = 59
const CRON_HOUR_MAX = 23
const CRON_DAY_MAX = 31
const CRON_MONTH_MAX = 12
const CRON_DOW_MAX = 7
const CRON_FIELD_MIN = [0, 0, 1, 1, 0]
const CRON_FIELD_MAX = [CRON_MINUTE_MAX, CRON_HOUR_MAX, CRON_DAY_MAX, CRON_MONTH_MAX, CRON_DOW_MAX]

/** cron 协议常量：5 段表达式（分 时 日 月 周）+ 周域索引（第 5 域）*/
const CRON_FIELD_COUNT = 5
const CRON_DOW_FIELD_INDEX = 4
/** 6 段含秒形态（秒 分 时 日 月 周；croner 接受，后端 normalize 5 段补秒后同为 6 段） */
const CRON_FIELD_COUNT_WITH_SECONDS = 6
/** 周域英文名域（croner 接受 MON-SUN，大小写不敏感）→ 数字（0=周日，与数字域语义一致） */
const DOW_NAME_TO_NUMBER: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const DOW_NAME_RE = /\b(sun|mon|tue|wed|thu|fri|sat)\b/gi
const DAYS_PER_WEEK = 7
const DURATION_UNITS: Record<string, number> = { m: MS_PER_MINUTE, h: MS_PER_HOUR, d: MS_PER_DAY, w: DAYS_PER_WEEK * MS_PER_DAY }
/** cron 步进穷举上界天数（闰年覆盖；一步 = 1 分钟） */
const CRON_SCAN_LIMIT_DAYS = 366

/** 预览条数（循环任务展示前 5 次下次运行） */
export const PREVIEW_RUN_COUNT = 5

/** 周域段英文名归一为数字（后端权威 croner 接受 MON-SUN；前端预览子集等价映射），
 *  替换后复用既有数字/范围/步进逻辑（MON-FRI → 1-5、MON,WED → 1,3）；非周域原样返回 */
function normalizeDowSegment(seg: string, rangeIdx: number): string {
  if (rangeIdx !== CRON_DOW_FIELD_INDEX) return seg
  return seg.replace(DOW_NAME_RE, (m) => String(DOW_NAME_TO_NUMBER[m.toLowerCase()] ?? m))
}

/** 步进段（\*\/n，如 \*\/5 每 5 分钟）：n≥1 时从 min 步进填充至 max；n<1 非法 */
function addStepValues(out: Set<number>, min: number, max: number, step: number): boolean {
  if (step < 1) return false
  for (let v = min; v <= max; v += step) out.add(v)
  return true
}

/** `a-b` 范围段：越界或倒序非法；合法则整段填充 */
function addRangeValues(out: Set<number>, a: number, b: number, min: number, max: number): boolean {
  if (a < min || b > max || a > b) return false
  for (let v = a; v <= b; v += 1) out.add(v)
  return true
}

/** 单值段：越界非法；合法则填充 */
function addSingleValue(out: Set<number>, n: number, min: number, max: number): boolean {
  if (n < min || n > max) return false
  out.add(n)
  return true
}

/** 单段（逗号分隔后）解析：步进 / 范围 / 单值三分支依次匹配，非法返回 false */
function parseCronSegment(out: Set<number>, seg: string, min: number, max: number): boolean {
  const step = seg.match(/^\*\/(\d+)$/)
  if (step) return addStepValues(out, min, max, Number(step[1]))
  const rng = seg.match(/^(\d+)-(\d+)$/)
  if (rng) return addRangeValues(out, Number(rng[1]), Number(rng[2]), min, max)
  if (!/^\d+$/.test(seg)) return false
  return addSingleValue(out, Number(seg), min, max)
}

function parseCronPart(part: string, rangeIdx: number): CronField | 'invalid' {
  if (part === '*') return null
  const min = CRON_FIELD_MIN[rangeIdx] ?? 0
  const max = CRON_FIELD_MAX[rangeIdx] ?? CRON_MINUTE_MAX
  const out = new Set<number>()
  for (const seg of part.split(',')) {
    if (!parseCronSegment(out, normalizeDowSegment(seg, rangeIdx), min, max)) return 'invalid'
  }
  return out
}

function cronMatches(cursor: Date, fields: CronField[]): boolean {
  const vals = [cursor.getMinutes(), cursor.getHours(), cursor.getDate(), cursor.getMonth() + 1, cursor.getDay()]
  for (let i = 0; i < vals.length; i++) {
    const f = fields[i]
    if (!f) continue
    if (f.has(vals[i])) continue
    if (i === CRON_DOW_FIELD_INDEX && vals[i] === 0 && f.has(CRON_DOW_MAX)) continue // 周域 7 = 周日
    return false
  }
  return true
}

/** 5/6 段 cron 下次运行（分钟步进穷举，上界 366 天，无命中返回 null）。
 *  6 段 = 首段秒（croner 语义）：预览为分钟粒度，跳过秒段算后续字段（秒段非 0/* 时
 *  实际触发在命中分钟内的第 N 秒，预览显示到分钟，不承诺秒级精度）。 */
export function cronNextRuns(expr: string, count: number, from: Date): Date[] | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== CRON_FIELD_COUNT && parts.length !== CRON_FIELD_COUNT_WITH_SECONDS) return null
  const fieldOffset = parts.length === CRON_FIELD_COUNT_WITH_SECONDS ? 1 : 0
  const fields: CronField[] = []
  for (let i = 0; i < CRON_FIELD_COUNT; i++) {
    const f = parseCronPart(parts[i + fieldOffset]!, i)
    if (f === 'invalid') return null
    fields.push(f)
  }
  const out: Date[] = []
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = (CRON_SCAN_LIMIT_DAYS * MS_PER_DAY) / MS_PER_MINUTE
  let stepped = 0
  while (out.length < count && stepped < limit) {
    if (cronMatches(cursor, fields)) out.push(new Date(cursor.getTime()))
    cursor.setMinutes(cursor.getMinutes() + 1)
    stepped++
  }
  return out.length > 0 ? out : null
}

/** duration（如 5m/2h/7d）→ ms；非 duration 形态返回 null */
export function parseDurationMs(s: string): number | null {
  const m = s.trim().match(/^(\d+)([mhdw])$/)
  if (!m) return null
  const unit = DURATION_UNITS[m[2]]
  return unit === undefined ? null : Number(m[1]) * unit
}
