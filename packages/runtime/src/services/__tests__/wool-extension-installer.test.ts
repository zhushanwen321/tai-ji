/**
 * WoolExtensionInstaller 测试（provider-plugin-access D6：双产物安装编排的扩展侧步骤）。
 *
 * 覆盖：清单双通道降级（github 成功恒用 github / 双败聚合原因）；版本配对校验
 * （资产版本 ≠ 配对版本 → VERSION_PAIR_MISMATCH 不安装）；钉版本安装 + 扫描确认；
 * 安装链成功但扫描未见 = install_failed（不假装成功）；卸载与已装查询。
 * 网络出口与清单地址全部注入，零真实网络。
 *
 * 测试框架：vitest。运行：cd packages/runtime && npx vitest run wool
 */
import { describe, it, expect, vi } from 'vitest'
import {
  WoolExtensionInstaller,
  WoolExtensionInstallError,
  VERSION_PAIR_MISMATCH,
  DEFAULT_WOOL_MANIFEST_URL,
  type WoolExtensionInstallerDeps,
  type WoolAssetManifest,
} from '../wool-extension-installer.js'

const MANIFEST: WoolAssetManifest = {
  schemaVersion: 1,
  generatedAt: 1_700_000_000_000,
  families: {
    workbuddy: {
      pkg: '@zhushanwen/pi-wool-workbuddy',
      version: '0.2.0',
      displayName: 'WorkBuddy',
      vendor: '腾讯',
      credentialsSource: 'oauth',
      riskNotice: '非官方接口',
    },
    qoder: {
      pkg: '@zhushanwen/pi-wool-qoder',
      version: '0.1.9',
      displayName: 'Qoder',
      vendor: '阿里',
      credentialsSource: 'ide-extract',
      riskNotice: '非官方接口',
    },
  },
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function makeDeps(overrides: Partial<WoolExtensionInstallerDeps> = {}): WoolExtensionInstallerDeps {
  const extensionService: WoolExtensionInstallerDeps['extensionService'] = {
    scanExtensions: vi.fn(async () => [{ name: '@zhushanwen/pi-wool-workbuddy', version: '0.2.0', enabled: true }]),
    installExtension: vi.fn(async () => {}),
    uninstallExtension: vi.fn(async () => {}),
  }
  return {
    extensionService,
    manifestUrl: 'https://fixture.test/wool-manifest.json',
    fetchFn: vi.fn(async () => jsonOk(MANIFEST)),
    ...overrides,
  }
}

describe('WoolExtensionInstaller（D6 双产物安装编排·扩展侧）', () => {
  it('installPiExtension：配对一致 → 钉清单版本安装 + 扫描确认', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    const result = await installer.installPiExtension('workbuddy', '0.2.0')

    expect(vi.mocked(deps.extensionService.installExtension)).toHaveBeenCalledWith('npm:@zhushanwen/pi-wool-workbuddy@0.2.0')
    expect(result).toEqual({ installedVersion: '0.2.0' })
  })

  it('版本配对不一致 → VERSION_PAIR_MISMATCH 拒绝，不执行安装（不落半成品）', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('workbuddy', '0.3.0')).rejects.toMatchObject({
      code: VERSION_PAIR_MISMATCH,
    })
    expect(vi.mocked(deps.extensionService.installExtension)).not.toHaveBeenCalled()
  })

  it('清单无该家族条目 → family_absent', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('trae', '0.1.0')).rejects.toMatchObject({
      code: 'family_absent',
    })
  })

  it('清单不可达（显式单源失败）→ unreachable，错误含恢复指引', async () => {
    const deps = makeDeps({ fetchFn: vi.fn(async () => new Response('boom', { status: 503 })) })
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('workbuddy', '0.2.0')).rejects.toMatchObject({
      code: 'unreachable',
    })
  })

  it('清单坏形状 → bad_shape', async () => {
    const deps = makeDeps({ fetchFn: vi.fn(async () => jsonOk({ schemaVersion: 2 })) })
    const installer = new WoolExtensionInstaller(deps)

    const result = await installer.fetchManifest()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('bad_shape')
  })

  it('缺省双通道：github 成功恒用 github（gitcode 滞后镜像不消费）', async () => {
    const staleManifest: WoolAssetManifest = {
      ...MANIFEST,
      families: { ...MANIFEST.families, workbuddy: { ...MANIFEST.families.workbuddy!, version: '0.0.1' } },
    }
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('github.com')) return jsonOk(MANIFEST)
      return jsonOk([{ prerelease: false, assets: [{ name: 'wool-manifest.json', browser_download_url: 'https://mirror.test/m.json' }] }])
    })
    const installer = new WoolExtensionInstaller({ extensionService: makeDeps().extensionService, fetchFn })

    const result = await installer.fetchManifest()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.families.workbuddy?.version).toBe('0.2.0')
    // 双通道并发各走完整通道：github 直拉 1 次 + gitcode 两跳 2 次（资产走镜像直链）；结果仍取 github。
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(fetchFn.mock.calls.every((call) => {
      const url = String(call[0])
      return url.includes(DEFAULT_WOOL_MANIFEST_URL) || url.includes('gitcode') || url.includes('mirror.test')
    })).toBe(true)
  })

  it('安装链成功但扫描未见 → install_failed（不假装成功）', async () => {
    const deps = makeDeps()
    vi.mocked(deps.extensionService.scanExtensions).mockResolvedValue([])
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('workbuddy', '0.2.0')).rejects.toMatchObject({
      code: 'install_failed',
    })
  })

  it('卸载走既有 uninstallExtension 链；失败转 uninstall_failed', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await installer.uninstallPiExtension('workbuddy')
    expect(vi.mocked(deps.extensionService.uninstallExtension)).toHaveBeenCalledWith('@zhushanwen/pi-wool-workbuddy')

    vi.mocked(deps.extensionService.uninstallExtension).mockRejectedValue(new Error('npm uninstall failed'))
    await expect(installer.uninstallPiExtension('workbuddy')).rejects.toBeInstanceOf(WoolExtensionInstallError)
  })

  it('scanInstalledVersion：已装回版本，未装回 undefined', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)
    expect(await installer.scanInstalledVersion('workbuddy')).toBe('0.2.0')

    vi.mocked(deps.extensionService.scanExtensions).mockResolvedValue([])
    expect(await installer.scanInstalledVersion('workbuddy')).toBeUndefined()
  })
})
