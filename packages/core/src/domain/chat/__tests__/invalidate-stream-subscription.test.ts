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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

interface Fixture {
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
    // [u4b 收窄] EnsureStreamSubDeps.chatApi = Pick<ChatApiPort, 'streamSubscribe'>，
    // 只注入消费面（excess property check 不放行多余键）
    chatApi: { streamSubscribe },
    // [session-dead 第三环] warning：defer 重投熔断提示的注入面（本用例不触发）
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

    // respawn 后 ensure 不被幂等守卫短路：三层全部重发
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
