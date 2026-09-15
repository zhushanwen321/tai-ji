/**
 * GitInfoReader 缓存测试（perf 微项 10：LRU 淘汰 O(n)→O(1)）。
 *
 * 观察手段：vi.mock node:child_process 的 execSync，计数缓存 miss 时的真实探测；
 * readGitInfoUncached 内的 statSync 走真实 fs（路径不存在 → isWorktree=false，快速 ENOENT）。
 *
 * 覆盖三点：
 * 1. TTL 内命中缓存（零新探测）
 * 2. 容量满时驱逐最老条目（first-key O(1) 淘汰）
 * 3. 过期重写移位后淘汰按「最后写入时间」——与原 O(n) 扫描 ts 最小的语义精确等价
 *
 * 测试框架 vitest，运行命令 npx vitest run。
 */
import { execSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitInfoReader, __resetGitInfoCacheForTests } from './git-info-reader.js'

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => 'main\n') }))

const execSyncMock = vi.mocked(execSync)

describe('GitInfoReader.readGitInfo 缓存（微项 10：LRU O(1) 淘汰）', () => {
  beforeEach(() => {
    __resetGitInfoCacheForTests()
    execSyncMock.mockClear()
  })

  it('TTL 内二次读取命中缓存：零新探测', () => {
    const reader = new GitInfoReader()
    const first = reader.readGitInfo('/git-info-repo')
    const second = reader.readGitInfo('/git-info-repo')
    expect(first).toEqual({ branch: 'main', isWorktree: false })
    expect(second).toEqual(first)
    expect(execSyncMock).toHaveBeenCalledTimes(1)
  })

  it('容量满时 O(1) 驱逐最老条目（first-key 淘汰）', () => {
    const reader = new GitInfoReader()
    reader.readGitInfo('/lru-repo-0')
    // 填满缓存（模块常量 CACHE_MAX_SIZE=500）：第 501 个 key 插入时驱逐最老的 /lru-repo-0
    for (let i = 1; i <= 500; i++) reader.readGitInfo(`/lru-repo-${i}`)
    expect(execSyncMock).toHaveBeenCalledTimes(501)

    // 被驱逐的最老条目：重新读取 → 缓存 miss → 重新探测
    reader.readGitInfo('/lru-repo-0')
    expect(execSyncMock).toHaveBeenCalledTimes(502)
    // 未驱逐条目 TTL 内命中：零新探测
    reader.readGitInfo('/lru-repo-250')
    expect(execSyncMock).toHaveBeenCalledTimes(502)
  })

  it('过期重写把条目移到 Map 尾部：容量淘汰按最后写入时间（与原 ts 扫描语义等价）', () => {
    vi.useFakeTimers()
    try {
      const reader = new GitInfoReader()
      reader.readGitInfo('/lru-a') // t0 写入
      reader.readGitInfo('/lru-b') // t0 写入
      vi.advanceTimersByTime(5 * 60 * 1000 + 1) // TTL（5min）过期
      reader.readGitInfo('/lru-a') // 过期重算 → delete+set 移尾（最后写入时间更新）
      // 填满剩余容量（当前 2 条 → 再插 498 到 500）
      for (let i = 0; i < 498; i++) reader.readGitInfo(`/lru-fill-${i}`)
      expect(execSyncMock).toHaveBeenCalledTimes(501) // 2 + 1（a 重算）+ 498

      // 新 key 触发淘汰：first key 是 /lru-b（最后写入时间最旧——虽比 /lru-a 后插入，
      // 但 /lru-a 过期重写过更"新"），与原 O(n) 扫描 ts 最小的语义精确等价
      reader.readGitInfo('/lru-new')
      expect(execSyncMock).toHaveBeenCalledTimes(502)

      // /lru-a 未被驱逐（重写过，较新）：TTL 内命中（注意此断言须在 /lru-b 重读之前——
      // b 重读会让缓存回到满容量，届时 first key（a）才会被挤出）
      reader.readGitInfo('/lru-a')
      expect(execSyncMock).toHaveBeenCalledTimes(502)
      // /lru-b 被驱逐：重新读取重算
      reader.readGitInfo('/lru-b')
      expect(execSyncMock).toHaveBeenCalledTimes(503)
    } finally {
      vi.useRealTimers()
    }
  })
})
