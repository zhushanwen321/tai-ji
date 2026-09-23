/**
 * workspaceStore 单测 —— W3 前端改接 workspaceStore。
 *
 * 覆盖：
 * - T3.1: defaultCwd = records[0]?.cwd
 * - T3.2: records 空 → defaultCwd undefined
 * - T3.4: RPC reject 降级（records 置 [] 不抛）
 *
 * mock 策略：mock workspaceApi.listRecent 返回值。
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/new-task/workspace-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RecentWorkspaceRecord } from '@taiji/shared'

// mock @/api 门面的 workspace（store 走门面，mock 路径须与 store import 一致；vi.mock 自动 hoist）
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  workspace: { listRecent: vi.fn(), record: vi.fn() },
}))

import { useWorkspaceStore } from '@/stores/workspace'
import { workspace } from '@/api'

// store 现经门面调 workspace.listRecent / workspace.record；mock 后此处即 vi.fn 实例
const mockListRecent = workspace.listRecent as unknown as ReturnType<typeof vi.fn>
const mockRecord = workspace.record as unknown as ReturnType<typeof vi.fn>

function mkRecord(cwd: string, lastUsedAt: number): RecentWorkspaceRecord {
  return { cwd, lastUsedAt, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockListRecent.mockReset()
  mockRecord.mockReset()
})

describe('workspaceStore.load（T3.1 / T3.2）', () => {
  it('T3.1: defaultCwd = records[0]?.cwd（首条记录的 cwd）', async () => {
    mockListRecent.mockResolvedValue([
      mkRecord('/repo-a', 300),
      mkRecord('/repo-b', 200),
    ])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBe('/repo-a')
    expect(store.records).toHaveLength(2)
  })

  it('T3.2: records 空 → defaultCwd undefined', async () => {
    mockListRecent.mockResolvedValue([])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBeUndefined()
    expect(store.records).toEqual([])
  })
})

describe('workspaceStore.load 降级（T3.4）', () => {
  it('RPC reject → records 置 [] 不抛', async () => {
    mockListRecent.mockRejectedValue(new Error('RPC timeout'))
    const store = useWorkspaceStore()
    // 不抛
    await store.load()
    expect(store.records).toEqual([])
    expect(store.defaultCwd).toBeUndefined()
  })

  it('RD-3#4: RPC reject → 补 console.warn + loadError 标记（读失败 ≠ 无历史，可观测）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mockListRecent.mockRejectedValue(new Error('RPC timeout'))
      const store = useWorkspaceStore()
      await store.load()
      // AC-4.5 口径不变：records 置 [] 不抛、不阻断启动（不加错误条/重试）
      expect(store.records).toEqual([])
      // RD-3#4：留痕 + 标记，让「读失败」与「真无历史」在观测面可分
      expect(store.loadError).toBe('RPC timeout')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[workspace] load failed'),
        'RPC timeout',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('RD-3#4: load 成功 → loadError 清空（失败标记不残留）', async () => {
    const store = useWorkspaceStore()
    mockListRecent.mockRejectedValueOnce(new Error('transient'))
    await store.load()
    expect(store.loadError).toBe('transient')

    mockListRecent.mockResolvedValueOnce([mkRecord('/repo-a', 300)])
    await store.load()
    expect(store.loadError).toBeNull()
    expect(store.records).toHaveLength(1)
  })
})

describe('workspaceStore.record（热更新）', () => {
  it('record(cwd) → 调 api.record 并用返回的最新 records 覆盖 store', async () => {
    const fresh = [mkRecord('/new', 400), mkRecord('/repo-a', 300)]
    mockRecord.mockResolvedValue(fresh)
    const store = useWorkspaceStore()
    await store.record('/new')
    expect(mockRecord).toHaveBeenCalledWith('/new')
    expect(store.records).toEqual(fresh)
    expect(store.defaultCwd).toBe('/new')
  })

  it('record RPC reject → 静默降级不抛（不阻断选目录流程）', async () => {
    mockRecord.mockRejectedValue(new Error('RPC timeout'))
    const store = useWorkspaceStore()
    // 不抛
    await store.record('/new')
  })

  it('record 空串 → noop 不调 api', async () => {
    const store = useWorkspaceStore()
    await store.record('')
    expect(mockRecord).not.toHaveBeenCalled()
  })
})
