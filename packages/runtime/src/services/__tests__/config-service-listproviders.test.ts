/**
 * listProviders 双源聚合测试（wave2，provider-dual-system-r2::list-providers-aggregate）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-listproviders.test.ts
 *
 * 策略：不 mock provider-catalog（用真实 builtin-providers.json + 真实 deriveEnabled），
 * mock configStore（readModels + getEnabledModels）+ authStorage（listCredentialIds +
 * hasCredentialSync）。覆盖 design TC1-TC5/TC7（聚合 / kind / enabled 派生 / override /
 * apiKeySet / 兼容）。TC6（findValidDefaultModel catalog 兜底过滤）见
 * pi-provider-store-finddefault.test.ts。
 */
import { describe, it, expect, vi } from 'vitest'
import { ConfigService } from '../config-service.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import { deriveEnabled } from '../provider-catalog.js'
import type { IConfigStore, ConfigModelsConfig } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'

/** ConfigService 构造函数期望的 authStorage Pick（全方法，mock 只实现被调用的）。 */
type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

interface MakeOpts {
  /** models.json providers（默认空）。 */
  models?: ConfigModelsConfig['providers']
  /** settings.json.enabledModels（默认空 = 全启用，DM3）。 */
  enabledModels?: string[]
  /** auth.json 顶层 providerId 列表（catalog 凭据源）。 */
  authIds?: string[]
  /** authStorage.hasCredentialSync 的判定函数（custom status 派生用）。 */
  hasCredential?: (id: string) => boolean
}

/** 构造 ConfigService + mock store/auth，返回 svc 供断言。 */
function makeService(opts: MakeOpts = {}): ConfigService {
  const {
    models = {},
    enabledModels = [],
    authIds = [],
    hasCredential = () => false,
  } = opts
  const store = {
    readModels: vi.fn(() => ({ providers: models })),
    getEnabledModels: vi.fn(() => enabledModels),
  } as unknown as IConfigStore
  const auth = {
    listCredentialIds: vi.fn(() => authIds),
    hasCredentialSync: vi.fn((id: string) => hasCredential(id)),
  } as unknown as FullAuthPick
  // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（auth.json ∪ models.json），
  // 与旧内联判定（auth.json 集合）同源于上方 auth/store mock。
  const resolver = new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: auth,
    configStore: store,
  })
  return new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
}

/** listProviders 结果按 id 索引，便于断言。 */
function byId(svc: ConfigService): Record<string, ReturnType<ConfigService['listProviders']>[number]> {
  return Object.fromEntries(svc.listProviders().map(p => [p.id, p]))
}

describe('TC1: listProviders 双源聚合——catalog 凭据在 auth.json 时也显示（F1 修复核心）', () => {
  it('models.json 只有 custom，auth.json 有 catalog 凭据 → 两者都出现', () => {
    const svc = makeService({
      models: { 'my-custom': { apiKey: 'sk-x', models: [{ id: 'm1' }] } },
      authIds: ['openai'],
    })
    const ids = svc.listProviders().map(p => p.id)
    expect(ids).toContain('my-custom')
    expect(ids).toContain('openai')
  })

  it('catalog 凭据在 auth.json 但 models.json 完全无该条目（F1 根因场景）', () => {
    const svc = makeService({ authIds: ['openai'] })
    const ids = svc.listProviders().map(p => p.id)
    expect(ids).toContain('openai')
    expect(ids).not.toContain('my-custom')
  })
})

describe('TC2: kind 标注——custom/catalog 分类', () => {
  it('混合 providers：custom（models.json ∉ builtin）+ catalog（auth.json ∩ builtin）', () => {
    const svc = makeService({
      models: { 'my-custom': { apiKey: 'sk-x', models: [] } },
      authIds: ['openai', 'anthropic'],
    })
    const m = byId(svc)
    expect(m['my-custom'].kind).toBe('custom')
    expect(m['openai'].kind).toBe('catalog')
    expect(m['anthropic'].kind).toBe('catalog')
  })
})

describe('TC3: deriveEnabled 算法（DM3）', () => {
  it('enabledModels 空/undefined → 全启用（pi 白名单语义）', () => {
    expect(deriveEnabled('openai', [])).toBe(true)
    expect(deriveEnabled('openai', undefined)).toBe(true)
  })

  it('enabledModels 非空 → 白名单匹配（<id>/* 或 <id>/model）', () => {
    expect(deriveEnabled('openai', ['openai/*'])).toBe(true)
    expect(deriveEnabled('openai', ['openai/gpt-4'])).toBe(true)
    expect(deriveEnabled('anthropic', ['openai/*'])).toBe(false)
  })

  it('startsWith 带斜杠防前缀碰撞：openai/* 不匹配 openai-compatible', () => {
    expect(deriveEnabled('openai-compatible', ['openai/*'])).toBe(false)
    expect(deriveEnabled('openai-compatible', ['openai-compatible/*'])).toBe(true)
  })

  it('经 listProviders 体现：enabledModels=["openai/*"] 时 openai→true, anthropic→false', () => {
    const svc = makeService({ enabledModels: ['openai/*'], authIds: ['openai', 'anthropic'] })
    const m = byId(svc)
    expect(m['openai'].enabled).toBe(true)
    expect(m['anthropic'].enabled).toBe(false)
  })
})

describe('TC4: catalog override——hasOverride + 字段优先取 override', () => {
  it('catalog provider 在 models.json 有 override → hasOverride=true + override 字段优先', () => {
    const svc = makeService({
      models: { openai: { name: 'My OpenAI', baseUrl: 'https://my.proxy' } },
    })
    const openai = byId(svc)['openai']
    expect(openai.kind).toBe('catalog')
    expect(openai.hasOverride).toBe(true)
    expect(openai.name).toBe('My OpenAI')
    expect(openai.baseUrl).toBe('https://my.proxy')
  })

  it('catalog provider 无 override（仅 auth.json 凭据）→ hasOverride=false + 用 builtin 副本', () => {
    const svc = makeService({ authIds: ['openai'] })
    const openai = byId(svc)['openai']
    expect(openai.hasOverride).toBe(false)
    // builtin openai 有 models（37 provider 之一），兜底非空
    expect(openai.models.length).toBeGreaterThan(0)
  })
})

// ── W2 重构特征锚定补充（listProviders 提取 helper 后的分支缺口）──

describe('TC5 补充: catalog apiKeySet 双源判定——override.apiKey（models.json 手填 key 旧数据）', () => {
  it('auth.json 无凭据但 override.apiKey 非空 → apiKeySet=true + status=connected', () => {
    const svc = makeService({
      models: { openai: { apiKey: 'sk-manual', models: [{ id: 'gpt-x' }] } },
      authIds: [],
    })
    const openai = byId(svc)['openai']
    expect(openai.kind).toBe('catalog')
    expect(openai.apiKeySet).toBe(true)
    expect(openai.status).toBe('connected')
  })

  it('catalog 无 override 且 auth.json 无凭据 → apiKeySet=false + status=not_configured', () => {
    const svc = makeService({
      models: { openai: { name: 'Renamed OpenAI' } },
      authIds: [],
    })
    const openai = byId(svc)['openai']
    expect(openai.apiKeySet).toBe(false)
    expect(openai.status).toBe('not_configured')
    // override 只改 name：name 覆盖生效、hasOverride=true
    expect(openai.name).toBe('Renamed OpenAI')
    expect(openai.hasOverride).toBe(true)
  })

  it('catalog 无 override → name 回退 builtinP.name（非 id）', () => {
    const svc = makeService({ authIds: ['anthropic'] })
    const anthropic = byId(svc)['anthropic']
    expect(anthropic.hasOverride).toBe(false)
    // builtin anthropic 模板 name 非空且不等于 id
    expect(anthropic.name).toBeTruthy()
    expect(anthropic.name).not.toBe('anthropic')
  })
})

describe('TC5: apiKeySet 派生——catalog 来自 auth.json，custom 来自 models.json', () => {
  it('catalog 凭据在 auth.json（models.json 无 apiKey）→ apiKeySet=true', () => {
    const svc = makeService({ authIds: ['openai'] })
    expect(byId(svc)['openai'].apiKeySet).toBe(true)
  })

  it('custom provider apiKeySet 来自 models.json apiKey', () => {
    const svc = makeService({
      models: { 'my-custom': { apiKey: 'sk-c', models: [{ id: 'm1' }] } },
    })
    expect(byId(svc)['my-custom'].apiKeySet).toBe(true)
  })

  it('custom provider 无 apiKey → apiKeySet=false', () => {
    const svc = makeService({
      models: { 'my-custom': { models: [{ id: 'm1' }] } },
    })
    expect(byId(svc)['my-custom'].apiKeySet).toBe(false)
  })
})

describe('TC7: custom provider 行为兼容（apiKeySet/status/models 兜底，与旧实现一致）', () => {
  it('custom 有 apiKey → apiKeySet=true, status=connected', () => {
    const svc = makeService({
      models: { 'my-custom': { apiKey: 'sk-x', models: [{ id: 'm1' }] } },
    })
    const p = byId(svc)['my-custom']
    expect(p.apiKeySet).toBe(true)
    expect(p.status).toBe('connected')
    expect(p.kind).toBe('custom')
  })

  it('custom 无 apiKey 但 auth.json 有凭据 → status=connected（沿用旧 M6 逻辑）', () => {
    const svc = makeService({
      models: { 'my-custom': { models: [{ id: 'm1' }] } },
      // B3：custom status 改用 authIdSet（listCredentialIds 批量读），不再逐个 hasCredentialSync
      authIds: ['my-custom'],
      hasCredential: id => id === 'my-custom',
    })
    const p = byId(svc)['my-custom']
    expect(p.apiKeySet).toBe(false)
    expect(p.status).toBe('connected')
  })

  it('custom 无 apiKey 无凭据 → status=not_configured', () => {
    const svc = makeService({
      models: { 'my-custom': { models: [{ id: 'm1' }] } },
    })
    expect(byId(svc)['my-custom'].status).toBe('not_configured')
  })

  it('custom 空 models（非 builtin id）→ models 兜底为空数组', () => {
    const svc = makeService({
      models: { 'my-custom': { apiKey: 'sk-x', models: [] } },
    })
    expect(byId(svc)['my-custom'].models).toEqual([])
  })
})

describe('B-4b 读侧：model 级 headers 经 ProviderInfo.models 透传（读写对称）', () => {
  it('custom provider 模型带 headers → listProviders 输出含 headers', () => {
    const svc = makeService({
      models: {
        'my-custom': {
          apiKey: 'sk-x',
          models: [{ id: 'm1', name: 'M1', headers: { 'X-Model': 'v1' } }],
        },
      },
    })
    const model = byId(svc)['my-custom'].models.find(m => m.id === 'm1')
    expect(model?.headers).toEqual({ 'X-Model': 'v1' })
  })

  it('catalog override 模型带 headers → override 条目同样透传', () => {
    const svc = makeService({
      models: {
        openai: {
          models: [{ id: 'gpt-4o', name: 'GPT-4o', headers: { 'X-Ovr': 'y' } }],
        },
      },
    })
    const ovr = byId(svc)['openai'].models.find(m => m.id === 'gpt-4o')
    expect(ovr?.headers).toEqual({ 'X-Ovr': 'y' })
    expect(ovr?.source).toBe('override')
  })

  it('无 headers 的模型 → 字段缺省（行为兼容，不带 headers 键语义不变）', () => {
    const svc = makeService({
      models: { 'my-custom': { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] } },
    })
    const model = byId(svc)['my-custom'].models.find(m => m.id === 'm1')
    expect(model?.headers).toBeUndefined()
  })
})
