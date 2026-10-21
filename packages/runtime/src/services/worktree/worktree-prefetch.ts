/**
 * 打开仓库时的默认远端 prefetch（自 worktree-service.ts 抽出，控 max-lines）。
 *
 * 事实驱动：refs/remotes/<remote>/* 的新鲜度只能由 fetch 保证——默认 base 推导与
 * 幽灵过滤都读它，打开仓库时刷一次让随后的 worktree 创建落在最新基线上。
 * 触发链：landing 选仓库 → workspace.record → fire-and-forget。
 *
 * 契约：永不抛（内部吞全部错误、日志留痕）——预热失败不影响任何主流程，不通知不重试；
 * 同 repo 并发 fetch 由 git 自身的 fetch 锁消解（后到者立即失败，被吞）。
 */
import { logger } from '../../infra/logger.js'
import type { IGitExecutor } from '../ports/git-executor.js'
import type { DefaultBaseResolver } from './default-base-resolver.js'
import type { WorkspaceDetector } from './workspace-detector.js'

/** fetch 超时（ms）：网络命令，对齐 worktree add/remove 的 60s 长超时档（非轻查询）。 */
const PREFETCH_FETCH_TIMEOUT_MS = 60_000

/** stderr 落盘长度帽（与 worktree-service 的失败日志口径一致）。 */
const STDERR_LOG_TAIL_LENGTH = 2048

/** prefetch 依赖（WorktreeService 传入其 deps 子集 + detector 工厂；数据形状，type 别名）。 */
export type WorktreePrefetchDeps = {
  gitExecutor: IGitExecutor
  baseResolver: DefaultBaseResolver
  createDetector: () => WorkspaceDetector
}

export async function prefetchDefaultRemoteWorktree(deps: WorktreePrefetchDeps, cwd: string): Promise<void> {
  try {
    const detection = await deps.createDetector().detect(cwd)
    if (detection.mode === 'not-repo') return
    const repoDir = detection.mode === 'bare-workspace' ? detection.barePath : detection.repoRoot
    const { defaultRemote } = await deps.baseResolver.resolve(repoDir)
    if (!defaultRemote) return
    const result = await deps.gitExecutor.exec(
      repoDir, 'fetch', ['--quiet', defaultRemote],
      { timeoutMs: PREFETCH_FETCH_TIMEOUT_MS },
    )
    if (result.exitCode !== 0) {
      logger.info('[worktree-service] prefetch 默认远端失败（降级：继续用本地 ref）', {
        cwd,
        remote: defaultRemote,
        exitCode: result.exitCode,
        stderr: result.stderr.trim().slice(0, STDERR_LOG_TAIL_LENGTH),
      })
    }
  } catch (e) {
    logger.warn('[worktree-service] prefetch 默认远端异常（降级：继续用本地 ref）', {
      cwd,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
