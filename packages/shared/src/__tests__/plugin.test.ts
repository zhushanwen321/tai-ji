import { describe, it, expect } from 'vitest'
import type { PluginInfo, PluginContributes } from '../plugin'

/**
 * PluginInfo.contributes wire 契约（容器扩展点统一 §6.2 声明通路）：
 * PluginInfo 是 config.plugins 广播载荷，contributes 是插件清单声明到达 renderer 的
 * 主体字段。形状三版对齐义务（plugin-sdk 插件作者契约 / core 解析层 / 本文件 wire 载荷）
 * 由各包 typecheck + 各自契约测试分头承载；本文件验证 wire 侧形状可完整实例化与回读。
 */
describe('PluginInfo.contributes（§6.2 声明通路 wire 契约）', () => {
  /** 最小合法 PluginInfo（缺省 contributes 的旧 runtime 兼容形态） */
  function bareInfo(): PluginInfo {
    return {
      pluginId: 'myplugin',
      version: '1.0.0',
      displayName: 'My Plugin',
      description: 'demo',
      status: 'active',
      trustLevel: 'trusted',
      enabled: true,
    }
  }

  it('contributes 可选字段存在：完整声明形状可挂上 PluginInfo 且字段回读一致', () => {
    const contributes: PluginContributes = {
      views: [
        {
          id: 'myplugin.sessions',
          placement: 'drawer.tab',
          title: '我的会话',
          icon: 'list',
          order: 30,
          scope: 'session',
          emptyState: { text: '还没有会话', hint: '从左侧选择一个项目开始' },
        },
      ],
      headerActions: [
        {
          id: 'myplugin.open',
          title: '我的面板',
          icon: 'panel-right',
          activation: { kind: 'overlay', tabId: 'myplugin.panel', params: { path: '/tmp/x' } },
        },
      ],
      commands: [{ command: 'myplugin.cmd', title: 'Cmd' }],
      slashCommands: [{ name: 'myplugin', description: 'slash' }],
      tools: [{ name: 'tool', description: 'd', parameters: {} }],
      hooks: ['onPiEvent'],
      menus: { 'composer.toolbar': [{ command: 'myplugin.cmd' }] },
      configuration: { properties: { key: { type: 'string' } } },
    }
    const info: PluginInfo = { ...bareInfo(), contributes }
    expect(info.contributes?.views?.[0]?.icon).toBe('list')
    expect(info.contributes?.views?.[0]?.order).toBe(30)
    expect(info.contributes?.views?.[0]?.scope).toBe('session')
    expect(info.contributes?.views?.[0]?.emptyState).toEqual({ text: '还没有会话', hint: '从左侧选择一个项目开始' })
    expect(info.contributes?.headerActions?.[0]?.activation).toEqual({
      kind: 'overlay',
      tabId: 'myplugin.panel',
      params: { path: '/tmp/x' },
    })
  })

  it('contributes 缺省 = 旧载荷形态仍合法（renderer 对未透传载荷的兼容面）', () => {
    const info = bareInfo()
    expect(info.contributes).toBeUndefined()
  })

  it('activation 结构化联合：command/overlay/drawer 三 kind 与 scheduler-overlay 迁移兼容值均合法', () => {
    const ha = (activation: NonNullable<PluginContributes['headerActions']>[number]['activation']): PluginContributes => ({
      headerActions: [{ id: 'a', title: 'T', icon: 'zap', activation }],
    })
    expect(ha({ kind: 'command' }).headerActions?.[0]?.activation).toEqual({ kind: 'command' })
    expect(ha({ kind: 'overlay', tabId: 'x.y' }).headerActions?.[0]?.activation).toEqual({ kind: 'overlay', tabId: 'x.y' })
    expect(ha({ kind: 'drawer', tabId: 'x.z', params: { s: 'a', n: 1, b: true } }).headerActions?.[0]?.activation).toEqual({
      kind: 'drawer',
      tabId: 'x.z',
      params: { s: 'a', n: 1, b: true },
    })
    expect(ha('scheduler-overlay').headerActions?.[0]?.activation).toBe('scheduler-overlay')
  })

  it('view 声明 scope 缺省语义由消费方承载（wire 层只透传，不补默认值）', () => {
    const contributes: PluginContributes = {
      views: [{ id: 'myplugin.global', placement: 'overlay.content', title: '全局面板', scope: 'global' }],
    }
    expect(contributes.views?.[0]?.scope).toBe('global')
    const noScope: PluginContributes = { views: [{ id: 'myplugin.plain', placement: 'drawer.tab', title: 'T' }] }
    expect(noScope.views?.[0]?.scope).toBeUndefined()
  })
})
