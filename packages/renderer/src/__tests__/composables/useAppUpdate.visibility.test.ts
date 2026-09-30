/**
 * useAppUpdate 可见性守卫单测（perf W05 Q1-6 + 补查时间阈值化）。
 *
 * 覆盖（fake timers + document.hidden mock）：
 * - hidden 期间周期定时器照常触发，但不联网检测（checkForUpdate 零调用，连 hidden 多周期均不发）
 * - 恢复可见（visibilitychange → visible）：距上次联网检查 ≥30min 时立即补查
 *   （force=false 走缓存），不等下一个 60min 周期
 * - 补查后周期检测继续（runAutoCheck 重排下一次定时器）
 * - 状态守卫优先于 visibility 补查：升级流程态（downloaded）恢复可见不补查
 * - onScopeDispose：scope 卸载后 visibilitychange 不再触发检测
 * - 补查 await 窗口 dispose：runAutoCheck await 恢复后不排新周期 timer（W05 review）
 *
 * Mock 策略：族级共享 harness（../helpers/app-update-mount.ts）——ipc 七键默认值 +
 * fake timers/epoch 起点 + 可见态重置 + markdown 桩 '<h2>notes</h2>'；hidden 态经
 * setHidden spy、事件经 fireVisibilityChange 派发。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.visibility.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
// app-update-markdown-stub 必须先于 app-update-mount import（后者加载 SUT 时 mock 工厂立即执行）
import { markdownStubModule } from '../helpers/app-update-markdown-stub'
import {
  ipc,
  setHidden,
  makeCheckHang,
  reinitAutoCheckInActiveScope,
  setupAppUpdate,
  setupAppUpdateLifecycle,
  startAutoCheckChain,
  type AppUpdateControllerInternal,
} from '../helpers/app-update-mount'

vi.mock('@/composables/logic/markdown', () => markdownStubModule())

setupAppUpdateLifecycle({
  fakeTimers: true,
  primeIpc: true,
  stubAppVersion: true,
  markdownHtml: '<h2>notes</h2>',
  resetVisibility: true,
})

/** 模拟浏览器可见性变化事件 */
function fireVisibilityChange(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

/** hidden 启动装置：hidden 态挂 auto-check 链并推进过 30s 首查（hidden 守卫跳过联网，lastNetworkCheckAt 保持 0） */
async function startHiddenAndSkipFirst(): Promise<{ result: AppUpdateControllerInternal; stop: () => void }> {
  setHidden(true)
  const handle = await startAutoCheckChain()
  await vi.advanceTimersByTimeAsync(30_000)
  return handle
}

describe('useAppUpdate 可见性守卫（Q1-6）', () => {
  it('hidden 期间周期触发不联网检测：30s 首次 + 60min 周期均跳过 checkForUpdate', async () => {
    const { stop } = await startHiddenAndSkipFirst()
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    // 连 hidden 多个 60min 周期均不发联网请求
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()
    stop()
  })

  it('恢复可见立即补查（force=false 走缓存），不等下一个 60min 周期', async () => {
    const { stop } = await startHiddenAndSkipFirst()
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange()
    // 补查同步发起，立即断言可见（距上次联网 = ∞ ≥ 30min 阈值）
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(ipc.checkForUpdate).toHaveBeenLastCalledWith({ force: false })
    stop()
  })

  it('补查后周期检测继续（下一个 60min 周期正常触发）', async () => {
    const { stop } = await startHiddenAndSkipFirst()
    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    // 补查的 runAutoCheck 重排了周期定时器：60min 后再次检测
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2)
    stop()
  })

  it('补查阈值：距上次联网检查 30min 内的恢复可见不补查（不重复联网）', async () => {
    // hidden 30s 首查跳过 → 恢复可见补查#1（lastNetworkCheckAt = t+30s）
    const { stop } = await startHiddenAndSkipFirst()
    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    // 多消费者再次 initAutoCheck（幂等重排）：清补查#1 的 60min 周期 timer，重排 30s 首查
    reinitAutoCheckInActiveScope()
    setHidden(true)
    await vi.advanceTimersByTimeAsync(30_000) // t+60s：hidden 触发 → 仍未联网
    setHidden(false)
    fireVisibilityChange() // 距补查#1 仅 30s < 30min 阈值 → 不补查，不联网

    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)
    stop()
  })

  it('距上次联网 ≥30min 的恢复可见补查：提前于 60min 周期拉起检查（时间阈值自愈通路）', async () => {
    const { stop } = await startAutoCheckChain()

    // 可见期间正常 30s 首查联网（lastNetworkCheckAt = t+30s）
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    // 推进 31min：距上次联网已超 30min 阈值，但 60min 周期 timer 还未到（剩 ~29min）
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1) // 周期未到，无新联网

    // 失焦又恢复 → 距上次联网 31min ≥ 30min → 补查（不等 60min 周期）
    setHidden(true)
    fireVisibilityChange()
    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2)
    expect(ipc.checkForUpdate).toHaveBeenLastCalledWith({ force: false })
    stop()
  })

  it('距上次联网 <30min 的恢复可见不补查（正常周期内的 visibilitychange 是 no-op）', async () => {
    const { stop } = await startAutoCheckChain()

    // 可见期间正常 30s 首次检测（lastNetworkCheckAt = t+30s）
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    // 失焦又恢复（距上次联网仅数秒 < 30min 阈值）
    setHidden(true)
    fireVisibilityChange()
    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1) // 不补查
    stop()
  })

  it('状态守卫优先：downloaded 态恢复可见不补查（升级流程不被打断）', async () => {
    setHidden(true)
    const { result, stop } = setupAppUpdate({ initAutoCheck: true })
    // 置为升级流程态：canAutoCheck=false，visibility 补查不发起
    result.state.state = 'downloaded'

    await vi.advanceTimersByTimeAsync(30_000)
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).not.toHaveBeenCalled() // 不补查（升级流程不被打断）
    stop()
  })

  it('onScopeDispose 卸载 listener：dispose 后 visibilitychange 不再触发检测', async () => {
    const { stop } = await startHiddenAndSkipFirst()
    stop() // 触发 onScopeDispose → 清 timer + 移除 listener

    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()
  })

  it('补查 await 期间 dispose：await 恢复后不排新周期 timer（卸载后 60min 内不联网，W05 review）', async () => {
    // 让 checkForUpdate 挂起，制造 runAutoCheck 的 await 窗口（此窗口无 pending timer）
    const resolveCheck = makeCheckHang()

    const { stop } = await startHiddenAndSkipFirst()
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange() // 补查发起：runAutoCheck 进入 await checkForUpdate（挂起中）
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    stop() // await 挂起期间 dispose（clearAutoCheckTimer 无 pending timer 可清）
    resolveCheck({ info: null, rateLimited: false }) // await 恢复：disposed 已置位 → 不排下一周期 timer
    await vi.advanceTimersByTimeAsync(0) // flush microtasks

    // 无新周期 timer 排上：推进 20min 不再联网
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1) // 仍只有补查那一次
  })
})
