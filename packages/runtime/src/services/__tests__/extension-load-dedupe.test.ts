/**
 * ExtensionService.getExtensionPaths 加载层同名去重（P7 冲突防护）集成测试。
 *
 * 场景：同一 extension（package.json.name 相同）同时出现在 discovery 目录
 *（如 ~/.pi/agent/extensions）与 settings.json packages[] 的 npm 安装目录时，
 * 旧行为两条路径都注入 --extension → pi 报 Tool conflicts → exit 1 → session 无法激活。
 * 修复后加载链路只注入受管（npm）版一份；单路径场景行为不变。
 *
 * 测试用真实 ExtensionResolver + 真实 tmpdir（discovery 目录 + npm 目录构造同名扩展），
 * 断言 getExtensionPaths 的去重后注入列表。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/extension-load-dedupe.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExtensionService } from '../extension-service.js'
import { ExtensionResolver } from '../../infra/installers/extension-resolver.js'
import { setSettingsPath, getActiveSettingsPath } from '../../infra/pi/pi-settings-store.js'
import type { IInstaller } from '../ports/installer.js'
import type { IExtensionSettings } from '../ports/extension-settings.js'
import type { IConfigStore } from '../ports/config.js'

// 测试包名必须是非 builtin 包：builtin（mandatory-extensions.json SSOT）中的 infrastructure
// 级（pi-session-reader 等 3 包）不可禁（disabled 记录无效、强加载），「受管版 disabled 占位」
// 语义只适用于 user/feature 级扩展。pi-vision 不在 builtin 清单。
const EXT_NAME = '@zhushanwen/pi-vision'

/** 写一个有效 pi extension 的 package.json（keywords 含 pi-package）。 */
function writeExtensionPkg(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      keywords: ['pi-package'],
      peerDependencies: { 'pi-coding-agent': '^0.82.0' },
    }),
    'utf-8',
  )
}

/** 构造 discovery 目录下的扩展（复刻 ~/.pi/agent/extensions 平铺布局：子目录 = 一个扩展）。 */
function writeDiscoveryExtension(discoveryRoot: string, leafName: string, name: string): string {
  const dir = join(discoveryRoot, leafName)
  writeExtensionPkg(dir, name)
  writeFileSync(join(dir, 'index.ts'), 'export const tools = []\n', 'utf-8')
  return dir
}

function createMockInstaller(): IInstaller {
  return {
    installNpm: vi.fn().mockResolvedValue(undefined),
    uninstallNpm: vi.fn().mockResolvedValue(undefined),
    installDeps: vi.fn().mockResolvedValue(undefined),
    installGit: vi.fn().mockResolvedValue(undefined),
    getLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
  }
}

interface Fixture {
  service: ExtensionService
  /** npm 安装目录下的扩展路径（settings 源定位） */
  npmPkgDir: string
  /** discovery 物理目录（按 opts.discoveryDirs 下标） */
  discoveryDirs: string[]
  root: string
}

/** 注册的临时根目录，afterEach 统一清理。 */
const registeredRoots: string[] = []

/**
 * 构造 ExtensionService fixture：真实 ExtensionResolver + 真实 tmpdir 文件系统。
 * - settings.json 写入 packages[]（经 setSettingsPath 指向，模拟 settings 源）
 * - npmDir 下构造 node_modules/<pkg>（settings 源定位的 npm 安装版）
 * - discoveryDirs 按下标创建物理目录（getExtensionDirs 返回）
 */
function setup(opts: { discoveryDirs: string[]; packages: string[]; disabled: string[] }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ext-dedupe-'))
  registeredRoots.push(root)
  const settingsDir = join(root, 'settings')
  const npmDir = join(root, 'npm')

  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ packages: opts.packages }), 'utf-8')
  setSettingsPath(join(settingsDir, 'settings.json'))

  const discoveryDirs = opts.discoveryDirs.map((_, i) => join(root, `discovery-${i}`))
  for (const d of discoveryDirs) mkdirSync(d, { recursive: true })

  const npmPkgDir = join(npmDir, 'node_modules', EXT_NAME)
  if (opts.packages.includes(`npm:${EXT_NAME}`)) {
    writeExtensionPkg(npmPkgDir, EXT_NAME)
  }

  const service = new ExtensionService({
    settingsDir,
    projectRoot: root,
    packaged: false,
    installer: createMockInstaller(),
    resolver: new ExtensionResolver({ npmDir, settingsDir }),
    extensionSettings: {
      getPackages: () => opts.packages,
      getDisabled: () => opts.disabled,
      getAutoUpgrade: () => [],
      addPackage: vi.fn().mockResolvedValue(undefined),
      removePackage: vi.fn().mockResolvedValue(undefined),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      setAutoUpgrade: vi.fn().mockResolvedValue(undefined),
    } as unknown as IExtensionSettings,
    configStore: { getExtensionDirs: () => discoveryDirs } as unknown as IConfigStore,
    extensionsDir: join(root, 'extensions'),
    npmDir,
    tmpDir: join(root, 'tmp'),
  })

  return { service, npmPkgDir, discoveryDirs, root }
}

describe('ExtensionService.getExtensionPaths 同名去重（P7）', () => {
  beforeEach(() => {
    // 静默 dev 模式 builtin 路径缺失 warn + 去重 skip warn
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setSettingsPath(getActiveSettingsPath())
    for (const r of registeredRoots.splice(0)) {
      rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('双路径同名：discovery 目录 + settings npm 版 → 注入列表只含 npm 版一份', async () => {
    const { service, npmPkgDir, discoveryDirs } = setup({
      discoveryDirs: [EXT_NAME],
      packages: [`npm:${EXT_NAME}`],
      disabled: [],
    })
    writeDiscoveryExtension(discoveryDirs[0], 'pi-session-reader', EXT_NAME)

    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([npmPkgDir])
    expect(paths).toHaveLength(1)
  })

  it('单路径（仅 discovery 目录）：注入 discovery 版，行为不变', async () => {
    const { service, discoveryDirs } = setup({ discoveryDirs: [EXT_NAME], packages: [], disabled: [] })
    const discoveryPkgDir = writeDiscoveryExtension(discoveryDirs[0], 'pi-session-reader', EXT_NAME)
    // discovery 源注入的是入口文件路径（复刻 pi collectAutoExtensionEntries，--extension 接受文件入口）
    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([join(discoveryPkgDir, 'index.ts')])
  })

  it('单路径（仅 settings npm 版）：注入 npm 版，行为不变', async () => {
    const { service, npmPkgDir } = setup({ discoveryDirs: [], packages: [`npm:${EXT_NAME}`], disabled: [] })

    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([npmPkgDir])
  })

  it('双路径不同名扩展：各自保留，不误杀其他扩展', async () => {
    const { service, npmPkgDir, discoveryDirs } = setup({
      discoveryDirs: [EXT_NAME],
      packages: [`npm:${EXT_NAME}`],
      disabled: [],
    })
    writeDiscoveryExtension(discoveryDirs[0], 'pi-session-reader', EXT_NAME)
    const otherDiscoveryEntry = join(writeDiscoveryExtension(discoveryDirs[0], 'pi-model-info', '@zhushanwen/pi-model-info'), 'index.ts')

    const paths = await service.getExtensionPaths()
    // resolver 按包名字母序输出（pi-model-info < pi-vision → discovery 版在前），
    // 去重不改变源顺序——断言顺序无关（两条都在、不误杀）
    expect(paths).toHaveLength(2)
    expect([...paths].sort()).toEqual([npmPkgDir, otherDiscoveryEntry].sort())
  })

  it('受管版被禁用时占位：npm 版 disabled → discovery 版不顶上（UI 禁用语义生效）', async () => {
    const { service, discoveryDirs } = setup({
      discoveryDirs: [EXT_NAME],
      packages: [`npm:${EXT_NAME}`],
      disabled: [`npm:${EXT_NAME}`],
    })
    writeDiscoveryExtension(discoveryDirs[0], 'pi-session-reader', EXT_NAME)

    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([])
  })

  it('多个 discovery 目录同名：保留第一个目录的版本', async () => {
    const { service, discoveryDirs } = setup({ discoveryDirs: [EXT_NAME, EXT_NAME], packages: [], disabled: [] })
    const dirA = writeDiscoveryExtension(discoveryDirs[0], 'reader-a', EXT_NAME)
    writeDiscoveryExtension(discoveryDirs[1], 'reader-b', EXT_NAME)

    const paths = await service.getExtensionPaths()
    expect(paths).toEqual([join(dirA, 'index.ts')])
  })
})
