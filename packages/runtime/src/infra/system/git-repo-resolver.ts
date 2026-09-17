/**
 * IGitRepoResolver 的真实实现 —— walk-up 一次向上遍历同时产出 {isBare, gitDir, headPath}，
 * branch 经 execSync rev-parse（从 cwd 起算）解析。
 *
 * 🔒 三层架构：infra 实现（services 定义 port，见 services/ports/git-info.ts）。
 * 本模块是 repo 观测器（services/git/repo-observer.ts）的解析执行器，自身无缓存、无状态。
 *
 * 遍历规则（每级先 .git 后 .bare，两查独立记录、互不短路）：
 * - .git 目录 → 普通 repo 锚点（gitDir/headPath 落定，isWorktree=false）
 * - .git 文件且以 'gitdir:' 开头 → worktree 锚点（gitDir 取指针指向，isWorktree=true）
 * - .bare 目录 → isBare=true（bare repo + worktree 约定布局）；若此刻尚无 .git 锚点，
 *   gitDir/headPath 由 .bare 承接（workspace 根 cwd 的形态）
 * - .git 锚点落定后仍继续向上找 .bare：.bare workspace 下的 worktree 子目录两标记同时成立
 *   （与旧 bareCache 的 walk-up 语义一致，见 RepoObservation.isBare 注释）
 *
 * branch 始终从 cwd 起 execSync 解析（不在 walk-up 锚点目录起算）：rev-parse 与旧行为逐字段
 * 等价的唯一保真路径——git 自己向上找 repo 的规则覆盖「.bare 命中后遍历提前结束、但更上层
 * 还有普通 repo」的边界（该边界下旧 readGitInfoUncached 同样能解析出分支）。
 */
import { statSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import type { IGitRepoResolver, RepoObservation } from '../../services/ports/git-info.js'
import { buildOutboundChildEnv } from '../spawn-env.js'

const GIT_TIMEOUT_MS = 2000
const GITDIR_PREFIX = 'gitdir:'

export class GitRepoResolver implements IGitRepoResolver {
  resolve(cwd: string): RepoObservation {
    const walk = this.walkUp(cwd)
    return {
      branch: this.resolveBranch(cwd),
      isWorktree: walk.isWorktree,
      isBare: walk.isBare,
      gitDir: walk.gitDir,
      headPath: walk.headPath,
    }
  }

  /**
   * 向上逐级遍历到文件系统根（dirname 不再变化），同时判定 worktree 锚点与 .bare。
   * 任何 stat/read 失败按「该级不存在」继续向上，绝不抛。
   */
  private walkUp(cwd: string): Pick<RepoObservation, 'isWorktree' | 'isBare' | 'gitDir' | 'headPath'> {
    let gitAnchor: { isWorktree: boolean; gitDir: string; headPath: string | undefined } | undefined
    let dir = cwd
    while (true) {
      if (!gitAnchor) {
        gitAnchor = this.probeGitAnchor(dir)
      }
      if (this.probeBare(dir)) {
        const bareDir = join(dir, '.bare')
        return {
          isWorktree: gitAnchor?.isWorktree ?? false,
          isBare: true,
          gitDir: gitAnchor?.gitDir ?? bareDir,
          headPath: gitAnchor?.headPath ?? join(bareDir, 'HEAD'),
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (gitAnchor) {
      return { isWorktree: gitAnchor.isWorktree, isBare: false, gitDir: gitAnchor.gitDir, headPath: gitAnchor.headPath }
    }
    return { isWorktree: false, isBare: false, gitDir: undefined, headPath: undefined }
  }

  /** 探测 dir/.git：目录 → 普通 repo；文件且 gitdir: 前缀 → worktree（gitDir 取指针指向）。 */
  private probeGitAnchor(dir: string): { isWorktree: boolean; gitDir: string; headPath: string | undefined } | undefined {
    const gitPath = join(dir, '.git')
    let stat
    try {
      stat = statSync(gitPath)
    } catch {
      return undefined
    }
    if (stat.isDirectory()) {
      return { isWorktree: false, gitDir: gitPath, headPath: join(gitPath, 'HEAD') }
    }
    if (stat.isFile()) {
      const notWorktree: { isWorktree: boolean; gitDir: string; headPath: string | undefined } = {
        isWorktree: false,
        gitDir: gitPath,
        headPath: undefined,
      }
      try {
        const content = readFileSync(gitPath, 'utf-8')
        if (content.startsWith(GITDIR_PREFIX)) {
          // 指针可能为相对路径（相对 .git 文件所在目录），统一 resolve 成绝对路径
          const pointer = content.slice(GITDIR_PREFIX.length).trim()
          if (pointer) {
            const gitDir = resolve(dir, pointer)
            return { isWorktree: true, gitDir, headPath: join(gitDir, 'HEAD') }
          }
        }
        return notWorktree
      } catch {
        // 指针读失败（权限/IO）→ 按非 worktree 文件形态降级（与旧实现的读失败分支一致）
        return notWorktree
      }
    }
    return undefined
  }

  private probeBare(dir: string): boolean {
    try {
      return statSync(join(dir, '.bare')).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * branch 解析（与旧 readGitInfoUncached 逐字段等价）：execSync 'git rev-parse --abbrev-ref HEAD'
   * 从 cwd 起算；空输出 / 非 0 退出 / 超时 / git 不可用 → undefined。detached HEAD → 'HEAD'。
   */
  private resolveBranch(cwd: string): string | undefined {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        // C-proc-09：出站契约构建器组装 env（git 仅需 PATH/HOME，白名单基座保留）
        env: buildOutboundChildEnv({ parentEnv: process.env }),
      }).trim()
      return branch || undefined
    } catch {
      return undefined
    }
  }
}
