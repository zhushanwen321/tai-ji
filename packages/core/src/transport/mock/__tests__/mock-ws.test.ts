/**
 * mock-ws 单测 —— 旧三导出（mockConnect/mockSend/mockDisconnect 状态机 + ping→pong）
 * 与新 createMockPlatform（in-memory KVStorage + WebSocketLike 桩：200ms connecting→connected、
 * ping 回灌 pong、close→CLOSED）。fake timers 驱动延迟。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { WS_READY_STATE } from '../../../platform/port'
import {
  mockConnect, mockDisconnect, mockSend, createMockPlatform,
} from '../mock-ws'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  mockDisconnect()
  vi.useRealTimers()
})

describe('旧导出（过渡兼容）：mockConnect / mockSend / mockDisconnect', () => {
  it('mockConnect：connecting → 200ms 后 connected', () => {
    const states: string[] = []
    mockConnect((s) => states.push(s), () => {})
    expect(states).toEqual(['connecting'])
    vi.advanceTimersByTime(200)
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('mockSend：ping 延迟 10ms 回灌 pong，其余类型 no-op', () => {
    const received: ServerMessage[] = []
    mockConnect(() => {}, (m) => received.push(m))
    mockSend({ type: 'ping', payload: {} })
    expect(received).toHaveLength(0)
    vi.advanceTimersByTime(10)
    expect(received.map((m) => m.type)).toEqual(['pong'])
    mockSend({ type: 'message.send', payload: {} } as never)
    vi.advanceTimersByTime(100)
    expect(received).toHaveLength(1)
  })

  it('mockDisconnect：回调置 disconnected 后清空', () => {
    const states: string[] = []
    mockConnect((s) => states.push(s), () => {})
    mockDisconnect()
    expect(states).toEqual(['connecting', 'disconnected'])
    // 二次 disconnect：callback 已清空，无新状态
    mockDisconnect()
    expect(states).toHaveLength(2)
  })
})

describe('createMockPlatform', () => {
  it('storage：get 不存在返 null，set/remove 闭环', async () => {
    const { storage } = createMockPlatform()
    expect(await storage.get('k')).toBeNull()
    await storage.set('k', 'v')
    expect(await storage.get('k')).toBe('v')
    await storage.remove('k')
    expect(await storage.get('k')).toBeNull()
  })

  it('webSocket 桩：CONNECTING → 200ms OPEN → onopen；ping 回灌 pong；close → CLOSED', () => {
    const { webSocket } = createMockPlatform()
    const ws = webSocket.create('ws://mock')
    expect(ws.readyState).toBe(WS_READY_STATE.CONNECTING)
    let opened = false
    let closed = false
    const received: string[] = []
    ws.onopen = () => {
      opened = true
    }
    ws.onclose = () => {
      closed = true
    }
    ws.onmessage = (ev: { data: unknown }): void => { received.push(String(ev.data)) }
    vi.advanceTimersByTime(200)
    expect(opened).toBe(true)
    expect(ws.readyState).toBe(WS_READY_STATE.OPEN)
    ws.send(JSON.stringify({ type: 'ping', payload: {} }))
    vi.advanceTimersByTime(10)
    expect(received.map((d) => (JSON.parse(d) as { type: string }).type)).toEqual(['pong'])
    // 非 JSON / 非 ping 消息静默忽略
    ws.send('not-json')
    ws.send(JSON.stringify({ type: 'message.send', payload: {} }))
    vi.advanceTimersByTime(100)
    expect(received).toHaveLength(1)
    ws.close()
    expect(closed).toBe(true)
    expect(ws.readyState).toBe(WS_READY_STATE.CLOSED)
  })
})
