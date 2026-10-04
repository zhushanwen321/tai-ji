/**
 * 送达水位对账触发接线测试（reload-closeout D2，u1）。
 *
 * 两段：
 * - event-adapter：agent_settled 经组合注册（withRecordReconcileTrigger ∘ withTraceTrigger）
 *   追加 record-reconcile-trigger 中间事件——原 handler 输出在前、两路追加在后互不取代；
 *   非 agent_settled 事件不追加（对账腿只挂 run 级联边界信号）。
 * - event-interpreter：record-reconcile-trigger → onRecordReconcile(sessionId) fire-and-forget
 *   恰好一次；未注入回调 no-op。
 *
 * 运行：cd packages/runtime && npx vitest run test/event-adapter-record-reconcile.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { translate } from '../src/infra/pi/event-adapter.js'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiEvent } from '../src/infra/pi/pi-protocol.js'

describe('event-adapter：agent_settled → record-reconcile-trigger（组合注册）', () => {
  it('agent_settled 输出 = [agent-settled, trace-trigger, record-reconcile-trigger]（原 handler 在前、追加在后）', () => {
    const out = translate({ type: 'agent_settled' } as PiEvent, 's1')
    expect(out).toEqual([
      { kind: 'agent-settled' },
      { kind: 'trace-trigger', trigger: 'agent_settled' },
      { kind: 'record-reconcile-trigger' },
    ])
  })

  it('entry_appended（record 主信号）不追加对账触发（对账腿不挂 entry 级信号）', () => {
    const out = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'subagent-record' } } as unknown as PiEvent,
      's1',
    )
    expect(out).toContainEqual({ kind: 'record-entry-appended', customType: 'subagent-record' })
    expect(out).toContainEqual({ kind: 'trace-trigger', trigger: 'entry_appended' })
    expect(out.some((ev) => ev.kind === 'record-reconcile-trigger')).toBe(false)
  })

  it('message_end 只追加 trace-trigger（trace 腿与对账腿不串扰）', () => {
    const out = translate({
      type: 'message_end',
      message: { id: 'm1', role: 'assistant', content: [] },
    } as unknown as PiEvent, 's1')
    expect(out.some((ev) => ev.kind === 'trace-trigger')).toBe(true)
    expect(out.some((ev) => ev.kind === 'record-reconcile-trigger')).toBe(false)
  })
})

describe('event-interpreter：record-reconcile-trigger → onRecordReconcile', () => {
  it('恰好一次、参数 = interpreter 持有 sid（非事件 payload 自报——事件无 payload）', () => {
    const onRecordReconcile = vi.fn()
    const interpreter = new EventInterpreter('sid-rec', { send: () => {}, onRecordReconcile })

    interpreter.interpret([{ kind: 'record-reconcile-trigger' }])

    expect(onRecordReconcile).toHaveBeenCalledTimes(1)
    expect(onRecordReconcile).toHaveBeenCalledWith('sid-rec')
  })

  it('未注入回调 no-op（存量单测装配不受新增 opts 影响）', () => {
    const sent: ServerMessage[] = []
    const interpreter = new EventInterpreter('sid-rec-2', { send: (m) => { sent.push(m) } })

    expect(() => interpreter.interpret([{ kind: 'record-reconcile-trigger' }])).not.toThrow()
    expect(sent).toEqual([])
  })
})
