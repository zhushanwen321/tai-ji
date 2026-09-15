/**
 * ExtensionService 扩展加载测试。
 *
 * 断言：
 * - 新的扩展包（@zhushanwen/pi-agent-ext 等）通过 mandatory-extensions.json 机制加载
 * - 旧的文件型扩展机制已被移除
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionService } from '../src/services/extension-service.js'
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js'
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js'
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'
import { refreshModels, setModelsPath } from '../src/infra/pi/pi-provider-store.js'
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

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}))

const mockedInstallPackage = vi.mocked(installPackage)
const mockedUninstallPackage = vi.mocked(uninstallPackage)
const mockedExecFileSync = vi.mocked(execFileSync)

let tmpRoot: string
let projectRoot: string
let settingsDir: string
let service: ExtensionService

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = mkdtempSync(join(tmpdir(), 'ext-system-prompt-'))
  projectRoot = join(tmpRoot, 'apps', 'electron')
  settingsDir = join(tmpRoot, 'settings')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(settingsDir, { recursive: true })

  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ packages: [] }), 'utf-8')
  setSettingsPath(join(settingsDir, 'settings.json'))
  setModelsPath(join(settingsDir, 'models.json'))
  refreshModels()

  service = new ExtensionService({
    settingsDir,
    projectRoot,
    packaged: false,
    installer: new NpmGitInstaller(),
    resolver: new ExtensionResolver({
      settingsDir,
      thirdPartyDir: join(settingsDir, 'extensions'),
      // Phase 1 路径迁移：npmDir 已从 settingsDir 子树迁出，注入回 settingsDir/npm 避免触碰真实 dataDir。
      npmDir: join(settingsDir, 'npm'),
    }),
    extensionSettings: new PiExtensionSettings(settingsDir),
    // Phase 1 路径迁移：extensions/npm/tmp 已从 settingsDir 子树迁出到 dataDir 根层，
    // 注入回 settingsDir 子目录让测试目录自洽（不依赖/污染真实 ~/.taiji）。
    extensionsDir: join(settingsDir, 'extensions'),
    npmDir: join(settingsDir, 'npm'),
    tmpDir: join(settingsDir, 'tmp'),
  })
})

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {
    // ignore cleanup errors
  }
})

describe('ExtensionService 扩展加载', () => {
  it('getExtensionPaths 返回空数组（旧文件型扩展已移除）', async () => {
    const paths = await service.getExtensionPaths()
    // 新的扩展通过 mandatory-extensions.json 机制加载，不在 getExtensionPaths 中
    expect(paths).toEqual([])
  })
})
