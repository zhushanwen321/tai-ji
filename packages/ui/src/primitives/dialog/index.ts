// ui 包 dialog 原语（w6 chat-ui-and-shell T2 从 renderer components/ui/dialog 迁入；
// W3 settings 组件迁移时补全 DialogHeader/ConfirmDialog —— 消费子集增量迁移，沿用 w6 先例）。
// P5/B8 统一迁全量 58 文件时合并其余原语。
export { default as Dialog } from './Dialog.vue'
export { default as ConfirmDialog } from './ConfirmDialog.vue'
export { default as DialogContent } from './DialogContent.vue'
export { default as DialogDescription } from './DialogDescription.vue'
export { default as DialogHeader } from './DialogHeader.vue'
export { default as DialogTitle } from './DialogTitle.vue'
export { DialogClose } from 'reka-ui'
