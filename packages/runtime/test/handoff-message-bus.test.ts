/**
 * Handoff + MessageBus 集成测试（wave:handoff-integration）。
 *
 * 端到端验证 BLOCKER-1：handoff 完成后新 session 的流式响应从 message_start 完整可见。
 *
 * 核心场景：
 * - handoffService.runHandoff → newClient.prompt(doc) 后，EventInterpreter 产生的
 *   message_start/text_delta 经 send 回调进 bus.publish(newId, msg)。
 * - renderer subscribe(newId) 后，bus 回放 ring 里的 message_start + text_delta 等事件。
 * - 新 session 流式完整可见。
 *
 * 测试模式：用真实 MessageBus 实例（不 mock），只 mock 外部依赖（RpcClient/SessionService）。
 * send 回调直接调 bus.publish（模拟 runtime-wiring 的双写逻辑）。
 *
 * 测试框架：vitest（禁止 node:test）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageBus } from '../src/services/message-bus/message-bus.js'
import { HandoffService } from '../src/services/handoff-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { SessionService } from '../src/services/session/session-service.js'
import type { IPiEngine } from '../src/services/ports/pi-engine.js'
import type { BusClient } from '../src/services/message-bus/types.js'
import type { ServerMessage } from '@taiji/shared'
import type { Message } from '@taiji/shared'

/**
 * 测试辅助：构造 ServerMessage（绕过 payload 形状检查，只关心 type + payload.sessionId）。
 * 集成测试不验证 payload 内部结构（那是 protocol wave 的事），只验证 bus 的 ring/seq/subscribe 语义。
 * 使用 `as unknown as ServerMessage` 避免 ServerMessageType 联合的字面量检查。
 */
function makeMsg(type: string, payload: Record<string, unknown>): ServerMessage {
  return { type, payload } as unknown as ServerMessage
}

// ── Mock helpers ──────────────────────────────────────────────────

/**
 * Mock IPiEngine：记录 onEvent 注册的 listener，提供 emit 触发。
 * prompt/abort 默认立即 resolve（fire-and-forget ack）。
 */
interface MockClient {
  prompt: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  exited: boolean
  _listeners: Set<(event: unknown) => void>
  /** 触发所有已注册 listener。 */
  emit(event: unknown): void
}

function createMockClient(): MockClient {
  const listeners = new Set<(event: unknown) => void>()
  // 这些用例不测退出路径：onExit 只支持注册/解绑（runHandoff 会订阅），不提供触发。
  const exitListeners = new Set<(code: number | null, stderr: string) => void>()
  const client: MockClient = {
    prompt: vi.fn(async () => ({})),
    abort: vi.fn(async () => ({})),
    exited: false,
    _listeners: listeners,
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    onExit: vi.fn((callback: (code: number | null, stderr: string) => void) => {
      exitListeners.add(callback)
      return () => {
        exitListeners.delete(callback)
      }
    }),
    emit(event: unknown) {
      for (const l of listeners) l(event)
    },
  }
  return client
}

/**
 * 创建 mock BusClient（模拟 WebSocket）。
 */
function createMockBusClient(): BusClient & { _sent: string[] } {
  const sent: string[] = []
  const client: BusClient & { _sent: string[] } = {
    readyState: 1, // OPEN
    send: vi.fn((data: string) => { sent.push(data) }),
    _sent: sent,
  }
  return client
}

/**
 * 创建 mock SessionService，send 回调直接调 bus.publish（模拟 runtime-wiring）。
 *
 * 关键：initializeManagedSession 的 send 回调做双写（bus.publish + broker.broadcast），
 * 这里只保留 bus.publish 路径（broker.broadcast 在集成测试中不关心）。
 */
function createMockSessionService(opts: {
  srcSessionId: string
  newSessionId: string
  srcClient: MockClient
  newClient: MockClient
  bus: MessageBus
}): SessionService {
  const { srcSessionId, newSessionId, srcClient, newClient } = opts

  return {
    getHistory: vi.fn(async () => ({
      messages: [{ id: 'msg-1', role: 'user', content: 'hi', status: 'complete', timestamp: Date.now() }] as Message[],
      truncated: false,
    })),
    getSession: vi.fn(() => ({
      cwd: '/tmp',
      label: 'src',
      sessionFilePath: '/tmp/s.json',
    })) as unknown as SessionService['getSession'],
    // D6（state-truth-sync C5）：runHandoff create 前读源生效值会调 findScannedSession
    //（内存实例字段缺值时的 sidecar 兜底）——mock 缺方法会 TypeError。
    findScannedSession: vi.fn(() => undefined) as unknown as SessionService['findScannedSession'],
    create: vi.fn(async () => ({
      id: newSessionId,
      label: 'handoff from src',
      cwd: '/tmp',
    })) as unknown as SessionService['create'],
    markHandedOff: vi.fn() as unknown as SessionService['markHandedOff'],
    ensureActive: vi.fn(async (sessionId: string) => {
      if (sessionId === srcSessionId) return srcClient as unknown as IPiEngine
      if (sessionId === newSessionId) return newClient as unknown as IPiEngine
      throw new Error(`ensureActive: unexpected sessionId ${sessionId}`)
    }) as unknown as SessionService['ensureActive'],
  } as unknown as SessionService
}

function createMockBroker(): IMessageBroker {
  return {
    broadcast: vi.fn(),
    send: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('Handoff + MessageBus integration (BLOCKER-1)', () => {
  let bus: MessageBus
  let broker: IMessageBroker
  let broadcastSessionList: () => void
  let nextPushId: () => string
  let srcClient: MockClient
  let newClient: MockClient
  let sessionService: SessionService
  let service: HandoffService

  const SRC_ID = 'src-1'
  const NEW_ID = 'new-1'

  beforeEach(() => {
    bus = new MessageBus()
    broker = createMockBroker()
    broadcastSessionList = vi.fn()
    nextPushId = vi.fn(() => 'push-123')
    srcClient = createMockClient()
    newClient = createMockClient()
    sessionService = createMockSessionService({
      srcSessionId: SRC_ID,
      newSessionId: NEW_ID,
      srcClient,
      newClient,
      bus,
    })
    service = new HandoffService({ sessionService, broker, broadcastSessionList, nextPushId })
  })

  /**
   * TC1: handoff 注入新 session 时，bus.publish 缓存 message_start + text_delta。
   *
   * 场景：runHandoff 流程中，newClient.prompt(doc) 后，EventInterpreter 产生的
   * message_start/text_delta 经 send 回调进 bus.publish(newId, msg)。
   * 验证 bus 的 streamRing 包含这些事件。
   *
   * wave:perf-w06（D5-1）：text_delta 归 transient——不入 ring、不分配 seq、直传订阅者；
   * 只有 stream 类（message_start）入 ring。快照完整性语义随之调整。
   */
  it('TC1: handoff flow publishes message_start (stream) to bus ring; text_delta is transient', async () => {
    // 启动 handoff
    const runPromise = service.runHandoff(SRC_ID)
    await new Promise((r) => setTimeout(r, 0))

    // srcClient.prompt 已被调用（handoff prompt）
    expect(srcClient.prompt).toHaveBeenCalledTimes(1)

    // emit agent_end → runHandoff 完成 → create new session → newClient.prompt(doc)
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'handoff doc' }], stopReason: 'stop' }],
      willRetry: false,
    })

    await runPromise

    // newClient.prompt 已被调用（wrapWithXmlTag(doc) 注入）
    expect(newClient.prompt).toHaveBeenCalledTimes(1)
    const injectedPrompt = newClient.prompt.mock.calls[0][0] as string
    expect(injectedPrompt).toContain('<handoff_document source="')
    expect(injectedPrompt).toContain('handoff doc')
    expect(injectedPrompt).toContain('</handoff_document>')

    // 模拟 EventInterpreter 产生的流式事件：message_start + text_delta
    // 使用 makeMsg 构造合法的 ServerMessage
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID, role: 'assistant' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Hello' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' world' }))

    // 验证 bus 内部 ring 只含 stream 类（message_start）；text_delta 是 transient 不入 ring
    // subscribe 返回 snapshot 验证 ring 内容
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    expect(result.snapshot).toHaveLength(1)
    expect(result.snapshot[0]!.type).toBe('message.message_start')
    // seq 只对 stream/state 分配：message_start 是 seq 1，两条 text_delta 不占 seq
    expect(result.snapshot[0]!.seq).toBe(1)
    expect(result.lastSeq).toBe(1)
  })

  /**
   * TC2: renderer subscribe(newId) 后拿到 stream 类完整 snapshot。
   *
   * 场景：bus.publish 若干条后，调 subscribe(newId)，验证 snapshot 包含
   * message_start + complete（stream 类，按顺序回放）。
   *
   * wave:perf-w06（D5-1）：text_delta 归 transient（高频流，丢失可接受、不回放），
   * subscribe 快照只含 stream 类；delta 的连续性靠 live push 保证。
   */
  it('TC2: subscribe after publish returns stream-only snapshot (message_start + complete)', () => {
    // 发布一系列流式事件
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID, role: 'assistant' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Part 1' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Part 2' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Part 3' }))
    bus.publish(NEW_ID, makeMsg('message.complete', { sessionId: NEW_ID, role: 'assistant' }))

    // renderer subscribe
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    // snapshot 只含 stream 类（message_start + complete），按发布顺序
    expect(result.snapshot).toHaveLength(2)
    expect(result.snapshot.map((m) => m.type)).toEqual([
      'message.message_start',
      'message.complete',
    ])
    // lastSeq 只随 stream/state 类推进（2 条 stream）
    expect(result.lastSeq).toBe(2)
  })

  /**
   * TC3: subscribe 后的 live push 正确路由。
   *
   * 场景：subscribe 后继续 publish，验证新事件自动推给已订阅的 ws。
   * wave:perf-w06（D5-1）：transient 类（text_delta）不入 ring 但 live push 照常直传（无 seq）。
   */
  it('TC3: live push after subscribe delivers new events to subscribed ws', () => {
    // 先发布 2 条（1 条 stream + 1 条 transient——ring 只存前者）
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'initial' }))

    // subscribe
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    expect(result.snapshot).toHaveLength(1)
    expect(result.lastSeq).toBe(1)

    // 清除 subscribe 期间的 send 记录
    vi.mocked(ws.send).mockClear()

    // 继续发布新事件（live push）
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' live' }))

    // ws 应该收到 live push（transient 直传）
    expect(ws.send).toHaveBeenCalledTimes(1)
    const sentPayload = JSON.parse(vi.mocked(ws.send).mock.calls[0]![0]) as ServerMessage
    expect(sentPayload.type).toBe('message.text_delta')
    expect((sentPayload.payload as { delta?: string }).delta).toBe(' live')
    expect(sentPayload.seq).toBeUndefined() // transient 不分配 seq
  })

  /**
   * TC4: 多个 ws 同时订阅新 session，都收到 broadcast。
   *
   * 场景：bus.publish 对所有 subscribers 广播。
   */
  it('TC4: multiple ws subscribers all receive broadcast on publish', () => {
    const ws1 = createMockBusClient()
    const ws2 = createMockBusClient()
    const ws3 = createMockBusClient()

    // 三个 ws 都订阅同一 session
    bus.subscribe(NEW_ID, ws1)
    bus.subscribe(NEW_ID, ws2)
    bus.subscribe(NEW_ID, ws3)

    // 发布事件
    const event = makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'broadcast' })
    bus.publish(NEW_ID, event)

    // 所有 ws 都应收到
    expect(ws1.send).toHaveBeenCalledTimes(1)
    expect(ws2.send).toHaveBeenCalledTimes(1)
    expect(ws3.send).toHaveBeenCalledTimes(1)

    // 内容一致
    const expected = JSON.stringify(event)
    expect(vi.mocked(ws1.send).mock.calls[0]![0]).toBe(expected)
    expect(vi.mocked(ws2.send).mock.calls[0]![0]).toBe(expected)
    expect(vi.mocked(ws3.send).mock.calls[0]![0]).toBe(expected)
  })

  /**
   * TC5: handoff 被 abort 后，bus 中的事件不被清除（幂等）。
   *
   * 场景：abort 只取消 turn，bus 的 ring 不受影响。
   * 事件已通过 send 回调进 bus.publish，abort 不会回滚。
   */
  it('TC5: abort handoff does not clear bus ring (events preserved)', async () => {
    // 先在 bus 中发布一些事件（模拟 newClient.prompt 后的流式输出）
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'data' }))

    // 验证事件已在 bus 中（wave:perf-w06：ring 只存 stream 类 message_start）
    const ws1 = createMockBusClient()
    const before = bus.subscribe(NEW_ID, ws1)
    expect(before.snapshot).toHaveLength(1)
    expect(before.snapshot[0]!.type).toBe('message.message_start')

    // 启动 handoff 并 abort
    const runPromise = service.runHandoff(SRC_ID).catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    await service.abortHandoff(SRC_ID)
    await runPromise

    // abort 后 bus 中的事件仍在
    const ws2 = createMockBusClient()
    const after = bus.subscribe(NEW_ID, ws2)
    expect(after.snapshot).toHaveLength(1)
    expect(after.snapshot[0]!.type).toBe('message.message_start')
  })

  /**
   * TC6: newClient.prompt(doc) 后立即 subscribe，snapshot 可能为空。
   *
   * 场景：bus.publish 是同步的（send 回调内），prompt ack 返回后可能还没产生 message_start。
   * subscribe 空 snapshot 是合法状态（ES1）。
   */
  it('TC6: subscribe before any publish returns empty snapshot (ES1)', () => {
    // 直接 subscribe 一个从未 publish 过的 session
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    // 空 snapshot 是合法状态
    expect(result.snapshot).toHaveLength(0)
    expect(result.lastSeq).toBe(0)
    expect(result.stateSnapshot).toHaveLength(0)
  })

  /**
   * TC7: 完整 handoff 流程 → bus 缓存事件 → subscribe 拿到完整 snapshot。
   *
   * 端到端场景：
   * 1. runHandoff(srcSessionId) → agent_end → create new session → newClient.prompt(doc)
   * 2. newClient 产生 message_start + text_delta + agent_end 事件
   * 3. 事件经 send 回调进 bus.publish(NEW_ID, msg)
   * 4. renderer subscribe(NEW_ID) → snapshot 包含完整事件序列
   *
   * 这是 BLOCKER-1 的核心验证：handoff 完成后新 session 的流式响应完整可见。
   */
  it('TC7: end-to-end handoff → bus cache → subscribe returns complete streaming snapshot', async () => {
    // ── Step 1: 启动 handoff ──
    const runPromise = service.runHandoff(SRC_ID)
    await new Promise((r) => setTimeout(r, 0))

    // ── Step 2: 源 session 产生 agent_end（handoff 文档）──
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'handoff doc content' }], stopReason: 'stop' }],
      willRetry: false,
    })

    await runPromise

    // ── Step 3: newClient.prompt(wrapWithXmlTag(doc)) 已被调用 ──
    expect(newClient.prompt).toHaveBeenCalledTimes(1)
    const injectedPrompt = newClient.prompt.mock.calls[0][0] as string
    expect(injectedPrompt).toContain('<handoff_document source="src"')
    expect(injectedPrompt).toContain('handoff doc content')
    expect(injectedPrompt).toContain('</handoff_document>')

    // ── Step 4: 模拟 newClient 产生流式事件（EventInterpreter 输出）──
    // 这些事件经 send 回调进 bus.publish(NEW_ID, msg)
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID, role: 'assistant' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Hello' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' from' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' new session' }))
    bus.publish(NEW_ID, makeMsg('message.complete', { sessionId: NEW_ID, role: 'assistant' }))

    // ── Step 5: renderer subscribe(newId) ──
    // 此时 renderer 收到 handoffComplete → selectSession(newId) → subscribeSession(newId)
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    // ── Step 6: 验证 snapshot 包含 stream 类完整事件序列 ──
    //（wave:perf-w06/D5-1：text_delta 是 transient 不入 ring，快照只含 message_start + complete）
    expect(result.snapshot).toHaveLength(2)
    expect(result.snapshot.map((m) => m.type)).toEqual([
      'message.message_start',
      'message.complete',
    ])
    expect(result.lastSeq).toBe(2)

    // ── Step 7: subscribe 后继续 publish（live push）──
    vi.mocked(ws.send).mockClear()
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' (continued)' }))

    // ws 收到 live push
    expect(ws.send).toHaveBeenCalledTimes(1)
    const sentPayload = JSON.parse(vi.mocked(ws.send).mock.calls[0]![0]) as ServerMessage
    expect(sentPayload.type).toBe('message.text_delta')
    expect((sentPayload.payload as { delta?: string }).delta).toBe(' (continued)')
  })

  /**
   * TC8: ring 容量溢出时，subscribe 只返回最新的 ringCapacity 条。
   *
   * 场景：如果 handoff 过程中产生了大量事件（超过 ring 容量），
   * 最旧的事件会被淘汰，subscribe 只返回保留的事件。
   *
   * wave:perf-w06（D5-3）：溢出淘汰由 O(1) 覆盖写环形缓冲完成；text_delta 是 transient
   * 不入 ring，改用 stream 类（message.status）驱动溢出。subscribe 不再返回 gap 字段
   * （R-03：bus 内死 gauge 已删，gap 由 session-message-handler 基于 fromSeq 判定，
   * 见 src/__tests__/session-message-handler-subscribe.test.ts）。
   */
  it('TC8: ring overflow — subscribe returns only ringCapacity most recent events', () => {
    // 用小容量 bus
    const smallBus = new MessageBus(5)

    // 发布 8 条 stream 类事件（超过容量 5）
    for (let i = 0; i < 8; i++) {
      smallBus.publish(NEW_ID, makeMsg('message.status', { sessionId: NEW_ID, status: `chunk-${i}` }))
    }

    const ws = createMockBusClient()
    const result = smallBus.subscribe(NEW_ID, ws)

    // 只保留最新的 5 条（chunk-3 到 chunk-7），按 seq 顺序导出
    expect(result.snapshot).toHaveLength(5)
    expect((result.snapshot[0]!.payload as { status?: string }).status).toBe('chunk-3')
    expect((result.snapshot[4]!.payload as { status?: string }).status).toBe('chunk-7')
    expect(result.snapshot[0]!.seq).toBe(4) // 最旧 seq 随淘汰正确推进
    expect(result.snapshot[4]!.seq).toBe(8)
    expect(result.lastSeq).toBe(8) // seq 仍然单调递增到 8
    // R-03：gap 不再由 bus 返回（死 gauge 已删），由 handler 基于 fromSeq 判定
    expect('gap' in result).toBe(false)
  })
})
