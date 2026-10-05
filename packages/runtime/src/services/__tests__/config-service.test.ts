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
import type { BuiltinProviderTemplate } from '@taiji/shared'
import snapshot from '../../generated/builtin-providers.json'
import type { AuthStorage } from '../auth/auth-storage.js'
import type { TaijiProviderStore } from '../provider-extras-store.js'

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

  // 投影层契约 = 「生成 JSON 完整透出 + 形状守卫」。值契约（42/openai both/radius 在册/
  // google-vertex M-1）的归属边界在 gen 提取器（scripts/__tests__/gen-builtin-providers.test.ts），
  // 此处不再复制第二份手写基线数字（gen t10 注释登记过「手写基线第三份数据失守」教训）。
  it('t1: 投影与生成快照结构等价（完整透出，无丢失无改写）', () => {
    expect(providers.length).toBeGreaterThan(0)
    expect(providers).toEqual(snapshot.providers)
  })

  it('t5: provider 级投影形状契约（本层独有信号：models.length===modelCount 对账 + 损坏守卫不误触发）', () => {
    for (const p of providers) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.name).toBe('string')
      expect(['api_key', 'oauth', 'both', 'ambient']).toContain(p.authMode)
      expect(Array.isArray(p.envVars)).toBe(true)
      expect(typeof p.oauthSupported).toBe('boolean')
      expect(typeof p.modelCount).toBe('number')
      expect(Array.isArray(p.models)).toBe(true)
      // 条目数对账是投影层独有的完整性信号（快照等价已保证其余字段）
      expect(p.models.length).toBe(p.modelCount)
    }
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

describe('ConfigService.getScopedModels（A8 恒注入守卫）', () => {
  it('未注入 providerExtrasStore → 抛带恢复指引 Error（不静默返回 []，与 write 侧 modifyScopedModels 对称）', () => {
    // 构造参数缺省 providerExtrasStore（生产组合根恒注入，此形态只出现在测试/装配遗漏）
    const svc = new ConfigService('/tmp/project', {} as unknown as IConfigStore)
    expect(() => svc.getScopedModels()).toThrow(
      /providerExtrasStore 未注入.*恢复：在组合根构造 ConfigService 时注入 providerExtrasStore/,
    )
  })
})
