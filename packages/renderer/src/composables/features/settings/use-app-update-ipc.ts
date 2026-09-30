/**
 * useAppUpdate 的 ipc 依赖缝（seam）。
 *
 * 本接口是 useAppUpdate 控制器对 settings 域升级 IPC 的全部依赖面（10 个方法与
 * @/api/domains/settings 现有导出一一对齐）。控制器与各轴工厂只认本接口：
 * 生产装配传 createRealAppUpdateIpc()（逐函数转发 @/api/domains/settings），
 * 测试注入内存 adapter——依赖方向反转后测试无需 vi.mock @/api 层。
 */
import type {
  LatestReleaseInfo,
  LaunchResult,
  UpdateCheckResult,
  UpdateErrorPayload,
  UpdateInstallResult,
  UpdateSettings,
  UpdateStage,
} from '@taiji/shared'
import {
  checkForUpdate as checkForUpdateApi,
  updateDownload as updateDownloadApi,
  updateInstall as updateInstallApi,
  openUpdateFallbackUrl as openUpdateFallbackUrlApi,
  getPreloaded as getPreloadedApi,
  getPendingUpdate as getPendingUpdateApi,
  getLaunchResult as getLaunchResultApi,
  getUpdateSettings as getUpdateSettingsApi,
  onUpdateProgress as onUpdateProgressApi,
  onUpdateError as onUpdateErrorApi,
} from '@/api/domains/settings'

/** useAppUpdate 的 ipc 依赖面（与 @/api/domains/settings 的升级导出一一对应） */
export interface AppUpdateIpc {
  /** 检测最新可用版本。opts.force 强制刷新缓存（默认走 1h 缓存） */
  checkForUpdate(opts?: { force?: boolean }): Promise<UpdateCheckResult>
  /** 触发下载阶段（版本解析 → 下载 → 校验，止于 downloaded 态） */
  updateDownload(version: string): Promise<{ downloaded: boolean }>
  /** 触发安装阶段（替换 + 重启）。依赖已下载产物 */
  updateInstall(): Promise<UpdateInstallResult>
  /** 读取 main 侧预下载产物，无则 null */
  getPreloaded(): Promise<{ release: LatestReleaseInfo; filePath: string } | null>
  /** 读取待提醒的升级版本，无则 null */
  getPendingUpdate(): Promise<LatestReleaseInfo | null>
  /** 读取启动结果（升级成功/失败/回滚通知），consumed 一次性 */
  getLaunchResult(): Promise<LaunchResult | null>
  /** 读取升级设置（autoUpdate / preDownload 等） */
  getUpdateSettings(): Promise<UpdateSettings>
  /** 不支持当前平台时，打开备用下载页（release 页面） */
  openUpdateFallbackUrl(url: string): Promise<void>
  /** 监听升级进度事件（stage + percent 0-100），返回取消订阅函数 */
  onUpdateProgress(cb: (p: { stage: UpdateStage; percent: number }) => void): () => void
  /** 监听升级错误事件（stage + message + errorCode + suggestion），返回取消订阅函数 */
  onUpdateError(cb: (e: UpdateErrorPayload) => void): () => void
}

/** 真实 adapter：逐函数转发 @/api/domains/settings（生产装配缺省值） */
export function createRealAppUpdateIpc(): AppUpdateIpc {
  return {
    checkForUpdate: (opts) => checkForUpdateApi(opts),
    updateDownload: (version) => updateDownloadApi(version),
    updateInstall: () => updateInstallApi(),
    getPreloaded: () => getPreloadedApi(),
    getPendingUpdate: () => getPendingUpdateApi(),
    getLaunchResult: () => getLaunchResultApi(),
    getUpdateSettings: () => getUpdateSettingsApi(),
    openUpdateFallbackUrl: (url) => openUpdateFallbackUrlApi(url),
    onUpdateProgress: (cb) => onUpdateProgressApi(cb),
    onUpdateError: (cb) => onUpdateErrorApi(cb),
  }
}
