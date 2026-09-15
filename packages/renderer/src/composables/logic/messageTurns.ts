/**
 * re-export shim —— messageTurns 纯逻辑已迁 @taiji/core/domain/chat（TD7，w6 chat-ui-and-shell）。
 *
 * renderer 旧消费方（MessageStream.vue / Turn.vue 等）零改动继续从此 import。
 * shim 留至 P6 清尾删。
 */
export type { MessageTurn, RenderItem, OrderedBlock, TurnRenderCache } from '@taiji/core/domain/chat'
export {
  renderKey,
  filterDisplayableMessages,
  groupTurns,
  toRenderItems,
  toRenderItemsIncremental,
  createTurnRenderCache,
  countThinking,
  countToolCalls,
  hasFailedTool,
  expandAssistantBlocks,
} from '@taiji/core/domain/chat'
