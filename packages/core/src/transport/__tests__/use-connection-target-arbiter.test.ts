/**
 * 连接控制器目标裁决表测试（connection-datasync-ssot §6.3 五行裁决表 + §6.1 实例核对）。
 *
 * 真实 ws-client（不 mock）+ fake 平台 WebSocket + 真实 use-connection 连接控制器，
 * 覆盖 impl-plan u3 验收条款 1 的裁决表各行与实例核对 fail-fast 链：
 * - 同 seq 不动作（幂等重复广播不拆连）/ seq 更低丢弃（不回退目标）
 * - seq 更高 + 已认证 → 断旧连新（携新凭据；getCurrentToken 世代信号随之更新——终端域
 *   世代判据回归项）
 * - seq 更高 + 未认证（connecting）→ 转向新目标
 * - auth 应答 runtimeId 不一致 → fail-fast 断开重拉重连（新目标核对一致即恢复，streak 清零）
 * - 连续 2 次不一致（快照已推进仍连错）→ setFailed 停止自动重连
 * - 快照未推进的重拉 → setFailed（连旧目标必再 mismatch，显式失败呈现）
 * - ws-client 层：waiting-runtime 态 / onAuthAccepted 未注册的 P-1 兼容（仅读 payload.ok）
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-target-arbiter.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RuntimeTargetSnapshot } from '@taiji/shared'
import { providePlatform } from '../../platform/port'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import {
  connect,
  disconnect,
  getCurrentToken,
  getState,
  onAuthAccepted,
  setWaitingRuntime,
} from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

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

function snap(seq: number, port: number, token: string, runtimeId: string): RuntimeTargetSnapshot {
  return { seq, runtimeId, port, token }
}

function authResult(ok: boolean, runtimeId?: string): string {
  return JSON.stringify({ type: 'auth.result', payload: ok ? { ok, runtimeId } : { ok } })
}

/** 快照可编程桩（裁决各路径都要在重拉时改变快照值） */
let stubSnapshot: RuntimeTargetSnapshot | null
let snapshotCb: ((snapshot: RuntimeTargetSnapshot) => void) | null = null

function makePorts(): ConnectionPorts {
  return {
    ipc: {
      getRuntimeTargetSnapshot: vi.fn(async () => stubSnapshot),
      onRuntimePort: (cb: (snapshot: RuntimeTargetSnapshot) => void) => {
        snapshotCb = cb
        return () => {
          snapshotCb = null
        }
      },
      onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
      onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
      onRuntimeError: vi.fn().mockReturnValue(() => {}),
      getRuntimeStartError: vi.fn(async () => null),
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
    env: { isMock: false, isDev: false },
    effects: {},
    t: (key: string) => key,
    onRuntimeUnavailable: vi.fn(),
  }
}

/** init 首连（快照桩先就位）并完成 auth 握手到 connected */
async function connectAuthenticated(initial: RuntimeTargetSnapshot): Promise<FakeWebSocket> {
  stubSnapshot = initial
  setConnectionPorts(makePorts())
  await useConnection().init()
  expect(fakes.length).toBe(1)
  const f = fakes[0]
  f.triggerOpen()
  f.triggerMessage(authResult(true, initial.runtimeId))
  expect(getState().value).toBe('connected')
  return f
}

/** flush 快照重拉的微任务链（recover* → pull → applyTargetSnapshot → connect） */
async function flushRecovery(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('连接控制器目标裁决表（§6.3）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    stubSnapshot = null
    snapshotCb = null
    disconnect()
  })
  afterEach(() => {
    useConnection().teardown()
    disconnect()
    vi.useRealTimers()
  })

  it('已认证 + seq 更高 → 断旧连新（携新快照凭据）；getCurrentToken 世代信号随之更新', async () => {
    const f1 = await connectAuthenticated(snap(1, 4000, 'tok-1', 'rt-1'))
    expect(f1.closeCalls).toBe(0)
    snapshotCb!(snap(2, 4500, 'tok-2', 'rt-2'))
    // 断旧：旧 socket 被 close（disconnect 摘回调后 close，不走 onclose 重连链）
    expect(f1.closeCalls).toBeGreaterThanOrEqual(1)
    // 连新：新快照 url + 新凭据
    expect(fakes.length).toBe(2)
    const f2 = fakes[1]
    f2.triggerOpen()
    expect(JSON.parse(f2.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-2' } })
    // 终端域世代判据回归项：新实例 token 必须可见（世代变更信号）
    expect(getCurrentToken()).toBe('tok-2')
  })

  it('已认证 + 同 seq 幂等重播 → 不动作（重复广播不拆连，getCurrentToken 不变）', async () => {
    const f1 = await connectAuthenticated(snap(1, 4000, 'tok-1', 'rt-1'))
    snapshotCb!(snap(1, 4000, 'tok-1', 'rt-1'))
    expect(fakes.length).toBe(1)
    expect(f1.closeCalls).toBe(0)
    expect(getState().value).toBe('connected')
    expect(getCurrentToken()).toBe('tok-1')
  })

  it('已认证 + seq 更低（拉取响应晚于推送的旧代）→ 丢弃，不回退目标', async () => {
    await connectAuthenticated(snap(2, 4500, 'tok-2', 'rt-2'))
    snapshotCb!(snap(1, 4000, 'tok-1', 'rt-1'))
    expect(fakes.length).toBe(1)
    expect(getState().value).toBe('connected')
    expect(getCurrentToken()).toBe('tok-2')
  })

  it('未认证（connecting 中）+ seq 更高 → 转向新目标（弃未完成的旧连接）', async () => {
    stubSnapshot = snap(1, 4000, 'tok-1', 'rt-1')
    setConnectionPorts(makePorts())
    await useConnection().init()
    expect(fakes.length).toBe(1)
    // f1 停在 connecting（未 triggerOpen，auth 未完成）
    expect(getState().value).toBe('connecting')
    snapshotCb!(snap(2, 4500, 'tok-2', 'rt-2'))
    // 转向：旧连接被弃（close），新目标发起
    expect(fakes.length).toBe(2)
    expect(fakes[0].closeCalls).toBeGreaterThanOrEqual(1)
    const f2 = fakes[1]
    f2.triggerOpen()
    expect(JSON.parse(f2.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-2' } })
  })

  it('实例核对不一致 → fail-fast 断开（不 connected 化）+ 重拉快照重连，一致后 streak 清零', async () => {
    stubSnapshot = snap(1, 4000, 'tok-1', 'rt-1')
    setConnectionPorts(makePorts())
    await useConnection().init()
    const f1 = fakes[0]
    f1.triggerOpen()
    // 先就位重拉结果：supervisor 已推进到 seq 2（真目标在别处）——核对失败的同步段就
    // 发起重拉（async 桩调用即读取当前值），赋值必须先于 triggerMessage
    stubSnapshot = snap(2, 4500, 'tok-2', 'rt-2')
    // 连到非预期进程：应答 runtimeId ≠ 期望快照（端口被旧实例占据的形态）
    f1.triggerMessage(authResult(true, 'rt-intruder'))
    // fail-fast：不进入 connected，连接被断开
    expect(getState().value).not.toBe('connected')
    expect(f1.closeCalls).toBeGreaterThanOrEqual(1)
    await flushRecovery()
    expect(fakes.length).toBe(2)
    const f2 = fakes[1]
    f2.triggerOpen()
    f2.triggerMessage(authResult(true, 'rt-2'))
    expect(getState().value).toBe('connected')
  })

  it('连续 2 次不一致（快照已推进仍连错）→ 停止自动重连置 failed', async () => {
    stubSnapshot = snap(1, 4000, 'tok-1', 'rt-1')
    setConnectionPorts(makePorts())
    await useConnection().init()
    const f1 = fakes[0]
    f1.triggerOpen()
    // 第 1 次不一致：重拉推进到 seq 2（先就位重拉结果，理由同上）
    stubSnapshot = snap(2, 4500, 'tok-2', 'rt-2')
    f1.triggerMessage(authResult(true, 'rt-intruder'))
    await flushRecovery()
    expect(fakes.length).toBe(2)
    const f2 = fakes[1]
    f2.triggerOpen()
    // 第 2 次不一致：连向 seq 2 目标却仍应答别的 id——前提失效形态，达停止阈值
    f2.triggerMessage(authResult(true, 'rt-intruder-2'))
    await flushRecovery()
    expect(getState().value).toBe('failed')
    // 停止自动重连：不再发起新连接
    expect(fakes.length).toBe(2)
  })

  it('核对失败重拉但快照未推进 → setFailed（重连旧目标必再 mismatch，不盲试）', async () => {
    stubSnapshot = snap(1, 4000, 'tok-1', 'rt-1')
    setConnectionPorts(makePorts())
    await useConnection().init()
    const f1 = fakes[0]
    f1.triggerOpen()
    f1.triggerMessage(authResult(true, 'rt-intruder'))
    // 重拉仍是 seq 1（目标未变——连到错进程但快照不动的异常态）
    await flushRecovery()
    expect(getState().value).toBe('failed')
    expect(fakes.length).toBe(1)
  })
})

describe('ws-client 等待态与 auth 接受信号（§6.8/§6.1）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    useConnection().teardown()
    disconnect()
    vi.useRealTimers()
  })

  it('setWaitingRuntime：断残留连接与退避定时器，状态置 waiting-runtime', async () => {
    // 先造一条连接 + 断开进退避（reconnecting 定时器在途）
    connect('ws://localhost:4000', { auth: 'token', token: 'tok' })
    const f = fakes[0]
    f.triggerOpen()
    f.triggerClose()
    expect(getState().value).toBe('reconnecting')
    setWaitingRuntime()
    expect(getState().value).toBe('waiting-runtime')
    // 等待期无自动重连（退避定时器已清）
    vi.advanceTimersByTime(60_000)
    expect(fakes.length).toBe(1)
  })

  it('onAuthAccepted 未注册（P-1 兼容）：仅读 payload.ok，行为与旧客户端一致', async () => {
    connect('ws://localhost:4000', { auth: 'token', token: 'tok' })
    const f = fakes[0]
    f.triggerOpen()
    // 应答带 runtimeId 字段但无人消费——多余字段不破坏仅读 ok 的路径
    f.triggerMessage(authResult(true, 'rt-x'))
    expect(getState().value).toBe('connected')
    // skip 形态凭据 getCurrentToken 为 null（世代判据语义：非 token 形态不参与）
    disconnect()
    connect('mock://localhost', { auth: 'skip' })
    fakes[1].triggerOpen()
    expect(getState().value).toBe('connected')
    expect(getCurrentToken()).toBeNull()
  })

  it('onAuthAccepted 注册且返回 false：断开且不 connected 化（fail-fast 半边）', async () => {
    const off = onAuthAccepted(() => false)
    connect('ws://localhost:4000', { auth: 'token', token: 'tok' })
    const f = fakes[0]
    f.triggerOpen()
    f.triggerMessage(authResult(true, 'rt-x'))
    expect(getState().value).toBe('disconnected')
    expect(f.closeCalls).toBeGreaterThanOrEqual(1)
    off()
  })

  it('getCurrentToken 回归（终端域世代判据）：connect 传入即更新、内部退避重连保留、断开后保留至下次 connect', async () => {
    connect('ws://localhost:4000', { auth: 'token', token: 'gen-1' })
    expect(getCurrentToken()).toBe('gen-1')
    const f = fakes[0]
    f.triggerOpen()
    f.triggerMessage(authResult(true, 'rt-1'))
    expect(getState().value).toBe('connected')
    // 断连 → 内部退避重连（scheduleReconnect 复用 currentCredentials）：世代不变
    f.triggerClose()
    expect(getState().value).toBe('reconnecting')
    expect(getCurrentToken()).toBe('gen-1')
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(2)
    fakes[1].triggerOpen()
    fakes[1].triggerMessage(authResult(true, 'rt-1'))
    expect(getCurrentToken()).toBe('gen-1')
    // 新实例凭据（连接控制器断旧连新路径）→ 世代变更
    connect('ws://localhost:4500', { auth: 'token', token: 'gen-2' })
    expect(getCurrentToken()).toBe('gen-2')
  })
})
