/**
 * thinking-levels 纯逻辑单元测试（U6 改锚：档位可用集切 supportedLevels）。
 *
 * 被测对象：domain/composer/thinking-levels.ts —— 思考档位判定纯函数。
 * [HISTORICAL] 语义基准 pi-ai 0.84.1 getSupportedThinkingLevels 的本地影子实现
 * （从 thinkingLevelMap+reasoning 推算可用档）已随 U6 删除——可用档唯一权威 = runtime
 * 注册表 pi 同源计算下发的 supportedLevels（normalizeSupportedLevels 只做归一）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/__tests__/thinking-levels.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  THINKING_LEVELS,
  normalizeSupportedLevels,
  resolveThinkingKey,
  resolveThinkingValue,
  highestAvailableLevel,
  isOnOffMap,
  isSameThinkingScheme,
} from '../thinking-levels'

describe('normalizeSupportedLevels — 下发档位集归一', () => {
  it('U1: undefined/null/空数组 → 默认五档 off/minimal/low/medium/high（过渡态对齐旧行为）', () => {
    const expected = ['off', 'minimal', 'low', 'medium', 'high']
    expect(normalizeSupportedLevels(undefined)).toEqual(expected)
    expect(normalizeSupportedLevels(null)).toEqual(expected)
    expect(normalizeSupportedLevels([])).toEqual(expected)
    // 不含 xhigh/max：需 pi 同源计算产物显式携带
    expect(normalizeSupportedLevels(undefined)).not.toContain('xhigh')
    expect(normalizeSupportedLevels(undefined)).not.toContain('max')
  })

  it('U2: 非法值过滤 + 按 pi 全序排列（乱序/脏数据下发不炸）', () => {
    expect(normalizeSupportedLevels(['max', 'off', 'bogus', 'high'])).toEqual(['off', 'high', 'max'])
    // 全非法值 → 防御归一只剩 off（对齐 pi clampThinkingLevel 兜底）
    expect(normalizeSupportedLevels(['nope', 42 as unknown as string])).toEqual(['off'])
  })

  it('U3: on/off 二档集与 reasoning 关闭集（["off"]）均原样归一', () => {
    expect(normalizeSupportedLevels(['off', 'high'])).toEqual(['off', 'high'])
    expect(normalizeSupportedLevels(['off'])).toEqual(['off'])
  })

  it('U4: isOnOffMap 显式二档判定不回归（on/off 展示机制保留）', () => {
    expect(isOnOffMap({ off: 'x', high: 'y', minimal: null, low: null, medium: null })).toBe(true)
    // map 缺失不是 on/off（走默认五档路径）
    expect(isOnOffMap(undefined)).toBe(false)
    expect(isOnOffMap({})).toBe(false)
  })

  it('U5: THINKING_LEVELS 枚举含 minimal，强度序介于 off 与 low 之间', () => {
    const levels = THINKING_LEVELS.map((o) => o.level)
    expect(levels).toContain('minimal')
    const idx = (l: (typeof levels)[number]) => levels.indexOf(l)
    expect(idx('off')).toBeLessThan(idx('minimal'))
    expect(idx('minimal')).toBeLessThan(idx('low'))
  })

  it('U6: resolveThinkingKey fallback 显式传入（新签名第三参）按传入档位集取最高', () => {
    // value 能正常反查时不走 fallback
    expect(resolveThinkingKey('l', { low: 'l' })).toBe('low')
    // fallback 缺省 = 默认五档最高档 'high'（不再动态推算）
    expect(resolveThinkingKey('unknown-value', { low: 'l' })).toBe('high')
    expect(resolveThinkingKey('unknown-value')).toBe('high')
    // 调用方传精确 fallback（如 supportedLevels 含 max 时）按传入值
    expect(resolveThinkingKey('unknown-value', { max: 'x' }, highestAvailableLevel(['off', 'max']))).toBe('max')
  })
})

describe('派生函数在 supportedLevels 语义下的联动', () => {
  it('highestAvailableLevel: 缺失 → high；档位集含 max → max；["off"] → off', () => {
    expect(highestAvailableLevel(undefined)).toBe('high')
    expect(highestAvailableLevel([])).toBe('high')
    expect(highestAvailableLevel(['off', 'high', 'max'])).toBe('max')
    expect(highestAvailableLevel(['off'])).toBe('off')
    // 乱序输入按全序取最高
    expect(highestAvailableLevel(['high', 'xhigh', 'off'])).toBe('xhigh')
  })

  it('isSameThinkingScheme: 档位集归一后比较（缺失 vs 六档跨体系；两缺失同体系）', () => {
    // undefined 归一五档；含 max 的六档 → 不同体系
    expect(isSameThinkingScheme(undefined, ['off', 'minimal', 'low', 'medium', 'high', 'max'])).toBe(false)
    // 两个缺失 → 同体系（均归一五档）
    expect(isSameThinkingScheme(undefined, undefined)).toBe(true)
    // on/off 与默认五档跨体系
    expect(isSameThinkingScheme(['off', 'high'], undefined)).toBe(false)
    // 同集（乱序等价）
    expect(isSameThinkingScheme(['high', 'off'], ['off', 'high'])).toBe(true)
  })

  it('resolveThinkingValue: 无映射回退 key 自身（发送链路不受影响）', () => {
    expect(resolveThinkingValue('high', undefined)).toBe('high')
    expect(resolveThinkingValue('max', { max: 'max' })).toBe('max')
  })
})
