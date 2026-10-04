// @vitest-environment node

/**
 * useExtensionHostBridge.test.ts —— ExtensionHost renderer 接线装配单测。
 *
 * createWsPluginMessageSource 过滤条件与 CompanionBand dialog 适配（source/transport
 * 工厂）的用例已随实现下沉 @taiji/ui/extension-host shell-adapters.test.ts（双壳共享件，
 * remote-use 架构审查裁决）；本文件聚焦壳侧装配：provide 契约 + MF-2 响应式桥 +
 * MF-1 挂载点上报时序。
 *
 * 链路：events.dispatchCrossSession（模拟 route-inbound crossSession 通道分发）→ source →
 * MessageBusBridge → bus。经 events 正规通道全链路验证（ADR-0060：source 双订阅 onGlobal +
 * onCrossSession，crossSession 通道注入可触发 source adapt，与 global 等价）。
 * M17 追加：TC7 VIEW_HOST_SOURCE_KEY provide 值的 getViewIds 纯透传
 * （extension:widgetGui 帧 → ViewHostStore → provide 枚举一致）。
 * M17 wave2 追加（D5：废弃 sidebar 动态 view 发现，getViews 纯静态）：
 * M17w2-TC1 widget 推送不进 L2 tab 清单（getViewIds 对照仍含）/
 * M17w2-TC2 静态声明 view 经 registerContribution 出现在 getViews。
 * R2-2 追加：TC13 重复 init 后重放器上报新实例快照（dispose-and-rebuild 防回归）；全部
 * describe 的 afterEach 经 __testing.lastInitHandles.dispose 统一回收（bridge + 两个重放器
 * watcher），消除旧实现「watcher 永绑首次 init 实例」的跨用例残留耦合。
 * u4b 追加（test-coverage SG-2 补防线）：E13 四态判定 resolveHeaderActionAvailability
 * 纯函数直测（store 命中 / registry 命中 / unregistered / unknown 四态）+
 * E3 executeCommand 语义 wiring 测试（缺失命令 → execute 出声 + 返 false 供置灰）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, nextTick } from 'vue'
import { InternalEventBus, MessageBusBridge, providePlatform, registerMountPoints, scanContributions, type ContributionRegistry, ActivationManager, CommandRegistry } from '@taiji/core'
import { dispatchCrossSession, dispatchGlobal } from '@taiji/core/transport/api'
import {
  getExtensionBus,
  initExtensionHostBridge,
  resolveHeaderActionAvailability,
  HEADER_ACTIONS_SOURCE_KEY,
  __testing,
  type CommandPartitionReader,
  type HeaderActionsSource,
} from '../useExtensionHostBridge'
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
 * setExtensionRegistries 最新注入的实例（幂等）；重放器 watcher 随 init dispose-and-rebuild
 * （R2-2）闭包绑定当次装配的实例——各装配点补注册后 list() 即为全量挂载点，用例间无跨实例
 * 残留依赖。step 5 scanContributions（registerBuiltin）在 D4① 后必须补：
 * viewsSource.getViews 消费 builtin 的 sidebar.tab view 声明（该 native 视图退役后
 * builtin 零 view 声明——本组用例经 external 注册路径覆盖 getViews 映射，见 M17w2-TC2）。
 * 两步骤实现体均为纯同步（async 仅是 bootstrap 编排签名，体内无 await）——调用即完成
 * 注册，同步用例（TC1/TC2 的 getViews 断言）无需 await 即读到注册后的 registry。
 */
async function simulateBootstrapRegistration(): Promise<void> {
  await Promise.all([registerMountPoints(), scanContributions()])
}

/** afterEach 统一回收最近一次装配（bridge + 两个重放器 watcher；R2-2 消除跨用例残留耦合） */
function disposeLastInit(): void {
  __testing.lastInitHandles?.dispose()
  __testing.lastInitHandles = null
}

describe('initExtensionHostBridge provide CompanionBand 契约（FR2/FR7，TC10）', () => {
  afterEach(disposeLastInit)

  it('TC10: provide DIALOG_REQUEST_SOURCE_KEY + UI_RESPONSE_TRANSPORT_KEY（形状正确）', () => {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }

    initExtensionHostBridge(app as never)
    if (!__testing.lastInitHandles) throw new Error('initExtensionHostBridge 未写入 __testing.lastInitHandles')
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
  afterEach(disposeLastInit)

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
  beforeEach(() => {
    vi.useFakeTimers()
    transportSendSpy.mockClear()
    providePlatform(createMockPlatform())
  })

  afterEach(() => {
    disposeLastInit()
    disconnect() // 复位 ws-client 状态（防泄漏到后续用例）
    vi.useRealTimers()
  })

  function initBridge(options?: { register?: boolean }) {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }
    initExtensionHostBridge(app as never)
    if (!__testing.lastInitHandles) throw new Error('initExtensionHostBridge 未写入 __testing.lastInitHandles')
    // 装配后补 bootstrap step 4 前置（见 simulateBootstrapRegistration 注释）——本组用例
    // 焦点是「已注册挂载点在 connected 时补发」的上报时序，非注册本身。注册不发 send，
    // 不影响「未连接不发送」断言。register:false 供 TC13 区分新旧实例快照（新实例空表）。
    if (options?.register !== false) void simulateBootstrapRegistration()
  }

  it('TC11: 初始未连接不发送；首次建连进入 connected 后补发全量挂载点', async () => {
    initBridge()

    // init 时 WS 未建连（main.ts 模块体同步执行先于 App.vue onMounted 建连）：不得发送
    // （旧实现此处 send 被 ws-client 非 OPEN return false 静默丢弃）
    expect(transportSendSpy).not.toHaveBeenCalled()

    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200) // mock WS connecting→connected（200ms）

    expect(transportSendSpy).toHaveBeenCalledTimes(1)
    expect(transportSendSpy).toHaveBeenCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'statusbar', 'modal'] },
    })
  })

  it('TC12: runtime 重启重连（断开→重连）→ connected 再次补发（overwrite 幂等）', async () => {
    initBridge()

    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)
    expect(transportSendSpy).toHaveBeenCalledTimes(1)

    // runtime 重启：旧 WS 断开 → 重连 → 再次 connected → 补发（syncMountPoints overwrite 幂等）
    disconnect()
    expect(transportSendSpy).toHaveBeenCalledTimes(1)
    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)

    expect(transportSendSpy).toHaveBeenCalledTimes(2)
    expect(transportSendSpy).toHaveBeenLastCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'statusbar', 'modal'] },
    })
  })

  it('TC13 (R2-2): 重复 init 后重放器上报新实例快照（dispose-and-rebuild 防回归）', async () => {
    // 第一次 init（含注册）→ 建连 → watcher 上报实例 1 全量快照
    initBridge()
    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)
    expect(transportSendSpy).toHaveBeenCalledTimes(1)

    // 重复 init：dispose-and-rebuild 使新 watcher 绑定新 registry 实例（setExtensionRegistries
    // 已换新）。register:false 使新实例快照为空表——若退回模块级布尔守卫（watcher 永久闭包
    // 绑定第一次 init 的实例），此处上报的是实例 1 残留快照（5 个挂载点），空表断言即红。
    initBridge({ register: false })
    // 已 connected → 新 watcher immediate 同步补发（无需推进 timer）
    expect(transportSendSpy).toHaveBeenCalledTimes(2)
    expect(transportSendSpy).toHaveBeenLastCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: [] },
    })

    // 新实例补注册后重连 → 重放器对新实例照常工作（上报其全量快照）
    await simulateBootstrapRegistration()
    disconnect()
    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)
    expect(transportSendSpy).toHaveBeenCalledTimes(3)
    expect(transportSendSpy).toHaveBeenLastCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'statusbar', 'modal'] },
    })
  })
})

describe('u4b E13 四态判定 resolveHeaderActionAvailability（纯函数直测，test-coverage SG-2）', () => {
  /** 独立 CommandRegistry（无激活声明 → ensureActivated 恒 no-op，对齐生产 trigger 适配） */
  function makeRegistry(commandIds: string[]): CommandRegistry {
    const registry = new CommandRegistry({
      bus: new InternalEventBus(),
      activationManager: new ActivationManager({ trigger: { ensureActivated: async () => {} } }),
      executor: { execute: async () => {} },
    })
    for (const id of commandIds) registry.registerCommand({ id, title: id, pluginId: 'demo-plugin' })
    return registry
  }

  /** 会话命令分区读取面 stub（E13 只消费 getCommands，结构契约见 CommandPartitionReader） */
  const readerOf = (names: string[]): CommandPartitionReader => ({
    getCommands: () => names.map((name) => ({ name })),
  })

  it('① 会话命令分区命中 → registered（pi getCommands 产物主路径）', () => {
    expect(resolveHeaderActionAvailability(readerOf(['pi.cmd', 'other']), makeRegistry([]), 's1', 'pi.cmd'))
      .toBe('registered')
  })

  it('② 分区未命中但 CommandRegistry 命中 → registered（scheduler-manager.open 主路径——其命令名非 pi slash 命令）', () => {
    expect(resolveHeaderActionAvailability(readerOf(['other']), makeRegistry(['scheduler-manager.open']), 's1', 'scheduler-manager.open'))
      .toBe('registered')
  })

  it('③ 分区非空但两源皆无 → unregistered（E2 禁用清理后灰置的主路径）', () => {
    expect(resolveHeaderActionAvailability(readerOf(['other']), makeRegistry([]), 's1', 'gone.open'))
      .toBe('unregistered')
  })

  it('④ 分区为空 → unknown（未拉取/恢复窗口的保守判定，不拦入口）', () => {
    expect(resolveHeaderActionAvailability(readerOf([]), makeRegistry([]), 's1', 'any.open'))
      .toBe('unknown')
  })
})

describe('u4b E3 executeCommand 语义（HeaderActionsSource wiring，test-coverage SG-2）', () => {
  let bridge: MessageBusBridge | null = null

  afterEach(() => {
    bridge?.dispose()
    bridge = null
  })

  /** 装配真实 bridge，取 HEADER_ACTIONS_SOURCE_KEY provide 值（error 出声走 shared bus） */
  function initHeaderActionsSource(): HeaderActionsSource {
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
    const source = provided.find((p) => p.key === HEADER_ACTIONS_SOURCE_KEY)?.value as
      | HeaderActionsSource
      | undefined
    if (!source) throw new Error('HEADER_ACTIONS_SOURCE_KEY 未 provide')
    return source
  }

  it('缺失命令：execute 仍发起且 ERR6 error 事件出声 + 返回 false 供组件置灰（禁静默 no-op）', () => {
    const source = initHeaderActionsSource()

    const errors: Array<{ source: string; message: string }> = []
    const off = getExtensionBus().on('error', (e) => errors.push({ source: e.source, message: e.message }))

    expect(source.executeCommand('missing.open')).toBe(false)
    // ERR6 出声：CommandRegistry.execute 内部 emit error 事件（不静默丢弃）
    expect(errors).toEqual([{ source: 'CommandRegistry', message: 'command not found: missing.open' }])
    off()
  })

  it('已注册命令：返回 true + 无 error 事件（置灰解除）', () => {
    const source = initHeaderActionsSource()
    const handles = __testing.lastInitHandles!
    const errors: Array<{ source: string; message: string }> = []
    const off = getExtensionBus().on('error', (e) => errors.push({ source: e.source, message: e.message }))

    // 经 external 声明 + plugin-status-change active 重放注册（handlePluginBack 路径）
    handles.contributions.registerContribution({
      pluginId: 'demo-plugin',
      contributionId: 'demo.open',
      type: 'command',
      placement: 'panel.header',
      available: false,
      command: { title: 'Demo' },
    })
    getExtensionBus().emit({ kind: 'plugin-status-change', pluginId: 'demo-plugin', status: 'active' })

    expect(source.executeCommand('demo.open')).toBe(true)
    expect(errors).toEqual([])
    off()
  })
})
