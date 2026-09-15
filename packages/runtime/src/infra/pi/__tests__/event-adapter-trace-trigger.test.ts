/**
 * withTraceTrigger 组合点回归测试（session-trace A33，round3 review S2 / mutation M4）。
 *
 * 锁定：message_end / agent_settled / entry_appended 三事件经 translate() 输出
 * **同时**含 main 侧 handler 产物（W21 实时 feed / W1 bash flush / W18 派生缓存失效）
 * **与** trace-trigger 中间事件（interpreter 调 onTraceSync 做追赶式 since 拉取），
 * 且 main 产物在前、trace-trigger 追加在后。
 *
 * 回归背景：本 PR merge 曾修「两组 DISPATCHER.set 叠加互相覆盖」bug（Map 后写覆盖
 * 前写，丢一组产物）。若退回单 handler 覆盖形态（丢 trace-trigger 追加），本文件
 * 用例必须红——session-trace.test.ts 只测 interpreter 消费侧（直接喂构造好的
 * trace-trigger 事件），adapter 产出侧此前零锚定。
 *
 * translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-trace-trigger.test.ts
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../event-adapter.js'
import type {
  PiEvent,
  PiMessageEndEvent,
  PiAgentSettledEvent,
  PiEntryAppendedEvent,
} from '../pi-protocol.js'

const SID = 's-trace-trigger'

describe('withTraceTrigger 组合注册不互相覆盖（session-trace A33 回归锁）', () => {
  it('组合注册不互相覆盖：三事件输出 main handler + trace-trigger 双产物', () => {
    // message_end：main = W21 实时 feed（message.message_end entry 帧）
    const messageEnd = translate(
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 1755700000000 },
      } as unknown as PiMessageEndEvent,
      SID,
    )
    expect(messageEnd).toHaveLength(2)
    expect(messageEnd[0]).toMatchObject({
      kind: 'message',
      message: {
        type: 'message.message_end',
        payload: {
          sessionId: SID,
          entry: { type: 'message', message: { role: 'assistant' } },
        },
      },
    })
    expect(messageEnd[1]).toEqual({ kind: 'trace-trigger', trigger: 'message_end' })

    // agent_settled：main = W1 bash flush 信号（agent-settled 中间事件）
    const settled = translate({ type: 'agent_settled' } as PiAgentSettledEvent, SID)
    expect(settled).toEqual([{ kind: 'agent-settled' }, { kind: 'trace-trigger', trigger: 'agent_settled' }])

    // entry_appended：main = W18 派生缓存失效（record-entry-appended）
    const appended = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'subagent-record' } } as unknown as PiEntryAppendedEvent,
      SID,
    )
    expect(appended).toEqual([
      { kind: 'record-entry-appended', customType: 'subagent-record' },
      { kind: 'trace-trigger', trigger: 'entry_appended' },
    ])
  })

  it('trace 腿独立于 main 腿：entry_appended 非 record customType 时 main 走 noop，trace-trigger 仍追加', () => {
    const events = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'demo:other' } } as unknown as PiEntryAppendedEvent,
      SID,
    )
    // 组合语义：main handler 的过滤（只对 record customType 产失效信号）不拖累
    // trace 腿——trace 视图仍需感知 extension appendEntry 触发追赶拉取
    expect(events).toEqual([{ kind: 'noop' }, { kind: 'trace-trigger', trigger: 'entry_appended' }])
  })

  it('非触发事件不追加 trace-trigger（组合点只注册三事件，守卫不扩大）', () => {
    const events = translate(
      {
        type: 'message_end',
        message: { role: 'user', content: 'hi' },
      } as unknown as PiEvent,
      SID,
    )
    expect(events).toHaveLength(2)
    // message_end 恒触发；换一个非触发事件对照（status）
    const status = translate({ type: 'status', status: 'busy' } as unknown as PiEvent, SID)
    expect(status.every((e) => e.kind !== 'trace-trigger')).toBe(true)
  })

  it('entry_appended 对 workflow-record 同样双产物（W18 两类派生缓存）', () => {
    const events = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'workflow-record' } } as unknown as PiEntryAppendedEvent,
      SID,
    )
    expect(events).toEqual([
      { kind: 'record-entry-appended', customType: 'workflow-record' },
      { kind: 'trace-trigger', trigger: 'entry_appended' },
    ])
  })
})
