/**
 * shell-adapters.test.ts —— 双壳共享 extension-host 壳侧适配层单测。
 *
 * 覆盖（自 renderer composables/shell 平移，行为语义全量保持）：
 * - createWsPluginMessageSource 过滤条件（FR1/AC1）：TC1 plugin:uiRequest 前缀放行 /
 *   TC1b plugin:viewUpdate / TC2 extension.ui_request 白名单放行 / TC3 extension.error 拒绝 /
 *   TC4 plugin:statusBarUpdate 回归 / TC5 白名单 5 项字面量 + 行为级验证
 * - convertToDialogRequest 转换（FR2/AC2）：TC1-TC4（source 判定 / askUser 改写 / options
 *   归一 / method 超界恢复 + receivedAt）
 * - createCompanionDialogAdapters 投递层：TC5 无 sessionId 跳过；TC6/TC6m askUser 路由
 *   钉子（routeAskUser='panel' 过滤 C4 分流 / 'companion' 全投递——双壳唯一行为差异，
 *   两侧取值都钉进断言）；TC10 onUiRequestExpired 撤窗（D2，requestId 反查 + miss noop）
 * - transport 回传双通道（FR7/AC6/AC9）：TC7/TC8/TC8b
 * - requestIdSessions 生命周期（G1 / memory-leak-remediation §3.4）：TC-G1a/b/c
 *
 * 策略：convertToDialogRequest 直测（纯函数）；source 用真实 InternalEventBus（bus.emit）
 * + dispatchGlobal/dispatchCrossSession（events 通道）——全链路范式；transport 用 vi.mock
 * 断言 send 调用形状。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EXTENSION_BRIDGE_TYPES, InternalEventBus, MessageBusBridge } from '@taiji/core'
import type { InternalEvent } from '@taiji/core'
import { dispatchCrossSession, dispatchGlobal } from '@taiji/core/transport/api'

vi.mock('@taiji/core/transport/ws-client', () => ({
  send: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  sendExtensionUIResponse: vi.fn(),
}))

import { send } from '@taiji/core/transport/ws-client'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'
import {
  convertToDialogRequest,
  createCompanionDialogAdapters,
  createWsPluginMessageSource,
  type CompanionDialogAdapters,
} from '../shell-adapters'

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

  it('TC2: askUser 改写——askUser:true → method=askUser + askUserQuestions/allowCancel 透传', () => {
    const e = makeUiRequestEvent({ kind: 'input' }) as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e.request.askUser = true
    e.request.askUserQuestions = [{ question: '继续?' }]
    e.request.allowCancel = false

    const req = convertToDialogRequest(e)
    expect(req.method).toBe('askUser')
    expect(req.askUserQuestions).toEqual([{ question: '继续?' }])
    expect(req.allowCancel).toBe(false)
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

  it('TC5: 无 sessionId 事件跳过投递 + console.warn（两路由共用守卫）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapters = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
    const handler = vi.fn()
    const unsub = adapters.source.onUiRequest(handler)

    bus.emit({ kind: 'ui-request', sessionId: undefined, request: { requestId: 'r1', pluginId: 'p1', kind: 'select' } })

    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    unsub()
    warn.mockRestore()
  })

  it('TC6: routeAskUser=panel（桌面壳）——askUser:true 不投递（C4 分流给 Panel inline），非 askUser 正常投递', () => {
    const adapters = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
    const handler = vi.fn()
    const unsub = adapters.source.onUiRequest(handler)

    bus.emit({
      kind: 'ui-request',
      sessionId: 's1',
      request: { requestId: 'r-ask', pluginId: '', kind: 'input', askUser: true },
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

  it('TC6m: routeAskUser=companion（移动壳）——askUser 事件全投递（CompanionBand 独占，method=askUser 改写透传）', () => {
    const adapters = createCompanionDialogAdapters(bus, { routeAskUser: 'companion' })
    const handler = vi.fn()
    const unsub = adapters.source.onUiRequest(handler)

    bus.emit({
      kind: 'ui-request',
      sessionId: 's1',
      request: {
        requestId: 'r-ask',
        pluginId: '',
        kind: 'input',
        askUser: true,
        askUserQuestions: [{ question: '继续?' }],
        allowCancel: true,
      },
    })
    expect(handler).toHaveBeenCalledTimes(1)
    const delivered = handler.mock.calls[0][0]
    expect(delivered.requestId).toBe('r-ask')
    expect(delivered.method).toBe('askUser')
    expect(delivered.askUserQuestions).toEqual([{ question: '继续?' }])
    expect(delivered.allowCancel).toBe(true)

    // 非 askUser dialog 同通道正常投递（全 method 投递，v1 移动壳能力边界）
    bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r-dialog', pluginId: 'p1', kind: 'select' } })
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls[1][0]).toMatchObject({ requestId: 'r-dialog', method: 'select', source: 'plugin' })
    unsub()
  })

  it('TC10: onUiRequestExpired 订阅 global 通道 plugin:uiRequestExpired（D2 撤窗，requestId 反查 sessionId）', () => {
    const adapters = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
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

    unsubExpired()
    unsubRequest()
  })

  it('TC-BUS: onUiRequest 退订后 bus 事件不再投递（订阅/退订时序契约，双壳共用）', () => {
    const adapters = createCompanionDialogAdapters(bus, { routeAskUser: 'companion' })
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
    bus = new InternalEventBus()
  })

  it('TC7: sendPluginResponse 发 plugin.uiResponse（runtime handleUiResponse 消费）', () => {
    const { transport } = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
    transport.sendPluginResponse('r1', { value: 'x' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: 'plugin.uiResponse',
      payload: { requestId: 'r1', result: { value: 'x' } },
    })
  })

  it('TC8: sendPiResponse 复用 sendExtensionUIResponse（extension.ui_response，method 透传）', () => {
    const { transport } = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
    transport.sendPiResponse('s1', 'r1', 'editor', 'value')
    expect(sendExtensionUIResponse).toHaveBeenCalledTimes(1)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'editor', 'value')
  })

  it('TC8b: sendPiResponse 兜底——非法 method 落到 input（对齐 kind 兜底语义）', () => {
    const { transport } = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
    transport.sendPiResponse('s1', 'r1', 'unknown-method', true)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'input', true)
  })
})

// ── requestIdSessions 生命周期（G1 / memory-leak-remediation §3.4）──────────

describe('requestIdSessions respond 路径删除（G1 / memory-leak-remediation §3.4）', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    vi.clearAllMocks()
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
    const adapters = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
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
    const adapters = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
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

  it('TC-G1c: 未 respond 的表项保留——撤窗反查仍命中（respond 删除不误伤展示中条目）', () => {
    // 防御性边界：respond 补删不能波及排队/展示中（未作答）条目——撤窗路径仍按 D2 语义反查出队
    const adapters = createCompanionDialogAdapters(bus, { routeAskUser: 'panel' })
    const expiredHandler = vi.fn()
    const unsubExpired = adapters.source.onUiRequestExpired(expiredHandler)
    deliverRequest(adapters, 'r3', 's9')
    expect(adapters.__testing.probeRequestIdSessionsSize()).toBe(1)

    // 无 respond，直接撤窗 → 反查命中（投递时归属 sid）+ 出队后表项删除（原有语义保持）
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r3', pluginId: 'p1' } })
    expect(expiredHandler).toHaveBeenCalledTimes(1)
    expect(expiredHandler).toHaveBeenCalledWith({ sessionId: 's9', requestId: 'r3' })
    expect(adapters.__testing.probeRequestIdSessionsSize()).toBe(0)
    unsubExpired()
  })

  it('TC-G1d: 反查表为 factory 实例私有——两次调用互不串扰；resetRequestIdSessionsForTest 清空', () => {
    const a = createCompanionDialogAdapters(bus, { routeAskUser: 'companion' })
    const b = createCompanionDialogAdapters(bus, { routeAskUser: 'companion' })
    deliverRequest(a, 'r1')
    expect(a.__testing.probeRequestIdSessionsSize()).toBe(1)
    expect(b.__testing.probeRequestIdSessionsSize()).toBe(0)

    a.__testing.resetRequestIdSessionsForTest()
    expect(a.__testing.probeRequestIdSessionsSize()).toBe(0)
  })
})
