// store-merged-merged.test.ts —— core C06 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/chat/store.ts`、`src/domain/chat/useChat.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/chat/__tests__/live-state-write-paths.test.ts（6 用例，skip 0）
//   - src/domain/chat/__tests__/truncated-window.test.ts（11 用例，skip 0）
//   - src/domain/chat/__tests__/use-chat-disposition.test.ts（17 用例，skip 0）
//   - src/domain/chat/__tests__/useChat.test.ts（87 用例，skip 0）

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { effectScope, nextTick, toRaw } from 'vue'
import { textToSegments, type Segment, type ServerMessage, type Message, segmentsToText } from '@taiji/shared'
import { createChatStore } from '../store'
import { createUseChat, resetChatModuleStateForTest, type UseChatDeps, EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS } from '../useChat'
import { type SessionLiveStateLike, type SessionStoreLike, type UseChatDeps as UseChatDepsTypes } from '../use-chat-types'
import { type SessionLiveState, createSessionLiveState } from '@taiji/core/domain/session'
import { createTruncatedWindowController, historyWindowFromReply } from '../truncated-window'
import { replaceDeliveryProjection, resetDeliveryProjectionForTest, getDeliveryProjectionRef } from '../effects/user-delivery'
import { getExecutingBash as getExecutingBashForTest } from '../bash-effects'
import { provideDevMode, __resetDevModeForTesting } from '../../../platform/dev-mode'
import { type DeliveryFrameEntry } from '../api-port'
import { msg, userEndFrame } from './helpers/fixtures'

// ======== 来源：live-state-write-paths.test.ts ========
describe("live-state-write-paths", () => {
  interface Fixture { // oe-exempt:20261023:test:测试 harness 参数包（单文件局部，非架构契约）
    useChat: ReturnType<typeof createUseChat>
    sessionStore: SessionStoreLike & {
      applySnapshot: ReturnType<typeof vi.fn>
      revive: ReturnType<typeof vi.fn>
    }
    liveState: SessionLiveStateLike
    writeModel: (id: string, patch: { modelId?: string; thinkingLevel?: string }) => void
    emit: (sid: string, m: ServerMessage) => void
    dispose: () => void
  }

  /** 极简状态层替身（语义与 core createSessionLiveState 同形：字段级合并 + 缺失 undefined） */
  function makeLiveState(): SessionLiveStateLike {
    const store = new Map<string, SessionLiveState>()
    return {
      applyLiveState: (id, patch) => {
        const prev = store.get(id) ?? {}
        const next: SessionLiveState = { ...prev }
        if (patch.modelId !== undefined) next.modelId = patch.modelId
        if (patch.thinkingLevel !== undefined) next.thinkingLevel = patch.thinkingLevel
        store.set(id, next)
      },
      liveStateOf: (id) => store.get(id),
      removeLiveState: (id) => {
        store.delete(id)
      },
    }
  }

  function makeFixture(): Fixture {
    const scope = effectScope(true)
    const streamHandlers = new Map<string, (m: ServerMessage) => void>()
    const chatStore = scope.run(() => createChatStore())!
    const chatApi = {
      submitDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' }),
      send: vi.fn(),
      subagentAction: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      bash: vi.fn(),
      abortBash: vi.fn(),
      getHistory: vi.fn(),
      streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
        streamHandlers.set(sid, h)
        return () => streamHandlers.delete(sid)
      }),
      revokeMessage: vi.fn(),
      cancelDelivery: vi.fn(),
    }
    const sessionStore = { applySnapshot: vi.fn(), revive: vi.fn() }
    const liveState = makeLiveState()
    const deps: UseChatDeps = {
      chatApi: chatApi as unknown as UseChatDeps['chatApi'],
      writeSegments: vi.fn().mockResolvedValue(undefined),
      getChatStore: () => chatStore,
      getSessionStore: () => sessionStore,
      getLiveStateStore: () => liveState,
      toast: { error: vi.fn(), warning: vi.fn() },
      t: (k: string) => k,
    }
    const useChat = createUseChat(deps)
    return {
      useChat,
      sessionStore,
      liveState,
      writeModel: (id, patch) => liveState.applyLiveState(id, patch),
      emit: (sid, m) => streamHandlers.get(sid)?.(m),
      dispose: () => scope.stop(),
    }
  }

  function frame(sid: string, type: string, payload: Record<string, unknown>): ServerMessage {
    return { type, id: `p_${type}`, payload: { sessionId: sid, ...payload } } as unknown as ServerMessage
  }

  const SEGMENTS: Segment[] = textToSegments('触发订阅')

  describe('session 状态帧 → 状态层（无列表命中判据）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
    })

    it('侧栏列表之外的会话 id（btw 线 session id）收到 state_changed：状态层更新（验收项 2 核心）', async () => {
      const f = makeFixture()
      const sessionId = 'pi-line-1'
      await f.useChat.send(sessionId, SEGMENTS)

      f.emit(sessionId, frame(sessionId, 'session.state_changed', { modelId: 'p/line-model', thinkingLevel: 'low' }))

      // 状态层按 id 寄存：与主会话完全同一条路径
      expect(f.liveState.liveStateOf(sessionId)).toEqual({ modelId: 'p/line-model', thinkingLevel: 'low' })
      // 导航列表不再承载状态字段写入（唯一写入口是状态层）
      expect(f.sessionStore.applySnapshot).not.toHaveBeenCalled()
      f.dispose()
    })

    it('btw 线与主会话走同一个 apply 函数（无 isBtwVirtualId 分支，验收项 5）', async () => {
      const f = makeFixture()
      const main = 'main-s1'
      const sessionId = 'pi-line-2'
      await f.useChat.send(main, SEGMENTS)
      await f.useChat.send(sessionId, SEGMENTS)

      f.emit(main, frame(main, 'session.state_changed', { modelId: 'p/main' }))
      f.emit(sessionId, frame(sessionId, 'session.state_changed', { modelId: 'p/line' }))

      const applySpy = vi.spyOn(f.liveState, 'applyLiveState')
      f.emit(main, frame(main, 'session.thinkingLevelSet', { level: 'high' }))
      f.emit(sessionId, frame(sessionId, 'session.thinkingLevelSet', { level: 'high' }))
      // 同一签名、同一入口被调用两次（入参形状相同，仅 id 不同）
      expect(applySpy.mock.calls).toEqual([
        [main, { thinkingLevel: 'high' }],
        [sessionId, { thinkingLevel: 'high' }],
      ])
      f.dispose()
    })

    it('未知 id（既不在侧栏列表也无任何注册）：照样写入状态层，不静默丢弃', async () => {
      const f = makeFixture()
      const ghost = 'ghost-session'
      await f.useChat.send(ghost, SEGMENTS)

      f.emit(ghost, frame(ghost, 'session.state_changed', { modelId: 'p/ghost' }))
      expect(f.liveState.liveStateOf(ghost)).toEqual({ modelId: 'p/ghost' })
      f.dispose()
    })

    it('thinkingLevel 缺省时只写 modelId，已缓存档位保留（字段级合并）', async () => {
      const f = makeFixture()
      const sid = 's-merge'
      await f.useChat.send(sid, SEGMENTS)
      f.emit(sid, frame(sid, 'session.state_changed', { modelId: 'p/one', thinkingLevel: 'low' }))

      f.emit(sid, frame(sid, 'session.state_changed', { modelId: 'p/two', thinkingLevel: undefined }))
      expect(f.liveState.liveStateOf(sid)).toEqual({ modelId: 'p/two', thinkingLevel: 'low' })
      f.dispose()
    })

    it('thinkingLevelSet 单独更新档位，不影响 modelId', async () => {
      const f = makeFixture()
      const sid = 's-tl'
      await f.useChat.send(sid, SEGMENTS)
      f.emit(sid, frame(sid, 'session.state_changed', { modelId: 'p/model' }))

      f.emit(sid, frame(sid, 'session.thinkingLevelSet', { level: 'max' }))
      expect(f.liveState.liveStateOf(sid)).toEqual({ modelId: 'p/model', thinkingLevel: 'max' })
      f.dispose()
    })

    it('session.renamed 仍写导航列表（label 是展示字段，不进状态层）', async () => {
      const f = makeFixture()
      await f.useChat.send('s-rename', SEGMENTS)

      f.emit('s-rename', frame('s-rename', 'session.renamed', { name: '新名' }))
      expect(f.sessionStore.applySnapshot).toHaveBeenCalledWith('s-rename', { label: '新名' })
      expect(f.liveState.liveStateOf('s-rename')).toBeUndefined()
      f.dispose()
    })
  })
});

// ======== 来源：truncated-window.test.ts ========
describe("truncated-window", () => {
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
    // [u5a 退役] ChatApiPort 已无 steer/followUp 成员（core 发送链统一 submitDelivery）——
    // mock 不留残留键（变量传参绕过 excess check，死键恒绿误导）
    const chatApi = {
      send: vi.fn().mockResolvedValue(undefined),
      submitDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' }),
      subagentAction: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn().mockResolvedValue(undefined),
      bash: vi.fn().mockResolvedValue(undefined),
      abortBash: vi.fn().mockResolvedValue(undefined),
      getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
      streamSubscribe: vi.fn(() => vi.fn()),
      // [U5 消息撤回] ChatApiPort 新增必选成员（revokeMessage/cancelDelivery）——本套件不触达
      // 撤回链，mock 补协议合法最小响应（类型完备；行为断言在 useChat.test.ts）
      revokeMessage: vi.fn().mockResolvedValue({ sessionId: 's1', revoked: false, error: 'no-mapping' }),
      cancelDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', cancelled: false }),
    }
    const deps: UseChatDepsTypes = {
      chatApi,
      writeSegments: vi.fn().mockResolvedValue(undefined),
      getChatStore: () => chatStore,
      getSessionStore: () => ({ applySnapshot: vi.fn(), revive: vi.fn() }),
      getLiveStateStore: () => createSessionLiveState(),
      toast: { error: vi.fn(), warning: vi.fn() },
      t: (k: string) => k,
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

    it('必测⑤ hydrate 接线：窗口契约字段经 historyWindowFromReply 归一后正确写入 store 窗口状态', () => {
      const f = makeFixture()
      // use-session 点击切入的生产通路：getHistory reply → historyWindowFromReply 归一 →
      // store.hydrate/reconcileHistory 写入（原 useChat.hydrateHistory 导出但无任何调用点已删，验收路径不变）
      f.chatStore.hydrate('s1', [makeMsg('m1')], historyWindowFromReply({
        truncated: true,
        loadedTurns: 20,
        totalTurnsEstimate: 42,
      }))
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
      f.chatStore.hydrate('s1', [makeMsg('m1')], historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 }))
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
      f.chatStore.hydrate('s1', [makeMsg('m1')], historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 }))
      f.chatApi.getHistory.mockResolvedValueOnce({ messages: [makeMsg('m0')], truncated: true, loadedTurns: 20, totalTurnsEstimate: 40 })
      await f.useChat.loadMoreHistory('s1')
      expect(f.useChat.hasMoreHistory('s1')).toBe(true)
      expect(f.chatStore.getHistoryWindow('s1')).toEqual({ truncated: true, loadedTurns: 40, totalTurnsEstimate: 42 })
      f.dispose()
    })

    it('cursor 未命中（runtime 返回空页 truncated=false）：分区不变 + 入口收敛，不报错', async () => {
      const f = makeFixture()
      f.chatStore.hydrate('s1', [makeMsg('m1')], historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 }))
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
});

// ======== 来源：use-chat-disposition.test.ts ========
describe("use-chat-disposition", () => {
  interface Fixture { // oe-exempt:20261004:test:测试 harness 参数包（单文件局部，非架构契约）
    useChat: ReturnType<typeof createUseChat>
    chatApi: {
      submitDelivery: ReturnType<typeof vi.fn>
      streamSubscribe: ReturnType<typeof vi.fn>
    }
    chatStore: ReturnType<typeof createChatStore>
    toast: { error: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> }
    /** 主动向 sid 的 streamSubscribe handler 注入一条 ServerMessage（模拟 WS 事件） */
    emit: (sid: string, m: ServerMessage) => void
    dispose: () => void
  }

  function makeFixture(): Fixture {
    const scope = effectScope(true)
    const streamHandlers = new Map<string, (m: ServerMessage) => void>()
    const chatStore = scope.run(() => createChatStore())!
    // 受理回执默认形态在用例内覆写（isCommand 是本族用例的自变量）
    const chatApi = {
      submitDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' }),
      streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
        streamHandlers.set(sid, h)
        return () => {
          streamHandlers.delete(sid)
        }
      }),
    }
    const toast = { error: vi.fn(), warning: vi.fn() }
    const deps: UseChatDeps = {
      chatApi: chatApi as unknown as UseChatDeps['chatApi'],
      writeSegments: vi.fn().mockResolvedValue(undefined),
      getChatStore: () => chatStore,
      getSessionStore: () => ({ applySnapshot: vi.fn(), revive: vi.fn() }),
      getLiveStateStore: () => createSessionLiveState(),
      toast,
      t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
    }
    const useChat = createUseChat(deps)
    return {
      useChat,
      chatApi,
      chatStore,
      toast,
      emit: (sid, m) => {
        streamHandlers.get(sid)?.(m)
      },
      dispose: () => scope.stop(),
    }
  }

  /** session.delivery 帧工厂（useChat.test.ts morph 用例同款形态） */
  function deliveryFrame(
    sid: string,
    entries: Array<{ clientUuid: string; state: string; lane: string }>,
  ): ServerMessage {
    return {
      type: 'session.delivery',
      payload: {
        sessionId: sid,
        entries: entries.map((e) => ({ clientUuid: e.clientUuid, preview: 'p', state: e.state, lane: e.lane })),
      },
    } as unknown as ServerMessage
  }

  /** session.deliveryHandled 终局通知帧工厂（D1③ payload：sessionId + clientUuid） */
  function handledFrame(sid: string, clientUuid: string): ServerMessage {
    return { type: 'session.deliveryHandled', payload: { sessionId: sid, clientUuid } }
  }

  /** extension.error 帧工厂（runtime event-adapter handleExtensionError 实发 payload 形态：
 * shared 侧该 type 为 Record<string, unknown> 占位，字段经 useChat 检查收窄） */
  function extensionErrorFrame(
    sid: string,
    fields: { extensionName: string; error: string; errorEvent: string },
  ): ServerMessage {
    return {
      type: 'extension.error',
      payload: { sessionId: sid, ...fields },
    } as unknown as ServerMessage
  }

  const COMMAND_REPLY = { clientUuid: 'u-x', state: 'in-flight' as const, lane: 'direct' as const, isCommand: true }

  describe('pi1-disposition-chat-flow U2：handled 终局通知静默回滚三件套（U2① / D1③④）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
      resetDeliveryProjectionForTest()
    })

    it('handled 通知到达 → 三件套：乐观气泡移出对话流（用户可见）+ pendingSend 清 + inflight 递减，无错误提示', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
      await f.useChat.send('s1', textToSegments('/todos'))
      const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
      // 前置：乐观气泡在流 + 占位记账
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
      expect(f.chatStore.isPendingSend('s1')).toBe(true)
      expect(f.chatStore.getInflight('s1')).toBe(1)

      f.emit('s1', handledFrame('s1', bubbleId))

      // 三件套：① 气泡移除（用户可见 DOM 断言——命令不进 transcript，气泡即刻消失）
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(false)
      // ② 清 dispatching 占位（clearPendingSend，纯 Set 操作）；③ 在途计数归零
      expect(f.chatStore.isPendingSend('s1')).toBe(false)
      expect(f.chatStore.getInflight('s1')).toBe(0)
      // 无错误提示：零 toast（handled = 命令已执行的正常终局）且无 error 气泡
      expect(f.toast.error).not.toHaveBeenCalled()
      expect(f.toast.warning).not.toHaveBeenCalled()
      expect(f.chatStore.getMessages('s1').some((m) => m.role === 'assistant' && m.status === 'error')).toBe(false)
      f.dispose()
    })

    it('非登记条目的 handled 通知零动作（外来命令条目不误扣本地在途配额）', async () => {
      const f = makeFixture()
      f.chatStore.incrementInflight('s1', 1)
      f.emit('s1', handledFrame('s1', 'foreign-uuid'))
      expect(f.chatStore.getInflight('s1')).toBe(1)
      f.dispose()
    })

    it('payload.sessionId 不匹配丢弃（ADR-0049 防御层）', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
      await f.useChat.send('s1', textToSegments('/todos'))
      const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
      f.emit('s1', handledFrame('other-session', bubbleId))
      // 非本 session 的通知不触发任何回滚
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
      expect(f.chatStore.getInflight('s1')).toBe(1)
      f.dispose()
    })
  })

  describe('pi1-disposition-chat-flow U2：孤儿对账双分支与反向（U2② / D1⑤）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
      resetDeliveryProjectionForTest()
    })

    it('分支 B：delivered 终态在场（通知丢失 + runtime 存活重连形态）→ 静默清除', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
      await f.useChat.send('s1', textToSegments('/todos'))
      const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
      // 帧1：条目受理进派生视图（in-flight）——「曾经在场」证据置位
      f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
      // 帧2：tombstone delivered 终态仍在派生视图（handled 通知已丢失）
      f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'delivered', lane: 'direct' }]))
      // 按 handled 同形态静默清除（用户可见 DOM 断言：气泡消失、无错误提示）
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(false)
      expect(f.chatStore.getInflight('s1')).toBe(0)
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('分支 A：不在当前派生视图（runtime 重启 tombstone 丢失形态）→ 静默清除', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
      await f.useChat.send('s1', textToSegments('/todos'))
      const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
      f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))
      // runtime 重启后派生视图为空（tombstone 内存态丢失）→ 分支 A 命中
      f.emit('s1', deliveryFrame('s1', []))
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(false)
      expect(f.chatStore.getInflight('s1')).toBe(0)
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('反向（V8 在途窗口）：受理窗口内快照不含新条目 → 未受理气泡不清除（「曾经在场」必要条件反向断言）', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
      await f.useChat.send('s1', textToSegments('/todos'))
      const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
      // 连发场景：第二条消息状态变化触发的快照不含未受理的第一条（受理窗口正常态）
      f.emit('s1', deliveryFrame('s1', []))
      // 未受理（从未见于派生视图）→「不在派生视图」不得清除（用户可见 DOM 断言：气泡保留）
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
      expect(f.chatStore.getInflight('s1')).toBe(1)
      // 后续帧条目进派生视图（in-flight）→ 仍不清（在途非终态）
      f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
      f.dispose()
    })

    it('操作域收窄：普通消息条目（受理回执无 isCommand）delivered 在场不清除——气泡去留归回执链', async () => {
      const f = makeFixture()
      await f.useChat.send('s1', textToSegments('普通消息'))
      const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
      f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))
      f.emit('s1', deliveryFrame('s1', [{ clientUuid: bubbleId, state: 'delivered', lane: 'direct' }]))
      // 快照先于 message_end 回执到达的窗口下，普通条目气泡被清 = 文本丢失风险——对账不碰
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
      f.dispose()
    })

    it('分支重叠防御：命令条目 steer 投递路径 morph 后孤儿清除不误删其后消息、不重建幽灵气泡', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
      await f.useChat.send('s1', textToSegments('/todos'))
      const cmdId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
      // 帧1：steer 投递路径 → 既有 morph 分支把气泡移出（与孤儿对账相邻分支，操作域互斥）
      f.emit('s1', deliveryFrame('s1', [{ clientUuid: cmdId, state: 'in-flight', lane: 'steer' }]))
      expect(f.chatStore.getMessages('s1').some((m) => m.id === cmdId)).toBe(false)
      // morph 后用户继续发消息（其后内容不能被对账误删）
      await f.useChat.send('s1', textToSegments('后续消息'))
      // 帧2：delivered 终态在场 → 孤儿清除（气泡已不在，truncateFrom 幂等 no-op）
      f.emit('s1', deliveryFrame('s1', [{ clientUuid: cmdId, state: 'delivered', lane: 'steer' }]))
      expect(f.chatStore.getMessages('s1').some((m) => m.id === cmdId)).toBe(false)
      expect(f.chatStore.getInflight('s1')).toBe(1) // 只剩后续消息的记账
      const after = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!
      expect(after.id).not.toBe(cmdId)
      expect(after.status).toBe('complete')
      f.dispose()
    })
  })

  describe('pi1-disposition-chat-flow U2：extension.error 命令反馈矩阵（U2③ / D10③）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
      resetDeliveryProjectionForTest()
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** 建立 streamSubscribe 订阅（不经 send——extension.error 消费独立于发送链） */
    function subscribeOnly(f: Fixture): void {
      void f.useChat.send('s1', textToSegments('建立订阅'))
      // 本组用例只关心 toast 断言：清掉 send 置位的 pendingSend 占位（无 timer 可推演——
      // 收尾全事件驱动，置位残留对 toast 断言无影响，纯状态卫生）
      f.chatStore.clearPendingSend('s1')
    }

    it('过滤：非 command 来源（事件/生命周期错误）不 toast，保持现状静默', () => {
      const f = makeFixture()
      subscribeOnly(f)
      f.emit('s1', extensionErrorFrame('s1', { extensionName: 'goal', error: 'handler blew up', errorEvent: 'agent_end' }))
      f.emit('s1', extensionErrorFrame('s1', { extensionName: 'x', error: 'register failed', errorEvent: 'register_provider' }))
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('command 来源 → toast 恰一次：文案带剥前缀命令名 + 错误文本（用户可见反馈）', () => {
      const f = makeFixture()
      subscribeOnly(f)
      f.emit('s1', extensionErrorFrame('s1', { extensionName: 'command:todos', error: 'boom', errorEvent: 'command' }))
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      const [text] = f.toast.error.mock.calls[0] as unknown as [string]
      expect(text).toContain('composable.extensionCommandFailed')
      expect(text).toContain('/todos')
      expect(text).toContain('boom')
      f.dispose()
    })

    it('风暴上限反向：同 key 3 连触发 → toast 恰一次（限频窗内去重）', () => {
      const f = makeFixture()
      subscribeOnly(f)
      const frame = (): ServerMessage =>
        extensionErrorFrame('s1', { extensionName: 'command:todos', error: 'boom', errorEvent: 'command' })
      f.emit('s1', frame())
      f.emit('s1', frame())
      f.emit('s1', frame())
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('限频窗两分支：窗内同 key 不重复弹；窗口（60s）过后同 key 再弹；异 key 同窗独立弹', () => {
      const f = makeFixture()
      subscribeOnly(f)
      const sameKey = (): ServerMessage =>
        extensionErrorFrame('s1', { extensionName: 'command:todos', error: 'boom', errorEvent: 'command' })
      const otherKey = (): ServerMessage =>
        extensionErrorFrame('s1', { extensionName: 'command:plan', error: 'other', errorEvent: 'command' })
      f.emit('s1', sameKey())
      f.emit('s1', otherKey())
      // 同窗：同 key 去重、异 key 独立
      expect(f.toast.error).toHaveBeenCalledTimes(2)
      // 窗内（59s）：同 key 仍被抑制
      vi.advanceTimersByTime(EXTENSION_COMMAND_ERROR_RATE_LIMIT_MS - 1_000)
      f.emit('s1', sameKey())
      expect(f.toast.error).toHaveBeenCalledTimes(2)
      // 出窗（再过 2s ≥ 60s）：同 key 再弹
      vi.advanceTimersByTime(2_000)
      f.emit('s1', sameKey())
      expect(f.toast.error).toHaveBeenCalledTimes(3)
      f.dispose()
    })
  })

  describe('pi1-disposition-chat-flow U2⑤：受理回执前不上屏（ADR-0122 ⑨ UI 跟随事实）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
      resetDeliveryProjectionForTest()
    })

    it('发送动作后、受理回执（RPC reply）前：消息列表无该条目气泡节点、无等待态占位；回执到达才上屏', async () => {
      const f = makeFixture()
      // 受理回执悬置（RPC 飞行中）：submitDelivery 返回未 resolve 的 promise
      let releaseReply: (reply: unknown) => void = () => {}
      f.chatApi.submitDelivery.mockImplementation(
        () => new Promise((resolve) => { releaseReply = resolve }),
      )
      const sendPromise = f.useChat.send('s1', textToSegments('/todos'))
      // 受理确认前（RPC 飞行窗口）：消息列表无该条目的气泡节点（用户可见 DOM 断言）+
      // pendingSend/inflight 零置位（无等待态、无记账）
      expect(f.chatStore.getMessages('s1')).toHaveLength(0)
      expect(f.chatStore.isPendingSend('s1')).toBe(false)
      expect(f.chatStore.getInflight('s1')).toBe(0)
      // 受理回执到达 → 气泡上屏 + 占位记账（等待态自此有事实依据）
      releaseReply({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' })
      await sendPromise
      const userMsg = f.chatStore.getMessages('s1').find((m) => m.role === 'user')
      expect(userMsg).toBeDefined()
      expect(f.chatStore.isPendingSend('s1')).toBe(true)
      expect(f.chatStore.getInflight('s1')).toBe(1)
      f.dispose()
    })

    it('命令条目（isCommand 受理回执）受理后才上屏，终局仍由 deliveryHandled 静默清除（started 基终局呈现）', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
      await f.useChat.send('s1', textToSegments('/todos'))
      const bubbleId = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!.id
      // 受理态呈现：命令条目气泡在流（pi 已受理输入的事实）+ pendingSend 挂起语义成立
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(true)
      expect(f.chatStore.isPendingSend('s1')).toBe(true)
      // 终局通知到达 → 静默收气泡（handled/queued/started 三值统一受理终局，回合输出照常流入）
      f.emit('s1', handledFrame('s1', bubbleId))
      expect(f.chatStore.getMessages('s1').some((m) => m.id === bubbleId)).toBe(false)
      expect(f.chatStore.isPendingSend('s1')).toBe(false)
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('RPC 失败：零乐观残留（无气泡、无占位、无记账），失败信号走既有 toast/false 契约', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockRejectedValue(new Error('transport down'))
      await expect(f.useChat.send('s1', textToSegments('hello'))).resolves.toBe(false)
      expect(f.chatStore.getMessages('s1')).toHaveLength(0)
      expect(f.chatStore.isPendingSend('s1')).toBe(false)
      expect(f.chatStore.getInflight('s1')).toBe(0)
      // transport 级失败 toast 兜底（错误可见性契约不变）
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('极端时序检查：送达回执先于受理回执（派生视图已 delivered）→ 气泡照常上屏、不挂无主 inflight 账', async () => {
      const f = makeFixture()
      // reply resolve 前派生视图已转 delivered（message_end(user) 标记回执先于 submit reply 到达——
      // reply 与事件帧异通道无顺序契约的极端窗）
      f.chatApi.submitDelivery.mockImplementation(async (sid: string, _content: string, clientUuid: string) => {
        replaceDeliveryProjection(sid, [{ clientUuid, preview: 'p', state: 'delivered', lane: 'direct' }])
        return { clientUuid, state: 'delivered', lane: 'direct' }
      })
      await f.useChat.send('s1', textToSegments('hello'))
      // 气泡上屏不丢（事实成立：消息已进 transcript）；inflight 零记账（回执已消费，记账永无抵消）
      expect(f.chatStore.getMessages('s1').some((m) => m.role === 'user')).toBe(true)
      expect(f.chatStore.getInflight('s1')).toBe(0)
      f.dispose()
    })
  })

  describe('pi1-disposition-chat-flow：断连未确认终局呈现（命令终局事件化 终局③）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
      resetDeliveryProjectionForTest()
    })

    it('在途命令条目遇 pi 断连：message.error「执行结果未确认」帧 → 用户可见 error 气泡（未确认文案）+ pendingSend 事件驱动收尾', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockResolvedValue({ ...COMMAND_REPLY })
      await f.useChat.send('s1', textToSegments('/todos'))
      expect(f.chatStore.getMessages('s1').some((m) => m.role === 'user')).toBe(true)
      expect(f.chatStore.isPendingSend('s1')).toBe(true)
      // pi 断连：runtime onPiDisconnected 在途条目批量 failed + message.error 逐条显式上报
      //（payload 形态 = session-delivery-registry onPiDisconnected 的用户可见文案）
      f.emit('s1', {
        type: 'message.error',
        payload: { sessionId: 's1', message: '执行结果未确认（pi 连接已断开），重发前请核对：/todos' },
      } as unknown as ServerMessage)
      // 用户可见终态呈现：error 气泡入流且「未确认」文案完整（不得静默悬挂）
      const errMsg = f.chatStore.getMessages('s1').find((m) => m.role === 'assistant' && m.status === 'error')
      expect(errMsg).toBeDefined()
      expect(errMsg!.error).toContain('执行结果未确认')
      expect(errMsg!.error).toContain('重发前请核对')
      // pendingSend 随终局收尾（finalizeSession 事件驱动，无墙钟兜底）
      expect(f.chatStore.isPendingSend('s1')).toBe(false)
      f.dispose()
    })
  })
});

// ======== 来源：useChat.test.ts ========
describe("useChat", () => {
  // getDeliveryProjection 快照读口已随过度设计审计候选 1 删除——测试断言经响应式读口组装同款快照。
  const getDeliveryProjection = (sid: string): readonly DeliveryFrameEntry[] =>
    getDeliveryProjectionRef().value.get(sid) ?? []

  interface Fixture { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    useChat: ReturnType<typeof createUseChat>
    chatApi: {
      submitDelivery: ReturnType<typeof vi.fn>
      send: ReturnType<typeof vi.fn>
      subagentAction: ReturnType<typeof vi.fn>
      abort: ReturnType<typeof vi.fn>
      compact: ReturnType<typeof vi.fn>
      bash: ReturnType<typeof vi.fn>
      abortBash: ReturnType<typeof vi.fn>
      getHistory: ReturnType<typeof vi.fn>
      streamSubscribe: ReturnType<typeof vi.fn>
      revokeMessage: ReturnType<typeof vi.fn>
      cancelDelivery: ReturnType<typeof vi.fn>
    }
    chatStore: ReturnType<typeof createChatStore>
    sessionStore: { applySnapshot: ReturnType<typeof vi.fn>; revive: ReturnType<typeof vi.fn> }
    liveState: ReturnType<typeof createSessionLiveState>
    toast: { error: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> }
    writeSegments: ReturnType<typeof vi.fn>
    restoreDraft: ReturnType<typeof vi.fn>
    /** 主动向 sid 的 streamSubscribe handler 注入一条 ServerMessage（模拟 WS 事件） */
    emit: (sid: string, m: ServerMessage) => void
    dispose: () => void
  }

  function makeFixture(): Fixture {
    const scope = effectScope(true)
    const streamHandlers = new Map<string, (m: ServerMessage) => void>()
    const chatStore = scope.run(() => createChatStore())!
    const chatApi = {
      // [投递所有权内核 u3b] 统一提交通道（默认 reply = direct/in-flight 受理确认）
      submitDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' }),
      // [u5a 注记] send 为 ChatApiPort 存量成员（协议 message.send 是设计显式保留项），core
      // 发送链已不再调用——mock 保留供「零调用」断言；steer/followUp 成员随 u5a 删除。
      send: vi.fn().mockResolvedValue(undefined),
      subagentAction: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn().mockResolvedValue(undefined),
      // bash 回执契约（dmg-r1-2）：默认 = 已执行并收尾（BashDispatchReceipt settled）
      bash: vi.fn().mockResolvedValue({ status: 'settled' }),
      abortBash: vi.fn().mockResolvedValue(undefined),
      getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
      streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
        streamHandlers.set(sid, h)
        return () => {
          streamHandlers.delete(sid)
        }
      }),
      // [U5 消息撤回] 两条撤回 RPC 路径（默认成功臂；错误臂用例 mockResolvedValueOnce 覆写）
      revokeMessage: vi.fn().mockResolvedValue({ sessionId: 's1', revoked: true, content: '' }),
      cancelDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', cancelled: false }),
    }
    const sessionStore = { applySnapshot: vi.fn(), revive: vi.fn() }
    // [W1] 状态层：session.* 状态帧的落点（真实 core factory，非 mock）
    const liveState = createSessionLiveState()
    const toast = { error: vi.fn(), warning: vi.fn() }
    const restoreDraft = vi.fn()
    const deps: UseChatDeps = {
      chatApi,
      writeSegments: vi.fn().mockResolvedValue(undefined),
      getChatStore: () => chatStore,
      getSessionStore: () => sessionStore,
      getLiveStateStore: () => liveState,
      toast,
      restoreDraft,
      t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
    }
    const useChat = createUseChat(deps)
    return {
      useChat,
      chatApi,
      chatStore,
      sessionStore,
      liveState,
      toast,
      restoreDraft,
      writeSegments: deps.writeSegments as unknown as ReturnType<typeof vi.fn>,
      emit: (sid, m) => {
        streamHandlers.get(sid)?.(m)
      },
      dispose: () => scope.stop(),
    }
  }

  describe('createUseChat factory 行为', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
    })

    // [u5a 退役] 前身「clearQueueState 转发 core store」用例已删：转发逻辑随 store 侧（queueStates
    // 分区 + clearQueueState 方法）一并删除，无转发可测——pi 槽位回收由 delivery.drain 承担。

    it('send 流程：统一 submit——appendUser 乐观气泡 + submitDelivery（content + clientUuid = 气泡 id）', async () => {
      const f = makeFixture()
      // [R2-A5 失败信号] 成功路径返回 true（Promise<boolean> 契约）
      await expect(f.useChat.send('s1', textToSegments('hello'))).resolves.toBe(true)
      expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1)
      const [calledSid, calledContent, calledUuid] = f.chatApi.submitDelivery.mock.calls[0] as unknown as [
        string, string, string,
      ]
      expect(calledSid).toBe('s1')
      expect(calledContent).toBe('hello')
      // clientUuid = appendUser 生成的乐观气泡 id（u-<uuid>）——内核条目 id / 帧回执 / morph 身份锚
      const userMsg = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!
      expect(calledUuid).toBe(userMsg.id)
      // v4 形态断言（8-4-4-4-12 分组 + 版本位 4 + 变体位 8/9/a/b），锚定 fallback 拼装不错位
      expect(calledUuid).toMatch(/^u-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      f.dispose()
    })

    it('send 在非 secure context（crypto.randomUUID undefined）下照常提交（移动壳 LAN http 场景）', async () => {
      // 场景：移动壳经 LAN http（http://<lan-ip>:<port>）访问，isSecureContext=false →
      // crypto.randomUUID 为 undefined（Web API 仅 secure context 暴露）。submitNewMessage
      // 直调它会在 clientUuid 生成处同步抛 TypeError → send 恒 false（移动端「未送达，请
      // 检查网络后重试」）。契约：clientUuid 必须经 randomUuid secure-context 安全包装
      // （fallback = crypto.getRandomValues 手拼 v4，无 secure context 限制）。
      vi.stubGlobal('crypto', {
        getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
      })
      try {
        const f = makeFixture()
        await expect(f.useChat.send('s1', textToSegments('hello'))).resolves.toBe(true)
        expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1)
        const calledUuid = (f.chatApi.submitDelivery.mock.calls[0] as unknown as [string, string, string])[2]
        // 同上：v4 形态断言（getRandomValues 手拼 fallback 必须产出合法 v4）
        expect(calledUuid).toMatch(/^u-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        f.dispose()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('busy 期发送不改投递路径（B 策略退役）：统一 submit 照常提交，由内核判定 lane', async () => {
      const f = makeFixture()
      await f.useChat.send('s2', textToSegments('hi'))
      f.emit('s2', msg('s2', 'message.message_start', { messageId: 'a1' }))
      expect(f.chatStore.isActive('s2')).toBe(true)
      await f.useChat.send('s2', textToSegments('more'))
      // 两次都走统一 submit；chatApi.send 零调用（投递路径判定在 runtime 内核）。
      // [u5a] 前身同时断言 chatApi.steer 零调用——该成员已随 u5a 删除，断言随之移除。
      expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(2)
      expect(f.chatApi.send).not.toHaveBeenCalled()
      f.dispose()
    })

    it('ensureStreamSubscription 幂等：同 session 二次 send streamSubscribe 只订阅一次', async () => {
      const f = makeFixture()
      await f.useChat.send('s3', textToSegments('one'))
      // 完成首轮（清 streaming/dispatching）
      f.emit('s3', msg('s3', 'message.message_start', { messageId: 'a1' }))
      f.emit('s3', msg('s3', 'message.complete', { stopReason: 'end_turn' }))
      await f.useChat.send('s3', textToSegments('two'))
      expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
      expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(2)
      f.dispose()
    })

    it('RET: send.rejected 帧零消费（内核排队取代拒绝——无回滚无 toast 无入队）', async () => {
      const f = makeFixture()
      await f.useChat.send('s4', textToSegments('hi'))
      const msgsBefore = f.chatStore.getMessages('s4').length
      f.emit('s4', msg('s4', 'send.rejected', { reason: 'busy', message: '被拒' }))
      // 前身 handler：回滚气泡/入队/toast——整体退役，帧静默终止
      expect(f.chatStore.getMessages('s4').length).toBe(msgsBefore)
      expect(f.toast.error).not.toHaveBeenCalled()
      expect(f.toast.warning).not.toHaveBeenCalled()
      f.dispose()
    })

    it('message.* 单一入口：message_start → isGenerating=true', async () => {
      const f = makeFixture()
      await f.useChat.send('s5', textToSegments('hi'))
      expect(f.chatStore.isGenerating('s5')).toBe(false)
      f.emit('s5', msg('s5', 'message.message_start', { messageId: 'm1' }))
      expect(f.chatStore.isGenerating('s5')).toBe(true)
      f.dispose()
    })

    it('session.renamed → sessionStore.applySnapshot(label)', async () => {
      const f = makeFixture()
      await f.useChat.send('s6', textToSegments('hi'))
      f.emit('s6', msg('s6', 'session.renamed', { name: '新名' }))
      expect(f.sessionStore.applySnapshot).toHaveBeenCalledWith('s6', { label: '新名' })
      f.dispose()
    })

    it('session.renamed 空 name 跳过（guard）', async () => {
      const f = makeFixture()
      await f.useChat.send('s6b', textToSegments('hi'))
      f.emit('s6b', msg('s6b', 'session.renamed', { name: '' }))
      expect(f.sessionStore.applySnapshot).not.toHaveBeenCalled()
      f.dispose()
    })

    it('session.state_changed → 状态层 applyLiveState(modelId/thinkingLevel)（W1：不经导航列表）', async () => {
      const f = makeFixture()
      await f.useChat.send('s7', textToSegments('hi'))
      f.emit('s7', msg('s7', 'session.state_changed', { modelId: 'gpt-4', thinkingLevel: 'high' }))
      expect(f.liveState.liveStateOf('s7')).toEqual({ modelId: 'gpt-4', thinkingLevel: 'high' })
      // 导航列表不承载状态字段写入
      expect(f.sessionStore.applySnapshot).not.toHaveBeenCalled()
      f.dispose()
    })

    it('followUp（统一 submit 化，原 steer 用例等价转写）：RPC 失败 → toast + return false（乐观副作用回滚）', async () => {
      const f = makeFixture()
      await f.useChat.send('s8', textToSegments('hi'))
      f.emit('s8', msg('s8', 'message.message_start', { messageId: 'a1' }))
      f.chatApi.submitDelivery.mockRejectedValueOnce(new Error('WS断'))
      await expect(f.useChat.followUp('s8', textToSegments('补充'))).resolves.toBe(false)
      // 失败回滚：乐观气泡移除 + inflight 不悬空
      expect(f.chatStore.getMessages('s8').filter((m) => m.role === 'user' && m.status !== 'error')).toHaveLength(1)
      expect(f.chatStore.getInflight('s8')).toBe(1) // 首发的 1；followUp 失败回滚后不叠加
      await nextTick()
      expect(f.toast.error).toHaveBeenCalled()
      f.dispose()
    })

    // [审计候选 8] 原「steer 返回值契约」用例随 useChat.steer 退役删除——steer 生产通路
    // 已并入 delivery.submit 统一提交，返回值契约由 followUp 用例承接。

    it('[R2-A5] followUp 返回值契约：失败 false，成功 true', async () => {
      const f = makeFixture()
      await f.useChat.send('s8d2', textToSegments('hi'))
      f.emit('s8d2', msg('s8d2', 'message.message_start', { messageId: 'a1' }))
      // 失败：RPC reject → false
      f.chatApi.submitDelivery.mockRejectedValueOnce(new Error('WS断'))
      await expect(f.useChat.followUp('s8d2', textToSegments('补充'))).resolves.toBe(false)
      // 成功：RPC resolve → true
      await expect(f.useChat.followUp('s8d2', textToSegments('再补'))).resolves.toBe(true)
      f.dispose()
    })

    it('首尾空白保真：原文（含空白）直达 submitDelivery（Gate B 观测①回归，统一 submit 通路）', async () => {
      const f = makeFixture()
      await f.useChat.send('s8w', textToSegments('hi'))
      f.emit('s8w', msg('s8w', 'message.message_start', { messageId: 'a1' }))
      f.emit('s8w', msg('s8w', 'message.complete', { stopReason: 'end_turn' }))
      await f.useChat.send('s8w', textToSegments('  注意  '))
      const calledContent = f.chatApi.submitDelivery.mock.calls[1]![1] as string
      expect(calledContent).toBe('  注意  ')
      f.dispose()
    })

    it('纯空白文本不发送：空挡拦截（保真修复后空白拦截归调用方）', async () => {
      const f = makeFixture()
      await f.useChat.send('s8b', textToSegments('hi'))
      f.emit('s8b', msg('s8b', 'message.message_start', { messageId: 'a1' }))
      f.emit('s8b', msg('s8b', 'message.complete', { stopReason: 'end_turn' }))
      await f.useChat.send('s8b', textToSegments('   '))
      expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1) // 仅首发那次
      f.dispose()
    })

    it('abort API 失败：不 throw 不 toast（chat-flow R4 删停止失败 toast，乐观 clearPendingSend）', async () => {
      const f = makeFixture()
      f.chatApi.abort.mockRejectedValueOnce(new Error('pi死'))
      await expect(f.useChat.abort('s9')).resolves.toBeUndefined()
      await nextTick()
      // 停止失败 toast 已删（chat-flow R4）：WS 断由断连全局提示覆盖、pi 层失败由 runtime
      // message.error 气泡承担，RPC reject 落 console.warn 不打扰。
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('hydrate（reconcile 生产通路验收路径）：注入历史 + truncated 窗口标志', () => {
      const f = makeFixture()
      // use-session 点击切入把 getHistory reply 经 historyWindowFromReply 归一后写 store
      // （use-session.ts reconcileHistory 通路）；store.hydrate 消费同形态窗口契约
      f.chatStore.hydrate('s10', [], historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 20 }))
      expect(f.useChat.hasMoreHistory('s10')).toBe(true)
      f.dispose()
    })

    it('[u6] loadMoreHistory：游标翻页（cursor = 分区最旧消息身份）页响应收敛 truncated=false', async () => {
      const f = makeFixture()
      f.chatStore.hydrate(
        's11',
        [{ id: 'm1', role: 'user', content: 'q', status: 'complete', timestamp: 1 }],
        historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 20 }),
      )
      expect(f.useChat.hasMoreHistory('s11')).toBe(true)
      // 游标翻页走 getHistory（带 cursor = 分区最旧消息 m1 的 id）；空页（翻页到头）收敛
      f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      await f.useChat.loadMoreHistory('s11')
      expect(f.chatApi.getHistory).toHaveBeenLastCalledWith('s11', { cursor: 'm1' })
      expect(f.useChat.hasMoreHistory('s11')).toBe(false)
      f.dispose()
    })

    it('[u6] loadMoreHistory：页响应仍 truncated=true → 顶部条入口保持', async () => {
      const f = makeFixture()
      f.chatStore.hydrate('s11b', [], historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 }))
      // 窗口契约字段写入 store 窗口状态（u4b 透传）
      expect(f.chatStore.getHistoryWindow('s11b')).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
      // [u6] 游标翻页页响应仍截断（锚前有更早历史）
      f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: true, loadedTurns: 20, totalTurnsEstimate: 40 })
      await f.useChat.loadMoreHistory('s11b')
      expect(f.useChat.hasMoreHistory('s11b')).toBe(true)
      f.dispose()
    })

    it('disposeSession：取消订阅 + 清内核派生视图，再 send 重新订阅', async () => {
      const f = makeFixture()
      await f.useChat.send('s12', textToSegments('hi'))
      expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
      // 预置派生视图 → dispose 清分区（clearDeliveryProjection 编排）
      replaceDeliveryProjection('s12', [{ clientUuid: 'u-1', preview: 'p', state: 'queued', lane: 'queued' }])
      f.useChat.disposeSession('s12')
      expect(getDeliveryProjection('s12')).toHaveLength(0)
      await f.useChat.send('s12', textToSegments('again'))
      expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(2)
      f.dispose()
    })

    it('compact：ensureStreamSubscription + chatApi.compact 调用', async () => {
      const f = makeFixture()
      await f.useChat.compact('s13')
      expect(f.chatApi.compact).toHaveBeenCalledTimes(1)
      expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('compact transport 级失败（envelope 无分类码，如 pending 超时）：toast 兜底', async () => {
      const f = makeFixture()
      // transport 级失败：RPC 未达 runtime（pending sweep 超时 / WS 断连 rejectAll）→
      // 无 runtime 分类码 → runtime 侧呈现未发生 → toast 兜底（AGENTS.md 规则 #3）
      f.chatApi.compact.mockRejectedValueOnce(Object.assign(new Error('request timeout after 66000ms'), { code: 'timeout' }))
      await f.useChat.compact('s15')
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      expect(f.toast.error).toHaveBeenCalledWith(
        expect.stringContaining('composable.compactFailed')
      )
      f.dispose()
    })

    it('compact busy 预检拒绝（envelope 分类码 compact_busy）：抑制 toast，对话流呈现由 runtime stream_warn 编排', async () => {
      const f = makeFixture()
      // runtime dispatcher.compact busy 预检 throw 带 code（D4-2）→ handler envelope 透传 →
      // catch 见分类码 → 抑制 toast（对话流 system 提示由 stream_warn 广播承担，非本 catch 职责）
      f.chatApi.compact.mockRejectedValueOnce(Object.assign(new Error('Cannot compact while agent generating'), { code: 'compact_busy' }))
      await f.useChat.compact('s15b')
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('compact pi 层失败（envelope 分类码 compact_failed）：抑制 toast，interpreter 对话流呈现', async () => {
      const f = makeFixture()
      // compact RPC reject 携带分类码 compact_failed：pi 层失败必发 compaction_end{errorMessage}
      // → interpreter 已编排对话流呈现；ensureActive 失败由 session 状态侧呈现。catch 不 toast。
      f.chatApi.compact.mockRejectedValueOnce(Object.assign(new Error('上下文压缩失败'), { code: 'compact_failed' }))
      await f.useChat.compact('s16')
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('compact 未知分类码（runtime 未来新增码）：保守回退 toast 兜底（契约边界）', async () => {
      const f = makeFixture()
      // 未知分类码：renderer 未升级的协议演进形态——错误可见性优先，保守 toast
      f.chatApi.compact.mockRejectedValueOnce(Object.assign(new Error('compact cancelled someday'), { code: 'compact_cancelled_future' }))
      await f.useChat.compact('s16b')
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      expect(f.toast.error).toHaveBeenCalledWith(
        expect.stringContaining('composable.compactFailed')
      )
      f.dispose()
    })

    it('compact 非法形态 reject（code 非字符串 / 无 code 裸 Error）：保守回退 toast 兜底（契约边界）', async () => {
      const f = makeFixture()
      // 非法形态：envelope code 非字符串（协议漂移）与无 code 裸 Error（WS 断连 rejectAll /
      // 本地异常）均无 runtime 分类呈现 → toast 兜底
      f.chatApi.compact.mockRejectedValueOnce(Object.assign(new Error('weird envelope'), { code: 42 }))
      await f.useChat.compact('s16c')
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      f.chatApi.compact.mockRejectedValueOnce(new Error('ws closed'))
      await f.useChat.compact('s16c')
      expect(f.toast.error).toHaveBeenCalledTimes(2)
      f.dispose()
    })

    it('abortBash API 失败：markStreamingBashError 兼底不 toast（chat-flow R4 呈现收敛聊天流内联）', async () => {
      const f = makeFixture()
      f.chatApi.abortBash.mockRejectedValueOnce(new Error('pi死'))
      // abortBash 失败 → markStreamingBashError（无 streaming bash 时 no-op；错误文本写入 bash
      // 消息 error 字段内联呈现）+ 停止失败 toast 已删（chat-flow R4）
      await expect(f.useChat.abortBash('s14')).resolves.toBeUndefined()
      await nextTick()
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })
  })

  // ── `@` 定向发送分流（U2b，composer-symbol-system §3.3.4/§3.3.7）──────────────────────

  describe('send 定向分流（含 subagent 段）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
    })

    it('subagentId 非空 → subagentAction(message) 被调且 text 序列化含 file/session 段；统一 submit 不被调', async () => {
      const f = makeFixture()
      await f.useChat.send('d1', [
        { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
        { type: 'session', sessionId: 'sess-9', label: '设计讨论' },
        { type: 'file', path: '/a.ts', lineRange: [1, 5] },
        { type: 'text', text: '展开讲讲' },
      ])
      expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
      expect(f.chatApi.subagentAction).toHaveBeenCalledWith('d1', 'message', {
        subagentId: 'rec-1',
        // 定向文本 = 其余段序列化：session → #sessionId、file → path:L 范围、subagent 段空串不进。
        text: ' #sess-9 /a.ts:L1-L5 展开讲讲',
      })
      // 不走主 agent 通道（§3.3.8 命题 1：无主 agent turn）
      expect(f.chatApi.submitDelivery).not.toHaveBeenCalled()
      f.dispose()
    })

    it('subagentId 非空：不 appendUser（无 user 气泡，live ≡ reload——pi 只落 custom entry）', async () => {
      const f = makeFixture()
      await f.useChat.send('d1b', [
        { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
        { type: 'text', text: '汇报进度' },
      ])
      const messages = f.chatStore.getMessages('d1b')
      expect(messages.some((m) => m.role === 'user')).toBe(false)
      // 定向气泡由 subagent.directive 广播驱动（见下一 describe），send 路径自身不插
      expect(messages.length).toBe(0)
      f.dispose()
    })

    it('subagentId 空串（新建占位 chip）→ subagentAction(start)，slug 自动生成 chat- 前缀，占位 slug 被覆盖', async () => {
      const f = makeFixture()
      await f.useChat.send('d2', [
        { type: 'subagent', subagentId: '', slug: '新任务' },
        { type: 'text', text: '帮我修 bug' },
      ])
      expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
      const [sid, action, params] = f.chatApi.subagentAction.mock.calls[0] as unknown as [
        string, string, { slug?: string; task?: string },
      ]
      expect(sid).toBe('d2')
      expect(action).toBe('start')
      expect(params.slug).toMatch(/^chat-/) // 自动 slug 生成规则
      expect(params.slug).not.toBe('新任务') // 占位 slug 不可作 id，被覆盖
      expect(params.task).toBe(' 帮我修 bug')
      expect(f.chatApi.submitDelivery).not.toHaveBeenCalled()
      f.dispose()
    })

    it('纯 chip 无文本 → 空文本挡：不调 subagentAction，toast 可读错误（不静默）', async () => {
      const f = makeFixture()
      await f.useChat.send('d3', [{ type: 'subagent', subagentId: 'rec-1', slug: 'build-api' }])
      expect(f.chatApi.subagentAction).not.toHaveBeenCalled()
      expect(f.chatApi.submitDelivery).not.toHaveBeenCalled()
      expect(f.toast.error).toHaveBeenCalledWith('composable.subagentDirectiveEmpty')
      f.dispose()
    })

    it('RPC 失败 → toast 错误可见（不 throw、不静默丢失）', async () => {
      const f = makeFixture()
      f.chatApi.subagentAction.mockRejectedValueOnce(new Error('subagent 已结束'))
      await expect(
        f.useChat.send('d4', [
          { type: 'subagent', subagentId: 'rec-x', slug: 'closed-one' },
          { type: 'text', text: '继续' },
        ]),
        // [R2-A5 失败信号] send 契约 Promise<boolean>：定向分流 RPC 失败内部消化 toast，
        // false = 输入未消费（调用方 restoreSegments 恢复草稿）
      ).resolves.toBe(false)
      expect(f.toast.error).toHaveBeenCalledWith(
        'composable.subagentDirectiveFailed:{"msg":"subagent 已结束"}',
      )
      f.dispose()
    })

    it('定向发送仍 ensureStreamSubscription（消费 subagent.directive 广播的前提）', async () => {
      const f = makeFixture()
      await f.useChat.send('d5', [
        { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
        { type: 'text', text: 'hi' },
      ])
      expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('主 agent busy 时定向消息不转统一 submit（与主 agent turn 正交）', async () => {
      const f = makeFixture()
      await f.useChat.send('d6', textToSegments('首发'))
      f.emit('d6', msg('d6', 'message.message_start', { messageId: 'a1' }))
      expect(f.chatStore.isActive('d6')).toBe(true)
      await f.useChat.send('d6', [
        { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
        { type: 'text', text: 'busy 时追问' },
      ])
      expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1) // 仅首发
      expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('session 段（无 subagent 段）走统一 submit，#sessionId 序列化进 prompt + u- 标记（U1 验证）', async () => {
      const f = makeFixture()
      await f.useChat.send('d7', [
        { type: 'session', sessionId: 'sess-1', label: '旧会话' },
        { type: 'text', text: '看看这个' },
      ])
      expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1)
      const [calledSid, calledContent, calledUuid] = f.chatApi.submitDelivery.mock.calls[0] as unknown as [
        string, string, string,
      ]
      expect(calledSid).toBe('d7')
      // 非纯文本消息（session 段）：u- 标记拼进 prompt（msg-id-mapper 映射通路不变，D8 双标记共存）
      expect(calledContent.startsWith('#sess-1 看看这个')).toBe(true)
      expect(calledContent).toMatch(/<!--taiji:msg:u-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-->$/i)
      expect(calledUuid).toMatch(/^u-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(f.chatApi.subagentAction).not.toHaveBeenCalled()
      f.dispose()
    })
  })

  // ── [投递所有权内核 u3b] inflight 占位闭环 + 乐观气泡/回执 ─────────────────────────

  describe('统一 submit 的 inflight 占位闭环（u3b：占位保留服务 direct 抵消）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
      resetDeliveryProjectionForTest()
    })

    it('send 乐观插入 → inflight +1；确认帧到达 → 抵消归零（direct 投递路径抵消机制保留，D7）', async () => {
      const f = makeFixture()
      await f.useChat.send('s30', textToSegments('hi'))
      expect(f.chatStore.getInflight('s30')).toBe(1)

      f.emit('s30', userEndFrame('s30', 'hi'))
      expect(f.chatStore.getInflight('s30')).toBe(0)
      f.dispose()
    })

    it('submitDelivery RPC 失败 → catch 回滚 −1 + 乐观气泡回滚（pi 侧无消息、回执永不到来）', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockRejectedValueOnce(new Error('WS断'))

      // [R2-A5 失败信号] 失败路径返回 false（内部已 toast + 回滚，调用方恢复草稿）
      await expect(f.useChat.send('s31', textToSegments('hi'))).resolves.toBe(false)

      expect(f.chatStore.getInflight('s31')).toBe(0)
      expect(f.chatStore.getMessages('s31')).toHaveLength(0)
      expect(f.toast.error).toHaveBeenCalled()
      f.dispose()
    })

    it('editAndResend 同样挂钩（统一 submit 化：其 message_end 走 ① 标记匹配回收）', async () => {
      const f = makeFixture()
      await f.useChat.send('s33', textToSegments('old'))
      const userMsgId = f.chatStore.getMessages('s33').find((m) => m.role === 'user')!.id
      f.emit('s33', msg('s33', 'message.message_start', { messageId: 'a1' }))
      f.emit('s33', msg('s33', 'message.complete', { stopReason: 'end_turn' }))

      // [R2-A5 失败信号] 成功路径返回 true（Promise<boolean> 契约，与 send 同）
      await expect(f.useChat.editAndResend('s33', userMsgId, textToSegments('edited'))).resolves.toBe(true)

      // 统一 submit 化后编辑重发与 send 同编排：乐观气泡 + inflight 占位（原「不挂钩」契约退役）。
      // 首发的 1（未确认——本用例未发 message_end(user)）+ 编辑重发的 1 = 2。
      expect(f.chatStore.getInflight('s33')).toBe(2)
      expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(2)
      f.dispose()
    })
  })

  // ── [投递所有权内核 u3b / D7] session.delivery 帧消费 + 乐观气泡 morph + 送达回执入流 ──

  describe('session.delivery 帧消费与气泡 morph（u3b / D7）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
      resetDeliveryProjectionForTest()
    })

    /** session.delivery 帧工厂 */
    function deliveryFrame(sid: string, entries: Array<{ clientUuid: string; state: string; lane: string }>): ServerMessage {
      return {
        type: 'session.delivery',
        payload: {
          sessionId: sid,
          entries: entries.map((e) => ({ clientUuid: e.clientUuid, preview: 'p', state: e.state, lane: e.lane })),
        },
      } as unknown as ServerMessage
    }

    it('morph：steer 投递路径帧到达 → 乐观气泡移出对话流 + 派生视图落位（队列区数据）+ dispatching 占位回收', async () => {
      const f = makeFixture()
      await f.useChat.send('m1', textToSegments('补充要求'))
      const bubbleId = f.chatStore.getMessages('m1').find((m) => m.role === 'user')!.id
      expect(f.chatStore.getMessages('m1').some((m) => m.id === bubbleId)).toBe(true)

      f.emit('m1', deliveryFrame('m1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'steer' }]))

      // 气泡 morph：移出对话流（气泡 → 队列条目）
      expect(f.chatStore.getMessages('m1').some((m) => m.id === bubbleId)).toBe(false)
      // 派生视图落位（单一数据源，u3c QueueBubble 消费）
      expect(getDeliveryProjection('m1')).toHaveLength(1)
      expect(getDeliveryProjection('m1')[0]).toMatchObject({ clientUuid: bubbleId, state: 'in-flight', lane: 'steer' })
      // 非直发投递路径：dispatching 空窗占位回收（无「本条即将触发 message_start」语义）
      expect(f.chatStore.isPendingSend('m1')).toBe(false)
      f.dispose()
    })

    it('direct 投递路径帧：气泡保持待确认（不 morph 不移除），派生视图照常落位', async () => {
      const f = makeFixture()
      await f.useChat.send('m2', textToSegments('直达消息'))
      const bubbleId = f.chatStore.getMessages('m2').find((m) => m.role === 'user')!.id

      f.emit('m2', deliveryFrame('m2', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))

      // direct → 待确认气泡保持（既有 inflightCounts 抵消机制服务 direct）
      expect(f.chatStore.getMessages('m2').some((m) => m.id === bubbleId)).toBe(true)
      expect(getDeliveryProjection('m2')).toHaveLength(1)
      f.dispose()
    })

    it('delivered 帧条目无 morph 面（transcript 权威由 reducer 承担）', async () => {
      const f = makeFixture()
      await f.useChat.send('m3', textToSegments('已送达消息'))
      const bubbleId = f.chatStore.getMessages('m3').find((m) => m.role === 'user')!.id

      f.emit('m3', deliveryFrame('m3', [{ clientUuid: bubbleId, state: 'delivered', lane: 'steer' }]))

      // delivered 条目：无 morph 动作（气泡既已不在也不重建；帧只更新派生视图）
      expect(getDeliveryProjection('m3')[0]?.state).toBe('delivered')
      f.dispose()
    })

    // [u3b 迁移] 本用例承接 store.test.ts 前身「steer 投递后 user 气泡进消息流且 segments 完整
    //（用户可见行为）」——原用例的 queue_update drain 驱动链已退役（D7），用户可见判据原样保留：
    // 富内容段（skill badge）不丢、引用恒等（morph 暂存搬运非重建）、序列化文本保真。
    it('送达回执 → 按序入流：morph 段经 message_end(user) ① 标记匹配回填为正常气泡（用户可见）', async () => {
      const f = makeFixture()
      const segs: Segment[] = [{ type: 'skill', name: 'deploy' }, { type: 'text', text: ' --prod' }]
      await f.useChat.send('m4', segs)
      const bubble = f.chatStore.getMessages('m4').find((m) => m.role === 'user')!
      const bubbleId = bubble.id

      // 1) steer 投递路径帧 → morph（气泡移除 + 原段暂存）
      f.emit('m4', deliveryFrame('m4', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'steer' }]))
      expect(f.chatStore.getMessages('m4').some((m) => m.id === bubbleId)).toBe(false)

      // 2) 内核投递完成：message_end(user) 携带裸标记（bare = clientUuid 去 u- 前缀）
      const bare = bubbleId.slice(2)
      f.emit('m4', userEndFrame('m4', 'deploy --prod', bare))

      // morph 段按原 segments 回填为正常 user 气泡（按序入流，用户可见 DOM 断言）
      const users = f.chatStore.getMessages('m4').filter((m) => m.role === 'user')
      expect(users).toHaveLength(1)
      const delivered = users[0]!
      // [消息撤回 U8] id 稳定端到端：morph → 回执重建 → 气泡 id 不变（=== 提交时
      // clientUuid）——live 窗口（未刷新）撤回入口按 clientUuid 定位的结构前提
      expect(delivered.id).toBe(bubbleId)
      expect(delivered.status).toBe('complete')
      // 段保真：skill badge 段引用恒等（morph 暂存搬运非重建）+ 序列化文本与提交原样一致
      expect(toRaw(delivered.content)).toBe(segs)
      expect(segmentsToText(delivered.content as Segment[])).toBe('<taiji-skill name="deploy"/> --prod')
      // 派生视图转 delivered（队列条目随即隐去）+ inflight 占位回收
      expect(getDeliveryProjection('m4')[0]?.state).toBe('delivered')
      expect(f.chatStore.getInflight('m4')).toBe(0)
      f.dispose()
    })

    it('multi-burst：两条连发均 queued → 倒序 morph 互不误删（truncateFrom 尾部先行）', async () => {
      const f = makeFixture()
      await f.useChat.send('m5', textToSegments('第一条'))
      await f.useChat.send('m5', textToSegments('第二条'))
      const ids = f.chatStore.getMessages('m5').filter((m) => m.role === 'user').map((m) => m.id)
      expect(ids).toHaveLength(2)

      f.emit('m5', deliveryFrame('m5', [
        { clientUuid: ids[0]!, state: 'queued', lane: 'queued' },
        { clientUuid: ids[1]!, state: 'queued', lane: 'queued' },
      ]))

      // 两条气泡全部 morph 移除（倒序截断不误删后条）
      expect(f.chatStore.getMessages('m5').filter((m) => m.role === 'user')).toHaveLength(0)
      expect(getDeliveryProjection('m5')).toHaveLength(2)
      // 投递序回执：第一条先回（气泡回填），第二条后回——回填顺序与发送序一致
      // [消息撤回 U8] 回执入流保留原 id：重建气泡沿用提交时 clientUuid，可直接断言 id
      f.emit('m5', userEndFrame('m5', '第一条', ids[0]!.slice(2)))
      f.emit('m5', userEndFrame('m5', '第二条', ids[1]!.slice(2)))
      const users = f.chatStore.getMessages('m5').filter((m) => m.role === 'user')
      expect(users).toHaveLength(2)
      expect(users[0]!.id).toBe(ids[0]!)
      expect(users[1]!.id).toBe(ids[1]!)
      const textOf = (m: (typeof users)[number]) =>
        (Array.isArray(m.content) ? (m.content as unknown as Array<{ type: string; text?: string }>) : [])
          .filter((s) => s.type === 'text')
          .map((s) => s.text ?? '')
          .join('')
      expect(textOf(users[0]!)).toBe('第一条')
      expect(textOf(users[1]!)).toBe('第二条')
      f.dispose()
    })

    it('occupancy idle 帧只写派生视图（flush 触发源退役——重投由内核驱动）', async () => {
      const f = makeFixture()
      await f.useChat.send('m6', textToSegments('hi'))
      f.emit('m6', msg('m6', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
      // 前身：全 idle + 队列非空 → flush 投递；退役后 occupancy 只维护派生视图，无任何投递编排
      expect(f.toast.error).not.toHaveBeenCalled()
      expect(f.toast.warning).not.toHaveBeenCalled()
      f.dispose()
    })

    it('occupancy 帧第四维 handingOff 透传派生视图（[chat-flow-consistency §6 裁决表「状态机｜交接在途状态归属」行] Set 退役后 membership 唯一通路）', async () => {
      const f = makeFixture()
      await f.useChat.send('m7', textToSegments('hi'))
      f.emit('m7', msg('m7', 'session.occupancy', { turn: 'generating', compacting: false, bash: false, handingOff: true }))
      // sessionPhase 派生视图带 handingOff（useQueueRows hint 交接分档 / isHandingOff 读口的唯一数据源）
      expect(f.chatStore.sessionPhase('m7').handingOff).toBe(true)
      expect(f.chatStore.isHandingOff('m7')).toBe(true)
      // 复位帧（'handingOff-end' 整帧替换）→ false
      f.emit('m7', msg('m7', 'session.occupancy', { turn: 'idle', compacting: false, bash: false, handingOff: false }))
      expect(f.chatStore.sessionPhase('m7').handingOff).toBe(false)
      f.dispose()
    })
  })

  // ── subagent.directive live 广播消费（U2b，§3.3.3a live 链路）──────────────────────

  describe('subagent.directive 广播消费', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
    })

    /** 构造 subagent.directive ServerMessage（payload 对齐 ServerMessageMap 契约） */
    function directiveMsg(sid: string, subagentId: string, slug: string, text: string): ServerMessage {
      return {
        type: 'subagent.directive',
        payload: { sessionId: sid, subagentId, slug, direction: 'user', text },
      } as ServerMessage
    }

    it('payload.sessionId 匹配订阅 sid → 聊天流插入定向消息（reload 形态逐字段一致）', async () => {
      const f = makeFixture()
      await f.useChat.send('e1', [
        { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
        { type: 'text', text: '汇报进度' },
      ])
      f.emit('e1', directiveMsg('e1', 'rec-1', 'build-api', '汇报进度'))
      const inserted = f.chatStore.getMessages('e1').at(-1)
      // U2c 契约：role system + customType + content + details + display:true（live ≡ reload）
      expect(inserted).toMatchObject({
        role: 'system',
        customType: 'subagent-directive',
        content: '汇报进度',
        details: { subagentId: 'rec-1', slug: 'build-api', direction: 'user' },
        display: true,
        status: 'complete',
      })
      expect(inserted?.id).toMatch(/^cm-/) // customStart 先例：客户端生成 id
      f.dispose()
    })

    it('payload.sessionId 不匹配订阅 sid → 丢弃（ADR-0049 per-session 隔离，架构约定 7）', async () => {
      const f = makeFixture()
      await f.useChat.send('e2', [
        { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
        { type: 'text', text: 'hi' },
      ])
      const before = f.chatStore.getMessages('e2').length
      // 伪造异 session 广播到达 e2 的 handler（防御层校验 payload.sessionId === 订阅 sid）
      f.emit('e2', directiveMsg('other-session', 'rec-1', 'build-api', '串台消息'))
      expect(f.chatStore.getMessages('e2').length).toBe(before)
      expect(f.chatStore.getMessages('e2').some((m) => m.content === '串台消息')).toBe(false)
      f.dispose()
    })

    it('未订阅的 session 收不到广播（per-sid 通道路由，无 handler 可触发）', async () => {
      const f = makeFixture()
      // e3 从未 send（未 ensureStreamSubscription）→ streamHandlers 无条目，emit 天然 no-op
      f.emit('e3', directiveMsg('e3', 'rec-1', 'build-api', '未订阅'))
      expect(f.chatStore.getMessages('e3')).toHaveLength(0)
      f.dispose()
    })
  })

  // ── sendBash toast 抑制（msg-pipeline-debloat D4-2 分类码路由）────────────────
  //
  // 极性（[消息投递可靠性 A-bash] 契约修订后）：投递判定（true/false）只看 RPC 回执
  // （BashDispatchReceipt status），bashResult 帧观测计数只作 toast 抑制提示——
  // ① 本次窗口终态帧已渲染 → 抑制失败 toast（气泡终态是权威呈现侧）；
  // ② 终态未渲染 → toast 是唯一提示，不抑制；
  // ③ 回执不可达（reject 无回执：断连 rejectAll / backstop 超时）→ 保守返回 true
  //    （命令可能已执行，恢复 !command 会双执行）+「状态未知」诚实 toast（不得说「失败」，
  //    那会诱导用户重发）；可证明未执行（回执 rejected）才返回 false 交调用方恢复草稿。
  describe('sendBash ①b toast 抑制（D2 极性：终态已渲染→抑制 / 其余→不抑制）', () => {
    it('终态帧先于回执到达（executingBash 为空）→ 抑制失败 toast，气泡终态是权威面', async () => {
      const f = makeFixture()
      // bash RPC 挂起：手动控制 reject 时机（模拟 runtime 先广播合成终态帧、后回执不可达）
      let rejectBash: (e: unknown) => void = () => {}
      f.chatApi.bash.mockImplementation(
        () => new Promise((_resolve, reject) => { rejectBash = reject }),
      )
      const sending = f.useChat.sendBash('b1', 'sleep 3700', false)
      // bashStart 到达：executingBash 置位
      f.emit('b1', msg('b1', 'message.bashStart', { command: 'sleep 3700', excludeFromContext: false, timestamp: 1724000000000 }))
      // 合成终态帧到达（dispatcher catch 的诚实文案帧）：executingBash 清空
      f.emit('b1', msg('b1', 'message.bashResult', {
        command: 'sleep 3700', output: '命令执行超过 1 小时，已停止等待……', exitCode: null,
        cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1724000000001,
      }))
      expect(getExecutingBashForTest('b1')).toBeUndefined()
      // 回执不可达（无回执可判）此时刻达
      rejectBash(new Error('Bash execution failed'))
      expect(await sending).toBe(true) // 终态已呈现 = 已被消费，调用方不得恢复 !command
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('回执不可达且终态帧未到达（bashStart 在场 = env backstop 先到形态）→ 不抑制，toast 是唯一提示', async () => {
      const f = makeFixture()
      let rejectBash: (e: unknown) => void = () => {}
      f.chatApi.bash.mockImplementation(
        () => new Promise((_resolve, reject) => { rejectBash = reject }),
      )
      const sending = f.useChat.sendBash('b2', 'sleep 3700', false)
      // bashStart 到达（命令确实在 runtime 执行中），bashResult 未到（runtime 3600s 未到点）
      f.emit('b2', msg('b2', 'message.bashStart', { command: 'sleep 3700', excludeFromContext: false, timestamp: 1724000000000 }))
      expect(getExecutingBashForTest('b2')).toBeDefined()
      // renderer backstop（3660s 或中间态 65s）先 reject
      rejectBash(new Error('request timeout after 3660000ms'))
      expect(await sending).toBe(true) // 已开跑 → 保守 true（恢复 !command 会双执行）
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      expect(f.toast.error).toHaveBeenCalledWith(expect.stringContaining('request timeout after 3660000ms'))
      f.dispose()
    })

    it('可证明未执行（回执 rejected：消息未送达 runtime）→ toast 可见 + 返回 false（原 deviations 登记偏差随契约清除）', async () => {
      const f = makeFixture()
      // 端口层把「消息未送达 runtime」的传输失败翻译为 rejected 回执（可证明未执行）
      f.chatApi.bash.mockResolvedValue({ status: 'rejected', error: 'transport unavailable (ws not open)' })
      const ok = await f.useChat.sendBash('b3', 'echo hi', false)
      // 原偏差登记（「无终态可呈现 → 抑制」）= !command 静默丢失风险，随 [消息投递可靠性
      // A-bash] 契约清除：与 send catch 同款——toast 可见 + false 交调用方恢复草稿；
      // ①b 抑制仅限「本次窗口终态帧已渲染」形态（见上方极性三分）。
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('回执不可达且无任何帧（断连 rejectAll 形态：命令可能已执行）→ 保守返回 true + 状态未知 toast（dmg-r1-2 双执行回归防护）', async () => {
      const f = makeFixture()
      // 断连 rejectAll：RPC 已送达 runtime 与否不可知——旧三分类会误入「从未开跑」返回 false
      // → 调用方恢复 !command 草稿 → 用户按「失败」提示重发即命令双执行
      f.chatApi.bash.mockRejectedValue(new Error('connection disconnected'))
      const ok = await f.useChat.sendBash('b4', 'rm -rf build', false)
      expect(ok).toBe(true) // 保守按已执行处理：不恢复草稿 = 不给双执行开门
      expect(getExecutingBashForTest('b4')).toBeUndefined() // 无帧证据也不改判定（帧只是提示）
      // 诚实措辞：状态未知（不得是「失败」措辞诱导重发），含原始错误供排障
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      expect(f.toast.error).toHaveBeenCalledWith(expect.stringContaining('composable.bashOutcomeUnknown'))
      expect(f.toast.error).toHaveBeenCalledWith(expect.stringContaining('connection disconnected'))
      f.dispose()
    })

    it('回执 started（bash 等待超时置孤儿仍在跑）→ 返回 true 不恢复草稿', async () => {
      const f = makeFixture()
      f.chatApi.bash.mockResolvedValue({ status: 'started', error: 'RPC command "bash" timed out after 3600000ms' })
      const ok = await f.useChat.sendBash('b5', 'sleep 9999', false)
      expect(ok).toBe(true)
      expect(f.toast.error).toHaveBeenCalledTimes(1) // 失败原因可见提示（无终态帧可呈现）
      f.dispose()
    })
  })

  // ── send 族 toast 抑制（msg-pipeline-debloat D4-2 分类码：message_blocked→抑制 / 无码→兜底）──
  //
  // 判别式：error envelope 携带 runtime 分类码 'message_blocked'（BeforeSend hook 否决——
  // runtime dispatcher 已广播 message.error 错误气泡，delivery.submit handler 同码回 error
  // envelope 让 renderer 回滚乐观气泡）→ 抑制 toast，错误气泡是权威呈现侧；transport 级
  //（断连 / 超时，无码或机械码）→ 保守 toast 兜底（错误可见性优先）。
  // send / followUp / editAndResend 三通路同一接法（对齐 sendBash/compact 先例）。
  describe('send 族 toast 抑制（D4-2 分类码：message_blocked→抑制 / 无码→兜底）', () => {
    it('send：hook 否决（message_blocked）→ 抑制 sendFailed toast，乐观副作用照常回滚', async () => {
      const f = makeFixture()
      f.chatApi.submitDelivery.mockRejectedValueOnce(
        Object.assign(new Error('Message blocked by plugin hook'), { code: 'message_blocked' }),
      )
      await expect(f.useChat.send('sb1', textToSegments('hi'))).resolves.toBe(false)
      expect(f.toast.error).not.toHaveBeenCalled()
      // 乐观回滚不受 toast 抑制影响（气泡移除 + inflight 不悬空）
      expect(f.chatStore.getMessages('sb1')).toHaveLength(0)
      expect(f.chatStore.getInflight('sb1')).toBe(0)
      f.dispose()
    })

    it('followUp：hook 否决（message_blocked）→ 抑制 nextTurnSendFailed toast', async () => {
      const f = makeFixture()
      await f.useChat.send('sb2', textToSegments('hi'))
      f.emit('sb2', msg('sb2', 'message.message_start', { messageId: 'a1' }))
      f.chatApi.submitDelivery.mockRejectedValueOnce(
        Object.assign(new Error('Message blocked by plugin hook'), { code: 'message_blocked' }),
      )
      await expect(f.useChat.followUp('sb2', textToSegments('补充'))).resolves.toBe(false)
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('editAndResend：hook 否决（message_blocked）→ 抑制 sendFailed toast', async () => {
      const f = makeFixture()
      await f.useChat.send('sb3', textToSegments('old'))
      const userMsgId = f.chatStore.getMessages('sb3').find((m) => m.role === 'user')!.id
      f.emit('sb3', msg('sb3', 'message.message_start', { messageId: 'a1' }))
      f.emit('sb3', msg('sb3', 'message.complete', { stopReason: 'end_turn' }))
      f.chatApi.submitDelivery.mockRejectedValueOnce(
        Object.assign(new Error('Message blocked by plugin hook'), { code: 'message_blocked' }),
      )
      await expect(f.useChat.editAndResend('sb3', userMsgId, textToSegments('edited'))).resolves.toBe(false)
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('editAndResend：transport 级失败（无码断连形态）→ 保守 toast 兜底（契约边界）', async () => {
      const f = makeFixture()
      await f.useChat.send('sb4', textToSegments('old'))
      const userMsgId = f.chatStore.getMessages('sb4').find((m) => m.role === 'user')!.id
      f.emit('sb4', msg('sb4', 'message.message_start', { messageId: 'a1' }))
      f.emit('sb4', msg('sb4', 'message.complete', { stopReason: 'end_turn' }))
      f.chatApi.submitDelivery.mockRejectedValueOnce(new Error('transport unavailable (ws not open)'))
      await expect(f.useChat.editAndResend('sb4', userMsgId, textToSegments('edited'))).resolves.toBe(false)
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      f.dispose()
    })
  })

  describe('恢复窗口过渡态的 message_start 收尾 gate（crash-resilience T4 回流修复）', () => {
    // 缺陷背景（Gate B A7 真机）：恢复窗口（respawnPending）内用户发消息 → runtime 惰性恢复
    // join 先于 D7 自动恢复 timer 完成 → timer fire「already active/restoring — skip」→
    // session.restored 帧永不发布 → 前端过渡态只能等 30s 超时回落 dead 终态页（而 session
    // 实际已活）。收尾信号 = 恢复窗口内该 session 的 message_start 到达（新 pi 已在处理）。

    it('respawnPending 内 message_start 到达 → 过渡态收尾 + T4 条入流 + sessionStore.revive', async () => {
      const f = makeFixture()
      await f.useChat.send('s-join', textToSegments('hello during recovery'))
      f.chatStore.markRespawnPending('s-join')

      f.emit('s-join', msg('s-join', 'message.message_start', { messageId: 'a-join' }))

      // 过渡态收尾（同步于 enqueue 前——流式帧处理前 T4 条已在流内，先于 assistant 气泡）
      expect(f.chatStore.isRespawnPending('s-join')).toBe(false)
      expect(f.sessionStore.revive).toHaveBeenCalledWith('s-join')
      const notice = f.chatStore
        .getMessages('s-join')
        .find((m) => m.role === 'system' && (m.details as { variant?: string } | undefined)?.variant === 'restored')
      expect(notice).toBeDefined()
      // fallbackText 经 deps.t（fixture 返回 key 本身）
      expect(notice!.content).toBe('panel.message.respawnRestored')
      f.dispose()
    })

    it('非恢复窗口 message_start → gate no-op（无 T4 条、revive 不调）', async () => {
      const f = makeFixture()
      await f.useChat.send('s-normal', textToSegments('hi'))
      f.emit('s-normal', msg('s-normal', 'message.message_start', { messageId: 'a1' }))
      expect(f.sessionStore.revive).not.toHaveBeenCalled()
      expect(
        f.chatStore
          .getMessages('s-normal')
          .some((m) => m.role === 'system' && (m.details as { variant?: string } | undefined)?.variant === 'restored'),
      ).toBe(false)
      f.dispose()
    })

    it('restored 帧先行收尾后 message_start 到达 → 二次收尾 no-op（不插双条）', async () => {
      const f = makeFixture()
      await f.useChat.send('s-race', textToSegments('hi'))
      f.chatStore.markRespawnPending('s-race')
      // 模拟 restored 帧先到（renderer useMessageEffects.handleSessionRestored 的收尾三件套）
      f.chatStore.clearRespawnPending('s-race')
      f.chatStore.appendRespawnNotice('s-race', 'restored', 'panel.message.respawnRestored')

      f.emit('s-race', msg('s-race', 'message.message_start', { messageId: 'a1' }))

      expect(f.sessionStore.revive).not.toHaveBeenCalled()
      expect(
        f.chatStore
          .getMessages('s-race')
          .filter((m) => m.role === 'system' && (m.details as { variant?: string } | undefined)?.variant === 'restored'),
      ).toHaveLength(1)
      f.dispose()
    })
  })

  // ── [u5a 收尾扩展 / #12 对称路径] 扩展命令手敲链 pendingSend 复位 ──
  // pi 扩展命令（手敲 /schedule … 等）同步执行、无 message_start/agent_start 回流 →
  // pendingSend（受理上屏时置位、正常由 message_start 清）永久在挂 → isActive 并集判定
  // 恒 true（steer placeholder + abort 按钮卡死）。修复：handleSessionOccupancy 收到三维
  // 全 idle 权威帧时清 pendingSend（权威帧兜底乐观态；与 defer flush 判据同形）。
  // [ADR-0122 受理回执后上屏] idle 帧的收尾对象 = 受理确认后置位的 pendingSend（reply 先于
  // idle 帧到达的正常时序）；idle 帧先于 reply 的极端时序下置位尚未发生（帧 no-op），命令
  // 条目的收尾归 session.deliveryHandled 终局（U2① 用例锁定）——全事件驱动，无墙钟兜底。

  describe('扩展命令手敲链 pendingSend 复位（#12 对称路径）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
    })

    it('全 idle 权威帧到达清 pendingSend（无 turn 回流通路的乐观态复位 → isActive 复位）', async () => {
      const f = makeFixture()
      await f.useChat.send('ec1', textToSegments('/schedule list'))
      // 受理上屏后 pendingSend 置位（扩展命令无 message_start 可清）
      expect(f.chatStore.isPendingSend('ec1')).toBe(true)
      // runtime 收尾帧（message-dispatcher willExecuteAsExtensionCommand 命中后广播）：
      // 扩展命令无 message_start，权威 idle 帧兜底清乐观态
      f.emit('ec1', msg('ec1', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
      expect(f.chatStore.isActive('ec1')).toBe(false)
      f.dispose()
    })

    it('dispatching 帧不清 pendingSend（正常 turn 路径仍等 message_start）', async () => {
      const f = makeFixture()
      const p = f.useChat.send('ec2', textToSegments('普通消息'))
      f.emit('ec2', msg('ec2', 'session.occupancy', { turn: 'dispatching', compacting: false, bash: false }))
      await p
      expect(f.chatStore.isActive('ec2')).toBe(true)
      f.dispose()
    })

    it('turn=idle 但 bash 忙：不清（三维判据同 flush，防误清占用窗口）', async () => {
      const f = makeFixture()
      const p = f.useChat.send('ec3', textToSegments('/schedule list'))
      f.emit('ec3', msg('ec3', 'session.occupancy', { turn: 'idle', compacting: false, bash: true }))
      await p
      expect(f.chatStore.isActive('ec3')).toBe(true)
      f.dispose()
    })
  })

  // ── [RD-1#9] 未列 session.* 帧类型的 dev 观测（协议漂移零痕迹 → 一次/类型 warn）──────────

  describe('未列 session.* 帧类型的 dev 观测（RD-1#9）', () => {
    /** 只取本观测点的 warn 行（send 路径另有 subscribe 端口未注入的 warn，须滤除）。 */
    function frameWarns(warn: ReturnType<typeof vi.spyOn>): string[] {
      return warn.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((m: string) => m.includes('unhandled session frame type'))
    }

    beforeEach(() => {
      resetChatModuleStateForTest()
      __resetDevModeForTesting()
    })

    afterEach(() => {
      vi.restoreAllMocks()
      __resetDevModeForTesting()
      resetChatModuleStateForTest()
    })

    it('dev 下未列 session.* 类型 → console.warn 一次/类型；已列类型不 warn', () => {
      provideDevMode(true)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const f = makeFixture()
      void f.useChat.send('s90', textToSegments('hi'))

      // 已列类型（session.renamed 有 case）不 warn
      f.emit('s90', msg('s90', 'session.renamed', { name: 'renamed' }))
      expect(frameWarns(warn)).toHaveLength(0)

      // 未列 session.* 类型：去重后一次/类型
      f.emit('s90', msg('s90', 'session.exited', { code: 1 }))
      f.emit('s90', msg('s90', 'session.exited', { code: 2 }))
      expect(frameWarns(warn)).toEqual([
        expect.stringContaining('unhandled session frame type session.exited'),
      ])

      // 另一未列类型独立计数
      f.emit('s90', msg('s90', 'session.stats_update', {}))
      expect(frameWarns(warn)).toHaveLength(2)
      f.dispose()
    })

    it('非 session.* 前缀的全局帧不 warn（app.info / config.* 由其他域消费，warn 即误报）', () => {
      provideDevMode(true)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const f = makeFixture()
      void f.useChat.send('s91', textToSegments('hi'))

      f.emit('s91', msg('s91', 'app.info', { version: '1' }))
      f.emit('s91', msg('s91', 'config.plugins', { plugins: [] }))
      expect(frameWarns(warn)).toHaveLength(0)
      f.dispose()
    })

    it('非 dev（未注入 provideDevMode）→ 零 warn（生产零噪音）', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const f = makeFixture()
      void f.useChat.send('s92', textToSegments('hi'))

      f.emit('s92', msg('s92', 'session.exited', { code: 1 }))
      expect(frameWarns(warn)).toHaveLength(0)
      f.dispose()
    })
  })

  // ── [U5 消息撤回 D6/D7/D8] 统一撤回编排：双态路由 + reply 消费 ──
  describe('[U5] useChat.revokeMessage（统一撤回编排）', () => {
    const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'
    const TAG = `<!--taiji:msg:${UUID}-->`
    const JOINER = '\n\n---\n\n'
    const TAG2 = `<!--taiji:msg:1b2c3d4e-5f60-7182-8394-b5c6d7e8f9a0-->`

    function makeHistMsg(id: string): Message {
      return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: Date.now() }
    }

    /** 预置派生视图条目（在途路由判定数据源） */
    function seedProjection(sid: string, entries: Array<{ clientUuid: string; state: 'queued' | 'in-flight' | 'delivered' | 'failed'; lane?: 'direct' | 'steer' | 'queued' }>): void {
      replaceDeliveryProjection(sid, entries.map((e) => ({ clientUuid: e.clientUuid, preview: 'p', state: e.state, lane: e.lane ?? 'steer' })))
    }

    beforeEach(() => {
      resetDeliveryProjectionForTest()
    })

    it('在途路由（派生视图条目未 delivered）→ 走 cancelDelivery 路径，不触达 revokeMessage RPC', async () => {
      const f = makeFixture()
      seedProjection('sr1', [{ clientUuid: 'u-1', state: 'queued' }])
      f.chatApi.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-1', cancelled: true, content: '收回原文', segments: [{ type: 'text', text: '收回原文' }] })
      await f.useChat.revokeMessage('sr1', 'u-1')
      expect(f.chatApi.cancelDelivery).toHaveBeenCalledWith('sr1', 'u-1')
      expect(f.chatApi.revokeMessage).not.toHaveBeenCalled()
      // cancel reply 的 content 已由 runtime 剥标记——原样回填（注入通道单值 text 语义，
      // [MF-1-2] 撤回路径纯文本回草稿，chips 恢复走队列区 restoreToDraft 通道）
      expect(f.restoreDraft).toHaveBeenCalledWith('sr1', { text: '收回原文' })
      f.dispose()
    })

    it('在途竞态落败（cancelled=false）→ toast 指引转已送达层，不回填', async () => {
      const f = makeFixture()
      seedProjection('sr2', [{ clientUuid: 'u-2', state: 'in-flight' }])
      f.chatApi.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-2', cancelled: false })
      await f.useChat.revokeMessage('sr2', 'u-2')
      expect(f.toast.error).toHaveBeenCalledWith('composable.revokeDeliveredRace')
      expect(f.restoreDraft).not.toHaveBeenCalled()
      f.dispose()
    })

    it('已送达 → revokeMessage RPC；revoked:true → 重新拉取 history（reconcileHistory 链）+ 草稿剥标记回填', async () => {
      const f = makeFixture()
      // 派生视图无该条目（已 morph 为 transcript）= 已送达
      f.chatApi.revokeMessage.mockResolvedValueOnce({ sessionId: 'sr3', revoked: true, content: `原文内容\n${TAG}` })
      f.chatApi.getHistory.mockResolvedValueOnce({ messages: [makeHistMsg('m1')], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      await f.useChat.revokeMessage('sr3', 'entry-1')
      expect(f.chatApi.revokeMessage).toHaveBeenCalledWith('sr3', 'entry-1')
      expect(f.chatApi.cancelDelivery).not.toHaveBeenCalled()
      // 重新拉取经 reconcileHistory 写入分区（live ≡ reload 汇合点）
      expect(f.chatApi.getHistory).toHaveBeenCalledWith('sr3')
      expect(f.chatStore.getMessages('sr3').map((m) => m.id)).toEqual(['m1'])
      // 草稿回填：content 剥标记后送 composer（D7）
      expect(f.restoreDraft).toHaveBeenCalledWith('sr3', { text: '原文内容' })
      f.dispose()
    })

    it('revoked:true 整批形态 → restoreRevokedDraft 两层切条后回填（空行连接）', async () => {
      const f = makeFixture()
      const batch = `第一条\n${TAG}${JOINER}第二条\n${TAG2}`
      f.chatApi.revokeMessage.mockResolvedValueOnce({ sessionId: 'sr4', revoked: true, content: batch })
      f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      await f.useChat.revokeMessage('sr4', 'entry-2')
      expect(f.restoreDraft).toHaveBeenCalledWith('sr4', { text: '第一条\n\n第二条' })
      f.dispose()
    })

    it('重新拉取失败不阻断回填（撤回已生效——warn 留痕，restoreDraft 照做）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const f = makeFixture()
      f.chatApi.revokeMessage.mockResolvedValueOnce({ sessionId: 'sr5', revoked: true, content: `原文\n${TAG}` })
      f.chatApi.getHistory.mockRejectedValueOnce(new Error('ws down'))
      await f.useChat.revokeMessage('sr5', 'entry-3')
      expect(warn).toHaveBeenCalled()
      expect(f.restoreDraft).toHaveBeenCalledWith('sr5', { text: '原文' })
      warn.mockRestore()
      f.dispose()
    })

    it('RPC reject → revokeFailed toast（不 throw）', async () => {
      const f = makeFixture()
      f.chatApi.revokeMessage.mockRejectedValueOnce(new Error('ws down'))
      await expect(f.useChat.revokeMessage('sr6', 'entry-4')).resolves.toBeUndefined()
      expect(f.toast.error).toHaveBeenCalledWith('composable.revokeFailed:{"msg":"ws down"}')
      f.dispose()
    })

    // D8 错误码 toast 闭集断言（六码各一键，呈现 SSOT）
    it.each([
      ['busy', 'composable.revokeBusy'],
      ['no-mapping', 'composable.revokeNoMapping'],
      ['extension-missing', 'composable.revokeExtensionMissing'],
      ['nav-failed', 'composable.revokeNavFailed'],
      ['pi-reclaimed', 'composable.revokePiReclaimed'],
      ['workflow-running', 'composable.revokeWorkflowRunning'],
    ] as const)('revoked:false + error=%s → toast %s（D8 呈现 SSOT）', async (code, key) => {
      const f = makeFixture()
      f.chatApi.revokeMessage.mockResolvedValueOnce({ sessionId: 'sr7', revoked: false, error: code })
      await f.useChat.revokeMessage('sr7', 'entry-5')
      expect(f.toast.error).toHaveBeenCalledWith(key)
      expect(f.restoreDraft).not.toHaveBeenCalled()
      expect(f.chatApi.getHistory).not.toHaveBeenCalled()
      f.dispose()
    })

    it('成功但草稿空白（契约违规形态）→ 不回填不出声轰炸（静默跳过空草稿）', async () => {
      const f = makeFixture()
      f.chatApi.revokeMessage.mockResolvedValueOnce({ sessionId: 'sr8', revoked: true, content: '' })
      f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      await f.useChat.revokeMessage('sr8', 'entry-6')
      expect(f.restoreDraft).not.toHaveBeenCalled()
      f.dispose()
    })
  })

  // ── 消息投递可靠性：bash 投递回执（验收⑦）──
  describe('消息投递可靠性：bash 投递回执（验收⑦a-⑦d）', () => {

    it('验收⑦a bash 可证明未执行（回执 rejected，无任何帧）→ 返回 false + 无悬空标记 + toast 可见', async () => {
      const f = makeFixture()
      // 回执契约（dmg-r1-2）：「真失败且未执行」的形态 = 回执 rejected（消息未送达 runtime /
      // runtime 拒绝），由回执状态判定——不再以「无任何帧」推断（帧丢失会误判致双执行）
      f.chatApi.bash.mockResolvedValueOnce({ status: 'rejected', error: 'WS断' })

      const ok = await f.useChat.sendBash('bf1', 'ls -la', false)

      expect(ok).toBe(false) // 可证明未执行 → 调用方恢复 !command 草稿（安全，不会双执行）
      // 无悬空标记：executingBash 从未置位（瞬时行/气泡全由帧驱动，bash 无乐观面）、
      // inflight 恒 0（不挂占位）、pendingSend 不置（无主 agent turn）
      expect(getExecutingBashForTest('bf1')).toBeUndefined()
      expect(f.chatStore.getInflight('bf1')).toBe(0)
      expect(f.chatStore.isPendingSend('bf1')).toBe(false)
      // 错误可见（不静默——原实现此形态误入 toast 抑制分支 → !command 静默丢失）
      expect(f.toast.error).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('验收⑦b 终态帧已渲染后 RPC 再败 → 返回 true（已呈现终态=已被消费）+ toast 抑制不变（①b 回归）', async () => {
      const f = makeFixture()
      let rejectBash: (e: unknown) => void = () => {}
      f.chatApi.bash.mockImplementation(() => new Promise((_resolve, reject) => { rejectBash = reject }))
      const sending = f.useChat.sendBash('bf2', 'sleep 3700', false)
      f.emit('bf2', msg('bf2', 'message.bashStart', { command: 'sleep 3700', excludeFromContext: false, timestamp: 1724000000000 }))
      f.emit('bf2', msg('bf2', 'message.bashResult', {
        command: 'sleep 3700', output: '命令执行超过 1 小时，已停止等待……', exitCode: null,
        cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1724000000001,
      }))
      rejectBash(new Error('Bash execution failed'))

      // 终态帧 = 用户可见恢复锚 → true（调用方恢复 !command 会与终态气泡双份）
      expect(await sending).toBe(true)
      expect(f.toast.error).not.toHaveBeenCalled() // ①b toast 抑制极性不变（气泡终态是权威呈现侧）
      f.dispose()
    })

    it('验收⑦c bash 正常投递 → 返回 true（回归）', async () => {
      const f = makeFixture()

      const ok = await f.useChat.sendBash('bf3', 'git status', false)

      expect(ok).toBe(true)
      expect(f.chatApi.bash).toHaveBeenCalledWith('bf3', 'git status', false)
      expect(f.toast.error).not.toHaveBeenCalled()
      f.dispose()
    })

    it('验收⑦d bashStart 在场、终态未到（backstop 先 reject）→ 返回 true（已投递，恢复会双执行）+ toast 不抑制', async () => {
      const f = makeFixture()
      let rejectBash: (e: unknown) => void = () => {}
      f.chatApi.bash.mockImplementation(() => new Promise((_resolve, reject) => { rejectBash = reject }))
      const sending = f.useChat.sendBash('bf4', 'sleep 3700', false)
      f.emit('bf4', msg('bf4', 'message.bashStart', { command: 'sleep 3700', excludeFromContext: false, timestamp: 1724000000000 }))
      rejectBash(new Error('request timeout after 3660000ms'))

      // 命令已开跑（瞬时执行行=可见恢复锚 + 迟到 bashResult 照常入流）→ true（恢复会双执行）
      expect(await sending).toBe(true)
      expect(getExecutingBashForTest('bf4')).toBeDefined() // 执行中瞬时态保持（非悬空——真实运行中）
      expect(f.toast.error).toHaveBeenCalledTimes(1) // 唯一提示，不抑制（D5 先例极性不变）
      // 收尾：哨兵帧（command:'' + cancelled:true，abortBash 兜底广播形态）清 executingBash，
      // 防 bash-effects 模块级 Map 残留泄漏到后续用例
      f.emit('bf4', msg('bf4', 'message.bashResult', { command: '', output: '', exitCode: null, cancelled: true, truncated: false, excludeFromContext: false, timestamp: 1724000000002 }))
      f.dispose()
    })
  })

  describe('chat-flow-consistency D4 终态处理失败恢复（occupancy idle × 本地 streaming 残留）', () => {
    beforeEach(() => {
      resetChatModuleStateForTest()
    })

    /** 权威历史 reply（getHistory 生产形态：pi 落盘 entry 派生消息，piEntryId 权威锚） */
    function authoritativeHistoryReply() {
      const now = Date.now()
      return {
        messages: [
          { id: 'e-user-1', piEntryId: 'e-user-1', role: 'user', content: 'hi', status: 'complete', timestamp: now },
          { id: 'e-assistant-1', piEntryId: 'e-assistant-1', role: 'assistant', content: '权威完整内容', status: 'complete', timestamp: now + 1 },
        ] as Message[],
        truncated: false,
        loadedTurns: 1,
        totalTurnsEstimate: 1,
      }
    }

    /**
   * 注入「终态处理失败」形态（任务书 A4 验收形态）：message.complete 帧副作用链抛错——
   * 走 ensureStreamSubscription 的 dispatch 错误隔离点（catch 吞掉只 warn，缺陷 5 现状
   * 半执行入口），终态帧被吞、本地 streaming 残留在场。
   */
    function injectCompleteHandlerFailure(f: Fixture): void {
      const realApply = f.chatStore.applyMessageEvent
      vi.spyOn(f.chatStore, 'applyMessageEvent').mockImplementation((sid, m) => {
        if (m.type === 'message.complete') throw new Error('injected terminal-frame handler failure')
        realApply(sid, m)
      })
    }

    it('主形态：complete 处理抛错后权威 idle 到达 → 两步收尾（stalled 定格 + getHistory 拉权威），最终消息列表与权威一致、无永久工作中态', async () => {
      const f = makeFixture()
      await f.useChat.send('s-d4', textToSegments('hi'))
      f.emit('s-d4', msg('s-d4', 'message.message_start', { messageId: 'm1' }))
      expect(f.chatStore.isGenerating('s-d4')).toBe(true)
      injectCompleteHandlerFailure(f)
      f.emit('s-d4', msg('s-d4', 'message.complete', { stopReason: 'end_turn' }))
      // 处理失败形态在场：终态帧被吞、本地 streaming 残留（缺陷 5 现状形态）
      expect(f.chatStore.isGenerating('s-d4')).toBe(true)
      f.chatApi.getHistory.mockResolvedValue(authoritativeHistoryReply())

      f.emit('s-d4', msg('s-d4', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))

      // 第一步收尾生效（无永久工作中态）
      expect(f.chatStore.isGenerating('s-d4')).toBe(false)
      // 第二步拉权威（每回合至多一次）
      expect(f.chatApi.getHistory).toHaveBeenCalledTimes(1)
      expect(f.chatApi.getHistory).toHaveBeenCalledWith('s-d4')
      await vi.waitFor(() => {
        const messages = f.chatStore.getMessages('s-d4')
        // 最终消息列表与权威一致：乐观 user 气泡经合并判据被权威 user 副本去重，
        // stalled 定格的 error assistant 被权威 assistant 替换（先收尾 → 保护段为空 → 基线接管）
        expect(messages).toHaveLength(2)
        expect(messages.some((m) => m.role === 'assistant' && m.status === 'streaming')).toBe(false)
        expect(messages.some((m) => m.role === 'assistant' && m.error)).toBe(false)
        expect(messages.find((m) => m.role === 'assistant')?.content).toBe('权威完整内容')
      })
      f.dispose()
    })

    it('stalled 定格形态：收尾后残留 assistant 转 error 终态 + 设计定稿中断文案（拉取前窗口）', async () => {
      const f = makeFixture()
      await f.useChat.send('s-d4m', textToSegments('hi'))
      f.emit('s-d4m', msg('s-d4m', 'message.message_start', { messageId: 'm1' }))
      injectCompleteHandlerFailure(f)
      f.emit('s-d4m', msg('s-d4m', 'message.complete', { stopReason: 'end_turn' }))
      // getHistory 挂起不 settle：锁存「收尾已做、拉取未回」的定格窗口形态
      f.chatApi.getHistory.mockImplementation(() => new Promise(() => {}))

      f.emit('s-d4m', msg('s-d4m', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))

      const lastAssistant = [...f.chatStore.getMessages('s-d4m')].reverse().find((m) => m.role === 'assistant')
      expect(lastAssistant?.status).toBe('error')
      expect(lastAssistant?.error).toContain('回复已中断')
      expect(lastAssistant?.error).toContain('重新打开会话可恢复完整内容')
      f.dispose()
    })

    it('拉取失败降级：getHistory reject → warn 留痕，stalled 定格文案保持完成时态 + 恢复动作指引（与设计 D4 降级登记一致）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const f = makeFixture()
      await f.useChat.send('s-d4fail', textToSegments('hi'))
      f.emit('s-d4fail', msg('s-d4fail', 'message.message_start', { messageId: 'm1' }))
      injectCompleteHandlerFailure(f)
      f.emit('s-d4fail', msg('s-d4fail', 'message.complete', { stopReason: 'end_turn' }))
      f.chatApi.getHistory.mockRejectedValue(new Error('ws closed'))

      f.emit('s-d4fail', msg('s-d4fail', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))

      await vi.waitFor(() => {
        // 降级已发生：失败 warn 留痕
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('history pull failed'))).toBe(true)
      })
      // 定格文案与 REASON_FALLBACK_ERROR_TEXT.stalled 登记一致：完成时态 + 恢复动作指引，
      // 无进行时态「正在恢复」（恢复已静默终止，收敛依赖下次切入/刷新的既有 reconcile）
      const lastAssistant = [...f.chatStore.getMessages('s-d4fail')].reverse().find((m) => m.role === 'assistant')
      expect(lastAssistant?.status).toBe('error')
      expect(lastAssistant?.error).toBe('回复已中断（内容可能不完整）。重新打开会话可恢复完整内容。')
      expect(lastAssistant?.error).not.toContain('正在恢复')
      warnSpy.mockRestore()
      f.dispose()
    })

    it('正常路径零触发：complete 正常收尾后 idle 帧到达不拉权威（每回合至多一次拉取契约）', async () => {
      const f = makeFixture()
      await f.useChat.send('s-d4n', textToSegments('hi'))
      f.emit('s-d4n', msg('s-d4n', 'message.message_start', { messageId: 'm1' }))
      f.emit('s-d4n', msg('s-d4n', 'message.complete', { stopReason: 'end_turn' }))
      expect(f.chatStore.isGenerating('s-d4n')).toBe(false)

      f.emit('s-d4n', msg('s-d4n', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))

      expect(f.chatApi.getHistory).not.toHaveBeenCalled()
      const messages = f.chatStore.getMessages('s-d4n')
      expect(messages.some((m) => m.role === 'assistant' && m.error)).toBe(false)
      f.dispose()
    })

    it('负路径：occupancy 非 idle（generating / bash 在途）到达时本地 streaming 在场不触发恢复', async () => {
      const f = makeFixture()
      await f.useChat.send('s-d4g', textToSegments('hi'))
      f.emit('s-d4g', msg('s-d4g', 'message.message_start', { messageId: 'm1' }))

      f.emit('s-d4g', msg('s-d4g', 'session.occupancy', { turn: 'generating', compacting: false, bash: false }))
      expect(f.chatApi.getHistory).not.toHaveBeenCalled()
      expect(f.chatStore.isGenerating('s-d4g')).toBe(true)

      f.emit('s-d4g', msg('s-d4g', 'session.occupancy', { turn: 'idle', compacting: false, bash: true }))
      expect(f.chatApi.getHistory).not.toHaveBeenCalled()
      expect(f.chatStore.isGenerating('s-d4g')).toBe(true)
      f.dispose()
    })

    it('降级：权威拉取失败仅 warn 留痕——本地已收尾无永久工作中态，不沿订阅回调逆传', async () => {
      const f = makeFixture()
      await f.useChat.send('s-d4f', textToSegments('hi'))
      f.emit('s-d4f', msg('s-d4f', 'message.message_start', { messageId: 'm1' }))
      injectCompleteHandlerFailure(f)
      f.emit('s-d4f', msg('s-d4f', 'message.complete', { stopReason: 'end_turn' }))
      f.chatApi.getHistory.mockRejectedValue(new Error('transport down'))

      expect(() =>
        f.emit('s-d4f', msg('s-d4f', 'session.occupancy', { turn: 'idle', compacting: false, bash: false })),
      ).not.toThrow()
      expect(f.chatStore.isGenerating('s-d4f')).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, 0))
      const lastAssistant = [...f.chatStore.getMessages('s-d4f')].reverse().find((m) => m.role === 'assistant')
      expect(lastAssistant?.status).toBe('error')
      expect(lastAssistant?.error).toContain('回复已中断')
      f.dispose()
    })
  })
});
