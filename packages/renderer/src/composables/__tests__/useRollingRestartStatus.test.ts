/**
 * useRollingRestartStatus 单元测试（crash-forensics-and-watchdog §3.3 D5 / D3，u7d + 偏差 #27）。
 *
 * 覆盖（验收 A1/A2 + B1 renderer 半腿）：
 * - 事件加速显示：deferred / countdown / forced 三广播分别驱动对应相位（sawRollingActive 置位）。
 * - #27 reattach:deferred：active=true → reattach-deferred 轻态；active=false → 清自身态
 *   且不触碰滚动重启态；缓解帧在 recovered 态不落井下石。
 * - 拉取恢复（A2 前半）：挂载即拉 + 断连重连（connected 转变）再拉，拉到 deferred 恢复横幅。
 * - 终态分叉（A2 后半）：出现过活跃态 → 重连拉到 idle 转绿 30s 自动清除；全新窗口
 *   （无活跃态历史）拉到 idle → 恒 idle 不重现。
 * - refCount：多消费者单条物理订阅（拉取只发一次 RPC）；最后一个卸载后退订。
 * - 拉取失败（transport 不可用 reject）：状态保持、不抛出。
 *
 * 驱动方式：dispatchGlobal（core events 层）喂广播帧；command / getState 以 vi.mock
 * 注入替身（renderer 测试无真实 WS；importOriginal 保留 events 真实现供 dispatchGlobal）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/__tests__/useRollingRestartStatus.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { dispatchGlobal } from '@taiji/core/transport/api'
import type {
  ReattachDeferredPayload,
  RollingRestartCountdownPayload,
  RollingRestartDeferredPayload,
  RollingRestartForcedPayload,
  RollingRestartStatusPayload,
  ServerMessage,
} from '@taiji/shared'
import {
  RECOVERED_AUTO_CLEAR_MS,
  useRollingRestartStatus,
  _resetRollingRestartStatusForTest,
} from '../useRollingRestartStatus'

// 连接态替身：真 Vue ref 经 mock 工厂内创建并挂到 hoisted holder（工厂惰性执行先于测试体；
// 必须是真 ref——composable 的 watch getter 读 .value 需要响应式依赖才会在重连时触发）
const conn = vi.hoisted(() => ({ stateRef: null as null | { value: string } }))

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: vi.fn() }
})

vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref } = await import('vue')
  conn.stateRef = ref('connected')
  return { ...actual, getState: () => conn.stateRef! }
})

// mock 工厂就位后取 command 替身（类型层是真实签名，运行时是 vi.fn）
const commandMock = vi.mocked(await import('@taiji/core/transport/api').then((m) => m.command))

/** 构造 rollingRestart 域广播帧。 */
function msg<T extends ServerMessage['type']>(type: T, payload: unknown): ServerMessage<T> {
  return { type, payload } as ServerMessage<T>
}

const deferredPayload: RollingRestartDeferredPayload = {
  reason: 'inflight',
  inflight: { inFlight: 2 },
  deferDeadlineAt: 1_700_000_100_000,
}
const countdownPayload: RollingRestartCountdownPayload = { executesAt: 1_700_000_060_000, inflight: { inFlight: 0 } }
const forcedPayload: RollingRestartForcedPayload = { reason: 'hard-threshold', inflight: { inFlight: 1 } }
const reattachPayload = (active: boolean): ReattachDeferredPayload => ({ active, reason: 'high-memory', pollMs: 30_000 })

function statusPayload(state: RollingRestartStatusPayload['state']): RollingRestartStatusPayload {
  return { state, inflight: { inFlight: state === 'idle' ? null : 0 } }
}

describe('useRollingRestartStatus（u7d 四态 + #27 轻态）', () => {
  beforeEach(() => {
    _resetRollingRestartStatusForTest()
    conn.stateRef!.value = 'connected'
    commandMock.mockReset()
    commandMock.mockResolvedValue(statusPayload('idle'))
  })

  afterEach(() => {
    _resetRollingRestartStatusForTest()
    vi.useRealTimers()
  })

  it('挂载即拉取：初始订阅发一次 rollingRestart.status（刷新后恢复语义）', async () => {
    commandMock.mockResolvedValue(statusPayload('deferred'))
    const scope = effectScope()
    scope.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('rollingRestart.status', {}, expect.any(Number))
    scope.stop()
  })

  it('事件加速显示：deferred 广播 → deferred 相位（reason/inflight/deadline 透传）', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(msg('rollingRestart:deferred', deferredPayload))
    expect(state?.phase.value).toEqual({
      kind: 'deferred', reason: 'inflight', inflight: 2, deferDeadlineAt: 1_700_000_100_000,
    })
    scope.stop()
  })

  it('事件加速显示：countdown 广播 → countdown 相位（executesAt 透传）；forced → 红牌 rolling', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(msg('rollingRestart:countdown', countdownPayload))
    expect(state?.phase.value).toEqual({ kind: 'countdown', executesAt: 1_700_000_060_000, inflight: 0 })
    dispatchGlobal(msg('rollingRestart:forced', forcedPayload))
    expect(state?.phase.value).toEqual({ kind: 'rolling', reason: 'hard-threshold', inflight: 1 })
    scope.stop()
  })

  it('#27：reattach:deferred active=true → 轻态；active=false 清自身态；不触碰滚动重启态', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(msg('reattach:deferred', reattachPayload(true)))
    expect(state?.phase.value).toEqual({ kind: 'reattach-deferred', pollMs: 30_000 })
    dispatchGlobal(msg('reattach:deferred', reattachPayload(false)))
    expect(state?.phase.value).toEqual({ kind: 'idle' })
    // 滚动重启态不被缓解帧触碰
    dispatchGlobal(msg('rollingRestart:deferred', deferredPayload))
    dispatchGlobal(msg('reattach:deferred', reattachPayload(false)))
    expect(state?.phase.value?.kind).toBe('deferred')
    scope.stop()
  })

  it('#27：缓解帧到达时若处于滚动重启活跃/recovered 态则保持原态不落井下石', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(msg('rollingRestart:forced', forcedPayload))
    dispatchGlobal(msg('reattach:deferred', reattachPayload(false)))
    expect(state?.phase.value?.kind).toBe('rolling')
    scope.stop()
  })

  it('A2 断连重连拉取：拉到 deferred → 横幅恢复（持续态经 RPC 重建）', async () => {
    commandMock.mockResolvedValue(statusPayload('idle'))
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(state?.phase.value.kind).toBe('idle')

    conn.stateRef!.value = 'disconnected'
    await flushPromises()
    commandMock.mockResolvedValue(statusPayload('deferred'))
    conn.stateRef!.value = 'connected' // 断连 → 重连转变触发拉取
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(2)
    expect(state?.phase.value).toEqual({
      kind: 'deferred', reason: 'inflight', inflight: 0, deferDeadlineAt: 0,
    })
    scope.stop()
  })

  it('A2 终态分叉·转绿：出现过活跃态 → 重连拉到 idle 转绿 30s 自动清除', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(msg('rollingRestart:deferred', deferredPayload))
    expect(state?.phase.value.kind).toBe('deferred')

    commandMock.mockResolvedValue(statusPayload('idle'))
    conn.stateRef!.value = 'restarting'
    await flushPromises()
    conn.stateRef!.value = 'connected'
    await flushPromises()
    expect(state?.phase.value.kind).toBe('recovered')

    await vi.advanceTimersByTimeAsync(RECOVERED_AUTO_CLEAR_MS)
    expect(state?.phase.value.kind).toBe('idle')
    scope.stop()
  })

  it('A2 终态分叉·不重现：全新窗口（无活跃态历史）重连拉到 idle → 恒 idle', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(state?.phase.value.kind).toBe('idle')
    conn.stateRef!.value = 'disconnected'
    await flushPromises()
    conn.stateRef!.value = 'connected'
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(2)
    expect(state?.phase.value.kind).toBe('idle') // 无历史不转绿、不重现
    scope.stop()
  })

  it('refCount：两消费者共享单条物理订阅（初始拉取只发一次 RPC）', async () => {
    const scopeA = effectScope()
    scopeA.run(() => useRollingRestartStatus())
    const scopeB = effectScope()
    scopeB.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(1)
    scopeA.stop()
    scopeB.stop()
    // 全部卸载后重挂 → 重新订阅 + 重新拉取
    commandMock.mockResolvedValue(statusPayload('deferred'))
    const scopeC = effectScope()
    scopeC.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(2)
    scopeC.stop()
  })

  it('拉取失败（transport 不可用 reject）→ 状态保持 idle、不向上抛', async () => {
    commandMock.mockRejectedValue(new Error('transport unavailable'))
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await expect(flushPromises()).resolves.not.toThrow()
    expect(state?.phase.value.kind).toBe('idle')
    scope.stop()
  })

  it('dismiss：手动关闭 → idle（recovered 定时器一并清理，不再复发）', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(msg('rollingRestart:deferred', deferredPayload))
    state?.dismiss()
    expect(state?.phase.value.kind).toBe('idle')
    await vi.advanceTimersByTimeAsync(RECOVERED_AUTO_CLEAR_MS)
    expect(state?.phase.value.kind).toBe('idle')
    scope.stop()
  })
})
