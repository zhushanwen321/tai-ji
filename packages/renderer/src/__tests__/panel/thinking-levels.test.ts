/**
 * thinking-levels 纯函数单测（U6 改锚：可用档判定切 supportedLevels，map 只承担
 * key↔value 映射职责）。
 *
 * thinkingLevelMap 语义：
 * - key = UI 可选档位（ThinkingLevel 枚举值，含 max），用于展示与 value 映射
 * - value = 发给 runtime/pi 的实际 level（string=可用，null=不可用）
 * - 发给 pi 的是 value（如 max 档发 xhigh），不是 key
 *
 * fixture 来自真实预设（useProviderEdit.ts THINKING_PRESETS）对应的 supportedLevels：
 * - all-levels: map undefined → supported 默认五档
 * - on-off: { off:'off', high:'high' } → ['off','high']
 * - high-max: { off:'off', high:'high', max:'xhigh' } → ['off','high','max']
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/thinking-levels.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  resolveThinkingValue,
  resolveThinkingKey,
  highestAvailableLevel,
  isSameThinkingScheme,
  getDisplayLabel,
  THINKING_LEVELS,
} from '@/components/panel/thinking-levels'

// 真实预设（从 useProviderEdit.ts THINKING_PRESETS 同步）：map + 对应 supportedLevels
const ON_OFF_MAP = { off: 'off', high: 'high' }
const HIGH_MAX_MAP = { off: 'off', high: 'high', max: 'xhigh' }
const ON_OFF_SUPPORTED = ['off', 'high']
const HIGH_MAX_SUPPORTED = ['off', 'high', 'max']
// 默认五档（supportedLevels 未下发 / all-levels 预设的 pi 同源计算产物）
const DEFAULT_FIVE = ['off', 'minimal', 'low', 'medium', 'high']

function sortedLevels(levels: readonly string[]): string[] {
  return [...levels].sort()
}


describe('resolveThinkingValue（UI 档位 key → 发 runtime 的 value）', () => {
  it('high-max: max 档发 xhigh（展示是 max，传递 value 是 xhigh）', () => {
    expect(resolveThinkingValue('max', HIGH_MAX_MAP)).toBe('xhigh')
  })

  it('high-max: high 档发 high', () => {
    expect(resolveThinkingValue('high', HIGH_MAX_MAP)).toBe('high')
  })

  it('on-off: off 档发 off', () => {
    expect(resolveThinkingValue('off', ON_OFF_MAP)).toBe('off')
  })

  it('all-levels（map 空）→ 发 key 自身', () => {
    expect(resolveThinkingValue('medium', undefined)).toBe('medium')
  })
})

describe('resolveThinkingKey（runtime value → UI 档位 key）', () => {
  it('high-max: value xhigh → key max（反查）', () => {
    expect(resolveThinkingKey('xhigh', HIGH_MAX_MAP)).toBe('max')
  })

  it('high-max: value high → key high', () => {
    expect(resolveThinkingKey('high', HIGH_MAX_MAP)).toBe('high')
  })

  it('on-off: value off → key off', () => {
    expect(resolveThinkingKey('off', ON_OFF_MAP)).toBe('off')
  })

  it('all-levels（map 空）→ value 直接是 key', () => {
    expect(resolveThinkingKey('medium', undefined)).toBe('medium')
  })

  it('无法映射时 fallback 缺省 high（U6：动态最高档推导已删）；显式传 fallback 按传入档位集', () => {
    expect(resolveThinkingKey('unknown', HIGH_MAX_MAP)).toBe('high')
    // 调用方（Popover/sync）传 supportedLevels 推导的精确 fallback
    expect(resolveThinkingKey('unknown', HIGH_MAX_MAP, 'max')).toBe('max')
  })
})

describe('getDisplayLabel', () => {
  it('on-off 模式 high → 「开」', () => {
    expect(getDisplayLabel('high', ON_OFF_MAP)).toBe('开')
  })

  it('high-max 模式 high → 「高」（通用 label）', () => {
    expect(getDisplayLabel('high', HIGH_MAX_MAP)).toBe('高')
  })

  it('high-max 模式 max → 「最高」', () => {
    expect(getDisplayLabel('max', HIGH_MAX_MAP)).toBe('最高')
  })
})

describe('highestAvailableLevel（U6：入参是 supportedLevels 档位集）', () => {
  it('high-max 档位集 → max（强度最高的可用档）', () => {
    expect(highestAvailableLevel(HIGH_MAX_SUPPORTED)).toBe('max')
  })

  it('on-off 档位集 → high（强度最高的可用档）', () => {
    expect(highestAvailableLevel(ON_OFF_SUPPORTED)).toBe('high')
  })

  it('undefined → high（默认五档最高档）', () => {
    expect(highestAvailableLevel(undefined)).toBe('high')
  })

  it('返回值始终是合法 ThinkingLevel', () => {
    const validLevels = THINKING_LEVELS.map((o) => o.level)
    expect(validLevels).toContain(highestAvailableLevel(HIGH_MAX_SUPPORTED))
    expect(validLevels).toContain(highestAvailableLevel(ON_OFF_SUPPORTED))
    expect(validLevels).toContain(highestAvailableLevel(undefined))
  })
})

describe('isSameThinkingScheme（U6：入参是各自模型的 supportedLevels 档位集）', () => {
  it('on-off vs on-off → 同体系', () => {
    expect(isSameThinkingScheme(ON_OFF_SUPPORTED, ON_OFF_SUPPORTED)).toBe(true)
  })

  it('high-max vs high-max → 同体系', () => {
    expect(isSameThinkingScheme(HIGH_MAX_SUPPORTED, HIGH_MAX_SUPPORTED)).toBe(true)
  })

  it('on-off vs high-max → 跨体系（档位集不同：{off,high} ≠ {off,high,max}）', () => {
    expect(isSameThinkingScheme(ON_OFF_SUPPORTED, HIGH_MAX_SUPPORTED)).toBe(false)
  })

  it('high-max vs on-off → 跨体系（不对称也成立）', () => {
    expect(isSameThinkingScheme(HIGH_MAX_SUPPORTED, ON_OFF_SUPPORTED)).toBe(false)
  })

  it('未下发(undefined) vs 未下发 → 同体系（两者均归一默认五档）', () => {
    expect(isSameThinkingScheme(undefined, undefined)).toBe(true)
  })

  it('未下发(undefined) vs on-off → 跨体系（归一五档 ≠ {off,high}）', () => {
    expect(isSameThinkingScheme(undefined, ON_OFF_SUPPORTED)).toBe(false)
  })

  it('未下发(undefined) vs high-max → 跨体系', () => {
    expect(isSameThinkingScheme(undefined, HIGH_MAX_SUPPORTED)).toBe(false)
  })

  it('自定义档位集 {off,high,xhigh} vs on-off → 跨体系', () => {
    const custom = ['off', 'high', 'xhigh']
    expect(isSameThinkingScheme(custom, ON_OFF_SUPPORTED)).toBe(false)
  })

  it('同档位集乱序 → 同体系（归一后集合比较）', () => {
    expect(isSameThinkingScheme(['high', 'off', 'max'], HIGH_MAX_SUPPORTED)).toBe(true)
  })
})
