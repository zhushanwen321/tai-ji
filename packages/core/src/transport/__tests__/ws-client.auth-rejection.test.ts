// ws-client auth 拒绝显式信号 + 重连抑制位测试（remote-use D8 / U1.3）。
//
// 锁定四个行为特征：
// 1. auth.result ok:false 时 onAuthRejected 信号**先于 ws.close()** 触发（信号触发瞬间 socket
//    仍 OPEN 且 close 未调用），随后 close 照常走重连链（D8 前现状不变量保留）
// 2. 有注册消费方：拒绝置抑制位 → onclose 后 scheduleReconnect 短路（不调度、无新连接）
// 3. 无注册消费方（桌面形态）：拒绝不置抑制位 → close 走原退避重连链（零回归锚——桌面行为
//    不变的直接证据）
// 4. resetAuthRejectionSuppression 显式解除（token 重试路径）+ markConnected（auth 成功）自动
//    复位 → 重试 connect 可达，且后续正常断线恢复自动重连
//
// 运行：cd packages/core && npx vitest run src/transport/__tests__/ws-client.auth-rejection.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform } from '../../platform/port'
import {
  connect,
  disconnect,
  getState,
  isAuthRejectedSuppressed,
  onAuthRejected,
  resetAuthRejectionSuppression,
} from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

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
