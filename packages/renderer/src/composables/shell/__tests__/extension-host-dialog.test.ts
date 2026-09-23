/**
 * extension-host-dialog.test.ts —— CompanionBand 适配层单测（FR2/FR7，AC2/AC6/AC9）。
 *
 * 覆盖：TC1-TC4 convertToDialogRequest 转换（source 判定 / askUser 改写 / options 归一 /
 * method 超界恢复 + receivedAt）；TC5 无 sessionId 跳过；TC6 投递层 askUser 过滤（C4 分流）；
 * TC7/TC8 回传双通道（plugin.uiResponse / extension.ui_response 复用）；
 * TC10 onUiRequestExpired 撤窗订阅（D2，requestId 反查 sessionId + miss noop）；
 * TC-G1 respond 路径反查表删除（memory-leak-remediation G1）；
 * TC-D4a/TC-PDS sendPiResponse 应答终局收尾锚点（cancel/提交/断连三型统一
 * clearPendingSend；ADR-0072 D4a cancel 先例 → ADR-0073 通路级收口）。
 *
 * 策略：convertToDialogRequest 直测（纯函数）；createDialogRequestSource 用真实
 * InternalEventBus（bus.emit）+ dispatchGlobal（onGlobal 通道）——对齐 useExtensionHostBridge.test.ts
 * 全链路范式；createUiResponseTransport 用 vi.mock 断言 send 调用形状；收尾锚点用例用
 * 真 pinia + 真 chat store 断言 pendingSend 因果（对齐同目录 notify-toast.test.ts 形态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'
import type { InternalEvent } from '@taiji/core'
import { dispatchGlobal } from '@taiji/core/transport/api'

// 部分 mock（importOriginal 展开）：收尾锚点用例引入 @/stores/chat → @/stores/workflow →
// @/api 导入链后，settings 域等旁路模块在顶层读取这些导出（onExtensions 等）——窄 mock
// 缺导出即挂载失败。仅覆盖本文件断言的两个函数，其余透传原实现。
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 返 true = 送达（M1 环 3 后 transport 消费 boolean；断连场景用例单独 mockReturnValueOnce(false)）
  send: vi.fn((): boolean => true),
}))

vi.mock('@taiji/core/transport/api/domains/extension', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendExtensionUIResponse: vi.fn((): boolean => true),
}))

import { send } from '@taiji/core/transport/ws-client'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'
import { useToast } from '@/composables/useToast'
import { useChatStore } from '@/stores/chat'
import {
  convertToDialogRequest,
  createDialogRequestSource,
  createUiResponseTransport,
  _probeDialogRequestIdSessionsSize,
  __resetDialogRequestIdSessionsForTest,
} from '../extension-host-dialog'

// 文件级 pinia setup：sendPiResponse 收尾锚点为无条件清（全路径执行 useChatStore()），
// AC6/AC9、G1、锚点族所有调 transport 的用例统一持有 active pinia，不依赖 describe
// 执行顺序；每用例新 pinia，chat store 分区状态隔离（pendingSend 是 store 内 Set）。
beforeEach(() => {
  setActivePinia(createPinia())
})

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

  it('TC2: form 类标记不参与 method 改写——form 帧（已被 C4 排除，不达本转换）残配 askUser 标记时 method 按 kind 兜底', () => {
    // askUser 构造端已随 ui-presentation-protocol §3.4-2 退役：convertToDialogRequest 不再
    // 改写 method=askUser / 搬运 askUserQuestions。form 类请求由 createDialogRequestSource
    // C4 排除（见下方分流用例），本用例锁定构造端对标记类字段的「无改写」语义。
    const e = makeUiRequestEvent({ kind: 'input' }) as Extract<InternalEvent, { kind: 'ui-request' }> & {
      request: Record<string, unknown>
    }
    e.request.askUser = true

    const req = convertToDialogRequest(e)
    expect(req.method).toBe('input') // kind 兜底，不再改写为 askUser
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

describe('createDialogRequestSource（C2/C3/C4 分流）', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    bus = new InternalEventBus()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC5: 无 sessionId 事件跳过投递 + console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = createDialogRequestSource(bus)
    const handler = vi.fn()
    const unsub = source.onUiRequest(handler)

    bus.emit({ kind: 'ui-request', sessionId: undefined, request: { requestId: 'r1', pluginId: 'p1', kind: 'select' } })

    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    unsub()
    warn.mockRestore()
  })

  it('TC6: 投递层 askUser 过滤（C4）——askUser:true 不投递，非 askUser 正常投递', () => {
    const source = createDialogRequestSource(bus)
    const handler = vi.fn()
    const unsub = source.onUiRequest(handler)

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

  it('TC6b: 投递层 planReview 过滤（C4，plan 模式重设计 D5）——planReview:true 不投递 CompanionBand，普通 dialog 不受影响', () => {
    const source = createDialogRequestSource(bus)
    const handler = vi.fn()
    const unsub = source.onUiRequest(handler)

    bus.emit({
      kind: 'ui-request',
      sessionId: 's1',
      request: { requestId: 'r-plan', pluginId: '', kind: 'select', planReview: true },
    })
    // planReview 请求不投递（由 PlanReviewBar 经 useExtensionUI planReviewFilter 消费，
    // 防止 marker 控制符 title 渲染成原始 dialog）
    expect(handler).not.toHaveBeenCalled()

    // 非 planReview 的普通 dialog 投递不受新增过滤影响（负向对照）
    bus.emit({ kind: 'ui-request', sessionId: 's1', request: { requestId: 'r-dialog', pluginId: '', kind: 'confirm' } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].requestId).toBe('r-dialog')
    unsub()
  })

  it('TC10: onUiRequestExpired 订阅 global 通道 plugin:uiRequestExpired（D2 撤窗，requestId 反查 sessionId）', () => {
    const source = createDialogRequestSource(bus)
    const expiredHandler = vi.fn()
    const unsubExpired = source.onUiRequestExpired(expiredHandler)

    // 反查表来自 onUiRequest 投递流：先投递（记录 requestId→sessionId），再撤窗
    const requestHandler = vi.fn()
    const unsubRequest = source.onUiRequest(requestHandler)
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

    // MF-4 兜底：Map miss（renderer 重启无条目）时 payload sid 兜底路由
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r3', pluginId: 'p1', sessionId: 's-payload' } })
    expect(expiredHandler).toHaveBeenLastCalledWith({ sessionId: 's-payload', requestId: 'r3' })

    unsubExpired()
    unsubRequest()
  })
})

describe('createUiResponseTransport（AC6/AC9）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetDialogRequestIdSessionsForTest()
  })

  it('TC7: sendPluginResponse 发 plugin.uiResponse（runtime handleUiResponse 消费）', () => {
    const t = createUiResponseTransport()
    t.sendPluginResponse('r1', { value: 'x' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: 'plugin.uiResponse',
      payload: { requestId: 'r1', result: { value: 'x' } },
    })
  })

  it('TC8: sendPiResponse 复用 sendExtensionUIResponse（extension.ui_response，method 透传）', () => {
    const t = createUiResponseTransport()
    t.sendPiResponse('s1', 'r1', 'editor', 'value')
    expect(sendExtensionUIResponse).toHaveBeenCalledTimes(1)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'editor', 'value')
  })

  it('TC8b: sendPiResponse 兜底——非法 method 落到 input（对齐 kind 兜底语义）', () => {
    const t = createUiResponseTransport()
    t.sendPiResponse('s1', 'r1', 'unknown-method', true)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'input', true)
  })

  it('TC9a: sendPiResponse 未送达（返 false）→ 返 false + 表项保留 + toast 提示；恢复后重发即删表项（M1 环 3）', () => {
    const t = createUiResponseTransport()
    deliverRequestForTransport('r-drop')
    expect(_probeDialogRequestIdSessionsSize()).toBe(1)

    // 断连期：sendExtensionUIResponse 返 false → transport 返 false，反查表项保留（请求仍在队列）
    vi.mocked(sendExtensionUIResponse).mockReturnValueOnce(false)
    expect(t.sendPiResponse('s1', 'r-drop', 'confirm', true)).toBe(false)
    expect(_probeDialogRequestIdSessionsSize()).toBe(1)
    expect(useToast().toasts.value.some((x) => x.type === 'error' && x.message.includes('回复未送达'))).toBe(true)

    // 连接恢复：重发（同 requestId 幂等）送达 → 表项删除
    expect(t.sendPiResponse('s1', 'r-drop', 'confirm', true)).toBe(true)
    expect(_probeDialogRequestIdSessionsSize()).toBe(0)
  })

  it('TC9b: sendPluginResponse 未送达（返 false）→ 返 false + 表项保留（M1 环 3）', () => {
    const t = createUiResponseTransport()
    deliverRequestForTransport('r-pdrop')
    expect(_probeDialogRequestIdSessionsSize()).toBe(1)

    vi.mocked(send).mockReturnValueOnce(false)
    expect(t.sendPluginResponse('r-pdrop', { value: 'x' })).toBe(false)
    expect(_probeDialogRequestIdSessionsSize()).toBe(1)

    // 恢复后送达 → 删除
    expect(t.sendPluginResponse('r-pdrop', { value: 'x' })).toBe(true)
    expect(_probeDialogRequestIdSessionsSize()).toBe(0)
  })
})

// ── sendPiResponse 应答终局收尾锚点（plain-dialog-submit-settle D1；ADR-0072 D4a
// cancel 先例 → ADR-0073 通路级收口）── plain dialog 通路默认值 = 无 turn 预期、应答
// 终局即收尾（生产者穷尽论证：command handler 源结构性无 turn / turn 内源 pendingSend
// 恒空），cancel / 提交 / 断连三型统一清 pendingSend。真 pinia + 真 chat store 断言
// pendingSend 因果（对齐 notify-toast.test.ts 形态；vi.mock chat store 只验调用不验
// 状态，弱于因果断言）。

describe('sendPiResponse 应答终局收尾锚点（TC-D4a/TC-PDS）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetDialogRequestIdSessionsForTest()
  })

  it('TC-D4a-1 cancel 即清：addPendingSend 后 sendPiResponse(result=null) → pendingSend 清 + null 回传照发', () => {
    const chat = useChatStore()
    chat.addPendingSend('s1')
    expect(chat.isPendingSend('s1')).toBe(true)

    const t = createUiResponseTransport()
    expect(t.sendPiResponse('s1', 'r1', 'confirm', null)).toBe(true)

    // 锚点核心断言：cancel 送达即收口（不再空等 message_start 的 30s 兜底）
    expect(chat.isPendingSend('s1')).toBe(false)
    // 回传链不破坏：null 结果照发（pi 侧 Promise resolve 不受锚点影响）
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'confirm', null)
  })

  it('TC-D4a-2 判据先于 delivered：WS 未送达（返 false）仍清 pendingSend——取消意图与送达无关；返回值/保留语义不变', () => {
    const chat = useChatStore()
    chat.addPendingSend('s1')
    expect(chat.isPendingSend('s1')).toBe(true)

    const t = createUiResponseTransport()
    vi.mocked(sendExtensionUIResponse).mockReturnValueOnce(false)
    expect(t.sendPiResponse('s1', 'r1', 'confirm', null)).toBe(false)

    // 判据在 delivered 判断之前：断连期取消也收口（不因回传失败残留假忙）
    expect(chat.isPendingSend('s1')).toBe(false)
    // M1 返回值语义不因锚点改变（false = 未送达，队列保留供重发）
    expect(useToast().toasts.value.some((x) => x.type === 'error')).toBe(true)
  })

  it('TC-D4a-3 提交即清：addPendingSend 后 sendPiResponse(result≠null) → pendingSend 清（通路级应答终局收尾，ADR-0073）', () => {
    const chat = useChatStore()
    chat.addPendingSend('s1')

    const t = createUiResponseTransport()
    expect(t.sendPiResponse('s1', 'r1', 'confirm', 'answer')).toBe(true)

    // 提交型同清：命令路径提交后结构性无 turn（pi rpc `void run()`），不清即 30s 假忙窗
    expect(chat.isPendingSend('s1')).toBe(false)
  })

  it('TC-D4a-4 plugin 源不动：sendPluginResponse(null) → pendingSend 保留（锚点范围 = pi 源，plugin 源 dialog 无 addPendingSend 链）', () => {
    const chat = useChatStore()
    chat.addPendingSend('s1')

    const t = createUiResponseTransport()
    expect(t.sendPluginResponse('r-p-null', null)).toBe(true)

    // plugin 源 cancel 不触锚点（plugin dialog 无 addPendingSend 发送链，清态属越权）
    expect(chat.isPendingSend('s1')).toBe(true)
    chat.clearPendingSend('s1') // 收尾清态
  })

  it('TC-D4a-5 无 pendingSend 的 cancel 幂等：不抛错、不产生负状态（clearPendingSend 本就幂等）', () => {
    const chat = useChatStore()
    expect(chat.isPendingSend('s1')).toBe(false)

    const t = createUiResponseTransport()
    expect(t.sendPiResponse('s1', 'r1', 'confirm', null)).toBe(true)
    expect(chat.isPendingSend('s1')).toBe(false)
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('s1', 'r1', 'confirm', null)
  })

  it('TC-PDS-1 三型统一清：提交型（result≠null）/ cancel 型（result=null）/ 断连型（!delivered）均 clearPendingSend(sessionId)', () => {
    const chat = useChatStore()
    const t = createUiResponseTransport()

    // 提交型（result 非 null）：命令路径提交即收尾——通路无 turn 可桥接（ADR-0073 通路级收口）
    chat.addPendingSend('s-submit')
    expect(t.sendPiResponse('s-submit', 'r-submit', 'select', 'provider-a')).toBe(true)
    expect(chat.isPendingSend('s-submit')).toBe(false)

    // cancel 型（result = null）：D4a 已交付语义不变（取消即清）
    chat.addPendingSend('s-cancel')
    expect(t.sendPiResponse('s-cancel', 'r-cancel', 'confirm', null)).toBe(true)
    expect(chat.isPendingSend('s-cancel')).toBe(false)

    // 断连型（提交 + sendExtensionUIResponse 返 false）：断连期 turn 不可达，不清则仍走
    // 30s 兜底——应答意图照常收尾；返回值 / 表项保留重发语义不变（队列层由 TC9a 锁定）
    chat.addPendingSend('s-drop')
    vi.mocked(sendExtensionUIResponse).mockReturnValueOnce(false)
    expect(t.sendPiResponse('s-drop', 'r-drop', 'select', 'model-b')).toBe(false)
    expect(chat.isPendingSend('s-drop')).toBe(false)
  })
})

/** TC9 用例投递：写入 requestIdSessions 反查表（复用 createDialogRequestSource 投递流） */
function deliverRequestForTransport(requestId: string, sessionId = 's1'): void {
  const bus = new InternalEventBus()
  const source = createDialogRequestSource(bus)
  const handler = vi.fn()
  const unsub = source.onUiRequest(handler)
  bus.emit({ kind: 'ui-request', sessionId, request: { requestId, pluginId: 'p1', kind: 'confirm' } })
  unsub()
}

describe('requestIdSessions respond 路径删除（G1 / memory-leak-remediation §3.4）', () => {
  let bus: InternalEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    __resetDialogRequestIdSessionsForTest()
    bus = new InternalEventBus()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 投递一个非 askUser dialog（写入 requestIdSessions 反查表）并返回投递 handler 调用数基线 */
  function deliverRequest(requestId: string, sessionId = 's1'): void {
    const source = createDialogRequestSource(bus)
    const handler = vi.fn()
    const unsub = source.onUiRequest(handler)
    bus.emit({ kind: 'ui-request', sessionId, request: { requestId, pluginId: 'p1', kind: 'confirm' } })
    unsub()
  }

  it('TC-G1a: pi respond（sendPiResponse）后表项删除——迟到撤窗广播 miss noop', () => {
    // [G1] pi 源 dialog 的有效清理路径只有 respond（extension UI 请求无超时撤窗广播）。
    const source = createDialogRequestSource(bus)
    const expiredHandler = vi.fn()
    const unsubExpired = source.onUiRequestExpired(expiredHandler)
    deliverRequest('r1')
    expect(_probeDialogRequestIdSessionsSize()).toBe(1)

    // respond：用户作答 → 回传 extension.ui_response → 表项删除
    const transport = createUiResponseTransport()
    transport.sendPiResponse('s1', 'r1', 'confirm', true)
    expect(_probeDialogRequestIdSessionsSize()).toBe(0)

    // 已 respond 的请求收到迟到撤窗广播 → 反查 miss → noop（不误触已达应答 dialog）
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r1', pluginId: 'p1' } })
    expect(expiredHandler).not.toHaveBeenCalled()
    unsubExpired()
  })

  it('TC-G1b: plugin respond（sendPluginResponse）后表项删除——迟到撤窗广播 miss noop', () => {
    const source = createDialogRequestSource(bus)
    const expiredHandler = vi.fn()
    const unsubExpired = source.onUiRequestExpired(expiredHandler)
    deliverRequest('r2')
    expect(_probeDialogRequestIdSessionsSize()).toBe(1)

    const transport = createUiResponseTransport()
    transport.sendPluginResponse('r2', { value: 'x' })
    expect(_probeDialogRequestIdSessionsSize()).toBe(0)

    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r2', pluginId: 'p1' } })
    expect(expiredHandler).not.toHaveBeenCalled()
    unsubExpired()
  })

  it('TC-G1c: 未 respond 的表项保留——撤窗反查仍命中（respond 删除不误伤展示中条目）', () => {
    // 防御性边界：respond 补删不能波及排队/展示中（未作答）条目——撤窗路径仍按 D2 语义反查出队
    const source = createDialogRequestSource(bus)
    const expiredHandler = vi.fn()
    const unsubExpired = source.onUiRequestExpired(expiredHandler)
    deliverRequest('r3', 's9')
    expect(_probeDialogRequestIdSessionsSize()).toBe(1)

    // 无 respond，直接撤窗 → 反查命中（投递时归属 sid）+ 出队后表项删除（原有语义保持）
    dispatchGlobal({ type: 'plugin:uiRequestExpired', payload: { requestId: 'r3', pluginId: 'p1' } })
    expect(expiredHandler).toHaveBeenCalledTimes(1)
    expect(expiredHandler).toHaveBeenCalledWith({ sessionId: 's9', requestId: 'r3' })
    expect(_probeDialogRequestIdSessionsSize()).toBe(0)
    unsubExpired()
  })
})
