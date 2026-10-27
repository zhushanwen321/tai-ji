// @vitest-environment node

/**
 * workspaceStore 单测 —— W3 前端改接 workspaceStore。
 *
 * 覆盖：
 * - T3.1: defaultCwd = records[0]?.cwd
 * - T3.2: records 空 → defaultCwd undefined
 * - T3.4: RPC reject 降级（保留旧 records 不抛；§6.4 降级型显式行为改进——原置空口径已废）
 *
 * mock 策略：mock workspaceApi.listRecent 返回值。
 *
 * 单文件多源合并（2 源同装载簇，全 node 环境）：workspace-store（本节，最大源）+
 * session-api——mock 正交（本节 mock '@/api' 门面；session-api 节不 mock @/api，
 * 只 mock core ws-client 与 core pending 相对路径，core domains/session 真实实现
 * 不经门面），零冲突。各节以裸块隔离。
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/new-task/workspace-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RecentWorkspaceRecord, SessionSummary } from '@taiji/shared'

// mock @/api 门面的 workspace（store 走门面，mock 路径须与 store import 一致；vi.mock 自动 hoist）
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  workspace: { listRecent: vi.fn(), record: vi.fn(), defaultSessionDir: vi.fn(), setPinned: vi.fn() },
}))

import { useWorkspaceStore } from '@/stores/workspace'
import { workspace } from '@/api'
import { create } from '@taiji/core/transport/api/domains/session'

// store 现经门面调 workspace.listRecent / workspace.record；mock 后此处即 vi.fn 实例
const mockListRecent = workspace.listRecent as unknown as ReturnType<typeof vi.fn>
const mockRecord = workspace.record as unknown as ReturnType<typeof vi.fn>
const mockDefaultSessionDir = workspace.defaultSessionDir as unknown as ReturnType<typeof vi.fn>
const mockSetPinned = workspace.setPinned as unknown as ReturnType<typeof vi.fn>

function mkRecord(cwd: string, lastUsedAt: number): RecentWorkspaceRecord {
  return { cwd, lastUsedAt, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockListRecent.mockReset()
  mockRecord.mockReset()
  mockDefaultSessionDir.mockReset()
  mockSetPinned.mockReset()
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
  it('RPC reject → 保留旧 records 不抛（§6.4 降级型显式行为改进：断连重拉失败不闪空列表）', async () => {
    mockListRecent.mockResolvedValueOnce([mkRecord('/repo-a', 300)])
    const store = useWorkspaceStore()
    await store.load()
    // 重拉失败（断连重拉形态）
    mockListRecent.mockRejectedValue(new Error('RPC timeout'))
    await store.load()
    // 保留旧值（不置空）+ defaultCwd 跟随旧值
    expect(store.records).toEqual([mkRecord('/repo-a', 300)])
    expect(store.defaultCwd).toBe('/repo-a')
  })

  it('RD-3#4: RPC reject → 补 console.warn + loadError 标记（读失败 ≠ 无历史，可观测）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mockListRecent.mockResolvedValueOnce([mkRecord('/repo-a', 300)])
      const store = useWorkspaceStore()
      await store.load()
      mockListRecent.mockRejectedValue(new Error('RPC timeout'))
      await store.load()
      // 保留旧值不置空（§6.4 降级型）
      expect(store.records).toEqual([mkRecord('/repo-a', 300)])
      // RD-3#4：留痕 + 标记，让「读失败」与「真无历史」在观测范围可分
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

describe('defaultCwd pinned 过滤（pin 固定目录 wave）', () => {
  it('首条记录 pinned → defaultCwd 取第一条未 pinned 的 cwd（pinned 条目不参与默认 cwd）', async () => {
    const pinned = { ...mkRecord('/pinned', 500), pinned: true }
    mockListRecent.mockResolvedValue([pinned, mkRecord('/normal', 400)])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBe('/normal')
  })

  it('全部记录 pinned → defaultCwd undefined（无可用默认目录）', async () => {
    mockListRecent.mockResolvedValue([{ ...mkRecord('/pinned', 500), pinned: true }])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBeUndefined()
  })
})

describe('workspaceStore.loadDefaultSessionDir（默认会话目录）', () => {
  it('成功 → defaultSessionDir = RPC 返回目录（landing「默认会话」入口数据源）', async () => {
    mockDefaultSessionDir.mockResolvedValue('/data/defaultSession')
    const store = useWorkspaceStore()
    await store.loadDefaultSessionDir()
    expect(mockDefaultSessionDir).toHaveBeenCalledTimes(1)
    expect(store.defaultSessionDir).toBe('/data/defaultSession')
  })

  it('RPC reject → defaultSessionDir 置空串不抛（空串 = 入口隐藏，降级不阻断启动）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mockDefaultSessionDir.mockRejectedValue(new Error('RPC timeout'))
      const store = useWorkspaceStore()
      await store.loadDefaultSessionDir()
      expect(store.defaultSessionDir).toBe('')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('loadDefaultSessionDir failed'),
        expect.any(Error),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('workspaceStore.setPinned（pin/unpin）', () => {
  it('成功且未降级 → records 用回传列表热更新，返回 true', async () => {
    const fresh = [{ ...mkRecord('/pinned-a', 500), pinned: true }, mkRecord('/repo-a', 300)]
    mockSetPinned.mockResolvedValue({ records: fresh, degraded: false })
    const store = useWorkspaceStore()
    const ok = await store.setPinned('/pinned-a', true)
    expect(mockSetPinned).toHaveBeenCalledWith('/pinned-a', true)
    expect(ok).toBe(true)
    expect(store.records).toEqual(fresh)
  })

  it('成功但 degraded=true（超 pin 上限被拒）→ 返回 false，列表以 runtime 回传为准', async () => {
    const unchanged = [mkRecord('/repo-a', 300)]
    mockSetPinned.mockResolvedValue({ records: unchanged, degraded: true })
    const store = useWorkspaceStore()
    const ok = await store.setPinned('/pinned-a', true)
    expect(ok).toBe(false)
    expect(store.records).toEqual(unchanged)
  })

  it('RPC reject → 返回 false 且保留旧 records（stale 降级，与 record 同款不抛）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const stale = [mkRecord('/repo-a', 300)]
      mockSetPinned.mockRejectedValue(new Error('RPC timeout'))
      const store = useWorkspaceStore()
      store.records = stale
      const ok = await store.setPinned('/pinned-a', true)
      expect(ok).toBe(false)
      expect(store.records).toEqual(stale)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('setPinned failed'),
        expect.any(Error),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ══════════ 来源：session-api.test.ts ══════════
// 其 ws-client / core pending mock 与 hoisted 常量在模块顶层（vi.mock 块内声明不被
// hoisting 提升，顶层 create import 期模块图已解析，块内 mock 会失效）
/**
 * sessionApi.create cwd 透传契约单测（#1，T1.1 配套 api 层片段）。
 *
 * 覆盖：
 * - create(cwd) → WS payload 含 cwd 字段（AC-1.1）
 * - create() 无参 → payload 不含 cwd 字段（runtime 回退 process.cwd()，AC-1.2 回归）
 * - create(cwd, label) → label 透传
 *
 * mock 策略：mock core ws-client（捕获 send payload）+ core pending 源文件相对路径
 * （返回可控 id/Promise），验证 session.create 消息 payload 形状。不 mock @/api
 * （直接测 domains/session 真实实现）。request 已下沉 core（tc u1），mock 目标须与
 * core 内相对 import 同一模块 ID 才能拦截。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/new-task/session-api.test.ts
 */

// 捕获 transport.send 收到的消息（含 payload 形状）
// （send 返回 true = 消息已送出，符合 transport.send 的 boolean 契约：
// request.command 对 send false 会走 fast-fail reject）
const transportMock = vi.hoisted(() => {
  const sent: Array<{ type: string; id: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    send: vi.fn((msg: { type: string; id: string; payload: Record<string, unknown> }): boolean => {
      sent.push(msg)
      return true
    }),
  }
})

vi.mock('@taiji/core/transport/ws-client', () => ({ send: transportMock.send }))
vi.mock('../../../../core/src/transport/api/pending', () => ({
  RPC_BACKSTOP_TIMEOUT_MS: 65_000,
  createCommandId: vi.fn(() => 'pid-1'),
  register: vi.fn(() =>
    Promise.resolve({ session: { id: 's1', cwd: '/x', status: 'idle' } as SessionSummary }),
  ),
  reject: vi.fn(),
}))

{
beforeEach(() => {
  transportMock.sent.length = 0
  transportMock.send.mockClear()
})

describe('sessionApi.create cwd 透传', () => {
  it('create(cwd) → payload 含 cwd 字段（AC-1.1）', async () => {
    await create('/repo')
    expect(transportMock.send).toHaveBeenCalledTimes(1)
    const msg = transportMock.sent[0]
    expect(msg.type).toBe('session.create')
    expect(msg.payload).toHaveProperty('cwd', '/repo')
  })

  it('create() 无参 → payload 不含 cwd 字段（AC-1.2 回归，runtime 回退）', async () => {
    await create()
    const msg = transportMock.sent[0]
    expect(msg.payload).not.toHaveProperty('cwd')
  })

  it('create(cwd, label) → label 透传，cwd 透传', async () => {
    await create('/repo', 'my-label')
    const msg = transportMock.sent[0]
    expect(msg.payload).toHaveProperty('cwd', '/repo')
    expect(msg.payload).toHaveProperty('label', 'my-label')
  })

  it('create() 无参 → label 也不强制写入（undefined 不写入键）', async () => {
    await create()
    const msg = transportMock.sent[0]
    // label 为 undefined 时同样不写入 payload 键，保持 payload 干净
    expect(msg.payload).not.toHaveProperty('label')
  })

  it('解包 reply envelope .session 返回 SessionSummary', async () => {
    const result = await create('/repo')
    expect(result).toMatchObject({ id: 's1', cwd: '/x', status: 'idle' })
  })
})
}
