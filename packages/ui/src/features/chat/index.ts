/**
 * @taiji/ui features/chat barrel（w6 chat-ui-and-shell）。
 *
 * 导出 chat 域展示组件（ChatView 顶层 + 迁移的展示/编排组件）+ deps inject token +
 * 纯函数（block-icon/format-utils）+ 类型（MarkdownSegment 等，SSOT 在 ./markdown-types）。
 *
 * markdown 渲染纯逻辑（markdown.ts / markdown-incremental.ts / mermaid.ts，D10 渲染链
 * 下沉自 renderer 壳）**不经本 barrel 导出**——重库依赖（markdown-it/shiki/katex/mermaid）
 * 只在消费方显式 import 对应 subpath（`@taiji/ui/features/chat/markdown` 等）时进入模块图，
 * 避免顶层 barrel 消费方被动拉入渲染重库。
 *
 * 消费方（renderer 壳 MessageStream.vue）经 @taiji/ui 子路径或顶层 barrel 消费。
 */
// 顶层薄壳 + 组装
export { default as ChatView } from './ChatView.vue'
// [u4d-truncated-ui] 历史预算截断顶部条（MessageStream 据截断窗口状态 v-if 挂载）
export { default as TruncatedHistoryBar } from './TruncatedHistoryBar.vue'
// deps inject token（ChatViewDeps）。trace 折叠 stick-guard 通路已随 <Transition> 删除退役
//（useVirtuaFollow INVAR-M4-2′ 复合判据：程序性写入回声不翻 stickToBottom=false，guarded
// 回归结构上不可能）。
export { ChatViewDepsKey, useChatViewDeps } from './chat-view-deps'
export type { ChatViewDeps, DrawerOpenOptions } from './chat-view-deps'
// 纯函数（图标决策 + 耗时格式化）
export * from './block-icon'
export * from './format-utils'
export * from './slash-icons'
// 类型
export type { MarkdownSegment, IncrementalMarkdownResult, IncrementalMarkdownCache } from './markdown-types'
// 展示组件
export { default as SystemNotice } from './SystemNotice.vue'
// [u8-pi-respawn] pi 崩溃恢复提示条（SystemNotice 按 PI_RESPAWN_NOTICE_CUSTOM_TYPE 分支渲染）
export { default as RespawnNoticeBar } from './RespawnNoticeBar.vue'
export { default as ImageThumb } from './ImageThumb.vue'
export { default as ToolResultImages } from './ToolResultImages.vue'
export { default as AmbiguousFilePopover } from './AmbiguousFilePopover.vue'
export { default as TurnRail } from './TurnRail.vue'
// 编排组件
export { default as Turn } from './Turn.vue'
export { default as UserBubble } from './UserBubble.vue'
export { default as TurnMeta } from './TurnMeta.vue'
export { default as TurnSummary } from './TurnSummary.vue'
export { default as Block } from './Block.vue'
export { default as BlockSubagent } from './BlockSubagent.vue'
export { default as MarkdownRenderer } from './MarkdownRenderer.vue'
export { default as MermaidRenderer } from './MermaidRenderer.vue'
export { default as BashOutputBlock } from './BashOutputBlock.vue'
export { default as ChangeSetCard } from './ChangeSetCard.vue'
// html-preview 内联预览容器（chat-html-support §6.3 D3，v16 形态变更——替代卡片形态）
export { default as HtmlPreviewInline } from './HtmlPreviewInline.vue'
