/**
 * extension-upgrade.test.ts — W1 wave: extension upgrade + auto-upgrade tests.
 *
 * TDD 红灯阶段：这些测试覆盖本次 wave 的预期行为，在实现前全部失败。
 *
 * 覆盖点：
 * 1. IExtensionSettings port: getAutoUpgrade / setAutoUpgrade（auto-upgrade 开关持久化）
 * 2. IInstaller port: getLatestVersion（从 npm registry 获取 latest 版本号）
 * 3. ExtensionService.upgradeExtension()（单个扩展升级：检查 latest → semver.lt → npm install → 重载）
 * 4. ExtensionService.checkAndAutoUpgrade()（启动时批量检查 + 静默升级，失败不阻塞）
 * 5. Protocol: extension.upgrade / extension.setAutoUpgrade WS 消息
 * 6. ExtensionMessageHandler: 处理 upgrade 相关消息
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExtensionService, ExtensionInstallError } from '../src/services/extension-service.js'
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js'
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js'
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'

// Mock npm-installer functions
vi.mock('../src/infra/installers/npm-installer.js', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  installDependencies: vi.fn(),
  fetchLatestVersion: vi.fn(),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  },
}))

// Mock child_process for git
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}))

/**
 * Phase 1 路径迁移适配：extensions/npm/tmp 已从 settingsDir 子树迁出到 dataDir 根层，
 * ExtensionService/ExtensionResolver 不再 join(settingsDir, ...)。此工厂把三个目录注入回
 * testSettingsDir 子目录，让现有 fixture（settingsDir/npm、settingsDir/extensions、settingsDir/tmp）继续生效。
 * 只需传 installer 和 extensionSettings（各测试差异点），路径注入统一在此收口。
 */
function createExtensionService(
  testSettingsDir: string,
  installer: NpmGitInstaller,
  extensionSettings: PiExtensionSettings,
): ExtensionService {
  return new ExtensionService({
    settingsDir: testSettingsDir,
    projectRoot: process.cwd(),
    installer,
    resolver: new ExtensionResolver({
      settingsDir: testSettingsDir,
      thirdPartyDir: join(testSettingsDir, 'extensions'),
      npmDir: join(testSettingsDir, 'npm'),
    }),
    extensionSettings,
    extensionsDir: join(testSettingsDir, 'extensions'),
    npmDir: join(testSettingsDir, 'npm'),
    tmpDir: join(testSettingsDir, 'tmp'),
  })
}

describe('Extension Upgrade', () => {
  let testSettingsDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    testSettingsDir = mkdtempSync(join(tmpdir(), 'ext-upgrade-test-'))
    // RT-3#12：PiExtensionSettings 构造不再对齐全局 settings 路径（去全局化），
    // 测试显式注入 setSettingsPath 指向 testSettingsDir（全仓测试惯例）。
    setSettingsPath(join(testSettingsDir, 'settings.json'))

    // Create settings.json with a user-installed extension
    writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({
      packages: ['npm:pi-test-ext'],
    }), 'utf-8')

    // Create the installed extension with version 1.0.0
    const extDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-test-ext')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'package.json'), JSON.stringify({
      name: 'pi-test-ext',
      version: '1.0.0',
      description: 'Test extension',
      keywords: ['pi-package'],
      peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
    }), 'utf-8')
    writeFileSync(join(extDir, 'index.ts'), '', 'utf-8')

    // npm dir package.json
    writeFileSync(join(testSettingsDir, 'npm', 'package.json'), JSON.stringify({ private: true }), 'utf-8')
  })

  afterEach(() => {
    try { rmSync(testSettingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
  })

  // ── 1. IExtensionSettings: autoUpgrade 持久化 ─────────────────

  describe('IExtensionSettings: autoUpgrade', () => {
    it('getAutoUpgrade returns empty array when no auto-upgrade config exists', () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      const autoUpgrades = settings.getAutoUpgrade()
      expect(autoUpgrades).toEqual([])
    })

    it('setAutoUpgrade persists auto-upgrade setting to auto-upgrade-packages.json', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Verify file was written
      const filePath = join(testSettingsDir, 'auto-upgrade-packages.json')
      expect(existsSync(filePath)).toBe(true)

      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(data.autoUpgrade).toContain('npm:pi-test-ext')

      // Verify getAutoUpgrade reads it back
      expect(settings.getAutoUpgrade()).toContain('npm:pi-test-ext')
    })

    it('setAutoUpgrade(false) removes from auto-upgrade list', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)
      await settings.setAutoUpgrade('npm:pi-test-ext', false)

      expect(settings.getAutoUpgrade()).not.toContain('npm:pi-test-ext')
    })

    it('setAutoUpgrade is idempotent for same source', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      const filePath = join(testSettingsDir, 'auto-upgrade-packages.json')
      const data = JSON.parse(readFileSync(filePath, 'utf-8'))
      // Should only appear once
      const count = data.autoUpgrade.filter((s: string) => s === 'npm:pi-test-ext').length
      expect(count).toBe(1)
    })
  })

  // ── 2. IInstaller: getLatestVersion ────────────────────────────

  describe('IInstaller.getLatestVersion', () => {
    it('getLatestVersion returns latest version string from npm registry', async () => {
      const { fetchLatestVersion } = await import('../src/infra/installers/npm-installer.js')
      const mockedFetch = vi.mocked(fetchLatestVersion)
      mockedFetch.mockResolvedValue('2.0.0')

      const installer = new NpmGitInstaller()
      const result = await installer.getLatestVersion('pi-test-ext')
      expect(result).toBe('2.0.0')
    })

    it('getLatestVersion throws NpmInstallError for non-existent package', async () => {
      const { fetchLatestVersion, NpmInstallError } = await import('../src/infra/installers/npm-installer.js')
      const mockedFetch = vi.mocked(fetchLatestVersion)
      mockedFetch.mockRejectedValue(new NpmInstallError('not_found', 'Package not found'))

      const installer = new NpmGitInstaller()
      await expect(installer.getLatestVersion('nonexistent-pkg-foo-12345'))
        .rejects.toMatchObject({ code: 'not_found' })
    })
  })

  // ── 3. ExtensionService.upgradeExtension ──────────────────────

  describe('ExtensionService.upgradeExtension', () => {
    it('upgrades extension when latest version is newer', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Mock installPackage to update the installed version
      mockedInstall.mockImplementation(async (_spec, nodeModulesDir) => {
        const pkgDir = join(nodeModulesDir, 'pi-test-ext')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'pi-test-ext',
          version: '2.0.0',
          description: 'Test extension upgraded',
          keywords: ['pi-package'],
          peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
        }), 'utf-8')
        writeFileSync(join(pkgDir, 'index.ts'), '', 'utf-8')
      })

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const result = await service.upgradeExtension('pi-test-ext')
      expect(result).toEqual({ upgraded: true, from: '1.0.0', to: '2.0.0' })
    })

    it('returns upgraded=false when already at latest version', async () => {
      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('1.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const result = await service.upgradeExtension('pi-test-ext')
      expect(result).toEqual({ upgraded: false, from: '1.0.0', to: '1.0.0' })
    })

    it('throws for non-user-installed (built-in) extensions', async () => {
      // Create a built-in extension in the thirdPartyDir (extensions/)
      // so the resolver can find it, but it's NOT in settings packages[]
      const extDir = join(testSettingsDir, 'extensions', 'pi-builtin-ext')
      mkdirSync(extDir, { recursive: true })
      writeFileSync(join(extDir, 'package.json'), JSON.stringify({
        name: 'pi-builtin-ext',
        version: '1.0.0',
        description: 'Built-in extension',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      writeFileSync(join(extDir, 'index.ts'), '', 'utf-8')

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      await expect(service.upgradeExtension('pi-builtin-ext'))
        .rejects.toThrow('Built-in extensions cannot be upgraded')
    })

    it('throws for non-existent extension', async () => {
      const installer = new NpmGitInstaller()

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      await expect(service.upgradeExtension('nonexistent-ext'))
        .rejects.toThrow('Extension not installed')
    })

    it('rolls back and throws not_extension when upgraded package is invalid (U6)', async () => {
      const { installPackage, uninstallPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)
      const mockedUninstall = vi.mocked(uninstallPackage)

      // Mock installPackage to write an INVALID extension (no pi manifest fields)
      mockedInstall.mockImplementation(async (_spec, nodeModulesDir) => {
        const pkgDir = join(nodeModulesDir, 'pi-test-ext')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'pi-test-ext',
          version: '2.0.0',
          // Missing keywords/peerDependencies — not a valid pi extension
        }), 'utf-8')
      })

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      await expect(service.upgradeExtension('pi-test-ext'))
        .rejects.toSatisfy((err: unknown) => {
          return err instanceof ExtensionInstallError && err.code === 'not_extension'
        })
      // Rollback uninstall should have been called
      expect(mockedUninstall).toHaveBeenCalledWith('pi-test-ext', expect.any(String))
    })

    it('classifies installNpm network error and does not rollback (U7)', async () => {
      const { NpmInstallError } = await import('../src/infra/installers/npm-installer.js')
      const { installPackage, uninstallPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)
      const mockedUninstall = vi.mocked(uninstallPackage)

      mockedInstall.mockRejectedValue(new NpmInstallError('network', 'ETIMEDOUT'))

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      await expect(service.upgradeExtension('pi-test-ext'))
        .rejects.toSatisfy((err: unknown) => {
          return err instanceof ExtensionInstallError && err.code === 'network'
        })
      // Network failure before install completes — no rollback
      expect(mockedUninstall).not.toHaveBeenCalled()
    })
  })

  // ── 4. ExtensionService.checkAndAutoUpgrade ───────────────────

  describe('ExtensionService.checkAndAutoUpgrade', () => {
    it('upgrades extensions with autoUpgrade enabled', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Enable auto-upgrade for pi-test-ext
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Mock installPackage to update version
      mockedInstall.mockImplementation(async (_spec, nodeModulesDir) => {
        const pkgDir = join(nodeModulesDir, 'pi-test-ext')
        mkdirSync(pkgDir, { recursive: true })
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'pi-test-ext',
          version: '2.0.0',
          description: 'Auto-upgraded',
          keywords: ['pi-package'],
          peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
        }), 'utf-8')
        writeFileSync(join(pkgDir, 'index.ts'), '', 'utf-8')
      })

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, settings)

      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({ name: 'pi-test-ext', upgraded: true, from: '1.0.0', to: '2.0.0' })
    })

    it('skips extensions without autoUpgrade enabled', async () => {
      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(0)
    })

    it('does not block startup on upgrade failure', async () => {
      const { installPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedInstall = vi.mocked(installPackage)

      // Enable auto-upgrade
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      // Mock installPackage to throw
      mockedInstall.mockRejectedValue(new Error('Network error'))

      const installer = new NpmGitInstaller()
      vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, settings)

      // Should not throw — failures are collected, not propagated
      const results = await service.checkAndAutoUpgrade()
      expect(results).toHaveLength(1)
      expect(results[0].upgraded).toBe(false)
      expect(results[0].error).toBeDefined()
    })

    it('skips built-in extensions even if somehow in autoUpgrade list', async () => {
      // Create a built-in extension
      const builtinDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-builtin-ext')
      mkdirSync(builtinDir, { recursive: true })
      writeFileSync(join(builtinDir, 'package.json'), JSON.stringify({
        name: 'pi-builtin-ext',
        version: '1.0.0',
        description: 'Built-in',
        keywords: ['pi-package'],
      }), 'utf-8')

      // Manually write auto-upgrade file with built-in extension
      writeFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), JSON.stringify({
        autoUpgrade: ['npm:pi-builtin-ext', 'npm:pi-test-ext'],
      }), 'utf-8')

      const installer = new NpmGitInstaller()
      const spy = vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('2.0.0')

      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const results = await service.checkAndAutoUpgrade()
      // Should only check pi-test-ext (user-installed), not pi-builtin-ext
      expect(spy).not.toHaveBeenCalledWith('pi-builtin-ext')
    })
  })

  // ── 5. Protocol messages ─────────────────────────────────────
  // 此前三个用 `typeof T extends {...}` 的编译期恒真断言（删掉 shared 字段仍全绿），
  // 替换为运行时行为校验：handler 的 handles 清单实际认领了这两个消息类型。

  describe('Protocol: extension.upgrade / extension.setAutoUpgrade routing', () => {
    it('ExtensionMessageHandler.handles 认领 extension.upgrade', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const handler = new ExtensionMessageHandler({} as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      expect(handler.handles).toContain('extension.upgrade')
    })

    it('ExtensionMessageHandler.handles 认领 extension.setAutoUpgrade', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const handler = new ExtensionMessageHandler({} as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      expect(handler.handles).toContain('extension.setAutoUpgrade')
    })
  })

  // ── 6. ExtensionMessageHandler ────────────────────────────────
  // 此前两个测试只断言 `typeof ExtensionMessageHandler === 'function'`，无 handler 逻辑覆盖。
  // 替换为真正的 handler 调用测试（参考 workspace-message-handler.test.ts 的 mock ctx 写法）。

  describe('ExtensionMessageHandler: upgrade messages', () => {
    /**
     * 构造 mock ctx + 捕获 reply/sendError。
     * 与 workspace-message-handler.test.ts 同构：reply 走 cap.replies，sendError 走 cap.errors。
     */
    function createMockCtx(overrides?: {
      extensionService?: Partial<Record<string, unknown>> | null
    }) {
      const cap = {
        replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>,
        errors: [] as Array<{ id: string | undefined; code: string; message: string; details?: unknown }>,
        broadcasts: [] as Array<{ type: string; payload: Record<string, unknown> }>,
      }
      const extensionService = overrides?.extensionService === null
        ? undefined
        : {
            scanExtensions: vi.fn().mockResolvedValue([{ name: 'pi-test-ext', version: '2.0.0' }]),
            upgradeExtension: vi.fn(),
            setAutoUpgrade: vi.fn().mockResolvedValue(undefined),
            ...overrides?.extensionService,
          }
      const ctx = {
        send: vi.fn(),
        sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: unknown) => {
          cap.errors.push({ id, code, message, details })
        }),
        reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
          cap.replies.push({ id, type, payload })
        }),
        broadcast: vi.fn((msg: { type: string; payload: Record<string, unknown> }) => {
          cap.broadcasts.push({ type: msg.type, payload: msg.payload })
        }),
        nextPushId: vi.fn().mockReturnValue('push_1'),
        sessionService: { getRpcClient: vi.fn().mockReturnValue(undefined) },
        extensionService,
        extensionTimeoutMgr: { isBridgeRequest: vi.fn().mockReturnValue(false), clearTimeout: vi.fn() },
      }
      return { ctx, cap }
    }

    const WS = {} as never

    it('extension.upgrade → upgradeExtension 成功后 reply config.extensions 含 upgradeResult', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const { ctx, cap } = createMockCtx({
        extensionService: {
          upgradeExtension: vi.fn().mockResolvedValue({ upgraded: true, from: '1.0.0', to: '2.0.0' }),
        },
      })
      const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      const msg = { type: 'extension.upgrade', id: 'req1', payload: { name: 'pi-test-ext' } } as unknown as import('@taiji/shared').ClientMessage

      await handler.handleExtensionMessage(msg, WS)

      expect(ctx.extensionService!.upgradeExtension).toHaveBeenCalledWith('pi-test-ext')
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]).toMatchObject({ id: 'req1', type: 'config.extensions' })
      expect(cap.replies[0].payload.upgradeResult).toEqual({ upgraded: true, from: '1.0.0', to: '2.0.0' })
    })

    it('extension.upgrade 空 name → reply invalid_payload 错误，不调 upgradeExtension', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const { ctx, cap } = createMockCtx()
      const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      const msg = { type: 'extension.upgrade', id: 'req2', payload: { name: '' } } as unknown as import('@taiji/shared').ClientMessage

      await handler.handleExtensionMessage(msg, WS)

      expect(ctx.extensionService!.upgradeExtension).not.toHaveBeenCalled()
      expect(cap.replies).toHaveLength(0)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'req2', code: 'invalid_payload' })
    })

    it('extension.upgrade 底层抛 ExtensionInstallError → 走 sendInstallError 透传 code/hint', async () => {
      const { ExtensionInstallError } = await import('../src/services/extension-service.js')
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const { ctx, cap } = createMockCtx({
        extensionService: {
          upgradeExtension: vi.fn().mockRejectedValue(
            new ExtensionInstallError('network', 'npm install failed: ETIMEDOUT', 'check network'),
          ),
        },
      })
      const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      const msg = { type: 'extension.upgrade', id: 'req3', payload: { name: 'pi-test-ext' } } as unknown as import('@taiji/shared').ClientMessage

      await handler.handleExtensionMessage(msg, WS)

      // 匹配 ExtensionInstallError 分支：code/message 透传，hint 进 details
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'req3', code: 'network', message: 'npm install failed: ETIMEDOUT' })
      expect(cap.errors[0].details).toMatchObject({ hint: 'check network' })
      // 失败路径不 reply config.extensions
      expect(cap.replies).toHaveLength(0)
    })

    it('extension.setAutoUpgrade → setAutoUpgrade 成功后 reply config.extensions', async () => {
      const { ExtensionMessageHandler } = await import('../src/transport/extension-message-handler.js')
      const { ctx, cap } = createMockCtx()
      const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
      const msg = { type: 'extension.setAutoUpgrade', id: 'req4', payload: { name: 'pi-test-ext', autoUpgrade: true } } as unknown as import('@taiji/shared').ClientMessage

      await handler.handleExtensionMessage(msg, WS)

      expect(ctx.extensionService!.setAutoUpgrade).toHaveBeenCalledWith('pi-test-ext', true)
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]).toMatchObject({ id: 'req4', type: 'config.extensions' })
      // setAutoUpgrade 不带 upgradeResult
      expect(cap.replies[0].payload.upgradeResult).toBeUndefined()
    })
  })

  // ── 7. uninstallExtension 清理 autoUpgrade ───────────────────

  describe('ExtensionService.uninstallExtension: autoUpgrade cleanup', () => {
    it('removes extension from autoUpgrade list on uninstall (U15)', async () => {
      const { uninstallPackage } = await import('../src/infra/installers/npm-installer.js')
      const mockedUninstall = vi.mocked(uninstallPackage)

      // Enable auto-upgrade for pi-test-ext first
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)
      expect(settings.getAutoUpgrade()).toContain('npm:pi-test-ext')

      mockedUninstall.mockResolvedValue(undefined)

      const installer = new NpmGitInstaller()
      const service = createExtensionService(testSettingsDir, installer, settings)

      await service.uninstallExtension('pi-test-ext')
      // autoUpgrade list should now be empty after uninstall
      expect(settings.getAutoUpgrade()).not.toContain('npm:pi-test-ext')
    })

    it('uninstall extension not in autoUpgrade list is a no-op (U15b)', async () => {
      const { uninstallPackage } = await import('../src/infra/installers/npm-installer.js')
      vi.mocked(uninstallPackage).mockResolvedValue(undefined)

      const settings = new PiExtensionSettings(testSettingsDir)
      // pi-test-ext not in autoUpgrade list (we never added it)
      expect(settings.getAutoUpgrade()).toEqual([])

      const installer = new NpmGitInstaller()
      const service = createExtensionService(testSettingsDir, installer, settings)

      // Should not throw even though extension not in autoUpgrade list
      await expect(service.uninstallExtension('pi-test-ext')).resolves.toBeUndefined()
    })
  })

  // ── 8. scanExtensions autoUpgrade 字段 ────────────────────────

  describe('ExtensionService.scanExtensions: autoUpgrade field', () => {
    it('sets autoUpgrade=true for extensions in autoUpgrade list (U16)', async () => {
      const settings = new PiExtensionSettings(testSettingsDir)
      await settings.setAutoUpgrade('npm:pi-test-ext', true)

      const installer = new NpmGitInstaller()
      const service = createExtensionService(testSettingsDir, installer, settings)

      const extensions = await service.scanExtensions()
      const ext = extensions.find(e => e.name === 'pi-test-ext')
      expect(ext).toBeDefined()
      expect(ext!.autoUpgrade).toBe(true)
    })

    it('sets autoUpgrade=false for extensions not in autoUpgrade list (U16)', async () => {
      const installer = new NpmGitInstaller()
      const service = createExtensionService(testSettingsDir, installer, new PiExtensionSettings(testSettingsDir))

      const extensions = await service.scanExtensions()
      const ext = extensions.find(e => e.name === 'pi-test-ext')
      expect(ext).toBeDefined()
      expect(ext!.autoUpgrade).toBe(false)
    })
  })
})
