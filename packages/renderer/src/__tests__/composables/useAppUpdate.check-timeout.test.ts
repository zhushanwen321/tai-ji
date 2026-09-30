/**
 * useAppUpdate ipc check 超时兜底单测（check 轴 60s 墙钟）。
 *
 * 背景缺陷（2026-09-30 排障）：Electron invoke 无内置超时，ipc.checkForUpdate 一旦
 * 永不返回会连锁杀死两条通路——自动调度链（runAutoCheck 在 await 之后才排下一周期，
 * 单次挂死 = 递归 setTimeout 链永久断裂）与 state（固化 checking，canCheck 守卫此后
 * 跳过一切自动检查）。修复 = check 轴内 withIpcTimeout 60s 兜底，超时按失败收口。
 *
 * 覆盖：
 * - auto 链挂死自愈：invoke 永不返回 → 60s 超时 → state 静默回 idle（不固化 checking）
 *   → 60min 周期照常排上并触发第二次检查（链未断）
 * - manual 挂死超时显形：state='error'（用户可见失败，不再无限等待）
 * - 迟到 resolve 丢弃：超时收口后原 promise 才 resolve，state 不被迟到结果改写
 *
 * Mock 策略（对齐 useAppUpdate.visibility.test.ts）：createAppUpdateController({ ipc })
 * 注入内存 adapter，挂死 = mockImplementation 返回永不 settle 的 Promise。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.check-timeout.test.ts
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

const hoistedRenderMarkdown = vi.hoisted(() => vi.fn<(md: string) => Promise<string>>())
vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: hoistedRenderMarkdown,
}))

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

/** 让 ipc check 永不返回（模拟 invoke 挂死），并暴露手动 settle 通道 */
function makeCheckHang(): (v: UpdateCheckResult) => void {
  let settle!: (v: UpdateCheckResult) => void
  ipc.checkForUpdate.mockImplementation(
    () =>
      new Promise<UpdateCheckResult>((res) => {
        settle = res
      }),
  )
  return (v: UpdateCheckResult) => settle(v)
}

beforeEach(() => {
  ipc = createMemoryAppUpdateIpc()
  controller = createAppUpdateController({ ipc })
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
  vi.stubGlobal('__APP_VERSION__', '0.0.0')
  ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
  ipc.updateDownload.mockResolvedValue({ downloaded: true })
  ipc.updateInstall.mockResolvedValue({ triggerRestart: true })
  ipc.getPreloaded.mockResolvedValue(null)
  ipc.getPendingUpdate.mockResolvedValue(null)
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

describe('useAppUpdate ipc check 超时兜底', () => {
  it('auto 链挂死自愈：60s 超时静默回 idle，60min 周期照常排上（链不断）', async () => {
    makeCheckHang()
    const { result, stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    // 30s 首查发起，invoke 挂起中（state=checking）
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(result.state.state).toBe('checking')

    // 60s 墙钟到点：超时按 auto 失败收口 → state 回 idle（不固化 checking）
    await vi.advanceTimersByTimeAsync(60_000)
    expect(result.state.state).toBe('idle')

    // 下一周期定时器已排上：60min 后第二次检查照常发起（递归链未断）
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2)
    stop()
  })

  it('manual 挂死超时显形：state="error"（用户可见失败，不再无限等待）', async () => {
    makeCheckHang()
    const { result, stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    // 用户点击「检查更新」（manual，force=true）→ invoke 挂起
    const pending = result.checkForUpdate(true, 'manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(result.state.state).toBe('checking')

    // 60s 墙钟到点：超时按 manual 失败收口 → error 态显形
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBeTruthy()
    stop()
  })

  it('迟到 resolve 丢弃：超时收口后原 promise 才返回，state 不被迟到结果改写', async () => {
    const resolveLate = makeCheckHang()
    const { result, stop } = setupWithAutoCheck()
    // initAutoCheck 的定时器排在 settings promise 之后，先 flush 微任务
    await vi.advanceTimersByTimeAsync(0)

    // 30s 首查挂起 → 60s 超时 → auto 静默回 idle
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(result.state.state).toBe('idle')

    // 原.invoke 此刻才 resolve 出新版信息——迟到结果不可信，不得改写 state
    resolveLate({
      info: {
        version: '9.9.9',
        tagName: 'v9.9.9',
        releaseNotes: '',
        publishedAt: '',
        htmlUrl: '',
        assets: {},
      },
      rateLimited: false,
    })
    await vi.advanceTimersByTimeAsync(0) // flush microtasks
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease?.version).toBeUndefined()
    stop()
  })
})
