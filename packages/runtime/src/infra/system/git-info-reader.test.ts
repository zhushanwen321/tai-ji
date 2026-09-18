/**
 * GitInfoReader 门面单测（缓存治理批 4 U10）：门面只做「观测器缓存 → GitInfo 旧形状」投影，
 * 自身零缓存零 IO。观测器策略（TTL/LRU/prune）由 repo-observer.test.ts 覆盖，walk-up 解析由
 * git-repo-resolver.test.ts 覆盖。
 *
 * observer 用手写 fake（记录调用），验证投影映射与 prune 委托。
 *
 * 测试框架 vitest，运行命令：cd packages/runtime && npx vitest run src/infra/system/git-info-reader.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import type { IGitRepoObserver, RepoObservation } from '../../services/ports/git-info.js'
import { GitInfoReader } from './git-info-reader.js'

const NON_REPO: RepoObservation = { branch: undefined, isWorktree: false, isBare: false, gitDir: undefined, headPath: undefined }

function fakeObserver(obs: RepoObservation): IGitRepoObserver {
  return {
    readObservation: vi.fn(() => obs),
    pruneCache: vi.fn(),
  }
}

describe('GitInfoReader.readGitInfo（观测器缓存 → GitInfo 投影）', () => {
  it('repo（gitDir + branch 均在）→ 投影 {branch, isWorktree}', () => {
    const observer = fakeObserver({ branch: 'feat-x', isWorktree: true, isBare: false, gitDir: '/ws/.bare/wt', headPath: '/ws/.bare/wt/HEAD' })
    const reader = new GitInfoReader(observer)

    expect(reader.readGitInfo('/ws/feat-x')).toEqual({ branch: 'feat-x', isWorktree: true })
    expect(observer.readObservation).toHaveBeenCalledWith('/ws/feat-x')
  })

  it('非 repo（gitDir undefined）→ undefined（摘要字段留空）', () => {
    const reader = new GitInfoReader(fakeObserver(NON_REPO))
    expect(reader.readGitInfo('/not-a-repo')).toBeUndefined()
  })

  it('branch undefined（rev-parse 失败 / 未出生分支 / git 不可用）→ undefined，即使 gitDir 存在', () => {
    const observer = fakeObserver({ branch: undefined, isWorktree: false, isBare: true, gitDir: '/ws/.bare', headPath: '/ws/.bare/HEAD' })
    const reader = new GitInfoReader(observer)
    expect(reader.readGitInfo('/ws')).toBeUndefined()
  })

  it('bare workspace 根形态：branch 有效时正常投影（isWorktree=false）', () => {
    // workspace 根在更上层 repo 之内的边界：walk-up 命中 .bare，rev-parse 从 cwd 起算仍可解析
    const observer = fakeObserver({ branch: 'main', isWorktree: false, isBare: true, gitDir: '/repo/inner/.bare', headPath: '/repo/inner/.bare/HEAD' })
    const reader = new GitInfoReader(observer)
    expect(reader.readGitInfo('/repo/inner')).toEqual({ branch: 'main', isWorktree: false })
  })
})

describe('GitInfoReader.pruneStaleCache（收缩动作打观测器单点）', () => {
  it('签名保留，动作整体委托观测器 pruneCache（branch/worktree/bare 同一缓存）', () => {
    const observer = fakeObserver(NON_REPO)
    const reader = new GitInfoReader(observer)

    const cwds = new Set(['/a', '/b'])
    reader.pruneStaleCache(cwds)
    expect(observer.pruneCache).toHaveBeenCalledTimes(1)
    expect(observer.pruneCache).toHaveBeenCalledWith(cwds)
  })
})
