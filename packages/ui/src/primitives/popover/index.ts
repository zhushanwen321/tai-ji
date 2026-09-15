// ui 包 popover 原语（w6 chat-ui-and-shell T2 从 renderer components/ui/popover 迁入；
// W3 settings 组件迁移时补全 PopoverTrigger/PopoverTriggerButton/PopoverActionItem +
// 共享样式常量 styles.ts —— 消费子集增量迁移，沿用 w6 先例）。
// w4 new-task-search 组件迁移时补全 PopoverListItem（C-W4-4，DirSelect/BranchSelect/
// PresetSelectChip 消费；styles.ts 常量复用零新增）。P5/B8 统一迁全量时合并去重。
export { default as Popover } from './Popover.vue'
export { default as PopoverContent } from './PopoverContent.vue'
export { default as PopoverTrigger } from './PopoverTrigger.vue'
export { default as PopoverTriggerButton } from './PopoverTriggerButton.vue'
export { default as PopoverActionItem } from './PopoverActionItem.vue'
export { default as PopoverListItem } from './PopoverListItem.vue'
export { PopoverAnchor, PopoverClose } from 'reka-ui'
