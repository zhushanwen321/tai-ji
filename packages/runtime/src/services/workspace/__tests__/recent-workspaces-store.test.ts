/**
 * RecentWorkspacesStore pin 语义测试（2026-10-22「pin 固定目录」需求）。
 *
 * 覆盖：setPinned 翻转 / pinned 豁免 LRU 淘汰（INV-6）/ 未 pinned 区独立上限（MAX_RECORDS=6）/
 * pin 上限 MAX_PINNED=5 拒绝 / list() 两区排序（pinned 置前，组内 lastUsedAt 倒序）。
 *
 * 运行命令：cd packages/runtime && pnpm test -- recent-workspaces-store
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecentWorkspacesStore } from '../recent-workspaces-store.js'

let configDir: string

function makeStore(): RecentWorkspacesStore {
  return new RecentWorkspacesStore(configDir)
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'recent-workspaces-test-'))
})

afterEach(() => {
  // maxRetries：teardown 递归删除与在途异步写竞争时一次瞬态失败即抛（ENOTEMPTY flake，
  // 教训 commit d9ad39cb）——rmSync 默认 maxRetries=0，显式带重试。
  rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('RecentWorkspacesStore pin 语义', () => {
  it('setPinned 翻转 pinned 标记，list() 中 pinned 条目置前', () => {
    const store = makeStore()
    store.record('/a')
    store.record('/b')

    expect(store.setPinned('/b', true)).toBe(true)
    expect(store.list().map((r) => r.cwd)).toEqual(['/b', '/a'])
    expect(store.list()[0].pinned).toBe(true)

    expect(store.setPinned('/b', false)).toBe(true)
    // unpin 后回到最近使用排序（两 record 同毫秒时序不稳定，只断言成员与 pinned 清除）
    const after = store.list()
    expect(after.map((r) => r.cwd).sort()).toEqual(['/a', '/b'])
    expect(after.every((r) => !r.pinned)).toBe(true)
  })

  it('pinned 条目豁免 LRU 淘汰：record 7 条后未 pinned 的最新 6 条保留，pinned 恒在', () => {
    const store = makeStore()
    // pin 最旧的条目
    store.record('/pinned-old')
    store.record('/r1')
    store.setPinned('/pinned-old', true)
    // 再 record 6 条（总未 pinned 条数达 7 > 6 → 淘汰未 pinned 最旧者 /r1）
    for (const cwd of ['/r2', '/r3', '/r4', '/r5', '/r6', '/r7']) store.record(cwd)

    const cwds = store.list().map((r) => r.cwd)
    expect(cwds).toContain('/pinned-old') // pinned 豁免淘汰
    expect(cwds).not.toContain('/r1') // 未 pinned 最旧者被淘汰
    expect(cwds).toContain('/r7') // 未 pinned 最新者保留
    expect(store.list().filter((r) => !r.pinned)).toHaveLength(6) // 未 pinned 区保持 ≤6
  })

  it('未 pinned 区独立上限：pinned 条目不挤占最近区名额', () => {
    const store = makeStore()
    // pin 5 条（达上限）
    for (let i = 0; i < 5; i++) {
      store.record(`/p${i}`)
      store.setPinned(`/p${i}`, true)
    }
    // 最近区 record 6 条
    for (let i = 0; i < 6; i++) store.record(`/r${i}`)

    const list = store.list()
    expect(list.filter((r) => r.pinned)).toHaveLength(5)
    expect(list.filter((r) => !r.pinned)).toHaveLength(6)
    expect(list[0].pinned).toBe(true) // pinned 置前
  })

  it('pin 上限 5：第 6 个 pin 拒绝（返回 false，列表不变）', () => {
    const store = makeStore()
    for (let i = 0; i < 5; i++) {
      store.record(`/p${i}`)
      expect(store.setPinned(`/p${i}`, true)).toBe(true)
    }
    store.record('/r0')
    expect(store.setPinned('/r0', true)).toBe(false)
    expect(store.list().find((r) => r.cwd === '/r0')?.pinned).toBeFalsy()
  })

  it('setPinned 条目不存在 → no-op 生效（返回 true，不抛）', () => {
    const store = makeStore()
    expect(store.setPinned('/not-exist', true)).toBe(true)
    expect(store.list()).toHaveLength(0)
  })
})
