/**
 * dir-select —— 工作区目录选择 + OS 原生对话框编排（core 域迁移版，IF4）。
 *
 * [归位] 迁自 renderer composables/new-task/useNewTaskDirSelect.ts（160 行），语义逐条等价。
 * pickDirectory（lib/ipc Electron 直连，D8 收编）经 DirectoryPickerPort 注入；
 * workspaceApi/worktreeApi 经 WorkspaceApiPort 注入；useWorkspaceStore 经 WorkspaceStatePort 注入。
 *
 * 职责（§4.2，延迟 create 语义）：
 * - openDirPopover：landing→dir-popover（overlay 互斥：已开 branch-popover 先归 landing）。
 * - selectWorkspace：dir-popover 选已有 workspace（记 pendingCwd，不 create session）。
 * - openDirDialog：打开 OS 目录选择器（pickDirectory），选中记 pendingCwd；取消落回 dir-popover。
 *
 * 不含：状态机定义/转换表（在 flow-state）、分支操作（在 branch）、
 * 发送/创建 session 编排（在 flow）。
 *
 * 依赖方向：DirectoryPickerPort/WorkspaceApiPort/WorkspaceStatePort（注入）+ flow-state
 * （transition + openOverlay + refs）。core 零跨包 import。
 */
import { ref, watch } from 'vue'
import { transition, openOverlay, useNewTaskFlowState } from './flow-state'
import type {
  DirectoryPickerPort,
  WorkspaceApiPort,
  WorkspaceMode,
  WorkspaceStatePort,
  WorktreeListReply,
} from './ports'

/**
 * @param deps dir-select 的外部依赖端口集（DirectoryPicker/WorkspaceApi/WorkspaceState）
 * @param currentCwd 当前 flow 的 cwd（chip 回灌判定：cwd 未变则 noop 仅关 popover）
 */
export function useNewTaskDirSelect(
  deps: {
    directoryPicker: DirectoryPickerPort
    workspaceApi: WorkspaceApiPort
    workspaceState: WorkspaceStatePort
  },
  currentCwd: () => string | null,
): {
  openDirPopover: () => void
  selectWorkspace: (cwd: string) => Promise<void>
  openDirDialog: () => Promise<void>
  openWorktreeModal: () => void
  isBare: ReturnType<typeof ref<boolean>>
  mode: ReturnType<typeof ref<WorkspaceMode>>
  worktreeItems: ReturnType<typeof ref<WorktreeListReply['items']>>
} {
  const { directoryPicker, workspaceApi, workspaceState } = deps
  const { pendingCwd } = useNewTaskFlowState()

  /**
   * isBare —— landing 态 bare workspace 检测结果（W2）。
   *
   * 旧实现 Landing.vue 读 gitInfo.isBare（依赖已绑定 session），延迟 create 架构下 landing 无 session
   * → gitInfo 恒 null → isBare 恒 false → 「新建 worktree」按钮永不显示。改由 pendingCwd 驱动：
   * watch pendingCwd 变化时调 workspace.detectBare(cwd)（runtime WorkspaceDetector 检测 .bare 命中），
   * 结果回填本 ref。pendingCwd=null 兜底 false（不调 RPC）。检测失败静默降级 false（不阻断选目录流程）。
   */
  const isBare = ref(false)
  /** workspace 三态模式（bare-workspace / plain-repo / not-repo）。pendingCwd 驱动。 */
  const mode = ref<WorkspaceMode>('not-repo')
  /** 当前 cwd 所在 workspace 的已有 worktree 列表。pendingCwd 驱动。 */
  const worktreeItems = ref<WorktreeListReply['items']>([])

  watch(
    () => currentCwd(),
    async (cwd) => {
      if (!cwd) {
        isBare.value = false
        mode.value = 'not-repo'
        worktreeItems.value = []
        return
      }
      // 并行加载 workspace detect + worktree list（独立数据源用 allSettled）
      const [detectResult, listResult] = await Promise.allSettled([
        workspaceApi.detect(cwd),
        workspaceApi.listWorktrees(cwd),
      ])
      if (detectResult.status === 'fulfilled') {
        mode.value = detectResult.value.mode
        isBare.value = detectResult.value.mode === 'bare-workspace'
      } else {
        mode.value = 'not-repo'
        isBare.value = false
      }
      // worktree.list 在非 bare repo 下可能失败（NOT_BARE_REPO），静默降级空列表
      worktreeItems.value =
        listResult.status === 'fulfilled' ? listResult.value.items : []
    },
    { immediate: true },
  )

  /**
   * landing→dir-popover（点 directory chip）。
   * overlay 互斥由 openOverlay 统一处理（已开任意 overlay 时先归 landing 再开 dir-popover）。
   */
  function openDirPopover(): void {
    openOverlay('dir-popover')
  }

  /**
   * openWorktreeModal —— 点「新建 worktree…」动作项打开 CreateWorktreeModal（W2 wave）。
   *
   * 来源态：dir-popover（DirSelectPopover 动作项）。overlay 互斥由 openOverlay 统一处理。
   * landing→worktree-modal 在 ALLOWED 表内合法，状态变更统一走守卫表。
   * CreateWorktreeModal 由 Landing 按 state==='worktree-modal' 挂载，内部自管五态机。
   */
  function openWorktreeModal(): void {
    openOverlay('worktree-modal')
  }

  /**
   * selectWorkspace —— dir-popover 选已有 workspace（§4.2）。
   *
   * 延迟 create：选目录只记 pendingCwd（chip 回灌所见即所得），不 create session。
   * session 由首发提交 submitFirstMessage 创建。slash 浮层在 landing 态用 config.skills
   * 全局扫描结果（CommandPopover 双源），不再依赖预建 session 取真实命令。
   * - cwd 未变→noop（仅关 popover）
   * - cwd 变→记 pendingCwd + 关 popover
   */
  async function selectWorkspace(cwd: string): Promise<void> {
    if (cwd === currentCwd()) {
      transition('landing') // dir-popover→landing（关 popover）
      return
    }
    pendingCwd.value = cwd
    transition('landing') // dir-popover→landing（关 popover，chip 回灌新 cwd）
    // 热更新最近工作区列表：选中后 record 写入 runtime，刷新后的 records 回补 store，
    // 下次打开 popover 即可见（无需重启）。失败静默降级（不阻断选目录流程）。
    void workspaceState.record(cwd)
  }

  /**
   * openDirDialog —— 打开 OS 目录选择器（§4.2）。
   *
   * 延迟 create：选中目录只记 pendingCwd，不 create session（同 selectWorkspace 语义）。
   * 选中→记 pendingCwd + landing；取消→落回 dir-popover（AC-5.3）。
   * E5 IPC 招错→落回 dir-popover + 向上抛（调用方接 toast，AC-5.6）。
   */
  async function openDirDialog(): Promise<void> {
    transition('dir-dialog') // dir-popover→dir-dialog
    try {
      // defaultPath 候选 = 当前 cwd（chip 回灌值）。主进程 existsSync 守卫：存在则定位到该目录，
      // 不存在（目录被删）则回退 ~。避免 macOS 原生 dialog 在记忆位置失效时回退到 Documents。
      const result = await directoryPicker.pickDirectory({
        defaultPath: currentCwd() ?? undefined,
      })
      if (result.canceled || !result.path) {
        transition('dir-popover') // 取消落回（AC-5.3）
        return
      }
      pendingCwd.value = result.path
      transition('landing') // dir-dialog→landing（chip 回灌新 cwd）
      // 热更新（同 selectWorkspace）：选中后 record 刷新列表，下次打开即可见
      void workspaceState.record(result.path)
    } catch (e) {
      // E5：IPC 招错 → 落回 dir-popover + 重抛（调用方显错 toast），不卡 dir-dialog
      transition('dir-popover')
      throw e
    }
  }

  return {
    openDirPopover,
    selectWorkspace,
    openDirDialog,
    openWorktreeModal,
    isBare,
    mode,
    worktreeItems,
  }
}
