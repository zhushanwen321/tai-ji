/**
 * EventAdapter: toolResult message_start 语义修正测试。
 *
 * 根因：pi agent-core 每个工具执行完会 emit message_start{message:{role:'toolResult'}} +
 * message_end{message:{role:'toolResult'}}（agent-loop.js emitToolResultMessage）。
 * event-adapter 的 handleMessageStart 兜底分支把 toolResult 当 assistant turn 翻译，
 * 产出无意义的 message.message_start（前端建空 assistant message），
 * 干扰 findLastAssistantIndex 导致后续 tool_call_end 匹配错位。
 *
 * 修正：role==='toolResult' 不转发（return null）——前端已通过 tool_execution_end
 * 拿到 output，toolResult message_start 是 pi 内部记账，对前端是噪声。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/event-adapter-toolresult.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventAdapter, type WsSender } from './helpers/event-adapter-test-fixture.js'
import type { EventAdapter } from '../src/infra/pi/event-adapter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiMessage } from '../src/infra/pi/rpc-client.js'

type PiTestEvent = PiMessage & Record<string, unknown>

function createAdapter(): { adapter: EventAdapter; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const send: WsSender = (msg) => { sent.push(msg) }
  const adapter = createEventAdapter('test-session-1', send)
  return { adapter, sent }
}

const flushAsync = () => new Promise<void>(r => setTimeout(r, 0))

function dispatchOne(adapter: EventAdapter, event: PiTestEvent): void {
  adapter.attach({
    onEvent: (listener) => {
      listener(event)
      return () => {}
    },
  })
}

describe('EventAdapter: toolResult message_start 语义修正', () => {
  let adapter: EventAdapter
  let sent: ServerMessage[]

  beforeEach(() => {
    const result = createAdapter()
    adapter = result.adapter
    sent = result.sent
  })

  it('U1: role=toolResult 的 message_start 不转发到前端', async () => {
    dispatchOne(adapter, {
      type: 'message_start',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: '文件内容' }],
        isError: false,
        timestamp: Date.now(),
      },
    })
    await flushAsync()

    // toolResult 是 pi 内部记账（agent-loop emitToolResultMessage），
    // 前端已通过 tool_execution_end 拿到 output，不应再建空 assistant message
    expect(sent).toHaveLength(0)
  })

  it('U2: 无 role 的 assistant turn message_start 仍正常产出（回归保护）', async () => {
    dispatchOne(adapter, {
      type: 'message_start',
      message: undefined,
    })
    await flushAsync()

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('message.message_start')
    expect(sent[0].payload).toHaveProperty('messageId')
  })

  it('U4: tool_execution_end → message_start(toolResult) → message_start(assistant) 序列', async () => {
    // 模拟 agent-loop.js:261-266 的真实事件序列：
    // tool_execution_end（带 output）→ message_start(toolResult) → message_start(assistant turn)
    dispatchOne(adapter, {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false,
    })
    dispatchOne(adapter, {
      type: 'message_start',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      },
    })
    dispatchOne(adapter, {
      type: 'message_start',
      message: undefined, // 下一个 assistant turn
    })
    await flushAsync()

    // tool_execution_end 产出 message.tool_call_end（带 output，前端据此更新 toolCall）
    // toolResult message_start 不产出（噪声过滤）
    // assistant turn message_start 产出 message.message_start
    expect(sent).toHaveLength(2)
    expect(sent[0].type).toBe('message.tool_call_end')
    // [w21] payload 换 toolResult message entry 形态（isError:false ≡ status:'completed'）
    expect(sent[0].payload).toMatchObject({ entry: { type: 'message', message: { toolCallId: 'tc-1', isError: false } } })
    expect(sent[1].type).toBe('message.message_start')
  })
})
