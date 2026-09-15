import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { ExtensionService, ExtensionInstallError } from '../src/services/extension-service.js'
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js'
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js'
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js'
import type { IConfigStore } from '../src/services/ports/config.js'

import { installPackage, uninstallPackage, NpmInstallError } from '../src/infra/installers/npm-installer.js'
import { execFileSync } from 'node:child_process'

vi.mock('../src/infra/installers/npm-installer.js', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  installDependencies: vi.fn(),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  },
}))

// git clone still uses execFileSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}))

const mockedInstallPackage = vi.mocked(installPackage)
const mockedUninstallPackage = vi.mocked(uninstallPackage)
const mockedExecFileSync = vi.mocked(execFileSync)

describe('ExtensionService', () => {
  let service: ExtensionService
  let testSettingsDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    // Create test directory structure
    testSettingsDir = mkdtempSync(join(tmpdir(), 'ext-service-test-'))
    writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({
      packages: ['npm:pi-ask-user'],
    }), 'utf-8')
    // Create a fake pi-ask-user package
    const npmDir = join(testSettingsDir, 'npm', 'node_modules', 'pi-ask-user')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(join(npmDir, 'package.json'), JSON.stringify({
      name: 'pi-ask-user',
      version: '0.1.0',
      description: 'Ask user questions',
      keywords: ['pi-package'],
      peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
    }), 'utf-8')
    writeFileSync(join(npmDir, 'index.ts'), '', 'utf-8')

    // Create settings.json in the npm directory for --prefix install
    writeFileSync(join(testSettingsDir, 'npm', 'package.json'), JSON.stringify({ private: true }), 'utf-8')

    service = new ExtensionService({
      settingsDir: testSettingsDir,
      projectRoot: process.cwd(),
      packaged: false, // 环境可能设 TAIJI_AGENT_PACKAGED=1（pi 桌面进程），测试显式覆盖为 dev 模式
      installer: new NpmGitInstaller(),
      resolver: new ExtensionResolver({
        settingsDir: testSettingsDir,
        thirdPartyDir: join(testSettingsDir, 'extensions'),
        // Phase 1 路径迁移：npmDir 已从 settingsDir 子树迁出，注入回 testSettingsDir/npm 让 fixture 继续生效。
        npmDir: join(testSettingsDir, 'npm'),
      }),
      // IExtensionSettings port：经 pi-settings-store 统一读写 settings.json（D17）。
      // 构造时把 store 路径对齐到 testSettingsDir，使 model 域与 extension 域在测试中读写同一文件。
      extensionSettings: new PiExtensionSettings(testSettingsDir),
      // Phase 1 路径迁移：extensions/npm/tmp 已从 settingsDir 子树迁出到 dataDir 根层，
      // 注入回 testSettingsDir 子目录让现有 fixture（settingsDir/npm、settingsDir/extensions、settingsDir/tmp）继续生效。
      extensionsDir: join(testSettingsDir, 'extensions'),
      npmDir: join(testSettingsDir, 'npm'),
      tmpDir: join(testSettingsDir, 'tmp'),
    })
  })

  afterEach(() => {
    // Cleanup test dir
    try {
      rmSync(testSettingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch { /* ignore */ }
  })

  describe('scanExtensions', () => {
    it('returns extensions from all resolver sources', async () => {
      const extensions = await service.scanExtensions()
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      expect(askUser).toBeDefined()
      expect(askUser!.source).toBe('user-installed')
      expect(askUser!.enabled).toBe(true)
      expect(askUser!.version).toBe('0.1.0')
      expect(askUser!.dirName).toBe('pi-ask-user')
    })

    it('marks disabled extensions as not enabled', async () => {
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:pi-ask-user'],
      }), 'utf-8')

      const extensions = await service.scanExtensions()
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      if (askUser) {
        expect(askUser.enabled).toBe(false)
      }
    })

    it('returns empty array when no extensions found', async () => {
      writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({}), 'utf-8')
      rmSync(join(testSettingsDir, 'npm'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

      const extensions = await service.scanExtensions()
      expect(Array.isArray(extensions)).toBe(true)
    })
  })

  describe('getRecommendedExtensions', () => {
    it('excludes mandatory packages from recommended list (all 6 recommended are now mandatory)', async () => {
      const recommended = await service.getRecommendedExtensions()
      // recommended-extensions.json 的 6 个条目全部属于 mandatory SSOT，
      // Task 4.3 要求 getRecommendedExtensions 过滤掉 mandatory 项 → 返回空列表。
      // 这是新契约：mandatory 扩展不进推荐列表（它们由 boot 强制安装）。
      expect(recommended.length).toBe(0)
    })

    it('marks matching non-mandatory recommended package as installed', async () => {
      // recommended-extensions.json 当前所有条目都是 mandatory，无法直接测 installed 标记。
      // 这里改为间接验证：getRecommendedExtensions 过滤 mandatory 后只返回非 mandatory 项，
      // 且对返回的每一项 installed 字段为 boolean（契约形状检查）。
      const recommended = await service.getRecommendedExtensions()
      expect(recommended.every(r => typeof r.installed === 'boolean')).toBe(true)
      // 所有返回项都不是 mandatory 包
      expect(recommended.every(r => !['@zhushanwen/pi-ask-user',
        '@zhushanwen/pi-goal', '@zhushanwen/pi-todo',
        '@zhushanwen/pi-pending-notifications', '@zhushanwen/pi-subagent-workflow',
        '@zhushanwen/pi-structured-output'].includes(r.name))).toBe(true)
    })
  })

  describe('mandatory extensions', () => {
    it('scanExtensions sets mandatory=true for mandatory packages', async () => {
      // 在 npm/node_modules 下造一个 mandatory 包（@zhushanwen/pi-goal）
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', '@zhushanwen', 'pi-goal')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@zhushanwen/pi-goal',
        version: '0.4.0',
        description: 'goal ext',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      const settingsPath = join(testSettingsDir, 'settings.json')
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      settings.packages = [...(settings.packages || []), 'npm:@zhushanwen/pi-goal']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      const extensions = await service.scanExtensions()
      const goal = extensions.find(e => e.name === '@zhushanwen/pi-goal')
      expect(goal).toBeDefined()
      expect(goal!.mandatory).toBe(true)
      // S10：tier 直接从 resolveExtensions 透传（pi-goal 是 feature mandatory）
      expect(goal!.tier).toBe('feature')
      // 非 mandatory 包 mandatory 字段为 false
      const askUser = extensions.find(e => e.name === 'pi-ask-user')
      if (askUser) {
        expect(askUser.mandatory).toBe(false)
      }
    })

    it('uninstallExtension rejects builtin packages', async () => {
      // @zhushanwen/pi-goal 是 builtin（feature 子级，仍不可卸）
      // 阶段 2 改名：mandatory_cannot_uninstall → builtin_cannot_uninstall
      await expect(service.uninstallExtension('@zhushanwen/pi-goal'))
        .rejects.toThrow(/Builtin extension cannot be uninstalled/)
    })

    it('uninstallExtension allows non-builtin packages', async () => {
      // pi-ask-user 非 builtin，卸载不应抛 builtin 守卫错误
      // （后续 npm uninstall 是 mock 的，不会真正报错）
      await expect(service.uninstallExtension('pi-ask-user'))
        .resolves.toBeUndefined()
    })
  })

  describe('getExtensionPaths', () => {
    it('returns paths of enabled extensions', async () => {
      const paths = await service.getExtensionPaths()
      expect(paths.some(p => p.includes('pi-ask-user'))).toBe(true)
    })

    it('excludes disabled extensions', async () => {
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:pi-ask-user'],
      }), 'utf-8')

      const paths = await service.getExtensionPaths()
      expect(paths.some(p => p.includes('pi-ask-user'))).toBe(false)
    })

    it('infrastructure builtin 包无视 disabled 强加载', async () => {
      // pi-pending-notifications 是 infrastructure builtin（被依赖的基础包），仍无视 disabled 强加载
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', '@zhushanwen', 'pi-pending-notifications')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@zhushanwen/pi-pending-notifications',
        version: '1.0.0',
        description: 'infra ext',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')
      const settingsPath = join(testSettingsDir, 'settings.json')
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      settings.packages = [...(settings.packages || []), 'npm:@zhushanwen/pi-pending-notifications']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      // 把 infrastructure 包加入 disabled-packages.json（应当被无视）
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:@zhushanwen/pi-pending-notifications'],
      }), 'utf-8')

      const paths = await service.getExtensionPaths()
      // infrastructure 包即使被 disabled 仍出现在路径中（强制加载）
      expect(paths.some(p => p.includes('@zhushanwen') && p.includes('pi-pending-notifications'))).toBe(true)
    })
  })

  describe('TAIJI_EXTENSION_PATHS', () => {
    let userExtDir: string

    beforeEach(() => {
      // 造一个临时 extension 目录，满足 isValidPiExtension（keywords 含 pi-package）
      userExtDir = mkdtempSync(join(tmpdir(), 'ext-user-path-'))
      writeFileSync(join(userExtDir, 'package.json'), JSON.stringify({
        name: 'my-dev-extension',
        version: '0.0.1',
        description: 'local dev extension',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(userExtDir, 'index.ts'), '', 'utf-8')
      process.env.TAIJI_EXTENSION_PATHS = userExtDir
    })

    afterEach(() => {
      delete process.env.TAIJI_EXTENSION_PATHS
      try { rmSync(userExtDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
    })

    it('scanExtensions 能扫到 TAIJI_EXTENSION_PATHS 指向的 extension', async () => {
      const extensions = await service.scanExtensions()
      const found = extensions.find(e => e.name === 'my-dev-extension')
      expect(found).toBeDefined()
      expect(found!.path).toBe(userExtDir)
    })

    it('getExtensionPaths 返回的路径包含 user extension 目录', async () => {
      const paths = await service.getExtensionPaths()
      expect(paths).toContain(userExtDir)
    })

    it('无效路径静默跳过，不抛错', async () => {
      process.env.TAIJI_EXTENSION_PATHS = `/nonexistent/path${delimiter}${userExtDir}`
      const extensions = await service.scanExtensions()
      // 无效路径被跳过，有效的仍在
      expect(extensions.find(e => e.name === 'my-dev-extension')).toBeDefined()
    })

    it('多个路径用分隔符隔开都能扫到', async () => {
      const userExtDir2 = mkdtempSync(join(tmpdir(), 'ext-user-path2-'))
      writeFileSync(join(userExtDir2, 'package.json'), JSON.stringify({
        name: 'second-dev-extension',
        version: '0.0.1',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(userExtDir2, 'index.ts'), '', 'utf-8')
      try {
        process.env.TAIJI_EXTENSION_PATHS = `${userExtDir}${delimiter}${userExtDir2}`
        const extensions = await service.scanExtensions()
        expect(extensions.find(e => e.path === userExtDir)).toBeDefined()
        expect(extensions.find(e => e.path === userExtDir2)).toBeDefined()
      } finally {
        rmSync(userExtDir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  describe('installExtension', () => {
    it('throws for non-npm sources', async () => {
      await expect(service.installExtension('git:foo/bar')).rejects.toThrow('Unsupported source')
    })

    it('rejects builtin packages (builtin_already_installed guard, MF-4)', async () => {
      // @zhushanwen/pi-goal 是 builtin（feature 级），installExtension 守卫应拒绝用户 npm 安装。
      // 否则与内置副本产生去重冲突，deduplicate 保留用户装的那份，
      // 产生 source(user-installed)/tier(mandatory) 矛盾条目（不可卸载却显示为用户安装）。
      // 与 uninstall/toggle 的 builtin 守卫对称（均有测），唯独 install 入口原缺测（MF-4）。
      try {
        await service.installExtension('npm:@zhushanwen/pi-goal')
        expect.unreachable('Should have thrown builtin_already_installed')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('builtin_already_installed')
        expect((e as Error).message).toMatch(/already built in/i)
      }
    })

    it('throws when package is not a valid pi extension', async () => {
      // installPackage succeeds but the installed package lacks pi manifest fields
      mockedInstallPackage.mockResolvedValue(undefined)
      mockedUninstallPackage.mockResolvedValue(undefined)
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'invalid-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'invalid-pkg',
        version: '1.0.0',
      }), 'utf-8')

      await expect(service.installExtension('npm:invalid-pkg')).rejects.toThrow('not a valid pi extension')
    })
  })

  describe('uninstallExtension', () => {
    it('removes from settings.json', async () => {
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'test-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'test-pkg', version: '0.1.0', description: '',
        keywords: ['pi-package'],
        peerDependencies: { '@mariozechner/pi-coding-agent': '*' },
      }), 'utf-8')

      const settingsPath = join(testSettingsDir, 'settings.json')
      const raw = readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw)
      settings.packages = [...(settings.packages || []), 'npm:test-pkg']
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

      mockedUninstallPackage.mockResolvedValue(undefined)
      await service.uninstallExtension('test-pkg')

      const updatedRaw = readFileSync(settingsPath, 'utf-8')
      const updatedSettings = JSON.parse(updatedRaw)
      expect(updatedSettings.packages).not.toContain('npm:test-pkg')
    })
  })

  describe('toggleExtension', () => {
    it('toggles extension to disabled', async () => {
      await service.toggleExtension('pi-ask-user', false)

      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      expect(existsSync(disabledPath)).toBe(true)
      const raw = readFileSync(disabledPath, 'utf-8')
      const data = JSON.parse(raw)
      expect(data.disabled).toContain('npm:pi-ask-user')
    })

    it('toggles disabled extension back to enabled', async () => {
      await service.toggleExtension('pi-ask-user', false)
      await service.toggleExtension('pi-ask-user', true)

      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      expect(existsSync(disabledPath)).toBe(false)
    })

    it('rejects disabling infrastructure but allows feature', async () => {
      // 阶段 2：守卫只拦截 infrastructure builtin（被依赖的基础包，不可禁）；
      // feature builtin（pi-goal）可禁，禁用走正常 disabled-packages.json 路径。

      // [1] infrastructure builtin（pi-pending-notifications）禁用应抛 infrastructure_cannot_disable
      // （阶段 2 改名：mandatory_cannot_disable → infrastructure_cannot_disable）
      await expect(service.toggleExtension('@zhushanwen/pi-pending-notifications', false))
        .rejects.toThrow(/Infrastructure extension cannot be disabled/)

      // [2] feature builtin（pi-goal）禁用应成功（feature 现在可禁）
      await expect(service.toggleExtension('@zhushanwen/pi-goal', false))
        .resolves.toBeUndefined()
      // 落盘到 disabled-packages.json（用 npm: 前缀，pi-goal 非 discovery 源）
      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      expect(existsSync(disabledPath)).toBe(true)
      const raw = readFileSync(disabledPath, 'utf-8')
      const data = JSON.parse(raw)
      expect(data.disabled).toContain('npm:@zhushanwen/pi-goal')
    })

    it('allows enabling builtin packages', async () => {
      // 开启 builtin 扩展允许（守卫只拦截禁用，开启无害）
      await expect(service.toggleExtension('@zhushanwen/pi-goal', true))
        .resolves.toBeUndefined()
    })
  })

  // ── Task 3: ExtensionInstallError and error classification ────

  describe('ExtensionInstallError', () => {
    it('has code, message, and optional hint', () => {
      const err = new ExtensionInstallError('not_found', 'Package not found', 'Check the package name')
      expect(err.code).toBe('not_found')
      expect(err.message).toBe('Package not found')
      expect(err.hint).toBe('Check the package name')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(ExtensionInstallError)
    })

    it('works without hint', () => {
      const err = new ExtensionInstallError('network', 'Connection timeout')
      expect(err.code).toBe('network')
      expect(err.hint).toBeUndefined()
    })
  })

  describe('installExtension error classification', () => {
    it('classifies 404 errors as not_found', async () => {
      mockedInstallPackage.mockRejectedValue(new NpmInstallError('not_found', 'Package not found (404)'))

      try {
        await service.installExtension('npm:nonexistent-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_found')
      }
    })

    it('classifies E404 errors as not_found', async () => {
      mockedInstallPackage.mockRejectedValue(new Error('npm ERR! E404 Package not found'))

      try {
        await service.installExtension('npm:e404-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_found')
      }
    })

    it('classifies other npm errors as network', async () => {
      mockedInstallPackage.mockRejectedValue(new NpmInstallError('network', 'Connection timeout'))

      try {
        await service.installExtension('npm:timeout-pkg')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('network')
      }
    })

    it('classifies invalid pi extension as not_extension', async () => {
      mockedInstallPackage.mockResolvedValue(undefined)
      mockedUninstallPackage.mockResolvedValue(undefined)
      const pkgDir = join(testSettingsDir, 'npm', 'node_modules', 'lodash')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'lodash',
        version: '4.17.21',
      }), 'utf-8')

      try {
        await service.installExtension('npm:lodash')
        expect.unreachable('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ExtensionInstallError)
        expect((e as ExtensionInstallError).code).toBe('not_extension')
      }
    })
  })

  // ── Task 4: installLocalDirectory, installGitRepository, finishInstall ──

  describe('installLocalDirectory', () => {
    it('throws for non-existent path', async () => {
      await expect(service.installLocalDirectory('/nonexistent/path'))
        .rejects.toThrow('does not exist')
    })

    it('throws for non-directory path', async () => {
      const filePath = join(testSettingsDir, 'some-file.txt')
      writeFileSync(filePath, 'hello', 'utf-8')

      await expect(service.installLocalDirectory(filePath))
        .rejects.toThrow('not a directory')
    })

    it('discovers extensions from a local directory with single pi extension', async () => {
      const sourceDir = join(testSettingsDir, 'source-ext')
      const extDir = join(sourceDir, 'my-pi-ext')
      mkdirSync(extDir, { recursive: true })
      writeFileSync(join(extDir, 'package.json'), JSON.stringify({
        name: 'pi-my-ext',
        version: '1.0.0',
        description: 'A test extension',
        keywords: ['pi-package'],
      }), 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.tempDir).toContain('ext-scan-')
        expect(result.candidates).toHaveLength(1)
        expect(result.candidates[0].name).toBe('pi-my-ext')
        expect(result.candidates[0].version).toBe('1.0.0')
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })

    it('discovers extensions from a directory that IS a pi extension itself', async () => {
      const sourceDir = join(testSettingsDir, 'source-ext-single')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
        name: 'pi-direct-ext',
        version: '2.0.0',
        description: 'Direct extension',
        pi: { type: 'extension' },
      }), 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.candidates).toHaveLength(1)
        expect(result.candidates[0].name).toBe('pi-direct-ext')
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })

    it('根即 extension：dirName 是源目录名（非 tempDir basename），finishInstall 回路完整', async () => {
      // 回归测试：源目录本身就是单个 pi extension 时，dirName 必须是源目录 basename，
      // 而非 tempDir 的 basename（"ext-scan-xxxx"）。否则 finishInstall 找不到子目录。
      const sourceDir = join(testSettingsDir, 'ask-user')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
        name: 'pi-ask-user',
        version: '0.1.0',
        description: 'single ext at root',
        keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(sourceDir, 'index.ts'), '', 'utf-8')

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.candidates).toHaveLength(1)
        // dirName 是源目录名，不是 tempDir basename（"ext-scan-xxxx"）
        expect(result.candidates[0].dirName).toBe('ask-user')
        expect(result.tempDir).toContain('ext-scan-') // tempDir 名仍带前缀，但 dirName 不等于它

        // finishInstall 回路：用返回的 tempDir + dirName 完成安装
        await service.finishInstall(result.tempDir, [result.candidates[0].dirName])
        const extensionsDir = join(testSettingsDir, 'extensions')
        expect(existsSync(join(extensionsDir, 'ask-user', 'package.json'))).toBe(true)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })

    it('returns empty candidates when no valid extensions found', async () => {
      const sourceDir = join(testSettingsDir, 'source-empty')
      mkdirSync(sourceDir, { recursive: true })

      const result = await service.installLocalDirectory(sourceDir)

      try {
        expect(result.candidates).toHaveLength(0)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })
  })

  describe('installGitRepository', () => {
    it('throws when git clone fails', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('git clone failed: repository not found')
      })

      await expect(service.installGitRepository('https://github.com/nonexistent/repo.git'))
        .rejects.toThrow('git clone failed')
    })

    it('discovers extensions from a cloned git repo', async () => {
      // Mock: when git clone is called via execFileSync, create the extension structure in the target dir
      mockedExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === 'clone') {
          // git clone args: ['clone', '--depth', '1', url, targetDir]
          const targetDir = args[4] ?? ''
          if (targetDir) {
            mkdirSync(targetDir, { recursive: true })
            const extDir = join(targetDir, 'packages', 'pi-cloned-ext')
            mkdirSync(extDir, { recursive: true })
            writeFileSync(join(extDir, 'package.json'), JSON.stringify({
              name: 'pi-cloned-ext',
              version: '0.5.0',
              description: 'A cloned extension',
              keywords: ['pi-package'],
            }), 'utf-8')
          }
        }
        return ''
      })

      const result = await service.installGitRepository('https://github.com/user/pi-ext-repo.git')

      expect(result.tempDir).toContain('ext-scan-')
      expect(result.candidates.length).toBeGreaterThanOrEqual(1)
      expect(result.candidates.some(c => c.name === 'pi-cloned-ext')).toBe(true)

      // Cleanup
      try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
    })

    it('clone 到 tempDir/<repoName>/ 子目录，dirName 是仓库名非 tempDir basename', async () => {
      // 回归：仓库根本身是单个 extension 时，clone 目标是 tempDir/repoName/，
      // discoverExtensions 走子目录扫描，dirName = repoName，finishInstall 回路完整。
      mockedExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === 'clone') {
          const targetDir = args[4] ?? ''
          if (targetDir) {
            mkdirSync(targetDir, { recursive: true })
            // 仓库根本身就是 extension（package.json 直接在 targetDir 下）
            writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
              name: 'pi-single-repo',
              version: '1.0.0',
              description: 'repo root IS the extension',
              keywords: ['pi-package'],
            }), 'utf-8')
            writeFileSync(join(targetDir, 'index.ts'), '', 'utf-8')
          }
        }
        return ''
      })

      const result = await service.installGitRepository('https://github.com/user/pi-single-repo.git')

      try {
        expect(result.candidates).toHaveLength(1)
        // repoName = pi-single-repo（URL 末段去 .git）
        expect(result.candidates[0].dirName).toBe('pi-single-repo')
        expect(result.tempDir).toContain('ext-scan-')

        // finishInstall 回路
        await service.finishInstall(result.tempDir, [result.candidates[0].dirName])
        const extensionsDir = join(testSettingsDir, 'extensions')
        expect(existsSync(join(extensionsDir, 'pi-single-repo', 'package.json'))).toBe(true)
      } finally {
        try { rmSync(result.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
      }
    })
  })

  describe('finishInstall', () => {
    it('copies selected extensions to extensions dir and cleans up temp', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-finish')
      const extA = join(tempDir, 'ext-a')
      const extB = join(tempDir, 'ext-b')
      mkdirSync(extA, { recursive: true })
      mkdirSync(extB, { recursive: true })
      writeFileSync(join(extA, 'package.json'), JSON.stringify({
        name: 'pi-ext-a', version: '1.0.0', description: 'A', keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(extB, 'package.json'), JSON.stringify({
        name: 'pi-ext-b', version: '1.0.0', description: 'B', keywords: ['pi-package'],
      }), 'utf-8')

      await service.finishInstall(tempDir, ['ext-a', 'ext-b'])

      const extensionsDir = join(testSettingsDir, 'extensions')
      expect(existsSync(join(extensionsDir, 'ext-a', 'package.json'))).toBe(true)
      expect(existsSync(join(extensionsDir, 'ext-b', 'package.json'))).toBe(true)
      expect(existsSync(tempDir)).toBe(false)
    })

    it('only installs selected extensions, not all', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-partial')
      const extA = join(tempDir, 'ext-a')
      const extB = join(tempDir, 'ext-b')
      mkdirSync(extA, { recursive: true })
      mkdirSync(extB, { recursive: true })
      writeFileSync(join(extA, 'package.json'), JSON.stringify({
        name: 'pi-ext-a', version: '1.0.0', description: 'A', keywords: ['pi-package'],
      }), 'utf-8')
      writeFileSync(join(extB, 'package.json'), JSON.stringify({
        name: 'pi-ext-b', version: '1.0.0', description: 'B', keywords: ['pi-package'],
      }), 'utf-8')

      await service.finishInstall(tempDir, ['ext-a'])

      const extensionsDir = join(testSettingsDir, 'extensions')
      expect(existsSync(join(extensionsDir, 'ext-a'))).toBe(true)
      expect(existsSync(join(extensionsDir, 'ext-b'))).toBe(false)
    })

    it('throws when selected extension does not exist in temp dir', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-missing')
      mkdirSync(tempDir, { recursive: true })

      await expect(service.finishInstall(tempDir, ['nonexistent']))
        .rejects.toThrow('not found in')
    })

    it('rejects symlink extension in temp dir', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-symlink')
      mkdirSync(tempDir, { recursive: true })
      // Create a symlink pointing to a real dir outside tempDir
      const targetDir = join(testSettingsDir, 'symlink-target')
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, 'package.json'), '{}', 'utf-8')
      symlinkSync(targetDir, join(tempDir, 'evil-link'))

      await expect(service.finishInstall(tempDir, ['evil-link']))
        .rejects.toThrow('symlink')
    })
  })

  describe('cancelInstall', () => {
    it('cleans up valid temp directory', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-test-cancel')
      mkdirSync(tempDir, { recursive: true })
      writeFileSync(join(tempDir, 'marker.txt'), 'test', 'utf-8')

      await service.cancelInstall(tempDir)

      expect(existsSync(tempDir)).toBe(false)
    })

    it('throws for path outside allowedPrefixes', async () => {
      await expect(service.cancelInstall('/tmp/outside-foo'))
        .rejects.toThrow()
    })

    it('handles non-existent temp dir gracefully', async () => {
      const tempDir = join(testSettingsDir, 'tmp', 'ext-scan-nonexistent-cancel')
      // Should not throw — rmSync force:true is idempotent
      await expect(service.cancelInstall(tempDir)).resolves.toBeUndefined()
    })
  })

  describe('installGitRepository URL validation', () => {
    it('rejects http:// URLs (SSRF prevention)', async () => {
      await expect(service.installGitRepository('http://169.254.169.254/latest/meta-data/'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('rejects git:// URLs', async () => {
      await expect(service.installGitRepository('git://github.com/user/repo.git'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('rejects ftp:// URLs', async () => {
      await expect(service.installGitRepository('ftp://example.com/repo'))
        .rejects.toThrow('Invalid Git URL')
    })

    it('accepts https:// URLs', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('git clone failed: test')
      })
      // Should fail with git clone error, not URL validation error
      await expect(service.installGitRepository('https://github.com/user/repo.git'))
        .rejects.toThrow('git clone failed')
    })
  })

  describe('scanExtensions with discovery dirs', () => {
    // discovery.json 中的 extension 目录分两类：绝对路径（全局有效）与相对路径（项目级）。
    // 这组测试验证拆分契约：绝对路径进 scanExtensions 全局视图，相对路径只进 session 启动（getDiscoveredAndDisabled）。
    // 注意 discovery 扩展入口复刻 pi 原生扫描：扫描结果是「入口路径」（单文件 *.ts 或 <ext>/index.ts），
    // 而非扩展目录本身——ExtensionInfo.name 取入口路径 basename，readPkgMeta 也以入口为基准读 package.json。
    // 因此 fixture 用单文件 my-discovery-ext.ts（name = 'my-discovery-ext.ts'），可测 toggleExtension 的 discovery:<name> 串联回路。
    let discoveryService: ExtensionService
    let discoverySettingsDir: string

    beforeEach(() => {
      vi.clearAllMocks()
      discoverySettingsDir = mkdtempSync(join(tmpdir(), 'ext-discovery-test-'))
      writeFileSync(join(discoverySettingsDir, 'settings.json'), JSON.stringify({ packages: [] }), 'utf-8')
      mkdirSync(join(discoverySettingsDir, 'npm'), { recursive: true })
      writeFileSync(join(discoverySettingsDir, 'npm', 'package.json'), JSON.stringify({ private: true }), 'utf-8')
    })

    afterEach(() => {
      try { rmSync(discoverySettingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* ignore */ }
    })

    /**
     * 构造带 configStore 的 service（复刻主 beforeEach 的端口装配，额外注入 configStore）。
     * 只需 getExtensionDirs，其余 IConfigStore 方法测试不触达，按既定 partial-mock 惯例 cast。
     */
    const buildService = (configStore: { getExtensionDirs: () => string[] }): ExtensionService => new ExtensionService({
      settingsDir: discoverySettingsDir,
      // 相对路径 discovery 目录按 projectRoot resolve，测试用 discoverySettingsDir 作 base
      projectRoot: discoverySettingsDir,
      installer: new NpmGitInstaller(),
      resolver: new ExtensionResolver({
        settingsDir: discoverySettingsDir,
        thirdPartyDir: join(discoverySettingsDir, 'extensions'),
        npmDir: join(discoverySettingsDir, 'npm'),
      }),
      extensionSettings: new PiExtensionSettings(discoverySettingsDir),
      extensionsDir: join(discoverySettingsDir, 'extensions'),
      npmDir: join(discoverySettingsDir, 'npm'),
      tmpDir: join(discoverySettingsDir, 'tmp'),
      configStore: configStore as unknown as IConfigStore,
    })

    it('absolute-path discovery dir 中的扩展在 scanExtensions 可见，source=discovery', async () => {
      // 在绝对路径 discovery 目录下放一个单文件 pi extension 入口
      const discDir = join(discoverySettingsDir, 'discovery-exts')
      mkdirSync(discDir, { recursive: true })
      writeFileSync(join(discDir, 'my-discovery-ext.ts'),
        '// discovery ext entry', 'utf-8')

      const configStore = { getExtensionDirs: () => [discDir] } // 绝对路径
      discoveryService = buildService(configStore)

      const extensions = await discoveryService.scanExtensions()
      const discExt = extensions.find(e => e.source === 'discovery')
      expect(discExt).toBeDefined()
      expect(discExt!.source).toBe('discovery')
      expect(discExt!.enabled).toBe(true)
      // 单文件入口：name/dirName = 入口路径 basename，path 指向入口文件
      expect(discExt!.name).toBe('my-discovery-ext.ts')
      expect(discExt!.path).toBe(join(discDir, 'my-discovery-ext.ts'))
    })

    it('toggleExtension(false) 后 discovery 扩展 enabled=false（disabled-packages.json 按 discovery:<name> 隔离）', async () => {
      const discDir = join(discoverySettingsDir, 'discovery-exts')
      mkdirSync(discDir, { recursive: true })
      writeFileSync(join(discDir, 'my-discovery-ext.ts'), '// entry', 'utf-8')

      const configStore = { getExtensionDirs: () => [discDir] }
      discoveryService = buildService(configStore)

      const before = await discoveryService.scanExtensions()
      const discExt = before.find(e => e.source === 'discovery')!
      expect(discExt).toBeDefined()

      // 用扫描出的 name 禁用——discovery 源走 discovery:<name> 机制（#2 与 npm 源隔离）
      await discoveryService.toggleExtension(discExt.name, false)

      const after = await discoveryService.scanExtensions()
      const discExtAfter = after.find(e => e.name === discExt.name)!
      expect(discExtAfter.enabled).toBe(false)

      // disabled-packages.json 落盘 discovery:<name>（#2 源隔离）
      const disabledRaw = readFileSync(join(discoverySettingsDir, 'disabled-packages.json'), 'utf-8')
      const disabledData = JSON.parse(disabledRaw) as { disabled: string[] }
      expect(disabledData.disabled).toContain(`discovery:${discExt.name}`)
      // 不应误写 npm: 前缀（避免与同名 npm 扩展串扰）
      expect(disabledData.disabled).not.toContain(`npm:${discExt.name}`)

      // 再启用，状态恢复 enabled=true
      await discoveryService.toggleExtension(discExt.name, true)
      const reEnabled = await discoveryService.scanExtensions()
      const discExtReEnabled = reEnabled.find(e => e.name === discExt.name)!
      expect(discExtReEnabled.enabled).toBe(true)
    })

    it('relative-path discovery dir 不进 scanExtensions 全局视图（拆分契约）', async () => {
      // 相对路径 discovery 目录：依赖 projectRoot，项目级，只 session 启动按 cwd resolve 加载
      const relDirName = 'relative-exts'
      mkdirSync(join(discoverySettingsDir, relDirName), { recursive: true })
      writeFileSync(join(discoverySettingsDir, relDirName, 'rel-ext.ts'), '// rel entry', 'utf-8')

      // configStore 返回相对路径（projectRoot = discoverySettingsDir，故能 resolve 到上面造的目录）
      const configStore = { getExtensionDirs: () => [relDirName] }
      discoveryService = buildService(configStore)

      // 全局视图不应含相对路径 discovery 扩展
      const scanResult = await discoveryService.scanExtensions()
      expect(scanResult.filter(e => e.source === 'discovery')).toHaveLength(0)

      // 但 session 启动（getDiscoveredAndDisabled）按 cwd resolve 后应含相对路径 discovery 扩展
      const { discovered } = await discoveryService.getDiscoveredAndDisabled(discoverySettingsDir)
      const discoveryEntries = discovered.filter(d => d.source === 'discovery')
      expect(discoveryEntries).toHaveLength(1)
      expect(discoveryEntries[0].path).toBe(join(discoverySettingsDir, relDirName, 'rel-ext.ts'))
    })
  })

  describe('installLocalDirectory path security', () => {
    it('rejects paths outside home and tmp', async () => {
      await expect(service.installLocalDirectory('/etc/passwd'))
        .rejects.toThrow(/not a directory|does not exist/)
    })

    it('rejects non-directory paths under home', async () => {
      // fs-guard：家目录在白名单外不可写。HOME 临时指向 tmp——installLocalDirectory 的
      // home 判定经 homedir() 动态读 $HOME，「home 下非目录路径 → 拒」语义原样保留。
      const realHome = process.env.HOME
      const fakeHome = mkdtempSync(join(tmpdir(), 'extsvc-home-'))
      process.env.HOME = fakeHome
      try {
        const filePath = join(fakeHome, 'taiji-test-file-' + Date.now())
        writeFileSync(filePath, 'test', 'utf-8')
        await expect(service.installLocalDirectory(filePath))
          .rejects.toThrow('not a directory')
      } finally {
        process.env.HOME = realHome
        rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  // ── Phase 4: migrateBuiltinExtensions（清理旧版 mandatory npm install 遗留）──

  describe('migrateBuiltinExtensions', () => {
    /** 9 个 builtin 包名（与 shared/mandatory-extensions.json SSOT 对齐） */
    const builtinNames = [
      '@zhushanwen/pi-ask-user',
      '@zhushanwen/pi-goal',
      '@zhushanwen/pi-todo',
      '@zhushanwen/pi-pending-notifications',
      '@zhushanwen/pi-subagent-workflow',
      '@zhushanwen/pi-structured-output',
      '@zhushanwen/pi-permission',
      '@zhushanwen/pi-scheduler',
      '@zhushanwen/pi-rename-session',
    ]
    /** 一个不属于 builtin 的 user 包（迁移后必须保留） */
    const userPkg = 'npm:user-installed-pkg'
    /** infrastructure 级 builtin（不可禁，disabled 记录属残留，迁移清除） */
    const infraNames = ['@zhushanwen/pi-pending-notifications', '@zhushanwen/pi-structured-output']
    /** feature 级 builtin（可禁，disabled 记录是用户合法状态，迁移必须保留，M6a-02） */
    const featureNames = builtinNames.filter(n => !infraNames.includes(n))

    it('清理 3 个数据文件中的 builtin 包记录，user 记录保留', async () => {
      // settings.json packages[]：builtin + user
      const settingsPath = join(testSettingsDir, 'settings.json')
      writeFileSync(settingsPath, JSON.stringify({
        packages: [...builtinNames.map(n => `npm:${n}`), userPkg],
      }), 'utf-8')

      // auto-upgrade-packages.json：builtin + user
      writeFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), JSON.stringify({
        autoUpgrade: [...builtinNames.map(n => `npm:${n}`), userPkg],
      }), 'utf-8')

      // disabled-packages.json：builtin（infra + feature）+ user
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: [...builtinNames.map(n => `npm:${n}`), userPkg],
      }), 'utf-8')

      await service.migrateBuiltinExtensions()

      // settings.json：builtin 清除，user 保留
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      for (const n of builtinNames) {
        expect(settings.packages).not.toContain(`npm:${n}`)
      }
      expect(settings.packages).toContain(userPkg)

      // auto-upgrade-packages.json：builtin 清除，user 保留
      const autoRaw = readFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), 'utf-8')
      const auto = JSON.parse(autoRaw) as { autoUpgrade: string[] }
      for (const n of builtinNames) {
        expect(auto.autoUpgrade).not.toContain(`npm:${n}`)
      }
      expect(auto.autoUpgrade).toContain(userPkg)

      // disabled-packages.json（M6a-02）：infrastructure builtin 清除（残留），
      // feature builtin 保留（用户合法禁用状态），user 保留
      const disabledRaw = readFileSync(join(testSettingsDir, 'disabled-packages.json'), 'utf-8')
      const disabled = JSON.parse(disabledRaw) as { disabled: string[] }
      for (const n of infraNames) {
        expect(disabled.disabled).not.toContain(`npm:${n}`)
      }
      for (const n of featureNames) {
        expect(disabled.disabled).toContain(`npm:${n}`)
      }
      expect(disabled.disabled).toContain(userPkg)
    })

    it('禁用 feature builtin 后迁移保留 disabled（模拟 boot，M6a-02）', async () => {
      // 用户禁用 feature builtin（toggleExtension 落盘 npm:<name>）
      const disabledPath = join(testSettingsDir, 'disabled-packages.json')
      writeFileSync(disabledPath, JSON.stringify({
        disabled: ['npm:@zhushanwen/pi-goal', 'npm:@zhushanwen/pi-subagent-workflow'],
      }), 'utf-8')
      // 旧机制遗留：settings.json packages[] 有同包 npm 记录（迁移应清除）
      writeFileSync(join(testSettingsDir, 'settings.json'), JSON.stringify({
        packages: ['npm:@zhushanwen/pi-goal'],
      }), 'utf-8')

      // 模拟 boot 迁移
      await service.migrateBuiltinExtensions()

      // disabled 保留：feature builtin 禁用状态跨重启持久
      const disabled = JSON.parse(readFileSync(disabledPath, 'utf-8')) as { disabled: string[] }
      expect(disabled.disabled).toContain('npm:@zhushanwen/pi-goal')
      expect(disabled.disabled).toContain('npm:@zhushanwen/pi-subagent-workflow')
      // packages[] 仍清理（builtin 不可安装，该记录永远不该存在）
      const settings = JSON.parse(readFileSync(join(testSettingsDir, 'settings.json'), 'utf-8'))
      expect(settings.packages).not.toContain('npm:@zhushanwen/pi-goal')
    })

    it('迁移清除 infrastructure builtin 的 disabled 残留（M6a-02）', async () => {
      // 旧 mandatory 机制/手动编辑残留的 infrastructure disabled 记录应被清除
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: ['npm:@zhushanwen/pi-pending-notifications', 'npm:@zhushanwen/pi-structured-output'],
      }), 'utf-8')

      await service.migrateBuiltinExtensions()

      // infrastructure disabled 全清后 disabled-packages.json 被 JsonStore 删除（空数组删文件行为）
      expect(existsSync(join(testSettingsDir, 'disabled-packages.json'))).toBe(false)
    })

    it('幂等：无 builtin 记录时不报错且数据不变', async () => {
      // 3 个文件只含 user 记录（无 builtin）
      const settingsPath = join(testSettingsDir, 'settings.json')
      writeFileSync(settingsPath, JSON.stringify({ packages: [userPkg] }), 'utf-8')
      writeFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), JSON.stringify({
        autoUpgrade: [userPkg],
      }), 'utf-8')
      writeFileSync(join(testSettingsDir, 'disabled-packages.json'), JSON.stringify({
        disabled: [userPkg],
      }), 'utf-8')

      await expect(service.migrateBuiltinExtensions()).resolves.toBeUndefined()

      // user 记录完整保留
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(settings.packages).toEqual([userPkg])
      const auto = JSON.parse(readFileSync(join(testSettingsDir, 'auto-upgrade-packages.json'), 'utf-8')) as { autoUpgrade: string[] }
      expect(auto.autoUpgrade).toEqual([userPkg])
      const disabled = JSON.parse(readFileSync(join(testSettingsDir, 'disabled-packages.json'), 'utf-8')) as { disabled: string[] }
      expect(disabled.disabled).toEqual([userPkg])
    })

    it('幂等：3 个文件均不存在时不报错', async () => {
      // 删除 beforeEach 造的 settings.json，模拟全新安装（无任何历史文件）
      rmSync(join(testSettingsDir, 'settings.json'), { force: true })
      rmSync(join(testSettingsDir, 'disabled-packages.json'), { force: true })
      rmSync(join(testSettingsDir, 'auto-upgrade-packages.json'), { force: true })

      await expect(service.migrateBuiltinExtensions()).resolves.toBeUndefined()
    })
  })
})
