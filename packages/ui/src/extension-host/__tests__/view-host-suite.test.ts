import type { ContributionInfo } from '../plugin-settings-data-source';
import type { OverlayLifecycleSource } from '../companion-band-source';
import type { OverlayState } from '../companion-band-source';
import type { PluginSettingsDataSource } from '../plugin-settings-data-source';
import CompanionBand from '../CompanionBand.vue';
import L2TabBar from '../L2TabBar.vue';
import PluginSettingsPage from '../PluginSettingsPage.vue';
import PluginViewContainer from '../PluginViewContainer.vue';
import ViewHost from '../ViewHost.vue';
import { DIALOG_QUEUE_HANDLE_KEY, DIALOG_REQUEST_SOURCE_KEY, OVERLAY_LIFECYCLE_KEY, UI_RESPONSE_TRANSPORT_KEY } from '../companion-band-source';
import type { DialogRequest, DialogRequestQueue, DialogRequestSource, UiResponseTransport } from '../dialog-request-queue';
import type { L2TabItem } from '../l2-tab-item';
import { PluginSettingsDataSourceKey } from '../plugin-settings-data-source';
import { VIEWS_SOURCE_KEY, type PluginViewSummary, type PluginViewsSource } from '../views-source';
import { ListTodo, Target } from '@lucide/vue';
import type { PluginInfo } from '@taiji/shared';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← CompanionBand.test.ts
// ======================================================================

// ── Mocks ────────────────────────────────────────────────────────────

class MockDialogRequestSource implements DialogRequestSource {
  /** 每次 mount 注册订阅返回的退订函数（unmount 退订断言用，MF-5） */
  unsubs: Array<ReturnType<typeof vi.fn>> = []
  onUiRequest = vi.fn((handler: (req: DialogRequest) => void): (() => void) => {
    this.requestHandler = handler
    const unsub = vi.fn()
    this.unsubs.push(unsub)
    return unsub as unknown as () => void
  })
  onUiRequestExpired = vi.fn((handler: (e: { sessionId: string; requestId: string }) => void): (() => void) => {
    this.expiredHandler = handler
    const unsub = vi.fn()
    this.unsubs.push(unsub)
    return unsub as unknown as () => void
  })

  requestHandler: ((req: DialogRequest) => void) | null = null
  expiredHandler: ((e: { sessionId: string; requestId: string }) => void) | null = null

  triggerUiRequest(req: Partial<DialogRequest> & { requestId: string; sessionId: string }): void {
    this.requestHandler?.(makeRequest(req))
  }

  triggerExpired(sessionId: string, requestId: string): void {
    this.expiredHandler?.({ sessionId, requestId })
  }
}

function makeRequest(overrides: Partial<DialogRequest> & { requestId: string; sessionId: string }): DialogRequest {
  return {
    source: 'pi',
    method: 'confirm',
    receivedAt: Date.now(),
    ...overrides,
  }
}

function makeTransport(): UiResponseTransport {
  return {
    // 返 true = 送达（M1 环 3 后 DialogRequestQueue.respond 消费 boolean）
    sendPiResponse: vi.fn((): boolean => true),
    sendPluginResponse: vi.fn((): boolean => true),
  }
}

function mountBand(sessionId = 'A', overlay?: OverlayLifecycleSource, registrar?: (q: unknown) => void) {
  const source = new MockDialogRequestSource()
  const transport = makeTransport()
  const wrapper = mount(CompanionBand, {
    props: { sessionId },
    global: {
      provide: {
        [DIALOG_REQUEST_SOURCE_KEY as symbol]: source,
        [UI_RESPONSE_TRANSPORT_KEY as symbol]: transport,
        ...(overlay ? { [OVERLAY_LIFECYCLE_KEY as symbol]: overlay } : {}),
        ...(registrar ? { [DIALOG_QUEUE_HANDLE_KEY as symbol]: registrar } : {}),
      },
    },
  })
  return { wrapper, source, transport }
}

/** OverlayLifecycle mock（结构兼容 OverlayLifecycleSource；transition 更新内部状态模拟状态机） */
class MockOverlayLifecycle {
  private state: OverlayState | undefined = undefined
  getState = vi.fn((_sid: string | undefined, _rid: string): OverlayState | undefined => this.state)
  transition = vi.fn((_sid: string | undefined, _rid: string, to: OverlayState): void => {
    this.state = to
  })
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CompanionBand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TC-1 confirm 渲染 + 确认/取消回传（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm', title: '确认操作', message: '是否继续？' })
    await nextTick()

    // DOM：band + title + message + 确认/取消按钮
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-title"]').text()).toContain('确认操作')
    expect(wrapper.find('[data-testid="companion-band-message"]').text()).toContain('是否继续？')
    expect(wrapper.find('[data-testid="companion-confirm-ok"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-confirm-cancel"]').exists()).toBe(true)

    // 确认 → respond(true)
    await wrapper.find('[data-testid="companion-confirm-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r1', 'confirm', true)

    // 取消 → respond(null)
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1b', method: 'confirm' })
    await nextTick()
    await wrapper.find('[data-testid="companion-confirm-cancel"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r1b', 'confirm', null)
  })

  it('TC-2 select 渲染选项 + 选中回传；未选确认禁用（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({
      sessionId: 'A',
      requestId: 'r2',
      method: 'select',
      options: [
        { label: 'A', value: 'opt-a' },
        { label: 'B', value: 'opt-b' },
      ],
    })
    await nextTick()

    // 选项 DOM（label 文本）
    const labels = wrapper.findAll('[data-testid="companion-select-option-label"]')
    expect(labels).toHaveLength(2)
    expect(labels[0]!.text()).toBe('A')
    expect(labels[1]!.text()).toBe('B')

    // 未选：确认禁用
    const okBtn = wrapper.find('[data-testid="companion-select-ok"]')
    expect(okBtn.attributes('disabled')).toBeDefined()

    // 选中 B → 确认启用 → 点确认 → respond(value)
    await wrapper.find('[data-testid="companion-select-option-opt-b"]').trigger('click')
    expect(okBtn.attributes('disabled')).toBeUndefined()
    await okBtn.trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r2', 'select', 'opt-b')
  })

  it('TC-3 input 渲染 + 文本回传（prefill 预填）；editor 变体走 Textarea（AC3）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r3', method: 'input', prefill: '默认值' })
    await nextTick()

    // Input DOM + prefill 预填
    const input = wrapper.find('[data-testid="companion-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('默认值')

    // 输入文本 → 确认 → respond(value)
    await input.setValue('abc')
    await wrapper.find('[data-testid="companion-input-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r3', 'input', 'abc')

    // editor 变体：Textarea 渲染 + 回传
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r3e', method: 'editor' })
    await nextTick()
    const textarea = wrapper.find('[data-testid="companion-editor"]')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue('multi\nline')
    await wrapper.find('[data-testid="companion-input-ok"]').trigger('click')
    expect(transport.sendPiResponse).toHaveBeenCalledWith('A', 'r3e', 'editor', 'multi\nline')
  })

  it('TC-5 无请求自隐藏（根元素 v-if 隐藏，不占位）（IF3）', async () => {
    const { wrapper } = mountBand()
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
  })

  it('TC-5b expired 撤窗：plugin:uiRequestExpired 出队后 band 自隐藏（D2 取消非替答，无回传）', async () => {
    const { wrapper, source, transport } = mountBand()
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm', title: '确认操作' })
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)

    // dialog 到期撤窗：band 消失 + 不产生任何回传（插件侧已收 UI_TIMEOUT reject）
    source.triggerExpired('A', 'r1')
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
    expect(transport.sendPiResponse).not.toHaveBeenCalled()
    expect(transport.sendPluginResponse).not.toHaveBeenCalled()
  })

  it('MF-5: unmount 后订阅退订生效（queue 在 setup 顶层创建，onScopeDispose 正常注册）', async () => {
    const { wrapper, source } = mountBand()
    await nextTick()
    // 队列创建时注册两个订阅（onUiRequest + onUiRequestExpired）
    expect(source.unsubs).toHaveLength(2)

    // 首次请求正常入队渲染
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm' })
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)

    wrapper.unmount()
    // scope dispose → 两个订阅均退订。MF-5 修复前 queue 在 computed getter 内创建，
    // onScopeDispose 注册静默失败（无 active effect scope），unmount 后 unsub 不会被调。
    expect(source.unsubs[0]).toHaveBeenCalledTimes(1)
    expect(source.unsubs[1]).toHaveBeenCalledTimes(1)
  })

  it('TC-6 未知 method 只读降级：title/message 展示 + 无按钮 + console.warn（ERR3）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { wrapper, source } = mountBand()
      source.triggerUiRequest({
        sessionId: 'A',
        requestId: 'r9',
        method: 'futureMethod',
        title: '未来方法',
        message: '只读信息',
      } as unknown as Partial<DialogRequest> & { requestId: string; sessionId: string })
      await nextTick()

      // band + title/message 只读展示
      expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="companion-band-title"]').text()).toContain('未来方法')
      expect(wrapper.find('[data-testid="companion-band-message"]').text()).toContain('只读信息')

      // 无任何交互按钮
      expect(wrapper.findAll('button')).toHaveLength(0)

      // console.warn 记录未知 method
      expect(warnSpy).toHaveBeenCalledWith('[CompanionBand] unknown dialog method:', 'futureMethod')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── OverlayLifecycle 契约（IF9 状态机，arch-fix-v2 闭环）──────────────
describe('CompanionBand × OverlayLifecycle 契约（IF9）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('minimize → transition(sessionId, requestId, "minimized") + UI 反映收起态', async () => {
    const overlay = new MockOverlayLifecycle()
    const { wrapper, source } = mountBand('A', overlay)
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r1', method: 'confirm', title: '确认', message: '正文' })
    await nextTick()

    // 初始未收起（getState undefined）→ minimize 按钮可见、body 可见
    expect(wrapper.find('[data-testid="companion-minimize"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(true)

    // 点击 minimize → transition('minimized') + 状态机更新 + refresh → UI 收起
    await wrapper.find('[data-testid="companion-minimize"]').trigger('click')
    expect(overlay.transition).toHaveBeenCalledWith('A', 'r1', 'minimized')
    expect(wrapper.find('[data-testid="companion-restore"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-minimize"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(false)
    // z-index 状态驱动 → 覆盖层（design-token）
    expect(wrapper.find('[data-testid="companion-band"]').attributes('style')).toContain('z-index: var(--z-overlay)')
  })

  it('restore → transition("restored") + body 重新可见', async () => {
    const overlay = new MockOverlayLifecycle()
    const { wrapper, source } = mountBand('A', overlay)
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r2', method: 'confirm', title: '收起测', message: 'm' })
    await nextTick()
    // 先收起
    await wrapper.find('[data-testid="companion-minimize"]').trigger('click')
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(false)

    // restore → transition('restored') + body 重新可见（restored 低层 z-index）
    await wrapper.find('[data-testid="companion-restore"]').trigger('click')
    expect(overlay.transition).toHaveBeenCalledWith('A', 'r2', 'restored')
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-minimize"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band"]').attributes('style')).toContain('z-index: var(--z-overlay)')
  })

  it('expanded 态 → z-index 钉 dialog+1 档（AP-2 规则③：用户待决确认层浮于 plugin modal 与浮层壳之上）', async () => {
    // OverlayLifecycle 生产语义：ui-request 到达即建 expanded 分区——mock 预置 expanded 态
    const overlay = new MockOverlayLifecycle()
    overlay.transition('A', 'r4', 'expanded')
    const { wrapper, source } = mountBand('A', overlay)
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r4', method: 'confirm', title: '确认', message: 'm' })
    await nextTick()
    // 用户可见断言：band 内联 z 钉确认层档 token +1（高于 --z-modal，且高于同用 z-dialog
    // 的浮层壳——同值平局 DOM 后序者胜会让壳遮罩盖住待决带，+1 消除平局）
    expect(wrapper.find('[data-testid="companion-band"]').attributes('style')).toContain('z-index: calc(var(--z-dialog) + 1)')
  })

  it('无 OverlayLifecycle inject：minimize 点击不崩（静默 no-op）', async () => {
    // mountBand 不传 overlay → OVERLAY_LIFECYCLE_KEY 未 provide → inject 默认 null
    const { wrapper, source } = mountBand('A')
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r3', method: 'confirm', title: '无注入' })
    await nextTick()

    const minBtn = wrapper.find('[data-testid="companion-minimize"]')
    expect(minBtn.exists()).toBe(true)
    // 点击不抛错
    await expect(minBtn.trigger('click')).resolves.toBeUndefined()
    // band 仍渲染（未崩），无 z-index（undefined 状态 → 不设）
    const band = wrapper.find('[data-testid="companion-band"]')
    expect(band.exists()).toBe(true)
    expect(band.attributes('style')).toBeFalsy()
  })

  // ── U6 句柄登记通路（remote-use D5 exited 分区清理段）：exited 编排经壳侧句柄调 resetFor ──

  it('provide DIALOG_QUEUE_HANDLE_KEY：queue 创建后回传实例句柄（含 resetFor 成员，U6 exited 通路）', async () => {
    const registrar = vi.fn()
    const { wrapper, source } = mountBand('A', undefined, registrar)
    // 回传恰一次，参数是 queue 实例（resetFor 是 U6 新增成员，结构断言防回传错误对象）
    expect(registrar).toHaveBeenCalledTimes(1)
    const handle = registrar.mock.calls[0]?.[0] as DialogRequestQueue
    expect(typeof handle.resetFor).toBe('function')
    expect(typeof handle.respond).toBe('function')
    // 句柄可用：经回传的 queue 触发请求照常渲染（同一实例非旁路副本）
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r-handle', method: 'confirm', title: '句柄' })
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
  })

  it('未 provide DIALOG_QUEUE_HANDLE_KEY（桌面壳形态）：静默跳过，组件照常渲染不崩', async () => {
    const { wrapper, source } = mountBand('A')
    source.triggerUiRequest({ sessionId: 'A', requestId: 'r-no-reg', method: 'confirm', title: '无登记' })
    await nextTick()
    // 不抛错、band 照常渲染（inject 缺失静默空态先例，source/transport 同款）
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
  })
})

// ======================================================================
// ← L2TabBar.test.ts
// ======================================================================

const TABS: L2TabItem[] = [
  { viewId: 'todo', title: '任务', icon: ListTodo, builtin: true },
  { viewId: 'goal', title: '目标', icon: Target },
]

function mountBar(tabs: L2TabItem[] = TABS, modelValue = 'todo') {
  return mount(L2TabBar, {
    props: { tabs, modelValue },
  })
}

describe('L2TabBar', () => {
  it('tab 渲染：标题文本 + data-testid（DOM 断言）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="l2-tabbar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="l2-tab-todo"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="l2-tab-goal"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('任务')
    expect(wrapper.text()).toContain('目标')
    wrapper.unmount()
  })

  it('active 态：modelValue 对应 tab data-active=true，其余 false', () => {
    const wrapper = mountBar(TABS, 'goal')
    expect(wrapper.find('[data-testid="l2-tab-goal"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="l2-tab-todo"]').attributes('data-active')).toBe('false')
    wrapper.unmount()
  })

  it('点击 tab → emit update:modelValue(viewId)', async () => {
    const wrapper = mountBar()
    await wrapper.find('[data-testid="l2-tab-goal"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['goal'])
    wrapper.unmount()
  })

  it('close 按钮：builtin tab 不渲染 close；非 builtin 渲染；点击 emit close(viewId) 且不触发切换', async () => {
    const wrapper = mountBar()
    // builtin（todo）无 close；非 builtin（goal）有 close
    expect(wrapper.find('[data-testid="l2-tab-close-todo"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="l2-tab-close-goal"]').exists()).toBe(true)

    // 点击 close → emit close('goal')，且 @click.stop 不触发 update:modelValue
    await wrapper.find('[data-testid="l2-tab-close-goal"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(wrapper.emitted('close')![0]).toEqual(['goal'])
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('无 icon 的 tab：纯文字渲染，不抛错', () => {
    const noIconTabs: L2TabItem[] = [
      { viewId: 'plain', title: '纯文字', builtin: false },
    ]
    const wrapper = mountBar(noIconTabs, 'plain')
    expect(wrapper.text()).toContain('纯文字')
    expect(wrapper.find('[data-testid="l2-tab-plain"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

// ======================================================================
// ← PluginSettingsPage.test.ts
// ======================================================================

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
    { id: 'c1', type: 'command', available: false },
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
    // 只有 c1 一条不可用（p1 的 c1 贡献），其他项无置灰 class
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

// ======================================================================
// ← PluginViewContainer.test.ts
// ======================================================================

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
    expect(host.props('scope')).toEqual({ kind: 'session', sessionId: 's1' })
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

  it('R3: 无 source 注入 → 静默空态不崩', async () => {
    const wrapper = mountContainer(undefined)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="plugin-view-empty"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
