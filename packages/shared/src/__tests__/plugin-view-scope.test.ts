/**
 * plugin-view-scope 纯函数单测（provider-plugin-access U2 分区键泛化）。
 *
 * 用例口径 = 文件头注契约表：scope 串两形态（session / global）、wire 载荷二选一
 * 解析（合法两态 + 都缺/都给/空串/非 string 逐字段拒绝）。纯函数零 IO。
 */
import { describe, expect, it } from 'vitest'
import { pluginViewScopeFromWire, pluginViewScopeKey, pluginViewScopeMountPrefix } from '../plugin-view-scope.js'

describe('pluginViewScopeKey（scope 串形态单一事实源）', () => {
  it('会话域 → session:<sessionId>', () => {
    expect(pluginViewScopeKey({ kind: 'session', sessionId: 's-1' })).toBe('session:s-1')
  })

  it('全局域 → global:<mountId>:<pluginId>（键含插件维度：同挂载位多插件互不覆盖）', () => {
    expect(pluginViewScopeKey({ kind: 'global', mountId: 'provider.authorize', pluginId: 'wool-workbuddy' })).toBe(
      'global:provider.authorize:wool-workbuddy',
    )
  })
})

describe('pluginViewScopeMountPrefix（挂载位前缀原语：pluginId 缺省的收窄/清理场景）', () => {
  it('挂载位前缀 → global:<mountId>:', () => {
    expect(pluginViewScopeMountPrefix('provider.authorize')).toBe('global:provider.authorize:')
  })

  it('键形态对账：全局域精确键必然以挂载位前缀开头（前缀删除覆盖全部精确键写入的分区）', () => {
    const prefix = pluginViewScopeMountPrefix('provider.authorize')
    expect(pluginViewScopeKey({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }).startsWith(prefix)).toBe(true)
    expect(pluginViewScopeKey({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-b' }).startsWith(prefix)).toBe(true)
  })
})

describe('pluginViewScopeFromWire（wire 载荷二选一窄化解析）', () => {
  it('sessionId 形态 → 会话域 scope', () => {
    expect(pluginViewScopeFromWire({ sessionId: 's-1' })).toEqual({ kind: 'session', sessionId: 's-1' })
  })

  it('mountId + pluginId 形态 → 全局域 scope', () => {
    expect(pluginViewScopeFromWire({ mountId: 'provider.authorize', pluginId: 'wool-workbuddy' })).toEqual({
      kind: 'global',
      mountId: 'provider.authorize',
      pluginId: 'wool-workbuddy',
    })
  })

  it('都缺或都给 → null（INVALID_VIEW_SCOPE 判据形态）', () => {
    expect(pluginViewScopeFromWire({})).toBeNull()
    expect(pluginViewScopeFromWire({ sessionId: 's-1', mountId: 'provider.authorize' })).toBeNull()
  })

  it('所选字段非非空 string → null（逐字段窄校验）', () => {
    // 会话域：sessionId 空串 / 非 string
    expect(pluginViewScopeFromWire({ sessionId: '' })).toBeNull()
    expect(pluginViewScopeFromWire({ sessionId: 42 })).toBeNull()
    // 全局域：mountId / pluginId 任一空串或非 string
    expect(pluginViewScopeFromWire({ mountId: '', pluginId: 'p' })).toBeNull()
    expect(pluginViewScopeFromWire({ mountId: 'provider.authorize', pluginId: '' })).toBeNull()
    expect(pluginViewScopeFromWire({ mountId: 'provider.authorize' })).toBeNull()
  })
})
