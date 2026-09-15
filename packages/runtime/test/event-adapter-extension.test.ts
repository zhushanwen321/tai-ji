import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventAdapter, type WsSender, type EventAdapterOptions } from './helpers/event-adapter-test-fixture.js'
import type { EventAdapter } from '../src/infra/pi/event-adapter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiMessage } from '../src/infra/pi/rpc-client.js'

/**
 * Task 2 tests: EventAdapter extension event translation.
 *
 * Verifies that:
 * 1. extension_ui_request with confirm/select/input/notify → extension.ui_request ServerMessage
 * 2. extension_ui_request with setStatus/setWidget → null (discarded)
 * 3. extension_error → extension.error ServerMessage
 * 4. tool_execution_update → message.tool_call_update ServerMessage
 * 5. Original mapping of confirm/select to a tool-call-pending message is REMOVED
 *    (asserted positively: confirm/select produce ONLY extension.ui_request, no other types)
 * 6. All ServerMessages include sessionId
 */

/** Pi extension events carry extra fields not in PiMessage, so we widen for tests */
type PiTestEvent = PiMessage & Record<string, unknown>

/** Helper to create event objects that satisfy PiMessage + extra pi fields */
function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}

function createAdapter(): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send)
  return { adapter, sent }
}

/** Wait for async handleEvent to flush */
const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

describe('EventAdapter: extension event translation', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter()
    adapter = result.adapter
    sent = result.sent
  })

  // ── extension_ui_request → extension.ui_request ──────────────

  describe('extension_ui_request (interactive methods)', () => {
    it('translates confirm method to extension.ui_request', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'confirm',
            id: 'req-1',
            title: 'Allow file access?',
            message: 'Extension wants to read /tmp/test.txt',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.ui_request')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-1',
        method: 'confirm',
        title: 'Allow file access?',
        message: 'Extension wants to read /tmp/test.txt',
      })
    })

    it('translates select method to extension.ui_request', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'select',
            id: 'req-2',
            title: 'Pick an option',
            // pi select 严格传 string[]（types.ts select 签名 + rpc-mode.js 原样透传）
            options: ['A', 'B'],
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.ui_request')
      const payload = sent[0].payload as Record<string, unknown>
      expect(payload.method).toBe('select')
      // options 透传 string[]（.map(String)，不再 .map(o=>o.label) 拍扁）
      expect(payload.options).toEqual(['A', 'B'])
    })

    it('translates input method to extension.ui_request', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'input',
            id: 'req-3',
            title: 'Enter a value',
            default: 'placeholder text',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.ui_request')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        requestId: 'req-3',
        method: 'input',
        title: 'Enter a value',
        default: 'placeholder text',
      })
    })

    it('translates notify method to extension:notify (fire-and-forget, no ui_request)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'notify',
            id: 'req-4',
            message: 'Operation completed',
            notifyType: 'warning',
          }))
          return () => {}
        },
      })
      await flushAsync()

      // notify 是 fire-and-forget（pi 不等回复），走独立 extension:notify WS 帧
      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:notify')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        message: 'Operation completed',
        level: 'warn',
      })
    })

    it('produces ONLY extension.ui_request for confirm (no tool-call-pending mapping)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'confirm',
            id: 'req-5',
            title: 'Allow?',
          }))
          return () => {}
        },
      })
      await flushAsync()

      // 正向断言：confirm 只产出 extension.ui_request，不调染 tool-call 状态（旧 pending 映射已移除）
      expect(sent.map((m) => m.type)).toEqual(['extension.ui_request'])
    })

    it('produces ONLY extension.ui_request for select (no tool-call-pending mapping)', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'select',
            id: 'req-6',
            options: [{ label: 'X', value: 'x' }],
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent.map((m) => m.type)).toEqual(['extension.ui_request'])
    })
  })

  // ── extension_ui_request (bridge methods) ─────────────────────

  describe('extension_ui_request (bridge methods)', () => {
    it('bridges setStatus to extension.status WS event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'setStatus',
            id: 'req-d1',
            statusKey: 'status-key',
            statusText: 'some status',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:status')
      const statusPayload = sent[0].payload as { statusKey: string; text: string }
      expect(statusPayload.statusKey).toBe('status-key')
      expect(statusPayload.text).toBe('some status')
    })

    it('bridges setWidget to extension.widget WS event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_ui_request',
            method: 'setWidget',
            id: 'req-d2',
            widgetKey: 'widget-key',
            widgetLines: ['line1', 'line2'],
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension:widget')
      const widgetPayload = sent[0].payload as { widgetKey: string; lines: string[] }
      expect(widgetPayload.widgetKey).toBe('widget-key')
      expect(widgetPayload.lines).toEqual(['line1', 'line2'])
    })
  })

  // ── extension_error → extension.error ─────────────────────────

  describe('extension_error', () => {
    it('translates extension_error to extension.error', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_error',
            extensionPath: 'my-extension',
            error: 'Extension crashed unexpectedly',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('extension.error')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-1',
        extensionName: 'my-extension',
        error: 'Extension crashed unexpectedly',
      })
    })

    it('handles extension_error without sessionId in raw event', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'extension_error',
            extensionPath: 'ext-2',
            error: 'some error',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        extensionName: 'ext-2',
      })
    })
  })

  // ── tool_execution_update → message.tool_call_update ──────────

  describe('tool_execution_update', () => {
    it('translates tool_execution_update to message.tool_call_update', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_update',
            toolCallId: 'tc-1',
            toolName: 'read_file',
            partialResult: 'partial content here',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toEqual({
        sessionId: 'test-session-1',
        toolCallId: 'tc-1',
        detail: 'partial content here',
      })
    })

    it('handles tool_execution_update without partialResult', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_update',
            toolCallId: 'tc-2',
            toolName: 'search',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_update')
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        toolCallId: 'tc-2',
      })
    })
  })

  // ── SessionId injection ────────────────────────────────────────

  describe('sessionId injection', () => {
    it('injects constructor sessionId into all extension messages', async () => {
      const localSent: ServerMessage[] = []
      const localSend: WsSender = (msg) => { localSent.push(msg) }
      const localAdapter = createEventAdapter('custom-session-42', localSend)

      localAdapter.attach({
        onEvent: (listener) => {
          listener(piEvent({ type: 'extension_error', extensionPath: 'e', error: 'err' }))
          listener(piEvent({ type: 'extension_ui_request', method: 'confirm', id: 'r1' }))
          listener(piEvent({ type: 'tool_execution_update', toolCallId: 'tc1', toolName: 't' }))
          return () => {}
        },
      })
      await flushAsync()

      for (const msg of localSent) {
        expect((msg.payload as Record<string, unknown>).sessionId).toBe('custom-session-42')
      }
    })
  })

  // ── Non-extension events unchanged ─────────────────────────────

  describe('non-extension events (regression)', () => {
    it('still translates tool_execution_start correctly', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'tool_execution_start',
            toolCallId: 'tc-reg',
            toolName: 'write_file',
            args: { path: '/tmp/x' },
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.tool_call_start')
      // [w21] payload 换 toolCall entry 形态（event-adapter 翻译时重构）
      expect(sent[0].payload).toMatchObject({
        sessionId: 'test-session-1',
        entry: {
          type: 'toolCall',
          toolCallId: 'tc-reg',
          toolName: 'write_file',
        },
      })
    })

    it('still translates status events correctly', async () => {
      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({
            type: 'status',
            status: 'thinking',
            detail: 'processing',
          }))
          return () => {}
        },
      })
      await flushAsync()

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('message.status')
    })
  })
})
