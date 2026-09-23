/**
 * WorkspaceDetector —— git 仓库/workspace 根检测（W2 三态升级）。
 *
 * detect() 返回三态：
 * - bare-workspace：cwd 在 .bare workspace 内（找到 .bare 目录）
 * - plain-repo：cwd 在普通 git 仓库内（git rev-parse --show-toplevel 成功但无 .bare）
 * - not-repo：既不是 bare workspace 也不是 git 仓库
 *
 * 向后兼容：detectBareWorkspaceCached 保持返回 boolean（isBareMode），不影响 session 摘要链路。
 *
 * 🔒 三层架构：本类属 service 域工具（被 WorktreeService 编排），fs + gitExecutor 经构造函数注入。
 * 不直接 import 'node:fs' / spawn git，而是接受注入对象。production 由 index.ts 传真实实现，
 * 测试传 mock。
 *
 * .bare 是 bare repo + worktree 约定俗成的目录名（与 create-worktree skill / remove-worktree
 * skill 一致）：workspace 根下放 .bare（bare repo）+ 各 worktree 子目录（feat-x / fix-y ...）。
 *
 * detectBareWorkspaceCached：session 摘要链路（toSummary / scannedToSummary）复用的门面版本。
 * 缓存治理批 4 U10：bare 判定并入 GitStateService 内建的 repo 观测器（walk-up 一次遍历同时
 * 产出 branch/worktree/bare），本函数降级为观测器之上的同步只读门面，与 readGitInfo 共享
 * 同一份缓存（getSharedRepoObserver() 生产单例）。失败兜底 false，绝不传播异常——
 * session 摘要生成不能因 workspace 检测失败而中断。
 */
import { join, dirname } from 'node:path'
import { getSharedRepoObserver } from '../git/repo-observer.js'

/** statSync 函数类型（仅本类用到的方法子集，与 node:fs.statSync 兼容）。 */
export interface FsLike {
  statSync: (path: string) => { isDirectory: () => boolean }
}

/** git rev-parse 执行器（仅本类用到的方法子集）。 */
export interface GitRevParser {
  /** 执行 `git -C cwd rev-parse --show-toplevel`，失败返回 null。 */
  getRepoRoot(cwd: string): Promise<string | null>
  /** 执行 `git -C cwd symbolic-ref refs/remotes/origin/HEAD`，失败返回 null。 */
  getDefaultBranch(cwd: string): Promise<string | null>
}

/** detect 三态返回。 */
export interface WorkspaceDetectResult {
  /** 检测到的仓库模式。 */
  mode: 'bare-workspace' | 'plain-repo' | 'not-repo'
  /** workspace 根绝对路径（.bare 的父目录，bare-workspace 模式）。未检测到则为空串。 */
  wsRoot: string
  /** .bare 目录绝对路径（bare-workspace 模式）。未检测到则为空串。 */
  barePath: string
  /** git 仓库根目录绝对路径（bare-workspace 或 plain-repo 模式）。未检测到则为空串。 */
  repoRoot: string
  /** 默认分支名（如 'main'）。检测不到则为空串。 */
  defaultBranch: string
  /** 向后兼容：是否处于 bare repo + worktree 模式。等价于 mode === 'bare-workspace'。 */
  isBareMode: boolean
}

/** 向后兼容接口：detectBareWorkspaceCached 旧返回（只关心 isBareMode）。 */
export interface WorkspaceDetectResultLegacy {
  wsRoot: string
  barePath: string
  isBareMode: boolean
}

export class WorkspaceDetector {
  constructor(
    private fs: FsLike,
    private git?: GitRevParser,
  ) {}

  /**
   * 从 currentCwd 向上逐级检测 .bare 目录，然后回退到 git rev-parse 判定普通仓库。
   *
   * 三态逻辑：
   * 1. 向上逐级找 .bare → 找到 = bare-workspace
   * 2. .bare 未找到 → git rev-parse --show-toplevel → 成功 = plain-repo
   * 3. 两者都失败 → not-repo
   *
   * 边界：
   * - currentCwd 本身就是 workspace 根（.bare 在其下）→ bare-workspace（WD-3）
   * - currentCwd 是 workspace 的深层子目录 → 向上找到 bare-workspace（WD-1）
   * - 普通 git 仓库 → plain-repo（WD-2）
   * - 非 git 目录 → not-repo（WD-4）
   *
   * 终止条件：dirname(dir) === dir（已达文件系统根）。
   */
  async detect(currentCwd: string): Promise<WorkspaceDetectResult> {
    let dir = currentCwd
    // 阶段 1：向上逐级，直到 dirname 不再变化（已达根）
    while (true) {
      const barePath = join(dir, '.bare')
      try {
        const stat = this.fs.statSync(barePath)
        if (stat.isDirectory()) {
          // bare-workspace：尝试读 defaultBranch，失败不阻断
          const repoRoot = dir
          const defaultBranch = this.git ? (await this.git.getDefaultBranch(repoRoot)) ?? '' : ''
          return {
            mode: 'bare-workspace',
            wsRoot: dir,
            barePath,
            repoRoot,
            defaultBranch,
            isBareMode: true,
          }
        }
      } catch (e: unknown) {
        // ENOENT 是预期（绝大多数目录无 .bare）；其它错误也当作「不存在」继续向上
        // （避免 statSync 的非预期异常阻断检测——workspace 检测应尽力向上找）。
        const code = (e as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') {
          // 权限错误等：保守跳过当前 dir，继续向上（不抛，调用方按 not-repo 兜底）
        }
      }
      const parent = dirname(dir)
      if (parent === dir) {
        // 已达文件系统根，仍未找到 .bare → 阶段 2：尝试 git rev-parse
        break
      }
      dir = parent
    }

    // 阶段 2：回退到 git rev-parse（检测普通 git 仓库）
    if (this.git) {
      const repoRoot = await this.git.getRepoRoot(currentCwd)
      if (repoRoot) {
        const defaultBranch = (await this.git.getDefaultBranch(repoRoot)) ?? ''
        return {
          mode: 'plain-repo',
          wsRoot: '',
          barePath: '',
          repoRoot,
          defaultBranch,
          isBareMode: false,
        }
      }
    }

    // 阶段 3：既不是 bare workspace 也不是 git 仓库
    return {
      mode: 'not-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '',
      defaultBranch: '',
      isBareMode: false,
    }
  }

  /**
   * 向后兼容 detect()：只关心 isBareMode（布尔）。
   * 供旧调用方（detectBareWorkspaceCached 等）无感迁移。
   */
  async detectLegacy(currentCwd: string): Promise<WorkspaceDetectResultLegacy> {
    const result = await this.detect(currentCwd)
    return { wsRoot: result.wsRoot, barePath: result.barePath, isBareMode: result.isBareMode }
  }

  /**
   * 同步版 detect：只做阶段 1（.bare 检查），不走 git rev-parse。
   * 供 session 摘要链路（detectBareWorkspaceCached）使用，该链路是同步的。
   * 当 git=undefined 时，返回 mode='not-repo'（无 git 信息可回退）。
   */
  detectSync(currentCwd: string): WorkspaceDetectResult {
    let dir = currentCwd
    while (true) {
      const barePath = join(dir, '.bare')
      try {
        const stat = this.fs.statSync(barePath)
        if (stat.isDirectory()) {
          return {
            mode: 'bare-workspace',
            wsRoot: dir,
            barePath,
            repoRoot: dir,
            defaultBranch: '',
            isBareMode: true,
          }
        }
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') {
          // 权限错误等：保守跳过
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    // 不走阶段 2（git），同步场景只关心 bare 非 bare
    // 返回 'plain-repo' 而非 'not-repo' 以与 detect() 语义一致（detect 对非 bare 仓库也返回 plain-repo）
    return {
      mode: 'plain-repo',
      wsRoot: '',
      barePath: '',
      repoRoot: '',
      defaultBranch: '',
      isBareMode: false,
    }
  }
}

// ── session 摘要链路用的门面版本（R1，批 4 U10 门面化）──────────────────────
// bare 判定的缓存与解析已并入 repo 观测器（services/git/repo-observer 单例）：本门面只读
// isBare 字段，与 readGitInfo 共享同一 per-cwd 缓存（原 bareCache 独立容器已删除）。

/**
 * 检测 cwd 是否位于 .bare workspace 下（读 repo 观测器单例缓存，miss 惰性同步解析回填）。
 *
 * 供 SessionService.toSummary / SessionScanner.scannedToSummary 填充 SessionSummary.isBareWorkspace。
 * 绝不抛——任何异常兜底 false，确保 session 摘要生成不被中断。
 *
 * @returns 是否处于 bare repo + worktree 结构
 */
export function detectBareWorkspaceCached(cwd: string): boolean {
  try {
    return getSharedRepoObserver().readObservation(cwd).isBare
  } catch {
    // 兜底 false：session 摘要不能因 workspace 检测失败而中断（resolver 契约本就绝不抛，
    // 此 catch 是摘要链路边界承诺的最后一道保险）
    return false
  }
}
