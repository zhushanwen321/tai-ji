/**
 * W2 权威拉取与冷读：状态层拉取对账 + 三源同一 reducer（设计 §7 验收项 8）。
 *
 * 锁定 `createUseSession.refreshLiveState` 的行为契约：
 * - **三时机**：打开视图（切入链步 13）/ 重连（壳 onConnected 调本方法）/ 缓存缺失
 *   （前两个时机的门控——状态层无条目才发 RPC）；
 * - **三源同一 reducer**：订阅回放（stateSnapshot）、状态消息（state_changed /
 *   thinkingLevelSet）、拉取（session.getState reply）全部经 `applyLiveState` 这唯一
 *   写入口落地，字段级合并，结果与 runtime 快照逐字段一致；
 * - **失败语义**：拉取失败静默（显式未知保持，下次时机重试），不回退主会话 / 默认模型 /
 *   其他会话的值（ADR-0122）；
 * - **未接线降级**：liveState / api.getState 任一缺省 → 整体跳过，不抛。
 *
 * 模式对齐 use-session.test.ts：effectScope + 真实 createSessionStore / 真实
 * createSessionLiveState + mock 端口。fire-and-forget 的拉取用微任务清空等待
 * （TEST-STRATEGY「异步等待写法」：微任务清空是事件循环构造性保证，不用轮询）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { SessionGroup, BatchDeleteResult } from '@taiji/shared'
import { createSessionStore } from '../store'
import { createUseSession, resetSessionListSubForTest } from '../use-session'
import type { UseSessionDeps, SessionCleanupHooks, ChatHydratePort } from '../use-session'
import type { SessionEntryPort } from '../api-port'
import { createSessionLiveState, type SessionLiveStateStore } from '../live-state'

/** 微任务清空（确定性 flush：mock 的 getState 返已 resolve 的 promise，数次 tick 必达） */
async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function makeHooks(): SessionCleanupHooks {
  const noop = (): void => {}
  return {
    clearFileTree: noop, clearSubagent: noop, clearWorkflow: noop, clearExtensionUI: noop,
    clearExtensionHost: noop, evictChat: noop, evictVirtualKeys: noop, clearAgentCallMapping: noop,
    disposeChat: noop, invalidateStatus: noop, browserDestroy: noop,
  }
}

type Fixture = {
  session: ReturnType<typeof createUseSession>
  store: ReturnType<typeof createSessionStore>
  liveState: SessionLiveStateStore
  api: {
    list: ReturnType<typeof vi.fn>
    switchSession: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    archive: ReturnType<typeof vi.fn>
    removeByCwd: ReturnType<typeof vi.fn>
    migrateImage: ReturnType<typeof vi.fn>
    onConfigSessions: ReturnType<typeof vi.fn>
    getState: ReturnType<typeof vi.fn>
  }
  chat: ChatHydratePort & {
    getHistory: ReturnType<typeof vi.fn>
    isHydrated: ReturnType<typeof vi.fn>
    reconcileHistory: ReturnType<typeof vi.fn>
    markHistoryFailed: ReturnType<typeof vi.fn>
  }
  dispose: () => void
}

function makeFixture(opts: { withLiveState?: boolean } = {}): Fixture {
  const scope = effectScope(true)
  const store = scope.run(() => createSessionStore())!
  const liveState = scope.run(() => createSessionLiveState())!
  const api = {
    list: vi.fn().mockResolvedValue([]),
    switchSession: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
    migrateImage: vi.fn(),
    onConfigSessions: vi.fn(() => vi.fn()),
    getState: vi.fn(),
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
  } satisfies ChatHydratePort & Record<string, ReturnType<typeof vi.fn>>
  const deps: UseSessionDeps = {
    store,
    api,
    panel,
    navigation,
    chat,
    hooks: makeHooks(),
    ...(opts.withLiveState === false ? {} : { liveState }),
  }
  const session = scope.run(() => createUseSession(deps))!
  return { session, store, liveState, api, chat, dispose: () => scope.stop() }
}

describe('refreshLiveState（W2 权威拉取与冷读）', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('打开视图时机：切入链尾部触发拉取，reply 落状态层（缓存缺失门控）', async () => {
    const f = makeFixture()
    f.api.getState.mockResolvedValue({ sessionId: 'sid-1', modelId: 'prov-a/model-a', thinkingLevel: 'high' })

    await f.session.selectSession('sid-1')
    // getState 在切入链内同步到达（refreshLiveState 的首个 await 之前）
    expect(f.api.getState).toHaveBeenCalledWith('sid-1')
    await flushMicrotasks()

    expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    f.dispose()
  })

  it('缓存缺失门控：状态层已有条目 → 不发 RPC（不覆盖推送已更新的值）', async () => {
    const f = makeFixture()
    f.liveState.applyLiveState('sid-1', { modelId: 'prov-pushed/model-pushed', thinkingLevel: 'low' })

    await f.session.refreshLiveState('sid-1')

    expect(f.api.getState).not.toHaveBeenCalled()
    expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-pushed/model-pushed', thinkingLevel: 'low' })
    f.dispose()
  })

  it('拉取失败：静默不抛 + 状态层保持显式未知（不回退猜测）', async () => {
    const f = makeFixture()
    f.api.getState.mockRejectedValue(Object.assign(new Error('session not found'), { code: 'SESSION_NOT_FOUND' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(f.session.refreshLiveState('ghost')).resolves.toBeUndefined()

    expect(f.liveState.liveStateOf('ghost')).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    f.dispose()
  })

  it('字段级合并：拉取先落一维、状态消息补另一维，两维都在（同一 reducer）', async () => {
    const f = makeFixture()
    // 拉取只拿到 modelId（thinkingLevel 缺省 = 该维显式未知）
    f.api.getState.mockResolvedValue({ sessionId: 'sid-1', modelId: 'prov-a/model-a' })
    await f.session.refreshLiveState('sid-1')
    expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-a/model-a' })

    // 状态消息（thinkingLevelSet）补另一维——字段级合并，不清掉已落地的 modelId
    f.liveState.applyLiveState('sid-1', { thinkingLevel: 'high' })
    expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    f.dispose()
  })

  it('未接线降级：liveState 缺省 → 跳过不抛；api.getState 缺省 → 同样跳过', async () => {
    const noLive = makeFixture({ withLiveState: false })
    await expect(noLive.session.refreshLiveState('sid-1')).resolves.toBeUndefined()
    expect(noLive.api.getState).not.toHaveBeenCalled()
    noLive.dispose()

    const noGetState = makeFixture()
    // 端口成员缺席（壳旧装配形态）
    const apiWithoutGetState = { ...noGetState.api } as Record<string, unknown>
    delete apiWithoutGetState.getState
    const scope = effectScope(true)
    const session = scope.run(() => createUseSession({
      store: noGetState.store,
      api: apiWithoutGetState as never,
      panel: noGetState.api as never,
      navigation: { push: vi.fn() },
      chat: noGetState.chat,
      hooks: makeHooks(),
      liveState: noGetState.liveState,
    }))!
    await expect(session.refreshLiveState('sid-1')).resolves.toBeUndefined()
    expect(noGetState.liveState.liveStateOf('sid-1')).toBeUndefined()
    scope.stop()
  })
})

describe('三源同一 reducer（设计 §7 验收项 8）', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
  })

  it('订阅回放 + 状态消息 + 拉取全部经 applyLiveState，合并结果与 runtime 快照逐字段一致', async () => {
    const f = makeFixture()
    const applySpy = vi.spyOn(f.liveState, 'applyLiveState')
    // runtime 快照（权威终值）：三源各自携带不同子集，合并后应逐字段等于它
    const runtimeSnapshot = { modelId: 'prov-final/model-final', thinkingLevel: 'xhigh' }

    // 源 1（拉取，W2 新增的第三源）：缓存缺失时打开会话即拉，两维一次落地
    f.api.getState.mockResolvedValue({ sessionId: 'sid-1', modelId: 'prov-pull/model-pull', thinkingLevel: 'high' })
    await f.session.refreshLiveState('sid-1')
    expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-pull/model-pull', thinkingLevel: 'high' })

    // 源 2（状态消息）：session.state_changed 只带 modelId
    f.liveState.applyLiveState('sid-1', { modelId: 'prov-msg/model-msg' })
    // 源 3（订阅回放/档位回执）：session.thinkingLevelSet 只带 thinkingLevel
    f.liveState.applyLiveState('sid-1', { thinkingLevel: 'xhigh' })
    // 权威终态由最后到达的两条消息收敛（推是提示，覆盖同维度的拉取值）
    f.liveState.applyLiveState('sid-1', { modelId: runtimeSnapshot.modelId })

    expect(f.liveState.liveStateOf('sid-1')).toEqual(runtimeSnapshot)
    // 四次写入全部落在同一个写入口上（无第二套合并逻辑）
    expect(applySpy).toHaveBeenCalledTimes(4)
    expect(applySpy.mock.calls.map((c) => c[1])).toEqual([
      { modelId: 'prov-pull/model-pull', thinkingLevel: 'high' },
      { modelId: 'prov-msg/model-msg' },
      { thinkingLevel: 'xhigh' },
      { modelId: runtimeSnapshot.modelId },
    ])
    f.dispose()
  })

  it('拉取写入不带 sessionId 进状态层（键 = 入参 sessionId，不信任 reply 回显）', async () => {
    const f = makeFixture()
    // reply 的 sessionId 与请求不一致（协议漂移/恶意回显）时，落点仍是请求的 sid
    f.api.getState.mockResolvedValue({ sessionId: 'other', modelId: 'prov-a/model-a' })

    await f.session.refreshLiveState('sid-1')

    expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-a/model-a' })
    expect(f.liveState.liveStateOf('other')).toBeUndefined()
    f.dispose()
  })
})
