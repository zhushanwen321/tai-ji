import type { Message } from '@taiji/shared'
import type { MessageTurn } from './message-turns'

/**
 * turn 级聚合事实（**整个 agent-turn** 口径，不是单条 assistant 消息口径）。
 *
 * 从 message-turns.ts 拆出（2026-09）：分组（什么构成一个 turn）与聚合（这个 turn 干了多少活）
 * 是两条独立变化轴。
 *
 * 消费方 = TurnMeta 状态行（「工作中/已工作 + 时长 + 时刻区间 + 已生成 N tokens」），经 ui
 * `useTurnElapsed` 以 core 纯函数形式调用（live 与 reload 同一公式，重开 session 数值一致）。
 *
 * 口径设计依据（2026-09 用户裁决）：状态行展示的是「这个 turn 一共干了多少活」——
 * 时间轴覆盖整 turn 墙钟（含工具执行/思考/等待），产出覆盖整个 turn 的模型生成 token。
 *
 * - `startedAt`：turn 起点 = user 消息时间戳（有 user 锚时）/ 首条 assistant 时间戳
 *   （bg-notify 续跑 turn、assistant 自启 turn）；无成员 = 0。
 * - `endedAt`：最后一次**产出结束** = max(assistant.endedAt ?? assistant.timestamp,
 *   toolCall.endTime, thinking.endTime)。消息结束时刻缺失（旧历史帧）时回退其开始时刻——
 *   与修复前行为等价（单条 assistant 的 turn 会退化为 1s，属已知降级）。
 *   notices（bash 记录 / liveOnly 警告）刻意不参与：它们不是 agent 产出。
 * - `generatedTokens`：本 turn **全部 LLM 调用的 usage.outputTokens 之和**（token 口径，
 *   2026-09 用户裁决「只显示模型上报的真实值，不做估算」）。pi 的 `output` 即「模型生成的
 *   全部内容」——正文 + 思考 + 工具参数，已实测 195 条真实样本
 *   `totalTokens = input + cacheRead + cacheWrite + output` 且 `reasoning ⊆ output`
 *   （无独立 reasoning 项），故无需按 block 分类统计。
 *   数据源两条链路同一份 pi usage：live = assistant message entry 经 reducer 转换写
 *   `Message.usage`（apply-entry-convert.usageField；pi 在 assistant 消息结束时就带 usage），
 *   reload = session JSONL 同名 entry 字段（message-converter 同源），故历史会话零迁移即修好。
 *
 * 数字的完整性（不做估算的代价，显式接受）：usage 仅在一次 LLM 调用**结束后**才有——
 * 正在流式生成的那一段在收口前不计数，故状态行数字是「**已上报的真实累计**」：流式期显示
 * 已完成各段的累计（单段 turn 在这一段期间不显示数字），收口瞬间跳到完整值。全程无近似值。
 */
export interface TurnAggregates {
  /** turn 起点（epoch ms）；无成员 = 0 */
  startedAt: number
  /** 最后一次产出结束（epoch ms）；无成员 = 0 */
  endedAt: number
  /** 本 turn 已上报的真实生成 token 总量（Σ usage.outputTokens） */
  generatedTokens: number
}

/**
 * 派生 turn 级聚合事实（纯函数，live 与 reload 同一公式——两条链路共用同一份 Message
 * 数据与同一份 pi usage，故「重开 session 数值一致」是构造性的）。
 *
 * 性能：O(turn 内消息与块数) 纯数值累加，无字符串遍历、无缓存。
 */
export function deriveTurnAggregates(turn: MessageTurn): TurnAggregates {
  let endedAt = 0
  let generatedTokens = 0
  for (const m of turn.assistants) {
    const msgEnd = assistantMessageEndAt(m)
    if (msgEnd > endedAt) endedAt = msgEnd
    generatedTokens += reportedOutputTokens(m)
  }
  const startedAt = turnStartedAt(turn)
  return { startedAt, endedAt, generatedTokens }
}

/**
 * 单条 assistant 消息的产出结束时刻：消息收口与 thinking/toolCall 结束取最大。
 * 消息结束时刻缺失（旧历史帧）时回退其开始时刻——与修复前行为等价（单条 assistant
 * 的 turn 会退化为 1s，属已知降级）。
 */
function assistantMessageEndAt(m: Message): number {
  let endedAt = m.endedAt ?? m.timestamp
  for (const th of m.thinking ?? []) {
    const thEnd = th.endTime ?? th.startTime
    if (thEnd !== undefined && thEnd > endedAt) endedAt = thEnd
  }
  for (const tc of m.toolCalls ?? []) {
    const tcEnd = tc.endTime ?? tc.startTime
    if (tcEnd > endedAt) endedAt = tcEnd
  }
  return endedAt
}

/**
 * 已上报的真实用量（token 口径）：无 usage（流式中的当前调用 / 异常历史帧）计入 0，
 * 不估算——数字宁可暂时偏小也不给近似值（用户裁决 A）。
 */
function reportedOutputTokens(m: Message): number {
  return m.usage?.outputTokens ?? 0
}

/** turn 起点：user 消息时间戳（有 user 锚时）/ 首条 assistant 时间戳（bg-notify 续跑
 * turn、assistant 自启 turn）；无成员 = 0。 */
function turnStartedAt(turn: MessageTurn): number {
  return turn.user?.timestamp ?? turn.assistants[0]?.timestamp ?? 0
}
