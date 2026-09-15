/**
 * renderer 公共工具 —— cn 薄 re-export（SSOT 在 @taiji/ui）。
 *
 * cn 实现已归位 ui 包（lib/utils.ts），renderer 经此 shim 消费。
 * rebuildSegmentsWithEditedText 已删除（renderer 侧零消费死代码，
 * ui 侧 SSOT 在 lib/segment-rebuild.ts，UserBubble 消费）。
 */
export { cn } from '@taiji/ui'
