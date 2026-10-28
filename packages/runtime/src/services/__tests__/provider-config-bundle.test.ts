import { logger } from '../../infra/logger.js';
import { createTtsDriver, getTtsFormModels } from '../../infra/tts/index.js';
import { TtsMessageHandler, type TtsHandlerContext } from '../../transport/tts-message-handler.js';
import { CredentialWriter, type AuthStorage } from '../auth/auth-storage.js';
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js';
import { ConfigService } from '../config-service.js';
import type { IConfigStore } from '../ports/config.js';
import type { IProviderCredentialResolver, ResolvedProviderCredential } from '../ports/provider-credential-resolver.js';
import { TtsSynthesisChunk, type TtsDriver } from '../ports/tts.js';
import { applyProviderWritePolicy, listProviders } from '../provider-config-helper.js';
import { TaijiProviderStore } from '../provider-extras-store.js';
import { isSensitiveHeaderKey, redactSensitiveHeaders } from '../provider-header-redaction.js';
import { getQuotaFetcher, listQuotaPresets as listQuotaPresets_mock } from '../quota-providers/index.js';
import { QuotaService } from '../quota-service.js';
import { canonicalSerialize, enforceTtsCacheFifoCap, splitIntoChunks, wrapWavHeader } from '../tts-audio.js';
import { TtsService, TtsServiceError, type TtsConfigureResult } from '../tts-service.js';
import { MAX_SPEAK_CHARS, QuotaFetchOutcome, QuotaFetcherConfig, TTS_CACHE_MAX_BYTES, TTS_CACHE_MAX_FILES, TtsCapabilities, TtsConfig, TtsFormModel, TtsProviderId, type ClientMessage, type InternalSpeechRequest, type ProviderQuotaFetcher, type QuotaPreset } from '@taiji/shared';
import { getTtsCacheDir } from '@taiji/shared/paths';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket as WsType } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← provider-config-helper.test.ts
// ======================================================================

type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>


let dir: string

let extrasPath: string


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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-config-helper', () => {
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

  it('d 新建 + skipUpsert 成立 → ensureProviderInWhitelist 仍被调用（白名单检查不随 skip 跳过）', async () => {
    const { svc, upsertProvider, ensureProviderInWhitelist } = makeSetProviderService(undefined)

    await svc.setProvider('p-new-empty', { name: 'Only Name' })

    expect(upsertProvider).not.toHaveBeenCalled()
    expect(ensureProviderInWhitelist).toHaveBeenCalledWith('p-new-empty')
  })
})
/**
 * M2b：链 5 凭据判定迁移到 resolver 批量 sync 版（设计 D3 收敛）。
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
      resolveProviderApiKeyRaw: async () => undefined,
      resolveProviderBaseUrl: vi.fn(() => undefined),
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
    resolveProviderApiKeyRaw: async () => undefined,
    resolveProviderBaseUrl: () => undefined,
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
    resolveProviderApiKeyRaw: async () => undefined,
    resolveProviderBaseUrl: () => undefined,
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
describe('U6① 模型 id 规则（id 类毒化收敛：可强转则强转、不可用才丢）', () => {
  it('id 缺失（undefined / null）/ 空串 / 纯空白 / 对象 → 整条丢弃 + droppedModels 可见', () => {
    const result = applyProviderWritePolicy(
      { name: 'p1' },
      {
        models: [
          { id: 'keep-1' },
          { name: 'no-id' },
          { id: null },
          { id: '' },
          { id: '   ' },
          { id: { nested: true } },
        ] as unknown as Array<Record<string, unknown>>,
      },
      'custom',
      'settings',
      'p1',
    )
    const kept = result.merged.models as Array<Record<string, unknown>>
    expect(kept.map((m) => m.id)).toEqual(['keep-1'])
    expect(result.droppedModels).toHaveLength(5)
    // 文案区分命中类（S9a 类排障按文案 grep）
    expect(result.droppedModels?.[0]).toContain('invalid id')
    expect(result.droppedModels?.[0]).toContain('(no id)')
  })

  it('可强转 id（number / boolean）→ 保留并就地写回字符串形式（与 settings 路径 String(m.id) 同口径）', () => {
    const result = applyProviderWritePolicy(
      { name: 'p2' },
      {
        models: [{ id: 123 }, { id: true }] as unknown as Array<Record<string, unknown>>,
      },
      'custom',
      'settings',
      'p2',
    )
    const kept = result.merged.models as Array<Record<string, unknown>>
    expect(kept.map((m) => m.id)).toEqual(['123', 'true'])
    expect(result.droppedModels).toBeUndefined()
  })

  it('合法 id + 空串 name/api/baseUrl → 保留条目 + 删键（既有防线②行为不回归）', () => {
    const result = applyProviderWritePolicy(
      { name: 'p3' },
      {
        models: [{ id: 'm1', name: '', api: '  ', baseUrl: 'https://x' }] as unknown as Array<Record<string, unknown>>,
      },
      'custom',
      'settings',
      'p3',
    )
    const kept = result.merged.models as Array<Record<string, unknown>>
    expect(kept).toEqual([{ id: 'm1', baseUrl: 'https://x' }])
    expect(result.droppedModels).toBeUndefined()
  })

  it('未传 models → 不触碰 merged.models，无 droppedModels 信号', () => {
    const merged: Record<string, unknown> = { name: 'p4', models: [{ id: 'existing' }] }
    const result = applyProviderWritePolicy(merged, { name: 'p4' }, 'custom', 'settings', 'p4')
    expect(result.merged.models).toEqual([{ id: 'existing' }])
    expect(result.droppedModels).toBeUndefined()
  })
})
describe('coding-plan 额度显示自动开启（新增即默认同意，quota-auto-enable）', () => {
  // 本节来自 provider-config-helper.test.ts（原文件无 quota-providers mock），依赖真实
  // listQuotaPresets 合并视图；本文件级 mock（quota-service 节带来）把它钉成返回 []。
  // 节内覆写为 actual 实现、afterEach 还原，两条节互不感知。
  let realPresets: () => ReturnType<typeof import('../quota-providers/index.js')['listQuotaPresets']>

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../quota-providers/index.js')>('../quota-providers/index.js')
    realPresets = () => actual.listQuotaPresets()
  })

  beforeEach(() => {
    vi.mocked(listQuotaPresets_mock).mockImplementation(realPresets)
  })

  afterEach(() => {
    vi.mocked(listQuotaPresets_mock).mockImplementation(() => [])
  })

  /**
   * setProvider 路径 harness：新建（getProviderConfig 恒 undefined）+ 真实 TaijiProviderStore
   * （extras quota 落盘/读回断言走真文件）。hasWriter=false 模拟 credentialWriter 未注入
   * （catalog apiKey 丢弃，M5-01）。
   */
  function makeAutoEnableService(opts: { hasWriter?: boolean; existing?: Record<string, unknown> } = {}) {
    const upsertProvider = vi.fn((_providerId: string, _merged: Record<string, unknown>) => ({}))
    const store = {
      getProviderConfig: vi.fn(() => opts.existing),
      applyTypeTranslation: vi.fn((t: string) => t),
      upsertProvider,
      ensureProviderInWhitelist: vi.fn(),
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    const extras = new TaijiProviderStore(extrasPath)
    const svc = new ConfigService('/tmp/project', store, makeAuth(), extras)
    if (opts.hasWriter !== false) {
      svc.setCredentialWriter({ saveCredential: vi.fn().mockResolvedValue(undefined) } as unknown as CredentialWriter)
    }
    return { svc, extras }
  }

  /** 「不自动开启」标准路径：固定 zai-coding-cn 明文 setProvider → quotaAutoEnabled 与 quota extras 双 undefined 断言。 */
  async function setPlainZaiAndExpectNoAutoEnable(svc: ConfigService, extras: TaijiProviderStore): Promise<void> {
    const res = await svc.setProvider('zai-coding-cn', { name: 'Z.AI Coding CN', apiKey: 'sk-plain' })

    expect(res.quotaAutoEnabled).toBeUndefined()
    expect(extras.getExtrasSync('zai-coding-cn')?.quota).toBeUndefined()
  }

  it('quick-setup 形态 catalog 新建（明文 key，不回传模板 baseUrl）→ 写 quota { enabled, fetcher: zhipu }（模板身份匹配）', async () => {
    const { svc, extras } = makeAutoEnableService()

    const res = await svc.setProvider('zai-coding-cn', { name: 'Z.AI Coding CN', apiKey: 'sk-plain' })

    expect(res.quotaAutoEnabled).toBe(true)
    expect(extras.getExtrasSync('zai-coding-cn')?.quota).toEqual({ enabled: true, fetcher: 'zhipu' })
  })

  it('kimi-coding 新建 → fetcher 按模板 baseUrl 命中 kimi-coding preset', async () => {
    const { svc, extras } = makeAutoEnableService()

    const res = await svc.setProvider('kimi-coding', { name: 'Kimi For Coding', apiKey: 'sk-plain' })

    expect(res.quotaAutoEnabled).toBe(true)
    expect(extras.getExtrasSync('kimi-coding')?.quota).toEqual({ enabled: true, fetcher: 'kimi-coding' })
  })

  it('custom 新建（name/baseUrl 命中 api-key 类 preset + 明文 key）→ 自动开启', async () => {
    const { svc, extras } = makeAutoEnableService()

    const res = await svc.setProvider('my-glm-router', {
      name: 'glm router',
      baseUrl: 'https://my-router.example/v1',
      apiKey: 'sk-plain',
    })

    expect(res.quotaAutoEnabled).toBe(true)
    expect(extras.getExtrasSync('my-glm-router')?.quota).toEqual({ enabled: true, fetcher: 'zhipu' })
  })

  it('env 占位 key（$VAR）/ !command → 不自动开启（quota 凭证链不解占位）', async () => {
    const a = makeAutoEnableService()
    const resA = await a.svc.setProvider('zai-coding-cn', { name: 'Z.AI Coding CN', apiKey: '$MY_KEY' })
    expect(resA.quotaAutoEnabled).toBeUndefined()
    expect(a.extras.getExtrasSync('zai-coding-cn')?.quota).toBeUndefined()

    const b = makeAutoEnableService()
    const resB = await b.svc.setProvider('zai-coding-cn', { name: 'Z.AI Coding CN', apiKey: '!printenv KEY' })
    expect(resB.quotaAutoEnabled).toBeUndefined()
    expect(b.extras.getExtrasSync('zai-coding-cn')?.quota).toBeUndefined()
  })

  it('带前后空白的 env 占位串 → 不自动开启（isPlaintextCredential 函数内 trim 后仍命中 $ 前缀；调用点防线②只同视空串、不剥非空值空白）', async () => {
    const { svc, extras } = makeAutoEnableService()

    const res = await svc.setProvider('zai-coding-cn', { name: 'Z.AI Coding CN', apiKey: ' $MY_KEY ' })

    expect(res.quotaAutoEnabled).toBeUndefined()
    expect(extras.getExtrasSync('zai-coding-cn')?.quota).toBeUndefined()
  })

  it('cookie 类 preset（xiaomi-token-plan-cn → mimo）→ 不自动开启（无 cookie 可复用）', async () => {
    const { svc, extras } = makeAutoEnableService()

    const res = await svc.setProvider('xiaomi-token-plan-cn', { name: 'Xiaomi Token Plan CN', apiKey: 'sk-plain' })

    expect(res.quotaAutoEnabled).toBeUndefined()
    expect(extras.getExtrasSync('xiaomi-token-plan-cn')?.quota).toBeUndefined()
  })

  it('用户已有 enabled 决定（手动关闭）→ 不覆盖不复活', async () => {
    const { svc, extras } = makeAutoEnableService()
    await extras.modify('zai-coding-cn', current => ({
      ...current,
      quota: { enabled: false, fetcher: 'zhipu' },
    }))

    const res = await svc.setProvider('zai-coding-cn', { name: 'Z.AI Coding CN', apiKey: 'sk-plain' })

    expect(res.quotaAutoEnabled).toBeUndefined()
    expect(extras.getExtrasSync('zai-coding-cn')?.quota).toEqual({ enabled: false, fetcher: 'zhipu' })
  })

  it('编辑既有条目（非新建）→ 不自动开启（只对新增生效）', async () => {
    const { svc, extras } = makeAutoEnableService({ existing: { name: 'Z.AI Coding CN' } })

    await setPlainZaiAndExpectNoAutoEnable(svc, extras)
  })

  it('catalog + credentialWriter 未注入（apiKey 被丢弃，M5-01）→ 不自动开启（无凭证可用只会有 no-credential）', async () => {
    const { svc, extras } = makeAutoEnableService({ hasWriter: false })

    await setPlainZaiAndExpectNoAutoEnable(svc, extras)
  })
})
/**
 * ISSUES-2 ⑨：headers 出线脱敏（读侧出口层）。
 *
 * 断言口径：listProviders 聚合输出（config.providers / model.list 帧、config.getProviders
 * reply 的共同单点）对 provider 级与模型级 headers 做凭据词根键剔除；写侧（setProvider →
 * upsertProvider 落盘）零变化——pi 扩展对话链读 models.json 条目 headers 取 refreshToken
 * 的链路不经过 listProviders，落盘形态不变即链路不受影响。
 */
describe('ISSUES-2 ⑨: headers 出线脱敏（listProviders 读侧出口，落盘不动）', () => {
  function makeRedactionStore(providers: Record<string, unknown>) {
    return {
      readModels: vi.fn(() => ({ providers })),
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
  }

  function makeNoCredentialsResolver(): IProviderCredentialResolver {
    return {
      hasProviderCredential: vi.fn(() => false),
      listCredentialBackedProviderIds: vi.fn(() => new Set<string>()),
      resolveProviderCredential: vi.fn(async () => undefined),
      resolveProviderApiKeyRaw: async () => undefined,
      resolveProviderBaseUrl: vi.fn(() => undefined),
    }
  }

  const mixedHeaders = { 'x-wool-refresh-token': 'rt-candidate', 'User-Agent': 'taiji-gateway/1.0' }

  it('custom 条目 provider 级 + 模型级凭据键剔除、非敏感键保留', () => {
    const store = makeRedactionStore({
      'wool-qoder': {
        name: 'Wool Qoder',
        headers: mixedHeaders,
        authHeader: false,
        models: [{ id: 'qoder-cli', api: 'wool-qoder', headers: { 'x-wool-refresh-token': 'rt-model-level', 'X-Trace': 'on' } }],
      },
    })

    const result = listProviders(store, makeAuth(), undefined, makeNoCredentialsResolver())
    const wool = result.find(p => p.id === 'wool-qoder')

    expect(wool?.headers).toEqual({ 'User-Agent': 'taiji-gateway/1.0' })
    expect(wool?.models[0]?.headers).toEqual({ 'X-Trace': 'on' })
  })

  it('catalog override 条目同形脱敏；全键命中 → headers undefined（帧内不落字段）', () => {
    const store = makeRedactionStore({
      anthropic: { headers: mixedHeaders },
      'wool-trae': { name: 'Wool Trae', headers: { 'x-wool-refresh-token': 'rt-only' } },
    })

    const result = listProviders(store, makeAuth(), undefined, makeNoCredentialsResolver())

    expect(result.find(p => p.id === 'anthropic')?.headers).toEqual({ 'User-Agent': 'taiji-gateway/1.0' })
    expect(result.find(p => p.id === 'wool-trae')?.headers).toBeUndefined()
  })

  it('写侧零变化：setProvider 落盘条目含完整 headers（凭据键原样，pi 对话链读盘不受出线脱敏影响）', async () => {
    const upsertProvider = vi.fn((_providerId: string, _merged: Record<string, unknown>) => ({}))
    const store = {
      getProviderConfig: vi.fn(() => undefined),
      applyTypeTranslation: vi.fn((t: string) => t),
      upsertProvider,
      ensureProviderInWhitelist: vi.fn(),
      getEnabledModels: vi.fn(() => []),
    } as unknown as IConfigStore
    const svc = new ConfigService('/tmp/project', store, makeAuth(), new TaijiProviderStore(extrasPath))

    await svc.setProvider('wool-qoder', {
      name: 'Wool Qoder',
      headers: mixedHeaders,
      models: [{ id: 'qoder-cli', api: 'wool-qoder', headers: mixedHeaders }],
    })

    const written = upsertProvider.mock.calls[0]?.[1] as { headers?: Record<string, string>; models?: Array<{ headers?: Record<string, string> }> }
    // 落盘 provider 级 + 模型级 headers 完整保留（含凭据键）——脱敏只发生在读侧出口
    expect(written.headers).toEqual(mixedHeaders)
    expect(written.models?.[0]?.headers).toEqual(mixedHeaders)
  })
})
});

// ======================================================================
// ← provider-header-redaction.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-header-redaction', () => {
describe('provider-header-redaction: isSensitiveHeaderKey 凭据词根判定', () => {
  it('wool 插件 refreshToken 承载键命中（ISSUES-2 ⑨ 现象键）', () => {
    expect(isSensitiveHeaderKey('x-wool-refresh-token')).toBe(true)
  })

  it('常见凭据键命中（大小写不敏感 + 分隔符变体）', () => {
    for (const key of ['Authorization', 'x-api-key', 'X_Api_Key', 'apikey', 'client_secret', 'X-Client-Secret', 'db-password', 'x-access-token', 'X-Auth-Credential', 'session-cookie']) {
      expect(isSensitiveHeaderKey(key), key).toBe(true)
    }
  })

  it('非凭据键不命中（裸 auth/key 词根排除——x-authenticated-at / x-key-id 类不误伤）', () => {
    for (const key of ['User-Agent', 'x-custom-ua', 'X-Request-Id', 'x-authenticated-at', 'x-key-id', 'accept-language', 'x-rate-limit-remaining']) {
      expect(isSensitiveHeaderKey(key), key).toBe(false)
    }
  })
})
describe('provider-header-redaction: redactSensitiveHeaders 出线脱敏', () => {
  it('凭据键剔除、非敏感键保留（同一条目混合形态）', () => {
    const out = redactSensitiveHeaders({
      'x-wool-refresh-token': 'rt-secret-value',
      'User-Agent': 'taiji-gateway/1.0',
    })
    expect(out).toEqual({ 'User-Agent': 'taiji-gateway/1.0' })
  })

  it('全键命中 → undefined（帧内不落 headers 字段）', () => {
    expect(redactSensitiveHeaders({ 'x-wool-refresh-token': 'rt' })).toBeUndefined()
    expect(redactSensitiveHeaders({})).toBeUndefined()
    expect(redactSensitiveHeaders(undefined)).toBeUndefined()
  })

  it('输入对象不被修改（出线脱敏不得污染 configStore.readModels 的原始条目）', () => {
    const original = { 'x-wool-refresh-token': 'rt', 'User-Agent': 'ua' }
    const snapshot = { ...original }
    redactSensitiveHeaders(original)
    expect(original).toEqual(snapshot)
  })
})
});

// ======================================================================
// ← src-services-__tests__-extra2.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/__tests__/quota-service.test.ts
// ======================================================================

// ── quota-providers 桩（两节共用：工厂提升为文件级，注册表随行提升到本层；各节用例动态 put/delete）──
const fakeFetchers = new Map<string, ProviderQuotaFetcher>()


vi.mock('../quota-providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quota-providers/index.js')>()
  return { ...actual, getQuotaFetcher: vi.fn((id: string) => fakeFetchers.get(id) ?? null),
  listQuotaPresets: vi.fn(() => []), }
})


// ======================================================================
// ← src/services/__tests__/tts-service.test.ts
// ======================================================================

vi.mock('../../infra/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/logger.js')>()
  return { ...actual, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, }
})

// ── fixture 工厂 ─────────────────────────────────────────────────────────

let dir_m2: string


const DEFAULT_BASE_URL = 'https://default.example.com/v1'


const SECRET_VALUE = 'sk-secret-key-abc123'


function baseCapabilities(overrides: Partial<TtsCapabilities> = {}): TtsCapabilities {
  return {
    endpointPath: '/v1/audio/speech',
    authHeader: 'bearer',
    maxInputChars: 1000,
    speedRange: [0.5, 2],
    pcmSampleRates: [24000],
    supportsInstructions: true,
    perModel: {},
    ...overrides,
  }
}


function baseFormModel(capabilities: TtsCapabilities): TtsFormModel {
  return {
    capabilities,
    baseUrlOptions: [{ url: DEFAULT_BASE_URL, label: 'default', isDefault: true }],
    models: [{ id: 'm1', label: 'M1' }],
    voices: [{ id: 'v1', label: 'V1' }],
    volumeRange: null,
    pitchRange: null,
    channels: [],
    emotions: [],
    languages: [],
    toggles: [],
    voiceModify: null,
    maxTimbreVoices: 0,
    hasPronunciationDict: false,
  }
}


interface DriverCall {  // oe-exempt:20261027:test:
  req: InternalSpeechRequest
  apiKey: string
}


/** mock driver：记录每次调用；chunks 序列按调用次序回放（耗尽后重复末段）。 */
function makeDriver(
  id: TtsProviderId,
  opts: { capabilities?: Partial<TtsCapabilities>; chunks?: TtsSynthesisChunk[] } = {},
): { driver: TtsDriver; calls: DriverCall[] } {
  const calls: DriverCall[] = []
  const capabilities = baseCapabilities(opts.capabilities)
  const driver: TtsDriver = {
    id,
    capabilities,
    formModel: baseFormModel(capabilities),
    async synthesizeChunk(req, apiKey) {
      calls.push({ req, apiKey })
      const chunks = opts.chunks
      if (!chunks || chunks.length === 0) return { pcm: Buffer.from([0, 0]), sampleRate: 24000, channels: 1 }
      return chunks[Math.min(calls.length - 1, chunks.length - 1)]
    },
  }
  return { driver, calls }
}


function makeResolver(
  outcomes: Record<string, ResolvedProviderCredential | undefined> = {},
  baseUrls: Record<string, string | undefined> = {},
): IProviderCredentialResolver {
  return {
    // 与生产语义对齐：凭据 outcomes 登记过的 id = 持凭据（D3 验收后检查依赖此判定）
    hasProviderCredential: (id) => id in outcomes,
    listCredentialBackedProviderIds: () => new Set<string>(Object.keys(outcomes)),
    resolveProviderCredential: async (id) => outcomes[id],
    resolveProviderApiKeyRaw: async () => undefined,
    resolveProviderBaseUrl: (id) => baseUrls[id],
  }
}


interface ServiceDeps {  // oe-exempt:20261027:test:
  stepfun: { driver: TtsDriver; calls: DriverCall[] }
  minimax: { driver: TtsDriver; calls: DriverCall[] }
  mimo: { driver: TtsDriver; calls: DriverCall[] }
  resolver: IProviderCredentialResolver
}


function makeServiceDeps(): ServiceDeps {
  return {
    stepfun: makeDriver('stepfun'),
    minimax: makeDriver('minimax'),
    mimo: makeDriver('mimo', { capabilities: { speedRange: null } }),
    resolver: makeResolver(),
  }
}


function makeService_m2(deps: ServiceDeps): TtsService {
  return new TtsService({
    dataDir: dir_m2,
    // driver 现建工厂：按 id 返回对应 mock driver（合成调用经 calls 观测）；表单派生视图取自
    // 同一 mock driver（capabilities 同源，与生产接线 getTtsFormModels + createTtsDriver 同构）
    createDriver: (id) => deps[id].driver,
    formModels: {
      stepfun: deps.stepfun.driver.formModel,
      minimax: deps.minimax.driver.formModel,
      mimo: deps.mimo.driver.formModel,
    },
    credentialResolver: deps.resolver,
  })
}


/** 直接落盘 tts.json（读写契约形状 = D4 store 形状）。 */
function writeTtsJson(providers: Partial<Record<TtsProviderId, TtsConfig>>, activeProvider: TtsProviderId = 'stepfun'): void {
  writeFileSync(join(dir_m2, 'tts.json'), JSON.stringify({ activeProvider, providers }, null, 2))
}


function writeSecret(providerId: TtsProviderId, value: string = SECRET_VALUE): void {
  mkdirSync(join(dir_m2, 'secrets'), { recursive: true })
  writeFileSync(join(dir_m2, 'secrets', `tts-${providerId}-apikey.txt`), value)
}


function baseStepfunConfig(overrides: Partial<TtsConfig> = {}): TtsConfig {
  return {
    baseUrl: 'https://api.stepfun.example/v1',
    model: 'm1',
    voice: 'v1',
    vendor: {},
    ...overrides,
  }
}


function listWavFiles(): string[] {
  const cacheDir = getTtsCacheDir(dir_m2)
  if (!existsSync(cacheDir)) return []
  return readdirSync(cacheDir).filter((name) => name.endsWith('.wav'))
}


/** 封顶后的缓存内容断言（新文件 + 指定残留文件名全集，恰等）。 */
function expectCacheContents(newFilePath: string, ...keptNames: string[]): void {
  const remaining = listWavFiles().sort()
  expect(remaining).toHaveLength(keptNames.length + 1)
  expect(remaining).toContain(basename(newFilePath))
  for (const name of keptNames) expect(remaining).toContain(name)
}


/** 读回落盘 tts.json 的 providers 表（配置写路用例共用）。 */
function readStoredProviders(): Partial<Record<TtsProviderId, TtsConfig>> {
  return (JSON.parse(readFileSync(join(dir_m2, 'tts.json'), 'utf-8')) as { providers: Partial<Record<TtsProviderId, TtsConfig>> }).providers
}


/** minimax from-provider 带入（联动指引类用例共用载荷）。 */
function configureMinimaxFromProvider(svc: TtsService): Promise<TtsConfigureResult> {
  return svc.configure({ providerId: 'minimax', config: baseStepfunConfig(), apiKeys: { minimax: 'from-provider' } })
}


/** mimo from-provider 带入（baseUrl 联动类用例共用载荷；overrides 透传 baseStepfunConfig）。 */
async function configureMimoFromProvider(svc: TtsService, overrides: Partial<TtsConfig> = {}): Promise<TtsConfigureResult> {
  return svc.configure({ providerId: 'mimo', config: baseStepfunConfig(overrides), apiKeys: { mimo: 'from-provider' } })
}


/** 老缓存文件制造（可指定字节大小与 mtime 先后）。 */
function seedCacheFile(name: string, sizeBytes: number, mtime: Date): string {
  const cacheDir = getTtsCacheDir(dir_m2)
  mkdirSync(cacheDir, { recursive: true })
  const filePath = join(cacheDir, name)
  writeFileSync(filePath, Buffer.alloc(sizeBytes))
  utimesSync(filePath, mtime, mtime)
  return filePath
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('src-services-__tests__-extra2', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('quota-service', () => {
// ════════════════ 来源: quota-service-credential-failures.test.ts ════════════════
describe('quota-service-credential-failures', () => {
  /**
   * QuotaService 凭据失败分流测试（code-harden RT-7#4 / RT-7#7）。
   *
   * 覆盖：
   * - RT-7#4：resolver 返回 unsupported（command / unresolved-env）→ 查询失败
   *   reason='credential-unsupported'，fetchQuota **不被调用**（禁止以形态标记串作
   *   Bearer 下发外部请求）
   * - RT-7#7：resolver 读盘抛错（io）→ reason='credential-unavailable'（与 no-credential
   * 分流），warn 落日志；secret 文件读盘失败（目录占位 → EISDIR）同归
   * credential-unavailable
   * - 对照组：resolver 全 miss → no-credential（既有语义不变）
   *
   * 测试框架：vitest。策略：注入假 api-key fetcher（调用计数断言「未发请求」）+
   * 可编程 resolver 替身，与 quota-service-workspace.test.ts 同模式。
   *
   * 运行：cd packages/runtime && npx vitest run src/services/__tests__/quota-service-credential-failures.test.ts
   */
  // W3 迁移：QUOTA_FETCHERS 可变注册表退役（基线 ⊕ 远程合并视图只读）——fake fetcher
  // 注入改走模块 mock（getQuotaFetcher 按注册表返回，测试用例动态 put/delete）


  vi.mock('../../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/pi/pi-provider-store.js')>()
  return { ...actual, getProviderConfig: vi.fn(() => undefined), }
})
  vi.mock('../../infra/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/logger.js')>()
  return { ...actual, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, }
})

  /** 可编程 resolver 替身：resolveProviderCredential 的返回值由用例注入。 */
  let nextResolved: Promise<ResolvedProviderCredential | undefined> = Promise.resolve(undefined)
  const stubResolver: IProviderCredentialResolver = {
    hasProviderCredential: () => false,
    listCredentialBackedProviderIds: () => new Set<string>(),
    resolveProviderCredential: () => nextResolved,
    resolveProviderApiKeyRaw: async () => undefined,
    resolveProviderBaseUrl: () => undefined,
  }

  let dir_m2: string
  let extrasStore: TaijiProviderStore
  let fetchCalls: number

  /** 调用计数版假 fetcher（auth=['api-key']：provider 源走 resolver 链路）。 */
  const fakeApiKeyFetcher: ProviderQuotaFetcher = {
    id: 'fake-apikey-fetcher',
    auth: ['api-key'],
    async fetchQuota(): Promise<QuotaFetchOutcome> {
      fetchCalls += 1
      return { ok: true, data: { label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] } }
    },
  }

  function makeService_m2(): QuotaService {
    return new QuotaService({
      dataDir: dir_m2,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      getProviderInfo: () => ({ quota: { fetcher: 'fake-apikey-fetcher' } }),
      providerCredentialResolver: stubResolver,
    })
  }

  beforeEach(() => {
    dir_m2 = mkdtempSync(join(tmpdir(), 'quota-service-cred-fail-'))
    extrasStore = new TaijiProviderStore(join(dir_m2, 'config', 'providers.json'))
    fakeFetchers.set(fakeApiKeyFetcher.id, fakeApiKeyFetcher)
    fetchCalls = 0
    nextResolved = Promise.resolve(undefined)
  })

  afterEach(() => {
    fakeFetchers.delete(fakeApiKeyFetcher.id)
    vi.clearAllMocks()
    rmSync(dir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('RT-7#4：unsupported 凭据形态在发请求前拦截', () => {
    it('resolver 返回 { unsupported: "command" } → credential-unsupported，fetchQuota 零调用', async () => {
      nextResolved = Promise.resolve({ unsupported: 'command' })
      const svc = makeService_m2()

      const result = await svc.refresh('p1')

      expect(result.data).toBeNull()
      expect(result.reason).toBe('credential-unsupported')
      expect(fetchCalls).toBe(0)
    })

    it('resolver 返回 { unsupported: "unresolved-env" } → 同拦（不降级不发请求）', async () => {
      nextResolved = Promise.resolve({ unsupported: 'unresolved-env' })
      const svc = makeService_m2()

      const result = await svc.refresh('p1')

      expect(result.reason).toBe('credential-unsupported')
      expect(fetchCalls).toBe(0)
    })
  })

  describe('RT-7#7：io 失败与无凭据分流', () => {
    it('resolver 抛错（auth.json/models.json 读盘失败）→ credential-unavailable（非 no-credential）+ warn', async () => {
      nextResolved = Promise.reject(new Error('EBUSY: resource locked, auth.json'))
      const svc = makeService_m2()

      const result = await svc.refresh('p1')

      expect(result.data).toBeNull()
      expect(result.reason).toBe('credential-unavailable')
      expect(fetchCalls).toBe(0)
      expect(logger.warn).toHaveBeenCalledWith(
        '[quota] failed to resolve provider credential (auth.json / models.json)',
        expect.objectContaining({ providerId: 'p1' }),
      )
    })

    it('cookie secret 文件读盘失败（EISDIR）→ credential-unavailable，warn 带文件路径', async () => {
      const cookieFetcher: ProviderQuotaFetcher = {
        id: 'fake-cookie-io-fetcher',
        auth: ['cookie'],
        async fetchQuota(): Promise<QuotaFetchOutcome> {
          fetchCalls += 1
          return { ok: false, reason: 'network' }
        },
      }
      fakeFetchers.set(cookieFetcher.id, cookieFetcher)
      try {
        const svc = new QuotaService({
          dataDir: dir_m2,
          providerExtrasStore: extrasStore,
          providerExists: () => true,
          getProviderInfo: () => ({ quota: { fetcher: cookieFetcher.id } }),
          providerCredentialResolver: stubResolver,
        })
        // 目录占位 secrets/<pid>-cookie.txt：existsSync=true、readFileSync 抛 EISDIR
        mkdirSync(join(dir_m2, 'secrets', 'p1-cookie.txt'), { recursive: true })

        const result = await svc.refresh('p1')

        expect(result.reason).toBe('credential-unavailable')
        expect(fetchCalls).toBe(0)
        expect(logger.warn).toHaveBeenCalledWith(
          '[quota] failed to read secret file',
          expect.objectContaining({ filePath: join(dir_m2, 'secrets', 'p1-cookie.txt') }),
        )
      } finally {
        fakeFetchers.delete(cookieFetcher.id)
      }
    })

    it('对照组：resolver 全 miss → no-credential（既有语义保持）', async () => {
      nextResolved = Promise.resolve(undefined)
      const svc = makeService_m2()

      const result = await svc.refresh('p1')

      expect(result.data).toBeNull()
      expect(result.reason).toBe('no-credential')
      expect(fetchCalls).toBe(0)
    })
  })
});
// ════════════════ 来源: quota-service-workspace.test.ts ════════════════
describe('quota-service-workspace', () => {
  /**
   * QuotaService 用户维度参数（quotaParams）配置读写与注入测试
   * （timeout-audit-hygiene-batch D1-1~D1-4 起源；2026-10 workspace 单字段泛化为 params）。
   *
   * 覆盖：
   * - configure：params 逐键按 preset 声明的 param spec 归一化落盘（opencode-workspace /
   *   opendesign-workspace 分流；未知键 raw 透传）；非法输入 fail-fast 不落盘；
   *   null/空串 = 清除该键；键缺省 = 继承既有值（逐键三态语义）
   * - doFetch：providers.json 读出的 params 经 QuotaFetcherConfig.quotaParams 注入 fetcher；
   *   旧版 workspace 单字段读侧映射为 params.workspaceUrl（泛化前持久化数据兼容）
   * - not_configured 透传：fetcher 报 not_configured 时失败态原样透传（data=null + reason）
   *
   * 测试框架：vitest。策略：真实文件系统（临时目录）+ 注入假 fetcher（URL 注入点断言），
   * 与 provider-write-side-switch.test.ts 同模式。
   *
   * 运行：cd packages/runtime && npx vitest run src/services/__tests__/provider-config-bundle.test.ts
   */
  // W3 迁移：QUOTA_FETCHERS 可变注册表退役（基线 ⊕ 远程合并视图只读）——fake fetcher
  // 注入改走模块 mock（getQuotaFetcher 按注册表返回，测试用例动态 put/delete）


  vi.mock('../../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/pi/pi-provider-store.js')>()
  return { ...actual, getProviderConfig: vi.fn(() => undefined), }
})
  // logger 落盘隔离（不依赖真实 dataDir）
  vi.mock('../../infra/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/logger.js')>()
  return { ...actual, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, }
})

  // param spec 驱动归一化：listQuotaPresets 提供 opencode-go / opendesign 两家的 spec
  // （与 shared QUOTA_PRESETS 同形态——service 只读 .fetcher 与 .params[].key/.normalize）。
  // 原单文件经模块 mock 提供；bundle 化后文件级 mock 钉死 []（quota-auto-enable 节依赖），
  // 本节 beforeEach 覆写、afterEach 还原（同节既有覆写模式，两条节互不感知）。
  const PARAM_PRESETS: QuotaPreset[] = [
    {
      fetcher: 'opencode-go',
      label: 'OpenCode Go',
      auth: ['cookie'],
      match: {},
      params: [{ key: 'workspaceUrl', normalize: 'opencode-workspace' }],
    },
    {
      fetcher: 'opendesign',
      label: 'OpenDesign Coding Plan',
      auth: ['cookie'],
      match: {},
      params: [{ key: 'workspaceUrl', normalize: 'opendesign-workspace' }],
    },
  ]

  /**
   * 恒注入形态的 resolver 替身（M2fg：QuotaService 构造必需）。本文件 fetcher 均为
   * cookie 形态，resolver 不参与 cookie 段——miss 形态即可。
   */
  const stubResolver: IProviderCredentialResolver = {
    hasProviderCredential: () => false,
    listCredentialBackedProviderIds: () => new Set<string>(),
    resolveProviderCredential: async () => undefined,
    resolveProviderApiKeyRaw: async () => undefined,
    resolveProviderBaseUrl: () => undefined,
  }

  let dir_m2: string
  let agentDir: string
  let extrasStore: TaijiProviderStore

  /** 记录注入点的假 fetcher（auth=['cookie']，与 opencode 同形态）。 */
  let lastConfig: QuotaFetcherConfig | undefined
  let nextOutcome: QuotaFetchOutcome = { ok: false, reason: 'not_configured' }

  const fakeFetcher: ProviderQuotaFetcher = {
    id: 'fake-cookie-fetcher',
    auth: ['cookie'],
    async fetchQuota(_credential, _kind, config) {
      lastConfig = config
      return nextOutcome
    },
  }

  function readQuotaRaw(): Record<string, unknown> | undefined {
    return extrasStore.getExtrasSync('p1')?.quota as Record<string, unknown> | undefined
  }

  function makeService_m2(): QuotaService {
    return new QuotaService({
      dataDir: dir_m2,
      providerExtrasStore: extrasStore,
      providerExists: () => true,
      // fetcher 路由：getFetcherForProvider 读 ProviderInfo.quota.fetcher（非 extrasStore），
      // 测试统一注入指向假 fetcher
      getProviderInfo: () => ({ quota: { fetcher: 'fake-cookie-fetcher' } }),
      providerCredentialResolver: stubResolver,
    })
  }

  beforeEach(() => {
    dir_m2 = mkdtempSync(join(tmpdir(), 'quota-service-params-'))
    agentDir = join(dir_m2, 'agent')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    process.env.TAIJI_AGENT_DATA_DIR = dir_m2
    extrasStore = new TaijiProviderStore(join(agentDir, 'config', 'providers.json'))
    fakeFetchers.set(fakeFetcher.id, fakeFetcher)
    lastConfig = undefined
    nextOutcome = { ok: false, reason: 'not_configured' }
    // params 归一化按 preset spec 分流：本节把 listQuotaPresets 覆写为 PARAM_PRESETS
    // （原单文件的模块 mock 等价形态；afterEach 还原文件级默认 []，不外溢他节）
    vi.mocked(listQuotaPresets_mock).mockImplementation(() => PARAM_PRESETS)
  })

  afterEach(() => {
    fakeFetchers.delete(fakeFetcher.id)
    delete process.env.TAIJI_AGENT_DATA_DIR
    vi.mocked(listQuotaPresets_mock).mockImplementation(() => [])
    rmSync(dir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('QuotaService.configure · params 逐键归一化（D1-1/P1-1，2026-10 泛化）', () => {
    it('完整 URL 归一化为规范 URL 落盘（opencode spec 分流）', async () => {
      const svc = makeService_m2()
      const result = await svc.configure({
        providerId: 'p1',
        enabled: true,
        fetcher: 'opencode-go',
        params: { workspaceUrl: 'https://opencode.ai/workspace/wrk_abc/go' },
      })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_abc/go' })
    })

    it('裸 wrk_ id 归一化为规范 URL 落盘（P1-1 两形态）', async () => {
      const svc = makeService_m2()
      const result = await svc.configure({
        providerId: 'p1',
        enabled: true,
        fetcher: 'opencode-go',
        params: { workspaceUrl: 'wrk_bareid9' },
      })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_bareid9/go' })
    })

    it('非法输入 → ok:false 不落盘（fail-fast，不写半成品配置；host 白名单安全边界）', async () => {
      const svc = makeService_m2()
      const result = await svc.configure({
        providerId: 'p1',
        enabled: true,
        fetcher: 'opencode-go',
        params: { workspaceUrl: 'https://evil.example.com/workspace/wrk_abc/go' },
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('opencode.ai')
      // 清除之外的非法输入不落任何 params
      expect(readQuotaRaw()?.params).toBeUndefined()
    })

    it('null / 空串 = 清除该键（quota.params 无该键，恢复未配置态）', async () => {
      const svc = makeService_m2()
      await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opencode-go', params: { workspaceUrl: 'wrk_abc' } })
      expect(readQuotaRaw()?.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_abc/go' })

      const cleared = await svc.configure({ providerId: 'p1', enabled: true, params: { workspaceUrl: '  ' } })
      expect(cleared).toEqual({ ok: true })
      expect(readQuotaRaw()?.params).toBeUndefined()
    })

    it('未传 params（undefined）= 继承既有值不被清掉（逐键三态）', async () => {
      const svc = makeService_m2()
      await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opencode-go', params: { workspaceUrl: 'wrk_keep77' } })
      // 只改 enabled 不传 params
      await svc.configure({ providerId: 'p1', enabled: false })
      expect(readQuotaRaw()?.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_keep77/go' })
      expect(readQuotaRaw()?.enabled).toBe(false)
    })

    it('fetcher=opendesign 时裸 workspace id 按 opendesign 规则归一化（spec 分流）', async () => {
      const svc = makeService_m2()
      const result = await svc.configure({
        providerId: 'p1',
        enabled: true,
        fetcher: 'opendesign',
        params: { workspaceUrl: 'userownws01' },
      })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.params).toEqual({
        workspaceUrl: 'https://amr-api.open-design.ai/api/v1/workspaces/userownws01/billing/coding-plan-usage',
      })
    })

    it('preset 未声明的键（远程 preset 先行 / 自定义参数）按 raw 透传——不阻断保存', async () => {
      const svc = makeService_m2()
      const result = await svc.configure({
        providerId: 'p1',
        enabled: true,
        fetcher: 'opencode-go',
        params: { workspaceUrl: 'wrk_x1', orgId: 'org-123' },
      })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.params).toEqual({
        workspaceUrl: 'https://opencode.ai/workspace/wrk_x1/go',
        orgId: 'org-123',
      })
    })

    it('payload 不传 fetcher 时按既存配置的 fetcher 分流（部分更新）', async () => {
      const svc = makeService_m2()
      await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opendesign' })
      const result = await svc.configure({ providerId: 'p1', enabled: true, params: { workspaceUrl: 'secondws02' } })
      expect(result).toEqual({ ok: true })
      expect(readQuotaRaw()?.params).toEqual({
        workspaceUrl: 'https://amr-api.open-design.ai/api/v1/workspaces/secondws02/billing/coding-plan-usage',
      })
    })

    it('多键部分更新：只动传入键，其余键继承（逐键合并不是整表替换）', async () => {
      const svc = makeService_m2()
      await svc.configure({
        providerId: 'p1',
        enabled: true,
        fetcher: 'opencode-go',
        params: { workspaceUrl: 'wrk_multi1', orgId: 'org-keep' },
      })
      await svc.configure({ providerId: 'p1', enabled: true, params: { workspaceUrl: 'wrk_multi2' } })
      expect(readQuotaRaw()?.params).toEqual({
        workspaceUrl: 'https://opencode.ai/workspace/wrk_multi2/go',
        orgId: 'org-keep',
      })
    })
  })

  describe('QuotaService.configure · cookie 入站归一化（SG-10，wire 不信任）', () => {
    const cookiePath = (): string => join(dir_m2, 'secrets', 'p1-cookie.txt')

    it('合法输入归一化后落盘（空白伪影 / Cookie: 头名被剥）', async () => {
      const svc = makeService_m2()
      const result = await svc.configure({ providerId: 'p1', enabled: true, cookie: 'Cookie:  a = 1 ;  b = 2 ' })

      expect(result).toEqual({ ok: true })
      expect(readFileSync(cookiePath(), 'utf-8')).toBe('a=1; b=2')
    })

    it('非空输入归一化后为空 → fail-fast（不落盘、不误报成功）', async () => {
      const svc = makeService_m2()
      const result = await svc.configure({ providerId: 'p1', enabled: true, cookie: '\tName\tValue\tauth\txyz' })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('格式无效')
      expect(existsSync(cookiePath())).toBe(false)
    })

    it('空串 = 清除（合法态，不误判格式错误）', async () => {
      const svc = makeService_m2()
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'a=1' })

      expect(await svc.configure({ providerId: 'p1', enabled: true, cookie: '' })).toEqual({ ok: true })
      expect(existsSync(cookiePath())).toBe(false)
    })
  })

  describe('QuotaService.doFetch · params 注入与 not_configured 透传（D1-2/D1-3）', () => {
    it('providers.json 读出的 params 经 config.quotaParams 注入 fetcher', async () => {
      const svc = makeService_m2()
      // fetcher=opencode-go 走 preset spec 归一化（裸 wrk_ id → 规范 URL 落盘）
      await svc.configure({ providerId: 'p1', enabled: true, fetcher: 'opencode-go', params: { workspaceUrl: 'wrk_inject1' } })
      // 写 cookie 凭证（cookie 文件）保证 resolveCredential 命中
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123' })

      nextOutcome = { ok: true, data: { label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] } }
      const result = await svc.refresh('p1')

      expect(result.data).toEqual({ label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] })
      expect(lastConfig?.quotaParams).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_inject1/go' })
    })

    it('未配置 params → 注入 undefined，fetcher 报 not_configured 原样透传（D1-3）', async () => {
      const svc = makeService_m2()
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123', fetcher: 'fake-cookie-fetcher' })

      const result = await svc.refresh('p1')

      expect(result.data).toBeNull()
      expect(result.reason).toBe('not_configured')
      expect(lastConfig?.quotaParams).toBeUndefined()
    })

    it('旧版 workspace 单字段（泛化前持久化）读侧映射为 params.workspaceUrl 注入', async () => {
      // 直接以旧版磁盘形态写入 providers.json（quota.workspace 单字符串，无 params 键）
      writeFileSync(
        join(agentDir, 'config', 'providers.json'),
        JSON.stringify({
          version: 1,
          providers: {
            p1: {
              quota: { fetcher: 'fake-cookie-fetcher', enabled: true, workspace: 'https://opencode.ai/workspace/wrk_legacy1/go' },
            },
          },
        }),
      )
      const svc = makeService_m2()
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123' })

      nextOutcome = { ok: true, data: { label: 'L', wins: [{ pct: 1, resetSec: null }, { pct: null, resetSec: null }, { pct: null, resetSec: null }] } }
      await svc.refresh('p1')

      expect(lastConfig?.quotaParams).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_legacy1/go' })
    })

    it('fetcher 报 not_configured 不写缓存（getCached 携带 reason 供 UI 失败态）', async () => {
      const svc = makeService_m2()
      await svc.configure({ providerId: 'p1', enabled: true, cookie: 'session=abc123', fetcher: 'fake-cookie-fetcher' })
      await svc.refresh('p1')

      const cached = svc.getCached('p1')
      expect(cached.data).toBeNull()
      expect(cached.reason).toBe('not_configured')
    })
  })
});
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('tts-service', () => {
beforeEach(() => {
  dir_m2 = mkdtempSync(join(tmpdir(), 'tts-service-'))
  vi.mocked(logger.warn).mockClear()
  vi.mocked(logger.info).mockClear()
})
afterEach(() => {
  rmSync(dir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
// ── 1. 缓存键稳定性 ──────────────────────────────────────────────────────

describe('缓存键稳定性（D5）', () => {
  async function speakWith(config: TtsConfig): Promise<{ filePath: string; calls: DriverCall[] }> {
    const deps = makeServiceDeps()
    writeTtsJson({ stepfun: config })
    writeSecret('stepfun')
    const svc = makeService_m2(deps)
    const result = await svc.speak('你好世界。再见！')
    return { filePath: result.filePath, calls: deps.stepfun.calls }
  }

  it('同配置两次 speak 命中缓存：同路径且 driver 只调一次', async () => {
    const deps = makeServiceDeps()
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const svc = makeService_m2(deps)
    const first = await svc.speak('你好世界。再见！')
    expect(deps.stepfun.calls).toHaveLength(1)
    const second = await svc.speak('你好世界。再见！')
    expect(second.filePath).toBe(first.filePath)
    expect(deps.stepfun.calls).toHaveLength(1) // 缓存命中跳过厂商请求
    expect(existsSync(second.filePath)).toBe(true)
  })

  it('改 instructions / sampleRate / baseUrl / vendor（passthrough）任一项键必变', async () => {
    const base = await speakWith(baseStepfunConfig())
    const withInstructions = await speakWith(baseStepfunConfig({ instructions: '温柔' }))
    const withSampleRate = await speakWith(baseStepfunConfig({ sampleRate: 32000 }))
    const withBaseUrl = await speakWith(baseStepfunConfig({ baseUrl: 'https://other.example.com/v1' }))
    const withVendor = await speakWith(baseStepfunConfig({ vendor: { voice_label: { emotion: '温柔' } } }))

    const paths = [base.filePath, withInstructions.filePath, withSampleRate.filePath, withBaseUrl.filePath, withVendor.filePath]
    expect(new Set(paths).size).toBe(paths.length)
  })
})
// ── 2. FIFO 双条件封顶 ───────────────────────────────────────────────────

describe('缓存双条件 FIFO 封顶（§7.4 步骤 7）', () => {
  const OLD = new Date('2026-01-01T00:00:00Z')
  const OLDER = new Date('2025-01-01T00:00:00Z')

  function makeCapService(overrides: { maxFiles?: number; maxBytes?: number; cacheRemove?: (p: string) => void }): TtsService {
    const deps = makeServiceDeps()
    return new TtsService({
      dataDir: dir_m2,
      createDriver: (id) => deps[id].driver,
      formModels: {
        stepfun: deps.stepfun.driver.formModel,
        minimax: deps.minimax.driver.formModel,
        mimo: deps.mimo.driver.formModel,
      },
      credentialResolver: deps.resolver,
      cacheMaxFiles: overrides.maxFiles ?? TTS_CACHE_MAX_FILES,
      cacheMaxBytes: overrides.maxBytes ?? TTS_CACHE_MAX_BYTES,
      cacheRemove: overrides.cacheRemove,
    })
  }

  async function prepareAndSpeak(svc: TtsService): Promise<string> {
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const result = await svc.speak('你好世界。再见！')
    return result.filePath
  }

  it('字节条件：总字节超限时删最旧至满足（新文件保留）', async () => {
    seedCacheFile('old-a.wav', 600, OLDER)
    seedCacheFile('old-b.wav', 600, OLD)
    // 上限 1000：写新文件后总量 1246 > 1000 → 删最旧 old-a → 646 ≤ 1000 停
    const newFilePath = await prepareAndSpeak(makeCapService({ maxBytes: 1000 }))
    expectCacheContents(newFilePath, 'old-b.wav')
  })

  it('文件数条件：超限删最旧至满足', async () => {
    seedCacheFile('a.wav', 10, OLDER)
    seedCacheFile('b.wav', 10, OLD)
    seedCacheFile('c.wav', 10, new Date('2026-02-01T00:00:00Z'))
    // 上限 2：写新文件后 4 个 → 删最旧 a、b → 剩 c + 新文件
    const newFilePath = await prepareAndSpeak(makeCapService({ maxFiles: 2 }))
    expectCacheContents(newFilePath, 'c.wav')
  })

  it('并发幂等：目标已被删除时 force rm 不抛、封顶照常收敛', () => {
    seedCacheFile('a.wav', 10, OLDER)
    seedCacheFile('b.wav', 10, OLD)
    seedCacheFile('c.wav', 10, new Date('2026-02-01T00:00:00Z'))
    // remove 注入：真实 rmSync 连调两次——第二次命中已被「对方窗口」删除的目标，
    // force:true 语义下不抛（本实现的默认删除通道即 rmSync force，此处锁该契约）
    expect(() =>
      enforceTtsCacheFifoCap(getTtsCacheDir(dir_m2), {
        maxFiles: 1,
        maxBytes: TTS_CACHE_MAX_BYTES,
        remove: (p) => {
          rmSync(p, { force: true })
          rmSync(p, { force: true })
        },
      }),
    ).not.toThrow()
    expect(listWavFiles()).toEqual(['c.wav'])
  })

  it('单文件删除失败（EBUSY 形态）：记 warn 跳过、speak 不失败、其余照删', async () => {
    const victim = seedCacheFile('victim.wav', 10, OLDER)
    seedCacheFile('healthy.wav', 10, OLD)
    const svc = makeCapService({
      maxFiles: 2,
      cacheRemove: (p) => {
        if (p === victim) {
          const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException
          err.code = 'EBUSY'
          throw err
        }
        rmSync(p, { force: true })
      },
    })
    const newFilePath = await prepareAndSpeak(svc) // 不抛 = speak 不失败
    expect(existsSync(newFilePath)).toBe(true)
    expect(existsSync(victim)).toBe(true) // 删不掉的留待下次封顶重试
    expect(listWavFiles()).toHaveLength(2) // healthy 被删、新文件 + victim
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[tts] cache cap: failed to remove cached file, skipped',
      expect.objectContaining({ filePath: victim }),
    )
  })
})
// ── 3. 配置脱敏派生视图 ──────────────────────────────────────────────────────

describe('getConfig 脱敏派生视图（永不回 Key 本体）', () => {
  it('hasApiKey 反映 secrets 状态；派生视图串不含 Key 本体', async () => {
    const deps = makeServiceDeps()
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const svc = makeService_m2(deps)

    const withKey = await svc.getConfig()
    expect(withKey.providers.stepfun.hasApiKey).toBe(true)
    expect(withKey.providers.minimax.hasApiKey).toBe(false)
    // 全量序列化后搜不到 Key 本体（脱敏派生视图的结构性证明）
    expect(JSON.stringify(withKey)).not.toContain(SECRET_VALUE)

    // 清除 Key 后派生视图跟随
    rmSync(join(dir_m2, 'secrets', 'tts-stepfun-apikey.txt'))
    const withoutKey = await svc.getConfig()
    expect(withoutKey.providers.stepfun.hasApiKey).toBe(false)
  })
})
describe('getCapabilities 表单派生视图（三家键，本层纯转发）', () => {
  it('返回三家键的全集派生视图，数据源 = 构造注入的 formModels（本层零加工）', () => {
    const deps = makeServiceDeps()
    const svc = makeService_m2(deps)
    const forms = svc.getCapabilities()
    expect(Object.keys(forms).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
    // 派生视图与注入源同对象引用（纯转发语义，与生产接线 getTtsFormModels 同构）
    expect(forms.stepfun).toBe(deps.stepfun.driver.formModel)
    expect(forms.minimax).toBe(deps.minimax.driver.formModel)
    expect(forms.mimo).toBe(deps.mimo.driver.formModel)
  })
})
// ── 4. tts.json 原子写 + parse 失败降级 ──────────────────────────────────────

describe('tts.json 原子写与 parse 失败降级', () => {
  it('configure 原子写：落盘可解析且无 tmp 残留', async () => {
    const deps = makeServiceDeps()
    const svc = makeService_m2(deps)
    const result = await svc.configure({ providerId: 'stepfun', config: baseStepfunConfig() })
    expect(result.ok).toBe(true)
    const store = JSON.parse(readFileSync(join(dir_m2, 'tts.json'), 'utf-8')) as { activeProvider: string; providers: Record<string, unknown> }
    expect(store.activeProvider).toBe('stepfun')
    expect(store.providers.stepfun).toEqual(baseStepfunConfig())
    const residue = readdirSync(dir_m2).filter((name) => name.includes('.tmp_'))
    expect(residue).toEqual([])
  })

  it('parse 失败：getConfig 回默认骨架配置（无异常）', async () => {
    writeFileSync(join(dir_m2, 'tts.json'), '{ not json')
    const deps = makeServiceDeps()
    const svc = makeService_m2(deps)
    const config = await svc.getConfig()
    expect(config.providers.stepfun.config.baseUrl).toBe(DEFAULT_BASE_URL) // 骨架值来自表单派生视图 isDefault
    expect(config.providers.stepfun.config.vendor).toEqual({})
  })

  it('parse 失败：speak 按 tts_not_configured 处置并记 parse 日志', async () => {
    writeFileSync(join(dir_m2, 'tts.json'), '{ not json')
    writeSecret('stepfun')
    const deps = makeServiceDeps()
    const svc = makeService_m2(deps)
    await expect(svc.speak('文本')).rejects.toMatchObject({ code: 'tts_not_configured' })
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('[tts] tts.json parse failed, treating as not configured')
  })
})
// ── 5. providerKeyAvailable 判定 ─────────────────────────────────────────

describe('providerKeyAvailable 判定（D4 联动检测通道）', () => {
  it('{ key } 命中即 true（含映射表非首个 id 命中）；{ unsupported } 与 undefined 均 false', async () => {
    writeTtsJson({})
    const deps = makeServiceDeps()
    deps.resolver = makeResolver({
      // minimax 首映射 id 缺席、次映射 id（minimax-cn）命中
      'minimax-cn': { key: 'sk-mm', source: 'auth.json', kind: 'api_key' },
      // mimo 首映射 id 命中 unsupported 形态
      xiaomi: { unsupported: 'command' },
    })
    const svc = makeService_m2(deps)
    const config = await svc.getConfig()
    expect(config.providers.minimax.providerKeyAvailable).toBe(true)
    expect(config.providers.mimo.providerKeyAvailable).toBe(false) // unsupported 形态 false
    expect(config.providers.stepfun.providerKeyAvailable).toBe(false) // 不参与联动恒 false
  })

  it('全部映射 id 未命中 → false', async () => {
    writeTtsJson({})
    const svc = makeService_m2(makeServiceDeps())
    const config = await svc.getConfig()
    expect(config.providers.minimax.providerKeyAvailable).toBe(false)
    expect(config.providers.mimo.providerKeyAvailable).toBe(false)
  })
})
// ── 6. 八步编排 happy path ───────────────────────────────────────────────

describe('speak 八步编排 happy path（两段拼接，WAV 头取第一段回报）', () => {
  it('分句两段顺序合成、PCM 拼接、WAV 头采样率/声道取第一段、落盘可读', async () => {
    const deps = makeServiceDeps()
    deps.stepfun = makeDriver('stepfun', {
      capabilities: { maxInputChars: 6 },
      chunks: [
        { pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24000, channels: 1 },
        { pcm: Buffer.from([5, 6]), sampleRate: 48000, channels: 2 }, // 多段不一致：以第一段为准
      ],
    })
    writeTtsJson({ stepfun: baseStepfunConfig({ vendor: { voice_label: { emotion: '温柔' } } }) })
    writeSecret('stepfun')
    const svc = makeService_m2(deps)

    // 清洗规则集（D7）含链接保文本：清洗后「你好世界。再见！」（8 字 > maxInputChars 6 → 句边界两段）
    const result = await svc.speak('[你好世界](https://example.com/x)。再见！', 'sess-1')

    // ④ 分句：句边界两段（清洗后「你好世界。再见！」）
    expect(deps.stepfun.calls).toHaveLength(2)
    expect(deps.stepfun.calls[0].req.input).toBe('你好世界。')
    expect(deps.stepfun.calls[1].req.input).toBe('再见！')
    // ③ 组装：标准位字段取顶层 + vendor 恒等搬运 + apiKey 透传
    expect(deps.stepfun.calls[0].req).toMatchObject({
      model: 'm1',
      voice: 'v1',
      response_format: 'pcm',
      passthrough: { voice_label: { emotion: '温柔' } },
    })
    expect(deps.stepfun.calls[0].apiKey).toBe(SECRET_VALUE)
    // ⑥⑦ WAV 头：采样率/声道取第一段回报；data 长度 = 两段 PCM 之和（4+2）
    const wav = readFileSync(result.filePath)
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(40)).toBe(6)
    expect(wav.readUInt32LE(4)).toBe(36 + 6)
    // ⑧ reply 只回 filePath
    expect(Object.keys(result)).toEqual(['filePath'])
  })

  it('清洗后为空 → tts_empty_text；超上限 → tts_text_too_long', async () => {
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const svc = makeService_m2(makeServiceDeps())
    await expect(svc.speak('```js\ncode()\n```')).rejects.toMatchObject({ code: 'tts_empty_text' })
    await expect(svc.speak('a'.repeat(MAX_SPEAK_CHARS + 1))).rejects.toMatchObject({ code: 'tts_text_too_long' })
  })

  it('未配置（无 tts.json / 无 Key）→ tts_not_configured', async () => {
    const svc = makeService_m2(makeServiceDeps())
    await expect(svc.speak('文本')).rejects.toMatchObject({ code: 'tts_not_configured' })
    writeTtsJson({ stepfun: baseStepfunConfig() })
    await expect(svc.speak('文本')).rejects.toMatchObject({ code: 'tts_not_configured' })
  })

  it('driver 统一错误形态归一为同码 TtsServiceError（snippet 进消息）', async () => {
    const deps = makeServiceDeps()
    deps.stepfun.driver.synthesizeChunk = async () => {
      throw { code: 'tts_auth_failed', snippet: 'HTTP 401 invalid key' }
    }
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const svc = makeService_m2(deps)
    const err = await svc.speak('文本').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TtsServiceError)
    expect((err as TtsServiceError).code).toBe('tts_auth_failed')
    expect((err as TtsServiceError).message).toContain('HTTP 401 invalid key')
  })
})
// ── 纯函数单测：分句 / WAV 头 / canonical 序列化 ─────────────────────────

describe('splitIntoChunks / wrapWavHeader / canonicalSerialize', () => {
  it('分句：不超限整段单发；超限句边界贪心打包，超长句硬切', () => {
    expect(splitIntoChunks('你好世界。再见！', 10)).toEqual(['你好世界。再见！']) // 未超限不多切
    expect(splitIntoChunks('你好世界。再见！', 6)).toEqual(['你好世界。', '再见！'])
    // 硬切片段 'aa。'（3 字）+ 'bb'（2 字）= 5 > 4 → 不合包；末尾 'bb' 为独立段
    expect(splitIntoChunks('aaaaaaaaaa。bb', 4)).toEqual(['aaaa', 'aaaa', 'aa。', 'bb'])
    expect(splitIntoChunks('', 10)).toEqual([])
  })

  it('WAV 头：44 字节、PCM 格式、blockAlign/byteRate 与声道一致', () => {
    const wav = wrapWavHeader(Buffer.from([1, 2, 3, 4]), 32000, 2)
    expect(wav).toHaveLength(48)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.readUInt32LE(24)).toBe(32000)
    expect(wav.readUInt32LE(28)).toBe(32000 * 2 * 2)
    expect(wav.readUInt16LE(32)).toBe(4)
    expect(wav.toString('ascii', 36, 40)).toBe('data')
  })

  it('canonical 序列化：键序无关、undefined 字段剔除', () => {
    expect(canonicalSerialize({ b: 1, a: 2 })).toBe(canonicalSerialize({ a: 2, b: 1 }))
    expect(canonicalSerialize({ a: 1, b: undefined })).toBe(canonicalSerialize({ a: 1 }))
    expect(canonicalSerialize({ z: { y: 1, x: [2, 1] } })).toBe('{"z":{"x":[2,1],"y":1}}')
  })
})
// ── 7. configure 写路校验 + Key 联动 ─────────────────────────────────────

describe('configure 写路校验（整条拒绝，不落半改状态）', () => {
  it('speed 超域 / 该家不支持 speed / 词典条目缺「原文/替换」→ invalid_payload 且 tts.json 不落盘', async () => {
    const deps = makeServiceDeps()
    const svc = makeService_m2(deps)
    await expect(
      svc.configure({ providerId: 'stepfun', config: baseStepfunConfig({ speed: 9 }) }),
    ).rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(
      svc.configure({ providerId: 'mimo', config: { ...baseStepfunConfig(), speed: 1 } }),
    ).rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(
      svc.configure({
        providerId: 'minimax',
        config: { ...baseStepfunConfig(), vendor: { pronunciation_dict: { tone: ['没有斜杠'] } } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_payload' })
    expect(existsSync(join(dir_m2, 'tts.json'))).toBe(false)
  })

  it('词典合法条目通过；speed 域内通过', async () => {
    const deps = makeServiceDeps()
    const svc = makeService_m2(deps)
    const result = await svc.configure({
      providerId: 'minimax',
      config: {
        ...baseStepfunConfig({ speed: 1.5 }),
        vendor: { pronunciation_dict: { tone: ['处理/(chu3)(li3)'] } },
      },
    })
    expect(result.ok).toBe(true)
  })
})
describe('configure Key 联动（D4）', () => {
  it("apiKeys 'from-provider'：经 resolver 读明文写 secrets", async () => {
    const deps = makeServiceDeps()
    deps.resolver = makeResolver({ minimax: { key: 'sk-provider-1', source: 'auth.json', kind: 'api_key' } })
    const svc = makeService_m2(deps)
    const result = await svc.configure({
      providerId: 'minimax',
      config: baseStepfunConfig(),
      apiKeys: { minimax: 'from-provider' },
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir_m2, 'secrets', 'tts-minimax-apikey.txt'), 'utf-8')).toBe('sk-provider-1')
    expect(result.config?.providers.minimax.hasApiKey).toBe(true)
  })

  it("resolver 命中 unsupported 形态：ok:false + 手动粘贴指引，不写 secrets 不落 tts.json", async () => {
    const deps = makeServiceDeps()
    deps.resolver = makeResolver({ minimax: { unsupported: 'unresolved-env' } })
    const svc = makeService_m2(deps)
    const result = await configureMinimaxFromProvider(svc)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('手动粘贴')
    expect(existsSync(join(dir_m2, 'secrets', 'tts-minimax-apikey.txt'))).toBe(false)
    expect(existsSync(join(dir_m2, 'tts.json'))).toBe(false)
  })

  it('全源未命中：ok:false + 手动粘贴指引', async () => {
    const svc = makeService_m2(makeServiceDeps())
    const result = await configureMinimaxFromProvider(svc)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('手动粘贴')
  })

  it('MiMo baseUrl 联动：出厂默认值时经 resolveProviderBaseUrl 预填实际生效集群；手动改过不覆盖', async () => {
    const deps = makeServiceDeps()
    // 凭据在 xiaomi-token-plan-cn（生产形态）→ 带入命中该 id → 预填其集群地址
    deps.resolver = makeResolver(
      { 'xiaomi-token-plan-cn': { key: 'sk-1', source: 'auth.json', kind: 'api_key' } },
      { 'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1' },
    )
    const svc = makeService_m2(deps)
    // baseUrl == isDefault 出厂默认 → 联动写入
    await configureMimoFromProvider(svc, { baseUrl: DEFAULT_BASE_URL })
    expect(readStoredProviders().mimo?.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/v1')

    // 手动改过的值不覆盖
    await configureMimoFromProvider(svc, { baseUrl: 'https://my-own.example.com/v1' })
    expect(readStoredProviders().mimo?.baseUrl).toBe('https://my-own.example.com/v1')
  })

  it('MiMo baseUrl 联动跟随 Key 带入命中 id（D3 验收缺陷回归：独立遍历映射表时首位无凭据 id 经 catalog 短路成默认集群）', async () => {
    const deps = makeServiceDeps()
    // 真实 catalog 形态复现：xiaomi（无集群绑定语义）恒有默认集群 catalog 值，凭据实际在
    // xiaomi-token-plan-cn 下——带入与预填必须命中同一 id，选 token plan 集群
    deps.resolver = makeResolver(
      { 'xiaomi-token-plan-cn': { key: 'sk-plan', source: 'auth.json', kind: 'api_key' } },
      {
        xiaomi: 'https://api.xiaomimimo.com/v1',
        'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1',
      },
    )
    const svc = makeService_m2(deps)
    await configureMimoFromProvider(svc, { baseUrl: DEFAULT_BASE_URL })
    expect(readStoredProviders().mimo?.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/v1')
  })

  it('MiniMax 不联动 baseUrl（默认值保留）', async () => {
    const deps = makeServiceDeps()
    deps.resolver = makeResolver(
      { minimax: { key: 'sk-1', source: 'auth.json', kind: 'api_key' } },
      { minimax: 'https://api.minimax.io/anthropic' },
    )
    const svc = makeService_m2(deps)
    await svc.configure({
      providerId: 'minimax',
      config: baseStepfunConfig({ baseUrl: DEFAULT_BASE_URL }),
      apiKeys: { minimax: 'from-provider' },
    })
    const store = JSON.parse(readFileSync(join(dir_m2, 'tts.json'), 'utf-8')) as { providers: Record<string, TtsConfig> }
    expect(store.providers.minimax.baseUrl).toBe(DEFAULT_BASE_URL)
  })

  it("apiKeys null / 空串清除 secret；字符串写入", async () => {
    const deps = makeServiceDeps()
    const svc = makeService_m2(deps)
    writeSecret('stepfun')
    await svc.configure({ providerId: 'stepfun', config: baseStepfunConfig(), apiKeys: { stepfun: null } })
    expect(existsSync(join(dir_m2, 'secrets', 'tts-stepfun-apikey.txt'))).toBe(false)
    await svc.configure({ providerId: 'stepfun', config: baseStepfunConfig(), apiKeys: { stepfun: 'sk-new' } })
    expect(readFileSync(join(dir_m2, 'secrets', 'tts-stepfun-apikey.txt'), 'utf-8')).toBe('sk-new')
  })
})
// ── 8. message-handler 协议往返形状（§7.1 逐字段）────────────────────────

describe('TtsMessageHandler.handles（路由认领清单）', () => {
  it('认领 tts 四 RPC（且仅这四个类型）', () => {
    const ctx = { send: vi.fn(), sendError: vi.fn(), reply: vi.fn(), ttsService: makeService_m2(makeServiceDeps()) } as unknown as TtsHandlerContext
    const handler = new TtsMessageHandler(ctx)
    expect(handler.handles).toEqual(['tts.getConfig', 'tts.configure', 'tts.speak', 'tts.getCapabilities'])
  })
})
describe('TtsMessageHandler 协议往返（payload/reply 键名与 §7.1 表一致）', () => {
  let deps: ServiceDeps
  let reply: ReturnType<typeof vi.fn>
  let sendError: ReturnType<typeof vi.fn>
  let handler: TtsMessageHandler
  const ws = {} as WsType

  beforeEach(() => {
    deps = makeServiceDeps()
    reply = vi.fn()
    sendError = vi.fn()
    const ctx = { send: vi.fn(), sendError, reply, ttsService: makeService_m2(deps) } as unknown as TtsHandlerContext
    handler = new TtsMessageHandler(ctx)
  })

  it('tts.getConfig → reply { config }（SanitizedTtsConfig 形状）', async () => {
    const msg = { type: 'tts.getConfig', id: 'r1', payload: {} } as ClientMessage
    await handler.handleTtsMessage(msg, ws)
    expect(reply).toHaveBeenCalledTimes(1)
    const [, id, type, payload] = reply.mock.calls[0] as [WsType, string, string, Record<string, unknown>]
    expect(id).toBe('r1')
    expect(type).toBe('tts.getConfig:result')
    expect(Object.keys(payload)).toEqual(['config'])
    const config = payload.config as { activeProvider: string; providers: Record<string, unknown> }
    expect(Object.keys(config.providers).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
    expect(Object.keys(config.providers.stepfun as Record<string, unknown>).sort()).toEqual([
      'config',
      'hasApiKey',
      'providerKeyAvailable',
    ])
  })

  it('tts.configure → reply { config?, ok, error? }；成功含 config 无 error', async () => {
    const msg = {
      type: 'tts.configure',
      id: 'r2',
      payload: { providerId: 'stepfun', config: baseStepfunConfig() },
    } as ClientMessage
    await handler.handleTtsMessage(msg, ws)
    const [, , type, payload] = reply.mock.calls[0] as [WsType, string, string, Record<string, unknown>]
    expect(type).toBe('tts.configure:result')
    expect(payload.ok).toBe(true)
    expect(payload.config).toBeDefined()
    expect(payload.error).toBeUndefined()
  })

  it('tts.speak → reply { filePath }；缺 text → invalid_payload 信封', async () => {
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const msg = { type: 'tts.speak', id: 'r3', payload: { text: '你好世界。再见！' } } as ClientMessage
    await handler.handleTtsMessage(msg, ws)
    const [, , type, payload] = reply.mock.calls[0] as [WsType, string, string, Record<string, unknown>]
    expect(type).toBe('tts.speak:result')
    expect(Object.keys(payload)).toEqual(['filePath'])

    const bad = { type: 'tts.speak', id: 'r4', payload: {} } as unknown as ClientMessage
    await handler.handleTtsMessage(bad, ws)
    expect(sendError).toHaveBeenCalledWith(ws, 'invalid_payload', 'text required', 'r4')
  })

  it('tts.getCapabilities → reply { forms }（三家键）', async () => {
    const msg = { type: 'tts.getCapabilities', id: 'r5', payload: {} } as ClientMessage
    await handler.handleTtsMessage(msg, ws)
    const [, , type, payload] = reply.mock.calls[0] as [WsType, string, string, Record<string, unknown>]
    expect(type).toBe('tts.getCapabilities:result')
    expect(Object.keys(payload)).toEqual(['forms'])
    expect(Object.keys(payload.forms as Record<string, unknown>).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
  })

  it('tts.configure 非法 providerId / config → invalid_payload 信封', async () => {
    const badId = {
      type: 'tts.configure',
      id: 'r6',
      payload: { providerId: 'nope', config: baseStepfunConfig() },
    } as unknown as ClientMessage
    await handler.handleTtsMessage(badId, ws)
    expect(sendError).toHaveBeenCalledWith(ws, 'invalid_payload', expect.stringContaining('providerId'), 'r6')

    const badConfig = {
      type: 'tts.configure',
      id: 'r7',
      payload: { providerId: 'stepfun', config: 'nope' },
    } as unknown as ClientMessage
    await handler.handleTtsMessage(badConfig, ws)
    expect(sendError).toHaveBeenCalledWith(ws, 'invalid_payload', expect.stringContaining('config'), 'r7')
  })

  it('领域失败（未配置）→ TtsServiceError 携 §7.1 码上抛（由 server 顶层透传 envelope）', async () => {
    const msg = { type: 'tts.speak', id: 'r8', payload: { text: '文本' } } as ClientMessage
    await expect(handler.handleTtsMessage(msg, ws)).rejects.toMatchObject({ code: 'tts_not_configured' })
    expect(reply).not.toHaveBeenCalled()
  })
})
// ── 9. speak 请求端点跟随配置 baseUrl（构造期固化缝隙修复）────────────────

describe('speak 请求端点跟随配置 baseUrl（真 driver + fetch 桩）', () => {
  const PCM = Buffer.from([1, 2, 3, 4])

  /** fetch 桩：返回最小 2xx 音频响应（stepfun 2xx = 裸 PCM 二进制）；不触真实网络。 */
  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => PCM.buffer.slice(PCM.byteOffset, PCM.byteOffset + PCM.byteLength),
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  /** 生产同构接线：真 driver 工厂 + 真三家表单派生视图（infra/tts 唯一装配出口）。 */
  function makeRealDriverService(): TtsService {
    return new TtsService({
      dataDir: dir_m2,
      createDriver: createTtsDriver,
      formModels: getTtsFormModels(),
      credentialResolver: makeResolver(),
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tts.json 配非默认 baseUrl：厂商请求打到该地址（fetch 层断言 URL 前缀与端点）', async () => {
    const altBase = 'https://token-plan-cn.xiaomimimo.com/v1'
    const fetchMock = stubFetch()
    writeTtsJson({ stepfun: baseStepfunConfig({ baseUrl: altBase }) })
    writeSecret('stepfun')
    await makeRealDriverService().speak('文本')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url.startsWith(altBase)).toBe(true)
    expect(url).toBe(`${altBase}/audio/speech`)
  })

  it('tts.json 缺 baseUrl 字段：回退表单派生视图出厂默认（与 skeleton 行为一致）', async () => {
    const fetchMock = stubFetch()
    writeFileSync(
      join(dir_m2, 'tts.json'),
      JSON.stringify({ activeProvider: 'stepfun', providers: { stepfun: { model: 'm1', voice: 'v1', vendor: {} } } }),
    )
    writeSecret('stepfun')
    await makeRealDriverService().speak('文本')
    const defaultUrl =
      getTtsFormModels().stepfun.baseUrlOptions.find((option) => option.isDefault)?.url ?? ''
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toBe(`${defaultUrl}/audio/speech`)
  })

  it('配置为出厂默认 baseUrl：端点与默认行为一致（回归锁定）', async () => {
    const defaultUrl =
      getTtsFormModels().stepfun.baseUrlOptions.find((option) => option.isDefault)?.url ?? ''
    const fetchMock = stubFetch()
    writeTtsJson({ stepfun: baseStepfunConfig({ baseUrl: defaultUrl }) })
    writeSecret('stepfun')
    await makeRealDriverService().speak('文本')
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toBe(`${defaultUrl}/audio/speech`)
  })
})
});
});
