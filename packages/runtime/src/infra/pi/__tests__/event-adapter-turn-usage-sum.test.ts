/**
 * [turn-badge-tokens → chat-flow-consistency D3 规则 5] agent_end 翻译的 usage 语义回归锁。
 *
 * [HISTORICAL] payload.usage（message.complete 回合级累计，sumTurnUsage 发端）已随
 * chat-flow-consistency D3 规则 5 退役：usage/endedAt 由 message_end(assistant) 逐条载荷
 * 唯一承担（core apply-entry-convert usageField 消费，live ≡ reload 同一转换函数）——
 * message.complete 回合级覆写与发端 payload.usage 死链同批删除（core 消费端 readUsage 与
 * 本发端在终态同步 F1-21/F1-26 清理），本文件不再断言 payload.usage。
 *
 * 现存断言：turn-end 顶层 inputTokens/totalTokens（context 占用）= 末次调用 totalTokens
 * （calculateContextTokens 同源语义，不随多调用累计变化）。
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

function agentEnd(messages: unknown[], willRetry = false): PiAgentEndEvent {
  return { type: 'agent_end', messages, willRetry } as unknown as PiAgentEndEvent
}

describe('[turn-badge-tokens] agent_end turn-end context 占用（payload.usage 发端已退役）', () => {
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

  it('message.complete payload 不再携带 usage（D3 规则 5 逐条载荷唯一承担）', () => {
    const payload = translate(
      agentEnd([assistantMsg({ input: 400, output: 500, totalTokens: 900 })]),
      SID,
    ).find((e) => e.kind === 'turn-end') as { message?: { payload?: Record<string, unknown> } }
    expect(payload.message?.payload?.usage).toBeUndefined()
  })
})
