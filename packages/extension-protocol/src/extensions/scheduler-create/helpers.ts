/**
 * scheduler 创建确认的共享协议资产（定制交互 helper 已退役）。
 *
 * scheduleCreateInteract() 已随统一提问表单协议迁移退役（ui-presentation-protocol
 * D3/u6，直接退役不保留 deprecated 别名）：scheduler 的创建确认改走
 * uiFormInteract() + UI_FORM_MARKER（ScheduleQuestion 形态，initial 预填草稿），
 * 交互入口在 extensions/universal/scheduler/src/tool.ts。
 *
 * 本模块保留三类跨端共享资产：
 * - isScheduleDraft / isScheduleFormResult 形状守卫：前者供 runtime event-adapter
 *   legacy 分支（SCHEDULE_CREATE_MARKER 帧 payload 判定）与 ui-form 守卫的
 *   schedule 分支（initial 深度校验）消费；后者供 scheduler 包回包判别
 *   （uiFormInteract answers[key] 解包后收窄为 ScheduleFormResult）。
 * - dateToOnceCron / onceCronToDate 时间折叠单点（D2）：GUI（ScheduleForm 渲染器）
 *   与 TUI（ScheduleCreateComponent）共用本实现，禁止双端各写一份——时间语义
 *   漂移正是本协议要关闭的失败模式（F1）。
 *
 * 时区语义：按本地墙钟时间（croner 对 cron 默认本地解释，datetime 控件与 TUI
 * 掩码编辑均产出本地墙钟时间）。
 */

import type { ScheduleDraft, ScheduleFormResult } from './types'

/** 形状守卫公共前置：非 null 的普通对象（排除数组；JSON.parse 产物均为 JSON 值） */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 可选字符串字段：undefined（JSON.stringify 丢弃的可选字段）或 string */
function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

/** 字符串数组字段（models 白名单逐项校验） */
function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((m) => typeof m === 'string')
}

/**
 * 类型守卫：验证 unknown 是否为合法的 ScheduleDraft。
 * 用于 runtime event-adapter 判定 marker select 的 payload 是否为本协议 draft
 * （检测失败降级普通 select），以及前端从 runtime 透传值中安全收窄。
 * 字段白名单校验（与 isAskUserQuestion 同构）：可选字段校验类型，未知附加字段忽略。
 */
export function isScheduleDraft(value: unknown): value is ScheduleDraft {
  if (!isPlainRecord(value)) return false
  const d = value
  return (d.kind === 'once' || d.kind === 'recurring')
    && typeof d.schedule === 'string'
    && isOptionalString(d.model)
    && typeof d.prompt === 'string'
    && isOptionalString(d.name)
    && isOptionalString(d.expires)
    && isStringArray(d.models)
    && isOptionalString(d.currentModel)
}

/** 回传形状守卫（导出消费：scheduler 包对 uiFormInteract answers[key] 解包值收窄；
 *  FormOverlay schedule 渲染器提交的 value = JSON.stringify(ScheduleFormResult)） */
export function isScheduleFormResult(value: unknown): value is ScheduleFormResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return r.action === 'create'
    && (r.kind === 'once' || r.kind === 'recurring')
    && typeof r.schedule === 'string'
    && (r.model === undefined || typeof r.model === 'string')
    && typeof r.prompt === 'string'
    && (r.name === undefined || typeof r.name === 'string')
    && (r.expires === undefined || typeof r.expires === 'string')
}

// ── 时间折叠单点（D2）：一次性时刻 ↔ 一次性 cron ──

/**
 * 本地墙钟时刻 → 一次性 cron（5 段 `分 时 日 月 *`）。
 *
 * 一次性 cron 语义：具体日 + 具体月 + 星期通配 → croner 天然只命中一次（S8/D2），
 * scheduler 现有 parseSchedule 直接接受，service 层零感知。
 */
export function dateToOnceCron(date: Date): string {
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
}

// 一次性 cron 固定 5 段（分 时 日 月 *），第 5 段为星期通配符
const ONCE_CRON_FIELD_COUNT = 5
// cron 各字段合法上/下界（分/时/日/月，与 croner 的标准 cron 语义一致）
const CRON_MINUTE_MAX = 59
const CRON_HOUR_MAX = 23
const CRON_DAY_MIN = 1
const CRON_DAY_MAX = 31
const CRON_MONTH_MIN = 1
const CRON_MONTH_MAX = 12
// 年份顺延上界：覆盖闰年周期（4 年）与 2100 类非闰世纪年跳变
const ONCE_CRON_MAX_YEAR_LOOKAHEAD = 8

/**
 * 一次性 cron（5 段 `分 时 日 月 *`）→ 本地墙钟时刻。
 *
 * cron 不含年份，还原为「下一次发生的该时刻」：以 now 为基准取当年，当年已过
 * 或该年不存在此日（如非闰年的 2/29——Date 构造对越界日静默滚动，解构回验字段
 * 一致性即「该年存在此日」判定）则向后顺延年份（至多 ONCE_CRON_MAX_YEAR_LOOKAHEAD
 * 年，覆盖闰年周期与 2100 类非闰世纪年跳变），供表单时间初值还原。
 *
 * 非 5 段 / 星期位非 * / 数字段含非数字或越界（分 0-59 / 时 0-23 / 日 1-31 /
 * 月 1-12）→ null（循环 cron 等非一次性形态不做时刻还原）。
 */
/** 一次性 cron 前 4 段（分 时 日 月）数字解析：全为纯数字 → 数值元组，否则 null（星期位 * 已由调用方校验，不入本解析） */
function parseOnceCronNumbers(parts: string[]): [number, number, number, number] | null {
  const [minute, hour, day, month] = parts
  if (![minute, hour, day, month].every((seg) => /^\d+$/.test(seg))) return null
  return [Number(minute), Number(hour), Number(day), Number(month)]
}

/** 一次性 cron 数字段越界判定：分/时/日/月任一超出合法区间即非法 */
function isOnceCronValueOutOfRange(m: number, h: number, d: number, mon: number): boolean {
  return m > CRON_MINUTE_MAX || h > CRON_HOUR_MAX
    || d < CRON_DAY_MIN || d > CRON_DAY_MAX
    || mon < CRON_MONTH_MIN || mon > CRON_MONTH_MAX
}

export function onceCronToDate(cron: string, now: Date = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== ONCE_CRON_FIELD_COUNT || parts[4] !== '*') return null
  const numbers = parseOnceCronNumbers(parts)
  if (numbers === null) return null
  const [m, h, d, mon] = numbers
  if (isOnceCronValueOutOfRange(m, h, d, mon)) return null
  const startYear = now.getFullYear()
  for (let year = startYear; year <= startYear + ONCE_CRON_MAX_YEAR_LOOKAHEAD; year++) {
    const candidate = new Date(year, mon - 1, d, h, m, 0, 0)
    if (candidate.getMonth() !== mon - 1 || candidate.getDate() !== d) continue
    if (candidate.getTime() >= now.getTime()) return candidate
  }
  return null
}
