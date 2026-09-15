// [测试 mock 接缝 · u18/裁决 4-B] 本层存在的唯一正当理由：为 settings 域 Electron IPC 提供
// 稳定的 vi.mock 目标（8 个测试文件直接 vi.mock 本层）。生产侧为 @/lib/ipc 的逐字 1:1 转发，
// 除聚合外零附加行为；新代码 IPC 调用一律经本层，禁止直取 @/lib/ipc。
//
// 覆盖范围（均直连 main 进程，不走 runtime WS；升级模块运行在 main 进程中）：
// - 代理配置（update:getProxyConfig / update:setProxyConfig / update:testProxy）
// - 升级设置与升级操作（update:getSettings / update:setSettings / update:check /
//   update:download / update:install / 预下载与启动结果 / 进度错误事件订阅）
// - settings 页面通用 IPC（数据目录路径 / 目录选择 dialog / 系统提示音清单）
// settings 域 WS 部分（config/extension 订阅转发 + worktree/smart-context 等 RPC）真源在
// @taiji/core/transport/api/domains/settings，消费方直接 import core 子路径，不经本文件。
import type {
  IProxyConfig,
  UpdateSettings,
  ProxyTestResult,
  LatestReleaseInfo,
  UpdateStage,
  UpdateErrorPayload,
  LaunchResult,
  UpdateCheckResult,
  UpdateInstallResult,
} from '@taiji/shared'
import {
  getProxyConfig as getProxyConfigIpc,
  setProxyConfig as setProxyConfigIpc,
  testProxy as testProxyIpc,
  getUpdateSettings as getUpdateSettingsIpc,
  setUpdateSettings as setUpdateSettingsIpc,
  checkForUpdate as checkForUpdateIpc,
  updateDownload as updateDownloadIpc,
  updateInstall as updateInstallIpc,
  getPreloaded as getPreloadedIpc,
  getPendingUpdate as getPendingUpdateIpc,
  onUpdateProgress as onUpdateProgressIpc,
  onUpdateError as onUpdateErrorIpc,
  getLaunchResult as getLaunchResultIpc,
  openUpdateFallbackUrl as openUpdateFallbackUrlIpc,
  getDataDir as getDataDirIpc,
  openUpdateManualDir as openUpdateManualDirIpc,
  chooseDirectory as chooseDirectoryIpc,
  listSystemSounds as listSystemSoundsIpc,
} from '@/lib/ipc'

// ── 代理配置（update:getProxyConfig / update:setProxyConfig / update:testProxy）──

/** 读取代理配置。 */
export async function getProxyConfig(): Promise<IProxyConfig> {
  return getProxyConfigIpc()
}

/** 保存代理配置。 */
export async function setProxyConfig(config: IProxyConfig): Promise<void> {
  await setProxyConfigIpc(config)
}

/** 测试代理连接。 */
export async function testProxy(config: IProxyConfig): Promise<ProxyTestResult> {
  return testProxyIpc(config)
}

// ── 升级设置（update:getSettings / update:setSettings）──
// 预下载开关等升级偏好，通过 Electron IPC 直接与 main 进程通信（不走 runtime WS）。

/** 读取升级设置。 */
export async function getUpdateSettings(): Promise<UpdateSettings> {
  return getUpdateSettingsIpc()
}

/** 保存升级设置（局部更新：只传要修改的字段）。 */
export async function setUpdateSettings(settings: Partial<UpdateSettings>): Promise<void> {
  await setUpdateSettingsIpc(settings)
}

// ── 升级操作（update:check / update:download / update:install / 预下载与启动结果）──
// useAppUpdate 升级链路消费；与上方升级设置同属 settings 域升级模块。

/** 检测最新可用版本。opts.force 强制刷新缓存（默认走 1h 缓存）。 */
export function checkForUpdate(opts?: { force?: boolean }): Promise<UpdateCheckResult> {
  return checkForUpdateIpc(opts)
}

/** 触发下载阶段（版本解析 → 下载 → 校验，止于 downloaded 态，不替换/重启）。 */
export function updateDownload(version: string): Promise<{ downloaded: boolean }> {
  return updateDownloadIpc(version)
}

/** 触发安装阶段（替换 + 重启）。依赖已下载产物（updateDownload 成功后调用）。 */
export function updateInstall(): Promise<UpdateInstallResult> {
  return updateInstallIpc()
}

/** 读取 main 侧预下载产物（app 启动时恢复 downloaded 态用），无则 null。 */
export function getPreloaded(): Promise<{ release: LatestReleaseInfo; filePath: string } | null> {
  return getPreloadedIpc()
}

/** 读取待提醒的升级版本（升级重启前的 pending 提醒恢复用），无则 null。 */
export function getPendingUpdate(): Promise<LatestReleaseInfo | null> {
  return getPendingUpdateIpc()
}

/** 监听升级进度事件（stage + percent 0-100），返回取消订阅函数。 */
export function onUpdateProgress(cb: (p: { stage: UpdateStage; percent: number }) => void): () => void {
  return onUpdateProgressIpc(cb)
}

/** 监听升级错误事件（stage + message + errorCode + suggestion），返回取消订阅函数。 */
export function onUpdateError(cb: (e: UpdateErrorPayload) => void): () => void {
  return onUpdateErrorIpc(cb)
}

/** 读取启动结果（升级成功/失败/回滚通知）。首次调用返回结果，后续返回 null。 */
export function getLaunchResult(): Promise<LaunchResult | null> {
  return getLaunchResultIpc()
}

/** 不支持当前平台时，打开备用下载页（release 页面）。 */
export function openUpdateFallbackUrl(url: string): Promise<void> {
  return openUpdateFallbackUrlIpc(url)
}

/** 打开手动升级产物目录（main 幂等建目录 + shell.openPath），打开失败 reject。 */
export function openUpdateManualDir(): Promise<{ success: boolean }> {
  return openUpdateManualDirIpc()
}

// ── settings 页面通用 IPC（数据目录路径 / 目录选择 dialog / 系统提示音清单）──
// 消费方均为 settings 页面组件（UpdateCheckCard 路径展示 / ExtensionPage 与
// SettingsResourcePage 的 LoadPaths 目录选择 / SystemSoundSection 提示音清单）。

/** 读取数据目录（~ 缩写展示路径）。无 IPC（web/mock）返回 undefined，调用方需 fallback。 */
export function getDataDir(): Promise<string | undefined> {
  return getDataDirIpc()
}

/** 打开目录选择 dialog，返回所选路径（canceled → null）。 */
export async function chooseDirectory(): Promise<string | null> {
  return chooseDirectoryIpc()
}

/** 当前平台可用系统提示音清单。无 IPC 返回空 sounds。 */
export function listSystemSounds(): Promise<{
  platform: string
  sounds: Array<{ id: string; name: string }>
}> {
  return listSystemSoundsIpc()
}
