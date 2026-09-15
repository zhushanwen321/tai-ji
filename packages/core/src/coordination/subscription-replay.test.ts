/**
 * subscription-replay.test.ts —— 回放与 live 共享路由语义的集成断言（PR #175 review R1 MUST_FIX）。
 *
 * 修复前回放路径（subscribeSession 的 snapshot/stateSnapshot 循环）裸调
 * events.dispatchSession，绕过 routeInbound 的 seq 去重与 ROUTE_TABLE effects /
 * crossSession 分发：
 * - (A) gap reconcile 的 subscribe(fromSeq=排他下界) 返回 snapshot 必含 live 已 dispatch
 *   的触发消息本身 → 回放二连击（message_start 重复 assistant 实体 / customStart 双
 *   system notice）；stateSnapshot 与 snapshot 的同 seq 重叠同样二连击
 * - (B) 回放的 session.subagents / message.complete / session.exited / extension:* 帧
 *   不触发 onSubagents 等兜底与 dispatchCrossSession → 重连/gap 后非活跃 session 的
 *   subagent 终态丢失（侧栏永久卡 running）
 *
 * 修复后回放经注入的 replay dispatcher 走 dispatchRouted 共享核心（seq 去重 + effects +
 * crossSession），gap 触发消息靠 SubscriptionState.gapDispatchedSeqs 簿记 drop。
 *
 * 集成链路：configureRouteInbound(ports, effects)（内部构造 replay 并 setSubscriptionPorts）
 * → subscribeSession 真实执行 → dispatcher（live 入口）。三组用例：
 * - A：seq 去重（gap 触发消息不重复实体、stateSnapshot 重叠 skip、多 gap 消息）
 * - B：回放帧触发 ROUTE_TABLE effects + crossSession 分发
 * - C：live 路径回归（正常递进不双 dispatch、簿记 drop 重复 push、收敛后簿记清理）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureRouteInbound } from './route-inbound'
import type { TransportPorts, InboundEffects } from './route-inbound'
import {
  subscribeSession,
  resubscribeAll,
  getSubscriptionState,
  resetSubscriptionStates,
} from './subscription-state'
import type { ServerMessage } from '@taiji/shared'

type SubscribeReply = Awaited<ReturnType<TransportPorts['subscribe']>>

function makePorts(): TransportPorts {
  return {
    pending: {
      resolve: vi.fn(),
      reject: vi.fn(),
      rejectAll: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      resolveEnvelope: vi.fn(),
    },
    events: {
      dispatchSession: vi.fn(),
      dispatchGlobal: vi.fn(),
      dispatchCrossSession: vi.fn(),
    },
    subscribe: vi.fn(),
  }
}

function makeEffects(): InboundEffects {
  return {
    onSessionExited: vi.fn(),
    onMessageComplete: vi.fn(),
    onSubagents: vi.fn(),
    onWorkflowUpdate: vi.fn(),
    onGlobalError: vi.fn(),
  }
}

/** 构造带 seq + sessionId payload 的消息（session 通道） */
function msg(seq: number, type = 'session.ping', payloadExtra: Record<string, unknown> = {}): ServerMessage {
  return { type: type as ServerMessage['type'], seq, payload: { sessionId: 's1', ...payloadExtra } }
}

/** 已 dispatch 到 session 通道的消息 seq 序列（断言辅助） */
function dispatchedSeqs(ports: TransportPorts): Array<number | undefined> {
  return (ports.events.dispatchSession as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1].seq)
}

function setup() {
  const ports = makePorts()
  const effects = makeEffects()
  const dispatcher = configureRouteInbound(ports, effects)
  return { ports, effects, dispatcher }
}

describe('A. 回放 seq 去重（gap 触发消息不重复实体）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.restoreAllMocks()
  })

  it('A1: gap 触发消息（live 已 dispatch）在 reconcile snapshot 回放中被 drop——message_start 只 dispatch 一次', async () => {
    const { ports, dispatcher } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    // initial subscribe 建基线 10（空回放）
    subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    // reconcile reply：fromSeq=10 排他下界，snapshot 必含触发消息 seq=13 本身
    subscribe.mockResolvedValueOnce({
      snapshot: [msg(11), msg(12), msg(13, 'message.message_start')],
      stateSnapshot: [],
      lastSeq: 13,
    })

    // live gap：seq 13 > 10+1 → dispatch 当前消息 + fire-and-forget reconcile
    dispatcher(msg(13, 'message.message_start'))

    await vi.waitFor(() => {
      // live 1 次（13）+ 回放缺失段 2 次（11、12）；触发消息 13 的回放被 gapDispatchedSeqs drop
      expect(dispatchedSeqs(ports)).toEqual([13, 11, 12])
    })
    // message_start 二连击只产生一次实体：seq=13 恰好 dispatch 一次
    expect(dispatchedSeqs(ports).filter((s) => s === 13)).toHaveLength(1)
    // 基线收敛到 13（缺失段递进 + 收敛公式）
    await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13))
    // 收敛后簿记清理（基线已覆盖）
    expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toBeUndefined()
  })

  it('A2: 多条 gap 触发消息（15、17）都靠簿记 drop，缺失段 11-14/16 补齐', async () => {
    const { ports, dispatcher } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    // reconcile 挂起：两条 gap 消息先后到达（in-flight 去重合并为同一次 RPC）
    let resolveReconcile!: (v: SubscribeReply) => void
    subscribe.mockImplementation(() => new Promise<SubscribeReply>((resolve) => { resolveReconcile = resolve }))

    dispatcher(msg(15)) // gap：dispatch + 记簿记 + reconcile(fromSeq=10)
    dispatcher(msg(17)) // gap：dispatch + 记簿记 + reconcile（复用 in-flight）
    expect(dispatchedSeqs(ports)).toEqual([15, 17])

    // ring 现已含 11..17（fromSeq=10 全量）
    resolveReconcile({ snapshot: [msg(11), msg(12), msg(13), msg(14), msg(15), msg(16), msg(17)], stateSnapshot: [], lastSeq: 17 })
    await vi.waitFor(() => {
      // 缺失段递进 dispatch；15、17 已 live dispatch 过 → 簿记 drop
      expect(dispatchedSeqs(ports)).toEqual([15, 17, 11, 12, 13, 14, 16])
    })
    await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(17))
  })

  it('A3: stateSnapshot 与 snapshot 同 seq 重叠（state topic 消息在 ring 内）只回放一次；溢出的旧 last-value 保留', async () => {
    const { ports } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    // initial subscribe（subscribed=false 兼容路径：evalSeqGap 全 pass，去重只靠回放内
    // replayedSeqs 簿记——这正是本用例锁定的机制）
    const subagentsInRing = msg(25, 'session.subagents', { subagents: [{ id: 'sa-1', status: 'done' }] })
    const staleLastValue = msg(5, 'session.context', { tokens: 42 })
    subscribe.mockResolvedValueOnce({
      snapshot: [msg(21), subagentsInRing],
      stateSnapshot: [subagentsInRing, staleLastValue],
      lastSeq: 25,
    })

    await subscribeSession('s1')

    // seq 25（snapshot 与 stateSnapshot 重叠）只 dispatch 一次；seq 5（ring 溢出仅剩
    // last-value）正常回放——ADR-0055 stateSnapshot 注入语义不因去重误伤
    expect(dispatchedSeqs(ports)).toEqual([21, 25, 5])
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(25)
  })
})

describe('B. 回放帧触发 ROUTE_TABLE effects 与 crossSession 分发', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.restoreAllMocks()
  })

  it('B1: resubscribeAll 回放 stateSnapshot 的 session.subagents → dispatchSession + onSubagents（重连后非活跃 session 终态恢复）', async () => {
    const { ports, effects } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    // 断线前已订阅（基线 20，空回放）
    subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 20 })
    await subscribeSession('s1')

    // 重连：resubscribeAll 捕获 fromSeq=20 重置条目后重发；runtime 断线期间 ring 溢出，
    // subagents last-value（旧 seq 5）只存于 stateSnapshot
    subscribe.mockResolvedValueOnce({
      snapshot: [msg(21)],
      stateSnapshot: [msg(5, 'session.subagents', { subagents: [{ id: 'sa-1', status: 'done' }] })],
      lastSeq: 21,
    })
    resubscribeAll()

    await vi.waitFor(() => {
      // stateSnapshot 帧 dispatchSession（session 通道）...
      expect(ports.events.dispatchSession).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ type: 'session.subagents', seq: 5 }),
      )
    })
    // ...且触发 onSubagents 兜底（侧栏 subagent 终态更新，修复「永久卡 running」）
    expect(effects.onSubagents).toHaveBeenCalledWith('s1', [{ id: 'sa-1', status: 'done' }])
    await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(21))
  })

  it('B2: 回放的 message.complete（snapshot 内）触发 onMessageComplete', async () => {
    const { ports, effects } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    subscribe.mockResolvedValueOnce({
      snapshot: [msg(11, 'message.complete', { stopReason: 'stop' })],
      stateSnapshot: [],
      lastSeq: 11,
    })
    await subscribeSession('s1')
    expect(ports.events.dispatchSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'message.complete' }),
    )
    expect(effects.onMessageComplete).toHaveBeenCalledWith('s1', { sessionId: 's1', stopReason: 'stop' })
  })

  it('B3: 回放的 session.exited（snapshot 内）触发 onSessionExited', async () => {
    const { ports, effects } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    subscribe.mockResolvedValueOnce({
      snapshot: [msg(11, 'session.exited', { code: 0, reason: 'done' })],
      stateSnapshot: [],
      lastSeq: 11,
    })
    await subscribeSession('s1')
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSessionExited).toHaveBeenCalledWith('s1', { sessionId: 's1', code: 0, reason: 'done' })
  })

  it('B4: 回放的 extension:widget（crossSession 声明条目）→ dispatchSession + dispatchCrossSession', async () => {
    const { ports } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    subscribe.mockResolvedValueOnce({
      snapshot: [msg(11, 'extension:widget', { widgetKey: 'w', lines: [] })],
      stateSnapshot: [],
      lastSeq: 11,
    })
    await subscribeSession('s1')
    // 与 live 同语义：session 通道 + crossSession 通道（ExtensionHost 全局单例消费者）
    expect(ports.events.dispatchSession).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'extension:widget' }))
    expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension:widget' }))
  })
})

describe('C. live 路径回归（行为不变）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
    vi.restoreAllMocks()
  })

  it('C1: 正常递进消息不双 dispatch、不触发 reconcile', async () => {
    const { ports, dispatcher } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    dispatcher(msg(11))
    dispatcher(msg(12))
    expect(dispatchedSeqs(ports)).toEqual([11, 12])
    expect(subscribe).toHaveBeenCalledTimes(1) // 仅 initial，无 reconcile
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(12)
  })

  it('C2: gap 触发消息在基线推进前重复到达（重发/乱序）→ 簿记 drop，不重复 dispatch', async () => {
    const { ports, dispatcher } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    // reconcile 挂起，基线停在 10（MF-3：gap 路径不推进）
    let resolveReconcile!: (v: SubscribeReply) => void
    subscribe.mockImplementation(() => new Promise<SubscribeReply>((resolve) => { resolveReconcile = resolve }))

    dispatcher(msg(13)) // gap：dispatch + 簿记
    dispatcher(msg(13)) // 重复到达：seq 13 > 基线 10（常规去重不覆盖）→ 靠簿记 drop
    expect(dispatchedSeqs(ports)).toEqual([13])

    resolveReconcile({ snapshot: [msg(11), msg(12), msg(13)], stateSnapshot: [], lastSeq: 13 })
    await vi.waitFor(() => {
      // 回放补缺失段 11、12；触发消息 13 不二连击
      expect(dispatchedSeqs(ports)).toEqual([13, 11, 12])
    })
    await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13))
  })

  it('C3: reconcile 回复空 snapshot（缺失段已不在 ring）也收敛基线并清空簿记，后续 live 正常递进', async () => {
    const { ports, dispatcher } = setup()
    const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
    subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 13 })
    dispatcher(msg(13)) // gap：dispatch + 簿记 + reconcile（ring 溢出拉不回 11、12）
    await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13))
    // 簿记已清理：后续同 seq 重复由常规 seq<=lastSeenSeq 去重接管
    dispatcher(msg(13))
    expect(dispatchedSeqs(ports)).toEqual([13])
    // 后续 live 消息正常递进（基线已跟上 ring 末尾）
    dispatcher(msg(14))
    expect(dispatchedSeqs(ports)).toEqual([13, 14])
  })
})
