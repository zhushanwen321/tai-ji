/**
 * MessageBus 观测面测试（pull-push W0 / D7「发布/订阅侧结构化日志」）。
 *
 * 覆盖：
 * - 投递失败观测（S5「一次推送丢失在日志可检索」）：state 类零送达落 deliver-dropped
 *   （域键=type、原因=no-subscriber/undelivered、耗时=elapsedMs）；GUI 投影五族逐条；
 *   其余 state 类 (sid,type) 滑窗限频（首条 + 窗口翻落聚合行带 suppressed 计数）；
 *   stream/transient 不观测（ring 回放兜底 / 设计内可丢）。
 * - 订阅生命周期观测：subscribe（stateSnapshot 键集 = 6c3 排障第一问的直接证据）、
 *   unsubscribe（幂等重入不落）、unsubscribeAll、clearSession（并清限频窗口）。
 * - 正常路径零日志（S5「无噪声」锚）：有 live 订阅者且送达成功不产生观测事件。
 *
 * 观察手段：vi.mock logger（不触真实日志文件）；行为层用 mock BusClient 收集 send。
 * 运行：cd packages/runtime && npx vitest run src/services/message-bus/__tests__/bus-observe.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageBus } from '../message-bus.js'
import { _resetBusObserveStateForTest } from '../bus-observe.js'
import type { BusClient } from '../types.js'
import type { ServerMessage } from '@taiji/shared'

vi.mock('../../../infra/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const loggerInfo = vi.mocked((await import('../../../infra/logger.js')).logger.info)
const loggerWarn = vi.mocked((await import('../../../infra/logger.js')).logger.warn)

/** deliver-dropped 观测行提取（meta 形态见 bus-observe.ts）。 */
function deliverDrops(): Array<Record<string, unknown>> {
  return loggerInfo.mock.calls
    .filter(([message]) => message === '[bus-observe] deliver-dropped')
    .map(([, meta]) => meta as Record<string, unknown>)
}

/** 全部 bus-observe 观测行（message 前缀匹配）。 */
function observeEvents(): Array<[string, Record<string, unknown> | undefined]> {
  return loggerInfo.mock.calls.filter(([message]) => String(message).startsWith('[bus-observe]')) as Array<[string, Record<string, unknown> | undefined]>
}

function mockClient(readyState = 1): BusClient & { sent: string[] } {
  const sent: string[] = []
  return { readyState, send: (data: string) => { sent.push(data) }, sent }
}

function stateMessage(type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: 's1', ...payload } } as ServerMessage
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetBusObserveStateForTest()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('投递失败观测（deliver-dropped）', () => {
  it('投影族空投逐条：planState 零订阅者发布 → 观测行带域键/原因/耗时', () => {
    const bus = new MessageBus()
    const started = Date.now()
    bus.publish('s1', stateMessage('session.planState', { planState: { isActive: false } }))

    const drops = deliverDrops()
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ sessionId: 's1', type: 'session.planState', reason: 'no-subscriber', subscribers: 0 })
    const elapsed = drops[0]!.elapsedMs as number
    expect(elapsed).toBeGreaterThanOrEqual(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(elapsed) // 耗时字段与真实时钟同源
  })

  it('投影族「订了但不在线」形态：readyState!==1 → reason=undelivered', () => {
    const bus = new MessageBus()
    bus.subscribe('s1', mockClient(3)) // CLOSED
    bus.publish('s1', stateMessage('session.subagents', { subagents: [] }))

    expect(deliverDrops()).toHaveLength(1)
    expect(deliverDrops()[0]).toMatchObject({ type: 'session.subagents', reason: 'undelivered', subscribers: 1 })
  })

  it('非投影族 state 空投限频：窗口内第二条不落日志；窗口翻落后聚合行带 suppressed 计数', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-26T00:00:00Z'))
    const bus = new MessageBus()
    // occupancy（非投影族 state）：窗口内首条落 + 第二条抑制
    bus.publish('s1', stateMessage('session.occupancy'))
    vi.setSystemTime(new Date('2026-09-26T00:00:10Z'))
    bus.publish('s1', stateMessage('session.occupancy'))
    let drops = deliverDrops().filter((d) => d.type === 'session.occupancy')
    expect(drops).toHaveLength(1)

    // 窗口翻落（>60s）后再空投：新窗口首条落，携带上一窗口抑制计数
    vi.setSystemTime(new Date('2026-09-26T00:01:30Z'))
    bus.publish('s1', stateMessage('session.occupancy'))
    drops = deliverDrops().filter((d) => d.type === 'session.occupancy')
    expect(drops).toHaveLength(2)
    expect(drops[1]).toMatchObject({ type: 'session.occupancy', suppressedInLastWindow: 1 })
  })

  it('stream / transient 空投不观测（ring 回放兜底 / 设计内可丢）', () => {
    const bus = new MessageBus()
    bus.publish('s1', stateMessage('message.message_start')) // stream（fallback 类）
    bus.publish('s1', stateMessage('message.text_delta')) // transient
    bus.publish('s1', stateMessage('terminal.data')) // transient（表内登记）
    expect(deliverDrops()).toHaveLength(0)
  })

  it('正常路径零日志：live 订阅者送达成功不产生任何 bus-observe 事件', () => {
    const bus = new MessageBus()
    const ws = mockClient()
    bus.subscribe('s1', ws)
    bus.publish('s1', stateMessage('session.planState', { planState: { isActive: false } }))
    bus.publish('s1', stateMessage('session.occupancy'))
    bus.publish('s1', stateMessage('message.text_delta'))

    expect(ws.sent).toHaveLength(3)
    expect(deliverDrops()).toHaveLength(0)
    // 只有 subscribe 一条生命周期事件，无投递失败事件
    expect(observeEvents().map(([m]) => m)).toEqual(['[bus-observe] subscribe'])
    expect(loggerWarn).not.toHaveBeenCalled()
  })
})

describe('订阅生命周期观测', () => {
  it('subscribe 观测携带 stateSnapshot 键集（6c3 排障第一问：快照里有没有 plan 帧）', () => {
    const bus = new MessageBus()
    bus.publish('s1', stateMessage('session.planState', { planState: { isActive: true } })) // 空投建快照
    loggerInfo.mockClear()
    bus.subscribe('s1', mockClient())

    const events = observeEvents()
    expect(events).toHaveLength(1)
    const [, meta] = events[0]!
    expect(meta).toMatchObject({ sessionId: 's1', ringSize: 0, lastSeq: 1, subscribers: 1 })
    expect(meta!.stateKeys).toEqual(['plan'])
  })

  it('unsubscribe 真实移除落事件；幂等重入不落', () => {
    const bus = new MessageBus()
    const ws = mockClient()
    bus.subscribe('s1', ws)
    loggerInfo.mockClear()

    bus.unsubscribe('s1', ws)
    expect(observeEvents().map(([m]) => m)).toEqual(['[bus-observe] unsubscribe'])
    expect(observeEvents()[0]![1]).toMatchObject({ sessionId: 's1', subscribersLeft: 0 })

    loggerInfo.mockClear()
    bus.unsubscribe('s1', ws) // ES2 幂等 no-op
    bus.unsubscribe('s-unknown', ws)
    expect(observeEvents()).toHaveLength(0)
  })

  it('unsubscribeAll / clearSession 落事件；clearSession 清限频窗口', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-26T00:00:00Z'))
    const bus = new MessageBus()
    const ws = mockClient()
    bus.subscribe('s1', ws)
    bus.publish('s1', stateMessage('session.occupancy')) // 建限频键（空投首条）
    loggerInfo.mockClear()

    bus.unsubscribeAll(ws)
    const names = observeEvents().map(([m]) => m)
    expect(names).toContain('[bus-observe] unsubscribe-all')
    expect(observeEvents().find(([m]) => m === '[bus-observe] unsubscribe-all')![1]).toMatchObject({ sessionCount: 1, sessionIds: ['s1'] })

    bus.clearSession('s1')
    expect(observeEvents().map(([m]) => m)).toContain('[bus-observe] clear-session')

    // 限频窗口已清：窗口中段再空投 occupancy 视为新窗口首条（无 suppressed 字段）
    vi.setSystemTime(new Date('2026-09-26T00:00:30Z'))
    bus.publish('s1', stateMessage('session.occupancy'))
    const drops = deliverDrops()
    expect(drops).toHaveLength(1)
    expect(drops[0]).not.toHaveProperty('suppressedInLastWindow')
  })
})
