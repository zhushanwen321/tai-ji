/**
 * createUseSession 行为测试（IF4 / DM2 / ES1-2 语义锁定，w3）。
 *
 * 锁定 createUseSession(deps) factory 产物的纯编排行为（不经 renderer 壳）：
 * selectSession 全编排 / 失败不更新 activeId / hydrate 失败消化、deleteSession S3 全 hooks
 * 调用序 + ES1 fallback、deleteFolder wasActiveInFolder 回退、loadSessions 成功/失败（ES2）、
 * retryHistory 双分支、newSession 延迟 create 三分支、rename/syncSessionToPanel、refCount 订阅去重；
 * [renderer-deepening D3/D4] selectSession 12 步切入链精确顺序（记录型 fake 端口回放调用序）。
 *
 * 模式（对齐 chat 域 useChat.test.ts）：effectScope + 真实 createSessionStore（w1 交付，
 * 编排终态断言需真实响应式）+ mock deps（api/panel/navigation/chat/hooks/flow/sessionEntry 全 vi.fn）。
 * 调用序断言用 invocation log 数组（S3 全序可读）。beforeEach 调 resetSessionListSubForTest()
 * 清模块级订阅计数（跨用例隔离）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary, BatchDeleteResult, ImageCacheWriteImage, ImageCacheWriteResult } from '@xyz-agent/shared'
import { createSessionStore } from '../store'
import { createUseSession, resetSessionListSubForTest } from '../use-session'
import type { UseSessionDeps, SessionCleanupHooks, ChatHydratePort } from '../use-session'
import type { SessionEntryPort } from '../api-port'
import { setImageCacheWritePort, _resetImageCacheForTest } from '../../chat/image-cache'

/** 构造 SessionSummary 最小形状（类型收窄后字段由测试按需给全） */
function summary(id: string, cwd = '/a'): SessionSummary {
  return { id, label: `label-${id}`, cwd, status: 'idle', lastActiveAt: 1, modelId: '', tokenCount: 0 }
}

function makeHooks(log: string[]): SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>> {
  const names = [
    'clearFileTree', 'clearSubagent', 'clearWorkflow',
    'clearExtensionUI', 'clearExtensionHost', 'evictChat', 'evictVirtualKeys',
    'clearAgentCallMapping', 'disposeChat', 'invalidateStatus', 'browserDestroy',
    'clearTerminalQueue', 'clearSlashCommands', 'clearForkNotices',
  ] as const
  const hooks = {} as SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>>
  for (const n of names) {
    hooks[n] = vi.fn((...args: unknown[]) => log.push(`${n}(${args.join(',')})`))
  }
  return hooks
}

interface Fixture {
  session: ReturnType<typeof createUseSession>
  store: ReturnType<typeof createSessionStore>
  api: {
    list: ReturnType<typeof vi.fn>
    switchSession: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    rename: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    removeByCwd: ReturnType<typeof vi.fn>
    migrateImage: ReturnType<typeof vi.fn>
    onConfigSessions: ReturnType<typeof vi.fn>
  }
  panel: {
    focusedSessionId: ReturnType<typeof vi.fn>
    activePanelId: ReturnType<typeof vi.fn>
    findPanelBySession: ReturnType<typeof vi.fn>
    loadSession: ReturnType<typeof vi.fn>
    openPanel: ReturnType<typeof vi.fn>
  }
  navigation: { push: ReturnType<typeof vi.fn> }
  chat: {
    getHistory: ReturnType<typeof vi.fn>
    isHydrated: ReturnType<typeof vi.fn>
    hydrate: ReturnType<typeof vi.fn>
    reconcileHistory: ReturnType<typeof vi.fn>
    clearHistoryError: ReturnType<typeof vi.fn>
    markHistoryFailed: ReturnType<typeof vi.fn>
  }
  flow: { startFlow: ReturnType<typeof vi.fn>; currentSession: ReturnType<typeof vi.fn> }
  hooks: SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>>
  log: string[]
  dispose: () => void
}

function makeFixture(
  opts: {
    withFlow?: boolean
    selectSessionFallback?: (id: string) => Promise<void>
    sessionEntry?: SessionEntryPort
  } = {},
): Fixture {
  const scope = effectScope(true)
  const log: string[] = []
  const store = scope.run(() => createSessionStore())!
  const api = {
    list: vi.fn().mockResolvedValue([]),
    switchSession: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
    migrateImage: vi.fn(),
    onConfigSessions: vi.fn(() => vi.fn()),
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
  }
  const flow = { startFlow: vi.fn().mockResolvedValue(undefined), currentSession: vi.fn(() => null) }
  const hooks = makeHooks(log)
  const deps: UseSessionDeps = {
    store, api, panel, navigation, chat, hooks,
    ...(opts.withFlow ? { flow } : {}),
    ...(opts.selectSessionFallback ? { selectSessionFallback: opts.selectSessionFallback } : {}),
    ...(opts.sessionEntry ? { sessionEntry: opts.sessionEntry } : {}),
  }
  const session = scope.run(() => createUseSession(deps))!
  return { session, store, api, panel, navigation, chat, flow, hooks, log, dispose: () => scope.stop() }
}

/** 组装分组（applySnapshot 整表形态后 store.list 派生） */
function seed(store: Fixture['store'], groups: SessionGroup[]): void {
  store.applySnapshot({ groups })
}

describe('selectSession', () => {
  it('TC-1 成功：switchSession→activeId→panel 载入→push→hydrate（D4 panel-first；12 步全序断言见下方切入链 describe）', async () => {
    const f = makeFixture()
    const msgs = [{ id: 'm1' } as never]
    f.chat.getHistory.mockResolvedValue({ messages: msgs, truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 })
    await f.session.selectSession('sid-1')

    expect(f.api.switchSession).toHaveBeenCalledTimes(1)
    expect(f.api.switchSession).toHaveBeenCalledWith('sid-1')
    expect(f.store.activeId.value).toBe('sid-1')
    // hydrate 链路（后台 session reconcile：未 hydrate 分支走 reconcileHistory，等价 hydrate）
    expect(f.chat.isHydrated).toHaveBeenCalledWith('sid-1')
    expect(f.chat.getHistory).toHaveBeenCalledTimes(1)
    // [u4d] 窗口状态随 reconcile 写入（[u6] 契约三字段必填）
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', msgs, { truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 })
    expect(f.chat.clearHistoryError).toHaveBeenCalledWith('sid-1')
    // panel 载入（经 activePanelId 端口）
    expect(f.panel.activePanelId).toHaveBeenCalled()
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    // 导航
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
    f.dispose()
  })

  it('TC-2 失败：switchSession reject → activeId 不更新 + 异常上抛 + 后续编排短路', async () => {
    const f = makeFixture()
    f.api.switchSession.mockRejectedValue(new Error('not found'))
    seed(f.store, [{ cwd: '/a', sessions: [summary('other')] }])
    f.store.activeId.value = 'other'

    await expect(f.session.selectSession('ghost')).rejects.toThrow('not found')
    expect(f.store.activeId.value).toBe('other')
    expect(f.chat.reconcileHistory).not.toHaveBeenCalled()
    expect(f.panel.loadSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    f.dispose()
  })

  it('TC-3 hydrate 失败：getHistory reject → markHistoryFailed + 不抛 + activeId 已更新', async () => {
    const f = makeFixture()
    f.chat.getHistory.mockRejectedValue(new Error('io'))
    await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
    expect(f.chat.markHistoryFailed).toHaveBeenCalledWith('sid-1')
    expect(f.store.activeId.value).toBe('sid-1')
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
    f.dispose()
  })

  it('已 hydrate 的 session 切入时静默刷新（后台 session reconcile，2026-08-22）', async () => {
    const f = makeFixture()
    const msgs = [{ id: 'm2' } as never]
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.getHistory.mockResolvedValue({ messages: msgs, truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await f.session.selectSession('sid-1')
    // 旧幂等守卫已废：后台（agent-managed）session 的 turn 可能在前端不在场时完成，
    // 切入必须刷新到最新 entries；失败静默（旧数据仍在，下次切入重试）
    expect(f.chat.getHistory).toHaveBeenCalledTimes(1)
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', msgs, { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    expect(f.chat.markHistoryFailed).not.toHaveBeenCalled()
    expect(f.store.activeId.value).toBe('sid-1')
    f.dispose()
  })

  it('已 hydrate 切入的窗口 reconcile 同步刷新 truncated 窗口状态（load-more 可恢复）', async () => {
    const f = makeFixture()
    f.chat.isHydrated.mockReturnValue(true)
    // 场景：hydrate（窗口 truncated=true）→ load-more 游标翻页 → 切走切回，
    // getHistory 又返回预算窗口（u4b）——[u6] reconcile 合并语义：窗口响应仅合并覆盖
    // 最近窗口，已加载更早历史保留；窗口状态同步刷新 truncated=true，顶部条重显。
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm2' } as never], truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    await f.session.selectSession('sid-1')
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [{ id: 'm2' }], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    f.dispose()
  })

  it('已 hydrate 切入的未截断响应（truncated=false）窗口状态同步收敛', async () => {
    const f = makeFixture()
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm2' } as never], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await f.session.selectSession('sid-1')
    // 分区已被 reconcile 替换为响应内容（全量响应）→ 无更早历史可加载，窗口状态同步收敛
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [{ id: 'm2' }], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    f.dispose()
  })
})

describe('selectSession 12 步切入链（D3 端口束 / D4 壳版时序）', () => {
  /**
   * 记录型 sessionEntry fake（D3 接口级断言）：每端口一个 push 到数组的 spy。
   * touchRecency 被链内两步消费（步 6 切入 session / 步 11 panel 绑定 session），
   * 用调用序号 #1/#2 区分——同名端口两次调用的相对位置即统一链时序断言目标。
   */
  function makeEntrySpies(order: string[]) {
    let touchCount = 0
    return {
      cancelActiveFlow: vi.fn(() => { order.push('1.cancelActiveFlow') }),
      clearUnread: vi.fn((sid: string) => { order.push(`4.clearUnread(${sid})`) }),
      ensureStreamSubscription: vi.fn((sid: string) => { order.push(`5.ensureStreamSubscription(${sid})`) }),
      touchRecency: vi.fn((sid: string) => { order.push(`6/11.touchRecency#${++touchCount}(${sid})`) }),
      preloadFileTree: vi.fn((sid: string) => { order.push(`10.preloadFileTree(${sid})`) }),
      evictLru: vi.fn((sid: string | null) => { order.push(`12.evictLru(${sid ?? 'null'})`) }),
    }
  }

  it('12 步精确顺序：cancelActiveFlow→switch→setActiveId→clearUnread→ensureStream→touch→sync→push→hydrate→preload→touch(panel)→evict', async () => {
    const order: string[] = []
    const entry = makeEntrySpies(order)
    const f = makeFixture({ sessionEntry: entry })
    // 非 sessionEntry 步骤（api/store/panel/navigation/chat 端口）记录到同一数组，
    // 步骤号对齐统一链注释（use-session.selectSession 的 1-12 步）
    f.api.switchSession.mockImplementation(async (id: string) => { order.push(`2.switchSession(${id})`) })
    const origSetActiveId = f.store.setActiveId.bind(f.store)
    f.store.setActiveId = (id: string | null) => { order.push(`3.setActiveId(${id})`); origSetActiveId(id) }
    f.panel.loadSession.mockImplementation((pid: string, sid: string | null) => {
      order.push(`7.syncSessionToPanel(${pid}<-${sid})`)
    })
    f.navigation.push.mockImplementation((route: { view: string }) => {
      order.push(`8.navigation.push(${route.view})`)
    })
    f.chat.reconcileHistory.mockImplementation((sid: string) => { order.push(`9.hydrateReconcile(${sid})`) })
    // panel 绑定 session 经 PanelOrchestrationPort.focusedSessionId 读取
    // （壳版 panel.currentLeaf.sessionId 与之同源——panel store layout.sessionId）
    f.panel.focusedSessionId.mockReturnValue('sid-1')

    await f.session.selectSession('sid-1')

    expect(order).toEqual([
      '1.cancelActiveFlow',
      '2.switchSession(sid-1)',
      '3.setActiveId(sid-1)',
      '4.clearUnread(sid-1)',
      '5.ensureStreamSubscription(sid-1)',
      '6/11.touchRecency#1(sid-1)',
      '7.syncSessionToPanel(p1<-sid-1)',
      '8.navigation.push(chat)',
      '9.hydrateReconcile(sid-1)',
      '10.preloadFileTree(sid-1)',
      '6/11.touchRecency#2(sid-1)',
      '12.evictLru(sid-1)',
    ])
    expect(f.panel.focusedSessionId).toHaveBeenCalled()
    // touchRecency 双跳：切入 session（步 6）+ panel 绑定 session（步 11，exempt 前半）
    expect(entry.touchRecency).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('panel 无绑定 session（focusedSessionId=null）：步 11 跳过，evictLru(null) 照常执行', async () => {
    const order: string[] = []
    const entry = makeEntrySpies(order)
    const f = makeFixture({ sessionEntry: entry })
    f.panel.focusedSessionId.mockReturnValue(null)

    await f.session.selectSession('sid-1')

    // 仅步 6 一次 touchRecency；步 11 的条件刷新跳过（对齐壳版 if (panel.currentLeaf.sessionId)）
    expect(entry.touchRecency).toHaveBeenCalledTimes(1)
    expect(entry.touchRecency).toHaveBeenCalledWith('sid-1')
    expect(entry.evictLru).toHaveBeenCalledTimes(1)
    expect(entry.evictLru).toHaveBeenCalledWith(null)
    f.dispose()
  })

  it('sessionEntry 全缺省：链完整执行不崩（no-op 步骤占位），主步骤照常', async () => {
    const f = makeFixture()
    await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
    expect(f.api.switchSession).toHaveBeenCalledWith('sid-1')
    expect(f.store.activeId.value).toBe('sid-1')
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [], { truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
    f.dispose()
  })

  it('成员级部分注入（仅 clearUnread）：其余成员缺省 no-op 不崩，链完整', async () => {
    const clearUnread = vi.fn()
    const f = makeFixture({ sessionEntry: { clearUnread } })
    await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
    expect(clearUnread).toHaveBeenCalledWith('sid-1')
    expect(f.store.activeId.value).toBe('sid-1')
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
    f.dispose()
  })

  it('switchSession reject：步 1 已执行、步 4 起全部短路 + 抛错上抛（失败语义不变）', async () => {
    const entry = makeEntrySpies([])
    const f = makeFixture({ sessionEntry: entry })
    f.api.switchSession.mockRejectedValue(new Error('not found'))

    await expect(f.session.selectSession('ghost')).rejects.toThrow('not found')
    // 步 1 在 switch 之前（对齐壳版 cancelFlow 先于 switchSession）
    expect(entry.cancelActiveFlow).toHaveBeenCalledTimes(1)
    expect(entry.clearUnread).not.toHaveBeenCalled()
    expect(entry.ensureStreamSubscription).not.toHaveBeenCalled()
    expect(entry.touchRecency).not.toHaveBeenCalled()
    expect(entry.preloadFileTree).not.toHaveBeenCalled()
    expect(entry.evictLru).not.toHaveBeenCalled()
    expect(f.panel.loadSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    expect(f.store.activeId.value).toBeNull()
    f.dispose()
  })

  it('hydrate 失败（未 hydrate 分支）：markHistoryFailed 不抛穿，尾部步骤 10-12 照常执行', async () => {
    const entry = makeEntrySpies([])
    const f = makeFixture({ sessionEntry: entry })
    f.chat.getHistory.mockRejectedValue(new Error('io'))

    await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
    expect(f.chat.markHistoryFailed).toHaveBeenCalledWith('sid-1')
    // D4 后 hydrate 在 panel 载入之后：panel 已挂载（先亮），历史失败不阻断文件树/驱逐
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
    expect(entry.preloadFileTree).toHaveBeenCalledWith('sid-1')
    expect(entry.evictLru).toHaveBeenCalledTimes(1)
    f.dispose()
  })
})

describe('deleteSession', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
  })

  it('TC-4 S3 全 hooks 调用序：panel 解绑→removeFromList→11 必选 + G1 可选 3 hooks→triggerSessionCleanups', async () => {
    const f = makeFixture()
    seed(f.store, [{ cwd: '/a', sessions: [summary('del')] }])
    f.store.activeId.value = 'del'
    f.panel.findPanelBySession.mockReturnValue({ id: 'p1', sessionId: 'del' })

    await f.session.deleteSession('del')

    // panel 解绑（[U7] overlay 兜底清理已随 overlay 移除）
    expect(f.panel.loadSession).toHaveBeenCalledWith('p1', null)
    // removeFromList 生效（列表空）
    expect(f.store.list.value).toHaveLength(0)
    // 删 active 后列表空 → push chat 空态
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
    // S3 全序（log 数组精确顺序断言）；末位 browserDestroy = B4 main 侧 WebContentsView 销毁接线，
    // 尾部 G1 三钩子 = 死清理 API 接线组（terminal 写队列 / slash 命令 / fork 通知 feed 分区）
    const expectedOrder = [
      'clearFileTree(del)', 'clearSubagent(del)', 'clearWorkflow(del)',
      'clearExtensionUI(del)', 'clearExtensionHost(del)', 'evictChat(del)',
      'evictVirtualKeys(del)', 'clearAgentCallMapping(del)', 'disposeChat(del)', 'invalidateStatus(del)',
      'browserDestroy(del)',
      'clearTerminalQueue(del)', 'clearSlashCommands(del)', 'clearForkNotices(del)',
    ]
    expect(f.log).toEqual(expectedOrder)
    // M1-03：extension-host 分区清理钩子被调用（壳层实现 emit session-destroyed）
    expect(f.hooks.clearExtensionHost).toHaveBeenCalledWith('del')
    f.dispose()
  })

  it('TC-4b G1 可选 hook 缺省容忍：不注入 clearTerminalQueue/clearSlashCommands/clearForkNotices 时删除链不炸', async () => {
    // [G1 / 2026-09-14 内存审计 §3.4] 三 hook 为可选成员（旧实现零破坏）——编排点 ?.
    // 调用，未注入即跳过（headless 形态 / 渐进接线期）。到类型层：仅必选 11 项即满足接口。
    const f = makeFixture()
    delete (f.hooks as Record<string, unknown>).clearTerminalQueue
    delete (f.hooks as Record<string, unknown>).clearSlashCommands
    delete (f.hooks as Record<string, unknown>).clearForkNotices
    seed(f.store, [{ cwd: '/a', sessions: [summary('del')] }])
    f.store.activeId.value = 'del'

    await expect(f.session.deleteSession('del')).resolves.toBeUndefined()

    // 删除链照常完成（removeFromList + 必选钩子不受可选缺省影响）
    expect(f.store.list.value).toHaveLength(0)
    expect(f.hooks.browserDestroy).toHaveBeenCalledWith('del')
    expect(f.log).not.toContain('clearTerminalQueue(del)')
    f.dispose()
  })

  it('TC-5 ES1 fallback：删 active 后 selectSession(next) reject → push({view:chat})，不抛', async () => {
    const f = makeFixture()
    seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
    f.store.activeId.value = 'a'
    // 回退 selectSession('b') 的 switchSession 失败（网络抖动）
    f.api.switchSession.mockRejectedValue(new Error('net'))

    await expect(f.session.deleteSession('a')).resolves.toBeUndefined()
    // cleanup 后 activeId 回退到 list[0]（removeFromList 语义）
    expect(f.store.activeId.value).toBe('b')
    // selectSession('b') 失败 → ES1 fallback push chat 空态
    expect(f.api.switchSession).toHaveBeenCalledWith('b')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
    f.dispose()
  })

  it('TC-6 非 active 删除：无回退（selectSession 未调）+ 仍走 cleanup', async () => {
    const f = makeFixture()
    seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
    f.store.activeId.value = 'a'

    await f.session.deleteSession('b')
    expect(f.store.activeId.value).toBe('a')
    expect(f.api.switchSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    expect(f.hooks.clearFileTree).toHaveBeenCalledWith('b')
    expect(f.hooks.disposeChat).toHaveBeenCalledWith('b')
    // B4：非 active 删除同样触发 browserDestroy（与 store 分区清理同生命周期）
    expect(f.hooks.browserDestroy).toHaveBeenCalledWith('b')
    // G1：非 active 删除同样触发三可选钩子（terminal/slash/fork 分区同生命周期释放）
    expect(f.hooks.clearTerminalQueue).toHaveBeenCalledWith('b')
    expect(f.hooks.clearSlashCommands).toHaveBeenCalledWith('b')
    expect(f.hooks.clearForkNotices).toHaveBeenCalledWith('b')
    f.dispose()
  })

  it('selectSessionFallback 注入：wasActive 回退走壳版端口（core headless selectSession 不触达）', async () => {
    // C-W5-1 债务清偿：壳（useSidebar）注入含 ensureStreamSubscription 时序的 selectSession，
    // 删 active 回退不再走 core headless 路径（否则回退后流式订阅缺失，handoff 回复丢失事故同源）
    const fallback = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
    const f = makeFixture({ selectSessionFallback: fallback })
    seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
    f.store.activeId.value = 'a'

    await f.session.deleteSession('a')
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledWith('b')
    expect(f.api.switchSession).not.toHaveBeenCalled()
    // 成功回退无空态出口
    expect(f.navigation.push).not.toHaveBeenCalled()
    f.dispose()
  })

  it('[D7] 空态承接：flow 接线时删空 → push chat + startFlow（landing 需 flow 活跃）', async () => {
    const f = makeFixture({ withFlow: true })
    seed(f.store, [{ cwd: '/a', sessions: [summary('del')] }])
    f.store.activeId.value = 'del'

    await f.session.deleteSession('del')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
    expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('[D7] S4 兜底：回退失败 + flow 接线 → push chat + startFlow，不抛', async () => {
    const f = makeFixture({ withFlow: true })
    seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
    f.store.activeId.value = 'a'
    f.api.switchSession.mockRejectedValue(new Error('net'))

    await expect(f.session.deleteSession('a')).resolves.toBeUndefined()
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
    expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
    f.dispose()
  })
})

describe('deleteFolder', () => {
  it('TC-7 wasActiveInFolder 回退：逐个 cleanup + selectSession(list[0]) + 返回值透传', async () => {
    const f = makeFixture()
    seed(f.store, [
      { cwd: '/a', sessions: [summary('a1'), summary('a2')] },
      { cwd: '/b', sessions: [summary('b1', '/b')] },
    ])
    f.store.activeId.value = 'a1'
    const res: BatchDeleteResult = { cwd: '/a', deleted: ['a1', 'a2'], failed: [] }
    f.api.removeByCwd.mockResolvedValue(res)

    const returned = await f.session.deleteFolder('/a')
    expect(returned).toBe(res)
    // 逐个 cleanup（a1、a2 各一轮）
    expect(f.hooks.clearFileTree).toHaveBeenCalledTimes(2)
    expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a1')
    expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a2')
    expect(f.hooks.disposeChat).toHaveBeenCalledTimes(2)
    // B4：folder 批量删除逐 session 触发 browserDestroy（cleanupSessionState 复用路径）
    expect(f.hooks.browserDestroy).toHaveBeenCalledTimes(2)
    expect(f.hooks.browserDestroy).toHaveBeenCalledWith('a1')
    expect(f.hooks.browserDestroy).toHaveBeenCalledWith('a2')
    // G1：folder 批量删除逐 session 触发三可选钩子（同 cleanupSessionState 复用路径）
    expect(f.hooks.clearTerminalQueue).toHaveBeenCalledTimes(2)
    expect(f.hooks.clearSlashCommands).toHaveBeenCalledWith('a1')
    expect(f.hooks.clearForkNotices).toHaveBeenCalledWith('a2')
    // activeId 回退到列表首项 'b1'，selectSession 衔接
    expect(f.store.activeId.value).toBe('b1')
    expect(f.api.switchSession).toHaveBeenCalledWith('b1')
    f.dispose()
  })

  it('active 不在 folder：无回退，仅 cleanup', async () => {
    const f = makeFixture()
    seed(f.store, [
      { cwd: '/a', sessions: [summary('a1')] },
      { cwd: '/b', sessions: [summary('b1', '/b')] },
    ])
    f.store.activeId.value = 'b1'
    f.api.removeByCwd.mockResolvedValue({ cwd: '/a', deleted: ['a1'], failed: [] })

    await f.session.deleteFolder('/a')
    expect(f.store.activeId.value).toBe('b1')
    expect(f.api.switchSession).not.toHaveBeenCalled()
    expect(f.navigation.push).not.toHaveBeenCalled()
    expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a1')
    f.dispose()
  })

  it('selectSessionFallback 注入：wasActiveInFolder 回退走壳版端口', async () => {
    const fallback = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
    const f = makeFixture({ selectSessionFallback: fallback })
    seed(f.store, [
      { cwd: '/a', sessions: [summary('a1'), summary('a2')] },
      { cwd: '/b', sessions: [summary('b1', '/b')] },
    ])
    f.store.activeId.value = 'a1'
    f.api.removeByCwd.mockResolvedValue({ cwd: '/a', deleted: ['a1', 'a2'], failed: [] })

    const returned = await f.session.deleteFolder('/a')
    expect(returned.deleted).toEqual(['a1', 'a2'])
    // 回退 list[0]='b1' 走壳版端口，core headless 不触达
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledWith('b1')
    expect(f.api.switchSession).not.toHaveBeenCalled()
    f.dispose()
  })
})

describe('loadSessions / retryHistory / renameSession / syncSessionToPanel', () => {
  it('TC-8 loadSessions 成功：applySnapshot 整表 + setListLoadError(null)', async () => {
    const f = makeFixture()
    const groups = [{ cwd: '/a', sessions: [summary('s1')] }]
    f.api.list.mockResolvedValue(groups)
    f.store.setListLoadError('stale')
    await f.session.loadSessions()
    expect(f.store.groups.value).toEqual(groups)
    expect(f.store.listLoadError.value).toBeNull()
    f.dispose()
  })

  it('TC-9 loadSessions 失败（ES2/S5）：setListLoadError(msg) + 不抛', async () => {
    const f = makeFixture()
    f.api.list.mockRejectedValue(new Error('conn lost'))
    seed(f.store, [{ cwd: '/a', sessions: [summary('s1')] }])
    await expect(f.session.loadSessions()).resolves.toBeUndefined()
    expect(f.store.listLoadError.value).toBe('conn lost')
    expect(f.store.list.value).toHaveLength(1)
    f.dispose()
  })

  it('TC-11 retryHistory 成功：clearHistoryError→getHistory→reconcile+窗口状态', async () => {
    const f = makeFixture()
    const msgs = [{ id: 'm1' } as never]
    f.chat.getHistory.mockResolvedValue({ messages: msgs, truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await f.session.retryHistory('s1')
    expect(f.chat.clearHistoryError).toHaveBeenCalledWith('s1')
    expect(f.chat.getHistory).toHaveBeenCalledWith('s1')
    expect(f.chat.reconcileHistory).toHaveBeenCalledWith('s1', msgs, { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    expect(f.chat.markHistoryFailed).not.toHaveBeenCalled()
    f.dispose()
  })

  it('TC-11 retryHistory 失败：markHistoryFailed + 不抛', async () => {
    const f = makeFixture()
    f.chat.getHistory.mockRejectedValue(new Error('io'))
    await expect(f.session.retryHistory('s1')).resolves.toBeUndefined()
    expect(f.chat.markHistoryFailed).toHaveBeenCalledWith('s1')
    f.dispose()
  })

  it('TC-13 renameSession：api.rename + 乐观更新 applySnapshot(label)', async () => {
    const f = makeFixture()
    seed(f.store, [{ cwd: '/a', sessions: [summary('s1')] }])
    await f.session.renameSession('s1', '新名字')
    expect(f.api.rename).toHaveBeenCalledWith('s1', '新名字')
    expect(f.store.list.value[0]!.label).toBe('新名字')
    f.dispose()
  })

  it('TC-13 syncSessionToPanel：loadSession(activePanelId, sessionId)', () => {
    const f = makeFixture()
    f.panel.activePanelId.mockReturnValue('p9')
    f.session.syncSessionToPanel('s1')
    expect(f.panel.loadSession).toHaveBeenCalledWith('p9', 's1')
    f.dispose()
  })
})

describe('newSession（延迟 create 语义）', () => {
  it('TC-12 currentSession null → push chat + 返回 null（延迟 create 路径）', async () => {
    const f = makeFixture({ withFlow: true })
    const result = await f.session.newSession()
    expect(result).toBeNull()
    expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
    expect(f.api.switchSession).not.toHaveBeenCalled()
    f.dispose()
  })

  it('TC-12 flow 产出 session → selectSession(created.id) + 返回 id', async () => {
    const f = makeFixture({ withFlow: true })
    f.flow.currentSession.mockReturnValue(summary('new1'))
    const result = await f.session.newSession('/b')
    expect(result).toBe('new1')
    expect(f.flow.startFlow).toHaveBeenCalledWith('/b')
    expect(f.api.switchSession).toHaveBeenCalledWith('new1')
    expect(f.store.activeId.value).toBe('new1')
    expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'new1' })
    f.dispose()
  })

  it('TC-12 in-flight 守卫：未 resolve 时二次调用直接返回 null', async () => {
    const f = makeFixture({ withFlow: true })
    let release!: () => void
    f.flow.startFlow.mockImplementation(() => new Promise<void>((r) => { release = r }))
    const first = f.session.newSession()
    const second = await f.session.newSession()
    expect(second).toBeNull()
    expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
    release()
    await first
    f.dispose()
  })

  it('flow 未接线（deps.flow 缺省）：返回 null 降级', async () => {
    const f = makeFixture()
    const result = await f.session.newSession()
    expect(result).toBeNull()
    expect(f.navigation.push).not.toHaveBeenCalled()
    f.dispose()
  })
})

describe('bindSessionListBroadcast refCount', () => {
  beforeEach(() => {
    resetSessionListSubForTest()
  })

  it('TC-10 多实例只订阅一次；全销毁后 unsub 一次；handler emit 触发 applySnapshot 整表', async () => {
    const unsub = vi.fn()
    let capturedHandler: ((groups: SessionGroup[]) => void) | null = null
    const scopeA = effectScope(true)
    const scopeB = effectScope(true)
    const storeA = scopeA.run(() => createSessionStore())!
    const storeB = scopeB.run(() => createSessionStore())!
    const apiA = {
      list: vi.fn().mockResolvedValue([]),
      switchSession: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(), rename: vi.fn(), remove: vi.fn(),
      removeByCwd: vi.fn(), migrateImage: vi.fn(),
      onConfigSessions: vi.fn((h: (g: SessionGroup[]) => void) => {
        capturedHandler = h
        return unsub
      }),
    }
    const baseDepsA = { store: storeA, api: apiA, panel: makePanel(), navigation: { push: vi.fn() }, chat: makeChat(), hooks: makeHooks([]) }
    const baseDepsB = { store: storeB, api: apiA, panel: makePanel(), navigation: { push: vi.fn() }, chat: makeChat(), hooks: makeHooks([]) }

    scopeA.run(() => createUseSession(baseDepsA))
    // 实例 B 共用同一 api（订阅只发生一次）
    scopeB.run(() => createUseSession(baseDepsB))
    expect(apiA.onConfigSessions).toHaveBeenCalledTimes(1)

    // handler 主动 emit 分组 → 实例 A 的 store 更新
    capturedHandler!([{ cwd: '/a', sessions: [summary('s1')] }])
    expect(storeA.groups.value).toHaveLength(1)

    // A 销毁（count 2→1 不退订）
    scopeA.stop()
    expect(unsub).not.toHaveBeenCalled()
    // B 销毁（count 1→0 退订一次）
    scopeB.stop()
    expect(unsub).toHaveBeenCalledTimes(1)

    resetSessionListSubForTest()
  })
})

/**
 * 图片落盘编排收口测试（crash-resilience §3.3 D6-⑨，Gate B A9③ 缺陷#2 回流修复）。
 *
 * 断言 use-session 侧三条 hydrate 通路（首次切入 / 已 hydrate 刷新 / retryHistory）
 * 统一经 reconcileFromReply 触发 persistImagesNewestFirst——此前编排只挂
 * useChat.hydrateHistory，主流点击切入三处 reconcile 旁路致 cache 零写入。
 * 引擎级语义（新→旧反转 / 超帽即停 / 幂等去重）由 chat/__tests__/image-cache-orchestration.test.ts
 * 覆盖，此处只测编排点挂接：注入 recording write port 断言「被调用 + sessionId + 新→旧序」。
 */
describe('hydrate 通路图片落盘编排收口（D6-⑨ 缺陷#2）', () => {
  /** 记录型 write port：捕获 (sessionId, images 序)，回写全量 written。 */
  function makeRecordingPort() {
    const calls: Array<{ sessionId: string; order: string[] }> = []
    const port = vi.fn((sessionId: string, images: ImageCacheWriteImage[]): Promise<ImageCacheWriteResult> => {
      calls.push({ sessionId, order: images.map((i) => i.data) })
      return Promise.resolve({
        results: images.map((i) => ({ status: 'written' as const, path: `/cache/${sessionId}/${i.data}.png`, bytes: 10 })),
        quotaFull: false,
      })
    })
    return { calls, port }
  }

  /** 含单张 toolResult 图的 assistant 消息（collectImagesFromMessages 扫描对象）。 */
  function msgWithImage(id: string, data: string): never {
    return {
      id, role: 'assistant', content: '', status: 'complete', timestamp: 0,
      toolCalls: [{ id: `t-${id}`, toolName: 'shot', input: {}, status: 'completed', startTime: 0, images: [{ data, mimeType: 'image/png' }] }],
    } as never
  }

  beforeEach(() => {
    resetSessionListSubForTest()
    _resetImageCacheForTest()
  })

  afterEach(() => {
    _resetImageCacheForTest()
  })

  it('selectSession 首次切入（主流点击路径）：getHistory 含 toolResult 图 → 落盘编排被调，port 收新→旧序', async () => {
    const { calls, port } = makeRecordingPort()
    setImageCacheWritePort(port)
    const f = makeFixture()
    // 消息序（旧→新）：m-old 在前、m-new 在后
    f.chat.getHistory.mockResolvedValue({
      messages: [msgWithImage('m-old', 'old-1'), msgWithImage('m-new', 'new-2')],
      truncated: false, loadedTurns: 2, totalTurnsEstimate: 2,
    })

    await f.session.selectSession('sid-1')

    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('sid-1')
    // D6-⑨ 顺序契约：消息序反转为新→旧交 main 落盘（超帽弃最旧）
    expect(calls[0]!.order).toEqual(['new-2', 'old-1'])
    f.dispose()
  })

  it('selectSession 已 hydrate 刷新：reconcile 通路同样触发落盘编排', async () => {
    const { calls, port } = makeRecordingPort()
    setImageCacheWritePort(port)
    const f = makeFixture()
    f.chat.isHydrated.mockReturnValue(true)
    f.chat.getHistory.mockResolvedValue({
      messages: [msgWithImage('m1', 'img-1')],
      truncated: true, loadedTurns: 1, totalTurnsEstimate: 3,
    })

    await f.session.selectSession('sid-1')

    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('sid-1')
    expect(calls[0]!.order).toEqual(['img-1'])
    f.dispose()
  })

  it('retryHistory：reconcile 通路触发落盘编排', async () => {
    const { calls, port } = makeRecordingPort()
    setImageCacheWritePort(port)
    const f = makeFixture()
    f.chat.getHistory.mockResolvedValue({
      messages: [msgWithImage('m1', 'img-1')],
      truncated: false, loadedTurns: 1, totalTurnsEstimate: 1,
    })

    await f.session.retryHistory('s1')

    expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('s1')
    f.dispose()
  })

  it('无图历史：port 不被调（collect 空列表零开销早退）；getHistory 失败短路：编排不触达', async () => {
    const { calls, port } = makeRecordingPort()
    setImageCacheWritePort(port)
    const f = makeFixture()

    // 无图消息（messages 无 toolCalls.images）
    f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm1' } as never], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    await f.session.selectSession('sid-1')
    expect(calls).toHaveLength(0)
    f.dispose()

    // hydrate 失败（getHistory reject）：markHistoryFailed 分支不触达编排
    const f2 = makeFixture()
    f2.chat.getHistory.mockRejectedValue(new Error('io'))
    await expect(f2.session.selectSession('sid-1')).resolves.toBeUndefined()
    expect(f2.chat.markHistoryFailed).toHaveBeenCalledWith('sid-1')
    expect(calls).toHaveLength(0)
    f2.dispose()
  })

  it('重复切入幂等：已落盘图（内容 hash 记账）不重复交 port', async () => {
    const { calls, port } = makeRecordingPort()
    setImageCacheWritePort(port)
    const f = makeFixture()
    f.chat.getHistory.mockResolvedValue({
      messages: [msgWithImage('m1', 'img-1')],
      truncated: false, loadedTurns: 1, totalTurnsEstimate: 1,
    })

    await f.session.selectSession('sid-1')
    f.chat.isHydrated.mockReturnValue(true) // 第二次切入走已 hydrate 刷新分支
    await f.session.selectSession('sid-1')

    expect(calls).toHaveLength(1) // 第二次编排 pending 全被记账剔除，port 不再被调
    f.dispose()
  })
})

function makePanel() {
  return {
    focusedSessionId: vi.fn(() => null),
    activePanelId: vi.fn(() => 'p1'),
    findPanelBySession: vi.fn(() => null),
    loadSession: vi.fn(),
    openPanel: vi.fn(),
  }
}

function makeChat(): ChatHydratePort {
  return {
    getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    isHydrated: vi.fn(() => false),
    hydrate: vi.fn(),
    reconcileHistory: vi.fn(),
    clearHistoryError: vi.fn(),
    markHistoryFailed: vi.fn(),
  }
}
