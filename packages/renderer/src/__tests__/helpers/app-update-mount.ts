/**
 * useAppUpdate 测试族共享 harness（check-timeout / manual-channel / pending /
 * visibility / 主文件五套同 SUT 测试单源；范式同 update-page-mount.ts）。
 * 收敛五文件逐字重复的挂载骨架：
 *  - 内存 ipc adapter + 控制器：setupAppUpdateLifecycle 的 beforeEach 重建（用例间零残留）
 *  - effectScope 订阅/启动编排（setupAppUpdate / startAutoCheckChain / reinitAutoCheckInActiveScope）
 *  - ipc 七键默认 resolved 值（primeIpc 选项注入，覆写在 lifecycle 之后执行即生效）
 *  - 可见性/挂死装置（setHidden / makeCheckHang）与 release fixture（makeUpdateRelease）
 *
 * ipc/controller 经 `export let` live binding 导出：beforeEach 重建后测试体内的裸引用
 * 自动指向新实例（vitest 按测试文件隔离模块图，本 helper 状态每文件独立）。
 *
 * markdown mock 的 vi.mock 注册留在测试文件（mock 是文件作用域），工厂经顶层 import
 * 转发 ./app-update-markdown-stub 导出——该模块必须在本模块之前 import（见其文件头）。
 * 测试文件自身的 vi.mock（toast / i18n 等）不受影响：vitest 把它们提升到本文件全部
 * import 之前执行，先于本 helper 内的 SUT 加载。
 */
import { beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { EffectScope } from 'vue'
import type { LatestReleaseInfo, UpdateCheckResult } from '@taiji/shared'
import { createMemoryAppUpdateIpc, type MemoryAppUpdateIpc } from './update-ipc-mock'
import { renderMarkdownMock } from './app-update-markdown-stub'
import {
  createAppUpdateController,
  type AppUpdateControllerInternal,
} from '@/composables/features/settings/useAppUpdate'

export type { AppUpdateControllerInternal } from '@/composables/features/settings/useAppUpdate'

/** 内存 ipc adapter + 绑定它的控制器（每 beforeEach 重建；live binding 导出供测试体裸引用） */
export let ipc: MemoryAppUpdateIpc
export let controller: AppUpdateControllerInternal
/** 兜底清理：用例中断未 stop 时，afterEach 统一触发 onScopeDispose 清理 */
let activeScope: EffectScope | null = null

/** lifecycle 差异轴（各测试文件的真实变化，非流水 flag）： */
export interface AppUpdateLifecycleOptions { // oe-exempt:20260930:test:测试 harness 的BeforeEach/afterEach 差异轴契约，五文件按需组合传入
  /** fake timers 轴（check-timeout / visibility）：beforeEach useFakeTimers + epoch 起点；afterEach 配对 restoreAllMocks → unstub → useRealTimers */
  fakeTimers?: boolean
  /** beforeEach 注入 ipc 七键默认 resolved 值（各用例的 mock* 覆写在其后执行即生效） */
  primeIpc?: boolean
  /** beforeEach stubGlobal __APP_VERSION__='0.0.0'（版本守卫不拦截，保持用例意图） */
  stubAppVersion?: boolean
  /** renderMarkdown 默认解析 html（mockReset 后置入；不传则不触碰桩） */
  markdownHtml?: string
  /** beforeEach 重置 document 可见态为 visible（visibility 族） */
  resetVisibility?: boolean
}

/** 订阅句柄：result 即控制器本体（容器化后单实例共享 state） */
export interface AppUpdateHandle { // oe-exempt:20260930:test:setup 系函数的返回形状契约，五文件用例统一解构
  result: AppUpdateControllerInternal
  stop: () => void
}

/** ipc 七键默认 resolved 值（lifecycle 的 primeIpc 选项调用） */
function primeIpcDefaults(): void {
  ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
  ipc.updateDownload.mockResolvedValue({ downloaded: true })
  ipc.updateInstall.mockResolvedValue({ triggerRestart: true })
  ipc.getPreloaded.mockResolvedValue(null)
  ipc.getPendingUpdate.mockResolvedValue(null)
  ipc.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
  ipc.getLaunchResult.mockResolvedValue(null)
}

/**
 * 注册本族公共生命周期：beforeEach 重建 ipc + 控制器（再按差异轴注入），afterEach 兜底
 * stop 活跃 scope（定时器/visibility listener/订阅随 onScopeDispose 清理）。fake timers
 * 轴下 stop 必须先于 restoreAllMocks/useRealTimers——onScopeDispose 的 clearTimeout
 * 需配对 fake timer。
 */
export function setupAppUpdateLifecycle(options: AppUpdateLifecycleOptions = {}): void {
  beforeEach(() => {
    ipc = createMemoryAppUpdateIpc()
    controller = createAppUpdateController({ ipc })
    if (options.fakeTimers) {
      vi.useFakeTimers()
      // fake 时钟起点设为真实 epoch 量级：lastNetworkCheckAt 初值 0 时，
      // 起点 0 会让「首查前的恢复可见补查」被时间比较误判（真实时钟不会）
      vi.setSystemTime(1_700_000_000_000)
    }
    if (options.stubAppVersion) {
      // __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之。
      // '0.0.0' 让版本守卫不拦截（< 任何 preloaded 版本），保持用例意图
      vi.stubGlobal('__APP_VERSION__', '0.0.0')
    }
    if (options.resetVisibility) setHidden(false)
    if (options.primeIpc) primeIpcDefaults()
    if (options.markdownHtml !== undefined) {
      renderMarkdownMock.mockReset().mockResolvedValue(options.markdownHtml)
    }
  })
  afterEach(() => {
    activeScope?.stop()
    activeScope = null
    if (options.fakeTimers) {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    } else {
      vi.unstubAllGlobals()
    }
  })
}

/** 在 effectScope 内订阅控制器并（可选）启动自动检查，返回 result + scope.stop（onScopeDispose 需活跃 scope） */
export function setupAppUpdate(options?: { initAutoCheck?: boolean }): AppUpdateHandle {
  const scope = effectScope()
  activeScope = scope
  scope.run(() => {
    controller.subscribeProgress()
    if (options?.initAutoCheck) {
      controller.initAutoCheck()
    }
  })
  return { result: controller, stop: () => scope.stop() }
}

/**
 * fake timers 下挂 auto-check 链并 flush 微任务：initAutoCheck 的定时器排在 settings
 * promise 之后，先 flush 微任务再推进墙钟（本族 fake-timer 用例的标准前置）。
 */
export async function startAutoCheckChain(): Promise<AppUpdateHandle> {
  const handle = setupAppUpdate({ initAutoCheck: true })
  await vi.advanceTimersByTimeAsync(0)
  return handle
}

/** 幂等重排：在当前活跃 scope 内再次 initAutoCheck（多消费者场景） */
export function reinitAutoCheckInActiveScope(): void {
  activeScope!.run(() => controller.initAutoCheck())
}

/** 构造测试用 LatestReleaseInfo（pending / 主文件共用字段值；manual-channel 断言依赖不同的 notes/url，留在该文件） */
export function makeUpdateRelease(version = '0.9.0'): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '## 新特性\n- 支持 foo',
    publishedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://github.com/example/repo/releases/v' + version,
    assets: {},
  }
}

/** 让 ipc check 永不返回（模拟 invoke 挂死），返回手动 settle 通道（check-timeout / visibility 挂死用例） */
export function makeCheckHang(): (v: UpdateCheckResult) => void {
  let settle!: (v: UpdateCheckResult) => void
  ipc.checkForUpdate.mockImplementation(
    () =>
      new Promise<UpdateCheckResult>((res) => {
        settle = res
      }),
  )
  return (v: UpdateCheckResult) => settle(v)
}

/** mock document.hidden / visibilityState（visibility 守卫用例；happy-dom 下 spyOn getter 生效） */
export function setHidden(hidden: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
}
