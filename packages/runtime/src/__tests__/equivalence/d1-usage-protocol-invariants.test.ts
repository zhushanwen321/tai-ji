/**
 * D1 协议收敛不变量（context-consistency Phase 1，w10 测试族扩展）。
 *
 * W1 任意触发路径产出的 session.state_changed 帧永不含 usage 三字段（序列化后断言 key 不存在）
 * W2 context.update 帧要么含全部三字段（真值），要么只含 sessionId（无值占位）——无部分字段 / 全 0
 * W3 session.getContext reply 与最近一次 context.update 帧 usage 字段一致（reply ≡ last-value）
 * W4 pi 重启重建（removeSessionEntry → 重播种）后，stateSnapshot 的 context last-value 与新实例快照一致
 *    （mock 基建无法 spawn 真实 pi 重启，按任务书降级为「removeSessionEntry 后重播种」单元断言）
 *
 * mock 层用例（fake pi client + 真 MessageBus），fake timers 驱动防抖 / 挂钩宏任务 /
 * thinkingLevel 30s 周期 poll——对齐 w10 / w12 的 fixture 形态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage, ClientMessage } from '@taiji/shared'
import { SessionService } from '../../services/session/session-service.js'
import { SessionMessageHandler } from '../../transport/session-message-handler.js'
import { MessageBus } from '../../services/message-bus/message-bus.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../../services/session/replicated-states.config.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { IPiEngine, IProcessManager, PiCommandInfo } from '../../services/ports/pi-engine.js'
import type { BusClient } from '../../services/message-bus/types.js'

/** state_changed 帧禁止携带的协议字段（D1 已删）。 */
const DELETED_USAGE_KEYS = ['usagePercent', 'inputTokens', 'contextLimit'] as const

/** 真 MessageBus + 可编程 mock pi client 的装置（返回类型推断；w12 同形态）。 */
function makeFixture(stats: Record<string, unknown> = { contextUsage: { tokens: 5000, contextWindow: 128000, percent: 3.9 } }) {
  const state = {
    sessionName: 'd1',
    thinkingLevel: 'low',
    model: { id: 'model-a', provider: 'p' },
    pendingMessageCount: 0,
  }
  const client = {
    getState: vi.fn(async () => state as Record<string, unknown>),
    getSessionStats: vi.fn(async () => stats as Record<string, unknown>),
    getCommands: vi.fn(async () => [] as PiCommandInfo[]),
    setModel: vi.fn(async () => undefined),
  }
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client as unknown as IPiEngine),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const publishSpy = vi.spyOn(bus, 'publish')
  const svc = new SessionService(
    pm,
    { broadcast: vi.fn() } as unknown as IMessageBroker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'p', modelId: 'model-a' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, bus, publishSpy, client }
}

/** 收集型 mock ws（BusClient 契约，stateSnapshot 断言用）。 */
function createMockWs(): BusClient & { sent: string[] } {
  const sent: string[] = []
  return { readyState: 1, send: (payload: string) => { sent.push(payload) }, sent }
}

/** publish spy 的结构形态（vi.spyOn(bus,'publish') 返回值的 mock.calls，structural 兼容）。 */
interface PublishSpyShape {
  mock: { calls: Array<[string, ServerMessage]> }
  mockClear(): void
}

/** publish spy 捕获的指定 type 全部帧（按调用顺序）。 */
function publishedFrames(spy: PublishSpyShape, type: ServerMessage['type']): ServerMessage[] {
  return spy.mock.calls
    .map(([, msg]) => msg)
    .filter((m) => m.type === type)
}

/** stateSnapshot 里按 type 找 last-value（重连/切回视角）。 */
function findStateMsg(msgs: ServerMessage[], type: ServerMessage['type']): ServerMessage | undefined {
  return msgs.find((m) => m.type === type)
}

/** W1 断言 helper：帧序列化后 usage 三 key 均不存在。 */
function expectNoUsageKeys(frames: ServerMessage[]): void {
  for (const frame of frames) {
    const serialized = JSON.stringify(frame.payload)
    for (const key of DELETED_USAGE_KEYS) {
      expect(serialized, `state_changed 帧 ${serialized} 不应含已删字段 ${key}`).not.toContain(`"${key}"`)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('W1：任意触发路径的 state_changed 帧永不含 usage 三字段', () => {
  it('播种 / switchModel 失效 / 事件失效重拉 / 30s 周期 poll 全路径无 usage key（序列化断言）', async () => {
    const fx = makeFixture()
    const sid = 'd1-w1'

    // 路径 1：播种 refetch（registerReplicatedStates → 三实例挂钩）
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'w1')
    await vi.advanceTimersByTimeAsync(1)
    expect(publishedFrames(fx.publishSpy, 'session.state_changed').length).toBeGreaterThanOrEqual(1)

    // 路径 2：switchModel 失效重拉（set_model RPC 成功 → modelId/usage/thinkingLevel markDirty）
    fx.client.getState.mockResolvedValue({
      sessionName: 'd1', thinkingLevel: 'medium', model: { id: 'model-b', provider: 'p' }, pendingMessageCount: 0,
    })
    await fx.svc.switchModel(sid, 'p' as never, 'model-b')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    // 路径 3：事件失效（turn_end 侧 applyContextUpdate 只失效 usage）
    fx.svc.applyContextUpdate(sid, 9000, 9000)
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    // 路径 4：thinkingLevel 失效驱动重拉（U6：30s 周期兜底已删，事件/RPC 响应失效替代；
    // 推进长时段验证「无失效不拉取」下不变量仍成立——帧数由路径 2/3 保证）
    await vi.advanceTimersByTimeAsync(65_000)

    // 不变量：全路径产出帧序列化后 usage 三 key 均不存在
    expectNoUsageKeys(publishedFrames(fx.publishSpy, 'session.state_changed'))
    // 帧确实产出过（防「零帧假绿」）
    expect(publishedFrames(fx.publishSpy, 'session.state_changed').length).toBeGreaterThanOrEqual(2)
  })
})

describe('W2：context.update 帧形态——全三字段（真值）或仅 sessionId（无值占位），无部分 / 无全 0', () => {
  it('真值帧：key 集合恰为 sessionId + 三字段', async () => {
    const fx = makeFixture()
    const sid = 'd1-w2-value'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'w2')
    await vi.advanceTimersByTimeAsync(1)

    const frames = publishedFrames(fx.publishSpy, 'context.update')
    expect(frames.length).toBeGreaterThanOrEqual(1)
    for (const frame of frames) {
      expect(Object.keys(frame.payload).sort()).toEqual(['contextLimit', 'inputTokens', 'sessionId', 'usagePercent'])
    }
  })

  it('无值占位帧：pi tokens=null → 仅含 sessionId（key 集合恰为 [sessionId]）', async () => {
    const fx = makeFixture()
    const sid = 'd1-w2-null'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'w2')
    await vi.advanceTimersByTimeAsync(1)
    fx.publishSpy.mockClear()

    // compact 后 tokens=null：事件失效 → 防抖重拉 → 空投影 → 占位帧
    fx.client.getSessionStats.mockResolvedValue({ contextUsage: { tokens: null, contextWindow: 128000, percent: null } })
    fx.svc.applyContextUpdate(sid, 0, 0)
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    const frames = publishedFrames(fx.publishSpy, 'context.update')
    expect(frames.length).toBeGreaterThanOrEqual(1)
    for (const frame of frames) {
      expect(Object.keys(frame.payload)).toEqual(['sessionId'])
    }
  })

  it('fetch 失败（退避重试窗口 / 从未成功）：不发占位帧也不发真值帧（帧计数不变）', async () => {
    const fx = makeFixture()
    const sid = 'd1-w2-fetchfail'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'w2')
    await vi.advanceTimersByTimeAsync(1)
    const before = publishedFrames(fx.publishSpy, 'context.update').length
    expect(before).toBeGreaterThanOrEqual(1)
    fx.publishSpy.mockClear()

    // fetch 抛错：fetchSessionStatsSnapshot throw → 挂钩不排 → 无帧（此刻值可能马上就来，
    // 发占位帧会让消费方误写 no-value）
    fx.client.getSessionStats.mockRejectedValue(new Error('rpc down'))
    fx.svc.applyContextUpdate(sid, 0, 0)
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

    expect(publishedFrames(fx.publishSpy, 'context.update')).toHaveLength(0)
  })
})

describe('W3：session.getContext reply ≡ 最近一次 context.update 帧（投影一次）', () => {
  /** 构造 SessionMessageHandler（真 SessionService 注入；session-trace makeHandler 同形态）。 */
  function makeHandler(svc: SessionService) {
    const replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[] = []
    const errors: { id: string | undefined; code: string; message: string }[] = []
    const handler = new SessionMessageHandler({
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        replies.push({ id, type, payload })
      }),
      sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
        errors.push({ id, code, message })
      }),
      sessionService: svc,
    } as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    const WS = { readyState: 1, send: vi.fn() } as never
    return { handler, replies, errors, WS }
  }

  function getContextMsg(sid: string): ClientMessage {
    return { type: 'session.getContext', id: 'req-ctx-1', payload: { sessionId: sid } }
  }

  it('有值态：reply 三字段 == stateSnapshot 的 context last-value 三字段', async () => {
    const fx = makeFixture()
    const sid = 'd1-w3-value'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'w3')
    await vi.advanceTimersByTimeAsync(1) // 播种收敛 → 真值帧为 last-value

    const { handler, replies, errors, WS } = makeHandler(fx.svc)
    await handler.handleSessionMessage(getContextMsg(sid), WS)

    expect(errors).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0]!.type).toBe('context.update')
    const lastValue = findStateMsg(fx.bus.subscribe(sid, createMockWs()).stateSnapshot, 'context.update')
    expect(replies[0]!.payload).toEqual(lastValue?.payload)
    expect(replies[0]!.payload).toEqual({
      sessionId: sid, inputTokens: 5000, contextLimit: 128000, usagePercent: 4,
    })
  })

  it('无值态：reply 仅含 sessionId == 占位帧 last-value（无 0 fallback）', async () => {
    const fx = makeFixture({ contextUsage: { tokens: null, contextWindow: 128000, percent: null } })
    const sid = 'd1-w3-null'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'w3')
    await vi.advanceTimersByTimeAsync(1) // 播种空投影 → 占位帧为 last-value

    const { handler, replies, errors, WS } = makeHandler(fx.svc)
    await handler.handleSessionMessage(getContextMsg(sid), WS)

    expect(errors).toHaveLength(0)
    expect(replies).toHaveLength(1)
    const reply = replies[0]!
    expect(reply.type).toBe('context.update')
    // D1：fetchContext null → reply 仅 sessionId（字段缺失 = 无值），与占位帧 last-value 同形
    expect(Object.keys(reply.payload)).toEqual(['sessionId'])
    const lastValue = findStateMsg(fx.bus.subscribe(sid, createMockWs()).stateSnapshot, 'context.update')
    expect(reply.payload).toEqual(lastValue?.payload)
  })
})

describe('W4：pi 重启重建（removeSessionEntry → 重播种）后 context last-value ≡ 新实例快照', () => {
  it('销毁全部实例 + bus clearSession 后重播种，stateSnapshot 的 context last-value == 新快照投影', async () => {
    const fx = makeFixture()
    const sid = 'd1-w4'
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'w4')
    await vi.advanceTimersByTimeAsync(1)
    expect(fx.svc.getScalarReplicatedStates(sid)?.usage.get()).toEqual({
      inputTokens: 5000, contextLimit: 128000, usagePercent: 4,
    })

    // pi 重启重建路径：removeSessionEntry（销毁四实例 + 清 diff 基线 + bus clearSession）
    fx.svc.removeSessionEntry(sid)
    expect(fx.svc.getScalarReplicatedStates(sid)).toBeUndefined()
    // bus 条目已清：无 last-value 残留（旧帧不泄漏给重建后的 stateSnapshot）
    expect(findStateMsg(fx.bus.subscribe(sid, createMockWs()).stateSnapshot, 'context.update')).toBeUndefined()

    // 新 pi 进程权威翻新（重播种前 mock 换值——模拟重启后 get_session_stats 投影变化）
    fx.client.getSessionStats.mockResolvedValue({ contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 } })
    fx.publishSpy.mockClear()
    await fx.svc.initializeManagedSession(sid, {} as unknown as IPiEngine, '/tmp', 'w4-rebuilt')
    await vi.advanceTimersByTimeAsync(1)

    // 重播种收敛：stateSnapshot 的 context last-value == 新实例快照投影（diff 基线已清，
    // 不因「上辈子同值」误判）
    const late = fx.bus.subscribe(sid, createMockWs())
    const lastValue = findStateMsg(late.stateSnapshot, 'context.update')
    const snapshot = fx.svc.getScalarReplicatedStates(sid)?.usage.get()
    expect(snapshot).toEqual({ inputTokens: 12000, contextLimit: 200000, usagePercent: 6 })
    expect(lastValue?.payload).toEqual({ sessionId: sid, ...snapshot })
  })
})
