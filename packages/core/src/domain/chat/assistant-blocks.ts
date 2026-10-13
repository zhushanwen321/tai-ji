/**
 * 单条 assistant Message 的有序渲染块展开（从 message-turns.ts 拆出，独立于 turn 分组）。
 *
 * 消费方经 @taiji/core/domain/chat 桶出口（Turn.vue trace 区按序 v-for 渲染 Block.vue），
 * trace-window.ts 包内深路径 import 经 message-turns.ts 的 re-export 解析。
 */
import { normalizeContent, SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '@taiji/shared'
import type { Message, ThinkingBlock, ToolCall } from '@taiji/shared'

/**
 * 有序渲染块 —— 单条 assistant Message 内部块按真实时序解出后的渲染单元。
 * Turn.vue trace 区按此数组顺序 v-for 渲染 Block.vue。
 * 数据形状用 type（同族渲染项 RenderItem 同款；非被 implements 的行为契约）。
 */
export type OrderedBlock = {
  kind: 'thinking' | 'tool' | 'text' | 'agentgraph'
  ref: ThinkingBlock | ToolCall | string
}

/** 判断 toolName 是否属于 agentgraph（subagent/workflow）。 */
function isAgentgraphToolName(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName) || WORKFLOW_TOOL_NAMES.has(toolName)
}

/** toolCall 块构造：agentgraph 工具名归 agentgraph kind（主路径/降级路径共用）。 */
function toolBlockOf(tc: ToolCall): OrderedBlock {
  return { kind: isAgentgraphToolName(tc.toolName) ? 'agentgraph' : 'tool', ref: tc }
}

/** 主路径：contentBlocks 非空时按其真实时序解出（text/thinking/toolCall 的 refId 回查）。 */
function expandFromContentBlocks(blocks: NonNullable<Message['contentBlocks']>, msg: Message): OrderedBlock[] {
  const result: OrderedBlock[] = []
  // [ADR-0122 断连未确认终局] error 消息的 text 块宿主保证（与 expandFallback 同判据）：
  // content 空但 error 非空时仍产 text 块——Block 的 error danger 行只挂 text 分支，
  // 缺宿主 = 错误文案在对话流不可见（静默悬挂）。
  const needsTextBlock = !!msg.content || (msg.status === 'error' && !!msg.error)
  for (const b of blocks) {
    if (b.type === 'text') {
      if (needsTextBlock) result.push({ kind: 'text', ref: normalizeContent(msg.content) })
    } else if (b.type === 'thinking') {
      const th = msg.thinking?.find((t) => t.id === b.refId)
      if (th) result.push({ kind: 'thinking', ref: th })
    } else if (b.type === 'toolCall') {
      const tc = msg.toolCalls?.find((t) => t.id === b.refId)
      if (tc) result.push(toolBlockOf(tc))
    }
  }
  return result
}

/** 降级路径：contentBlocks 缺失/为空时按 content 文本 + thinking + toolCalls 顺序解出。 */
function expandFallback(msg: Message): OrderedBlock[] {
  const fallback: OrderedBlock[] = []
  const text = normalizeContent(msg.content)
  // [ADR-0122 断连未确认终局] 纯 error 气泡（content 空 + error 非空）必须有 text 块宿主：
  // Block 的 error danger 行只挂 text 分支——零块消息（秒败 turn / 断连显式失败上报
  // 「执行结果未确认」）的 error 文案在对话流不可见（静默悬挂）。补空正文 text 块，
  // error 行随 Block text 分支渲染（空正文 + 独立 danger 行 = M2 追加形态）。
  if (text.trim() || (msg.status === 'error' && !!msg.error)) fallback.push({ kind: 'text', ref: text })
  for (const th of msg.thinking ?? []) fallback.push({ kind: 'thinking', ref: th })
  for (const tc of msg.toolCalls ?? []) fallback.push(toolBlockOf(tc))
  return fallback
}

/**
 * 把单条 assistant Message 的内部块按 contentBlocks 真实时序解成有序列表。
 * 纯函数：相同输入相同输出，无副作用。
 *
 * contentBlocks 是渲染顺序的唯一 SSOT，消费端（Turn.vue 等）禁止在其上叠加
 * 「末位 assistant」等兄弟消息派生的位置判断——那会随 message_start 翻转导致
 * block 跳变（2026-08 对话流 block 渲染重构的主症，设计文档已删，git 可追溯）。
 *
 * 填充点契约：全部填充点（live feed = effects/registry.ts、streaming =
 * streaming-state-machine.ts、重放 = apply-entry-convert.ts、历史转换 =
 * runtime infra/pi/message-converter.ts）必须 append-only + 单 message 最多
 * 1 个 text 块（`.some(b => b.type === 'text')` 幂等守卫，见 registry:544 /
 * streaming-state-machine:162 先例）——新增填充点必须带同款守卫，否则 fallback
 * 分支会对每个 text 块重复 push 完整 content。顺序语义统一按 contentIndex
 * （产出顺序）insert，禁止退化为「事件到达顺序」与「content array 顺序」双轨。
 */
export function expandAssistantBlocks(msg: Message): OrderedBlock[] {
  const blocks = msg.contentBlocks
  if (blocks && blocks.length > 0) {
    return expandFromContentBlocks(blocks, msg)
  }
  return expandFallback(msg)
}
