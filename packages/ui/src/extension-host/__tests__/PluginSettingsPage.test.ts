/**
 * PluginSettingsPage 组件测试（W4 · T3）。
 *
 * 覆盖用例（design-review TC-1~TC-4）：
 *  - TC-1 插件列表渲染：名称/版本/启用状态/信任级别 DOM
 *  - TC-2 available=false contribution 置灰标注（data-testid + is-unavailable class + 默认文案）
 *  - TC-3 available=true contribution 正常展示（无置灰）
 *  - TC-4 unmount 退订（unsubscribe 被调用）
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { PluginInfo } from '@taiji/shared'
import PluginSettingsPage from '../PluginSettingsPage.vue'
import { PluginSettingsDataSourceKey } from '../plugin-settings-data-source'
import type { PluginSettingsDataSource, ContributionInfo } from '../plugin-settings-data-source'

/** mock 插件列表：p1 含可用 + 不可用 contribution 各一项，p2 全可用 */
const plugins: PluginInfo[] = [
  {
    pluginId: 'p1',
    version: '1.0.0',
    displayName: 'Plugin One',
    description: '',
    status: 'active',
    trustLevel: 'trusted',
    enabled: true,
  },
  {
    pluginId: 'p2',
    version: '2.1.0',
    displayName: 'Plugin Two',
    description: '',
    status: 'discovered',
    trustLevel: 'sandbox',
    enabled: false,
  },
]

/** getContributions 查表：p1 返回可用+不可用，p2 全可用 */
const contributionMap: Record<string, ContributionInfo[]> = {
  p1: [
    { id: 'c1', type: 'status-bar', available: false },
    { id: 'c2', type: 'views', available: true },
  ],
  p2: [{ id: 'c3', type: 'commands', available: true }],
}

function makeDataSource(overrides?: Partial<PluginSettingsDataSource>) {
  const unsubscribe = vi.fn()
  const dataSource: PluginSettingsDataSource = {
    onPlugins: vi.fn((handler) => {
      handler(plugins)
      return unsubscribe
    }),
    getContributions: vi.fn((pluginId: string) => contributionMap[pluginId] ?? []),
    ...overrides,
  }
  return { dataSource, unsubscribe }
}

function mountPage(dataSource: PluginSettingsDataSource) {
  return mount(PluginSettingsPage, {
    global: {
      provide: { [PluginSettingsDataSourceKey as symbol]: dataSource },
    },
  })
}

describe('PluginSettingsPage', () => {
  it('TC-1 插件列表渲染：名称/版本/启用状态/信任级别', async () => {
    const { dataSource } = makeDataSource()
    const wrapper = mountPage(dataSource)
    await wrapper.vm.$nextTick()
    const text = wrapper.text()
    expect(text).toContain('Plugin One')
    expect(text).toContain('1.0.0')
    expect(text).toContain('已启用')
    expect(text).toContain('受信任')
    expect(text).toContain('Plugin Two')
    expect(text).toContain('2.1.0')
    expect(text).toContain('已禁用')
    expect(text).toContain('沙箱')
    // 订阅被调用一次（onMounted）
    expect(dataSource.onPlugins).toHaveBeenCalledTimes(1)
  })

  it('TC-2 available=false contribution 置灰标注', async () => {
    const { dataSource } = makeDataSource()
    const wrapper = mountPage(dataSource)
    await wrapper.vm.$nextTick()
    const grayed = wrapper.find('[data-testid="contribution-unavailable"]')
    expect(grayed.exists()).toBe(true)
    expect(grayed.classes()).toContain('is-unavailable')
    expect(grayed.text()).toContain('当前平台不支持该挂载点')
    // 数据源按插件拉取贡献
    expect(dataSource.getContributions).toHaveBeenCalledWith('p1')
  })

  it('TC-3 available=true contribution 正常展示（无置灰）', async () => {
    const { dataSource } = makeDataSource()
    const wrapper = mountPage(dataSource)
    await wrapper.vm.$nextTick()
    const text = wrapper.text()
    // 可用项渲染（views / commands 类型名出现）
    expect(text).toContain('views')
    expect(text).toContain('commands')
    // 只有 c1 一条不可用（p1 的 status-bar），其他项无置灰 class
    const unavailableEls = wrapper.findAll('[data-testid="contribution-unavailable"]')
    expect(unavailableEls).toHaveLength(1)
    const viewItem = wrapper
      .findAll('[data-testid="contribution-item"]')
      .find((w) => w.text().includes('views'))
    expect(viewItem).toBeDefined()
    expect(viewItem!.classes()).not.toContain('is-unavailable')
  })

  it('TC-4 unmount 退订', () => {
    const { unsubscribe } = makeDataSource()
    const wrapper = mountPage({ onPlugins: () => unsubscribe, getContributions: () => [] })
    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
