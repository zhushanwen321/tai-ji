/**
 * useAppUpdate 功能 1 测试：持久化升级提醒标志（常驻提醒）。
 *
 * 覆盖场景：
 * - PENDING-TC1：restorePendingUpdate 从 getPendingUpdate 恢复「可升级」提醒（state='available' + latestRelease + releaseNotes）
 * - PENDING-TC2：getPendingUpdate 返回 null → restorePendingUpdate 不改变 state（保持 idle）
 * - PENDING-TC3：防覆盖守卫——pending 恢复后 checkForUpdate 检测失败不回退 idle（保持 available）
 * - PENDING-TC4：防覆盖守卫——pending 恢复后 checkForUpdate 返回 null 不回退 idle
 * - PENDING-TC5：pending 恢复后 checkForUpdate 确认有新版 → 正常刷新 latestRelease
 * - PENDING-TC6：无 pending 恢复时，checkForUpdate 失败正常回退 idle（守卫不影响正常流程）
 * - PENDING-TC7（I#8）：getPendingUpdate reject（IPC 异常）→ restorePendingUpdate catch 分支：state 保持 idle、不抛错
 * - PENDING-TC8（I#9）：initAutoCheck 完整启动序列——先同步触发 restorePendingUpdate，30s 后触发 checkForUpdate
 *
 * 测试设计：直接调 controller.restorePendingUpdate（绕过 initAutoCheck 的 30s 定时器，避免
 * fake timer 与 async/await mock promise 的交互复杂度）。restorePendingUpdate 进控制器接口
 * 供测试直调，运行时由 initAutoCheck 内部触发。
 *
 * Mock 策略（控制器化，对齐 useAppUpdate.test.ts）：
 * - createAppUpdateController({ ipc }) 注入内存 adapter（helpers/update-ipc-mock.ts）。
 *   getPreloaded 默认 null → initAutoCheck 先 restorePreloadedUpdate 无果，再走
 *   restorePendingUpdate 路径
 * - vi.mock('@/composables/logic/markdown') 桩 renderMarkdown 避免 shiki WASM
 * - effectScope 包 controller.subscribeProgress（onScopeDispose 依赖活跃 scope）
 * - afterEach 兜底 stop 活跃 scope（定时器/visibility listener/订阅随 onScopeDispose 清理）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.pending.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { EffectScope } from 'vue'
import type { LatestReleaseInfo } from '@taiji/shared'
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

/** 构造测试用 LatestReleaseInfo */
function makeRelease(version = '0.9.0'): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '## 新特性\n- 支持 foo',
    publishedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://github.com/example/repo/releases/v' + version,
    assets: {},
  }
}

/** 内存 ipc adapter + 绑定它的控制器（每 beforeEach 重建，用例间零残留） */
let ipc: MemoryAppUpdateIpc
let controller: AppUpdateControllerInternal
/** 兜底清理：用例中断未 stop 时，afterEach 统一触发 onScopeDispose 清理 */
let activeScope: EffectScope | null = null

beforeEach(() => {
  ipc = createMemoryAppUpdateIpc()
  controller = createAppUpdateController({ ipc })
  // initAutoCheck 恢复链的 checkLaunchResult 消费启动结果（consumed 一次性）；null = 无待通知结果
  ipc.getLaunchResult.mockResolvedValue(null)
  // initAutoCheck 读 autoUpdate 开关（默认 true，存量行为不变）
  ipc.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
  // 默认值：getPreloaded null 表示无预下载产物 → initAutoCheck 先 restorePreloadedUpdate
  // 无果后再 restorePendingUpdate（pending 测试的核心路径）
  ipc.getPreloaded.mockResolvedValue(null)
  ipc.getPendingUpdate.mockResolvedValue(null)
  ipc.updateDownload.mockResolvedValue({ downloaded: true })
  ipc.updateInstall.mockResolvedValue({ triggerRestart: true })
  hoistedRenderMarkdown.mockReset()
  hoistedRenderMarkdown.mockResolvedValue('<h2>新特性</h2>')
})

afterEach(() => {
  activeScope?.stop()
  activeScope = null
  vi.unstubAllGlobals()
})

/** 在 effectScope 内订阅控制器，返回 result + scope.stop 清理函数 */
function setupUseAppUpdate(): { result: AppUpdateControllerInternal; stop: () => void } {
  const scope = effectScope()
  activeScope = scope
  scope.run(() => {
    controller.subscribeProgress()
  })
  return { result: controller, stop: () => scope.stop() }
}

describe('useAppUpdate 功能1：持久化升级提醒标志', () => {
  it('PENDING-TC1：restorePendingUpdate 从 getPendingUpdate 恢复「可升级」提醒', async () => {
    ipc.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()

    await controller.restorePendingUpdate()

    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    // releaseNotes 异步渲染，waitFor 等 html 填充
    await vi.waitFor(() => {
      expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    })
    expect(ipc.getPendingUpdate).toHaveBeenCalledOnce()
    stop()
  })

  it('PENDING-TC2：getPendingUpdate 返回 null → 不恢复提醒，state 保持 idle', async () => {
    ipc.getPendingUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate()

    await controller.restorePendingUpdate()

    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('PENDING-TC3：防覆盖守卫——pending 恢复后 checkForUpdate 失败不回退 idle', async () => {
    // 1. 恢复 pending
    ipc.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()
    await controller.restorePendingUpdate()
    expect(result.state.state).toBe('available')

    // 2. 模拟 30s 后联网检测失败（网络断开）
    ipc.checkForUpdate.mockRejectedValue(new Error('network error'))
    await result.checkForUpdate()

    // 防覆盖守卫：pendingRestored=true 时检测失败不回退 idle，保持 available
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('PENDING-TC4：防覆盖守卫——pending 恢复后 checkForUpdate 返回 null 不回退 idle', async () => {
    // 1. 恢复 pending
    ipc.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()
    await controller.restorePendingUpdate()
    expect(result.state.state).toBe('available')

    // 2. 模拟 30s 后联网检测无新版（null）
    ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    await result.checkForUpdate()

    // 防覆盖守卫：pendingRestored=true 时无新版不回退 idle（pending 标志证明曾检测到更新）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('PENDING-TC5：pending 恢复后 checkForUpdate 确认有新版 → 正常刷新 latestRelease', async () => {
    // 1. 恢复的 pending 是 v0.9.0
    ipc.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()
    await controller.restorePendingUpdate()
    expect(result.state.latestRelease?.version).toBe('0.9.0')

    // 2. 联网检测到更新的 v0.9.5
    ipc.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.5'), rateLimited: false })
    await result.checkForUpdate()

    // 确认有新版 → 正常刷新（latestRelease 更新为 v0.9.5）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.5')
    stop()
  })

  it('PENDING-TC6：无 pending 恢复时，checkForUpdate 失败正常回退 idle（守卫不影响正常流程）', async () => {
    // 无 pending → pendingRestored 保持 false
    ipc.getPendingUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate()
    await controller.restorePendingUpdate()
    expect(result.state.state).toBe('idle')

    // 联网检测失败
    ipc.checkForUpdate.mockRejectedValue(new Error('network error'))
    await result.checkForUpdate()

    // 正常流程（非 pending 恢复）：检测失败 → 回退 idle（守卫只在 pendingRestored 时生效）
    expect(result.state.state).toBe('idle')
    stop()
  })

  it('PENDING-TC7（I#8）：getPendingUpdate reject（IPC 异常）→ restorePendingUpdate catch 分支：state 保持 idle、不抛错', async () => {
    // 模拟 IPC 通道异常（如 preload 桥未就绪 / ipcRenderer.invoke reject）
    ipc.getPendingUpdate.mockRejectedValue(new Error('ipc fail'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, stop } = setupUseAppUpdate()

    // restorePendingUpdate 是 best-effort：catch 后不 re-throw，state 不变
    await expect(controller.restorePendingUpdate()).resolves.toBeUndefined()

    // state 保持初始 idle，latestRelease 未被污染
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    // 失败信息经 console.warn 诊断（不进 errorMessage，避免 idle 态残留）
    expect(warnSpy).toHaveBeenCalledWith(
      '[useAppUpdate] restorePendingUpdate failed:',
      expect.any(Error),
    )
    warnSpy.mockRestore()
    stop()
  })

  it('PENDING-TC8（I#9）：initAutoCheck 完整启动序列——先同步触发 restorePendingUpdate，30s 后触发 checkForUpdate', async () => {
    // AUTO_CHECK_DELAY_MS = 30_000（use-app-update-autocheck.ts 未导出常量，用字面量并注明）
    const AUTO_CHECK_DELAY_MS = 30_000
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // pending 恢复成功（立即触发，不等 30s）
    ipc.getPendingUpdate.mockResolvedValue(makeRelease('0.9.0'))
    // 30s 后联网检测确认有更新版本
    ipc.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.5'), rateLimited: false })
    const { result, stop } = setupUseAppUpdate()

    // initAutoCheck 必须在活跃 effect scope 内调（onScopeDispose 注册 timer 清理）
    result.initAutoCheck()

    // 1. 启动序列先触发 restorePreloadedUpdate（getPreloaded），无预下载产物后再
    //    restorePendingUpdate（getPendingUpdate）。两者都是 async，需 flush 微任务
    await vi.waitFor(() => {
      expect(ipc.getPreloaded).toHaveBeenCalledOnce()
    })
    await vi.waitFor(() => {
      expect(ipc.getPendingUpdate).toHaveBeenCalledOnce()
    })
    await vi.waitFor(() => {
      expect(result.state.state).toBe('available')
      expect(result.state.latestRelease?.version).toBe('0.9.0')
    })
    // 此时 30s 定时器尚未到期，checkForUpdate 不应被调
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    // 2. 推进 30s：联网检测被触发（刷新 release info）
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS)
    await vi.waitFor(() => {
      expect(ipc.checkForUpdate).toHaveBeenCalledOnce()
    })
    // 联网检测确认 v0.9.5 → latestRelease 被刷新
    await vi.waitFor(() => {
      expect(result.state.latestRelease?.version).toBe('0.9.5')
    })
    expect(result.state.state).toBe('available')

    warnSpy.mockRestore()
    vi.useRealTimers()
    stop()
  })

  it('PENDING-TC9（I#9 补充）：initAutoCheck 在 30s 内不触发 checkForUpdate（定时器语义正确，不提前检测）', async () => {
    const AUTO_CHECK_DELAY_MS = 30_000
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ipc.getPendingUpdate.mockResolvedValue(null)
    ipc.checkForUpdate.mockResolvedValue({ info: makeRelease('0.9.0'), rateLimited: false })
    const { result, stop } = setupUseAppUpdate()

    result.initAutoCheck()
    await vi.waitFor(() => {
      expect(ipc.getPendingUpdate).toHaveBeenCalledOnce()
    })

    // 推进 29s（差 1s 到期）→ checkForUpdate 仍不应被调
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS - 1_000)
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()
    // pending 为 null → state 保持 idle
    expect(result.state.state).toBe('idle')

    // 再推进 1s 达到 30s → checkForUpdate 触发
    vi.advanceTimersByTime(1_000)
    await vi.waitFor(() => {
      expect(ipc.checkForUpdate).toHaveBeenCalledOnce()
    })

    warnSpy.mockRestore()
    vi.useRealTimers()
    stop()
  })
})
