/**
 * subscription-state.test.ts —— 订阅状态迁移等价断言（F9，TC-3）+ seq 协议判定（D1 归位，
 * 原 seq-gap.test.ts 并入——evalSeqGap 六分支用例逐字保留，仅 import 改指本模块）。
 *
 * IF5 契约 + ES2：
 * ① 已 subscribed 且 fromSeq undefined → 幂等直接 return（subscribe 不被调用）
 * ② fromSeq 显式传入 → 跳过守卫发 RPC（reconcile backfill）
 * ③ snapshot/stateSnapshot 依次回放 replay 端口
 * ④ lastSeenSeq = max(reply.lastSeq, maxSnapshotSeq, maxStateSnapshotSeq, prevLastSeen)
 * ⑤ subscribe RPC 失败 → console.warn + 不标记 subscribed
 * ⑥ clearSubscription 删除、resetSubscriptionStates 清空、updateLastSeenSeq 更新基线
 *
 * 注入驱动：setSubscriptionPorts 注入 subscribe spy + replay spy（回放分发入口；
 * routeInbound 语义的集成测试见 subscription-replay.test.ts）；
 * beforeEach resetSubscriptionStates() 清 Map（测试隔离）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import {
  subscribeSession,
  getSubscriptionState,
  clearSubscription,
  updateLastSeenSeq,
  resetSubscriptionStates,
  setSubscriptionPorts,
  evalSeqGap,
} from './subscription-state'
import type { SubscriptionState } from './subscription-state'
import type { TransportPorts } from './route-inbound'
import type { ServerMessage } from '@taiji/shared'

function makeMsg(seq: number, type = 'session.ping'): ServerMessage {
  return { type: type as ServerMessage['type'], seq, payload: { sessionId: 's1' } }
}

function setup() {
  // TransportPorts['subscribe'] 形状的 mock（resolve 形状在用例内 mockResolvedValue 给定）
  const subscribe = vi.fn() as Mock<TransportPorts['subscribe']>
  const replay = vi.fn()
  setSubscriptionPorts({ subscribe, replay })
  return { subscribe, replay }
}

describe('subscribeSession', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.restoreAllMocks()
  })

  it('① 幂等守卫：已 subscribed 且 fromSeq undefined → 直接 return（subscribe 不被重复调用）', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1')
    await subscribeSession('s1')
    await subscribeSession('s1')
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 5, subscribed: true })
  })

  it('①b 并发 initial subscribe 去重（MF-2）：in-flight 期间重复调用复用同一 Promise（subscribe 只调一次）', async () => {
    const { subscribe } = setup()
    // 挂起第一个 subscribe，制造「守卫通过后、await 前」的并发窗口
    let resolveFirst!: (v: { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number }) => void
    subscribe.mockImplementation(
      () => new Promise((resolve) => { resolveFirst = resolve }),
    )
    const p1 = subscribeSession('s1')
    const p2 = subscribeSession('s1')
    expect(subscribe).toHaveBeenCalledTimes(1) // 第二个复用 in-flight，不发重复 RPC
    resolveFirst({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await Promise.all([p1, p2])
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 5, subscribed: true })
    // resolve 后再调 → subscribed 守卫拦截，仍不重复 RPC
    await subscribeSession('s1')
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('①c gap backfill 不被 initial subscribe 互吞（MF-2）：不同 fromSeq 各发各的 RPC', async () => {
    const { subscribe } = setup()
    const resolvers: Array<(v: { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number }) => void> = []
    subscribe.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve) }))
    const p1 = subscribeSession('s1') // initial（fromSeq undefined）in-flight
    const p2 = subscribeSession('s1', 10) // gap backfill（fromSeq 显式）不得互吞
    expect(subscribe).toHaveBeenCalledTimes(2)
    resolvers[0]({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    resolvers[1]({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await Promise.all([p1, p2])
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 10, subscribed: true }) // max(5, 10)
  })

  it('② fromSeq 显式传入 → 跳过幂等守卫发 RPC（reconcile backfill，即使已 subscribed）', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
    await subscribeSession('s1') // 首次订阅
    await subscribeSession('s1', 7) // gap reconcile：即使已 subscribed 也发 RPC
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(subscribe).toHaveBeenLastCalledWith('s1', 7)
  })

  it('③ snapshot/stateSnapshot 依次回放 replay 端口', async () => {
    const { subscribe, replay } = setup()
    subscribe.mockResolvedValue({
      snapshot: [makeMsg(1), makeMsg(2)],
      stateSnapshot: [makeMsg(3, 'session.commands'), makeMsg(4, 'session.context')],
      lastSeq: 10,
    })
    await subscribeSession('s1')
    expect(replay).toHaveBeenCalledTimes(4)
    expect(replay.mock.calls.map((c) => c[1].seq)).toEqual([1, 2, 3, 4])
    // 全部以 sessionId 路由
    for (const call of replay.mock.calls) {
      expect(call[0]).toBe('s1')
    }
  })

  it('④ lastSeenSeq = max(reply.lastSeq, maxSnapshotSeq, maxStateSnapshotSeq, prevLastSeen)', async () => {
    const { subscribe } = setup()
    // 场景 A：reply.lastSeq 最大
    subscribe.mockResolvedValue({
      snapshot: [makeMsg(2)],
      stateSnapshot: [makeMsg(1)],
      lastSeq: 10,
    })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(10)

    // 场景 B：snapshot seq 最大（ring 溢出场景：lastSeq 小于已 dispatch 的 snapshot seq）
    resetSubscriptionStates()
    subscribe.mockResolvedValue({
      snapshot: [makeMsg(50), makeMsg(51)],
      stateSnapshot: [],
      lastSeq: 30,
    })
    await subscribeSession('s2')
    expect(getSubscriptionState('s2')?.lastSeenSeq).toBe(51)

    // 场景 C：prevLastSeen 最大（reconcile 期间 live 消息已推进基线，不回落）
    subscribe.mockResolvedValue({
      snapshot: [],
      stateSnapshot: [],
      lastSeq: 3,
    })
    await subscribeSession('s3') // lastSeenSeq=3
    updateLastSeenSeq('s3', 20) // live 推进到 20
    await subscribeSession('s3', 5) // reconcile 回拉，reply.lastSeq=3 < 20
    expect(getSubscriptionState('s3')?.lastSeenSeq).toBe(20)
  })

  it('⑤ subscribe RPC 失败 → console.warn + 不标记 subscribed（意图条目留存，下次可重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { subscribe } = setup()
    subscribe.mockRejectedValue(new Error('connection lost'))
    await subscribeSession('s1')
    expect(warnSpy).toHaveBeenCalled()
    // M1/W09 follow-up：失败时留存 subscribed=false 的意图条目（供 WS 重连后 resubscribeAll
    // 重发），gap 检测走兼容路径（evalSeqGap 分支 1/2），行为与「无条目」一致
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 0, subscribed: false })
    // 重试成功
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 8 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 8, subscribed: true })
    warnSpy.mockRestore()
  })

  it('防御：端口未注入时 console.warn + 不崩（不标记 subscribed）', async () => {
    // 隔离模块实例（其他用例已 setSubscriptionPorts 注入，模块级状态被污染）
    vi.resetModules()
    const fresh = await import('./subscription-state')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fresh.subscribeSession('s1')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not injected'))
    expect(fresh.getSubscriptionState('s1')).toBeUndefined()
    warnSpy.mockRestore()
  })
})

describe('getSubscriptionState / clearSubscription / updateLastSeenSeq / resetSubscriptionStates', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.restoreAllMocks()
  })

  it('getSubscriptionState：未订阅返回 undefined；订阅后返回 state', async () => {
    const { subscribe } = setup()
    expect(getSubscriptionState('s1')).toBeUndefined()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 1, subscribed: true })
  })

  it('clearSubscription：删除后 getSubscriptionState 返回 undefined', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
    await subscribeSession('s1')
    clearSubscription('s1')
    expect(getSubscriptionState('s1')).toBeUndefined()
  })

  it('updateLastSeenSeq：更新基线（仅 lastSeenSeq，不动 subscribed）；state 不存在 no-op', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
    await subscribeSession('s1')
    updateLastSeenSeq('s1', 42)
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 42, subscribed: true })
    // state 不存在 → no-op 不崩
    expect(() => updateLastSeenSeq('ghost', 1)).not.toThrow()
  })

  it('resetSubscriptionStates：清空全部 Map', async () => {
    const { subscribe } = setup()
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
    await subscribeSession('s1')
    await subscribeSession('s2')
    resetSubscriptionStates()
    expect(getSubscriptionState('s1')).toBeUndefined()
    expect(getSubscriptionState('s2')).toBeUndefined()
  })
})

/**
 * evalSeqGap 六分支全覆盖（F7，TC-1；原 seq-gap.test.ts 逐字并入，D1 归位）。
 *
 * IF3 契约六分支：
 * ① state undefined → pass（无副作用）
 * ② state.subscribed=false → pass
 * ③ msg.seq 非 number → pass
 * ④ seq <= lastSeenSeq → drop（重复/乱序丢弃）
 * ⑤ seq > lastSeenSeq+1 → pass + reconcileFromSeq: lastSeenSeq（gap；subscribe fromSeq 是排他下界）
 * ⑥ seq === lastSeenSeq+1 → pass（正常递进，无 reconcileFromSeq）
 *
 * 纯函数零 mock：直接 import 调用断言返回值。
 */
const subscribed: SubscriptionState = { lastSeenSeq: 10, subscribed: true }

describe('evalSeqGap', () => {
  it('分支①：state undefined → pass（无副作用）', () => {
    expect(evalSeqGap({ seq: 5 }, undefined)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: 11 }, undefined)).toEqual({ action: 'pass' })
    expect(evalSeqGap({}, undefined)).toEqual({ action: 'pass' })
  })

  it('分支②：state.subscribed=false → pass（兼容路径不 gap 检测）', () => {
    const notSubscribed: SubscriptionState = { lastSeenSeq: 10, subscribed: false }
    expect(evalSeqGap({ seq: 5 }, notSubscribed)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: 100 }, notSubscribed)).toEqual({ action: 'pass' })
  })

  it('分支③：msg.seq 非 number → pass（无 gap 语义）', () => {
    expect(evalSeqGap({}, subscribed)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: undefined }, subscribed)).toEqual({ action: 'pass' })
  })

  it('分支④：seq <= lastSeenSeq → drop（reconcile 回放重复/乱序）', () => {
    expect(evalSeqGap({ seq: 10 }, subscribed)).toEqual({ action: 'drop' })
    expect(evalSeqGap({ seq: 3 }, subscribed)).toEqual({ action: 'drop' })
    expect(evalSeqGap({ seq: 0 }, subscribed)).toEqual({ action: 'drop' })
  })

  it('分支⑤：seq > lastSeenSeq+1 → pass + reconcileFromSeq: lastSeenSeq（gap 回拉，排他下界覆盖缺失段）', () => {
    // runtime session.subscribe 的 fromSeq 是排他下界（只返 seq > fromSeq）：
    // 传 lastSeenSeq（而非 seq-1）才能取回 lastSeenSeq+1..seq-1 的整个缺失段（MF-1）。
    expect(evalSeqGap({ seq: 12 }, subscribed)).toEqual({ action: 'pass', reconcileFromSeq: 10 })
    expect(evalSeqGap({ seq: 20 }, subscribed)).toEqual({ action: 'pass', reconcileFromSeq: 10 })
  })

  it('分支⑥：seq === lastSeenSeq+1 → pass（正常递进，无 reconcileFromSeq）', () => {
    expect(evalSeqGap({ seq: 11 }, subscribed)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: 10 + 1 }, subscribed)).toEqual({ action: 'pass' })
  })

  it('边界：lastSeenSeq=0（无历史）时 seq=1 正常递进、seq=2 gap', () => {
    const fresh: SubscriptionState = { lastSeenSeq: 0, subscribed: true }
    expect(evalSeqGap({ seq: 1 }, fresh)).toEqual({ action: 'pass' })
    expect(evalSeqGap({ seq: 2 }, fresh)).toEqual({ action: 'pass', reconcileFromSeq: 0 })
    expect(evalSeqGap({ seq: 0 }, fresh)).toEqual({ action: 'drop' })
  })
})
