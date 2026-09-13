/**
 * apply-entry-convert 单元测试 —— computeToolCallFill 的 endTime 回填（chat-flow-timestamp U1）。
 *
 * 覆盖（impl-plan U1 验收条款 ①②）：
 * - computeToolCallFill 返回 endTime = toolResult body.timestamp（缺失/非 number 不设字段）
 * - reload 路径（replayEntries）toolCall.endTime 有值且 === toolResult body.timestamp
 * - toolResult 缺 timestamp → toolCall 不带 endTime 字段（旧数据缺口语义，设计 §2.5）
 * - 孤儿 toolResult 不崩（收集为 orphan，endTime 随 body 保留原值不回填）
 * - copy-on-write 不变量：回填产新 toolCall 副本，原 state / entry 不被 mutate
 *   （apply-entry.ts 文件头纯度契约在该新字段上的延伸断言）
 * - R2-S1 双入口幂等：同 toolCallId 二投保留首条版本（endTime 与 output 同语义）
 *
 * computeToolCallFill 的截断语义（output/outputRaw/outputTruncated）见 entry-truncate.test.ts，
 * 本文件只覆盖 endTime 维度，避免同断言双份维护。
 *
 * 运行：cd packages/core && pnpm exec vitest run src/domain/chat/__tests__/apply-entry-convert.test.ts
 */
import { describe, it, expect } from 'vitest'
import { computeToolCallFill } from '../apply-entry-convert'
import { applyEntry, createInitialChatViewState, replayEntries } from '../apply-entry'
import type { PiEntry, PiMessageEntry } from '../apply-entry'

// ── 测试数据工厂（同 apply-entry.test.ts 惯例：ISO timestamp / uuid 风格 id）──────────

function msgEntry(
  id: string,
  body: Record<string, unknown>,
  overrides?: { parentId?: string | null; timestamp?: string },
): PiMessageEntry {
  return {
    type: 'message',
    id,
    parentId: overrides?.parentId ?? null,
    timestamp: overrides?.timestamp ?? '2026-09-13T10:00:00.000Z',
    message: body,
  }
}

const ISO = (ms: number): string => new Date(ms).toISOString()

/** 带 toolCall 的 assistant entry（startTime 来源 = body.timestamp）。 */
function assistantWithToolCall(id: string, tcId: string, ts: number): PiMessageEntry {
  return msgEntry(id, {
    role: 'assistant',
    content: [{ type: 'toolCall', id: tcId, name: 'bash', arguments: { command: 'ls' } }],
    timestamp: ts,
  }, { timestamp: ISO(ts) })
}

/** toolResult entry（endTime 来源 = body.timestamp）。 */
function toolResultEntry(id: string, tcId: string, ts: number | undefined, extra?: Record<string, unknown>): PiMessageEntry {
  return msgEntry(id, {
    role: 'toolResult',
    toolCallId: tcId,
    toolName: 'bash',
    content: [{ type: 'text', text: 'done' }],
    ...(ts !== undefined ? { timestamp: ts } : {}),
    ...extra,
  }, { timestamp: ISO(ts ?? 0) })
}

describe('computeToolCallFill：endTime 回填源（chat-flow-timestamp U1 验收①）', () => {
  it('body.timestamp 为 number → endTime 返回该值', () => {
    const fill = computeToolCallFill({
      role: 'toolResult', toolCallId: 'tc1', toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }], timestamp: 5432,
    })
    expect(fill.endTime).toBe(5432)
  })

  it('body.timestamp 缺失 → 不设 endTime 字段（条件 spread，无 undefined 噪声）', () => {
    const fill = computeToolCallFill({
      role: 'toolResult', toolCallId: 'tc1', toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }],
    })
    expect('endTime' in fill).toBe(false)
  })

  it('body.timestamp 非 number（JSONL 宽形态防御，同 usageField 模式）→ 不设 endTime', () => {
    // PiMessageBody.timestamp 类型收窄为 number，真实磁盘数据是宽形态（外部系统不信任原则）
    const malformed = {
      role: 'toolResult', toolCallId: 'tc1', toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }], timestamp: '2026-09-13T10:00:00.000Z',
    } as unknown as Parameters<typeof computeToolCallFill>[0]
    const fill = computeToolCallFill(malformed)
    expect('endTime' in fill).toBe(false)
  })
})

describe('reload 路径 toolCall.endTime 回填（chat-flow-timestamp U1 验收② / 设计 A5）', () => {
  it('replayEntries：toolCall.endTime === toolResult body.timestamp，startTime 不受影响', () => {
    const state = replayEntries([
      assistantWithToolCall('e-asst', 'tc-x', 1000),
      toolResultEntry('e-tr', 'tc-x', 5432),
    ])
    expect(state.messages).toHaveLength(1)
    const tc = state.messages[0]!.toolCalls![0]!
    expect(tc.id).toBe('tc-x')
    expect(tc.startTime).toBe(1000) // assistant body.timestamp（既有语义不变）
    expect(tc.endTime).toBe(5432) // toolResult body.timestamp（本次回填）
  })

  it('toolResult 缺 timestamp → 回填后 toolCall 不带 endTime 字段（running/end_not_received 缺口语义）', () => {
    const state = replayEntries([
      assistantWithToolCall('e-asst', 'tc-x', 1000),
      toolResultEntry('e-tr', 'tc-x', undefined),
    ])
    const tc = state.messages[0]!.toolCalls![0]!
    expect('endTime' in tc).toBe(false)
  })

  it('applyEntry 单条路径（live 帧入口）：copy-on-write —— 原 state 的 toolCall 对象不被 mutate', () => {
    const base = replayEntries([assistantWithToolCall('e-asst', 'tc-x', 1000)])
    const originalTc = base.messages[0]!.toolCalls![0]!
    const next = applyEntry(base, toolResultEntry('e-tr', 'tc-x', 5432))

    // 新 state 回填完成
    expect(next.messages[0]!.toolCalls![0]!.endTime).toBe(5432)
    // 原 state 引用与值均不变（copy-on-write：产物是新副本，输入零污染）
    expect(base.messages[0]!.toolCalls![0]!).toBe(originalTc)
    expect(originalTc.endTime).toBeUndefined()
    // entry 输入不被 mutate
    const trBody = toolResultEntry('e-tr-2', 'tc-x', 9999).message
    expect('endTime' in trBody).toBe(false)
  })

  it('R2-S1 双入口幂等：同 toolCallId 二投保留首条版本（endTime 与 output 同语义）', () => {
    const first = applyEntry(
      replayEntries([assistantWithToolCall('e-asst', 'tc-x', 1000)]),
      toolResultEntry('e-tr-1', 'tc-x', 5432),
    )
    expect(first.messages[0]!.toolCalls![0]!.endTime).toBe(5432)

    // 第二条帧（message_end 载体，timestamp 不同）：整体 no-op，保留首条 endTime
    const second = applyEntry(first, toolResultEntry('e-tr-2', 'tc-x', 7777))
    expect(second.messages[0]!.toolCalls![0]!.endTime).toBe(5432)
  })

  it('孤儿 toolResult（带 timestamp）：不崩，收集为 orphan，不产消息不回填', () => {
    const state = replayEntries([
      toolResultEntry('e-tr-orphan', 'tc-none', 5432),
    ])
    expect(state.messages).toHaveLength(0)
    expect(state.orphanToolResults).toHaveLength(1)
    expect(state.orphanToolResults[0]!.toolCallId).toBe('tc-none')
    expect(state.orphanToolResults[0]!.timestamp).toBe(5432)
  })

  it('同 assistant 多 toolCall 只回填匹配 id（其余 toolCall 不带 endTime）', () => {
    const state = replayEntries([
      msgEntry('e-asst', {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-a', name: 'bash', arguments: {} },
          { type: 'toolCall', id: 'tc-b', name: 'read', arguments: {} },
        ],
        timestamp: 1000,
      }, { timestamp: ISO(1000) }),
      toolResultEntry('e-tr', 'tc-a', 5432),
    ])
    const [tcA, tcB] = state.messages[0]!.toolCalls!
    expect(tcA.endTime).toBe(5432)
    expect('endTime' in tcB).toBe(false)
    expect(tcB.status).toBe('completed')
  })
})

describe('确定性：endTime 派生自 entry 数据，无 Date.now() 渗入（reducer 纯度契约）', () => {
  it('同序列两次喂入 endTime 全等', () => {
    const entries: PiEntry[] = [
      assistantWithToolCall('e-asst', 'tc-x', 1000),
      toolResultEntry('e-tr', 'tc-x', 5432),
    ]
    const a = replayEntries(entries)
    const b = replayEntries(entries)
    expect(a.messages[0]!.toolCalls![0]!.endTime).toBe(b.messages[0]!.toolCalls![0]!.endTime)
    expect(a.messages[0]!.toolCalls![0]!.endTime).toBe(5432)
  })

  it('createInitialChatViewState 起点下 orphan 分支同序列确定性', () => {
    const entry = toolResultEntry('e-tr-orphan', 'tc-none', 5432)
    const s1 = applyEntry(createInitialChatViewState(), entry)
    const s2 = applyEntry(createInitialChatViewState(), entry)
    expect(s1.orphanToolResults).toEqual(s2.orphanToolResults)
  })
})
