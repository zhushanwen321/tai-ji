/**
 * chat store 的流式 chunk 定位辅助函数（F2 重构后职责收窄）。
 *
 * 背景：原 applyChunk（21 case switch）已并入 chat-message-effects.ts 的 effect 注册表，
 * 消除「chunk-processor + useChat 对同一 ServerMessage 流 switch 两次」的 double-dispatch。
 * 本文件保留纯查找辅助函数（findLastAssistantIndex / findToolCallOwner），供注册表
 * handler 与 store.applyFileChanges 复用。不再含 switch 分发逻辑。
 *
 * 行为不变：查找语义与原 applyChunk 内联调用完全一致。
 */
import type { Message } from '@taiji/shared'

/** 从后往前找最后一条 assistant message 的下标 */
export function findLastAssistantIndex(list: Message[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant') return i
  }
  return -1
}

/**
 * 按 toolCallId 全局查找所属 assistant message 的下标（ID 锚定，不靠位置）。
 *
 * [HISTORICAL] 为什么不用 findLastAssistantIndex：event-adapter 并行处理 pi 事件
 * （void this.handleEvent 不 await），tool_execution_end 的 async handler（含 hook + git 对账）
 * 可能晚于下一个 message_start 发送。若用「最后一条 assistant」定位，end 会命中错位的 message
 * （如 toolResult 假 message_start 建的空 message），更新静默失败，toolCall 永久卡 running。
 *
 * 按 toolCallId 锚定让乱序无害化：无论事件到达顺序，end/update 都精确命中真正含该 toolCall 的 message。
 * 从后往前扫：toolCall 总是挂在最近的 assistant message（多 assistant turn 时命中最新）。
 * 消息量通常 <100，O(n) 可接受；性能瓶颈出现再加索引。
 */
export function findToolCallOwner(list: Message[], toolCallId: string): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'assistant' && list[i].toolCalls?.some((tc) => tc.id === toolCallId)) {
      return i
    }
  }
  return -1
}
