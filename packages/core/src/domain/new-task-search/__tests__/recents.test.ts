/**
 * useRecents 单测（IF6，core 版）。
 *
 * 覆盖 plan TC-11..TC-12：FIFO 每类 ≤5、同 key 幂等、Math.max+1 时间戳兜底、
 * JSON 脏数据降级、写失败降级内存态、跨类型独立 FIFO。
 * KVStorage 用 Map 实现 mock（async 语义对齐 PlatformPort.storage 契约）。
 * 环境：vitest node。
 */
import { describe, expect, it, vi } from 'vitest'
import type { KVStorage } from '../../../platform/port'
import { useRecents } from '../recents'
import type { RecentEntry } from '../types'

/** Map 实现 KVStorage（get 可注入失败场景） */
function makeMockStorage(initial?: Record<string, string>): KVStorage & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null
    },
    async set(key: string, value: string) {
      store.set(key, value)
    },
    async remove(key: string) {
      store.delete(key)
    },
  }
}

function entry(over: Partial<RecentEntry>): RecentEntry {
  return { type: 'file', key: 'file:x', timestamp: Date.now(), title: 'x', sub: 'src', ...over }
}

describe('TC-11: FIFO + 幂等 + 兜底', () => {
  it('写后读回：每类 ≤RECENTS_PER_TYPE（5）', async () => {
    const storage = makeMockStorage()
    const recents = useRecents(storage)

    // 同类型写 7 条（timestamp 递增由 write 内部 Math.max+1 兜底）
    for (let i = 0; i < 7; i++) {
      await recents.write(entry({ type: 'file', key: `file:k${i}`, title: `k${i}` }))
    }

    const list = await recents.read()
    expect(list).toHaveLength(5) // 每类 ≤5
    // FIFO 倒序：最新在前
    expect(list[0].key).toBe('file:k6')
    expect(list[4].key).toBe('file:k2')
  })

  it('同 key 幂等：更新 timestamp 不新增（AC-3.5）', async () => {
    const storage = makeMockStorage()
    const recents = useRecents(storage)
    await recents.write(entry({ key: 'file:x', title: 'x' }))
    await recents.write(entry({ key: 'file:x', title: 'x' }))

    const list = await recents.read()
    expect(list).toHaveLength(1)
    expect(list[0].key).toBe('file:x')
  })

  it('Math.max+1 时间戳兜底：同毫秒连续 write 仍有序（AC-3.6）', async () => {
    const storage = makeMockStorage()
    const recents = useRecents(storage)
    const now = Date.now()
    const e1 = entry({ type: 'file', key: 'file:a', timestamp: now, title: 'a' })
    const e2 = entry({ type: 'file', key: 'file:b', timestamp: now, title: 'b' })
    await recents.write(e1)
    await recents.write(e2)

    const list = await recents.read()
    expect(list[0].key).toBe('file:b') // 后写优先
    expect(list[0].timestamp).toBeGreaterThan(list[1].timestamp)
  })

  it('跨类型独立 FIFO（各自 ≤5）', async () => {
    const storage = makeMockStorage()
    const recents = useRecents(storage)
    for (let i = 0; i < 6; i++) {
      await recents.write(entry({ type: 'file', key: `file:k${i}` }))
      await recents.write(entry({ type: 'session', key: `session:k${i}`, title: `s${i}` }))
    }

    const list = await recents.read()
    const files = list.filter((e) => e.type === 'file')
    const sessions = list.filter((e) => e.type === 'session')
    expect(files).toHaveLength(5)
    expect(sessions).toHaveLength(5)
  })

  it('首用（storage 无 key）read → []（AC-3.3）', async () => {
    const recents = useRecents(makeMockStorage())
    expect(await recents.read()).toEqual([])
  })
})

describe('TC-12: 失败降级', () => {
  it('JSON 脏数据 read → []（MR-3.1 不崩溃）', async () => {
    const storage = makeMockStorage({ 'taiji:search-recents': '{invalid json' })
    const recents = useRecents(storage)
    expect(await recents.read()).toEqual([])
  })

  it('storage.set 抛错 → write 返 false 内存态保留（MR-3.3 不抛）', async () => {
    const storage = makeMockStorage()
    const failing: KVStorage = {
      ...storage,
      async set() {
        throw new Error('QuotaExceededError')
      },
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const recents = useRecents(failing)
      const ok = await recents.write(entry({ key: 'file:x' }))
      expect(ok).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('storage.get 抛错 → read → []（不抛）', async () => {
    const storage = makeMockStorage()
    const failing: KVStorage = {
      ...storage,
      async get() {
        throw new Error('read failed')
      },
    }
    const recents = useRecents(failing)
    expect(await recents.read()).toEqual([])
  })
})
