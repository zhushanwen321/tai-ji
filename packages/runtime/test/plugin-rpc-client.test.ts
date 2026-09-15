import { describe, it, expect, beforeEach } from 'vitest'

import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { ClientPort } from '../src/services/plugin-service/plugin-rpc-client.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'

function createMockPort(): ClientPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

describe('PluginRpcClient', () => {
  let client: PluginRpcClient
  let port: ReturnType<typeof createMockPort>

  beforeEach(() => {
    client = new PluginRpcClient()
    port = createMockPort()
    client.attach(port)
  })

  // ── TC-3-02: request timeout → RPC_TIMEOUT error ──────────────
  it('TC-3-02: request() rejects with RPC_TIMEOUT when server never responds', async () => {
    const promise = client.request('test.slow', {}, 50)

    // Verify request was sent
    expect(port.messages.length).toBe(1)
    const sent = port.messages[0] as { type: string; method: string; id: number }
    expect(sent.type).toBe('rpc')
    expect(sent.method).toBe('test.slow')

    // No response arrives → timeout after 50ms
    const start = Date.now()
    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      const elapsed = Date.now() - start
      expect(elapsed >= 45).toBeTruthy()
      expect((e as Error).message.includes('RPC timeout')).toBeTruthy()
      expect((e as { code?: number }).code).toBe(PluginRpcErrorCodes.RPC_TIMEOUT)
    }
    expect(caught).toBeTruthy()
  })

  // ── request succeeds when response arrives before timeout ──────
  it('request() resolves when response arrives before timeout', async () => {
    const promise = client.request('test.fast', { x: 1 }, 500)

    // Simulate server response
    const sent = port.messages[0] as { id: number }
    client.handleResponse({
      jsonrpc: '2.0',
      id: sent.id,
      result: { echoed: true },
    })

    const result = await promise
    expect(result).toEqual({ echoed: true })
  })

  // ── request rejects with error response ────────────────────────
  it('request() rejects with error when server returns error', async () => {
    const promise = client.request('test.fail', {}, 500)

    const sent = port.messages[0] as { id: number }
    client.handleResponse({
      jsonrpc: '2.0',
      id: sent.id,
      error: { code: -32600, message: 'bad request' },
    })

    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      expect((e as Error).message.includes('bad request')).toBeTruthy()
      expect((e as { code?: number }).code).toBe(-32600)
    }
    expect(caught).toBeTruthy()
  })

  // ── dispose cancels pending requests ───────────────────────────
  it('dispose() cancels pending requests', async () => {
    const promise = client.request('test.pending', {}, 5000)

    // Dispose before response
    client.dispose()

    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      expect((e as Error).message.includes('disposed')).toBeTruthy()
    }
    expect(caught).toBeTruthy()
  })

  // ── multiple concurrent requests get correct responses ─────────
  it('concurrent requests receive correct responses by id', async () => {
    const promises = [
      client.request('test.a', { val: 1 }, 500),
      client.request('test.b', { val: 2 }, 500),
      client.request('test.c', { val: 3 }, 500),
    ]

    // Respond out of order
    const ids = port.messages.map((m: unknown) => (m as { id: number }).id)
    client.handleResponse({ jsonrpc: '2.0', id: ids[2], result: 'C' })
    client.handleResponse({ jsonrpc: '2.0', id: ids[0], result: 'A' })
    client.handleResponse({ jsonrpc: '2.0', id: ids[1], result: 'B' })

    const results = await Promise.all(promises)
    expect(results).toEqual(['A', 'B', 'C'])
  })

  // ── notification sends without id ──────────────────────────────
  it('notify() sends notification without id', () => {
    client.notify('test.event', { data: 42 })

    expect(port.messages.length).toBe(1)
    const msg = port.messages[0] as { type: string; method: string; id?: number }
    expect(msg.type).toBe('rpc')
    expect(msg.method).toBe('test.event')
    expect(msg.id).toBe(undefined)
  })

  // ── onNotification receives notifications ──────────────────────
  it('onNotification() handler receives notifications', () => {
    const received: unknown[] = []
    client.onNotification('test.push', (params) => {
      received.push(params)
    })

    client.handleNotification({ jsonrpc: '2.0', method: 'test.push', params: { n: 1 } })
    client.handleNotification({ jsonrpc: '2.0', method: 'test.push', params: { n: 2 } })

    expect(received.length).toBe(2)
    expect(received[0]).toEqual({ n: 1 })
    expect(received[1]).toEqual({ n: 2 })
  })

  // ── onNotification unsubscribe stops receiving ─────────────────
  it('onNotification() unsubscribe stops receiving', () => {
    const received: unknown[] = []
    const unsub = client.onNotification('test.temp', (params) => {
      received.push(params)
    })

    client.handleNotification({ jsonrpc: '2.0', method: 'test.temp', params: { a: 1 } })
    unsub()
    client.handleNotification({ jsonrpc: '2.0', method: 'test.temp', params: { a: 2 } })

    expect(received.length).toBe(1)
  })
})
