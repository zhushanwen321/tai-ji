/**
 * w1 timer-decouple 回归测试（bash-align-pi-tui-w4::w1-timer-decouple；
 * W1 fix-chat-flow-order entry 化后种子方式更新）。
 *
 * 锁定行为（[timeout-streaming-ui-idle u-s3] dormant bash timer 契约整链删除后，
 * bash 收口只剩 bashResult entry 化 + markBashError 兜底两条真实路径）：
 * - W1T2：bashResult entry 化后消息恒 complete，推进 300s 无任何 timer 再触碰
 *   （原 W1T1 的 300s bash timer 随 dormant 契约删除，本用例守卫「无 timer 误触」不变式）。
 * - W1T3：markBashError 清 executingBash（abortBash RPC 失败兜底）。
 * - W1T3b：markBashError 对手动种子的 streaming bash 消息仍推 error 态（防御路径保留）。
 *
 * [W1 fix-chat-flow-order] bashStart 不再创建 streaming bash 消息（改写 ephemeral
 * executingBash）——W1T3b 的「streaming bash 消息」种子改为手动 setMessages 注入
 * （防御场景：entry 化后正常流转不产生 streaming bash 消息，仅手动种子可触发该路径）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-bash-effects.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { markBashError, getExecutingBash } from '@taiji/core'
import type { Message, ServerMessage } from '@taiji/shared'

/** 手动种子：streaming bash 消息（entry 化后正常流转不产生，仅手动注入可达） */
function streamingBashMsg(command: string): Message {
  return {
    id: `bash-${command}`,
    role: 'system',
    content: '',
    status: 'streaming',
    bashExecution: {
      command,
      output: '',
      exitCode: null,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: 0,
    },
  } as Message
}

describe('w1 bash 收口链（entry 化 + markBashError 兜底，bash timer 契约已删除）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('W1T2: bashStart→bashResult entry 化后消息恒 complete，推进 300s 无 timer 再触碰', () => {
    const store = useChatStore()
    const sid = 's-w1t2'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hi', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    // [W1 fix-chat-flow-order] bashStart 不建消息项（ephemeral 执行态；bash timer 挂点已随
    // dormant 契约删除）
    expect(store.getMessages(sid)).toHaveLength(0)

    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'echo hi',
        output: 'hi',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    // 消息经 entry 入流即为 complete（无 streaming 中间态）
    expect(store.getMessages(sid)[0].status).toBe('complete')

    // 推进 300s：无任何 timer 回调触碰这条已 complete 的消息（bash timer 契约已删除）
    vi.advanceTimersByTime(300_000)
    const after = store.getMessages(sid)
    expect(after[0].status).toBe('complete')
    expect(after[0].bashExecution?.cancelled).toBe(false)
  })

  it('W1T3: markBashError 清 executingBash（abortBash RPC 失败兜底）', () => {
    const store = useChatStore()
    const sid = 's-w1t3'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 5', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()

    // messagesRef 用 storeToRefs 拿真 ref：markBashError 内 commitMessages 整体替换写回 store。
    const messagesRef = storeToRefs(store).messages
    markBashError(messagesRef, sid, 'abort rpc failed')

    // executingBash 已清（abortBash RPC 失败时无 bashResult 帧到达的唯一兜底清点）
    expect(getExecutingBash(sid)).toBeUndefined()
  })

  it('W1T3b: markBashError 对手动种子的 streaming bash 消息仍推 error 态（防御路径保留）', () => {
    const store = useChatStore()
    const sid = 's-w1t3b'
    store.setMessages(sid, [streamingBashMsg('sleep 5')])
    const messagesRef = storeToRefs(store).messages

    markBashError(messagesRef, sid, 'abort rpc failed')

    const m = store.getMessages(sid)[0]
    expect(m.status).toBe('error')
    expect(m.bashExecution?.cancelled).toBe(true)
    expect(m.error).toBe('abort rpc failed')
  })
})
