/**
 * 时长格式化单点（renderer 侧）。
 *
 * 原 TrayNativePanel / WorkflowTab / BackgroundTaskDetailPanel 三处各持换算实现与
 * MS_PER_SECOND 常量，收敛于此（同门 token-format.ts 先例；ui 包的 formatDurationHms
 * 口径不同——补零 + h/m/s 后缀——不跨包强搬）。
 *
 * 视觉口径差异以参数保留（本模块只做换算单点，不统一口径）：
 * - clock：drawer 小时段补零（01:02:03），tray 不补（1:02:03）；
 * - compact：tray 含小时档（1h2m），WorkflowTab 无小时档（≥1h 仍累计分钟，如 62m0s）。
 */
export const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const TIME_PAD_WIDTH = 2

/** ms → mm:ss（≥1h 为 h:mm:ss / hh:mm:ss；padHours 决定小时段补零宽度） */
export function formatClockDuration(ms: number, opts: { padHours: boolean }): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR)
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  const pad = (n: number): string => String(n).padStart(TIME_PAD_WIDTH, '0')
  return hours > 0
    ? `${opts.padHours ? pad(hours) : hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
}

/** 秒 → 可读耗时（hours 档开启为 hNm / 否则分钟累计 NmNs；均含 Ns 兜底） */
export function formatCompactDuration(seconds: number, opts: { hours: boolean }): string {
  if (opts.hours && seconds >= SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_HOUR)}h${Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)}m`
  }
  if (seconds >= SECONDS_PER_MINUTE) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${seconds % SECONDS_PER_MINUTE}s`
  }
  return `${seconds}s`
}
