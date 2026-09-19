/**
 * deriveTurnAggregates —— 整个 agent-turn 聚合事实单测（2026-09 状态行口径改造）。
 *
 * 用户裁决口径：TurnMeta 状态行展示的是**整个 agent-turn** 的聚合事实——
 * - 时长：turn 起点（user 消息 / 首条 assistant）→ 最后一次**产出结束**（含工具执行 / 思考）
 * - 字符：模型生成文本总量 = Σ 正文 + Σ thinking（跨 turn 内全部 assistant 段；不含工具
 *   参数 / 工具输出等环境产出）
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
import { deriveTurnAggregates } from '../message-turns'

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
    expect(deriveTurnAggregates(turn([]))).toEqual({ startedAt: 0, endedAt: 0, generatedChars: 0 })
  })

  it('notices（bash 记录 / liveOnly 警告）不参与时间轴与字符（不是 agent 产出）', () => {
    const withNotice: MessageTurn = {
      ...turn([assistant({ timestamp: T0, endedAt: T0 + 1_000 })]),
      notices: [{ id: 'n1', role: 'system', content: 'x'.repeat(500), status: 'complete', timestamp: T0 + 99_000 }],
    }
    expect(deriveTurnAggregates(withNotice)).toEqual({ startedAt: T0, endedAt: T0 + 1_000, generatedChars: 0 })
  })
})

describe('deriveTurnAggregates 生成字符总量', () => {
  it('Σ 正文 + Σ thinking，跨全部 assistant 段累计', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({ id: 'a1', content: 'abc', thinking: [{ id: 'th1', content: '想了一', collapsed: true }] }),
      assistant({
        id: 'a2',
        content: 'de',
        thinking: [
          { id: 'th2', content: '想二', collapsed: true },
          { id: 'th3', content: '三点', collapsed: true },
        ],
      }),
    ]))
    // 正文 3 + 2 = 5；思考 3 + 2 + 2 = 7
    expect(agg.generatedChars).toBe(12)
  })

  it('user / system 文本不计入（只算模型生成）', () => {
    const agg = deriveTurnAggregates(turn([assistant({ content: 'ok' })], T0))
    expect(agg.generatedChars).toBe(2)
  })

  it('工具参数 / 工具输出不计入（环境产出，非模型生成）', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({
        content: 'ok',
        toolCalls: [{
          id: 'tc1',
          toolName: 'read',
          input: { path: 'a'.repeat(300) },
          output: 'b'.repeat(5_000),
          status: 'completed',
          startTime: T0,
        }],
      }),
    ]))
    expect(agg.generatedChars).toBe(2)
  })

  it('Segment[] content 经 normalizeContent 归一（防御路径：assistant 理论恒 string）', () => {
    const agg = deriveTurnAggregates(turn([
      assistant({ content: [{ type: 'text', text: 'abcd' }] }),
    ]))
    expect(agg.generatedChars).toBe(4)
  })
})
