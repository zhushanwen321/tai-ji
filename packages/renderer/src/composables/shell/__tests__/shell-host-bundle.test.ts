// @vitest-environment node

/**
 * shell 壳层 + effects 边界合并产物（round 6 renderer 测试压缩）：五文件同产物，
 * 环境统一 node（原五文件均 node；纯 pinia/bus 逻辑无 DOM 依赖）。
 *
 * 并入来源（基名）：
 *  - shell/notify-toast（extension notify 壳层编排 + 前台/后台分级，15 例）
 *  - shell/usePermissionRequest（桌面壳装配薄接线 smoke，3 例）
 *  - shell/useExtensionHostBridge（ExtensionHost renderer 接线装配，29 例）
 *  - effects/useSessionStreamSync-boundary（w2 边界验证真链路端到端，5 例）
 *  - shell/settings-transport-adapter（@/api 门面八元转发矩阵 + V8 + discover guard，6 例）
 *
 * mock 注册与互斥核查：
 *  - notify-toast / boundary 零 store mock（真 Pinia store 链）；boundary mock '@/api'
 *    为 spread actual 仅覆写 chat.streamSubscribe（桥接 events.on 还原真实链路），门面其余
 *    域真成员保留——notify-toast 的 session/chat store 装配链不受截断。
 *  - usePermissionRequest 与 useExtensionHostBridge 原各自 mock plugin domain（前者砍成员
 *    工厂、后者 spread + 覆写 getPluginUiSnapshot）——同 spec 双工厂统一为 spread 版 +
 *    approvePermissions/denyPermissions（闭包转发 spy，permission 节用）与 getPluginUiSnapshot
 *    （inject 注入，bridge 节用）；两节互不消费对方覆写成员。
 *  - useExtensionHostBridge mock ws-client（spread actual 仅覆写 send）——真 connect/disconnect/
 *    getState 保留（TC11/TC12 真建连依赖）；其余节不消费 ws-client.send。
 *  - useExtensionHostBridge 真消费 '@taiji/core/transport/mock/mock-ws' 的 createMockPlatform
 *    （providePlatform(createMockPlatform())）——本产物不 mock mock-ws（useSettingsShell 的
 *    mock-ws mock 与此结构性互斥，该文件保留独立）。
 *  - settings-transport-adapter 节经 vi.doMock + vi.resetModules + 动态 import 自管模块图
 *    （afterEach 已下沉进各 describe），不与文件级 vi.mock 冲突；其动态 import '../settings-
 *    transport-adapter' 命中 boundary 的 '@/api' 文件级 mock 时拿到 spread 门面（真成员保留），
 *    V8 节 mock fixture 断言经真门面 mock 分支（vitest.config env VITE_MOCK=true）成立。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/composables/shell/__tests__/shell-host-bundle.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, nextTick, shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import {
  InternalEventBus,
  MessageBusBridge,
  providePlatform,
  registerMountPoints,
  scanContributions,
  type ContributionRegistry,
  ActivationManager,
  CommandRegistry,
  type ContributionRecord,
  type HeaderActionEntry,
} from '@taiji/core'
import { dispatchCrossSession } from '@taiji/core/transport/api'
import type {
  Message,
  SessionGroup,
  SessionSummary,
  ServerMessage,
} from '@taiji/shared'
import type { SettingsTransport, DiscoverModelsRequest } from '@taiji/core/domain/settings'
import type {
  LlmRetryConfig,
  NetworkProxyConfig,
  PiLaunchPreset,
  ProviderId,
  ProviderSource,
  QuotaConfigurePayload,
  RenameMode,
  RenameStyle,
  RetryableErrorRule,
  SetProviderData,
  SkillDirConfig,
  SystemPromptConfig,
  TerminalConfig,
} from '@taiji/shared'
import { apiConfigDomainMock } from '@/__tests__/helpers/api-facade-mock'
import { useSessionStore } from '@/stores/session'
import { useChatStore } from '@/stores/chat'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useToast } from '@/composables/useToast'
import { buildSessionLocator, shouldShowSessionNotify, createNotifyToastHandler } from '../notify-toast'
import { initPermissionRequest, usePermissionRequest } from '../usePermissionRequest'
import { PERMISSION_TRANSPORT_KEY, type PermissionTransport } from '@taiji/ui/extension-host'
import {
  getExtensionBus,
  initExtensionHostBridge,
  applyUiSnapshot,
  hasVisibleHeaderActions,
  isVisibleHeaderAction,
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
  VIEWS_SOURCE_KEY,
  type ViewHostSource,
  type PluginViewsSource,
} from '@taiji/ui/extension-host'
import { connect, disconnect } from '@taiji/core/transport/ws-client'
import { createMockPlatform } from '@taiji/core/transport/mock/mock-ws'
import { bindSessionStreamSync, diffSessionList } from '../../effects/useSessionStreamSync'
import {
  ensureStreamSubscription,
  resetChatModuleState,
} from '@/composables/features/chat/useChat'
import { deriveStatus } from '@/composables/logic/sessionStatus'

// ── useExtensionHostBridge 节的 ws-client mock（spread actual 仅覆写 send）──
// MF-4 断言 mountPoints.sync 发送（真实 send 在单测环境不可观测）。D5 后 bridge 直连
// core ws-client——mock 须拦截该模块本身；importOriginal 保留真实 connect/disconnect/
// getState（TC11/TC12 建连 + watch connected 依赖真实状态机）。
const transportSendSpy = vi.fn()
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    send: (...args: unknown[]) => transportSendSpy(...args),
  }
})

// ── plugin domain 统一 mock（usePermissionRequest + useExtensionHostBridge 双工厂归一）──
// spread actual 保留全部真成员；approvePermissions/denyPermissions 为 permission 节的
// 闭包转发 spy（TC1 断言 + 可控回包），getPluginUiSnapshot 为 bridge 节快照补拉注入口。
const approvePermissionsSpy = vi.fn()
const pluginDomain = vi.hoisted(() => ({
  inject: null as null | ((filter: Record<string, unknown>) => Promise<unknown>),
}))
vi.mock('@taiji/core/transport/api/domains/plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/plugin')>()
  return {
    ...actual,
    approvePermissions: (...args: unknown[]) => approvePermissionsSpy(...args),
    denyPermissions: () => Promise.resolve(),
    getPluginUiSnapshot: (filter?: Record<string, unknown>) =>
      pluginDomain.inject ? pluginDomain.inject(filter ?? {}) : actual.getPluginUiSnapshot(filter ?? {}),
  }
})

// ── boundary 节的 @/api mock（spread actual 仅覆写 chat.streamSubscribe）──
// vitest.config.ts 设 VITE_MOCK=true，导致 @/api 门面把 chat 切到 mock 门面
// （mock/index.ts 的 streamSubscribe 写入独立的 streamHandlers Map，与真实
// events.sessionHandlers 完全脱节）。真实链路（api/domains/chat.ts:117-122）下
// streamSubscribe 即 events.on。此处桥接以还原规格约定的「streamSubscribe 底层是 events.on」，
// 让 ensureStreamSubscription → events.on → dispatchSession 投递真实贯通。
// 其余 api（session/config/...）保留 actual 实现，最大程度端到端（notify-toast 的
// store 装配链消费门面真成员，不受截断）。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    chat: {
      ...actual.chat,
      streamSubscribe: (sid: string, handler: (msg: ServerMessage) => void) =>
        eventsBridge.on(sid, handler),
    },
  }
})

// boundary 工厂引用的 events 桥接（闭包经函数惰性解析，工厂求值时不需要已初始化的绑定）
import * as eventsBridge from '@taiji/core/transport/api'
import * as events from '@taiji/core/transport/api'

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：shell/notify-toast
// ─────────────────────────────────────────────────────────────────────────────

/** 最小 SessionSummary（buildSessionLocator 只读 id/label/cwd） */
function summary(id: string, label: string, cwd: string): SessionGroup['sessions'][number] {
  return {
    id,
    label,
    cwd,
    status: 'idle',
    lastActiveAt: 0,
  }
}

function userMessage(text: string): Message {
  return {
    id: 'msg-1',
    role: 'user',
    content: text,
    status: 'complete',
    timestamp: 0,
  }
}

/** 填 session 列表（整表快照形态，对齐 runtime config.sessions 广播） */
function seedSessions(sessions: SessionGroup['sessions'][number][]): void {
  useSessionStore().applySnapshot({
    groups: [{ cwd: '/tmp/group', sessions }],
  })
}

/** 填 chat 分区（模拟首条 user prompt 已进对话流） */
function seedUserPrompt(sessionId: string, text: string): void {
  useChatStore().messages.set(sessionId, shallowRef([userMessage(text)]))
}

describe('buildSessionLocator 定位行组装', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('显式 label → `label · 目录名`', () => {
    seedSessions([summary('s1', '修通知组件', '/Users/z/Code/taiji')])
    expect(buildSessionLocator('s1')).toBe('修通知组件 · taiji')
  })

  it('派生 label（= basename）+ prompt 存在 → `prompt 前 15 字 · 目录名`', () => {
    seedSessions([summary('s2', 'taiji', '/Users/z/Code/taiji')])
    seedUserPrompt('s2', '帮我优化右下角的通知组件显示')
    expect(buildSessionLocator('s2')).toBe('帮我优化右下角的通知组件显示 · taiji')
  })

  it('prompt 超 15 字截断；多空白折叠为单空格', () => {
    seedSessions([summary('s3', 'repo', '/Users/z/Code/repo')])
    seedUserPrompt('s3', '这是一个  超长的\n用户提示词需要被截断到十五个字符以内才对')
    expect(buildSessionLocator('s3')).toBe('这是一个 超长的 用户提示词需 · repo')
  })

  it('派生 label + 无 prompt（分区缺失）→ 只显示目录名', () => {
    seedSessions([summary('s4', 'repo', '/Users/z/Code/repo')])
    expect(buildSessionLocator('s4')).toBe('repo')
  })

  it('session 不在 store → null（退化纯消息，不渲染定位行）', () => {
    seedSessions([])
    expect(buildSessionLocator('unknown')).toBeNull()
  })

  it('sessionId 缺失 → null', () => {
    expect(buildSessionLocator(undefined)).toBeNull()
  })

  it('Windows 风格路径分隔符也取最后段', () => {
    seedSessions([summary('s5', 'repo', 'C:\\Users\\z\\Code\\repo')])
    expect(buildSessionLocator('s5')).toBe('repo')
  })
})

describe('shouldShowSessionNotify 前台/后台分级', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    seedSessions([summary('bg', 'repo', '/tmp/repo'), summary('fg', 'repo', '/tmp/repo')])
    usePanelStore().loadSession(ROOT_PANEL_ID, 'fg')
  })

  it('无 sessionId → 照弹（全局事件保守不丢）', () => {
    expect(shouldShowSessionNotify(undefined, 'info')).toBe(true)
    expect(shouldShowSessionNotify(undefined, undefined)).toBe(true)
  })

  it('error / warning / warn → 无论前后台都弹', () => {
    expect(shouldShowSessionNotify('bg', 'error')).toBe(true)
    expect(shouldShowSessionNotify('bg', 'warning')).toBe(true)
    expect(shouldShowSessionNotify('bg', 'warn')).toBe(true)
  })

  it('info + 前台（focused）→ 弹（命令回显唯一反馈通道）', () => {
    expect(shouldShowSessionNotify('fg', 'info')).toBe(true)
  })

  it('info + 后台 → 丢弃（goal start/budget70 等过程噪音）', () => {
    expect(shouldShowSessionNotify('bg', 'info')).toBe(false)
  })
})

describe('createNotifyToastHandler 装配（真实 useToast 入口）', () => {
  /** toast 模块单例是跨用例共享状态，取末条断言 + 用后清空 */
  const { toasts, remove } = useToast()

  function lastToast() {
    return toasts.value[toasts.value.length - 1]
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    seedSessions([summary('bg', '修通知', '/tmp/repo'), summary('fg', '修通知', '/tmp/repo')])
    usePanelStore().loadSession(ROOT_PANEL_ID, 'fg')
    while (toasts.value.length > 0) remove(toasts.value[0].id)
  })

  it('error → toast type=error，sessionLabel + sessionId 双透传（定位行可渲染可跳转）', () => {
    createNotifyToastHandler()('goal blocked', 'error', 'bg')
    const t = lastToast()
    expect(t.type).toBe('error')
    expect(t.sessionLabel).toBe('修通知 · repo')
    expect(t.sessionId).toBe('bg') // 回归：曾漏传致定位行永不渲染
  })

  it('warn / warning → 归一为 warning；其余 → info', () => {
    const show = createNotifyToastHandler()
    show('w1', 'warn', 'bg')
    expect(lastToast().type).toBe('warning')
    show('w2', 'info', 'fg')
    expect(lastToast().type).toBe('info')
  })

  it('info + 后台 session → 不入列（过滤生效）', () => {
    const before = toasts.value.length
    createNotifyToastHandler()('budget 70%', 'info', 'bg')
    expect(toasts.value.length).toBe(before)
  })

  it('sessionId 非字符串 → 归一 undefined，不设 sessionId 字段（无定位行纯消息）', () => {
    createNotifyToastHandler()('plugin crashed', 'error', null)
    const t = lastToast()
    expect(t.type).toBe('error')
    expect(t.sessionId).toBeUndefined()
    expect(t.sessionLabel).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：shell/usePermissionRequest
// ─────────────────────────────────────────────────────────────────────────────

/** 通过 bus.emit 模拟 bridge 归一后的 permission 事件 */
function emitPermissionRequest(bus: InternalEventBus, pluginId = 'p1', permissions = ['shell']) {
  bus.emit({
    kind: 'plugin-permission-request',
    request: { pluginId, permissions, requestId: `perm_${pluginId}` },
  } as Parameters<InternalEventBus['emit']>[0])
}

/** 收集 app.provide 调用（对齐 useExtensionHostBridge.test.ts TC10 范式） */
function makeApp() {
  const provided: Array<{ key: unknown; value: unknown }> = []
  const app = {
    provide(key: unknown, value: unknown) {
      provided.push({ key, value })
      return app
    },
  }
  return { provided, app }
}

describe('usePermissionRequest 桌面壳装配薄接线', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    approvePermissionsSpy.mockReset()
    bus = new InternalEventBus()
  })

  it('TC0: init 前调 usePermissionRequest() → fail-fast（装配时序错误指向恢复动作，不静默返回空 state）', () => {
    expect(() => usePermissionRequest()).toThrow(/initPermissionRequest/)
  })

  it('TC1: init → provide 注入 factory transport，与 usePermissionRequest() state 同源（回传驱动收尾）', async () => {
    const { app, provided } = makeApp()
    initPermissionRequest(app as never, bus)

    // provide 契约：PERMISSION_TRANSPORT_KEY 下注入 transport
    const transport = provided.find((p) => p.key === PERMISSION_TRANSPORT_KEY)?.value as PermissionTransport

    emitPermissionRequest(bus, 'tasks', ['shell', 'fs'])
    const state = usePermissionRequest()
    expect(state.pluginId).toBe('tasks')
    expect(state.pending).toBe(true)

    // 同源验证：provide 的 transport 回传成功 → usePermissionRequest() state 收尾
    approvePermissionsSpy.mockResolvedValue(undefined)
    transport.approve('tasks', ['shell'])
    await vi.waitFor(() => expect(state.pending).toBe(false))
    expect(approvePermissionsSpy).toHaveBeenCalledWith('tasks', ['shell'])
  })

  it('TC2: 重复初始化幂等（HMR 防 listener 翻倍）：bus handler 数恒为 1', () => {
    const { app } = makeApp()

    initPermissionRequest(app as never, bus)
    initPermissionRequest(app as never, bus)

    // 白盒验证幂等本质：第二次 init 先 dispose 旧 controller（退订）再建新——
    // bus 内 plugin-permission-request 的 handler 数恒为 1（不翻倍，项目规则#2）。
    const handlers = (bus as unknown as { handlers: Map<string, Set<unknown>> }).handlers
    expect(handlers.get('plugin-permission-request')?.size).toBe(1)

    // 行为验证：事件驱动的是第二次 init 后的 state（旧 controller 已 dispose）
    emitPermissionRequest(bus)
    const state = usePermissionRequest()
    expect(state.pluginId).toBe('p1')
    expect(state.pending).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：shell/useExtensionHostBridge
// ─────────────────────────────────────────────────────────────────────────────

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
    const viewsSource = provided.find((p) => p.key === VIEWS_SOURCE_KEY)?.value as PluginViewsSource
    return { viewHostSource, viewsSource, contributions: handles.contributions }
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
    // 对照断言：ViewHost 枚举（Composer 托盘 widget 区消费方）不受影响，仍含该 widgetKey
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

  /** 按 type 过滤 send 调用（plugin.ui.snapshot 重放器与 mountPoints.sync 同为 connected
   *  触发、共享同一 send spy——本组用例只断言 mountPoints.sync 帧的时序，按帧过滤计数）。 */
  function syncCallsOf(type: string): unknown[][] {
    return transportSendSpy.mock.calls.filter((c) => (c[0] as { type?: string } | undefined)?.type === type)
  }

  it('TC11: 初始未连接不发送；首次建连进入 connected 后补发全量挂载点', async () => {
    initBridge()

    // init 时 WS 未建连（main.ts 模块体同步执行先于 App.vue onMounted 建连）：不得发送
    // （旧实现此处 send 被 ws-client 非 OPEN return false 静默丢弃）
    expect(transportSendSpy).not.toHaveBeenCalled()

    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200) // mock WS connecting→connected（200ms）

    expect(syncCallsOf('plugin.mountPoints.sync')).toHaveLength(1)
    expect(transportSendSpy).toHaveBeenCalledWith({
      type: 'plugin.mountPoints.sync',
      payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'provider.authorize', 'provider.detail-extra'] },
    })
  })

  it('TC12: runtime 重启重连（断开→重连）→ connected 再次补发（overwrite 幂等）', async () => {
    initBridge()

    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)
    expect(syncCallsOf('plugin.mountPoints.sync')).toHaveLength(1)

    // runtime 重启：旧 WS 断开 → 重连 → 再次 connected → 补发（syncMountPoints overwrite 幂等）
    disconnect()
    expect(syncCallsOf('plugin.mountPoints.sync')).toHaveLength(1)
    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)

    expect(syncCallsOf('plugin.mountPoints.sync')).toHaveLength(2)
    expect(syncCallsOf('plugin.mountPoints.sync').at(-1)).toEqual([
      { type: 'plugin.mountPoints.sync', payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'provider.authorize', 'provider.detail-extra'] } },
    ])
  })

  it('TC13 (R2-2): 重复 init 后重放器上报新实例快照（dispose-and-rebuild 防回归）', async () => {
    // 第一次 init（含注册）→ 建连 → watcher 上报实例 1 全量快照
    initBridge()
    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)
    expect(syncCallsOf('plugin.mountPoints.sync')).toHaveLength(1)

    // 重复 init：dispose-and-rebuild 使新 watcher 绑定新 registry 实例（setExtensionRegistries
    // 已换新）。register:false 使新实例快照为空表——若退回模块级布尔检查（watcher 永久闭包
    // 绑定第一次 init 的实例），此处上报的是实例 1 残留快照（5 个挂载点），空表断言即红。
    initBridge({ register: false })
    // 已 connected → 新 watcher immediate 同步补发（无需推进 timer）
    expect(syncCallsOf('plugin.mountPoints.sync')).toHaveLength(2)
    expect(syncCallsOf('plugin.mountPoints.sync').at(-1)).toEqual([
      { type: 'plugin.mountPoints.sync', payload: { mountPoints: [] } },
    ])

    // 新实例补注册后重连 → 重放器对新实例照常工作（上报其全量快照）
    await simulateBootstrapRegistration()
    disconnect()
    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)
    expect(syncCallsOf('plugin.mountPoints.sync')).toHaveLength(3)
    expect(syncCallsOf('plugin.mountPoints.sync').at(-1)).toEqual([
      { type: 'plugin.mountPoints.sync', payload: { mountPoints: ['sidebar.tab', 'panel.header', 'composer.toolbar', 'provider.authorize', 'provider.detail-extra'] } },
    ])
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

  /** 会话命令分区读侧 stub（E13 只消费 getCommands，结构契约见 CommandPartitionReader） */
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

describe('isVisibleHeaderAction（可见性谓词单点：渲染过滤与聚合判定的唯一判定源）', () => {
  const declOf = (ha: Record<string, unknown> | null): ContributionRecord => ({
    pluginId: 'demo-plugin',
    contributionId: 'c1',
    type: 'headerAction',
    headerAction: ha as ContributionRecord['headerAction'],
  })
  /** 非空运行时状态条目（缺省反转后的「已推送」形态：插件声明了入口存在） */
  const pushedEntry: HeaderActionEntry = {
    headerActionId: 'c1',
    pluginId: 'demo-plugin',
    updatedAt: 1,
  }
  const hiddenEntry: HeaderActionEntry = {
    headerActionId: 'c1',
    pluginId: 'demo-plugin',
    hidden: true,
    updatedAt: 1,
  }

  it('① 插件从未推送（undefined）→ 不可见（缺省反转：未知态 fail-safe 不渲染）；推送后 overlay 直开声明可见', () => {
    const decl = declOf({ activation: 'scheduler-overlay', icon: 'clock', title: '定时任务' })
    expect(isVisibleHeaderAction(decl, undefined)).toBe(false)
    if (isVisibleHeaderAction(decl, pushedEntry)) {
      // type predicate 收窄断言：toHeaderActionButton 依赖它免二次 !ha 判定
      expect(decl.headerAction.activation).toBe('scheduler-overlay')
    }
    expect(isVisibleHeaderAction(decl, pushedEntry)).toBe(true)
  })

  it('② 推送后命令链声明（有 commandId）可见；无 commandId 且无 activation 的声明不可见', () => {
    expect(isVisibleHeaderAction(declOf({ commandId: 'demo.open', title: 'T' }), pushedEntry)).toBe(true)
    expect(isVisibleHeaderAction(declOf({ icon: 'puzzle', title: 'T' }), pushedEntry)).toBe(false)
  })

  it('③ 运行时 hidden=true → 不可见（插件「无任务不显示」契约）；hidden=false 推送帧可见', () => {
    const decl = declOf({ activation: 'scheduler-overlay', icon: 'clock', title: '定时任务' })
    expect(isVisibleHeaderAction(decl, hiddenEntry)).toBe(false)
    expect(isVisibleHeaderAction(decl, { ...hiddenEntry, hidden: false })).toBe(true)
  })

  it('④ 声明缺省（headerAction 段为空）→ false——predicate 同时收窄掉缺省形状', () => {
    expect(isVisibleHeaderAction(declOf(null), pushedEntry)).toBe(false)
  })
})

describe('hasVisibleHeaderActions（聚合面板「有可见按钮才出段」+ 密度 absent 判据；可见性条件单点 isVisibleHeaderAction）', () => {
  /** 最小 source stub（只带可见性判定消费的三个读侧；E13/E3 面不参与可见性）。
   *  runtime: 'none' = 未推送（undefined）/ 'pushed' = 已推送非 hidden / 'hidden' = 已推送 hidden。
   *  缺省反转后未推送不可见——「可见」用例一律用 pushed 形态。 */
  function sourceOf(
    declarations: Array<{ id: string; ha: Record<string, unknown> | null }>,
    runtime: 'none' | 'pushed' | 'hidden' = 'pushed',
  ): HeaderActionsSource {
    return {
      getDeclarations: () =>
        declarations.map((d) => ({
          pluginId: 'demo-plugin',
          contributionId: d.id,
          type: 'headerAction',
          headerAction: d.ha,
        })),
      getRuntimeState: (_sid, _id) =>
        runtime === 'none'
          ? undefined
          : { headerActionId: _id, pluginId: 'demo-plugin', updatedAt: 1, ...(runtime === 'hidden' ? { hidden: true } : {}) },
      resolveCommandAvailability: () => 'registered',
      executeCommand: () => true,
    } as unknown as HeaderActionsSource
  }

  it('overlay 直开声明（无 commandId）已推送 → 可见——scheduler 定时任务钮形态', () => {
    const source = sourceOf([{ id: 'c1', ha: { activation: 'scheduler-overlay', icon: 'clock', title: '定时任务' } }])
    expect(hasVisibleHeaderActions(source, 's1')).toBe(true)
  })

  it('插件从未推送 → 不可见（缺省反转的对账位：未知态不出段）', () => {
    const source = sourceOf([{ id: 'c1', ha: { activation: 'scheduler-overlay', icon: 'clock', title: '定时任务' } }], 'none')
    expect(hasVisibleHeaderActions(source, 's1')).toBe(false)
  })

  it('推送后命令链声明（有 commandId）可见；无 commandId 且无 activation 的声明不可见', () => {
    const withCmd = sourceOf([{ id: 'c1', ha: { commandId: 'demo.open', title: 'T' } }])
    expect(hasVisibleHeaderActions(withCmd, 's1')).toBe(true)
    const bare = sourceOf([{ id: 'c1', ha: { icon: 'puzzle', title: 'T' } }])
    expect(hasVisibleHeaderActions(bare, 's1')).toBe(false)
  })

  it('运行时 hidden=true → 不可见（插件「无任务不显示」契约的对账位）', () => {
    const source = sourceOf([{ id: 'c1', ha: { activation: 'scheduler-overlay', icon: 'clock', title: '定时任务' } }], 'hidden')
    expect(hasVisibleHeaderActions(source, 's1')).toBe(false)
  })

  it('无声明 / 非本类型声明 → false', () => {
    expect(hasVisibleHeaderActions(sourceOf([]), 's1')).toBe(false)
    expect(hasVisibleHeaderActions(sourceOf([{ id: 'c1', ha: null }]), 's1')).toBe(false)
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

describe('插件 UI 快照拉取（ADR-0097 拉为主：connected 全量恢复 + ViewHost 分区缺失自举补拉）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    transportSendSpy.mockClear()
    providePlatform(createMockPlatform())
  })

  afterEach(() => {
    disposeLastInit()
    disconnect()
    vi.useRealTimers()
  })

  function initBridge(): Array<{ key: unknown; value: unknown }> {
    const provided: Array<{ key: unknown; value: unknown }> = []
    const app = {
      provide(key: unknown, value: unknown) {
        provided.push({ key, value })
        return app
      },
    }
    initExtensionHostBridge(app as never)
    return provided
  }

  it('applyUiSnapshot：快照条目按实时帧形状逐条 emit（headerAction 帧 + widget 帧带 sessionId）', () => {
    const bus = new InternalEventBus()
    const headerFrames: unknown[] = []
    const widgetFrames: Array<{ sessionId?: string; mountId?: string; viewId: string; guiTree: unknown[]; generation?: number }> = []
    bus.on('plugin:headerActionUpdate', (e) => headerFrames.push(e.headerAction))
    bus.on('extension-widget', (e) => widgetFrames.push({ sessionId: e.sessionId, mountId: e.mountId, viewId: e.widget.viewId, guiTree: e.widget.guiTree, generation: e.widget.generation }))

    applyUiSnapshot(bus, {
      headerActions: [{ pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '2' }],
      views: [{ sessionId: 's1', viewId: 'scheduler.modal', pluginId: 'scheduler-manager', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }], updatedAt: 1 }],
    })

    expect(headerFrames).toEqual([{ pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '2' }])
    expect(widgetFrames).toEqual([{ sessionId: 's1', viewId: 'scheduler.modal', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }], generation: undefined }])
  })

  it('applyUiSnapshot：全局域条目（U2）按 mountId 形态 emit + generation 透传', () => {
    const bus = new InternalEventBus()
    const widgetFrames: Array<{ sessionId?: string; mountId?: string; viewId: string; pluginId: string; generation?: number }> = []
    bus.on('extension-widget', (e) => widgetFrames.push({ sessionId: e.sessionId, mountId: e.mountId, viewId: e.widget.viewId, pluginId: e.widget.pluginId, generation: e.widget.generation }))

    applyUiSnapshot(bus, {
      headerActions: [],
      views: [
        { mountId: 'provider.authorize', viewId: 'flow', pluginId: 'plug-a', guiTree: [{ type: 'ansi-text', props: { lines: ['auth'] } }], updatedAt: 1, generation: 4 },
      ],
    })

    expect(widgetFrames).toEqual([
      { sessionId: undefined, mountId: 'provider.authorize', viewId: 'flow', pluginId: 'plug-a', generation: 4 },
    ])
  })

  it('WS connected 边沿发出无过滤全量拉取（plugin.ui.snapshot）；未连接不发送', async () => {
    initBridge()
    expect(transportSendSpy).not.toHaveBeenCalled()

    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)

    const snapshotCalls = transportSendSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string } | undefined)?.type === 'plugin.ui.snapshot',
    )
    expect(snapshotCalls).toHaveLength(1)
    // command() 附加幂等 id（createCommandId），断言只对 type + payload
    const frame = snapshotCalls[0][0] as { type: string; payload: unknown }
    expect(frame.type).toBe('plugin.ui.snapshot')
    expect(frame.payload).toEqual({})
  })

  it('refreshView（VIEW_HOST_SOURCE_KEY provide）：按 (sessionId, viewId) 过滤补拉', async () => {
    const provided = initBridge()
    const viewSource = provided.find((p) => p.key === VIEW_HOST_SOURCE_KEY)?.value as
      | { refreshView?: (sessionId: string, viewId: string) => void }
      | undefined
    expect(viewSource?.refreshView).toBeTypeOf('function')

    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)
    transportSendSpy.mockClear()

    viewSource!.refreshView!('s1', 'scheduler.modal')
    await Promise.resolve()

    const snapshotCalls = transportSendSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string } | undefined)?.type === 'plugin.ui.snapshot',
    )
    expect(snapshotCalls).toHaveLength(1)
    const frame = snapshotCalls[0][0] as { type: string; payload: unknown }
    expect(frame.type).toBe('plugin.ui.snapshot')
    expect(frame.payload).toEqual({ sessionId: 's1', viewId: 'scheduler.modal' })
  })

  it('refreshViewInScope（U2 VIEW_HOST_SOURCE_KEY provide）：全局域按 (mountId, pluginId, viewId) 过滤补拉', async () => {
    const provided = initBridge()
    const viewSource = provided.find((p) => p.key === VIEW_HOST_SOURCE_KEY)?.value as
      | { refreshViewInScope?: (scope: unknown, viewId: string) => void; getViewInScope?: unknown }
      | undefined
    expect(viewSource?.refreshViewInScope).toBeTypeOf('function')
    expect(viewSource?.getViewInScope).toBeTypeOf('function')

    connect('mock://extension-host-test', { auth: 'skip' })
    await vi.advanceTimersByTimeAsync(200)
    transportSendSpy.mockClear()

    viewSource!.refreshViewInScope!({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }, 'flow')
    await Promise.resolve()

    const snapshotCalls = transportSendSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string } | undefined)?.type === 'plugin.ui.snapshot',
    )
    expect(snapshotCalls).toHaveLength(1)
    const frame = snapshotCalls[0][0] as { type: string; payload: unknown }
    expect(frame.type).toBe('plugin.ui.snapshot')
    expect(frame.payload).toEqual({ mountId: 'provider.authorize', pluginId: 'plug-a', viewId: 'flow' })
  })

  it('refreshViewInScope 补拉回包 → applyUiSnapshot 进 bus（extension-widget 帧）；getViewInScope 读回缓存条目', async () => {
    const provided = initBridge()
    const viewSource = provided.find((p) => p.key === VIEW_HOST_SOURCE_KEY)?.value as
      | { refreshViewInScope?: (scope: unknown, viewId: string) => void; getViewInScope?: (scope: unknown, viewId: string) => unknown }
      | undefined

    // 受控回包注入：捕获补拉 filter，返回 runtime reply 形状的快照（成功分支 → applyUiSnapshot）
    const capturedFilters: Array<Record<string, unknown>> = []
    pluginDomain.inject = (filter) => {
      capturedFilters.push(filter)
      return Promise.resolve({
        headerActions: [],
        views: [
          {
            mountId: 'provider.authorize',
            viewId: 'flow',
            pluginId: 'plug-a',
            guiTree: [{ type: 'ansi-text', props: { lines: ['auth'] } }],
            updatedAt: 1,
          },
        ],
      })
    }

    const widgetFrames: Array<{ sessionId?: string; mountId?: string; viewId: string; pluginId: string }> = []
    getExtensionBus().on('extension-widget', (e) => {
      // applyUiSnapshot 帧形状：归属（sessionId ∨ mountId）在事件顶层，载荷在 e.widget
      const frame = e as { sessionId?: string; mountId?: string; widget?: { viewId: string; pluginId: string } }
      if (frame.widget) widgetFrames.push({ sessionId: frame.sessionId, mountId: frame.mountId, viewId: frame.widget.viewId, pluginId: frame.widget.pluginId })
    })

    viewSource!.refreshViewInScope!({ kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' }, 'flow')
    await vi.waitFor(() => {
      expect(widgetFrames).toHaveLength(1)
    })

    // 补拉 filter 按全局域分区键组装（U2：mountId + pluginId + viewId 三元过滤）
    expect(capturedFilters).toEqual([{ mountId: 'provider.authorize', pluginId: 'plug-a', viewId: 'flow' }])
    expect(widgetFrames[0]).toMatchObject({ mountId: 'provider.authorize', viewId: 'flow', pluginId: 'plug-a' })
    pluginDomain.inject = null

    // 读路径真调（U2 scope 联合消费面）：会话域 scope 透传 store——先经正规通道推一条
    // widget 帧（TC7 同款）建分区，再以 getViewInScope 反查（getView 纯透传，行级接线验证）
    dispatchCrossSession({
      type: 'extension:widgetGui',
      payload: {
        sessionId: 's1',
        widgetKey: 'todo',
        gui: { type: 'ansi-text', props: { lines: ['buy milk'] } },
      },
    })
    await nextTick()
    const cached = viewSource!.getViewInScope!({ kind: 'session', sessionId: 's1' }, 'todo')
    expect(cached).toMatchObject({ viewId: 'todo' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：effects/useSessionStreamSync-boundary（w2 边界验证，真链路端到端）
// ─────────────────────────────────────────────────────────────────────────────

/** 辅助：构造最小 SessionSummary（cast 补齐可选字段，测试代码可接受） */
function mkSession(id: string): SessionSummary {
  return { id, label: id, cwd: '/x', status: 'idle' } as SessionSummary
}

describe('bindSessionStreamSync 边界验证（w2）', () => {
  let pinia: ReturnType<typeof createPinia>
  let scope: ReturnType<typeof effectScope>
  let sessionStore: ReturnType<typeof useSessionStore>
  let chatStore: ReturnType<typeof useChatStore>

  beforeEach(() => {
    // 清 streamSubscriptions 模块级 Map（隔离 w1 测试残留 + 跨用例隔离）
    resetChatModuleState()
    // 抑制 chat-message-effects 的 DEV 诊断日志（message_start/complete 打印 + Error stack）
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    pinia = createPinia()
    setActivePinia(pinia)
    scope = effectScope()
    scope.run(() => {
      sessionStore = useSessionStore()
      chatStore = useChatStore()
      // 在 scope 内注册 effect（watch + onScopeDispose）
      bindSessionStreamSync()
    })
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
  })

  it('TC1: 批量 applySnapshot 整表全量替换——added/removed 各自触发，保留项不重复', () => {
    // 初始 list=[a,b,c]——appendSession 触发 watch，3 个 session 各自 ensureStreamSubscription
    sessionStore.applySnapshot({ groups: [
      { cwd: '/x', sessions: [mkSession('a'), mkSession('b'), mkSession('c')] },
    ] })

    // 验证：对 a/b/c 推 message_start，3 个 session 都应建立 streaming assistant
    // （证明 3 个都被订阅——未订阅的 sid dispatchSession 静默丢弃）
    for (const sid of ['a', 'b', 'c']) {
      events.dispatchSession(sid, {
        type: 'message.message_start',
        payload: { sessionId: sid, messageId: `m-${sid}` },
      } as ServerMessage)
    }
    expect(chatStore.getMessages('a').length).toBe(1)
    expect(chatStore.getMessages('b').length).toBe(1)
    expect(chatStore.getMessages('c').length).toBe(1)

    // applySnapshot 整表替换为 [a,d,e]（保留 a、新增 d/e、移除 b/c）
    sessionStore.applySnapshot({ groups: [
      { cwd: '/x', sessions: [mkSession('a'), mkSession('d'), mkSession('e')] },
    ] })

    // d/e 应被订阅（新 added），b/c 应被 disposeSession（messages 被清）
    events.dispatchSession('d', {
      type: 'message.message_start',
      payload: { sessionId: 'd', messageId: 'm-d' },
    } as ServerMessage)
    events.dispatchSession('e', {
      type: 'message.message_start',
      payload: { sessionId: 'e', messageId: 'm-e' },
    } as ServerMessage)
    expect(chatStore.getMessages('d').length).toBe(1)
    expect(chatStore.getMessages('e').length).toBe(1)
    // b/c 被 disposeSession 后 messages 清空（chat.ts:846 disposeSession 删 messages key）
    expect(chatStore.getMessages('b').length).toBe(0)
    expect(chatStore.getMessages('c').length).toBe(0)

    // 补强（m1）：证明 b/c 不只是 messages 被清，订阅（events.on）也真的被拆。
    // disposeSession 内部 streamSubscriptions.delete + 调 unsub（events.off）——若漏删订阅，
    // 下面 dispatch 仍会投递到 b 的旧 handler，applyMessageEvent 重新建 streaming assistant，length 变 1。
    events.dispatchSession('b', {
      type: 'message.message_start',
      payload: { sessionId: 'b', messageId: 'm-b-2' },
    } as ServerMessage)
    expect(chatStore.getMessages('b').length).toBe(0) // 订阅已拆，事件被丢弃
    events.dispatchSession('c', {
      type: 'message.message_start',
      payload: { sessionId: 'c', messageId: 'm-c-2' },
    } as ServerMessage)
    expect(chatStore.getMessages('c').length).toBe(0)
  })

  it('TC2: 从未交互 session（仅 appendSession 进 list）收 message.start+complete 后 isGenerating 翻 false', () => {
    const sid = 's-never-interacted'
    // 仅 appendSession（不调 useChat.send）——watch 自动建订阅
    sessionStore.appendSession(mkSession(sid))

    // 推 message_start 建立流式状态
    events.dispatchSession(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'm1' },
    } as ServerMessage)
    // 此时应有 streaming assistant，isGenerating 为 true
    expect(chatStore.isGenerating(sid)).toBe(true)
    const msgs = chatStore.getMessages(sid)
    expect(msgs.length).toBe(1)
    expect(msgs[0].status).toBe('streaming')
    expect(msgs[0].role).toBe('assistant')

    // 推 message.complete 收尾
    events.dispatchSession(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'stop' },
    } as ServerMessage)
    // isGenerating 翻 false，assistant status 翻 complete
    expect(chatStore.isGenerating(sid)).toBe(false)
    const finalMsgs = chatStore.getMessages(sid)
    expect(finalMsgs[0].status).toBe('complete')
  })

  it('TC3: message.complete 后 derivedStatus 从 streaming 变 done（观察者视角）', () => {
    const sid = 's-derive'
    sessionStore.appendSession(mkSession(sid))
    events.dispatchSession(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'm1' },
    } as ServerMessage)
    // message_start 后应 streaming（isActive=isGenerating=true）
    // deriveStatus 签名：(sessionId, chat, isActive, isCompacting=false, hasBackgroundWork=false, metaStatus?, hasFormOverlayPending=false)
    const statusDuring = deriveStatus(sid, chatStore, chatStore.isActive(sid))
    expect(statusDuring).toBe('streaming')

    events.dispatchSession(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'stop' },
    } as ServerMessage)
    // complete 后应 done（非 active、最后 assistant status=complete、非 error/interrupted）
    const statusAfter = deriveStatus(sid, chatStore, chatStore.isActive(sid))
    expect(statusAfter).toBe('done')
  })

  it('TC4: watch 已建订阅后，显式 ensureStreamSubscription 命中幂等短路变 no-op', () => {
    const sid = 's-idempotent'
    sessionStore.appendSession(mkSession(sid))
    // 此时 watch 已对 sid 建订阅（events.on 已注册一次）
    // spy events.on 计数（spy 建在已订阅之后，故仅后续调用被计入）
    const onSpy = vi.spyOn(events, 'on')

    // 模拟 fork-ask:108 / handoff:64 的显式调用
    const chat = useChatStore()
    const session = useSessionStore()
    ensureStreamSubscription(sid, chat, session)

    // ensureStreamSubscription 首行 has(sid) 短路，不应再调 events.on
    expect(onSpy).not.toHaveBeenCalled()
    onSpy.mockRestore()
  })

  it('TC5: HMR 双 scope——旧 scope.stop() 取消旧 watch，新 scope 建新 watch', () => {
    const sid1 = 's-hmr-1'
    sessionStore.appendSession(mkSession(sid1))
    // scope A 已在 beforeEach 建立，sid1 已订阅（ensureStreamSubscription 注册 events.on）
    events.dispatchSession(sid1, {
      type: 'message.message_start',
      payload: { sessionId: sid1, messageId: 'm1' },
    } as ServerMessage)
    expect(chatStore.getMessages(sid1).length).toBe(1)

    // 模拟 HMR：停旧 scope + 清模块级 streamSubscriptions（HMR 整模块重载的等价清理）。
    // 说明：scope.stop() 仅取消 watch（onScopeDispose 注册的 stopWatch），
    // ensureStreamSubscription 的 events.on 订阅存于模块级 streamSubscriptions Map，
    // 非作用域绑定——单 scope.stop 不会拆订阅。真实 HMR 会整模块重载（useChat 模块重新求值，
    // streamSubscriptions Map 重置），此处用 resetChatModuleState 精确建模该重载。
    scope.stop()

    // 关键断言（TC5 核心，填补验证空洞）：在 resetChatModuleState 之前，append 一个全新 session
    // 并推事件——若 scope.stop() 真的取消了旧 watch，旧 watch 不会响应 list 变化给 sid-new
    // 建订阅，dispatchSession(sid-new) 无订阅者，messages 保持 0。
    const sidNew = 's-hmr-new'
    sessionStore.appendSession(mkSession(sidNew))
    events.dispatchSession(sidNew, {
      type: 'message.message_start',
      payload: { sessionId: sidNew, messageId: 'm-new' },
    } as ServerMessage)
    expect(chatStore.getMessages(sidNew).length).toBe(0) // 旧 watch 已取消，sid-new 无订阅

    // 清模块级订阅（模拟 HMR 整模块重载的剩余部分）。
    // 旧订阅已清——sid1 再推事件不应到（messages 不变）
    resetChatModuleState()
    events.dispatchSession(sid1, {
      type: 'message.message_start',
      payload: { sessionId: sid1, messageId: 'm2' },
    } as ServerMessage)
    expect(chatStore.getMessages(sid1).length).toBe(1) // 仍是 1，未增

    // 新 scope 挂载（模拟 HMR 重挂 App.vue setup）
    const scopeB = effectScope()
    scopeB.run(() => {
      bindSessionStreamSync()
    })
    const sid2 = 's-hmr-2'
    sessionStore.appendSession(mkSession(sid2))
    events.dispatchSession(sid2, {
      type: 'message.message_start',
      payload: { sessionId: sid2, messageId: 'm3' },
    } as ServerMessage)
    expect(chatStore.getMessages(sid2).length).toBe(1) // 新 scope 的 watch 工作
    scopeB.stop()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：shell/settings-transport-adapter（doMock/resetModules 自管模块图）
// ─────────────────────────────────────────────────────────────────────────────

/** 与被测 mock 域 fixture 的对照锚（composer-data MOCK_MODELS 首条） */
const MOCK_ANCHOR_MODEL_ID = 'claude-sonnet-4.5'

describe('settings-transport-adapter · @/api 门面八元全量转发矩阵（u17）', () => {
  afterEach(() => {
    vi.doUnmock('@/api')
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  /** 请求方法返回值哨兵（adapter 必须原样透传 resolve 值） */
  const REPLY = { probe: 'reply' }
  /** 订阅方法取消函数哨兵（adapter 必须原样透传返回的取消函数） */
  const OFF = (): void => {}
  /** 通用订阅 handler 探针（零参函数可赋任意 handler 签名） */
  const probeHandler = (): void => {}

  // ── 探针参数哨兵（值任意，只需类型合法；同一常量同时喂 call 与透传断言，防脱节）──
  const PROBE_PID = 'probe-provider' as ProviderId
  const PROBE_SOURCE: ProviderSource = 'pi'
  const PROBE_RENAME_MODE: RenameMode = 'first-stop'
  const PROBE_RENAME_STYLE: RenameStyle = 'slug'
  const PROBE_DIRS: SkillDirConfig[] = [{ path: 'probe/dir', enabled: true, scope: 'project' }]
  const PROBE_SYSTEM_PROMPT: SystemPromptConfig = {
    version: 1,
    replace: { enabled: true, prompt: 'probe' },
    append: { enabled: false, prompt: '' },
  }
  const PROBE_TERMINAL: TerminalConfig = {
    version: 1,
    shell: 'probe-shell',
    shellArgs: [],
    fontSize: 12,
    fontFamily: 'probe-font',
    scrollback: 100,
    cursorStyle: 'block',
    bell: false,
  }
  const PROBE_RETRY: LlmRetryConfig = { enabled: true, maxRetries: 1, baseDelayMs: 2 }
  const PROBE_RETRY_RULES: RetryableErrorRule[] = [
    {
      id: 'probe-rule',
      name: 'probe',
      verdict: 'retryable',
      class: 'provider',
      source: 'custom',
      match: [{ kind: 'pattern', pattern: 'probe' }],
    },
  ]
  const PROBE_NETWORK_PROXY: NetworkProxyConfig = {
    enabled: true,
    proxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
    noProxy: ['localhost'],
    rules: ['api.anthropic.com'],
  }
  const PROBE_QUOTA_PAYLOAD: QuotaConfigurePayload = { providerId: 'probe-provider', enabled: true }
  const PROBE_PRESET: PiLaunchPreset = {
    id: 'probe-preset',
    name: 'probe',
    builtin: false,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
  }
  const PROBE_PROVIDER_DATA: SetProviderData = { name: 'probe', baseUrl: 'https://probe.example' }

  type FacadeDomain =
    | 'config'
    | 'model'
    | 'extension'
    | 'settings'
    | 'quota'
    | 'preset'
    | 'usage'
    | 'session'
    // provider-plugin-access U6：插件 Provider 来源域（清单 / invoke / 事件 / uiEvent / 安装）
    | 'plugin'

  interface ForwardEntry {  // oe-exempt:20261027:test:
    domain: FacadeDomain
    /** transport.<方法> 转发到的门面成员名 */
    facade: string
    /** 探针参数（与 call 收到的同一引用，用于透传断言） */
    args: readonly unknown[]
    call: (t: SettingsTransport) => unknown
  }

  /**
   * 矩阵条目工厂：args 元组绑定进 call 的 rest 探针——call 内联调用即编译期校验
   * （方法名拼错 / 参数个数或类型不符 = 编译错），运行期用同一 args 断言参数透传。
   */
  function fwd<A extends unknown[]>(
    domain: FacadeDomain,
    facade: string,
    args: A,
    call: (t: SettingsTransport, ...probe: A) => unknown,
  ): ForwardEntry {
    return { domain, facade, args, call: (t) => call(t, ...args) }
  }

  /**
   * 转发矩阵 = SettingsTransport 接口清单的镜像文档。每条：transport.<方法> →
   * [门面域, 门面成员, 探针参数]，与 settings-transport-adapter.ts 逐行一一对应；
   * satisfies 键集与接口 keyof 同宽，adapter 新增转发而矩阵缺行 = 编译错。
   */
  const FORWARD_MATRIX = {
    // ════════════════ 读（请求-响应）════════════════
    listProviders: fwd('config', 'listProviders', [], (t) => t.listProviders()),
    listModels: fwd('model', 'listModels', [], (t) => t.listModels()),
    listBuiltinProviders: fwd('config', 'listBuiltinProviders', [], (t) => t.listBuiltinProviders()),
    detectSources: fwd('config', 'detectSources', [], (t) => t.detectSources()),
    refreshProviderCatalogs: fwd('config', 'refreshProviderCatalogs', [], (t) => t.refreshProviderCatalogs()),
    scanSkills: fwd('config', 'scanSkills', ['probe-skill-src'], (t, sources) => t.scanSkills(sources)),
    scanAgents: fwd('config', 'scanAgents', ['probe-agent-src'], (t, sources) => t.scanAgents(sources)),
    listQuotaPresets: fwd('config', 'listQuotaPresets', [], (t) => t.listQuotaPresets()),
    setProviderCatalogWatch: fwd('config', 'setProviderCatalogWatch', [true], (t, enable) =>
      t.setProviderCatalogWatch(enable),
    ),
    getGlobalSkills: fwd('config', 'getGlobalSkills', [], (t) => t.getGlobalSkills()),
    getProjectSkills: fwd('config', 'getProjectSkills', ['probe-cwd'], (t, cwd) => t.getProjectSkills(cwd)),
    previewImportProviders: fwd('config', 'previewImportProviders', [PROBE_SOURCE], (t, source) =>
      t.previewImportProviders(source),
    ),
    discoverModels: fwd(
      'config',
      'discoverModels',
      [{ baseUrl: 'https://probe.example', mode: 'discover' } as DiscoverModelsRequest],
      (t, req) => t.discoverModels(req),
    ),
    hasOAuth: fwd('config', 'hasOAuth', [PROBE_PID], (t, providerId) => t.hasOAuth(providerId)),
    checkEnvVars: fwd('config', 'checkEnvVars', [['PROBE_VAR']], (t, names) => t.checkEnvVars(names)),
    revealProviderApiKey: fwd('config', 'revealProviderApiKey', [PROBE_PID], (t, providerId) => t.revealProviderApiKey(providerId)),
    getSystemPrompt: fwd('config', 'getSystemPrompt', [], (t) => t.getSystemPrompt()),
    getTerminalConfig: fwd('config', 'getTerminalConfig', [], (t) => t.getTerminalConfig()),
    getRetryConfig: fwd('config', 'getRetryConfig', [], (t) => t.getRetryConfig()),
    getRetryRules: fwd('config', 'getRetryRules', [], (t) => t.getRetryRules()),
    getNetworkProxyConfig: fwd('config', 'getNetworkProxyConfig', [], (t) => t.getNetworkProxyConfig()),
    getNetworkProxyStats: fwd('config', 'getNetworkProxyStats', ['all'], (t, range) => t.getNetworkProxyStats(range)),
    getWorktreeRootDir: fwd('settings', 'getWorktreeRootDir', [], (t) => t.getWorktreeRootDir()),
    getSetupScript: fwd('settings', 'getSetupScript', [], (t) => t.getSetupScript()),
    getBareSetupScript: fwd('settings', 'getBareSetupScript', [], (t) => t.getBareSetupScript()),
    getWorktreeTimeout: fwd('settings', 'getWorktreeTimeout', [], (t) => t.getWorktreeTimeout()),
    getDefaultBaseBranch: fwd('settings', 'getDefaultBaseBranch', [], (t) => t.getDefaultBaseBranch()),
    getAutoRenameEnabled: fwd('settings', 'getAutoRenameEnabled', [], (t) => t.getAutoRenameEnabled()),
    getRenameMode: fwd('settings', 'getRenameMode', [], (t) => t.getRenameMode()),
    getRenameModel: fwd('settings', 'getRenameModel', [], (t) => t.getRenameModel()),
    getRenamePrompt: fwd('settings', 'getRenamePrompt', [], (t) => t.getRenamePrompt()),
    getRenameMaxLength: fwd('settings', 'getRenameMaxLength', [], (t) => t.getRenameMaxLength()),
    getSmartContextConfig: fwd('settings', 'getSmartContextConfig', [], (t) => t.getSmartContextConfig()),
    getCodemodeEnabled: fwd('settings', 'getCodemodeEnabled', [], (t) => t.getCodemodeEnabled()),
    getUsageStats: fwd('usage', 'getUsageStats', [], (t) => t.getUsageStats()),
    getSubagentEngineConfig: fwd('session', 'getSubagentEngineConfig', [], (t) => t.getSubagentEngineConfig()),
    getCachedQuota: fwd('quota', 'getCached', [PROBE_PID], (t, providerId) => t.getCachedQuota(providerId)),
    refreshQuota: fwd('quota', 'refreshQuota', [PROBE_PID], (t, providerId) => t.refreshQuota(providerId)),
    listPresets: fwd('preset', 'list', [], (t) => t.listPresets()),
    getDefaultPreset: fwd('preset', 'getDefault', [], (t) => t.getDefaultPreset()),
    fetchRecommendedExtensions: fwd('extension', 'fetchRecommended', [], (t) => t.fetchRecommendedExtensions()),

    // ── 插件 Provider 来源（provider-plugin-access U6）──
    listAvailablePlugins: fwd('plugin', 'listAvailablePlugins', [], (t) => t.listAvailablePlugins()),
    // 已发现插件列表（S13 家族卡崩溃态判定源：plugin.list 拉为主）
    listPlugins: fwd('plugin', 'listPlugins', [], (t) => t.listPlugins()),
    invokePlugin: fwd('plugin', 'invokePlugin', ['probe-plugin', 'getStatus', { providerId: 'probe-provider' }], (t, pluginId, method, params) =>
      t.invokePlugin(pluginId, method, params),
    ),
    sendPluginUiEvent: fwd(
      'plugin',
      'sendPluginUiEvent',
      [{ pluginId: 'probe-plugin', viewId: 'probe-view', componentId: 'probe-input', event: 'change', value: 'probe' }],
      (t, payload) => t.sendPluginUiEvent(payload),
    ),
    executePluginCommand: fwd(
      'plugin',
      'executePluginCommand',
      [{ pluginId: 'probe-plugin', commandId: 'probe-command' }],
      (t, payload) => t.executePluginCommand(payload),
    ),
    // 两段式安装三成员在 seam 上是 optional（通道未落定的宿主实现可省略）：矩阵以
    // 可选调用形态登记，domain 实装存在时（本用例 Proxy 恒返回 spy）必须逐条转发。
    preparePluginInstall: fwd('plugin', 'preparePluginInstall', ['probe-package'], (t, spec) =>
      t.preparePluginInstall?.(spec),
    ),
    confirmPluginInstall: fwd('plugin', 'confirmPluginInstall', ['probe-plugin'], (t, pluginId) =>
      t.confirmPluginInstall?.(pluginId),
    ),
    cancelPluginInstall: fwd('plugin', 'cancelPluginInstall', ['probe-plugin'], (t, pluginId) =>
      t.cancelPluginInstall?.(pluginId),
    ),
    // 启用/停用插件（S13 重启动作 = off 再 on）+ 挂载位分区清理（U2 裁决①：防陈旧；
    // clearPluginMountUi 与安装三成员同款 optional 契约形态）
    togglePlugin: fwd('plugin', 'togglePlugin', ['probe-plugin', true], (t, pluginId, enabled) =>
      t.togglePlugin(pluginId, enabled),
    ),
    clearPluginMountUi: fwd('plugin', 'clearPluginMountUi', ['probe-mount'], (t, mountId) =>
      t.clearPluginMountUi?.(mountId),
    ),

    // ════════════════ 写（动作-ack）════════════════
    setProvider: fwd('config', 'setProvider', [PROBE_PID, PROBE_PROVIDER_DATA], (t, id, data) =>
      t.setProvider(id, data),
    ),
    setScopedModels: fwd('config', 'setScopedModels', [['probe:scoped']], (t, models) => t.setScopedModels(models)),
    setDefaultModel: fwd('config', 'setDefaultModel', [PROBE_PID, 'probe-model'], (t, provider, modelId) =>
      t.setDefaultModel(provider, modelId),
    ),
    toggleProviderEnabled: fwd('config', 'toggleProviderEnabled', [PROBE_PID, true], (t, providerId, enabled) =>
      t.toggleProviderEnabled(providerId, enabled),
    ),
    removeProviderByKind: fwd('config', 'removeProviderByKind', [PROBE_PID, 'custom' as const], (t, providerId, kind) =>
      t.removeProviderByKind(providerId, kind),
    ),
    setSkillDirs: fwd('config', 'setSkillDirs', [PROBE_DIRS], (t, dirs) => t.setSkillDirs(dirs)),
    setAgentDirs: fwd('config', 'setAgentDirs', [PROBE_DIRS], (t, dirs) => t.setAgentDirs(dirs)),
    setExtensionDirs: fwd('config', 'setExtensionDirs', [PROBE_DIRS], (t, dirs) => t.setExtensionDirs(dirs)),
    applyImportProviders: fwd('config', 'applyImportProviders', ['probe-import', ['sel-1']], (t, importId, ids) =>
      t.applyImportProviders(importId, ids),
    ),
    setSystemPrompt: fwd('config', 'setSystemPrompt', [PROBE_SYSTEM_PROMPT], (t, cfg) => t.setSystemPrompt(cfg)),
    setTerminalConfig: fwd('config', 'setTerminalConfig', [PROBE_TERMINAL], (t, cfg) => t.setTerminalConfig(cfg)),
    setRetryConfig: fwd('config', 'setRetryConfig', [PROBE_RETRY], (t, cfg) => t.setRetryConfig(cfg)),
    setRetryRules: fwd('config', 'setRetryRules', [PROBE_RETRY_RULES], (t, rules) => t.setRetryRules(rules)),
    setNetworkProxyConfig: fwd('config', 'setNetworkProxyConfig', [PROBE_NETWORK_PROXY], (t, cfg) =>
      t.setNetworkProxyConfig(cfg),
    ),
    testNetworkProxy: fwd('config', 'testNetworkProxy', [PROBE_NETWORK_PROXY], (t, cfg) => t.testNetworkProxy(cfg)),
    resetNetworkProxyStats: fwd('config', 'resetNetworkProxyStats', [], (t) => t.resetNetworkProxyStats()),
    setWorktreeRootDir: fwd('settings', 'setWorktreeRootDir', ['probe-root'], (t, dir) => t.setWorktreeRootDir(dir)),
    setSetupScript: fwd('settings', 'setSetupScript', ['probe-script'], (t, script) => t.setSetupScript(script)),
    setBareSetupScript: fwd('settings', 'setBareSetupScript', ['probe-script'], (t, script) =>
      t.setBareSetupScript(script),
    ),
    setWorktreeTimeout: fwd('settings', 'setWorktreeTimeout', [120], (t, timeout) => t.setWorktreeTimeout(timeout)),
    setDefaultBaseBranch: fwd('settings', 'setDefaultBaseBranch', ['probe-branch'], (t, branch) =>
      t.setDefaultBaseBranch(branch),
    ),
    setAutoRenameEnabled: fwd('settings', 'setAutoRenameEnabled', [true], (t, enabled) =>
      t.setAutoRenameEnabled(enabled),
    ),
    setRenameMode: fwd('settings', 'setRenameMode', [PROBE_RENAME_MODE], (t, mode) => t.setRenameMode(mode)),
    setRenameModel: fwd('settings', 'setRenameModel', ['probe-model'], (t, model) => t.setRenameModel(model)),
    setRenamePrompt: fwd('settings', 'setRenamePrompt', [PROBE_RENAME_STYLE, 'probe-instruction'], (t, style, instruction) =>
      t.setRenamePrompt(style, instruction),
    ),
    setRenameMaxLength: fwd('settings', 'setRenameMaxLength', [50], (t, maxLength) => t.setRenameMaxLength(maxLength)),
    setSmartContextEnabled: fwd('settings', 'setSmartContextEnabled', [true], (t, enabled) =>
      t.setSmartContextEnabled(enabled),
    ),
    setSmartContextCompactModel: fwd('settings', 'setSmartContextCompactModel', ['probe-model'], (t, model) =>
      t.setSmartContextCompactModel(model),
    ),
    setSmartContextThresholds: fwd('settings', 'setSmartContextThresholds', [[100, 200, 300]], (t, thresholds) =>
      t.setSmartContextThresholds(thresholds),
    ),
    setSmartContextExcludedModels: fwd('settings', 'setSmartContextExcludedModels', [['probe/excluded']], (t, models) =>
      t.setSmartContextExcludedModels(models),
    ),
    setCodemodeEnabled: fwd('settings', 'setCodemodeEnabled', [true], (t, enabled) => t.setCodemodeEnabled(enabled)),
    setSubagentDefaultEngine: fwd('session', 'setSubagentDefaultEngine', ['probe-engine'], (t, engineId) =>
      t.setSubagentDefaultEngine(engineId),
    ),
    setSubagentEngineDefaultModel: fwd(
      'session',
      'setSubagentEngineDefaultModel',
      ['probe-engine', 'probe-provider/probe-model'],
      (t, engineId, modelRef) => t.setSubagentEngineDefaultModel(engineId, modelRef),
    ),
    oauthLogin: fwd('config', 'oauthLogin', [PROBE_PID], (t, providerId) => t.oauthLogin(providerId)),
    oauthCancel: fwd('config', 'oauthCancel', [PROBE_PID], (t, providerId) => t.oauthCancel(providerId)),
    oauthLogout: fwd('config', 'oauthLogout', [PROBE_PID], (t, providerId) => t.oauthLogout(providerId)),
    configureQuota: fwd('quota', 'configure', [PROBE_QUOTA_PAYLOAD], (t, payload) => t.configureQuota(payload)),
    setDefaultPreset: fwd('preset', 'setDefault', ['probe-preset'], (t, presetId) => t.setDefaultPreset(presetId)),
    createPreset: fwd('preset', 'create', [PROBE_PRESET], (t, preset) => t.createPreset(preset)),
    updatePreset: fwd('preset', 'update', [PROBE_PRESET], (t, preset) => t.updatePreset(preset)),
    removePreset: fwd('preset', 'remove', ['probe-preset'], (t, presetId) => t.removePreset(presetId)),
    toggleExtension: fwd('extension', 'toggle', ['probe-ext', true], (t, name, enabled) =>
      t.toggleExtension(name, enabled),
    ),
    installExtension: fwd('extension', 'install', ['probe-source'], (t, source) => t.installExtension(source)),
    uninstallExtension: fwd('extension', 'uninstall', ['probe-ext'], (t, name) => t.uninstallExtension(name)),
    installExtensionDir: fwd('extension', 'installDir', ['probe/dir'], (t, path) => t.installExtensionDir(path)),
    installExtensionGitRepository: fwd('extension', 'installGitRepository', ['https://probe.example/git'], (t, url) =>
      t.installExtensionGitRepository(url),
    ),
    finishExtensionInstall: fwd('extension', 'finishInstall', ['probe-temp', ['sel-1']], (t, tempDir, selected) =>
      t.finishExtensionInstall(tempDir, selected),
    ),
    cancelExtensionInstall: fwd('extension', 'cancelInstall', ['probe-temp'], (t, tempDir) =>
      t.cancelExtensionInstall(tempDir),
    ),
    upgradeExtension: fwd('extension', 'upgrade', ['probe-ext'], (t, name) => t.upgradeExtension(name)),
    setExtensionAutoUpgrade: fwd('extension', 'setAutoUpgrade', ['probe-ext', true], (t, name, enabled) =>
      t.setExtensionAutoUpgrade(name, enabled),
    ),

    // ════════════════ 订阅（返回取消函数）════════════════
    onProviders: fwd('config', 'onProviders', [probeHandler], (t, h) => t.onProviders(h)),
    onModels: fwd('model', 'onModels', [probeHandler], (t, h) => t.onModels(h)),
    onSkills: fwd('config', 'onSkills', [probeHandler], (t, h) => t.onSkills(h)),
    onAgents: fwd('config', 'onAgents', [probeHandler], (t, h) => t.onAgents(h)),
    onExtensions: fwd('extension', 'onExtensions', [probeHandler], (t, h) => t.onExtensions(h)),
    onNetworkProxyConfig: fwd('config', 'onNetworkProxyConfig', [probeHandler], (t, h) => t.onNetworkProxyConfig(h)),
    onSkillDirs: fwd('config', 'onSkillDirs', [probeHandler], (t, h) => t.onSkillDirs(h)),
    onAgentDirs: fwd('config', 'onAgentDirs', [probeHandler], (t, h) => t.onAgentDirs(h)),
    onExtensionDirs: fwd('config', 'onExtensionDirs', [probeHandler], (t, h) => t.onExtensionDirs(h)),
    onDefaults: fwd('config', 'onDefaults', [probeHandler], (t, h) => t.onDefaults(h)),
    onDefaultsWithSource: fwd('config', 'onDefaultsWithSource', [probeHandler], (t, h) => t.onDefaultsWithSource(h)),
    onSkillCacheInvalidated: fwd('config', 'onSkillCacheInvalidated', [probeHandler], (t, h) =>
      t.onSkillCacheInvalidated(h),
    ),
    onSystemPrompt: fwd('config', 'onSystemPrompt', [probeHandler], (t, h) => t.onSystemPrompt(h)),
    onTerminalConfig: fwd('config', 'onTerminalConfig', [probeHandler], (t, h) => t.onTerminalConfig(h)),
    onRetryConfig: fwd('config', 'onRetryConfig', [probeHandler], (t, h) => t.onRetryConfig(h)),
    onRetryRules: fwd('config', 'onRetryRules', [probeHandler], (t, h) => t.onRetryRules(h)),
    onAuthDeviceCode: fwd('config', 'onAuthDeviceCode', [probeHandler], (t, h) => t.onAuthDeviceCode(h)),
    onAuthAuthUrl: fwd('config', 'onAuthAuthUrl', [probeHandler], (t, h) => t.onAuthAuthUrl(h)),
    onAuthSuccess: fwd('config', 'onAuthSuccess', [probeHandler], (t, h) => t.onAuthSuccess(h)),
    onAuthError: fwd('config', 'onAuthError', [probeHandler], (t, h) => t.onAuthError(h)),
    onPluginEvent: fwd('plugin', 'onPluginEvent', [probeHandler], (t, h) => t.onPluginEvent(h)),
    onPluginCrashed: fwd('plugin', 'onPluginCrashed', [probeHandler], (t, h) => t.onPluginCrashed(h)),
  } satisfies Record<keyof SettingsTransport, ForwardEntry>

  it('SettingsTransport 接口清单全量方法逐条转发：目标 = @/api 门面对应导出，参数与返回值原样透传（防回退 core/transport 直连）', async () => {
    // 每域一个 Proxy：任意成员访问都返回（并登记）同一个 spy——转发目标域.成员由此可观测。
    // 若矩阵行登记的 facade 与 adapter 实际访问的成员不符，登记的 spy 收不到调用 → 该行红；
    // 反向断言（registry 总数 = 矩阵条目数）再兜住「adapter 访问了矩阵之外的门面成员」。
    const registry = new Map<string, ReturnType<typeof vi.fn>>()
    const spyOf = (domain: FacadeDomain, facade: string): ReturnType<typeof vi.fn> => {
      const key = `${domain}.${facade}`
      const existing = registry.get(key)
      if (existing) return existing
      const spy = vi.fn()
      registry.set(key, spy)
      return spy
    }
    const domainProxy = (domain: FacadeDomain): Record<string, unknown> =>
      new Proxy(
        {},
        {
          get: (_target, prop) => (typeof prop === 'string' ? spyOf(domain, prop) : undefined),
        },
      )

    vi.resetModules()
    vi.doMock('@/api', () => ({
      config: domainProxy('config'),
      model: domainProxy('model'),
      extension: domainProxy('extension'),
      settings: domainProxy('settings'),
      quota: domainProxy('quota'),
      preset: domainProxy('preset'),
      usage: domainProxy('usage'),
      session: domainProxy('session'),
      plugin: domainProxy('plugin'),
    }))
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    const transport = createSettingsTransport()

    for (const [method, entry] of Object.entries(FORWARD_MATRIX)) {
      const spy = spyOf(entry.domain, entry.facade)
      const isSubscription = method.startsWith('on')
      if (isSubscription) spy.mockReturnValue(OFF)
      else spy.mockResolvedValue(REPLY)

      const ret = entry.call(transport)

      expect(spy, `transport.${method} 必须恰好转发到 ${entry.domain}.${entry.facade} 一次`).toHaveBeenCalledTimes(1)
      if (isSubscription) {
        expect(ret, `transport.${method} 必须透传取消函数`).toBe(OFF)
      } else {
        expect(await ret, `transport.${method} 必须透传请求返回值`).toBe(REPLY)
      }
      if (method === 'onExtensions') {
        // 唯一非原样参数：adapter 包装 handler 做宽→窄 cast（见 adapter onExtensions 注释），只断言以函数调用
        expect(spy).toHaveBeenCalledWith(expect.any(Function))
      } else {
        expect(spy, `transport.${method} 参数必须原样透传`).toHaveBeenCalledWith(...entry.args)
      }
    }

    // 反向断言：adapter 没有矩阵之外的任何门面成员访问（registry 恰好登记矩阵条目数个 spy）
    expect(registry.size).toBe(Object.keys(FORWARD_MATRIX).length)

    // 同宽断言（运行期防线）：矩阵键集必须与 transport 实际转发范围一致——adapter 新增转发
    // 方法而矩阵缺行 = 此处红。本测试文件未入 renderer typecheck-test 白名单，上方 satisfies
    // 编译期同宽暂不生效，以此断言兜底（typecheck 接入后两者互为冗余防线）。
    expect(Object.keys(FORWARD_MATRIX).sort()).toEqual(Object.keys(transport).sort())
  })
})

describe('settings-transport-adapter · V8 mock 模式接回（裁决 3）', () => {
  afterEach(() => {
    vi.doUnmock('@/api')
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('VITE_MOCK=true：settings 域方法解析到 mockApi（请求/订阅均返回 mock fixture，不打真实 WS）', async () => {
    vi.stubEnv('VITE_MOCK', 'true')
    vi.resetModules()
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    const transport = createSettingsTransport()

    // 请求通路：listModels / listProviders 返回 mock fixture 数据。
    // 证据力：real 域走 ws-client RPC，单测环境无 WS 连接必失败/挂起——能同步返回
    // fixture 即证明解析到了 mockApi（门面三元 isMock 分支生效）。
    const models = await transport.listModels()
    expect(models.map((m) => m.id)).toContain(MOCK_ANCHOR_MODEL_ID)

    const providersReply = await transport.listProviders()
    expect(providersReply.providers.length).toBeGreaterThan(0)
    expect(Array.isArray(providersReply.scopedModels)).toBe(true)

    // 订阅通路：onModels 注册后微任务收到 mock fixture 首推（makeMockSubscription 语义）
    const pushed: number[] = []
    const off = transport.onModels((models) => pushed.push(models.length))
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    off()
  })
})

describe('settings-transport-adapter · discoverModels 模式感知 guard（S-13，经 @/api 门面 spy）', () => {
  afterEach(() => {
    vi.doUnmock('@/api')
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  async function makeTransportWithDiscoverSpy() {
    const discoverModels = vi.fn()
    vi.resetModules()
    vi.doMock('@/api', () => ({
      // config 域基座（on* 订阅族 + terminal 读写）单源在 helpers/api-facade-mock；
      // discover 场景消费的请求方法保持本文件内联（discoverModels 为断言捕获 spy）
      config: {
        ...apiConfigDomainMock(),
        listProviders: vi.fn(),
        setProvider: vi.fn(),
        setScopedModels: vi.fn(),
        discoverModels,
        setSkillDirs: vi.fn(),
        setAgentDirs: vi.fn(),
        setExtensionDirs: vi.fn(),
      },
      model: { listModels: vi.fn(), onModels: vi.fn(() => () => {}) },
      extension: { onExtensions: vi.fn(() => () => {}) },
      // plugin 域：空对象 = 两段式安装成员缺席（optional 不挂载；本组用例不触插件通道）
      plugin: {},
    }))
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    return { transport: createSettingsTransport(), discoverModels }
  }

  it('discover 模式缺 baseUrl：短路返回 success:false 且不调 discoverModels', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    const reply = await transport.discoverModels({ mode: 'discover' })

    expect(reply).toEqual({ success: false, error: 'baseUrl is required for model discovery' })
    expect(discoverModels).not.toHaveBeenCalled()
  })

  it('mode 缺省按 discover 处理：缺 baseUrl 同样短路', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    const reply = await transport.discoverModels({})

    expect(reply.success).toBe(false)
    expect(discoverModels).not.toHaveBeenCalled()
  })

  it('test 模式缺 baseUrl：照常透传（端点回落链归 runtime，不校验 baseUrl）', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    discoverModels.mockResolvedValue({ success: true })
    const req = { mode: 'test' as const, providerId: 'p1' }
    const reply = await transport.discoverModels(req)

    expect(reply).toEqual({ success: true })
    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledWith({ ...req, mode: 'test' })
  })

  it('discover 模式带 baseUrl：正常透传（mode 缺省补全）', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    discoverModels.mockResolvedValue({ success: true, models: [] })
    const reply = await transport.discoverModels({ baseUrl: 'https://api.example.com' })

    expect(reply).toEqual({ success: true, models: [] })
    expect(discoverModels).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com',
      mode: 'discover',
    })
  })
})
