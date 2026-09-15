/**
 * IGitInfoReader port —— session 摘要（branch / worktree 标记）查询的唯一 seam。
 *
 * 🔒 三层架构：services 定义 port，infra/system/git-info-reader.ts 实现。
 * SessionService.toSummary / SessionScanner.scannedToSummary 经此 port 取 git 信息，
 * 不直接 spawn/exec / 读 .git 文件。
 *
 * 范式与 IGitExecutor（services/ports/git-executor.ts）对称，但语义不同——
 * - IGitExecutor：白名单 execFileSync 跑任意 git 子命令（status/add/commit/...），异步，不抛（非 0 原样返回）。
 * - IGitInfoReader：读 branch + worktree 标记的窄查询（rev-parse 查询 + 读 .git 文件判定 worktree），
 *   同步（toSummary/scannedToSummary 是同步链）、内置 TTL+LRU 缓存。
 * 两者合一会污染 IGitExecutor（同步性、.git 文件读取、缓存都不属于「跑 git 子命令」语义），故单列窄 port。
 *
 * 选「单列」而非「并入 IGitExecutor」的理由：
 * 1. 同步 vs 异步：readGitInfo 在 toSummary 同步链中被调用，必须同步返回；IGitExecutor.exec 是 async。
 * 2. worktree 判定读 .git 文件（node:fs），不是 git 子命令，不归 IGitExecutor「执行 git CLI」语义。
 * 3. 缓存（per-cwd TTL+LRU）是查询域的关注点，放纯 exec seam 会污染 IGitExecutor 契约。
 */

/**
 * git 分支 + worktree 标记。供 SessionSummary.gitBranch / gitIsWorktree 填充。
 * 非 git 仓库 / 查询失败时，整个返回 undefined（摘要字段留空）。
 */
export interface GitInfo {
  branch: string
  isWorktree: boolean
}

/**
 * git 信息读取 port。
 *
 * 实现约束（infra/system/git-info-reader.ts）：
 * - readGitInfo 同步返回（GitInfo | undefined）：execSync('git rev-parse --abbrev-ref HEAD') 取分支，
 *   statSync+readFileSync 读 .git 文件判定 worktree（文件 + 以 'gitdir:' 开头）。
 * - 内置 per-cwd 缓存（TTL + LRU 上限）：toSummary 在每次 listPersistedSessions 对每个 session 调用，
 *   无缓存则 10 个 session = 10 次 execSync spawn。
 * - 非 git 仓库 / 超时 / git 不可用 → 返回 undefined（不抛，调用方留空字段）。
 * - pruneStaleCache：按现有活跃 cwd 集合清理已失效缓存项（session 被删后其 cwd 不再被任何 session 引用）。
 */
export interface IGitInfoReader {
  /** 读 cwd 的 branch + worktree 标记（命中缓存或落盘查询）。非 git 仓库 → undefined。 */
  readGitInfo(cwd: string): GitInfo | undefined
  /** 清理 cwd 不再被引用、或 TTL 过期的缓存项。在每次列举 session 后调用。 */
  pruneStaleCache(existingCwds: Set<string>): void
}
