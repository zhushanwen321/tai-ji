/**
 * createProjectionBusView 单测（composer-gen-stats 设计 D4 写 2 挂接点的实装件——
 * 全 runtime 唯一 state_changed 拦截点；此前仅经 session-service 大装配间接擦到，
 * modelId 守卫分支回归时无定向失败信息，review round1 test-coverage S15）。
 *
 * 覆盖：
 * - state_changed + 合法 modelId → tap 触发且帧序先 publish 后 tap（MF9 固定帧序：
 *   state_changed 同步送达订阅 ws 之后才执行写 2 tap）
 * - 非 state_changed 类型 → 仅透传 publish，不触发 tap
 * - modelId 守卫：payload 缺失 / 非 string / 空串 → 不触发 tap（publish 仍透传）
 * - 其余 IMessageBus 方法逐项透传底层 bus
 *
 * Mock 边界：fake bus（vi.fn 五方法，零真实 ws）；纯内存无 fs、无 timer。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/projection-bus-view.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { ServerMessage } from '@taiji/shared'

import type { BusClient } from '../../message-bus/types.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import { createProjectionBusView } from '../projection-bus-view.js'

const SID = 'sess-1'
const MODEL_ID = 'xiaomi-token-plan-cn/mimo-v2.5-pro'

interface FakeBus {
  publish: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  unsubscribeAll: ReturnType<typeof vi.fn>
  clearSession: ReturnType<typeof vi.fn>
}

function makeFakeBus(): FakeBus {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(() => ({ snapshot: [], stateSnapshot: [], lastSeq: 0 })),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  }
}

/** state_changed 合法载荷（对齐 shared protocol ServerMessageMap 契约）。 */
function stateChangedMessage(modelId: string, thinkingLevel?: string): ServerMessage {
  const payload: { sessionId: string; modelId: string; thinkingLevel?: string } = { sessionId: SID, modelId }
  if (thinkingLevel !== undefined) payload.thinkingLevel = thinkingLevel
  return { type: 'session.state_changed', id: 'push_test', payload }
}

/** 运行时脏数据形态构造（守卫分支的被测对象；协议类型上不合法，故意 as）。 */
function dirtyMessage(type: string, payload?: unknown): ServerMessage {
  return { type, id: 'push_test', payload } as unknown as ServerMessage
}

describe('createProjectionBusView：state_changed 拦截 tap（D4 写 2 挂接点）', () => {
  it('state_changed + 合法 modelId：tap 触发 (sessionId, modelId)，帧序先 publish 后 tap（MF9）', () => {
    const bus = makeFakeBus()
    const order: string[] = []
    bus.publish.mockImplementation(() => order.push('publish'))
    const onStateChanged = vi.fn(() => order.push('tap'))
    const view = createProjectionBusView(bus as unknown as IMessageBus, onStateChanged)

    view.publish(SID, stateChangedMessage(MODEL_ID))

    expect(bus.publish).toHaveBeenCalledTimes(1)
    expect(bus.publish).toHaveBeenCalledWith(SID, stateChangedMessage(MODEL_ID))
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    expect(onStateChanged).toHaveBeenCalledWith(SID, MODEL_ID)
    expect(order).toEqual(['publish', 'tap']) // 固定帧序：原序发布先于后置 tap
  })

  it('非 state_changed 类型（session.thinkingLevelSet）：publish 透传但不触发 tap', () => {
    const bus = makeFakeBus()
    const onStateChanged = vi.fn()
    const view = createProjectionBusView(bus as unknown as IMessageBus, onStateChanged)

    const msg = dirtyMessage('session.thinkingLevelSet', { sessionId: SID, level: 'high' })
    view.publish(SID, msg)

    expect(bus.publish).toHaveBeenCalledTimes(1)
    expect(bus.publish).toHaveBeenCalledWith(SID, msg)
    expect(onStateChanged).not.toHaveBeenCalled()
  })

  it('modelId 守卫：payload 缺失 / 非 string / 空串 → 不触发 tap（publish 仍透传）', () => {
    const bus = makeFakeBus()
    const onStateChanged = vi.fn()
    const view = createProjectionBusView(bus as unknown as IMessageBus, onStateChanged)

    const dirtyPayloads: unknown[] = [undefined, {}, { modelId: '' }, { modelId: 42 }, { modelId: null }]
    for (const payload of dirtyPayloads) {
      view.publish(SID, dirtyMessage('session.state_changed', payload))
    }

    expect(bus.publish).toHaveBeenCalledTimes(dirtyPayloads.length)
    expect(onStateChanged).not.toHaveBeenCalled()
  })
})

describe('createProjectionBusView：其余 IMessageBus 方法透传', () => {
  it('subscribe/unsubscribe/unsubscribeAll/clearSession 逐项委托底层 bus，subscribe 返回值原样透传', () => {
    const bus = makeFakeBus()
    const view = createProjectionBusView(bus as unknown as IMessageBus, vi.fn())
    const ws: BusClient = { readyState: 1, send: vi.fn() }

    const subResult = view.subscribe(SID, ws)
    view.unsubscribe(SID, ws)
    view.unsubscribeAll(ws)
    view.clearSession(SID)

    expect(bus.subscribe).toHaveBeenCalledWith(SID, ws)
    expect(bus.unsubscribe).toHaveBeenCalledWith(SID, ws)
    expect(bus.unsubscribeAll).toHaveBeenCalledWith(ws)
    expect(bus.clearSession).toHaveBeenCalledWith(SID)
    expect(subResult).toEqual({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
  })

  it('wrapped 对象不依赖 Facade 状态：同参数多次 publish 各自透传（memoize 归 Facade，此处只验视图无状态）', () => {
    const bus = makeFakeBus()
    const onStateChanged = vi.fn()
    const view = createProjectionBusView(bus as unknown as IMessageBus, onStateChanged)

    view.publish(SID, stateChangedMessage(MODEL_ID))
    view.publish(SID, stateChangedMessage('another/model'))

    expect(bus.publish).toHaveBeenCalledTimes(2)
    expect(onStateChanged).toHaveBeenCalledTimes(2)
    expect(onStateChanged).toHaveBeenNthCalledWith(2, SID, 'another/model')
  })
})
