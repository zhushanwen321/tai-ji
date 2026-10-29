/**
 * 连接发现收敛测试（renderer-package-topology §2.4「连接发现策略可插拔」/ 连接派生 profile 策略 D4）。
 *
 * 锁定 init() 的三形态分支选择与各形态连接目标派生：
 * - 分支选择：mock = env.isMock（优先于 ipc 存在性——electron 装配恒注入 ipc（含
 *   VITE_MOCK 构建），mock 优先是桌面等价性要求）；本地 = ipc 有值；远程 = ipc 无值。
 * - electron 本地形态：连接目标 = 目标快照单一权威源（connection-datasync-ssot §6.2）——
 *   快照拉取 / 快照推送 / null 等待态 / HMR 重拉四条路径的 URL 与凭据断言（备用猜连
 *   fallback 公式已删除）。
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
import { connect, getState, setWaitingRuntime } from '../ws-client'

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
  // U1.3 D8：auth 拒绝信号消费方（use-connection 远程形态注册/查询）——本文件断言连接目标
  // 与分支选择，信号路径由 use-connection-auth-rejection.test.ts 专项锁定
  onAuthRejected: vi.fn(() => () => {}),
  isAuthRejectedSuppressed: vi.fn(() => false),
  // 连接控制器新消费面（connection-datasync-ssot §6.2/§6.3）
  setWaitingRuntime: vi.fn(),
  onAuthAccepted: vi.fn(() => () => {}),
  resetAuthRejectionSuppression: vi.fn(),
}))

// ── 其余端口 mock（use-connection-token-refresh.test.ts 同款；D3 后三件套直连真实模块，
// 本文件只断言分支选择与连接目标，三件套零断言依赖）──

interface PortsSpec {
  isMock?: boolean
  isDev?: boolean
  /** false = 不注入 ipc（远程形态判别输入）；缺省 = 注入（electron 装配形态） */
  withIpc?: boolean
  withProfile?: boolean
  /** 快照拉取桩返回值；缺省 = null（runtime 未启动 → 等待态）。undefined 字段显式传入无效，统一归 null */
  snapshot?: { seq: number; runtimeId: string; port: number; token: string } | null
  profileUrl?: string
  /** null = resolve 结果不带 token（无凭据路径） */
  profileToken?: string | null
}

function buildIpc(spec: PortsSpec) {
  return {
    getRuntimeTargetSnapshot: vi.fn().mockResolvedValue(spec.snapshot ?? null),
    onRuntimePort: vi.fn().mockReturnValue(() => {}),
    onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
    onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
    onRuntimeError: vi.fn().mockReturnValue(() => {}),
    getRuntimeStartError: vi.fn().mockResolvedValue(null),
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

beforeEach(() => {
  vi.clearAllMocks()
  mockStateRef.value = 'disconnected'
})

afterEach(() => {
  // 复位 use-connection 模块级单例态（initialised/listeners/lastConnectedUrl），用例互不污染
  useConnection().teardown()
})

describe('连接发现收敛：三形态分支选择（topology §2.4 / D4）', () => {
  it('TC-M1: mock 分支优先于 ipc 存在性（electron mock 构建形态：ipc 有值 + isMock）→ mock:// 且零 IPC 端口发现', async () => {
    const { ports, ipc } = makePorts({ isMock: true })
    await initFresh(ports)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('mock://localhost', { auth: 'skip' })
    // mock 分支不做快照拉取、不注册 runtime 事件监听（现状行为）
    expect(ipc?.getRuntimeTargetSnapshot).not.toHaveBeenCalled()
    expect(ipc?.onRuntimePort).not.toHaveBeenCalled()
    // HMR 重复 init 亦不发起本地重连（现状行为）
    await useConnection().init()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('TC-M2: ipc 无值 + isMock → 同样 mock://（ipc 存在性不改变 mock 行为）', async () => {
    const { ports, ipc } = makePorts({ isMock: true, withIpc: false })
    await initFresh(ports)
    expect(connect).toHaveBeenCalledWith('mock://localhost', { auth: 'skip' })
    expect(ipc).toBeNull()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('TC-M3: 本地分支（ipc 有值 + 非 mock）→ 快照路径 connect ws://localhost:4000 + 快照 token', async () => {
    const snapshot = { seq: 1, runtimeId: 'rt-1', port: 4000, token: 'tok-1' }
    const { ports, ipc } = makePorts({ snapshot })
    await initFresh(ports)
    // 本地分支完整装配：快照拉取 + runtime 事件监听注册（连接目标 = 快照单一权威源）
    expect(ipc?.getRuntimeTargetSnapshot).toHaveBeenCalledTimes(1)
    expect(ipc?.onRuntimePort).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('ws://localhost:4000', { auth: 'token', token: 'tok-1' })
  })

  it('TC-M4: 本地分支快照 null（runtime 未启动）→ 不发起连接、置 waiting-runtime（§6.2 权威目标确认前不连接）', async () => {
    const { ports } = makePorts({ snapshot: null })
    await initFresh(ports)
    expect(connect).not.toHaveBeenCalled()
    expect(setWaitingRuntime).toHaveBeenCalledTimes(1)
  })

  it('TC-M5: 本地分支快照拉取抛错 → 同样落等待态（不猜连、不抛出）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ports, ipc } = makePorts({ snapshot: null })
    vi.mocked(ipc!.getRuntimeTargetSnapshot).mockRejectedValueOnce(new Error('ipc gone'))
    await initFresh(ports)
    expect(connect).not.toHaveBeenCalled()
    expect(setWaitingRuntime).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('TC-M7: 本地分支 HMR 重连（重复 init）→ 重拉快照连接（快照即目标，非猜连公式）', async () => {
    const snapshot = { seq: 1, runtimeId: 'rt-1', port: 4000, token: 'tok-4' }
    const { ports } = makePorts({ snapshot })
    setConnectionPorts(ports)
    const conn = useConnection()
    await conn.init()
    expect(connect).toHaveBeenCalledWith('ws://localhost:4000', { auth: 'token', token: 'tok-4' })
    vi.mocked(connect).mockClear()
    // initialised=true → HMR 路径：重拉快照（此时已 connected → 幂等不动作）
    mockStateRef.value = 'connected'
    await conn.init()
    expect(connect).not.toHaveBeenCalled()
    // 断连后 HMR → 重拉快照连向快照目标
    mockStateRef.value = 'disconnected'
    await conn.init()
    expect(connect).toHaveBeenLastCalledWith('ws://localhost:4000', { auth: 'token', token: 'tok-4' })
  })
})

describe('远程 profile 分支（U0.2 骨架，U1.3 移动壳消费点）', () => {
  it('TC-M8: ipc 无值 + 非 mock + profile 注入 → resolve 一次 + connect(profile.url, token 凭据对象)', async () => {
    const { ports, profile } = makePorts({
      withIpc: false,
      withProfile: true,
      profileUrl: 'ws://192.168.1.5:3210',
      profileToken: 'remote-token',
    })
    await initFresh(ports)
    expect(profile?.resolve).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('ws://192.168.1.5:3210', { auth: 'token', token: 'remote-token' })
  })

  it('TC-M9: profile resolve 无 token → connect(url, {auth:"token", token:""})（空串强制走 auth 握手，D8 恢复链可达）', async () => {
    // 无凭据 ≠ skip：skip 会在握手缺失下假 connected，runtime fail-closed 拒绝永远不可达
    // （U1.3 事故形态）；空串 token 走强制握手探测，runtime 回 bad_token → onAuthRejected 恢复回路。
    const { ports, profile } = makePorts({ withIpc: false, withProfile: true, profileToken: null })
    await initFresh(ports)
    expect(profile?.resolve).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('ws://192.168.1.5:3210', { auth: 'token', token: '' })
  })

  it('TC-M10: profile 未注入 → init 显式失败（含恢复指引）且不发起任何连接', async () => {
    const { ports } = makePorts({ withIpc: false })
    setConnectionPorts(ports)
    await expect(useConnection().init()).rejects.toThrow(
      /no connectionProfile injected[\s\S]*setConnectionPorts/,
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it('TC-M11: 远程 HMR 重连（重复 init）→ 再次经 profile 解析（骨架语义：重连同走收敛点）', async () => {
    const { ports, profile } = makePorts({ withIpc: false, withProfile: true })
    setConnectionPorts(ports)
    const conn = useConnection()
    await conn.init()
    await conn.init()
    expect(profile?.resolve).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledTimes(2)
  })
})
