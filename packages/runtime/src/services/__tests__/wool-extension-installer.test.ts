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

  it('缺省双通道双败 → unreachable，message 聚合 github/gitcode 两通道 detail', async () => {
    // 双败聚合分支（fetchManifest 缺省路径 :201-209）：错误信封拼装两通道原因——
    // 排障时用户能看到「哪条通道、各自败因」，单源用例触不到本分支
    const fetchFn = vi.fn(async () => new Response('boom', { status: 503 }))
    const installer = new WoolExtensionInstaller({ extensionService: makeDeps().extensionService, fetchFn })

    const err = await installer.installPiExtension('workbuddy', '0.2.0').then(
      () => { throw new Error('expected rejection') },
      (e: unknown) => e as Error & { code?: string },
    )

    expect(err.code).toBe('unreachable')
    expect(err.message).toContain('github：HTTP 503')
    expect(err.message).toContain('gitcode：HTTP 503')
    // github 直拉 1 次 + gitcode releases 首跳即败 1 次（两跳完整路径只在成功时走满）
    expect(fetchFn).toHaveBeenCalledTimes(2)
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

describe('fetchManifest 缓存与时点差自愈（D6：清单热更新后重试自愈）', () => {
  it('成功结果进内存缓存：第二次 fetchManifest 不发网络', async () => {
    const fetchFn = vi.fn(async () => jsonOk(MANIFEST))
    const installer = new WoolExtensionInstaller({ extensionService: makeDeps().extensionService, manifestUrl: 'https://fixture.test/m.json', fetchFn })

    await installer.fetchManifest()
    await installer.fetchManifest()

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('force: true 跳过缓存强制重拉，重拉成功后覆盖缓存', async () => {
    const refreshed: WoolAssetManifest = {
      ...MANIFEST,
      families: { ...MANIFEST.families, workbuddy: { ...MANIFEST.families.workbuddy!, version: '0.3.0' } },
    }
    let call = 0
    const fetchFn = vi.fn(async () => jsonOk(call++ === 0 ? MANIFEST : refreshed))
    const installer = new WoolExtensionInstaller({ extensionService: makeDeps().extensionService, manifestUrl: 'https://fixture.test/m.json', fetchFn })

    await installer.fetchManifest()
    const second = await installer.fetchManifest({ force: true })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.manifest.families.workbuddy?.version).toBe('0.3.0')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    // 重拉后的新清单成为缓存：第三次无 force 读取不再发网络
    await installer.fetchManifest()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('时点差自愈：缓存清单落后 → mismatch 触发强制重拉 → 新清单配对一致 → 安装成功', async () => {
    // 第一跳（缓存填充）回旧清单 0.1.9；mismatch 后 force 重拉回新清单 0.2.0（模拟
    // v2-plugins 配对权威先行热更新、wool-manifest 随后跟上的时点差窗口关闭）。
    const refreshed: WoolAssetManifest = {
      ...MANIFEST,
      families: { ...MANIFEST.families, qoder: { ...MANIFEST.families.qoder!, version: '0.2.0' } },
    }
    let call = 0
    const fetchFn = vi.fn(async () => jsonOk(call++ === 0 ? MANIFEST : refreshed))
    const deps = makeDeps({ fetchFn })
    vi.mocked(deps.extensionService.scanExtensions).mockResolvedValue([
      { name: '@zhushanwen/pi-wool-qoder', version: '0.2.0', enabled: true },
    ])
    const installer = new WoolExtensionInstaller(deps)

    const result = await installer.installPiExtension('qoder', '0.2.0')

    expect(result).toEqual({ installedVersion: '0.2.0' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.extensionService.installExtension)).toHaveBeenCalledWith('npm:@zhushanwen/pi-wool-qoder@0.2.0')
  })

  it('时点差未收敛：强制重拉后仍不一致 → VERSION_PAIR_MISMATCH（原文案保留）', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installPiExtension('workbuddy', '0.3.0')).rejects.toMatchObject({
      code: VERSION_PAIR_MISMATCH,
      message: expect.stringContaining('清单热更新后自愈'),
    })
    // 首拉（缓存填充）+ mismatch 强制重拉 = 2 次网络；安装未执行（不落半成品）
    expect(vi.mocked(deps.fetchFn!)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.extensionService.installExtension)).not.toHaveBeenCalled()
  })
})

describe('installForCatalogEntry（U7 接线：v2-plugins 清单条目 → 家族推导 → 钉版安装）', () => {
  it('plugin-wool-<family> 包名推导家族 → 配对校验 + 安装', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    const result = await installer.installForCatalogEntry({
      packageName: '@zhushanwen/plugin-wool-workbuddy',
      piExtensionVersion: '0.2.0',
    })

    expect(result).toEqual({ installedVersion: '0.2.0' })
    expect(vi.mocked(deps.extensionService.installExtension)).toHaveBeenCalledWith('npm:@zhushanwen/pi-wool-workbuddy@0.2.0')
  })

  it('非 plugin-wool-* 包名（清单指向未知家族）→ family_unknown 结构化拒绝，不安装', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.installForCatalogEntry({
      packageName: '@acme/some-other-plugin',
      piExtensionVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'family_unknown' })
    expect(vi.mocked(deps.extensionService.installExtension)).not.toHaveBeenCalled()
  })

  it('plugin-wool- 前缀但家族不在词表 → family_unknown', async () => {
    const installer = new WoolExtensionInstaller(makeDeps())

    await expect(installer.installForCatalogEntry({
      packageName: '@zhushanwen/plugin-wool-nosuch',
      piExtensionVersion: '1.0.0',
    })).rejects.toMatchObject({ code: 'family_unknown' })
  })
})

describe('uninstallForCatalogEntry（U4 接线：包名 → 家族推导 → 卸载；plugin-service.uninstallPlugin 消费）', () => {
  it('plugin-wool-<family> 包名推导家族 → uninstallExtension 以 pi-wool-<family> 包名执行', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await installer.uninstallForCatalogEntry('@zhushanwen/plugin-wool-workbuddy')

    expect(vi.mocked(deps.extensionService.uninstallExtension)).toHaveBeenCalledWith('@zhushanwen/pi-wool-workbuddy')
  })

  it('非 plugin-wool-* 包名（单产物插件）→ no-op 不触碰扩展目录', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await installer.uninstallForCatalogEntry('@acme/some-other-plugin')

    expect(vi.mocked(deps.extensionService.uninstallExtension)).not.toHaveBeenCalled()
  })

  it('plugin-wool- 前缀但家族不在词表 → no-op（卸载侧包名事实源 = 磁盘 package.json，非清单，无 guard 契约可违反）', async () => {
    const deps = makeDeps()
    const installer = new WoolExtensionInstaller(deps)

    await expect(installer.uninstallForCatalogEntry('@zhushanwen/plugin-wool-nosuch')).resolves.toBeUndefined()
    expect(vi.mocked(deps.extensionService.uninstallExtension)).not.toHaveBeenCalled()
  })
})
