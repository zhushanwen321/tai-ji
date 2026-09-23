/**
 * use-connection 可见性切换回归测试（W4，自 renderer __tests__/useConnection-visibility.test.ts 迁入）。
 *
 * 锁定 W4 改动：当用户从其它标签页 / 系统切回应用（visibilityState 变为 'visible'）
 * 且当前 WS 未连接时，useConnection 应主动调用 connect() 尝试重连，而不是干等
 * ws-client 的指数退避（最长 30s）—— 用户回来后还想看对话进展。
 *
 * 迁移改造（§10.2 D-1）：DOM 操作（document.visibilityState / addEventListener）已迁入
 * renderer 装配点的 visibility 端口实现；core 测试直接注入可控的 visibility 端口
 * （isVisible 变量 + 捕获 onVisibilityChange 的 handler），断言语义不变。
 *
 * R2 error envelope 套件：dispatcher 经 mocked onMessage 捕获（原 renderer 版经
 * transport.on 捕获），pending 分流断言不变。
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-visibility.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'

// ── ws-client mock：捕获 connect 调用 + 可控 state ref + 捕获 dispatcher ──
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
// 默认 disconnected；每个测试可改 mockStateRef.value 模拟当前连接态
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
/** 捕获 onMessage 注册的 routeInbound dispatcher（原 renderer 版经 transport.on） */
let inboundHandler: ((msg: ServerMessage) => void) | null = null
vi.mock('../ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
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
}))

// ── 端口 mock ────────────────────────────────────────────────────
// ipc：全部返回空（init 会调 getRuntimePort 等）
const mockRejectAll = vi.fn()
const mockPendingResolve = vi.fn()
const mockPendingReject = vi.fn()
const mockDispatchSession = vi.fn()
const mockDispatchGlobal = vi.fn()
const mockEffects = vi.fn()
const mockRuntimeCleanup = vi.fn()
const mockT = vi.fn((key: string) => `[${key}]`)

// ── 三件套模块 mock（D3 后 dispatcher 缺省直连 transport/api 真实模块，不再经
// ConnectionPorts 注入——mock 须拦截模块本身；工厂闭包惰性转发上述 const，避开 TDZ）──
vi.mock('../api/pending', () => ({
  rejectAll: (...args: unknown[]) => mockRejectAll(...args),
  resolve: (...args: unknown[]) => mockPendingResolve(...args),
  reject: (...args: unknown[]) => mockPendingReject(...args),
  // routeInbound 用 has 判定 msg.id 是否命中 pending；测试模拟的带 id error reply 均为 reply
  has: vi.fn().mockReturnValue(true),
  // 模拟 transport/api/pending.resolveEnvelope 行为（收尾 6 R2/ES1）：route-inbound 委托
  // envelope 展开到 pending 层（code 提取 + details.detail → Error），此处转发到 reject/resolve。
  // 真实实现单测在 transport/api/__tests__/pending.test.ts。
  resolveEnvelope: (msg: ServerMessage) => {
    if (msg.type === 'error') {
      const payload = msg.payload as { code?: string; message?: string; details?: { detail?: unknown } }
      const message = typeof payload.message === 'string' ? payload.message : 'request failed'
      const code = typeof payload.code === 'string' ? payload.code : 'unknown'
      const enriched: Record<string, unknown> = { code }
      const d = payload.details?.detail
      if (typeof d === 'string') {
        enriched.cwd = d
      } else if (d && typeof d === 'object') {
        Object.assign(enriched, d)
      }
      mockPendingReject(msg.id!, Object.assign(new Error(message), enriched))
    } else {
      mockPendingResolve(msg.id!, msg.payload)
    }
  },
}))

vi.mock('../api/events', () => ({
  dispatchSession: (...args: unknown[]) => mockDispatchSession(...args),
  dispatchGlobal: (...args: unknown[]) => mockDispatchGlobal(...args),
  dispatchCrossSession: vi.fn(),
}))

vi.mock('../api/domains/session', () => ({
  subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
}))

// visibility 端口可控变量
let visVisible = false
let visHandler: (() => void) | null = null

function makePorts(): ConnectionPorts {
  return {
    ipc: {
      getRuntimePort: vi.fn().mockResolvedValue(undefined),
      getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
getRuntimeToken: vi.fn(async () => null),
      onRuntimePort: vi.fn().mockReturnValue(() => {}),
      onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
      onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
      // RD-3#2：启动失败真因消费端口（推送置 failed 短路徒劳重连 + init 拉取兜底）
      onRuntimeError: () => () => {},
      getRuntimeStartError: async () => null,
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => visVisible,
      onVisibilityChange: (h: () => void) => {
        visHandler = h
        return () => {
          visHandler = null
        }
      },
    },
    env: { isMock: true, isDev: false },
    effects: {
      onSessionExited: mockEffects,
      onMessageComplete: mockEffects,
      onSubagents: mockEffects,
      onWorkflowUpdate: mockEffects,
      onGlobalError: mockEffects,
    },
    t: mockT,
    onRuntimeUnavailable: mockRuntimeCleanup,
  }
}

describe('useConnection 可见性切换主动重连（W4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
    visVisible = false
    visHandler = null
    setConnectionPorts(makePorts())
  })

  it('切回应用（visible）且未连接时 → connect 被调用', async () => {
    const { init, teardown } = useConnection()
    await init()

    // 当前处于 disconnected（模拟标签页后台时连接掉了）
    mockStateRef.value = 'disconnected'
    mockConnect.mockClear()

    // W4：init 应已注册 visibilitychange 监听（端口捕获 handler）。模拟切回前台。
    visVisible = true
    expect(visHandler).not.toBeNull()
    visHandler!()

    // 关键断言：切回可见 + 未连接 → 主动重连
    expect(mockConnect).toHaveBeenCalled()

    teardown()
  })

  it('切回应用（visible）但已 connected 时 → connect 不被调用', async () => {
    const { init, teardown } = useConnection()
    await init()

    // 当前已连接（不需要重连）
    mockStateRef.value = 'connected'
    mockConnect.mockClear()

    visVisible = true
    visHandler!()

    // 关键断言：已连接就不重连（这条测守卫正确性）
    expect(mockConnect).not.toHaveBeenCalled()

    teardown()
  })

  it('切到后台（hidden）时 → 不触发重连（只有切回 visible 才重连）', async () => {
    const { init, teardown } = useConnection()
    await init()

    mockStateRef.value = 'disconnected'
    mockConnect.mockClear()

    visVisible = false
    visHandler!()

    // 关键断言：切后台不应触发重连（避免无谓连接触发）
    expect(mockConnect).not.toHaveBeenCalled()

    teardown()
  })
})

describe('useConnection error envelope details 透传（R2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStateRef = ref('connected')
    inboundHandler = null
    setConnectionPorts(makePorts())
  })

  it('error envelope details.detail 为对象 → exitCode/stderr 展开到 reject Error', async () => {
    const { init, teardown } = useConnection()
    await init()
    expect(inboundHandler).not.toBeNull()

    // 模拟 runtime worktree handler 发来的 error envelope：
    // code=SETUP_FAILED, message, details.detail={ exitCode, stderr }
    inboundHandler!({
      type: 'error',
      id: 'req-1',
      payload: {
        code: 'SETUP_FAILED',
        message: 'setup 脚本失败',
        details: { detail: { exitCode: 2, stderr: 'npm install failed' } },
      },
    })

    expect(mockPendingReject).toHaveBeenCalledTimes(1)
    const [rejectedId, err] = mockPendingReject.mock.calls[0]!
    expect(rejectedId).toBe('req-1')
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('setup 脚本失败')
    // code + 展开的 exitCode/stderr 都在 Error 上
    expect((err as { code: string }).code).toBe('SETUP_FAILED')
    expect((err as { exitCode: number }).exitCode).toBe(2)
    expect((err as { stderr: string }).stderr).toBe('npm install failed')

    teardown()
  })

  it('error envelope details.detail 为对象（WORKTREE_EXISTS 的 {cwd, dirName}）→ cwd 展开到 reject Error', async () => {
    const { init, teardown } = useConnection()
    await init()

    inboundHandler!({
      type: 'error',
      id: 'req-2',
      payload: {
        code: 'WORKTREE_EXISTS',
        message: 'worktree 目录已存在',
        details: { detail: { cwd: '/ws/feat-existing', dirName: 'feat-existing' } },
      },
    })

    expect(mockPendingReject).toHaveBeenCalledTimes(1)
    const [, err] = mockPendingReject.mock.calls[0]!
    expect((err as { code: string }).code).toBe('WORKTREE_EXISTS')
    // object detail 经 Object.assign 展开 → cwd + dirName 都在 Error 上
    // CreateWorktreeModal exists 态「直接开始」读 lastError.cwd
    expect((err as { cwd: string }).cwd).toBe('/ws/feat-existing')
    expect((err as { dirName: string }).dirName).toBe('feat-existing')

    teardown()
  })

  it('error envelope 无 details → 只透传 code（保持向后兼容）', async () => {
    const { init, teardown } = useConnection()
    await init()

    inboundHandler!({
      type: 'error',
      id: 'req-3',
      payload: { code: 'out_of_cwd', message: 'cwd 不存在' },
    })

    expect(mockPendingReject).toHaveBeenCalledTimes(1)
    const [, err] = mockPendingReject.mock.calls[0]!
    expect((err as { code: string }).code).toBe('out_of_cwd')
    expect((err as Error).message).toBe('cwd 不存在')
    // 无 details.detail → 不附加 cwd/exitCode/stderr
    expect((err as { cwd?: string }).cwd).toBeUndefined()

    teardown()
  })
})
