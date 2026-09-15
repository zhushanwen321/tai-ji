// croner 是 dependencies + 静态 import（ext-simplify-08 D2/M18）：npm 语义保证全安装
// 形态在盘（独立安装 / builtin inline 同构），不存在「解析器缺失」分支——undefined
// 的唯一语义 = 表达式无效。
import { Cron } from 'croner'

import type { ScheduleSpec } from './types.js'

// ── Duration 解析 ──

// 时间单位毫秒数（包内共享：format.ts / runtime.ts 复用）
export const MS_PER_DAY = 86_400_000
export const MS_PER_HOUR = 3_600_000
export const MS_PER_MINUTE = 60_000
export const MS_PER_SECOND = 1000

const DURATION_RE = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: MS_PER_SECOND, sec: MS_PER_SECOND, second: MS_PER_SECOND, seconds: MS_PER_SECOND,
  m: MS_PER_MINUTE, min: MS_PER_MINUTE, minute: MS_PER_MINUTE, minutes: MS_PER_MINUTE,
  h: MS_PER_HOUR, hr: MS_PER_HOUR, hour: MS_PER_HOUR, hours: MS_PER_HOUR,
  d: MS_PER_DAY, day: MS_PER_DAY, days: MS_PER_DAY,
}

/**
 * 解析 duration 字符串为毫秒数。
 * 支持：5s, 5m, 2h, 1d, 30seconds, 2hours 等
 * 返回 undefined 表示无法解析。
 */
export function parseDuration(text: string): number | undefined {
  const match = DURATION_RE.exec(text.trim())
  if (!match) return undefined
  const value = parseInt(match[1]!, 10)
  const unit = match[2]!.toLowerCase()
  const multiplier = DURATION_MULTIPLIERS[unit]
  if (multiplier === undefined) return undefined
  return value * multiplier
}

/**
 * 格式化毫秒数为可读 duration 字符串。
 * 优先使用最大单位：300000 → "5m"，不是 "300s"
 */
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

// ── Cron 解析 ──

/** cron 标准字段数（分 时 日 月 周）。 */
const CRON_FIELD_COUNT = 5
/** 带秒字段的标准 cron 字段数（秒 分 时 日 月 周）。 */
const CRON_FIELD_COUNT_WITH_SECONDS = 6
/** computeNextCronRuns / computeNextRuns 默认返回的未来执行时间数。 */
const DEFAULT_NEXT_RUNS_COUNT = 5

/**
 * 规范化 cron 表达式：5 字段自动补秒字段。
 * 返回 undefined 表示无效。
 */
export function normalizeCronExpression(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined

  const parts = trimmed.split(/\s+/)

  // 6 字段原样返回
  if (parts.length === CRON_FIELD_COUNT_WITH_SECONDS) {
    return trimmed
  }

  // 5 字段补秒字段
  if (parts.length === CRON_FIELD_COUNT) {
    return `0 ${trimmed}`
  }

  return undefined
}

/**
 * 计算 cron 表达式的下次执行时间。
 * 返回 undefined 的唯一语义 = 表达式无效（croner 静态 import 恒在盘，见文件头注释）。
 */
export function computeNextCronRunAt(
  expression: string,
  from?: number,
): number | undefined {
  try {
    const normalized = normalizeCronExpression(expression)
    if (!normalized) return undefined

    const job = new Cron(normalized, { startAt: from ? new Date(from) : undefined })
    const next = job.nextRun()
    return next ? next.getTime() : undefined
  } catch {
    return undefined
  }
}

/**
 * 计算 cron 表达式的多个未来执行时间。
 * count 默认 5；表达式无效 → 空数组。
 */
export function computeNextCronRuns(
  expression: string,
  from?: number,
  count = DEFAULT_NEXT_RUNS_COUNT,
): number[] {
  try {
    const normalized = normalizeCronExpression(expression)
    if (!normalized) return []

    const job = new Cron(normalized, { startAt: from ? new Date(from) : undefined })
    const runs: number[] = []
    let current = from ? new Date(from) : new Date()

    for (let i = 0; i < count; i++) {
      const next = job.nextRun(current)
      if (!next) break
      runs.push(next.getTime())
      current = next
    }

    return runs
  } catch {
    return []
  }
}

// ── 统一解析 ──

/**
 * 统一解析 schedule 输入为 ScheduleSpec（L7：不包装单字段结果对象）。
 * 不含空格 → duration 解析 → interval mode
 * 含空格 → cron 解析 → cron mode
 * 都失败 → undefined（语义 = 表达式无效，service 层归一为 INVALID_SCHEDULE 单一错误通道）
 */
export function parseSchedule(input: string): ScheduleSpec | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined

  // 不含空格 → 尝试 duration
  if (!trimmed.includes(' ')) {
    const ms = parseDuration(trimmed)
    if (ms !== undefined) {
      return { mode: 'interval', intervalMs: ms }
    }
    return undefined
  }

  // 含空格 → 尝试 cron
  const normalized = normalizeCronExpression(trimmed)
  if (normalized) {
    // 验证 cron 表达式有效
    const nextRun = computeNextCronRunAt(trimmed)
    if (nextRun !== undefined) {
      return { mode: 'cron', cronExpression: normalized }
    }
  }

  return undefined
}

/**
 * 统一计算 schedule 的下次执行时间（IF-5：runtime 内唯一 nextRunAt 计算入口）。
 * interval → from + intervalMs（from 缺省 Date.now()）；
 * cron → 下次命中时间戳（> from）；cron 无效 → undefined。
 * undefined 语义按调用方决策：addTask → 创建即抛错；
 * toggleTask/dispatchTask 重算 → ERR-2 fallback（停用 + failed）。
 */
export function computeNextRunAt(
  spec: ScheduleSpec,
  from?: number,
): number | undefined {
  if (spec.mode === 'interval') {
    const start = from ?? Date.now()
    return start + spec.intervalMs
  }

  return computeNextCronRunAt(spec.cronExpression, from)
}

// ── Next Runs 计算 ──

/**
 * 统一计算多个未来执行时间。
 * interval 模式直接乘法，cron 模式调用 croner。
 */
export function computeNextRuns(
  spec: ScheduleSpec,
  from?: number,
  count = DEFAULT_NEXT_RUNS_COUNT,
): number[] {
  if (spec.mode === 'interval') {
    const start = from ?? Date.now()
    return Array.from({ length: count }, (_, i) => start + spec.intervalMs * (i + 1))
  }

  return computeNextCronRuns(spec.cronExpression, from, count)
}
