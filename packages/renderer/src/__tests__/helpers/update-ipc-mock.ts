/**
 * useAppUpdate* composables 测试共享 IPC 桥 mock 底座（r2-01 顺路消化，docs/todo/test-infra-source-simplify-2026-09.md §3 R5）。
 *
 * composables/useAppUpdate.test.ts / .pending / .manual-channel / .visibility 四文件曾各复制
 * ~65 行 vi.hoisted mock 块。收敛目标 = 真正同构的部分：@/api/domains/settings 的 update IPC 桥
 * （10 个导出）+ onUpdateProgress/onUpdateError 的回调捕获机制（fireProgress/fireError）。
 * 键泛型签名统一为现行源码契约（updateDownload 传 version 字符串——批次 3 RC1 后的形态）。
 *
 * 机制：helper 模块顶层初始化单例 = 测试文件 vi.hoisted 块的外移；vi.mock 注册留在测试文件
 * （mock 是文件作用域），工厂经顶层 import 转发本 helper 导出——同 Wave C update-card-mock.ts
 * 先例。vitest 按测试文件隔离模块图：各单例在每个测试文件内是独立实例，文件内 beforeEach
 * 重置与断言共享同一批 vi.fn，与原 vi.hoisted 文件内单例语义一致。
 *
 * 与 Wave C update-card-mock.ts 互补不重复：那边 mock 的是「整个 useAppUpdate composable 模块」
 * （服务 update-page / UpdateCheckCard 系），这边 mock 的是 SUT 真实依赖的 settings IPC 桥
 * （服务直接加载 useAppUpdate 源码的 composables 四文件）。
 *
 * 未收敛的互异部分（各文件 beforeEach 的默认值序列 / markdown·toast·i18n 的文件内 mock）
 * 保留在各测试文件——只收敛结构同构，不抹平行为差异。
 */
import { vi } from 'vitest'
import type { LatestReleaseInfo, LaunchResult, UpdateCheckResult, UpdateInstallResult } from '@xyz-agent/shared'

/** onUpdateProgress 推送负载（main → renderer 进度） */
export interface UpdateProgressPayload {
  stage: 'downloading' | 'replacing'
  percent: number
}

/** onUpdateError 推送负载（main → renderer 错误 SSOT） */
export interface UpdateErrorPayload {
  stage: string
  message: string
  errorCode?: string
  suggestion?: string
}

/** 创建一份 IPC 桥 mock（含回调捕获；一般直接用下方 updateIpcBridge 单例） */
export function createUpdateIpcBridge() {
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
    getUpdateSettings: vi.fn<() => Promise<{ preDownload: boolean; autoUpdate?: boolean }>>(),
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
    // 暴露给测试：手动触发 main 进程的进度/错误推送
    fireProgress: (p: UpdateProgressPayload) => {
      if (progressCb) progressCb(p)
    },
    fireError: (e: UpdateErrorPayload) => {
      if (errorCb) errorCb(e)
    },
  }
}

export type UpdateIpcBridge = ReturnType<typeof createUpdateIpcBridge>

/** 文件内单例：测试断言（bridge.xxx）与 vi.mock 工厂引用同一批 vi.fn */
export const updateIpcBridge = createUpdateIpcBridge()

/** '@/api/domains/settings' mock 工厂：转发桥的 10 个 update 相关导出（测试文件一行注册） */
export function updateIpcModule(bridge: UpdateIpcBridge) {
  return {
    checkForUpdate: bridge.checkForUpdate,
    updateDownload: bridge.updateDownload,
    updateInstall: bridge.updateInstall,
    getPreloaded: bridge.getPreloaded,
    getPendingUpdate: bridge.getPendingUpdate,
    getLaunchResult: bridge.getLaunchResult,
    getUpdateSettings: bridge.getUpdateSettings,
    openUpdateFallbackUrl: bridge.openUpdateFallbackUrl,
    onUpdateProgress: bridge.onUpdateProgress,
    onUpdateError: bridge.onUpdateError,
  }
}
