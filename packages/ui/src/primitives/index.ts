// ui 包 shadcn-vue 原语 barrel。
// 从 renderer components/ui/* 按消费子集增量迁入：
// - w6 chat-ui-and-shell T2：button/dialog/hover-card/popover/textarea（message-stream 消费）
// - W3 settings 组件迁移：input/select/switch/label/checkbox + dialog 补 ConfirmDialog/DialogHeader
// P5/B8 将统一迁全量 58 文件，当前只迁各 wave 消费子集。
export * from './button'
export * from './checkbox'
export * from './dialog'
export * from './hover-card'
export * from './input'
export * from './label'
export * from './popover'
export * from './select'
export * from './switch'
export * from './textarea'
