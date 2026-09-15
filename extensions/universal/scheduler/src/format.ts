import { formatDuration, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from './parsing.js'
import type { ScheduleSpec, TaskKind } from './types.js'

/** 相对时间显示的"现在"判定窗口（±5s 内视为 now）。 */
const NOW_THRESHOLD_MS = 5000
/** 省略号 "..." 的字符数（truncate 截断预留宽度）。 */
const ELLIPSIS_LENGTH = 3

/** Format ScheduleSpec to readable string. kind 区分 once/recurring（once 显示 'once in X' 而非误导性的 'every X'）。 */
export function formatSchedule(spec: ScheduleSpec, kind?: TaskKind): string {
  if (spec.mode === 'interval') {
    return kind === 'once'
      ? `once in ${formatDuration(spec.intervalMs)}`
      : `every ${formatDuration(spec.intervalMs)}`
  }
  return spec.cronExpression
}

/**
 * 格式化时间戳为相对时间字符串。
 * 未来: "in 5m"
 * 过去: "5m ago"
 * 当前(+-5s): "now"
 *
 * now 可选参数：基准时间戳，默认 Date.now()。测试可传固定值快进/锁定，
 * 生产调用方无需传（参数可选，行为不变）。
 */
export function formatRelativeTime(timestamp: number, now?: number): string {
  const currentTime = now ?? Date.now()
  const diff = timestamp - currentTime

  // 5秒内视为"现在"
  if (Math.abs(diff) < NOW_THRESHOLD_MS) return 'now'

  const absDiff = Math.abs(diff)
  const units: [string, number][] = [
    ['d', MS_PER_DAY],
    ['h', MS_PER_HOUR],
    ['m', MS_PER_MINUTE],
    ['s', MS_PER_SECOND],
  ]

  let formatted = ''
  for (const [suffix, divisor] of units) {
    if (absDiff >= divisor) {
      const value = Math.floor(absDiff / divisor)
      formatted = `${value}${suffix}`
      break
    }
  }

  if (!formatted) {
    formatted = `${Math.round(absDiff / MS_PER_SECOND)}s`
  }

  return diff > 0 ? `in ${formatted}` : `${formatted} ago`
}

/**
 * 截断文本到指定长度，超出部分用 "..." 替代。
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= ELLIPSIS_LENGTH) return text.slice(0, maxLen)
  return text.slice(0, maxLen - ELLIPSIS_LENGTH) + '...'
}

/** 生成任务 ID 的随机字节数（8 位 hex = 4 字节）。 */
const TASK_ID_RANDOM_BYTES = 4
const HEX_RADIX = 16
/** 每字节展开的 hex 字符数（padStart 宽度）。 */
const HEX_CHARS_PER_BYTE = 2

/**
 * 生成任务 ID：8 位 hex。
 */
export function generateTaskId(): string {
  const bytes = new Uint8Array(TASK_ID_RANDOM_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(HEX_RADIX).padStart(HEX_CHARS_PER_BYTE, '0')).join('')
}

/** autoName 任务名最大长度。 */
const AUTO_NAME_MAX_LENGTH = 30

/**
 * 从 prompt 自动生成任务名称：取前 30 字。
 */
export function autoName(prompt: string): string {
  return truncate(prompt.trim(), AUTO_NAME_MAX_LENGTH)
}
