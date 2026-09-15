/**
 * W1 TDD 测试：EventInterpreter.interpret() 的 per-event try-catch（事件级隔离）。
 *
 * 背景：interpret() 当前是「裸 for 循环」调 handle()，无 try-catch。
 *   EventAdapter.attach() 虽然在「整批事件」外有 try-catch（隔离整批失败），
 *   但 interpret 一次会处理多个 PiTranslatedEvent——若其中第 N 个事件触发 handler 抛错
 *   （如 send 回调被 mock 成抛、或某个 details 形状异常），for 循环会被中断，
 *   后续事件（含关键的 turn-end / agent_end）被吞掉，导致：
 *     - isGenerating 永不复位（onTurnFinalize 未触发）
 *     - message.complete 不送达前端（streaming 永远不停）
 *
 * W1 改动：interpret() 内对每个事件包 try-catch，单事件失败仅记日志不中断批次。
 *
 * [红灯说明] 当前 interpret() 无 per-event try-catch，第 2 个事件抛错会中断 for 循环 →
 *   第 3 个事件不被处理 → 断言失败。加 try-catch 后应转绿。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

describe('EventInterpreter · W1 interpret 循环事件级隔离', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
  })

  /** 构造一个会被正常转发的 message 事件（带唯一 tag 便于断言被处理）。 */
  function taggedMessage(tag: string): PiTranslatedEvent {
    return {
      kind: 'message',
      message: { type: 'message.text_delta', payload: { sessionId: 'sid-iso', delta: tag } },
    }
  }

  /** 构造一个会触发 send 抛错的 message 事件。 */
  function throwingMessage(): PiTranslatedEvent {
    return {
      kind: 'message',
      message: { type: 'message.text_delta', payload: { sessionId: 'sid-iso', delta: 'throw' } },
    }
  }

  /** 构造一个 turn-end（agent_end）事件。 */
  function turnEnd(): PiTranslatedEvent {
    return {
      kind: 'turn-end',
      message: {
        type: 'message.complete',
        payload: { sessionId: 'sid-iso', stopReason: 'end_turn' },
      },
      stopReason: 'end_turn',
    }
  }

  // ── ISO1：单个事件抛错不中断批次 ──────────────────────────────
  it('ISO1: 3 个事件中第 2 个触发 handler 抛错 → 第 3 个事件仍被处理', () => {
    // send 在收到 delta='throw' 时抛错，其余正常入栈
    send = (msg) => {
      const delta = (msg.payload as { delta?: string } | undefined)?.delta
      if (delta === 'throw') throw new Error('boom from send')
      sent.push(msg)
    }
    const onTurnFinalize = vi.fn()
    const interpreter = new EventInterpreter('sid-iso', { send, onTurnFinalize })

    // 同一批 interpret：ev1 正常 → ev2 抛错 → ev3 必须仍被处理（W1 隔离）
    interpreter.interpret([
      taggedMessage('first'),
      throwingMessage(),
      taggedMessage('third'),
    ])

    // 第 1 个与第 3 个事件都已入栈（第 2 个被隔离吞掉）
    const deltas = sent.map((m) => (m.payload as { delta?: string }).delta)
    expect(deltas).toContain('first')
    expect(deltas).toContain('third')
  })

  // ── ISO2：turn-end 不被前面抛错事件吞掉 ──────────────────────
  it('ISO2: 抛错 message 事件 + turn-end 同批 → onTurnFinalize 仍被调用（isGenerating 复位不被吞）', () => {
    send = (msg) => {
      const delta = (msg.payload as { delta?: string } | undefined)?.delta
      if (delta === 'throw') throw new Error('boom before turn-end')
      sent.push(msg)
    }
    const onTurnFinalize = vi.fn()
    const interpreter = new EventInterpreter('sid-iso', { send, onTurnFinalize })

    interpreter.interpret([
      throwingMessage(),
      turnEnd(),
    ])

    // turn-end 的 onTurnFinalize（复位 isGenerating）必须被触发，否则 session 永远 busy
    expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    // onTurnFinalize 签名 (sessionId, stopReason?) —— 正常 turn-end 路径传 stopReason
    expect(onTurnFinalize).toHaveBeenCalledWith('sid-iso', 'end_turn')
  })

  // ── ISO3：turn-end 自己抛错时 onTurnFinalize 兜底复位（B2 核心） ──
  it('ISO3: turn-end handler 自身抛错 → onTurnFinalize 仍被兜底调用（isGenerating 不永久 busy）', () => {
    // send 在处理 turn-end（message.complete）时抛错——模拟 send 回调抛 / details 形状异常
    send = (msg) => {
      if (msg.type === 'message.complete') throw new Error('boom inside turn-end')
      sent.push(msg)
    }
    const onTurnFinalize = vi.fn()
    const interpreter = new EventInterpreter('sid-iso', { send, onTurnFinalize })

    interpreter.interpret([turnEnd()])

    // B2: 即使 turn-end 自身 handler 抛错，catch 兜底也必须调 onTurnFinalize，
    // 否则 isGenerating 永不复位 → session 永久 busy（AGENTS.md 规则 #3）
    // S4：catch 兜底也传 stopReason（对齐正常路径 + handleTurnEndSideEffects 的 outcome 映射）
    expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    expect(onTurnFinalize).toHaveBeenCalledWith('sid-iso', 'end_turn')
  })
})
