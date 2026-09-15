/**
 * [u4d-truncated-ui] 截断窗口状态测试（crash-resilience §3.3 D4；[u6] 游标翻页适配）。
 *
 * 三视角（TEST-STRATEGY §3，本文件覆盖构建者白盒 + 使用者黑盒；DOM 视角在
 * ui/renderer 组件测试）：
 * 1. historyWindowFromReply 归一（[u6] 三字段必填——legacy historyTruncated 已退役）
 * 2. store hydrate/reconcile 路径写入窗口状态（必测断言⑤：hydrate 接线字段正确）
 * 3. loadMoreHistory 游标翻页（[u6] 原 getFullHistory 全量通路退役）：游标 = 分区最旧
 *    消息身份、页窗口状态累计、翻页到头收敛
 * 4. disposeSession / LRU 驱逐清理分区
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/truncated-window.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { Message } from '@taiji/shared'
import { createChatStore } from '../store'
import { createUseChat, resetChatModuleStateForTest } from '../useChat'
import type { UseChatDeps } from '../use-chat-types'
import { createTruncatedWindowController, historyWindowFromReply } from '../truncated-window'

// ── 1. 归一函数 ──────────────────────────────────────────────────

describe('historyWindowFromReply 归一（[u6] 三字段必填）', () => {
  it('u4b 窗口契约 reply：truncated/loadedTurns/totalTurnsEstimate 原样透传', () => {
    expect(
      historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 }),
    ).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    expect(
      historyWindowFromReply({ truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    ).toEqual({ truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })
})

// ── 2/3/4. store + useChat 集成 ─────────────────────────────────

function makeMsg(id: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
}

function makeFixture() {
  const scope = effectScope(true)
  const chatStore = scope.run(() => createChatStore())!
  const chatApi = {
    send: vi.fn().mockResolvedValue(undefined),
    subagentAction: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    bash: vi.fn().mockResolvedValue(undefined),
    abortBash: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    streamSubscribe: vi.fn(() => vi.fn()),
  }
  const deps: UseChatDeps = {
    chatApi,
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => ({ applySnapshot: vi.fn(), revive: vi.fn() }),
    toast: { error: vi.fn(), warning: vi.fn() },
    t: (k: string) => k,
    getCompactQueue: () => ({
      flush: vi.fn().mockResolvedValue(true),
      enqueue: vi.fn(),
      peek: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      confirmDelivery: vi.fn(() => false),
    }),
  }
  const useChat = scope.run(() => createUseChat(deps))!
  return {
    useChat,
    chatStore,
    chatApi,
    dispose: () => scope.stop(),
  }
}

describe('store 截断窗口状态（hydrate/reconcile 接线）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('必测⑤ hydrate 接线：hydrateHistory 把窗口契约字段正确写入 store 窗口状态', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({
      messages: [makeMsg('m1')],
      truncated: true,
      loadedTurns: 20,
      totalTurnsEstimate: 42,
    })
    await f.useChat.hydrateHistory('s1')
    expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    // 布尔显隐从窗口状态派生（单一事实）
    expect(f.useChat.hasMoreHistory('s1')).toBe(true)
    f.dispose()
  })

  it('hydrate 不带 window（mock 门面 legacy reply）→ 无窗口记录，按未截断处理', async () => {
    const f = makeFixture()
    f.chatStore.hydrate('s1', [makeMsg('m1')])
    expect(f.chatStore.getHistoryWindow('s1')).toBeUndefined()
    expect(f.useChat.hasMoreHistory('s1')).toBe(false)
    f.dispose()
  })

  it('reconcileHistory 刷新窗口状态（切入链每次拿最新预算窗口响应）', async () => {
    const f = makeFixture()
    f.chatStore.hydrate('s1', [makeMsg('m1')], { truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    // 切出切回：u4b 预算窗口响应 → truncated 翻回 true（顶部条重显）
    f.chatStore.reconcileHistory('s1', [makeMsg('m2')], { truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    f.dispose()
  })

  it('reconcileHistory 未 hydrate 分支等价 hydrate：窗口状态一并写入', () => {
    const f = makeFixture()
    f.chatStore.reconcileHistory('s1', [makeMsg('m1')], { truncated: true, loadedTurns: 5, totalTurnsEstimate: 9 })
    expect(f.chatStore.isHydrated('s1')).toBe(true)
    expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 5, totalTurnsEstimate: 9 })
    f.dispose()
  })

  it('disposeSession 清理窗口分区', () => {
    const f = makeFixture()
    f.chatStore.hydrate('s1', [makeMsg('m1')], { truncated: true, loadedTurns: 3, totalTurnsEstimate: 9 })
    expect(f.chatStore.getHistoryWindow('s1')).toBeDefined()
    f.chatStore.disposeSession('s1')
    expect(f.chatStore.getHistoryWindow('s1')).toBeUndefined()
    f.dispose()
  })
})

describe('loadMoreHistory 游标翻页（[u6] 需求③：点击「加载更早」触发带 cursor 的 session.history）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('truncated=true 时点击：游标 = 分区最旧消息身份，页响应收敛 truncated=false（翻页到头）', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({
      messages: [makeMsg('m1')],
      truncated: true,
      loadedTurns: 20,
      totalTurnsEstimate: 42,
    })
    await f.useChat.hydrateHistory('s1')
    expect(f.useChat.hasMoreHistory('s1')).toBe(true)

    // 「加载更早」→ session.history 带 cursor（游标 = 分区最旧消息 m1 的 id）
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [makeMsg('m0')], truncated: false, loadedTurns: 10, totalTurnsEstimate: 30 })
    await f.useChat.loadMoreHistory('s1')
    expect(f.chatApi.getHistory).toHaveBeenLastCalledWith('s1', { cursor: 'm1' })
    // 翻页到头 → truncated=false → 顶部条消失（需求③收敛态）
    expect(f.useChat.hasMoreHistory('s1')).toBe(false)
    expect(f.chatStore.getHistoryWindow('s1')!.truncated).toBe(false)
    // loadedTurns 累计各页（20 + 10）；读到头 totalTurnsEstimate = 页精确值
    expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: false, loadedTurns: 30, totalTurnsEstimate: 30 })
    // 页内容前插（m0 在 m1 之前）
    expect(f.chatStore.getMessages('s1').map((m) => m.id)).toEqual(['m0', 'm1'])
    f.dispose()
  })

  it('页响应仍 truncated=true（锚前有更早历史）→ 入口保持可见 + 窗口累计', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [makeMsg('m1')], truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    await f.useChat.hydrateHistory('s1')
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [makeMsg('m0')], truncated: true, loadedTurns: 20, totalTurnsEstimate: 40 })
    await f.useChat.loadMoreHistory('s1')
    expect(f.useChat.hasMoreHistory('s1')).toBe(true)
    expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 40, totalTurnsEstimate: 42 })
    f.dispose()
  })

  it('cursor 未命中（runtime 返回空页 truncated=false）：分区不变 + 入口收敛，不报错', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [makeMsg('m1')], truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    await f.useChat.hydrateHistory('s1')
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    await f.useChat.loadMoreHistory('s1')
    expect(f.chatStore.getMessages('s1').map((m) => m.id)).toEqual(['m1']) // 分区不变
    expect(f.useChat.hasMoreHistory('s1')).toBe(false) // 翻页到头收敛
    f.dispose()
  })
})

describe('createTruncatedWindowController 工厂本体（review S-12c：不经 store 的纯控制器路径）', () => {
  it('无记录 clearHistoryWindow 幂等 early-return：不抛、Map 不被无谓替换', () => {
    const scope = effectScope(true)
    const ctrl = scope.run(() => createTruncatedWindowController())!
    expect(() => ctrl.clearHistoryWindow('never-hydrated')).not.toThrow()
    expect(ctrl.getHistoryWindow('never-hydrated')).toBeUndefined()
    expect(ctrl.historyWindows.value.size).toBe(0)
    scope.stop()
  })

  it('set→get→clear 全链：写入可见、清除后回 undefined、二次 clear 幂等', () => {
    const scope = effectScope(true)
    const ctrl = scope.run(() => createTruncatedWindowController())!
    ctrl.setHistoryWindow('s1', { truncated: true, loadedTurns: 3, totalTurnsEstimate: 9 })
    expect(ctrl.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 3, totalTurnsEstimate: 9 })
    ctrl.clearHistoryWindow('s1')
    expect(ctrl.getHistoryWindow('s1')).toBeUndefined()
    expect(() => ctrl.clearHistoryWindow('s1')).not.toThrow()
    scope.stop()
  })
})
