/**
 * deriveTurnAggregates —— 整个 agent-turn 聚合事实单测（2026-09 状态行口径改造）。
 *
 * 用户裁决口径：TurnMeta 状态行展示的是**整个 agent-turn** 的聚合事实——
 * - 时长：turn 起点（user 消息 / 首条 assistant）→ 最后一次**产出结束**（含工具执行 / 思考）
 * - token：本 turn 全部 LLM 调用的 usage.outputTokens 之和（**只统计已上报的真实值，不估算**——
 *   用户裁决 A）——pi output 含正文 + 思考 + 工具参数
 *
 * 回归锚点（旧口径的两个可见缺陷）：
 * 1. 单条 assistant 的 turn 恒显「1s」（起止同源）→ 现在读 Message.endedAt，得真实墙钟。
 * 2. 多段 turn 漏掉末条消息自身的生成时长 / 工具执行时长 → 现在取 max(消息结束, 工具结束)。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/turn-aggregates.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { Message } from '@taiji/shared'
import type { MessageTurn } from '../message-turns'
import { deriveTurnAggregates } from '../turn-aggregates'

const T0 = 1_700_000_000_000

function assistant(over: Partial<Message> = {}): Message {
  return { id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: T0, ...over }
}

function turn(assistants: Message[], userTs: number | null = null): MessageTurn {
  return {
    index: 1,
    user: userTs === null
      ? null
      : { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }], status: 'complete', timestamp: userTs },
    assistants,
    isStreaming: false,
    hasFoldable: false,
  }
}

describe('deriveTurnAggregates 时间轴', () => {
  it('单条 assistant：起点 = 消息开始，终点 = 消息 endedAt（不再退化为 1s）', () => {
    const agg = deriveTurnAggregates(turn([assistant({ timestamp: T0, endedAt: T0 + 6_800 })]))
    expect(agg.startedAt).toBe(T0)
    expect(agg.endedAt).toBe(T0 + 6_800)
  })

  it('有 user 锚：起点取 user 消息时间戳（整 turn 从用户发送算起）', () => {
    const agg = deriveTurnAggregates(turn([assistant({ timestamp: T0 + 3_000, endedAt: T0 + 9_000 })], T0))
    expect(agg.startedAt).toBe(T0)
    expect(agg.endedAt).toBe(T0 + 9_000)
  })

  it('终点取 max(消息 endedAt, 工具 endTime, 思考 endTime)——长工具/思考结束晚于消息时刻时不丢', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({
        timestamp: T0,
        endedAt: T0 + 2_000,
        toolCalls: [{ id: 'tc1', toolName: 'bash', input: {}, status: 'completed', startTime: T0 + 100, endTime: T0 + 40_000 }],
        thinking: [{ id: 'th1', content: 'x', collapsed: true, startTime: T0 + 50, endTime: T0 + 1_500 }],
      }),
    ]))
    expect(agg.endedAt).toBe(T0 + 40_000)
  })

  it('running 工具（无 endTime）以 startTime 参与：末位工具开始后仍在跑 → 终点不早于它', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({
        timestamp: T0,
        endedAt: T0 + 1_000,
        toolCalls: [{ id: 'tc1', toolName: 'bash', input: {}, status: 'running', startTime: T0 + 5_000 }],
      }),
    ]))
    expect(agg.endedAt).toBe(T0 + 5_000)
  })

  it('endedAt 缺失（旧历史帧）→ 回退消息 timestamp（修复前行为，降级不虚高）', () => {
    const agg = deriveTurnAggregates(turn([assistant({ timestamp: T0 + 700 })]))
    expect(agg.endedAt).toBe(T0 + 700)
  })

  it('跨 assistant 段：终点取全部段的 max（多 LLM 段 turn 不被首段截断）', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({ id: 'a1', timestamp: T0, endedAt: T0 + 2_000 }),
      assistant({ id: 'a2', timestamp: T0 + 30_000, endedAt: T0 + 45_000 }),
    ]))
    expect(agg.endedAt).toBe(T0 + 45_000)
  })

  it('空 turn（无 user / 无 assistant）→ 0/0（消费侧 0s 兜底）', () => {
    expect(deriveTurnAggregates(turn([]))).toEqual({ startedAt: 0, endedAt: 0, generatedTokens: 0 })
  })

  it('notices（bash 记录 / liveOnly 警告）不参与时间轴与 token（不是 agent 产出）', () => {
    const withNotice: MessageTurn = {
      ...turn([assistant({ timestamp: T0, endedAt: T0 + 1_000 })]),
      notices: [{ id: 'n1', role: 'system', content: 'x'.repeat(500), status: 'complete', timestamp: T0 + 99_000 }],
    }
    const agg = deriveTurnAggregates(withNotice)
    expect(agg.startedAt).toBe(T0)
    expect(agg.endedAt).toBe(T0 + 1_000)
    expect(agg.generatedTokens).toBe(0)
  })
})

describe('deriveTurnAggregates 生成 token 总量（只统计已上报真值，不估算）', () => {
  it('Σ usage.outputTokens，跨全部 assistant 段累计', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({ id: 'a1', content: 'abc', usage: { inputTokens: 10, outputTokens: 120 } }),
      assistant({ id: 'a2', content: 'de', usage: { inputTokens: 5, outputTokens: 41 } }),
    ]))
    expect(agg.generatedTokens).toBe(161)
  })

  it('无 usage 的段（live 流式中的当前调用）计入 0，不估算——数字宁小不假', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({ id: 'a1', usage: { inputTokens: 1, outputTokens: 122 } }),
      assistant({ id: 'a2', content: '正在写很长的正文，但这次调用还没结束', status: 'streaming' }),
    ]))
    expect(agg.generatedTokens).toBe(122)
  })

  it('单段 turn 流式中 → 0（状态行不渲染数字，收口后跳完整值）', () => {
    const agg = deriveTurnAggregates(turn([assistant({ content: 'abc', status: 'streaming' })]))
    expect(agg.generatedTokens).toBe(0)
  })

  it('工具参数不计入公式（token 来自 usage.output，而非文本重算——无按 block 分类）', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({
        content: '',
        usage: { inputTokens: 3, outputTokens: 272 },
        toolCalls: [{ id: 'tc1', toolName: 'read', input: { path: 'a'.repeat(300) }, output: 'b'.repeat(5_000), status: 'completed', startTime: T0 }],
      }),
    ]))
    expect(agg.generatedTokens).toBe(272)
  })

  it('usage 全零（失败帧）→ 0（0 是真实测量值，不视为缺失）', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({ content: '', usage: { inputTokens: 0, outputTokens: 0 } }),
    ]))
    expect(agg.generatedTokens).toBe(0)
  })
})
