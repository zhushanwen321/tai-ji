import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventAdapter, type EventAdapterOptions } from './helpers/event-adapter-test-fixture.js'
import type { EventAdapter } from '../src/infra/pi/event-adapter.js'
import type { ServerMessage } from '@xyz-agent/shared'

function createAdapter(options?: EventAdapterOptions): {
  adapter: EventAdapter
  sent: ServerMessage[]
} {
  const sent: ServerMessage[] = []
  const send = vi.fn((msg: ServerMessage) => { sent.push(msg) })
  const adapter = createEventAdapter('test-session-id', send, options)
  return { adapter, sent }
}

describe('EventAdapter extension bridge', () => {
  describe('setWidget', () => {
    it('sends extension.widget WS event with widgetKey and lines', async () => {
      const { adapter, sent } = createAdapter()
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      // Get the event listener
      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      // Simulate setWidget event from pi
      listener({
        type: 'extension_ui_request',
        method: 'setWidget',
        widgetKey: 'my-widget',
        widgetLines: ['line 1', 'line 2', 'line 3'],
      })

      // Wait for async handling
      await vi.waitFor(() => sent.length > 0)

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:widget')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-id',
        widgetKey: 'my-widget',
        lines: ['line 1', 'line 2', 'line 3'],
      })
    })

    it('handles missing key and lines as widget clear (gui:null)', async () => {
      const { adapter, sent } = createAdapter()
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setWidget',
      })

      await vi.waitFor(() => sent.length > 0)

      // 缺失 widgetLines → 清除语义 → extension:widgetGui with gui:null
      expect(sent[0].type).toBe('extension:widgetGui')
      const payload = sent[0].payload as { widgetKey: string; gui: null }
      expect(payload.widgetKey).toBe('')
      expect(payload.gui).toBeNull()
    })

    it('converts non-string lines to strings', async () => {
      const { adapter, sent } = createAdapter()
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setWidget',
        widgetKey: 'widget',
        widgetLines: [42, null, 'text'],
      })

      await vi.waitFor(() => sent.length > 0)

      expect((sent[0].payload as { lines: string[] }).lines).toEqual(['42', 'null', 'text'])
    })
  })

  describe('setStatus', () => {
    it('sends extension.status WS event and invokes callback', async () => {
      const onStatusSetUpdate = vi.fn()
      const { adapter, sent } = createAdapter({ onStatusSetUpdate })
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'my-status',
        statusText: 'Loading...',
      })

      await vi.waitFor(() => sent.length > 0)

      // Callback should be called（status-set 中间事件携带 textRaw 原始文本）
      expect(onStatusSetUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        key: 'my-status',
        text: 'Loading...',
        textRaw: 'Loading...',
      })

      // WS event should be sent（payload 含 text + textRaw，协议 spec §8.1）
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:status')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-id',
        statusKey: 'my-status',
        text: 'Loading...',
        textRaw: 'Loading...',
      })
    })

    it('sends WS event even without callback', async () => {
      const { adapter, sent } = createAdapter() // no onStatusSetUpdate
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'status',
        statusText: 'Done',
      })

      await vi.waitFor(() => sent.length > 0)

      expect(sent[0].type).toBe('extension:status')
      const statusPayload = sent[0].payload as { statusKey: string; text: string }
      expect(statusPayload.statusKey).toBe('status')
      expect(statusPayload.text).toBe('Done')
    })

    it('handles missing key/text with defaults', async () => {
      const onStatusSetUpdate = vi.fn()
      const { adapter } = createAdapter({ onStatusSetUpdate })
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({ type: 'extension_ui_request', method: 'setStatus' })

      await vi.waitFor(() => onStatusSetUpdate.mock.calls.length > 0)

      expect(onStatusSetUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        key: '',
        text: '',
        textRaw: '',
      })
    })

    it('handles undefined text with empty string', async () => {
      const onStatusSetUpdate = vi.fn()
      const { adapter } = createAdapter({ onStatusSetUpdate })
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'todo',
        statusText: undefined,
      })

      await vi.waitFor(() => onStatusSetUpdate.mock.calls.length > 0)

      expect(onStatusSetUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        key: 'todo',
        text: '',
        textRaw: '',
      })
    })

    it('multiple setStatus events are all captured', async () => {
      const statusUpdates: Array<{ sessionId: string; key: string; text: string }> = []
      const { adapter } = createAdapter({
        onStatusSetUpdate: (data) => {
          statusUpdates.push(data)
        },
      })
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener(piEvent({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'goal', statusText: '3/20' }))
      listener(piEvent({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'todo', statusText: '5/10' }))
      listener(piEvent({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'goal', statusText: '' })) // clear

      await vi.waitFor(() => statusUpdates.length === 3)

      expect(statusUpdates[0].key).toBe('goal')
      expect(statusUpdates[1].key).toBe('todo')
      expect(statusUpdates[2].text).toBe('') // clear event
    })
  })

  // ── context.update：onContextUpdate callback from agent_end（自 statusline-event-adapter.test.ts 并入）──

  describe('context.update: onContextUpdate from agent_end', () => {
    it('calls onContextUpdate when agent_end has usage with inputTokens > 0', async () => {
      const onContextUpdate = vi.fn()
      const { adapter, sent } = createAdapter({ onContextUpdate })
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener(piEvent({
        type: 'agent_end',
        messages: [{
          role: 'assistant',
          stopReason: 'end_turn',
          usage: { input: 5000, output: 3000, totalTokens: 8000 },
        }] as [{ role: string; stopReason: string; usage: { input: number; output: number; totalTokens: number } }],
      }))

      // handleEvent is async (void), wait for microtask to flush
      await vi.waitFor(() => {
        expect(sent).toHaveLength(1)
      })
      expect(sent[0].type).toBe('message.complete')

      // callback is called
      // [HISTORICAL] context 占用字段 inputTokens 现取 totalTokens（input+output+cacheRead+cacheWrite），
      // 与 pi calculateContextTokens 同源（commit 31caf7b5）。usage.input 只是单 turn 增量，值很小。
      expect(onContextUpdate).toHaveBeenCalledTimes(1)
      expect(onContextUpdate).toHaveBeenCalledWith('test-session-id', {
        inputTokens: 8000,
        totalTokens: 8000,
      })
    })

    it('does NOT call onContextUpdate when inputTokens is 0', async () => {
      const onContextUpdate = vi.fn()
      const { adapter } = createAdapter({ onContextUpdate })
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener(piEvent({
        type: 'agent_end',
        messages: [{
          role: 'assistant',
          stopReason: 'end_turn',
          usage: { input: 0, output: 0, totalTokens: 0 },
        }],
      }))

      await vi.waitFor(() => {
        expect(onContextUpdate).not.toHaveBeenCalled()
      })
    })

    it('does NOT call onContextUpdate when usage is missing', async () => {
      const onContextUpdate = vi.fn()
      const { adapter } = createAdapter({ onContextUpdate })
      const client = { onEvent: vi.fn() }
      adapter.attach(client)

      const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void

      listener(piEvent({
        type: 'agent_end',
        messages: [{
          role: 'assistant',
          stopReason: 'end_turn',
        }],
      }))

      await vi.waitFor(() => {
        expect(onContextUpdate).not.toHaveBeenCalled()
      })
    })
  })
})

/** 构造 pi 事件（wire 局部形态，type + 自定义字段）。 */
function piEvent(fields: Record<string, unknown> & { type: string }): Record<string, unknown> {
  return fields
}
