/**
 * GitRepoObserver 单测（缓存治理批 4 U10）：branch/worktree/bare 单源缓存的策略层。
 *
 * resolver 用手写 fake（记录调用 + 可编程产物），不触真实 fs / git——验证的是缓存策略
 * 本身（TTL / 容量驱逐 / prune / 精确失效 / 引用契约）；walk-up 解析逻辑由
 * git-repo-resolver.test.ts 单独覆盖。
 *
 * 测试框架 vitest，运行命令：cd packages/runtime && npx vitest run src/services/git/repo-observer.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IGitRepoResolver, RepoObservation } from '../ports/git-info.js'
import { GitRepoObserver } from './repo-observer.js'


const NON_REPO: RepoObservation = { branch: undefined, isWorktree: false, isBare: false, gitDir: undefined, headPath: undefined }

function obsOf(partial: Partial<RepoObservation>): RepoObservation {
  return { ...NON_REPO, ...partial }
}

/** 手写 fake IGitRepoResolver：记录解析顺序，产物按 cwd 可编程。 */
function createFakeResolver(defaultObs?: Partial<RepoObservation>) {
  const calls: string[] = []
  const impls = new Map<string, Partial<RepoObservation>>()
  const resolver: IGitRepoResolver = {
    resolve(cwd: string): RepoObservation {
      calls.push(cwd)
      return obsOf(impls.get(cwd) ?? defaultObs ?? {})
    },
  }
  return {
    resolver,
    calls,
    stub(cwd: string, partial: Partial<RepoObservation>): void {
      impls.set(cwd, partial)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})


describe('GitRepoObserver.readObservation', () => {
  it('miss 惰性同步解析并回填：TTL 内二次读取命中缓存（零新解析），返回同一对象引用', () => {
    const fake = createFakeResolver({ branch: 'main', gitDir: '/repo/.git' })
    const observer = new GitRepoObserver({ resolver: fake.resolver })

    const first = observer.readObservation('/repo')
    const second = observer.readObservation('/repo')
    expect(fake.calls).toEqual(['/repo'])
    expect(first).toEqual(obsOf({ branch: 'main', gitDir: '/repo/.git' }))
    expect(second).toBe(first)
  })

  it('TTL（默认 5min）过期后重新解析并刷新缓存', () => {
    const fake = createFakeResolver({ branch: 'main', gitDir: '/repo/.git' })
    const observer = new GitRepoObserver({ resolver: fake.resolver })

    observer.readObservation('/repo')
    vi.advanceTimersByTime(5 * 60 * 1000 - 1)
    observer.readObservation('/repo')
    expect(fake.calls).toEqual(['/repo']) // TTL 边界内仍命中

    vi.advanceTimersByTime(1) // 累计 5min，过期
    observer.readObservation('/repo')
    expect(fake.calls).toEqual(['/repo', '/repo'])
  })

  it('非 repo 观测产物（gitDir undefined）同样被缓存——与旧 gitInfoCache 缓存 undefined 的语义一致', () => {
    const fake = createFakeResolver()
    const observer = new GitRepoObserver({ resolver: fake.resolver })

    const first = observer.readObservation('/not-a-repo')
    const second = observer.readObservation('/not-a-repo')
    expect(first).toEqual(NON_REPO)
    expect(second).toBe(first)
    expect(fake.calls).toEqual(['/not-a-repo'])
  })
})

describe('GitRepoObserver 容量驱逐（oldest-insert + 过期重写移位）', () => {
  it('容量满时 O(1) 驱逐最老条目（first-key 淘汰）', () => {
    const fake = createFakeResolver()
    const observer = new GitRepoObserver({ resolver: fake.resolver, maxSize: 2 })

    observer.readObservation('/a')
    observer.readObservation('/b')
    observer.readObservation('/c') // 帽满，驱逐最老的 /a
    expect(fake.calls).toEqual(['/a', '/b', '/c'])

    observer.readObservation('/a') // miss：回填前先驱逐 first key /b（当前最老），再插入 /a
    expect(fake.calls).toEqual(['/a', '/b', '/c', '/a'])
    observer.readObservation('/a') // 刚回填，TTL 内命中
    expect(fake.calls).toHaveLength(4)
    observer.readObservation('/b') // 已被驱逐 → 重新解析
    expect(fake.calls).toHaveLength(5)
  })

  it('过期重写把条目移到 Map 尾部：容量淘汰按最后写入时间', () => {
    const fake = createFakeResolver()
    const observer = new GitRepoObserver({ resolver: fake.resolver, maxSize: 2 })

    observer.readObservation('/a') // t0 写入
    observer.readObservation('/b') // t0 写入
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    observer.readObservation('/a') // 过期重写 → delete+set 移尾（Map 序 [b, a]）
    expect(fake.calls).toEqual(['/a', '/b', '/a'])

    observer.readObservation('/c') // 帽满驱逐 first key = /b（最后写入时间最旧）
    expect(fake.calls).toEqual(['/a', '/b', '/a', '/c'])

    observer.readObservation('/a') // 刚重写过 → 命中
    expect(fake.calls).toHaveLength(4)
    observer.readObservation('/b') // 被驱逐 → 重新解析
    expect(fake.calls).toHaveLength(5)
  })
})

describe('GitRepoObserver.pruneCache / invalidateCwd', () => {
  it('pruneCache：不在活跃集合的条目删除，在集合且未过期的保留', async () => {
    const fake = createFakeResolver({ branch: 'main', gitDir: '/x/.git' })
    const observer = new GitRepoObserver({ resolver: fake.resolver })

    observer.readObservation('/live')
    observer.readObservation('/dead')
    observer.pruneCache(new Set(['/live']))

    observer.readObservation('/live') // 命中
    observer.readObservation('/dead') // 已被收缩 → 重新解析
    expect(fake.calls).toEqual(['/live', '/dead', '/dead'])
  })

  it('pruneCache：在活跃集合但 TTL 已过期的条目同样删除', async () => {
    const fake = createFakeResolver({ branch: 'main', gitDir: '/x/.git' })
    const observer = new GitRepoObserver({ resolver: fake.resolver })

    observer.readObservation('/live')
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    observer.pruneCache(new Set(['/live']))

    observer.readObservation('/live') // 过期被收缩 → 重新解析
    expect(fake.calls).toEqual(['/live', '/live'])
  })

  it('invalidateCwd：按 cwd 精确失效，其他条目不受影响', async () => {
    const fake = createFakeResolver({ branch: 'main', gitDir: '/x/.git' })
    const observer = new GitRepoObserver({ resolver: fake.resolver })

    observer.readObservation('/repo-a')
    observer.readObservation('/repo-b')
    observer.invalidateCwd('/repo-a')

    observer.readObservation('/repo-a') // 失效 → 重新解析
    observer.readObservation('/repo-b') // 命中
    expect(fake.calls).toEqual(['/repo-a', '/repo-b', '/repo-a'])
  })
})
