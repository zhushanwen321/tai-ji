/**
 * 按当前平台选择 release 对应的 asset。
 *
 * 与 orchestrator 的 pickAsset 同源逻辑：darwin → macArm64Dmg，win32 → winX64Exe，
 * linux → linuxX64AppImage。抽成独立模块供 orchestrator / preloaded-update 复用，
 * 避免两处平台分流逻辑漂移。
 *
 * 依赖方向：pick-platform-asset → @taiji/shared
 */
import type { LatestReleaseInfo, ReleaseAsset } from '@taiji/shared'

/**
 * 根据 process.platform 选择对应平台 asset。
 *
 * @param release release 信息
 * @returns 当前平台 asset；平台不支持或 asset 缺失返回 undefined
 */
export function pickPlatformAsset(release: LatestReleaseInfo): ReleaseAsset | undefined {
  switch (process.platform) {
    case 'darwin': return release.assets.macArm64Dmg
    case 'win32': return release.assets.winX64Exe
    case 'linux': return release.assets.linuxX64AppImage
    default: return undefined
  }
}

/**
 * 当前平台对应 asset 的 name（用于预下载产物校验）。
 *
 * @param release release 信息
 * @returns asset name；无对应 asset 返回 undefined
 */
export function pickPlatformAssetName(release: LatestReleaseInfo): string | undefined {
  return pickPlatformAsset(release)?.name
}
