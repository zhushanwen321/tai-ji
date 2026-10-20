/**
 * formatQuotaPct 单测（额度百分比展示口径 = 2 位小数，双消费面同一 SSOT）。
 *
 * 回归锚（[HISTORICAL]）：指标聚合页曾直接插值 `{{ win.pct }}%`，OpenDesign 派生值
 * `2.9499999999999997` 撑爆 32px 数字列并溢出行宽（用户截图 2026-10-20）；
 * 设置页 QuotaWindowList 同期用 `Math.round(win.pct)`（0 位小数）——同一窗口两处不同数字。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/quota-pct-format.test.ts
 */
import { describe, it, expect } from 'vitest'
import { formatQuotaPct, QUOTA_PCT_DECIMALS } from '../quota-types'

describe('formatQuotaPct · 两位小数口径', () => {
  it('浮点尾数截断到 2 位（截图事故原值）', () => {
    expect(formatQuotaPct(2.9499999999999997)).toBe('2.95')
  })

  it('整数不补尾零（用户可读性优先于等宽对齐）', () => {
    expect(formatQuotaPct(68)).toBe('68')
    expect(formatQuotaPct(0)).toBe('0')
    expect(formatQuotaPct(100)).toBe('100')
  })

  it('两位小数原样保留，一位补零后丢尾零', () => {
    expect(formatQuotaPct(12.34)).toBe('12.34')
    expect(formatQuotaPct(0.148)).toBe('0.15')
    expect(formatQuotaPct(0.1)).toBe('0.1')
  })

  it('边界与负数（pct 理论 0-100，out-of-range 不裁剪只格式化）', () => {
    expect(formatQuotaPct(99.995)).toBe('100')
    expect(formatQuotaPct(-0.001)).toBe('0')
  })

  it('非有限值降级 --（不渲染 NaN% / Infinity%）', () => {
    expect(formatQuotaPct(Number.NaN)).toBe('--')
    expect(formatQuotaPct(Number.POSITIVE_INFINITY)).toBe('--')
    expect(formatQuotaPct(Number.NEGATIVE_INFINITY)).toBe('--')
  })

  it('小数位常量是口径唯一定义点（改这里即改双消费面）', () => {
    expect(QUOTA_PCT_DECIMALS).toBe(2)
  })
})
