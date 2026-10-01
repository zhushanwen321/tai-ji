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
 * D9③ 投影面边界（plan 状态机显式化）：selfReview 消费面止于审批请求帧，**不投影进
 * session.planState 帧**（planState 帧有界前提不扩展）；state/resumeHint（D2 归一产物）
 * 经帧无损透传。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/message-bus/__tests__/message-bus-plan-state.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import type { BusClient } from '../types.js'
import { MessageBus } from '../message-bus.js'
import { scanPlanStateEntries } from '../../session/plan-state-extractor.js'

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

describe('D9③ 投影面边界：selfReview 不进 session.planState 帧', () => {
  it('entry 携带 selfReview → 派生 View 无 selfReview、帧经 bus 序列化全程无泄漏；state/resumeHint 无损透传', () => {
    const entry = {
      type: 'custom',
      customType: 'plan-state',
      id: 'e1',
      parentId: null,
      timestamp: '2026-09-24T00:00:00Z',
      data: {
        isActive: true,
        planFilePath: '/tmp/taiji-plan/auth/plan.md',
        requirement: '重构 auth 模块',
        templateName: 'tech-design',
        state: 'reviewing',
        resumeHint: 'resubmit',
        selfReview: '自审结论（消费面止于审批请求帧，不投影进本帧）',
      },
    }
    const view = scanPlanStateEntries([entry])
    expect(view).not.toBeNull()
    expect(view!.state).toBe('reviewing')
    expect(view!.resumeHint).toBe('resubmit')
    expect('selfReview' in view!).toBe(false)

    const bus = new MessageBus()
    const ws = makeClient()
    bus.subscribe('s1', ws)
    bus.publish('s1', {
      type: 'session.planState',
      payload: { sessionId: 's1', planState: view },
    } as unknown as ServerMessage)
    const received = ws.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
    // 序列化全帧不含 selfReview（投影面止于审批请求帧，planState 帧有界前提不扩展）
    expect(JSON.stringify(received)).not.toContain('selfReview')
    const payload = received[0]!.payload as { planState: { state: string; resumeHint: string } }
    expect(payload.planState.state).toBe('reviewing')
    expect(payload.planState.resumeHint).toBe('resubmit')
  })
})
