/**
 * plugin-view-scope 单测（provider-plugin-access U2 分区键泛化）：scope 串形态单一事实源的
 * 两函数契约——pluginViewScopeKey 的两种分区键形态、pluginViewScopeFromWire 的二选一校验
 * 全臂（都给 / 都缺 / 非法值 / 全局域缺 pluginId → null）。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/plugin-view-scope.test.ts
 */
import { describe, it, expect } from 'vitest'
import { pluginViewScopeKey, pluginViewScopeFromWire } from '../plugin-view-scope'

describe('pluginViewScopeKey', () => {
  it('会话域 → session:<sessionId>', () => {
    expect(pluginViewScopeKey({ kind: 'session', sessionId: 's1' })).toBe('session:s1')
  })

  it('全局域 → global:<mountId>:<pluginId>（含插件维度，S25 互不可见）', () => {
    expect(pluginViewScopeKey({ kind: 'global', mountId: 'provider.authorize', pluginId: 'wool-workbuddy' })).toBe(
      'global:provider.authorize:wool-workbuddy',
    )
  })
})

describe('pluginViewScopeFromWire', () => {
  it('sessionId 形态 → 会话域 scope', () => {
    expect(pluginViewScopeFromWire({ sessionId: 's1' })).toEqual({ kind: 'session', sessionId: 's1' })
  })

  it('mountId+pluginId 形态 → 全局域 scope', () => {
    expect(pluginViewScopeFromWire({ mountId: 'provider.authorize', pluginId: 'wool-workbuddy' })).toEqual({
      kind: 'global',
      mountId: 'provider.authorize',
      pluginId: 'wool-workbuddy',
    })
  })

  it('都给 → null（二选一破坏）', () => {
    expect(pluginViewScopeFromWire({ sessionId: 's1', mountId: 'm', pluginId: 'p' })).toBeNull()
  })

  it('都缺 → null', () => {
    expect(pluginViewScopeFromWire({})).toBeNull()
    expect(pluginViewScopeFromWire({ pluginId: 'p' })).toBeNull()
  })

  it('sessionId 非非空 string → null', () => {
    expect(pluginViewScopeFromWire({ sessionId: '' })).toBeNull()
    expect(pluginViewScopeFromWire({ sessionId: 42 })).toBeNull()
  })

  it('mountId 非非空 string → null', () => {
    expect(pluginViewScopeFromWire({ mountId: '' })).toBeNull()
    expect(pluginViewScopeFromWire({ mountId: null })).toBeNull()
  })

  it('全局域缺 pluginId 或非法值 → null', () => {
    expect(pluginViewScopeFromWire({ mountId: 'm' })).toBeNull()
    expect(pluginViewScopeFromWire({ mountId: 'm', pluginId: '' })).toBeNull()
    expect(pluginViewScopeFromWire({ mountId: 'm', pluginId: 7 })).toBeNull()
  })
})
