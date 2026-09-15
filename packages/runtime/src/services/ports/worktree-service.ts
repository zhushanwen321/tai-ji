/**
 * IWorktreeService port —— worktree 创建/列举的领域编排契约（W2 升级）。
 *
 * 🔒 三层层架构：services 定义 port，services/worktree/worktree-service.ts 实现。
 * WorktreeMessageHandler 经此 port 调用方法，不直接依赖具体 WorktreeService。
 *
 * 编排职责（实现侧 WorktreeService）：
 * 1. 经 WorkspaceDetector 检测 .bare / plain-repo / not-repo 三态
 * 2. create: 经 IGitExecutor 跑 `git worktree add`（白名单含 'worktree'）
 * 3. listBranches: 经 IGitExecutor 跑 `git branch --list` 获取分支列表
 * 4. list: 经 IGitExecutor 跑 `git worktree list --porcelain` 获取 worktree 列表
 * 5. 经 IShellRunner 跑可选的 setup 脚本（npm install / git hooks 等）
 *
 * 错误对象统一用 `Object.assign(new Error(msg), { code, detail })` 模式——
 * 测试用 toMatchObject 断言 code/detail，故错误必须是普通 Error + 附加字段（非 class 实例）。
 * 这与 GitError/FileError 的 class 模式不同，是 WorktreeService 的刻意选择：
 * worktree 错误码（NOT_BARE_REPO / WORKTREE_EXISTS / SETUP_FAILED）只在本域消费，
 * 无需跨层 instanceof 判定，扁平字段更利于测试断言。
 */

/** workspace 检测结果（三态）。对齐 WorkspaceDetectResult。 */
export interface WorkspaceDetectResult {
  mode: 'bare-workspace' | 'plain-repo' | 'not-repo'
  wsRoot: string
  barePath: string
  repoRoot: string
  defaultBranch: string
}

/** worktree 创建参数。 */
export interface WorktreeCreateParams {
  /** 新分支名（如 'feat/oauth'）。目录名由其派生（/ → -）。 */
  branch: string
  /** 基分支：'current'（继承当前分支，默认）/ 'origin/main'（校验远端 ref 存在后使用）/ 任意分支名。 */
  baseBranch?: string
  /** worktree 创建位置模式。省略时 bare 模式默认 'workspace'，plain-repo 默认 'dedicated-dir'。 */
  locationMode?: 'workspace' | 'repo-dir' | 'dedicated-dir'
  /** workspace 检测起点 cwd（缺省用 process.cwd()）。前端发起时显式传入。 */
  workspaceHint?: string
}

/** worktree 创建结果。 */
export interface WorktreeCreateResult {
  /** 新 worktree 的绝对路径（cwd）。 */
  cwd: string
  /** 新分支名（与入参一致，原始分支名含斜杠）。 */
  branch: string
}

/** 分支列表结果。 */
export interface WorktreeBranchListResult {
  /** 本地分支名列表。 */
  local: string[]
  /** 远程分支名列表（origin/*）。 */
  remote: string[]
  /** 默认分支名（如 'main'）。检测不到则为空串。 */
  defaultBranch: string
}

/** 单个 worktree 条目。 */
export interface WorktreeListItem {
  /** worktree 绝对路径。 */
  path: string
  /** 关联的分支名。 */
  branch: string
  /** 是否为当前 HEAD 指向的 worktree。 */
  HEAD: boolean
  /** 是否为 bare repo（.bare 本身）。 */
  bare: boolean
}

/** worktree 列举结果。 */
export interface WorktreeListResult {
  items: WorktreeListItem[]
}

/**
 * worktree 创建 port。
 *
 * 失败模式（实现抛 Object.assign 错误）：
 * - NOT_BARE_REPO：当前 cwd 不在 bare repo + worktree 结构下（bare-workspace 模式专属）
 * - NOT_GIT_REPO：cwd 既不是 bare workspace 也不是普通 git 仓库
 * - WORKTREE_EXISTS：目标 worktree 目录已存在。detail = { cwd, dirName }，
 *   前端可核对 dirName 是否与当前请求分支一致——区分「同分支已存在」与
 *   「另一分支名映射同目录碰撞」（feat/a 与 feat-a 映射同目录）。
 * - GIT_FAILED：git worktree add 失败（exitCode 非 0）
 * - SETUP_FAILED：setup-worktree.sh 失败（exitCode 非 0），detail 含 exitCode + stderr
 */
export interface IWorktreeService {
  create(params: WorktreeCreateParams): Promise<WorktreeCreateResult>
  /** 检测 cwd 所在仓库的三态模式。 */
  detect(cwd: string): Promise<WorkspaceDetectResult>
  /** 列出 cwd 所在仓库的本地/远程分支。 */
  listBranches(cwd: string): Promise<WorktreeBranchListResult>
  /** 列出 cwd 所在 workspace 的所有 worktree。 */
  list(cwd: string): Promise<WorktreeListResult>
}
