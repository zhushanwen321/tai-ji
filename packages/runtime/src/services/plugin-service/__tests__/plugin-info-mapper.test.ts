/**
 * plugin-info-mapper.test.ts —— PluginDescriptor → PluginInfo 协议映射单测。
 *
 * U4 声明通路（容器扩展点统一 §6.2）验收①：contributes 透传——config.plugins 广播
 * 即声明载体，字段在映射层被挑掉则插件声明到不了渲染层（失败模式 A 的断链点）。
 */
import { describe, it, expect } from 'vitest'
import { toPluginInfos } from '../plugin-info-mapper'
import type { PluginDescriptor } from '../plugin-types'
import type { PluginContributes } from '../plugin-types'

function descriptorOf(overrides: Partial<PluginDescriptor> & { contributes?: PluginContributes | undefined } = {}): PluginDescriptor {
  const base: PluginDescriptor = {
    pluginId: 'probe',
    version: '1.0.0',
    displayName: 'Probe',
    description: 'probe plugin',
    main: 'index.js',
    activationEvents: [],
    trustLevel: 'trusted',
    status: 'ACTIVE',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/plugins/probe/index.js',
    source: 'built-in',
    extensionDependencies: [],
  }
  return { ...base, ...overrides }
}

describe('plugin-info-mapper contributes 透传（U4 §6.2 声明通路验收①）', () => {
  it('descriptor 带 contributes → PluginInfo.contributes 原样透传（views/headerActions 深值不挑不改）', () => {
    const contributes: PluginContributes = {
      views: [{ id: 'probe.tab', title: '探针面板', placement: 'drawer.tab', icon: 'list', order: 30 }],
      headerActions: [{ id: 'probe.open', title: '打开', icon: 'panel-right', activation: { kind: 'overlay', tabId: 'probe.tab' } }],
    }
    const [info] = toPluginInfos([descriptorOf({ contributes })])
    expect(info.contributes).toEqual(contributes)
  })

  it('descriptor 无 contributes（undefined，运行时扫描不会产生但契约允许）→ PluginInfo 不带该键', () => {
    const [info] = toPluginInfos([descriptorOf({ contributes: undefined })])
    expect('contributes' in info).toBe(false)
  })

  it('contributes 为 {}（清单无声明段）→ 透传空对象（「无声明」判定归消费方，映射层不改判）', () => {
    const [info] = toPluginInfos([descriptorOf({ contributes: {} })])
    expect(info.contributes).toEqual({})
  })

  it('多插件映射各自带声明（config.plugins 广播载荷整体形状）', () => {
    const infos = toPluginInfos([
      descriptorOf({ pluginId: 'a', contributes: { views: [{ id: 'a.v', title: 'A', placement: 'drawer.tab' }] } }),
      descriptorOf({ pluginId: 'b', contributes: {} }),
    ])
    expect(infos.map((i) => i.pluginId)).toEqual(['a', 'b'])
    expect(infos[0].contributes?.views?.[0]?.id).toBe('a.v')
    expect(infos[1].contributes).toEqual({})
  })
})
