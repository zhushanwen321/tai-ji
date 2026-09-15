/**
 * custom-registry.test.ts —— GUI_CUSTOM_REGISTRY_KEY / EMPTY_CUSTOM_REGISTRY / isCustomRegistered
 * 全覆盖（TC-1/TC-2，AC3「注册表 builtin-only 机制生效」）。
 *
 * IF2 契约面：
 * ① key 类型 symbol + 描述 'Symbol(gui-custom-registry)'（与 renderer gui-registry.ts 同 Symbol 值）
 * ② key 唯一性（与其它任意 Symbol 不相等）
 * ③ EMPTY_CUSTOM_REGISTRY frozen + 零自有属性（运行时不可 mutate）
 * ④ isCustomRegistered 三分支：undefined→false / 含名→true / 不含→false + 空表组合
 *
 * 纯常量 + 纯函数零 mock：node 环境直接 import 调用断言。
 */
import { describe, it, expect } from 'vitest'
import { GUI_CUSTOM_REGISTRY_KEY, EMPTY_CUSTOM_REGISTRY, isCustomRegistered } from './custom-registry'

describe('GUI_CUSTOM_REGISTRY_KEY', () => {
  it('分支①：key 是 symbol，描述与 renderer gui-registry.ts 同值', () => {
    expect(typeof GUI_CUSTOM_REGISTRY_KEY).toBe('symbol')
    expect(String(GUI_CUSTOM_REGISTRY_KEY)).toBe('Symbol(gui-custom-registry)')
  })

  it('分支②：key 唯一性（与其它任意 Symbol 不相等）', () => {
    expect(GUI_CUSTOM_REGISTRY_KEY).not.toBe(Symbol('gui-custom-registry'))
    expect(GUI_CUSTOM_REGISTRY_KEY).not.toBe(Symbol('gui-custom-registry-other'))
    expect(GUI_CUSTOM_REGISTRY_KEY).not.toBe(Symbol('any-other-key'))
  })
})

describe('EMPTY_CUSTOM_REGISTRY', () => {
  it('分支③：空表 frozen + 零自有属性（运行时不可 mutate）', () => {
    expect(Object.isFrozen(EMPTY_CUSTOM_REGISTRY)).toBe(true)
    expect(Object.keys(EMPTY_CUSTOM_REGISTRY)).toHaveLength(0)
  })
})

describe('isCustomRegistered', () => {
  it('分支④a：registry undefined → false（未 provide，空表语义）', () => {
    expect(isCustomRegistered(undefined, 'my-widget')).toBe(false)
  })

  it('分支④b：registry 含 name → true', () => {
    const registry = { 'my-widget': () => null }
    expect(isCustomRegistered(registry, 'my-widget')).toBe(true)
  })

  it('分支④c：registry 不含 name → false', () => {
    const registry = { 'my-widget': () => null }
    expect(isCustomRegistered(registry, 'other-widget')).toBe(false)
  })

  it('分支④d：EMPTY_CUSTOM_REGISTRY 传入任意 name → false', () => {
    expect(isCustomRegistered(EMPTY_CUSTOM_REGISTRY, 'my-widget')).toBe(false)
    expect(isCustomRegistered(EMPTY_CUSTOM_REGISTRY, '')).toBe(false)
  })
})
