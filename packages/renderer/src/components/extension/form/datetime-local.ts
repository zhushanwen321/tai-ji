/**
 * datetime-local 字符串契约的 UI 层换算（`yyyy-MM-ddTHH:mm`，本地墙钟无时区后缀）。
 *
 * 与 @zhushanwen/extension-protocol 的 dateToOnceCron/onceCronToDate（协议层折叠单点）分工：
 * 本文件只服务表单控件的值形态（原生 datetime-local 同形字符串），解析语义与
 * ScheduleForm.onceDate 一致——new Date(string) 按本地时区解析（ES 规范）。
 */
import { MS_PER_HOUR, MS_PER_MINUTE } from './cron-preview'

/** 时间字段两位补零宽度（HH/mm） */
export const TIME_FIELD_WIDTH = 2

export function pad2(n: number): string {
  return String(n).padStart(TIME_FIELD_WIDTH, '0')
}

/** Date → `yyyy-MM-ddTHH:mm`（datetime-local 值形态） */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `yyyy-MM-ddTHH:mm` → Date；非法/空串返回 null（与 onceDate 的 NaN 判定同结果） */
export function parseLocalInput(s: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 默认时刻 = 下一整点（进 once 模式无时刻时的初值，ScheduleForm.switchKind 与 DateTimePicker 共用） */
export function nextFullHour(): Date {
  const d = new Date(Date.now() + MS_PER_HOUR)
  d.setMinutes(0, 0, 0)
  return d
}

/** N 分钟后的时刻（once 快捷预设） */
export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * MS_PER_MINUTE)
}

/** 明天 hour 点整（once 快捷预设） */
export function tomorrowAtHour(hour: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(hour, 0, 0, 0)
  return d
}
