/**
 * remote-provider-sync 单测（provider 清单域：模板映射 + 合并写盘语义）。
 *
 * 合并语义红线用例：同 id 覆盖 / 新 id 追加 / 不删除本地（含用户手动加的模型）/
 * 远程下线条目不动 / 无 remoteSource 标记不更新 / 无变化 no-op / guard 拒绝不写盘。
 * 策略同 remote-config-fetch.test.ts（tmp dataDir + fetch mock + resetModules）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IConfigStore } from '../../ports/config.js'
import type { ProviderExtras } from '../../provider-extras-store.js'
import type { ProviderExtrasAccessors, ProviderExtrasServiceDeps } from '../../provider-config-helper.js'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rps-test-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function loadFresh() {
  vi.resetModules()
  return await import('../remote-provider-sync.js')
}

function remoteConfig(providers: Array<Record<string, unknown>>) {
  return { version: 1, providers }
}

function mockFetch200(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    body: null,
    headers: { get: () => null },
  })))
}

/** 轻量 fake：只实现 sync 链路消费的 IConfigStore 面（getProviderConfig/upsertProvider/
 * getEnabledModels——更新分支不触 ensureProviderInWhitelist 的写侧）。 */
function makeConfigStore(initial: Record<string, Record<string, unknown>>) {
  const providers = new Map(Object.entries(initial))
  const upserts: Array<{ id: string; entry: Record<string, unknown> }> = []
  const store = {
    getProviderConfig: (id: string) => providers.get(id),
    upsertProvider: (id: string, entry: Record<string, unknown>) => {
      providers.set(id, entry)
      upserts.push({ id, entry })
      return {}
    },
    getEnabledModels: () => [],
    setEnabledModels: () => {},
    ensureProviderInWhitelist: () => {},
  }
  return { store: store as unknown as IConfigStore, upserts, providers }
}

function makeExtrasStore(markers: Record<string, { remoteSource?: string; modelStates?: Record<string, { enabled: boolean }> }>): ProviderExtrasAccessors & Pick<ProviderExtrasServiceDeps, 'readAllSync'> {
  const providers: Record<string, ProviderExtras> = { ...markers }
  return {
    readAllSync: () => providers,
    getExtrasSync: (id: string) => providers[id],
    modify: async (id: string, fn: (cur: ProviderExtras | undefined) => ProviderExtras) => {
      providers[id] = fn(providers[id])
      return providers[id]
    },
    cleanScopedModelsResidue: async () => {},
  }
}

describe('listRemoteProviderTemplates', () => {
  it('合法缓存 → 模板同形映射（authMode api_key + remoteSource 标记 + modelCount）', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, 'remote-config'), { recursive: true })
    writeFileSync(
      join(dataDir, 'remote-config', 'builtin-providers.json'),
      JSON.stringify({ version: 1, checkedAt: Date.now(), data: remoteConfig([
        { id: 'taiji-relay', name: 'Relay', api: 'openai-compatible', baseUrl: 'https://r.example', models: [{ id: 'm1', name: 'M1', contextWindow: 128000 }] },
      ]) }),
    )
    const mod = await loadFresh()
    const templates = mod.listRemoteProviderTemplates()
    expect(templates).toHaveLength(1)
    expect(templates[0]).toMatchObject({
      id: 'taiji-relay',
      name: 'Relay',
      api: 'openai-compatible',
      baseUrl: 'https://r.example',
      authMode: 'api_key',
      envVars: [],
      oauthSupported: false,
      modelCount: 1,
      remoteSource: 'taiji-relay',
    })
    expect(templates[0].models[0]).toMatchObject({ id: 'm1', name: 'M1', contextWindow: 128000, reasoning: false, input: ['text'] })
  })

  it('无缓存 → 空列表', async () => {
    const mod = await loadFresh()
    expect(mod.listRemoteProviderTemplates()).toEqual([])
  })
})

describe('syncRemoteProviderModels 合并写盘', () => {
  const ENTRY = {
    id: 'taiji-relay',
    name: 'Relay',
    baseUrl: 'https://r.example',
    models: [{ id: 'm1', name: 'M1 v2', contextWindow: 256000 }, { id: 'm2', name: 'M2' }],
  }

  it('同 id 覆盖 + 新 id 追加 + 不删除本地（含用户手动模型）', async () => {
    mockFetch200(remoteConfig([ENTRY]))
    const { store, upserts } = makeConfigStore({
      'taiji-relay': { models: [
        { id: 'm1', name: 'M1 v1', contextWindow: 128000 },
        { id: 'manual', name: 'User Added' },
      ] },
    })
    const mod = await loadFresh()
    const result = await mod.syncRemoteProviderModels({
      configStore: store,
      extrasStore: makeExtrasStore({ 'taiji-relay': { remoteSource: 'taiji-relay' } }),
    })
    expect(result.updatedProviders).toEqual(['taiji-relay'])
    expect(upserts).toHaveLength(1)
    const models = upserts[0].entry.models as Array<{ id: string; name?: string; contextWindow?: number }>
    const byId = Object.fromEntries(models.map((m) => [m.id, m]))
    // 同 id 覆盖（远程权威）
    expect(byId['m1'].name).toBe('M1 v2')
    expect(byId['m1'].contextWindow).toBe(256000)
    // 新 id 追加
    expect(byId['m2']).toBeDefined()
    // 本地手动模型保留（不删除语义）
    expect(byId['manual']).toBeDefined()
  })

  it('远程下线条目 → 该 provider 不写盘', async () => {
    mockFetch200(remoteConfig([]))
    const { store, upserts } = makeConfigStore({ 'taiji-relay': { models: [{ id: 'm1' }] } })
    const mod = await loadFresh()
    const result = await mod.syncRemoteProviderModels({
      configStore: store,
      extrasStore: makeExtrasStore({ 'taiji-relay': { remoteSource: 'taiji-relay' } }),
    })
    expect(result.updatedProviders).toEqual([])
    expect(upserts).toHaveLength(0)
  })

  it('无 remoteSource 标记的 provider 不更新（custom 隔离）', async () => {
    mockFetch200(remoteConfig([ENTRY]))
    const { store, upserts } = makeConfigStore({ 'my-custom': { models: [{ id: 'm1' }] } })
    const mod = await loadFresh()
    const result = await mod.syncRemoteProviderModels({
      configStore: store,
      extrasStore: makeExtrasStore({ 'my-custom': {} }),
    })
    expect(result.updatedProviders).toEqual([])
    expect(upserts).toHaveLength(0)
  })

  it('模型无变化 → no-op 不写盘', async () => {
    mockFetch200(remoteConfig([{ id: 'taiji-relay', name: 'Relay', models: [{ id: 'm1', name: 'M1' }] }]))
    const { store, upserts } = makeConfigStore({
      'taiji-relay': { models: [{ id: 'm1', name: 'M1' }] },
    })
    const mod = await loadFresh()
    const result = await mod.syncRemoteProviderModels({
      configStore: store,
      extrasStore: makeExtrasStore({ 'taiji-relay': { remoteSource: 'taiji-relay' } }),
    })
    expect(result.updatedProviders).toEqual([])
    expect(upserts).toHaveLength(0)
  })

  it('guard 拒绝坏配置 → 不写盘 + fetchReason invalid', async () => {
    mockFetch200({ version: 1, providers: 'broken' })
    const { store, upserts } = makeConfigStore({ 'taiji-relay': { models: [{ id: 'm1' }] } })
    const mod = await loadFresh()
    const result = await mod.syncRemoteProviderModels({
      configStore: store,
      extrasStore: makeExtrasStore({ 'taiji-relay': { remoteSource: 'taiji-relay' } }),
    })
    expect(result.updatedProviders).toEqual([])
    expect(result.fetchReason).toBe('invalid')
    expect(upserts).toHaveLength(0)
  })

  it('extrasStore 未注入 → 零同步对象直接返回', async () => {
    mockFetch200(remoteConfig([ENTRY]))
    const { store, upserts } = makeConfigStore({ 'taiji-relay': { models: [{ id: 'm1' }] } })
    const mod = await loadFresh()
    const result = await mod.syncRemoteProviderModels({ configStore: store })
    expect(result.updatedProviders).toEqual([])
    expect(upserts).toHaveLength(0)
  })
})
