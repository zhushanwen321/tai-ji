/**
 * @taiji/ui features/new-task barrel（w4 new-task-search UI 迁移）。
 *
 * 导出 5 个跨端共享 new-task 组件（C-NT-4）+ NewTaskDeps inject token +
 * 键盘导航 composable + path 纯函数。
 *
 * 消费方（renderer 壳 Landing.vue，w5 接入）经 @taiji/ui 顶层 barrel 消费；
 * 壳层 provide NewTaskDepsKey（真 renderer 实现：flow 编排器 + workspace/worktree/preset RPC）。
 */
// 5 个跨端共享组件（C-NT-4：DirSelectPopover/BranchSelectPopover/CreateBranchModal/
// CreateWorktreeModal/PresetSelectChip；Landing.vue 留壳）
export { default as DirSelectPopover } from './DirSelectPopover.vue'
export { default as BranchSelectPopover } from './BranchSelectPopover.vue'
export { default as CreateBranchModal } from './CreateBranchModal.vue'
export { default as CreateWorktreeModal } from './CreateWorktreeModal.vue'
export { default as PresetSelectChip } from './PresetSelectChip.vue'
// deps inject token（C-W4-1/2：flow + workspace/worktree/preset RPC + toast）
export { NewTaskDepsKey, useNewTaskDeps } from './new-task-deps'
export type {
  NewTaskDeps,
  WorktreeBranchesReply,
  WorktreeCreateParams,
  WorktreeCreateReply,
  WorkspaceDetectReply,
  PickDirectoryResult,
} from './new-task-deps'
// 键盘导航 + path 纯函数（C-W4-3 归位 ui 包内部）
export { useFlatListNav } from './composables/useFlatListNav'
export type { FlatListNav, FlatListNavOptions } from './composables/useFlatListNav'
export { dirNameOf, parentDirNameOf } from './logic/path'
