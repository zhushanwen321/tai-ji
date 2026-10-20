/**
 * worktree 默认 base 解析器 —— 从仓库实况动态推导默认基线 ref。
 *
 * 为什么不硬编码 'origin/main'（2026-10-20 事故）：remote-tracking ref 的权威完全来自
 * 「名为 <remote> 的远端会在 fetch 时刷新它」。bare workspace 的远端可以叫 github 而非
 * origin，且 refs/remotes/origin/* 可能残留外部脚本镜像后停止维护的死数据（远端不存在，
 * 永无更新通道）——按存在性校验采信它会让新 worktree 落在冻结快照上。推导只看
 * `git remote` 实况，幽灵 ref 天然不进候选。
 *
 * 默认远端挑选顺序（多远端时谁排最前）：
 * ① git config checkout.defaultRemote（git 官方的默认远端裁决配置——用户显式意图，必须在
 * `git remote` 清单内才采信）② origin（git clone 通行惯例）③ 单一远端 ④ 清单首个。
 * 显式配置排惯例名之前：仓库同时有 origin 与另一远端且 defaultRemote 指向后者时，
 * 'auto' 必须解析到用户指定的那个，而不是被惯例名静默盖掉。
 *
 * 默认分支：<remote>/HEAD 的 symref（symbolic-ref 对非 symref 的残留直接 ref 非零退出，
 * 幽灵 HEAD 天然不污染）→ 依次 rev-parse 验证 <remote>/main、<remote>/master → 均无则
 * 退本地 main。
 */
import { WORKTREE_AUTO_BASE_BRANCH } from '@taiji/shared'
import type { IGitExecutor } from '../ports/git-executor.js'
import { logger } from '../../infra/logger.js'

/**
 * baseBranch 配置哨兵：动态推导（worktree-config-helper 的 DEFAULT_BASE_BRANCH）。
 * 值 SSOT = @taiji/shared WORKTREE_AUTO_BASE_BRANCH（跨端协议哨兵，C-comm-22）；此处 re-export
 * 保持 runtime 域内既有 import 路径不变。
 */
export const AUTO_BASE_BRANCH = WORKTREE_AUTO_BASE_BRANCH

/** 无远端 / 远端无可用分支时的兜底基线（本地 main）。 */
const LOCAL_MAIN = 'main'

/** 候选默认分支（<remote>/HEAD symref 不可用时依次尝试）。 */
const BRANCH_CANDIDATES = ['main', 'master'] as const

/** refs/remotes/<remote>/HEAD → 剥 refs/remotes/<remote>/ 前缀。 */
const REMOTE_REF_PREFIX_RE = /^refs\/remotes\/[^/]+\//

/** 解析结果（数据形状，type 别名——非多态契约）。 */
export type DefaultBaseResolution = {
  /** `git remote` 全清单（git config 定义顺序）。 */
  remotes: string[]
  /** 决出的默认远端；无远端为 null。 */
  defaultRemote: string | null
  /** 默认远端的默认分支名（<remote>/HEAD symref 或候选验证得出）；解析不出为 null。 */
  remoteDefaultBranch: string | null
  /** 完整基线 ref：'<remote>/<branch>'；无远端或远端无分支时为本地 'main'。 */
  defaultBaseRef: string
}

export class DefaultBaseResolver {
  constructor(private readonly gitExecutor: IGitExecutor) {}

  /**
   * 解析 repoDir 的默认 base。命令均为本地元数据查询（远端清单/配置/ref 解析），
   * 不触网；git 命令非零退出按「该信息不可得」降级（空清单/null），仅 git 不可用/超时
   * （GitExecutorError）向上抛——与既有轻查询失败语义一致。
   */
  async resolve(repoDir: string): Promise<DefaultBaseResolution> {
    const remotes = await this.listRemotes(repoDir)
    const defaultRemote = await this.pickDefaultRemote(repoDir, remotes)
    if (!defaultRemote) {
      return { remotes, defaultRemote: null, remoteDefaultBranch: null, defaultBaseRef: LOCAL_MAIN }
    }
    const remoteDefaultBranch = await this.resolveRemoteDefaultBranch(repoDir, defaultRemote)
    return {
      remotes,
      defaultRemote,
      remoteDefaultBranch,
      defaultBaseRef: remoteDefaultBranch ? `${defaultRemote}/${remoteDefaultBranch}` : LOCAL_MAIN,
    }
  }

  /** `git remote` 清单（config 定义顺序）。失败降级空清单 = 按无远端处理。 */
  async listRemotes(repoDir: string): Promise<string[]> {
    const r = await this.gitExecutor.exec(repoDir, 'remote', [])
    if (r.exitCode !== 0) return []
    return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  }

  /**
   * resolve 的安全形态：GitExecutorError（git 不可用/超时）不抛，warn 留痕后返回 null。
   * 供「解析失败只降级不阻断」的调用方（detect reply 附带、listBranches 过滤）使用。
   */
  async safeResolve(repoDir: string): Promise<DefaultBaseResolution | null> {
    try {
      return await this.resolve(repoDir)
    } catch (e) {
      logger.warn('[worktree-service] 默认 base 解析失败（降级：跳过远端实况增强）', {
        repoDir,
        error: e instanceof Error ? e.message : String(e),
      })
      return null
    }
  }

  /**
   * 解析远端默认分支名：<remote>/HEAD symref → <remote>/main → <remote>/master。
   * 返回 null = 该远端没有可识别的默认分支。
   */
  async resolveRemoteDefaultBranch(repoDir: string, remote: string): Promise<string | null> {
    const sym = await this.gitExecutor.exec(repoDir, 'symbolic-ref', [`refs/remotes/${remote}/HEAD`])
    if (sym.exitCode === 0) {
      const branch = sym.stdout.trim().replace(REMOTE_REF_PREFIX_RE, '')
      if (branch) return branch
    }
    for (const candidate of BRANCH_CANDIDATES) {
      const verify = await this.gitExecutor.exec(repoDir, 'rev-parse', ['--verify', `${remote}/${candidate}`])
      if (verify.exitCode === 0) return candidate
    }
    return null
  }

  /**
   * 按挑选顺序决出默认远端：① checkout.defaultRemote（须在清单内）② origin ③ 单一远端
   * ④ 清单首个（③④ 同为 remotes[0]）。
   */
  private async pickDefaultRemote(repoDir: string, remotes: string[]): Promise<string | null> {
    const configured = await this.gitExecutor.exec(repoDir, 'config', ['--get', 'checkout.defaultRemote'])
    const preferred = configured.exitCode === 0 ? configured.stdout.trim() : ''
    if (preferred && remotes.includes(preferred)) return preferred
    if (remotes.includes('origin')) return 'origin'
    return remotes[0] ?? null
  }

  /**
   * 解析仓库默认分支名（不带 remote 前缀）：默认远端的默认分支 → 本地 main → 本地 master。
   * 全部失败返回 null（调用方自行兜底）。workspace 检测的 defaultBranch 用。
   */
  async resolveDefaultBranchName(repoDir: string): Promise<string | null> {
    const { defaultRemote } = await this.resolve(repoDir)
    if (defaultRemote) {
      const branch = await this.resolveRemoteDefaultBranch(repoDir, defaultRemote)
      if (branch) return branch
    }
    for (const candidate of BRANCH_CANDIDATES) {
      const check = await this.gitExecutor.exec(repoDir, 'rev-parse', ['--verify', `refs/heads/${candidate}`])
      if (check.exitCode === 0) return candidate
    }
    return null
  }

  /**
   * 幽灵 remote-tracking ref 判定：ref 能解析、且落在 refs/remotes/<未配置远端>/ 下时
   * 返回解析出的完整 ref 名（refs/remotes/...），否则返回 null。这类 ref 的更新通道
   * （同名远端的 fetch）不存在，指向的提交永远停在镜像写入那天——采信它会让新 worktree
   * 落在冻结快照上（2026-10-20 事故）。refs/heads/ 下的本地分支不属此列。
   */
  async resolveGhostRemoteTrackingRef(repoDir: string, ref: string): Promise<string | null> {
    const fullName = await this.gitExecutor.exec(repoDir, 'rev-parse', ['--verify', '--symbolic-full-name', ref])
    if (fullName.exitCode !== 0) return null
    const resolved = fullName.stdout.trim()
    return resolved.startsWith('refs/remotes/') ? resolved : null
  }
}
