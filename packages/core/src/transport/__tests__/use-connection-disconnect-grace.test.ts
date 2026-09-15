/**
 * 断连宽限兜底（review findings-confirmation-report #1.2：纯网络断连零复位缺口）。
 *
 * 锁定行为：网络断连（ws onclose → disconnected/reconnecting）与 IPC 崩溃
 * （restarting/failed）在 stateWatch 单一汇合点触发清理：
 * - 网络断连：pending.rejectAll 立即；在途流收口（onRuntimeUnavailable）**延迟**到
 *   DISCONNECT_GRACE_MS 到期且仍未 connected（宽限期内重连成功则由 ring 回放 /
 *   live 事件驱动正常收口，不误伤在途流——立即收口会被 sealed 守卫不可逆 error 化）。
 * - IPC 崩溃：立即收口（进程没了流物理不可能恢复），且清掉已 armed 的宽限 timer。
 *
 * fake timers 覆盖超时兜底分支（timer 测试纪律）。
 *
 * 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-disconnect-grace.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import type { ConnectionState } from '../ws-client'
import { useConnection, setConnectionPorts, DISCONNECT_GRACE_MS, type ConnectionPorts } from '../use-connection'

// ── ws-client mock：state ref 直驱（模拟 onclose / setRestarting / setFailed 置态）──
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
vi.mock('../ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  setRestarting: () => {
    mockStateRef.value = 'restarting'
  },
  setFailed: () => {
    mockStateRef.value = 'failed'
  },
  onMessage: vi.fn(() => () => {}),
  onQueueDrop: vi.fn(() => () => {}),
}))

let restartingCb: (() => void) | null = null
const mockRejectAll = vi.fn()
const mockRuntimeCleanup = vi.fn()
const mockT = vi.fn((key: string) => `[${key}]`)

// pending 模块 mock（D3 后 use-connection 的 rejectAll 直连 transport/api/pending，
// 不再经 ConnectionPorts 注入——mock 须拦截模块本身；闭包转发 mockRejectAll，
// 工厂执行早于 const 初始化，惰性解引用避开 TDZ）
vi.mock('../api/pending', () => ({
  rejectAll: (...args: unknown[]) => mockRejectAll(...args),
  resolve: vi.fn(),
  reject: vi.fn(),
  has: vi.fn(),
  resolveEnvelope: vi.fn(),
}))

function makePorts(): ConnectionPorts {
  return {
    ipc: {
      getRuntimePort: vi.fn().mockResolvedValue(undefined),
      getRuntimePortOffset: vi.fn().mockResolvedValue(undefined),
      getRuntimeToken: vi.fn().mockResolvedValue('tok'),
      onRuntimePort: () => () => {},
      onRuntimeRestarting: (cb: () => void) => {
        restartingCb = cb
        return () => {
          restartingCb = null
        }
      },
      onRuntimeFailed: () => () => {},
      restartRuntime: vi.fn().mockResolvedValue(undefined),
    },
    visibility: {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
    env: { isMock: false, isDev: false },
    effects: {},
    t: mockT,
    onRuntimeUnavailable: mockRuntimeCleanup,
  }
}

/** init + 连上（connected），返回句柄。每个用例的断言基线。 */
async function setupConnected() {
  const handle = useConnection()
  await handle.init()
  mockStateRef.value = 'connected'
  await nextTick()
  return handle
}

describe('断连宽限兜底：网络断连 vs IPC 崩溃单一汇合', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
    restartingCb = null
    setConnectionPorts(makePorts())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('网络断连（connected→reconnecting）→ rejectAll 立即；宽限期内不收口，到期仍断连 → onRuntimeUnavailable("disconnect")', async () => {
    const { teardown } = await setupConnected()

    // 模拟 ws onclose（同一 tick 内 disconnected → reconnecting，watch 收到最终值）
    mockStateRef.value = 'disconnected'
    mockStateRef.value = 'reconnecting'
    await nextTick()
    expect(mockRejectAll).toHaveBeenCalledTimes(1)
    // 宽限期内（9.9s）：不收口（等重连 + ring 回放）
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 100)
    expect(mockRuntimeCleanup).not.toHaveBeenCalled()
    // 到期仍断连 → 收口（streaming 态复位不挂 10min streaming timer）
    vi.advanceTimersByTime(100)
    expect(mockRuntimeCleanup).toHaveBeenCalledTimes(1)
    expect(mockRuntimeCleanup).toHaveBeenCalledWith('disconnect')
    teardown()
  })

  it('宽限期内重连成功 → 到期不收口（ring 回放 / live 事件接管终态，不误伤在途流）', async () => {
    const { teardown } = await setupConnected()

    mockStateRef.value = 'reconnecting'
    await nextTick()
    // 半程重连成功（connected 迁移触发 resubscribeAll，宽限 timer 保留到期自检）
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS / 2)
    mockStateRef.value = 'connected'
    await nextTick()
    // 越过到期时刻：已 connected → 不收口
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS)
    expect(mockRuntimeCleanup).not.toHaveBeenCalled()
    teardown()
  })

  it('断连→恢复→再断连 flapping：宽限从首次断连起算单窗口，累计到期限未恢复 → 收口一次', async () => {
    const { teardown } = await setupConnected()

    mockStateRef.value = 'reconnecting'
    await nextTick()
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS / 2)
    mockStateRef.value = 'connected'
    await nextTick()
    // 再断连（grace 已 armed 不重置）
    mockStateRef.value = 'reconnecting'
    await nextTick()
    expect(mockRuntimeCleanup).not.toHaveBeenCalled()
    // 首次断连起算满宽限 → 收口
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS / 2 + 100)
    expect(mockRuntimeCleanup).toHaveBeenCalledTimes(1)
    expect(mockRuntimeCleanup).toHaveBeenCalledWith('disconnect')
    teardown()
  })

  it('IPC 崩溃（restarting）→ 立即收口不走宽限，且清掉已 armed 的宽限 timer（到期不二次触发）', async () => {
    const { teardown } = await setupConnected()

    // 先网络断连（arm 宽限），随后 runtime 崩溃（restarting 置态）
    mockStateRef.value = 'reconnecting'
    await nextTick()
    expect(mockRuntimeCleanup).not.toHaveBeenCalled()
    restartingCb!() // setRestarting → state=restarting
    await nextTick()
    // 立即收口（pi 死了流物理不可能恢复，无宽限）
    expect(mockRuntimeCleanup).toHaveBeenCalledTimes(1)
    expect(mockRuntimeCleanup).toHaveBeenCalledWith('restart')
    // 宽限 timer 已被清：推进到期时刻无二次触发
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 2)
    expect(mockRuntimeCleanup).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('重连用尽（connected→failed，scheduleReconnect 超限置 failed）→ 立即收口（failed 分支不要求宽限）', async () => {
    const { teardown } = await setupConnected()

    mockStateRef.value = 'failed'
    await nextTick()
    expect(mockRuntimeCleanup).toHaveBeenCalledTimes(1)
    expect(mockRuntimeCleanup).toHaveBeenCalledWith('disconnect')
    teardown()
  })
})
