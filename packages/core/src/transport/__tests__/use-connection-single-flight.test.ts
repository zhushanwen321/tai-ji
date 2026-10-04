// use-connection 三入场口单飞集成测试（移动端「同页多 WS 连接并存（半死）」防回归）。
//
// 与 use-connection-*.test.ts 的差异：本文件**不 mock ../ws-client**——真实 ws-client +
// fake websocket 平台 + 可控 visibility/profile 端口，端到端验证三个重连入场口（重复
// initConnection / visibility 切前台 × 退避定时器 / failed 后重试）交错时不产生并存
// WebSocket 实例（create 次数与 close 配对：任意时点非 CLOSED socket 至多一个）。
// ws-client 层的守卫单测见 ws-client.single-flight.test.ts；本文件锁定「入场口 × 守卫」
// 的组合行为（use-connection 的 visibility handler / init 重入路径真实走到 ws-client）。
//
// 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-single-flight.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform, WS_READY_STATE } from '../../platform/port'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import { getState, setFailed } from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

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

/** close 配对不变量：任意时点非 CLOSED（存活/悬挂）socket 至多一个。 */
function expectAtMostOneAlive(): void {
  const alive = fakes.filter((f) => f.readyState !== WS_READY_STATE.CLOSED)
  expect(alive.length).toBeLessThanOrEqual(1)
}

/** 完成 token 握手（open → auth 帧 → auth.result ok）→ connected。 */
function handshakeOk(f: FakeWebSocket): void {
  f.triggerOpen()
  f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
  expect(getState().value).toBe('connected')
}

// ── 远程形态端口（移动壳等价：无 ipc + connectionProfile + 可控 visibility）──
let visVisible = false
let visHandler: (() => void) | null = null

function makeRemotePorts(): ConnectionPorts {
  return {
    // 无 ipc = 远程形态（resolveConnectionMode 判定）
    visibility: {
      isVisible: () => visVisible,
      onVisibilityChange: (h: () => void) => {
        visHandler = h
        return () => {
          visHandler = null
        }
      },
    },
    env: { isMock: false, isDev: false },
    connectionProfile: {
      resolve: async () => ({ url: 'ws://remote-test', token: 'tok' }),
    },
    onAuthRejected: () => {},
    effects: {},
    t: (key: string) => `[${key}]`,
    onRuntimeUnavailable: () => {},
  }
}

describe('use-connection 三入场口单飞（真实 ws-client 集成）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    visVisible = false
    visHandler = null
    setConnectionPorts(makeRemotePorts())
  })
  afterEach(() => {
    useConnection().teardown() // 拆监听 + disconnect + initialised 复位（模块级单例防跨用例污染）
    // setFailed 复位重连簿记（reconnectAttempts / reconnectStartedAt——disconnect 刻意不重置，
    // 仅 markConnected / setFailed 复位），防用例间泄漏使退避时值依赖执行历史
    setFailed()
    vi.useRealTimers()
  })

  it('重复 initConnection：第二次 init 不新建 WS（活跃 CONNECTING socket 单飞拦截）', async () => {
    const conn = useConnection()
    await conn.init()
    expect(fakes.length).toBe(1)
    await conn.init() // 重复 init（initialised=true → remote 分支重走 profile → connect）
    expect(fakes.length).toBe(1) // 幂等：未创建新 WS
    expect(getState().value).toBe('connecting')
    expectAtMostOneAlive()
  })

  it('visibility 切前台 × connecting：已有连接中 socket 时切前台不新建 WS', async () => {
    const conn = useConnection()
    await conn.init()
    expect(fakes.length).toBe(1)
    expect(visHandler).not.toBeNull()

    visVisible = true
    visHandler!() // state='connecting'（非 connected）→ visibility 放行到 connectWs → 单飞拦截
    expect(fakes.length).toBe(1)
    expectAtMostOneAlive()
  })

  it('visibility 切前台 × 退避定时器双源：外部 connect 放行后清退避定时器，不叠双建连', async () => {
    const conn = useConnection()
    await conn.init()

    // 建连 + auth 通过 → 断线 → 退避 T1@1s
    handshakeOk(fakes[0]!)
    fakes[0]!.triggerClose()
    expect(getState().value).toBe('reconnecting')

    // 切前台：旧 socket 已 CLOSED → 放行建 #2（T1 被清）
    visVisible = true
    visHandler!()
    expect(fakes.length).toBe(2)
    expectAtMostOneAlive()

    // #2 立即失败 → 退避 T2@2s（attempts 累积）
    fakes[1]!.triggerClose()
    expect(getState().value).toBe('reconnecting')

    // T1 原到期点（1s）：定时器已清，无提前建连
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(2)
    expectAtMostOneAlive()

    // T2 到期：退避链唯一建 #3，收敛
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(3)
    expectAtMostOneAlive()
  })

  it('visibility 切前台 × CLOSING 悬挂：close 握手未完成时切前台不放行，onclose 后退避链接力', async () => {
    const conn = useConnection()
    await conn.init()

    // auth 5s 超时 → close() 已发出但 close 事件未送达（CLOSING 悬挂，弱网形态）
    fakes[0]!.triggerOpen()
    vi.advanceTimersByTime(5_000)
    fakes[0]!.setReadyState(WS_READY_STATE.CLOSING)

    // 切前台：state='connecting'（非 connected）→ visibility 放行到 connectWs → CLOSING 拦截
    visVisible = true
    visHandler!()
    expect(fakes.length).toBe(1)
    expectAtMostOneAlive()

    // close 事件送达 → 退避链接力建 #2
    fakes[0]!.triggerClose()
    vi.advanceTimersByTime(1_000)
    expect(fakes.length).toBe(2)
    expect(fakes[0]!.readyState).toBe(WS_READY_STATE.CLOSED)
    expectAtMostOneAlive()
  })

  it('failed 后重试（重复 init 等价再入场）：旧 socket 已 CLOSED → 放行重建，state 离开 failed', async () => {
    const conn = useConnection()
    await conn.init()
    handshakeOk(fakes[0]!)

    // 驱动至 failed（重连时长上限 60s；循环模式对齐 ws-client.invariants ⑤）
    let guard = 0
    while (getState().value !== 'failed' && guard < 30) {
      fakes[fakes.length - 1]!.triggerClose()
      vi.advanceTimersByTime(30_000)
      guard++
    }
    expect(getState().value).toBe('failed')
    const lenAtFail = fakes.length
    expectAtMostOneAlive()

    // 再入场（用户重试 / 重复 init）：旧 socket CLOSED → 放行，重连预算已重置
    await conn.init()
    expect(fakes.length).toBe(lenAtFail + 1)
    expect(getState().value).toBe('connecting')
    expectAtMostOneAlive()
  })
})
