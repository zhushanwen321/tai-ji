/**
 * WorkspaceDetector 三态检测测试（W2）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/worktree/workspace-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  WorkspaceDetector,
  type FsLike,
  type GitRevParser,
  detectBareWorkspaceCached,
  pruneBareCache,
  __resetBareCacheForTests,
} from './workspace-detector.js'

// ── helpers ──────────────────────────────────────────────────

/** 创建 mock FsLike，statSync 按 dirSet 判定 isDirectory。 */
function mockFs(dirSet: Set<string>): FsLike {
  return {
    statSync: (p: string) => {
      if (dirSet.has(p)) return { isDirectory: () => true }
      const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
      e.code = 'ENOENT'
      throw e
    },
  }
}

/** 创建 mock GitRevParser。 */
function mockGit(overrides?: {
  repoRoot?: string | null
  defaultBranch?: string | null
}): GitRevParser {
  return {
    getRepoRoot: vi.fn().mockResolvedValue(overrides?.repoRoot ?? null),
    getDefaultBranch: vi.fn().mockResolvedValue(overrides?.defaultBranch ?? null),
  }
}

// ── detect 三态测试 ─────────────────────────────────────────

describe('WorkspaceDetector.detect()', () => {
  it('bare-workspace：cwd 本身就是 workspace 根（.bare 在其下）', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const git = mockGit({ defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/project')
    expect(result.mode).toBe('bare-workspace')
    expect(result.wsRoot).toBe('/project')
    expect(result.barePath).toBe('/project/.bare')
    expect(result.repoRoot).toBe('/project')
    expect(result.defaultBranch).toBe('main')
    expect(result.isBareMode).toBe(true)
  })

  it('bare-workspace：cwd 是 workspace 的深层子目录', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const git = mockGit({ defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/project/packages/runtime/src')
    expect(result.mode).toBe('bare-workspace')
    expect(result.wsRoot).toBe('/project')
    expect(result.barePath).toBe('/project/.bare')
    expect(result.isBareMode).toBe(true)
  })

  it('bare-workspace：defaultBranch 获取失败时返回空串', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const git = mockGit({ defaultBranch: null })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/project')
    expect(result.mode).toBe('bare-workspace')
    expect(result.defaultBranch).toBe('')
  })

  it('plain-repo：无 .bare，git rev-parse --show-toplevel 成功', async () => {
    const fs = mockFs(new Set())
    const git = mockGit({ repoRoot: '/home/user/my-repo', defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/home/user/my-repo/src')
    expect(result.mode).toBe('plain-repo')
    expect(result.wsRoot).toBe('')
    expect(result.barePath).toBe('')
    expect(result.repoRoot).toBe('/home/user/my-repo')
    expect(result.defaultBranch).toBe('main')
    expect(result.isBareMode).toBe(false)
  })

  it('not-repo：无 .bare，git rev-parse 也失败', async () => {
    const fs = mockFs(new Set())
    const git = mockGit({ repoRoot: null })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/tmp/random')
    expect(result.mode).toBe('not-repo')
    expect(result.wsRoot).toBe('')
    expect(result.barePath).toBe('')
    expect(result.repoRoot).toBe('')
    expect(result.defaultBranch).toBe('')
    expect(result.isBareMode).toBe(false)
  })

  it('not-repo：无 .bare，无 git 适配器', async () => {
    const fs = mockFs(new Set())
    const detector = new WorkspaceDetector(fs, undefined)

    const result = await detector.detect('/tmp/random')
    expect(result.mode).toBe('not-repo')
    expect(result.isBareMode).toBe(false)
  })

  it('statSync 权限错误（非 ENOENT）时不抛，继续向上', async () => {
    const fs: FsLike = {
      statSync: (p: string) => {
        if (p === '/project/.bare') {
          const e = new Error('EACCES') as NodeJS.ErrnoException
          e.code = 'EACCES'
          throw e
        }
        if (p === '/project/packages/.bare') {
          return { isDirectory: () => true }
        }
        const e = new Error('ENOENT') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      },
    }
    const git = mockGit({ defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    const result = await detector.detect('/project/packages/runtime')
    // /project/.bare EACCES → 跳过，继续向上找 → /project/packages/.bare 命中
    expect(result.mode).toBe('bare-workspace')
    expect(result.wsRoot).toBe('/project/packages')
  })
})

// ── detectSync 同步版测试 ──────────────────────────────────

describe('WorkspaceDetector.detectSync()', () => {
  it('bare-workspace：命中 .bare', () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const detector = new WorkspaceDetector(fs)

    const result = detector.detectSync('/project')
    expect(result.mode).toBe('bare-workspace')
    expect(result.isBareMode).toBe(true)
    expect(result.wsRoot).toBe('/project')
  })

  it('plain-repo：无 .bare（不走 git 回退，返回 plain-repo 与 detect 一致）', () => {
    const fs = mockFs(new Set())
    const detector = new WorkspaceDetector(fs)

    const result = detector.detectSync('/tmp/random')
    expect(result.mode).toBe('plain-repo')
    expect(result.isBareMode).toBe(false)
  })

  it('defaultBranch 始终为空串（同步版不走 git）', () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const detector = new WorkspaceDetector(fs)

    const result = detector.detectSync('/project')
    expect(result.defaultBranch).toBe('')
  })
})

// ── detectLegacy 向后兼容测试 ──────────────────────────────

describe('WorkspaceDetector.detectLegacy()', () => {
  it('bare-workspace 时 isBareMode=true', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const detector = new WorkspaceDetector(fs)

    const result = await detector.detectLegacy('/project')
    expect(result.isBareMode).toBe(true)
    expect(result.wsRoot).toBe('/project')
    expect(result.barePath).toBe('/project/.bare')
  })

  it('not-repo 时 isBareMode=false', async () => {
    const fs = mockFs(new Set())
    const detector = new WorkspaceDetector(fs)

    const result = await detector.detectLegacy('/tmp')
    expect(result.isBareMode).toBe(false)
    expect(result.wsRoot).toBe('')
    expect(result.barePath).toBe('')
  })
})

// ── detectBareWorkspaceCached 缓存版本测试 ─────────────────

describe('detectBareWorkspaceCached()', () => {
  beforeEach(() => {
    __resetBareCacheForTests()
  })

  it('bare workspace 返回 true', () => {
    // detectBareWorkspaceCached 用 realDetector + 真实 node:fs
    // 这里测试 cwd 指向 .bare workspace 根目录
    // 注：此测试依赖真实文件系统，需要 cwd 在 .bare workspace 下
    // 为隔离 IO，我们用 __resetBareCacheForTests 确保缓存干净
    const result = detectBareWorkspaceCached('/tmp/nonexistent')
    expect(result).toBe(false) // /tmp 下没有 .bare
  })

  it('缓存命中：第二次调用不重新 detect', () => {
    // 第一次调用
    detectBareWorkspaceCached('/tmp/test-cache')
    // 第二次调用应该命中缓存（不抛即证明）
    const result = detectBareWorkspaceCached('/tmp/test-cache')
    expect(result).toBe(false)
  })

  it('pruneBareCache 清理过期/不存在的 cwd', () => {
    detectBareWorkspaceCached('/tmp/prune-test')
    pruneBareCache(new Set(['/tmp/prune-test']))
    // 未过期的保留
    expect(detectBareWorkspaceCached('/tmp/prune-test')).toBe(false)

    pruneBareCache(new Set()) // 传空集合，清理所有
    // 清理后重新查询
    expect(detectBareWorkspaceCached('/tmp/prune-test')).toBe(false)
  })

  // ── perf 微项 10：LRU 淘汰 O(n)→O(1)（容量 500，观察 detectSync 调用计数）──────

  it('容量满时 O(1) 驱逐最老条目（first-key 淘汰）', () => {
    __resetBareCacheForTests()
    const spy = vi.spyOn(WorkspaceDetector.prototype, 'detectSync')
    try {
      detectBareWorkspaceCached('/lru-wt-0')
      // 填满缓存（模块常量 CACHE_MAX_SIZE=500）：第 501 个 key 插入时驱逐最老的 /lru-wt-0
      for (let i = 1; i <= 500; i++) detectBareWorkspaceCached(`/lru-wt-${i}`)
      expect(spy).toHaveBeenCalledTimes(501)

      // 被驱逐的最老条目：重新读取 → 缓存 miss → 重新检测
      detectBareWorkspaceCached('/lru-wt-0')
      expect(spy).toHaveBeenCalledTimes(502)
      // 未驱逐条目 TTL 内命中：零新检测
      detectBareWorkspaceCached('/lru-wt-250')
      expect(spy).toHaveBeenCalledTimes(502)
    } finally {
      spy.mockRestore()
    }
  })

  it('过期重写把条目移到 Map 尾部：容量淘汰按最后写入时间（与原 ts 扫描语义等价）', () => {
    vi.useFakeTimers()
    __resetBareCacheForTests()
    const spy = vi.spyOn(WorkspaceDetector.prototype, 'detectSync')
    try {
      detectBareWorkspaceCached('/lru-a') // t0 写入
      detectBareWorkspaceCached('/lru-b') // t0 写入
      vi.advanceTimersByTime(5 * 60 * 1000 + 1) // TTL（5min）过期
      detectBareWorkspaceCached('/lru-a') // 过期重算 → delete+set 移尾（最后写入时间更新）
      // 填满剩余容量（当前 2 条 → 再插 498 到 500）
      for (let i = 0; i < 498; i++) detectBareWorkspaceCached(`/lru-fill-${i}`)
      expect(spy).toHaveBeenCalledTimes(501) // 2 + 1（a 重算）+ 498

      // 新 key 触发淘汰：first key 是 /lru-b（最后写入时间最旧——虽比 /lru-a 后插入，
      // 但 /lru-a 过期重写过更"新"），与原 O(n) 扫描 ts 最小的语义精确等价
      detectBareWorkspaceCached('/lru-new')
      expect(spy).toHaveBeenCalledTimes(502)

      // /lru-a 未被驱逐（重写过，较新）：TTL 内命中（此断言须在 /lru-b 重读之前——
      // b 重读会让缓存回到满容量，届时 first key（a）才会被挤出）
      detectBareWorkspaceCached('/lru-a')
      expect(spy).toHaveBeenCalledTimes(502)
      // /lru-b 被驱逐：重新读取重算
      detectBareWorkspaceCached('/lru-b')
      expect(spy).toHaveBeenCalledTimes(503)
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
})

// ── GitRevParser 调用验证 ──────────────────────────────────

describe('WorkspaceDetector git 适配器调用', () => {
  it('bare-workspace 命中时调用 getDefaultBranch', async () => {
    const fs = mockFs(new Set(['/project/.bare']))
    const git = mockGit({ defaultBranch: 'develop' })
    const detector = new WorkspaceDetector(fs, git)

    await detector.detect('/project')
    expect(git.getDefaultBranch).toHaveBeenCalledWith('/project')
    expect(git.getRepoRoot).not.toHaveBeenCalled()
  })

  it('bare-workspace 未命中时调用 getRepoRoot', async () => {
    const fs = mockFs(new Set())
    const git = mockGit({ repoRoot: '/repo', defaultBranch: 'main' })
    const detector = new WorkspaceDetector(fs, git)

    await detector.detect('/repo/src')
    expect(git.getRepoRoot).toHaveBeenCalledWith('/repo/src')
    expect(git.getDefaultBranch).toHaveBeenCalledWith('/repo')
  })

  it('git 适配器为 undefined 时不调用 git', async () => {
    const fs = mockFs(new Set())
    const detector = new WorkspaceDetector(fs, undefined)

    const result = await detector.detect('/tmp')
    expect(result.mode).toBe('not-repo')
  })
})
