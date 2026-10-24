/**
 * plugin-catalog 单测（provider-plugin-access U5）：清单 guard（含双产物版本配对校验）、
 * S15 清单不可达两态 fail-safe 链、listAvailable 数据组装与本地已装版本比对。
 *
 * 策略对齐 remote-config-fetch.test.ts：TAIJI_AGENT_DATA_DIR stub 到临时目录 +
 * fetch 全局 mock + vi.resetModules 动态 import 隔离模块级 cacheSnapshots。
 * RPC 往返端到端不在本文件（归 u-protocol 验收，复审 F3）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginCatalogEntry } from '@taiji/shared'
import {
  CATALOG_INVALID,
  PLUGIN_CATALOG_DOMAIN,
  PluginCatalogService,
  VERSION_PAIR_MISMATCH,
  installedVersionsFromDescriptors,
  isPluginCatalogConfig,
  listAvailablePlugins,
  validatePluginCatalogConfig,
  type CatalogInstalledEntry,
} from '../src/services/plugin-service/plugin-catalog.js'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'plugin-catalog-test-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** resetModules + 动态 import：隔离 remote-config-fetch 的模块级 cacheSnapshots。 */
async function loadCatalogModule() {
  vi.resetModules()
  return await import('../src/services/plugin-service/plugin-catalog.js')
}

const SINGLE_ARTIFACT_ENTRY: PluginCatalogEntry = {
  packageName: '@scope/demo-plugin',
  pluginId: 'scope__demo-plugin',
  displayName: 'Demo Plugin',
  description: 'single-artifact plugin',
  pluginVersion: '1.2.0',
}

const DUAL_ARTIFACT_ENTRY: PluginCatalogEntry = {
  ...SINGLE_ARTIFACT_ENTRY,
  pluginId: 'scope__wool-workbuddy',
  packageName: '@zhushanwen/plugin-wool-workbuddy',
  pluginVersion: '0.3.0',
  piExtensionVersion: '0.2.1',
  family: {
    id: 'wool-workbuddy',
    displayName: 'WorkBuddy',
    vendor: '腾讯',
    credentialSource: 'oauth',
    modelCount: 17,
  },
}

const VALID_CATALOG = {
  version: 1 as const,
  plugins: [SINGLE_ARTIFACT_ENTRY, DUAL_ARTIFACT_ENTRY],
}

function mockFetch(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: null,
    headers: { get: (k: string): string | null => headers[k.toLowerCase()] ?? null },
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

function cachePath(): string {
  return join(dataDir, 'remote-config', `${PLUGIN_CATALOG_DOMAIN}.json`)
}

function writeCache(data: unknown): void {
  mkdirSync(join(dataDir, 'remote-config'), { recursive: true })
  writeFileSync(cachePath(), JSON.stringify({ version: 1, checkedAt: Date.now(), data }))
}

function readCachedData(): unknown {
  return JSON.parse(readFileSync(cachePath(), 'utf-8')).data
}

describe('validatePluginCatalogConfig（清单 guard）', () => {
  it('合法清单（单产物 + 双产物 + 家族元数据）→ ok', () => {
    const result = validatePluginCatalogConfig(VALID_CATALOG)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.plugins).toHaveLength(2)
    expect(isPluginCatalogConfig(VALID_CATALOG)).toBe(true)
  })

  it('空清单（种子文件形态）→ ok', () => {
    expect(validatePluginCatalogConfig({ version: 1, plugins: [] }).ok).toBe(true)
  })

  it('配对不一致：pluginVersion 缺失 → VERSION_PAIR_MISMATCH', () => {
    const noVersion = { ...DUAL_ARTIFACT_ENTRY, pluginVersion: undefined }
    const result = validatePluginCatalogConfig({ version: 1, plugins: [noVersion] })
    expect(result).toMatchObject({ ok: false, code: VERSION_PAIR_MISMATCH })
    expect(isPluginCatalogConfig({ version: 1, plugins: [noVersion] })).toBe(false)
  })

  it('配对不一致：piExtensionVersion 空串 → VERSION_PAIR_MISMATCH', () => {
    const result = validatePluginCatalogConfig({
      version: 1,
      plugins: [{ ...DUAL_ARTIFACT_ENTRY, piExtensionVersion: '' }],
    })
    expect(result).toMatchObject({ ok: false, code: VERSION_PAIR_MISMATCH })
  })

  it('配对不一致：piExtensionVersion 非字符串 → VERSION_PAIR_MISMATCH', () => {
    const result = validatePluginCatalogConfig({
      version: 1,
      plugins: [{ ...DUAL_ARTIFACT_ENTRY, piExtensionVersion: 3 }],
    })
    expect(result).toMatchObject({ ok: false, code: VERSION_PAIR_MISMATCH })
  })

  it('version 非 1 → CATALOG_INVALID', () => {
    expect(validatePluginCatalogConfig({ version: 2, plugins: [] })).toMatchObject({ ok: false, code: CATALOG_INVALID })
  })

  it('plugins 非数组 → CATALOG_INVALID', () => {
    expect(validatePluginCatalogConfig({ version: 1, plugins: 'x' })).toMatchObject({ ok: false, code: CATALOG_INVALID })
  })

  it('条目缺 packageName → CATALOG_INVALID', () => {
    const noName = { ...SINGLE_ARTIFACT_ENTRY, packageName: undefined }
    expect(validatePluginCatalogConfig({ version: 1, plugins: [noName] })).toMatchObject({ ok: false, code: CATALOG_INVALID })
  })

  it('family.credentialSource 非法值 → CATALOG_INVALID', () => {
    const bad = { ...DUAL_ARTIFACT_ENTRY, family: { ...DUAL_ARTIFACT_ENTRY.family, credentialSource: 'sms' } }
    expect(validatePluginCatalogConfig({ version: 1, plugins: [bad] })).toMatchObject({ ok: false, code: CATALOG_INVALID })
  })

  it('family.modelCount 负数 → CATALOG_INVALID', () => {
    const bad = { ...DUAL_ARTIFACT_ENTRY, family: { ...DUAL_ARTIFACT_ENTRY.family, modelCount: -1 } }
    expect(validatePluginCatalogConfig({ version: 1, plugins: [bad] })).toMatchObject({ ok: false, code: CATALOG_INVALID })
  })

  it('capabilities 非字符串数组 → CATALOG_INVALID', () => {
    const bad = { ...SINGLE_ARTIFACT_ENTRY, capabilities: ['network.http', 1] }
    expect(validatePluginCatalogConfig({ version: 1, plugins: [bad] })).toMatchObject({ ok: false, code: CATALOG_INVALID })
  })

  it('非对象输入 → CATALOG_INVALID', () => {
    expect(validatePluginCatalogConfig('x')).toMatchObject({ ok: false, code: CATALOG_INVALID })
    expect(validatePluginCatalogConfig(null)).toMatchObject({ ok: false, code: CATALOG_INVALID })
  })
})

describe('refreshPluginCatalog fail-safe 链（S15 清单不可达两态）', () => {
  it('S15① 曾成功拉取 + 断网 → 缓存清单 + stale=true（「可能不是最新」提示态）', async () => {
    const mod = await loadCatalogModule()
    mockFetch(200, VALID_CATALOG)
    const first = await mod.refreshPluginCatalog()
    expect(first.config).toEqual(VALID_CATALOG)
    expect(first.stale).toBe(false)

    // force 绕节流窗；断网（fetch reject）→ 缓存兜底
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const second = await mod.refreshPluginCatalog({ force: true })
    expect(second.config).toEqual(VALID_CATALOG)
    expect(second.stale).toBe(true)
    expect(second.reason).toBe('network')
  })

  it('S15② 从未成功拉取 + 断网 → 无数据（整页报错态）', async () => {
    const mod = await loadCatalogModule()
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const out = await mod.refreshPluginCatalog()
    expect(out.config).toBeUndefined()
    expect(out.stale).toBe(false)
    expect(out.reason).toBe('network')
  })

  it('远程 payload 配对不一致被 guard 拒绝 → 整体拒用回退缓存（reason invalid），坏数据不落盘', async () => {
    const mod = await loadCatalogModule()
    mockFetch(200, VALID_CATALOG)
    await mod.refreshPluginCatalog()

    const corrupted = { version: 1, plugins: [{ ...DUAL_ARTIFACT_ENTRY, piExtensionVersion: '' }] }
    mockFetch(200, corrupted)
    const out = await mod.refreshPluginCatalog({ force: true })
    expect(out.config).toEqual(VALID_CATALOG)
    expect(out.stale).toBe(true)
    expect(out.reason).toBe('invalid')
    expect(readCachedData()).toEqual(VALID_CATALOG)
  })

  it('远程 payload 配对不一致 + 无缓存 → 无数据 + reason invalid', async () => {
    const mod = await loadCatalogModule()
    const corrupted = { version: 1, plugins: [{ ...SINGLE_ARTIFACT_ENTRY, pluginVersion: null }] }
    mockFetch(200, corrupted)
    const out = await mod.refreshPluginCatalog()
    expect(out.config).toBeUndefined()
    expect(out.reason).toBe('invalid')
  })

  it('节流窗内 → 缓存数据 + stale=false（新鲜语义，不提示过期）', async () => {
    writeCache(VALID_CATALOG)
    const mod = await loadCatalogModule()
    const fetchFn = mockFetch(200, VALID_CATALOG)
    const out = await mod.refreshPluginCatalog()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(out.config).toEqual(VALID_CATALOG)
    expect(out.stale).toBe(false)
    expect(out.reason).toBe('throttled')
  })

  it('loadPluginCatalog 读侧：有缓存返回、无缓存 undefined', async () => {
    const mod = await loadCatalogModule()
    expect(mod.loadPluginCatalog()).toBeUndefined()
    writeCache(VALID_CATALOG)
    const mod2 = await loadCatalogModule()
    expect(mod2.loadPluginCatalog()).toEqual(VALID_CATALOG)
  })
})

describe('listAvailablePlugins（数据组装 + 本地已装版本比对）', () => {
  const entries: PluginCatalogEntry[] = [
    SINGLE_ARTIFACT_ENTRY,
    { ...DUAL_ARTIFACT_ENTRY, pluginVersion: '2.0.0' },
  ]

  it('未安装条目 → installed=false 且无 installedVersion', () => {
    const reply = listAvailablePlugins(entries, new Map())
    expect(reply.plugins).toHaveLength(2)
    expect(reply.plugins.every((p) => p.installed === false && p.installedVersion === undefined)).toBe(true)
  })

  it('已安装同版本 → installed=true + installedVersion；清单版本相等 → 无 updateAvailable', () => {
    const reply = listAvailablePlugins(entries, new Map([
      [SINGLE_ARTIFACT_ENTRY.pluginId, '1.2.0'],
    ]))
    const first = reply.plugins[0]
    expect(first.installed).toBe(true)
    expect(first.installedVersion).toBe('1.2.0')
    expect(first.updateAvailable).toBeUndefined()
  })

  it('清单版本 > 已装版本 → updateAvailable=true（S26 更新提示数据源）', () => {
    const reply = listAvailablePlugins(entries, new Map([
      [entries[1].pluginId, '0.3.0'],
    ]))
    expect(reply.plugins[1].updateAvailable).toBe(true)
  })

  it('清单版本 < 已装版本 → 无 updateAvailable', () => {
    const reply = listAvailablePlugins(entries, new Map([
      [entries[1].pluginId, '9.0.0'],
    ]))
    expect(reply.plugins[1].updateAvailable).toBeUndefined()
  })

  it('任一侧版本非法 semver → 不比较、无 updateAvailable（不猜测）', () => {
    const reply = listAvailablePlugins(entries, new Map([
      [SINGLE_ARTIFACT_ENTRY.pluginId, 'not-semver'],
    ]))
    expect(reply.plugins[0].installed).toBe(true)
    expect(reply.plugins[0].updateAvailable).toBeUndefined()
  })

  it('installedVersionsFromDescriptors：descriptors → pluginId→version 映射', () => {
    const map = installedVersionsFromDescriptors([
      { pluginId: 'a', version: '1.0.0' },
      { pluginId: 'b', version: '2.0.0' },
    ])
    expect(map.get('a')).toBe('1.0.0')
    expect(map.get('b')).toBe('2.0.0')
  })
})

describe('PluginCatalogService（service 层编排）', () => {
  function makeService(
    installed: ReadonlyMap<string, string> = new Map(),
    installedEntries?: ReadonlyArray<CatalogInstalledEntry>,
  ) {
    return new PluginCatalogService({
      getInstalledVersions: async () => installed,
      ...(installedEntries !== undefined
        ? { getInstalledEntries: async () => installedEntries }
        : {}),
    })
  }

  const INSTALLED_ENTRY = {
    pluginId: 'zhushanwen__plugin-wool-workbuddy',
    displayName: 'WorkBuddy',
    packageName: '@zhushanwen/plugin-wool-workbuddy',
    pluginVersion: '0.1.0',
    namespace: 'wool-workbuddy',
  }

  it('listAvailable：清单可用 + 本地比对组装（available=true）', async () => {
    await loadCatalogModule()
    mockFetch(200, VALID_CATALOG)
    const service = makeService(new Map([[SINGLE_ARTIFACT_ENTRY.pluginId, '1.0.0']]))
    const out = await service.listAvailable()
    expect(out.available).toBe(true)
    expect(out.stale).toBe(false)
    expect(out.reply.plugins).toHaveLength(2)
    expect(out.reply.plugins[0]).toMatchObject({ installed: true, installedVersion: '1.0.0', updateAvailable: true })
  })

  it('R-2：拉取元数据（available/stale/reason）组装进 reply 本体（wire 面即元数据载体）', async () => {
    await loadCatalogModule()
    // 无缓存 + 断网 → available=false（报错态判据；本测试先断失败态，成功拉取后缓存
    // 落盘，「无缓存」分支在同 dataDir 内不可复现）
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const failed = await makeService().listAvailable({ force: true })
    expect(failed.reply).toMatchObject({ available: false, stale: false, reason: 'network' })

    // 拉取成功 → available=true / stale=false / reason 缺省（exact-optional 不落 undefined）
    mockFetch(200, VALID_CATALOG)
    const ok = await makeService().listAvailable()
    expect(ok.reply).toMatchObject({ available: true, stale: false })
    expect(ok.reply.reason).toBeUndefined()

    // 有缓存 + 断网 force → stale=true（提示态判据）
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const stale = await makeService().listAvailable({ force: true })
    expect(stale.reply).toMatchObject({ available: true, stale: true, reason: 'network' })
  })

  it('S15② 本地已装条目回退：available=false → reply.plugins = 已装条目（installed=true，带 namespace；无 updateAvailable——无清单基线不猜测）', async () => {
    await loadCatalogModule()
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const out = await makeService(new Map(), [INSTALLED_ENTRY]).listAvailable()
    expect(out.available).toBe(false)
    expect(out.reply.available).toBe(false)
    expect(out.reply.plugins).toHaveLength(1)
    expect(out.reply.plugins[0]).toMatchObject({
      pluginId: INSTALLED_ENTRY.pluginId,
      packageName: INSTALLED_ENTRY.packageName,
      namespace: 'wool-workbuddy',
      installed: true,
      installedVersion: '0.1.0',
    })
    expect(out.reply.plugins[0].updateAvailable).toBeUndefined()
  })

  it('S15② 回退端口缺失 → available=false 且 reply.plugins 为空（旧装配形态）', async () => {
    await loadCatalogModule()
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const out = await makeService().listAvailable()
    expect(out.available).toBe(false)
    expect(out.reply.plugins).toEqual([])
  })

  it('listAvailable：断网缓存兜底 → available=true + stale=true（S15① 提示态）', async () => {
    writeCache(VALID_CATALOG)
    await loadCatalogModule()
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const out = await makeService().listAvailable({ force: true })
    expect(out.available).toBe(true)
    expect(out.stale).toBe(true)
    expect(out.reply.plugins).toHaveLength(2)
  })

  it('catalog：返回清单原始条目（含家族元数据）+ 元数据进 reply 本体', async () => {
    await loadCatalogModule()
    mockFetch(200, VALID_CATALOG)
    const out = await makeService().catalog()
    expect(out.available).toBe(true)
    expect(out.reply.entries).toEqual(VALID_CATALOG.plugins)
    expect(out.reply.entries[1].family).toEqual(DUAL_ARTIFACT_ENTRY.family)
    expect(out.reply.available).toBe(true)
  })

  it('catalog：无缓存 → 已装条目回退（S15② 同构语义）', async () => {
    await loadCatalogModule()
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const out = await makeService(new Map(), [INSTALLED_ENTRY]).catalog()
    expect(out.available).toBe(false)
    expect(out.reply.entries).toHaveLength(1)
    expect(out.reply.entries[0]).toMatchObject({ pluginId: INSTALLED_ENTRY.pluginId, installed: true })
  })
})
