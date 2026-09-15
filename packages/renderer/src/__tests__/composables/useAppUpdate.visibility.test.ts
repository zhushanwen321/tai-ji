/**
 * useAppUpdate 可见性守卫单测（perf W05 Q1-6）。
 *
 * 覆盖（fake timers + document.hidden mock）：
 * - hidden 期间周期定时器照常触发，但不联网检测（checkForUpdate 零调用，连 hidden 多周期均不发）
 * - 恢复可见（visibilitychange → visible）：跳过被立即补查（force=true），不等下一个 60min
 * - 补查后周期检测继续（runAutoCheck 重排下一次定时器）
 * - 状态守卫优先于 visibility 补查：升级流程态（downloaded）hidden 期间跳过不标记，恢复可见不补查
 * - onScopeDispose：scope 卸载后 visibilitychange 不再触发检测
 * - 补查 await 窗口 dispose：runAutoCheck await 恢复后不排新周期 timer（W05 review）
 *
 * Mock 策略对齐 useAppUpdate.test.ts（vi.mock @/api/domains/settings + markdown，effectScope 包 useAppUpdate）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.visibility.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { UpdateCheckResult } from '@xyz-agent/shared'
import { updateIpcBridge, updateIpcModule } from '../helpers/update-ipc-mock'

// IPC 桥 mock 底座收敛在 helpers/update-ipc-mock.ts（r2-01：原 vi.hoisted 块外移为
// helper 模块单例，vi.mock 工厂经顶层 import 转发注册）。原文件 onUpdateProgress/onUpdateError
// 为 no-op stub，统一为桥的回调捕获版：本文件从不 fire，行为等价；getLaunchResult 原未注册
// （SUT 侧 checkLaunchResult 对 undefined 依赖已有 catch 兜底），桥统一注册后行为更干净。
vi.mock('@/api/domains/settings', () => updateIpcModule(updateIpcBridge))

// markdown mock 留文件内：默认 html 属本文件行为面（非 IPC 桥）
const hoistedRenderMarkdown = vi.hoisted(() => vi.fn<(md: string) => Promise<string>>())
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: hoistedRenderMarkdown,
}))

import { useAppUpdate, _resetForTest } from '@/composables/features/settings/useAppUpdate'

/** mock document.hidden / visibilityState */
function setHidden(hidden: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
}

/** 模拟浏览器可见性变化事件 */
function fireVisibilityChange(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

/** 在 effectScope 内运行 useAppUpdate + initAutoCheck（onScopeDispose 需活跃 scope） */
function setupWithAutoCheck(): { result: ReturnType<typeof useAppUpdate>; stop: () => void } {
  const scope = effectScope()
  let result: ReturnType<typeof useAppUpdate> | undefined
  scope.run(() => {
    result = useAppUpdate()
    result.initAutoCheck()
  })
  return { result: result!, stop: () => scope.stop() }
}

beforeEach(() => {
  _resetForTest()
  vi.useFakeTimers()
  // fake 时钟起点设为真实 epoch 量级：lastVisibilityCheckAt 初值 0 时，
  // 起点 0 会让「首查后 30s 的补查」被 10min 节流窗口误挡（真实时钟不会）
  vi.setSystemTime(1_700_000_000_000)
  vi.stubGlobal('__APP_VERSION__', '0.0.0')
  setHidden(false)
  updateIpcBridge.checkForUpdate.mockReset().mockResolvedValue({ info: null, rateLimited: false })
  updateIpcBridge.updateDownload.mockReset().mockResolvedValue({ downloaded: true })
  updateIpcBridge.updateInstall.mockReset().mockResolvedValue({ triggerRestart: true })
  updateIpcBridge.getPreloaded.mockReset().mockResolvedValue(null)
  updateIpcBridge.getPendingUpdate.mockReset().mockResolvedValue(null)
  // u4a：initAutoCheck 读 autoUpdate 开关（visibility 用例默认 true，保持周期调度行为）
  updateIpcBridge.getUpdateSettings.mockReset().mockResolvedValue({ preDownload: false, autoUpdate: true })
  updateIpcBridge.openUpdateFallbackUrl.mockReset()
  updateIpcBridge.onUpdateProgress.mockClear()
  updateIpcBridge.onUpdateError.mockClear()
  hoistedRenderMarkdown.mockReset().mockResolvedValue('<h2>notes</h2>')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useAppUpdate 可见性守卫（Q1-6）', () => {
  it('hidden 期间周期触发不联网检测：30s 首次 + 60min 周期均跳过 checkForUpdate', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // u4a：initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    // 30s 首次触发 → hidden 跳过
    await vi.advanceTimersByTimeAsync(30_000)
    expect(updateIpcBridge.checkForUpdate).not.toHaveBeenCalled()

    // 连 hidden 多个 60min 周期均不发联网请求
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(updateIpcBridge.checkForUpdate).not.toHaveBeenCalled()
    stop()
  })

  it('恢复可见立即补查（force=true），不等下一个 60min 周期', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // u4a：initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(30_000) // hidden 跳过，标记 skippedWhileHidden
    expect(updateIpcBridge.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange()
    // 补查同步发起，立即断言可见
    expect(updateIpcBridge.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(updateIpcBridge.checkForUpdate).toHaveBeenLastCalledWith({ force: false })
    stop()
  })

  it('补查后周期检测继续（下一个 60min 周期正常触发）', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // u4a：initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(30_000)
    setHidden(false)
    fireVisibilityChange()
    expect(updateIpcBridge.checkForUpdate).toHaveBeenCalledTimes(1)

    // 补查的 runAutoCheck 重排了周期定时器：60min 后再次检测
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(updateIpcBridge.checkForUpdate).toHaveBeenCalledTimes(2)
    stop()
  })

  it('恢复可见无跳过记录时不补查（正常周期内的 visibilitychange 是 no-op）', async () => {
    const { stop } = setupWithAutoCheck()
    // u4a：initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    // 可见期间正常 30s 首次检测（无跳过记录）
    await vi.advanceTimersByTimeAsync(30_000)
    expect(updateIpcBridge.checkForUpdate).toHaveBeenCalledTimes(1)

    // 失焦又恢复（hidden 期间无周期触发 → 无跳过记录）
    setHidden(true)
    fireVisibilityChange()
    setHidden(false)
    fireVisibilityChange()
    expect(updateIpcBridge.checkForUpdate).toHaveBeenCalledTimes(1) // 不补查
    stop()
  })

  it('状态守卫优先：downloaded 态 hidden 期间跳过不标记，恢复可见不补查', async () => {
    setHidden(true)
    const { result, stop } = setupWithAutoCheck()
    // 置为升级流程态：canCheck=false，visibility 守卫不应置补查标记
    result.state.state = 'downloaded'

    await vi.advanceTimersByTimeAsync(30_000)
    expect(updateIpcBridge.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange()
    expect(updateIpcBridge.checkForUpdate).not.toHaveBeenCalled() // 不补查（升级流程不被打断）
    stop()
  })

  it('onScopeDispose 卸载 listener：dispose 后 visibilitychange 不再触发检测', async () => {
    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // u4a：initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(30_000)
    stop() // 触发 onScopeDispose → 清 timer + 移除 listener

    setHidden(false)
    fireVisibilityChange()
    expect(updateIpcBridge.checkForUpdate).not.toHaveBeenCalled()
  })

  it('补查 await 期间 dispose：await 恢复后不排新周期 timer（卸载后 60min 内不联网，W05 review）', async () => {
    // 让 checkForUpdate 挂起，制造 runAutoCheck 的 await 窗口（此窗口无 pending timer）
    let resolveCheck!: (v: UpdateCheckResult) => void
    updateIpcBridge.checkForUpdate.mockImplementation(
      () =>
        new Promise<UpdateCheckResult>((res) => {
          resolveCheck = res
        }),
    )

    setHidden(true)
    const { stop } = setupWithAutoCheck()
    // u4a：initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000) // hidden 跳过，标记 skippedWhileHidden
    expect(updateIpcBridge.checkForUpdate).not.toHaveBeenCalled()

    setHidden(false)
    fireVisibilityChange() // 补查发起：runAutoCheck 进入 await checkForUpdate（挂起中）
    expect(updateIpcBridge.checkForUpdate).toHaveBeenCalledTimes(1)

    stop() // await 挂起期间 dispose（clearAutoCheckTimer 无 pending timer 可清）
    resolveCheck({ info: null, rateLimited: false }) // await 恢复：disposed 已置位 → 不排下一周期 timer
    await vi.advanceTimersByTimeAsync(0) // flush microtasks

    // 无新周期 timer 排上：推进 20min 不再联网
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(updateIpcBridge.checkForUpdate).toHaveBeenCalledTimes(1) // 仍只有补查那一次
  })
})
