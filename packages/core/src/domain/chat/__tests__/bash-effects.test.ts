/**
 * bash-effects 单测（W1 fix-chat-flow-order：bash live 入流 entry 化 + ephemeral 执行态）。
 *
 * 锁定三视角：
 * - 构建者（白盒）：bashResult 构造的 bashExecution entry 形态对齐 apply-entry.ts bashExecution
 *   case 消费的 PiEntry 结构，经 applyEntryFrame 喂 per-session reducer state。
 * - 使用者（黑盒）：bashResult 后 messages ref 出现 complete 态 bashExecution system 消息
 *   （用户可见行为）；bashStart 不建消息项。
 * - 观察者（形态）：executingBash 置/清成对（bashStart 置 / bashResult·markBashError 清），
 *   abortBash 合成哨兵帧（command:'' + cancelled:true）只清执行态不产 entry。
 *
 * 等价性断言（entry 序 vs 手工重放）归 W6，此处只锁 entry 形态与 reducer 喂入。
 */
import { describe, it, expect } from 'vitest'
import type { ShallowRef } from 'vue'
import { shallowRef } from 'vue'
import type { Message, PiEntry } from '@taiji/shared'
import {
  bashStartEffect,
  bashResultEffect,
  getExecutingBash,
  markBashError,
  findLastStreamingBashIndex,
} from '../bash-effects'
import { applyEntry, createInitialChatViewState } from '../apply-entry'
import { commitMessages, type MessagesRef } from '../mutations'
import type { MessageEffectContext, MessageEffectHandler } from '../effect-types'

/** 测试用 ctx：messages ref（渲染 overlay）+ applyEntryFrame（真实 reducer 喂入，镜像 store 实现）。 */
function createTestCtx() {
  const messages: MessagesRef = shallowRef(new Map<string, ShallowRef<Message[]>>())
  const entryStates = new Map<string, ReturnType<typeof createInitialChatViewState>>()
  const applyEntryFrame = (sid: string, entry: PiEntry): void => {
    entryStates.set(sid, applyEntry(entryStates.get(sid) ?? createInitialChatViewState(), entry))
  }
  const ctx = {
    messages,
    applyEntryFrame,
  } as unknown as MessageEffectContext
  return { ctx, messages, entryStates }
}

function dispatch(handler: MessageEffectHandler, ctx: MessageEffectContext, sid: string, payload: Record<string, unknown>): void {
  handler(ctx, sid, payload)
}

function bashResultPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's1',
    command: 'ls -la',
    output: 'file1\nfile2',
    exitCode: 0,
    cancelled: false,
    truncated: false,
    excludeFromContext: false,
    timestamp: 1724000000000,
    ...extra,
  }
}

describe('bashStartEffect：ephemeral 执行态（不建消息项）', () => {
  it('bashStart 不创建 messages 数组项，executingBash 置位（命令 + 开始时刻）', () => {
    const { ctx, messages } = createTestCtx()
    dispatch(bashStartEffect, ctx, 's1', { command: 'sleep 1', excludeFromContext: false, timestamp: 1234 })

    expect(messages.value.get('s1')?.value ?? []).toHaveLength(0)
    expect(getExecutingBash('s1')).toEqual({ command: 'sleep 1', startedAt: 1234 })
  })

  it('executingBash 按 session 分区（Map 分区范式：互不串扰）', () => {
    const { ctx } = createTestCtx()
    dispatch(bashStartEffect, ctx, 'sA', { command: 'cmd-a', excludeFromContext: false })
    dispatch(bashStartEffect, ctx, 'sB', { command: 'cmd-b', excludeFromContext: false })

    expect(getExecutingBash('sA')?.command).toBe('cmd-a')
    expect(getExecutingBash('sB')?.command).toBe('cmd-b')
  })
})

describe('bashResultEffect：bashExecution entry 化（reducer 唯一入流通道）', () => {
  it('使用者可见：ref 末尾出现 complete 态 bashExecution system 消息（命令/输出/exitCode 正确）', () => {
    const { ctx, messages } = createTestCtx()
    dispatch(bashStartEffect, ctx, 's1', { command: 'ls -la', excludeFromContext: false, timestamp: 1 })
    dispatch(bashResultEffect, ctx, 's1', bashResultPayload())

    const list = messages.value.get('s1')?.value ?? []
    expect(list).toHaveLength(1)
    const m = list[0]
    expect(m.role).toBe('system')
    expect(m.status).toBe('complete')
    expect(m.bashExecution?.command).toBe('ls -la')
    expect(m.bashExecution?.output).toBe('file1\nfile2')
    expect(m.bashExecution?.exitCode).toBe(0)
    expect(m.bashExecution?.timestamp).toBe(1724000000000)
  })

  it('构建者：entry 形态对齐 apply-entry bashExecution case（role/command/exitCode/exclude + ISO timestamp），经 applyEntryFrame 喂 reducer state', () => {
    const { ctx, entryStates } = createTestCtx()
    dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ excludeFromContext: true, fullOutputPath: '/tmp/out.txt' }))

    // reducer state 与 ref 同步产出（applyEntryFrame 喂入 + overlay 投影同 entry）
    const state = entryStates.get('s1')
    expect(state).toBeDefined()
    expect(state!.messages).toHaveLength(1)
    const reduced = state!.messages[0]
    expect(reduced.role).toBe('system')
    expect(reduced.bashExecution).toMatchObject({
      command: 'ls -la',
      output: 'file1\nfile2',
      exitCode: 0,
      excludeFromContext: true,
      fullOutputPath: '/tmp/out.txt',
    })
  })

  it('探针①语义：excludeFromContext bash 与普通 bash 同路径 entry 化（不 liveOnly、不丢弃）', () => {
    const { ctx, messages, entryStates } = createTestCtx()
    dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ excludeFromContext: true }))

    const ref = messages.value.get('s1')?.value ?? []
    expect(ref).toHaveLength(1)
    expect(ref[0].bashExecution?.excludeFromContext).toBe(true)
    expect(entryStates.get('s1')!.messages).toHaveLength(1)
  })

  it('executingBash 清除（与 bashStart 置位成对）', () => {
    const { ctx } = createTestCtx()
    dispatch(bashStartEffect, ctx, 's1', { command: 'ls', excludeFromContext: false })
    expect(getExecutingBash('s1')).toBeDefined()
    dispatch(bashResultEffect, ctx, 's1', bashResultPayload())
    expect(getExecutingBash('s1')).toBeUndefined()
  })

  it('abortBash 合成哨兵帧（command:"" + cancelled:true）只清执行态，不产 entry（不渲染空命令卡片）', () => {
    const { ctx, messages, entryStates } = createTestCtx()
    dispatch(bashStartEffect, ctx, 's1', { command: 'sleep 999', excludeFromContext: false })
    dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ command: '', output: '', exitCode: null, cancelled: true }))

    expect(messages.value.get('s1')?.value ?? []).toHaveLength(0)
    expect(entryStates.get('s1')).toBeUndefined()
    expect(getExecutingBash('s1')).toBeUndefined()
  })

  it('错误兜底帧（RPC 失败 "[bash error] ..."，cancelled:false）照常 entry 化', () => {
    const { ctx, messages } = createTestCtx()
    dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ output: '[bash error] timeout', exitCode: null }))

    const list = messages.value.get('s1')?.value ?? []
    expect(list).toHaveLength(1)
    expect(list[0].bashExecution?.output).toBe('[bash error] timeout')
    expect(list[0].bashExecution?.exitCode).toBeNull()
  })

  it('顺序：两次 bashResult 依帧序追加（延迟 flush 与立即发布同一 handler）', () => {
    const { ctx, messages } = createTestCtx()
    dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ command: 'first', timestamp: 1 }))
    dispatch(bashResultEffect, ctx, 's1', bashResultPayload({ command: 'second', output: 'b', timestamp: 2 }))

    const list = messages.value.get('s1')?.value ?? []
    expect(list.map((m) => m.bashExecution?.command)).toEqual(['first', 'second'])
  })
})

describe('markBashError：错误路径兜底清执行态', () => {
  it('清 executingBash（abortBash RPC 失败时无 bashResult 帧到达的唯一兜底清点）', () => {
    const { ctx, messages } = createTestCtx()
    dispatch(bashStartEffect, ctx, 's1', { command: 'sleep 999', excludeFromContext: false })
    expect(getExecutingBash('s1')).toBeDefined()

    markBashError(messages, 's1', 'abort failed')
    expect(getExecutingBash('s1')).toBeUndefined()
  })
})

describe('findLastStreamingBashIndex（契约保留：markBashError / 手动种子场景）', () => {
  it('命中最后一条 streaming bash，无则 -1', () => {
    const mk = (status: Message['status']): Message => ({
      id: 'bash-x',
      role: 'system',
      content: '',
      status,
      bashExecution: { command: 'c', output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 0 },
    } as Message)
    expect(findLastStreamingBashIndex([])).toBe(-1)
    expect(findLastStreamingBashIndex([mk('complete')])).toBe(-1)
    expect(findLastStreamingBashIndex([mk('streaming'), mk('complete'), mk('streaming')])).toBe(2)
  })
})
