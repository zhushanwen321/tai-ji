/**
 * re-export shim —— summarizeTurn 纯逻辑已迁 @taiji/core/domain/chat（TD7，w6 chat-ui-and-shell）。
 *
 * renderer 旧消费方零改动继续从此 import。shim 留至 P6 清尾删。
 */
export {
  summarizeTurnForRail,
  stripMarkdown,
  truncate,
  summarizeAssistantForRail,
} from '@taiji/core/domain/chat'
