/**
 * NewTaskFlowPorts —— new-task 编排器跨域端口集（IF4，TC1，C-NT-2 裁决落点）。
 *
 * 端口注入模式（对齐 domain/session 的 SessionApiPort/PanelOrchestrationPort 先例）：
 * core 定义接口契约，壳层（renderer）把现 api/stores/composables 适配注入。
 * core 不 import @/api / @/stores / @/composables / @/i18n（D4 包级单向铁律 + TC1）。
 *
 * 裁决标注：
 * - C-NT-2：编排器全部跨域依赖收敛为构造注入端口（SessionFlowPort/ChatSendPort/
 *   NavigationPanelPort/ToastPort/FileTreePort/TranslatePort/ImageMigratePort +
 *   GitApiPort/DirectoryPickerPort/WorkspaceApiPort/WorkspaceStatePort）
 * - C-SS-2：session 创建编排经 SessionFlowPort.createSession 承接（[已废除 2026-09 D5]
 *   post-create applyModel / setThinkingLevel 双通道已删——override 经 create 快照化一次到位）
 * - D8：Electron 直连收编——pickDirectory（lib/ipc）经 DirectoryPickerPort、
 *   workspace/worktree API 经 WorkspaceApiPort、useWorkspaceStore 经 WorkspaceStatePort
 * - IF4 契约：SessionFlowPort 契约对齐 domain/session/createSessionFlow
 *   （cwd/presetId/pendingModel/segments/bashCommand → {session, migratedSegments} | null，
 *   含 INV-7 cwd 降级比对 + migrateImages）
 */
import type { Segment } from '@taiji/shared'
// AC10 跨域铁律：session 域经 '@taiji/core/domain/session' 公开 index API 消费（禁内部模块相对路径）
import type {
  CreateSessionFlowInput,
  CreateSessionFlowResult,
} from '@taiji/core/domain/session'

/**
 * session 生命周期端口（壳适配 renderer useNewTaskFlow 的 createSessionFlow(ctx, input) 调用）。
 * - createSession：session 创建全编排（guard→cwd 兜底→label 派生→create→INV-7 降级→
 *   appendSession→migrateImages），返回 null = 空 content guard 命中（未创建）。
 *   壳实现：core domain/session createSessionFlow(ctx, input) 包一层（ctx 的 store/api/
 *   defaultCwd/onCwdFallback 由壳组装——store 是壳持有的 createSessionStore 实例）。
 * - [已删 2026-09 D5] setThinkingLevel 方法已随契约快照化删除——landing 恒传解析终值，
 *   post-create 补 apply 是同值二次 RPC。
 */
export interface SessionFlowPort {
  createSession(input: CreateSessionFlowInput): Promise<CreateSessionFlowResult | null>
}

/** chat 发送端口（壳适配 useChat().send / useChat().sendBash）。 */
export interface ChatSendPort {
  /** 普通发送（segments 结构化段；壳适配 useChat().send） */
  send(sessionId: string, segments: Segment[]): Promise<void>
  /** bash 首发（landing 态 !/!! 前缀；壳适配 useChat().sendBash，不经 LLM turn） */
  sendBash(sessionId: string, command: string, excludeFromContext: boolean): Promise<void>
}

/**
 * panel/navigation/workspace 编排端口（壳适配 useSessionStore/usePanelStore/
 * useNavigationStore/useWorkspaceStore）。
 * 相对 IF4 字面签名扩展（clarify Q3）：activePanelId/clearActiveSession/setActiveSession——
 * startFlow 不变量（activeId 清空 + loadPanel(null)）与 submitFirstMessage 成功
 * （activeId=sid）是源 useNewTaskFlow.ts 既有语义（session.activeId = null / = id）。
 */
export interface NavigationPanelPort {
  /** 当前活跃 panel id（loadPanel 目标；壳适配 usePanelStore().activePanelId） */
  activePanelId(): string | null
  /** 让指定 panel 载入 session（loadPanel(panelId, null) 解绑；壳适配 panel.loadSession；panelId null = 无活跃 panel 时 noop） */
  loadPanel(panelId: string | null, sessionId: string | null): void
  /** 清空全局 active session id（startFlow 不变量；壳适配 session.activeId = null） */
  clearActiveSession(): void
  /** 设置全局 active session id（submitFirstMessage 成功；壳适配 session.activeId = sid） */
  setActiveSession(sessionId: string): void
  /** 导航到 chat 视图（壳适配 navigation.push({ view: 'chat', sessionId })） */
  pushChat(sessionId: string): void
  /** 默认 cwd（壳适配 workspaceStore.defaultCwd ?? null） */
  defaultCwd(): string | null
}

/** toast 端口（壳适配 useToast().error / useToast().warning）。 */
export interface ToastPort {
  error(msg: string): void
  warning(msg: string): void
}

/** 文件树端口（壳适配 useFileTree().loadTree / useFileTreeStore().selectFile）。 */
export interface FileTreePort {
  /** 加载 session 文件树（fire-and-forget 语义由调用方保留）。 */
  loadTree(sessionId: string): Promise<void>
  /** 选中文件（search-jump file 分支：selectFile(path) 触发 useDetailPane watch 链渲染；壳适配 fileTreeStore.selectFile） */
  selectFile(path: string | null): void
}

/** 域内文案端口（TC3；壳适配 renderer i18n.global.t）。 */
export interface TranslatePort {
  t(key: string, params?: Record<string, unknown>): string
}

/** git 分支操作端口（壳适配 @/api git domain）。 */
export interface GitApiPort {
  /** 已建 session 分支切换（git.checkout RPC） */
  checkout(sessionId: string, name: string): Promise<void>
  /** landing 态（无 session）直接对 cwd 切分支（git.checkoutByCwd RPC，plain-repo 模式） */
  checkoutByCwd(cwd: string, name: string): Promise<void>
  /** 创建并检出分支（git.createBranch RPC） */
  createBranch(sessionId: string, name: string): Promise<void>
}

/**
 * OS 原生目录选择器端口（D8 收编 lib/ipc 的 Electron 直连）。
 * 壳适配 renderer lib/ipc pickDirectory（electronAPI IPC bridge）。
 * 返回 { canceled, path }：canceled=true 表示用户取消（无 path）。
 */
export interface DirectoryPickerPort {
  pickDirectory(p?: { defaultPath?: string }): Promise<{ canceled: boolean; path?: string | null }>
}

/** workspace 三态模式（对齐 shared protocol workspace.detected 的 mode 字段）。 */
export type WorkspaceMode = 'bare-workspace' | 'plain-repo' | 'not-repo'

/** workspace.detect 的 reply（core 域内自声明，对齐 shared protocol workspace.detected）。 */
export interface WorkspaceDetectReply {
  mode: WorkspaceMode
}

/** worktree.list 的 reply（core 域内自声明，对齐 shared protocol worktree.list:result）。 */
export interface WorktreeListReply {
  items: Array<{ path: string; branch: string; HEAD: boolean; bare: boolean }>
}

/** workspace/worktree 后端端口（壳适配 @/api workspace + worktree domains）。 */
export interface WorkspaceApiPort {
  /** 检测 cwd 所在 git 仓库模式（workspace.detect RPC） */
  detect(cwd: string): Promise<WorkspaceDetectReply>
  /** 列出 cwd 所在 workspace 的所有 worktree（worktree.list RPC；非 bare repo 可能失败） */
  listWorktrees(cwd: string): Promise<WorktreeListReply>
}

/**
 * workspace store 状态端口（壳适配 useWorkspaceStore）。
 * 相对 IF4 字面签名扩展（clarify Q4）：record——源 selectWorkspace/openDirDialog 的
 * workspaceStore.record(cwd) 热更新最近工作区列表（fire-and-forget，失败静默降级）。
 */
export interface WorkspaceStatePort {
  /** 默认 cwd（records[0]?.cwd；壳适配 workspaceStore.defaultCwd ?? null） */
  defaultCwd(): string | null
  /** 记录一次工作区使用（热更新最近工作区列表；壳适配 workspaceStore.record） */
  record(cwd: string): Promise<void>
}

/**
 * tmpdir 图片迁移端口（retry/预建分支专用——session 已存在不调 createSessionFlow，
 * landing 态新贴的 needsMigrate image 段需迁移到 attachments/<sessionId>/）。
 * 签名对齐 SessionApiPort.migrateImage（C-W4-1）：{fromPath, sessionId, fileName} → {path}。
 * 壳适配 sessionApi.migrateImage。
 */
export interface ImageMigratePort {
  migrateImage(p: { fromPath: string; sessionId: string; fileName: string }): Promise<{ path: string }>
}

/** useNewTaskFlow 编排器的全部注入依赖（IF5 deps）。 */
export interface NewTaskFlowDeps {
  /** 跨域编排端口集（session 生命周期 / chat / panel-navigation / toast / fileTree / i18n / image 迁移） */
  ports: {
    createSessionFlow: SessionFlowPort
    chat: ChatSendPort
    navigation: NavigationPanelPort
    toast: ToastPort
    fileTree: FileTreePort
    t: TranslatePort['t']
    migrateImage: ImageMigratePort
  }
  /** git 分支操作（branch 子编排器注入） */
  gitApi: GitApiPort
  /** OS 目录选择器（dir-select 子编排器注入） */
  directoryPicker: DirectoryPickerPort
  /** workspace/worktree 后端（dir-select 子编排器注入） */
  workspaceApi: WorkspaceApiPort
  /** workspace store 状态（dir-select 子编排器注入） */
  workspaceState: WorkspaceStatePort
}
