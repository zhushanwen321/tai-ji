import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { computeNextRunAt, computeNextRuns, formatDuration, parseDuration, parseSchedule } from '../parsing.js'

/**
 * property-based 测试（fast-check）：纯函数不变量回归保护。
 *
 * 生成器范围契约（与 m3-design C1 一致）：
 * - intervalMs ∈ [1, 86_400_000]（1ms..1d，贴近 parseDuration 现实域）
 * - from ∈ [0, 2^48]（from + intervalMs*count ≈ 2.8e14 << 2^53，无 Number 溢出）
 * - count ∈ [1, 10]
 *
 * 不变量边界（C3）：
 * - formatDuration↔parseDuration round-trip 恒等仅对「精确域」成立
 *   （ms % 1000 === 0 且 ms >= 1000，s 分支整除保证）；
 * - 全域只断言输出可解析且 >= 0（Math.round 兜底会破坏非整除域恒等，禁止断言恒等）。
 */

describe('property: computeNextRunAt interval 精确不变量', () => {
  it('恒等于 from + intervalMs 且 > from', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 86_400_000 }),
        fc.integer({ min: 0, max: 2 ** 48 }),
        async (intervalMs, from) => {
          const r = await computeNextRunAt({ mode: 'interval', intervalMs }, from)
          expect(r).toBe(from + intervalMs)
          expect(r!).toBeGreaterThan(from)
        },
      ),
    )
  })
})

describe('property: computeNextRuns interval 等间隔递增', () => {
  it('长度 === count、严格递增、等间隔、runs[0] 与 computeNextRunAt 一致', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 86_400_000 }),
        fc.integer({ min: 0, max: 2 ** 48 }),
        fc.integer({ min: 1, max: 10 }),
        async (intervalMs, from, count) => {
          const runs = await computeNextRuns({ mode: 'interval', intervalMs }, from, count)
          expect(runs).toHaveLength(count)
          for (let i = 0; i < count; i++) {
            expect(runs[i]).toBe(from + intervalMs * (i + 1))
            if (i > 0) expect(runs[i]!).toBeGreaterThan(runs[i - 1]!)
          }
          // 两入口同源不变量：runs[0] 必须与单次计算入口一致
          const single = await computeNextRunAt({ mode: 'interval', intervalMs }, from)
          expect(runs[0]).toBe(single)
        },
      ),
    )
  })
})

// ── TC4 grammar 生成：duration 单位表（与 parsing.ts DURATION_MULTIPLIERS 语义一致） ──

const UNITS = ['s', 'sec', 'second', 'seconds', 'm', 'min', 'minute', 'minutes', 'h', 'hr', 'hour', 'hours', 'd', 'day', 'days']
const UNIT_VARIANTS = [...UNITS, ...UNITS.map(u => u.toUpperCase()), 'Sec', 'MIN', 'Hours', 'Day']

const MULTIPLIERS: Record<string, number> = {
  s: 1000, sec: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
}

describe('property: parseDuration/parseSchedule round-trip', () => {
  it('合法 duration（value×unit grammar 生成）恒精确解析且 parseSchedule 恒 interval mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          value: fc.integer({ min: 0, max: 1_000_000 }),
          unit: fc.constantFrom(...UNIT_VARIANTS),
        }),
        async ({ value, unit }) => {
          const text = `${value}${unit}`
          const expectedMs = value * MULTIPLIERS[unit.toLowerCase()]!
          expect(parseDuration(text)).toBe(expectedMs)

          // 无空格字符串 → 恒走 duration 分支 → interval mode + 同一 intervalMs
          const parsed = await parseSchedule(text)
          expect(parsed).toBeDefined()
          expect(parsed!).toEqual({ mode: 'interval', intervalMs: expectedMs })
        },
      ),
    )
  })

  it('非法输入（裸数字/未知单位/空串/负值/小数）恒 undefined', async () => {
    const invalid = ['123', '5x', '', '-5m', 'm', '1.5m', '5m 5s']
    for (const input of invalid) {
      expect(parseDuration(input)).toBeUndefined()
      expect(await parseSchedule(input)).toBeUndefined()
    }
  })
})

describe('property: formatDuration↔parseDuration round-trip', () => {
  // 精确域：ms 为 1000 正整数倍且 >= 1000 → 恒等（整除路径或 s 分支兜底均精确）。
  // 用 k*1000 生成（而非 filter）避免 fc 对 1/1000 通过率的 filter 重试浪费。
  it('精确域 round-trip 恒等', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }).map(k => k * 1000),
        ms => {
          expect(parseDuration(formatDuration(ms))).toBe(ms)
        },
      ),
    )
  })

  // 全域：Math.round 兜底会破坏非整除域恒等（如 1500 → '2s'），
  // 只断言输出可解析且解析值 >= 0（C3 不变量边界）。
  it('全域输出恒可解析且 >= 0（不断言恒等）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        ms => {
          const out = formatDuration(ms)
          const parsed = parseDuration(out)
          expect(parsed).toBeDefined()
          expect(parsed!).toBeGreaterThanOrEqual(0)
        },
      ),
    )
  })
})
