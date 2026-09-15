/**
 * PR#116 review chat store 层修复回归测试（B1 / B2 / M1 / M2）。
 *
 * B1 [BLOCKER]：streamingSessionIds 仅扫 role:'assistant'，纯 bash 执行期间
 *               isGenerating(sid)===false / isActive(sid)===false（bash 不阻塞）。
 * B2 [BLOCKER]：useChat.abortBash RPC 失败时 markBashError 写回 store 真正的 shallowRef，
 *               bash 消息被正确标 error（旧实现 { value: chat.messages } 写入丢失）。
 * M1 [MAJOR]：finalizeMessagesImpl 跳过 bashExecution 消息，assistant error 不会误杀
 *             共存中的 streaming bash（bashResult 到达时仍能找到 streaming bash 收口）。
 * M2 [MAJOR]：finalizeSession 恢复 clearStreamingTimer，message.complete 后 streaming
 *             timer 被清除（10min 后不再误触发 finalizeSession('timeout')）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-bash-review-fix.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── api mock（B2 用：abortBash reject 触发 catch）──
const apiMock = vi.hoisted(() => ({
  bash: vi.fn(() => Promise.resolve()),
  abortBash: vi.fn(() => Promise.resolve()),
  streamSubscribe: vi.fn((_sid: string, _handler: (msg: ServerMessage) => void) => () => {}),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    bash: apiMock.bash,
    abortBash: apiMock.abortBash,
    streamSubscribe: apiMock.streamSubscribe,
  },
  // w5：useChat 薄包装 import session.writeSegments（写 segments sidecar），mock 补全
  session: {
    writeSegments: vi.fn(() => Promise.resolve()),
  },
}))

// ── useToast mock：捕获 error 调用 ──
const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError }),
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'
import { getExecutingBash } from '@taiji/core'
import type { Message, ServerMessage } from '@taiji/shared'

describe('B1: streamingSessionIds 仅扫 role:assistant —— 纯 bash 不阻塞', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('纯 bash 执行（streaming bash 消息，无 assistant streaming）→ isGenerating=false / isActive=false', () => {
    const store = useChatStore()
    const sid = 's-b1'
    // [W1 fix-chat-flow-order] bashStart 只写 ephemeral executingBash，不建消息项
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 30', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(0)

    // 核心断言：纯 bash 执行期间不应被当作 assistant 生成态
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false)
  })

  it('bash 完成后 isGenerating 仍为 false（无回归）', () => {
    const store = useChatStore()
    const sid = 's-b1-done'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hi', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: { sessionId: sid, command: 'echo hi', output: 'hi', exitCode: 0, cancelled: false, truncated: false, timestamp: 2000 },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false)
  })

  it('assistant streaming 仍被正确识别（回归防护：assistant 不被 bash 改动误伤）', () => {
    const store = useChatStore()
    const sid = 's-b1-assistant'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)
    expect(store.isActive(sid)).toBe(true)
  })
})

describe('M1: finalizeMessagesImpl 跳过 bash —— assistant error 不误杀共存 streaming bash', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('assistant 与 bash 并发 → assistant error 收口后，bash 仍 streaming，后续 bashResult 可正常收口', () => {
    const store = useChatStore()
    const sid = 's-m1'
    // assistant turn streaming
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-streaming' },
    } as ServerMessage)
    // [W1 fix-chat-flow-order] bashStart 不建消息项——streaming bash 消息手动种子
    // （防御场景：entry 化后正常流转不产生，仅手动注入可验证 finalizeMessages 的跳过语义）
    store.setMessages(sid, [...store.getMessages(sid), {
      id: 'bash-m1',
      role: 'system',
      content: '',
      status: 'streaming',
      bashExecution: { command: 'longcmd', output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1000 },
    } as Message])

    const before = store.getMessages(sid)
    expect(before[0].status).toBe('streaming') // assistant
    expect(before[1].status).toBe('streaming') // bash

    // assistant error 收口（finalizeSession('error') 走 finalizeMessagesImpl）
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'assistant boom' },
    } as ServerMessage)

    const after = store.getMessages(sid)
    // assistant 被收口为 error
    expect(after[0].status).toBe('error')
    // 核心断言：bash 仍 streaming（不被 finalizeMessagesImpl 误杀）
    expect(after[1].status).toBe('streaming')
    expect(after[1].bashExecution?.cancelled).toBe(false)
  })

  it('entry 化形态：assistant streaming 中执行 bash → assistant error 后 bash 延迟帧照常 entry 入流', () => {
    const store = useChatStore()
    const sid = 's-m1b'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-streaming' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'longcmd', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    // assistant error 收口（run 崩溃），bash 执行态仍 ephemeral 存在
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'assistant boom' },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()

    // 后续 bashResult 延迟帧到达（级联结束 flush）→ entry 入流 append（不依赖 streaming bash 消息）
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: { sessionId: sid, command: 'longcmd', output: 'real output', exitCode: 0, cancelled: false, truncated: false, timestamp: 2000 },
    } as ServerMessage)
    const final = store.getMessages(sid)
    expect(final).toHaveLength(2)
    expect(final[1].bashExecution?.output).toBe('real output')
    expect(final[1].status).toBe('complete')
    expect(getExecutingBash(sid)).toBeUndefined()
  })
})

describe('M2: finalizeSession 恢复 clearStreamingTimer —— message.complete 后 streaming timer 清除', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('message.complete 收口后，推进 10min 不再触发 finalizeSession("timeout")', () => {
    const store = useChatStore()
    const sid = 's-m2'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)

    // 正常 complete 收口（reason='normal'）
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.getMessages(sid)[0].status).toBe('complete')

    // spy console.warn：finalizeSession 异常 reason 会打 dev warn（timeout 会命中此分支）。
    // message.complete 走 normal，不打 warn。若 10min 后 timer 仍触发 finalizeSession('timeout')，
    // 会打一次 '[chat] finalizeSession ... reason=timeout' warn。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 推进 10min + 1s（streaming 超时阈值 600_000ms）
    vi.advanceTimersByTime(600_000 + 1_000)

    // 核心断言：clearStreamingTimer 已生效，timer 不再触发 timeout 收口
    const timeoutWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('reason=timeout'))
    expect(timeoutWarns).toHaveLength(0)
    // 消息仍 complete（未被二次收口为 error）
    expect(store.getMessages(sid)[0].status).toBe('complete')

    warnSpy.mockRestore()
  })
})

describe('B2: useChat.abortBash RPC 失败 → markBashError 写回 store 真 ref', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    vi.clearAllMocks()
  })

  it('abortBash RPC reject → executingBash 被清（markBashError 兜底），手动种子消息写回真 ref', async () => {
    apiMock.abortBash.mockRejectedValueOnce(new Error('rpc boom'))

    const { abortBash } = useChat()
    const store = useChatStore()
    const sid = 's-b2'

    // bashStart 写 ephemeral 执行态（模拟 bash 正在执行）+ 手动种子 streaming bash 消息
    //（防御路径：验证 markBashError 对真 ref 的写回在新形态下仍有效）
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 999', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()
    store.setMessages(sid, [{
      id: 'bash-b2',
      role: 'system',
      content: '',
      status: 'streaming',
      bashExecution: { command: 'sleep 999', output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1000 },
    } as Message])

    // abortBash RPC 失败 → catch 调 markBashError（B2 修复后写回 store 真 ref）
    await expect(abortBash(sid)).resolves.toBeUndefined()

    // 核心断言 1：executingBash 被清（abortBash RPC 失败时无 bashResult 帧到达的唯一兜底清点）
    expect(getExecutingBash(sid)).toBeUndefined()
    // 核心断言 2：手动种子消息被标 error（旧实现 { value: chat.messages } 写入丢失，
    // store 不会更新，消息会仍 streaming）。cancelled=true。
    const after = store.getMessages(sid)
    expect(after[0].status).toBe('error')
    expect(after[0].bashExecution?.cancelled).toBe(true)
    expect(after[0].error).toBe('rpc boom')
    // toast 也被调（与 abort 错误处理对齐）
    expect(toastError).toHaveBeenCalledOnce()
  })
})
