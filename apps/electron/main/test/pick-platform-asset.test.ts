/**
 * pick-platform-asset 单元测试（I#7 test-coverage）。
 *
 * 覆盖 pickPlatformAsset / pickPlatformAssetName 全部导出：
 *   1. darwin → macArm64Dmg
 *   2. win32 → winX64Exe
 *   3. linux → linuxX64AppImage
 *   4. unknown（如 freebsd/aix）→ undefined
 *   5. 平台 asset 缺失（release 未发布该平台产物）→ undefined
 *   6. pickPlatformAssetName 返回对应 asset 的 name（或 undefined）
 *
 * 之前仅经 preloaded-update / orchestrator 间接覆盖 darwin/win/linux，
 * 未覆盖 default → undefined 分支与各平台资产缺失分支。本测试补齐独立单测。
 *
 * Mock 策略（对齐 shell-env.test.ts / orchestrator.test.ts）：
 * - process.platform 只读，用 Object.defineProperty 桩（configurable:true 便于还原）
 * - pickPlatformAsset 在函数体内读 process.platform（非模块加载时），无需 vi.resetModules
 *
 * 运行：npx vitest run apps/electron/main/test/pick-platform-asset.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { LatestReleaseInfo, ReleaseAsset } from '@taiji/shared'
import { pickPlatformAsset, pickPlatformAssetName } from '../update/pick-platform-asset.js'

const ORIG_PLATFORM = process.platform

/** 临时覆盖 process.platform（只读属性，需 Object.defineProperty）。 */
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** 构造包含全部 3 个平台 asset 的 release fixture。 */
function makeFullRelease(): LatestReleaseInfo {
  return {
    version: '0.9.0',
    tagName: 'v0.9.0',
    releaseNotes: '## What changed\n- pick-platform-asset fixture',
    publishedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
    assets: {
      macArm64Dmg: {
        name: 'TaiJi-0.10.0-mac-arm64.dmg',
        downloadUrl: 'https://example.com/mac.dmg',
        size: 1000,
        sha256: 'a'.repeat(64),
      },
      winX64Exe: {
        name: 'TaiJi-0.10.0-win-x64.exe',
        downloadUrl: 'https://example.com/win.exe',
        size: 2000,
        sha256: 'b'.repeat(64),
      },
      linuxX64AppImage: {
        name: 'TaiJi-0.10.0-linux-x64.AppImage',
        downloadUrl: 'https://example.com/linux.AppImage',
        size: 3000,
        sha256: 'c'.repeat(64),
      },
    },
  }
}

beforeEach(() => {
  // 默认还原平台，单个用例内自行 setPlatform
  setPlatform(ORIG_PLATFORM)
})

afterEach(() => {
  setPlatform(ORIG_PLATFORM)
})

describe('pickPlatformAsset', () => {
  it('darwin → 返回 macArm64Dmg asset', () => {
    setPlatform('darwin')
    const asset = pickPlatformAsset(makeFullRelease())
    expect(asset?.name).toBe('TaiJi-0.10.0-mac-arm64.dmg')
    expect(asset?.size).toBe(1000)
  })

  it('win32 → 返回 winX64Exe asset', () => {
    setPlatform('win32')
    const asset = pickPlatformAsset(makeFullRelease())
    expect(asset?.name).toBe('TaiJi-0.10.0-win-x64.exe')
    expect(asset?.size).toBe(2000)
  })

  it('linux → 返回 linuxX64AppImage asset', () => {
    setPlatform('linux')
    const asset = pickPlatformAsset(makeFullRelease())
    expect(asset?.name).toBe('TaiJi-0.10.0-linux-x64.AppImage')
    expect(asset?.size).toBe(3000)
  })

  it('unknown 平台（如 freebsd）→ 返回 undefined（覆盖 default 分支）', () => {
    setPlatform('freebsd')
    const asset = pickPlatformAsset(makeFullRelease())
    expect(asset).toBeUndefined()
  })

  it('当前平台 asset 缺失（release 未发布该平台产物）→ 返回 undefined', () => {
    setPlatform('darwin')
    const release = makeFullRelease()
    // 删掉 mac 产物，模拟 release 未提供 mac 包
    delete release.assets.macArm64Dmg
    const asset = pickPlatformAsset(release)
    expect(asset).toBeUndefined()
  })
})

describe('pickPlatformAssetName', () => {
  it('darwin → 返回 macArm64Dmg.name', () => {
    setPlatform('darwin')
    expect(pickPlatformAssetName(makeFullRelease())).toBe('TaiJi-0.10.0-mac-arm64.dmg')
  })

  it('win32 → 返回 winX64Exe.name', () => {
    setPlatform('win32')
    expect(pickPlatformAssetName(makeFullRelease())).toBe('TaiJi-0.10.0-win-x64.exe')
  })

  it('linux → 返回 linuxX64AppImage.name', () => {
    setPlatform('linux')
    expect(pickPlatformAssetName(makeFullRelease())).toBe('TaiJi-0.10.0-linux-x64.AppImage')
  })

  it('unknown 平台 → 返回 undefined', () => {
    setPlatform('aix')
    expect(pickPlatformAssetName(makeFullRelease())).toBeUndefined()
  })

  it('平台 asset 缺失 → 返回 undefined', () => {
    setPlatform('linux')
    const release = makeFullRelease()
    delete release.assets.linuxX64AppImage
    expect(pickPlatformAssetName(release)).toBeUndefined()
  })

  it('返回的 name 与 pickPlatformAsset 返回对象的 name 一致', () => {
    setPlatform('darwin')
    const release = makeFullRelease()
    const asset: ReleaseAsset | undefined = pickPlatformAsset(release)
    const name: string | undefined = pickPlatformAssetName(release)
    expect(name).toBe(asset?.name)
  })
})
