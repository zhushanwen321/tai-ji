/**
 * W09 单通道确定性验收（02 文档 §4 V1 的脚本化断言，wave:perf-w09 D1-2）。
 *
 * V1 原文：「同一 session 级消息在 send/bus 层只被 JSON.stringify 一次（ws 层打点计数 = 1）、
 * 只推给订阅该 sid 的连接」。本文件把两条都做成确定性断言（不依赖真实 ws / 真实 pi）：
 *
 * - TC-V1a（bus 层）：publish 一条 stream 消息 → JSON.stringify 恰好 1 次；
 *   订阅该 sid 的 ws 收到 1 条、订阅其它 sid 的 ws / 未订阅 ws 均 0 条。
 * - TC-V1b（send 层集成）：SessionService 的 send 回调（EventAdapter 透传路径）转发
 *   session 级消息 → 全程 JSON.stringify 恰好 1 次（只有 bus 的定向推送一次），
 *   broker.broadcast 0 次（盲广播腿已删）。
 * - TC-V1c（transient）：delta 类不占 seq，同一窗口 stringify 仍恰好 1 次。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/w09-single-channel-v1.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionService } from '../services/session/session-service.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'

/** mock ws（BusClient 契约：readyState + send），收集收到的原始 payload 字符串。 */
function createMockWs() {
  const sent: string[] = []
  return {
    readyState: 1 as const,
    sent,
    send: (payload: string) => { sent.push(payload) },
  }
}

/**
 * 构造真实 SessionService + 真实 MessageBus（对齐 session-service-w07-bus.test.ts 的 makeEnv），
 * sendCb 捕获 initializeManagedSession 注入 adapterFactory 的 send 回调。
 */
function makeEnv() {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  const client = { getCommands: vi.fn(async () => []) } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  let sendCb: ((msg: ServerMessage) => void) | null = null
  const captureAdapterFactory = (_sid: string, send: (msg: ServerMessage) => void) => {
    sendCb = send
    return { attach: vi.fn(), detach: vi.fn() }
  }

  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    captureAdapterFactory,
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never,
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
    { pruneStaleCache: vi.fn() } as never,
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, bus, broker, broadcasts, getSendCb: () => sendCb! }
}

describe('W09 单通道确定性验收（02 §4 V1）', () => {
  let stringifySpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stringifySpy = vi.spyOn(JSON, 'stringify')
  })
  afterEach(() => {
    stringifySpy.mockRestore()
  })

  it('TC-V1a: bus.publish 一条 stream 消息 → JSON.stringify 恰好 1 次 + 只推订阅该 sid 的连接', () => {
    const bus = new MessageBus()
    const wsA = createMockWs() // 订阅 sid-1（目标 session）
    const wsB = createMockWs() // 订阅 sid-2（其它 session）
    const wsC = createMockWs() // 未订阅任何 session
    bus.subscribe('sid-1', wsA)
    bus.subscribe('sid-2', wsB)

    stringifySpy.mockClear()
    bus.publish('sid-1', { type: 'message.status', payload: { sessionId: 'sid-1', status: 'thinking' } })

    // 只序列化一次（三个连接总共一次 stringify——序列化与订阅者数解耦）
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    // 只有订阅 sid-1 的连接收到，恰好 1 条
    expect(wsA.sent).toHaveLength(1)
    expect(JSON.parse(wsA.sent[0]!)).toMatchObject({ type: 'message.status', seq: 1 })
    // 订阅其它 sid 的连接、未订阅连接均未收到（V1：每个 panel 只收到自己 session 的消息）
    expect(wsB.sent).toHaveLength(0)
    expect(wsC.sent).toHaveLength(0)
  })

  it('TC-V1b: send 层（SessionService send 回调）转发 session 级消息 → 全程 stringify 恰好 1 次、broadcast 0 次', async () => {
    const { svc, bus, broker, broadcasts, getSendCb } = makeEnv()
    await svc.initializeManagedSession('s-v1', {} as unknown as IPiEngine, '/tmp', 'test')
    const send = getSendCb()

    const online = createMockWs()
    bus.subscribe('s-v1', online)

    stringifySpy.mockClear()
    send({ type: 'message.status', payload: { sessionId: 's-v1', status: 'thinking' } })

    // 单次序列化：send 回调 → bus.publish（seq + ring + 定向推送）是唯一出口，
    // broker.broadcast 腿已删（D1-2），全程 stringify 计数 = 1
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    expect(broker.broadcast).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
    // 订阅者收到 1 条带 seq 的消息
    expect(online.sent).toHaveLength(1)
    const parsed = JSON.parse(online.sent[0]!) as ServerMessage & { seq?: number }
    expect(parsed.type).toBe('message.status')
    expect(typeof parsed.seq).toBe('number')
  })

  it('TC-V1c: transient delta 不占 seq，同窗口 stringify 仍恰好 1 次', async () => {
    const { svc, bus, getSendCb } = makeEnv()
    await svc.initializeManagedSession('s-v1', {} as unknown as IPiEngine, '/tmp', 'test')
    const send = getSendCb()

    const online = createMockWs()
    bus.subscribe('s-v1', online)

    stringifySpy.mockClear()
    send({ type: 'message.text_delta', payload: { sessionId: 's-v1', delta: 'hi' } })

    expect(stringifySpy).toHaveBeenCalledTimes(1)
    expect(online.sent).toHaveLength(1)
    // transient 类不分配 seq（D5-1）
    const parsed = JSON.parse(online.sent[0]!) as { type: string; seq?: number }
    expect(parsed.type).toBe('message.text_delta')
    expect(parsed.seq).toBeUndefined()
  })
})
