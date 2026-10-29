/**
 * use-session 历史缓存合并编排测试（session-cold-switch-perf §3.3-3/§3.3-4，impl-plan u3）。
 *
 * 覆盖 u3 验收四条：
 * ① 切入链并行切口：getHistory 先于 switch resolve 也能落库显示（mock 层断言时序结构）；
 * ② historyCacheReady 通知帧：到达且活跃匹配 → 重拉合并；snapshotLeafId 过期 → 不重拉；
 * ③ truncated 窗口状态与后台任务状态解耦（失败帧不改写窗口，SSOT 仍 = history 响应）；
 * ④ btw 线分区不触发重拉（分区 ≠ activeId 的匹配判定；renderer btw-replay 族回归由
 *    chat-store-bundle.test.ts btw-replay 节承担——本单元未改 btw 回放消费的任何接口签名）。
 *
 * ROUTE_TABLE 'session.historyCacheReady' 条目的 crossSession 声明一并锁定（帧到达
 * core 消费面的路由前提——漏声明则帧只进 session 通道、单消费面永收不到）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionGroup, BatchDeleteResult, SessionSummary } from '@taiji/shared'
import { effectScope } from 'vue'
import { createUseSession, resetSessionListSubForTest, resetHistoryCacheSubForTest, type UseSessionDeps, type SessionCleanupHooks, type ChatHydratePort } from '../use-session'
import { createSessionStore } from '../store'
import { createChatStore } from '../../chat/store'
import { ROUTE_TABLE } from '../../../coordination/route-inbound'

/** 构造 SessionSummary 最小形状 */
function summary(id: string, cwd = '/a'): SessionSummary {
  return { id, label: `label-${id}`, cwd, status: 'idle', lastActiveAt: 1 }
}

/** 手动 deferred（时序结构断言用：把指定 RPC 钉在未 resolve 态） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 排空 microtask 队列（并行竞速用例的确定性推进） */
const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0))

interface Fixture { // oe-exempt:20261029:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  session: ReturnType<typeof createUseSession>
  store: ReturnType<typeof createSessionStore>
  chatStore: ReturnType<typeof createChatStore>
  api: {
    switchSession: ReturnType<typeof vi.fn>
    onConfigSessions: ReturnType<typeof vi.fn>
    onHistoryCacheReady: ReturnType<typeof vi.fn>
  }
  chat: {
    getHistory: ReturnType<typeof vi.fn>
    isHydrated: ReturnType<typeof vi.fn>
    hydrate: ReturnType<typeof vi.fn>
    reconcileHistory: ReturnType<typeof vi.fn>
    clearHistoryError: ReturnType<typeof vi.fn>
    markHistoryFailed: ReturnType<typeof vi.fn>
    markCacheFailed: ReturnType<typeof vi.fn>
    clearCacheFailed: ReturnType<typeof vi.fn>
    isSnapshotFresh: ReturnType<typeof vi.fn>
  }
  emitHistoryCacheReady: (sessionId: string, payload: { snapshotLeafId: string; error?: string }) => void
  panel: { loadSession: ReturnType<typeof vi.fn> }
  navigation: { push: ReturnType<typeof vi.fn> }
  dispose: () => void
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const store = scope.run(() => createSessionStore())!
  const chatStore = scope.run(() => createChatStore())!

  let cacheReadyHandler: ((sessionId: string, payload: { snapshotLeafId: string; error?: string }) => void) | null = null

  const api = {
    list: vi.fn().mockResolvedValue([] as SessionGroup[]),
    switchSession: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
    migrateImage: vi.fn(),
    onConfigSessions: vi.fn(() => vi.fn()),
    // 通知帧入口：捕获 handler 供用例模拟帧到达（refCount 单飞——首实例注册生效）
    onHistoryCacheReady: vi.fn((handler: typeof cacheReadyHandler) => {
      cacheReadyHandler = handler
      return () => {}
    }),
  }

  const panel = {
    focusedSessionId: vi.fn(() => null),
    activePanelId: vi.fn(() => 'p1'),
    findPanelBySession: vi.fn(() => null),
    loadSession: vi.fn(),
    openPanel: vi.fn(),
  }
  const navigation = { push: vi.fn() }
  const chat = {
    getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    isHydrated: vi.fn(() => false),
    hydrate: vi.fn(),
    reconcileHistory: vi.fn(),
    clearHistoryError: vi.fn(),
    markHistoryFailed: vi.fn(),
    markCacheFailed: vi.fn(),
    clearCacheFailed: vi.fn(),
    isSnapshotFresh: vi.fn(() => true),
  }
  const hooks = {
    clearFileTree: vi.fn(), clearSubagent: vi.fn(), clearWorkflow: vi.fn(),
    clearExtensionUI: vi.fn(), clearExtensionHost: vi.fn(), evictChat: vi.fn(),
    evictVirtualKeys: vi.fn(), clearAgentCallMapping: vi.fn(), disposeChat: vi.fn(),
    invalidateStatus: vi.fn(), browserDestroy: vi.fn(),
  } as unknown as SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>>

  const deps: UseSessionDeps = {
    store,
    api: api as unknown as UseSessionDeps['api'],
    panel,
    navigation,
    chat: {
      ...chat,
      historyCache: {
        markCacheFailed: chat.markCacheFailed,
        clearCacheFailed: chat.clearCacheFailed,
        isSnapshotFresh: chat.isSnapshotFresh,
      },
    } as ChatHydratePort,
    hooks,
  }
  const session = scope.run(() => createUseSession(deps))!
  return {
    session,
    store,
    chatStore,
    api,
    chat,
    panel,
    navigation,
    emitHistoryCacheReady: (sessionId, payload) => {
      if (!cacheReadyHandler) throw new Error('onHistoryCacheReady handler not bound')
      cacheReadyHandler(sessionId, { sessionId, ...payload })
    },
    dispose: () => scope.stop(),
  }
}

describe('切入链并行切口（session-cold-switch-perf §3.3-4）', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
    resetHistoryCacheSubForTest()
  })

  it('① getHistory 先于 switch resolve 也能落库显示：switch 钉在未 resolve 态时 reconcile 已执行（mock 层时序结构断言）', async () => {
    const f = makeFixture()
    const switchGate = deferred<void>()
    f.api.switchSession.mockReturnValue(switchGate.promise)
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm1' } as never], truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 })

    const done = f.session.selectSession('sid-1')
    await flush()

    // 并行发出：两个请求都已发出；switch 未 resolve 时数据已落库（「查看数据获取」与
    //「执行就绪」解耦——冷切首屏不等 spawn/全量重建）
    expect(f.api.switchSession).toHaveBeenCalledWith('sid-1')
    expect(f.chat.getHistory).toHaveBeenCalledWith('sid-1')
    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith(
      'sid-1',
      [{ id: 'm1' }],
      { truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 },
    )
    expect(f.chat.clearHistoryError).toHaveBeenCalledWith('sid-1')
    // 显示层仍随 switch：未 resolve 则 panel 挂载/导航未发生
    expect(f.panel.loadSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()

    switchGate.resolve(undefined)
    await done
    // switch 返回后链补完：activeId 更新 + panel 挂载（panel 若晚于尾读返回，到达即显示——
    // 两种到达顺序收敛到同一终态）
    expect(f.store.activeId.value).toBe('sid-1')
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    // 单飞：链步 9 消费同一 promise，无双拉
    expect(f.chat.getHistory).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('① switch 失败短路显示链，已发出的 history reply 仍落库（pi 不可用时查看数据仍可得）', async () => {
    const f = makeFixture()
    const switchGate = deferred<void>()
    f.api.switchSession.mockReturnValue(switchGate.promise)
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm1' } as never], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })

    const done = f.session.selectSession('ghost')
    await flush()
    // 短路前数据已落库（独立于链短路的 reply 处理——场景 6 数据层断言的载体）
    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)

    switchGate.reject(new Error('pi unavailable'))
    await expect(done).rejects.toThrow('pi unavailable')
    // 显示层短路：activeId 不更新、panel/navigation 不动；数据层落库保持
    expect(f.store.activeId.value).toBeNull()
    expect(f.panel.loadSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('① 历史晚于 switch 返回：链 await 并行 pull，panel 先挂载、消息到达即落库', async () => {
    const f = makeFixture()
    const historyGate = deferred<{ messages: never[]; truncated: boolean; loadedTurns: number; totalTurnsEstimate: number }>()
    f.chat.getHistory.mockReturnValue(historyGate.promise)

    const done = f.session.selectSession('sid-1')
    await flush()
    // switch 快速返回：panel 挂载先行（panel-first），历史未到不落库
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()

    historyGate.resolve({ messages: [{ id: 'm2' } as never], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await done
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [{ id: 'm2' }], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    // 链尾步骤（LRU 驱逐）在历史落库之后执行（时序保持）
    expect(f.store.activeId.value).toBe('sid-1')
    f.dispose()
  })
})

describe('historyCacheReady 通知编排（session-cold-switch-perf §3.3-3）', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
    resetHistoryCacheSubForTest()
  })

  it('② 成功帧 + 活跃会话匹配 + 快照新鲜 → 重拉并合并落库 + 清失败态', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1')] }] })
    f.store.setActiveId('sid-1')
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.isSnapshotFresh.mockReturnValue(true)
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'full' } as never], truncated: false, loadedTurns: 9, totalTurnsEstimate: 9 })

    f.emitHistoryCacheReady('sid-1', { snapshotLeafId: 'leaf-1' })
    await flush()

    // 重拉（命中缓存快路径）→ reconcileHistory 合并上屏（基线替换 + 尾部 live 保护段）
    expect(f.chat.isSnapshotFresh).toHaveBeenCalledWith('sid-1', 'leaf-1')
    expect(f.chat.getHistory).toHaveBeenCalledWith('sid-1')
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [{ id: 'full' }], { truncated: false, loadedTurns: 9, totalTurnsEstimate: 9 })
    expect(f.chat.clearCacheFailed).toHaveBeenCalledWith('sid-1')
    f.dispose()
  })

  it('② snapshotLeafId 过期（重建期间有新追加）→ 不重拉，由尾部保护段衔接', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1')] }] })
    f.store.setActiveId('sid-1')
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.isSnapshotFresh.mockReturnValue(false) // 快照基准不匹配

    f.emitHistoryCacheReady('sid-1', { snapshotLeafId: 'stale-leaf' })
    await flush()

    expect(f.chat.getHistory).not.toHaveBeenCalled()
    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()
    expect(f.chat.markCacheFailed).not.toHaveBeenCalled()
    f.dispose()
  })

  it('② 失败帧（error 非空）→ 不重拉，收敛「加载更早失败 + 重试入口」（失败态分区写入）', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1')] }] })
    f.store.setActiveId('sid-1')
    f.chat.isHydrated.mockReturnValue(true)

    f.emitHistoryCacheReady('sid-1', { snapshotLeafId: 'leaf-1', error: 'rebuild failed' })
    await flush()

    expect(f.chat.markCacheFailed).toHaveBeenCalledWith('sid-1')
    expect(f.chat.getHistory).not.toHaveBeenCalled()
    // ADR-0122 首败即停：重试由下一次 getHistory 派单（手动/切入/重连）消费驱动，不自动重拉
    expect(f.chat.clearCacheFailed).not.toHaveBeenCalled()
    f.dispose()
  })

  it('④ btw 线分区不触发重拉：分区 ≠ activeId（drawer 选中线），成功帧/失败帧都静默忽略', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1')] }] })
    f.store.setActiveId('sid-1')
    // btw 线分区可能已 hydrate（回放窗口在场），但线 id 不是 activeId
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.isSnapshotFresh.mockReturnValue(true)

    f.emitHistoryCacheReady('btw-line-1', { snapshotLeafId: 'leaf-1' })
    f.emitHistoryCacheReady('btw-line-2', { snapshotLeafId: 'leaf-2', error: 'rebuild failed' })
    await flush()

    // 回放窗口保持（尾读 + live 帧按现状继续填充），缓存收益在下次重开回放兑现
    expect(f.chat.getHistory).not.toHaveBeenCalled()
    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()
    expect(f.chat.markCacheFailed).not.toHaveBeenCalled()
    f.dispose()
  })

  it('② 未 hydrate 跳过：首屏加载由切入链并行 pull 承担，防双拉', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1')] }] })
    f.store.setActiveId('sid-1')
    f.chat.isHydrated.mockReturnValue(false)

    f.emitHistoryCacheReady('sid-1', { snapshotLeafId: 'leaf-1' })
    await flush()

    expect(f.chat.getHistory).not.toHaveBeenCalled()
    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()
    f.dispose()
  })

  it('② 重拉 await 窗口内用户切走 → 放弃落库（迟到帧不扰动新会话）', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1'), summary('sid-2')] }] })
    f.store.setActiveId('sid-1')
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.isSnapshotFresh.mockReturnValue(true)
    const gate = deferred<{ messages: never[]; truncated: boolean; loadedTurns: number; totalTurnsEstimate: number }>()
    f.chat.getHistory.mockReturnValue(gate.promise)

    f.emitHistoryCacheReady('sid-1', { snapshotLeafId: 'leaf-1' })
    await flush()
    expect(f.chat.getHistory).toHaveBeenCalledWith('sid-1')

    // 用户切走（真实编排 = selectSession('sid-2') 更新 activeId；用例直写等效状态）
    f.store.setActiveId('sid-2')
    gate.resolve({ messages: [{ id: 'full' } as never], truncated: false, loadedTurns: 9, totalTurnsEstimate: 9 })
    await flush()

    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()
    f.dispose()
  })

  it('重拉失败（缓存快路径 RPC reject）→ warn 静默不抛，不写失败态', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1')] }] })
    f.store.setActiveId('sid-1')
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.isSnapshotFresh.mockReturnValue(true)
    f.chat.getHistory.mockRejectedValue(new Error('conn lost'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    f.emitHistoryCacheReady('sid-1', { snapshotLeafId: 'leaf-1' })
    await flush()

    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()
    expect(f.chat.markCacheFailed).not.toHaveBeenCalled()
    warn.mockRestore()
    f.dispose()
  })
})

describe('truncated 窗口状态与后台任务状态解耦（session-cold-switch-perf 验收③）', () => {
  it('失败帧收敛只写 historyCacheFailed 分区，不写窗口（truncated 事实 SSOT 仍是 history 响应）', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1')] }] })
    f.store.setActiveId('sid-1')
    f.chat.isHydrated.mockReturnValue(true)

    // 用真实 chat store 承载窗口状态：hydrate 一份 truncated=true 的尾读窗口
    f.chatStore.hydrate('sid-1', [{ id: 'm1', piEntryId: 'e1' } as never], { truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 })

    f.emitHistoryCacheReady('sid-1', { snapshotLeafId: 'leaf-1', error: 'rebuild failed' })
    await flush()

    // 后台失败不改写 truncated：「加载更早」入口的事实（还有更早历史）不随后台任务状态变化
    expect(f.chatStore.getHistoryWindow('sid-1')?.truncated).toBe(true)
    // 失败态在独立分区（呈现层合并消费——「加载更早失败 + 重试入口」）
    expect(f.chat.markCacheFailed).toHaveBeenCalledWith('sid-1')
    f.dispose()
  })

  it('成功重拉后窗口随响应整体覆盖（「加载更早」入口随全量响应收敛消失）', async () => {
    const f = makeFixture()
    f.store.applySnapshot({ groups: [{ cwd: '/a', sessions: [summary('sid-1')] }] })
    f.store.setActiveId('sid-1')
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.isSnapshotFresh.mockReturnValue(true)

    f.chatStore.hydrate('sid-1', [{ id: 'm1', piEntryId: 'e1' } as never], { truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 })
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'full' } as never], truncated: false, loadedTurns: 9, totalTurnsEstimate: 9 })
    // reconcile 落真实 store（合并语义见 store.reconcileHistory——false 收敛顶部条）
    f.chat.reconcileHistory.mockImplementation((sid: string, messages: never[], window: { truncated: boolean; loadedTurns: number; totalTurnsEstimate: number }) => {
      f.chatStore.reconcileHistory(sid, messages, window)
    })

    f.emitHistoryCacheReady('sid-1', { snapshotLeafId: 'leaf-1' })
    await flush()

    expect(f.chatStore.getHistoryWindow('sid-1')?.truncated).toBe(false)
    f.dispose()
  })
})

describe('chat store 快照对账与失败态分区（数据层 SSOT）', () => {
  it('isHistorySnapshotFresh：分区尾文件侧身份 === snapshotLeafId 判新鲜', () => {
    const scope = effectScope(true)
    const chatStore = scope.run(() => createChatStore())!
    chatStore.hydrate('s1', [
      { id: 'm1', piEntryId: 'e-1' } as never,
      { id: 'm2', piEntryId: 'e-2' } as never,
    ])
    expect(chatStore.isHistorySnapshotFresh('s1', 'e-2')).toBe(true)
    expect(chatStore.isHistorySnapshotFresh('s1', 'e-1')).toBe(false)
    scope.stop()
  })

  it('isHistorySnapshotFresh：未 hydrate / 空分区 = false（无对账基准）', () => {
    const scope = effectScope(true)
    const chatStore = scope.run(() => createChatStore())!
    expect(chatStore.isHistorySnapshotFresh('s-none', 'leaf')).toBe(false)
    chatStore.hydrate('s-empty', [])
    expect(chatStore.isHistorySnapshotFresh('s-empty', 'leaf')).toBe(false)
    scope.stop()
  })

  it('失败态分区生命周期：mark/clear 幂等收敛 + disposeSession 随分区清理', () => {
    const scope = effectScope(true)
    const chatStore = scope.run(() => createChatStore())!
    expect(chatStore.isHistoryCacheFailed('s1')).toBe(false)
    chatStore.markHistoryCacheFailed('s1')
    chatStore.markHistoryCacheFailed('s1')
    expect(chatStore.isHistoryCacheFailed('s1')).toBe(true)
    chatStore.clearHistoryCacheFailed('s1')
    expect(chatStore.isHistoryCacheFailed('s1')).toBe(false)
    // 未标记的会话清除是 no-op（幂等）
    expect(() => chatStore.clearHistoryCacheFailed('s-none')).not.toThrow()

    chatStore.markHistoryCacheFailed('s2')
    chatStore.disposeSession('s2')
    expect(chatStore.isHistoryCacheFailed('s2')).toBe(false)
    scope.stop()
  })

  it("ROUTE_TABLE 'session.historyCacheReady' 声明 crossSession（帧到达单消费面的路由前提）", () => {
    expect(ROUTE_TABLE['session.historyCacheReady']).toBeDefined()
    expect(ROUTE_TABLE['session.historyCacheReady']?.crossSession).toBe(true)
  })
})
