/**
 * plugin-installer.test.ts — W2 wave: NpmPluginInstaller (infra adapter) tests.
 *
 * 严格 TDD：先写失败测试（红）→ 写实现（绿）。
 *
 * 覆盖点（来自 plan.json U4/U5）：
 * - U4: NpmPluginInstaller.install 成功路径——mock downloadPackageTarball 返回成功
 *   并在 targetDir 写入含 taijiPlugin:{manifestVersion:1} 的 package.json，
 *   调 install(spec)，断言 {success:true, pluginId 非空, path===join(pluginsDir,pluginId)}
 * - U5: manifest 校验失败——mock downloadPackageTarball 成功但 package.json 含
 *   taijiPlugin:{manifestVersion:2}，调 install，断言 {success:false} 且 targetDir 已删
 *
 * mock 层：downloadPackageTarball 被 vi.mock 替换，不触发真实 npm registry 网络。
 * E1（真实 npm 包安装）需手工验证。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock downloadPackageTarball（infra 的纯 Node 下载函数），由测试控制成功/失败 +
// 在 targetDir 写入自定义 package.json。installPackage 等其他导出保留 no-op 占位
// 以防 NpmPluginInstaller 误调。
vi.mock('../src/infra/installers/npm-installer.js', () => ({
  downloadPackageTarball: vi.fn(),
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

// 延迟 import：vi.mock 会被提升到 import 之前，故此处能拿到 mocked 版本。
const { downloadPackageTarball } = await import('../src/infra/installers/npm-installer.js')
const { NpmPluginInstaller } = await import('../src/infra/installers/plugin-installer-adapter.js')

const mockDownload = vi.mocked(downloadPackageTarball)

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  tmpDir = await mkdtemp(join(tmpdir(), 'npm-plugin-installer-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
  vi.restoreAllMocks()
})

describe('NpmPluginInstaller', () => {
  describe('install - success (U4)', () => {
    it('should install a valid taiji plugin', async () => {
      const pluginsDir = join(tmpDir, 'plugins')
      const installer = new NpmPluginInstaller(pluginsDir)

      const pluginName = 'my-test-plugin'
      const pluginVersion = '1.0.0'

      // downloadPackageTarball mock：在 targetDir 写入合法 package.json（strip=1 解压
      // 后包内容落在 targetDir 根，故 package.json 直接在 targetDir 下）。
      mockDownload.mockImplementation(async (_spec: string, targetDir: string) => {
        await mkdir(targetDir, { recursive: true })
        await writeFile(
          join(targetDir, 'package.json'),
          JSON.stringify({
            name: pluginName,
            version: pluginVersion,
            taijiPlugin: { manifestVersion: 1, main: 'index.js' },
          }),
          'utf-8',
        )
        return { name: pluginName, version: pluginVersion }
      })

      const result = await installer.install(`${pluginName}@${pluginVersion}`)

      expect(result.success).toBe(true)
      expect(result.pluginId).toBe(pluginName)
      expect(result.path).toBe(join(pluginsDir, pluginName))

      // package.json 应已落在 pluginsDir/<name>/package.json
      const installedPkg = JSON.parse(
        await readFile(join(result.path!, 'package.json'), 'utf-8'),
      )
      expect(installedPkg.name).toBe(pluginName)
      expect(installedPkg.taijiPlugin.manifestVersion).toBe(1)
    })
  })

  describe('install - wrong manifestVersion (U5)', () => {
    it('should fail and clean up targetDir when manifestVersion is not 1', async () => {
      const pluginsDir = join(tmpDir, 'plugins')
      const installer = new NpmPluginInstaller(pluginsDir)

      const pluginName = 'wrong-version'

      mockDownload.mockImplementation(async (_spec: string, targetDir: string) => {
        await mkdir(targetDir, { recursive: true })
        await writeFile(
          join(targetDir, 'package.json'),
          JSON.stringify({
            name: pluginName,
            version: '1.0.0',
            taijiPlugin: { manifestVersion: 2 },
          }),
          'utf-8',
        )
        return { name: pluginName, version: '1.0.0' }
      })

      const result = await installer.install(pluginName)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Not a valid taiji plugin')

      // targetDir 应已被清理
      const targetDir = join(pluginsDir, pluginName)
      await expect(access(targetDir)).rejects.toThrow()
    })
  })

  describe('install - package.json missing after extract (cleanup leak guard)', () => {
    it('should clean up targetDir when package.json is missing after extract', async () => {
      const pluginsDir = join(tmpDir, 'plugins')
      const installer = new NpmPluginInstaller(pluginsDir)

      const pluginName = 'no-pkg-json'

      // downloadPackageTarball 成功（建了 targetDir）但没写 package.json。
      mockDownload.mockImplementation(async (_spec: string, targetDir: string) => {
        await mkdir(targetDir, { recursive: true })
        // 故意不写 package.json —— readFile 将抛 ENOENT
        return { name: pluginName, version: '1.0.0' }
      })

      const result = await installer.install(pluginName)

      expect(result.success).toBe(false)

      // targetDir 必须被清理，不能残留僵尸目录（registry.scan 会扫到并 warn）
      const targetDir = join(pluginsDir, pluginName)
      await expect(access(targetDir)).rejects.toThrow()
    })

    it('should clean up targetDir when package.json is corrupt JSON', async () => {
      const pluginsDir = join(tmpDir, 'plugins')
      const installer = new NpmPluginInstaller(pluginsDir)

      const pluginName = 'corrupt-pkg'

      mockDownload.mockImplementation(async (_spec: string, targetDir: string) => {
        await mkdir(targetDir, { recursive: true })
        await writeFile(join(targetDir, 'package.json'), '{ not valid json', 'utf-8')
        return { name: pluginName, version: '1.0.0' }
      })

      const result = await installer.install(pluginName)

      expect(result.success).toBe(false)

      const targetDir = join(pluginsDir, pluginName)
      await expect(access(targetDir)).rejects.toThrow()
    })
  })

  describe('install - download failure', () => {
    it('should return error when downloadPackageTarball throws', async () => {
      const pluginsDir = join(tmpDir, 'plugins')
      const installer = new NpmPluginInstaller(pluginsDir)

      mockDownload.mockRejectedValue(new Error('registry network error'))

      const result = await installer.install('some-package')

      expect(result.success).toBe(false)
      expect(result.error).toContain('registry network error')
    })
  })

  describe('uninstall', () => {
    it('should remove the plugin directory', async () => {
      const pluginsDir = join(tmpDir, 'plugins')
      const pluginPath = join(pluginsDir, 'test-plugin')
      await mkdir(pluginPath, { recursive: true })
      await writeFile(join(pluginPath, 'package.json'), '{}', 'utf-8')

      const installer = new NpmPluginInstaller(pluginsDir)
      await installer.uninstall('test-plugin', pluginPath)

      // Directory should be gone
      await expect(readFile(join(pluginPath, 'package.json'), 'utf-8')).rejects.toThrow()
    })
  })
})
