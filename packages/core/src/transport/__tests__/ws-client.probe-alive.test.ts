// ws-client 探活（probeAlive）死链检测测试。
//
// 规格来源：ws-client.invariants.test.ts 头注释块 ⑦（探活不变量 SSOT）。
// 背景：移动锁屏/基站切换形成半开 TCP——心跳只发 ping 不等 pong，移动壳无 IPC supervisor
// 事件补位（桌面才有），state 恒 connected、send 返回 true 但对端收不到。probeAlive 在
// connected 态发 ping + 限时等任意入站帧，超时 close 走既有退避重连链。
//
// 锁定行为：
// 1. 超时路径：ping 上 wire，5s 无入站帧 → close 被调 → onclose → 退避重连链可达（簿记不动）
// 2. 活性路径：5s 内任意入站帧（pong / 坏 JSON 帧）→ 计时器清除、不 close
// 3. 状态门控：非 connected（disconnected / connecting / reconnecting）调用 no-op
// 4. 单定时器不变量：重复调用只留一个计时器
// 5. 清理不跨代：探活窗内断开（onclose / disconnect 路径）→ 计时器清除，重连后的新连接不被
//    旧计时器误杀，新连接上探活可复用（簿记不残留）
//
// 运行：cd packages/core && npx vitest run src/transport/__tests__/ws-client.probe-alive.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform } from '../../platform/port'
import { connect, disconnect, getState, probeAlive } from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

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

    // 坏帧（parse 失败路径）同样是链路活性证据——清除点在大小守卫/parse 之前
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
