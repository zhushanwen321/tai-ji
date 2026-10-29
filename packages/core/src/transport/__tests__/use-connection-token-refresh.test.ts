/**
 * 快照凭据连接编排测试（connection-datasync-ssot §6.2/§6.3；原 S1-W1 token 刷新编排的
 * 语义迁移版——token 随目标快照并置读取，不再单路拉取）。
 *
 * 锁定 use-connection 连接控制器的快照→连接编排半边：
 * - init 拉取快照非 null → connect(ws://localhost:<port>, {auth:'token', token: 快照 token})
 * - init 拉取快照 null / 抛错 → setWaitingRuntime（不发起连接，等推送）
 * - onRuntimePort 推更高 seq 快照 → disconnect + connect(新 url, 新 token)（断旧连新携新凭据）
 * - onRuntimePort 推同 seq 快照 → 不动作（幂等重播不拆连）
 *
 * 用例自包含：beforeEach 经 teardown() 复位 use-connection 的模块级单例装配（监听 /
 * initialised 幂等检查 / 连接簿记 / 期望快照），每条用例经 initConnection() 自己走首连
 * 装配路径——onRuntimePort 监听（snapshotCb）由本用例的 init 安装。init 装配自身的调用
 * 不计入分支断言：装配后 mockClear，断言基准 = 本用例驱动的行为。
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-token-refresh.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import type { RuntimeTargetSnapshot, ServerMessage } from '@taiji/shared'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import { connect, disconnect } from '../ws-client'

// ── ws-client mock：捕获 connect/disconnect 调用 + 可控连接状态 ref ──
const mockStateRef = ref<ConnectionState>('disconnected')
let inboundHandler: ((msg: ServerMessage) => void) | null = null
vi.mock('../ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  setWaitingRuntime: vi.fn(),
  onAuthAccepted: vi.fn(() => () => {}),
  onAuthRejected: vi.fn(() => () => {}),
  resetAuthRejectionSuppression: vi.fn(),
  isAuthRejectedSuppressed: vi.fn(() => false),
  onMessage: (cb: (msg: ServerMessage) => void) => {
    inboundHandler = cb
    return () => {
      inboundHandler = null
    }
  },
  onQueueDrop: vi.fn(() => () => {}),
}))

// ── 其余端口 mock（use-connection-reconnect-resubscribe.test.ts 同款）──

/** 被测 IPC 桩：快照拉取可编程返回值；onRuntimePort 回调被捕获供测试触发 */
const getRuntimeTargetSnapshot = vi.fn<() => Promise<RuntimeTargetSnapshot | null | undefined>>()
let snapshotCb: ((snapshot: RuntimeTargetSnapshot) => void) | null = null

function snap(seq: number, port: number, token: string, runtimeId = `rt-${seq}`): RuntimeTargetSnapshot {
  return { seq, runtimeId, port, token }
}

function makePorts(): ConnectionPorts {
  return {
    ipc: {
      getRuntimeTargetSnapshot,
      onRuntimePort: vi.fn((cb: (snapshot: RuntimeTargetSnapshot) => void) => {
        snapshotCb = cb
        return () => {
          snapshotCb = null
        }
      }),
      onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
      onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
      onRuntimeError: () => () => {},
      getRuntimeStartError: async () => null,
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
    env: { isMock: false, isDev: false },
    effects: {},
    t: vi.fn((key: string) => `[${key}]`),
    onRuntimeUnavailable: vi.fn(),
  }
}

beforeAll(() => {
  setConnectionPorts(makePorts())
})

beforeEach(() => {
  // 复位上一条用例遗留的单例装配（teardown 拆全部监听 + initialised=false + 清簿记与
  // 期望快照，使本用例的 init 走首连装配路径；teardown 会触发一次 mocked disconnect，
  // 故先复位再 clearAllMocks——断言计数不被上一条用例或复位动作污染）
  useConnection().teardown()
  vi.clearAllMocks()
  getRuntimeTargetSnapshot.mockReset()
  snapshotCb = null
})

/** 每条用例自含装配：init 走首连路径（teardown 已复位 initialised），onRuntimePort 监听由本用例安装 */
async function initConnection(): Promise<void> {
  await useConnection().init()
}

/** 等 fire-and-forget 的快照重拉完成（IPC mock resolve + connect 微任务） */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('快照凭据连接编排（connection-datasync-ssot §6.2）', () => {
  it('TC-S1: init 拉取快照非 null → connect(url, {auth:"token", token: 快照 token})', async () => {
    getRuntimeTargetSnapshot.mockResolvedValue(snap(1, 4000, 'token-1'))
    await initConnection()
    // dispatcher 已安装（init 副作用，不与快照编排耦合）
    expect(inboundHandler).not.toBeNull()
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4000', { auth: 'token', token: 'token-1' })
  })

  it('TC-S2: init 拉取快照 null → setWaitingRuntime（不发起连接，权威目标未确认不连接）', async () => {
    getRuntimeTargetSnapshot.mockResolvedValue(null)
    const { setWaitingRuntime } = await import('../ws-client')
    await initConnection()
    expect(vi.mocked(connect)).not.toHaveBeenCalled()
    expect(vi.mocked(setWaitingRuntime)).toHaveBeenCalledTimes(1)
    // 快照推送到达（拉取兜底 + 广播两路之一）→ 立即连接
    snapshotCb!(snap(1, 4000, 'token-push'))
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4000', { auth: 'token', token: 'token-push' })
  })

  it('TC-S3: 快照拉取抛错 → 同样落等待态（推送监听已装，广播到达即恢复）', async () => {
    getRuntimeTargetSnapshot.mockRejectedValue(new Error('ipc gone'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { setWaitingRuntime } = await import('../ws-client')
    await initConnection()
    // warn 分支可见（排查依据），不连接、不抛出
    expect(warnSpy).toHaveBeenCalled()
    expect(vi.mocked(connect)).not.toHaveBeenCalled()
    expect(vi.mocked(setWaitingRuntime)).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('TC-S4: onRuntimePort 推更高 seq 快照 → disconnect + connect(新 url, 新 token)（断旧连新携新凭据）', async () => {
    getRuntimeTargetSnapshot.mockResolvedValue(snap(1, 4000, 'token-1'))
    await initConnection()
    // 首连推进（期望未建立 → 任何快照都推进）也经 disconnect+connect 统一入口，计数基准清零
    vi.mocked(connect).mockClear()
    vi.mocked(disconnect).mockClear()
    // runtime 重启 = 新 spawn = seq+1 + 新 runtimeId + 新 token
    snapshotCb!(snap(2, 4500, 'token-2'))
    // 旧连接先断开（断旧连新），再以新快照凭据连接
    expect(vi.mocked(disconnect)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connect)).toHaveBeenCalledWith('ws://localhost:4500', { auth: 'token', token: 'token-2' })
  })

  it('TC-S5: onRuntimePort 推同 seq 快照（幂等重播）→ 不动作（不拆连）', async () => {
    getRuntimeTargetSnapshot.mockResolvedValue(snap(1, 4000, 'token-1'))
    await initConnection()
    vi.mocked(connect).mockClear()
    vi.mocked(disconnect).mockClear()
    snapshotCb!(snap(1, 4000, 'token-1'))
    expect(vi.mocked(disconnect)).not.toHaveBeenCalled()
    expect(vi.mocked(connect)).not.toHaveBeenCalled()
  })

  it('TC-S6: onRuntimePort 推更低 seq 快照（拉取响应晚于推送的旧代）→ 丢弃，不回退目标', async () => {
    getRuntimeTargetSnapshot.mockResolvedValue(snap(2, 4500, 'token-2'))
    await initConnection()
    vi.mocked(connect).mockClear()
    vi.mocked(disconnect).mockClear()
    snapshotCb!(snap(1, 4000, 'token-1'))
    expect(vi.mocked(disconnect)).not.toHaveBeenCalled()
    expect(vi.mocked(connect)).not.toHaveBeenCalled()
  })
})
