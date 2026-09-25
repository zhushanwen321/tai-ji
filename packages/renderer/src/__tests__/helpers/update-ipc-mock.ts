/**
 * useAppUpdate* composables 测试共享的内存 ipc adapter 工厂。
 *
 * 控制器化改造后 useAppUpdate 家族不再 import @/api/domains/settings——测试经
 * createAppUpdateController({ ipc }) 注入本工厂产出的内存 adapter（vi.fn 集合 +
 * fireProgress/fireError 回调捕获），无需 vi.mock @/api 层（也切断了 @/lib/ipc
 * 对 window.electronAPI 的真实依赖加载路径上的 mock 需求）。
 *
 * 签名对齐 AppUpdateIpc（use-app-update-ipc.ts）；fireProgress/fireError 是测试专用扩展
 * （模拟 main 进程的进度/错误推送），不属于生产接口。
 *
 * 与 Wave C update-card-mock.ts 互补不重复：那边 mock 的是「整个 useAppUpdate composable 模块」
 * （服务 update-page / UpdateCheckCard 系组件测试），这边是 SUT 真实依赖的 ipc 缝内存实现
 * （服务直接加载 useAppUpdate 源码的 composables 四文件）。
 */
import { vi } from 'vitest'
import type {
  LatestReleaseInfo,
  LaunchResult,
  UpdateCheckResult,
  UpdateErrorPayload,
  UpdateInstallResult,
  UpdateSettings,
} from '@taiji/shared'
import type { AppUpdateIpc } from '@/composables/features/settings/use-app-update-ipc'

/** onUpdateProgress 推送负载（main → renderer 进度；restarting 由 performInstall resolve 后置，不经推送） */
export interface UpdateProgressPayload {
  stage: 'downloading' | 'replacing'
  percent: number
}

/** 内存 ipc adapter：AppUpdateIpc 的 vi.fn 实现 + 测试专用推送触发器 */
export interface MemoryAppUpdateIpc extends AppUpdateIpc {
  /** 模拟 main 进度的进度推送（转发给已注册的 onUpdateProgress 回调） */
  fireProgress(p: UpdateProgressPayload): void
  /** 模拟 main 进度的错误推送（转发给已注册的 onUpdateError 回调） */
  fireError(e: UpdateErrorPayload): void
}

/** 创建一份独立的内存 ipc adapter（每调用新 vi.fn 集，用例间零残留） */
export function createMemoryAppUpdateIpc(): MemoryAppUpdateIpc {
  // 捕获 onUpdateProgress/onUpdateError 注册的回调，供测试手动触发（模拟 main 推送）
  let progressCb: ((p: UpdateProgressPayload) => void) | null = null
  let errorCb: ((e: UpdateErrorPayload) => void) | null = null
  return {
    checkForUpdate: vi.fn<(opts?: { force?: boolean }) => Promise<UpdateCheckResult>>(),
    updateDownload: vi.fn<(version: string) => Promise<{ downloaded: boolean }>>(),
    updateInstall: vi.fn<() => Promise<UpdateInstallResult>>(),
    getPreloaded: vi.fn<() => Promise<{ release: LatestReleaseInfo; filePath: string } | null>>(),
    getPendingUpdate: vi.fn<() => Promise<LatestReleaseInfo | null>>(),
    getLaunchResult: vi.fn<() => Promise<LaunchResult | null>>(),
    getUpdateSettings: vi.fn<() => Promise<UpdateSettings>>(),
    openUpdateFallbackUrl: vi.fn<(url: string) => Promise<void>>(),
    onUpdateProgress: vi.fn((cb: (p: UpdateProgressPayload) => void) => {
      progressCb = cb
      return () => {
        progressCb = null
      }
    }),
    onUpdateError: vi.fn((cb: (e: UpdateErrorPayload) => void) => {
      errorCb = cb
      return () => {
        errorCb = null
      }
    }),
    fireProgress: (p: UpdateProgressPayload) => {
      if (progressCb) progressCb(p)
    },
    fireError: (e: UpdateErrorPayload) => {
      if (errorCb) errorCb(e)
    },
  }
}
