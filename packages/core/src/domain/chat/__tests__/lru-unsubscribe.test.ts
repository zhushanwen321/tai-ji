/**
 * evictLruWithUnsubscribe 单测 —— LRU 驱逐连带退订复合入口（remote-use D2/U5）。
 *
 * 锁定 D2 裁决语义：evictLru 不再裸接 evictIfNeeded——驱逐发生时对被驱逐会话同时
 * ① 失效本地两层订阅簿记（invalidateStreamSubscription：events handler 退订 + subscribe
 * 幂等标记失效），② 发 session.unsubscribe RPC（服务端停发，订阅数量随分区同界有界）。
 * 不做驱逐退订的后果（D2 采用段）：被驱逐会话订阅仍在，后续消息经 commitMessages 重建
 * 分区——驱逐白做，且订阅数量随打开会话数线性增长。
 *
 * 模式：对齐 invalidate-stream-subscription.test.ts 的 makeFixture（真实 createChatStore +
 * vi.fn deps + setSubscriptionPorts 捕获 subscribe RPC）；分区经 hydrate（ops 面合法入口，
 * 内部 lruTouch 记 recency）构造超阈值场景。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'
import {
  ensureStreamSubscription,
  evictLruWithUnsubscribe,
  resetChatModuleStateForTest,
} from '../useChat'
import type { EnsureStreamSubDeps, LruUnsubscribeDeps } from '../useChat'
import {
  setSubscriptionPorts,
  getSubscriptionState,
} from '../../../coordination/subscription-state'
import { _resetLruForTest } from '../lru'

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
    chatApi: { streamSubscribe },
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

    // 模拟重走 12 步切入链（步 5 ensureStreamSubscription）：不被残留守卫短路
    f.ensure('s0')
    expect(f.streamSubscribe).toHaveBeenCalledTimes(2)
    await flushSubscribes(f.subscribeRpc)
    expect(f.subscribeRpc).toHaveBeenCalledTimes(2)
    expect(getSubscriptionState('s0')?.subscribed).toBe(true)
  })
})
