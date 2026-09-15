/**
 * useNewTaskDeps —— NewTaskDeps 12 字段壳构造（new-task-search 域 w5）。
 *
 * ui 包 new-task 组件（w4 迁入）经 NewTaskDepsKey inject 消费壳层依赖。本 composable
 * 把 renderer 真实现适配组装（对齐 new-task-deps.ts 契约注释的 12 字段映射），
 * Landing.vue setup 调本函数 + provide(NewTaskDepsKey, deps)。
 *
 * 关键约束：
 * - Ref 字段（recentWorkspaces/presets/defaultPresetId/presetOpenRequest）必须经
 *   storeToRefs 取 Ref（pinia store 直接访问会解包成值，丢失响应式派生链）。
 * - pickDirectory 适配 path:null → undefined（ui 包 PickDirectoryResult.path 是
 *   string|undefined；lib/ipc 返回 string|null）。
 * - flow = 壳 useNewTaskFlow()（core 实例，与 useSidebar 共享）。
 */
import { storeToRefs } from 'pinia'
import type { NewTaskDeps } from '@taiji/ui'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useWorkspaceStore } from '@/stores/workspace'
import { usePresetStore } from '@/stores/preset'
import { usePiPresets } from '@/composables/features/settings/usePiPresets'
import { useToast } from '@/composables/useToast'
import { workspace as workspaceApi } from '@/api'
import { worktreeApi } from '@taiji/core/transport/api/domains/worktree'
import { pickDirectory as ipcPickDirectory } from '@/lib/ipc'

export function useNewTaskDeps(): NewTaskDeps {
  const workspaceStore = useWorkspaceStore()
  const presetStore = usePresetStore()
  const presetActions = usePiPresets()
  const { error: toastError } = useToast()
  const flow = useNewTaskFlow()
  // Ref 响应式：storeToRefs 取 ref 引用（直接 store.records 会被 pinia 解包成数组）
  const { records } = storeToRefs(workspaceStore)
  const { presets, defaultPresetId, openRequest } = storeToRefs(presetStore)
  return {
    flow,
    recentWorkspaces: records,
    listBranches: worktreeApi.listBranches,
    createWorktree: worktreeApi.create,
    detectWorkspace: workspaceApi.detect,
    // path:null → undefined（PickDirectoryResult 契约）
    pickDirectory: (opts) =>
      ipcPickDirectory(opts).then((r) => ({ canceled: r.canceled, path: r.path ?? undefined })),
    presets,
    defaultPresetId,
    presetOpenRequest: openRequest,
    loadPresets: () => presetActions.loadPresets(),
    setDefaultPreset: (presetId) => presetActions.setDefault(presetId),
    toast: { error: toastError },
  }
}
