import { formatDuration, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from './parsing.js'
import type { ScheduleSpec, TaskKind } from './types.js'

/**
 * 界面语言（L2 extension 侧文案语言，经 `<dataDir>/ui-preferences.json` 通道获取）。
 * 定义在 format.ts：i18n.ts 依赖本模块的格式化器，类型反向定义会成环——i18n.ts 再导出。
 */
export type UiLocale = 'zh-CN' | 'en-US'

/** 相对时间显示的"现在"判定窗口（±5s 内视为 now）。 */
const NOW_THRESHOLD_MS = 5000
/** 省略号 "..." 的字符数（truncate 截断预留宽度）。 */
const ELLIPSIS_LENGTH = 3

/** 相对时间的单位表（en 短后缀 / zh 全称；两格式化器共用的单一口径）。 */
const RELATIVE_UNITS_EN: readonly (readonly [string, number])[] = [
  ['d', MS_PER_DAY],
  ['h', MS_PER_HOUR],
  ['m', MS_PER_MINUTE],
  ['s', MS_PER_SECOND],
]
const RELATIVE_UNITS_ZH: readonly (readonly [string, number])[] = [
  ['天', MS_PER_DAY],
  ['小时', MS_PER_HOUR],
  ['分钟', MS_PER_MINUTE],
  ['秒', MS_PER_SECOND],
]

/**
 * Format ScheduleSpec to readable string. kind 区分 once/recurring（once 显示 'once in X' 而非误导性的 'every X'）。
 *
 * `locale` 必填、无默认值（设计 r4 M1）：漏传即编译报错，替代「人工枚举调用点」清单
 * （r3→r4 已连漏 notify/widget 与 getArgumentCompletions 两处）。内部按 `spec.mode`
 * 显式分支 interval/cron——不靠 `intervalMs`/`cron` 空值推断。
 *
 * 直接调用点三处（设计 §7.1）：`service.ts`（tool/L4 → 'en-US'）、`widget.ts`（TUI/L2 →
 * 当前 locale）、`commands.ts` 的 `getArgumentCompletions`（补全菜单/L2 → 当前 locale）。
 * u-p2b 已删除 u-p2a 遗留的两参 `@deprecated` 桥，locale 至此全线必填（无第二形态）。
 */
export function formatSchedule(
  spec: ScheduleSpec,
  kind: TaskKind | undefined,
  locale: UiLocale,
): string {
  if (spec.mode === 'interval') {
    const duration = formatDurationI18n(spec.intervalMs, locale)
    if (locale === 'zh-CN') {
      return kind === 'once' ? `${duration}后一次` : `每 ${duration}`
    }
    return kind === 'once' ? `once in ${duration}` : `every ${duration}`
  }
  return spec.cronExpression
}

/** 时长格式化（zh 全称单位 / en 走 parsing.formatDuration 既有口径）。 */
function formatDurationI18n(ms: number, locale: UiLocale): string {
  if (locale !== 'zh-CN') return formatDuration(ms)
  if (ms <= 0) return '0 秒'
  for (const [suffix, divisor] of RELATIVE_UNITS_ZH) {
    if (ms >= divisor && ms % divisor === 0) return `${ms / divisor} ${suffix}`
  }
  return `${Math.round(ms / MS_PER_SECOND)} 秒`
}

/**
 * 格式化时间戳为相对时间字符串。
 * en 未来: "in 5m" / 过去: "5m ago" / 当前(±5s): "now"
 * zh 未来: "5 分钟后" / 过去: "5 分钟前" / 当前: "现在"
 *
 * `locale` 必填、无默认值（设计 r4 M1：漏传即编译报错）。`now` 可选参数：基准时间戳，
 * 默认 Date.now()。测试可传固定值快进/锁定。
 */
export function formatRelativeTime(timestamp: number, locale: UiLocale, now?: number): string {
  const currentTime = now ?? Date.now()
  const diff = timestamp - currentTime
  const absDiff = Math.abs(diff)

  // 5秒内视为"现在"
  if (absDiff < NOW_THRESHOLD_MS) return locale === 'zh-CN' ? '现在' : 'now'

  if (locale === 'zh-CN') {
    const formatted = formatMagnitudeZh(absDiff)
    return diff > 0 ? `${formatted}后` : `${formatted}前`
  }

  const formatted = formatMagnitudeEn(absDiff)
  return diff > 0 ? `in ${formatted}` : `${formatted} ago`
}

function formatMagnitudeEn(absDiff: number): string {
  for (const [suffix, divisor] of RELATIVE_UNITS_EN) {
    if (absDiff >= divisor) return `${Math.floor(absDiff / divisor)}${suffix}`
  }
  return `${Math.round(absDiff / MS_PER_SECOND)}s`
}

function formatMagnitudeZh(absDiff: number): string {
  for (const [suffix, divisor] of RELATIVE_UNITS_ZH) {
    if (absDiff >= divisor) return `${Math.floor(absDiff / divisor)} ${suffix}`
  }
  return `${Math.round(absDiff / MS_PER_SECOND)} 秒`
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
