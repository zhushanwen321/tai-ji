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
 * Mock 策略（控制器化，对齐 useAppUpdate.test.ts）：createAppUpdateController({ ipc }) 注入
 * 内存 adapter，effectScope 包 controller.subscribeProgress / initAutoCheck。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.visibility.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { EffectScope } from 'vue'
import type { UpdateCheckResult } from '@taiji/shared'
import { createMemoryAppUpdateIpc, type MemoryAppUpdateIpc } from '../helpers/update-ipc-mock'
import {
  createAppUpdateController,
  type AppUpdateControllerInternal,
} from '@/composables/features/settings/useAppUpdate'

// markdown mock 留文件内：默认 html 属本文件行为面（非 IPC 桥）
const hoistedRenderMarkdown = vi.hoisted(() => vi.fn<(md: string) => Promise<string>>())
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: hoistedRenderMarkdown,
}))

/** mock document.hidden / visibilityState */
function setHidden(hidden: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
}

/** 模拟浏览器可见性变化事件 */
function fireVisibilityChange(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

/** 内存 ipc adapter + 绑定它的控制器（每 beforeEach 重建，用例间零残留） */
let ipc: MemoryAppUpdateIpc
let controller: AppUpdateControllerInternal
/** 兜底清理：用例中断未 stop 时，afterEach 统一触发 onScopeDispose 清理 */
let activeScope: EffectScope | null = null

/** 在 effectScope 内订阅控制器 + initAutoCheck（onScopeDispose 需活跃 scope） */
function setupWithAutoCheck(): { result: AppUpdateControllerInternal; stop: () => void } {
  const scope = effectScope()
  activeScope = scope
  scope.run(() => {
    controller.subscribeProgress()
    controller.initAutoCheck()
  })
  return { result: controller, stop: () => scope.stop() }
}

beforeEach(() => {
  ipc = createMemoryAppUpdateIpc()
  controller = createAppUpdateController({ ipc })
  vi.useFakeTimers()
  // fake 时钟起点设为真实 epoch 量级：lastNetworkCheckAt 初值 0 时，
  // 起点 0 会让「首查前的恢复可见补查」被时间比较误判（真实时钟不会）
  vi.setSystemTime(1_700_000_000_000)
  vi.stubGlobal('__APP_VERSION__', '0.0.0')
  setHidden(false)
  ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
  ipc.updateDownload.mockResolvedValue({ downloaded: true })
  ipc.updateInstall.mockResolvedValue({ triggerRestart: true })
  ipc.getPreloaded.mockResolvedValue(null)
  ipc.getPendingUpdate.mockResolvedValue(null)
  // initAutoCheck 读 autoUpdate 开关（visibility 用例默认 true，保持周期调度行为）
  ipc.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
  hoistedRenderMarkdown.mockReset().mockResolvedValue('<h2>notes</h2>')
})

afterEach(() => {
  // 先在 fake 时钟仍活跃时触发 onScopeDispose（clearTimeout 需配对 fake timer）
  activeScope?.stop()
  activeScope = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useAppUpdate 可见性守卫（Q1-6）', () => {
  it('hidden 期间周期触发不联网检测：30s 首次 + 60min 周期均跳过 checkForUpdate', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    // 30s 首次触发 → hidden 跳过
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    // 连 hidden 多个 60min 周期均不发联网请求
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()
    stop()
  })

  it('恢复可见立即补查（force=false 走缓存），不等下一个 60min 周期', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(30_000) // hidden 跳过（未联网，lastNetworkCheckAt 保持 0）
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange()
    // 补查同步发起，立即断言可见（距上次联网 = ∞ ≥ 30min 阈值）
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(ipc.checkForUpdate).toHaveBeenLastCalledWith({ force: false })
    stop()
  })

  it('补查后周期检测继续（下一个 60min 周期正常触发）', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(30_000)
    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    // 补查的 runAutoCheck 重排了周期定时器：60min 后再次检测
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2)
    stop()
  })

  it('补查阈值：距上次联网检查 30min 内的恢复可见不补查（不重复联网）', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    // hidden 30s 首查跳过 → 恢复可见补查#1（lastNetworkCheckAt = t+30s）
    await vi.advanceTimersByTimeAsync(30_000)
    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)

    // 多消费者再次 initAutoCheck（幂等重排）：清补查#1 的 60min 周期 timer，重排 30s 首查
    activeScope!.run(() => controller.initAutoCheck())
    setHidden(true)
    await vi.advanceTimersByTimeAsync(30_000) // t+60s：hidden 触发 → 仍未联网
    setHidden(false)
    fireVisibilityChange() // 距补查#1 仅 30s < 30min 阈值 → 不补查，不联网

    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)
    stop()
  })

  it('距上次联网 ≥30min 的恢复可见补查：提前于 60min 周期拉起检查（时间阈值自愈通路）', async () => {
    const { stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

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
    const { stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

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
    const { result, stop } = setupWithAutoCheck()
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
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(30_000)
    stop() // 触发 onScopeDispose → 清 timer + 移除 listener

    setHidden(false)
    fireVisibilityChange()
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()
  })

  it('补查 await 期间 dispose：await 恢复后不排新周期 timer（卸载后 60min 内不联网，W05 review）', async () => {
    // 让 checkForUpdate 挂起，制造 runAutoCheck 的 await 窗口（此窗口无 pending timer）
    let resolveCheck!: (v: UpdateCheckResult) => void
    ipc.checkForUpdate.mockImplementation(
      () =>
        new Promise<UpdateCheckResult>((res) => {
          resolveCheck = res
        }),
    )

    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000) // hidden 跳过（未联网，lastNetworkCheckAt 保持 0）
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
