// scheduler 时间格式化器（下沉自 extensions/universal/scheduler/src/format.ts，U2 折叠器下沉）：
// formatSchedule / formatRelativeTime 与 composer widget、taiji plugin 管理面共用同一份输出——
// 插件与扩展各持一份必然漂移（设计 D5 / §3.1.1）。只带纯函数：MS_PER_* 与 formatDuration
// 随迁自带（原实现来自扩展 parsing.ts），cron 解析属 parsing 域留在扩展、不进本包（P7 依赖面）。

import type { ScheduleSpec, TaskKind } from './types.js'

// ── 时间单位毫秒数（随折叠器下沉单源：formatRelativeTime / formatDuration 共用）──

export const MS_PER_DAY = 86_400_000
export const MS_PER_HOUR = 3_600_000
export const MS_PER_MINUTE = 60_000
export const MS_PER_SECOND = 1000

/** 相对时间显示的"现在"判定窗口（±5s 内视为 now）。 */
const NOW_THRESHOLD_MS = 5000

/** 格式化毫秒数为可读 duration 字符串。优先使用最大单位：300000 → "5m"，不是 "300s"。 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'

  const units: [string, number][] = [
    ['d', MS_PER_DAY],
    ['h', MS_PER_HOUR],
    ['m', MS_PER_MINUTE],
    ['s', MS_PER_SECOND],
  ]

  for (const [suffix, divisor] of units) {
    if (ms >= divisor && ms % divisor === 0) {
      return `${ms / divisor}${suffix}`
    }
  }

  // 兜底：用秒表示
  return `${Math.round(ms / MS_PER_SECOND)}s`
}

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
