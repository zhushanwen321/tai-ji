/**
 * invalidateStreamSubscription 单测 —— session.exited 后本地流订阅标记失效。
 *
 * 锁定 respawn 链路缺口（缺口 #2）：pi 死亡时 runtime clearSession 清掉服务端订阅集合，
 * 前端 streamSubscriptions（events 层幂等标记）与 subscriptionStates（MessageBus 订阅
 * 状态 + in-flight 去重）若不同步失效，respawn 后 ensureStreamSubscription 被各层幂等
 * 守卫短路：events handler 不重挂（旧 handler 残留 → 重挂后双订阅双 dispatch）+
 * subscribe RPC 不重发（新 pi 的 message.* 定向推送无订阅者 → UI 卡「进行中…」）。
 *
 * 模式：对齐 useChat.test.ts 的 makeFixture（真实 createChatStore + vi.fn deps），
 * 直接调模块级 ensureStreamSubscription / invalidateStreamSubscription；注入
 * setSubscriptionPorts 捕获 subscribe RPC（subscribeSession 端口）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import { createChatStore } from '../store'
import {
  ensureStreamSubscription,
  invalidateStreamSubscription,
  resetChatModuleStateForTest,
} from '../useChat'
import type { EnsureStreamSubDeps } from '../useChat'
import {
  setSubscriptionPorts,
  getSubscriptionState,
} from '../../../coordination/subscription-state'

/** 等 fire-and-forget 的 subscribeSession（async）收敛 */
const flushSubscribes = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface Fixture {
  /** 对固定 sid 调 ensureStreamSubscription（chat/sessionStore/deps 已闭包注入） */
  ensure: (sid: string) => void
  streamSubscribe: ReturnType<typeof vi.fn>
  subscribeRpc: ReturnType<typeof vi.fn>
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
    // [u4b 收窄] EnsureStreamSubDeps.chatApi = Pick<ChatApiPort, 'streamSubscribe'>，
    // 只注入消费面（excess property check 不放行多余键）
    chatApi: { streamSubscribe },
    // [session-dead 第三环] warning：defer 重投熔断提示的注入面（本用例不触发）
    toast: { error: vi.fn(), warning: vi.fn() },
    t: (k: string) => k,
    getCompactQueue: () => ({
      flush: vi.fn().mockResolvedValue(true),
      enqueue: vi.fn(),
      peek: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      confirmDelivery: vi.fn(),
    }),
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
  }
}

describe('invalidateStreamSubscription（session.exited 订阅失效）', () => {
  let f: Fixture

  beforeEach(() => {
    resetChatModuleStateForTest()
    f = makeFixture()
  })

  it('invalidate 后再次 ensure：重发 events 订阅 + 重发 subscribe RPC + 重建订阅状态', async () => {
    const sid = 's-dead'
    f.ensure(sid)
    expect(f.streamSubscribe).toHaveBeenCalledTimes(1)
    await flushSubscribes()
    expect(f.subscribeRpc).toHaveBeenCalledTimes(1)
    expect(getSubscriptionState(sid)?.subscribed).toBe(true)

    // session.exited → 失效本地标记（服务端订阅已被 clearSession 清除）
    invalidateStreamSubscription(sid)
    expect(getSubscriptionState(sid)).toBeUndefined()

    // respawn 后 ensure 不被幂等守卫短路：三层全部重发
    f.ensure(sid)
    expect(f.streamSubscribe).toHaveBeenCalledTimes(2)
    await flushSubscribes()
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
    await flushSubscribes()
    expect(f.subscribeRpc).toHaveBeenCalledTimes(1)

    invalidateStreamSubscription(sid)

    // 恢复正常 resolve：首次 ensure 必须发新 RPC，而非被 in-flight 去重收敛到旧死 Promise
    f.subscribeRpc.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
    f.ensure(sid)
    await flushSubscribes()
    expect(f.subscribeRpc).toHaveBeenCalledTimes(2)
    expect(getSubscriptionState(sid)?.subscribed).toBe(true)
  })

  it('未订阅的 sid invalidate 幂等 no-op', () => {
    expect(() => invalidateStreamSubscription('s-ghost')).not.toThrow()
    f.ensure('s-live')
    expect(f.streamSubscribe).toHaveBeenCalledTimes(1)
  })
})
