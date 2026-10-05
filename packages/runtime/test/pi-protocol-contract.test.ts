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

// ════════════════════════════════════════════════════════════════════════
// C5: pi 1.0.0 codemode tool_execution_end shape (codemode 设计 D4① 契约样本)
// ════════════════════════════════════════════════════════════════════════
//
// 样本来源：真机实测（taiji dev 实例 + pi 1.0.0 二进制 --mode rpc，真实 LLM 触发
// codemode 脚本并行 tools.read；RPC tool_execution_end 事件原样采集，仅替换标识符
// 与正文为脱敏占位）。信封与 C4 通用样本同构（type/toolCallId/toolName/result/
// isError），codemode 特有形状在 result 内：
//   - content 首块恒为 text：[0] 沙箱执行元信息（Script completed / Wall time）；
//     其后为脚本产物 items——本样本（并行 read 场景）恰一块脚本返回值序列化 text。
//     非恒定形状（pi execute.js content 拼装 = [header, ...items]）：image 产出场景
//     image 块追加在 text 块后（设计 §2 链路 C「text 块在前、image 块追加在后」；
//     S3 真机已验 image 块出现于 content 数组），无返回值脚本则无返回值 text 块
//   - details.calls：嵌套调用清单（D6 后置的树形展示数据源，本期无渲染消费点），
//     每项 { id: "<toolCallId>/<序号>", name, args: JSON 字符串, status, durationMs }
// 嵌套子调用自身的事件带 parentToolCallId 且不落 transcript（D4 过滤判据的
// 协议依据），不会以独立 tool_execution_end 形态出现在该契约面上。

describe('C5: pi 1.0.0 codemode tool_execution_end shape (real-device sample)', () => {
  const CODEMODE_END_SAMPLE: PiToolExecutionEndEvent = {
    type: 'tool_execution_end',
    toolCallId: 'call_codemode_sample_0001',
    toolName: 'codemode',
    result: {
      content: [
        { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'text', text: '[{"file":"a.txt","lines":5},{"file":"a1.log","lines":7}]' },
      ],
      details: {
        calls: [
          {
            id: 'call_codemode_sample_0001/1',
            name: 'read',
            args: '{"path":"a.txt","offset":null,"limit":null}',
            status: 'ok',
            durationMs: 14.27,
          },
          {
            id: 'call_codemode_sample_0001/2',
            name: 'read',
            args: '{"path":"a1.log","offset":null,"limit":null}',
            status: 'ok',
            durationMs: 4.7,
          },
        ],
      },
    },
    isError: false,
  }

  it('envelope is assignable to PiToolExecutionEndEvent (same fields as C4 canonical)', () => {
    const e: PiToolExecutionEndEvent = CODEMODE_END_SAMPLE
    expect(e.type).toBe('tool_execution_end')
    expect(e.toolName).toBe('codemode')
    expect(e.isError).toBe(false)
  })

  it('result.content is two text blocks (sandbox meta + serialized return value)', () => {
    const content = CODEMODE_END_SAMPLE.result.content
    expect(content).toHaveLength(2)
    expect(content.every((c) => c.type === 'text')).toBe(true)
    expect((content[0] as { type: 'text'; text: string }).text).toMatch(/^Script completed/)
  })

  it('result.details.calls pins the nested-call list shape (D6 deferred data source)', () => {
    const details = CODEMODE_END_SAMPLE.result.details as {
      calls: { id: string; name: string; args: string; status: string; durationMs: number }[]
    }
    expect(details.calls).toHaveLength(2)
    for (const call of details.calls) {
      expect(call.id).toMatch(/^call_codemode_sample_0001\/\d+$/)
      expect(typeof call.name).toBe('string')
      expect(typeof call.args).toBe('string') // JSON-serialized arguments, not an object
      expect(call.status).toBe('ok')
      expect(typeof call.durationMs).toBe('number')
    }
    expect(() => JSON.parse(details.calls[0].args)).not.toThrow()
  })
})
