/**
 * remote-config-fetch 单测（通用拉取器：节流 / ETag / guard 拒绝回退 / fail-safe 链）。
 *
 * 策略对齐 provider-catalog-refresh.test.ts：TAIJI_AGENT_DATA_DIR stub 到临时目录 +
 * fetch 全局 mock + vi.resetModules 动态 import 隔离模块级 cacheSnapshots。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rcf-test-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function loadFresh() {
  vi.resetModules()
  return await import('../remote-config-fetch.js')
}

const VALID = { version: 1 as const, providers: [{ id: 'taiji-demo', name: 'Demo', models: [{ id: 'm1' }] }] }

function guard(v: unknown): v is typeof VALID {
  return (
    typeof v === 'object' && v !== null && (v as { version?: unknown }).version === 1 &&
    Array.isArray((v as { providers?: unknown }).providers)
  )
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
  return fn as unknown as ReturnType<typeof vi.fn>
}

function cachePath(): string {
  return join(dataDir, 'remote-config', 'builtin-providers.json')
}

function writeCache(data: unknown, etag?: string): void {
  mkdirSync(join(dataDir, 'remote-config'), { recursive: true })
  writeFileSync(cachePath(), JSON.stringify({ version: 1, checkedAt: Date.now(), etag, data }))
}

describe('refreshRemoteConfig', () => {
  it('无缓存 + 200 + guard 通过 → 返回数据 + 落盘', async () => {
    const mod = await loadFresh()
    mockFetch(200, VALID, { etag: '"abc"' })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(out.data).toEqual(VALID)
    expect(out.refreshed).toBe(true)
    expect(existsSync(cachePath())).toBe(true)
  })

  it('无缓存 + 网络失败 → data undefined + reason network', async () => {
    const mod = await loadFresh()
    mockFetch(0).mockRejectedValue(new Error('offline'))
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(out.data).toBeUndefined()
    expect(out.refreshed).toBe(false)
    expect(out.reason).toBe('network')
  })

  it('节流窗内 → 零网络请求，data 来自缓存', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    const fn = mockFetch(200, VALID)
    const out = await mod.refreshRemoteConfig('builtin-providers', guard)
    expect(fn).not.toHaveBeenCalled()
    expect(out.data).toEqual(VALID)
    expect(out.reason).toBe('throttled')
  })

  it('304 → data 来自缓存，checkedAt 顺延', async () => {
    writeCache(VALID, '"abc"')
    const mod = await loadFresh()
    // force 绕过节流窗，命中 304 分支
    mockFetch(304)
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.data).toEqual(VALID)
    expect(out.refreshed).toBe(false)
    const persisted = JSON.parse(readFileSync(cachePath(), 'utf-8'))
    expect(persisted.etag).toBe('"abc"')
  })

  it('200 内容变化 → refreshed=true + 新数据落盘；内容不变 → refreshed=false', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    const changed = { ...VALID, providers: [...VALID.providers, { id: 'taiji-x', name: 'X', models: [] }] }
    mockFetch(200, changed)
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.refreshed).toBe(true)
    expect(out.data).toEqual(changed)

    const mod2 = await loadFresh()
    mockFetch(200, changed)
    const out2 = await mod2.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out2.refreshed).toBe(false)
  })

  it('guard 拒绝 → 整体拒用回退缓存，坏数据不落盘', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    mockFetch(200, { version: 1, providers: 'not-an-array' })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.data).toEqual(VALID)
    expect(out.reason).toBe('invalid')
    expect(JSON.parse(readFileSync(cachePath(), 'utf-8')).data).toEqual(VALID)
  })

  it('非 JSON 响应 → reason invalid 回退缓存', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    mockFetch(200, undefined).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new Error('bad json') },
      body: null,
      headers: { get: () => null },
    })
    const out = await mod.refreshRemoteConfig('builtin-providers', guard, { force: true })
    expect(out.reason).toBe('invalid')
    expect(out.data).toEqual(VALID)
  })
})

describe('loadRemoteConfig 读侧', () => {
  it('缓存损坏 JSON → undefined 不抛错', async () => {
    mkdirSync(join(dataDir, 'remote-config'), { recursive: true })
    writeFileSync(cachePath(), '[[[')
    const mod = await loadFresh()
    expect(mod.loadRemoteConfig('builtin-providers', guard)).toBeUndefined()
  })

  it('缓存合法 → 返回数据', async () => {
    writeCache(VALID)
    const mod = await loadFresh()
    expect(mod.loadRemoteConfig('builtin-providers', guard)).toEqual(VALID)
  })
})
