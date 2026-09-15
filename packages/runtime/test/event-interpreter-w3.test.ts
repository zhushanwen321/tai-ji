/**
 * W3 TDD tests：EventInterpreter 新回调 onTurnUsage / onTurnFinalize（U6 + U7）。
 *
 * 背景：W3 收口第二条 pi 事件订阅（attachUsageListener），把副作用
 * （isGenerating 复位 / tokenCount 写入等）迁移到中间事件链路。
 * EventInterpreter 两个可选回调：
 *   - onTurnUsage(sessionId)：pi turn_end 触发（turn 级副作用：project sidecar 兜底等；
 *     label 持久化 W1 起移交 pi set_session_name RPC，不再经此链路直写）
 *   - onTurnFinalize(sessionId)：pi agent_end 触发（复位 isGenerating=false + 终态副作用）
 *
 * U6：turn-end / turn-usage handler 调用新回调（各调一次含 sessionId）。
 * U7：副作用经中间事件链路保留（onTurnFinalize→handleTurnEndSideEffects 复位 isGenerating；
 *     onContextUpdate 含 totalTokens→applyContextUpdate 写入 tokenCount）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

describe('EventInterpreter · W3 onTurnUsage / onTurnFinalize 回调', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  // ── U6：turn-usage（pi turn_end）调 onTurnUsage ──────────────────
  describe('U6: turn-usage handler 调 onTurnUsage（pi turn_end 主路径）', () => {
    it('turn-usage 事件触发 onTurnUsage 回调一次，参数含 sessionId', () => {
      const onTurnUsage = vi.fn()
      const onContextUpdate = vi.fn()
      const interpreter = new EventInterpreter('sid-u6a', { send, onContextUpdate, onTurnUsage })

      const ev: PiTranslatedEvent = {
        kind: 'turn-usage',
        sessionId: 'sid-u6a',
        inputTokens: 163628,
        totalTokens: 163628,
        outputTokens: null,
        cacheRead: null,
        cacheWrite: null,
        input: null,
        model: null,
        provider: null,
      }
      interpreter.interpret([ev])

      // onTurnUsage 调一次，参数是 interpreter 持有的 sessionId
      expect(onTurnUsage).toHaveBeenCalledTimes(1)
      expect(onTurnUsage).toHaveBeenCalledWith('sid-u6a')
    })

    it('turn-usage 先调 onContextUpdate 再调 onTurnUsage（顺序：用量回写在前，持久化在后）', () => {
      const callOrder: string[] = []
      const onContextUpdate = vi.fn(() => { callOrder.push('onContextUpdate') })
      const onTurnUsage = vi.fn(() => { callOrder.push('onTurnUsage') })
      const interpreter = new EventInterpreter('sid-order', { send, onContextUpdate, onTurnUsage })

      interpreter.interpret([{
        kind: 'turn-usage',
        sessionId: 'sid-order',
        inputTokens: 100,
        totalTokens: 100,
        outputTokens: null,
        cacheRead: null,
        cacheWrite: null,
        input: null,
        model: null,
        provider: null,
      }])

      expect(callOrder).toEqual(['onContextUpdate', 'onTurnUsage'])
    })

    it('未注入 onTurnUsage 时不抛错（可选回调）', () => {
      const onContextUpdate = vi.fn()
      const interpreter = new EventInterpreter('sid-noop', { send, onContextUpdate })

      expect(() => interpreter.interpret([{
        kind: 'turn-usage', sessionId: 'sid-noop', inputTokens: 10, totalTokens: 10,
        outputTokens: null, cacheRead: null, cacheWrite: null, input: null, model: null, provider: null,
      }])).not.toThrow()
      expect(onContextUpdate).toHaveBeenCalledTimes(1)
    })
  })

  // ── U6：turn-end（pi agent_end）调 onTurnFinalize ────────────────
  describe('U6: turn-end handler 调 onTurnFinalize（pi agent_end）', () => {
    it('turn-end 事件触发 onTurnFinalize 回调一次，参数含 sessionId', async () => {
      const onTurnFinalize = vi.fn()
      const interpreter = new EventInterpreter('sid-u6b', { send, onTurnFinalize })

      const completeMsg: ServerMessage = {
        type: 'message.complete',
        payload: { sessionId: 'sid-u6b', stopReason: 'end_turn' },
      }
      const ev: PiTranslatedEvent = {
        kind: 'turn-end',
        message: completeMsg,
        inputTokens: 5000,
        totalTokens: 5000,
        stopReason: 'end_turn',
      }
      interpreter.interpret([ev])
      // handleTurnEnd 返回 Promise（虽然同步执行），flush 微任务
      await new Promise<void>(r => setTimeout(r, 0))

      expect(onTurnFinalize).toHaveBeenCalledTimes(1)
      // onTurnFinalize 签名 (sessionId, stopReason?) —— 正常 turn-end 路径传 stopReason
      expect(onTurnFinalize).toHaveBeenCalledWith('sid-u6b', 'end_turn')
    })

    it('turn-end 先转发 message.complete 再调 onTurnFinalize', async () => {
      const onTurnFinalize = vi.fn()
      const interpreter = new EventInterpreter('sid-te-order', { send, onTurnFinalize })

      const completeMsg: ServerMessage = {
        type: 'message.complete',
        payload: { sessionId: 'sid-te-order', stopReason: 'end_turn' },
      }
      interpreter.interpret([{ kind: 'turn-end', message: completeMsg, totalTokens: 0 }])
      await new Promise<void>(r => setTimeout(r, 0))

      // message.complete 已转发
      expect(sent.find(m => m.type === 'message.complete')).toBeDefined()
      // onTurnFinalize 调一次
      expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    })

    it('未注入 onTurnFinalize 时不抛错（可选回调）', async () => {
      const interpreter = new EventInterpreter('sid-noop-te', { send })
      const completeMsg: ServerMessage = {
        type: 'message.complete',
        payload: { sessionId: 'sid-noop-te', stopReason: 'end_turn' },
      }
      expect(() => interpreter.interpret([{ kind: 'turn-end', message: completeMsg }])).not.toThrow()
      await new Promise<void>(r => setTimeout(r, 0))
      expect(sent.find(m => m.type === 'message.complete')).toBeDefined()
    })
  })
})
