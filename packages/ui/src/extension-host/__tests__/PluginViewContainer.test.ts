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
import { L2_TAB_BADGE_SOURCE_KEY, NATIVE_VIEWS_KEY } from '../l2-tab-item'
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

/** builtin tasks 双 view（todo/goal，对齐 core builtin-contributions.ts） */
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

  // ── 原生视图路由 + badge（background-task-sidebar-view D4②/D4④）──

  it('D4②: NATIVE_VIEWS 命中 activeView → 渲染原生组件（sessionId 透传）替代 ViewHost；未命中 viewId 走原路径', async () => {
    const source = makeSource([
      { viewId: 'background-tasks', title: '后台命令', initialVisibility: 'visible', pluginId: 'base-tool-enhance' },
      { viewId: 'widget-view', title: 'Widget', initialVisibility: 'visible', pluginId: 'ext' },
    ])
    const nativeStub = { template: '<div data-testid="native-stub">NATIVE</div>' }
    const wrapper = mount(PluginViewContainer, {
      props: { sessionId: 's-native' },
      global: {
        provide: {
          [VIEWS_SOURCE_KEY as symbol]: source,
          [NATIVE_VIEWS_KEY as symbol]: { 'background-tasks': nativeStub },
        },
      },
    })
    await wrapper.vm.$nextTick()
    // 默认 active = 第一个可见 view（background-tasks）→ 原生组件渲染、ViewHost 不渲染
    expect(wrapper.find('[data-testid="native-stub"]').exists()).toBe(true)
    expect(wrapper.findComponent(ViewHost).exists()).toBe(false)

    // 切到未注册原生映射的 view → 回落 ViewHost 原路径
    await wrapper.find('[data-testid="l2-tab-widget-view"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="native-stub"]').exists()).toBe(false)
    expect(wrapper.findComponent(ViewHost).exists()).toBe(true)
    expect(wrapper.findComponent(ViewHost).props('viewId')).toBe('widget-view')
    wrapper.unmount()
  })

  it('D4②: 原生组件收到 sessionId prop（数据按 session 分区）', async () => {
    const received: string[] = []
    const nativeStub = {
      props: ['sessionId'],
      template: '<div data-testid="native-sid">{{ sessionId }}</div>',
      setup(props: { sessionId: string }) {
        received.push(props.sessionId)
        return props
      },
    }
    const source = makeSource([
      { viewId: 'background-tasks', title: '后台命令', initialVisibility: 'visible', pluginId: 'base-tool-enhance' },
    ])
    const wrapper = mount(PluginViewContainer, {
      props: { sessionId: 's-42' },
      global: {
        provide: {
          [VIEWS_SOURCE_KEY as symbol]: source,
          [NATIVE_VIEWS_KEY as symbol]: { 'background-tasks': nativeStub },
        },
      },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="native-sid"]').text()).toBe('s-42')
    expect(received).toEqual(['s-42'])
    wrapper.unmount()
  })

  it('D4②回归: 未注入 NATIVE_VIEWS → 全部 view 走 ViewHost 原路径（TC1 同构）', async () => {
    const source = makeSource([
      { viewId: 'background-tasks', title: '后台命令', initialVisibility: 'visible', pluginId: 'base-tool-enhance' },
    ])
    const wrapper = mountContainer(source)
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(ViewHost).exists()).toBe(true)
    expect(wrapper.findComponent(ViewHost).props('viewId')).toBe('background-tasks')
    wrapper.unmount()
  })

  it('D4④: badge 源点亮条件流转——源返回 true 渲染圆点、false 不渲染；未注入不渲染；base-tool-enhance 无 close 按钮', async () => {
    const source = makeSource([
      { viewId: 'background-tasks', title: '后台命令', initialVisibility: 'visible', pluginId: 'base-tool-enhance' },
    ])
    // badge 源模拟壳实现形态：读 sessionId，返回 viewId → boolean（点亮条件 = 运行中桶 > 0，
    // 与 renderer 分桶 SSOT 同源派生在壳侧完成，ui 层只流转 boolean）
    const badgeSource = vi.fn((sessionId: string) => ({
      'background-tasks': sessionId === 's-running',
    }))
    const wrapper = mount(PluginViewContainer, {
      props: { sessionId: 's-running' },
      global: {
        provide: {
          [VIEWS_SOURCE_KEY as symbol]: source,
          [L2_TAB_BADGE_SOURCE_KEY as symbol]: badgeSource,
        },
      },
    })
    await wrapper.vm.$nextTick()
    // 亮：源返回 true → 圆点渲染（用户可见 DOM 断言）；源以焦点 session 调用
    expect(badgeSource).toHaveBeenCalledWith('s-running')
    expect(wrapper.find('[data-testid="l2-tab-badge-background-tasks"]').exists()).toBe(true)
    // base-tool-enhance 是 builtin：无 close 按钮（D4③ 基础设施级，不可关闭）
    expect(wrapper.find('[data-testid="l2-tab-close-background-tasks"]').exists()).toBe(false)
    wrapper.unmount()

    // 不亮：源返回 false → 无圆点
    const wrapperOff = mount(PluginViewContainer, {
      props: { sessionId: 's-idle' },
      global: {
        provide: {
          [VIEWS_SOURCE_KEY as symbol]: source,
          [L2_TAB_BADGE_SOURCE_KEY as symbol]: badgeSource,
        },
      },
    })
    await wrapperOff.vm.$nextTick()
    expect(wrapperOff.find('[data-testid="l2-tab-badge-background-tasks"]').exists()).toBe(false)
    wrapperOff.unmount()

    // 未注入 badge 源：无圆点（生产接线前回归安全）
    const wrapperNoSource = mountContainer(source)
    await wrapperNoSource.vm.$nextTick()
    expect(wrapperNoSource.find('[data-testid="l2-tab-badge-background-tasks"]').exists()).toBe(false)
    wrapperNoSource.unmount()
  })
})
