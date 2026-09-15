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
 * detectBareWorkspaceCached：session 摘要链路（toSummary / scannedToSummary）复用的缓存版本。
 * 缓存模式镜像 GitInfoReader（per-cwd TTL + 最老条目淘汰），避免每次 listPersistedSessions 对
 * 每个 session 重新向上 statSync。失败（statSync 抛非 ENOENT）兜底 false，绝不传播异常——
 * session 摘要生成不能因 workspace 检测失败而中断。
 */
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'

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

// ── session 摘要链路用的缓存版本（R1）──────────────────────────────────────
// 镜像 GitInfoReader 的 per-cwd TTL + 最老条目淘汰（oldest-insert）缓存，避免每次列举 session
// 重复向上 statSync。真实 node:fs 直接用（detect 仅 statSync，无需注入——注入模式仅 WorktreeService 单测需要）。
// eslint-disable-next-line no-magic-numbers -- 5 minutes = 5 * 60 * 1000ms, self-documenting with comment
const BARE_CACHE_TTL_MS = 5 * 60 * 1000
const BARE_CACHE_MAX_SIZE = 500

const bareCache = new Map<string, { isBare: boolean; ts: number }>()
const realDetector = new WorkspaceDetector(
  { statSync: (p: string) => statSync(p) },
  // git 信息由 execSync 实现；session 摘要链路不需要 git 回退（只关心 bare 非 bare），
  // 所以这里不注入 git——detect 不命中 .bare 时直接返回 not-repo，对摘要无影响。
  undefined,
)

/**
 * 检测 cwd 是否位于 .bare workspace 下（带 per-cwd TTL + 最老条目淘汰缓存）。
 *
 * 供 SessionService.toSummary / SessionScanner.scannedToSummary 填充 SessionSummary.isBareWorkspace。
 * 绝不抛——任何异常（权限、IO 错误）兜底 false，确保 session 摘要生成不被中断。
 *
 * @returns 是否处于 bare repo + worktree 结构
 */
export function detectBareWorkspaceCached(cwd: string): boolean {
  const now = Date.now()
  const cached = bareCache.get(cwd)
  if (cached && (now - cached.ts) < BARE_CACHE_TTL_MS) return cached.isBare

  // 最老条目淘汰（oldest-insert，非真 LRU——命中不刷新 ts）—— O(1)：JS Map 迭代序 = 插入序，
  // 过期重写路径（下方 delete+set）保证「迭代序 = 最后写入时间升序」不变量，故 first key 恒为
  // ts 最小条目，与原 O(n) 扫描 ts 最小的语义精确等价（perf 微项 10）。
  // 已知边界（W16 审查 Fix-8）：该不变量以 Date.now 单调为前提，时钟回拨下 first-key 驱逐可能
  // 非最旧——5min TTL 窗口内秒级回拨的影响可忽略，不做补偿。
  if (bareCache.size >= BARE_CACHE_MAX_SIZE) {
    const oldest = bareCache.keys().next().value
    if (oldest !== undefined) bareCache.delete(oldest)
  }

  let isBare = false
  try {
    // detectSync 只做 .bare 检查（同步），不走 git rev-parse，
    // session 摘要链路只关心 bare 非 bare，不需要三态完整信息
    isBare = realDetector.detectSync(cwd).isBareMode
  } catch {
    // 兜底 false：session 摘要不能因 workspace 检测失败而中断
    isBare = false
  }
  // 过期重写先 delete 再 set：把条目移到 Map 尾部，维持上述不变量（set 对已有 key 不换位）
  bareCache.delete(cwd)
  bareCache.set(cwd, { isBare, ts: now })
  return isBare
}

/**
 * 清理 cwd 不再被引用、或 TTL 过期的 bare 缓存项（与 GitInfoReader.pruneStaleCache 对称）。
 * 在每次列举 session 后由 scanner 调用。
 */
export function pruneBareCache(existingCwds: Set<string>): void {
  const now = Date.now()
  for (const key of bareCache.keys()) {
    if (!existingCwds.has(key) || (now - (bareCache.get(key)?.ts ?? 0)) >= BARE_CACHE_TTL_MS) {
      bareCache.delete(key)
    }
  }
}

/** 测试隔离用：重置 bare 缓存（@internal，仅供单测 beforeEach 调）。 */
export function __resetBareCacheForTests(): void {
  bareCache.clear()
}
