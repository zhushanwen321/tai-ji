/**
 * worktree 创建的 base ref 解析（自 worktree-service.ts 抽出，控 max-lines）。
 *
 * 四形态：
 * - 'current'：gitInfoReader 读当前分支，读不到 fallback 推导默认
 * - 'auto'（config 默认值）：DefaultBaseResolver 按仓库远端实况动态推导
 * - '<remote>/<branch>'：先验证 <remote> 是已配置远端；解析到 refs/remotes/<未配置名>/...
 *   的是幽灵 ref（远端不存在 = 永无更新通道的死数据），拒绝采信并 fallback 推导默认
 * - 其他字符串：作为具体分支名，rev-parse 验证存在性
 *
 * RT-8#8：fallback 不再静默——baseBranch 校验失败改用别的基线是「创建基线被偷换」，
 * 新 worktree 会落在用户没选的基线上。warn 留痕 + 调用方把返回的 usedBaseRef 带回
 * worktree.created envelope（前端可见实际用了哪个 ref）。
 */
import { logger } from '../../infra/logger.js'
import type { IGitExecutor } from '../ports/git-executor.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import { AUTO_BASE_BRANCH, DefaultBaseResolver } from './default-base-resolver.js'

/** 解析所需依赖（WorktreeService 传入其 deps 子集，测试同源 mock）。 */
export type BaseRefResolutionDeps = {
  gitExecutor: IGitExecutor
  gitInfoReader: IGitInfoReader
  baseResolver: DefaultBaseResolver
}

export async function resolveWorktreeBaseRef(
  deps: BaseRefResolutionDeps,
  repoDir: string,
  branch: string,
  baseBranch: string,
  workspaceHint?: string,
): Promise<string> {
  if (baseBranch === 'current') {
    const info = deps.gitInfoReader.readGitInfo(workspaceHint ?? process.cwd())
    if (info?.branch) return info.branch
    const fallback = await resolveDefaultBase(deps, repoDir)
    logger.warn('[worktree-service] base 解析 fallback：current 读不到，改用推导默认', {
      branch,
      repoDir,
      requestedBaseBranch: baseBranch,
      fallback,
      reason: 'gitInfoReader 返回空',
      impact: '新 worktree 基于推导默认而非当前分支',
    })
    return fallback
  }
  if (baseBranch === AUTO_BASE_BRANCH) {
    return resolveDefaultBase(deps, repoDir)
  }
  // 幽灵 remote-tracking ref 防护：首段不是已配置远端、但 ref 物理存在于
  // refs/remotes/<首段>/ 下——远端不存在意味着没有任何 fetch 会刷新它（2026-10-20
  // 事故：外部脚本镜像残留的 origin/* 冻结三天，rev-parse 存在性校验被骗过）
  const firstSegment = baseBranch.includes('/') ? baseBranch.split('/')[0] : null
  if (firstSegment && !(await deps.baseResolver.listRemotes(repoDir)).includes(firstSegment)) {
    const ghostRef = await deps.baseResolver.resolveGhostRemoteTrackingRef(repoDir, baseBranch)
    if (ghostRef) {
      const fallback = await resolveDefaultBase(deps, repoDir)
      logger.warn('[worktree-service] base 解析 fallback：幽灵 remote-tracking ref，拒绝采信', {
        branch,
        repoDir,
        requestedBaseBranch: baseBranch,
        resolvedRef: ghostRef,
        reason: `远端 '${firstSegment}' 未配置，${ghostRef} 无更新通道（疑似残留镜像）`,
        fallback,
        impact: '新 worktree 基于推导默认而非请求的 base（创建基线被偷换）',
      })
      return fallback
    }
  }
  // 验证 ref 存在
  const result = await deps.gitExecutor.exec(repoDir, 'rev-parse', ['--verify', baseBranch])
  if (result.exitCode === 0) return baseBranch
  const fallback = await resolveDefaultBase(deps, repoDir)
  logger.warn('[worktree-service] base 解析 fallback：请求 ref 校验失败，改用推导默认', {
    branch,
    repoDir,
    requestedBaseBranch: baseBranch,
    fallback,
    revParseExit: result.exitCode,
    revParseStderr: result.stderr.trim(),
    impact: '新 worktree 基于推导默认而非请求的 base（创建基线被偷换）',
  })
  return fallback
}

/**
 * 推导默认基线（DefaultBaseResolver）。resolver 只在 git 不可用/超时（GitExecutorError）
 * 时抛——该失败形态下后续 worktree add 同样不可执行，向上传播成 GIT_FAILED 是正确语义；
 * 其余情况（无远端等）恒有 'main' 兜底返回。
 */
async function resolveDefaultBase(deps: BaseRefResolutionDeps, repoDir: string): Promise<string> {
  const resolution = await deps.baseResolver.resolve(repoDir)
  return resolution.defaultBaseRef
}
