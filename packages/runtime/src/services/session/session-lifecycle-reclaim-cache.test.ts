/**
 * SessionLifecycle.reclaimManagedSession × B8 历史缓存驱逐（memory-leak-remediation
 * §3.3-B8 候选 C）接线测试。
 *
 * 锁定语义：
 * - reclaim 成功路径调用 ReclaimSessionDeps.evictHistoryRebuildCache（驱逐该 session 的
 *   HistoryRebuildCache 条目——回收不是销毁，刻意不走 removeSessionEntry 汇聚点）。
 * - 驱逐挂代际校验通过后的成功路径：未回收路径（session 不存在 / 代际校验取消）不驱逐
 *   （并发重建的新 session 无辜，不摘其缓存）。
 * - 端到端（全 fake，无真 pi）：reclaim 前缓存命中 → reclaim 驱逐 → 重激活（新 client）
 *   全量重建 → 写回新缓存（P7 张力四要素显式登记的代价：重激活走单次全量重建）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/session-lifecycle-reclaim-cache.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { SessionLifecycle } from './session-lifecycle.js'
import { ReclaimSeat } from './idle-pi-reaper.js'
import { HistoryRebuildCache, SessionHistoryReader } from './history-rebuild-cache.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from './session-internal.js'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { IEventAdapter } from '../../interfaces.js'
import type { SessionSummary } from '@xyz-agent/shared'
import type { PiSessionEntry } from '../../infra/pi/pi-protocol.js'

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: tmpdir(), status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

function makeFakeAdapter(): IEventAdapter {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter
}

/**
 * 最小 lifecycle 环境（mock 分层对齐 session-lifecycle-gate.test.ts 的 makeEnv；
 * pm.hasClient 可编排——代际校验取消路径的注入点）。
 */
function makeEnv() {
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: { id: string }) => makeSummary(s.id)),
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const client = {} as IPiEngine
  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
    getClient: vi.fn(() => client),
    hasClient: vi.fn(() => false),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => makeFakeAdapter(),
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { svc, pm, lifecycle }
}

function entry(id: string, parentId: string | null = null): PiSessionEntry {
  return { id, type: 'message', parentId, timestamp: '2026-09-14T00:00:00.000Z' } as unknown as PiSessionEntry
}

function msg(piEntryId: string) {
  return {
    id: `m-${piEntryId}`,
    role: 'user' as const,
    content: `content-${piEntryId}`,
    status: 'complete' as const,
    piEntryId,
    timestamp: 1,
  }
}

/**
 * 独立 fake 的 SessionHistoryReader（getEntries 脚本出队 + 直通重建，mock 分层对齐
 * session-history-incremental.test.ts）。lifecycle 与 reader 各持各的 pm fake——本测试
 * 只锁「reclaim 编排 → 驱逐接口」的接线，pi 进程语义由 lifecycle fake 承担。
 */
function makeReader(script: Array<{ data?: { entries: PiSessionEntry[]; leafId: string | null } } | Error>) {
  const calls: Array<{ since?: string }> = []
  const client = {
    getEntries: vi.fn(async (since?: string) => {
      calls.push({ since })
      const step = script.shift()
      if (step instanceof Error) throw step
      if (!step) throw new Error('getEntries script exhausted')
      return step
    }),
  } as unknown as IPiEngine
  const pm = { onSessionExit: vi.fn(), getClient: vi.fn(() => client) } as unknown as IProcessManager
  const sessionStore = {
    rebuildHistoryFromEntries: vi.fn((entries: PiSessionEntry[]) => ({
      messages: entries.map((e) => msg(e.id)),
      orphanToolResults: [],
    })),
    scanSessions: vi.fn(() => []),
    extractSessionOutcome: vi.fn(() => null),
    persistSessionEnd: vi.fn(),
  } as never
  const cache = new HistoryRebuildCache()
  const reader = new SessionHistoryReader({ pm, sessionStore }, cache)
  return { reader, cache, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionLifecycle.reclaimManagedSession × B8 历史缓存驱逐', () => {
  it('回收成功路径调用 evictHistoryRebuildCache；未注入时静默跳过（可选依赖）', async () => {
    const { pm, lifecycle } = makeEnv()
    await lifecycle.registerSession('s1', pm.getClient('s1') as IPiEngine, tmpdir(), 't')
    expect(lifecycle.has('s1')).toBe(true)

    const evictSpy = vi.fn()
    const reclaimed = await lifecycle.reclaimManagedSession('s1', {
      seat: new ReclaimSeat(),
      evictHistoryRebuildCache: evictSpy,
    })
    expect(reclaimed).toBe(true)
    expect(evictSpy).toHaveBeenCalledTimes(1)
    expect(evictSpy).toHaveBeenCalledWith('s1')
    expect(lifecycle.has('s1')).toBe(false)

    // 可选依赖缺省：不注入不炸（装配遗漏 = 回退到 B8 前行为，非硬错误）
    await lifecycle.registerSession('s2', pm.getClient('s2') as IPiEngine, tmpdir(), 't')
    const reclaimedNoDep = await lifecycle.reclaimManagedSession('s2', { seat: new ReclaimSeat() })
    expect(reclaimedNoDep).toBe(true)
  })

  it('未回收路径不驱逐：session 不存在 / 代际校验取消（hasClient 命中）', async () => {
    const { pm, lifecycle } = makeEnv()
    const evictSpy = vi.fn()

    // ① session 不在 Map（未附着）→ 直接 false，不驱逐
    const unknown = await lifecycle.reclaimManagedSession('nope', {
      seat: new ReclaimSeat(),
      evictHistoryRebuildCache: evictSpy,
    })
    expect(unknown).toBe(false)

    // ② 代际校验取消：destroySession 后 hasClient 仍命中（并发重建占位）→ false，不驱逐
    await lifecycle.registerSession('s1', pm.getClient('s1') as IPiEngine, tmpdir(), 't')
    ;(pm.hasClient as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const cancelled = await lifecycle.reclaimManagedSession('s1', {
      seat: new ReclaimSeat(),
      evictHistoryRebuildCache: evictSpy,
    })
    expect(cancelled).toBe(false)
    expect(evictSpy).not.toHaveBeenCalled()
  })

  it('端到端（全 fake）：reclaim 驱逐缓存 → 重激活全量重建 → 写回新缓存（后续增量命中）', async () => {
    const { pm, lifecycle } = makeEnv()
    const full = { data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-1' } }
    const { reader, cache, calls } = makeReader([full, { ...full }, { data: { entries: [], leafId: 'leaf-1' } }])

    await lifecycle.registerSession('s-e2e', pm.getClient('s-e2e') as IPiEngine, tmpdir(), 't')

    // 回收前：getHistory 建立缓存（全量 → 增量路径可用）
    const before = await reader.getHistory('s-e2e')
    expect(before.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(cache.size).toBe(1)

    // reclaim（驱逐接口接线 = 生产组合根形态：evictHistoryRebuildCache → onSessionReclaimed）
    const reclaimed = await lifecycle.reclaimManagedSession('s-e2e', {
      seat: new ReclaimSeat(),
      evictHistoryRebuildCache: (s) => reader.onSessionReclaimed(s),
    })
    expect(reclaimed).toBe(true)
    expect(cache.size).toBe(0) // 驱逐生效
    expect(cache.get('s-e2e')).toBeUndefined()

    // 重激活（restore 语义）：无缓存 → 全量重建（无 since）→ 写回新缓存
    const after = await reader.getHistory('s-e2e')
    expect(after.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(cache.size).toBe(1)

    // 后续命中新缓存：since 增量 + 空 delta 短路（新缓存生效的行为级证据）
    const third = await reader.getHistory('s-e2e')
    expect(calls.map((c) => c.since)).toEqual([undefined, undefined, 'leaf-1'])
    expect(third.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
  })
})
