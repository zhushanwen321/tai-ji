// ws-client 入站帧守卫测试（crash-forensics-and-watchdog §3.3 D8 / u10a）。
//
// 覆盖（设计 A6 验收的 core 层机械核验 + D8 三点钉死）：
// - ① 80MB 阈值守卫：超界 text 帧丢弃不崩、不断链（后续正常帧照常 dispatch）；
//   恰好 40M code units 不触发守卫（> 判定边界，防误伤合法大帧）
// - ② per-session 连续计数与终止阀：同 session 连续 3 次丢帧触发终止阀（回调
//   valveTripped=true）；第 4 帧继续上报（A6 ×4 台账计数语义）；正常帧到达中断
//   「连续」性；无法归因（null）不参与阀门；不同 session 计数互不干扰（不连坐）
// - ③ 终止阀的订阅暂停与恢复：trip 后该 session 的 session.subscribe 出站被拦截
//   （send false），其余 session 与非 subscribe 消息不受影响；retryInboundDroppedSession
//   解除后放行（恢复触发器入口）；in-flight subscribe 簿记归因（subscribe reply 超界
//   —— D8 死循环主形态）与正常 reply 清理簿记
//
// 体例：ws-client.invariants.test.ts 同款（providePlatform + createFakeWebSocket +
// triggerMessage 驱动；模块级单例状态 beforeEach/afterEach 复位）。
// 运行：cd packages/core && pnpm vitest run src/transport/__tests__/ws-client.inbound-guard.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { providePlatform } from '../../platform/port'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import {
  connect,
  disconnect,
  onMessage,
  send,
  onInboundFrameDropped,
  retryInboundDroppedSession,
  isInboundValveTripped,
  INBOUND_FRAME_MAX_TEXT_CODE_UNITS,
  _resetInboundGuardForTest,
  _inFlightSubscribeCountForTest,
  type InboundFrameDroppedInfo,
} from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

// ── 测试平台注入（invariants 同款 fake websocket factory）──────────
let fakes: FakeWebSocket[]

function installTestPlatform(): void {
  fakes = []
  providePlatform({
    kind: 'mock',
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    webSocket: {
      create: () => {
        const f = createFakeWebSocket()
        fakes.push(f)
        return f
      },
    },
  })
}

function latestFake(): FakeWebSocket {
  expect(fakes.length).toBeGreaterThan(0)
  return fakes[fakes.length - 1]
}

// ── 夹具构造 ────────────────────────────────────────────────────────

/** 出站 subscribe 请求（生产 request.ts command() 同款形状，invariants as 断言体例）。 */
function subscribeMsg(id: string, sessionId: string): ClientMessage {
  return { type: 'session.subscribe', id, payload: { sessionId } } as ClientMessage
}

/**
 * 超界 text 帧（总 code units > INBOUND_FRAME_MAX_TEXT_CODE_UNITS）。prefix 落在
 * 守卫归因扫描窗口（头部 4KB）内——归因字段必须在前缀里。
 */
function oversizedFrame(prefix: string): string {
  const padUnits = INBOUND_FRAME_MAX_TEXT_CODE_UNITS - prefix.length
  return `${prefix}"pad":"${'x'.repeat(padUnits)}"}`
}

/** live push 形态超界帧前缀（头部含 sessionId 字段——归因路径 ②）。 */
function livePushPrefix(sessionId: string): string {
  return `{"type":"message.chunk","seq":9,"payload":{"sessionId":"${sessionId}","blob":"`
}

/** subscribe reply 形态超界帧前缀（头部含 id 字段——归因路径 ①，簿记反查）。 */
function subscribeReplyPrefix(requestId: string): string {
  return `{"id":"${requestId}","type":"session.subscribe","payload":{"snapshot":"`
}

describe('ws-client 入站守卫 ① 80MB 阈值（超界丢帧不断链）', () => {
  let dropped: InboundFrameDroppedInfo[]
  let offDrop: () => void
  let dispatchHandler: Mock<(msg: ServerMessage) => void>

  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
    _resetInboundGuardForTest()
    dropped = []
    offDrop = onInboundFrameDropped((info) => dropped.push(info))
    dispatchHandler = vi.fn<(msg: ServerMessage) => void>()
    onMessage(dispatchHandler)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    connect('ws://test')
    latestFake().triggerOpen()
  })

  afterEach(() => {
    offDrop()
    disconnect()
    _resetInboundGuardForTest()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('超界 text 帧整条丢弃（不 parse 不 dispatch），后续正常帧照常到达（不断链）', () => {
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))

    expect(dropped).toHaveLength(1)
    expect(dropped[0].kind).toBe('text')
    expect(dropped[0].frameSize).toBeGreaterThan(INBOUND_FRAME_MAX_TEXT_CODE_UNITS)
    expect(dispatchHandler).not.toHaveBeenCalled() // 守卫在 parse 前，帧未进入路由

    // 不断链：守卫命中后消息泵不死，正常帧照常 dispatch
    latestFake().triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
    expect(dispatchHandler).toHaveBeenCalledTimes(1)
  })

  it('恰好 40M code units 不触发守卫（> 严格大于边界，不误伤合法大帧）', () => {
    // 长度恰为上限的帧：不超界 → 走 parse 链，守卫回调零触发 = 未被守卫丢弃
    const boundaryFrame = '{"pad":"' + 'x'.repeat(INBOUND_FRAME_MAX_TEXT_CODE_UNITS - 10) + '"}'
    expect(boundaryFrame.length).toBe(INBOUND_FRAME_MAX_TEXT_CODE_UNITS)
    latestFake().triggerMessage(boundaryFrame)
    expect(dropped).toHaveLength(0)
  })
})

describe('ws-client 入站守卫 ② per-session 连续计数与终止阀', () => {
  let dropped: InboundFrameDroppedInfo[]
  let offDrop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
    _resetInboundGuardForTest()
    dropped = []
    offDrop = onInboundFrameDropped((info) => dropped.push(info))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    connect('ws://test')
    latestFake().triggerOpen()
  })

  afterEach(() => {
    offDrop()
    disconnect()
    _resetInboundGuardForTest()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('同 session 连续 3 次丢帧 → 第 3 帧触发终止阀（valveTripped=true，session 归因）', () => {
    for (let i = 1; i <= 3; i++) latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))

    expect(dropped).toHaveLength(3)
    expect(dropped.map((d) => d.sessionDropCount)).toEqual([1, 2, 3])
    expect(dropped[0].valveTripped).toBe(false)
    expect(dropped[1].valveTripped).toBe(false)
    expect(dropped[2]).toMatchObject({ sessionId: 's1', valveTripped: true })
    expect(isInboundValveTripped('s1')).toBe(true)
  })

  it('trip 后第 4 帧继续上报（valveTripped=false，A6 台账 ×4 计数语义）', () => {
    for (let i = 1; i <= 4; i++) latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))

    expect(dropped).toHaveLength(4)
    expect(dropped[3]).toMatchObject({ sessionId: 's1', valveTripped: false, sessionDropCount: 4 })
    expect(dropped.filter((d) => d.valveTripped)).toHaveLength(1) // 仅第 3 帧 trip 一次
  })

  it('正常帧到达中断「连续」性：丢 2 → 正常帧 → 再丢 2，不触发终止阀', () => {
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
    // 同 session 的可 parse 正常帧到达 → 计数清零（连续性中断）
    latestFake().triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))

    expect(dropped).toHaveLength(4)
    expect(dropped.every((d) => !d.valveTripped)).toBe(true)
    expect(dropped[3].sessionDropCount).toBe(2) // 中断后重新累计
    expect(isInboundValveTripped('s1')).toBe(false)
  })

  it('无法归因（头部无 id 簿记命中无 sessionId 字段）→ 只上报不参与阀门', () => {
    for (let i = 1; i <= 3; i++) latestFake().triggerMessage(oversizedFrame('{"blob":"'))

    expect(dropped).toHaveLength(3)
    expect(dropped.every((d) => d.sessionId === null && d.sessionDropCount === 0)).toBe(true)
    expect(dropped.every((d) => !d.valveTripped)).toBe(true)
    expect(isInboundValveTripped('s1')).toBe(false)
  })

  it('不同 session 计数互不干扰：s1/s2 各丢 2 帧均不 trip；s1 第 3 帧 trip 而 s2 不连坐', () => {
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s2')))
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s2')))
    expect(isInboundValveTripped('s1')).toBe(false)
    expect(isInboundValveTripped('s2')).toBe(false)

    latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
    expect(dropped[4]).toMatchObject({ sessionId: 's1', valveTripped: true })
    expect(isInboundValveTripped('s1')).toBe(true)
    expect(isInboundValveTripped('s2')).toBe(false) // 单 session 作用域，s2 不连坐
  })
})

describe('ws-client 入站守卫 ③ 终止阀的订阅暂停与恢复', () => {
  let dropped: InboundFrameDroppedInfo[]
  let offDrop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
    _resetInboundGuardForTest()
    dropped = []
    offDrop = onInboundFrameDropped((info) => dropped.push(info))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    connect('ws://test')
    latestFake().triggerOpen()
  })

  afterEach(() => {
    offDrop()
    disconnect()
    _resetInboundGuardForTest()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function tripSession(sessionId: string): void {
    for (let i = 1; i <= 3; i++) latestFake().triggerMessage(oversizedFrame(livePushPrefix(sessionId)))
    expect(isInboundValveTripped(sessionId)).toBe(true)
  }

  it('trip 后该 session 的 subscribe 出站被拦截（send false），其余 session 与其他消息放行', () => {
    tripSession('s1')

    expect(send(subscribeMsg('rpc-s1', 's1'))).toBe(false) // 自动重订阅暂停点
    expect(latestFake().sent.some((d) => d.includes('rpc-s1'))).toBe(false) // 未上 wire

    expect(send(subscribeMsg('rpc-s2', 's2'))).toBe(true) // 其余 session 不连坐
    expect(send({ type: 'ping', payload: {} })).toBe(true) // 非 subscribe 消息不受影响
    expect(latestFake().sent.some((d) => d.includes('rpc-s2'))).toBe(true)
  })

  it('retryInboundDroppedSession 解除暂停（恢复触发器入口），随后该 session subscribe 放行；未 tripped 返回 false', () => {
    tripSession('s1')
    expect(retryInboundDroppedSession('s2')).toBe(false) // 未 tripped：调用方无需动作

    expect(retryInboundDroppedSession('s1')).toBe(true)
    expect(isInboundValveTripped('s1')).toBe(false)
    expect(send(subscribeMsg('rpc-retry', 's1'))).toBe(true) // 解除后放行（重试订阅可达 wire）
    expect(latestFake().sent.some((d) => d.includes('rpc-retry'))).toBe(true)
  })

  it('in-flight subscribe 簿记归因：出站 subscribe 后其 reply 帧超界 → 归因目标 session（头部无 sessionId 字段）', async () => {
    expect(send(subscribeMsg('rpc-1', 's1'))).toBe(true)

    // reply 形态超界帧：头部只有 id（subscribe reply 顶层无 sessionId 字段），经簿记反查归因 s1
    for (let i = 1; i <= 3; i++) {
      expect(send(subscribeMsg(`rpc-${i}`, 's1'))).toBe(true)
      latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix(`rpc-${i}`)))
    }

    expect(dropped).toHaveLength(3)
    expect(dropped.every((d) => d.sessionId === 's1')).toBe(true)
    expect(dropped[2].valveTripped).toBe(true) // 死循环主形态同样触发终止阀
  })

  it('正常 reply 到达清理簿记：同 id 的后续超界帧退化为无法归因（null，不参与阀门）', () => {
    expect(send(subscribeMsg('rpc-x', 's1'))).toBe(true)
    // 可 parse 的正常帧带同 id → 簿记清理（订阅正常完成，归因锚退役）
    latestFake().triggerMessage(JSON.stringify({ id: 'rpc-x', type: 'session.subscribe', payload: { snapshot: [], lastSeq: 0 } }))

    latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix('rpc-x')))
    latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix('rpc-x')))
    latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix('rpc-x')))

    expect(dropped).toHaveLength(3)
    expect(dropped.every((d) => d.sessionId === null)).toBe(true)
    expect(isInboundValveTripped('s1')).toBe(false) // 无法归因 → 阀门不误触发
  })
})

describe('ws-client 入站守卫 ④ in-flight 簿记重连 sweep（G2 活性治理，memory-leak-remediation §3.4）', () => {
  // G2：断连使部分 subscribe reply 永不到达（重连后新 id 重订），过期簿记原实现只能等
  // 超界帧归因死路径触发 sweep。修复 = markConnected（新连接确立，含重连）时 sweep 一次。
  // fake timers 同步 mock Date（vitest 默认 toFake 含 Date），advanceTimersByTime 驱动 TTL 过期。
  const RECONNECT_BASE_DELAY_MS = 1_000 // ws-client 内部常量（未导出，字面量对齐）
  const IN_FLIGHT_TTL_MS = 90_000       // IN_FLIGHT_SUBSCRIBE_TTL_MS（未导出，字面量对齐）

  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
    _resetInboundGuardForTest()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    connect('ws://test')
    latestFake().triggerOpen()
  })

  afterEach(() => {
    disconnect()
    _resetInboundGuardForTest()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** 断连 → 1s 退避 → connect 新 fake → open（markConnected = sweep 触发点）。 */
  function reconnect(): FakeWebSocket {
    latestFake().triggerClose() // onclose → scheduleReconnect
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS) // 退避到点 → connect() 建新 fake
    const next = latestFake()
    next.triggerOpen() // onopen → markConnected（同步 sweep）
    return next
  }

  it('过期条目在重连确立时被扫除：断连致 reply 永不到达的簿记不再驻留到超界帧死路径', () => {
    expect(send(subscribeMsg('rpc-stale', 's1'))).toBe(true)
    expect(_inFlightSubscribeCountForTest()).toBe(1)

    vi.advanceTimersByTime(IN_FLIGHT_TTL_MS + 1) // 跨过 TTL（含 fake Date 前进）
    reconnect()

    expect(_inFlightSubscribeCountForTest()).toBe(0) // sweep 已在重连确立时扫除
  })

  it('未过期条目在重连后保留（sweep 语义仍是 TTL 惰性过期，重连不连坐清除新鲜簿记）', () => {
    expect(send(subscribeMsg('rpc-fresh', 's1'))).toBe(true)

    reconnect()

    expect(_inFlightSubscribeCountForTest()).toBe(1) // 未过期（~1s < 90s）：归因锚仍有效
    // 归因锚仍可用：该 id 的超界 reply 仍归因到目标 session
    latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix('rpc-fresh')))
    expect(isInboundValveTripped('s1')).toBe(false) // 单帧不触发阀门，仅验证归因链路存活
  })

  it('sweep 早于重订阅登记（markConnected 同步执行，resubscribeAll 触发点在其后）：重连后新订阅正常登记', () => {
    expect(send(subscribeMsg('rpc-old', 's1'))).toBe(true)
    vi.advanceTimersByTime(IN_FLIGHT_TTL_MS + 1)

    reconnect() // sweep 在 connected 置位同帧内完成（use-connection 的 state watch 异步其后）
    expect(_inFlightSubscribeCountForTest()).toBe(0)

    // 重连后 resubscribeAll 形态的新订阅（新 id）正常登记，不被 sweep 误扫
    expect(send(subscribeMsg('rpc-new', 's1'))).toBe(true)
    expect(_inFlightSubscribeCountForTest()).toBe(1)
  })
})
