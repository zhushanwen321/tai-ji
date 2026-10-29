import CompanionBand from '../../extension-host/CompanionBand.vue';
import L2TabBar from '../../extension-host/L2TabBar.vue';
import PluginSettingsPage from '../../extension-host/PluginSettingsPage.vue';
import PluginViewContainer from '../../extension-host/PluginViewContainer.vue';
import ViewHost from '../../extension-host/ViewHost.vue';
import { type OverlayLifecycleSource, type OverlayState, DIALOG_QUEUE_HANDLE_KEY, DIALOG_REQUEST_SOURCE_KEY, OVERLAY_LIFECYCLE_KEY, UI_RESPONSE_TRANSPORT_KEY } from '../../extension-host/companion-band-source';
import type { DialogRequest, DialogRequestQueue, DialogRequestSource, UiResponseTransport } from '../../extension-host/dialog-request-queue';
import type { L2TabItem } from '../../extension-host/l2-tab-item';
import { type ContributionInfo, type PluginSettingsDataSource, PluginSettingsDataSourceKey } from '../../extension-host/plugin-settings-data-source';
import { convertToDialogRequest, createCompanionDialogAdapters, createWsPluginMessageSource, type CompanionDialogAdapters, type CompanionDialogAdaptersTesting } from '../../extension-host/shell-adapters';
import { VIEWS_SOURCE_KEY, type PluginViewSummary, type PluginViewsSource } from '../../extension-host/views-source';
import BlockScrollBox from '../../features/chat/BlockScrollBox.vue';
import { ListTodo, Target } from '@lucide/vue';
import { EXTENSION_BRIDGE_TYPES, InternalEventBus, MessageBusBridge, type InternalEvent } from '@taiji/core';
import type { ComposerInputInstance } from '@taiji/core/domain/composer';
import { createComposerInjectionStore, useComposerInjection } from '@taiji/core/domain/composer/context';
import { dispatchCrossSession, dispatchGlobal } from '@taiji/core/transport/api';
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension';
import { send } from '@taiji/core/transport/ws-client';
import { type ChipCallbacks, type ContenteditableCallbacks, getSegmentsFromEl, useComposerChipCommands, useContenteditableInput } from '@taiji/dom-core/composer/input';
import type { PluginInfo } from '@taiji/shared';
import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';

// wave3 簇 [ui/happy-dom] 4 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - extension-host/__tests__/shell-adapters.test.ts
 * - extension-host/__tests__/view-host-suite.test.ts
 * - features/chat/__tests__/BlockScrollBox.test.ts
 * - features/composer/__tests__/composer-suite.test.ts
 */

// ======================================================================
// ← extension-host/__tests__/shell-adapters.test.ts
// ======================================================================

vi.mock('@taiji/core/transport/ws-client', () => ({
  send: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  // 默认 resolve true（WS 送达）——TC8c 显式改写 false 走未送达分支
  sendExtensionUIResponse: vi.fn((): boolean => true),
}))

/** 模块级共享反查表的测试探针入口（__testing 指向同一张表，实例载体任意） */
function __testingProbe(): CompanionDialogAdaptersTesting {
  return createCompanionDialogAdapters(new InternalEventBus()).__testing
}

// ── createWsPluginMessageSource（自 useExtensionHostBridge.test.ts 平移）────────

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

  it('TC2: extension.dialog 白名单放行 → bus 收到 kind=ui-request（与 plugin:uiRequest 归一）', () => {
    const { bus, bridge: b } = makeBridge()
    bridge = b
    const { emitted } = spyEmit(bus)

    dispatchCrossSession({
      type: 'extension.dialog',
      payload: { sessionId: 's1', requestId: 'r1', dialogKind: 'confirm', title: '确认?' },
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

  it('TC5: EXTENSION_BRIDGE_TYPES 字面量 5 项 + 每项行为级验证（进 bridge 产出非 error 事件）', () => {
    // 字面量锁：EXTENSION_BRIDGE_TYPES 已是 core SSOT（派生自 EXTENSION_HANDLERS keys），
    // 锁项数防 handlers 增删时白名单悄悄漂移（消费方 source filter 行为随之变化无信号）。
    // 第 5 项 extension:requestsInvalidated 为 P2-2 失效链（runtime 非 respond 终结挂起的广播）
    expect(EXTENSION_BRIDGE_TYPES).toEqual([
      'extension:widget',
      'extension:widgetGui',
      'extension:notify',
      'extension:requestsInvalidated',
      'extension.dialog',
    ])

    // 行为级一致性：白名单每项经全链路都产出对应 kind 事件（非 kind=error）。
    // samples 的 type 是宽泛 string，无法静态收窄到 ServerMessage union 成员，做受控擦除
    // （运行时 tap emit 只按 type 路由 + 透传 payload，形状正确性由 core parser 校验）。
    const samples: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: 'extension:widget', payload: { sessionId: 's1', widgetKey: 'w1', lines: ['line'] } },
      { type: 'extension:widgetGui', payload: { sessionId: 's1', widgetKey: 'w1', gui: ['g'] } },
      { type: 'extension:notify', payload: { sessionId: 's1', message: 'hi', level: 'info' } },
      { type: 'extension:requestsInvalidated', payload: { sessionId: 's1', requestIds: ['r9'], reason: 'turn-aborted' } },
      { type: 'extension.dialog', payload: { sessionId: 's1', requestId: 'r1', dialogKind: 'select' } },
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

// ── convertToDialogRequest（纯函数直测）──────────────────────────────

function makeUiRequestEvent(overrides: Partial<{ sessionId: string; pluginId: string; requestId: string; kind: 'select' | 'confirm' | 'input' }> = {}): Extract<InternalEvent, { kind: 'ui-request' }> {
  return {
    kind: 'ui-request',
    sessionId: overrides.sessionId ?? 's1',
    request: {
      requestId: overrides.requestId ?? 'r1',
      pluginId: overrides.pluginId ?? 'p1',
      kind: overrides.kind ?? 'select',
    },
  }
}

describe('convertToDialogRequest（AC2）', () => {
  it('TC1: source 判定——pluginId 非空 → plugin；pluginId 空 → pi', () => {
    const plugin = convertToDialogRequest(makeUiRequestEvent({ pluginId: 'tasks' }))
    expect(plugin.source).toBe('plugin')
    expect(plugin.sessionId).toBe('s1')
    expect(plugin.requestId).toBe('r1')

    const pi = convertToDialogRequest(makeUiRequestEvent({ pluginId: '' }))
    expect(pi.source).toBe('pi')
  })

  it('TC2: form 类键不透传——askUser 帧经 C4 排除不达本转换；到达的请求按原始 method/kind 归一', () => {
    const e = makeUiRequestEvent({ kind: 'input' }) as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e.request.askUser = true
    e.request.askUserQuestions = [{ question: '继续?' }]
    e.request.allowCancel = false

    const req = convertToDialogRequest(e)
    // 不再做 askUser 改写（ui-presentation-protocol：askUser 帧已被 C4 排除，归一只发生在
    // useExtensionUI handler 内）——method 走原始/kind 兜底，富交互键不透传
    expect(req.method).toBe('input')
    expect('askUserQuestions' in req).toBe(false)
    expect(req.allowCancel).toBeUndefined()
  })

  it('TC3: options 归一——string[] → {label,value}[]；对象数组透传；非法项跳过', () => {
    const e1 = makeUiRequestEvent() as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e1.request.options = ['a', 'b']
    expect(convertToDialogRequest(e1).options).toEqual([
      { label: 'a', value: 'a' },
      { label: 'b', value: 'b' },
    ])

    const e2 = makeUiRequestEvent() as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e2.request.options = [
      { label: 'x', value: '1', description: 'desc' },
      42, // 非法项跳过
    ]
    expect(convertToDialogRequest(e2).options).toEqual([{ label: 'x', value: '1', description: 'desc' }])
  })

  it('TC3b: options 含非法项——console.warn 单条留痕（requestId + 跳过索引汇总）且合法项正常产出', () => {
    // 降级留痕对齐移动壳 MobileFormCard formQuestions dropped 先例：跳过不静默，单条汇总不逐项刷屏
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = makeUiRequestEvent() as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e.request.options = ['ok', 42, { label: 'x', value: '1' }, null]
    const req = convertToDialogRequest(e)

    // 合法项（string + 合法对象）照常产出，非法项（索引 1、3）跳过
    expect(req.options).toEqual([
      { label: 'ok', value: 'ok' },
      { label: 'x', value: '1' },
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    const warnText = warn.mock.calls[0][0] as string
    expect(warnText).toContain('r1') // requestId
    expect(warnText).toContain('2/4') // 跳过数/总数
    expect(warnText).toContain('1, 3') // 被跳过索引
    warn.mockRestore()
  })

  it('TC3c: options 全部合法时不产生留痕 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = makeUiRequestEvent() as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e.request.options = ['a', { label: 'x', value: '1' }]
    convertToDialogRequest(e)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('TC4: method 超界恢复 + receivedAt 补齐——原始 method 优先（editor 透传），无 method 用 kind', () => {
    const e1 = makeUiRequestEvent({ kind: 'input' }) as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e1.request.method = 'editor'
    const req1 = convertToDialogRequest(e1)
    expect(req1.method).toBe('editor')
    expect(typeof req1.receivedAt).toBe('number')
    expect(Date.now() - req1.receivedAt).toBeLessThan(5000)

    const req2 = convertToDialogRequest(makeUiRequestEvent({ kind: 'confirm' }))
    expect(req2.method).toBe('confirm')
  })
})

// ── createCompanionDialogAdapters（投递层路由 + 撤窗订阅）──────────────────

describe('createCompanionDialogAdapters（C2/C3/C4 分流）', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    bus = new InternalEventBus()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC5: 无 sessionId 事件跳过投递 + console.warn（双壳共用检查）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapters = createCompanionDialogAdapters(bus)
    const handler = vi.fn()
    const unsub = adapters.source.onUiRequest(handler)

    bus.emit({ kind: 'ui-request', sessionId: undefined, request: { requestId: 'r1', pluginId: 'p1', kind: 'select' } })

    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    unsub()
    warn.mockRestore()
  })

  it('TC6: C4 四键排除（form ∨ askUser ∨ scheduleCreate ∨ planReview 不投递）——普通 dialog 正常投递', () => {
    const adapters = createCompanionDialogAdapters(bus)
    const handler = vi.fn()
    const unsub = adapters.source.onUiRequest(handler)

    // 四键逐键断言：各归 useExtensionUI 消费方（FormOverlay / PlanReviewBar / legacy 窗口期
    // 归一层），漏排除 = 空壳 dialog 误触 + 双 UI 并存（违反零重叠契约）
    const formKeys = ['form', 'askUser', 'scheduleCreate', 'planReview'] as const
    formKeys.forEach((key, i) => {
      bus.emit({
        kind: 'ui-request',
        sessionId: 's1',
        request: { requestId: `r-excluded-${i}`, pluginId: '', kind: 'select', [key]: true },
      })
    })
    expect(handler).not.toHaveBeenCalled()

    bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r-dialog', pluginId: '', kind: 'confirm' } })
    expect(handler).toHaveBeenCalledTimes(1)
    const delivered = handler.mock.calls[0][0]
    expect(delivered.requestId).toBe('r-dialog')
    expect(delivered.method).toBe('confirm')
    expect(delivered.source).toBe('pi')
    unsub()
  })

  it('TC10: onUiRequestExpired 订阅 global 通道 plugin:uiRequestExpired（D2 撤窗，requestId 反查 sessionId）', () => {
    // 反查表为模块级共享（同文件先行用例可能残留表项）——用例内显式 reset，尾部表项数断言才只反映本用例写入
    __testingProbe().resetRequestIdSessionsForTest()
    const adapters = createCompanionDialogAdapters(bus)
    const expiredHandler = vi.fn()
    const unsubExpired = adapters.source.onUiRequestExpired(expiredHandler)

    // 反查表来自 onUiRequest 投递流：先投递（记录 requestId→sessionId），再撤窗
    const requestHandler = vi.fn()
    const unsubRequest = adapters.source.onUiRequest(requestHandler)
    bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'p1', kind: 'confirm' } })
    expect(requestHandler).toHaveBeenCalledTimes(1)

    // D2：撤窗广播 payload 无 sessionId（runtime 不注入活跃 sid）→ global 通道广播形状
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r1', pluginId: 'p1' } })
    expect(expiredHandler).toHaveBeenCalledTimes(1)
    expect(expiredHandler).toHaveBeenCalledWith({ sessionId: 's1', requestId: 'r1' })

    // 同一 requestId 二次撤窗：表项已删 → miss noop（幂等）
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r1', pluginId: 'p1' } })
    expect(expiredHandler).toHaveBeenCalledTimes(1)

    // 未投递过的 requestId（已 respond 关闭 / 未知请求）→ miss noop 幂等（V4b）
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'unknown', pluginId: 'p1' } })
    expect(expiredHandler).toHaveBeenCalledTimes(1)

    // 非 expired 类型零触发
    dispatchGlobal({ type: 'plugin:crashed', payload: { pluginId: 'p1', error: 'x' } })
    expect(expiredHandler).toHaveBeenCalledTimes(1)

    // MF-4：payload.sessionId（撤窗时点活跃 sid）与反查表冲突时，反查优先（投递时归属 sid）
    bus.emit({ kind: 'ui-request', sessionId: 's2', request: { requestId: 'r2', pluginId: 'p1', kind: 'confirm' } })
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r2', pluginId: 'p1', sessionId: 's-other' } })
    expect(expiredHandler).toHaveBeenLastCalledWith({ sessionId: 's2', requestId: 'r2' })

    // MF-4 兜底：Map miss（壳重启无条目）时 payload sid 兜底路由
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r3', pluginId: 'p1', sessionId: 's-payload' } })
    expect(expiredHandler).toHaveBeenLastCalledWith({ sessionId: 's-payload', requestId: 'r3' })

    // expired 命中出队即删表（G1 生命周期，不残留）：本用例 r1/r2 命中撤窗后表项数为 0
    expect(__testingProbe().probeRequestIdSessionsSize()).toBe(0)

    unsubExpired()
    unsubRequest()
  })

  it('TC-BUS: onUiRequest 退订后 bus 事件不再投递（订阅/退订时序契约，双壳共用）', () => {
    const adapters = createCompanionDialogAdapters(bus)
    const handler = vi.fn()
    const unsub = adapters.source.onUiRequest(handler)

    bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r1', pluginId: 'p1', kind: 'confirm' } })
    expect(handler).toHaveBeenCalledTimes(1)

    unsub()
    bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r2', pluginId: 'p1', kind: 'confirm' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

// ── transport 回传双通道（AC6/AC9）────────────────────────────────

describe('createCompanionDialogAdapters transport（AC6/AC9）', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    // 反查表已提为模块级共享（双消费方共管不变量）——用例间显式 reset 防跨用例残留
    __testingProbe().resetRequestIdSessionsForTest()
    bus = new InternalEventBus()
  })

  it('TC7: sendPluginResponse 发 plugin.uiResponse（runtime handleUiResponse 消费）', () => {
    const { transport } = createCompanionDialogAdapters(bus)
    transport.sendPluginResponse('r1', { value: 'x' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: 'plugin.uiResponse',
      payload: { requestId: 'r1', result: { value: 'x' } },
    })
  })

  it('TC8: sendPiResponse 复用 sendExtensionUIResponse（extension.ui_response，method 透传）', () => {
    const { transport } = createCompanionDialogAdapters(bus)
    transport.sendPiResponse('s1', 'r1', 'editor', 'value')
    expect(sendExtensionUIResponse).toHaveBeenCalledTimes(1)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'editor', 'value')
  })

  it('TC8b: sendPiResponse 兜底——非法 method 落到 input（对齐 kind 兜底语义）', () => {
    const { transport } = createCompanionDialogAdapters(bus)
    transport.sendPiResponse('s1', 'r1', 'unknown-method', true)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'input', true)
  })

  it('TC8c: 未送达（WS 非 OPEN）→ 返回 false + notifyNotDelivered + 表项保留（M1/RD-3#1 连接恢复后重发）', () => {
    vi.mocked(sendExtensionUIResponse).mockReturnValue(false)
    const notifyNotDelivered = vi.fn()
    const { transport, source, __testing } = createCompanionDialogAdapters(bus, { notifyNotDelivered })
    // 投递一条写入反查表（source/transport 同 factory 实例，G1 共管不变量）
    const handler = vi.fn()
    const unsub = source.onUiRequest(handler)
    bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r-nd', pluginId: '', kind: 'confirm' } })
    expect(handler).toHaveBeenCalledTimes(1)

    expect(transport.sendPiResponse('s1', 'r-nd', 'confirm', true)).toBe(false)
    expect(notifyNotDelivered).toHaveBeenCalledWith('s1')
    // 返回 false 时表项保留（请求仍在队列，撤窗反查仍需可用）
    expect(__testing.probeRequestIdSessionsSize()).toBe(1)

    // plugin 通道同语义：未送达 → false + 无 sessionId 提示
    vi.mocked(send).mockReturnValue(false)
    expect(transport.sendPluginResponse('r-x', { v: 1 })).toBe(false)
    expect(notifyNotDelivered).toHaveBeenLastCalledWith()
    unsub()
  })

  it('TC8d: 通路级收尾锚点（ADR-0073 D4a）——onPiResponseSettled 在 delivered 判定之前无条件调用', () => {
    const callOrder: string[] = []
    vi.mocked(sendExtensionUIResponse).mockImplementation(() => {
      callOrder.push('send')
      return false // 即使未送达，锚点也应已触发（清在 delivered 判定之前）
    })
    const onPiResponseSettled = vi.fn((sid: string) => callOrder.push(`settled:${sid}`))
    const { transport } = createCompanionDialogAdapters(bus, { onPiResponseSettled })

    transport.sendPiResponse('s1', 'r-anchor', 'confirm', true)
    expect(onPiResponseSettled).toHaveBeenCalledWith('s1')
    expect(callOrder).toEqual(['settled:s1', 'send'])
  })
})

// ── requestIdSessions 生命周期（G1 / memory-leak-remediation §3.4）──────────

describe('requestIdSessions respond 路径删除（G1 / memory-leak-remediation §3.4）', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks 连同 mock 工厂默认实现一起清——恢复「WS 送达 true」默认（TC8c 自行改写 false）
    vi.mocked(sendExtensionUIResponse).mockReturnValue(true)
    vi.mocked(send).mockReturnValue(true)
    // 模块级共享表（双消费方共管）——用例间显式 reset 防跨用例残留
    __testingProbe().resetRequestIdSessionsForTest()
    bus = new InternalEventBus()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 投递一个非 askUser dialog（写入 adapters 的反查表）——source/transport 须同 factory 实例 */
  function deliverRequest(adapters: CompanionDialogAdapters, requestId: string, sessionId = 's1'): void {
    const handler = vi.fn()
    const unsub = adapters.source.onUiRequest(handler)
    bus.emit({ kind: 'ui-request', sessionId, request: { requestId, pluginId: 'p1', kind: 'confirm' } })
    unsub()
  }

  it('TC-G1a: pi respond（sendPiResponse）后表项删除——迟到撤窗广播 miss noop', () => {
    // [G1] pi 源 dialog 的有效清理路径只有 respond（extension UI 请求无超时撤窗广播）。
    const adapters = createCompanionDialogAdapters(bus)
    const expiredHandler = vi.fn()
    const unsubExpired = adapters.source.onUiRequestExpired(expiredHandler)
    deliverRequest(adapters, 'r1')
    expect(adapters.__testing.probeRequestIdSessionsSize()).toBe(1)

    // respond：用户作答 → 回传 extension.ui_response → 表项删除
    adapters.transport.sendPiResponse('s1', 'r1', 'confirm', true)
    expect(adapters.__testing.probeRequestIdSessionsSize()).toBe(0)

    // 已 respond 的请求收到迟到撤窗广播 → 反查 miss → noop（不误触已达应答 dialog）
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r1', pluginId: 'p1' } })
    expect(expiredHandler).not.toHaveBeenCalled()
    unsubExpired()
  })

  it('TC-G1b: plugin respond（sendPluginResponse）后表项删除——迟到撤窗广播 miss noop', () => {
    const adapters = createCompanionDialogAdapters(bus)
    const expiredHandler = vi.fn()
    const unsubExpired = adapters.source.onUiRequestExpired(expiredHandler)
    deliverRequest(adapters, 'r2')
    expect(adapters.__testing.probeRequestIdSessionsSize()).toBe(1)

    adapters.transport.sendPluginResponse('r2', { value: 'x' })
    expect(adapters.__testing.probeRequestIdSessionsSize()).toBe(0)

    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r2', pluginId: 'p1' } })
    expect(expiredHandler).not.toHaveBeenCalled()
    unsubExpired()
  })

  it('TC-G1d: 反查表为模块级共享（双消费方共管不变量）——跨 factory/独立 transport 同表；reset 清空', () => {
    const a = createCompanionDialogAdapters(bus)
    const b = createCompanionDialogAdapters(bus)
    // factory source 投递写入的表项，对另一次 factory 调用与独立 createUiResponseTransport
    // 均可见（btw 面板经后者 respond 时必须删得到同一表项，G1 补删才成立）
    deliverRequest(a, 'r1')
    expect(a.__testing.probeRequestIdSessionsSize()).toBe(1)
    expect(b.__testing.probeRequestIdSessionsSize()).toBe(1)

    b.__testing.resetRequestIdSessionsForTest()
    expect(a.__testing.probeRequestIdSessionsSize()).toBe(0)
  })
})

// ======================================================================
// ← extension-host/__tests__/view-host-suite.test.ts
// ======================================================================

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
  { viewId: 'todo', title: '任务', pluginId: 'tasks' },
  { viewId: 'goal', title: '目标', pluginId: 'tasks' },
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
      { viewId: 'ext-view', title: '外部视图', pluginId: 'other' },
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
      { viewId: 'ext-view', title: '外部视图', pluginId: 'other' },
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

// ======================================================================
// ← features/chat/__tests__/BlockScrollBox.test.ts
// ======================================================================

// vue-i18n 的 useI18n 覆盖为自包含 t（vitest.setup.ts 默认 mock 直接回 key——
// 本用例要断言展开/收起与行区间文案，故给真实文案字典 + 命名参数插值；共享口径见 helpers/i18n-mock）
vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../helpers/i18n-mock')
  return i18nMock({
    'panel.message.blockScrollExpandAll': '展开全部',
    'panel.message.collapse': '收起',
    'panel.message.blockScrollLines': '{from}–{to} / {total} 行',
  })
})

/** 内容行高（px）：信息条行区间断言的实测路径（slot 内容内联 line-height） */
const CONTENT_LINE_HEIGHT = 20
/** 降级路径字号（px）：line-height 为 normal 时按 字号 × leading-snug(1.375) = 19.25px 估算 */
const FALLBACK_FONT_SIZE = 14

const VIEWPORT_SEL = '[data-testid="block-scroll-viewport"]'
const FADE_TOP_SEL = '[data-testid="block-scroll-fade-top"]'
const FADE_BOTTOM_SEL = '[data-testid="block-scroll-fade-bottom"]'
const INFO_SEL = '[data-testid="block-scroll-info"]'
const RANGE_SEL = '[data-testid="block-scroll-range"]'
const TOGGLE_SEL = '[data-testid="block-scroll-toggle"]'
const LABEL_SEL = '[data-testid="block-scroll-toggle-label"]'
const CONTENT_SEL = '[data-testid="block-scroll-content"]'

interface ScrollMetrics {  // oe-exempt:20261027:test:
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

interface BoxHarness {  // oe-exempt:20261027:test:
  wrapper: ReturnType<typeof mountBox>
  viewport: HTMLElement
  metrics: ScrollMetrics
  /** 排空 MutationObserver 回调（微任务） */
  flush: () => Promise<void>
  /** 模拟滚动到指定位置（派发 scroll 事件 → 组件重测） */
  scrollTo: (top: number) => Promise<void>
  /** 模拟内容增长（不改几何值，只触发观测回调） */
  appendContent: () => void
}

/** 滚动几何 mock（getter 形态：mock 对象持续可变，支撑「增长后 scrollHeight 变化」用例） */
function mockScrollMetrics(el: HTMLElement): ScrollMetrics {
  const metrics: ScrollMetrics = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value
    },
  })
  return metrics
}

/**
 * 挂载：slot 内容带内联行高（实测路径）或字号（降级路径）。
 * attachTo body：getComputedStyle 需要有文档上下文（同 WidgetArea.test.ts 范式）。
 */
function mountBox(options: { surface?: 'canvas' | 'recessed'; fade?: boolean; lineHeight?: number; fontSize?: number } = {}) {
  const style = options.lineHeight !== undefined
    ? `line-height: ${options.lineHeight}px`
    : `font-size: ${options.fontSize ?? FALLBACK_FONT_SIZE}px`
  const props: Record<string, unknown> = {}
  if (options.surface) props.surface = options.surface
  if (options.fade !== undefined) props.fade = options.fade
  return mount(BlockScrollBox, {
    attachTo: document.body,
    props,
    slots: { default: `<div data-testid="block-scroll-content" style="${style}">content</div>` },
  })
}

function setupBox(options: { surface?: 'canvas' | 'recessed'; fade?: boolean; lineHeight?: number; fontSize?: number } = {}): BoxHarness {
  const wrapper = mountBox(options)
  const viewport = wrapper.get(VIEWPORT_SEL).element as HTMLElement
  const metrics = mockScrollMetrics(viewport)
  return {
    wrapper,
    viewport,
    metrics,
    flush: () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve()
        }, 0)
      }),
    scrollTo: async (top: number) => {
      metrics.scrollTop = top
      await wrapper.get(VIEWPORT_SEL).trigger('scroll')
    },
    appendContent: () => {
      wrapper.get(CONTENT_SEL).element.appendChild(document.createTextNode(' more'))
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

/** 渐隐条是否显形（scroll 事件切 opacity class：opacity-100 = 该方向可滚） */
function fadeVisible(box: BoxHarness, sel: string): boolean {
  return box.wrapper.get(sel).classes().includes('opacity-100')
}

describe('BlockScrollBox 限高与信息条渲染', () => {
  it('限高 style：视口 max-height = var(--block-scroll-max-height)；展开全部后解除（maxHeight none）', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    // 未展开：限高走 token（真值源 renderer style.css / mobile tokens.css 镜像）
    expect(box.viewport.style.maxHeight).toBe('var(--block-scroll-max-height)')

    // 造溢出 → 信息条可见 → 点展开全部
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(true)

    await box.wrapper.get(TOGGLE_SEL).trigger('click')
    expect(box.viewport.style.maxHeight).toBe('none')

    // 收起回滚限高
    await box.wrapper.get(TOGGLE_SEL).trigger('click')
    expect(box.viewport.style.maxHeight).toBe('var(--block-scroll-max-height)')
    box.wrapper.unmount()
  })

  it('内容不超限高：信息条整条不渲染（展开按钮一并缺席），两侧渐隐条均不显形', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 200
    box.metrics.clientHeight = 240 // 240px 限高内容装得下
    await box.scrollTo(0)
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(false)
    expect(box.wrapper.find(TOGGLE_SEL).exists()).toBe(false)
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(false)
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(false)
    box.wrapper.unmount()
  })

  it('溢出：信息条渲染，渐隐 class 随滚动方向切换（顶部→仅下渐隐 / 中部→上下都有 / 底部→仅上渐隐）', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(true)
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(true)
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(false)

    await box.scrollTo(80) // 中部
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(true)
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(true)

    await box.scrollTo(160) // 底部（scrollHeight - clientHeight）
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(true)
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(false)
    box.wrapper.unmount()
  })

  it('渐隐底色上下文：surface prop → 根 --block-scroll-fade-bg（默认画布底 / recessed = 凹槽底）', () => {
    const canvasBox = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    expect(canvasBox.wrapper.element.style.getPropertyValue('--block-scroll-fade-bg')).toBe('var(--bg)')
    canvasBox.wrapper.unmount()

    const recessedBox = setupBox({ surface: 'recessed', lineHeight: CONTENT_LINE_HEIGHT })
    expect(recessedBox.wrapper.element.style.getPropertyValue('--block-scroll-fade-bg')).toBe('var(--bg-input)')
    recessedBox.wrapper.unmount()
  })

  it('fade=false：两渐隐条整条不渲染（DOM 无该元素）；限高滚动与信息条行为不变', async () => {
    const box = setupBox({ fade: false, lineHeight: CONTENT_LINE_HEIGHT })
    expect(box.wrapper.find(FADE_TOP_SEL).exists()).toBe(false)
    expect(box.wrapper.find(FADE_BOTTOM_SEL).exists()).toBe(false)

    // 溢出 + 滚动到中部（既有形态下该位置两渐隐条都显形）→ 仍无元素，非仅 opacity 关闭
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(80)
    expect(box.wrapper.find(FADE_TOP_SEL).exists()).toBe(false)
    expect(box.wrapper.find(FADE_BOTTOM_SEL).exists()).toBe(false)
    // 限高与信息条不受 fade 影响
    expect(box.viewport.style.maxHeight).toBe('var(--block-scroll-max-height)')
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(true)
    box.wrapper.unmount()
  })

  it('默认（不传 fade）：两渐隐条渲染在 DOM，溢出时显形行为与现状一致', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    expect(box.wrapper.find(FADE_TOP_SEL).exists()).toBe(true)
    expect(box.wrapper.find(FADE_BOTTOM_SEL).exists()).toBe(true)
    // 底部可下滚 → 下渐隐显形（同既有「溢出」用例方向判据）
    expect(fadeVisible(box, FADE_BOTTOM_SEL)).toBe(true)
    expect(fadeVisible(box, FADE_TOP_SEL)).toBe(false)
    box.wrapper.unmount()
  })
})

describe('BlockScrollBox 行区间信息条', () => {
  it('行高实测路径（20px）：内容 400px / 视口 240px → 1–12 / 20 行；滚到底 → 9–20 / 20 行', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    expect(box.wrapper.get(RANGE_SEL).text()).toBe('1–12 / 20 行')

    await box.scrollTo(160)
    expect(box.wrapper.get(RANGE_SEL).text()).toBe('9–20 / 20 行')
    box.wrapper.unmount()
  })

  it('行高降级路径（line-height normal + 字号 14px → 字号 × leading-snug 估算）：500px 内容 → 1–12 / 26 行', async () => {
    const box = setupBox({ fontSize: FALLBACK_FONT_SIZE })
    box.metrics.scrollHeight = 500
    box.metrics.clientHeight = 240
    await box.scrollTo(0)
    // 14 × 1.375 = 19.25px → round(500 / 19.25) = 26 行（若误用 16px 默认字号会得 23 行）
    expect(box.wrapper.get(RANGE_SEL).text()).toBe('1–12 / 26 行')
    box.wrapper.unmount()
  })
})

describe('BlockScrollBox 展开全部切换', () => {
  it('按钮文案与 aria：展开 ↓ → 收起 ↑（aria-expanded 同步），展开态信息条保留', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(0)

    const toggle = box.wrapper.get(TOGGLE_SEL)
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(box.wrapper.get(LABEL_SEL).text()).toBe('展开全部')
    expect(toggle.text()).toContain('↓')

    await toggle.trigger('click')
    expect(box.wrapper.get(TOGGLE_SEL).attributes('aria-expanded')).toBe('true')
    expect(box.wrapper.get(LABEL_SEL).text()).toBe('收起')
    expect(box.wrapper.get(TOGGLE_SEL).text()).toContain('↑')
    // 展开态信息条保留（收起按钮是其唯一入口）
    expect(box.wrapper.find(INFO_SEL).exists()).toBe(true)
    box.wrapper.unmount()
  })
})

describe('BlockScrollBox streaming 吸底', () => {
  it('内容增长且未上滚 → 贴底；用户上滚后停吸；回底恢复吸底', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 100
    box.metrics.clientHeight = 240
    await box.scrollTo(0) // 内容未超限高 = 贴底态

    // ① 增长 → 吸底
    box.metrics.scrollHeight = 400
    box.appendContent()
    await box.flush()
    expect(box.viewport.scrollTop).toBe(400)

    // ② 用户上滚 → 停吸（新内容不再把视口拉走）
    await box.scrollTo(0)
    box.metrics.scrollHeight = 500
    box.appendContent()
    await box.flush()
    expect(box.viewport.scrollTop).toBe(0)

    // ③ 回底 → 恢复吸底
    await box.scrollTo(260) // 500 - 240
    box.metrics.scrollHeight = 600
    box.appendContent()
    await box.flush()
    expect(box.viewport.scrollTop).toBe(600)
    box.wrapper.unmount()
  })

  it('展开全部态不吸底（内容已全量可见，视口位置不动）', async () => {
    const box = setupBox({ lineHeight: CONTENT_LINE_HEIGHT })
    box.metrics.scrollHeight = 400
    box.metrics.clientHeight = 240
    await box.scrollTo(160) // 贴底
    await box.wrapper.get(TOGGLE_SEL).trigger('click') // 展开全部

    box.metrics.scrollHeight = 500
    box.appendContent()
    await box.flush()
    expect(box.viewport.scrollTop).toBe(160)
    box.wrapper.unmount()
  })
})

// ======================================================================
// ← features/composer/__tests__/composer-suite.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← composer-injection-real-dom.test.ts
// ======================================================================

beforeEach(() => {
  document.body.innerHTML = ''
})

/**
 * 搭建真实 chip 操作链路：contenteditable div + useComposerChipCommands（真实 DOM）+
 * 一个模拟 ComposerInput 的 expose 对象（含真实 insertFileChip）。
 * useComposerInjection 通过 inputRef.value.insertFileChip 调用，与真实 ComposerInput 行为一致。
 * store 用 core factory 本地实例（每 setup 新建，隔离测试间状态）。
 */
function setupRealChipChain(variant: 'panel' | 'landing', sessionId: string | null, store?: ReturnType<typeof createComposerInjectionStore>) {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.setAttribute('data-testid', 'composer-input')
  document.body.appendChild(el)
  // 清掉前一个测试残留的 selection range（指向已移除节点会导致 insertNode 静默失败）
  window.getSelection()?.removeAllRanges()
  const elRef = ref(el) as Ref<HTMLDivElement | null>
  // 真实 restoreSelection 链路（设计 D1 / u2 改写点）：不 mock restoreSelection——
  // 活选区优先 + savedRange blur 回退的真实语义是 chip 落位正确性的被测对象，
  // mock 会掩盖插入位置回归（composer chip bug 存活根因）
  const inputCallbacks = {
    onInput: vi.fn(),
    onSlashTrigger: vi.fn(),
    onFileTrigger: vi.fn(),
    onEnterKeydown: vi.fn(),
    onKeydown: vi.fn(),
    handleBackspaceOnChip: vi.fn(() => false),
    insertImageBadge: vi.fn(),
    getSessionId: vi.fn(() => 's1'),
    pasteImage: vi.fn(),
  } as unknown as ContenteditableCallbacks
  const input = useContenteditableInput(elRef, inputCallbacks)
  const chipCommands = useComposerChipCommands(elRef, {
    onChanged: vi.fn(),
    restoreSelection: input.restoreSelection,
    renderIcon: () => false,
    t: (key: string) => key,
  } as ChipCallbacks)
  // 模拟 ComposerInput 的 defineExpose 对象（useComposerInjection 通过 inputRef.value 访问）。
  // W4：core 统一 ComposerInputInstance 契约（input/types.ts）——mock 只实现注入消费方，
  // 用断言补齐剩余方法（clear/setText 等壳层消费方法在真实组件上有，mock 不需要）。
  const fakeInputRef = ref({
    focus: vi.fn(),
    insertFileChip: chipCommands.insertFileChip,
  }) as unknown as Ref<ComposerInputInstance | null>
  const sessionIdRef = ref(sessionId)
  const variantRef = ref(variant)
  // 双挂载场景传入共享 store（模拟 pinia 单例语义），否则本地新建隔离实例
  const injectionStore = store ?? createComposerInjectionStore()
  useComposerInjection(fakeInputRef, sessionIdRef, variantRef, {
    injectionStore,
    startFlow: vi.fn(async () => {}),
    getSessionCwd: () => undefined,
    getActiveSessionId: () => sessionIdRef.value,
  })
  return { el, store: injectionStore, input }
}

/** 把光标 collapse 到指定文本节点的 offset 处 */
function setCursor(node: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('composer 注入真实 DOM chip（R1/R3）', () => {
  it('R1: target=current → watch → contenteditable 内真实 .mention-file chip', async () => {
    const { el, store } = setupRealChipChain('panel', 's1')
    store.requestInjection({ target: 'current', path: 'src/foo.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipType).toBe('file')
    expect(chip.dataset.chipPath).toBe('src/foo.ts')
    expect(chip.querySelector('.chip-label')).toBeTruthy()
  })

  it('R1b: target=current 带 lineRange → 真实 chip dataset 含行范围', async () => {
    const { el, store } = setupRealChipChain('panel', 's1')
    store.requestInjection({
      target: 'current',
      path: 'src/foo.ts',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 's1',
    })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip.dataset.chipLineStart).toBe('10')
    expect(chip.dataset.chipLineEnd).toBe('20')
  })

  it('R3: target=new → landing composer 消费 → 真实 DOM chip', async () => {
    const { el, store } = setupRealChipChain('landing', null)
    store.requestInjection({ target: 'new', path: 'bar.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipPath).toBe('bar.ts')
  })

  it('R1c: 注入后 pendingInjection 清空（消费即清）', async () => {
    const { store } = setupRealChipChain('panel', 's1')
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    await nextTick()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('R1d: 真实选区链路——savedRange=头部旧快照 + 活光标在草稿末尾 → 注入 chip 落活光标处（设计 D1）', async () => {
    const { el, store, input } = setupRealChipChain('panel', 's1')
    el.textContent = 'AAA BBB'
    const textNode = el.firstChild as Text
    // savedRange 旧快照 = 头部（模拟点击框后打字推进，savedRange 不随打字更新）
    setCursor(textNode, 0)
    input.saveSelection()
    // 活光标在草稿末尾（键盘路径焦点从未离开）
    setCursor(textNode, 7)
    store.requestInjection({ target: 'current', path: 'cursor.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.dataset.chipPath).toBe('cursor.ts')
    // chip 不在头部（失败模式 A 回归）：firstChild 仍是正文文本，chip 紧跟其后
    expect(el.firstChild).toBe(textNode)
    expect(chip.previousSibling).toBe(textNode)
  })
})

// ── W18: split / dual panel 多 Composer 实例守护测试 ─────────────────────────────
// 防的 bug：split（panel+landing 同时挂载）/ dual panel 场景下，target=current 且
// sessionId 匹配活跃 session 时，可能被多个 Composer 实例误消费（双重注入）。
// 锁定契约：variant=panel 按 sessionId 精确匹配，variant=landing 仅消费 sessionId=null 的请求。
describe('W18: split / dual panel 多 Composer 实例注入隔离', () => {
  /**
   * 双挂载 setup：panel + landing 两个 Composer 共享同一 composerInjectionStore
   * 与同一 contenteditable 池（用不同 el 模拟两个独立 Composer 实例）。
   */
  function setupDualMount(panelSessionId: string | null) {
    // 共享同一 store（模拟 pinia 单例语义：drawer 写入 + 双 Composer 消费同一通道）
    const sharedStore = createComposerInjectionStore()
    const panelChain = setupRealChipChain('panel', panelSessionId, sharedStore)
    const landingChain = setupRealChipChain('landing', null, sharedStore)
    return {
      panelEl: panelChain.el,
      landingEl: landingChain.el,
      store: sharedStore,
    }
  }

  it('W18-1: panel + landing 双挂载 + target=current + sessionId=活跃 session → 仅 panel 注入，landing 不误消费', async () => {
    // 场景：split 视图（panel 显示活跃 session 的对话流，landing 显示空起始页）。
    // 用户从 drawer 注入到「当前活跃 session」。
    // 期望：panel composer（variant=panel，sessionId 匹配活跃 session）消费；
    //      landing composer（variant=landing，sessionId=null 不匹配 current 的非 null sessionId）不消费。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'main.ts', sessionId: 's-active' })
    await nextTick()

    // panel 注入成功
    const panelChip = panelEl.querySelector('.mention-file') as HTMLElement
    expect(panelChip).toBeTruthy()
    expect(panelChip.dataset.chipPath).toBe('main.ts')

    // landing 未注入（variant=landing 只消费 sessionId=null 的请求）
    expect(landingEl.querySelector('.mention-file')).toBeNull()

    // pendingInjection 被消费后清空（一次注入只对应一个 Composer，无双重消费）
    expect(store.pendingInjection.value).toBeNull()
  })

  it('W18-2: panel + landing 双挂载 + target=current + sessionId=null（routeToLanding 改写后）→ 仅 landing 注入', async () => {
    // 场景：阶段二，routeToLanding 把 target=new 改为 current 且 sessionId=null。
    // 此时 panel composer 不匹配（sessionId=null ≠ panel 的活跃 session），landing 匹配。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'new-task.ts', sessionId: null })
    await nextTick()

    // landing 注入成功（variant=landing 消费 sessionId=null 的 current 请求）
    const landingChip = landingEl.querySelector('.mention-file') as HTMLElement
    expect(landingChip).toBeTruthy()
    expect(landingChip.dataset.chipPath).toBe('new-task.ts')

    // panel 不匹配（sessionId=null ≠ 's-active'）
    expect(panelEl.querySelector('.mention-file')).toBeNull()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('W18-3: panel + landing 双挂载 + target=new → landing 直接消费（阶段一前置：landing 已挂载）', async () => {
    // 场景：用户停在 landing 态，从 drawer 发起新对话注入。
    // 期望：landing composer 已挂载时直接消费 target=new（不路由到自身），
    //      panel composer 不消费 target=new（仅 session composer 触发 startFlow，但此处 panel 不匹配）。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'new', path: 'fresh.ts', sessionId: 's-active' })
    await nextTick()

    // landing 直接消费 target=new
    const landingChip = landingEl.querySelector('.mention-file') as HTMLElement
    expect(landingChip).toBeTruthy()
    expect(landingChip.dataset.chipPath).toBe('fresh.ts')

    // panel 不注入（target=new 仅 landing composer 或路由阶段二消费）
    expect(panelEl.querySelector('.mention-file')).toBeNull()
    expect(store.pendingInjection.value).toBeNull()
  })
})

// ======================================================================
// ← file-chip.test.ts
// ======================================================================

/** 创建挂载在 document 上的 contenteditable div + chipCommands 实例 */
function setupChipCommands(): {
  el: HTMLDivElement
  chipCommands: ReturnType<typeof useComposerChipCommands>
} {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  const elRef = ref(el)
  // insertFileChip 内部调 restoreSelection + window.getSelection，jsdom 下需清掉旧 selection
  // 否则前一个 test 残留的 range 指向已移除节点，range.insertNode 静默失败导致 chip 没进 DOM
  window.getSelection()?.removeAllRanges()
  const onChanged = vi.fn()
  const restoreSelection = vi.fn()
  const chipCommands = useComposerChipCommands(elRef as never, {
    onChanged,
    restoreSelection,
    renderIcon: () => false,
    t: (key: string) => key,
  } as ChipCallbacks)
  return { el, chipCommands }
}

describe('W1: insertFileChip 结构化 file chip DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('U1: insertFileChip(path) 创建 .mention-file chip 含 dataset + label + x + spacer', () => {
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts')

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.classList.contains('mention-chip')).toBe(true)
    expect(chip.classList.contains('mention-file')).toBe(true)
    expect(chip.contentEditable).toBe('false')
    // dataset 结构化标记
    expect(chip.dataset.chipType).toBe('file')
    expect(chip.dataset.chipPath).toBe('src/foo.ts')
    // 子元素：chip-pre($) + chip-label + chip-x
    expect(chip.querySelector('.chip-pre')?.textContent).toBe('$')
    expect(chip.querySelector('.chip-label')).toBeTruthy()
    expect(chip.querySelector('.chip-x')).toBeTruthy()
    // 后跟 ZWSP spacer 文本节点
    const spacer = chip.nextSibling
    expect(spacer?.nodeType).toBe(Node.TEXT_NODE)
    expect(spacer?.textContent).toBe('\u200B')
  })

  it('U2: insertFileChip(path, [10,20]) 设行范围 dataset + label 显示 path:L10-L20', () => {
    const { chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts', [10, 20])

    const chip = document.querySelector('.mention-file') as HTMLElement
    expect(chip.dataset.chipLineStart).toBe('10')
    expect(chip.dataset.chipLineEnd).toBe('20')
    const label = chip.querySelector('.chip-label') as HTMLElement
    expect(label.textContent).toContain('src/foo.ts')
    expect(label.textContent).toContain('L10-L20')
  })

  it('U2b: insertFileChip(path, [10,10]) 单行 label 显示 path:L10', () => {
    const { chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts', [10, 10])

    const label = document.querySelector('.mention-file .chip-label') as HTMLElement
    expect(label.textContent).toContain('L10')
    // 单行不显示 L10-L10，只显示 L10
    expect(label.textContent).not.toContain('L10-L10')
  })

  it('U4: @mention 仍走 insertMentionChip 行为不变（非 mention-file，无 file dataset）', () => {
    const { chipCommands } = setupChipCommands()
    chipCommands.insertMentionChip('@', 'user')

    const chip = document.querySelector('.mention-chip') as HTMLElement
    expect(chip.classList.contains('mention-at')).toBe(true)
    expect(chip.classList.contains('mention-file')).toBe(false)
    // 拍平文本与旧纯 textContent 形态一致（结构化 pre(@) + label(user)，svg/× 无文本）
    expect(chip.textContent).toBe('@user')
    expect(chip.querySelector('.chip-pre')?.textContent).toBe('@')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('user')
    expect(chip.querySelector('.chip-x')).toBeTruthy()
    // 不设 file 结构化 dataset（旧通路保持无 dataset）
    expect(chip.dataset.chipType).toBeUndefined()
    expect(chip.dataset.chipPath).toBeUndefined()
  })
})

describe('W1: getSegmentsFromEl 解析 file segment', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('U3: 解析 .mention-file 产出 file segment 无文本污染', () => {
    const { el, chipCommands } = setupChipCommands()
    // 先插入文本再插入 file chip 再插入文本
    el.textContent = 'before '
    chipCommands.insertFileChip('foo.ts')
    // chip 后追加文本
    const after = document.createTextNode(' after')
    el.querySelector('.mention-file')?.after(after)

    const segments = getSegmentsFromEl(el)
    // 应产出 text(file) + file segment + text(after)，无 chip-label/x 文本污染
    expect(segments).toEqual([
      { type: 'text', text: 'before ' },
      { type: 'file', path: 'foo.ts' },
      { type: 'text', text: ' after' },
    ])
  })

  it('U3b: 解析带行范围的 file segment', () => {
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts', [10, 20])
    const segments = getSegmentsFromEl(el)
    expect(segments).toEqual([{ type: 'file', path: 'src/foo.ts', lineRange: [10, 20] }])
  })

  it('R2: 真实 DOM file chip 经 getSegments 产出 file segment（含 lineRange）', () => {
    // R2 验证 DOM→segment 真实链路（非 mock getSegmentsFromEl）
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertFileChip('src/foo.ts', [10, 20])
    const segments = getSegmentsFromEl(el)
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('file')
    if (segments[0].type === 'file') {
      expect(segments[0].path).toBe('src/foo.ts')
      expect(segments[0].lineRange).toEqual([10, 20])
    }
  })
})

// ======================================================================
// ← useComposerChipCommands.image.test.ts
// ======================================================================

/** 创建挂载在 document 上的 contenteditable div + chipCommands 实例（同 file-chip.test 范式） */
function setupChipCommands_m2(): {
  el: HTMLDivElement
  chipCommands: ReturnType<typeof useComposerChipCommands>
} {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  const elRef = ref(el)
  window.getSelection()?.removeAllRanges()
  const onChanged = vi.fn()
  const restoreSelection = vi.fn()
  const chipCommands = useComposerChipCommands(elRef as never, {
    onChanged,
    restoreSelection,
    renderIcon: () => false,
    t: (key: string) => key,
  } as ChipCallbacks)
  return { el, chipCommands }
}

describe('TC6: insertImageBadge DOM 结构', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('创建 .image-chip span + dataset + label + x + ZWSP spacer', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    chipCommands.insertImageBadge('/tmp/x.png', 'x-uuid.png', 'x.png')

    const chip = el.querySelector('.image-chip') as HTMLElement
    expect(chip).toBeTruthy()
    // 复用 mention-chip 基础样式（TO2）+ image-chip 修饰
    expect(chip.classList.contains('mention-chip')).toBe(true)
    expect(chip.classList.contains('image-chip')).toBe(true)
    expect(chip.contentEditable).toBe('false')
    // C2 DOM schema：dataset 结构化标记（fileName 磁盘全名 + displayName 用户可读名）
    expect(chip.dataset.chipType).toBe('image')
    expect(chip.dataset.chipPath).toBe('/tmp/x.png')
    expect(chip.dataset.chipFileName).toBe('x-uuid.png')
    expect(chip.dataset.chipDisplayName).toBe('x.png')
    // M1：needsMigrate 默认 false（省略第 4 参数）→ dataset 'false'（+菜单选的磁盘文件不迁移）
    expect(chip.dataset.chipNeedsMigrate).toBe('false')
    // C3：chipId 是稳定唯一 uuid（crypto.randomUUID），同一文件附两次时 ContextChipsBar :key 用它区分
    expect(chip.dataset.chipId).toBeTruthy()
    expect(chip.dataset.chipId!.length).toBeGreaterThan(0)
    // 子元素：chip-label（显 displayName 用户可读名）+ chip-x
    const label = chip.querySelector('.chip-label') as HTMLElement
    expect(label).toBeTruthy()
    expect(label.textContent).toBe('x.png')
    expect(chip.querySelector('.chip-x')).toBeTruthy()
    // 后跟 ZWSP spacer 文本节点
    const spacer = chip.nextSibling
    expect(spacer?.nodeType).toBe(Node.TEXT_NODE)
    expect(spacer?.textContent).toBe('\u200B')
  })

  it('M1: insertImageBadge 第 4 参数 needsMigrate=true → dataset.chipNeedsMigrate="true"', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    // landing 态粘贴落 tmpdir 的图需迁移 → needsMigrate=true
    chipCommands.insertImageBadge('/tmp/x.png', 'x-uuid.png', 'x.png', true)
    const chip = el.querySelector('.image-chip') as HTMLElement
    expect(chip.dataset.chipNeedsMigrate).toBe('true')
  })

  it('C3: 同一文件附两次 → 两个 chip 各有唯一 chipId（path 重复但 id 不冲突）', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    chipCommands.insertImageBadge('/tmp/dup.png', 'dup.png', 'dup.png')
    chipCommands.insertImageBadge('/tmp/dup.png', 'dup.png', 'dup.png')

    const chips = el.querySelectorAll<HTMLElement>('.image-chip')
    expect(chips.length).toBe(2)
    // path 相同（同一文件），id 必须不同（否则 ContextChipsBar :key 冲突）
    expect(chips[0].dataset.chipPath).toBe('/tmp/dup.png')
    expect(chips[1].dataset.chipPath).toBe('/tmp/dup.png')
    expect(chips[0].dataset.chipId).not.toBe(chips[1].dataset.chipId)
  })

  it('onChanged 被调用', () => {
    const onChanged = vi.fn()
    const el = document.createElement('div')
    document.body.appendChild(el)
    const cc = useComposerChipCommands(ref(el) as never, {
      onChanged,
      restoreSelection: vi.fn(),
      renderIcon: () => false,
      t: (key: string) => key,
    } as ChipCallbacks)
    cc.insertImageBadge('/tmp/a.png', 'a.png', 'a.png')
    expect(onChanged).toHaveBeenCalled()
  })
})

describe('image badge lead 缩略图（demo .ichip .thumb，demo 对齐）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('badge 内渲染 img.chip-thumb（src = local-file:// 编码路径 + alt 用户可读名），位次在 label 前', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    chipCommands.insertImageBadge('/tmp/我的 截图.png', 'x-uuid.png', '截图.png')

    const chip = el.querySelector('.image-chip') as HTMLElement
    const img = chip.querySelector('img.chip-thumb') as HTMLImageElement
    expect(img).toBeTruthy()
    // local-file:// 协议（main protocol.handle 白名单通道），路径段整体 encodeURIComponent
    expect(img.src).toBe('local-file:///' + encodeURIComponent('/tmp/我的 截图.png'))
    expect(img.alt).toBe('截图.png')
    // lead 位次：label 之前（demo chipHtml lead + nm + x 顺序）
    expect(img.nextElementSibling?.classList.contains('chip-label')).toBe(true)
  })

  it('img 加载失败（error 事件）→ 回退 ImageIcon 占位（span.chip-icon 内联 svg），不留破图', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    chipCommands.insertImageBadge('/tmp/missing.png', 'missing.png', 'missing.png')

    const img = el.querySelector('img.chip-thumb') as HTMLImageElement
    expect(img).toBeTruthy()
    img.dispatchEvent(new Event('error'))

    // img 被占位 svg 替换：span.chip-icon.chip-thumb-fallback 内 12px svg（lucide image 同款三段）
    const fallback = el.querySelector('.chip-thumb-fallback') as HTMLElement
    expect(fallback).toBeTruthy()
    expect(el.querySelector('img.chip-thumb')).toBeNull()
    const svg = fallback.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('width')).toBe('12')
    // 占位复用 chip-icon 容器（壳层既有 12px 规格样式）
    expect(fallback.classList.contains('chip-icon')).toBe(true)
  })
})

describe('TC7: getSegmentsFromEl image 分支', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('解析 [text][image-chip][text] → 3 段，image chip 子树文本不污染', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    el.textContent = 'hello'
    chipCommands.insertImageBadge('/tmp/a.png', 'a-uuid.png', 'a.png')
    // chip 后追加文本
    el.querySelector('.image-chip')?.after(document.createTextNode('world'))

    const segments = getSegmentsFromEl(el)
    expect(segments).toEqual([
      { type: 'text', text: 'hello' },
      // C3：image segment 含稳定唯一 id（chip.dataset.chipId 的 uuid）+ fileName/displayName
      // M1：默认 needsMigrate=false（insertImageBadge 未传第 4 参数 → dataset 'false' → segment false）
      { type: 'image', id: expect.any(String), path: '/tmp/a.png', fileName: 'a-uuid.png', displayName: 'a.png', needsMigrate: false },
      { type: 'text', text: 'world' },
    ])
    // chip-label 'a.png' 与 chip-x '×' 不出现在任何 text segment（rejectChipSubtree 生效）
    const textContent = segments
      .filter((s): s is { type: 'text'; text: string } => s.type === 'text')
      .map((s) => s.text)
      .join('')
    expect(textContent).not.toContain('×')
  })

  it('M1: getSegmentsFromEl 读 dataset.chipNeedsMigrate="true" → segment.needsMigrate=true', () => {
    const { el, chipCommands } = setupChipCommands_m2()
    // landing 态 writeSessionImage 落 tmpdir 的图 → needsMigrate=true
    chipCommands.insertImageBadge('/tmp/landing.png', 'landing.png', '截图.png', true)
    const segments = getSegmentsFromEl(el)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ type: 'image', needsMigrate: true })
  })

  it('W2: getSegmentsFromEl 跳过 __paste_pending_ / __drag_pending_ 占位符（防占位进 pi prompt）', () => {
    // 场景：用户粘图/拖图时插了占位 badge（path=__paste_pending_<uuid>__），
    // 在 await handleImagePaste 完成前按 Enter 发送——占位符 path 无效，不应进 segments。
    // 这里同时构造 paste 与 drag 两种占位 + 1 个真实 image + text，断言占位被静默丢弃。
    const { el, chipCommands } = setupChipCommands_m2()
    el.textContent = '前'
    // 占位 badge：path/fileName 用 __paste_pending_<uuid>__ / __drag_pending_<uuid>__
    chipCommands.insertImageBadge(
      '__paste_pending_11111111-1111-1111-1111-111111111111__',
      '__paste_pending_11111111-1111-1111-1111-111111111111__',
      '粘贴中...',
    )
    chipCommands.insertImageBadge(
      '__drag_pending_22222222-2222-2222-2222-222222222222__',
      '__drag_pending_22222222-2222-2222-2222-222222222222__',
      '拖入中…',
    )
    // 真实 image badge（已回填的真实 path）
    chipCommands.insertImageBadge('/tmp/real.png', 'real.png', 'real.png')
    // 末尾追加文本
    el.querySelector('.image-chip:nth-last-of-type(1)')?.after(document.createTextNode('后'))

    const segments = getSegmentsFromEl(el)
    // 占位符被丢弃：只剩「前」text + 真实 image + 「后」text，无任何 pending path
    expect(segments).toEqual([
      { type: 'text', text: '前' },
      expect.objectContaining({ type: 'image', path: '/tmp/real.png' }),
      { type: 'text', text: '后' },
    ])
    // 关键断言：没有任何 segment 的 path 形如 __paste_pending_ / __drag_pending_
    const allPaths = segments
      .filter((s): s is Extract<typeof s, { type: 'image'; path: string }> => s.type === 'image')
      .map((s) => s.path)
    expect(allPaths.some((p) => /__(?:paste|drag)_pending_/.test(p))).toBe(false)
  })
})
