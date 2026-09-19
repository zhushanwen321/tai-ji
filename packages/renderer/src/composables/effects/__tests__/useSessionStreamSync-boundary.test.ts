/**
 * useSessionStreamSync wave w2 边界验证测试（TC1-TC5）。
 *
 * w1 已实现 bindSessionStreamSync effect（commit ec779fd99）：watch sessionStore.list
 * flush:sync，added→ensureStreamSubscription，removed→disposeSession。本 wave 是验证 wave，
 * 证明核心价值（从未交互 session 收终态事件后侧栏正确翻态）+ 边界场景。
 *
 * 与 w1 的区别：w1 mock useChat（隔离 streamSubscriptions 模块级 Map + 捕获调用次数），
 * 走真实链路（真实 Pinia store + 真实 useChat + 真实 events.dispatchSession → applyMessageEvent
 * → chat-message-effects），端到端验证事件投递 / streaming 翻态 / deriveStatus 派生。
 *
 * 关键链路（已确认）：
 *   ensureStreamSubscription 内部调 chatApi.streamSubscribe(sid, handler)
 *   → events.on(sid, handler)（api/domains/chat.ts:117-122）
 *   handler 收 message.* → chat.applyMessageEvent → dispatchMessageEvent 查 messageEffects 表
 *   - message.message_start（chat-message-effects.ts:264）：建 streaming assistant（role:'assistant',
 *     status:'streaming'），isGenerating 派生为 true
 *   - message.complete（chat-message-effects.ts:300）：把 streaming assistant 翻终态（complete/error）
 *     + finalizeSession 收口，isGenerating 派生为 false
 *   模拟 runtime 推送：调 events.dispatchSession(sid, msg) 触发已注册 handler
 *
 * 运行：cd packages/renderer && npx vitest run composables/effects/__tests__/useSessionStreamSync-boundary.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import * as events from '@taiji/core/transport/api'
import { bindSessionStreamSync } from '../useSessionStreamSync'
import { useSessionStore } from '@/stores/session'
import { useChatStore } from '@/stores/chat'
import {
  ensureStreamSubscription,
  resetChatModuleState,
} from '@/composables/features/chat/useChat'
import { deriveStatus } from '@/composables/logic/sessionStatus'
import type { SessionSummary, ServerMessage } from '@taiji/shared'

/**
 * 桥接 chatApi.streamSubscribe → 真实 events.on。
 *
 * vitest.config.ts 设 VITE_MOCK=true，导致 @/api 门面把 chat 切到 mock 门面
 * （mock/index.ts 的 streamSubscribe 写入独立的 streamHandlers Map，与真实
 * events.sessionHandlers 完全脱节）。真实链路（api/domains/chat.ts:117-122）下
 * streamSubscribe 即 events.on。此处桥接以还原规格约定的「streamSubscribe 底层是 events.on」，
 * 让 ensureStreamSubscription → events.on → dispatchSession 投递真实贯通，TC2/TC3/TC4 走真实链路。
 * 其余 api（session/config/...）保留 actual 实现，最大程度端到端。
 */
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    chat: {
      ...actual.chat,
      streamSubscribe: (sid: string, handler: (msg: ServerMessage) => void) =>
        events.on(sid, handler),
    },
  }
})

/** 辅助：构造最小 SessionSummary（cast 补齐可选字段，测试代码可接受） */
function mkSession(id: string): SessionSummary {
  return { id, label: id, cwd: '/x', status: 'idle' } as SessionSummary
}

describe('bindSessionStreamSync 边界验证（w2）', () => {
  let pinia: ReturnType<typeof createPinia>
  let scope: ReturnType<typeof effectScope>
  let sessionStore: ReturnType<typeof useSessionStore>
  let chatStore: ReturnType<typeof useChatStore>

  beforeEach(() => {
    // 清 streamSubscriptions 模块级 Map（隔离 w1 测试残留 + 跨用例隔离）
    resetChatModuleState()
    // 抑制 chat-message-effects 的 DEV 诊断日志（message_start/complete 打印 + Error stack）
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    pinia = createPinia()
    setActivePinia(pinia)
    scope = effectScope()
    scope.run(() => {
      sessionStore = useSessionStore()
      chatStore = useChatStore()
      // 在 scope 内注册 effect（watch + onScopeDispose）
      bindSessionStreamSync()
    })
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
  })

  it('TC1: 批量 applySnapshot 整表全量替换——added/removed 各自触发，保留项不重复', () => {
    // 初始 list=[a,b,c]——appendSession 触发 watch，3 个 session 各自 ensureStreamSubscription
    sessionStore.applySnapshot({ groups: [
      { cwd: '/x', sessions: [mkSession('a'), mkSession('b'), mkSession('c')] },
    ] })

    // 验证：对 a/b/c 推 message_start，3 个 session 都应建立 streaming assistant
    // （证明 3 个都被订阅——未订阅的 sid dispatchSession 静默丢弃）
    for (const sid of ['a', 'b', 'c']) {
      events.dispatchSession(sid, {
        type: 'message.message_start',
        payload: { sessionId: sid, messageId: `m-${sid}` },
      } as ServerMessage)
    }
    expect(chatStore.getMessages('a').length).toBe(1)
    expect(chatStore.getMessages('b').length).toBe(1)
    expect(chatStore.getMessages('c').length).toBe(1)

    // applySnapshot 整表替换为 [a,d,e]（保留 a、新增 d/e、移除 b/c）
    sessionStore.applySnapshot({ groups: [
      { cwd: '/x', sessions: [mkSession('a'), mkSession('d'), mkSession('e')] },
    ] })

    // d/e 应被订阅（新 added），b/c 应被 disposeSession（messages 被清）
    events.dispatchSession('d', {
      type: 'message.message_start',
      payload: { sessionId: 'd', messageId: 'm-d' },
    } as ServerMessage)
    events.dispatchSession('e', {
      type: 'message.message_start',
      payload: { sessionId: 'e', messageId: 'm-e' },
    } as ServerMessage)
    expect(chatStore.getMessages('d').length).toBe(1)
    expect(chatStore.getMessages('e').length).toBe(1)
    // b/c 被 disposeSession 后 messages 清空（chat.ts:846 disposeSession 删 messages key）
    expect(chatStore.getMessages('b').length).toBe(0)
    expect(chatStore.getMessages('c').length).toBe(0)

    // 补强（m1）：证明 b/c 不只是 messages 被清，订阅（events.on）也真的被拆。
    // disposeSession 内部 streamSubscriptions.delete + 调 unsub（events.off）——若漏删订阅，
    // 下面 dispatch 仍会投递到 b 的旧 handler，applyMessageEvent 重新建 streaming assistant，length 变 1。
    events.dispatchSession('b', {
      type: 'message.message_start',
      payload: { sessionId: 'b', messageId: 'm-b-2' },
    } as ServerMessage)
    expect(chatStore.getMessages('b').length).toBe(0) // 订阅已拆，事件被丢弃
    events.dispatchSession('c', {
      type: 'message.message_start',
      payload: { sessionId: 'c', messageId: 'm-c-2' },
    } as ServerMessage)
    expect(chatStore.getMessages('c').length).toBe(0)
  })

  it('TC2: 从未交互 session（仅 appendSession 进 list）收 message.start+complete 后 isGenerating 翻 false', () => {
    const sid = 's-never-interacted'
    // 仅 appendSession（不调 useChat.send）——watch 自动建订阅
    sessionStore.appendSession(mkSession(sid))

    // 推 message_start 建立流式状态
    events.dispatchSession(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'm1' },
    } as ServerMessage)
    // 此时应有 streaming assistant，isGenerating 为 true
    expect(chatStore.isGenerating(sid)).toBe(true)
    const msgs = chatStore.getMessages(sid)
    expect(msgs.length).toBe(1)
    expect(msgs[0].status).toBe('streaming')
    expect(msgs[0].role).toBe('assistant')

    // 推 message.complete 收口
    events.dispatchSession(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'stop' },
    } as ServerMessage)
    // isGenerating 翻 false，assistant status 翻 complete
    expect(chatStore.isGenerating(sid)).toBe(false)
    const finalMsgs = chatStore.getMessages(sid)
    expect(finalMsgs[0].status).toBe('complete')
  })

  it('TC3: message.complete 后 derivedStatus 从 streaming 变 done（观察者视角）', () => {
    const sid = 's-derive'
    sessionStore.appendSession(mkSession(sid))
    events.dispatchSession(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'm1' },
    } as ServerMessage)
    // message_start 后应 streaming（isActive=isGenerating=true）
    // deriveStatus 签名：(sessionId, chat, isActive, isCompacting=false, hasBackgroundWork=false, metaStatus?, hasFormOverlayPending=false)
    const statusDuring = deriveStatus(sid, chatStore, chatStore.isActive(sid))
    expect(statusDuring).toBe('streaming')

    events.dispatchSession(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'stop' },
    } as ServerMessage)
    // complete 后应 done（非 active、最后 assistant status=complete、非 error/interrupted）
    const statusAfter = deriveStatus(sid, chatStore, chatStore.isActive(sid))
    expect(statusAfter).toBe('done')
  })

  it('TC4: watch 已建订阅后，显式 ensureStreamSubscription 命中幂等短路变 no-op', () => {
    const sid = 's-idempotent'
    sessionStore.appendSession(mkSession(sid))
    // 此时 watch 已对 sid 建订阅（events.on 已注册一次）
    // spy events.on 计数（spy 建在已订阅之后，故仅后续调用被计入）
    const onSpy = vi.spyOn(events, 'on')

    // 模拟 fork-ask:108 / handoff:64 的显式调用
    const chat = useChatStore()
    const session = useSessionStore()
    ensureStreamSubscription(sid, chat, session)

    // ensureStreamSubscription 首行 has(sid) 短路，不应再调 events.on
    expect(onSpy).not.toHaveBeenCalled()
    onSpy.mockRestore()
  })

  it('TC5: HMR 双 scope——旧 scope.stop() 取消旧 watch，新 scope 建新 watch', () => {
    const sid1 = 's-hmr-1'
    sessionStore.appendSession(mkSession(sid1))
    // scope A 已在 beforeEach 建立，sid1 已订阅（ensureStreamSubscription 注册 events.on）
    events.dispatchSession(sid1, {
      type: 'message.message_start',
      payload: { sessionId: sid1, messageId: 'm1' },
    } as ServerMessage)
    expect(chatStore.getMessages(sid1).length).toBe(1)

    // 模拟 HMR：停旧 scope + 清模块级 streamSubscriptions（HMR 整模块重载的等价清理）。
    // 说明：scope.stop() 仅取消 watch（onScopeDispose 注册的 stopWatch），
    // ensureStreamSubscription 的 events.on 订阅存于模块级 streamSubscriptions Map，
    // 非作用域绑定——单 scope.stop 不会拆订阅。真实 HMR 会整模块重载（useChat 模块重新求值，
    // streamSubscriptions Map 重置），此处用 resetChatModuleState 精确建模该重载。
    scope.stop()

    // 关键断言（TC5 核心，填补验证空洞）：在 resetChatModuleState 之前，append 一个全新 session
    // 并推事件——若 scope.stop() 真的取消了旧 watch，旧 watch 不会响应 list 变化给 sid-new
    // 建订阅，dispatchSession(sid-new) 无订阅者，messages 保持 0。
    // 这一步真正区分了「旧 watch 已取消」与「旧 watch 仍存活但被幂等短路掩盖」：
    //   若 scope.stop 未生效（旧 watch 仍存活），appendSession(sid-new) 会触发旧 watch 调
    //   ensureStreamSubscription(sid-new) 建订阅 → 推事件后 messages 变 1，断言失败。
    //   只有旧 watch 真被取消时，sid-new 才会因无订阅而 messages===0。
    // 故意保留 sid1 的旧订阅（模块级，未 reset）——只验旧 watch 对新 list 项的不响应，
    // sid1 旧订阅与 sid-new 无关，不影响本断言。
    const sidNew = 's-hmr-new'
    sessionStore.appendSession(mkSession(sidNew))
    events.dispatchSession(sidNew, {
      type: 'message.message_start',
      payload: { sessionId: sidNew, messageId: 'm-new' },
    } as ServerMessage)
    expect(chatStore.getMessages(sidNew).length).toBe(0) // 旧 watch 已取消，sid-new 无订阅

    // 清模块级订阅（模拟 HMR 整模块重载的剩余部分）。
    // 旧订阅已清——sid1 再推事件不应到（messages 不变）
    resetChatModuleState()
    events.dispatchSession(sid1, {
      type: 'message.message_start',
      payload: { sessionId: sid1, messageId: 'm2' },
    } as ServerMessage)
    expect(chatStore.getMessages(sid1).length).toBe(1) // 仍是 1，未增

    // 新 scope 挂载（模拟 HMR 重挂 App.vue setup）
    const scopeB = effectScope()
    scopeB.run(() => {
      bindSessionStreamSync()
    })
    const sid2 = 's-hmr-2'
    sessionStore.appendSession(mkSession(sid2))
    events.dispatchSession(sid2, {
      type: 'message.message_start',
      payload: { sessionId: sid2, messageId: 'm3' },
    } as ServerMessage)
    expect(chatStore.getMessages(sid2).length).toBe(1) // 新 scope 的 watch 工作
    scopeB.stop()
  })
})
