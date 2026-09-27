import { describe, expect, it } from 'vitest'
import { formatDuration, formatRelativeTime, formatSchedule } from '../../index'

// 包内格式化器逐行为覆盖：扩展侧 format.test.ts 覆盖的是扩展自有的 i18n 变体
// （autoName/truncate/zh-CN 输出等），本包只承载纯单源实现——此处按包内签名
// （无 locale 参数）直接断言，含扩展侧未走到的秒兜底分支。

describe('formatDuration', () => {
  it('大单位整除优先：优先用最大可整除单位，不用秒拼', () => {
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(7_200_000)).toBe('2h')
    expect(formatDuration(86_400_000)).toBe('1d')
    // 90s 能被秒整除但不能被分整除 → '90s'（不是误导性的 '1m'）
    expect(formatDuration(90_000)).toBe('90s')
  })

  it('ms <= 0 → 0s', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-5_000)).toBe('0s')
  })

  it('秒兜底：不被任何单位整除时 Math.round 到秒', () => {
    expect(formatDuration(1_500)).toBe('2s') // Math.round(1.5) = 2
    expect(formatDuration(2_500)).toBe('3s') // Math.round(2.5) = 3（half-up）
  })
})

describe('formatSchedule', () => {
  it('interval：kind 区分 once in / every', () => {
    expect(formatSchedule({ mode: 'interval', intervalMs: 1_800_000 }, 'recurring')).toBe('every 30m')
    expect(formatSchedule({ mode: 'interval', intervalMs: 300_000 }, 'once')).toBe('once in 5m')
  })

  it('interval：kind 省略时按 every 输出', () => {
    expect(formatSchedule({ mode: 'interval', intervalMs: 60_000 })).toBe('every 1m')
  })

  it('cron：表达式原样返回', () => {
    expect(formatSchedule({ mode: 'cron', cronExpression: '*/10 * * * *' })).toBe('*/10 * * * *')
  })
})

describe('formatRelativeTime', () => {
  it('未来 in X / 过去 X ago，按最大单位取整', () => {
    expect(formatRelativeTime(60_000, 0)).toBe('in 1m')
    expect(formatRelativeTime(300_000, 0)).toBe('in 5m')
    expect(formatRelativeTime(7_200_000, 0)).toBe('in 2h')
    expect(formatRelativeTime(-3_600_000, 0)).toBe('1h ago')
    expect(formatRelativeTime(-86_400_000, 0)).toBe('1d ago')
  })

  it('±5s 内视为 now（阈值边界：4999 → now，5000 → in 5s）', () => {
    expect(formatRelativeTime(4_999, 0)).toBe('now')
    expect(formatRelativeTime(-4_999, 0)).toBe('now')
    expect(formatRelativeTime(5_000, 0)).toBe('in 5s')
    expect(formatRelativeTime(-5_000, 0)).toBe('5s ago')
  })

  it('不足 1 分钟走秒口径（units 循环 s 单位，Math.floor 取整）', () => {
    expect(formatRelativeTime(30_000, 0)).toBe('in 30s')
    expect(formatRelativeTime(-45_000, 0)).toBe('45s ago')
    expect(formatRelativeTime(59_999, 0)).toBe('in 59s') // floor(59.999) = 59，非 round
  })

  it('NaN 时间戳不抛错：降级到秒兜底输出字面 NaNs ago', () => {
    // 退化输入契约（如上游传入未解析时间戳）：Math.abs(NaN) 的比较全为 false，
    // 循环无单位命中 → 兜底 Math.round(NaN/1000) = NaN；NaN > 0 为 false → 走 ago 分支。
    // 该兜底分支对有限数输入结构性不可达（|diff|>=5000 必命中 's' 单位），仅 NaN 可达。
    expect(formatRelativeTime(NaN, 0)).toBe('NaNs ago')
  })
})
