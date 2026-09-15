import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { autoName,formatRelativeTime, formatSchedule, generateTaskId, truncate } from '../format.js'
import { formatDuration } from '../parsing.js'

describe('formatSchedule', () => {
  it('formats interval spec', () => {
    expect(formatSchedule({ mode: 'interval', intervalMs: 300_000 })).toBe('every 5m')
    expect(formatSchedule({ mode: 'interval', intervalMs: 3_600_000 })).toBe('every 1h')
  })

  it('formats once kind as "once in X" (not misleading "every X")', () => {
    expect(formatSchedule({ mode: 'interval', intervalMs: 300_000 }, 'once')).toBe('once in 5m')
    expect(formatSchedule({ mode: 'interval', intervalMs: 3_600_000 }, 'once')).toBe('once in 1h')
    // recurring/缺省保持 every
    expect(formatSchedule({ mode: 'interval', intervalMs: 300_000 }, 'recurring')).toBe('every 5m')
  })

  it('formats cron spec', () => {
    expect(formatSchedule({ mode: 'cron', cronExpression: '*/10 * * * *' })).toBe('*/10 * * * *')
  })
})

describe('formatRelativeTime', () => {
  // 固定系统时间避免 clock-boundary flake：formatRelativeTime 内部读 Date.now()，
  // 若与测试捕获的 now 间有毫秒级偏差，正好压在 2h/1d 边界上的断言会偶发失败。
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('formats future time', () => {
    const now = Date.now()
    expect(formatRelativeTime(now + 300_000)).toBe('in 5m')
    expect(formatRelativeTime(now + 7_200_000)).toBe('in 2h')
  })

  it('formats past time', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 300_000)).toBe('5m ago')
    expect(formatRelativeTime(now - 86_400_000)).toBe('1d ago')
  })

  it('formats now for recent timestamps', () => {
    const now = Date.now()
    expect(formatRelativeTime(now)).toBe('now')
    expect(formatRelativeTime(now + 2000)).toBe('now')
    expect(formatRelativeTime(now - 2000)).toBe('now')
  })

  // 5 秒边界：源码 `< 5000` 严格小于。用显式 now 参数精确锁定，避免 fake-timer 漂移。
  it('treats 4999ms as now and 5000ms as not-now (strict <)', () => {
    const base = 1_700_000_000_000
    expect(formatRelativeTime(base + 4999, base)).toBe('now')
    expect(formatRelativeTime(base + 5000, base)).not.toBe('now')
    expect(formatRelativeTime(base + 5000, base)).toBe('in 5s')
  })
})

describe('truncate', () => {
  it('returns original text if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('truncates and adds ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
    expect(truncate('a very long text', 10)).toBe('a very ...')
  })

  it('handles edge cases', () => {
    expect(truncate('', 5)).toBe('')
    expect(truncate('hi', 2)).toBe('hi')
    expect(truncate('hi', 1)).toBe('h')
  })

  // maxLen<=3 分支：不加省略号，直接 slice
  it('does not add ellipsis when maxLen <= 3', () => {
    expect(truncate('hello', 3)).toBe('hel')
    expect(truncate('hello', 0)).toBe('')
  })
})

describe('formatDuration', () => {
  // 秒兜底分支：>60s 但不能整除 m → 不被误判为 "1m"，走 Math.round(ms/1000)
  it('falls back to seconds when not evenly divisible by larger units', () => {
    expect(formatDuration(90_000)).toBe('90s')
    expect(formatDuration(1500)).toBe('2s')
  })

  // TC7 边界值：最大单位整除优先（300000 → '5m' 而非 '300s'）
  it('prefers largest unit when ms is evenly divisible', () => {
    expect(formatDuration(300_000)).toBe('5m')
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(86_400_000)).toBe('1d')
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(1000)).toBe('1s')
  })

  it('handles zero and negative as 0s', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-1)).toBe('0s')
    expect(formatDuration(-86_400_000)).toBe('0s')
  })

  // TC7 修正（design-review R1）：1500000 % 60000 === 0 → '25m'（最大单位优先），
  // 而非 design 初稿误写的 '1500s'。非整除大单位落秒用例改用 1510000。
  it('prefers even minute when ms is multiple of 60000 (1500000 → 25m)', () => {
    expect(formatDuration(1_500_000)).toBe('25m')
  })

  it('falls back to seconds for large non-divisible values (1510000 → 1510s)', () => {
    // 1510000 % 60000 = 10000 ≠ 0 → 不整除 m，落秒分支
    expect(formatDuration(1_510_000)).toBe('1510s')
    // 1500001 % 1000 ≠ 0 → Math.round 兜底
    expect(formatDuration(1_500_001)).toBe('1500s')
  })
})

describe('generateTaskId', () => {
  it('generates 8 character hex string', () => {
    const id = generateTaskId()
    expect(id).toHaveLength(8)
    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTaskId()))
    expect(ids.size).toBe(100)
  })
})

describe('autoName', () => {
  it('returns full prompt if <= 30 chars', () => {
    expect(autoName('check build status')).toBe('check build status')
    expect(autoName('a'.repeat(30))).toBe('a'.repeat(30))
  })

  it('truncates long prompt', () => {
    const long = 'a'.repeat(50)
    expect(autoName(long)).toBe('a'.repeat(27) + '...')
  })

  it('trims whitespace', () => {
    expect(autoName('  hello  ')).toBe('hello')
  })
})
