/**
 * wave:runtime-message-bus::runtime-wiring 集成测试。
 *
 * 覆盖 MessageBus 接入 runtime 的 5 个接线点（TC1-TC9）：
 * - TC1/TC2：session-service send 回调（wave:perf-w09 单通道：session 级只走 bus.publish；
 *   全局无 sid 消息走 broker.broadcast 兜底）。
 * - TC3/TC4/TC5：session-message-handler 的 session.subscribe/unsubscribe RPC（含 fromSeq gap 检测）。
 * - TC6：ConnectionManager.onClose → bus.unsubscribeAll。
 * - TC7：session-service removeSessionEntry → bus.clearSession。
 * - TC8：session-service fetchAndBroadcastCommands 双写（session.commands 走 bus + broker）。
 * - TC9：ClientMessageMap subscribe/unsubscribe payload 形状（编译期 + 运行时构造）。
 *
 * Mock 策略（design-review mockStrategyNote）：
 * - mock MessageBus（vi.fn 跟踪 publish/subscribe/unsubscribe/clearSession/unsubscribeAll）。
 * - mock broker（IMessageBroker 桩：send/broadcast/sendError 全 vi.fn）。
 * - mock WebSocket（BusClient 形状 { readyState:1, send:vi.fn() }）。
 * - mock ctx（SessionHandlerContext 桩，reply 捕获）。
 *
 * 运行：cd packages/runtime && npx vitest run test/runtime-wiring.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerMessage, ClientMessage } from '@taiji/shared'

import { SessionService } from '../src/services/session/session-service.js'
import { AuthStorage } from '../src/services/auth/auth-storage.js'
import { AuthService } from '../src/services/auth/auth-service.js'
import { ProviderCredentialResolver } from '../src/services/auth/provider-credential-resolver.js'
import { QuotaService } from '../src/services/quota-service.js'
import { TaijiProviderStore } from '../src/services/provider-extras-store.js'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import { ConnectionManager } from '../src/transport/connection-manager.js'
import type { MessageBus } from '../src/services/message-bus/message-bus.js'
import type { BusClient } from '../src/services/message-bus/types.js'
import type { SessionHandlerContext } from '../src/transport/session-message-handler.js'

// ── mock helpers（参照 message-bus.test.ts + session-service.test.ts 范式）──────

/**
 * 创建 mock MessageBus：所有方法 vi.fn，便于断言调用次数与参数。
 * 不引入真实 MessageBus 实现（本 wave 测接线，bus 核心由 bus-core wave 覆盖）。
 */
function createMockMessageBus(): MessageBus {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  } as unknown as MessageBus
}

/** 创建 mock BusClient（ws 适配器契约）。readyState 默认 1（OPEN）。 */
function createMockWs(readyState: number = 1): BusClient & { sent: string[] } {
  const sent: string[] = []
  return { readyState, send: (data: string) => { sent.push(data) }, sent }
}

/**
 * 创建 mock IProcessManager（SessionService 构造依赖）。
 * 仅 stub 构造函数用到的 onSessionExit（进程退出回调注册）+ getClient（fetchAndBroadcastCommands 用）。
 * 与 session-service.test.ts 的 pm 桩对齐（本 wave 不测 pi 交互，pm 仅满足构造时序）。
 */
function createMockPm(overrides: Partial<{ getClient: ReturnType<typeof vi.fn> }> = {}) {
  return {
    onSessionExit: vi.fn(),
    getClient: overrides.getClient ?? vi.fn(() => undefined),
  }
}

// ───────────────────────────────────────────────────────────────────
// TC1 / TC2：session-service send 回调双写
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC1/TC2 session-service send 回调双写', () => {
  /**
   * 验证 initializeManagedSession 的内联 send 闭包接线：session 级消息（带 sessionId payload）
   * 双写走 bus.publish + broker.broadcast；全局消息（无 sessionId）只走 broker.broadcast。
   *
   * send 闭包是 initializeManagedSession 内联的，经 adapterFactory 第 2 参数透传。
   * 测试侧用捕获型 adapterFactory 拿到 send 闭包，再分别传入 session 级 / 全局消息断言路由。
   * mock client.getCommands reject 让 fetchAndBroadcastCommands catch no-op（避免 bus.publish 噪音）。
   */
  let messageBus: MessageBus
  let broker: { broadcast: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    messageBus = createMockMessageBus()
    broker = { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() }
  })

  /** 构造 SessionService + 注入 messageBus（可选），经 initializeManagedSession 触发并捕获 send 闭包。 */
  async function captureSend(injectBus: boolean): Promise<{ send: (msg: ServerMessage) => void; svc: SessionService }> {
    let captured: ((msg: ServerMessage) => void) | null = null
    const captureAdapterFactory = (_sid: string, send: (msg: ServerMessage) => void) => {
      captured = send
      return { attach: vi.fn(), detach: vi.fn() }
    }
    const pm = createMockPm()
    const fakeClient = {
      getState: vi.fn().mockResolvedValue({ sessionId: 'pi-x', sessionFile: '/fake/x.jsonl' }),
      getCommands: vi.fn().mockRejectedValue(new Error('mock: skip fetchAndBroadcast')),
    }
    vi.mocked(pm.getClient).mockReturnValue(fakeClient as never)
    // configStore 桩：getDefaultModel 返 undefined（modelId 留空，本测试不关注模型字段）。
    const configStore = { getDefaultModel: vi.fn(() => undefined) }
    const svc = new SessionService(
      pm as never, broker as never,
      captureAdapterFactory as never,
      '/tmp', {} as never, configStore as never, {} as never,
      { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never,
    )
    if (injectBus) svc.setMessageBus(messageBus)
    await (svc as unknown as { initializeManagedSession: (id: string, client: unknown, cwd: string, label: string) => Promise<unknown> })
      .initializeManagedSession('s1', fakeClient, '/tmp', 'test')
    if (!captured) throw new Error('send callback was not captured')
    return { send: captured, svc }
  }

  it('TC1: session 级消息（带 sessionId payload）单通道——只 bus.publish，broker.broadcast 不再被调', async () => {
    const { send } = await captureSend(true)
    // 清空 fetchAndBroadcastCommands 阶段的 broker.broadcast 调用记录（避免噪音）
    broker.broadcast.mockClear()
    vi.mocked(messageBus.publish).mockClear()

    const msg: ServerMessage = { type: 'message.text_delta', payload: { sessionId: 's1', delta: 'hello' } }
    send(msg)
    // session 级：bus.publish 被调（'s1', msg），恰好一次（D1-2 单通道）
    expect(messageBus.publish).toHaveBeenCalledTimes(1)
    expect(messageBus.publish).toHaveBeenCalledWith('s1', msg)
    // wave:perf-w09（D1-2）：broadcast 腿已删——盲广播不再发生
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('TC2: 全局消息（无 sessionId payload）只走 broker.broadcast，不经 bus', async () => {
    const { send } = await captureSend(true)
    broker.broadcast.mockClear()
    vi.mocked(messageBus.publish).mockClear()

    const msg: ServerMessage = { type: 'config.sessions', payload: { groups: [] } }
    send(msg)
    // 全局消息：bus.publish 未被调
    expect(messageBus.publish).not.toHaveBeenCalled()
    // broker.broadcast 被调（盲广播保留）
    expect(broker.broadcast).toHaveBeenCalledTimes(1)
    expect(broker.broadcast).toHaveBeenCalledWith(msg)
  })

  it('TC1 边界：message.complete 带 sessionId 时仍触发 onMessageComplete 回调', async () => {
    const { send, svc } = await captureSend(true)
    const cb = vi.fn()
    svc.setOnMessageComplete(cb)
    broker.broadcast.mockClear()
    vi.mocked(messageBus.publish).mockClear()

    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's-complete' } }
    send(msg)
    expect(cb).toHaveBeenCalledWith('s-complete')
    expect(messageBus.publish).toHaveBeenCalledWith('s-complete', msg)
    // wave:perf-w09（D1-2）：broadcast 腿已删
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('未注入 messageBus 时（nullable）session 级消息不抛错（publish no-op，broker 也不走）', async () => {
    const { send } = await captureSend(false)
    broker.broadcast.mockClear()

    const msg: ServerMessage = { type: 'message.text_delta', payload: { sessionId: 's1' } }
    // wave:perf-w09（D1-2）：bus 未注入时 this.messageBus?.publish 静默 no-op——不抛错；
    // sid 存在故不走 broker 兜底分支（else 只接无 sid 消息）。组合根恒注入 bus，此为防御语义。
    expect(() => send(msg)).not.toThrow()
    expect(broker.broadcast).not.toHaveBeenCalled()
    expect(messageBus.publish).not.toHaveBeenCalled()
  })
})

// ───────────────────────────────────────────────────────────────────
// TC3 / TC4 / TC5：session-message-handler subscribe/unsubscribe RPC
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC3/TC4/TC5 session.subscribe/unsubscribe RPC', () => {
  /** 构造 SessionMessageHandler + mock ctx，返回 handler + 捕获 reply 的工具。 */
  function createHandlerWithMocks(busOverride?: Partial<MessageBus>) {
    const messageBus = { ...createMockMessageBus(), ...busOverride } as MessageBus
    const reply = vi.fn()
    const sendError = vi.fn()
    const ctx: SessionHandlerContext = {
      send: vi.fn(),
      reply,
      sendError,
      sessionService: {} as never,
      messageBus,
      nextPushId: () => 'push_test',
      broadcastSessionList: vi.fn(),
      broadcast: vi.fn(),
      invalidatePendingUiRequests: vi.fn(),
    }
    const handler = new SessionMessageHandler(ctx)
    return { handler, ctx, reply, sendError, messageBus }
  }

  it('TC3: session.subscribe 调 bus.subscribe + reply { snapshot, stateSnapshot, lastSeq, gap:false }', async () => {
    const snapshot = [{ type: 'pong', seq: 1, payload: {} }, { type: 'pong', seq: 2, payload: {} }] as ServerMessage[]
    const stateSnapshot = [{ type: 'session.commands', seq: 1, payload: { sessionId: 's1', commands: [] } }] as ServerMessage[]
    const { handler, reply, messageBus } = createHandlerWithMocks({
      subscribe: vi.fn(() => ({ snapshot: [...snapshot], stateSnapshot: [...stateSnapshot], lastSeq: 2 })),
    })
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-1', payload: { sessionId: 's1' } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)

    expect(messageBus.subscribe).toHaveBeenCalledTimes(1)
    expect(messageBus.subscribe).toHaveBeenCalledWith('s1', ws)
    expect(reply).toHaveBeenCalledWith(ws, 'rpc-1', 'session.subscribe', { snapshot, stateSnapshot, lastSeq: 2, gap: false })
  })

  it('TC4: session.subscribe 带 fromSeq 增量过滤（fromSeq=1, oldestSeq=1 → 无 gap，过滤 seq>1；stateSnapshot 不受影响）', async () => {
    // ring 中有 seq 1,2,3；fromSeq=1 表示已处理到 1，应返 seq>1 的 [2,3]，gap=false
    const snapshot = [
      { type: 'pong', seq: 1, payload: {} },
      { type: 'pong', seq: 2, payload: {} },
      { type: 'pong', seq: 3, payload: {} },
    ] as ServerMessage[]
    const stateSnapshot = [{ type: 'context.update', seq: 1, payload: { sessionId: 's1', usagePercent: 50 } }] as ServerMessage[]
    const { handler, reply } = createHandlerWithMocks({
      subscribe: vi.fn(() => ({ snapshot: [...snapshot], stateSnapshot: [...stateSnapshot], lastSeq: 3 })),
    })
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-2', payload: { sessionId: 's1', fromSeq: 1 } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)

    // 过滤后 snapshot 只含 seq>1；stateSnapshot 是 last-value 不受 fromSeq 影响
    const replyCall = reply.mock.calls[0]
    expect(replyCall[0]).toBe(ws)
    expect(replyCall[1]).toBe('rpc-2')
    expect(replyCall[2]).toBe('session.subscribe')
    const payload = replyCall[3] as { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap: boolean }
    expect(payload.gap).toBe(false)
    expect(payload.lastSeq).toBe(3)
    expect(payload.snapshot.map(m => m.seq)).toEqual([2, 3])
    // stateSnapshot 全量透传（不被 fromSeq 过滤）
    expect(payload.stateSnapshot).toEqual(stateSnapshot)
  })

  it('TC4: session.subscribe fromSeq < oldestSeq（gap 检测，返全量 + gap:true）', async () => {
    // ring 最旧 seq=1，fromSeq=0 < 1 → 旧消息已被淘汰，gap=true 返全量
    const snapshot = [
      { type: 'pong', seq: 1, payload: {} },
      { type: 'pong', seq: 2, payload: {} },
    ] as ServerMessage[]
    const { handler, reply } = createHandlerWithMocks({
      subscribe: vi.fn(() => ({ snapshot: [...snapshot], stateSnapshot: [], lastSeq: 2 })),
    })
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-3', payload: { sessionId: 's1', fromSeq: 0 } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)

    const payload = reply.mock.calls[0][3] as { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap: boolean }
    expect(payload.gap).toBe(true)
    // 全量返（不过滤）
    expect(payload.snapshot.map(m => m.seq)).toEqual([1, 2])
    expect(payload.stateSnapshot).toEqual([])
  })

  it('TC4 边界：bus.subscribe 返空 snapshot + fromSeq=0 → gap=false（无旧消息可淘汰）', async () => {
    // 空 ring：oldestSeq=0（snapshot[0]?.seq ?? 0），fromSeq=0 不 < 0，gap=false
    const { handler, reply } = createHandlerWithMocks({
      subscribe: vi.fn(() => ({ snapshot: [], stateSnapshot: [], lastSeq: 0 })),
    })
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-4', payload: { sessionId: 's1', fromSeq: 0 } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)
    const payload = reply.mock.calls[0][3] as { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; gap: boolean }
    expect(payload.gap).toBe(false)
    expect(payload.snapshot).toEqual([])
    expect(payload.stateSnapshot).toEqual([])
  })

  it('TC5: session.unsubscribe 调 bus.unsubscribe + reply message.status ack', async () => {
    const { handler, reply, messageBus } = createHandlerWithMocks()
    const ws = createMockWs()
    const msg = { type: 'session.unsubscribe', id: 'rpc-5', payload: { sessionId: 's1' } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)

    expect(messageBus.unsubscribe).toHaveBeenCalledTimes(1)
    expect(messageBus.unsubscribe).toHaveBeenCalledWith('s1', ws)
    // ack 型：reply 'message.status'（ReplyPayloadMap 已定 void//reply message.status）
    expect(reply).toHaveBeenCalledWith(ws, 'rpc-5', 'message.status', { sessionId: 's1', status: 'unsubscribed' })
  })

  it('TC3 边界：messageBus 未注入时 session.subscribe 报 subscribe_unsupported', async () => {
    // 构造一个 ctx 不含 messageBus（模拟组合根未注入——理论不可达，防御性测）
    const reply = vi.fn()
    const sendError = vi.fn()
    const ctx = {
      send: vi.fn(), reply, sendError,
      sessionService: {} as never,
      nextPushId: () => 'push_test',
      broadcastSessionList: vi.fn(),
      broadcast: vi.fn(),
      // messageBus 故意不注入
    } as unknown as SessionHandlerContext
    const handler = new SessionMessageHandler(ctx)
    const ws = createMockWs()
    const msg = { type: 'session.subscribe', id: 'rpc-6', payload: { sessionId: 's1' } } as unknown as ClientMessage
    await handler.handleSessionMessage(msg, ws as never)
    expect(sendError).toHaveBeenCalledWith(ws, 'subscribe_unsupported', 'message bus not available', 'rpc-6', { sessionId: 's1' })
  })
})

// ───────────────────────────────────────────────────────────────────
// TC6：ConnectionManager.onClose → bus.unsubscribeAll
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC6 ConnectionManager.onClose → bus.unsubscribeAll', () => {
  it('ws close 时调 onDisconnect 回调（server 注入 bus.unsubscribeAll）', async () => {
    const messageBus = createMockMessageBus()
    // 用真实 ConnectionManager + 注入 onDisconnect 回调（模拟 server.ts 的接线）
    // 选一个空闲端口避免冲突；start 后模拟 ws close。
    const conn = new ConnectionManager(0, {
      onConnect: () => {},
      onMessage: vi.fn(),
      sendError: vi.fn(),
      onDisconnect: (ws) => messageBus.unsubscribeAll(ws as unknown as BusClient),
    }, 'test-ws-token-wiring')
    await conn.start()
    // 直接从 clients 池取一个 ws 模拟 close 事件（clients 是 readonly Set，handleConnection 时 add）。
    // 由于无法轻易构造真实 ws 进 connection 回调，改为验证 onDisconnect 回调本身接线正确：
    const fakeWs = createMockWs()
    // 手动触发 onDisconnect（验证回调调 bus.unsubscribeAll）
    ;(conn as unknown as { callbacks: { onDisconnect?: (ws: unknown) => void } }).callbacks.onDisconnect?.(fakeWs)
    expect(messageBus.unsubscribeAll).toHaveBeenCalledTimes(1)
    expect(messageBus.unsubscribeAll).toHaveBeenCalledWith(fakeWs)
    await conn.stop()
  })

  it('onDisconnect 可选（未注入时不抛错，向后兼容）', async () => {
    // 不注入 onDisconnect——旧 ConnectionCallbacks 形状仍合法
    const conn = new ConnectionManager(0, {
      onConnect: () => {},
      onMessage: vi.fn(),
      sendError: vi.fn(),
    }, 'test-ws-token-wiring')
    await conn.start()
    expect(() => {
      ;(conn as unknown as { callbacks: { onDisconnect?: (ws: unknown) => void } }).callbacks.onDisconnect?.(createMockWs())
    }).not.toThrow()
    await conn.stop()
  })
})

// ───────────────────────────────────────────────────────────────────
// TC7：session-service removeSessionEntry → bus.clearSession
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC7 removeSessionEntry → bus.clearSession', () => {
  it('removeSessionEntry 调 bus.clearSession(sessionId)', () => {
    const messageBus = createMockMessageBus()
    const service = new SessionService(
      createMockPm() as never, { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() } as never,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/tmp', {} as never, {} as never, {} as never,
      { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never,
    )
    service.setMessageBus(messageBus)
    // removeSessionEntry 是内部协议公开方法（lifecycle/dispatcher 窄接口共享声明）
    service.removeSessionEntry('s-destroy')
    expect(messageBus.clearSession).toHaveBeenCalledTimes(1)
    expect(messageBus.clearSession).toHaveBeenCalledWith('s-destroy')
  })

  it('未注入 messageBus 时 removeSessionEntry 仍正常（nullable no-op，不抛错）', () => {
    const service = new SessionService(
      createMockPm() as never, { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() } as never,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/tmp', {} as never, {} as never, {} as never,
      { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never,
    )
    // 不调 setMessageBus
    expect(() => service.removeSessionEntry('s-x')).not.toThrow()
  })
})

// ───────────────────────────────────────────────────────────────────
// TC8：session.commands 发布单通道（W12 起激活发布 = 播种 fetch 快照挂钩，仍只走 bus.publish）
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC8 session.commands 激活发布（W12 快照挂钩）', () => {
  it('播种 fetch → 快照应用挂钩发布 session.commands，只调 bus.publish(sessionId, msg)，broker.broadcast 不再被调', async () => {
    const messageBus = createMockMessageBus()
    const broadcast = vi.fn()
    // 构造 SessionService + mock pm.getClient 返回带 getCommands 的 client
    const commands = [{ name: 'cmd1', source: 'extension' }]
    const fakeClient = { getCommands: vi.fn().mockResolvedValue(commands) }
    const pm = createMockPm({ getClient: vi.fn().mockReturnValue(fakeClient) })
    const service = new SessionService(
      pm as never,
      { broadcast, send: vi.fn(), sendError: vi.fn() } as never,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/tmp', {} as never, { getDefaultModel: () => undefined } as never, {} as never,
      { readGitInfo: () => undefined, pruneStaleCache: () => {} } as never, {} as never,
    )
    service.setMessageBus(messageBus)

    // W12：旧 fetchAndBroadcastCommands（RPC 直连 publish）已删——激活发布 = initializeManagedSession
    // 注册播种 refetch → commands 快照应用 → fetchCommandsSnapshot 挂钩（setTimeout 0 宏任务）
    // 读快照发布（publishCommandsSnapshot 有 sessions.has 防护，须经真实 session 建立路径）。
    await service.initializeManagedSession('s-cmd', { getCommands: fakeClient.getCommands } as never, '/tmp', 't')
    // 播种 fetch 是 fire-and-forget（微任务链 applySnapshot），挂钩宏任务在其后——轮询等
    // publish 落地（全量并行负载下固定 sleep 不可靠，2s 上限兜底）。等待条件必须是
    // commands 帧本身而非「任意 publish」：registerSession 现含 occupancy idle 宣告帧
    // （Gate B V6b 修复），任意帧出现 ≠ 播种链宏任务完成。
    const deadline = Date.now() + 2_000
    const hasCommandsPublish = () =>
      vi.mocked(messageBus.publish).mock.calls.some((c) => c[1].type === 'session.commands')
    while (!hasCommandsPublish() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // session.commands 单通道（wave:perf-w09 D1-2）：只 bus.publish，broadcast 腿已删。
    // payload 数据源 = commands 实例快照（W12），值与 mock RPC 返回逐字段一致。
    //（publish 总数可能含 modelId/thinkingLevel 播种失败后的 state_changed 兜底帧——
    // fakeClient 无 getState，与本用例的 commands 通道断言无关，按 type 过滤。）
    const cmdPublishes = vi.mocked(messageBus.publish).mock.calls.filter((c) => c[1].type === 'session.commands')
    expect(cmdPublishes).toHaveLength(1)
    const publishCall = cmdPublishes[0]
    expect(publishCall[0]).toBe('s-cmd')
    expect(publishCall[1]).toMatchObject({ type: 'session.commands', payload: { sessionId: 's-cmd', commands } })

    expect(broadcast).not.toHaveBeenCalled()
  })
})

// ───────────────────────────────────────────────────────────────────
// TC9：ClientMessageMap subscribe/unsubscribe payload 形状（编译期 + 运行时）
// ───────────────────────────────────────────────────────────────────

describe('wave:runtime-wiring · TC9 ClientMessageMap subscribe/unsubscribe payload', () => {
  it('session.subscribe ClientMessage 带 fromSeq 可构造（payload 形状正确）', () => {
    const msg: Extract<ClientMessage, { type: 'session.subscribe' }> = {
      type: 'session.subscribe',
      id: 'rpc-1',
      payload: { sessionId: 's1', fromSeq: 5 },
    }
    expect(msg.type).toBe('session.subscribe')
    expect(msg.payload.sessionId).toBe('s1')
    expect(msg.payload.fromSeq).toBe(5)
  })

  it('session.subscribe ClientMessage 不带 fromSeq 也合法（fromSeq 可选）', () => {
    const msg: Extract<ClientMessage, { type: 'session.subscribe' }> = {
      type: 'session.subscribe',
      id: 'rpc-2',
      payload: { sessionId: 's1' },
    }
    expect(msg.payload.fromSeq).toBeUndefined()
  })

  it('session.unsubscribe ClientMessage payload 形状正确', () => {
    const msg: Extract<ClientMessage, { type: 'session.unsubscribe' }> = {
      type: 'session.unsubscribe',
      id: 'rpc-3',
      payload: { sessionId: 's1' },
    }
    expect(msg.type).toBe('session.unsubscribe')
    expect(msg.payload.sessionId).toBe('s1')
  })
})

// ───────────────────────────────────────────────────────────────────
// M2c：D3 组合根接线（index.ts / pi-provider-store.ts 源码级断言）
//
// index.ts 不可 import（模块顶层 `main().catch(...)` 即执行，会起真实进程/监听端口），
// 故组合根装配接线只能做源码级断言；它与行为断言互补——行为断言证明「消费点注入后生效」，
// 本组证明「组合根/传输层真的把 resolver 传到了那些消费点」，以及装配序（init 先于任何
// findValidDefaultModel 触发点）。pi-provider-store 的 readAuthCredentials 已删除，
// 此处同时锁定该裸读不会回归。
// ───────────────────────────────────────────────────────────────────
describe('M2c: 组合根 providerCredentialResolver 装配接线（源码级 + quota 近端到端）', () => {
  const readSource = (relPath: string): string =>
    readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf-8')

  const indexSource = readSource('../src/index.ts')
  const providerStoreSource = readSource('../src/infra/pi/pi-provider-store.ts')

  it('index.ts 装配 ProviderCredentialResolver 三依赖（authService / authStorage / configStore）', () => {
    const idx = indexSource.indexOf('new ProviderCredentialResolver({')
    expect(idx).toBeGreaterThan(-1)
    const block = indexSource.slice(idx, indexSource.indexOf('})', idx))
    expect(block).toContain('authService')
    expect(block).toContain('authStorage')
    expect(block).toContain('configStore')
  })

  it('装配序：init 注入先于任何 findValidDefaultModel 触发点（服务构造 / server.start / 后台初始化）', () => {
    const initIdx = indexSource.indexOf('initProviderCredentialResolver(providerCredentialResolver)')
    expect(initIdx).toBeGreaterThan(-1)
    for (const later of [
      'new ConfigService(',
      'new SessionService(',
      'new AuthService(',
      'new QuotaService(',
      'await server.start()',
      'runStartupBackgroundInit(',
    ]) {
      const laterIdx = indexSource.indexOf(later)
      expect(laterIdx, `index.ts 缺少 ${later}`).toBeGreaterThan(-1)
      expect(initIdx, `init 必须早于 ${later}`).toBeLessThan(laterIdx)
    }
  })

  it('三处消费点装配均收到 resolver：ConfigService 构造 / QuotaService options / server.setServices optional', () => {
    // ① ConfigService：组合根第 6 参
    const configLine = indexSource.split('\n').find(l => l.includes('new ConfigService('))
    expect(configLine).toContain('providerCredentialResolver')

    // ② QuotaService options
    const quotaStart = indexSource.indexOf('new QuotaService({')
    expect(quotaStart).toBeGreaterThan(-1)
    expect(indexSource.slice(quotaStart, indexSource.indexOf('const tServicesReady', quotaStart))).toContain('providerCredentialResolver')

    // ③ server.setServices optional 对象（链 2 经此进 SettingsMessageHandler ctx）
    const setServicesStart = indexSource.indexOf('server.setServices(')
    expect(setServicesStart).toBeGreaterThan(-1)
    expect(indexSource.slice(setServicesStart, indexSource.indexOf('// Graceful shutdown', setServicesStart))).toContain('providerCredentialResolver')
  })

  it('D-21 端口化：组合根构造 ModelConnectionTester 经 server.setServices 注入，transport 零 infra value import', () => {
    // ① 组合根构造（组合根允许 value import infra 实现）
    expect(indexSource).toContain('new ModelConnectionTester()')
    // ② server.setServices optional 对象入参（经此进 SettingsMessageHandler ctx）
    const setServicesStart = indexSource.indexOf('server.setServices(')
    expect(setServicesStart).toBeGreaterThan(-1)
    expect(indexSource.slice(setServicesStart, indexSource.indexOf('// Graceful shutdown', setServicesStart))).toContain('connectionTester')
    // ③ transport 关闭 M3a 让步：不再 value import infra 的 tester 实现
    const handlerSource = readSource('../src/transport/settings-message-handler.ts')
    expect(handlerSource).not.toMatch(/import\s+\{\s*ModelConnectionTester\s*\}/)
    expect(handlerSource).toContain("from '../services/ports/model-connection-tester.js'")
  })

  it('clearApiKey（I9 清理②）接到纯删键实现 clearProviderApiKey', () => {
    expect(indexSource).toContain('clearApiKey: clearProviderApiKey')
  })

  it('链 3 私有裸读 readAuthCredentials 已不存在（防回归：不得再出现裸读 auth.json）', () => {
    expect(providerStoreSource).not.toContain('readAuthCredentials')
    // 消费点改经注入的 resolver：单 provider 判定用 sync 布尔版 + 候选遍历用批量版（消除 N+1）
    // RT-3#5：消费点经 credentialResolverOrWarn（未注入一次性 warn 显形；返回注入的 resolver，语义不变）
    expect(providerStoreSource).toContain("credentialResolverOrWarn('adjudicateCatalogOnlyDefault')?.hasProviderCredential(")
    expect(providerStoreSource).toContain("credentialResolverOrWarn('pickCredentialBackedCatalogProvider')?.listCredentialBackedProviderIds(")
  })

  it('QuotaService 消费点（生产装配形态）：api-key 凭据经注入 resolver 解析并真实用于请求', async () => {
    // 近端到端：按组合根 index.ts 的装配形态构造真实 ProviderCredentialResolver
    // （auth.json 经真实 AuthStorage）+ 真实 QuotaService，驱动 refresh 走 getCredential 链。
    const quotaDir = mkdtempSync(join(tmpdir(), 'm2c-quota-'))
    const authPath = join(quotaDir, 'auth.json')
    writeFileSync(authPath, JSON.stringify({ 'zai-coding-cn': { type: 'api_key', key: 'k-from-auth-json' } }))
    const authStorage = new AuthStorage(authPath)
    // 生产形态：resolver 的 auth.json 明文腿经 AuthService.getCredential（index.ts 同款装配）
    const authService = new AuthService({
      authStorage,
      getOAuthConfig: () => undefined,
      broadcast: () => {},
      nextPushId: () => '1',
      clearApiKey: () => {},
    })
    const resolver = new ProviderCredentialResolver({
      authService,
      authStorage,
      configStore: { readModels: () => ({ providers: {} }), getProviderConfig: () => undefined } as never,
    })
    const resolveSpy = vi.spyOn(resolver, 'resolveProviderCredential')
    const extrasStore = new TaijiProviderStore(join(quotaDir, 'config', 'providers.json'))
    await extrasStore.modify('zai-coding-cn', () => ({ quota: { fetcher: 'zhipu', enabled: true } }))
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) =>
      new Response(JSON.stringify({
        success: true,
        data: { level: 'Max', limits: [{ type: 'TOKENS_LIMIT', percentage: 40 }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const svc = new QuotaService({
        dataDir: quotaDir,
        providerExtrasStore: extrasStore,
        getProviderInfo: (id) => (id === 'zai-coding-cn' ? { name: id, quota: { fetcher: 'zhipu' } } : undefined),
        providerCredentialResolver: resolver,
      })

      await svc.refresh('zai-coding-cn')

      // 凭据链经 resolver（而非旧内联 auth.json/models.json 链）
      expect(resolveSpy).toHaveBeenCalledWith('zai-coding-cn')
      // 且解析出的 key 真实进入请求头（zhipu 裸 authorization，无 Bearer 前缀）
      expect(new Headers(fetchMock.mock.calls[0]![1].headers).get('authorization')).toBe('k-from-auth-json')
    } finally {
      vi.unstubAllGlobals()
      rmSync(quotaDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
