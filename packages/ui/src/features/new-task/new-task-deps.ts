/**
 * NewTaskDeps —— ui 包 new-task 组件消费壳层依赖的唯一契约（w4 new-task-search UI 迁移）。
 *
 * ui 包展示组件不直接 import renderer store/api/composable（反向依赖禁令，CT-1），
 * 所有跨层依赖（workspace store 数据 / worktree RPC / 预设 store + RPC / IPC 目录选择 /
 * flow 编排器 / toast）经此 inject token 注入。renderer 壳层（Landing.vue，w5 接入）
 * provide 真 renderer 实现。
 *
 * 设计依据：C-W4-1 inject token 裁决（对齐 settings injection-keys / composer
 * ComposerInputDeps / chat ChatViewDeps 三个先例）；C-W4-2 flow 编排器实例经本 deps 注入
 * （core useNewTaskFlow 返回类型，组件内不 import renderer）。
 */
import type { InjectionKey, Ref } from 'vue'
import { inject } from 'vue'
import type {
  ClientMessageMap,
  PiLaunchPreset,
  RecentWorkspaceRecord,
  ServerMessageMap,
} from '@taiji/shared'
import type { useNewTaskFlow } from '@taiji/core'

/** worktree.listBranches reply 类型（shared 协议派生，与 renderer api/domains/worktree 同源）。 */
export type WorktreeBranchesReply = ServerMessageMap['worktree.branches']
/** worktree.create 请求参数类型（shared 协议派生）。 */
export type WorktreeCreateParams = ClientMessageMap['worktree.create']
/** worktree.create 成功 reply 类型（shared 协议派生）。 */
export type WorktreeCreateReply = ServerMessageMap['worktree.created']
/** workspace.detect reply 类型（shared 协议派生）。 */
export type WorkspaceDetectReply = ServerMessageMap['workspace.detected']
/** 目录选择结果（壳适配 lib/ipc pickDirectory）。 */
export interface PickDirectoryResult {
  canceled: boolean
  path?: string
}

/**
 * NewTask 组件依赖端口（shell → ui 展示层注入）。
 *
 * 字段分组：
 * - flow：core 编排器实例（w5 壳 Landing 构造 useNewTaskFlow(deps) 后 provide）
 * - 目录/分支/worktree RPC：worktreeApi / workspace.detect / lib/ipc 适配
 * - 预设：presetStore 响应式数据 + usePiPresets 动作适配
 * - toast：useToast().error 适配
 */
export interface NewTaskDeps {
  /** flow 编排器（core useNewTaskFlow 返回；CreateBranchModal/CreateWorktreeModal 消费） */
  flow: ReturnType<typeof useNewTaskFlow>
  /** 最近工作区列表（壳适配 workspaceStore.records，Ref 保持响应式） */
  recentWorkspaces: Ref<RecentWorkspaceRecord[]>
  /** 列出 cwd 仓库分支（壳适配 worktreeApi.listBranches） */
  listBranches: (cwd: string) => Promise<WorktreeBranchesReply>
  /** 创建 worktree（壳适配 worktreeApi.create） */
  createWorktree: (params: WorktreeCreateParams) => Promise<WorktreeCreateReply>
  /** workspace 检测（壳适配 api/domains/workspace detect） */
  detectWorkspace: (cwd: string) => Promise<WorkspaceDetectReply>
  /** 目录选择（壳适配 lib/ipc pickDirectory，D8 IPC 收编） */
  pickDirectory: (options?: { defaultPath?: string }) => Promise<PickDirectoryResult>
  /** 预设列表（壳适配 presetStore.presets，Ref 保持响应式） */
  presets: Ref<PiLaunchPreset[]>
  /** 全局默认预设 id（壳适配 presetStore.defaultPresetId） */
  defaultPresetId: Ref<string>
  /** 快捷键打开请求计数（壳适配 presetStore.openRequest，watch 触发打开） */
  presetOpenRequest: Ref<number>
  /** 拉取预设列表 + 默认预设写 store（壳适配 usePiPresets().loadPresets） */
  loadPresets: () => Promise<void>
  /** 设为全局默认（壳适配 usePiPresets().setDefault） */
  setDefaultPreset: (presetId: string) => Promise<void>
  /** toast 通知（壳适配 useToast().error） */
  toast: { error: (message: string) => void }
}

/** NewTaskDeps inject token（InjectionKey 保类型安全） */
export const NewTaskDepsKey: InjectionKey<NewTaskDeps> = Symbol('NewTaskDeps')

/**
 * inject NewTaskDeps helper。token 缺失时抛错（防运行时 undefined 调用崩溃）。
 * ui 组件 setup 顶部调 const deps = useNewTaskDeps()。
 * 测试必须 provide NewTaskDepsKey（缺失即显式失败，对齐 ComposerInputDeps 抛错先例）。
 */
export function useNewTaskDeps(): NewTaskDeps {
  const deps = inject(NewTaskDepsKey)
  if (!deps) {
    throw new Error(
      '[NewTaskDeps] inject 缺失：组件必须在 provide NewTaskDepsKey 的容器内渲染。' +
        'renderer 壳层 Landing.vue 应 provide(NewTaskDepsKey, realDeps)。',
    )
  }
  return deps
}
