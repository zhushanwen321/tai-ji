// use-connection auth 拒绝信号消费测试（remote-use D8 / U1.3）。
//
// 真实 ws-client（不 mock，区别于 mode-dispatch 测试的模块 mock）+ fake 平台 WebSocket，
// 锁定 use-connection 形态分支的信号消费面：
// 1. 远程 profile 形态：connectRemoteProfile 注册 ws-client onAuthRejected → 转发
//    ports.onAuthRejected + 抑制位置位；visibility 切前台触发点被抑制（不重连）；reset +
//    visibility 再触发 → 重连恢复（显式复用 lastConnectedUrl 与 lastCredentials，S4）
// 2. 本地 ipc 形态（桌面）：不注册信号 → ports.onAuthRejected 不被调、无抑制位、close 走
//    原退避重连链（桌面零回归锚）
// 3. teardown 拆卸信号监听：重装后转发目标跟随最新装配（不串台）
//
// 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-auth-rejection.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform } from '../../platform/port'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import {
  disconnect,
  getState,
  isAuthRejectedSuppressed,
  resetAuthRejectionSuppression,
} from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

let fakes: FakeWebSocket[]
let visibilityHandler: (() => void) | null = null

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

function authResult(ok: boolean): string {
  return JSON.stringify({ type: 'auth.result', payload: { ok } })
}

/** 本地形态 ipc 端口 stub（mode-dispatch 测试 buildIpc 同款最小视图） */
function buildIpc(knownPort: number, token: string): NonNullable<ConnectionPorts['ipc']> {
  return {
    getRuntimePort: vi.fn().mockResolvedValue(knownPort),
    getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
    getRuntimeToken: vi.fn().mockResolvedValue(token),
    onRuntimePort: vi.fn().mockReturnValue(() => {}),
    onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
    onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
    onRuntimeError: vi.fn().mockReturnValue(() => {}),
    getRuntimeStartError: vi.fn().mockResolvedValue(null),
    restartRuntime: vi.fn().mockResolvedValue(undefined),
  }
}

function makePorts(spec: { remote: boolean }): {
  ports: ConnectionPorts
  onAuthRejected: ReturnType<typeof vi.fn>
} {
  const onAuthRejected = vi.fn()
  const ports: ConnectionPorts = {
    ...(spec.remote ? {} : { ipc: buildIpc(4000, 'tok-local') }),
    visibility: {
      isVisible: () => true,
      onVisibilityChange: (cb) => {
        visibilityHandler = cb
        return () => {
          visibilityHandler = null
        }
      },
    },
    env: { isMock: false, isDev: false },
    ...(spec.remote
      ? {
          connectionProfile: {
            resolve: async () => ({ url: 'ws://192.168.1.5:3210', token: 'tok-remote' }),
          },
        }
      : {}),
    onAuthRejected,
    effects: {},
    t: (key: string) => key,
    onRuntimeUnavailable: vi.fn(),
  }
  return { ports, onAuthRejected }
}

async function initFresh(ports: ConnectionPorts): Promise<void> {
  setConnectionPorts(ports)
  await useConnection().init()
}

describe('use-connection auth 拒绝信号消费（D8）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    resetAuthRejectionSuppression()
    disconnect()
    visibilityHandler = null
  })
  afterEach(() => {
    // 复位 use-connection 模块级单例态（initialised/listeners/lastConnectedUrl），用例互不污染
    useConnection().teardown()
    disconnect()
    resetAuthRejectionSuppression()
    vi.useRealTimers()
  })

  it('远程形态：auth 拒绝 → ports.onAuthRejected 转发 + 抑制位；visibility 触发点被抑制；reset 后重连恢复', async () => {
    const { ports, onAuthRejected } = makePorts({ remote: true })
    await initFresh(ports)
    expect(fakes.length).toBe(1)
    const f = fakes[0]
    f.triggerOpen()
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-remote' } })
    f.triggerMessage(authResult(false))
    // 信号转发 + 抑制位置位
    expect(onAuthRejected).toHaveBeenCalledTimes(1)
    expect(isAuthRejectedSuppressed()).toBe(true)
    f.triggerClose()
    expect(getState().value).toBe('disconnected')

    // D8 触发点②：切前台主动重连被抑制（无新连接）
    visibilityHandler?.()
    expect(fakes.length).toBe(1)

    // token 重试路径：reset → visibility 再触发 → 重连恢复（显式复用 lastConnectedUrl + lastCredentials）
    resetAuthRejectionSuppression()
    visibilityHandler?.()
    expect(fakes.length).toBe(2)
    const f2 = fakes[1]
    f2.triggerOpen()
    expect(JSON.parse(f2.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-remote' } })
  })

  it('本地形态（桌面零回归锚）：onAuthRejected 不被调、无抑制位、close 走原退避重连链', async () => {
    const { ports, onAuthRejected } = makePorts({ remote: false })
    await initFresh(ports)
    expect(fakes.length).toBe(1)
    const f = fakes[0]
    f.triggerOpen()
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-local' } })
    f.triggerMessage(authResult(false))
    // 本地形态不注册信号：回调不被调（即便 ports 上提供了实现）、抑制位不置位
    expect(onAuthRejected).not.toHaveBeenCalled()
    expect(isAuthRejectedSuppressed()).toBe(false)
    f.triggerClose()
    expect(getState().value).toBe('reconnecting') // D8 前现状不变量
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(2) // 1s 退避到 → 重连
  })

  it('teardown 拆卸信号监听：重装后转发目标跟随最新装配（不串台）', async () => {
    const first = makePorts({ remote: true })
    await initFresh(first.ports)
    useConnection().teardown()
    disconnect()

    const second = makePorts({ remote: true })
    await initFresh(second.ports)
    const f = fakes[fakes.length - 1]
    f.triggerOpen()
    f.triggerMessage(authResult(false))
    expect(second.onAuthRejected).toHaveBeenCalledTimes(1)
    expect(first.onAuthRejected).not.toHaveBeenCalled()
  })
})
