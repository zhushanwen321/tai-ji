/**
 * provider-catalog-refresh 单测（远程模型目录 overlay：读侧合并 + 刷侧状态码语义）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-catalog-refresh.test.ts
 *
 * 策略：TAIJI_AGENT_DATA_DIR stub 到临时目录（隔离真实 ~/.taiji），fetch 全局 mock。
 * 模块级 overlaySnapshot 内存缓存经 vi.resetModules + 动态 import 每用例隔离。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import builtinData from '../../generated/builtin-providers.json'

const GENERATED_AT = (builtinData as { catalogGeneratedAt?: number }).catalogGeneratedAt ?? 0

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pcr-test-'))
  mkdirSync(join(dataDir, 'agent'), { recursive: true })
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 每用例动态 import：resetModules 隔离模块级 overlaySnapshot 内存缓存。 */
async function loadFresh() {
  vi.resetModules()
  return await import('../provider-catalog-refresh.js')
}

function writeOwnCache(entries: unknown): void {
  writeFileSync(join(dataDir, 'provider-catalog-overlay.json'), JSON.stringify({ version: 1, entries }))
}

function writePiStore(entries: unknown): void {
  writeFileSync(join(dataDir, 'agent', 'models-store.json'), JSON.stringify(entries))
}

/** fetch mock：返回固定状态码/形状响应，返回 fn 供调用断言。 */
function mockFetch(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('getCatalogOverlayModels 读侧', () => {
  it('自刷缓存条目（lastModified 新于 catalogGeneratedAt）→ 返回模型', async () => {
    writeOwnCache({ zai: { models: [{ id: 'glm-9.9' }], checkedAt: 1, lastModified: GENERATED_AT + 1000 } })
    const mod = await loadFresh()
    expect(mod.getCatalogOverlayModels('zai').map(m => m.id)).toEqual(['glm-9.9'])
  })

  it('自刷缓存与 pi store 并存 → lastModified 新者胜', async () => {
    writeOwnCache({ zai: { models: [{ id: 'from-own' }], checkedAt: 1, lastModified: GENERATED_AT + 1000 } })
    writePiStore({ zai: { models: [{ id: 'from-pi' }], checkedAt: 1, lastModified: GENERATED_AT + 2000 } })
    const mod = await loadFresh()
    expect(mod.getCatalogOverlayModels('zai').map(m => m.id)).toEqual(['from-pi'])
  })

  it('lastModified <= catalogGeneratedAt → staleness 忽略（内置已覆盖）', async () => {
    writeOwnCache({ zai: { models: [{ id: 'stale' }], checkedAt: 1, lastModified: GENERATED_AT } })
    const mod = await loadFresh()
    expect(mod.getCatalogOverlayModels('zai')).toEqual([])
  })

  it('无 lastModified 字段（旧格式）→ 不过滤直接生效', async () => {
    writePiStore({ zai: { models: [{ id: 'no-lm' }], checkedAt: 1 } })
    const mod = await loadFresh()
    expect(mod.getCatalogOverlayModels('zai').map(m => m.id)).toEqual(['no-lm'])
  })

  it('缓存文件损坏 / 未知 provider → fail-safe 空数组', async () => {
    writeFileSync(join(dataDir, 'provider-catalog-overlay.json'), '{broken json')
    const mod = await loadFresh()
    expect(mod.getCatalogOverlayModels('zai')).toEqual([])
    expect(mod.getCatalogOverlayModels('nonexistent-provider')).toEqual([])
  })
})

describe('refreshProviderCatalogs 刷侧', () => {
  it('200 id-keyed map → 落盘 + 读侧可见（provider/baseUrl 等字段透传）', async () => {
    const mod = await loadFresh()
    mockFetch(200, { 'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200000 } }, {
      etag: 'W/"abc"',
      'last-modified': new Date(GENERATED_AT + 5000).toUTCString(),
    })
    const result = await mod.refreshProviderCatalogs(['zai'])
    expect(result.refreshed).toEqual(['zai'])
    expect(result.failed).toEqual([])
    expect(mod.getCatalogOverlayModels('zai').map(m => m.id)).toEqual(['glm-5.3'])
  })

  it('200 数组形态同样接受（parseCatalog 三形态容错）', async () => {
    const mod = await loadFresh()
    mockFetch(200, [{ id: 'glm-5.3' }], { 'last-modified': new Date(GENERATED_AT + 5000).toUTCString() })
    await mod.refreshProviderCatalogs(['zai'])
    expect(mod.getCatalogOverlayModels('zai').map(m => m.id)).toEqual(['glm-5.3'])
  })

  it('304 → 保留原缓存模型仅顺延 checkedAt', async () => {
    writeOwnCache({ zai: { models: [{ id: 'cached' }], checkedAt: 1, lastModified: GENERATED_AT + 1000, etag: 'W/"old"' } })
    const mod = await loadFresh()
    const fn = mockFetch(304)
    await mod.refreshProviderCatalogs(['zai'])
    expect(fn).toHaveBeenCalled()
    expect(mod.getCatalogOverlayModels('zai').map(m => m.id)).toEqual(['cached'])
  })

  it('404 → overlay 永久失效（lastModified:0 被读侧 staleness 过滤）', async () => {
    writeOwnCache({ zai: { models: [{ id: 'cached' }], checkedAt: 1, lastModified: GENERATED_AT + 1000 } })
    const mod = await loadFresh()
    mockFetch(404, {})
    const result = await mod.refreshProviderCatalogs(['zai'])
    expect(result.refreshed).toEqual(['zai'])
    expect(mod.getCatalogOverlayModels('zai')).toEqual([])
  })

  it('网络失败 → failed + 不落盘（保留原缓存语义）', async () => {
    writeOwnCache({ zai: { models: [{ id: 'cached' }], checkedAt: 1, lastModified: GENERATED_AT + 1000 } })
    const mod = await loadFresh()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    const result = await mod.refreshProviderCatalogs(['zai'])
    expect(result.failed).toEqual([{ providerId: 'zai', reason: 'timeout' }])
    expect(mod.getCatalogOverlayModels('zai').map(m => m.id)).toEqual(['cached'])
  })

  it('多 provider 部分成功部分失败 → allSettled 语义互不影响', async () => {
    const mod = await loadFresh()
    const fn = vi.fn(async (url: string | URL) => {
      const id = String(url).split('/').pop()
      if (id === 'zai') {
        return { ok: true, status: 200, json: async () => ({ 'glm-5.3': { id: 'glm-5.3' } }), headers: { get: () => new Date(GENERATED_AT + 5000).toUTCString() } }
      }
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fn)
    const result = await mod.refreshProviderCatalogs(['zai', 'anthropic'])
    expect(result.refreshed).toEqual(['zai'])
    expect(result.failed).toEqual([{ providerId: 'anthropic', reason: 'network down' }])
    expect(mod.getCatalogOverlayModels('zai').map(m => m.id)).toEqual(['glm-5.3'])
  })
})
