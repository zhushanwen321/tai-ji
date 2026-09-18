/**
 * SessionScanner — 从 session-service 巨石拆出的会话列举/分组职责。
 *
 * 负责:listPersistedSessions(对外)+ listGrouped / listAll / pruneGitCache / scannedToSummary。
 *
 * 合并活跃会话(经 Facade 提供的 summaries + filePaths 去重)与
 * 持久化会话(scanPiSessions 读磁盘),按 cwd 分组、按 lastActiveAt 排序。
 *
 * 依赖经构造注入:svc(scanner 窄接口 IScannerSessionOps,按消费者收窄——
 * 调用点实测 2 方法,见 session-internal.ts)。
 */
import { basename } from 'node:path'
import type { SessionSummary, SessionGroup, SessionStatus } from '@taiji/shared'
import type { IScannerSessionOps } from './session-internal.js'
import type { ISessionStore } from '../ports/session.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import type { ScannedSession } from './types.js'
import { detectBareWorkspaceCached } from '../worktree/workspace-detector.js'

export class SessionScanner {
  constructor(
    private readonly svc: IScannerSessionOps,
    private readonly sessionStore: ISessionStore,
    private readonly gitInfoReader: IGitInfoReader,
  ) {}

  listPersistedSessions(): SessionGroup[] {
    return this.listGrouped()
  }

  private listGrouped(): SessionGroup[] {
    const summaries = this.listAll()
    const byCwd: Record<string, SessionSummary[]> = {}
    for (const s of summaries) {
      if (!byCwd[s.cwd]) byCwd[s.cwd] = []
      byCwd[s.cwd].push(s)
    }
    // eslint-disable-next-line taste/no-unsafe-object-entries -- cwd 来自已验证的 SessionSummary,非外部注入
    return Object.entries(byCwd).map(([cwd, sessions]) => ({ cwd, sessions }))
  }

  private listAll(): SessionSummary[] {
    const active = this.svc.getActiveSummaries()
    const activeFilePaths = this.svc.getActiveFilePaths()

    const persisted = this.sessionStore.scanSessions()
      .filter(s => !activeFilePaths.has(s.filePath))
      .map(s => this.scannedToSummary(s))

    const result = [...active, ...persisted]
      // 隐藏 session（公共 session）不进 sidebar 列表。active（内存 Map，hidden 标记在
      // IManagedSessionView）和 persisted（磁盘扫描，hidden 标记经 toSummary 透传）都过滤。
      .filter(s => !s.hidden)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    this.pruneGitCache(result)
    return result
  }

  /** Prune stale repo-observer cache entries for cwds no longer represented in any session. */
  private pruneGitCache(allSummaries: SessionSummary[]): void {
    const cwds = new Set(allSummaries.map(s => s.cwd))
    // 收缩动作打观测器单点：gitInfoCache/bareCache 已合并为观测器单一缓存，
    // pruneStaleCache（门面）一次调用即覆盖 branch/worktree/bare 全部条目
    this.gitInfoReader.pruneStaleCache(cwds)
  }

  private scannedToSummary(s: ScannedSession): SessionSummary {
    const git = this.gitInfoReader.readGitInfo(s.cwd)
    // W3 三读合一：outcome 随 scanPiSessions 一起提取进 ScannedSessionMeta，
    // 此处直接取 s.outcome，不再独立调 extractSessionOutcome（消除第 3 次全量读）。
    // 无 session_end entry（历史 session / 未结束）→ idle 兜底
    const outcome = s.outcome
    return {
      id: s.id,
      label: s.name ?? basename(s.cwd),
      cwd: s.cwd,
      gitBranch: git?.branch,
      gitIsWorktree: git?.isWorktree,
      // R1：复用 WorkspaceDetector 检测 .bare workspace（带缓存）
      isBareWorkspace: detectBareWorkspaceCached(s.cwd),
      status: (outcome ?? 'idle') as SessionStatus,
      lastActiveAt: s.lastModified,
      // modelId 来自 scanSessionMeta 第七读的反向读 JSONL 真源（scan 占位语义）。
      // source:'scan' 标记让合并侧（core mergeViewSnapshot 守卫）能按来源分流——扫描占位
      // 空值不覆盖实例/广播真值（#2 空串覆盖事故防线）；owner 快照的显式空值不受此守卫。
      modelId: s.modelId ?? '',
      tokenCount: 0,
      source: 'scan',
      sessionFile: s.filePath,
      parentSession: s.parentSession,
      forkEntryId: s.forkEntryId,
      handedOffTo: s.handedOffTo,
      // 透传 launch preset 绑定（wave2 scanSessionMeta 四读合一已提取进 meta）。
      // 严禁在此独立读文件——会破坏缓存契约 W3（每 session 多一次 readFileSync）。
      launchPresetId: s.launchPresetId,
      // D14 语义修正：归属 project（scanSessionMeta 第五读，同缓存契约）。
      projectId: s.projectId,
      // 透传 agent binding（scanSessionMeta 第六读，同缓存契约）。
      spawnSource: s.spawnSource,
      parentAgentSessionId: s.parentAgentSessionId,
      thinkingLevel: s.thinkingLevel,
    }
  }
}
