/**
 * Git 域 port —— git CLI 执行的唯一 seam。
 *
 * 🔒 三层架构：services 定义 port，infra/git-executor.ts 实现（execFile 异步、数组参数防注入）。
 * GitService 经此 port 执行 git 子命令，不直接 spawn/exec。
 *
 * **白名单 = GitCommand 联合类型本身**。exec 只接受这些 git 子命令；
 * 其余参数（路径/message）由 GitService 以数组元素传入，经 execFile 数组形式执行，
 * 不经 shell，杜绝命令注入（spec-w11 G-R2-05）。
 */
import type { GitFileStatus } from '@taiji/shared'

/**
 * 允许执行的 git 子命令（白名单）。
 * - status / diff / rev-parse：只读查询（status 用于全量状态、diff --numstat 取行数、rev-parse 验仓库）
 * - add / reset：暂存/取消暂存
 * - commit：提交
 * - checkout：切换分支（#6 `checkout <name>`）/ 创建并检出分支（#7 `checkout -b <name>`），共用白名单项
 * - branch：只读列举分支（#6 选分支 popover 数据源，`branch --list --format`）
 * - worktree：worktree 管理（W1 `worktree add <path> -b <branch> <base>`，bare repo + worktree 结构创建隔离工作目录）
 *
 * 路径/message/分支名 作为 args 数组元素传入（如 ['--', 'src/a.ts']、['-m', 'msg']、['main']），
 * 由 GitService 保证语义正确，executor 只负责以数组形式交给 execFile。
 */
export type GitCommand = 'status' | 'add' | 'reset' | 'commit' | 'diff' | 'rev-parse' | 'checkout' | 'branch' | 'worktree'

/** IGitExecutor.exec 的返回。exitCode 非 0 时 GitService 按 stderr 判定失败类型。 */
export interface GitExecutorResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** exec 的可选执行参数。timeoutMs 覆盖实现默认超时（git-executor 默认 8000ms）。 */
export interface GitExecOptions {
  timeoutMs?: number
}

/**
 * git CLI 执行 port。
 *
 * 实现约束（infra/git-executor.ts）：
 * - 必须用 `child_process.execFile('git', [command, ...(args ?? [])], { cwd, encoding:'utf8' })`
 *   （异步——execFile 不阻塞事件循环；数组参数不经 shell）
 * - 禁止 exec/spawn 拼接 shell 字符串（§6.4 grep 防注入）
 * - 设 timeout 防大仓库卡死（spec-w11 G-R2-05）；调用方可经 opts.timeoutMs 收紧
 *   （GitStateService 的 snapshotStatus/numstat 按 03-git-state-service D3-1 定案用 5000ms）
 * - exitCode 非 0 时**不抛**，原样返回 {exitCode, stderr}，由 GitService 按语义判定（如非 git 仓库 vs 冲突）
 */
export interface IGitExecutor {
  exec(cwd: string, command: GitCommand, args?: string[], opts?: GitExecOptions): Promise<GitExecutorResult>
}

/**
 * git 不可用 / 超时时抛出。属 port 契约的一部分（executor 的失败分类），
 * 由 infra/git-executor.ts 在实现中 throw，GitService 捕获后按语义判定（getStatus 降级 / 写操作转 GitError）。
 * 定义在 port 层，避免 services 直接 import infra 造成分层泄漏（D1）。
 */
export class GitExecutorError extends Error {
  readonly code: 'git_unavailable' | 'timeout'
  constructor(code: 'git_unavailable' | 'timeout', message: string) {
    super(message)
    this.name = 'GitExecutorError'
    this.code = code
  }
}

// ── 复用 shared 类型，供 GitService / parser 之间传递 ───────────────
export type { GitFileStatus }
