/**
 * [turn-badge-tokens] turn 徽标 token 数 live ≡ reload 聚合一致断言。
 *
 * [chat-flow-consistency D3 规则 5 改写] usage 的 live 写入点已从 message.complete 收尾
 * （terminalMessagePatch 回填末位）改为 message_end 定稿重建（registry
 * rebuildAssistantOnFinalize 按每条 assistant 的 entry 载荷写入各自 usage——与 reload 侧
 * reducer usageField 同源同值，「live ≡ reload」构造性成立）。complete 的 usage/endedAt
 * 覆盖随之退役：回合级累计若再覆盖末位，deriveTurnAggregates 逐条求和会把末位双计。
 * 本文件锁新口径下两端组合后的聚合一致性：
 *
 * - live 路径：多调用 turn 的 ref 形态（每条 assistant 在自己的 message_end 被重建，usage
 *   = 该条调用的载荷值）+ terminalMessagePatch 收尾（只翻 status——usage 退役后不覆盖，
 *   负断言防回归为覆盖即双计）；
 * - reload 路径：同 turn 的 session JSONL entries 经 replayEntries（逐条 entry 自带 usage）；
 * - 两路径 deriveTurnAggregates().generatedTokens 全等，且等于全部调用之和（非末次调用量）。
 *
 * [HISTORICAL] 旧口径（terminalMessagePatch 回填 runtime sumTurnUsage 的 turn 级累计）
 * 的结构性偏小根因与 event-adapter 求和补丁见 git 历史；sumTurnUsage 产物的 complete
 * payload.usage 字段自此无前端消费方（发端字段退役清理属 runtime 侧后续单元）。
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

describe('[turn-badge-tokens] 多 assistant 调用 turn：live ≡ reload 聚合一致（D3 逐条载荷口径）', () => {
  it('live 路径（定稿重建逐条 usage + complete 收尾不覆盖）= reload 路径（replayEntries 逐条求和）= 全部调用之和', () => {
    // ── live 路径：ref 形态（registry 定稿重建产物）——每条 assistant 的 usage =
    //    自己 message_end 载荷的调用值（rebuildAssistantOnFinalize 写入，与 reload 同源）──
    const live: Message[] = [
      { id: 'u-live', role: 'user', content: 'q', status: 'complete', timestamp: T0 },
      {
        id: 'a-live-1', role: 'assistant', content: '', status: 'streaming', timestamp: T0 + 100,
        toolCalls: [{ id: 'tc1', toolName: 'edit', input: { path: '/a.ts' }, status: 'completed', startTime: T0 + 200, endTime: T0 + 1500 }],
        usage: { inputTokens: CALL1.input, outputTokens: CALL1.output },
      },
      { id: 'a-live-2', role: 'assistant', content: 'final', status: 'streaming', timestamp: T0 + 2000, usage: { inputTokens: CALL2.input, outputTokens: CALL2.output } },
    ]
    // 回合收尾（message.complete）：terminalMessagePatch 只翻 status / 权威 content——
    // usage/endedAt 覆盖已退役（D3 规则 5）。负断言防回归：若此处改回回合级累计覆盖，
    // 下方聚合会变成「逐条 + 回合累计」双计而偏离 SUM_OUTPUT。
    const lastAssistantIdx = findLastAssistantIndex(live)
    const livePatched = live.map((m, i) =>
      m.role === 'assistant' && m.status === 'streaming'
        ? terminalMessagePatch(m, i, {
          lastAssistantIdx,
          isErrorStop: false,
          errorMessage: undefined,
          finalContent: 'final',
        })
        : m,
    )
    expect(livePatched[1]!.usage).toEqual({ inputTokens: CALL1.input, outputTokens: CALL1.output })
    expect(livePatched[2]!.usage).toEqual({ inputTokens: CALL2.input, outputTokens: CALL2.output })
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

    // 两路径聚合全等 = 全部调用之和（逐条载荷同源求和，非末次调用量、非回合累计双计）
    expect(liveAgg.generatedTokens).toBe(SUM_OUTPUT)
    expect(reloadAgg.generatedTokens).toBe(SUM_OUTPUT)
    expect(liveAgg.generatedTokens).toBe(reloadAgg.generatedTokens)
  })

  it('单调用 turn：live = reload = 该次调用量（回归锚：收尾不改变单调用行为）', () => {
    const livePatched = terminalMessagePatch(
      { id: 'a1', role: 'assistant', content: 'x', status: 'streaming', timestamp: T0, usage: { inputTokens: CALL1.input, outputTokens: CALL1.output } },
      0,
      {
        lastAssistantIdx: 0,
        isErrorStop: false,
        errorMessage: undefined,
        finalContent: 'x',
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
