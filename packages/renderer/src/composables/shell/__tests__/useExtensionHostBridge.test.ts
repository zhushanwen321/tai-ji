/**
 * useExtensionHostBridge.test.ts —— createWsPluginMessageSource 过滤条件单测（FR1/AC1）。
 *
 * 链路：events.dispatchCrossSession（模拟 route-inbound crossSession 通道分发）→ source →
 * MessageBusBridge → bus。经 events 正规通道全链路验证（ADR-0060：source 双订阅 onGlobal +
 * onCrossSession，crossSession 通道注入可触发 source adapt，与 global 等价）。
 *
 * 覆盖：TC1 plugin:uiRequest 前缀放行 / TC2 extension.ui_request 白名单放行（归一 kind=ui-request）/
 * TC3 extension.error 非白名单拒绝 / TC4 plugin:statusBarUpdate 前缀回归 /
 * TC5 白名单 5 项字面量 + 行为级验证（防与 core EXTENSION_HANDLERS 漂移）。
 * M17 追加：TC7 VIEW_HOST_SOURCE_KEY provide 值的 getViewIds 纯透传
 * （extension:widgetGui 帧 → ViewHostStore → provide 枚举一致）。
 * M17 wave2 追加（D5：废弃 sidebar 动态 view 发现，getViews 纯静态）：
 * M17w2-TC1 widget 推送不进 L2 tab 清单（getViewIds 对照仍含）/
 * M17w2-TC2 静态声明 view 经 registerContribution 出现在 getViews。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, nextTick } from 'vue'
import { EXTENSION_BRIDGE_TYPES, InternalEventBus, MessageBusBridge, providePlatform, registerMountPoints, scanContributions, type ContributionRegistry } from '@taiji/core'
import type { InternalEvent } from '@taiji/core'
import { dispatchCrossSession, dispatchGlobal } from '@taiji/core/transport/api'
import { createWsPluginMessageSource, initExtensionHostBridge, __testing } from '../useExtensionHostBridge'
import {
  DIALOG_REQUEST_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
  VIEW_HOST_SOURCE_KEY,
  STATUS_BAR_SOURCE_KEY,
  VIEWS_SOURCE_KEY,
  type ViewHostSource,
  type StatusBarSource,
  type PluginViewsSource,
} from '@taiji/ui/extension-host'
import { connect, disconnect } from '@taiji/core/transport/ws-client'
import { createMockPlatform } from '@taiji/core/transport/mock/mock-ws'

// mock ws-client.send：MF-4 断言 mountPoints.sync 发送（真实 send 在单测环境不可观测）。
// D5 后 bridge 直连 core ws-client——mock 须拦截该模块本身；importOriginal 保留真实
// connect/disconnect/getState（TC11/TC12 建连 + watch connected 依赖真实状态机）。
// 模式对齐 usePermissionRequest.test.ts（顶层 vi.fn + 工厂转发）。
const transportSendSpy = vi.fn()
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    send: (...args: unknown[]) => transportSendSpy(...args),
  }
})

/**
 * 模拟 bootstrap step 4+5（u6 注册收敛）：bridge 装配后不再自行触发注册，生产由 App.vue
 * onMounted 的 bootstrap 第 4/5 步执行；测试显式调用补齐该前置。两者均读
 * setExtensionRegistries 最新注入的实例（幂等）；ensureMountPointsSync 的模块级守卫使
 * watch 闭包引用首次装配的 mountPoints 实例——各装配点统一补注册，watch 无论引用哪个
 * 实例 list() 均为全量挂载点。step 5 scanContributions（registerBuiltin）在 D4① 后必须补：
 * viewsSource.getViews 消费 builtin 的 sidebar.tab view 声明（该 native 视图退役后
 * builtin 零 view 声明——本组用例经 external 注册路径覆盖 getViews 映射，见 M17w2-TC2）。
 * 两步骤实现体均为纯同步（async 仅是 bootstrap 编排签名，体内无 await）——调用即完成
 * 注册，同步用例（TC1/TC2 的 getViews 断言）无需 await 即读到注册后的 registry。
 */
async function simulateBootstrapRegistration(): Promise<void> {
  await Promise.all([registerMountPoints(), scanContributions()])
}

function makeBridge() {
  const bus = new InternalEventBus()
  const source = createWsPluginMessageSource()
  const bridge = new MessageBusBridge({ source, bus })
  return { bus, bridge }
}

/** emit 后收集 bus 上所有事件（对齐 core message-bus-bridge.test.ts 范式）。 */
function spyEmit(bus: InternalEventBus) {
  const emitted: InternalEvent[] = []
  const spy = vi.spyOn(bus, 'emit')
  spy.mockImplementation((e) => {
    emitted.push(e)
    return
  })
  return { emitted, spy }
}

describe('createWsPluginMessageSource 过滤条件（FR1/AC1）', () => {
  let bridge: MessageBusBridge | null = null

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    bridge?.dispose()
    bridge = null
  })

  it('TC1: plugin:uiRequest 前缀放行 → bus 收到 kind=ui-request（sessionId 透传）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'plugin:uiRequest',
      payload: { sessionId: 's1', requestId: 'r1', method: 'select', options: ['a', 'b'] },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ kind: 'ui-request', sessionId: 's1' })
    expect(emitted[0]).not.toMatchObject({ kind: 'error' })
  })

  it('TC1b: plugin:viewUpdate 前缀放行 → bus 收到 kind=extension-widget（MF-1 链路）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'plugin:viewUpdate',
      payload: { sessionId: 's1', viewId: 'sidebar.tab', pluginId: 'p1', guiTree: [{ type: 'ansi-text', props: { lines: ['hi'] } }], updatedAt: 1 },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      kind: 'extension-widget',
      sessionId: 's1',
      widget: { viewId: 'sidebar.tab', pluginId: 'p1', guiTree: [{ type: 'ansi-text', props: { lines: ['hi'] } }] },
    })
    expect(emitted[0]).not.toMatchObject({ kind: 'error' })
  })

  it('TC2: extension.ui_request 白名单放行 → bus 收到 kind=ui-request（与 plugin:uiRequest 归一）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'extension.ui_request',
      payload: { sessionId: 's1', requestId: 'r1', method: 'confirm', title: '确认?' },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ kind: 'ui-request', sessionId: 's1' })
    expect(emitted[0]).not.toMatchObject({ kind: 'error' })
  })

  it('TC3: extension.error 非白名单 → bridge 零感知（bus 零事件）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({ type: 'extension.error', payload: { sessionId: 's1', code: 'boom' } })

    expect(emitted).toHaveLength(0)
  })

  it('TC4: plugin:statusBarUpdate 前缀放行不回归', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'plugin:statusBarUpdate',
      payload: {
        items: [{ id: 'sb1', pluginId: 'tasks', text: 'ready', priority: 100, scope: 'per-session', sessionId: 's1' }],
      },
    })

    expect(emitted).toHaveLength(1)
    // 事件级 sessionId 来自 payload 顶层（statusBarUpdate 无，故 undefined）；item 级 sessionId 保留在 items 内
    expect(emitted[0]).toMatchObject({ kind: 'plugin-status-bar-update', items: [{ id: 'sb1', sessionId: 's1' }] })
  })

  it('TC5: EXTENSION_BRIDGE_TYPES 字面量 5 项 + 每项行为级验证（进 bridge 产出非 error 事件）', () => {
    // 字面量锁：EXTENSION_BRIDGE_TYPES 已是 core SSOT（派生自 EXTENSION_HANDLERS keys），
    // 锁 5 项防 handlers 增删时白名单悄悄漂移（消费方 source filter 行为随之变化无信号）
    expect(EXTENSION_BRIDGE_TYPES).toEqual([
      'extension:widget',
      'extension:widgetGui',
      'extension:status',
      'extension:notify',
      'extension.ui_request',
    ])

    // 行为级一致性：白名单每项经全链路都产出对应 kind 事件（非 kind=error）。
    // samples 的 type 是宽泛 string，无法静态收窄到 ServerMessage union 成员，做受控擦除
    // （运行时 tap emit 只按 type 路由 + 透传 payload，形状正确性由 core parser 校验）。
    const samples: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: 'extension:widget', payload: { sessionId: 's1', widgetKey: 'w1', lines: ['line'] } },
      { type: 'extension:widgetGui', payload: { sessionId: 's1', widgetKey: 'w1', gui: ['g'] } },
      { type: 'extension:status', payload: { sessionId: 's1', statusKey: 'k', text: 'ready' } },
      { type: 'extension:notify', payload: { sessionId: 's1', message: 'hi', level: 'info' } },
      { type: 'extension.ui_request', payload: { sessionId: 's1', requestId: 'r1', method: 'select' } },
    ]
    for (const s of samples) {
      const { bus, bridge: b } = makeBridge()
      bridge = b
      const { emitted } = spyEmit(bus)
      dispatchCrossSession({ type: s.type, payload: s.payload } as never)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].kind).not.toBe('error')
    }
  })
})

describe('initExtensionHostBridge provide CompanionBand 契约（FR2/FR7，TC10）', () => {
  let bridge: MessageBusBridge | null = null

  afterEach(() => {
    bridge?.dispose()
    bridge = null
  })

  it('TC10: provide DIALOG_REQUEST_SOURCE_KEY + UI_RESPONSE_TRANSPORT_KEY（形状正确）', () => {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }

    initExtensionHostBridge(app as never)
    const result = __testing.lastInitHandles
    if (!result) throw new Error('initExtensionHostBridge 未写入 __testing.lastInitHandles')
    bridge = result.bridge
    void simulateBootstrapRegistration()

    const sourceProvided = provided.find((p) => p.key === DIALOG_REQUEST_SOURCE_KEY)
    const transportProvided = provided.find((p) => p.key === UI_RESPONSE_TRANSPORT_KEY)

    expect(sourceProvided).toBeDefined()
    const source = sourceProvided?.value as { onUiRequest: unknown; onUiRequestExpired: unknown }
    expect(typeof source.onUiRequest).toBe('function')
    expect(typeof source.onUiRequestExpired).toBe('function')

    expect(transportProvided).toBeDefined()
    const transport = transportProvided?.value as { sendPiResponse: unknown; sendPluginResponse: unknown }
    expect(typeof transport.sendPiResponse).toBe('function')
    expect(typeof transport.sendPluginResponse).toBe('function')
  })
})

describe('MF-2 响应式桥（分区后建时序 + global scope）', () => {
  let bridge: MessageBusBridge | null = null

  afterEach(() => {
    bridge?.dispose()
    bridge = null
  })

  /** 装配真实 bridge 链（events → source → bus → store → provide），返回注入的数据源。 */
  function initBridgeSources(): {
    viewHostSource: ViewHostSource
    statusBarSource: StatusBarSource
    viewsSource: PluginViewsSource
    contributions: ContributionRegistry
  } {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }
    initExtensionHostBridge(app as never)
    const handles = __testing.lastInitHandles
    if (!handles) throw new Error('initExtensionHostBridge 未写入 __testing.lastInitHandles')
    bridge = handles.bridge
    void simulateBootstrapRegistration()
    const viewHostSource = provided.find((p) => p.key === VIEW_HOST_SOURCE_KEY)?.value as ViewHostSource
    const statusBarSource = provided.find((p) => p.key === STATUS_BAR_SOURCE_KEY)?.value as StatusBarSource
    const viewsSource = provided.find((p) => p.key === VIEWS_SOURCE_KEY)?.value as PluginViewsSource
    return { viewHostSource, statusBarSource, viewsSource, contributions: handles.contributions }
  }

  it('case B: 分区后建时序——computed 首次求值无分区，首个 viewUpdate 到达后重算命中', async () => {
    const { viewHostSource } = initBridgeSources()
    // 模拟 ViewHost.vue 的 computed 读路径：先于任何事件求值（分区尚不存在 → 短路 undefined）
    const view = computed(() => viewHostSource.getView('s1', 'sidebar.tab'))
    expect(view.value).toBeUndefined()

    // 首个 viewUpdate 到达 → ViewHostStore 惰性建分区 + setView（R1 修复前外层普通 Map，
    // set 不触发 → 此 computed 永久 stale，panel.header 常挂组件时序直接命中）
    dispatchCrossSession({
      type: 'plugin:viewUpdate',
      payload: {
        sessionId: 's1',
        viewId: 'sidebar.tab',
        pluginId: 'p1',
        guiTree: [{ type: 'ansi-text', props: { lines: ['hello'] } }],
        updatedAt: 1,
      },
    })
    await nextTick()
    expect(view.value).toMatchObject({ viewId: 'sidebar.tab', pluginId: 'p1' })
  })

  it('global scope: statusBarUpdate 广播 → getItems("global") computed 重算（不再 stale）', async () => {
    const { statusBarSource } = initBridgeSources()
    // 模拟 StatusBar.vue 的 visibleItems computed：global 项读路径
    const items = computed(() => statusBarSource.getItems('global'))
    expect(items.value).toHaveLength(0)

    dispatchGlobal({
      type: 'plugin:statusBarUpdate',
      payload: {
        items: [{ id: 'g1', pluginId: 'statusline', text: '3 tasks', alignment: 'left', priority: 100, scope: 'global' }],
      },
    })
    await nextTick()
    // R1 前：controller 私有 raw 数组 replaceAllWith 原地 mutate 不经 proxy → 永不更新
    expect(items.value.map((i) => i.id)).toEqual(['g1'])
  })

  it('TC7 (M17): extension:widgetGui 帧 → provide 的 getViewIds 纯透传 ViewHostStore 枚举', async () => {
    const { viewHostSource } = initBridgeSources()
    // 初始该 session 无 widget：枚举为空
    expect(viewHostSource.getViewIds('s1')).toEqual([])

    // 经 bridge 的 WS 消息源推一条 extension:widgetGui（widgetKey=todo + 合法 GuiComponent）：
    // events crossSession 通道 → source filter（白名单）→ MessageBusBridge 归一
    // extension-widget（viewId←widgetKey）→ ViewHostStore setView
    dispatchCrossSession({
      type: 'extension:widgetGui',
      payload: {
        sessionId: 's1',
        widgetKey: 'todo',
        gui: { type: 'ansi-text', props: { lines: ['buy milk'] } },
      },
    })
    await nextTick()

    // provide 出的 getViewIds 返回该 widget 的 viewId（widgetKey 裸值），与 store 一致
    expect(viewHostSource.getViewIds('s1')).toEqual(['todo'])
    // 枚举出的 id 可经同一 source.getView 查到缓存条目（透传链路自洽）
    expect(viewHostSource.getView('s1', 'todo')).toMatchObject({ viewId: 'todo', pluginId: '' })

    // 其他 session 分区不受污染
    expect(viewHostSource.getViewIds('s2')).toEqual([])
  })

  it('M17w2-TC1: getViews 纯静态——extension:widgetGui 推送后不出现动态 view（getViewIds 对照仍含）', async () => {
    const { viewHostSource, viewsSource } = initBridgeSources()
    // 初始静态清单 = builtin 的 sidebar.tab view 声明（该视图退役后恒空），
    // 不含任何 widget 动态项
    expect(viewsSource.getViews('s1').map((v) => v.viewId)).toEqual([])

    // 推帧模式复用 TC7：events crossSession 通道 → source filter → bridge 归一 → ViewHostStore setView
    dispatchCrossSession({
      type: 'extension:widgetGui',
      payload: {
        sessionId: 's1',
        widgetKey: 'goal',
        gui: { type: 'ansi-text', props: { lines: ['goal: ship it'] } },
      },
    })
    await nextTick()

    // sidebar L2 tab 数据源纯静态（D5：M2 动态发现废弃）——widget 推送不进 getViews
    expect(viewsSource.getViews('s1').map((v) => v.viewId)).toEqual([])
    expect(viewsSource.getViews('s1').map((v) => v.viewId)).not.toContain('goal')
    // 对照断言：ViewHost 枚举（Composer 托盘 widget 区消费面）不受影响，仍含该 widgetKey
    expect(viewHostSource.getViewIds('s1')).toEqual(['goal'])
  })

  it('M17w2-TC2: 静态声明 view（sidebar.tab 贡献）照常出现在 getViews', () => {
    const { viewsSource, contributions } = initBridgeSources()
    expect(viewsSource.getViews('s1').map((v) => v.viewId)).toEqual([])

    // 经 bridge 返回的 contributions.registerContribution（contribution-registry public API）
    // 注入一条 sidebar.tab view 静态声明（形状对齐 parseContributes 的 view 分支）
    contributions.registerContribution({
      pluginId: 'demo-plugin',
      contributionId: 'demo-view',
      type: 'view',
      placement: 'sidebar.tab',
      available: false,
      view: { viewType: 'gui', title: 'Demo', initialVisibility: 'hidden' },
    })

    // 静态映射路径被真实覆盖（防止移除动态段时改坏 staticViews 映射零报警）
    expect(viewsSource.getViews('s1').map((v) => v.viewId)).toEqual(['demo-view'])
    expect(viewsSource.getViews('s1')[0]).toMatchObject({
      viewId: 'demo-view',
      title: 'Demo',
      pluginId: 'demo-plugin',
      initialVisibility: 'hidden',
    })

    // placement 过滤保持：非 sidebar.tab 的 view 声明不进清单
    contributions.registerContribution({
      pluginId: 'demo-plugin',
      contributionId: 'panel-view',
      type: 'view',
      placement: 'panel.header',
      available: false,
      view: { viewType: 'gui', title: 'Panel', initialVisibility: 'hidden' },
    })
    expect(viewsSource.getViews('s1').map((v) => v.viewId)).toEqual(['demo-view'])
  })
})

describe('MF-1 挂载点上报时序（mountPoints.sync 连接就绪后发送）', () => {
  let bridge: MessageBusBridge | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    transportSendSpy.mockClear()
    providePlatform(createMockPlatform())
  })

  afterEach(() => {
    bridge?.dispose()
    bridge = null
    disconnect() // 复位 ws-client 状态（防泄漏到后续用例）
    vi.useRealTimers()
  })

  function initBridge() {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }
    initExtensionHostBridge(app as never)
    const handles = __testing.lastInitHandles
    if (!handles) throw new Error('initExtensionHostBridge 未写入 __testing.lastInitHandles')
    bridge = handles.bridge
    // 装配后补 bootstrap step 4 前置（见 simulateBootstrapRegistration 注释）——本组用例
    // 焦点是「已注册挂载点在 connected 时补发」的上报时序，非注册本身。注册不发 send，
    // 不影响「未连接不发送」断言。
    void simulateBootstrapRegistration()
  }

  it('TC11: 初始未连接不发送；首次建连进入 connected 后补发全量挂载点', async () => {
    initBridge()

    // init 时 WS 未建连（main.ts 模块体同步执行先于 App.vue onMounted 建连）：不得发送
    // （旧实现此处 send 被 ws-client 非 OPEN return false 静默丢弃）
    expect(transportSendSpy).not.toHaveBeenCalled()

    connect('mock://extension-host-test')
    await vi.advanceTimersByTimeAsync(200) // mock WS connecting→connected（200ms）

    expect(transportSendSpy).toHaveBeenCalledTimes(1)
    expect(transportSendSpy).toHaveBeenCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'statusbar', 'modal'] },
    })
  })

  it('TC12: runtime 重启重连（断开→重连）→ connected 再次补发（overwrite 幂等）', async () => {
    initBridge()

    connect('mock://extension-host-test')
    await vi.advanceTimersByTimeAsync(200)
    expect(transportSendSpy).toHaveBeenCalledTimes(1)

    // runtime 重启：旧 WS 断开 → 重连 → 再次 connected → 补发（syncMountPoints overwrite 幂等）
    disconnect()
    expect(transportSendSpy).toHaveBeenCalledTimes(1)
    connect('mock://extension-host-test')
    await vi.advanceTimersByTimeAsync(200)

    expect(transportSendSpy).toHaveBeenCalledTimes(2)
    expect(transportSendSpy).toHaveBeenLastCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'statusbar', 'modal'] },
    })
  })
})
