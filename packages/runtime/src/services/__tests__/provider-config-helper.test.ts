/**
 * provider-config-helper 测试：scoped-model 残留清理（scoped-model design §4.1 A8 / S8）
 * + 删除链 quota 清理（coding-plan-quota-config-ux D12，见文末 describe 列表）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-config-helper.test.ts
 *
 * A8 语义：deleteProvider 后 scopedModels（providers.json 顶层白名单）中该 provider 的
 * `providerId/` 前缀条目被清，其他 provider 条目保留。
 *
 * D12 语义：provider 删除链在 extras 条目已从磁盘清除之后才调 quota 清理器，且清理器失败
 * warn-only（惰性孤儿），不阻断删除主流程。
 *
 * 策略：真实 TaijiProviderStore（tmpdir providers.json，走 RMW 锁 + 原子写真路径）
 * + mock configStore/authStorage（调用路由断言，模式同 config-service-removebykind.test.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { TaijiProviderStore } from '../provider-extras-store.js'
import { applyProviderWritePolicy, listProviders } from '../provider-config-helper.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import type { IConfigStore } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'

type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

let dir: string
let extrasPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-config-helper-'))
  extrasPath = join(dir, 'config', 'providers.json')
  mkdirSync(join(dir, 'config'), { recursive: true })
  // 防线②③ 命中即 warn（诊断日志）——测试期静音，需要断言的用例经 expect(console.warn) 检查
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 预写 providers.json（含顶层 scopedModels 白名单）。 */
function writeScopedModels(scopedModels: string[]): void {
  writeFileSync(extrasPath, JSON.stringify({ version: 1, providers: {}, scopedModels }, null, 2))
}

/** 读回文件态 scopedModels（绕过 store 直接读盘，断言写路径真生效）。 */
function readScopedModels(): string[] {
  return (JSON.parse(readFileSync(extrasPath, 'utf-8')) as { scopedModels?: string[] }).scopedModels ?? []
}

/** 最小 mock IConfigStore（写方法 vi.fn 供断言路由，模式同 config-service-removebykind.test.ts）。 */
function makeStore() {
  return {
    getEnabledModels: vi.fn(() => []),
    getDefaultModel: vi.fn(() => null),
    removeProvider: vi.fn(() => ({ removed: true })),
    cleanEnabledModelsResidue: vi.fn(),
  } as unknown as IConfigStore & {
    removeProvider: ReturnType<typeof vi.fn>
    cleanEnabledModelsResidue: ReturnType<typeof vi.fn>
  }
}

function makeAuth(): FullAuthPick {
  return {
    listCredentialIds: vi.fn(() => []),
    hasCredentialSync: vi.fn(() => false),
    remove: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    hasOAuth: vi.fn(() => false),
    hasOAuthSync: vi.fn(() => false),
  } as unknown as FullAuthPick
}

function makeService(): { svc: ConfigService; store: ReturnType<typeof makeStore>; extras: TaijiProviderStore } {
  const store = makeStore()
  const extras = new TaijiProviderStore(extrasPath)
  const svc = new ConfigService('/tmp/project', store, makeAuth(), extras)
  return { svc, store, extras }
}

describe('A8: deleteProvider 清 scopedModels 残留', () => {
  it('A8 删除 provider 后 scopedModels 中该 provider 前缀条目被清，其他 provider 条目保留', async () => {
    writeScopedModels(['openai/gpt-4', 'anthropic/claude', 'openai/gpt-3.5'])
    const { svc, store } = makeService()

    await svc.deleteProvider('openai')

    // openai/ 前缀两条被清，anthropic 条目保留（读盘断言，非 mock 回显）
    expect(readScopedModels()).toEqual(['anthropic/claude'])
    // 编排路由：models.json 条目删除 + enabledModels 残留清理照旧
    expect(store.removeProvider).toHaveBeenCalledWith('openai')
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
  })

  it('A8 无匹配条目时幂等（scopedModels 原样保留）', async () => {
    writeScopedModels(['anthropic/claude'])
    const { svc } = makeService()

    await svc.deleteProvider('openai')

    expect(readScopedModels()).toEqual(['anthropic/claude'])
  })
})

/**
 * M1b：防线载体 applyProviderWritePolicy（设计 D1 防线②③，catalog-provider-field-authority v3.3）。
 *
 * 纯函数单测（a–j 逐条对应实施计划验收条款）+ 一条 setProvider 接线用例（证明载体真的被
 * setProvider 路径消费，而不只是可独立调用）。
 */
describe('M1b: applyProviderWritePolicy 防线②③', () => {
  it('a1 空串矩阵（provider 级）：name/baseUrl/apiKey/api 收到空串 → merged 无任何键', () => {
    const { merged } = applyProviderWritePolicy(
      {},
      { name: '', baseUrl: '', apiKey: '', api: '' },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged).toEqual({})
  })

  it('a2 空串矩阵（模型级）：id/name/api/baseUrl 空串 → 空串键被剥除 + 空 id 模型整条丢弃', () => {
    const { merged } = applyProviderWritePolicy(
      {},
      { models: [{ id: 'm1', name: '', api: '', baseUrl: '' }, { id: '', name: 'orphan' }] },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged.models).toEqual([{ id: 'm1' }])
  })

  it('b apiKey 空串 = 清除语义 → merged.apiKey 键被删除（不是被写成空串）', () => {
    const { merged } = applyProviderWritePolicy(
      { apiKey: 'sk-old', baseUrl: 'https://api.example/v1' },
      { apiKey: '' },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged).not.toHaveProperty('apiKey')
  })

  it('c 纯空白串（"  "）与空串同视 → 不写键 + 既有值不变', () => {
    const { merged } = applyProviderWritePolicy(
      { apiKey: 'sk-old', baseUrl: 'https://api.example/v1' },
      { apiKey: '  ', name: '  ', baseUrl: '  ', api: '  ' },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged).toEqual({ baseUrl: 'https://api.example/v1' })
  })

  it('d catalog + type 键 → merged 不含 provider 级 api 键 + warn', () => {
    const { merged } = applyProviderWritePolicy(
      { baseUrl: 'https://gw.example' },
      { api: 'anthropic-messages' },
      'catalog',
      'settings',
      'opencode-go',
    )

    expect(merged).not.toHaveProperty('api')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ignored provider-level type for catalog opencode-go'))
  })

  it('e catalog + 非空 baseUrl（settings）→ 写入 merged.baseUrl 且返回 gatewayToSet', () => {
    const { merged, gatewayToSet } = applyProviderWritePolicy(
      {},
      { baseUrl: 'https://gw.example/opencode' },
      'catalog',
      'settings',
      'opencode-go',
    )

    expect(merged.baseUrl).toBe('https://gw.example/opencode')
    expect(gatewayToSet).toBe('https://gw.example/opencode')
  })

  it('f catalog + 显式空串 baseUrl → merged 无 baseUrl 键且返回 gatewayToClear', () => {
    const { merged, gatewayToClear } = applyProviderWritePolicy(
      { baseUrl: 'https://gw.example/old' },
      { baseUrl: '' },
      'catalog',
      'settings',
      'opencode-go',
    )

    expect(merged).not.toHaveProperty('baseUrl')
    expect(gatewayToClear).toBe(true)
  })

  it('g catalog + baseUrl 未带键（undefined）→ 既有 baseUrl 不变且无网关信号', () => {
    const result = applyProviderWritePolicy(
      { baseUrl: 'https://gw.example/keep' },
      {},
      'catalog',
      'settings',
      'opencode-go',
    )

    expect(result.merged.baseUrl).toBe('https://gw.example/keep')
    expect(result.gatewayToSet).toBeUndefined()
    expect(result.gatewayToClear).toBeUndefined()
  })

  it('h 八字段全缺 → 返回 skipUpsert 信号（name 不计入实质字段）', () => {
    const result = applyProviderWritePolicy({}, { name: 'Only Name' }, 'custom', 'settings', 'p-empty')

    expect(result.skipUpsert).toBe(true)
  })

  it('h2 八字段任一在场 → 不返回 skipUpsert（反向对照）', () => {
    const result = applyProviderWritePolicy(
      { headers: { 'X-K': 'v' } },
      {},
      'custom',
      'settings',
      'p-nonempty',
    )

    expect(result.skipUpsert).toBeUndefined()
  })

  it("i source='import' + catalog + 非空 baseUrl/api → 两者均被剥除（不产生隐形网关）", () => {
    const result = applyProviderWritePolicy(
      {},
      { baseUrl: 'https://gw.example', api: 'anthropic-messages' },
      'catalog',
      'import',
      'opencode-go',
    )

    expect(result.merged).toEqual({})
  })

  it("j source='settings' + custom + 非空 baseUrl → 原样写入", () => {
    const { merged } = applyProviderWritePolicy(
      {},
      { baseUrl: 'https://api.example/v1' },
      'custom',
      'settings',
      'p-custom',
    )

    expect(merged.baseUrl).toBe('https://api.example/v1')
  })
})

describe('S15: custom provider oauth 清理失败 fail-fast（I9 清理① + RT-7#3 await 化）', () => {
  function makeSetProviderService(auth: FullAuthPick) {
    const upsertProvider = vi.fn((_providerId: string, _merged: Record<string, unknown>) => ({}))
    const store = {
      getProviderConfig: vi.fn(() => undefined),
      applyTypeTranslation: vi.fn((t: string) => t),
      upsertProvider,
      ensureProviderInWhitelist: vi.fn(),
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    return { svc: new ConfigService('/tmp/project', store, auth, new TaijiProviderStore(extrasPath)), upsertProvider }
  }

  it('authStorage.remove reject → setProvider 整体 reject 且 upsert 不执行（清理失败不落半成品 models.json）', async () => {
    const auth = makeAuth()
    ;(auth.remove as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('auth store locked'))
    const { svc, upsertProvider } = makeSetProviderService(auth)

    await expect(svc.setProvider('p-custom', { apiKey: 'sk-new' })).rejects.toThrow('auth store locked')
    expect(upsertProvider).not.toHaveBeenCalled()
    expect(auth.remove).toHaveBeenCalledWith('p-custom')
  })

  it('authStorage.remove 成功 → upsert 在清理完成后执行（await 顺序，merged 含新 apiKey）', async () => {
    const removeDone: number[] = []
    const auth = makeAuth()
    ;(auth.remove as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      removeDone.push(1)
    })
    const { svc, upsertProvider } = makeSetProviderService(auth)

    await svc.setProvider('p-custom', { apiKey: 'sk-new' })

    // 清理先完成、upsert 后执行（fire-and-forget 时 upsert 可先于 auth.json 落盘发生）
    expect(removeDone).toHaveLength(1)
    expect(upsertProvider).toHaveBeenCalledTimes(1)
    expect(upsertProvider.mock.calls[0][1]).toMatchObject({ apiKey: 'sk-new' })
  })
})

describe('M1b: setProvider 接线（防线②③ 经 applyProviderWritePolicy 载体消费信号）', () => {
  /**
   * 最小 mock IConfigStore（setProvider 路径：读既有条目 + 捕获 upsert 入参）+ 真实
   * TaijiProviderStore（gatewayBaseUrl 标记落盘/清理走真文件，modify 经 spy 观测调用序）。
   */
  function makeSetProviderService(existing: Record<string, unknown> | undefined) {
    const upsertProvider = vi.fn((_providerId: string, _merged: Record<string, unknown>) => ({}))
    const ensureProviderInWhitelist = vi.fn()
    const store = {
      getProviderConfig: vi.fn(() => existing),
      applyTypeTranslation: vi.fn((t: string) => t),
      upsertProvider,
      ensureProviderInWhitelist,
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    const extras = new TaijiProviderStore(extrasPath)
    const modifySpy = vi.spyOn(extras, 'modify')
    const svc = new ConfigService('/tmp/project', store, makeAuth(), extras)
    return { svc, upsertProvider, ensureProviderInWhitelist, extras, modifySpy }
  }

  it('catalog 保存空串 baseUrl + 快照 artifact type → 落盘条目不含 baseUrl/api 键（P0 毒化链拆除）', async () => {
    const { svc, upsertProvider } = makeSetProviderService({ name: 'OpenCode Go' })

    await svc.setProvider('opencode-go', {
      type: 'anthropic-messages',
      baseUrl: '',
      headers: { 'X-Custom': 'v' },
    })

    expect(upsertProvider.mock.calls[0]?.[1]).toEqual({ name: 'OpenCode Go', headers: { 'X-Custom': 'v' } })
  })

  it('custom 清除 API Key 哨兵（apiKey:""）→ 落盘条目删键而非写空串', async () => {
    const { svc, upsertProvider } = makeSetProviderService({ apiKey: 'sk-old', baseUrl: 'https://api.example/v1' })

    await svc.setProvider('p-custom', { apiKey: '' })

    expect(upsertProvider.mock.calls[0]?.[1]).toEqual({ baseUrl: 'https://api.example/v1' })
  })

  it('catalog 设置用户网关（非空 baseUrl）→ 落盘条目写入该 baseUrl', async () => {
    const { svc, upsertProvider } = makeSetProviderService({ name: 'OpenCode Go' })

    await svc.setProvider('opencode-go', { baseUrl: 'https://gw.example/opencode' })

    expect(upsertProvider.mock.calls[0]?.[1]).toMatchObject({ baseUrl: 'https://gw.example/opencode' })
  })

  it('b catalog + 非空 baseUrl → extras 写 gatewayBaseUrl 标记，且 upsert 在其后（写序契约）', async () => {
    const { svc, upsertProvider, extras, modifySpy } = makeSetProviderService({ name: 'OpenCode Go' })

    await svc.setProvider('opencode-go', { baseUrl: 'https://gw.example/opencode' })

    expect(extras.getExtrasSync('opencode-go')?.gatewayBaseUrl).toBe('https://gw.example/opencode')
    expect(modifySpy).toHaveBeenCalledTimes(1)
    // 设置网关：先写 extras 标记、后写 models.json（崩溃中间态 = 多余标记，D2 可自愈）
    expect(modifySpy.mock.invocationCallOrder[0]).toBeLessThan(upsertProvider.mock.invocationCallOrder[0]!)
  })

  it('a 既有条目 + 清空网关 → upsert 被调用、落盘条目不含 baseUrl、extras 标记被清（验收场景 A\'/5 单元级）', async () => {
    // 预置形态 = 用户此前设过网关：catalog override {name, baseUrl} + extras 标记
    const { svc, upsertProvider, extras, modifySpy } = makeSetProviderService({
      name: 'OpenCode Go',
      baseUrl: 'https://gw.example',
    })
    await extras.modify('opencode-go', current => ({ ...current, gatewayBaseUrl: 'https://gw.example' }))
    modifySpy.mockClear()

    await svc.setProvider('opencode-go', { baseUrl: '' })

    // (i) 既有条目的剥除/清除必须落盘（否则用户的「清空」是静默 no-op、盘上旧 baseUrl 仍生效）
    expect(upsertProvider).toHaveBeenCalledTimes(1)
    // (ii) 落盘条目不含 baseUrl 键（回退内置端点）
    expect(upsertProvider.mock.calls[0]?.[1]).not.toHaveProperty('baseUrl')
    // (iii) extras 网关标记被清
    expect(extras.getExtrasSync('opencode-go')?.gatewayBaseUrl).toBeUndefined()
    expect(modifySpy).toHaveBeenCalledTimes(1)
  })

  it('清空网关：无标记时短路不调 extras.modify（既有条目照样 upsert）', async () => {
    const { svc, upsertProvider, modifySpy } = makeSetProviderService({
      name: 'OpenCode Go',
      baseUrl: 'https://gw.example/keep',
    })

    await svc.setProvider('opencode-go', { baseUrl: '' })

    expect(upsertProvider).toHaveBeenCalledTimes(1)
    expect(upsertProvider.mock.calls[0]?.[1]).not.toHaveProperty('baseUrl')
    expect(modifySpy).not.toHaveBeenCalled()
  })

  it('b 新建 + 八字段全缺 → upsertProvider 不被调用（只不物化「新」空壳）', async () => {
    const { svc, upsertProvider } = makeSetProviderService(undefined)

    await svc.setProvider('p-empty', { name: 'Only Name' })

    expect(upsertProvider).not.toHaveBeenCalled()
  })

  it('c 既有条目 + 八字段全缺（全清空）→ upsertProvider 被调用，落盘内容为剥除后结果', async () => {
    const { svc, upsertProvider } = makeSetProviderService({
      name: 'OpenCode Go',
      baseUrl: 'https://gw.example',
    })

    await svc.setProvider('opencode-go', { baseUrl: '' })

    expect(upsertProvider).toHaveBeenCalledTimes(1)
    expect(upsertProvider.mock.calls[0]?.[1]).toEqual({ name: 'OpenCode Go' })
  })

  it('d 新建 + skipUpsert 成立 → ensureProviderInWhitelist 仍被调用（白名单守卫不随 skip 跳过）', async () => {
    const { svc, upsertProvider, ensureProviderInWhitelist } = makeSetProviderService(undefined)

    await svc.setProvider('p-new-empty', { name: 'Only Name' })

    expect(upsertProvider).not.toHaveBeenCalled()
    expect(ensureProviderInWhitelist).toHaveBeenCalledWith('p-new-empty')
  })
})

/**
 * M2b：链 5 凭据判定迁移到 resolver 批量 sync 版（设计 D3 收口）。
 *
 * 不变量：apiKeySet / status 判定经 `listCredentialBackedProviderIds` 单次批量取（auth.json ∪
 * models.json），不得退回 per-provider `hasProviderCredential` / `hasCredentialSync` 循环
 * （那会重新引入 N+1 读盘，B3 先例 provider-config-helper.ts:412）。
 */
describe('M2b: listProviders 凭据判定走 resolver 批量 sync 版（链 5）', () => {
  function makeListStore(providers: Record<string, unknown> = {}) {
    return {
      readModels: vi.fn(() => ({ providers })),
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
  }

  function makeResolver(ids: string[]) {
    const resolver: IProviderCredentialResolver = {
      hasProviderCredential: vi.fn(() => false),
      listCredentialBackedProviderIds: vi.fn(() => new Set(ids)),
      resolveProviderCredential: vi.fn(async () => undefined),
    }
    return resolver
  }

  it('apiKeySet 以 resolver 批量结果为权威，且 store/auth 均单次读（无 N+1）', () => {
    const store = makeListStore({ 'my-custom': { name: 'My Custom' } })
    const auth = makeAuth()
    // auth.json 有 anthropic（catalog），但 resolver 批量结果为空 → apiKeySet 应以 resolver 为准
    vi.mocked(auth.listCredentialIds).mockReturnValue(['anthropic'])
    const resolver = makeResolver([])

    const result = listProviders(store, auth, undefined, resolver)

    // 单次批量调用（非 per-provider hasProviderCredential / hasCredentialSync 循环）
    expect(vi.mocked(resolver.listCredentialBackedProviderIds)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(resolver.hasProviderCredential)).not.toHaveBeenCalled()
    // 批量单次读盘：readModels / listCredentialIds 各一次
    expect(vi.mocked(store.readModels)).toHaveBeenCalledTimes(1)
    expect(auth.listCredentialIds).toHaveBeenCalledTimes(1)
    expect(auth.hasCredentialSync).not.toHaveBeenCalled()
    // 权威性：resolver 空集 → catalog 凭据判定为 false，status 落到 not_configured
    const anthropic = result.find(p => p.id === 'anthropic')
    expect(anthropic?.kind).toBe('catalog')
    expect(anthropic?.apiKeySet).toBe(false)
    expect(anthropic?.status).toBe('not_configured')
  })

  it('resolver 批量结果命中时 catalog provider 判 connected', () => {
    // catalog 候选来自 models.json 条目（auth.json 无该 id）；无 override.apiKey →
    // 旧内联判定为 false，命中仅可能来自 resolver 批量集
    const store = makeListStore({ anthropic: {} })
    const auth = makeAuth()
    const resolver = makeResolver(['anthropic'])

    const result = listProviders(store, auth, undefined, resolver)

    const anthropic = result.find(p => p.id === 'anthropic')
    expect(anthropic?.apiKeySet).toBe(true)
    expect(anthropic?.status).toBe('connected')
  })

  it('真 resolver 接线：auth.json-only catalog provider 判 connected（端到端，无 per-provider 判定）', () => {
    const providers = { 'my-custom': { name: 'My Custom' } }
    const store = {
      readModels: vi.fn(() => ({ providers })),
      getEnabledModels: vi.fn(() => []),
      getProviderConfig: vi.fn((id: string) => (providers as Record<string, unknown>)[id]),
    } as unknown as IConfigStore
    const auth = makeAuth()
    // 凭据只在 auth.json（models.json 的 my-custom 无 apiKey）
    vi.mocked(auth.listCredentialIds).mockReturnValue(['anthropic'])
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: vi.fn(async () => undefined) },
      authStorage: auth,
      configStore: store,
    })

    const result = listProviders(store, auth, undefined, resolver)

    // auth.json-only catalog provider 命中（旧内联路径也命中；此处证明真 resolver 接线可达）
    expect(result.find(p => p.id === 'anthropic')?.apiKeySet).toBe(true)
    // 批量形态：不逐 provider 走 getProviderConfig / hasCredentialSync
    expect(store.getProviderConfig).not.toHaveBeenCalled()
    expect(auth.hasCredentialSync).not.toHaveBeenCalled()
  })
})

/**
 * M4：catalog provider 级展示字段下发（设计 catalog-provider-field-authority §3.3 D5
 * 「网关优先 + 模型集派生兜底」）。
 *
 * 断言口径 = 真实快照数据（builtin-providers.json 编译期 import）：快照 provider 级
 * api/baseUrl 是构建期 artifact，不再是展示源——展示值必须来自 override 用户网关（优先）
 * 或合并模型集（快照 ⊕ overlay）派生。overlay 在单测内为 never-seen（无数据目录文件）→
 * 合并视图 == 快照，派生结果由快照模型级字段决定（数值见各用例注释）。
 */
describe('M4: catalog 展示字段（网关优先 + 派生兜底）', () => {
  /**
   * 恒注入形态的 resolver 替身（M2fg：listProviders 构造必需）。本 describe 断言全部
   * 针对展示字段（api/baseUrl），凭据集恒空即可（apiKeySet 断言归 M2b describe）。
   */
  const stubResolver: IProviderCredentialResolver = {
    hasProviderCredential: () => false,
    listCredentialBackedProviderIds: () => new Set<string>(),
    resolveProviderCredential: async () => undefined,
  }

  /** 只读 store：providers 即 models.json 全量（catalog id 出现在其中即进入 catalog 聚合） */
  function listWith(providers: Record<string, Record<string, unknown>>) {
    const store = {
      readModels: vi.fn(() => ({ providers })),
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    return listProviders(store, undefined, undefined, stubResolver)
  }

  /** 取某 catalog provider 的聚合结果（override 缺省 = 空条目，等价「无用户配置」） */
  function displayOf(id: string, override: Record<string, unknown> = {}) {
    const found = listWith({ [id]: override }).find(p => p.id === id)
    expect(found).toBeDefined()
    // 防御性断言后再返回（不过度使用非空断言）
    if (!found) throw new Error(`catalog provider ${id} 未出现在 listProviders 结果中`)
    return found
  }

  it('a 网关优先：override 非空 baseUrl（用户网关）→ 原值下发，不参与派生', () => {
    // opencode-go 模型端点分两组（https://opencode.ai/zen/go 与 .../zen/go/v1），
    // 无网关时派生 undefined；存在用户网关时下发网关原值
    // （pi provider-composer.js:98 对全部内置模型执行 baseUrl 覆盖）
    const p = displayOf('opencode-go', { baseUrl: 'https://gw.corp.example/opencode' })

    expect(p.baseUrl).toBe('https://gw.corp.example/opencode')
    // 网关只覆盖端点，协议派生不受影响（该 provider 三协议混合 → undefined）
    expect(p.api).toBeUndefined()
  })

  it('b1 派生·全模型同值 → 该值（api/baseUrl 同规则）', () => {
    const p = displayOf('deepseek')

    expect(p.baseUrl).toBe('https://api.deepseek.com')
    expect(p.api).toBe('openai-completions')
  })

  it('b2 派生·>1 种非空值 → undefined（快照 artifact 非空也不再展示）', () => {
    // fireworks 快照 provider 级 baseUrl = https://api.fireworks.ai/inference（artifact），
    // 但模型级有 /inference 与 /inference/v1 两种 → 派生 undefined（artifact 不再被消费）
    const p = displayOf('fireworks')
    expect(p.baseUrl).toBeUndefined()
    expect(p.api).toBeUndefined()

    // 反向对照：amazon-bedrock 协议单一（api 有派生值）而端点两种（baseUrl undefined）
    const bedrock = displayOf('amazon-bedrock')
    expect(bedrock.api).toBe('bedrock-converse-stream')
    expect(bedrock.baseUrl).toBeUndefined()
  })

  it('b3 派生·全部空/缺省 → undefined（api 仍有派生值）', () => {
    // azure-openai-responses：38 个模型 baseUrl 全空（host 型目录），协议单一
    const p = displayOf('azure-openai-responses')

    expect(p.baseUrl).toBeUndefined()
    expect(p.api).toBe('azure-openai-responses')
  })

  it('c api 派生·混合协议 → undefined；单端点 provider 的 baseUrl 不受影响', () => {
    // github-copilot：3 协议混合（api undefined）+ 端点单一（baseUrl 有派生值）
    const p = displayOf('github-copilot')

    expect(p.api).toBeUndefined()
    expect(p.baseUrl).toBe('https://api.individual.githubcopilot.com')
  })

  it('c2 override.api（历史固化的快照 artifact）不参与展示：catalog 协议恒为派生值', () => {
    const p = displayOf('deepseek', { api: 'anthropic-messages' })

    expect(p.api).toBe('openai-completions')
    expect(p.baseUrl).toBe('https://api.deepseek.com')
  })

  it('空串/纯空白 baseUrl override（毒化残留窗口）视同无网关 → 走派生', () => {
    expect(displayOf('deepseek', { baseUrl: '' }).baseUrl).toBe('https://api.deepseek.com')
    expect(displayOf('deepseek', { baseUrl: '  ' }).baseUrl).toBe('https://api.deepseek.com')
  })
})

/**
 * D12（设计 §7.3 改动 5）：删除链 quota 清理的**排序约束**与失败语义。
 *
 * 语义两条（缺一即失效）：
 * ① 排序：quotaStateCleaner（生产 = QuotaService.clearProviderState，删 secrets/<pid>-{cookie,apikey}.txt
 *    明文 + lastFailure/lastFetchTime + 缓存条目）**只在 cleanProviderExtras 确认成功后**执行——
 *    否则留下「quota.apiKeySet=true 但 secrets 文件已删」的幽灵标记，同 id 重建的凭证归属判定
 *    读到假状态（M5-05 缺口）。
 * ② warn-only：extras 失败或清理器失败都不得阻断删除主流程（与 cleanAuthCredential 同语义）。
 *
 * 落点三处：deleteProvider 尾 + removeProviderByKind 的 catalog / custom 两分支尾。
 * 覆盖不到 helper 层则 quota-service.test.ts 无法发现排序/短路写反（如 `if (!ok) throw`）。
 */
describe('D12: 删除链 quota 清理（排序约束 + warn-only）', () => {
  /** 恒注入形态的 resolver 替身（catalog 分支构造必需；本 describe 的 default 为 null 故不被消费）。 */
  const stubResolver: IProviderCredentialResolver = {
    hasProviderCredential: () => false,
    listCredentialBackedProviderIds: () => new Set<string>(),
    resolveProviderCredential: async () => undefined,
  }

  /** 真实 TaijiProviderStore（tmpdir providers.json）+ 最小 mock IConfigStore，走 ConfigService 删除链。 */
  function makeD12Service() {
    const store = makeStore()
    const extras = new TaijiProviderStore(extrasPath)
    const svc = new ConfigService('/tmp/project', store, makeAuth(), extras, undefined, stubResolver)
    return { svc, store, extras }
  }

  it('① cleanProviderExtras 失败 → 删除主流程仍成功、清理器不被调用、secrets 保留', async () => {
    const { svc, store, extras } = makeD12Service()
    await extras.modify('my-custom', () => ({ quota: { enabled: true, apiKeySet: true } }))
    // extras 删除 IO 失败（boolean 失败信号来源）
    vi.spyOn(extras, 'delete').mockRejectedValue(new Error('disk full'))
    // secrets 文件 = 清理器唯一删除对象；清理器不被调用 ⇔ 文件保留
    const secretPath = join(dir, 'secrets', 'my-custom-cookie.txt')
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(secretPath, 'session=foo')
    const cleaner = vi.fn(async () => { rmSync(secretPath, { force: true }) })
    svc.setQuotaStateCleaner(cleaner)

    const ret = await svc.deleteProvider('my-custom')

    // 主语义（条目删除）不受清理失败影响
    expect(ret.removed).toBe(true)
    expect(store.removeProvider).toHaveBeenCalledWith('my-custom')
    // 排序约束：extras 未确认清除 → 清理器短路跳过（否则产生幽灵标记）
    expect(cleaner).not.toHaveBeenCalled()
    expect(existsSync(secretPath)).toBe(true)
    // warn 语义不变（失败可诊断，不抛）
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('providers.json extras cleanup failed'),
      expect.anything(),
    )
  })

  it('② extras 清除成功 + 清理器失败 → warn-only 惰性孤儿，删除主流程仍成功', async () => {
    const { svc, extras } = makeD12Service()
    await extras.modify('my-custom', () => ({ quota: { enabled: true, apiKeySet: true } }))
    const cleaner = vi.fn().mockRejectedValue(new Error('secrets unlink failed'))
    svc.setQuotaStateCleaner(cleaner)

    const ret = await svc.deleteProvider('my-custom')

    // extras 已删（排序前提满足）→ 清理器被执行；其失败只 warn，不外抛
    expect(ret.removed).toBe(true)
    expect(cleaner).toHaveBeenCalledWith('my-custom')
    expect(extras.getExtrasSync('my-custom')).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('quota state cleanup failed'),
      expect.anything(),
    )
  })

  it('③ deleteProvider 落点：清理器在 extras 条目已从磁盘清除之后才执行', async () => {
    const { svc, extras } = makeD12Service()
    await extras.modify('my-custom', () => ({ quota: { enabled: true, apiKeySet: true } }))
    let extrasSeenByCleaner: unknown = 'cleaner-not-called'
    const cleaner = vi.fn(async (pid: string) => { extrasSeenByCleaner = extras.getExtrasSync(pid) })
    svc.setQuotaStateCleaner(cleaner)

    await svc.deleteProvider('my-custom')

    expect(cleaner).toHaveBeenCalledTimes(1)
    expect(cleaner).toHaveBeenCalledWith('my-custom')
    // 排序证据：清理器执行时读 providers.json，该条目已不在（保证 secrets 与标记同清）
    expect(extrasSeenByCleaner).toBeUndefined()
  })

  it('④ removeProviderByKind(catalog) 分支尾：清理器在 extras 清除后执行', async () => {
    const { svc, extras } = makeD12Service()
    await extras.modify('openai', () => ({ quota: { enabled: true, apiKeySet: true } }))
    let extrasSeenByCleaner: unknown = 'cleaner-not-called'
    const cleaner = vi.fn(async (pid: string) => { extrasSeenByCleaner = extras.getExtrasSync(pid) })
    svc.setQuotaStateCleaner(cleaner)

    const ret = await svc.removeProviderByKind('openai', 'catalog')

    expect(ret.removed).toBe(true)
    expect(cleaner).toHaveBeenCalledWith('openai')
    expect(extrasSeenByCleaner).toBeUndefined()
  })

  it('⑤ removeProviderByKind(custom) 分支尾：清理器在 extras 清除后执行', async () => {
    const { svc, extras } = makeD12Service()
    await extras.modify('my-custom', () => ({ quota: { enabled: true, apiKeySet: true } }))
    let extrasSeenByCleaner: unknown = 'cleaner-not-called'
    const cleaner = vi.fn(async (pid: string) => { extrasSeenByCleaner = extras.getExtrasSync(pid) })
    svc.setQuotaStateCleaner(cleaner)

    await svc.removeProviderByKind('my-custom', 'custom')

    expect(cleaner).toHaveBeenCalledWith('my-custom')
    expect(extrasSeenByCleaner).toBeUndefined()
  })

  it('未注入清理器（未回填）→ 删除链正常，无 no-op 之外的行为变化', async () => {
    const { svc, extras } = makeD12Service()
    await extras.modify('my-custom', () => ({ quota: { enabled: true } }))

    const ret = await svc.deleteProvider('my-custom')

    expect(ret.removed).toBe(true)
    expect(extras.getExtrasSync('my-custom')).toBeUndefined()
  })
})
