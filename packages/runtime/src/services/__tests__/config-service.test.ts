/**
 * ConfigService.listBuiltinProviders 单测（wave 2，builtin-provider-rpc）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service.test.ts
 *
 * 测试策略（WC6）：config-service 直接测（不 mock，import 真实 generated JSON）。
 * listBuiltinProviders 是纯函数（模块级 import builtinData，不触 ConfigStore），
 * 故构造 ConfigService 时 configStore 传最小 mock（{} 即可，方法不被调用）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConfigService } from '../config-service.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'
import type { IConfigStore } from '../ports/config.js'
import type { BuiltinProviderTemplate } from '@xyz-agent/shared'
import type { AuthStorage } from '../auth/auth-storage.js'
import type { XyzProviderStore } from '../provider-extras-store.js'

/**
 * M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（D3 唯一通道）。
 * authStorage 缺省用空集 stub（auth.json 无凭据），configStore 传用例的 mock store。
 */
function makeResolver(
  store: IConfigStore,
  authStorage?: Pick<AuthStorage, 'hasCredentialSync' | 'listCredentialIds'>,
): IProviderCredentialResolver {
  return new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: authStorage ?? { hasCredentialSync: () => false, listCredentialIds: () => [] },
    configStore: store,
  })
}

// mock isCatalogProvider → false: keep existing test behavior (custom provider path)。
// wave2：保留 deriveEnabled 真实实现（listProviders 消费），只 override isCatalogProvider。
vi.mock('../provider-catalog.js', async (importActual) => {
  const actual = await importActual<typeof import('../provider-catalog.js')>()
  return { ...actual, isCatalogProvider: vi.fn(() => false) }
})

// listBuiltinProviders 不触 ConfigStore（纯函数 import JSON），传空对象即可实例化（构造只存引用）。
const service = new ConfigService('/tmp/project', {} as unknown as IConfigStore)

describe('ConfigService.listBuiltinProviders', () => {
  const providers: BuiltinProviderTemplate[] = service.listBuiltinProviders()

  it('t1: 返回 39 个内置 provider', () => {
    expect(providers).toHaveLength(39)
  })

  it('t2: openai authMode===api_key 且 envVars 含 OPENAI_API_KEY', () => {
    const openai = providers.find(p => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai!.authMode).toBe('api_key')
    expect(openai!.envVars).toContain('OPENAI_API_KEY')
  })

  it('t3: 不含 radius（wave 1 已排除）', () => {
    const radius = providers.find(p => p.id === 'radius')
    expect(radius).toBeUndefined()
  })

  it('t4: anthropic authMode===both 且 oauthSupported===true', () => {
    const anthropic = providers.find(p => p.id === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic!.authMode).toBe('both')
    expect(anthropic!.oauthSupported).toBe(true)
  })

  it('t5: 每个 provider 含全字段，models 元素含 11 字段契约（id/name/api/baseUrl/reasoning/input/cost/contextWindow/maxTokens/thinkingLevelMap/compat）', () => {
    expect(providers.length).toBeGreaterThan(0)
    const ALL_11 = ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat']
    for (const p of providers) {
      // provider 级字段
      expect(typeof p.id).toBe('string')
      expect(typeof p.name).toBe('string')
      // api/baseUrl 为 optional，存在时须为 string
      if (p.api !== undefined) expect(typeof p.api).toBe('string')
      if (p.baseUrl !== undefined) expect(typeof p.baseUrl).toBe('string')
      expect(['api_key', 'oauth', 'both', 'ambient']).toContain(p.authMode)
      expect(Array.isArray(p.envVars)).toBe(true)
      expect(typeof p.oauthSupported).toBe('boolean')
      if (p.apiKeyName !== undefined) expect(typeof p.apiKeyName).toBe('string')
      if (p.oauthName !== undefined) expect(typeof p.oauthName).toBe('string')
      expect(typeof p.modelCount).toBe('number')
      if (p.logoUrl !== undefined) expect(typeof p.logoUrl).toBe('string')
      expect(Array.isArray(p.models)).toBe(true)
      expect(p.models.length).toBe(p.modelCount)
      // model 级 11 字段契约（生成脚本恒输出 11 键；可选字段缺省为 null）
      for (const m of p.models) {
        for (const key of ALL_11) {
          expect(m, `${p.id} model ${m.id} 应含字段 ${key}`).toHaveProperty(key)
        }
        expect(typeof m.id).toBe('string')
        expect(typeof m.name).toBe('string')
        expect(typeof m.api).toBe('string')
        if (m.baseUrl !== undefined) expect(typeof m.baseUrl).toBe('string')
        expect(typeof m.reasoning).toBe('boolean')
        expect(Array.isArray(m.input)).toBe(true)
        expect(m.contextWindow).toBeTypeOf('number')
        if (m.maxTokens !== null && m.maxTokens !== undefined) expect(typeof m.maxTokens).toBe('number')
        if (m.thinkingLevelMap !== null && m.thinkingLevelMap !== undefined) expect(typeof m.thinkingLevelMap).toBe('object')
        if (m.compat !== null && m.compat !== undefined) expect(typeof m.compat).toBe('object')
      }
    }
  })

  it('t6: google-vertex envVars 含 GOOGLE_CLOUD_API_KEY（镜像表漏配回归，M-1）', () => {
    const gv = providers.find(p => p.id === 'google-vertex')
    expect(gv).toBeDefined()
    expect(gv!.envVars).toContain('GOOGLE_CLOUD_API_KEY')
  })
})

describe('ConfigService auth 清理（I9 清理① + I8，T6）', () => {
  function makeSvc(authStorage?: Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>) {
    const mockStore = {
      getProviderConfig: vi.fn(() => ({ name: 'anthropic' })),
      upsertProvider: vi.fn(() => ({})),
      removeProvider: vi.fn(() => ({ removed: true })),
      // M5-05：deleteProvider 现调 cleanEnabledModelsResidue（决策 4 不变式），mock 必须提供
      cleanEnabledModelsResidue: vi.fn(),
    } as unknown as IConfigStore
    const svc = new ConfigService('/tmp/project', mockStore, authStorage as unknown as Pick<AuthStorage, 'set' | 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>)
    return { svc, mockStore, authStorage }
  }

  it('setProvider 保存 apiKey → 清 auth.json oauth（both provider 切凭据源，幂等）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { apiKey: 'sk-test' })
    expect(authStorage.remove).toHaveBeenCalledWith('anthropic')
  })

  it('setProvider 未传 apiKey（只改 baseUrl）→ 不清 auth.json', () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { baseUrl: 'https://proxy.example.com' })
    expect(authStorage.remove).not.toHaveBeenCalled()
  })

  it('setProvider apiKey 为空串（env 空自定义变量）→ 不清 auth.json（MF-1：防误删 OAuth 凭据）', () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    svc.setProvider('anthropic', { apiKey: '', authMethod: 'env_var' })
    expect(authStorage.remove).not.toHaveBeenCalled()
  })

  it('deleteProvider → 清 auth.json（I8：OAuth token 强绑定凭据，删除时同步清）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    await svc.deleteProvider('anthropic')
    expect(authStorage.remove).toHaveBeenCalledWith('anthropic')
  })

  it('deleteProvider → 清 enabledModels 残留（M5-05，决策 4 不变式，对齐 removeProviderByKind）', async () => {
    const authStorage = { remove: vi.fn(async () => undefined), hasOAuth: vi.fn(async () => false) }
    const { svc, mockStore } = makeSvc(authStorage as unknown as Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync'>)
    await svc.deleteProvider('anthropic')
    expect(mockStore.cleanEnabledModelsResidue).toHaveBeenCalledWith('anthropic')
  })

  it('未注入 authStorage（测试/无 OAuth 场景）→ 两处清理 no-op 不抛错', () => {
    const { svc } = makeSvc()
    expect(() => svc.setProvider('anthropic', { apiKey: 'sk-x' })).not.toThrow()
    expect(() => svc.deleteProvider('anthropic')).not.toThrow()
  })
})

describe('ConfigService.checkEnvVars（I3，wave-env-check TC2）', () => {
  const KEEP: Record<string, string | undefined> = {}
  for (const name of ['CHECK_ENV_A', 'CHECK_ENV_EMPTY', 'CHECK_ENV_B']) {
    KEEP[name] = process.env[name]
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(KEEP)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('已设置（非空）→ true；未设置 / 空串 → false', () => {
    process.env.CHECK_ENV_A = 'sk-abc'
    process.env.CHECK_ENV_EMPTY = ''
    delete process.env.CHECK_ENV_B

    const result = service.checkEnvVars(['CHECK_ENV_A', 'CHECK_ENV_EMPTY', 'CHECK_ENV_B'])
    expect(result).toEqual({ CHECK_ENV_A: true, CHECK_ENV_EMPTY: false, CHECK_ENV_B: false })
  })

  it('names 去重（重复名字只查一次，结果一致）', () => {
    process.env.CHECK_ENV_A = 'x'
    const result = service.checkEnvVars(['CHECK_ENV_A', 'CHECK_ENV_A'])
    expect(Object.keys(result)).toEqual(['CHECK_ENV_A'])
    expect(result.CHECK_ENV_A).toBe(true)
  })

  it('空数组 → 空结果（不抛错）', () => {
    expect(service.checkEnvVars([])).toEqual({})
  })
})

// [2026-09 测试舰队审查 r2-24] 以下三节已删（与专文重复，专文覆盖更硬）：
// - 'authMethod 透传与推断' setProvider 写侧 → provider-write-side-switch.test.ts
//   'authMethod 写 providers.json，models.json 不落 authMethod'（真实落盘断言）
// - 'listProviders 回填 authMethod' 读侧 → provider-read-source-switch.test.ts
//   A1-3（providers.json 标注 + $/非空/空 推断）
// - 'status 派生与 models 合并' → config-service-listproviders.test.ts TC5/TC7
//   （connected/not_configured 双源 + custom models 兜底）
