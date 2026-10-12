/**
 * [turn-badge-tokens] agent_end → message.complete payload.usage 的 turn 级累计回归锁。
 *
 * 根因：live 徽标经
 * message.complete payload.usage 回填末位 assistant（core terminalMessagePatch），此前取
 * pi agent_end lastMsg.usage = 末次调用量；重放径（session JSONL → reducer usageField 逐条
 * 写 Message.usage → turn-aggregates Σ outputTokens）逐调用求和——多 LLM 调用 turn 的
 * live 徽标恒小于重放值（结构性输入缺失）。修复 = handleAgentEnd 对 agent_end.messages
 * 中 role='assistant' 的 usage 逐条求和（pi bundle runLoop newMessages 累积实装，每条
 * assistant 消息各带自身 usage）。
 *
 * 本锁断言：
 * - 多 assistant 调用 turn：payload.usage = Σ 各 assistant usage（toolResult 消息携带的
 *   嵌套 subagent 合并 usage 不计入——与重放径 usageField 仅 assistant role 同口径）；
 * - 单 assistant turn：与旧行为逐字段一致（lastMsg.usage）；
 * - turn-end 顶层 inputTokens/totalTokens（context 占用）不随累计变化，仍 = 末次调用
 *   totalTokens（calculateContextTokens 同源语义）；
 * - usage 全程缺省 → payload.usage 缺省（D4 无值编码，不折 0）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-turn-usage-sum.test.ts
 */
import { describe, it, expect } from 'vitest'
import { translate } from '../event-adapter.js'
import type { PiAgentEndEvent } from '../pi-protocol.js'

const SID = 's-turn-usage-sum'

function assistantMsg(usage: { input: number; output: number; totalTokens: number } | undefined) {
  return { role: 'assistant', content: [], stopReason: 'stop', ...(usage ? { usage } : {}) }
}

function toolResultMsg(usage: { input: number; output: number; totalTokens: number }) {
  return { role: 'toolResult', content: [], toolCallId: 'tc1', usage }
}

function agentEnd(messages: unknown[], willRetry = false): PiAgentEndEvent {
  return { type: 'agent_end', messages, willRetry } as unknown as PiAgentEndEvent
}

function completePayloadOf(translated: ReturnType<typeof translate>): Record<string, unknown> {
  const turnEnd = translated.find((e) => e.kind === 'turn-end')
  expect(turnEnd).toBeDefined()
  const message = (turnEnd as { message: { type: string; payload: Record<string, unknown> } }).message
  expect(message.type).toBe('message.complete')
  return message.payload
}

describe('[turn-badge-tokens] agent_end payload.usage turn 级累计', () => {
  it('多 assistant 调用 turn：payload.usage = Σ 各 assistant usage（toolResult 嵌套量不计入）', () => {
    const payload = completePayloadOf(
      translate(
        agentEnd([
          assistantMsg({ input: 400, output: 500, totalTokens: 900 }),
          toolResultMsg({ input: 9999, output: 8888, totalTokens: 999999 }), // 嵌套 subagent 合并量，禁双算
          assistantMsg({ input: 50, output: 30, totalTokens: 80 }),
        ]),
        SID,
      ),
    )
    expect(payload.usage).toEqual({ inputTokens: 450, outputTokens: 530, totalTokens: 980 })
  })

  it('单 assistant turn：与旧行为一致（= lastMsg.usage 的 taiji 映射）', () => {
    const payload = completePayloadOf(
      translate(agentEnd([assistantMsg({ input: 400, output: 500, totalTokens: 900 })]), SID),
    )
    expect(payload.usage).toEqual({ inputTokens: 400, outputTokens: 500, totalTokens: 900 })
  })

  it('turn-end 顶层 inputTokens/totalTokens（context 占用）仍 = 末次调用 totalTokens，不随累计变化', () => {
    const turnEnd = translate(
      agentEnd([
        assistantMsg({ input: 400, output: 500, totalTokens: 900 }),
        assistantMsg({ input: 50, output: 30, totalTokens: 80 }),
      ]),
      SID,
    ).find((e) => e.kind === 'turn-end') as { inputTokens?: number; totalTokens?: number }
    expect(turnEnd.inputTokens).toBe(80)
    expect(turnEnd.totalTokens).toBe(80)
  })

  it('usage 全程缺省 → payload.usage 缺省（D4 无值编码，不折 0）', () => {
    const payload = completePayloadOf(translate(agentEnd([assistantMsg(undefined)]), SID))
    expect(payload.usage).toBeUndefined()
  })

  it('多 assistant 且部分字段缺省：字段级求和，全程缺省的字段不出现在结果中', () => {
    const payload = completePayloadOf(
      translate(
        agentEnd([
          { role: 'assistant', content: [], usage: { input: 400, output: 500 } }, // 无 totalTokens
          { role: 'assistant', content: [], usage: { output: 30 } }, // 仅 output
        ]) as unknown as PiAgentEndEvent,
        SID,
      ),
    )
    expect(payload.usage).toEqual({ inputTokens: 400, outputTokens: 530 })
  })
})
