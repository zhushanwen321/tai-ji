/**
 * plugin-installer.test.ts — 安装器补齐（provider-plugin-access U4 / 设计 D11）。
 *
 * 覆盖点：
 * - S8：scoped 包装完可见 + 目录名 scope__pkg 形态（registry 扫描口径对齐）
 * - S18：两档失败回滚（manifest 校验失败 / 激活失败）后列表、目录、暂存、
 *   installed.json、注册表五处无残留 + 后续正常安装成功；更新场景旧版本幸存
 * - S22：namespace 不匹配拒绝（NAMESPACE_MISMATCH）且无残留；一致时推导值透传
 * - installed.json schema：只含 installedAt（版本与命名空间不落盘，D11）
 * - 卸载编排：命名空间前缀扫描派生清理集 → providers.delete 逐条（含 apiKey 条目）
 * - 两段式编排（prepare/confirm/cancel）、串行锁、启动清扫（恢复类）
 *
 * mock 层：downloadPackageTarball 被 vi.mock 替换，不触发真实 npm registry 网络；
 * 激活链 spy（activatePlugin 吞错以 getState 终态判定，单测层不 fork 真实插件进程）。
 * 写删目标全部 mkdtemp 自建自删（test-guard 防线约束）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile, access, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

// Mock remote-config 清单链（U7 双产物接线后 confirmPluginInstall 会查 v2-plugins 清单）：
// 默认回「无缓存且未刷新」（fail-safe 链尾 → config undefined → 跳过扩展安装），防既有
// 用例触真实网络/真实 ~/.taiji 缓存；双产物用例经 refreshRemoteConfigMock 注入 fixture 清单。
const refreshRemoteConfigMock = vi.fn()
vi.mock('../src/services/remote-config/remote-config-fetch.js', () => ({
  refreshRemoteConfig: (...args: unknown[]) => refreshRemoteConfigMock(...args),
  loadRemoteConfig: vi.fn(),
}))

// 延迟 import：vi.mock 会被提升到 import 之前，故此处能拿到 mocked 版本。
const { downloadPackageTarball } = await import('../src/infra/installers/npm-installer.js')
const { NpmPluginInstaller } = await import('../src/infra/installers/plugin-installer-adapter.js')
const { InstalledStore } = await import('../src/services/plugin-service/installed-store.js')
const { PluginRegistry } = await import('../src/services/plugin-service/plugin-registry.js')
const { PluginService, PLUGIN_PREPARE_FAILED } = await import('../src/services/plugin-service/plugin-service.js')
const { NAMESPACE_MISMATCH } = await import('@taiji/shared/plugin-namespace')

import type { PreparedPluginInstall } from '../src/services/ports/plugin-installer.js'

const mockDownload = vi.mocked(downloadPackageTarball)

let tmpDir: string
let pluginsDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  refreshRemoteConfigMock.mockResolvedValue({ data: undefined, refreshed: false, reason: 'network' })
  // 安装/卸载编排会落 warn（激活失败回滚、清理跳过等），测试不依赖控制台输出
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  tmpDir = await mkdtemp(join(tmpdir(), 'npm-plugin-installer-test-'))
  pluginsDir = join(tmpDir, 'plugins')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
  vi.restoreAllMocks()
})

/** 构造插件 package.json 内容（taijiPlugin manifest 字段按 opts 展开）。 */
function pkgJson(name: string, opts?: {
  version?: string
  manifestVersion?: number
  namespace?: string
  capabilities?: string[]
  readPaths?: string[]
  permissions?: string[]
  withMain?: boolean
}): string {
  const taijiPlugin: Record<string, unknown> = { manifestVersion: opts?.manifestVersion ?? 1 }
  if (opts?.namespace !== undefined) taijiPlugin.namespace = opts.namespace
  if (opts?.capabilities !== undefined) taijiPlugin.capabilities = opts.capabilities
  if (opts?.readPaths !== undefined) taijiPlugin.readPaths = opts.readPaths
  if (opts?.permissions !== undefined) taijiPlugin.permissions = opts.permissions
  return JSON.stringify(
    {
      name,
      version: opts?.version ?? '1.0.0',
      ...(opts?.withMain === false ? {} : { main: 'index.js' }),
      taijiPlugin,
    },
    null,
    2,
  )
}

/** mockDownload 变体：在 targetDir 写入给定 fixture（strip=1 解压后包内容落根）。 */
function mockDownloadWrites(pkg: string): void {
  mockDownload.mockImplementation(async (_spec: string, targetDir: string) => {
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'package.json'), pkg, 'utf-8')
    const parsed = JSON.parse(pkg) as { name: string; version?: string }
    return { name: parsed.name, version: parsed.version ?? '0.0.0' }
  })
}

/** 直接在 pluginsDir 下放置插件目录（预置已安装形态用）。 */
async function writePluginDir(dirName: string, pkg: string): Promise<string> {
  const dir = join(pluginsDir, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), pkg, 'utf-8')
  await writeFile(join(dir, 'index.js'), 'export default {}', 'utf-8')
  return dir
}

function newInstaller(): InstanceType<typeof NpmPluginInstaller> {
  return new NpmPluginInstaller(pluginsDir)
}

function newRegistry(): InstanceType<typeof PluginRegistry> {
  return new PluginRegistry(tmpDir, tmpDir, join(tmpDir, 'no-builtin-dir'))
}

interface ProviderEntriesFake {
  listIds: ReturnType<typeof vi.fn<() => Promise<string[]>>>
  delete: ReturnType<typeof vi.fn<(providerId: string) => Promise<void>>>
}

function makeProviderEntries(ids: string[]): ProviderEntriesFake {
  return {
    listIds: vi.fn(async () => [...ids]),
    delete: vi.fn(async () => {}),
  }
}

/** piExtensionInstaller port fake（U7/U4 双产物接线用例）：记录 install/uninstall 入参。 */
function makePiExtensionInstaller(): {
  installForCatalogEntry: ReturnType<typeof vi.fn<(entry: { packageName: string; piExtensionVersion: string }) => Promise<{ installedVersion: string }>>>
  uninstallForCatalogEntry: ReturnType<typeof vi.fn<(packageName: string) => Promise<void>>>
} {
  return {
    installForCatalogEntry: vi.fn(async () => ({ installedVersion: '0.2.0' })),
    uninstallForCatalogEntry: vi.fn(async () => {}),
  }
}

function buildService(opts?: {
  providerEntries?: ProviderEntriesFake
  piExtensionInstaller?: ReturnType<typeof makePiExtensionInstaller>
}): {
  service: InstanceType<typeof PluginService>
  registry: InstanceType<typeof PluginRegistry>
  broker: { send: ReturnType<typeof vi.fn>; broadcast: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
} {
  const registry = newRegistry()
  const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
  const service = new PluginService(registry, broker, {
    configDir: tmpDir,
    pluginInstaller: newInstaller(),
    ...(opts?.providerEntries ? { providerEntries: opts.providerEntries } : {}),
    ...(opts?.piExtensionInstaller ? { piExtensionInstaller: opts.piExtensionInstaller } : {}),
  })
  return { service, registry, broker }
}

/** spy 激活链：activatePlugin 吞错不抛，成败以 getState 终态判定（实现同款判据）。 */
function mockActivation(service: InstanceType<typeof PluginService>, outcome: 'ACTIVE' | 'CRASHED'): void {
  vi.spyOn(service.activator, 'activatePlugin').mockResolvedValue(undefined)
  vi.spyOn(service.activator, 'getState').mockReturnValue(outcome)
}

async function readInstalledJson(): Promise<Record<string, unknown>> {
  // 登记文件可能尚未创建（安装未发生过 = 无残留的断言形态），缺失按空表
  try {
    const raw = await readFile(join(pluginsDir, 'installed.json'), 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function stagingEntries(): Promise<string[]> {
  try {
    return await readdir(join(pluginsDir, '.staging'))
  } catch {
    return []
  }
}

// ── NpmPluginInstaller：prepareInstall（第一段）─────────────────────

describe('NpmPluginInstaller.prepareInstall', () => {
  it('scoped 包解压至暂存，dirName 为 scope__pkg 安全化形态', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('@scope/test-plugin', { namespace: 'test-plugin' }))

    const result = await installer.prepareInstall('@scope/test-plugin@1.0.0')

    expect(result.success).toBe(true)
    const prepared = result.prepared!
    expect(prepared.dirName).toBe('scope__test-plugin')
    expect(prepared.stagingPath).toBe(join(pluginsDir, '.staging', 'scope__test-plugin'))
    expect(prepared.packageName).toBe('@scope/test-plugin')
    expect(prepared.version).toBe('1.0.0')
    expect(existsSync(join(prepared.stagingPath, 'package.json'))).toBe(true)
  })

  it('manifest 知情面全量透传（capabilities / readPaths / permissions / namespace）', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('plugin-wool-workbuddy', {
      namespace: 'wool-workbuddy',
      capabilities: ['network.http', 'crypto'],
      readPaths: ['Library/Application Support/WorkBuddy'],
      permissions: ['providers.write'],
    }))

    const result = await installer.prepareInstall('plugin-wool-workbuddy')

    expect(result.success).toBe(true)
    expect(result.prepared!.capabilities).toEqual(['network.http', 'crypto'])
    expect(result.prepared!.readPaths).toEqual(['Library/Application Support/WorkBuddy'])
    expect(result.prepared!.permissions).toEqual(['providers.write'])
    expect(result.prepared!.namespace).toBe('wool-workbuddy')
  })

  it('manifestVersion ≠ 1 → 拒装且暂存无残留', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('bad-plugin', { manifestVersion: 2 }))

    const result = await installer.prepareInstall('bad-plugin')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Not a valid taiji plugin')
    expect(existsSync(join(pluginsDir, '.staging', 'bad-plugin'))).toBe(false)
  })

  it('manifest 未声明 namespace → prepared.namespace 为 undefined（非 provider 插件常态）', async () => {
    const installer = newInstaller()
    mockDownloadWrites(pkgJson('plain-plugin'))

    const result = await installer.prepareInstall('plain-plugin')

    expect(result.success).toBe(true)
    expect(result.prepared!.namespace).toBeUndefined()
    expect(result.prepared!.capabilities).toEqual([])
  })

  it('下载失败 → success:false 且无暂存残留', async () => {
    const installer = newInstaller()
    mockDownload.mockRejectedValue(new Error('registry network error'))

    const result = await installer.prepareInstall('some-package')

    expect(result.success).toBe(false)
    expect(result.error).toContain('registry network error')
    expect(existsSync(join(pluginsDir, '.staging', 'some-package'))).toBe(false)
  })

  it('同插件重复 prepare 先清旧暂存（幂等重下）', async () => {
    const installer = newInstaller()
    const staleMarker = join(pluginsDir, '.staging', 'my-plugin', 'stale.txt')
    await mkdir(join(pluginsDir, '.staging', 'my-plugin'), { recursive: true })
    await writeFile(staleMarker, 'leftover', 'utf-8')
    mockDownloadWrites(pkgJson('my-plugin'))

    const result = await installer.prepareInstall('my-plugin')

    expect(result.success).toBe(true)
    expect(existsSync(staleMarker)).toBe(false)
    expect(existsSync(join(result.prepared!.stagingPath, 'package.json'))).toBe(true)
  })
})

// ── NpmPluginInstaller：commitInstall / rollbackInstall（第二段与回滚）──

describe('NpmPluginInstaller.commitInstall', () => {
  function preparedOf(dirName: string): PreparedPluginInstall {
    return {
      dirName,
      packageName: `@scope/${dirName.replace('__', '/')}`,
      version: '1.0.0',
      stagingPath: join(pluginsDir, '.staging', dirName),
      capabilities: [],
      readPaths: [],
      permissions: [],
    }
  }

  it('首次提交：暂存单步换入正式目录，暂存消失', async () => {
    const installer = newInstaller()
    const dirName = 'scope__app'
    await mkdir(join(pluginsDir, '.staging', dirName), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', dirName, 'package.json'), pkgJson('pkg'), 'utf-8')

    const result = await installer.commitInstall(preparedOf(dirName))

    expect(result.success).toBe(true)
    expect(result.pluginId).toBe(dirName)
    expect(result.path).toBe(join(pluginsDir, dirName))
    expect(existsSync(join(pluginsDir, dirName, 'package.json'))).toBe(true)
    expect(await stagingEntries()).toEqual([])
  })

  it('更新提交：旧版本被替换入 replacing 位（保留至激活终局清理），新版入位', async () => {
    const installer = newInstaller()
    const dirName = 'my-plugin'
    await writePluginDir(dirName, pkgJson('my-plugin', { version: '1.0.0' }))
    await mkdir(join(pluginsDir, '.staging', dirName), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', dirName, 'package.json'), pkgJson('my-plugin', { version: '2.0.0' }), 'utf-8')

    const result = await installer.commitInstall(preparedOf(dirName))

    expect(result.success).toBe(true)
    const newPkg = JSON.parse(await readFile(join(pluginsDir, dirName, 'package.json'), 'utf-8')) as { version: string }
    expect(newPkg.version).toBe('2.0.0')
    // replacing 位保留（提交后激活失败的回滚仍需旧版本），激活成功后由 discardReplaced 清理
    const replacingPkg = JSON.parse(
      await readFile(join(pluginsDir, '.staging', `.replacing-${dirName}`, 'package.json'), 'utf-8'),
    ) as { version: string }
    expect(replacingPkg.version).toBe('1.0.0')

    await installer.discardReplaced(preparedOf(dirName))
    expect(await stagingEntries()).toEqual([])
  })

  it('换入失败（暂存缺失）→ success:false 且旧版本目录幸存、内容不变', async () => {
    const installer = newInstaller()
    const dirName = 'my-plugin'
    await writePluginDir(dirName, pkgJson('my-plugin', { version: '1.0.0' }))
    // prepared.stagingPath 指向不存在的暂存 → rename 必败（ENOENT）

    const result = await installer.commitInstall(preparedOf(dirName))

    expect(result.success).toBe(false)
    const oldPkg = JSON.parse(await readFile(join(pluginsDir, dirName, 'package.json'), 'utf-8')) as { version: string }
    expect(oldPkg.version).toBe('1.0.0')
  })
})

describe('NpmPluginInstaller.rollbackInstall', () => {
  async function preparedWithStaging(dirName: string, stagingVersion: string): Promise<PreparedPluginInstall> {
    await mkdir(join(pluginsDir, '.staging', dirName), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', dirName, 'package.json'), pkgJson(dirName, { version: stagingVersion }), 'utf-8')
    return {
      dirName,
      packageName: dirName,
      version: stagingVersion,
      stagingPath: join(pluginsDir, '.staging', dirName),
      capabilities: [],
      readPaths: [],
      permissions: [],
    }
  }

  it('无旧版本：删除刚提交的新版目录', async () => {
    const installer = newInstaller()
    const prepared = await preparedWithStaging('my-plugin', '2.0.0')
    await installer.commitInstall(prepared)
    expect(existsSync(join(pluginsDir, 'my-plugin'))).toBe(true)

    await installer.rollbackInstall(prepared)

    expect(existsSync(join(pluginsDir, 'my-plugin'))).toBe(false)
  })

  it('更新场景：新版删除、旧版本从替换位恢复（旧版本幸存）', async () => {
    const installer = newInstaller()
    const dirName = 'my-plugin'
    await writePluginDir(dirName, pkgJson('my-plugin', { version: '1.0.0' }))
    const prepared = await preparedWithStaging(dirName, '2.0.0')
    await installer.commitInstall(prepared)
    // 模拟提交完成、激活失败的现场：replacing 位留有旧版 1.0.0
    const replacingPath = join(pluginsDir, '.staging', `.replacing-${dirName}`)
    await mkdir(join(pluginsDir, '.staging'), { recursive: true })
    await rm(replacingPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await mkdir(replacingPath, { recursive: true })
    await writeFile(join(replacingPath, 'package.json'), pkgJson(dirName, { version: '1.0.0' }), 'utf-8')

    await installer.rollbackInstall(prepared)

    expect(existsSync(join(pluginsDir, dirName, 'package.json'))).toBe(true)
    const restoredPkg = JSON.parse(await readFile(join(pluginsDir, dirName, 'package.json'), 'utf-8')) as { version: string }
    expect(restoredPkg.version).toBe('1.0.0')
    expect(await stagingEntries()).toEqual([])
  })
})

describe('NpmPluginInstaller.sweepStaging（启动清扫，恢复类）', () => {
  it('正常暂存残留 → 删除', async () => {
    const installer = newInstaller()
    await mkdir(join(pluginsDir, '.staging', 'half-installed'), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', 'half-installed', 'package.json'), '{}', 'utf-8')

    await installer.sweepStaging()

    expect(existsSync(join(pluginsDir, '.staging', 'half-installed'))).toBe(false)
  })

  it('替换位残留 + 正式位缺失 → 旧版本恢复为正式目录', async () => {
    const installer = newInstaller()
    const replacingPath = join(pluginsDir, '.staging', '.replacing-my-plugin')
    await mkdir(replacingPath, { recursive: true })
    await writeFile(join(replacingPath, 'package.json'), pkgJson('my-plugin', { version: '1.0.0' }), 'utf-8')

    await installer.sweepStaging()

    expect(existsSync(join(pluginsDir, 'my-plugin', 'package.json'))).toBe(true)
    expect(await stagingEntries()).toEqual([])
  })

  it('替换位残留 + 正式位存在（新版已入位）→ 替换位删除', async () => {
    const installer = newInstaller()
    await writePluginDir('my-plugin', pkgJson('my-plugin', { version: '2.0.0' }))
    const replacingPath = join(pluginsDir, '.staging', '.replacing-my-plugin')
    await mkdir(replacingPath, { recursive: true })
    await writeFile(join(replacingPath, 'package.json'), pkgJson('my-plugin', { version: '1.0.0' }), 'utf-8')

    await installer.sweepStaging()

    const curPkg = JSON.parse(await readFile(join(pluginsDir, 'my-plugin', 'package.json'), 'utf-8')) as { version: string }
    expect(curPkg.version).toBe('2.0.0')
    expect(await stagingEntries()).toEqual([])
  })

  it('暂存区不存在 → no-op 不抛', async () => {
    const installer = newInstaller()
    await expect(installer.sweepStaging()).resolves.toBeUndefined()
  })
})

describe('NpmPluginInstaller.uninstall', () => {
  it('删除插件目录', async () => {
    const dir = await writePluginDir('test-plugin', pkgJson('test-plugin'))
    const installer = newInstaller()

    await installer.uninstall('test-plugin', dir)

    await expect(readFile(join(dir, 'package.json'), 'utf-8')).rejects.toThrow()
  })
})

// ── InstalledStore：installed.json（只记安装时间，D11）──────────────

describe('InstalledStore', () => {
  function newStore(): InstanceType<typeof InstalledStore> {
    return new InstalledStore(pluginsDir)
  }

  it('recordInstalled 后 schema 只含 installedAt（版本与命名空间不落盘）', async () => {
    const store = newStore()

    await store.recordInstalled('my-plugin', '2026-10-24T00:00:00.000Z')

    const file = await readInstalledJson()
    expect(file).toEqual({ 'my-plugin': { installedAt: '2026-10-24T00:00:00.000Z' } })
    const entry = file['my-plugin'] as Record<string, unknown>
    expect(Object.keys(entry)).toEqual(['installedAt'])
  })

  it('recordUninstalled 移除条目', async () => {
    const store = newStore()
    await store.recordInstalled('a')
    await store.recordInstalled('b')

    await store.recordUninstalled('a')

    const file = await readInstalledJson()
    expect(Object.keys(file)).toEqual(['b'])
  })

  it('load：文件缺失 → 空表；损坏 JSON → 空表（容错不抛）', async () => {
    const store = newStore()
    expect(await store.load()).toEqual({})

    await mkdir(pluginsDir, { recursive: true })
    await writeFile(join(pluginsDir, 'installed.json'), '{ not json', 'utf-8')
    expect(await store.load()).toEqual({})
  })
})

// ── PluginRegistry：扫描口径与安装目录名对齐（S8）──────────────────

describe('PluginRegistry 扫描口径', () => {
  it('scope__pkg 目录形态被发现，pluginId 即目录名，version 读包内 package.json', async () => {
    await writePluginDir('scope__test-plugin', pkgJson('@scope/test-plugin', { version: '3.2.1' }))
    const registry = newRegistry()

    const descriptors = await registry.scan()

    const found = descriptors.find(d => d.pluginId === 'scope__test-plugin')
    expect(found).toBeDefined()
    expect(found!.version).toBe('3.2.1')
  })

  it('.staging 等辅助目录不作为插件扫描', async () => {
    await writePluginDir('real-plugin', pkgJson('real-plugin'))
    await mkdir(join(pluginsDir, '.staging', 'half-installed'), { recursive: true })
    await writeFile(join(pluginsDir, '.staging', 'half-installed', 'package.json'), pkgJson('half-installed'), 'utf-8')
    const registry = newRegistry()

    const descriptors = await registry.scan()

    expect(descriptors.map(d => d.pluginId)).toEqual(['real-plugin'])
  })
})

// ── PluginService：两段式编排 + 回滚 + 卸载清理（S8 / S18 / S22）────

describe('PluginService 两段式安装编排', () => {
  it('prepare → 确认卡知情面；confirm → 提交落盘 + 注册 + installed.json 登记 + 广播（S27/S8）', async () => {
    const { service, registry, broker } = buildService()
    mockDownloadWrites(pkgJson('@scope/test-plugin', {
      namespace: 'test-plugin',
      capabilities: ['network.http'],
      readPaths: ['some/path'],
    }))
    mockActivation(service, 'ACTIVE')

    const preview = await service.preparePluginInstall('@scope/test-plugin@1.0.0')
    expect(preview.pluginId).toBe('scope__test-plugin')
    expect(preview.packageName).toBe('@scope/test-plugin')
    expect(preview.capabilities).toEqual(['network.http'])
    expect(preview.readPaths).toEqual(['some/path'])
    expect(preview.namespace).toBe('test-plugin')
    // 未确认不落盘：只有暂存，正式目录未触及
    expect(existsSync(join(pluginsDir, 'scope__test-plugin'))).toBe(false)

    const result = await service.confirmPluginInstall('scope__test-plugin')

    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('scope__test-plugin')
    expect(existsSync(join(pluginsDir, 'scope__test-plugin', 'package.json'))).toBe(true)
    expect(registry.getDescriptor('scope__test-plugin')).toBeDefined()
    const installed = await readInstalledJson()
    expect(Object.keys(installed)).toEqual(['scope__test-plugin'])
    expect(broker.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'config.plugins' }))
  })

  it('cancel → 暂存清理，再 confirm 报无 pending（未确认不发生安装落盘）', async () => {
    const { service } = buildService()
    mockDownloadWrites(pkgJson('cancel-me'))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('cancel-me')
    expect(existsSync(join(pluginsDir, '.staging', 'cancel-me'))).toBe(true)

    await service.cancelPluginInstall('cancel-me')

    expect(existsSync(join(pluginsDir, '.staging', 'cancel-me'))).toBe(false)
    const result = await service.confirmPluginInstall('cancel-me')
    expect(result.success).toBe(false)
    expect(existsSync(join(pluginsDir, 'cancel-me'))).toBe(false)
  })

  it('confirm 无 pending 登记 → success:false', async () => {
    const { service } = buildService()
    const result = await service.confirmPluginInstall('never-prepared')
    expect(result.success).toBe(false)
  })

  it('S22：namespace 不匹配 → prepare 抛 NAMESPACE_MISMATCH 且列表/目录/暂存无残留', async () => {
    const { service, registry } = buildService()
    mockDownloadWrites(pkgJson('@scope/test-plugin', { namespace: 'totally-different' }))

    const err = await service.preparePluginInstall('@scope/test-plugin@1.0.0').catch((e: unknown) => e)

    expect((err as Error).message).toContain('NAMESPACE_MISMATCH')
    expect((err as { code?: string }).code).toBe(NAMESPACE_MISMATCH)
    expect(registry.getAllDescriptors()).toEqual([])
    expect(existsSync(join(pluginsDir, 'scope__test-plugin'))).toBe(false)
    expect(await stagingEntries()).toEqual([])
  })

  it('S22 反例：namespace 声明与包名推导一致 → prepare 成功且 namespace 为推导值', async () => {
    const { service } = buildService()
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    const preview = await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')

    expect(preview.namespace).toBe('wool-workbuddy')
  })

  it('S18 档 1：manifest 校验失败 → 五处无残留 + 后续正常安装成功', async () => {
    const { service, registry } = buildService()
    mockDownloadWrites(pkgJson('broken-plugin', { manifestVersion: 2 }))
    mockActivation(service, 'ACTIVE')

    const result = await service.installPlugin('broken-plugin')

    expect(result.success).toBe(false)
    // 五处无残留：列表 / 注册表 / 插件目录 / 暂存 / installed.json
    expect(service.getDiscoveredPlugins().map(p => p.pluginId)).not.toContain('broken-plugin')
    expect(registry.getDescriptor('broken-plugin')).toBeUndefined()
    expect(existsSync(join(pluginsDir, 'broken-plugin'))).toBe(false)
    expect(await stagingEntries()).toEqual([])
    expect(await readInstalledJson()).toEqual({})

    // 后续正常安装成功
    mockDownloadWrites(pkgJson('good-plugin'))
    const second = await service.installPlugin('good-plugin')
    expect(second.success).toBe(true)
    expect(existsSync(join(pluginsDir, 'good-plugin', 'package.json'))).toBe(true)
  })

  it('S18 档 2：激活失败 → 五处无残留、旧版本幸存（更新场景）+ 后续正常安装成功', async () => {
    const { service, registry } = buildService()
    // 预置已安装旧版本 1.0.0
    await writePluginDir('upgradable', pkgJson('upgradable', { version: '1.0.0' }))
    const registryBefore = await registry.scan()
    expect(registryBefore.find(d => d.pluginId === 'upgradable')).toBeDefined()

    // 更新到 2.0.0，激活失败（getState = CRASHED）
    mockDownloadWrites(pkgJson('upgradable', { version: '2.0.0' }))
    mockActivation(service, 'CRASHED')

    const result = await service.installPlugin('upgradable')

    expect(result.success).toBe(false)
    expect(result.error).toContain('rolled back')
    // 五处无残留（新版）
    expect(existsSync(join(pluginsDir, '.staging', 'upgradable'))).toBe(false)
    expect(await stagingEntries()).toEqual([])
    const installed = await readInstalledJson()
    expect(Object.keys(installed)).not.toContain('upgradable')
    // 旧版本幸存：目录内容回到 1.0.0，注册表重扫后仍是旧版
    const oldPkg = JSON.parse(await readFile(join(pluginsDir, 'upgradable', 'package.json'), 'utf-8')) as { version: string }
    expect(oldPkg.version).toBe('1.0.0')
    const after = await registry.scan()
    expect(after.find(d => d.pluginId === 'upgradable')?.version).toBe('1.0.0')

    // 后续正常安装成功（激活恢复）
    mockActivation(service, 'ACTIVE')
    mockDownloadWrites(pkgJson('fresh-after-rollback'))
    const second = await service.installPlugin('fresh-after-rollback')
    expect(second.success).toBe(true)
    expect(Object.keys(await readInstalledJson())).toContain('fresh-after-rollback')
  })

  it('直通 installPlugin（旧通道）：prepare + commit 一次完成，含激活与登记', async () => {
    const { service, registry, broker } = buildService()
    mockDownloadWrites(pkgJson('direct-plugin'))
    mockActivation(service, 'ACTIVE')

    const result = await service.installPlugin('direct-plugin')

    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('direct-plugin')
    expect(registry.getDescriptor('direct-plugin')).toBeDefined()
    expect(Object.keys(await readInstalledJson())).toEqual(['direct-plugin'])
    expect(broker.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'config.plugins' }))
  })

  // ── R-1（2026-10-24 裁决）：更新链先 terminate 旧沙箱进程再激活（进程即模块边界）──
  // 单测层断言机制（terminate 先于 activatePlugin 的调用顺序 + trusted 跳过 + 回滚
  // 重激活）；真 fork 的「新代码生效 / PID 变化」终验归真机 a26 剧本（本层不 spawn）。

  it('R-1：已激活插件更新 → commit 后、activatePlugin 前 terminate 旧 sandbox fork', async () => {
    const { service } = buildService()
    await writePluginDir('upgradable', pkgJson('upgradable', { version: '1.0.0' }))
    mockDownloadWrites(pkgJson('upgradable', { version: '2.0.0' }))
    mockActivation(service, 'ACTIVE')
    const terminate = vi.spyOn(service.host, 'terminateWorker').mockResolvedValue(undefined)
    vi.spyOn(service.host, 'getWorkerHandle').mockReturnValue({ workerId: 'sandbox-42', postMessage: vi.fn() })

    const result = await service.installPlugin('upgradable')

    expect(result.success).toBe(true)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledWith('sandbox-42')
    // 顺序 = 缺陷本体：terminate 必须先于激活（否则 assignProcess 复用旧 fork + ESM
    // 模块缓存，更新后仍跑旧代码）
    expect(terminate.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(service.activator.activatePlugin).mock.invocationCallOrder[0]!,
    )
  })

  it('R-1：trusted 共享 Worker（非 sandbox- 前缀）→ 不 terminate（镜像卸载侧跳过判定）', async () => {
    const { service } = buildService()
    mockDownloadWrites(pkgJson('trusted-plugin'))
    mockActivation(service, 'ACTIVE')
    const terminate = vi.spyOn(service.host, 'terminateWorker').mockResolvedValue(undefined)
    vi.spyOn(service.host, 'getWorkerHandle').mockReturnValue({ workerId: 'worker-7', postMessage: vi.fn() })

    const result = await service.installPlugin('trusted-plugin')

    expect(result.success).toBe(true)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('R-1：必败包更新（激活失败）→ 旧沙箱终结 + 回滚可达 + 旧版本重激活', async () => {
    const { service } = buildService()
    await writePluginDir('upgradable', pkgJson('upgradable', { version: '1.0.0' }))
    mockDownloadWrites(pkgJson('upgradable', { version: '2.0.0' }))
    mockActivation(service, 'CRASHED')
    const terminate = vi.spyOn(service.host, 'terminateWorker').mockResolvedValue(undefined)
    vi.spyOn(service.host, 'getWorkerHandle').mockReturnValue({ workerId: 'sandbox-9', postMessage: vi.fn() })

    const result = await service.installPlugin('upgradable')

    expect(result.success).toBe(false)
    expect(result.error).toContain('rolled back')
    expect(terminate).toHaveBeenCalledWith('sandbox-9')
    // 回滚分支对恢复的旧版本 best-effort 重激活（S26「旧版本幸存可用」的进程态语义：
    // 旧沙箱已终结，旧代码在新 fork 中重新激活，而非依赖被终结的旧进程）
    expect(vi.mocked(service.activator.activatePlugin)).toHaveBeenCalledTimes(2)
    // D6 B1：回滚分支 removeDescriptor 后必须 registerDescriptors 回填（reload 恢复的
    // 旧版 descriptor），否则 activatePlugin 开头 descriptor 缺失静默 no-op = 重激活死路径。
    // 行为判据 = 回滚后 descriptors 表含本插件（activatePlugin 的 no-op 前置不再成立）
    expect(service.activator.getState('upgradable')).toBe('CRASHED') // mock 终态可达 = descriptor 在表内（真实实现不再 no-op）
    expect(service.registry.getDescriptor('upgradable')).toBeDefined()
    const oldPkg = JSON.parse(await readFile(join(pluginsDir, 'upgradable', 'package.json'), 'utf-8')) as { version: string }
    expect(oldPkg.version).toBe('1.0.0')
  })

  it('串行锁：并发两次安装严格串行（第二次等待第一次完成才开始下载）', async () => {
    const { service } = buildService()
    mockActivation(service, 'ACTIVE')
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    mockDownload.mockImplementation(async (spec: string, targetDir: string) => {
      events.push(`start:${spec}`)
      if (spec === 'first-plugin') await gate
      events.push(`end:${spec}`)
      await mkdir(targetDir, { recursive: true })
      await writeFile(join(targetDir, 'package.json'), pkgJson(spec), 'utf-8')
      return { name: spec, version: '1.0.0' }
    })

    const p1 = service.installPlugin('first-plugin')
    const p2 = service.installPlugin('second-plugin')
    releaseFirst()
    await Promise.all([p1, p2])

    // 有锁：first 完成后 second 才开始；无锁时 two start 会插在 first end 之前
    expect(events[0]).toBe('start:first-plugin')
    expect(events.indexOf('start:second-plugin')).toBeGreaterThan(events.indexOf('end:first-plugin'))
  })
})

describe('PluginService 双产物安装编排（U7/D6：confirm 成功后接 pi 扩展成员安装）', () => {
  const WOOL_ENTRY = {
    packageName: '@zhushanwen/plugin-wool-workbuddy',
    pluginId: 'zhushanwen__plugin-wool-workbuddy',
    displayName: 'WorkBuddy',
    pluginVersion: '1.0.0',
    piExtensionVersion: '0.2.0',
  }

  function mockCatalog(entries: unknown[]): void {
    refreshRemoteConfigMock.mockResolvedValue({ data: { version: 1, plugins: entries }, refreshed: true })
  }

  it('清单条目携带 piExtensionVersion（双产物）→ confirm 成功后调 piExtensionInstaller 安装扩展成员', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service } = buildService({ piExtensionInstaller })
    mockCatalog([WOOL_ENTRY])
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')
    const result = await service.confirmPluginInstall('zhushanwen__plugin-wool-workbuddy')

    expect(result.success).toBe(true)
    expect(piExtensionInstaller.installForCatalogEntry).toHaveBeenCalledWith({
      packageName: '@zhushanwen/plugin-wool-workbuddy',
      piExtensionVersion: '0.2.0',
    })
  })

  it('单产物条目（无 piExtensionVersion）→ 跳过扩展安装，confirm 成功', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service } = buildService({ piExtensionInstaller })
    mockCatalog([{ ...WOOL_ENTRY, piExtensionVersion: undefined }])
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')
    const result = await service.confirmPluginInstall('zhushanwen__plugin-wool-workbuddy')

    expect(result.success).toBe(true)
    expect(piExtensionInstaller.installForCatalogEntry).not.toHaveBeenCalled()
  })

  it('清单不可得（fail-safe 链尾）→ 跳过扩展安装不误伤（warn 留痕），confirm 成功', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service } = buildService({ piExtensionInstaller })
    // 默认 refreshRemoteConfigMock = { data: undefined }（beforeEach 设置）
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')
    const result = await service.confirmPluginInstall('zhushanwen__plugin-wool-workbuddy')

    expect(result.success).toBe(true)
    expect(piExtensionInstaller.installForCatalogEntry).not.toHaveBeenCalled()
  })

  it('扩展成员安装失败 → confirm 整体报失败（插件已落盘事实保留），错误含恢复指引', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    piExtensionInstaller.installForCatalogEntry.mockRejectedValue(
      new Error('资产清单不可达。请检查网络后重试'),
    )
    const { service } = buildService({ piExtensionInstaller })
    mockCatalog([WOOL_ENTRY])
    mockDownloadWrites(pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    mockActivation(service, 'ACTIVE')

    await service.preparePluginInstall('@zhushanwen/plugin-wool-workbuddy')
    const result = await service.confirmPluginInstall('zhushanwen__plugin-wool-workbuddy')

    expect(result.success).toBe(false)
    expect(result.error).toContain('pi 扩展成员')
    expect(result.error).toContain('重试安装')
    // 插件侧已落盘事实保留（不回滚——重试安装幂等覆盖）
    expect(existsSync(join(pluginsDir, 'zhushanwen__plugin-wool-workbuddy', 'package.json'))).toBe(true)
  })
})

describe('PluginService 卸载编排', () => {
  it('provider 插件卸载：命名空间前缀扫描派生清理集 → 逐条 delete（含 apiKey 条目），非匹配条目不动', async () => {
    const providerEntries = makeProviderEntries([
      'wool-workbuddy',
      'wool-workbuddy-extra',
      'wool-workbuddy-alt-model',
      'other-provider',
    ])
    const { service, registry } = buildService({ providerEntries })
    // scoped provider 插件：包名 @x/plugin-wool-workbuddy → ns wool-workbuddy
    await writePluginDir('x__wool-workbuddy', pkgJson('@x/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    await registry.scan()
    // 预置安装登记（卸载后应一并移除）
    const store = new InstalledStore(pluginsDir)
    await store.recordInstalled('x__wool-workbuddy')

    await service.uninstallPlugin('x__wool-workbuddy')

    // 前缀匹配三条全部逐条 delete（'wool-workbuddy' 可为含 apiKey 的凭据条目——
    // delete 通道按 id 整条移除，凭据字段随条目消失）
    expect(providerEntries.delete).toHaveBeenCalledTimes(3)
    expect(providerEntries.delete).toHaveBeenCalledWith('wool-workbuddy')
    expect(providerEntries.delete).toHaveBeenCalledWith('wool-workbuddy-extra')
    expect(providerEntries.delete).toHaveBeenCalledWith('wool-workbuddy-alt-model')
    // 非匹配条目不触碰
    expect(providerEntries.listIds).toHaveBeenCalledTimes(1)
    // 插件目录拆除 + 注册表移除 + installed.json 条目移除
    expect(existsSync(join(pluginsDir, 'x__wool-workbuddy'))).toBe(false)
    expect(registry.getDescriptor('x__wool-workbuddy')).toBeUndefined()
    expect(Object.keys(await readInstalledJson())).not.toContain('x__wool-workbuddy')
  })

  it('非 provider 插件（manifest 未声明 namespace）卸载 → 不触碰 provider 条目', async () => {
    const providerEntries = makeProviderEntries(['wool-workbuddy', 'plain-plugin-something'])
    const { service, registry } = buildService({ providerEntries })
    await writePluginDir('plain-plugin', pkgJson('plain-plugin'))
    await registry.scan()

    await service.uninstallPlugin('plain-plugin')

    expect(providerEntries.delete).not.toHaveBeenCalled()
    expect(existsSync(join(pluginsDir, 'plain-plugin'))).toBe(false)
  })

  it('deps 未接 providerEntries port → 卸载照常完成（provider 清理跳过 warn）', async () => {
    const { service, registry } = buildService()
    await writePluginDir('no-port-plugin', pkgJson('no-port-plugin', { namespace: 'some-ns' }))
    await registry.scan()

    const result = await service.uninstallPlugin('no-port-plugin')

    expect(result.map(p => p.pluginId)).not.toContain('no-port-plugin')
    expect(existsSync(join(pluginsDir, 'no-port-plugin'))).toBe(false)
  })

  it('命名空间声明与包名推导不一致（手工放置的坏包）→ 不按错误声明清理', async () => {
    const providerEntries = makeProviderEntries(['victim-provider', 'victim-provider-x'])
    const { service } = buildService({ providerEntries })
    await writePluginDir('evil-plugin', pkgJson('@x/plugin-evil', { namespace: 'victim-provider' }))
    const registry = newRegistry()
    await registry.scan()

    await service.uninstallPlugin('evil-plugin')

    expect(providerEntries.delete).not.toHaveBeenCalled()
    expect(providerEntries.listIds).not.toHaveBeenCalled()
  })

  it('卸载与安装共用串行锁（与安装编排互斥）', async () => {
    const providerEntries = makeProviderEntries([])
    const { service } = buildService({ providerEntries })
    mockActivation(service, 'ACTIVE')
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    mockDownload.mockImplementation(async (spec: string, targetDir: string) => {
      events.push(`install-start:${spec}`)
      if (spec === 'locking-plugin') await gate
      events.push(`install-end:${spec}`)
      await mkdir(targetDir, { recursive: true })
      await writeFile(join(targetDir, 'package.json'), pkgJson(spec), 'utf-8')
      return { name: spec, version: '1.0.0' }
    })
    // provider 插件 fixture：卸载编排进入 provider 清理段时调 listIds（卸载开始标记）
    providerEntries.listIds.mockImplementation(async () => {
      events.push('uninstall-provider-cleanup')
      return []
    })
    await writePluginDir('concurrent-plugin', pkgJson('@x/plugin-concurrent', { namespace: 'concurrent' }))
    const registry = newRegistry()
    await registry.scan()

    const installP = service.installPlugin('locking-plugin')
    const uninstallP = service.uninstallPlugin('concurrent-plugin')
    releaseFirst()
    await Promise.all([installP, uninstallP])

    // 卸载编排等第一次安装完成才开始（同一把锁）
    expect(events.indexOf('uninstall-provider-cleanup')).toBeGreaterThan(events.indexOf('install-end:locking-plugin'))
  })

  it('双产物插件卸载：条目清理与 pi 扩展成员卸载一并执行（S23「卸载后扩展与条目一并清理」）', async () => {
    const providerEntries = makeProviderEntries(['wool-workbuddy', 'wool-workbuddy-extra'])
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service, registry } = buildService({ providerEntries, piExtensionInstaller })
    await writePluginDir('zhushanwen__plugin-wool-workbuddy', pkgJson('@zhushanwen/plugin-wool-workbuddy', { namespace: 'wool-workbuddy' }))
    await registry.scan()

    await service.uninstallPlugin('zhushanwen__plugin-wool-workbuddy')

    // 扩展侧：包名交端口（家族推导在实现内——pi-wool-workbuddy 由 wool 域单测覆盖）
    expect(piExtensionInstaller.uninstallForCatalogEntry).toHaveBeenCalledWith('@zhushanwen/plugin-wool-workbuddy')
    // 条目侧：命名空间前缀扫描清理照旧
    expect(providerEntries.delete).toHaveBeenCalledWith('wool-workbuddy')
    // 插件侧：目录拆除 + 注册表移除
    expect(existsSync(join(pluginsDir, 'zhushanwen__plugin-wool-workbuddy'))).toBe(false)
    expect(registry.getDescriptor('zhushanwen__plugin-wool-workbuddy')).toBeUndefined()
  })

  it('pi 扩展成员卸载失败 → warn 不阻断：插件目录与注册表照常清理（卸载不抛）', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    piExtensionInstaller.uninstallForCatalogEntry.mockRejectedValue(
      new Error('扩展卸载失败：npm uninstall failed。请到扩展管理页重试卸载'),
    )
    const { service, registry } = buildService({ piExtensionInstaller })
    await writePluginDir('zhushanwen__plugin-wool-qoder', pkgJson('@zhushanwen/plugin-wool-qoder', { namespace: 'wool-qoder' }))
    await registry.scan()

    await expect(service.uninstallPlugin('zhushanwen__plugin-wool-qoder')).resolves.toBeDefined()

    expect(piExtensionInstaller.uninstallForCatalogEntry).toHaveBeenCalledWith('@zhushanwen/plugin-wool-qoder')
    // 插件侧清理完成（扩展残留走扩展管理页手动移除的恢复路径）
    expect(existsSync(join(pluginsDir, 'zhushanwen__plugin-wool-qoder'))).toBe(false)
    expect(registry.getDescriptor('zhushanwen__plugin-wool-qoder')).toBeUndefined()
  })

  it('包内 package.json 缺 name（异常包）→ 跳过扩展卸载，卸载照常完成', async () => {
    const piExtensionInstaller = makePiExtensionInstaller()
    const { service, registry } = buildService({ piExtensionInstaller })
    // parseManifest 只校验 taijiPlugin manifest 不校验 name——name 缺失的包可入注册表
    await writePluginDir('nameless-plugin', JSON.stringify({
      version: '1.0.0',
      main: 'index.js',
      taijiPlugin: { manifestVersion: 1, namespace: 'wool-qoder' },
    }))
    await writeFile(join(pluginsDir, 'nameless-plugin', 'index.js'), 'export default {}', 'utf-8')
    await registry.scan()
    expect(registry.getDescriptor('nameless-plugin')).toBeDefined()

    await service.uninstallPlugin('nameless-plugin')

    expect(piExtensionInstaller.uninstallForCatalogEntry).not.toHaveBeenCalled()
    expect(existsSync(join(pluginsDir, 'nameless-plugin'))).toBe(false)
  })
})
