/**
 * [retry-sound] agent_end → message.complete 的 willRetry 透传回归锁。
 *
 * 背景：pi 每个 LLM attempt 失败都结束当次 agent loop 并发 agent_end（重试经
 * agent.continue() 续跑），且 agent_end 恒带 willRetry（pi-protocol.ts PiAgentEndEvent，
 * W6 A-10 探针验证）。此前 handleAgentEnd 丢弃该字段 → 前端把「中间失败」当终态，
 * 完成提示音误响（重试成功双响 / 多次重试连响）。本锁保证 payload.willRetry 不再丢失：
 * - willRetry=true（pi 将自动重试）→ 前端静音中间失败（useCompletionNotify 门控）；
 * - willRetry=false（终态：成功/重试用尽/不可重试错误）→ 前端正常发声；
 * - 空 messages 降级路径 → willRetry=false（拿不到 pi 字段，按不重试终态处理）。
 *
 * translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出（同
 * event-adapter-trace-trigger.test.ts 范式）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-retry-sound.test.ts
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../event-adapter.js'
import type { PiAgentEndEvent } from '../pi-protocol.js'

const SID = 's-retry-sound'

/**
 * 构造 agent_end 事件：lastMsg 取 messages 末位（与 handleAgentEnd 取法一致）。
 * errorMessage 是 pi 运行时扩展字段（超出 PiAgentEndMessage 声明，event-adapter 经
 * AgentEndRuntimeExtras as 提取）——测试构造同样以扩展形态传入。
 */
function agentEndEvent(
  willRetry: boolean,
  lastMsg: PiAgentEndEvent['messages'][number] & { errorMessage?: string },
): PiAgentEndEvent {
  return { type: 'agent_end', messages: [lastMsg], willRetry } as PiAgentEndEvent
}

/** 从 translate 产物中取 turn-end 的 message.complete 帧。 */
function completeOf(translated: ReturnType<typeof translate>): { payload: Record<string, unknown> } {
  const turnEnd = translated.find((e) => e.kind === 'turn-end')
  expect(turnEnd).toBeDefined()
  const message = (turnEnd as { message: { type: string; payload: Record<string, unknown> } }).message
  expect(message.type).toBe('message.complete')
  return message
}

describe('[retry-sound] agent_end willRetry 透传 message.complete payload', () => {
  it('中间失败：willRetry=true + stopReason=error → payload.willRetry=true 透传', () => {
    const message = completeOf(
      translate(
        agentEndEvent(true, {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          errorMessage: 'Provider 500',
        }),
        SID,
      ),
    )
    expect(message.payload.stopReason).toBe('error')
    expect(message.payload.willRetry).toBe(true)
    expect(message.payload.errorMessage).toBe('Provider 500')
  })

  it('重试用尽终态：willRetry=false + stopReason=error → payload.willRetry=false', () => {
    const message = completeOf(
      translate(
        agentEndEvent(false, {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          errorMessage: 'Provider 500',
        }),
        SID,
      ),
    )
    expect(message.payload.stopReason).toBe('error')
    expect(message.payload.willRetry).toBe(false)
  })

  it('成功终态：willRetry=false + stopReason=stop → payload.willRetry=false', () => {
    const message = completeOf(
      translate(
        agentEndEvent(false, {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        }),
        SID,
      ),
    )
    expect(message.payload.stopReason).toBe('end_turn')
    expect(message.payload.willRetry).toBe(false)
  })

  it('空 messages 降级路径 → payload.willRetry=false（按不重试终态处理）', () => {
    const message = completeOf(
      translate({ type: 'agent_end', messages: [], willRetry: false } as unknown as PiAgentEndEvent, SID),
    )
    expect(message.payload.stopReason).toBe('error')
    expect(message.payload.willRetry).toBe(false)
  })
})
