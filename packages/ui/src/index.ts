export const UI_PACKAGE_NAME = '@taiji/ui'

// ── shadcn-vue 原语（W6 从 renderer components/ui 迁入 message-stream 消费子集）──
export * from './primitives'

// ── features/chat（w6 chat-ui-and-shell：chat 域展示组件 + ChatView 薄壳 + deps token）──
export * from './features/chat'

// ── features/new-task（w4 new-task-search UI 迁移：5 个跨端共享组件 + NewTaskDeps token）──
export * from './features/new-task'

// ── overlays（w4 new-task-search UI 迁移：SearchModal 全局搜索浮层）──
export { default as SearchModal } from './overlays/SearchModal.vue'

// ── lib（公共工具层：文件反查 + class 合并，SSOT 归位，renderer 经 re-export shim 消费）──
export * from './lib/file-basename'
export { cn } from './lib/utils'

// RenderingProtocol 层的公共面（GuiComponentRenderer / AnsiText / 注册表机制）经
// `@taiji/ui/rendering-protocol` 子路径暴露。7 原语是 RenderingProtocol 内部
// 实现细节，不经顶层导出（AC4：原语不经顶层暴露，消费方走 ./rendering-protocol 子路径）。
