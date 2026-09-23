/**
 * PluginViewContainer 组件测试（W4 · T7）。
 *
 * 覆盖用例（wave design TC1-TC3）：
 *  - TC1: 注入 2 个 views 的 mock source → L2TabBar 渲染「任务」「目标」；
 *    默认 activeViewId='todo'；点击「目标」后 ViewHost view-id='goal'（DOM 断言）
 *  - TC2: views 空 → 空态提示（data-testid=plugin-view-empty），组件不抛错
 *  - TC3: builtin（pluginId 'tasks'）tab 无 close 按钮；非 builtin tab 有 close（DOM 断言）
 *  - R3: 无 source 注入 → 静默空态不崩（对齐 ViewHost.test.ts R3 范式）
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/__tests__/PluginViewContainer.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PluginViewContainer from '../PluginViewContainer.vue'
import { VIEWS_SOURCE_KEY, type PluginViewsSource, type PluginViewSummary } from '../views-source'
import ViewHost from '../ViewHost.vue'

function makeSource(views: PluginViewSummary[]): PluginViewsSource {
  return { getViews: vi.fn((_sessionId: string) => views) }
}

function mountContainer(source?: PluginViewsSource, sessionId = 's1') {
  const provide = source ? { [VIEWS_SOURCE_KEY as symbol]: source } : {}
  return mount(PluginViewContainer, {
    props: { sessionId },
    global: { provide },
  })
}

/**
 * builtin plugin（pluginId 'tasks'）贡献的双 view 夹具——builtin 判定按 pluginId 取
 * core builtinContributions 的 pluginId 集合（tasks 在集内 → 不可关闭）。
 */
const TASKS_VIEWS: PluginViewSummary[] = [
  { viewId: 'todo', title: '任务', initialVisibility: 'visible', pluginId: 'tasks' },
  { viewId: 'goal', title: '目标', initialVisibility: 'visible', pluginId: 'tasks' },
]

describe('PluginViewContainer', () => {
  it('TC1: L2TabBar 渲染「任务」「目标」+ 默认 activeViewId=todo + 点击切到 goal（DOM 断言）', async () => {
    const source = makeSource(TASKS_VIEWS)
    const wrapper = mountContainer(source)
    await wrapper.vm.$nextTick()

    // L2TabBar 渲染两个 tab（标题 DOM 断言）
    const tabbar = wrapper.find('[data-testid="l2-tabbar"]')
    expect(tabbar.exists()).toBe(true)
    expect(tabbar.text()).toContain('任务')
    expect(tabbar.text()).toContain('目标')
    // 默认 activeViewId = 第一个可见 view → ViewHost view-id='todo'
    const host = wrapper.findComponent(ViewHost)
    expect(host.exists()).toBe(true)
    expect(host.props('viewId')).toBe('todo')
    expect(host.props('sessionId')).toBe('s1')
    // todo tab 是 active 态（data-active DOM 断言）
    expect(wrapper.find('[data-testid="l2-tab-todo"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="l2-tab-goal"]').attributes('data-active')).toBe('false')

    // 点击「目标」→ 切 tab 只改 activeViewId → ViewHost view-id='goal'
    await wrapper.find('[data-testid="l2-tab-goal"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(ViewHost).props('viewId')).toBe('goal')
    expect(wrapper.find('[data-testid="l2-tab-goal"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="l2-tab-todo"]').attributes('data-active')).toBe('false')
    wrapper.unmount()
  })

  it('TC2: views 空 → 空态提示渲染（data-testid 断言），不挂 L2TabBar/ViewHost，不抛错', async () => {
    const source = makeSource([])
    const wrapper = mountContainer(source)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="plugin-view-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="l2-tabbar"]').exists()).toBe(false)
    expect(wrapper.findComponent(ViewHost).exists()).toBe(false)
    wrapper.unmount()
  })

  it('TC3: builtin（tasks pluginId）tab 无 close 按钮；非 builtin tab 有 close（DOM 断言）', async () => {
    const mixed: PluginViewSummary[] = [
      ...TASKS_VIEWS,
      { viewId: 'ext-view', title: '外部视图', initialVisibility: 'hidden', pluginId: 'other' },
    ]
    const source = makeSource(mixed)
    const wrapper = mountContainer(source)
    await wrapper.vm.$nextTick()

    // tasks 的 todo/goal：无 close 按钮
    expect(wrapper.find('[data-testid="l2-tab-close-todo"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="l2-tab-close-goal"]').exists()).toBe(false)
    // other pluginId 的 ext-view：有 close 按钮
    expect(wrapper.find('[data-testid="l2-tab-close-ext-view"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('TC3b: close 事件对非 builtin 生效——本地移除该 tab，不持久化', async () => {
    const mixed: PluginViewSummary[] = [
      ...TASKS_VIEWS,
      { viewId: 'ext-view', title: '外部视图', initialVisibility: 'visible', pluginId: 'other' },
    ]
    const source = makeSource(mixed)
    const wrapper = mountContainer(source)
    await wrapper.vm.$nextTick()

    // 默认 active 是第一个可见 view（todo）
    expect(wrapper.find('[data-testid="l2-tab-ext-view"]').exists()).toBe(true)

    // 先切到 ext-view（使之为当前 active）→ 点击 close → tab 移除 + active 回退到第一个可见 view
    await wrapper.find('[data-testid="l2-tab-ext-view"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(ViewHost).props('viewId')).toBe('ext-view')

    await wrapper.find('[data-testid="l2-tab-close-ext-view"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="l2-tab-ext-view"]').exists()).toBe(false)
    // tasks 的 tab 不受影响
    expect(wrapper.find('[data-testid="l2-tab-todo"]').exists()).toBe(true)
    // 关闭当前 active → 回退到第一个可见 view（todo）
    expect(wrapper.findComponent(ViewHost).props('viewId')).toBe('todo')
    wrapper.unmount()
  })

  it('TC3c: pin 切换本地 ref（data-pinned DOM 断言），不持久化', async () => {
    const source = makeSource(TASKS_VIEWS)
    const wrapper = mountContainer(source)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="l2-tab-pin-goal"]').attributes('data-pinned')).toBe('false')
    await wrapper.find('[data-testid="l2-tab-pin-goal"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="l2-tab-pin-goal"]').attributes('data-pinned')).toBe('true')
    // 再点一次取消
    await wrapper.find('[data-testid="l2-tab-pin-goal"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="l2-tab-pin-goal"]').attributes('data-pinned')).toBe('false')
    wrapper.unmount()
  })

  it('R3: 无 source 注入 → 静默空态不崩', async () => {
    const wrapper = mountContainer(undefined)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="plugin-view-empty"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
