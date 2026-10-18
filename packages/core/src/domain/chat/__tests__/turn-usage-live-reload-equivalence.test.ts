/**
 * [turn-badge-tokens] turn 徽标 token 数 live ≡ reload 聚合一致断言。
 *
 * 根因：徽标 generatedTokens
 * = deriveTurnAggregates Σ Message.usage.outputTokens。重放径逐条 assistant entry 带 usage
 * （reducer usageField），求和天然完整；live 径的 usage 唯一写入点是 message.complete 收尾
 * （terminalMessagePatch 回填末位 assistant），此前 payload.usage = 末次调用量 → 多 LLM
 * 调用 turn 的 live 值结构性偏小。修复后 runtime sumTurnUsage 在 event-adapter 对
 * agent_end.messages 全部 assistant 调用求和（runtime 侧断言见 event-adapter-turn-usage-sum
 * 测试），本文件锁两端组合后的聚合一致性：
 *
 * - live 路径：多调用 turn 的 ref 形态（中间 assistant 气泡无 usage——live 唯一 usage 写入点
 *   是末位收尾）+ terminalMessagePatch（payload.usage = turn 累计，即 runtime 产物）；
 * - reload 路径：同 turn 的 session JSONL entries 经 replayEntries（逐条 entry 自带 usage）；
 * - 两路径 deriveTurnAggregates().generatedTokens 全等，且等于全部调用之和（非末次调用量）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/turn-usage-live-reload-equivalence.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { Message, PiMessageEntry } from '@taiji/shared'
import { replayEntries } from '../apply-entry'
import { terminalMessagePatch } from '../mutations'
import { findLastAssistantIndex } from '../chunk-processor'
import { deriveTurnAggregates } from '../turn-aggregates'
import { msgEntry } from './helpers/fixtures'
import type { MessageTurn } from '../message-turns'

const T0 = 1_700_000_000_000
const ISO = (ms: number): string => new Date(ms).toISOString()

// 同一 turn 的两次真实调用用量（call1 = 500、call2 = 30 output tokens）
const CALL1 = { input: 400, output: 500, totalTokens: 900 }
const CALL2 = { input: 50, output: 30, totalTokens: 80 }
const SUM_OUTPUT = CALL1.output + CALL2.output // 530

function makeTurn(user: Message | null, assistants: Message[]): MessageTurn {
  return { index: 0, user, assistants, isStreaming: false, hasFoldable: false }
}

describe('[turn-badge-tokens] 多 assistant 调用 turn：live ≡ reload 聚合一致', () => {
  it('live 路径（terminalMessagePatch 回填 turn 累计到末位）= reload 路径（replayEntries 逐条求和）= 全部调用之和', () => {
    // ── live 路径：ref 形态（registry overlay 产物）——中间气泡无 usage，末位 streaming ──
    const live: Message[] = [
      { id: 'u-live', role: 'user', content: 'q', status: 'complete', timestamp: T0 },
      {
        id: 'a-live-1', role: 'assistant', content: '', status: 'streaming', timestamp: T0 + 100,
        toolCalls: [{ id: 'tc1', toolName: 'edit', input: { path: '/a.ts' }, status: 'completed', startTime: T0 + 200, endTime: T0 + 1500 }],
      },
      { id: 'a-live-2', role: 'assistant', content: 'final', status: 'streaming', timestamp: T0 + 2000 },
    ]
    // runtime sumTurnUsage 产物（event-adapter-turn-usage-sum 测试锁定其正确性）
    const payload = { usage: { inputTokens: CALL1.input + CALL2.input, outputTokens: SUM_OUTPUT } }
    const lastAssistantIdx = findLastAssistantIndex(live)
    const livePatched = live.map((m, i) =>
      m.role === 'assistant' && m.status === 'streaming'
        ? terminalMessagePatch(m, i, {
          lastAssistantIdx,
          isErrorStop: false,
          errorMessage: undefined,
          finalContent: 'final',
          payload,
          endedAt: T0 + 3000,
        })
        : m,
    )
    const liveTurn = makeTurn(livePatched[0]!, livePatched.filter((m) => m.role === 'assistant'))
    const liveAgg = deriveTurnAggregates(liveTurn)

    // ── reload 路径：session JSONL entries（每条 assistant 自带 usage）──
    const entries: PiMessageEntry[] = [
      msgEntry('e-u', { role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: T0 }, { timestamp: ISO(T0) }),
      msgEntry('e-a1', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'edit', arguments: { path: '/a.ts' } }],
        timestamp: T0 + 100,
        usage: CALL1,
      }, { timestamp: ISO(T0 + 100) }),
      msgEntry('e-tr', {
        role: 'toolResult', toolCallId: 'tc1', toolName: 'edit',
        content: [{ type: 'text', text: 'ok' }], timestamp: T0 + 1500,
      }, { timestamp: ISO(T0 + 1500) }),
      msgEntry('e-a2', {
        role: 'assistant', content: [{ type: 'text', text: 'final' }],
        timestamp: T0 + 2000, usage: CALL2,
      }, { timestamp: ISO(T0 + 2000) }),
    ]
    const state = replayEntries(entries)
    const reloadAssistants = state.messages.filter((m) => m.role === 'assistant')
    const reloadUser = state.messages.find((m) => m.role === 'user') ?? null
    const reloadAgg = deriveTurnAggregates(makeTurn(reloadUser, reloadAssistants))

    // 两路径聚合全等 = 全部调用之和（修复前 live 路径只回填末次调用量 → 30 ≠ 530）
    expect(liveAgg.generatedTokens).toBe(SUM_OUTPUT)
    expect(reloadAgg.generatedTokens).toBe(SUM_OUTPUT)
    expect(liveAgg.generatedTokens).toBe(reloadAgg.generatedTokens)
  })

  it('单调用 turn：live = reload = 该次调用量（回归锚：修复不改变单调用行为）', () => {
    const livePatched = terminalMessagePatch(
      { id: 'a1', role: 'assistant', content: 'x', status: 'streaming', timestamp: T0 },
      0,
      {
        lastAssistantIdx: 0,
        isErrorStop: false,
        errorMessage: undefined,
        finalContent: 'x',
        payload: { usage: { inputTokens: CALL1.input, outputTokens: CALL1.output } },
        endedAt: T0 + 1000,
      },
    )
    const liveAgg = deriveTurnAggregates(makeTurn(null, [livePatched]))
    const state = replayEntries([
      msgEntry('e-a', { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: T0, usage: CALL1 }, { timestamp: ISO(T0) }),
    ])
    const reloadAgg = deriveTurnAggregates(makeTurn(null, state.messages))
    expect(liveAgg.generatedTokens).toBe(CALL1.output)
    expect(reloadAgg.generatedTokens).toBe(CALL1.output)
  })
})
