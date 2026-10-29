// thinking-levels 纯函数单测（remote-use-mobile-v2 §7.2 思考档行；验收条款 4）。
//
// 表驱动覆盖：四段映射（段值原样 + 非段值就近不点亮）+ chip 短词表七值全覆盖 +
// 值域权威自 shared PI_THINKING_LEVELS（A-03：手写值域漏 'max' 致最高档静默不生效——
// 本测试把「七值全覆盖」从类型对照扩展为运行时断言）。
import { describe, expect, it } from 'vitest'
import { PI_THINKING_LEVELS } from '@taiji/shared'
import {
  isOffSegmentValue,
  isSegmentSelected,
  nearestSegmentOf,
  THINKING_SEGMENTS,
  THINKING_LEVEL_LABEL_KEYS,
} from '../thinking-levels'

describe('思考档七值四段映射（§7.2）', () => {
  it('段值精确映射：低=low、中=medium、高=high、最高=max（就近段 = 段本身）', () => {
    expect(THINKING_SEGMENTS).toEqual(['low', 'medium', 'high', 'max'])
    for (const segment of THINKING_SEGMENTS) {
      expect(nearestSegmentOf(segment)).toBe(segment)
    }
  })

  it('非段值就近归段：off/minimal → 低段、xhigh → 最高段（§7.2 处置行）', () => {
    expect(nearestSegmentOf('off')).toBe('low')
    expect(nearestSegmentOf('minimal')).toBe('low')
    expect(nearestSegmentOf('xhigh')).toBe('max')
  })

  it('段选中态只认精确段值：非段值不点亮（off/minimal/xhigh 全不选中；用户选段即下发段值）', () => {
    // 非段值：就近段存在但选中态恒 false
    expect(isSegmentSelected('off', 'low')).toBe(false)
    expect(isSegmentSelected('minimal', 'low')).toBe(false)
    expect(isSegmentSelected('xhigh', 'max')).toBe(false)
    // 段值：精确命中才选中
    expect(isSegmentSelected('low', 'low')).toBe(true)
    expect(isSegmentSelected('medium', 'low')).toBe(false)
    expect(isSegmentSelected('max', 'max')).toBe(true)
  })

  it('段外值判定：七值外的串为段外（未知值不误判）；undefined 不是段外（尚无权威值）', () => {
    expect(isOffSegmentValue('off')).toBe(false)
    expect(isOffSegmentValue('max')).toBe(false)
    expect(isOffSegmentValue('ultra')).toBe(true)
    expect(isOffSegmentValue(undefined)).toBe(false)
  })

  it('chip 短词表覆盖七值全集（表驱动：PI_THINKING_LEVELS 逐值有键；A-03 防线运行时化）', () => {
    for (const level of PI_THINKING_LEVELS) {
      expect(THINKING_LEVEL_LABEL_KEYS[level]).toBe(level)
    }
    // 键集恰为七值（无多余键）
    expect(Object.keys(THINKING_LEVEL_LABEL_KEYS).sort()).toEqual([...PI_THINKING_LEVELS].sort())
  })

  it('值域权威对账：四段段值 ⊆ PI_THINKING_LEVELS（映射不越权威词表）', () => {
    for (const segment of THINKING_SEGMENTS) {
      expect(PI_THINKING_LEVELS).toContain(segment)
    }
  })
})
