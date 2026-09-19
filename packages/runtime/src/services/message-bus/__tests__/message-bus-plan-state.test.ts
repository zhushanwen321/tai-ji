/**
 * message-bus plan 投影登记单测（plan 模式重设计 D1⑤）。
 *
 * 锁定 'session.planState' 的两表登记（照 'session.subagents' 同款断言口径）：
 * - TOPIC_TABLE：'state' 类（分配 seq、写快照、不入 ring）；
 * - STATE_TYPE_KEY_MAP：typeKey 'plan'（subscribe 的 stateSnapshot 含该帧）。
 *
 * 未入表的 fallback='stream' 永不写快照——若两表任一漏登记，本文件的
 * stateSnapshot/ring 断言即红（投影链六件套之一，静默失效面由测试显式锚定）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/message-bus/__tests__/message-bus-plan-state.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import type { BusClient } from '../types.js'
import { MessageBus } from '../message-bus.js'

function makeClient(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}

function planStateFrame(isActive: boolean): ServerMessage {
  return {
    type: 'session.planState',
    payload: {
      sessionId: 's1',
      planState: { isActive, planFilePath: isActive ? '/tmp/taiji-plan/auth/plan.md' : null, requirement: null, templateName: null },
    },
  } as unknown as ServerMessage
}

describe('session.planState 两表登记（D1⑤）', () => {
  it('state 类：写 stateSnapshot（typeKey plan）且不入 streamRing', () => {
    const bus = new MessageBus()
    bus.publish('s1', planStateFrame(true))
    const sub = bus.subscribe('s1', makeClient())
    expect(sub.stateSnapshot.map((m) => m.type)).toEqual(['session.planState'])
    expect(sub.snapshot).toHaveLength(0)
    // state 类分配 seq（订阅方 lastSeq 基线推进）
    expect(sub.lastSeq).toBe(1)
  })

  it('last-value 覆盖：同 typeKey 替换只留最新值（isActive 翻转可回放）', () => {
    const bus = new MessageBus()
    bus.publish('s1', planStateFrame(true))
    bus.publish('s1', planStateFrame(false))
    const sub = bus.subscribe('s1', makeClient())
    expect(sub.stateSnapshot).toHaveLength(1)
    const payload = sub.stateSnapshot[0]!.payload as { planState: { isActive: boolean } }
    expect(payload.planState.isActive).toBe(false)
  })

  it('wire 直推：订阅中的 ws 收到该帧（广播正常）', () => {
    const bus = new MessageBus()
    const ws = makeClient()
    bus.subscribe('s1', ws)
    bus.publish('s1', planStateFrame(true))
    const received = ws.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
    expect(received.map((m) => m.type)).toEqual(['session.planState'])
  })
})
