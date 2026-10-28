// ws-client.test.ts —— core C03 簇合并产物（round5-G）。
// 共同被测业务模块：`src/transport/ws-client.ts`。mock 相容：单侧 mock ../api/pending、../ws-client——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/transport/__tests__/ws-client.auth-rejection.test.ts（4 用例，skip 0）
//   - src/transport/__tests__/ws-client.inbound-guard.test.ts（14 用例，skip 0）
//   - src/transport/__tests__/ws-client.probe-alive.test.ts（6 用例，skip 0）
//   - src/transport/__tests__/ws-client.single-flight.test.ts（4 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { providePlatform, WS_READY_STATE } from '../../platform/port'
import { connect, disconnect, getState, isAuthRejectedSuppressed, onAuthRejected, resetAuthRejectionSuppression, onMessage, send, onInboundFrameDropped, retryInboundDroppedSession, isInboundValveTripped, INBOUND_FRAME_MAX_TEXT_CODE_UNITS, _resetInboundGuardForTest, _inFlightSubscribeCountForTest, type InboundFrameDroppedInfo, probeAlive, setFailed } from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'
import { type ClientMessage, type ServerMessage } from '@taiji/shared'

// ======== 来源：ws-client.auth-rejection.test.ts ========
describe("ws-client.auth-rejection", () => {
  // ── 测试平台注入（invariants 测试同款 fake websocket factory）──
  let fakes: FakeWebSocket[]

  function installTestPlatform(): void {
    fakes = []
    providePlatform({
      kind: 'mock',
      storage: {
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      },
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

  function authResult(ok: boolean): string {
    return JSON.stringify({ type: 'auth.result', payload: { ok } })
  }

  describe('ws-client auth 拒绝信号与重连抑制（D8）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      installTestPlatform()
      resetAuthRejectionSuppression()
      disconnect() // 重置模块级单例状态（上轮残留连接/定时器）
    })
    afterEach(() => {
      disconnect()
      // 凭据经 connect 第二参显式传入（S4），无 currentToken 残留复位需求（invariants 同体例）
      resetAuthRejectionSuppression()
      vi.useRealTimers()
    })

    it('信号先于 close 触发：触发瞬间 socket 仍 OPEN 且 close 未调用，随后 close 照常', () => {
      let observedAtSignal: string | null = null
      const off = onAuthRejected(() => {
        observedAtSignal = `readyState=${latestFake().readyState} closeCalls=${latestFake().closeCalls}`
      })
      connect('ws://test', { auth: 'token', token: 'tok-d8' })
      latestFake().triggerOpen()
      latestFake().triggerMessage(authResult(false))
      // 信号触发瞬间：readyState=OPEN(1) 且 close 尚未调用——「先于 close」的直接证据
      expect(observedAtSignal).toBe('readyState=1 closeCalls=0')
      // onmessage 返回后 close 已调（D8 前现状：close 走重连链保留）
      expect(latestFake().closeCalls).toBe(1)
      off()
    })

    it('有注册消费方：拒绝置抑制位，onclose 后不调度重连（state 停 disconnected、无新 WS）', () => {
      const handler = vi.fn()
      const off = onAuthRejected(handler)
      connect('ws://test', { auth: 'token', token: 'tok-d8' })
      const f = latestFake()
      f.triggerOpen()
      f.triggerMessage(authResult(false))
      expect(handler).toHaveBeenCalledTimes(1)
      expect(isAuthRejectedSuppressed()).toBe(true)
      f.triggerClose()
      // 抑制短路：不进 reconnecting（无退避调度）
      expect(getState().value).toBe('disconnected')
      vi.advanceTimersByTime(60_000)
      expect(fakes.length).toBe(1) // 全程无新连接
      off()
    })

    it('无注册消费方（桌面形态）：拒绝不置抑制位，close 走原退避重连链（行为不变）', () => {
      connect('ws://test', { auth: 'token', token: 'tok-desktop' })
      const f = latestFake()
      f.triggerOpen()
      f.triggerMessage(authResult(false))
      expect(isAuthRejectedSuppressed()).toBe(false)
      f.triggerClose()
      expect(getState().value).toBe('reconnecting') // D8 前现状不变量
      vi.advanceTimersByTime(1_000)
      expect(fakes.length).toBe(2) // 1s 退避到 → 重连
    })

    it('resetAuthRejectionSuppression 显式解除：重试 connect 可达、auth 成功复位抑制位、后续断线恢复自动重连', () => {
      const off = onAuthRejected(() => {})
      connect('ws://test', { auth: 'token', token: 'tok-stale' })
      let f = latestFake()
      f.triggerOpen()
      f.triggerMessage(authResult(false))
      f.triggerClose()
      expect(fakes.length).toBe(1) // 抑制中：无重连

      // token 重试路径形态：reset → 显式 connect（新凭据）
      resetAuthRejectionSuppression()
      // reset 直接锚，且必须落在 connect 之前：markConnected（auth 成功）也会复位抑制位，
      // 若锚在 connect 后则 reset 体被掏空仍全绿（无判别力）
      expect(isAuthRejectedSuppressed()).toBe(false)
      connect('ws://test', { auth: 'token', token: 'tok-new' })
      expect(fakes.length).toBe(2)
      f = latestFake()
      f.triggerOpen()
      f.triggerMessage(authResult(true))
      expect(getState().value).toBe('connected')
      // markConnected 自动复位抑制位
      expect(isAuthRejectedSuppressed()).toBe(false)
      // 抑制不复活：正常断线恢复自动重连
      f.triggerClose()
      expect(getState().value).toBe('reconnecting')
      vi.advanceTimersByTime(1_000)
      expect(fakes.length).toBe(3)
      off()
    })
  })
});

// ======== 来源：ws-client.inbound-guard.test.ts ========
describe("ws-client.inbound-guard", () => {
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
 * 检查归因扫描窗口（头部 4KB）内——归因字段必须在前缀里。
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

  describe('ws-client 入站检查 ① 80MB 阈值（超界丢帧不断链）', () => {
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
      connect('ws://test', { auth: 'skip' })
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
      expect(dispatchHandler).not.toHaveBeenCalled() // 检查在 parse 前，帧未进入路由

      // 不断链：检查命中后消息泵不死，正常帧照常 dispatch
      latestFake().triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
      expect(dispatchHandler).toHaveBeenCalledTimes(1)
    })

    it('恰好 40M code units 不触发检查（> 严格大于边界，不误伤合法大帧）', () => {
      // 长度恰为上限的帧：不超界 → 走 parse 链，检查回调零触发 = 未被检查丢弃
      const boundaryFrame = '{"pad":"' + 'x'.repeat(INBOUND_FRAME_MAX_TEXT_CODE_UNITS - 10) + '"}'
      expect(boundaryFrame.length).toBe(INBOUND_FRAME_MAX_TEXT_CODE_UNITS)
      latestFake().triggerMessage(boundaryFrame)
      expect(dropped).toHaveLength(0)
    })
  })

  describe('ws-client 入站检查 ② per-session 连续计数与终止阀', () => {
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
      connect('ws://test', { auth: 'skip' })
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

    it('trip 后第 4 帧继续上报（valveTripped=false，A6 登记清单 ×4 计数语义）', () => {
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

  describe('ws-client 入站检查 ③ 终止阀的订阅暂停与恢复', () => {
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
      connect('ws://test', { auth: 'skip' })
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

  describe('ws-client 入站检查 ④ in-flight 簿记重连 sweep（G2 活性治理，memory-leak-remediation §3.4）', () => {
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
      connect('ws://test', { auth: 'skip' })
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
});

// ======== 来源：ws-client.probe-alive.test.ts ========
describe("ws-client.probe-alive", () => {
  // ── 测试平台注入（auth-rejection 测试同款 fake websocket factory）──
  let fakes: FakeWebSocket[]

  function installTestPlatform(): void {
    fakes = []
    providePlatform({
      kind: 'mock',
      storage: {
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      },
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

  /** 建连 + auth 握手到 connected（探活仅 connected 态有效的前置） */
  function connectAndAuth(): FakeWebSocket {
    connect('ws://test', { auth: 'token', token: 'tok-probe' })
    const f = latestFake()
    f.triggerOpen()
    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    expect(getState().value).toBe('connected')
    return f
  }

  describe('ws-client probeAlive 探活死链检测', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      installTestPlatform()
      disconnect() // 重置模块级单例状态（上轮残留连接/定时器）
    })
    afterEach(() => {
      disconnect()
      vi.useRealTimers()
    })

    it('超时路径：ping 上 wire，5s 无入站帧 → close 被调，onclose 后走退避重连链', () => {
      const f = connectAndAuth()
      const sentCountBeforeProbe = f.sent.length

      probeAlive()
      // 探活 ping 实际发出（心跳帧形状与 startHeartbeat 同款）
      expect(JSON.parse(f.sent[sentCountBeforeProbe])).toEqual({ type: 'ping', payload: {} })

      vi.advanceTimersByTime(4_999)
      expect(f.closeCalls).toBe(0) // 未超时不关
      vi.advanceTimersByTime(1)
      expect(f.closeCalls).toBe(1) // 超时主动 close
      // close ≠ onclose：状态迁移由既有 onclose 链负责（此处不动簿记）
      expect(getState().value).toBe('connected')

      f.triggerClose()
      expect(getState().value).toBe('reconnecting') // 非 auth 拒绝：退避重连链可达
      vi.advanceTimersByTime(1_000)
      expect(fakes.length).toBe(2) // 1s 退避到 → 重连发起（connect 再次被调）
    })

    it('活性路径：5s 内收到任意入站帧（pong / 坏 JSON 帧）→ 清计时器不 close', () => {
      const f = connectAndAuth()

      probeAlive()
      f.triggerMessage(JSON.stringify({ type: 'pong', payload: {} }))
      vi.advanceTimersByTime(10_000)
      expect(f.closeCalls).toBe(0)

      // 坏帧（parse 失败路径）同样是链路活性证据——清除点在大小检查/parse 之前
      probeAlive()
      f.triggerMessage('{oops')
      vi.advanceTimersByTime(10_000)
      expect(f.closeCalls).toBe(0)
      expect(getState().value).toBe('connected')
    })

    it('状态门控：非 connected 态调用 no-op（不发 ping、不定时器）', () => {
      // disconnected（无连接）：no-op，不建连不发帧
      probeAlive()
      expect(fakes.length).toBe(0)

      // connecting：no-op
      connect('ws://test', { auth: 'skip' })
      const f = latestFake()
      probeAlive()
      expect(f.sent).toHaveLength(0)
      vi.advanceTimersByTime(10_000)
      expect(f.closeCalls).toBe(0)

      // reconnecting：no-op（既有重连链照常，新连接上无探活副作用）
      f.triggerOpen()
      f.triggerClose()
      expect(getState().value).toBe('reconnecting')
      probeAlive()
      vi.advanceTimersByTime(10_000)
      expect(fakes.length).toBe(2) // 1s 退避重连照常发起
      expect(fakes[1].sent).toHaveLength(0) // 新连接（CONNECTING）无探活 ping
      expect(fakes[1].closeCalls).toBe(0)
    })

    it('单定时器不变量：探活窗内重复调用只留一个计时器（5s 只 close 一次）', () => {
      const f = connectAndAuth()
      probeAlive()
      probeAlive()
      probeAlive()
      vi.advanceTimersByTime(5_000)
      expect(f.closeCalls).toBe(1)
    })

    it('清理不跨代（onclose 路径）：探活窗内断开 → 重连后新连接不被旧计时器误杀，探活可复用', () => {
      const f1 = connectAndAuth()
      probeAlive()
      f1.triggerClose() // 探活窗内服务端断开：onclose 清计时器 + 调度重连
      vi.advanceTimersByTime(1_000)
      expect(fakes.length).toBe(2)

      // 新连接建立：旧探活计时器若残留会在此窗口误 close 新连接——不应发生
      const f2 = latestFake()
      f2.triggerOpen()
      f2.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
      expect(getState().value).toBe('connected')
      vi.advanceTimersByTime(10_000)
      expect(f2.closeCalls).toBe(0)

      // 簿记不残留：新连接上再探活，超时路径照常可用
      probeAlive()
      expect(f2.sent.some((d) => d.includes('"type":"ping"'))).toBe(true)
      vi.advanceTimersByTime(5_000)
      expect(f2.closeCalls).toBe(1)
      f2.triggerClose()
      vi.advanceTimersByTime(1_000)
      expect(fakes.length).toBe(3) // 重连链持续可用
    })

    it('清理不跨代（clearTimers 路径）：探活窗内主动 disconnect → 计时器清零无残余 close', () => {
      const f = connectAndAuth()
      probeAlive()
      disconnect()
      const closeCallsAtDisconnect = f.closeCalls // disconnect 自身会 close 一次（摘回调后）
      vi.advanceTimersByTime(10_000)
      // 计时器已清：无残余触发（否则会再 close 一次）
      expect(f.closeCalls).toBe(closeCallsAtDisconnect)
      expect(getState().value).toBe('disconnected')
    })
  })
});

// ======== 来源：ws-client.single-flight.test.ts ========
describe("ws-client.single-flight", () => {
  // ── 测试平台注入（fake websocket factory，每次 create 产出新 fake 并登记）──
  let fakes: FakeWebSocket[]

  function installTestPlatform(): void {
    fakes = []
    providePlatform({
      kind: 'mock',
      storage: {
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      },
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

  /** close 配对不变量：任意时点非 CLOSED（存活/悬挂）socket 至多一个。 */
  function expectAtMostOneAlive(): void {
    const alive = fakes.filter((f) => f.readyState !== WS_READY_STATE.CLOSED)
    expect(alive.length).toBeLessThanOrEqual(1)
  }

  describe('ws-client 单飞防并存', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      installTestPlatform()
      disconnect() // 重置模块级单例状态（上轮残留连接/定时器）
    })
    afterEach(() => {
      disconnect()
      // setFailed 复位重连簿记（reconnectAttempts / reconnectStartedAt——disconnect 刻意不重置，
      // 仅 markConnected / setFailed 复位），防用例间泄漏使退避时值依赖执行历史
      setFailed()
      vi.useRealTimers()
    })

    it('旧 socket CLOSING（close 握手未完成）时 connect 不放行；onclose 到达后由退避链接力建新连接', () => {
      // 复现路径：token 模式 open → auth 5s 超时 → close() 发出但 close 事件未送达（弱网悬挂）
      connect('ws://test', { auth: 'token', token: 'tok-sf1' })
      const f1 = latestFake()
      f1.triggerOpen() // auth 帧已发，authTimer(5s) 已挂
      vi.advanceTimersByTime(5_000) // auth 超时 → ws.close()（fake 置 CLOSED；此处再改回 CLOSING 模拟 close 事件未送达）
      expect(f1.closeCalls).toBe(1)
      f1.setReadyState(WS_READY_STATE.CLOSING)
      expect(getState().value).toBe('connecting') // auth 超时不置态，仍处握手期

      // 外部 connect（visibility 切前台 / token 重试等价入场）：CLOSING 悬挂期不放行
      connect('ws://test', { auth: 'token', token: 'tok-sf1' })
      expect(fakes.length).toBe(1) // 未创建新 WS
      expectAtMostOneAlive()

      // close 事件最终送达 → onclose → 退避链接力 → 新连接（且唯一）
      f1.triggerClose()
      expect(getState().value).toBe('reconnecting')
      vi.advanceTimersByTime(1_000)
      expect(fakes.length).toBe(2)
      expect(f1.readyState).toBe(WS_READY_STATE.CLOSED) // 旧 socket 已死透
      expectAtMostOneAlive()
    })

    it('connect() 放行时清挂起的退避定时器：外部 connect 与退避链不叠成双链双建连', () => {
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
      latestFake().triggerClose() // onclose → 退避 T1@1s
      expect(getState().value).toBe('reconnecting')

      // 外部 connect（visibility 等价）：旧 socket 已 CLOSED → 放行建 #2，T1 应被清
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(2)
      const f2 = latestFake()

      // #2 立即失败 → onclose → 退避 T2@2s（attempts=2）
      f2.triggerClose()
      expect(getState().value).toBe('reconnecting')

      // T1 原到期点（1s）：定时器已清，无提前建连（修复前 T1 在此放行建 #3）
      vi.advanceTimersByTime(1_000)
      expect(fakes.length).toBe(2)
      expectAtMostOneAlive()

      // T2 到期（2s）：退避链接力建 #3（正常收敛，唯一活跃）
      vi.advanceTimersByTime(1_000)
      expect(fakes.length).toBe(3)
      expectAtMostOneAlive()
    })

    it('failed 后重试（connect 再入场）：旧 socket 已 CLOSED → 放行重建，重连预算已重置', () => {
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
      // 驱动至 failed（重连时长上限 60s，循环模式对齐 invariants ⑤）
      let guard = 0
      while (getState().value !== 'failed' && guard < 30) {
        latestFake().triggerClose()
        vi.advanceTimersByTime(30_000)
        guard++
      }
      expect(getState().value).toBe('failed')
      const lenAtFail = fakes.length
      expectAtMostOneAlive()

      // 用户重试 / 重复 init 再入场：ws CLOSED → 放行，state 离开 failed
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(lenAtFail + 1)
      expect(getState().value).toBe('connecting')
      expectAtMostOneAlive()

      // 重连预算已重置的行为锚：再入场后不 open 直接断线（再入场后的首次掉线）。
      // setFailed 未复位簿记时——残留 reconnectStartedAt（本次驱动约 90s 前）越 60s 时长上限，
      // 本次 scheduleReconnect 直落 failed；残留 reconnectAttempts 使首个退避间隔为 8s（2^3）
      // 而非 base 1s。两条复位线各有独立红灯。
      latestFake().triggerClose()
      expect(getState().value).toBe('reconnecting') // 未直落 failed = reconnectStartedAt 已复位
      vi.advanceTimersByTime(1_000) // base 1s 到 → 退避链接力建新连接（从 base 起步 = attempts 已复位）
      expect(fakes.length).toBe(lenAtFail + 2)
      expect(getState().value).toBe('connecting')
      expectAtMostOneAlive()
    })

    it('混合驱动序列不变量：open/close/重连/外部 connect 任意交错后非 CLOSED socket 至多一个', () => {
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
      expectAtMostOneAlive()

      // 已连接时重复 connect（外部入场口）→ 拦
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(1)

      latestFake().triggerClose() // 断线 → 退避
      connect('ws://test', { auth: 'skip' }) // 外部提前重连（旧 CLOSED → 放行 + 清 T1）
      expect(fakes.length).toBe(2)
      expectAtMostOneAlive()

      vi.advanceTimersByTime(5_000) // 被清的 T1 不会建连；#2 仍 CONNECTING
      expect(fakes.length).toBe(2)

      latestFake().triggerClose() // #2 失败 → 退避（attempts=2 → delay 4s）
      vi.advanceTimersByTime(4_000) // 退避链建 #3
      expect(fakes.length).toBe(3)
      expectAtMostOneAlive()

      // 主动断开后重复 connect（disconnect 置 ws=null → 放行）
      disconnect()
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(4)
      expectAtMostOneAlive()
    })
  })
});
