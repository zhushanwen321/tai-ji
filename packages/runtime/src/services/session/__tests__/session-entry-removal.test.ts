/**
 * SessionEntryRemovalOrchestrator 销毁收敛链单步隔离测试（code-harden RT-4#1）。
 *
 * 锁定：
 * - 链内某步抛错（disposeProjection）→ 该步降级为 console.error + crash 台账
 *   （reason=destroy-chain-step-failed），**后续步骤继续收敛**（removeEntry /
 *   disposeRecords / clearMessageBusSession 必达），onSessionDestroyed 扇出照常。
 * - 其余 session 不受累：抛错后对另一 session 的 remove 全链正常完成。
 * - toSummary 抛错 → destroyedSummary 降级最小形状（宁发少知不发错），条目删除不被打断。
 *
 * crash journal 经 vi.mock 拦截（append 是 D1 台账的断言面）；reaper / pi-paths mock 使
 * 本单测 hermetic（不 spawnSync ps、不触真实目录）。checkpoint store 单例在空清单上
 * removeSession 为 no-op（不落盘），无需 mock。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-entry-removal.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionSummary } from '@taiji/shared'
import type { CrashJournalEvent } from '@taiji/shared'
import { SessionEntryRemovalOrchestrator, type SessionEntryRemovalDeps } from '../session-entry-removal.js'
import type { IManagedSessionView } from '../types.js'

// ── Mocks（路径相对本测试文件，解析后与被测模块的 import 同一文件）──

const journalAppends: CrashJournalEvent[] = []
vi.mock('../../../infra/crash-journal.js', () => ({
  getCrashJournal: () => ({ append: (e: CrashJournalEvent) => { journalAppends.push(e) } }),
}))

vi.mock('../background-task-reaper.js', () => {
  return {
    reapSessionBackgroundTasks: vi.fn(async () => undefined),
  }
})

vi.mock('../../../infra/pi/pi-paths.js', () => ({
  getPiAgentDir: () => '/mock/pi-agent-dir',
}))

function makeSession(id: string): IManagedSessionView {
  return {
    id,
    cwd: '/test',
    label: id,
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
  } as unknown as IManagedSessionView
}

function makeDeps(overrides: Partial<SessionEntryRemovalDeps> = {}): SessionEntryRemovalDeps & {
  calls: string[]
  destroyedHandler: ReturnType<typeof vi.fn>
} {
  const sessions = new Map<string, IManagedSessionView>([
    ['s1', makeSession('s1')],
    ['s2', makeSession('s2')],
  ])
  const calls: string[] = []
  const destroyedHandler = vi.fn((summary: SessionSummary) => { calls.push(`destroyed:${summary.id}`) })
  const deps: SessionEntryRemovalDeps = {
    getSession: (id) => sessions.get(id),
    removeEntry: (id) => { sessions.delete(id); calls.push(`removeEntry:${id}`) },
    toSummary: (session) => { calls.push(`toSummary:${session.id}`); return { id: session.id } as unknown as SessionSummary },
    cancelRespawn: (id) => { calls.push(`cancelRespawn:${id}`) },
    clearSessionViewed: (id) => { calls.push(`clearViewed:${id}`) },
    fireOnSessionDelete: (id) => { calls.push(`onDelete:${id}`) },
    getOnSessionDestroyedHandlers: () => [destroyedHandler],
    unwatchBackgroundTasks: (id) => { calls.push(`unwatch:${id}`) },
    disposeHistoryReader: (id) => { calls.push(`disposeHistory:${id}`) },
    disposeTraceSync: (id) => { calls.push(`disposeTrace:${id}`) },
    disposeProjection: (id) => { calls.push(`disposeProjection:${id}`) },
    disposeRecords: (id) => { calls.push(`disposeRecords:${id}`) },
    clearMessageBusSession: (id) => { calls.push(`clearBus:${id}`) },
    ...overrides,
  }
  return { ...deps, calls, destroyedHandler }
}

describe('SessionEntryRemovalOrchestrator 销毁链单步隔离（RT-4#1）', () => {
  beforeEach(() => {
    journalAppends.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('mock 门禁：reaper 必须被 vi.mock 拦截（hermetic 前提，防路径写错静默失效）', async () => {
    const reaperModule = await import('../background-task-reaper.js')
    expect(vi.isMockFunction(reaperModule.reapSessionBackgroundTasks)).toBe(true)
  })

  it('dispose 抛错：该步降级日志+台账，后续步骤继续收敛（removeEntry / 其余 dispose / bus 清理必达）', () => {
    const deps = makeDeps({
      disposeProjection: () => { throw new Error('projection dispose exploded') },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    expect(() => orchestrator.remove('s1')).not.toThrow()

    // 抛错步之前的步骤全部完成
    expect(deps.calls).toContain('toSummary:s1')
    expect(deps.calls).toContain('removeEntry:s1')
    // 抛错步之后的步骤不被打断（终态必达）
    expect(deps.calls).toContain('disposeRecords:s1')
    expect(deps.calls).toContain('clearBus:s1')
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
    // 失败落 crash 台账（RT-4#1：失败记台账）
    expect(journalAppends).toContainEqual(expect.objectContaining({
      layer: 'runtime',
      event: 'crash',
      reason: 'destroy-chain-step-failed',
      sessionId: 's1',
    }))
  })

  it('其余 session 不受累：s1 链抛错后，s2 的 remove 全链正常完成', () => {
    const s2Trace: string[] = []
    const deps = makeDeps({
      disposeTraceSync: (id) => {
        if (id === 's1') throw new Error('trace dispose exploded for s1')
        s2Trace.push(id)
      },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    orchestrator.remove('s1')
    orchestrator.remove('s2')

    // s2 全链完成（含抛错步之后的全部步骤）
    expect(s2Trace).toEqual(['s2'])
    expect(deps.calls).toContain('disposeProjection:s2')
    expect(deps.calls).toContain('disposeRecords:s2')
    expect(deps.calls).toContain('clearBus:s2')
    expect(deps.calls).toContain('removeEntry:s2')
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }))
  })

  it('toSummary 抛错：destroyedSummary 降级最小形状，条目删除与销毁扇出不被打断', () => {
    const deps = makeDeps({
      toSummary: () => { throw new Error('git reader exploded') },
    })
    const orchestrator = new SessionEntryRemovalOrchestrator(deps)

    expect(() => orchestrator.remove('s1')).not.toThrow()

    expect(deps.calls).toContain('removeEntry:s1')
    // 销毁通知仍发出（最小形状：id + dead 兜底字段，宁发少知不发错）
    expect(deps.destroyedHandler).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1',
      status: 'dead',
      label: 's1',
    }))
    expect(journalAppends).toContainEqual(expect.objectContaining({
      reason: 'destroy-chain-step-failed',
      sessionId: 's1',
    }))
  })

  it('全链无异常：零隔离台账行（deleted 台账照常，隔离路径不产生噪音事件）', () => {
    const orchestrator = new SessionEntryRemovalOrchestrator(makeDeps())
    orchestrator.remove('s1')
    // 第 1 步 deleted 台账行恒在（D1 唯一挂点）；无任何 destroy-chain-step-failed 行
    expect(journalAppends).toEqual([
      expect.objectContaining({ layer: 'pi', event: 'deleted', sessionId: 's1' }),
    ])
  })
})
