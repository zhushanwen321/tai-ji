import { describe, expect, it } from 'vitest'

import {
  computeNextCronRunAt,
  computeNextCronRuns,
  computeNextRunAt,
  computeNextRuns,
  formatDuration,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  normalizeCronExpression,
  parseDuration,
  parseSchedule,
} from '../parsing.js'

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('5s')).toBe(5000)
    expect(parseDuration('30sec')).toBe(30_000)
    expect(parseDuration('1second')).toBe(1000)
    expect(parseDuration('2seconds')).toBe(2000)
  })

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('30min')).toBe(1_800_000)
    expect(parseDuration('1minute')).toBe(60_000)
    expect(parseDuration('2minutes')).toBe(120_000)
  })

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1hr')).toBe(3_600_000)
    expect(parseDuration('1hour')).toBe(3_600_000)
    expect(parseDuration('3hours')).toBe(10_800_000)
  })

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('7days')).toBe(604_800_000)
  })

  it('returns undefined for invalid input', () => {
    expect(parseDuration('invalid')).toBeUndefined()
    expect(parseDuration('')).toBeUndefined()
    expect(parseDuration('5x')).toBeUndefined()
    expect(parseDuration('abc5m')).toBeUndefined()
  })

  it('accepts zero value', () => {
    expect(parseDuration('0s')).toBe(0)
  })

  it('returns undefined for bare number without unit', () => {
    expect(parseDuration('5')).toBeUndefined()
  })

  it('trims leading/trailing whitespace', () => {
    expect(parseDuration('  5m  ')).toBe(300_000)
  })

  it('accepts uppercase units (case-insensitive)', () => {
    expect(parseDuration('5M')).toBe(300_000)
    expect(parseDuration('5H')).toBe(18_000_000)
  })
})

describe('formatDuration', () => {
  it('formats milliseconds to readable string', () => {
    expect(formatDuration(300_000)).toBe('5m')
    expect(formatDuration(7_200_000)).toBe('2h')
    expect(formatDuration(86_400_000)).toBe('1d')
  })

  it('uses largest unit possible', () => {
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(1000)).toBe('1s')
  })

  it('handles edge cases', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-1000)).toBe('0s')
  })
})

describe('normalizeCronExpression', () => {
  it('prepends seconds field for 5-field cron', () => {
    expect(normalizeCronExpression('*/10 * * * *')).toBe('0 */10 * * * *')
  })

  it('keeps 6-field cron as-is', () => {
    expect(normalizeCronExpression('0 */10 * * * *')).toBe('0 */10 * * * *')
  })

  it('returns undefined for invalid field count', () => {
    expect(normalizeCronExpression('* * *')).toBeUndefined()
    expect(normalizeCronExpression('')).toBeUndefined()
  })
})

describe('parseSchedule', () => {
  it('parses duration to interval mode', async () => {
    const result = await parseSchedule('5m')
    expect(result).toEqual({ mode: 'interval', intervalMs: 300_000 })
  })

  it('returns undefined for invalid duration', async () => {
    const result = await parseSchedule('invalid')
    expect(result).toBeUndefined()
  })

  it('returns undefined for empty input', async () => {
    const result = await parseSchedule('')
    expect(result).toBeUndefined()
  })

  // cron 分支：含空格的输入走 cron 解析（computeNextCronRunAt 验证有效性）
  it('parses valid cron expression to cron mode', async () => {
    const result = await parseSchedule('0 9 * * 1-5')
    expect(result).toBeDefined()
    expect(result!.mode).toBe('cron')
  })

  it('returns undefined for invalid cron with spaces', async () => {
    const result = await parseSchedule('not a valid cron')
    expect(result).toBeUndefined()
  })
})

describe('computeNextRunAt', () => {
  it('interval 模式 → from + intervalMs（精确相等）', async () => {
    const from = Date.now()
    const next = await computeNextRunAt({ mode: 'interval', intervalMs: 60_000 }, from)
    expect(next).toBe(from + 60_000)
  })

  it('interval 模式 from 缺省用当前时间', async () => {
    const before = Date.now()
    const next = await computeNextRunAt({ mode: 'interval', intervalMs: 60_000 })
    expect(next!).toBeGreaterThanOrEqual(before + 60_000)
  })

  it('cron 有效 → 返回未来时间戳（> from）', async () => {
    const from = Date.now()
    const next = await computeNextRunAt({ mode: 'cron', cronExpression: '*/10 * * * *' }, from)
    expect(next).not.toBeUndefined()
    expect(next!).toBeGreaterThan(from)
  })

  it('cron 无效 → undefined', async () => {
    const next = await computeNextRunAt({ mode: 'cron', cronExpression: 'invalid * *' }, Date.now())
    expect(next).toBeUndefined()
  })

  // ── croner startAt 语义回归（2026-09 探针钉住，croner 9.1.0 实测）──
  // 探针证据：nextRun() 无参调用时 startAt 参与推算（croner _next 内「基准早于
  // startAt 则抬到 startAt 再找命中」）。若未来 croner 升级改变该语义（startAt 沦为
  // 纯调度约束、不参与 nextRun 推算），本用例红灯 = 登记风险「from 传了但没用」成真
  it('from 在未来且命中落在 (now, from) 区间 → 返回严格 > from（startAt 参与推算）', () => {
    const now = Date.now()
    const from = now + MS_PER_HOUR
    // 命中构造在 now+30min（今天该墙钟时刻 ∈ (now, from)）：startAt 生效 → 下次命中
    // 在明天同刻（> from）；startAt 失效 → 返回今天的该命中（< from），断言即红
    const hit = new Date(now + 30 * MS_PER_MINUTE)
    const expr = `${hit.getMinutes()} ${hit.getHours()} * * *`
    const next = computeNextCronRunAt(expr, from)
    expect(next).toBeDefined()
    expect(next!).toBeGreaterThan(from)
  })

  // 现状语义锚点：once-cron（无年份）目标已过 → croner 顺延到下一次同 (分时日月)。
  // 「已过输入」的拦截责任在表单层（TUI timeValid / GUI onceTimeValid，持完整含
  // 年份时刻可精确判定）——解析层不拦：无年份表达式上「已过目标顺延」与「用户
  // 故意选明年日期」同分布，本层无法区分
  it('once-cron 目标已过 → 返回下一次同 (分时日月)（不返回已过时刻）', () => {
    const now = new Date()
    const past = new Date(now.getTime() - MS_PER_HOUR) // 1 小时前：目标已过
    const expr = `${past.getMinutes()} ${past.getHours()} ${past.getDate()} ${past.getMonth() + 1} *`
    const next = computeNextCronRunAt(expr, now.getTime())
    expect(next).toBeDefined()
    const nextDate = new Date(next!)
    // 严格未来 + 同 (分时日月)：一般 = 明年同刻；目标在跨年边界（如 12/31 且 now
    // 在 1 月）= 今年年底——两者都是合法的「下一次同刻」，年份不作硬断言
    expect(nextDate.getTime()).toBeGreaterThan(now.getTime())
    expect(nextDate.getMonth()).toBe(past.getMonth())
    expect(nextDate.getDate()).toBe(past.getDate())
    expect(nextDate.getHours()).toBe(past.getHours())
    expect(nextDate.getMinutes()).toBe(past.getMinutes())
  })
})

describe('computeNextRuns', () => {
  it('computes interval runs', async () => {
    const from = Date.now()
    const spec = { mode: 'interval' as const, intervalMs: 60_000 }
    const runs = await computeNextRuns(spec, from, 3)

    expect(runs).toHaveLength(3)
    expect(runs[0]).toBe(from + 60_000)
    expect(runs[1]).toBe(from + 120_000)
    expect(runs[2]).toBe(from + 180_000)
  })

  it('defaults to 5 runs', async () => {
    const spec = { mode: 'interval' as const, intervalMs: 60_000 }
    const runs = await computeNextRuns(spec)
    expect(runs).toHaveLength(5)
  })

  // cron 分支：computeNextRuns 委托 computeNextCronRuns
  it('computes cron runs (delegates to croner)', async () => {
    const from = Date.now()
    const spec = { mode: 'cron' as const, cronExpression: '*/10 * * * *' }
    const runs = await computeNextRuns(spec, from, 3)
    expect(runs).toHaveLength(3)
    // cron runs 严格递增且都晚于 from
    expect(runs[0]).toBeGreaterThan(from)
    expect(runs[0]).toBeLessThan(runs[1]!)
    expect(runs[1]).toBeLessThan(runs[2]!)
  })
})
