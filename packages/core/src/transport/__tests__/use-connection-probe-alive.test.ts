// use-connection visibility 切前台探活接线测试（remote 形态死链检测）。
//
// 真实 ws-client（不 mock 模块，对齐 use-connection-auth-rejection 测试体例）+ fake 平台
// WebSocket，锁定 visibility 回调的形态分流接线：
// ① remote 形态 + connected 切前台 → probeAlive 被调（探活 ping 上 wire）；5s 无入站帧 →
//    close → 退避重连链可达，重连后 auth 握手照常（完整链路锚 + 簿记不残留）
// ② remote 形态 + connected 切后台（hidden）→ 不探活（守卫 1 先于探活分支）
// ③ local 形态（ipc 有值）+ connected 切前台 → 不探活、不 close（桌面零回归锚——桌面死链
//    检测由 IPC supervisor 事件兜底）
// ④ mock 形态 + connected 切前台 → 不探活（现状保持）
//
// 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-probe-alive.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform } from '../../platform/port'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import { disconnect, getState } from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

let fakes: FakeWebSocket[]
let visibilityHandler: (() => void) | null = null
let visVisible = true

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

/** 本地形态 ipc 端口 stub（auth-rejection 测试 buildIpc 同款最小视图） */
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

function makePorts(spec: { remote?: boolean; mock?: boolean }): ConnectionPorts {
  return {
    ...(spec.remote || spec.mock ? {} : { ipc: buildIpc(4000, 'tok-local') }),
    visibility: {
      isVisible: () => visVisible,
      onVisibilityChange: (cb) => {
        visibilityHandler = cb
        return () => {
          visibilityHandler = null
        }
      },
    },
    env: { isMock: spec.mock === true, isDev: false },
    ...(spec.remote
      ? {
          connectionProfile: {
            resolve: async () => ({ url: 'ws://192.168.1.5:3210', token: 'tok-remote' }),
          },
        }
      : {}),
    onAuthRejected: vi.fn(),
    effects: {},
    t: (key: string) => key,
    onRuntimeUnavailable: vi.fn(),
  }
}

async function initFresh(ports: ConnectionPorts): Promise<void> {
  setConnectionPorts(ports)
  await useConnection().init()
}

/** 建连 + auth 握手到 connected（init 已由调用方完成） */
function openAndAuth(f: FakeWebSocket): void {
  f.triggerOpen()
  f.triggerMessage(authResult(true))
  expect(getState().value).toBe('connected')
}

describe('use-connection visibility 探活接线（remote 死链检测）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
    visibilityHandler = null
    visVisible = true
  })
  afterEach(() => {
    // 复位 use-connection 模块级单例态（initialised/listeners/lastConnectedUrl），用例互不污染
    useConnection().teardown()
    disconnect()
    vi.useRealTimers()
  })

  it('remote 形态 connected 切前台 → 探活 ping 上 wire；5s 无帧 close → 重连可达、auth 照常（完整链路）', async () => {
    await initFresh(makePorts({ remote: true }))
    expect(fakes.length).toBe(1)
    const f = fakes[0]
    openAndAuth(f)
    expect(f.sent).toHaveLength(1) // 仅 auth 帧

    visibilityHandler?.() // 切回前台
    // 探活被触发：ping 上 wire（非重连——connect 未被再调）
    expect(f.sent).toHaveLength(2)
    expect(JSON.parse(f.sent[1])).toEqual({ type: 'ping', payload: {} })
    expect(fakes.length).toBe(1)

    vi.advanceTimersByTime(5_000)
    expect(f.closeCalls).toBe(1) // 无任何入站帧 → 主动 close
    f.triggerClose()
    expect(getState().value).toBe('reconnecting')
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(2) // 1s 退避到 → 重连发起

    // 簿记不残留：重连后 auth 握手照常（凭据复用 lastCredentials）
    fakes[1].triggerOpen()
    expect(JSON.parse(fakes[1].sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-remote' } })
  })

  it('remote 形态 connected 切后台（hidden）→ 不探活（守卫 1 先于探活分支）', async () => {
    await initFresh(makePorts({ remote: true }))
    const f = fakes[0]
    openAndAuth(f)

    visVisible = false
    visibilityHandler?.()
    expect(f.sent).toHaveLength(1) // 无探活 ping
    vi.advanceTimersByTime(10_000)
    expect(f.closeCalls).toBe(0)
  })

  it('local 形态 connected 切前台 → 不探活不 close（桌面零回归锚）', async () => {
    await initFresh(makePorts({})) // ipc 有值 = local 形态
    expect(fakes.length).toBe(1)
    const f = fakes[0]
    openAndAuth(f)
    expect(f.sent).toHaveLength(1)

    visibilityHandler?.()
    expect(f.sent).toHaveLength(1) // 无探活 ping
    vi.advanceTimersByTime(10_000)
    expect(f.closeCalls).toBe(0) // 不 close
    expect(getState().value).toBe('connected')
  })

  it('mock 形态 connected 切前台 → 不探活（现状保持）', async () => {
    await initFresh(makePorts({ mock: true }))
    const f = fakes[0]
    f.triggerOpen() // {auth:'skip'}：onopen 即 connected
    expect(getState().value).toBe('connected')

    visibilityHandler?.()
    expect(f.sent).toHaveLength(0) // 无探活 ping
    vi.advanceTimersByTime(10_000)
    expect(f.closeCalls).toBe(0)
  })
})
