/**
 * mock-ws 单测 —— createMockPlatform（in-memory KVStorage + WebSocketLike 桩：
 * 200ms connecting→connected、ping 回灌 pong、close→CLOSED）。fake timers 驱动延迟。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WS_READY_STATE } from '../../../platform/port'
import { createMockPlatform } from '../mock-ws'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
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
