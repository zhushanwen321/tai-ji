/**
 * bashStart / bashResult effect 单测（composer-bash-execute W3 TK7 → W1 fix-chat-flow-order 语义更新）。
 *
 * [W1 fix-chat-flow-order] bash live 入流 entry 化：
 * - message.bashStart → 不建 messages 项，写 ephemeral executingBash（执行中反馈）
 * - message.bashResult（dispatcher 双分支延迟/立即发布）→ bashExecution entry 经
 *   applyEntryFrame 入流（reducer 唯一入流通道），ref 末尾出现 complete 态消息
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-message-effects-bash.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { getExecutingBash } from '@taiji/core'
import type { ServerMessage } from '@taiji/shared'

describe('bash effect（message.bashStart / message.bashResult）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('T1: bashStart → 不建 messages 项，executingBash 置位（执行中 ephemeral 反馈）', () => {
    const store = useChatStore()
    const sid = 's-bash-1'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hello', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    expect(store.getMessages(sid)).toHaveLength(0)
    expect(getExecutingBash(sid)).toEqual({ command: 'echo hello', startedAt: 1000 })
  })

  it('T2: bashStart 后 bashResult → 末尾 complete 态 bashExecution 消息（entry 入流），执行态清除', () => {
    const store = useChatStore()
    const sid = 's-bash-2'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'ls', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'ls',
        output: 'file1\nfile2',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    const m = msgs[0]
    expect(m.role).toBe('system')
    expect(m.status).toBe('complete')
    expect(m.bashExecution?.command).toBe('ls')
    expect(m.bashExecution?.output).toBe('file1\nfile2')
    expect(m.bashExecution?.exitCode).toBe(0)
    expect(m.bashExecution?.cancelled).toBe(false)
    expect(getExecutingBash(sid)).toBeUndefined()
  })

  it('T3: bashResult cancelled=true（真实命令）→ entry 入流 cancelled=true', () => {
    const store = useChatStore()
    const sid = 's-bash-3'
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'sleep 5',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].status).toBe('complete')
    expect(msgs[0].bashExecution?.cancelled).toBe(true)
  })

  it('T4: abortBash 合成哨兵帧（command:"" + cancelled:true）→ 不建消息（无文件对应物，防空命令卡片）', () => {
    const store = useChatStore()
    const sid = 's-bash-4'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 5', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: '',
        output: '',
        exitCode: null,
        cancelled: true,
        truncated: false,
        excludeFromContext: false,
        timestamp: 2000,
      },
    } as ServerMessage)

    expect(store.getMessages(sid)).toHaveLength(0)
    expect(getExecutingBash(sid)).toBeUndefined()
  })

  it('T5: excludeFromContext 透传（探针①：该类 bash 仍写 entry，与普通 bash 同路径 entry 化）', () => {
    const store = useChatStore()
    const sid = 's-bash-5'
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'secret',
        output: 'ok',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 2000,
      },
    } as ServerMessage)
    expect(store.getMessages(sid)[0].bashExecution?.excludeFromContext).toBe(true)
  })

  it('T6: streaming 中 bash（延迟帧在 turn 收口后到达）→ bash 记录位于 assistant 之后（与文件位置一致，G2）', () => {
    const store = useChatStore()
    const sid = 's-bash-6'
    // run 级联：assistant streaming 中用户执行 `!` bash（bashStart 即时反馈）
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-1' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: 'partial answer' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'ls -la', excludeFromContext: false, timestamp: 1500 },
    } as ServerMessage)
    // 级联结束：assistant 收口在前，bash 延迟帧（flush）在后——bash 落在 turn 末尾而非执行时刻
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: {
        sessionId: sid,
        command: 'ls -la',
        output: 'total 0',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 3000,
      },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].status).toBe('complete')
    expect(msgs[1].bashExecution?.command).toBe('ls -la')
    expect(msgs[1].status).toBe('complete')
  })
})
