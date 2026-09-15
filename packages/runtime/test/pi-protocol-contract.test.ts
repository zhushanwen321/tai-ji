/**
 * pi-protocol contract tests.
 *
 * W1 (U1/U2/U3): pi-protocol.ts deepened into a real contract.
 *  - U1: PiEvent union includes all 10 newly-added event types
 *        (compaction_start/end, auto_retry_start/end, thinking_level_changed,
 *         queue_update, entry_appended, session_info_changed, agent_settled,
 *         extension_error)
 *  - U2: PiToolExecutionResult mirrors pi AgentToolResult
 *        (content with image blocks + details + addedToolNames + terminate)
 *  - U3: PiTurnEndEvent carries message + toolResults
 *
 * W2 (U4/U5/U6): event-adapter.ts consumes pi-protocol narrow types.
 *  - U4: event-adapter.ts imports PiEvent from pi-protocol.js (no local shadow)
 *  - U5: event-adapter.ts has no defensive double-read fallbacks
 *        (no `?? event.output` / `?? event.input` / `?? event.payload`)
 *  - U6: 3 representative handler params are narrow Pi*Event interfaces
 *
 * Method: assignment compile checks (assigning a literal to a typed variable
 * proves membership in the union / shape conformance) + `@ts-expect-error`
 * negative cases + runtime shape assertions on the same fixtures.
 * W2 structural assertions read event-adapter.ts source text (grep/regex).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type {
  PiEvent,
  PiToolExecutionResult,
  PiTurnEndEvent,
  PiCompactionStartEvent,
  PiCompactionEndEvent,
  PiAutoRetryStartEvent,
  PiAutoRetryEndEvent,
  PiThinkingLevelChangedEvent,
  PiQueueUpdateEvent,
  PiEntryAppendedEvent,
  PiSessionInfoChangedEvent,
  PiAgentSettledEvent,
  PiExtensionErrorEvent,
  PiUsage,
  PiAgentEndEvent,
  PiToolExecutionUpdateEvent,
  PiToolExecutionEndEvent,
} from '../src/infra/pi/pi-protocol.js'

// ════════════════════════════════════════════════════════════════════════
// U1: PiEvent union covers all 10 new event types
// ════════════════════════════════════════════════════════════════════════

describe('U1: PiEvent union — 10 new event types present', () => {
  it('compaction_start is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'compaction_start', reason: 'manual' }
    expect(e.type).toBe('compaction_start')
  })

  it('compaction_end is assignable to PiEvent (full shape)', () => {
    const e: PiEvent = {
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      willRetry: true,
      errorMessage: 'oom',
    }
    expect(e.type).toBe('compaction_end')
  })

  it('auto_retry_start is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: 'timeout',
    }
    expect(e.type).toBe('auto_retry_start')
  })

  it('auto_retry_end is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'auto_retry_end', success: true, attempt: 2 }
    expect(e.type).toBe('auto_retry_end')
  })

  it('thinking_level_changed is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'thinking_level_changed', level: 'high' }
    expect(e.type).toBe('thinking_level_changed')
  })

  it('queue_update is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'queue_update',
      steering: ['s1'],
      followUp: ['f1'],
    }
    expect(e.type).toBe('queue_update')
  })

  it('entry_appended is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'entry_appended',
      entry: { id: 'e1', role: 'user' },
    }
    expect(e.type).toBe('entry_appended')
  })

  it('session_info_changed is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'session_info_changed', name: 'renamed' }
    expect(e.type).toBe('session_info_changed')
  })

  it('agent_settled is assignable to PiEvent', () => {
    const e: PiEvent = { type: 'agent_settled' }
    expect(e.type).toBe('agent_settled')
  })

  it('extension_error is assignable to PiEvent', () => {
    const e: PiEvent = {
      type: 'extension_error',
      extensionPath: 'a/b.ts',
      event: 'tool_execution',
      error: 'boom',
    }
    expect(e.type).toBe('extension_error')
  })

  // Negative case: a non-existent type must NOT be assignable.
  it('rejects unknown event types at compile time', () => {
    // @ts-expect-error — 'not_a_real_type' is not a member of the PiEvent union
    const _e: PiEvent = { type: 'not_a_real_type' }
    expect(_e).toBeDefined()
  })
})

// Independent existence of the exported interfaces (so importing the names
// is valid even when used outside the union).
describe('U1: event interfaces are independently exported', () => {
  it('PiCompactionStartEvent accepts manual|threshold|overflow', () => {
    const e: PiCompactionStartEvent = { type: 'compaction_start', reason: 'overflow' }
    expect(e.reason).toBe('overflow')
  })

  it('PiCompactionEndEvent carries aborted/willRetry/errorMessage', () => {
    const e: PiCompactionEndEvent = {
      type: 'compaction_end',
      reason: 'manual',
      aborted: true,
      willRetry: false,
    }
    expect(e.aborted).toBe(true)
  })

  it('PiAutoRetryStartEvent / PiAutoRetryEndEvent shapes', () => {
    const s: PiAutoRetryStartEvent = {
      type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: 'e',
    }
    const en: PiAutoRetryEndEvent = { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'x' }
    expect(s.attempt).toBe(1)
    expect(en.success).toBe(false)
  })

  it('PiThinkingLevelChangedEvent', () => {
    const e: PiThinkingLevelChangedEvent = { type: 'thinking_level_changed', level: 'xhigh' }
    expect(e.level).toBe('xhigh')
  })

  it('PiQueueUpdateEvent', () => {
    const e: PiQueueUpdateEvent = { type: 'queue_update', steering: [], followUp: [] }
    expect(e.steering).toHaveLength(0)
  })

  it('PiEntryAppendedEvent', () => {
    const e: PiEntryAppendedEvent = { type: 'entry_appended', entry: { a: 1 } }
    expect(e.entry).toEqual({ a: 1 })
  })

  it('PiSessionInfoChangedEvent accepts undefined name', () => {
    const e: PiSessionInfoChangedEvent = { type: 'session_info_changed', name: undefined }
    expect(e.name).toBeUndefined()
  })

  it('PiAgentSettledEvent', () => {
    const e: PiAgentSettledEvent = { type: 'agent_settled' }
    expect(e.type).toBe('agent_settled')
  })

  it('PiExtensionErrorEvent', () => {
    const e: PiExtensionErrorEvent = {
      type: 'extension_error', extensionPath: 'p', event: 'ev', error: 'err',
    }
    expect(e.extensionPath).toBe('p')
  })
})

// ════════════════════════════════════════════════════════════════════════
// U2: PiToolExecutionResult mirrors pi AgentToolResult
// ════════════════════════════════════════════════════════════════════════

describe('U2: PiToolExecutionResult — mirrors pi AgentToolResult', () => {
  it('accepts content with text + image blocks, plus details/addedToolNames/terminate', () => {
    const r: PiToolExecutionResult = {
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'base64==', mimeType: 'image/png' },
      ],
      details: { truncated: true },
      addedToolNames: ['newTool'],
      terminate: true,
    }
    expect(r.content).toHaveLength(2)
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(r.details).toEqual({ truncated: true })
    expect(r.addedToolNames).toEqual(['newTool'])
    expect(r.terminate).toBe(true)
  })

  it('details is required (unknown), addedToolNames/terminate optional', () => {
    const r: PiToolExecutionResult = {
      content: [{ type: 'text', text: 'plain' }],
      details: null,
    }
    expect(r.details).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════
// U3: PiTurnEndEvent carries message + toolResults
// ════════════════════════════════════════════════════════════════════════

describe('U3: PiTurnEndEvent — message + toolResults', () => {
  it('accepts message (role/content/usage/stopReason) + toolResults array', () => {
    const e: PiTurnEndEvent = {
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: 'done',
        usage: { input: 10, output: 5, totalTokens: 15 },
        stopReason: 'end_turn',
      },
      toolResults: [
        {
          role: 'toolResult',
          toolCallId: 'tc1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'out' }],
          isError: false,
        },
      ],
    }
    expect(e.message.stopReason).toBe('end_turn')
    expect(e.toolResults).toHaveLength(1)
    expect(e.toolResults[0].toolName).toBe('bash')
  })

  it('toolResults may be empty', () => {
    const e: PiTurnEndEvent = {
      type: 'turn_end',
      message: { role: 'assistant', content: 'no tools' },
      toolResults: [],
    }
    expect(e.toolResults).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════
// W2 (U4/U5/U6): event-adapter.ts consumes pi-protocol narrow types.
// Structural assertions read event-adapter.ts source text.
// ════════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVENT_ADAPTER_SRC = readFileSync(
  resolve(__dirname, '../src/infra/pi/event-adapter.ts'),
  'utf8',
)

describe('U4: event-adapter.ts imports PiEvent from pi-protocol (no local shadow)', () => {
  it('imports PiEvent as a type from ./pi-protocol.js', () => {
    // Must have `import type { ... PiEvent ... } from './pi-protocol.js'`
    expect(EVENT_ADAPTER_SRC).toMatch(/import\s+type\s+\{[^}]*\bPiEvent\b[^}]*\}\s+from\s+['"]\.\/pi-protocol\.js['"]/)
  })

  it('has no local `type PiEvent = Record<...>` shadow definition', () => {
    // The old shadow was: `type PiEvent = Record<string, unknown>`
    expect(EVENT_ADAPTER_SRC).not.toMatch(/^\s*type\s+PiEvent\s*=\s*Record</m)
  })
})

describe('U5: event-adapter.ts has no defensive double-read fallbacks', () => {
  it('has no `?? event.output` (result??output defense)', () => {
    expect(EVENT_ADAPTER_SRC).not.toContain('?? event.output')
  })

  it('has no `?? event.input` (args??input defense)', () => {
    expect(EVENT_ADAPTER_SRC).not.toContain('?? event.input')
  })

  it('has no `?? event.payload` (message??payload defense)', () => {
    expect(EVENT_ADAPTER_SRC).not.toContain('?? event.payload')
  })
})

describe('U6: 3 representative handlers use narrow Pi*Event param types', () => {
  // These three handlers previously took the wide `PiEvent` (= Record) shadow.
  // After W2 they must take the specific narrow interfaces from pi-protocol.

  it('handleToolExecutionEnd takes PiToolExecutionEndEvent', () => {
    expect(EVENT_ADAPTER_SRC).toMatch(/function\s+handleToolExecutionEnd\s*\(\s*event:\s*PiToolExecutionEndEvent\b/)
  })

  it('handleTurnEndPi takes PiTurnEndEvent', () => {
    expect(EVENT_ADAPTER_SRC).toMatch(/function\s+handleTurnEndPi\s*\(\s*event:\s*PiTurnEndEvent\b/)
  })

  it('handleToolExecutionStart takes PiToolExecutionStartEvent', () => {
    expect(EVENT_ADAPTER_SRC).toMatch(/function\s+handleToolExecutionStart\s*\(\s*event:\s*PiToolExecutionStartEvent\b/)
  })
})

// ════════════════════════════════════════════════════════════════════════
// W2 contract deepening — 4 should_fix field alignments (mirror pi source)
// ════════════════════════════════════════════════════════════════════════
//
// pi-protocol.ts claims to be pi's real contract (ADR-0037), but 4 fields
// drifted from pi's canonical names/shapes. These tests pin the alignment:
//   C1: PiUsage mirrors pi Usage field names (input/output/cacheRead/cacheWrite/totalTokens)
//   C2: PiAgentEndEvent carries willRetry: boolean (pi AgentSessionEvent.agent_end)
//   C3: PiToolExecutionUpdateEvent.partialResult is unknown (pi sends `any`)
//   C4: PiToolExecutionEndEvent has NO args field (pi never sends args on end)

describe('C1: PiUsage mirrors pi Usage field names (input/output/cacheRead/cacheWrite)', () => {
  it('accepts pi canonical field names { input, output, totalTokens, cacheRead, cacheWrite }', () => {
    const u: PiUsage = {
      input: 100,
      output: 50,
      totalTokens: 150,
      cacheRead: 10,
      cacheWrite: 5,
    }
    expect(u.input).toBe(100)
    expect(u.cacheRead).toBe(10)
  })

  it('rejects taiji field name inputTokens (translation belongs in event-adapter, not the contract)', () => {
    // @ts-expect-error — PiUsage mirrors pi: field is `input`, NOT `inputTokens`
    const _u: PiUsage = { inputTokens: 100 }
    expect(_u).toBeDefined()
  })

  it('rejects taiji field name outputTokens', () => {
    // @ts-expect-error — PiUsage mirrors pi: field is `output`, NOT `outputTokens`
    const _u: PiUsage = { outputTokens: 50 }
    expect(_u).toBeDefined()
  })
})

describe('C2: PiAgentEndEvent carries willRetry (pi AgentSessionEvent.agent_end)', () => {
  it('accepts { type, messages, willRetry }', () => {
    const e: PiAgentEndEvent = {
      type: 'agent_end',
      messages: [],
      willRetry: false,
    }
    expect(e.willRetry).toBe(false)
  })

  it('willRetry is required (omitting it must fail to compile)', () => {
    // @ts-expect-error — pi always sends willRetry; it is a required field
    const _e: PiAgentEndEvent = { type: 'agent_end', messages: [] }
    expect(_e).toBeDefined()
  })
})

describe('C3: PiToolExecutionUpdateEvent.partialResult is unknown (pi sends any)', () => {
  it('accepts a string partialResult', () => {
    const e: PiToolExecutionUpdateEvent = {
      type: 'tool_execution_update',
      toolCallId: 'x',
      toolName: 'y',
      partialResult: 'working...',
    }
    expect(e.partialResult).toBe('working...')
  })

  it('accepts an object partialResult (pi may send AgentToolResult-shaped objects)', () => {
    const e: PiToolExecutionUpdateEvent = {
      type: 'tool_execution_update',
      toolCallId: 'x',
      toolName: 'y',
      partialResult: { details: { progress: 50 }, content: 'half' },
    }
    expect(e.partialResult).toEqual({ details: { progress: 50 }, content: 'half' })
  })
})

describe('C4: PiToolExecutionEndEvent has NO args field (pi never sends args on end)', () => {
  it('accepts the canonical shape without args', () => {
    const e: PiToolExecutionEndEvent = {
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
      isError: false,
    }
    expect(e.toolCallId).toBe('tc1')
  })

  it('rejects args field (pi types.ts:430 defines tool_execution_end WITHOUT args)', () => {
    // args is a ghost field; pi only sends args on tool_execution_start.
    // Assigning to a PiToolExecutionEndEvent-typed variable must fail type-check.
    // @ts-expect-error — 'args' does not exist on PiToolExecutionEndEvent
    const _e: PiToolExecutionEndEvent = { type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'write', result: { content: [], details: {} }, isError: false, args: { path: '/x' } }
    expect(_e).toBeDefined()
  })
})
