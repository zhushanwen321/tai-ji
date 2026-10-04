/**
 * 连接发现收口测试（renderer-package-topology §2.4「连接发现策略可插拔」/ 连接派生 profile 策略 D4）。
 *
 * 锁定 init() 的三形态分支选择与各形态连接目标派生：
 * - 分支选择：mock = env.isMock（优先于 ipc 存在性——electron 装配恒注入 ipc（含
 *   VITE_MOCK 构建），mock 优先是桌面等价性要求）；本地 = ipc 有值；远程 = ipc 无值。
 * - electron 本地形态 URL 派生与收口前逐字节等价：knownPort / onRuntimePort 推送 /
 *   fallback（含 dev offset）/ HMR 重连四条路径的 URL 字符串断言。
 * - 远程 profile 分支：连接目标经注入的 connectionProfile 解析（U1.3 移动壳消费点）；
 *   未注入时 init 显式失败（fail-fast + 恢复指引），不静默降级、不发起连接。
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-mode-dispatch.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import type { ConnectionState } from '../ws-client'
import {
  useConnection,
  setConnectionPorts,
  type ConnectionPorts,
  type ConnectionProfilePort,
  type ResolvedConnectionProfile,
} from '../use-connection'
import { connect, disconnect } from '../ws-client'

// ── ws-client mock：捕获 connect/disconnect 调用 + 可控连接状态 ref（token-refresh 测试同款）──
const mockStateRef = ref<ConnectionState>('disconnected')
let inboundHandler: ((msg: ServerMessage) => void) | null = null
vi.mock('../ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: (cb: (msg: ServerMessage) => void) => {
    inboundHandler = cb
    return () => {
      inboundHandler = null
    }
  },
  onQueueDrop: vi.fn(() => () => {}),
  // U1.3 D8：auth 拒绝信号消费面（use-connection 远程形态注册/查询）——本文件断言连接目标
  // 与分支选择，信号路径由 use-connection-auth-rejection.test.ts 专项锁定
  onAuthRejected: vi.fn(() => () => {}),
  isAuthRejectedSuppressed: vi.fn(() => false),
}))

// ── 其余端口 mock（use-connection-token-refresh.test.ts 同款；D3 后三件套直连真实模块，
// 本文件只断言分支选择与连接目标，三件套零断言依赖）──

/** onRuntimePort 捕获的回调，测试内触发端口推送 */
let portCb: ((port: number) => void) | null = null

interface PortsSpec {
  isMock?: boolean
  isDev?: boolean
  /** false = 不注入 ipc（远程形态判别输入）；缺省 = 注入（electron 装配形态） */
  withIpc?: boolean
  withProfile?: boolean
  knownPort?: number | undefined
  offset?: number | undefined
  token?: string | null
  profileUrl?: string
  /** null = resolve 结果不带 token（无凭据路径） */
  profileToken?: string | null
}

function buildIpc(spec: PortsSpec) {
  return {
    getRuntimePort: vi.fn().mockResolvedValue(spec.knownPort),
    getRuntimePortOffset: vi.fn().mockResolvedValue(spec.offset),
    getRuntimeToken: vi.fn().mockResolvedValue(spec.token ?? null),
    onRuntimePort: vi.fn((cb: (port: number) => void) => {
      portCb = cb
      return () => {
        portCb = null
      }
    }),
    onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
    onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
    restartRuntime: vi.fn().mockResolvedValue(undefined),
  }
}

function buildProfile(spec: PortsSpec): ConnectionProfilePort & {
  resolve: ReturnType<typeof vi.fn>
} {
  const resolved: ResolvedConnectionProfile = {
    url: spec.profileUrl ?? 'ws://192.168.1.5:3210',
    ...(spec.profileToken === null ? {} : { token: spec.profileToken ?? 'remote-token' }),
  }
  return {
    resolve: vi.fn().mockResolvedValue(resolved),
  }
}

function makePorts(spec: PortsSpec = {}): {
  ports: ConnectionPorts
  ipc: ReturnType<typeof buildIpc> | null
  profile: ReturnType<typeof buildProfile> | null
} {
  const ipc = spec.withIpc === false ? null : buildIpc(spec)
  const profile = spec.withProfile ? buildProfile(spec) : null
  const ports: ConnectionPorts = {
    ...(ipc ? { ipc } : {}),
    visibility: { isVisible: () => true, onVisibilityChange: () => () => {} },
    env: { isMock: spec.isMock ?? false, isDev: spec.isDev ?? false },
    ...(profile ? { connectionProfile: profile } : {}),
    effects: {},
    t: vi.fn((key: string) => `[${key}]`),
    onRuntimeUnavailable: vi.fn(),
  }
  return { ports, ipc, profile }
}

/** 注入 + 首次 init（清模块态后调用；模块态由 afterEach teardown 复位） */
async function initFresh(ports: ConnectionPorts): Promise<void> {
  setConnectionPorts(ports)
  await useConnection().init()
}

/** 等 fire-and-forget 的 refreshTokenAndConnect 完成（token-refresh 测试同款） */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  portCb = null
  mockStateRef.value = 'disconnected'
})

afterEach(() => {
  // 复位 use-connection 模块级单例态（initialised/listeners/lastConnectedUrl），用例互不污染
  useConnection().teardown()
})

describe('连接发现收口：三形态分支选择（topology §2.4 / D4）', () => {
  it('TC-M1: mock 分支优先于 ipc 存在性（electron mock 构建形态：ipc 有值 + isMock）→ mock:// 且零 IPC 端口发现', async () => {
    const { ports, ipc } = makePorts({ isMock: true, knownPort: 4000 })
    await initFresh(ports)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('mock://localhost', undefined)
    // mock 分支不做端口发现、不注册 runtime 事件监听（现状行为）
    expect(ipc?.getRuntimePort).not.toHaveBeenCalled()
    expect(ipc?.onRuntimePort).not.toHaveBeenCalled()
    // HMR 重复 init 亦不发起本地重连（现状行为）
    await useConnection().init()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('TC-M2: ipc 无值 + isMock → 同样 mock://（ipc 存在性不改变 mock 行为）', async () => {
    const { ports, ipc } = makePorts({ isMock: true, withIpc: false })
    await initFresh(ports)
    expect(connect).toHaveBeenCalledWith('mock://localhost', undefined)
    expect(ipc).toBeNull()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('TC-M3: 本地分支（ipc 有值 + 非 mock）→ knownPort 路径 connect ws://localhost:4000 + token（收口前等价）', async () => {
    const { ports, ipc } = makePorts({ knownPort: 4000, token: 'tok-1' })
    await initFresh(ports)
    // 本地分支完整装配：端口发现 + runtime 事件监听注册
    expect(ipc?.getRuntimePort).toHaveBeenCalledTimes(1)
    expect(ipc?.onRuntimePort).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('ws://localhost:4000', 'tok-1')
  })

  it('TC-M4: 本地分支 fallback（getRuntimePort→undefined）→ ws://localhost:3210（BASE_PORT，收口前等价）', async () => {
    const { ports } = makePorts({ knownPort: undefined, offset: undefined, token: 'tok-2' })
    await initFresh(ports)
    expect(connect).toHaveBeenCalledWith('ws://localhost:3210', 'tok-2')
  })

  it('TC-M5: 本地分支 dev fallback（isDev + offset undefined）→ ws://localhost:3310（BASE_PORT+DEV_PORT_OFFSET，收口前等价）', async () => {
    const { ports } = makePorts({ isDev: true, offset: undefined, token: null })
    await initFresh(ports)
    expect(connect).toHaveBeenCalledWith('ws://localhost:3310', undefined)
  })

  it('TC-M6: 本地分支 onRuntimePort 推送 → disconnect + 重拉 token + connect ws://localhost:4500（收口前等价）', async () => {
    const { ports } = makePorts({ knownPort: 4000, token: 'tok-3' })
    await initFresh(ports)
    // 推送守卫要求 state !== 'disconnected'（runtime 存活期间常态为 connected）
    mockStateRef.value = 'connected'
    portCb!(4500)
    await flushAsync()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('ws://localhost:4500', 'tok-3')
  })

  it('TC-M7: 本地分支 HMR 重连（重复 init）→ fallback URL ws://localhost:3210（收口前等价）', async () => {
    const { ports } = makePorts({ knownPort: 4000, token: 'tok-4' })
    setConnectionPorts(ports)
    const conn = useConnection()
    await conn.init()
    expect(connect).toHaveBeenCalledWith('ws://localhost:4000', 'tok-4')
    // initialised=true → HMR 路径：仅按 fallback 端口重连，不重复端口发现
    await conn.init()
    expect(connect).toHaveBeenLastCalledWith('ws://localhost:3210', 'tok-4')
  })
})

describe('远程 profile 分支（U0.2 骨架，U1.3 移动壳消费点）', () => {
  it('TC-M8: ipc 无值 + 非 mock + profile 注入 → resolve 一次 + connect(profile.url, token)', async () => {
    const { ports, profile } = makePorts({
      withIpc: false,
      withProfile: true,
      profileUrl: 'ws://192.168.1.5:3210',
      profileToken: 'remote-token',
    })
    await initFresh(ports)
    expect(profile?.resolve).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('ws://192.168.1.5:3210', 'remote-token')
  })

  it('TC-M9: profile resolve 无 token → connect(url, "")（空串强制走 auth 握手，D8 恢复链可达）', async () => {
    // 不传 undefined：ws-client 的 undefined 语义是「保留上次 token / 无 token 模式」，
    // 首连会被判为无 auth 模式跳过握手 → runtime fail-closed 拒绝永远不可达（假 connected
    // 超时循环，token 输入视图不可达）。空串使 runtime 回 bad_token → onAuthRejected 闭合。
    const { ports, profile } = makePorts({ withIpc: false, withProfile: true, profileToken: null })
    await initFresh(ports)
    expect(profile?.resolve).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('ws://192.168.1.5:3210', '')
  })

  it('TC-M10: profile 未注入 → init 显式失败（含恢复指引）且不发起任何连接', async () => {
    const { ports } = makePorts({ withIpc: false })
    setConnectionPorts(ports)
    await expect(useConnection().init()).rejects.toThrow(
      /no connectionProfile injected[\s\S]*setConnectionPorts/,
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it('TC-M11: 远程 HMR 重连（重复 init）→ 再次经 profile 解析（骨架语义：重连同走收口点）', async () => {
    const { ports, profile } = makePorts({ withIpc: false, withProfile: true })
    setConnectionPorts(ports)
    const conn = useConnection()
    await conn.init()
    await conn.init()
    expect(profile?.resolve).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledTimes(2)
  })
})
