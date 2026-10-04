/**
 * pi1-disposition-chat-flow U2 前端消费单测族——命令终局消费三面：
 *
 * 1. U2① session.deliveryHandled 终局通知 → 静默回滚三件套（移除乐观气泡 + 清空窗计时器 +
 *    递减在途计数，无错误提示，D1③④）；
 * 2. U2② 孤儿对账双分支（delivered 终态在场 / 不在投影，D1⑤）+「曾经在场」反向（V8 在途
 *    窗口未受理气泡不清除）+ 操作域收窄（普通消息条目不进对账——回执链管）；
 * 3. U2③ extension.error 命令来源 toast（D10③：仅 errorEvent === 'command' 放行 + 同 key
 *    去重 + 60s 限频窗两分支；风暴上限反向 = 同 key 3 连触发 toast 恰一次）；
 * 4. U2⑤ pendingSend 30s 空窗计时器对命令条目不挂表（D14③ G3 闸③，普通消息计时器不变对照）。
 *
 * 「用户可见 DOM 断言」在 core 层的形态 = chat store messages 分区断言（对话流渲染的单一
 * 输入源），与 useChat.test.ts 既有 morph 用例同判据。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { textToSegments } from '@taiji/shared'
import type { Segment, ServerMessage } from '@taiji/shared'
import { createChatStore, PENDING_SEND_TIMEOUT_MS } from '../store'
import {
  createUseChat,
  resetChatModuleStateForTest,
  EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS,
} from '../useChat'
import { resetDeliveryProjectionForTest } from '../effects/user-delivery'
import type { UseChatDeps } from '../useChat'

interface Fixture { // oe-exempt:20261004:test:测试 harness 参数包（单文件局部，非架构契约）
  useChat: ReturnType<typeof createUseChat>
  chatApi: {
    submitDelivery: ReturnType<typeof vi.fn>
    streamSubscribe: ReturnType<typeof vi.fn>
  }
  chatStore: ReturnType<typeof createChatStore>
  toast: { error: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> }
  /** 主动向 sid 的 streamSubscribe handler 注入一条 ServerMessage（模拟 WS 事件） */
  emit: (sid: string, m: ServerMessage) => void
  dispose: () => void
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => createChatStore())!
  // 受理回执默认形态在用例内覆写（isCommand 是本族用例的自变量）
  const chatApi = {
    submitDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' }),
    streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
      streamHandlers.set(sid, h)
      return () => {
        streamHandlers.delete(sid)
      }
    }),
  }
  const toast = { error: vi.fn(), warning: vi.fn() }
  const deps: UseChatDeps = {
    chatApi: chatApi as unknown as UseChatDeps['chatApi'],
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => ({ applySnapshot: vi.fn(), revive: vi.fn() }),
    toast,
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
  }
  const useChat = createUseChat(deps)
  return {
    useChat,
    chatApi,
    chatStore,
    toast,
    emit: (sid, m) => {
      streamHandlers.get(sid)?.(m)
    },
    dispose: () => scope.stop(),
  }
}

/** session.delivery 帧工厂（useChat.test.ts morph 用例同款形态） */
function deliveryFrame(
  sid: string,
  entries: Array<{ clientUuid: string; state: string; lane: string }>,
): ServerMessage {
  return {
    type: 'session.delivery',
    payload: {
      sessionId: sid,
      entries: entries.map((e) => ({ clientUuid: e.clientUuid, preview: 'p', state: e.state, lane: e.lane })),
    },
  } as unknown as ServerMessage
}

/** session.deliveryHandled 终局通知帧工厂（D1③ payload：sessionId + clientUuid） */
function handledFrame(sid: string, clientUuid: string): ServerMessage {
  return { type: 'session.deliveryHandled', payload: { sessionId: sid, clientUuid } }
}

/** extension.error 帧工厂（runtime event-adapter handleExtensionError 实发 payload 形态：
 * shared 侧该 type 为 Record<string, unknown> 占位，字段经 useChat 守卫收窄） */
function extensionErrorFrame(
  sid: string,
  fields: { extensionName: string; error: string; errorEvent: string },
): ServerMessage {
  return {
    type: 'extension.error',
    payload: { sessionId: sid, ...fields },
  } as unknown as ServerMessage
}

const COMMAND_REPLY = { clientUuid: 'u-x', state: 'in-flight' as const, lane: 'direct' as const, isCommand: true }

describe('pi1-disposition-chat-flow U2：handled 终局通知静默回滚三件套（U2① / D1③④）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    resetDeliveryProjectionForTest()
  })

  it('handled 通知到达 → 三件套：乐观气泡移出对话流（用户可见）+ pendingSend 清 + inflight 递减，无错误提示', async () => {
    const f = makeFixture()
    f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
    await f.useChat.send('s1', textToSegments('/todos'))
    const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
    // 前置：乐观气泡在流 + 占位挂账
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
    expect(f.chatStore.isPendingSend('s1')).toBe(true)
    expect(f.chatStore.getInflight('s1')).toBe(1)

    f.emit('s1', handledFrame('s1', bubbleId))

    // 三件套：① 气泡移除（用户可见 DOM 断言——命令不进 transcript，气泡即刻消失）
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(false)
    // ② 清空窗计时器 + dispatching 占位；③ 在途计数归零
    expect(f.chatStore.isPendingSend('s1')).toBe(false)
    expect(f.chatStore.getInflight('s1')).toBe(0)
    // 无错误提示：零 toast（handled = 命令已执行的正常终局）且无 error 气泡
    expect(f.toast.error).not.toHaveBeenCalled()
    expect(f.toast.warning).not.toHaveBeenCalled()
    expect(f.chatStore.getMessages('s1').some((m) => m.role === 'assistant' && m.status === 'error')).toBe(false)
    f.dispose()
  })

  it('非登记条目的 handled 通知零动作（外来命令条目不误扣本地在途配额）', async () => {
    const f = makeFixture()
    f.chatStore.incrementInflight('s1', 1)
    f.emit('s1', handledFrame('s1', 'foreign-uuid'))
    expect(f.chatStore.getInflight('s1')).toBe(1)
    f.dispose()
  })

  it('payload.sessionId 不匹配丢弃（ADR-0049 防御层）', async () => {
    const f = makeFixture()
    f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
    await f.useChat.send('s1', textToSegments('/todos'))
    const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
    f.emit('s1', handledFrame('other-session', bubbleId))
    // 非本 session 的通知不触发任何回滚
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
    expect(f.chatStore.getInflight('s1')).toBe(1)
    f.dispose()
  })
})

describe('pi1-disposition-chat-flow U2：孤儿对账双分支与反向（U2② / D1⑤）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    resetDeliveryProjectionForTest()
  })

  it('分支 B：delivered 终态在场（通知丢失 + runtime 存活重连形态）→ 静默清除', async () => {
    const f = makeFixture()
    f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
    await f.useChat.send('s1', textToSegments('/todos'))
    const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
    // 帧1：条目受理进投影（in-flight）——「曾经在场」证据置位
    f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
    // 帧2：tombstone delivered 终态仍在投影（handled 通知已丢失）
    f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'delivered', lane: 'direct' }]))
    // 按 handled 同形态静默清除（用户可见 DOM 断言：气泡消失、无错误提示）
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(false)
    expect(f.chatStore.getInflight('s1')).toBe(0)
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('分支 A：不在当前投影（runtime 重启 tombstone 丢失形态）→ 静默清除', async () => {
    const f = makeFixture()
    f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
    await f.useChat.send('s1', textToSegments('/todos'))
    const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
    f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))
    // runtime 重启后投影为空（tombstone 内存态丢失）→ 分支 A 命中
    f.emit('s1', deliveryFrame('s1', []))
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(false)
    expect(f.chatStore.getInflight('s1')).toBe(0)
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('反向（V8 在途窗口）：受理窗口内快照不含新条目 → 未受理气泡不清除（「曾经在场」必要条件反向断言）', async () => {
    const f = makeFixture()
    f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
    await f.useChat.send('s1', textToSegments('/todos'))
    const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
    // 连发场景：第二条消息状态变化触发的快照不含未受理的第一条（受理窗口正常态）
    f.emit('s1', deliveryFrame('s1', []))
    // 未受理（从未见于投影）→「不在投影」不得清除（用户可见 DOM 断言：气泡保留）
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
    expect(f.chatStore.getInflight('s1')).toBe(1)
    // 后续帧条目进投影（in-flight）→ 仍不清（在途非终态）
    f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
    f.dispose()
  })

  it('操作域收窄：普通消息条目（受理回执无 isCommand）delivered 在场不清除——气泡去留归回执链', async () => {
    const f = makeFixture()
    await f.useChat.send('s1', textToSegments('普通消息'))
    const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
    f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))
    f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'delivered', lane: 'direct' }]))
    // 快照先于 message_end 回执到达的窗口下，普通条目气泡被清 = 文本丢失面——对账不碰
    expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
    f.dispose()
  })

  it('分支重叠防御：命令条目 steer 车道 morph 后孤儿清除不误删其后消息、不重建幽灵气泡', async () => {
    const f = makeFixture()
    f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
    await f.useChat.send('s1', textToSegments('/todos'))
    const cmdId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
    // 帧1：steer 车道 → 既有 morph 分支把气泡移出（与孤儿对账相邻分支，操作域互斥）
    f.emit('s1', deliveryFrame('s1', [{ clientUuid: cmdId, state: 'in-flight', lane: 'steer' }]))
    expect(f.chatStore.getMessages('s1').some((m) => m.id === cmdId)).toBe(false)
    // morph 后用户继续发消息（其后内容不能被对账误删）
    await f.useChat.send('s1', textToSegments('后续消息'))
    // 帧2：delivered 终态在场 → 孤儿清除（气泡已不在，truncateFrom 幂等 no-op）
    f.emit('s1', deliveryFrame('s1', [{ clientUuid: cmdId, state: 'delivered', lane: 'steer' }]))
    expect(f.chatStore.getMessages('s1').some((m) => m.id === cmdId)).toBe(false)
    expect(f.chatStore.getInflight('s1')).toBe(1) // 只剩后续消息的挂账
    const after = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!
    expect(after.id).not.toBe(cmdId)
    expect(after.status).toBe('complete')
    f.dispose()
  })
})

describe('pi1-disposition-chat-flow U2：extension.error 命令反馈矩阵（U2③ / D10③）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    resetDeliveryProjectionForTest()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 建立 streamSubscribe 订阅（不经 send——extension.error 消费独立于发送链） */
  function subscribeOnly(f: Fixture): void {
    void f.useChat.send('s1', textToSegments('建立订阅'))
    // 本组用例只关心 toast 断言：清掉 send 的 pendingSend 空窗 timer，防限频窗用例推进
    // timers 时触发无关的 finalizeSession(timeout) 日志噪音
    f.chatStore.clearPendingSend('s1')
  }

  it('过滤：非 command 来源（事件/生命周期错误）不 toast，保持现状静默', () => {
    const f = makeFixture()
    subscribeOnly(f)
    f.emit('s1', extensionErrorFrame('s1', { extensionName: 'goal', error: 'handler blew up', errorEvent: 'agent_end' }))
    f.emit('s1', extensionErrorFrame('s1', { extensionName: 'x', error: 'register failed', errorEvent: 'register_provider' }))
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('command 来源 → toast 恰一次：文案带剥前缀命令名 + 错误文本（用户可见反馈）', () => {
    const f = makeFixture()
    subscribeOnly(f)
    f.emit('s1', extensionErrorFrame('s1', { extensionName: 'command:todos', error: 'boom', errorEvent: 'command' }))
    expect(f.toast.error).toHaveBeenCalledTimes(1)
    const [text] = f.toast.error.mock.calls[0] as unknown as [string]
    expect(text).toContain('composable.extensionCommandFailed')
    expect(text).toContain('/todos')
    expect(text).toContain('boom')
    f.dispose()
  })

  it('风暴上限反向：同 key 3 连触发 → toast 恰一次（限频窗内去重）', () => {
    const f = makeFixture()
    subscribeOnly(f)
    const frame = (): ServerMessage =>
      extensionErrorFrame('s1', { extensionName: 'command:todos', error: 'boom', errorEvent: 'command' })
    f.emit('s1', frame())
    f.emit('s1', frame())
    f.emit('s1', frame())
    expect(f.toast.error).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('限频窗两分支：窗内同 key 不重复弹；窗口（60s）过后同 key 再弹；异 key 同窗独立弹', () => {
    const f = makeFixture()
    subscribeOnly(f)
    const sameKey = (): ServerMessage =>
      extensionErrorFrame('s1', { extensionName: 'command:todos', error: 'boom', errorEvent: 'command' })
    const otherKey = (): ServerMessage =>
      extensionErrorFrame('s1', { extensionName: 'command:plan', error: 'other', errorEvent: 'command' })
    f.emit('s1', sameKey())
    f.emit('s1', otherKey())
    // 同窗：同 key 去重、异 key 独立
    expect(f.toast.error).toHaveBeenCalledTimes(2)
    // 窗内（59s）：同 key 仍被抑制
    vi.advanceTimersByTime(EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS - 1_000)
    f.emit('s1', sameKey())
    expect(f.toast.error).toHaveBeenCalledTimes(2)
    // 出窗（再过 2s ≥ 60s）：同 key 再弹
    vi.advanceTimersByTime(2_000)
    f.emit('s1', sameKey())
    expect(f.toast.error).toHaveBeenCalledTimes(3)
    f.dispose()
  })
})

describe('pi1-disposition-chat-flow U2：pendingSend 空窗计时器命令豁免（U2⑤ / D14③ G3 闸③）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    resetDeliveryProjectionForTest()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('命令条目（受理回执 isCommand）不挂 30s 空窗计时器：推满阈值后挂起语义成立（不被切成失败形态）', async () => {
    const f = makeFixture()
    f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
    await f.useChat.send('s1', textToSegments('/permission rule'))
    expect(f.chatStore.isPendingSend('s1')).toBe(true)
    // 推满 30s 空窗阈值 + 余量：命令条目计时器未挂 → 无 timeout 收口
    vi.advanceTimersByTime(PENDING_SEND_TIMEOUT_MS + 1_000)
    // 挂起语义成立：pendingSend 置位保留（isActive 保持——停止按钮/steer guard 不误翻转）
    expect(f.chatStore.isPendingSend('s1')).toBe(true)
    expect(f.chatStore.isActive('s1')).toBe(true)
    f.dispose()
  })

  it('对照（普通消息计时器不变）：受理回执无 isCommand → 推满阈值照常 timeout 收口', async () => {
    const f = makeFixture()
    await f.useChat.send('s1', textToSegments('普通消息'))
    expect(f.chatStore.isPendingSend('s1')).toBe(true)
    vi.advanceTimersByTime(PENDING_SEND_TIMEOUT_MS)
    // D-015/F4 既有语义零变化：空窗超时 → finalizeSession(timeout) 收口（pendingSend 清）
    expect(f.chatStore.isPendingSend('s1')).toBe(false)
    f.dispose()
  })
})
