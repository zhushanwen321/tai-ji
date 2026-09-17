/**
 * IGitInfoReader 的门面实现 —— 同步读 repo 观测器缓存并投影为 GitInfo 旧形状。
 *
 * 三层架构：infra 实现（services 定义 port），从 services/git-info.ts 迁入（design §「services 需去 infra 直连」）。
 * 原文件放在 services/ 是分层违规——它查 git 外部系统，本属 infra。现归位到 infra/system/（与 trash.ts 同目录）。
 *
 * 缓存治理批 4 U10：本类降级为观测器之上的同步只读门面——branch / worktree / bare 判定的
 * 单一缓存与解析在 GitStateService 内建的 repo 观测器（services/git/repo-observer.ts，经组合根
 * 注入共享单例）；本模块不再持有任何缓存容器。观测器缓存为空的时序窗口由观测器自身闭合
 * （miss 惰性同步解析并回填，热路径永不返回「待定」态）。
 */
import type { GitInfo, IGitInfoReader, IGitRepoObserver } from '../../services/ports/git-info.js'

export class GitInfoReader implements IGitInfoReader {
  private readonly observer: IGitRepoObserver

  /** observer 由组合根注入（GitStateService 实例，即观测器的 service 面）。 */
  constructor(observer: IGitRepoObserver) {
    this.observer = observer
  }

  readGitInfo(cwd: string): GitInfo | undefined {
    const obs = this.observer.readObservation(cwd)
    // 旧语义保真：非 git 仓库（gitDir undefined）/ branch 为空（rev-parse 失败、未出生分支、
    // git 不可用）→ 整体 undefined（摘要字段留空）
    if (!obs.gitDir || !obs.branch) return undefined
    return { branch: obs.branch, isWorktree: obs.isWorktree }
  }

  /** 收缩动作打观测器单点（签名保留；原独立 bareCache prune 已并入同一观测器缓存）。 */
  pruneStaleCache(existingCwds: Set<string>): void {
    this.observer.pruneCache(existingCwds)
  }
}
