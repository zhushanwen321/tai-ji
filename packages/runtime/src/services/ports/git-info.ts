/**
 * IGitInfoReader port —— session 摘要（branch / worktree 标记）查询的唯一 seam。
 *
 * 🔒 三层架构：services 定义 port，infra/system/git-info-reader.ts 实现门面；
 * 门面之下是 GitStateService 内建的 repo 观测器（services/git/repo-observer.ts，
 * branch / worktree / bare 判定单源单缓存），本 port 的读写全部打在观测器缓存上。
 * SessionService.toSummary / SessionScanner.scannedToSummary 经此 port 取 git 信息，
 * 不直接 spawn/exec / 读 .git 文件。
 *
 * 范式与 IGitExecutor（services/ports/git-executor.ts）对称，但语义不同——
 * - IGitExecutor：白名单 execFileSync 跑任意 git 子命令（status/add/commit/...），异步，不抛（非 0 原样返回）。
 * - IGitInfoReader：读 branch + worktree 标记的窄查询，同步（toSummary/scannedToSummary 是同步链）。
 * 两者合一会污染 IGitExecutor（同步性、.git 文件读取、缓存都不属于「跑 git 子命令」语义），故单列窄 port。
 *
 * 选「单列」而非「并入 IGitExecutor」的理由：
 * 1. 同步 vs 异步：readGitInfo 在 toSummary 同步链中被调用，必须同步返回；IGitExecutor.exec 是 async。
 * 2. worktree 判定读 .git 文件（node:fs），不是 git 子命令，不归 IGitExecutor「执行 git CLI」语义。
 * 3. 缓存是观测器域的关注点，放纯 exec seam 会污染 IGitExecutor 契约。
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
 * repo 观测器对单个 cwd 的一次解析产物（walk-up 一次向上遍历同时产出全部字段）。
 *
 * 字段语义：
 * - branch：`git rev-parse --abbrev-ref HEAD`（从 cwd 起算）解析的分支名；非仓库 / 未出生分支
 *   （无 HEAD commit）/ git 不可用 → undefined。detached HEAD → 'HEAD'（rev-parse 原生语义）。
 * - isWorktree：cwd 所在 repo 的 .git 是「文件且以 gitdir: 开头」（git worktree 形态）。
 * - isBare：walk-up 命中 .bare 目录（bare repo + worktree 约定布局，workspace 根下放 .bare）。
 *   与 isWorktree 可同时为 true（.bare workspace 下的 worktree 子目录——两套旧缓存的历史
 *   组合语义，门面按各自字段独立消费）。
 * - gitDir：walk-up 就近判定的 git 目录绝对路径。优先级：.git 目录 > .git 文件（worktree 取
 *   gitdir: 指向）> .bare 目录；三者皆无 → undefined。
 * - headPath：上述 gitDir 的 HEAD 文件绝对路径（观测器后续事件驱动的 watch 目标锚点）；
 *   无法定位（如 .git 文件指针读取失败）→ undefined。
 */
export interface RepoObservation {
  branch: string | undefined
  isWorktree: boolean
  isBare: boolean
  gitDir: string | undefined
  headPath: string | undefined
}

/**
 * 观测器的单次解析执行器 port（infra 实装：walk-up statSync/readFileSync + execSync rev-parse）。
 * 契约：绝不抛——任何 IO 失败按字段级降级（branch undefined / 布尔 false / 路径 undefined）。
 */
export interface IGitRepoResolver {
  resolve(cwd: string): RepoObservation
}

/**
 * repo 观测器 port：branch / worktree / bare 判定的单源缓存面（门面消费的只读 + 收缩面）。
 * 实现约束（services/git/repo-observer.ts）：
 * - readObservation 同步返回：命中缓存直接返回**同一对象引用**（只读契约，消费方不得 mutate）；
 *   miss 时惰性同步解析（resolver.resolve）并回填——热路径永不返回「待定」态。
 * - 缓存 per-cwd，TTL + 容量上界（沿用原 gitInfoCache/bareCache 的 5min/500 语义）。
 * - pruneCache：按现有活跃 cwd 集合清理不再引用或已过期的条目（原两套 prune 收缩后的唯一动作）。
 * 按 cwd 的写失效（invalidateCwd）不走本 port——那是 GitStateService 写操作钩子的内部耦合面。
 */
export interface IGitRepoObserver {
  readObservation(cwd: string): RepoObservation
  pruneCache(existingCwds: Set<string>): void
}

/**
 * git 信息读取 port（观测器之上的同步只读门面）。
 *
 * 实现约束（infra/system/git-info-reader.ts 门面）：
 * - readGitInfo 同步返回（GitInfo | undefined）：读观测器缓存并投影为旧形状；
 *   非 git 仓库 / branch 为空（含未出生分支）→ undefined（不抛，调用方留空字段）。
 * - pruneStaleCache：收缩动作打观测器单点（pruneCache），签名保留不变。
 */
export interface IGitInfoReader {
  /** 读 cwd 的 branch + worktree 标记（命中缓存或落盘查询）。非 git 仓库 → undefined。 */
  readGitInfo(cwd: string): GitInfo | undefined
  /** 清理 cwd 不再被引用、或 TTL 过期的缓存项。在每次列举 session 后调用。 */
  pruneStaleCache(existingCwds: Set<string>): void
}
