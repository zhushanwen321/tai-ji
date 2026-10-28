// store-merged.test.ts —— core C02 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/chat/store.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/chat/__tests__/derive-status.test.ts（19 用例，skip 0）
//   - src/domain/chat/__tests__/invalidate-stream-subscription.test.ts（4 用例，skip 0）
//   - src/domain/chat/__tests__/lifecycle-effects.test.ts（13 用例，skip 0）
//   - src/domain/chat/__tests__/lru-unsubscribe.test.ts（7 用例，skip 0）
//   - src/domain/chat/__tests__/streaming-state-machine.test.ts（43 用例，skip 0）
//   - src/domain/chat/__tests__/subagent-entries.test.ts（10 用例，skip 0）
//   - src/domain/session/__tests__/session-derivations.test.ts（11 用例，skip 0）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, type ShallowRef, computed, ref, shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore, type ChatStoreInstance, type SessionOccupancyState } from '../store'
import { deriveStatus } from '../derive-status'
import { type Message, type ServerMessage, PI_RESPAWN_NOTICE_CUSTOM_TYPE, subagentVirtualId, type PiEntry, type PiMessageEntry, type PiToolCallEntryForm, type SessionGroup } from '@taiji/shared'
import { createSessionLiveState } from '@taiji/core/domain/session'
import { ensureStreamSubscription, invalidateStreamSubscription, resetChatModuleStateForTest, type EnsureStreamSubDeps, evictLruWithUnsubscribe, type LruUnsubscribeDeps } from '../useChat'
import { setSubscriptionPorts, getSubscriptionState, resetSubscriptionStates } from '../../../coordination/subscription-state'
import { createSessionStore, deriveSessionStatus, sessionsInRuntimeGroupOrder } from '../../session/store'
import { createLifecycleEffects, type LifecycleEffects, type LifecycleEffectsDeps, type LifecycleNoticeTexts } from '../lifecycle-effects'
import { _resetLruForTest } from '../lru'
import { createStreamingStateMachine, type SubagentStreamStateSnapshot } from '../streaming-state-machine'

// ======== 来源：derive-status.test.ts ========
describe("derive-status", () => {
  /** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。返回 store + dispose。 */
  function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
    const scope = effectScope(true)
    const store = scope.run(() => createChatStore())!
    return { store, dispose: () => scope.stop() }
  }

  /** 构造 complete assistant 消息 */
  function assistantMsg(id: string, overrides: Partial<Message> = {}): Message {
    return { id, role: 'assistant', content: 'ok', status: 'complete', timestamp: 1, ...overrides }
  }

  describe('deriveStatus 9 态 parity（M3 搬迁）', () => {
    let sut: { store: ChatStoreInstance; dispose: () => void }

    beforeEach(() => {
      vi.useFakeTimers()
      setActivePinia(createPinia())
      sut = makeStore()
    })

    afterEach(() => {
      sut.dispose()
      vi.useRealTimers()
    })

    it('未 hydrate + 非活跃 → done（兜底）', () => {
      expect(sut.store.getMessages('s1')).toHaveLength(0)
      expect(deriveStatus('s1', sut.store, false)).toBe('done')
    })

    it('isActive=true（pendingSend 空窗）→ pending', () => {
      sut.store.addPendingSend('s1')
      expect(sut.store.isActive('s1')).toBe(true)
      expect(deriveStatus('s1', sut.store, true)).toBe('pending')
    })

    it('streaming（message_start → isGenerating）→ streaming', () => {
      sut.store.applyMessageEvent('s1', {
        type: 'message.message_start',
        payload: { sessionId: 's1', messageId: 'a1' },
      } as ServerMessage)
      expect(sut.store.isGenerating('s1')).toBe(true)
      expect(deriveStatus('s1', sut.store, true)).toBe('streaming')
    })

    it('末条 assistant status=streaming → streaming（不依赖 isGenerating）', () => {
      sut.store.hydrate('s1', [assistantMsg('m1', { status: 'streaming' })])
      expect(deriveStatus('s1', sut.store, false)).toBe('streaming')
    })

    it('isCompacting=true → compacting', () => {
      sut.store.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
      expect(deriveStatus('s1', sut.store, false, true)).toBe('compacting')
    })

    it('hasBackgroundWork=true → working（主 turn 结束，background 仍在跑）', () => {
      sut.store.hydrate('s1', [assistantMsg('m1')])
      expect(deriveStatus('s1', sut.store, false, false, true)).toBe('working')
    })

    it('末条 assistant toolCall running → waiting（最优先）', () => {
      sut.store.hydrate('s1', [
        assistantMsg('m1', {
          status: 'streaming',
          toolCalls: [{ id: 't1', toolName: 'bash', input: {}, status: 'running', startTime: 0 }],
        }),
      ])
      expect(deriveStatus('s1', sut.store, false)).toBe('waiting')
    })

    it('hasFormOverlayPending=true → waiting（与 toolCall 并列最优先）', () => {
      // 未 hydrate + 非活跃 → 单独看兜底 done；富交互表单 pending 应改判 waiting
      expect(deriveStatus('s1', sut.store, false, false, false, undefined, true)).toBe('waiting')
    })

    it('hasFormOverlayPending 默认 false：不传第 7 参行为不变', () => {
      expect(deriveStatus('s1', sut.store, false)).toBe('done')
      expect(deriveStatus('s1', sut.store, false, false, false, undefined, false)).toBe('done')
    })

    it('末条 assistant status=error → error', () => {
      sut.store.hydrate('s1', [assistantMsg('m1', { status: 'error' })])
      expect(deriveStatus('s1', sut.store, false)).toBe('error')
    })

    it('末条 assistant isInterrupted → stopped', () => {
      sut.store.hydrate('s1', [assistantMsg('m1', { isInterrupted: true })])
      expect(deriveStatus('s1', sut.store, false)).toBe('stopped')
    })

    it('末条 assistant complete → done', () => {
      sut.store.hydrate('s1', [assistantMsg('m1')])
      expect(deriveStatus('s1', sut.store, false)).toBe('done')
    })
  })

  describe('deriveStatus metaStatus 兜底（W6，未 hydrate）', () => {
    let sut: { store: ChatStoreInstance; dispose: () => void }

    beforeEach(() => {
      vi.useFakeTimers()
      setActivePinia(createPinia())
      sut = makeStore()
    })

    afterEach(() => {
      sut.dispose()
      vi.useRealTimers()
    })

    it('未 hydrate + metaStatus=error → error', () => {
      expect(deriveStatus('s1', sut.store, false, false, false, 'error')).toBe('error')
    })

    it('未 hydrate + metaStatus=stopped → stopped', () => {
      expect(deriveStatus('s1', sut.store, false, false, false, 'stopped')).toBe('stopped')
    })

    it('未 hydrate + metaStatus=done → done', () => {
      expect(deriveStatus('s1', sut.store, false, false, false, 'done')).toBe('done')
    })

    it('未 hydrate + metaStatus=idle（历史 session）→ 兜底 done', () => {
      expect(deriveStatus('s1', sut.store, false, false, false, 'idle')).toBe('done')
    })

    it('未 hydrate + 无 metaStatus → 兜底 done', () => {
      expect(deriveStatus('s1', sut.store, false, false, false)).toBe('done')
    })

    it('已 hydrate 不受 metaStatus 干扰（末条 error 优先）', () => {
      sut.store.hydrate('s1', [assistantMsg('m1', { status: 'error' })])
      expect(deriveStatus('s1', sut.store, false, false, false, 'done')).toBe('error')
    })
  })

  describe('deriveStatus 优先级回归（retrying > compacting > streaming）', () => {
    let sut: { store: ChatStoreInstance; dispose: () => void }

    beforeEach(() => {
      vi.useFakeTimers()
      setActivePinia(createPinia())
      sut = makeStore()
    })

    afterEach(() => {
      sut.dispose()
      vi.useRealTimers()
    })

    it('retryStates 存在 → retrying（高于 streaming）', () => {
      sut.store.applyMessageEvent('s1', {
        type: 'message.message_start',
        payload: { sessionId: 's1', messageId: 'a1' },
      } as ServerMessage)
      // 注入 retry 状态（经 store 公开 API 不可直接写，这里走 deriveStatus 的 getRetryState
      // 结构接口——用 spy 验证 retrying 分支优先于 streaming）
      const withRetry = {
        ...sut.store,
        getRetryState: () => ({ attempt: 1, inProgress: true }),
      }
      expect(deriveStatus('s1', withRetry, true)).toBe('retrying')
    })
  })
});

// ======== 来源：invalidate-stream-subscription.test.ts ========
describe("invalidate-stream-subscription", () => {
  /**
 * 等 fire-and-forget 的 subscribeSession（async）收敛。
 *
 * 确定性收敛信号（非 setTimeout 魔法等待）：await 每个 subscribe RPC 的真实 promise
 * ——settle 即 subscribeSession 的同步续体（写订阅状态）已在微任务队列跑完；用例 3 注入的
 * 永挂死 Promise（in-flight 窗口）经已 resolve 哨兵 race 跳过，不依赖 timer。
 * 尾部两轮微任务排空续体链残余——排空不足只会让随后的 subscribed 正断言假红（可见），
 * 不产生假绿方向。
 */
  const flushSubscribes = async (subscribeRpc: ReturnType<typeof vi.fn>): Promise<void> => {
    for (const r of subscribeRpc.mock.results) {
      await Promise.race([r.value, Promise.resolve()])
    }
    await Promise.resolve()
    await Promise.resolve()
  }

  interface Fixture { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    /** 对固定 sid 调 ensureStreamSubscription（chat/sessionStore/deps 已闭包注入） */
    ensure: (sid: string) => void
    streamSubscribe: ReturnType<typeof vi.fn>
    subscribeRpc: ReturnType<typeof vi.fn>
    /** effectScope.stop（对齐 useChat.test.ts fixture dispose 先例） */
    dispose: () => void
  }

  function makeFixture(): Fixture {
    const scope = effectScope(true)
    const chatStore = scope.run(() => createChatStore())!
    /** 每次事件层订阅对应的 unsub（验证 invalidate 调用了旧 unsub，不残留双订阅） */
    const unsubs: Array<ReturnType<typeof vi.fn>> = []
    const streamSubscribe = vi.fn((_sid: string, _h: (m: ServerMessage) => void) => {
      const unsub = vi.fn()
      unsubs.push(unsub)
      return unsub
    })
    const subscribeRpc = vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
    setSubscriptionPorts({ subscribe: subscribeRpc, replay: vi.fn() })
    const deps: EnsureStreamSubDeps = {
      // [u4b 收窄 → chat-flow-consistency D4 扩员] chatApi = Pick<ChatApiPort, 'streamSubscribe' | 'getHistory'>，
      // 只注入消费方（excess property check 不放行多余键）；getHistory 本文件用例不触发，mock 补齐形状
      chatApi: {
        streamSubscribe,
        getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
      },
      // [W1 状态层] session.* 状态帧唯一落点（本用例不触达 session.* 状态帧，注入真实 factory 保持契约形状）
      liveState: createSessionLiveState(),
      // [session-dead 第三环] warning：defer 重投熔断提示的注入点（本用例不触发）
      toast: { error: vi.fn(), warning: vi.fn() },
      t: (k: string) => k,
    }
    return {
      ensure: (sid) =>
        ensureStreamSubscription(
          sid,
          chatStore,
          { applySnapshot: vi.fn(), revive: vi.fn() },
          deps,
        ),
      streamSubscribe,
      subscribeRpc,
      dispose: () => scope.stop(),
    }
  }

  describe('invalidateStreamSubscription（session.exited 订阅失效）', () => {
    let f: Fixture

    beforeEach(() => {
      resetChatModuleStateForTest()
      f = makeFixture()
    })

    afterEach(() => {
      f.dispose()
    })

    it('invalidate 后再次 ensure：重发 events 订阅 + 重发 subscribe RPC + 重建订阅状态', async () => {
      const sid = 's-dead'
      f.ensure(sid)
      expect(f.streamSubscribe).toHaveBeenCalledTimes(1)
      await flushSubscribes(f.subscribeRpc)
      expect(f.subscribeRpc).toHaveBeenCalledTimes(1)
      expect(getSubscriptionState(sid)?.subscribed).toBe(true)

      // session.exited → 失效本地标记（服务端订阅已被 clearSession 清除）
      invalidateStreamSubscription(sid)
      expect(getSubscriptionState(sid)).toBeUndefined()

      // respawn 后 ensure 不被幂等检查短路：三层全部重发
      f.ensure(sid)
      expect(f.streamSubscribe).toHaveBeenCalledTimes(2)
      await flushSubscribes(f.subscribeRpc)
      expect(f.subscribeRpc).toHaveBeenCalledTimes(2)
      expect(getSubscriptionState(sid)?.subscribed).toBe(true)
    })

    it('invalidate 后再次 ensure 产生新 unsub，旧 handler 已随 invalidate 移除', () => {
      const sid = 's-dead'
      f.ensure(sid)
      expect(f.streamSubscribe).toHaveBeenCalledTimes(1)
      // streamSubscribe 的第 1 次调用返回的 unsub 被调用 = 旧 events handler 已解除
      const firstUnsub = (f.streamSubscribe.mock.results[0]!.value as ReturnType<typeof vi.fn>)
      invalidateStreamSubscription(sid)
      expect(firstUnsub).toHaveBeenCalledTimes(1)

      f.ensure(sid)
      expect(f.streamSubscribe).toHaveBeenCalledTimes(2)
    })

    it('in-flight subscribe 期间 invalidate：respawn 后首次 ensure 重发 subscribe RPC（不复用死 Promise）', async () => {
      const sid = 's-dead'
      // subscribe RPC 永不 resolve（模拟 runtime 侧 session 已删、reply 不来，65s 超时前的窗口）
      f.subscribeRpc.mockImplementation(() => new Promise(() => {}))
      f.ensure(sid)
      await flushSubscribes(f.subscribeRpc)
      expect(f.subscribeRpc).toHaveBeenCalledTimes(1)

      invalidateStreamSubscription(sid)

      // 恢复正常 resolve：首次 ensure 必须发新 RPC，而非被 in-flight 去重收敛到旧死 Promise
      f.subscribeRpc.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
      f.ensure(sid)
      await flushSubscribes(f.subscribeRpc)
      expect(f.subscribeRpc).toHaveBeenCalledTimes(2)
      expect(getSubscriptionState(sid)?.subscribed).toBe(true)
    })

    it('未订阅的 sid invalidate 幂等 no-op', () => {
      expect(() => invalidateStreamSubscription('s-ghost')).not.toThrow()
      f.ensure('s-live')
      expect(f.streamSubscribe).toHaveBeenCalledTimes(1)
    })
  })
});

// ======== 来源：lifecycle-effects.test.ts ========
describe("lifecycle-effects", () => {
  const NOTICES: LifecycleNoticeTexts = {
    restored: '已恢复（fixture 文案）',
    restoreFailed: '恢复失败（fixture 文案）',
  }

  type SessionStore = ReturnType<typeof createSessionStore>

  /** 等 fire-and-forget 的 subscribeSession（async）收敛（invalidate-stream-subscription.test.ts 同款）。
 *  reject 的 RPC（失败用例注入）同样等待其收敛但不外抛——settle 即续体跑完，失败方向由
 *  subscribed 状态断言承接。 */
  const flushSubscribes = async (subscribeRpc: ReturnType<typeof vi.fn>): Promise<void> => {
    for (const r of subscribeRpc.mock.results) {
      await Promise.race([Promise.resolve(r.value).catch(() => {}), Promise.resolve()])
    }
    await Promise.resolve()
    await Promise.resolve()
  }

  interface Fixture { // oe-exempt:20261003:test:测试 fixture 单实现常态
    chat: ReturnType<typeof createChatStore>
    session: SessionStore
    effects: LifecycleEffects
    markSessionErrorSpy: ReturnType<typeof vi.fn>
    markDeadSpy: ReturnType<typeof vi.fn>
    subscribeRpc: ReturnType<typeof vi.fn>
    /** effectScope.stop */
    dispose: () => void
  }

  function makeFixture(ensureStream?: (sessionId: string) => void): Fixture {
    const scope = effectScope(true)
    const chat = scope.run(() => createChatStore())!
    const session = createSessionStore()
    session.applySnapshot({
      groups: [
        {
          cwd: '/fixture',
          sessions: [
            { id: 's1', label: 'fixture session', cwd: '/fixture', status: 'active', lastActiveAt: 1 },
          ],
        },
      ],
    })
    const subscribeRpc = vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
    setSubscriptionPorts({ subscribe: subscribeRpc, replay: vi.fn() })
    // createChatStore/createSessionStore 产物方法均为闭包函数（不依赖 this），包一层序 spy 透传真实调用
    const markSessionErrorSpy = vi.fn((sid: string, reason: string) => chat.markSessionError(sid, reason))
    const markDeadSpy = vi.fn((sid: string) => session.markDead(sid))
    const deps: LifecycleEffectsDeps = {
      chat: {
        markSessionError: markSessionErrorSpy,
        appendRespawnNotice: (sid, variant, text) => chat.appendRespawnNotice(sid, variant, text),
      },
      session: {
        markDead: markDeadSpy,
        revive: (sid) => session.revive(sid),
      },
      ...(ensureStream ? { ensureStream } : {}),
    }
    return {
      chat,
      session,
      effects: createLifecycleEffects(deps, NOTICES),
      markSessionErrorSpy,
      markDeadSpy,
      subscribeRpc,
      dispose: () => scope.stop(),
    }
  }

  describe('createLifecycleEffects.markSessionDead（exited core 序列）', () => {
    let f: Fixture

    beforeEach(() => {
      resetChatModuleStateForTest()
      resetSubscriptionStates()
      f = makeFixture()
    })

    afterEach(() => {
      resetChatModuleStateForTest()
      resetSubscriptionStates()
      f.dispose()
    })

    it('markSessionError → markDead 保序（错误消息 / dead 态 UI 反馈先落地），reason 透传', () => {
      f.effects.markSessionDead('s1', 'Session process exited (code: 1)')

      expect(f.markSessionErrorSpy).toHaveBeenCalledWith('s1', 'Session process exited (code: 1)')
      expect(f.markDeadSpy).toHaveBeenCalledWith('s1')
      const errIdx = f.markSessionErrorSpy.mock.invocationCallOrder[0]!
      const deadIdx = f.markDeadSpy.mock.invocationCallOrder[0]!
      expect(errIdx).toBeLessThan(deadIdx)
    })

    it('无 streaming 实体：追加 error assistant 消息（reason 入 error 字段）+ session 置 dead', () => {
      f.effects.markSessionDead('s1', 'Session process exited (code: 1)')

      const messages = f.chat.getMessages('s1')
      expect(messages).toHaveLength(1)
      expect(messages[0]!.role).toBe('assistant')
      expect(messages[0]!.status).toBe('error')
      // createAssistantErrorMessage 形态：reason 落 error 字段（渲染层读 error 展示），content 为空串
      expect(messages[0]!.error).toBe('Session process exited (code: 1)')
      expect(f.session.getList().find((s) => s.id === 's1')?.status).toBe('dead')
    })

    it('流式终结：分区尾 streaming assistant 被 finalize（error 态），不追加第二条错误消息', () => {
      const streaming: Message = {
        id: 'a-stream',
        role: 'assistant',
        content: '生成中',
        status: 'streaming',
        timestamp: 1,
      }
      f.chat.setMessages('s1', [streaming])

      f.effects.markSessionDead('s1', 'killed mid-stream')

      const messages = f.chat.getMessages('s1')
      expect(messages).toHaveLength(1)
      expect(messages[0]!.status).toBe('error')
      expect(messages[0]!.content).toBe('生成中')
      expect(messages.some((m) => m.status === 'streaming')).toBe(false)
    })

    it('订阅簿记失效：已建立订阅的 session exited 后本地两层簿记清空（events unsub 调用 + 订阅状态删除）', async () => {
      const sid = 's1'
      const unsub = vi.fn()
      const streamSubscribe = vi.fn(() => unsub)
      const deps: EnsureStreamSubDeps = {
        // [chat-flow-consistency D4 扩员] getHistory 形状补齐（本用例不触发）
        chatApi: {
          streamSubscribe,
          getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
        },
        // [W1 状态层] session.* 状态帧唯一落点（本用例不触达 session.* 状态帧，注入真实 factory 保持契约形状）
        liveState: createSessionLiveState(),
        toast: { error: vi.fn(), warning: vi.fn() },
        t: (k: string) => k,
      }
      ensureStreamSubscription(sid, f.chat, f.session, deps)
      await flushSubscribes(f.subscribeRpc)
      expect(getSubscriptionState(sid)?.subscribed).toBe(true)

      f.effects.markSessionDead(sid, 'boom')

      expect(getSubscriptionState(sid)).toBeUndefined()
      expect(unsub).toHaveBeenCalledTimes(1)
    })
  })

  describe('createLifecycleEffects.openRestoreWindow（恢复窗口订阅）', () => {
    let f: Fixture

    beforeEach(() => {
      resetChatModuleStateForTest()
      resetSubscriptionStates()
      f = makeFixture()
    })

    afterEach(() => {
      resetChatModuleStateForTest()
      resetSubscriptionStates()
      f.dispose()
    })

    it('立即重发 subscribeSession（sid 透传），settle 后 subscribed=true', async () => {
      f.effects.openRestoreWindow('s1')

      expect(f.subscribeRpc).toHaveBeenCalledTimes(1)
      expect(f.subscribeRpc).toHaveBeenCalledWith('s1', undefined)
      await flushSubscribes(f.subscribeRpc)
      expect(getSubscriptionState('s1')?.subscribed).toBe(true)
    })

    it('幂等：已 subscribed 再调不重发 RPC（subscribeSession 内建检查承接）', async () => {
      f.effects.openRestoreWindow('s1')
      await flushSubscribes(f.subscribeRpc)

      f.effects.openRestoreWindow('s1')

      expect(f.subscribeRpc).toHaveBeenCalledTimes(1)
    })

    it('RPC 失败不抛（fire-and-forget，链路自愈：subscribed 不标记、下次可重试）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      f.subscribeRpc.mockRejectedValueOnce(new Error('ws gone'))

      expect(() => f.effects.openRestoreWindow('s1')).not.toThrow()
      await flushSubscribes(f.subscribeRpc)

      expect(getSubscriptionState('s1')?.subscribed ?? false).toBe(false)
      warn.mockRestore()
    })

    it('deps.ensureStream 注入：走全套重建（events handler 重挂 + bus 订阅），不回落 bus 层 resubscribe', () => {
      // [remote-use-mobile-v2 A5] 注入态分流：恢复窗口订阅优先走壳侧全套重建原语——只发
      // bus 层 subscribe 时恢复帧到不了已退订的 events handler（见 lifecycle-effects.ts 注释）
      const ensureStream = vi.fn()
      const injected = makeFixture(ensureStream)

      injected.effects.openRestoreWindow('s1')

      expect(ensureStream).toHaveBeenCalledTimes(1)
      expect(ensureStream).toHaveBeenCalledWith('s1')
      // 分流断言：注入态不得再发 bus 层 subscribe（避免双订阅）
      expect(injected.subscribeRpc).not.toHaveBeenCalled()
      injected.dispose()
    })
  })

  describe('createLifecycleEffects.onSessionRestored（revive + 提示条 + 重订阅）', () => {
    let f: Fixture

    beforeEach(() => {
      resetChatModuleStateForTest()
      resetSubscriptionStates()
      f = makeFixture()
    })

    afterEach(() => {
      resetChatModuleStateForTest()
      resetSubscriptionStates()
      f.dispose()
    })

    it('revive 复位 dead 态 + 写入 restored 形态恢复提示条（注入文案）', () => {
      f.session.markDead('s1')
      expect(f.session.getList().find((s) => s.id === 's1')?.status).toBe('dead')

      f.effects.onSessionRestored('s1', { attempts: 2 })

      expect(f.session.getList().find((s) => s.id === 's1')?.status).toBe('idle')
      const notice = f.chat.getMessages('s1').at(-1)
      expect(notice?.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
      expect(notice?.details).toEqual({ variant: 'restored' })
      expect(notice?.content).toBe(NOTICES.restored)
      expect(notice?.liveOnly).toBe(true)
    })

    it('重订阅：restored 后重发 subscribe RPC（恢复 live 订阅 + 完整回放）', async () => {
      f.effects.onSessionRestored('s1', { attempts: 1 })

      expect(f.subscribeRpc).toHaveBeenCalledTimes(1)
      expect(f.subscribeRpc).toHaveBeenCalledWith('s1', undefined)
      await flushSubscribes(f.subscribeRpc)
      expect(getSubscriptionState('s1')?.subscribed).toBe(true)
    })

    it('invalidate 后的恢复窗口：markSessionDead 失效簿记 → onSessionRestored 重发不被幂等检查短路', async () => {
      f.effects.openRestoreWindow('s1')
      await flushSubscribes(f.subscribeRpc)
      expect(f.subscribeRpc).toHaveBeenCalledTimes(1)

      // pi 死亡 → exited 序列失效订阅簿记 → 自动恢复成功
      f.effects.markSessionDead('s1', 'crashed')
      f.effects.onSessionRestored('s1', { attempts: 1 })

      expect(f.subscribeRpc).toHaveBeenCalledTimes(2)
      await flushSubscribes(f.subscribeRpc)
      expect(getSubscriptionState('s1')?.subscribed).toBe(true)
    })
  })

  describe('createLifecycleEffects.onSessionRestoreFailed（willRetry 分流 + 熔断提示条）', () => {
    let f: Fixture

    beforeEach(() => {
      resetChatModuleStateForTest()
      resetSubscriptionStates()
      f = makeFixture()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
      resetChatModuleStateForTest()
      resetSubscriptionStates()
      f.dispose()
    })

    it('willRetry=true 中间失败：仅 log，不写提示条不触发订阅（重试由 runtime 自动续排）', () => {
      f.effects.onSessionRestoreFailed('s1', { attempts: 1, willRetry: true, reason: 'attach failed' })

      expect(f.chat.getMessages('s1')).toHaveLength(0)
      expect(f.subscribeRpc).not.toHaveBeenCalled()
    })

    it('willRetry=false 熔断：写入 restoreFailed 形态恢复提示条（注入文案）', () => {
      f.effects.onSessionRestoreFailed('s1', { attempts: 2, willRetry: false, reason: 'attach hard-fail' })

      const notice = f.chat.getMessages('s1').at(-1)
      expect(notice?.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
      expect(notice?.details).toEqual({ variant: 'restoreFailed' })
      expect(notice?.content).toBe(NOTICES.restoreFailed)
    })

    it('恢复提示条两形态齐备：restored 与 restoreFailed 先后写入各一条（连续提示条语义）', () => {
      f.effects.onSessionRestored('s1', { attempts: 1 })
      f.effects.onSessionRestoreFailed('s1', { attempts: 2, willRetry: false, reason: 'again' })

      const messages = f.chat.getMessages('s1')
      expect(messages).toHaveLength(2)
      expect(messages[0]!.details).toEqual({ variant: 'restored' })
      expect(messages[0]!.content).toBe(NOTICES.restored)
      expect(messages[1]!.details).toEqual({ variant: 'restoreFailed' })
      expect(messages[1]!.content).toBe(NOTICES.restoreFailed)
    })
  })
});

// ======== 来源：lru-unsubscribe.test.ts ========
describe("lru-unsubscribe", () => {
  /**
 * 等 fire-and-forget 的 subscribeSession（async）收敛（对齐 invalidate-stream-subscription
 * 同名 helper）：await 每个 subscribe RPC 的真实 promise settle，尾部两轮微任务排空续体链。
 * 排空不足只会让随后的 subscribed 正断言假红（可见），不产生假绿方向。
 */
  const flushSubscribes = async (subscribeRpc: ReturnType<typeof vi.fn>): Promise<void> => {
    for (const r of subscribeRpc.mock.results) {
      await Promise.race([r.value, Promise.resolve()])
    }
    await Promise.resolve()
    await Promise.resolve()
  }

  /**
 * 等 fire-and-forget 的 unsubscribe RPC（复合入口 void Promise.resolve(...).catch）收敛。
 * race 前先 .catch 垫平：race 按数组顺序取首个 settle——rejected RPC promise 若直接进
 * race 会以「数组序优先」判 rejected 使 await throw（失败形态与生产消费链无关，纯测试
 * 等待原语的自伤）；垫平后 race 只表达「已收敛」，失败本身由实现的 .catch 消费。
 */
  const flushUnsubscribes = async (unsubscribeRpc: ReturnType<typeof vi.fn>): Promise<void> => {
    for (const r of unsubscribeRpc.mock.results) {
      await Promise.race([r.value.then(() => undefined, () => undefined), Promise.resolve()])
    }
    await Promise.resolve()
    await Promise.resolve()
  }

  interface Fixture { // oe-exempt:20261003:test:测试 fixture 单实现常态
    chatStore: ChatStoreInstance
    hydrate: (sid: string) => void
    ensure: (sid: string) => void
    streamSubscribe: ReturnType<typeof vi.fn>
    subscribeRpc: ReturnType<typeof vi.fn>
    unsubscribeRpc: ReturnType<typeof vi.fn>
    evict: () => void
    dispose: () => void
  }

  function makeFixture(): Fixture {
    const scope = effectScope(true)
    const chatStore = scope.run(() => createChatStore())!
    const unsubs: Array<ReturnType<typeof vi.fn>> = []
    const streamSubscribe = vi.fn((_sid: string, _h: (m: ServerMessage) => void) => {
      const unsub = vi.fn()
      unsubs.push(unsub)
      return unsub
    })
    const subscribeRpc = vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
    setSubscriptionPorts({ subscribe: subscribeRpc, replay: vi.fn() })
    const unsubscribeRpc = vi.fn().mockResolvedValue(undefined)
    const deps: EnsureStreamSubDeps = {
      // [chat-flow-consistency D4 扩员] getHistory 形状补齐（本文件用例不触发）
      chatApi: {
        streamSubscribe,
        getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
      },
      // [W1 状态层] session.* 状态帧唯一落点（本用例不触达 session.* 状态帧，注入真实 factory 保持契约形状）
      liveState: createSessionLiveState(),
      toast: { error: vi.fn(), warning: vi.fn() },
      t: (k: string) => k,
    }
    const evictDeps: LruUnsubscribeDeps = { unsubscribe: unsubscribeRpc }
    return {
      chatStore,
      hydrate: (sid) => chatStore.hydrate(sid, []),
      ensure: (sid) =>
        ensureStreamSubscription(
          sid,
          chatStore,
          { applySnapshot: vi.fn(), revive: vi.fn() },
          deps,
        ),
      streamSubscribe,
      subscribeRpc,
      unsubscribeRpc,
      evict: () => evictLruWithUnsubscribe(chatStore, evictDeps),
      dispose: () => scope.stop(),
    }
  }

  /** 构造 count 个分区（hydrate 内部 lruTouch 记 recency），返回 sid 列表（插入序 = recency 旧→新） */
  function seedPartitions(f: Fixture, count: number, prefix = 's'): string[] {
    const sids = Array.from({ length: count }, (_, i) => `${prefix}${i}`)
    for (const sid of sids) f.hydrate(sid)
    return sids
  }

  describe('evictLruWithUnsubscribe（LRU 驱逐连带退订，D2）', () => {
    let f: Fixture

    beforeEach(() => {
      resetChatModuleStateForTest()
      _resetLruForTest()
      f = makeFixture()
    })

    afterEach(() => {
      f.dispose()
    })

    it('驱逐发生：被驱逐会话分区删除 + 订阅簿记失效 + 发出 session.unsubscribe RPC；保留区不退订', async () => {
      // 9 分区 > LRU_MAX_SESSIONS(8)：插入序最前的 s0 被驱逐（时间戳同毫秒并列时稳定排序保留插入序）
      const sids = seedPartitions(f, 9)
      f.ensure('s0')
      await flushSubscribes(f.subscribeRpc)
      expect(getSubscriptionState('s0')?.subscribed).toBe(true)
      expect(f.chatStore.isHydrated('s0')).toBe(true)

      f.evict()

      // 分区驱逐本体（evictIfNeeded 语义不变）：s0 分区 + hydrated 标记同删，保留区 8 个不动
      expect(f.chatStore.isHydrated('s0')).toBe(false)
      expect(f.chatStore.getMessages('s0')).toEqual([])
      for (const sid of sids.slice(1)) expect(f.chatStore.isHydrated(sid)).toBe(true)
      // 本地两层簿记失效（invalidateStreamSubscription 生效）
      expect(getSubscriptionState('s0')).toBeUndefined()
      // 服务端退订 RPC 以被驱逐 sid 发出，保留区 sid 零 RPC
      expect(f.unsubscribeRpc).toHaveBeenCalledTimes(1)
      expect(f.unsubscribeRpc).toHaveBeenCalledWith('s0')
    })

    it('驱逐发生：被驱逐会话 events handler 已退订（unsub 被调），保留区订阅不受影响', async () => {
      seedPartitions(f, 9)
      f.ensure('s0')
      f.ensure('s8')
      await flushSubscribes(f.subscribeRpc)
      const unsubS0 = f.streamSubscribe.mock.results[0]!.value as ReturnType<typeof vi.fn>
      const unsubS8 = f.streamSubscribe.mock.results[1]!.value as ReturnType<typeof vi.fn>

      f.evict()

      // s0 被驱逐 → 其 events 订阅退订；s8 在保留区 → 订阅簿记原样
      expect(unsubS0).toHaveBeenCalledTimes(1)
      expect(unsubS8).not.toHaveBeenCalled()
      expect(getSubscriptionState('s8')?.subscribed).toBe(true)
      expect(f.unsubscribeRpc).toHaveBeenCalledTimes(1)
      expect(f.unsubscribeRpc).toHaveBeenCalledWith('s0')
    })

    it('未超阈值：零驱逐零退订零 RPC（幂等安全）', async () => {
      seedPartitions(f, 8)
      f.ensure('s0')
      await flushSubscribes(f.subscribeRpc)

      f.evict()

      expect(f.unsubscribeRpc).not.toHaveBeenCalled()
      expect(getSubscriptionState('s0')?.subscribed).toBe(true)
      expect(f.streamSubscribe).toHaveBeenCalledTimes(1)
    })

    it('订阅了但分区不存在（从未 hydrate）：不进驱逐候选，不误伤其订阅', async () => {
      // 订阅簿记存在但无分区：候选集只含「有 messages 分区且有 recency 记录」的 sid，
      // ghost 无分区不进候选——其他分区超阈值触发的驱逐不退订它
      seedPartitions(f, 9)
      f.ensure('s-ghost')
      await flushSubscribes(f.subscribeRpc)

      f.evict()

      expect(getSubscriptionState('s-ghost')?.subscribed).toBe(true)
      expect(f.unsubscribeRpc).not.toHaveBeenCalledWith('s-ghost')
    })

    it('派生键（subagent 前缀）联动驱逐不产生退订 RPC（虚拟键无订阅簿记）', () => {
      // 主分区 s0 + 其 subagent 派生分区；s0 被驱逐时派生键联动同删，
      // 差集含 subagent:s0:child——退订 RPC 只发真实 sid，不发虚拟键
      f.hydrate('s0')
      f.chatStore.setMessages('subagent:s0:child', [])
      for (let i = 1; i < 9; i++) f.hydrate(`s${i}`)

      f.evict()

      expect(f.unsubscribeRpc).toHaveBeenCalledTimes(1)
      expect(f.unsubscribeRpc).toHaveBeenCalledWith('s0')
      expect(f.unsubscribeRpc).not.toHaveBeenCalledWith('subagent:s0:child')
    })

    it('unsubscribe RPC 失败不阻断驱逐链（fire-and-forget，簿记失效先于 RPC）', async () => {
      // deferred reject 形态：RPC 在途后失败（真实「发出后连接断」形态）。不用
      // mockImplementation(() => Promise.reject(...)) 同步 reject——tinyspy 记录链会复制出
      // 一条无消费者的 rejected promise 触发 unhandled rejection 假红
      let rejectRpc!: (e: unknown) => void
      f.unsubscribeRpc.mockImplementation(
        () => new Promise<void>((_, rej) => { rejectRpc = rej }),
      )
      seedPartitions(f, 9)
      f.ensure('s0')
      await flushSubscribes(f.subscribeRpc)

      expect(() => f.evict()).not.toThrow()
      // 簿记失效同步完成（先于 RPC 失败收敛）
      expect(getSubscriptionState('s0')).toBeUndefined()
      // RPC 在途后失败：仅 warn，不炸链不回滚
      rejectRpc(new Error('ws down'))
      await flushUnsubscribes(f.unsubscribeRpc)
      expect(f.unsubscribeRpc).toHaveBeenCalledTimes(1)
    })

    it('驱逐后退订：重切该会话时订阅可重建（invalidate 变体而非 clear 语义）', async () => {
      seedPartitions(f, 9)
      f.ensure('s0')
      await flushSubscribes(f.subscribeRpc)

      f.evict()
      expect(f.unsubscribeRpc).toHaveBeenCalledWith('s0')

      // 模拟重走 12 步切入链（步 5 ensureStreamSubscription）：不被残留检查短路
      f.ensure('s0')
      expect(f.streamSubscribe).toHaveBeenCalledTimes(2)
      await flushSubscribes(f.subscribeRpc)
      expect(f.subscribeRpc).toHaveBeenCalledTimes(2)
      expect(getSubscriptionState('s0')?.subscribed).toBe(true)
    })
  })
});

// ======== 来源：streaming-state-machine.test.ts ========
describe("streaming-state-machine", () => {
  /** 构造 streaming assistant 消息（可选 overrides） */
  function streamingAssistant(id: string, overrides: Partial<Message> = {}): Message {
    return { id, role: 'assistant', content: '', status: 'streaming', timestamp: 1, ...overrides }
  }

  /** 构造 bash 消息（role:'system' + bashExecution，生命周期独立管理） */
  function bashMsg(id: string): Message {
    return { id, role: 'system', content: '', status: 'streaming', timestamp: 1, bashExecution: {} as Message['bashExecution'] }
  }

  /** 构造 running toolCall */
  function runningToolCall(id: string) {
    return { id, toolName: 'read', input: {}, status: 'running' as const, startTime: 1 }
  }

  function makeMachine(opts: { subagentStreamPull?: (virtualId: string, recordId: string) => Promise<SubagentStreamStateSnapshot> } = {}) {
    // W10 D-1 容器范式：外层 Map 恒等稳定，每 sid 分区是独立 ShallowRef
    const messages = shallowRef<Map<string, ShallowRef<Message[]>>>(new Map())
    const occupancies = ref<Map<string, SessionOccupancyState>>(new Map())
    const retryStates = ref<Map<string, unknown>>(new Map())
    const pendingSend = ref<Set<string>>(new Set())
    const clearOccupancy = vi.fn<(sessionId: string) => void>()
    const sm = createStreamingStateMachine({
      messages,
      occupancies,
      retryStates,
      pendingSend,
      clearOccupancy,
      subagentStreamPull: opts.subagentStreamPull,
    })
    return { sm, messages, retryStates, clearOccupancy }
  }

  describe('applySubagentStreamDelta', () => {
    it('TC1 替换路径：已有 streaming assistant 时替换 content，text block 幂等不重复 push', () => {
      const { sm, messages } = makeMachine()
      const existing = streamingAssistant('a1', { content: 'old', contentBlocks: [{ type: 'text', refId: 'text' }] })
      messages.value = new Map([['subagent:x', shallowRef([existing])]])

      sm.applySubagentStreamDelta('subagent:x', ['line1', 'line2'])

      const after = messages.value.get('subagent:x')!.value
      expect(after).toHaveLength(1) // 不新增消息
      expect(after[0].id).toBe('a1') // 同一消息
      expect(after[0].content).toBe('line1\nline2') // 替换非追加
      expect(after[0].contentBlocks?.filter((b) => b.type === 'text')).toHaveLength(1) // text 块幂等
      expect(after[0].status).toBe('streaming')
    })

    it('TC2 新建路径：无 streaming assistant 时 push sa- 新消息', () => {
      const { sm, messages } = makeMachine()
      messages.value = new Map([['subagent:x', shallowRef([streamingAssistant('a1', { status: 'complete' })])]]) // 最后 assistant 已 complete

      sm.applySubagentStreamDelta('subagent:x', ['hello'])

      const after = messages.value.get('subagent:x')!.value
      expect(after).toHaveLength(2)
      const pushed = after[1]
      expect(pushed.role).toBe('assistant')
      expect(pushed.status).toBe('streaming')
      expect(pushed.id.startsWith('sa-')).toBe(true)
      expect(pushed.content).toBe('hello')
      expect(pushed.contentBlocks).toEqual([{ type: 'text', refId: 'text' }])
    })

    it('TC2b 空 session 时同样新建', () => {
      const { sm, messages } = makeMachine()

      sm.applySubagentStreamDelta('subagent:empty', ['x'])

      const after = messages.value.get('subagent:empty')!.value
      expect(after).toHaveLength(1)
      expect(after[0].id.startsWith('sa-')).toBe(true)
    })
  })

  describe('finalizeSubagentStream', () => {
    it('TC3 收尾 + sealed 幂等：streaming 翻 complete，重复调 no-op', () => {
      const { sm, messages } = makeMachine()
      messages.value = new Map([['subagent:x', shallowRef([streamingAssistant('a1')])]])

      sm.finalizeSubagentStream('subagent:x')
      expect(messages.value.get('subagent:x')!.value[0].status).toBe('complete')

      // 重复收尾：sealed 检查，不再变化（引用稳定）
      const snapshot = messages.value.get('subagent:x')!.value[0]
      sm.finalizeSubagentStream('subagent:x')
      expect(messages.value.get('subagent:x')!.value[0]).toBe(snapshot)
    })

    it('TC3b 无 streaming 实体时幂等 no-op（complete 消息不翻）', () => {
      const { sm, messages } = makeMachine()
      messages.value = new Map([['subagent:x', shallowRef([streamingAssistant('a1', { status: 'complete' })])]])

      sm.finalizeSubagentStream('subagent:x')

      expect(messages.value.get('subagent:x')!.value[0].status).toBe('complete')
    })

    it('TC3c 收尾写入产出结束时刻 endedAt（turn 聚合口径时间轴右端）；已有值不覆写', () => {
      const { sm, messages } = makeMachine()
      messages.value = new Map([['subagent:x', shallowRef([streamingAssistant('a1')])]])

      sm.finalizeSubagentStream('subagent:x')
      expect(messages.value.get('subagent:x')!.value[0].endedAt).toBeTypeOf('number')

      // 已有值不覆写（迟到收尾不覆写真实终点）
      const second = makeMachine()
      second.messages.value = new Map([['subagent:y', shallowRef([streamingAssistant('a1', { endedAt: 1234 })])]])
      second.sm.finalizeSubagentStream('subagent:y')
      expect(second.messages.value.get('subagent:y')!.value[0].endedAt).toBe(1234)
    })
  })

  describe('finalizeMessages', () => {
    it('TC4 error 收尾：streaming assistant → error + errorText 写 msg.error（content 不动）；running toolCall → error + endTime；bash 跳过', () => {
      const { sm, messages } = makeMachine()
      const assistant = streamingAssistant('a1', { content: 'partial', toolCalls: [runningToolCall('tc1')] })
      const bash = bashMsg('b1')
      messages.value = new Map([['s1', shallowRef([assistant, bash])]])

      sm.finalizeMessages('s1', 'error', 'boom')

      const after = messages.value.get('s1')!.value
      expect(after[0].status).toBe('error')
      // [M2 error-visibility] 追加形态双通道：content 保持崩溃前正文不动，errorText 写 msg.error（不拼 \n\n）
      expect(after[0].content).toBe('partial')
      expect(after[0].error).toBe('boom')
      expect(after[0].toolCalls![0].status).toBe('error')
      expect(after[0].toolCalls![0].endTime).toBeTypeOf('number') // 非 normal/aborted 设 endTime
      expect(after[1]).toBe(bash) // bash 消息原样跳过（引用不变）
    })

    it('TC2 追加形态空 content：errorText 仍写 msg.error，content 保持空（不兜底拼进 content）', () => {
      const { sm, messages } = makeMachine()
      // 流刚开始就崩（content 为空）：errorText 不兜底进 content，独立 error 字段承载
      messages.value = new Map([['s1', shallowRef([streamingAssistant('a1')])]])

      sm.finalizeMessages('s1', 'error', 'boom')

      const after = messages.value.get('s1')!.value[0]
      expect(after.status).toBe('error')
      expect(after.content).toBe('')
      expect(after.error).toBe('boom')
    })

    it('TC2b 非 assistant 消息不写 error 字段（user 提问不受 errorText 影响）', () => {
      const { sm, messages } = makeMachine()
      messages.value = new Map([['s1', shallowRef([{ id: 'u1', role: 'user' as const, content: '提问', status: 'complete' as const, timestamp: 1 }])]])

      sm.finalizeMessages('s1', 'error', 'boom')

      const after = messages.value.get('s1')!.value[0]
      expect(after.content).toBe('提问')
      expect(after.error).toBeUndefined()
    })

    it('TC4b 已终态 message 只收尾 toolCall；无 running toolCall 引用稳定', () => {
      const { sm, messages } = makeMachine()
      const completeWithRunningTc = streamingAssistant('a1', { status: 'complete', toolCalls: [runningToolCall('tc1')] })
      const completeNoTc = streamingAssistant('a2', { status: 'complete' })
      messages.value = new Map([['s1', shallowRef([completeWithRunningTc, completeNoTc])]])

      sm.finalizeMessages('s1', 'disconnect')

      const after = messages.value.get('s1')!.value
      expect(after[0].toolCalls![0].status).toBe('end_not_received') // 非 error reason → end_not_received
      expect(after[0].toolCalls![0].endTime).toBeTypeOf('number')
      expect(after[1]).toBe(completeNoTc) // 无 running toolCall 保持引用稳定
    })

    it('TC4c stream_error 收尾：streaming → error；toolCall → error + endTime', () => {
      const { sm, messages } = makeMachine()
      const assistant = streamingAssistant('a1', { content: 'partial', toolCalls: [runningToolCall('tc1')] })
      messages.value = new Map([['s1', shallowRef([assistant])]])

      sm.finalizeMessages('s1', 'stream_error')

      const after = messages.value.get('s1')!.value[0]
      expect(after.status).toBe('error') // stream_error ∈ isErrorReason
      expect(after.toolCalls![0].status).toBe('error') // stream_error ∈ tcIsError
      expect(after.toolCalls![0].endTime).toBeTypeOf('number') // 非 normal/aborted 设 endTime
    })

    it('TC4d disconnect 收尾：streaming → error；toolCall → end_not_received + endTime（restart 同族）', () => {
      const { sm, messages } = makeMachine()
      const assistant = streamingAssistant('a1', { content: 'partial', toolCalls: [runningToolCall('tc1')] })
      messages.value = new Map([['s1', shallowRef([assistant])]])

      sm.finalizeMessages('s1', 'disconnect')

      const after = messages.value.get('s1')!.value[0]
      expect(after.status).toBe('error') // disconnect ∈ isErrorReason（restart 同分支）
      expect(after.toolCalls![0].status).toBe('end_not_received') // 非 error/stream_error → end_not_received
      expect(after.toolCalls![0].endTime).toBeTypeOf('number')
    })

    // [M2 error-visibility 不变量] 凡 streaming 收尾口产出 error 终态的 assistant 消息，
    // error 字段必非空——渲染层以「error 有无」区分纯 error（整条 danger）与追加形态
    // （正文原色 + error 独立 danger 行）。errorText 缺失路径（断连 / 重启收尾
    // 不带文案）若无兜底，崩溃前正常正文会被误判纯 error 整条染红。
    it('TC4e errorText 缺失的 error 类收尾：error 字段写 reason 兜底文案（追加形态不变量）', () => {
      const { sm, messages } = makeMachine()
      const assistant = streamingAssistant('a1', { content: 'partial' })
      messages.value = new Map([['s1', shallowRef([assistant])]])

      for (const reason of ['disconnect', 'restart'] as const) {
        // 重置回 streaming 再收尾（sealed 检查：终态消息二次 finalize 不重写）
        messages.value = new Map([['s1', shallowRef([streamingAssistant('a1', { content: 'partial' })])]])
        sm.finalizeMessages('s1', reason)
        const after = messages.value.get('s1')!.value[0]
        expect(after.status).toBe('error')
        expect(after.content).toBe('partial') // 崩溃前正文不动
        expect(typeof after.error).toBe('string')
        expect(after.error!.length).toBeGreaterThan(0) // 兜底文案非空——不会误判纯 error
      }
    })

    it('TC4f errorText 空串视同缺失：error 字段走兜底（空 error 同样破坏形态判定信号）', () => {
      const { sm, messages } = makeMachine()
      messages.value = new Map([['s1', shallowRef([streamingAssistant('a1', { content: 'partial' })])]])

      sm.finalizeMessages('s1', 'error', '')

      const after = messages.value.get('s1')!.value[0]
      expect(after.status).toBe('error')
      expect(after.error).toBe('会话出错，回复已中断。')
    })

    it('TC4g 非 error reason 不写兜底：normal 收尾 error 字段保持 undefined', () => {
      const { sm, messages } = makeMachine()
      messages.value = new Map([['s1', shallowRef([streamingAssistant('a1', { content: 'full' })])]])

      sm.finalizeMessages('s1', 'normal')

      const after = messages.value.get('s1')!.value[0]
      expect(after.status).toBe('complete')
      expect(after.error).toBeUndefined()
    })

    it('TC4h 收尾写入产出结束时刻 endedAt（turn 聚合时间轴右端）；已有值不覆写（不迟到覆写真实终点）', () => {
      const { sm, messages } = makeMachine()
      messages.value = new Map([['s1', shallowRef([
        streamingAssistant('a1'),
        streamingAssistant('a2', { endedAt: 777 }),
      ])]])

      sm.finalizeMessages('s1', 'aborted')

      const after = messages.value.get('s1')!.value
      expect(after[0].endedAt).toBeTypeOf('number')
      expect(after[1].endedAt).toBe(777)
    })

    it('TC5 normal 收尾：streaming → complete；toolCall → end_not_received 且不设 endTime；无 errorText 不追加', () => {
      const { sm, messages } = makeMachine()
      const assistant = streamingAssistant('a1', { content: 'full', toolCalls: [runningToolCall('tc1')] })
      messages.value = new Map([['s1', shallowRef([assistant])]])

      sm.finalizeMessages('s1', 'normal')

      const after = messages.value.get('s1')!.value[0]
      expect(after.status).toBe('complete')
      expect(after.content).toBe('full') // 无 errorText 不写 error 字段
      expect(after.error).toBeUndefined()
      expect(after.toolCalls![0].status).toBe('end_not_received')
      expect(after.toolCalls![0].endTime).toBeUndefined() // normal/aborted 不设 endTime
    })

    it('TC5b 空 session no-op（不抛错不写）', () => {
      const { sm, messages } = makeMachine()
      sm.finalizeMessages('ghost', 'error')
      expect(messages.value.has('ghost')).toBe(false)
    })
  })

  describe('collectFinalizeCandidates', () => {
    it('TC6 并集：messages ∪ occupancy(compacting/handingOff) ∪ retry ∪ pendingSend（[u5a] queue 源 / [§6 裁决表行] handingOff Set 源已退役）', () => {
      // 5 源各贡献一个独有 sid，验证并集不漏（c 经 occupancy 第四维 handingOff 贡献）
      const messages = shallowRef<Map<string, ShallowRef<Message[]>>>(new Map([['a', shallowRef([streamingAssistant('a1')])]]))
      const occupancies = ref<Map<string, SessionOccupancyState>>(new Map([
        ['b', { turn: 'idle', compacting: true, bash: false }],
        ['c', { turn: 'idle', compacting: false, bash: false, handingOff: true }],
      ]))
      const retryStates = ref<Map<string, unknown>>(new Map([['d', {}]]))
      const pendingSend = ref<Set<string>>(new Set(['e']))
      const sm = createStreamingStateMachine({
        messages,
        occupancies,
        retryStates,
        pendingSend,
        clearOccupancy: vi.fn(),
      })

      const candidates = sm.collectFinalizeCandidates()
      expect([...candidates].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    })
  })

  describe('clearIndependentTransient', () => {
    it('TC7 清 occupancy 分区（含 handingOff 维）+ retry 删除；无 sid 时 no-op（[u5a] queue 维度已退役）', () => {
      const { sm, retryStates, clearOccupancy } = makeMachine()
      retryStates.value = new Map([['s1', { attempt: 1 }]])

      sm.clearIndependentTransient('s1')

      // handingOff 复位随 occupancy 分区删除一并成立（membership = 第四维，无独立 setHandingOff）
      expect(clearOccupancy).toHaveBeenCalledWith('s1')
      expect(retryStates.value.has('s1')).toBe(false)

      // 无该 sid 的态：不再清（no-op 幂等）
      const retrySnapshot = retryStates.value
      sm.clearIndependentTransient('ghost')
      expect(retryStates.value).toBe(retrySnapshot)
    })
  })

  // ── [B2 subagent-stream-chunk §4.3] 增量 chunk 消费状态机 ──────────────────────────
  // 契约权威 = 设计文档 §4.3：chunk 处理优先序四步 / 拉取响应按序判定四分支 /
  // 跨消息边界（推进重置 + 丢旧 buffer）/ 水位回放 / sealedMsgSeq 单调水位 /
  // 在途拉取 settle 即清（pullDedup factory，C-data-18）。分区状态经 _chunkPartitionsForTest
  // 只读断言、在途态经 _pullDedupForTest.has(key) 断言（行为断言为主，buffer / 在途槽
  // 无消息派生视图，状态读口是唯一观测点）。

  /** chunk 状态机测试夹具：注入受控拉取执行器（deferred 手动 resolve/reject 控制时序） */
  function makeChunkMachine() {
    const pullCalls: Array<{ virtualId: string; recordId: string; response: Promise<SubagentStreamStateSnapshot> }> = []
    let resolvePull: ((response: SubagentStreamStateSnapshot) => void) | undefined
    let rejectPull: ((reason: unknown) => void) | undefined
    const { sm, messages } = makeMachine({
      subagentStreamPull: (virtualId: string, recordId: string) => {
        const response = new Promise<SubagentStreamStateSnapshot>((resolve, reject) => {
          resolvePull = resolve
          rejectPull = reject
        })
        pullCalls.push({ virtualId, recordId, response })
        return response
      },
    })
    const VID = subagentVirtualId('s1', 'bg-1')
    const RID = 'bg-1'
    /** 分区状态只读断言口（buffer / sealedMsgSeq 无消息派生视图，唯一观测点） */
    const partition = () => sm._chunkPartitionsForTest.get(VID)!.get(RID)!
    /** (VID, RID) 在途拉取观测口（等价原分区 pullInFlight 字段：settle 即清由 factory 承接） */
    const pullInFlight = () => sm._pullDedupForTest.has(`${VID}::${RID}`)
    /** 拉取执行器全部在微任务中续跑（.then/.catch），flush 两拍保证响应应用完成 */
    const flush = async () => {
      await Promise.resolve()
      await Promise.resolve()
    }
    return { sm, messages, VID, RID, partition, pullInFlight, pullCalls, flush, resolvePull: () => resolvePull, rejectPull: () => rejectPull }
  }

  describe('applySubagentStreamChunk（§4.3 chunk 处理优先序）', () => {
    it('TC-C1+2 干净起步（新建分区 + deltaSeq=0）与顺序追加（== expected，O(1) 拼接非全量替换）', () => {
      const { sm, messages, VID, RID, partition } = makeChunkMachine()

      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      let after = messages.value.get(VID)!.value
      expect(after).toHaveLength(1)
      expect(after[0].id.startsWith('sa-')).toBe(true)
      expect(after[0].status).toBe('streaming')
      expect(after[0].content).toBe('a')

      sm.applySubagentStreamChunk(VID, RID, 1, 1, 'b')
      after = messages.value.get(VID)!.value
      expect(after).toHaveLength(1) // 追加不新建
      expect(after[0].content).toBe('ab')

      expect(partition().msgSeq).toBe(1)
      expect(partition().expectedDeltaSeq).toBe(2)
      expect(partition().sealedMsgSeq).toBe(0) // 干净起步不拉取（无在途、无缓冲）
      expect(partition().buffer).toHaveLength(0)
    })

    it('TC-C3+4 失步（> expected）入 buffer 并触发拉取；在途去重（同 record 至多一个在途拉取）', () => {
      const { sm, messages, VID, RID, partition, pullInFlight, pullCalls } = makeChunkMachine()

      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 跳过 deltaSeq=1 → 失步
      expect(partition().buffer).toEqual([{ msgSeq: 1, deltaSeq: 2, delta: 'x' }])
      expect(pullInFlight()).toBe(true)
      expect(pullCalls).toHaveLength(1)
      expect(pullCalls[0]).toMatchObject({ virtualId: VID, recordId: RID })

      sm.applySubagentStreamChunk(VID, RID, 1, 3, 'y') // 在途拉取未归：只入 buffer 不再拉
      expect(partition().buffer).toHaveLength(2)
      expect(pullCalls).toHaveLength(1)
      expect(messages.value.get(VID)!.value[0].content).toBe('a') // 失步 chunk 不上屏
    })

    it('TC-C4b 丢弃（< expected）：已含于拉取结果的 chunk 丢弃，不上屏不触发拉取', async () => {
      const { sm, messages, VID, RID, partition, pullCalls, resolvePull, flush } = makeChunkMachine()

      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 失步 → 拉取
      resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 3, lines: ['a', 'm1', 'm2', 'm3'] })
      await flush()

      // 响应已含 deltaSeq ≤ 3 的全部内容；expected = 4
      expect(partition().expectedDeltaSeq).toBe(4)
      expect(messages.value.get(VID)!.value[0].content).toBe('a\nm1\nm2\nm3')
      expect(pullCalls).toHaveLength(1)

      const before = messages.value.get(VID)!.value[0]
      sm.applySubagentStreamChunk(VID, RID, 1, 1, 'late') // < expected → 丢弃
      expect(messages.value.get(VID)!.value[0]).toBe(before) // 引用稳定（零变化）
      expect(pullCalls).toHaveLength(1)
    })

    it('TC-C6 跨消息边界（msgSeq 推进）：开新 streaming 消息 + expectedDeltaSeq 重置 + 丢旧 buffer', () => {
      const { sm, messages, VID, RID, partition } = makeChunkMachine()

      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 失步入 buffer + 拉取在途
      sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b') // 边界推进：旧 buffer 丢弃、expected 重置

      const after = messages.value.get(VID)!.value
      expect(after).toHaveLength(2)
      expect(after[0].status).toBe('complete') // 旧消息实体就地收尾（终态由 entry 链权威覆盖）
      expect(after[0].content).toBe('a')
      expect(after[1].status).toBe('streaming')
      expect(after[1].content).toBe('b') // 新消息增量并入新实体

      expect(partition().msgSeq).toBe(2)
      expect(partition().expectedDeltaSeq).toBe(1) // 重置 0 后被 (2,0) 推进
      expect(partition().buffer).toHaveLength(0) // 旧 buffer 丢弃（旧消息已定稿，残留无意义）
    })

    it('TC-C6b 边界推进不重置 sealedMsgSeq（单调水位）；后续消息正常追加', () => {
      const { sm, VID, RID, partition } = makeChunkMachine()
      sm.sealSubagentStream(VID, RID, 1)
      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b')

      expect(partition().msgSeq).toBe(2)
      expect(partition().sealedMsgSeq).toBe(1) // 边界推进不触碰水位
    })

    it('TC-C7 跨多条消息前向跳号：一次推进到目标 msgSeq（中间消息全文由 entry 权威链承载）', () => {
      const { sm, messages, VID, RID, partition } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID, RID, 3, 0, 'c') // 1 → 3 跨一条

      const after = messages.value.get(VID)!.value
      expect(partition().msgSeq).toBe(3)
      expect(after).toHaveLength(2)
      expect(after[1].content).toBe('c')
    })

    it('TC-C8 陈旧 chunk（msgSeq < 当前）丢弃：不改状态不上屏不拉取（契约收窄，见实现注记）', () => {
      const { sm, messages, VID, RID, partition, pullCalls } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b')
      const before = messages.value.get(VID)!.value

      sm.applySubagentStreamChunk(VID, RID, 1, 9, 'stale')

      expect(messages.value.get(VID)!.value).toBe(before)
      expect(partition().msgSeq).toBe(2)
      expect(partition().expectedDeltaSeq).toBe(1)
      expect(partition().buffer).toHaveLength(0)
      expect(pullCalls).toHaveLength(0)
    })

    it('TC-N1 未注入拉取执行器：失步入 buffer、不抛错、无在途标记（core 单测缺省形态）', () => {
      const { sm } = makeMachine() // 无 subagentStreamPull
      const VID2 = subagentVirtualId('s1', 'bg-2')
      const RID2 = 'bg-2'

      expect(() => sm.applySubagentStreamChunk(VID2, RID2, 1, 5, 'x')).not.toThrow()
      expect(sm._chunkPartitionsForTest.get(VID2)!.get(RID2)!.buffer).toEqual([{ msgSeq: 1, deltaSeq: 5, delta: 'x' }])
      expect(sm._pullDedupForTest.has(`${VID2}::${RID2}`)).toBe(false)
    })
  })

  describe('applySubagentStreamState（§4.3 拉取响应按序判定四分支）', () => {
    it('TC-R1 分支 1（≤ sealedMsgSeq → 已定稿丢弃）：晚到响应不复活定稿消息，出口清在途槽', async () => {
      const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
      sm.sealSubagentStream(VID, RID, 1)
      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a') // 常规流式（expected=1）
      sm.applySubagentStreamChunk(VID, RID, 1, 3, 'x') // 失步 → 拉取在途
      expect(pullInFlight()).toBe(true)
      const before = messages.value.get(VID)!.value

      resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 5, lines: ['final', 'text'] })
      await flush()

      expect(messages.value.get(VID)!.value).toBe(before) // 零写入：定稿消息的全文响应不复活内容
      expect(pullInFlight()).toBe(false) // settle 即清（factory）
    })

    it('TC-R2 分支 2（< 当前 msgSeq → 陈旧响应丢弃）：RPC 应答与广播推进交错窗口防护', async () => {
      const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 1, 5, 'x') // 失步 → 拉取在途
      sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b') // 广播先推进边界（buffer 丢弃）
      resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 9, lines: ['stale'] })
      await flush()

      const after = messages.value.get(VID)!.value
      expect(after).toHaveLength(2) // 陈旧响应未产生任何消息写
      expect(after[1].content).toBe('b')
      expect(partition().msgSeq).toBe(2)
      expect(partition().expectedDeltaSeq).toBe(1) // 未被响应重置
      expect(pullInFlight()).toBe(false)
    })

    it('TC-R3 found:false（协议形态 msgSeq=0）→ 零写入出口清在途槽：经分支 1 等效拦截（设计注记「判定 1 通常已拦截」）', async () => {
      const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 失步 → 拉取在途
      // 线上回执形态：found=false 时 msgSeq 无流式语义恒 0（shared 协议注释）——
      // 0 <= sealedMsgSeq(0) 在分支 1 即拦截，与分支 3 同一出口（不动作 + 清在途槽）
      resolvePull()!({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
      await flush()

      expect(messages.value.get(VID)!.value[0].content).toBe('a') // 内容不动
      expect(partition().msgSeq).toBe(1) // 水位状态不动（含 lastDeltaSeq 未应用）
      expect(partition().expectedDeltaSeq).toBe(1)
      expect(pullInFlight()).toBe(false)
    })

    it('TC-R3b 分支 3 本体（found:false 且 msgSeq 超前，白盒覆盖分支臂）→ 不动作，出口清在途槽', async () => {
      const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 2, 0, 'b') // msgSeq=2, expected=1
      sm.applySubagentStreamChunk(VID, RID, 2, 3, 'x') // 失步 → 拉取在途
      // 非线上形态（found=false 恒 msgSeq=0）：msgSeq 超前的 found:false 仅可达分支 3 本体
      resolvePull()!({ found: false, msgSeq: 5, lastDeltaSeq: 0, lines: [] })
      await flush()

      expect(messages.value.get(VID)!.value[0].content).toBe('b') // 不动作
      expect(partition().msgSeq).toBe(2) // 状态未被响应重置
      expect(partition().expectedDeltaSeq).toBe(1)
      expect(pullInFlight()).toBe(false)
    })

    it('TC-R4 分支 4（判定通过，含跨边界恢复）：全量替换 + 状态按响应重置（重置即边界推进）', async () => {
      const { sm, messages, VID, RID, partition, pullInFlight, resolvePull, flush } = makeChunkMachine()
      // 接入拉取（触发点 ①）：无任何 chunk 时经 requestSubagentStreamState 主动拉
      sm.requestSubagentStreamState(VID, RID)
      expect(pullInFlight()).toBe(true)

      resolvePull()!({ found: true, msgSeq: 3, lastDeltaSeq: 1, lines: ['l0', 'l1'] })
      await flush()

      const after = messages.value.get(VID)!.value
      expect(after).toHaveLength(1)
      expect(after[0].status).toBe('streaming')
      expect(after[0].content).toBe('l0\nl1') // 复用 applySubagentStreamDelta 全量替换
      expect(partition().msgSeq).toBe(3) // 按响应重置（超前当前 0 = 跨边界恢复）
      expect(partition().expectedDeltaSeq).toBe(2) // lastDeltaSeq + 1
      expect(partition().sealedMsgSeq).toBe(0) // 水位不受响应影响
      expect(pullInFlight()).toBe(false)
    })

    it('TC-R4b requestSubagentStreamState 在途去重：并发触发合并为单次拉取', () => {
      const { sm, VID, RID, pullCalls } = makeChunkMachine()
      sm.requestSubagentStreamState(VID, RID)
      sm.requestSubagentStreamState(VID, RID)
      sm.requestSubagentStreamState(VID, RID)
      expect(pullCalls).toHaveLength(1)
    })

    it('TC-R5 degraded 透传（M3 D6）：true 置位 / 缺省不置位 / found:false 降级回执也保留 / 非降级快照覆盖回 false', () => {
      const { sm, VID, RID, partition } = makeChunkMachine()

      // 未降级形态：协议「非降级不带本字段」→ 不置位
      sm.applySubagentStreamState(VID, RID, { found: true, msgSeq: 1, lastDeltaSeq: 0, lines: ['a'] })
      expect(sm.isSubagentStreamDegraded(VID, RID)).toBe(false)
      expect(partition().degraded).toBe(false)

      // 降级快照：透传到流状态（分区位 + 读口）
      sm.applySubagentStreamState(VID, RID, { found: true, msgSeq: 2, lastDeltaSeq: 0, lines: ['b'], degraded: true })
      expect(sm.isSubagentStreamDegraded(VID, RID)).toBe(true)
      expect(partition().degraded).toBe(true)

      // found:false + degraded（线上形态 msgSeq=0，会走分支 1 早退）：降级位仍须采集
      sm.applySubagentStreamState(VID, RID, { found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [], degraded: true })
      expect(sm.isSubagentStreamDegraded(VID, RID)).toBe(true)
      expect(partition().msgSeq).toBe(2) // 内容水位不被 found:false 回执推进

      // 新 tee 的非降级快照：查询快照即当前事实，覆盖回 false
      sm.applySubagentStreamState(VID, RID, { found: true, msgSeq: 2, lastDeltaSeq: 0, lines: ['b'] })
      expect(sm.isSubagentStreamDegraded(VID, RID)).toBe(false)
    })

    it('TC-R6 degraded 读口响应式：位翻转触发下游 computed 重算，分区清除回落 false', () => {
      const { sm, VID, RID } = makeChunkMachine()
      const degraded = computed(() => sm.isSubagentStreamDegraded(VID, RID))
      expect(degraded.value).toBe(false)

      sm.applySubagentStreamState(VID, RID, { found: true, msgSeq: 1, lastDeltaSeq: 0, lines: ['a'], degraded: true })
      expect(degraded.value).toBe(true) // 分区表非响应式，依赖版本号 bump

      sm.clearSubagentChunkState(VID)
      expect(degraded.value).toBe(false)
    })
  })

  describe('水位回放（buffer replay，§4.3 分支 4 + 去重即水位）', () => {
    it('TC-P1 > 水位按序回放：回放 chunk 走同一管线追加，回放后 expected 对齐续传', async () => {
      const { sm, messages, VID, RID, partition, resolvePull, flush } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID, RID, 1, 2, 'c2') // 失步入 buffer（跳过 1）

      resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 1, lines: ['a', 'mid'] })
      await flush()

      // 全文替换为水位处全文 + 回放 buffer 中 (1,2)（> 水位 expected=2）
      expect(messages.value.get(VID)!.value[0].content).toBe('a\nmidc2')
      expect(partition().expectedDeltaSeq).toBe(3)

      sm.applySubagentStreamChunk(VID, RID, 1, 3, 'd3') // 回放后对齐，续传追加
      expect(messages.value.get(VID)!.value[0].content).toBe('a\nmidc2d3')
    })

    it('TC-P2 ≤ 水位回放丢弃：响应已含的失步 chunk 回放时被水位过滤，不重复不缺段', async () => {
      const { sm, messages, VID, RID, partition, pullCalls, resolvePull, flush } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a') // expected → 1
      sm.applySubagentStreamChunk(VID, RID, 1, 2, 'c2') // 跳过 1 → 失步入 buffer + 拉取
      expect(pullCalls).toHaveLength(1)

      // 响应含到 deltaSeq=2（水位=2）：(1,2) 的内容已在全文内
      resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 2, lines: ['a', 'b', 'c'] })
      await flush()

      // 回放 (1,2)：deltaSeq 2 < expected 3 → 丢弃（≤ 水位），全文不重复追加
      expect(messages.value.get(VID)!.value[0].content).toBe('a\nb\nc')
      expect(partition().expectedDeltaSeq).toBe(3)
      expect(partition().buffer).toHaveLength(0)
      expect(pullCalls).toHaveLength(1)
    })

    it('TC-P2b 回放中再遇跳号 → 再次拉取（在途槽已随响应 settle 清，再触发 run 新槽）', async () => {
      const { sm, messages, VID, RID, partition, pullInFlight, pullCalls, resolvePull, flush } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 1, 2, 'c2') // 失步（跳过 0/1）
      sm.applySubagentStreamChunk(VID, RID, 1, 5, 'f5') // 继续失步（同 record 单在途）
      expect(pullCalls).toHaveLength(1)

      resolvePull()!({ found: true, msgSeq: 1, lastDeltaSeq: 1, lines: ['a', 'mid'] })
      await flush()

      // 回放：(1,2) == expected 追加；(1,5) 仍跳号（expected=3）→ 入 buffer 并再次拉取
      expect(messages.value.get(VID)!.value[0].content).toBe('a\nmidc2')
      expect(partition().buffer).toEqual([{ msgSeq: 1, deltaSeq: 5, delta: 'f5' }])
      expect(pullCalls).toHaveLength(2)
      expect(pullInFlight()).toBe(true) // 回放触发的拉取 run 新在途槽
    })

    it('TC-F1 拉取失败（executor reject）→ settle 清在途槽、保持失步态，下一条 chunk 重新触发（事件驱动无定时器）', async () => {
      const { sm, VID, RID, partition, pullInFlight, pullCalls, rejectPull, flush } = makeChunkMachine()
      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID, RID, 1, 2, 'x') // 失步 → 拉取
      rejectPull()!(new Error('connection closed'))
      await flush()

      expect(pullInFlight()).toBe(false)
      expect(partition().buffer).toHaveLength(1) // 保持失步态（缓冲保留）

      sm.applySubagentStreamChunk(VID, RID, 1, 3, 'y') // 下一条失步 chunk → 重新触发
      expect(pullCalls).toHaveLength(2)
      expect(pullInFlight()).toBe(true)
    })
  })

  describe('sealedMsgSeq 单调水位（§4.3）', () => {
    it('TC-S1 单调推进不回退：小额 msgSeq 置位不改水位，分支 1 判定按最高已定稿', async () => {
      const { sm, VID, RID, partition, resolvePull, flush } = makeChunkMachine()
      sm.sealSubagentStream(VID, RID, 3)
      sm.sealSubagentStream(VID, RID, 1) // 迟到的低序号清除消息
      expect(partition().sealedMsgSeq).toBe(3)

      sm.applySubagentStreamState(VID, RID, { found: true, msgSeq: 3, lastDeltaSeq: 0, lines: ['old'] })
      await flush()
      expect(partition().msgSeq).toBe(0) // 分支 1 丢弃：状态未被响应推进
    })

    it('TC-S3 无分区清除消息（缺前缀晚接入）先落水位：后续接入拉取响应被分支 1 拦截', async () => {
      const { sm, messages, VID, RID, partition, pullInFlight, pullCalls, resolvePull, flush } = makeChunkMachine()
      sm.sealSubagentStream(VID, RID, 5) // 清除消息先于任何 chunk 到达（分区据置位创建）
      expect(partition().sealedMsgSeq).toBe(5)

      sm.requestSubagentStreamState(VID, RID) // 接入拉取（触发点 ①）
      resolvePull()!({ found: true, msgSeq: 5, lastDeltaSeq: 9, lines: ['sealed'] })
      await flush()

      expect(messages.value.has(VID)).toBe(false) // 已定稿内容不复活
      expect(pullInFlight()).toBe(false)
      expect(pullCalls).toHaveLength(1)
    })

    it('TC-S4 clearSubagentChunkState / clearSubagentChunkStateForSession 分区生命周期清除', () => {
      const { sm, VID, RID } = makeChunkMachine()
      const VID2 = subagentVirtualId('s1', 'bg-2')
      const VID_OTHER = subagentVirtualId('s2', 'bg-9')
      sm.applySubagentStreamChunk(VID, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID2, RID, 1, 0, 'a')
      sm.applySubagentStreamChunk(VID_OTHER, RID, 1, 0, 'a')

      sm.clearSubagentChunkState(VID) // record/分区级：整 vid 名下
      expect(sm._chunkPartitionsForTest.has(VID)).toBe(false)

      sm.clearSubagentChunkStateForSession('s1') // session 级：按三段式中段归属
      expect(sm._chunkPartitionsForTest.has(VID2)).toBe(false)
      expect(sm._chunkPartitionsForTest.has(VID_OTHER)).toBe(true) // 其他 session 分区不受影响

      // 清除后同键 chunk 从干净状态重建（msgSeq 回 0，边界推进正常）
      sm.applySubagentStreamChunk(VID_OTHER, RID, 1, 0, 'fresh')
      expect(sm._chunkPartitionsForTest.get(VID_OTHER)!.get(RID)!.msgSeq).toBe(1)
    })
  })
});

// ======== 来源：subagent-entries.test.ts ========
describe("subagent-entries", () => {
  const VIRTUAL_ID = 'subagent:main-1:rec-1'

  /** 构造独立 store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离）。 */
  function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
    const scope = effectScope(true)
    const store = scope.run(() => createChatStore())!
    return { store, dispose: () => scope.stop() }
  }

  function messageEntry(message: PiMessageEntry['message']): PiMessageEntry {
    return { type: 'message', parentId: null, timestamp: '2026-08-25T00:00:00.000Z', message }
  }

  function toolCallForm(overrides: Partial<PiToolCallEntryForm> = {}): PiToolCallEntryForm {
    return {
      type: 'toolCall',
      parentId: null,
      timestamp: '2026-08-25T00:00:00.000Z',
      toolCallId: 'tc-1',
      toolName: 'read',
      arguments: { path: '/x' },
      ...overrides,
    }
  }

  describe('applySubagentEntries（E-4 entry 帧消费）', () => {
    let sut: { store: ChatStoreInstance; dispose: () => void }

    beforeEach(() => {
      sut = makeStore()
    })
    afterEach(() => {
      sut.dispose()
    })

    it('帧到达 → 虚拟分区出现 entry 派生消息（reducer 派生视图，user/assistant 顺序保留）', () => {
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({ role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1000 }),
        messageEntry({ role: 'assistant', content: [{ type: 'text', text: '产出' }], timestamp: 2000 }),
      ])

      const messages = sut.store.getMessages(VIRTUAL_ID)
      expect(messages).toHaveLength(2)
      // user 消息 content 保留 Segment[] 原样（apply-entry user 分支语义，appendUser 注释同源）
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: '任务' }],
        status: 'complete',
      })
      expect(messages[1]).toMatchObject({ role: 'assistant', content: '产出', status: 'complete' })
    })

    it('toolCall overlay → running toolCall 挂末位 assistant；toolResult entry 到达后基线回填终态', () => {
      const assistantWithTool = messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
        timestamp: 1000,
      })
      // 帧 1：assistant 定稿（基线 toolCalls 提取版 status:'completed'）
      sut.store.applySubagentEntries(VIRTUAL_ID, [assistantWithTool])
      // 帧 2：tool_execution_start → running overlay（修正重放视角的终态假设）
      sut.store.applySubagentEntries(VIRTUAL_ID, [toolCallForm()])
      let messages = sut.store.getMessages(VIRTUAL_ID)
      expect(messages[0]?.toolCalls?.[0]).toMatchObject({ id: 'tc-1', status: 'running' })

      // 帧 3：tool_execution_end → toolResult entry 喂 reducer 回填 → 基线派生视图覆盖 running
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file body' }],
          timestamp: 3000,
        }),
      ])
      messages = sut.store.getMessages(VIRTUAL_ID)
      expect(messages[0]?.toolCalls?.[0]).toMatchObject({ id: 'tc-1', status: 'completed', output: 'file body' })
    })

    it('同帧 [toolResult, toolCall] 交错 → toolResult 先派生视图，overlay 不把终态倒退回 running', () => {
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
          timestamp: 1000,
        }),
      ])
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'done' }],
          timestamp: 3000,
        }),
        toolCallForm(),
      ])
      const messages = sut.store.getMessages(VIRTUAL_ID)
      expect(messages[0]?.toolCalls?.[0]).toMatchObject({ status: 'completed', output: 'done' })
    })

    it('delta 中间态被 entry 定稿覆盖（§6.2：sa-* streaming 实体被基线派生视图取代）', () => {
      // delta 打字机：streaming 中间态（applySubagentStreamDelta 建的 sa-<uuid> 实体）
      sut.store.applySubagentStreamDelta(VIRTUAL_ID, ['Hello wor'])
      expect(sut.store.getMessages(VIRTUAL_ID)[0]).toMatchObject({ status: 'streaming', content: 'Hello wor' })

      // entry 帧：assistant 定稿 → reducer 基线整体替换分区
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({ role: 'assistant', content: [{ type: 'text', text: 'Hello world' }], timestamp: 2000 }),
      ])

      const messages = sut.store.getMessages(VIRTUAL_ID)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ role: 'assistant', content: 'Hello world', status: 'complete' })
      // delta 中间态实体（sa- 前缀 id）被定稿消息取代，不重复渲染
      expect(messages[0]?.id.startsWith('sa-')).toBe(false)
    })

    it('幂等：toolResult 重复帧 no-op（reducer deliveredToolResultIds 去重继承）', () => {
      const toolResultEntry = messageEntry({
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file body' }],
        timestamp: 3000,
      })
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
          timestamp: 1000,
        }),
      ])
      sut.store.applySubagentEntries(VIRTUAL_ID, [toolResultEntry])
      const afterFirst = sut.store.getMessages(VIRTUAL_ID)

      // 同 toolResult 帧重复投递 → reducer 二次喂入 no-op（孤儿不重复收集，消息不变）
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        sut.store.applySubagentEntries(VIRTUAL_ID, [toolResultEntry])
      } finally {
        warnSpy.mockRestore()
      }
      expect(sut.store.getMessages(VIRTUAL_ID)).toEqual(afterFirst)
      expect(afterFirst[0]?.toolCalls?.[0]?.output).toBe('file body')
    })

    it('toolCall overlay 重复帧 no-op（同 toolCallId 已 running 不重复 push）', () => {
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
          timestamp: 1000,
        }),
        toolCallForm(),
      ])
      const afterFirst = sut.store.getMessages(VIRTUAL_ID)
      expect(afterFirst[0]?.toolCalls).toHaveLength(1)

      sut.store.applySubagentEntries(VIRTUAL_ID, [toolCallForm()])
      expect(sut.store.getMessages(VIRTUAL_ID)[0]?.toolCalls).toHaveLength(1)
    })

    it('「帧先于打开 → 打开即完整」：帧累积 → 快照替换（fetchAndInject 形态）→ 后续帧不产生重复', () => {
      // 帧先于 drawer 打开到达（分区惰性创建，§6.1-2）
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({ role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1000 }),
        messageEntry({
          role: 'assistant',
          content: [{ type: 'text', text: '第一段产出' }],
          timestamp: 2000,
        }),
      ])
      // drawer 打开：fetchAndInject 快照整体替换（setMessages，文件直读全量；user content
      // 在快照形态是 segments——直读链同派生规则）
      sut.store.setMessages(VIRTUAL_ID, [
        { id: 'uuid-u1', role: 'user', content: [{ type: 'text', text: '任务' }], status: 'complete', timestamp: 1000 },
        { id: 'uuid-a1', role: 'assistant', content: '第一段产出', status: 'complete', timestamp: 2000 },
      ])
      expect(sut.store.getMessages(VIRTUAL_ID)).toHaveLength(2)

      // 后续新帧：reducer 基线全量派生视图替换（live 累积 ⊇ 快照期内容），无重复消息
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'assistant',
          content: [{ type: 'text', text: '第二段产出' }],
          timestamp: 4000,
        }),
      ])
      const messages = sut.store.getMessages(VIRTUAL_ID)
      expect(messages).toHaveLength(3)
      expect(messages.map((m) => (typeof m.content === 'string' ? m.content : ''))).toEqual(['', '第一段产出', '第二段产出'])
      expect((messages[0]?.content as Array<{ type: string; text: string }>)[0]?.text).toBe('任务')
    })

    it('基线派生视图截断：超限 toolResult 截断后，后续帧再派生视图截断值逐字节稳定（引用短路不改输出）', () => {
      const bigOutput = 'x'.repeat(10_000)
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: '/x' } }],
          timestamp: 1000,
        }),
      ])
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'read',
          content: [{ type: 'text', text: bigOutput }],
          timestamp: 3000,
        }),
      ])
      // reducer 回填保留全量原文，基线派生视图负责截断（含标记 ≤ 4KB）
      const truncated = sut.store.getMessages(VIRTUAL_ID)[0]?.toolCalls?.[0]?.output
      expect(truncated).toBeDefined()
      expect(new TextEncoder().encode(truncated!).length).toBeLessThanOrEqual(4096)
      expect(truncated!.endsWith('\n\n[...output truncated...]')).toBe(true)

      // 后续帧（新 user entry，历史消息 reducer 引用不变）触发全量派生视图：历史消息
      // 截断值不二次截断、marker 不叠加、逐字节等于首次派生视图结果
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({ role: 'user', content: [{ type: 'text', text: '下一轮' }], timestamp: 4000 }),
      ])
      const messages = sut.store.getMessages(VIRTUAL_ID)
      expect(messages).toHaveLength(2)
      expect(messages[0]?.toolCalls?.[0]?.output).toBe(truncated)
    })

    it('重复派生视图幂等：无新 entry 的重复触发输出与上次逐值一致（已见引用短路语义）', () => {
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({ role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1000 }),
        messageEntry({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { cmd: 'ls' } }],
          timestamp: 2000,
        }),
      ])
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'out'.repeat(2000) }],
          timestamp: 3000,
        }),
      ])
      const afterEntries = sut.store.getMessages(VIRTUAL_ID)

      // 空帧（无 entry 无 toolCall form）= 纯重派生视图：输出 deep equal，历史值不漂移
      sut.store.applySubagentEntries(VIRTUAL_ID, [])
      expect(sut.store.getMessages(VIRTUAL_ID)).toEqual(afterEntries)
    })

    it('disposeSession 清理 reducer 累积态：后续帧从空分区重新累积', () => {
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({ role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1000 }),
      ])
      expect(sut.store.getMessages(VIRTUAL_ID)).toHaveLength(1)

      sut.store.disposeSession(VIRTUAL_ID)
      expect(sut.store.getMessages(VIRTUAL_ID)).toHaveLength(0)

      // 清理后新帧：reducer state 一并清空（否则派生视图会带出清理前的累积，分区复活旧消息）
      sut.store.applySubagentEntries(VIRTUAL_ID, [
        messageEntry({ role: 'user', content: [{ type: 'text', text: '新任务' }], timestamp: 9000 }),
      ])
      expect(sut.store.getMessages(VIRTUAL_ID)).toHaveLength(1)
      expect(sut.store.getMessages(VIRTUAL_ID)[0]?.content).toEqual([{ type: 'text', text: '新任务' }])
    })
  })
});

// ======== 来源：session-derivations.test.ts ========
describe("session-derivations", () => {
  /** 构造独立 chat store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离） */
  function makeChatStore(): { store: ChatStoreInstance; dispose: () => void } {
    const scope = effectScope(true)
    const store = scope.run(() => createChatStore())!
    return { store, dispose: () => scope.stop() }
  }

  function assistantMsg(id: string, overrides: Partial<Message> = {}): Message {
    return { id, role: 'assistant', content: 'ok', status: 'complete', timestamp: 1, ...overrides }
  }

  function session(id: string, lastActiveAt: number): SessionGroup['sessions'][number] {
    return { id, label: `会话-${id}`, cwd: '/tmp/project', status: 'idle', lastActiveAt }
  }

  describe('A13 sessionsInRuntimeGroupOrder：组序恒等（runtime 权威序唯一定义点）', () => {
    it('多组多会话乱序输入 → 输出与输入展平原序恒等（组间序 + 组内序都不重排）', () => {
      const groups: SessionGroup[] = [
        { cwd: '/b', sessions: [session('b2', 3000), session('b1', 1000)] },
        { cwd: '/a', sessions: [session('a1', 2000)] },
      ]
      // 桌面旧行为 = SessionList 对 groups 直渲染（v-for g.sessions）零排序；
      // lastActiveAt 故意乱序——谓词若做任何客户端重排即与本断言红
      expect(sessionsInRuntimeGroupOrder(groups).map((s) => s.id)).toEqual(['b2', 'b1', 'a1'])
    })

    it('createSessionStore().list 经同一谓词派生（store 派生视图与谓词唯一定义点同源）', () => {
      const groups: SessionGroup[] = [
        { cwd: '/b', sessions: [session('b1', 1000), session('b2', 9000)] },
        { cwd: '/a', sessions: [session('a1', 5000), session('a2', 4000)] },
      ]
      const store = createSessionStore()
      store.applySnapshot({ groups })
      expect(store.getList().map((s) => s.id)).toEqual(sessionsInRuntimeGroupOrder(groups).map((s) => s.id))
    })

    it('空输入 → 空输出', () => {
      expect(sessionsInRuntimeGroupOrder([])).toEqual([])
    })
  })

  describe('A14 deriveSessionStatus ≡ deriveStatus（参数化输入 vs 桌面旧位置参数调用）', () => {
    let sut: { store: ChatStoreInstance; dispose: () => void }

    beforeEach(() => {
      setActivePinia(createPinia())
      sut = makeChatStore()
    })

    /** 等价断言：新入口（参数化对象）与桌面旧谓词（位置参数展开）同 store 状态下同输出 */
    function expectParity(
      sid: string,
      inputs: Parameters<typeof deriveSessionStatus>[2],
    ): string {
      const meta = inputs.metaStatus
      const legacy = deriveStatus(
        sid,
        sut.store,
        inputs.isActive,
        inputs.isCompacting,
        inputs.hasBackgroundWork,
        meta,
        inputs.hasBlockingOverlay ?? false,
      )
      const migrated = deriveSessionStatus(sid, sut.store, inputs)
      expect(migrated).toBe(legacy)
      return migrated
    }

    it('未 hydrate + 非活跃 + 无 meta → done（兜底）', () => {
      expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: false })).toBe('done')
    })

    it('isActive=true（pendingSend 空窗）→ pending', () => {
      sut.store.addPendingSend('s1')
      expect(expectParity('s1', { isActive: true, isCompacting: false, hasBackgroundWork: false })).toBe('pending')
    })

    it('isGenerating（message_start）→ streaming', () => {
      sut.store.applyMessageEvent('s1', {
        type: 'message.message_start',
        payload: { sessionId: 's1', messageId: 'a1' },
      } as ServerMessage)
      expect(expectParity('s1', { isActive: true, isCompacting: false, hasBackgroundWork: false })).toBe('streaming')
    })

    it('isCompacting=true → compacting', () => {
      sut.store.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
      expect(expectParity('s1', { isActive: false, isCompacting: true, hasBackgroundWork: false })).toBe('compacting')
    })

    it('hasBackgroundWork=true → working（移动输入 = A9 subagent 运行态布尔的消费形态）', () => {
      sut.store.hydrate('s1', [assistantMsg('m1')])
      expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: true })).toBe('working')
    })

    it('末条 assistant toolCall running → waiting（最优先分支）', () => {
      sut.store.hydrate('s1', [
        assistantMsg('m1', { toolCalls: [{ id: 't1', toolName: 'bash', input: {}, status: 'running', startTime: 0 }] }),
      ])
      expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: false })).toBe('waiting')
    })

    it('hasBlockingOverlay=true → waiting；缺省（undefined）与显式 false 同输出（移动恒 false 白名单语义）', () => {
      // 桌面输入：extensionUI pending → waiting
      expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: false, hasBlockingOverlay: true })).toBe('waiting')
      // 移动输入：无该源，缺省与显式 false 等价（均为非 waiting 的回落分支）
      sut.store.hydrate('s2', [assistantMsg('m2')])
      const byDefault = deriveSessionStatus('s2', sut.store, { isActive: false, isCompacting: false, hasBackgroundWork: false })
      const byExplicitFalse = deriveSessionStatus('s2', sut.store, { isActive: false, isCompacting: false, hasBackgroundWork: false, hasBlockingOverlay: false })
      expect(byDefault).toBe(byExplicitFalse)
      expect(byDefault).toBe('done')
    })

    it('metaStatus 终态兜底：error/stopped 未 hydrate 直达；dead 按 deriveStatus 既有语义落 done（桌面侧栏同语义）', () => {
      expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: false, metaStatus: 'error' })).toBe('error')
      expect(expectParity('s2', { isActive: false, isCompacting: false, hasBackgroundWork: false, metaStatus: 'stopped' })).toBe('stopped')
      expect(expectParity('s3', { isActive: false, isCompacting: false, hasBackgroundWork: false, metaStatus: 'dead' })).toBe('done')
    })
  })
});
