/**
 * zcode-provider-sync：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - zcode-provider-sync.test.ts
 *   - zcode-provider-sync-wiring.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/services/zcode-provider-sync.test.ts
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientMessage } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS } from '@zhushanwen/subagent-engine-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { ModelsConfigView, ProviderConfigView } from '../../infra/pi/pi-provider-store.js'
import type { IConfigService, IModelService, ISessionService } from '../../interfaces.js'
import type { IModelConnectionTester } from '../../services/ports/model-connection-tester.js'
import type { IProviderCredentialResolver, ResolvedProviderCredential } from '../../services/ports/provider-credential-resolver.js'
import type { MergedCatalogView } from '../../services/provider-catalog.js'
import type { SkillRegistry } from '../../services/skill-registry.js'
import { type ZcodeProviderStartupSyncDeps, createZcodeProviderMirrorSync, defaultZcodeProviderSyncPaths, runZcodeProviderStartupSync } from '../../services/zcode-provider-sync-wiring.js'
import { type MappingModelSource, type ProviderMappingInput, TRANSLATION_CHANNEL_PROVIDER_IDS, type ZcodeProviderSyncDeps, type ZcodeProviderSyncPaths, catalogViewToModelSources, collectZcodeOccupiedProviderIds, deriveZcodeEngineModels, locateZcodeBuiltinCatalogSync, mapPiProvidersToZcodeRules, syncZcodeProviders } from '../../services/zcode-provider-sync.js'
import { RuntimeServer } from '../../transport/server.js'


// ════════════════ 来源: zcode-provider-sync.test.ts ════════════════
describe('zcode-provider-sync', () => {
  /**
   * zcode provider 启动同步模块测试（engine-provider-unification u1-sync）。
   *
   * 覆盖（对齐设计 §3.3 D2/D7 + 任务书验收条款 + engine-ref-translation 2026-10-14 裁决）：
   * 1. 映射纯函数字段级断言：六条参与判定逐条 / 协议映射表 / per-model 差异整条跳过 /
   *    让位四源谓词逐源 / 字段丢弃与清单同序；
   * 2. 翻译通道（engine-ref-translation）：zai-coding-cn 不映射条目（skip=translation-channel、
   *    零 key 注入——等价由派发期翻译承载）；zai 按 1:1 通用映射直传；
   * 3. 副本瘦形态：不含任何真实文件条目、providerOrder 仅 pi 追加序；
   * 4. 落盘条件（pi 映射空 → 删旧副本）与幂等（同输入跳写）；
   * 5. 失败判定四分支（readModels 抛错 / ENOENT 零配置 / provider_config ENOENT / 其余读取异常）；
   * 6. 清单派生：真实 ∪ 副本 id 级聚合、真实优先、ENOENT 空集继续，∪ 内建目录 account:
   *    直通家族（无 apiKey 过滤、与个人 id 去重个人优先）。
   *
   * 全部 fixture 经 mkdtempSync 自建（os.tmpdir()），零接触真实 ~/.zcode / ~/.taiji / ~/.pi。
   *
   * 运行：cd packages/runtime && npx vitest run src/__tests__/services/zcode-provider-sync.test.ts
   */

  // ── fixture 基建 ─────────────────────────────────────────────────────────────

  let root: string
  let paths: ZcodeProviderSyncPaths
  let warnings: string[]

  /** 真实 provider_config.json 的个人条目 fixture 写盘形态。 */
  function writeRealProviderConfig(providerIds: string[], order: string[] = providerIds): void {
    writeFileSync(paths.realProviderConfigPath, JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: order,
        providerConfigRules: {
          providerRules: providerIds.map(id => ({
            providerId: id,
            providerName: `real-${id}`,
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey: 'real-key' },
              api: { type: 'openai-chat-completions', baseUrl: 'https://real.example/v1' },
              personalModelIds: ['real-model'],
              modelOrder: ['real-model'],
            },
          })),
        },
        modelConfigRules: { providerModelRules: [] },
      },
    }))
  }

  /** v2 config.json provider 字典 fixture（hasKey 判定形态：options.apiKey 非空才有 key）。 */
  function writeV2Config(entries: Record<string, { apiKey?: string }>): void {
    writeFileSync(paths.v2ConfigPath, JSON.stringify({
      provider: Object.fromEntries(Object.entries(entries).map(([id, e]) => [
        id,
        { kind: 'anthropic', options: e.apiKey !== undefined ? { apiKey: e.apiKey } : {} },
      ])),
    }))
  }

  /** cli config.json provider 字典 fixture（键存在即算、不看 key）。 */
  function writeCliConfig(ids: string[]): void {
    writeFileSync(paths.cliConfigPath, JSON.stringify({
      provider: Object.fromEntries(ids.map(id => [id, { options: {} }])),
    }))
  }

  interface FakeDepsInput { // oe-exempt:20261012:test:测试构造辅助形态
    providers?: Record<string, ProviderConfigView>
    enabledModels?: string[]
    credentials?: Record<string, ResolvedProviderCredential | undefined>
    baseUrls?: Record<string, string | undefined>
    catalog?: Record<string, readonly MappingModelSource[] | undefined>
    readModelsThrows?: boolean
    modelsCorrupted?: boolean
    /** auth.json 型 provider id（models.json 无条目，仅凭据源有）——resolver 两源并集枚举的第二源。 */
    credentialOnlyIds?: string[]
  }

  /** 组装编排 deps（fake configStore / fake resolver / fixture 路径族）。 */
  function makeDeps(input: FakeDepsInput = {}): ZcodeProviderSyncDeps {
    const models: ModelsConfigView = { providers: input.providers ?? {} }
    return {
      configStore: {
        readModels: () => {
          if (input.readModelsThrows) throw new Error('EACCES: permission denied')
          return models
        },
        getEnabledModels: () => input.enabledModels ?? [],
      },
      credentialResolver: {
        resolveProviderCredential: async id => input.credentials?.[id] ?? undefined,
        resolveProviderBaseUrl: id => input.baseUrls?.[id],
        // 真实两源并集语义：models.json 条目 id ∪ auth.json 凭据 id（credentialOnlyIds 模拟后者）
        listCredentialBackedProviderIds: () =>
          new Set([...Object.keys(models.providers), ...(input.credentialOnlyIds ?? [])]),
      },
      paths,
      isModelsCorrupted: () => input.modelsCorrupted ?? false,
      // 输入的 catalog 值已是 MappingModelSource[]（预转换形态）——包成 MergedCatalogView 形态供桥接
      getMergedCatalogModels: id => {
        const models = input.catalog?.[id]
        return models ? { models: models as unknown as MergedCatalogView['models'], overlayState: { state: 'never-seen' } } : undefined
      },
      warn: msg => warnings.push(msg),
    }
  }

  /** stepfun 标准输入单源（providers/credentials/baseUrls 三件套；差异键经 over 追加）。 */
  function stepfunDeps(over: Parameters<typeof makeDeps>[0] = {}) {
    return makeDeps({
      providers: { 'stepfun': stdProvider() },
      credentials: { 'stepfun': stdCredential() },
      baseUrls: { 'stepfun': 'https://api.stepfun.com/v1' },
      ...over,
    })
  }

  /** 通用映射纯函数的最小输入装配（测试逐判定断言用）。 */
  function mappingInput(overrides: Partial<ProviderMappingInput> = {}): ProviderMappingInput {
    return {
      providers: {},
      credentials: new Map(),
      providerBaseUrlOf: () => undefined,
      catalogModelsOf: () => undefined,
      enabledModels: [],
      occupiedProviderIds: new Set<string>(),
      ...overrides,
    }
  }

  /** 标准可用 provider fixture（openai 兼容、网关、两模型带 contextWindow）。 */
  function stdProvider(): ProviderConfigView {
    return {
      name: 'StepFun',
      baseUrl: 'https://api.stepfun.com/v1',
      apiKey: 'pi-key',
      api: 'openai-completions',
      models: [
        { id: 'step-2-16k', contextWindow: 16000 },
        { id: 'step-1v', enabled: false, contextWindow: 8000 },
      ],
    }
  }

  function stdCredential(): ResolvedProviderCredential {
    return { key: 'resolved-key', source: 'auth.json', kind: 'api_key' }
  }

  /** 纯函数标准输入（StepFun 全绿通过形态）。 */
  function stdMappingInput(overrides: Partial<ProviderMappingInput> = {}): ProviderMappingInput {
    return mappingInput({
      providers: { 'stepfun': stdProvider() },
      credentials: new Map([['stepfun', stdCredential()]]),
      providerBaseUrlOf: id => (id === 'stepfun' ? 'https://api.stepfun.com/v1' : undefined),
      ...overrides,
    })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zcode-provider-sync-'))
    mkdirSync(join(root, 'zcode-home'), { recursive: true })
    paths = {
      realProviderConfigPath: join(root, 'zcode-home', 'provider_config.json'),
      v2ConfigPath: join(root, 'zcode-home', 'config.json'),
      cliConfigPath: join(root, 'zcode-home', 'cli-config.json'),
      syncedCopyPath: join(root, 'data', 'engines', 'zcode', 'pi-synced-provider-config.json'),
    }
    warnings = []
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── 映射纯函数：六条判定逐条 ───────────────────────────────────────────────

  describe('mapPiProvidersToZcodeRules：D2 六条判定', () => {


    it('判定①：resolver 两源均无凭据 → 跳过并登记 no-credential', () => {
      const result = mapPiProvidersToZcodeRules(mappingInput({
        providers: { 'p1': { api: 'openai-completions', baseUrl: 'https://x', models: [{ id: 'm1' }] } },
        credentials: new Map([['p1', undefined]]),
        providerBaseUrlOf: () => 'https://x',
      }))
      expect(result.rules).toHaveLength(0)
      expect(result.skips).toEqual([expect.objectContaining({ providerId: 'p1', rule: 'no-credential' })])
    })

    it('判定①：unsupported 凭据形态（command / unresolved-env）不映射为 api-key 条目', () => {
      for (const unsupported of ['command', 'unresolved-env'] as const) {
        const result = mapPiProvidersToZcodeRules(stdMappingInput({
          credentials: new Map([['stepfun', { unsupported }]]),
        }))
        expect(result.rules).toHaveLength(0)
        expect(result.skips[0]?.rule).toBe('unsupported-credential')
      }
    })

    it('判定①：oauth 凭据（auth.json type:"oauth" 的短时 access token）不映射为 api-key 条目（MF-2）', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        credentials: new Map([['stepfun', { key: 'oauth-access-token', source: 'auth.json', kind: 'oauth' }]]),
      }))
      expect(result.rules).toHaveLength(0)
      expect(result.providerOrder).toHaveLength(0)
      expect(result.skips).toEqual([
        expect.objectContaining({ providerId: 'stepfun', rule: 'oauth-credential' }),
      ])
    })

    it('判定②：models.json enabled:false 与 enabledModels 白名单禁用均整条跳过', () => {
      const disabledExplicit = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'stepfun': { ...stdProvider(), enabled: false } },
      }))
      expect(disabledExplicit.skips[0]?.rule).toBe('provider-disabled')

      const disabledByWhitelist = mapPiProvidersToZcodeRules(stdMappingInput({
        enabledModels: ['other-prov/*'],
      }))
      expect(disabledByWhitelist.skips[0]?.rule).toBe('provider-disabled')
      expect(disabledByWhitelist.rules).toHaveLength(0)
    })

    it('判定③：baseUrl 三链全空（模型级/provider 级/catalog 级）→ 跳过 no-base-url', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'stepfun': { ...stdProvider(), baseUrl: undefined } },
        providerBaseUrlOf: () => undefined,
      }))
      expect(result.rules).toHaveLength(0)
      expect(result.skips[0]?.rule).toBe('no-base-url')
    })

    it('判定④：协议无 zcode 对应（openai-responses 等 8 种与未声明）→ 跳过 no-supported-api', () => {
      for (const api of ['openai-responses', 'mistral-conversations', 'google-generative-ai', undefined]) {
        const result = mapPiProvidersToZcodeRules(stdMappingInput({
          providers: { 'stepfun': { ...stdProvider(), api } },
        }))
        expect(result.rules, `api=${api}`).toHaveLength(0)
        expect(result.skips[0]?.rule, `api=${api}`).toBe('no-supported-api')
      }
    })

    it('判定⑤：模型级 baseUrl 覆盖与 provider 级生效值不一致 → 整条跳过 per-model-mismatch', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: {
          'stepfun': {
            ...stdProvider(),
            models: [
              { id: 'm-a' },
              { id: 'm-b', baseUrl: 'https://mirror.example/v1' },
            ],
          },
        },
      }))
      expect(result.rules).toHaveLength(0)
      expect(result.skips[0]?.rule).toBe('per-model-mismatch')
    })

    it('判定⑤：模型级 api 覆盖不一致（openai 混 anthropic）→ 整条跳过', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: {
          'stepfun': {
            ...stdProvider(),
            models: [
              { id: 'm-openai', api: 'openai-completions' },
              { id: 'm-anthropic', api: 'anthropic-messages' },
            ],
          },
        },
      }))
      expect(result.rules).toHaveLength(0)
      expect(result.skips[0]?.rule).toBe('per-model-mismatch')
    })

    it('判定⑤边界：模型级覆盖与 provider 级一致时不判差异；provider 级缺省取模型级一致值', () => {
      // 模型级 = provider 级同值 → 通过
      const consistent = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'stepfun': { ...stdProvider(), models: [{ id: 'm1', baseUrl: 'https://api.stepfun.com/v1' }] } },
      }))
      expect(consistent.rules).toHaveLength(1)
      expect(consistent.rules[0]?.config.api.baseUrl).toBe('https://api.stepfun.com/v1')

      // provider 级 api 缺省、模型级一致 anthropic → 用模型级值映射直传
      const modelLevelApi = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: {
          'stepfun': {
            ...stdProvider(),
            api: undefined,
            models: [{ id: 'm1', api: 'anthropic-messages' }],
          },
        },
      }))
      expect(modelLevelApi.rules[0]?.config.api.type).toBe('anthropic-messages')
    })

    it('判定⑥：zcode 侧同名（四源并集）→ pi 映射让位且不进 providerOrder', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        occupiedProviderIds: new Set(['stepfun']),
      }))
      expect(result.rules).toHaveLength(0)
      expect(result.providerOrder).toHaveLength(0)
      expect(result.skips[0]?.rule).toBe('yield-to-zcode')
    })

    it('边界：过滤白名单/禁用后参与模型为空 → 跳过 no-models', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'stepfun': { ...stdProvider(), models: [{ id: 'm1', enabled: false }] } },
      }))
      expect(result.rules).toHaveLength(0)
      expect(result.skips[0]?.rule).toBe('no-models')
    })

    it('翻译通道（zai-coding-cn）不进通用映射；zai（国际 API-key）按 1:1 通用映射直传', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: {
          'zai-coding-cn': stdProvider(),
          'zai': { ...stdProvider(), api: 'anthropic-messages' },
        },
        credentials: new Map([
          ['zai-coding-cn', stdCredential()],
          ['zai', stdCredential()],
        ]),
        providerBaseUrlOf: id => (id === 'zai' ? 'https://api.z.ai/v1' : undefined),
      }))
      // zai-coding-cn：翻译通道——不产条目、零 key 注入（等价由派发期翻译承载，2026-10-14 裁决）
      expect(result.rules.map(r => r.providerId)).toEqual(['zai'])
      expect(result.providerOrder).toEqual(['zai'])
      expect(result.skips).toEqual([
        { providerId: 'zai-coding-cn', rule: 'translation-channel', detail: expect.stringContaining('派发期翻译') },
      ])
    })
  })

  // ── 映射纯函数：协议映射表与字段转换 ────────────────────────────────────────

  describe('mapPiProvidersToZcodeRules：协议映射表与字段转换', () => {
    it('协议映射：openai-completions → openai-chat-completions；anthropic-messages → 同名直传', () => {
      const openai = mapPiProvidersToZcodeRules(stdMappingInput()).rules[0]
      expect(openai?.config.api.type).toBe('openai-chat-completions')

      const anthropic = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'stepfun': { ...stdProvider(), api: 'anthropic-messages' } },
      })).rules[0]
      expect(anthropic?.config.api.type).toBe('anthropic-messages')
    })

    it('字段转换：personalModelIds 与 modelOrder 同清单同序（override 序 + catalog 追加）；禁用模型滤除', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'stepfun': stdProvider() },
        catalogModelsOf: id => (id === 'stepfun'
          ? [{ id: 'cat-model' }, { id: 'step-2-16k', api: 'openai-completions' }]
          : undefined),
      }))
      const rule = result.rules[0]
      // stdProvider models = step-2-16k（通过）+ step-1v（enabled:false 滤除）；catalog 追加
      // cat-model；catalog 的 step-2-16k 同 id 被 override 覆盖不重复
      expect(rule?.config.personalModelIds).toEqual(['step-2-16k', 'cat-model'])
      expect(rule?.config.modelOrder).toEqual(['step-2-16k', 'cat-model'])
    })

    it('字段转换：contextWindow → providerModelRules；丢弃字段（reasoning/headers/cost/compat 等）不进产物', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: {
          'stepfun': {
            ...stdProvider(),
            headers: { 'x-custom': '1' },
            models: [{ id: 'm1', reasoning: true, contextWindow: 128000, compat: { force: true } }],
          },
        },
      }))
      expect(result.modelRules).toEqual([
        { providerId: 'stepfun', modelId: 'm1', config: { properties: { contextWindow: 128000 } } },
      ])
      const serialized = JSON.stringify(result.rules[0])
      for (const dropped of ['reasoning', 'headers', 'cost', 'compat', 'thinkingLevelMap', 'authMethod', 'quota', 'modelOverrides']) {
        expect(serialized.includes(`"${dropped}"`), `字段 ${dropped} 应被丢弃`).toBe(false)
      }
    })

    it('凭据映射：access = {type:"api-key", apiKey: resolver 解析明文}；providerName 缺省回 id', () => {
      const named = mapPiProvidersToZcodeRules(stdMappingInput()).rules[0]
      expect(named?.config.access).toEqual({ type: 'api-key', apiKey: 'resolved-key' })
      expect(named?.providerName).toBe('StepFun')

      const unnamed = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'stepfun': { ...stdProvider(), name: undefined } },
      })).rules[0]
      expect(unnamed?.providerName).toBe('stepfun')
    })

    it('白名单模型级 pattern：`<id>/*` 放行全部、`<id>/<mid>` 精确放行', () => {
      const wildcard = mapPiProvidersToZcodeRules(stdMappingInput({ enabledModels: ['stepfun/*'] }))
      expect(wildcard.rules[0]?.config.personalModelIds).toEqual(['step-2-16k'])

      const precise = mapPiProvidersToZcodeRules(stdMappingInput({
        enabledModels: ['stepfun/step-2-16k'],
        providers: { 'stepfun': { ...stdProvider(), models: [{ id: 'step-2-16k' }, { id: 'other' }] } },
      }))
      expect(precise.rules[0]?.config.personalModelIds).toEqual(['step-2-16k'])
    })
  })

  // ── 让位四源（谓词逐源对齐 wrapper 实装）────────────────────────────────────

  describe('collectZcodeOccupiedProviderIds：让位四源谓词', () => {
    it('源①：真实 provider_config.json providerRules 键存在即算（不看 apiKey）', () => {
      writeRealProviderConfig(['from-rules'])
      writeV2Config({})
      const ids = collectZcodeOccupiedProviderIds(paths)
      expect(ids.personalConfig.has('from-rules')).toBe(true)
      expect(ids.all.has('from-rules')).toBe(true)
    })

    it('源②：同文件 providerOrder 成员也算', () => {
      writeRealProviderConfig([], ['order-only'])
      const ids = collectZcodeOccupiedProviderIds(paths)
      expect(ids.personalConfig.has('order-only')).toBe(true)
    })

    it('源③：v2 字典带 key 才算（hasKey 谓词：options.apiKey 非空）', () => {
      writeV2Config({ 'v2-with-key': { apiKey: 'k' }, 'v2-no-key': {} })
      const ids = collectZcodeOccupiedProviderIds(paths)
      expect(ids.v2WithKey.has('v2-with-key')).toBe(true)
      expect(ids.v2WithKey.has('v2-no-key')).toBe(false)
      expect(ids.all.has('v2-no-key')).toBe(false)
    })

    it('源④：cli 字典键存在即算、不看 key；ENOENT 容错空集', () => {
      writeCliConfig(['cli-any'])
      const ids = collectZcodeOccupiedProviderIds(paths)
      expect(ids.cliAny.has('cli-any')).toBe(true)
    })

    it('provider_config ENOENT = 空集继续（D7③），不抛错', () => {
      expect(() => collectZcodeOccupiedProviderIds(paths)).not.toThrow()
      expect(collectZcodeOccupiedProviderIds(paths).all.size).toBe(0)
    })
  })

  // ── 翻译通道（engine-ref-translation，2026-10-14 用户裁决）──────────────────────

  describe('翻译通道：zai-coding-cn 不映射条目（等价由派发期翻译承载）', () => {
    it('zai-coding-cn → skip=translation-channel（不产条目、零 key 注入）', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'zai-coding-cn': stdProvider() },
        credentials: new Map([['zai-coding-cn', stdCredential()]]),
      }))
      expect(result.rules).toHaveLength(0)
      expect(result.providerOrder).toHaveLength(0)
      expect(result.skips).toEqual([{
        providerId: 'zai-coding-cn',
        rule: 'translation-channel',
        detail: expect.stringContaining('派发期翻译'),
      }])
    })

    it('zai（国际 API-key provider）1:1 原样直传（id/模型清单不变形）', () => {
      const result = mapPiProvidersToZcodeRules(stdMappingInput({
        providers: { 'zai': { ...stdProvider(), api: 'anthropic-messages' } },
        credentials: new Map([['zai', stdCredential()]]),
        providerBaseUrlOf: id => (id === 'zai' ? 'https://api.z.ai/v1' : undefined),
      }))
      expect(result.rules).toHaveLength(1)
      expect(result.rules[0]?.providerId).toBe('zai')
      expect(result.rules[0]?.config.personalModelIds).toEqual(['step-2-16k'])
      expect(result.providerOrder).toEqual(['zai'])
    })
  })

  // ── 编排：瘦副本落盘 / 幂等 / 落盘条件 / 失败四分支 ─────────────────────────

  describe('syncZcodeProviders：编排与瘦副本形态', () => {
    it('成功路径：副本 providerRules 仅含 pi 映射条目（不含真实文件条目）、providerOrder 仅 pi 追加序', async () => {
      writeRealProviderConfig(['real-provider'], ['real-provider'])
      writeV2Config({
        'v2-provider': { apiKey: 'k' },
        // builtin: 条目带 apiKey 才算四源占用（源③判定）
        'builtin:bigmodel-coding-plan': { apiKey: 'special-token-49chars' },
      })
      writeCliConfig(['cli-provider'])

      const outcome = await syncZcodeProviders(makeDeps({
        providers: {
          'stepfun': stdProvider(),
          'zai-coding-cn': stdProvider(),
        },
        credentials: { 'stepfun': stdCredential() },
        baseUrls: { 'stepfun': 'https://api.stepfun.com/v1' },
      }))

      expect(outcome.status).toBe('written')
      expect(outcome.ruleCount).toBe(1) // 仅 stepfun 通用映射（翻译通道不产条目）

      const copy = JSON.parse(readFileSync(paths.syncedCopyPath, 'utf-8')) as {
        schemaVersion: number
        config: { providerOrder: string[]; providerConfigRules: { providerRules: Array<{ providerId: string }> } }
      }
      const ruleIds = copy.config.providerConfigRules.providerRules.map(r => r.providerId)
      expect(ruleIds).toEqual(['stepfun'])
      // 瘦形态专项：真实文件条目（四源占用者）不进副本，order 仅 pi 追加序
      expect(ruleIds.includes('real-provider')).toBe(false)
      expect(ruleIds.includes('v2-provider')).toBe(false)
      expect(ruleIds.includes('cli-provider')).toBe(false)
      expect(copy.config.providerOrder).toEqual(['stepfun'])
      expect(copy.schemaVersion).toBe(1)
      // MF-1-3：副本含明文 apiKey，落盘权限必须 0600（对齐 auth.json 等凭据文件）
      expect(statSync(paths.syncedCopyPath).mode & 0o777).toBe(0o600)
    })

    it('auth.json 型 provider（models.json 无条目）→ 凭据并集进候选集，catalog 供数 1:1 同步（2026-10-16 真机事故回归守卫）', async () => {
      // xiaomi 形态：key 在 auth.json（resolver 命中）、models/baseUrl 在 catalog 快照、
      // models.json 零条目——旧枚举只读 models.json 导致它永不进候选集（透传翻译失效）。
      writeRealProviderConfig([], [])
      writeV2Config({})
      writeCliConfig([])

      const outcome = await syncZcodeProviders(makeDeps({
        providers: {},
        credentialOnlyIds: ['xiaomi-token-plan-cn'],
        credentials: { 'xiaomi-token-plan-cn': { key: 'tp-test-key', source: 'auth.json', kind: 'api_key' } },
        baseUrls: { 'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1' },
        catalog: {
          'xiaomi-token-plan-cn': [
            { id: 'mimo-v2.5', api: 'openai-completions', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
            { id: 'mimo-v2.5-pro', api: 'openai-completions', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
            { id: 'mimo-v2.6-flash', api: 'openai-completions', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
            { id: 'mimo-v2.6-pro', api: 'openai-completions', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
          ],
        },
      }))

      expect(outcome.status).toBe('written')
      const copy = JSON.parse(readFileSync(paths.syncedCopyPath, 'utf-8')) as {
        config: { providerOrder: string[]; providerConfigRules: { providerRules: Array<{ providerId: string; config: { personalModelIds: string[] } }> } }
      }
      const rules = copy.config.providerConfigRules.providerRules
      expect(rules.map(r => r.providerId)).toEqual(['xiaomi-token-plan-cn'])
      expect(rules[0]?.config.personalModelIds).toEqual(['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro'])
      expect(copy.config.providerOrder).toEqual(['xiaomi-token-plan-cn'])
    })

    it('oauth 凭据（auth.json type:"oauth"）不进映射：skip=oauth-credential、副本不落盘、清单派生不产模型（MF-2）', async () => {
      writeRealProviderConfig([], [])
      writeV2Config({})
      writeCliConfig([])

      const outcome = await syncZcodeProviders(makeDeps({
        providers: {},
        credentialOnlyIds: ['anthropic'],
        // resolver 凭据形态判别：auth.json oauth 条目 → kind='oauth'（access 是短时 token）
        credentials: { anthropic: { key: 'oauth-access-token', source: 'auth.json', kind: 'oauth' } },
        baseUrls: { anthropic: 'https://api.anthropic.com' },
        catalog: {
          anthropic: [{ id: 'claude-sonnet-4-5', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }],
        },
      }))

      // 唯一候选被 skip → 空集分支：副本不写（旧副本若在也删除），短时 access token 永不落盘
      expect(outcome.status).toBe('skipped-empty')
      expect(outcome.skips.map(s => s.rule)).toContain('oauth-credential')
      expect(existsSync(paths.syncedCopyPath)).toBe(false)
      expect(warnings.some(w => w.includes('oauth-credential'))).toBe(true)
      // settings 清单派生（读副本）同样不产该 provider 的模型
      const models = deriveZcodeEngineModels({ ...paths, builtinCatalogPath: join(root, 'absent-catalog.json') })
      expect(models.map(m => m.id)).toEqual([])
    })

    it('SUG-3：provider id 与 Object.prototype 继承名同名（toString）→ own-property 判定，仍进候选集', async () => {
      writeRealProviderConfig([], [])
      writeV2Config({})
      writeCliConfig([])

      // null-prototype 字典：字面量 `{ toString: ... }` 会被 TS 当成 Object.prototype.toString 覆写，
      // 上下文类型丢失（source/kind 被宽化成 string）。
      const protoCredentials: Record<string, ResolvedProviderCredential | undefined> = Object.create(null)
      protoCredentials['toString'] = { key: 'proto-key', source: 'auth.json', kind: 'api_key' }

      const outcome = await syncZcodeProviders(makeDeps({
        providers: {},
        credentialOnlyIds: ['toString'],
        credentials: protoCredentials,
        baseUrls: { toString: 'https://proto.example/v1' },
        catalog: { toString: [{ id: 'proto-model', api: 'openai-completions', baseUrl: 'https://proto.example/v1' }] },
      }))

      // `in` 判定会被 Object.prototype.toString 继承键误命中 → 本题在修复前为 skipped-empty
      expect(outcome.status).toBe('written')
      const copy = JSON.parse(readFileSync(paths.syncedCopyPath, 'utf-8')) as {
        config: { providerOrder: string[]; providerConfigRules: { providerRules: Array<{ providerId: string; config: { personalModelIds: string[] } }> } }
      }
      const rules = copy.config.providerConfigRules.providerRules
      expect(rules.map(r => r.providerId)).toEqual(['toString'])
      expect(rules[0]?.config.personalModelIds).toEqual(['proto-model'])
    })

    it('SUG-17：provider id 为 "__proto__" → defineProperty 建自有属性，仍进候选集', async () => {
      writeRealProviderConfig([], [])
      writeV2Config({})
      writeCliConfig([])

      // null-prototype 字典（赋值不触发 Object.prototype 的 __proto__ setter）
      const protoCredentials: Record<string, ResolvedProviderCredential | undefined> = Object.create(null)
      protoCredentials['__proto__'] = { key: 'proto-key', source: 'auth.json', kind: 'api_key' }
      const protoBaseUrls: Record<string, string | undefined> = Object.create(null)
      protoBaseUrls['__proto__'] = 'https://proto.example/v1'
      const protoCatalog: Record<string, readonly MappingModelSource[] | undefined> = Object.create(null)
      protoCatalog['__proto__'] = [{ id: 'proto-model', api: 'openai-completions', baseUrl: 'https://proto.example/v1' }]

      const outcome = await syncZcodeProviders(makeDeps({
        providers: {},
        credentialOnlyIds: ['__proto__'],
        credentials: protoCredentials,
        baseUrls: protoBaseUrls,
        catalog: protoCatalog,
      }))

      // 裸赋值 `providers['__proto__'] = {}` 只改原型 → 该 provider 从 Object.keys 消失 → 修复前为 skipped-empty
      expect(outcome.status).toBe('written')
      const copy = JSON.parse(readFileSync(paths.syncedCopyPath, 'utf-8')) as {
        config: { providerOrder: string[]; providerConfigRules: { providerRules: Array<{ providerId: string; config: { personalModelIds: string[] } }> } }
      }
      const rules = copy.config.providerConfigRules.providerRules
      expect(rules.map(r => r.providerId)).toEqual(['__proto__'])
      expect(rules[0]?.config.personalModelIds).toEqual(['proto-model'])
    })

    it('auth.json 型翻译通道（zai-coding-cn 仅凭据源命中）→ 同样 skip 不产条目（例外对枚举路径同样生效）', async () => {
      writeRealProviderConfig([], [])
      writeV2Config({})
      writeCliConfig([])

      const outcome = await syncZcodeProviders(makeDeps({
        providers: {},
        credentialOnlyIds: ['zai-coding-cn'],
        credentials: { 'zai-coding-cn': { key: 'zai-test-key', source: 'auth.json', kind: 'api_key' } },
      }))

      // 全员 skip（唯一候选是翻译通道）→ skipped-empty 分支：不落盘且删除旧副本
      expect(outcome.status).toBe('skipped-empty')
      expect(outcome.skips.map(s => s.rule)).toContain('translation-channel')
      expect(existsSync(paths.syncedCopyPath)).toBe(false)
    })

    it('幂等：同输入二次同步跳写（mtime 不变）', async () => {
      const deps = stepfunDeps()
      await syncZcodeProviders(deps)
      const firstMtime = statSync(paths.syncedCopyPath).mtimeMs
      await new Promise(resolve => setTimeout(resolve, 10))
      await syncZcodeProviders(deps)
      expect(statSync(paths.syncedCopyPath).mtimeMs).toBe(firstMtime)
    })

    it('遗留副本（本策略前落盘的 0644 同字节）→ 跳写不重写，但权限自愈到 0600', async () => {
      const deps = stepfunDeps()
      await syncZcodeProviders(deps)
      // 模拟存量 0644 副本（明文 apiKey 世界可读）——同字节不得跳写放过
      chmodSync(paths.syncedCopyPath, 0o644)
      const bytes = readFileSync(paths.syncedCopyPath, 'utf-8')

      const outcome = await syncZcodeProviders(deps)

      expect(outcome.status).toBe('written')
      expect(statSync(paths.syncedCopyPath).mode & 0o777).toBe(0o600)
      expect(readFileSync(paths.syncedCopyPath, 'utf-8')).toBe(bytes)
    })

    it('落盘条件：pi 映射条目空 → 不落盘且删除旧副本', async () => {
      // 预置旧副本（模拟上次同步产物）
      mkdirSync(join(root, 'data', 'engines', 'zcode'), { recursive: true })
      writeFileSync(paths.syncedCopyPath, '{"schemaVersion":1,"config":{}}')

      const outcome = await syncZcodeProviders(makeDeps({ providers: {} }))
      expect(outcome.status).toBe('skipped-empty')
      expect(() => statSync(paths.syncedCopyPath)).toThrow()
    })

    it('失败分支①a：readModels 真抛错（IO 异常）→ 中止并保留上次产物', async () => {
      mkdirSync(join(root, 'data', 'engines', 'zcode'), { recursive: true })
      writeFileSync(paths.syncedCopyPath, 'previous-copy')

      const outcome = await syncZcodeProviders(makeDeps({ readModelsThrows: true }))
      expect(outcome.status).toBe('aborted')
      expect(readFileSync(paths.syncedCopyPath, 'utf-8')).toBe('previous-copy')
      expect(warnings.some(w => w.includes('同步中止'))).toBe(true)
    })

    it('失败分支①b：models.json 损坏态 → 中止并保留上次产物', async () => {
      mkdirSync(join(root, 'data', 'engines', 'zcode'), { recursive: true })
      writeFileSync(paths.syncedCopyPath, 'previous-copy')

      const outcome = await syncZcodeProviders(makeDeps({ modelsCorrupted: true }))
      expect(outcome.status).toBe('aborted')
      expect(readFileSync(paths.syncedCopyPath, 'utf-8')).toBe('previous-copy')
    })

    it('失败分支②：pi 配置 ENOENT = 零配置（非失败）→ 按空集继续 → skipped-empty', async () => {
      // readModels fake 恒返回空骨架（ENOENT 容错语义由真实 JsonStore 提供，此处直接给空）
      const outcome = await syncZcodeProviders(makeDeps({ providers: {} }))
      expect(outcome.status).toBe('skipped-empty')
      expect(warnings.some(w => w.includes('同步中止'))).toBe(false)
    })

    it('失败分支③：真实 provider_config.json ENOENT = 真实条目空集（非失败）→ 照常落仅含 pi 映射的副本', async () => {
      const outcome = await syncZcodeProviders(stepfunDeps())
      expect(outcome.status).toBe('written')
      expect(outcome.ruleCount).toBe(1)
    })

    it('失败分支④：v2 config.json 损坏（JSON 解析失败）→ 中止保留上次产物', async () => {
      mkdirSync(join(root, 'data', 'engines', 'zcode'), { recursive: true })
      writeFileSync(paths.syncedCopyPath, 'previous-copy')
      writeFileSync(paths.v2ConfigPath, '{corrupt json')

      const outcome = await syncZcodeProviders(stepfunDeps())
      expect(outcome.status).toBe('aborted')
      expect(readFileSync(paths.syncedCopyPath, 'utf-8')).toBe('previous-copy')
    })

    it('失败分支④：cli config.json 损坏 → 中止（让位判定缺源 = 视图分叉风险，宁中止保留旧副本）', async () => {
      writeFileSync(paths.cliConfigPath, 'not-json')
      const outcome = await syncZcodeProviders(stepfunDeps())
      expect(outcome.status).toBe('aborted')
    })

    it('v2 config.json 缺失（absent 态）→ 不中止照常落盘，但 warn 前置提示（§2 前提表行 6 / D3：不静默）', async () => {
      // v2ConfigPath 不写盘（ENOENT = absent 态）——该形态下 wrapper fs 拦截整体不安装，
      // 同步模块必须出声提示此前置，防 N1/P-cli-eat 失败无信号可归因
      const outcome = await syncZcodeProviders(stepfunDeps())
      expect(outcome.status).toBe('written')
      expect(outcome.ruleCount).toBe(1)
      expect(warnings.some(w => w.includes('v2 config.json 缺失'))).toBe(true)
      expect(warnings.some(w => w.includes('不进 Registry'))).toBe(true)
      expect(warnings.some(w => w.includes('同步中止'))).toBe(false)
    })

    it('翻译通道条目 skip 全量 warn 出声（不映射条目，普通条目同步不受影响）', async () => {
      const outcome = await syncZcodeProviders(stepfunDeps({
        providers: { 'stepfun': stdProvider(), 'zai-coding-cn': stdProvider() },
        credentials: { 'stepfun': stdCredential() },
      }))
      expect(outcome.status).toBe('written')
      expect(outcome.ruleCount).toBe(1) // 仅 stepfun
      expect(outcome.skips.some(s => s.rule === 'translation-channel')).toBe(true)
      expect(warnings.some(w => w.includes('translation-channel'))).toBe(true)
    })

    it('skip 记录全部 warn 出声（ baseUrl 缺失示例 = 场景 S3）', async () => {
      await syncZcodeProviders(makeDeps({
        providers: { 'broken': { api: 'openai-completions', apiKey: 'k', models: [{ id: 'm1' }] } },
        credentials: { 'broken': stdCredential() },
        baseUrls: {},
      }))
      expect(warnings.some(w => w.includes('no-base-url'))).toBe(true)
    })
  })

  // ── 清单派生（D5：真实 ∪ 副本 id 级聚合）────────────────────────────────────

  describe('deriveZcodeEngineModels：settings 模型清单派生', () => {
    function writeCopy(rules: Array<Record<string, unknown>>): void {
      mkdirSync(join(root, 'data', 'engines', 'zcode'), { recursive: true })
      writeFileSync(paths.syncedCopyPath, JSON.stringify({
        schemaVersion: 1,
        config: {
          providerOrder: rules.map(r => r.providerId),
          providerConfigRules: { providerRules: rules },
          modelConfigRules: { providerModelRules: [] },
        },
      }))
    }

    it('真实 ∪ 副本聚合、真实优先（同名 id 真实条目整条胜出）', () => {
      writeRealProviderConfig(['dup', 'real-only'])
      writeCopy([
        {
          providerId: 'dup',
          providerName: 'copy-dup',
          config: {
            access: { type: 'api-key', apiKey: 'copy-key' },
            personalModelIds: ['copy-model'],
            modelOrder: ['copy-model'],
          },
        },
        {
          providerId: 'copy-only',
          providerName: 'Copy Provider',
          config: {
            access: { type: 'api-key', apiKey: 'copy-key' },
            personalModelIds: ['copy-model'],
            modelOrder: ['copy-model'],
          },
        },
      ])

      const models = deriveZcodeEngineModels({ ...paths, builtinCatalogPath: join(root, 'absent-catalog.json') })
      const ids = models.map(m => m.id)
      // dup 用真实条目（real-model），copy-only 追加
      expect(ids).toContain('dup/real-model')
      expect(ids).toContain('real-only/real-model')
      expect(ids).toContain('copy-only/copy-model')
      expect(ids).not.toContain('dup/copy-model')
      // name 形态 = `providerName · model`
      expect(models.find(m => m.id === 'copy-only/copy-model')?.name).toBe('Copy Provider · copy-model')
    })

    it('真实文件 ENOENT = 空集继续（仅副本条目）', () => {
      writeCopy([{
        providerId: 'copy-only',
        config: { access: { type: 'api-key', apiKey: 'k' }, personalModelIds: ['m1'], modelOrder: ['m1'] },
      }])
      const models = deriveZcodeEngineModels({ ...paths, builtinCatalogPath: join(root, 'absent-catalog.json') })
      expect(models.map(m => m.id)).toEqual(['copy-only/m1'])
    })

    it('无 apiKey 条目过滤（与 zcode 校验链 listZcodeModels 同判据）；personalModelIds 空回落 modelOrder', () => {
      writeRealProviderConfig(['with-key'])
      writeCopy([{
        providerId: 'no-key',
        providerName: 'NoKey',
        config: { access: { type: 'api-key', apiKey: '' }, personalModelIds: [], modelOrder: ['from-order'] },
      }])
      const models = deriveZcodeEngineModels({ ...paths, builtinCatalogPath: join(root, 'absent-catalog.json') })
      expect(models.map(m => m.id)).toEqual(['with-key/real-model'])
    })

    it('providerName 缺失时条目无 name 字段', () => {
      writeCopy([{
        providerId: 'anon',
        config: { access: { type: 'api-key', apiKey: 'k' }, personalModelIds: ['m1'] },
      }])
      const models = deriveZcodeEngineModels({ ...paths, builtinCatalogPath: join(root, 'absent-catalog.json') })
      expect(models[0]).toEqual({ id: 'anon/m1' })
    })

    it('account 直通家族追加（engine-ref-translation D3）：无 apiKey 过滤、builtinModelIds 优先、模型级去重与个人 id 共存（S-1）', () => {
      writeRealProviderConfig(['with-key', 'account:bigmodel-individual-coding-plan'])
      writeCopy([{
        providerId: 'copy-only',
        config: { access: { type: 'api-key', apiKey: 'k' }, personalModelIds: ['m1'], modelOrder: ['m1'] },
      }])
      const catalogPath = join(root, 'derive-account-catalog.json')
      writeFileSync(catalogPath, JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: 'account:bigmodel-individual-coding-plan', providerName: 'BigModel Individual Coding Plan', config: { builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } },
              { providerId: 'account:zai-individual-coding-plan', providerName: 'Z.AI Individual Coding Plan', config: { personalModelIds: ['Z-Model'] } },
            ],
          },
        },
      }))
      const models = deriveZcodeEngineModels({ ...paths, builtinCatalogPath: catalogPath })
      const ids = models.map(m => m.id)
      expect(ids).toContain('with-key/real-model')
      expect(ids).toContain('copy-only/m1')
      expect(ids).toContain('account:zai-individual-coding-plan/Z-Model')
      // 模型级去重（S-1 统一判据，对齐引擎侧 preparer listZcodeModels 的 seen 语义）：
      // 个人条目模型在列；内建模型与个人模型 id 不交叉 → 共存（不再按 providerId 整条让位）
      expect(ids).toContain('account:bigmodel-individual-coding-plan/real-model')
      expect(ids).toContain('account:bigmodel-individual-coding-plan/GLM-5.3')
      expect(ids).toContain('account:bigmodel-individual-coding-plan/GLM-5.3-Flash')
      expect(models.find(m => m.id === 'account:zai-individual-coding-plan/Z-Model')?.name).toBe('Z.AI Individual Coding Plan · Z-Model')
    })

    it('account 家族模型级交叉去重（S-1）：个人模型 id 与内建模型同名时恰出现一次（个人段先入）', () => {
      // 个人 account 条目模型含 GLM-5.3（与内建同名）——模型级去重 = 内建同名模型让位，
      // 内建独有模型（GLM-5.3-Flash）照常在列
      writeFileSync(paths.realProviderConfigPath, JSON.stringify({
        schemaVersion: 1,
        config: {
          providerOrder: ['account:bigmodel-individual-coding-plan'],
          providerConfigRules: {
            providerRules: [{
              providerId: 'account:bigmodel-individual-coding-plan',
              providerName: 'Personal Account',
              config: {
                access: { type: 'api-key', apiKey: 'k' },
                personalModelIds: ['real-model', 'GLM-5.3'],
                modelOrder: ['real-model', 'GLM-5.3'],
              },
            }],
          },
          modelConfigRules: { providerModelRules: [] },
        },
      }))
      const catalogPath = join(root, 'derive-account-cross-catalog.json')
      writeFileSync(catalogPath, JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: 'account:bigmodel-individual-coding-plan', config: { builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } },
            ],
          },
        },
      }))
      const models = deriveZcodeEngineModels({ ...paths, builtinCatalogPath: catalogPath })
      const ids = models.map(m => m.id)
      expect(ids.filter(id => id === 'account:bigmodel-individual-coding-plan/GLM-5.3')).toHaveLength(1)
      expect(ids).toContain('account:bigmodel-individual-coding-plan/GLM-5.3-Flash')
      expect(ids).toContain('account:bigmodel-individual-coding-plan/real-model')
    })

    it('account 家族清单判据（S-1 统一）：builtinModelIds 数组在位（含空）即用，缺键才回落 personalModelIds', () => {
      // 空 builtin 数组在位 = 该家族本期无模型（不回落 personal——与引擎侧
      // pushAccountFamilyRuleModels 的 Array.isArray 在位判定同语义）；缺 builtin 键才用 personal
      writeCopy([])
      const catalogPath = join(root, 'derive-account-empty-builtin-catalog.json')
      writeFileSync(catalogPath, JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: 'account:empty-builtin', config: { builtinModelIds: [], personalModelIds: ['P-Should-Not-Appear'] } },
              { providerId: 'account:no-builtin-key', config: { personalModelIds: ['P-Model'] } },
            ],
          },
        },
      }))
      const models = deriveZcodeEngineModels({ ...paths, builtinCatalogPath: catalogPath })
      const ids = models.map(m => m.id)
      expect(ids).not.toContain('account:empty-builtin/P-Should-Not-Appear')
      expect(ids.filter(id => id.startsWith('account:empty-builtin/'))).toEqual([])
      expect(ids).toContain('account:no-builtin-key/P-Model')
    })
  })

  // ── 附属纯函数 ──────────────────────────────────────────────────────────────

  describe('附属函数', () => {
    it('catalogViewToModelSources：合并视图模型 → 映射源视图（api/baseUrl/contextWindow 透传）', () => {
      const sources = catalogViewToModelSources({
        models: [{ id: 'm1', name: 'M1', api: 'openai-completions', baseUrl: 'https://x', reasoning: true, input: ['text'], contextWindow: 64000 }] as never,
        overlayState: 'never-seen' as never,
      })
      expect(sources).toEqual([{ id: 'm1', api: 'openai-completions', baseUrl: 'https://x', contextWindow: 64000 }])
    })

    it('locateZcodeBuiltinCatalogSync：显式路径优先注入', () => {
      expect(locateZcodeBuiltinCatalogSync(join(root, 'explicit.json'))).toBe(join(root, 'explicit.json'))
    })
  })

  // ── 三处同源锁步（ADR-0142 机器防线：代码表 + manifest 声明 + 同步 skip 集合）──

  /**
   * zcode 引擎包 manifest 路径（SUG-10：包目录名集中为命名常量——runtime 禁 import 引擎包，
   * 只能按数据文件路径对账；zcode-subagent-cli 若改名/移动，必须同步本常量）。
   */
  const ZCODE_ENGINE_PACKAGE_JSON_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../zcode-subagent-cli/package.json',
  )

  describe('translation-channel 三处同源锁步（ADR-0142）', () => {
    it('TRANSLATION_CHANNEL_PROVIDER_IDS ↔ zcode 包 manifest modelTranslation 声明键集合一致（runtime 禁 import 引擎包——按数据文件路径对账；代码表↔manifest 腿由 preparer.test.ts 锁步用例承载）', () => {
      const pkg = JSON.parse(readFileSync(ZCODE_ENGINE_PACKAGE_JSON_PATH, 'utf8')) as {
        taiji?: { subagentEngine?: { modelTranslation?: Record<string, string> } }
      }
      const declared = pkg.taiji?.subagentEngine?.modelTranslation
      if (!declared) throw new Error('zcode 包 manifest 缺 modelTranslation 声明（ADR-0142 部署形态翻译面）')
      expect(Object.keys(declared).sort()).toEqual([...TRANSLATION_CHANNEL_PROVIDER_IDS].sort())
    })
  })
});

// ════════════════ 来源: zcode-provider-sync-wiring.test.ts ════════════════
describe('zcode-provider-sync-wiring', () => {
  /**
   * zcode provider 启动同步接线测试（engine-provider-unification u2-wiring）。
   *
   * 覆盖（对齐任务书：同步抛错不中断启动 + 接线契约）：
   * 1. 缺省路径拼装：真实三路径 homedir 段形态 + 副本路径段形态（副本段常量单源 =
   *    SDK zcode-db-paths.ts ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS——测试锁 SDK 段
   *    常量字面值 + 断言生产确实由该常量拼装，SDK 常量被误改或 runtime 漂移回自拼
   *    字面量均在此红）；
   * 2. D7 降级：底层依赖抛错 → 不向调用方上抛（启动不中断）+ warn 留痕含恢复语义；
   * 3. 摘要日志三态：written（条目数 + 落盘路径）/ skipped-empty（删旧副本回落真实文件）。
   * 4. transport 装配契约（ADR-0142 write-through）：RuntimeServer.setServices 可选服务
   *    zcodeProviderMirrorSync 的注入分支（assignServices 解构 + providerHandler ctx 三元）
   *    ——注入后 mutation 类 config.* 消息处理成功恰触发一次；缺省 undefined 不调用不炸。
   *    handler 侧 mirrorAfterMutation 触发链细则见 src/transport/provider-message-handler-mirror.test.ts。
   *
   * fixture 经 mkdtempSync 自建（os.tmpdir()），零接触真实 ~/.zcode / ~/.taiji / ~/.pi。
   *
   * 运行：cd packages/runtime && npx vitest run src/__tests__/services/zcode-provider-sync-wiring.test.ts
   */

  // ── fixture 基建 ─────────────────────────────────────────────────────────────

  let root: string
  let paths: ZcodeProviderSyncPaths
  let warns: string[]
  let infos: string[]

  /** 标准可用 provider fixture（openai 兼容网关，u1 同款形态）。 */
  function stdProvider(): ProviderConfigView {
    return {
      name: 'StepFun',
      baseUrl: 'https://api.stepfun.com/v1',
      apiKey: 'pi-key',
      api: 'openai-completions',
      models: [{ id: 'step-2-16k', contextWindow: 16000 }],
    }
  }

  interface WiringDepsInput { // oe-exempt:20261012:test:测试构造辅助形态
    providers?: Record<string, ProviderConfigView>
    credentials?: Record<string, ResolvedProviderCredential | undefined>
    credentialThrows?: boolean
  }

  /** 组装 wiring deps（fake 组合根三项 + fixture 路径族 + 收集日志通道）。 */
  function makeDeps(input: WiringDepsInput = {}): ZcodeProviderStartupSyncDeps {
    const models: ModelsConfigView = { providers: input.providers ?? {} }
    return {
      configStore: {
        readModels: () => models,
        getEnabledModels: () => [],
      },
      credentialResolver: {
        resolveProviderCredential: async id => {
          if (input.credentialThrows) throw new Error('resolver exploded (fixture)')
          return input.credentials?.[id] ?? undefined
        },
        resolveProviderBaseUrl: id => input.providers?.[id]?.baseUrl,
        listCredentialBackedProviderIds: () => new Set(Object.keys(input.providers ?? {})),
      },
      paths,
      isModelsCorrupted: () => false,
      getMergedCatalogModels: () => undefined,
      log: {
        warn: msg => warns.push(msg),
        info: msg => infos.push(msg),
      },
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zcode-provider-sync-wiring-'))
    paths = {
      realProviderConfigPath: join(root, 'real', 'provider_config.json'),
      v2ConfigPath: join(root, 'real', 'v2-config.json'),
      cliConfigPath: join(root, 'real', 'cli-config.json'),
      syncedCopyPath: join(root, 'copy', 'pi-synced-provider-config.json'),
    }
    warns = []
    infos = []
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── 缺省路径拼装 ─────────────────────────────────────────────────────────────

  describe('defaultZcodeProviderSyncPaths', () => {
    it('真实三路径 homedir 段形态 + 副本路径 getDataDir 段形态（SDK 段常量单源对账）', () => {
      // SDK 段常量字面值锁（真实对账点）：runtime 生产代码与 zcode-subagent-cli 引擎
      // 读侧同源 import 该常量——字面值被误改在此红，两侧消费同步断裂可感知
      expect([...ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS]).toEqual([
        'engines',
        'zcode',
        'pi-synced-provider-config.json',
      ])
      const p = defaultZcodeProviderSyncPaths()
      const zcodeRoot = join(homedir(), '.zcode')
      expect(p.realProviderConfigPath).toBe(join(zcodeRoot, 'v2', 'provider_config.json'))
      expect(p.v2ConfigPath).toBe(join(zcodeRoot, 'v2', 'config.json'))
      expect(p.cliConfigPath).toBe(join(zcodeRoot, 'cli', 'config.json'))
      // 生产必须由 SDK 常量拼装（常量字面值已被上行锁死）——漂移回自拼字面量在此红
      expect(p.syncedCopyPath).toBe(join(getDataDir(), ...ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS))
    })
  })

  // ── D7 降级：同步抛错不中断启动 ──────────────────────────────────────────────

  describe('runZcodeProviderStartupSync 降级语义', () => {
    it('底层 resolver 抛错：不 reject（启动不中断）+ warn 留痕含恢复语义 + failed 结果', async () => {
      const result = await runZcodeProviderStartupSync(makeDeps({
        providers: { stepfun: stdProvider() },
        credentialThrows: true,
      }))
      expect(result.kind).toBe('failed')
      expect(warns.some(w => w.includes('不阻断 runtime 启动') && w.includes('resolver exploded (fixture)'))).toBe(true)
    })

    it('u1 内部中止（readModels 抛错）同样不上抛：completed + aborted 透传，不重复摘要', async () => {
      const deps = { ...makeDeps(), configStore: { readModels: () => { throw new Error('EACCES') }, getEnabledModels: () => [] } }
      const result = await runZcodeProviderStartupSync(deps)
      expect(result.kind).toBe('completed')
      expect(result.kind === 'completed' && result.outcome.status).toBe('aborted')
      expect(warns.some(w => w.includes('同步中止'))).toBe(true)
      expect(infos).toHaveLength(0)
    })
  })

  // ── 摘要日志与落盘 ───────────────────────────────────────────────────────────

  describe('runZcodeProviderStartupSync 摘要日志', () => {
    it('written：info 摘要含条目数与副本路径，副本真实落盘且条目正确', async () => {
      const result = await runZcodeProviderStartupSync(makeDeps({
        providers: { stepfun: stdProvider() },
        credentials: { stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' } },
      }))
      expect(result.kind).toBe('completed')
      expect(result.kind === 'completed' && result.outcome.status).toBe('written')
      const summary = infos.find(w => w.includes('副本落盘'))
      expect(summary).toBeDefined()
      expect(summary).toContain('provider 条目 1')
      expect(summary).toContain(paths.syncedCopyPath)
      const copy = JSON.parse(readFileSync(paths.syncedCopyPath, 'utf-8')) as {
        config: { providerConfigRules: { providerRules: { providerId: string }[] }; providerOrder: string[] }
      }
      expect(copy.config.providerConfigRules.providerRules.map(r => r.providerId)).toEqual(['stepfun'])
      expect(copy.config.providerOrder).toEqual(['stepfun'])
    })

    it('skipped-empty：pi 映射空 → 旧副本被删 + info 摘要含回落语义', async () => {
      mkdirSync(join(root, 'copy'), { recursive: true })
      writeFileSync(paths.syncedCopyPath, '{}')
      const result = await runZcodeProviderStartupSync(makeDeps())
      expect(result.kind).toBe('completed')
      expect(result.kind === 'completed' && result.outcome.status).toBe('skipped-empty')
      expect(infos.some(w => w.includes('无 pi 映射条目') && w.includes('回落真实 zcode 配置'))).toBe(true)
      expect(() => readFileSync(paths.syncedCopyPath, 'utf-8')).toThrow()
    })

    it('trigger=mutation：日志措辞按来源分流（变更镜像，不冒用启动同步文案）', async () => {
      const result = await runZcodeProviderStartupSync({
        ...makeDeps({
          providers: { stepfun: stdProvider() },
          credentials: { stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' } },
        }),
        trigger: 'mutation',
      })
      expect(result.kind).toBe('completed')
      expect(infos.some(w => w.includes('变更镜像同步完成') && w.includes('副本落盘'))).toBe(true)
      expect(infos.some(w => w.includes('启动同步完成'))).toBe(false)
    })

    it('trigger=mutation 异常：warn 使用配置写入措辞（不含「不阻断 runtime 启动」）', async () => {
      const result = await runZcodeProviderStartupSync({
        ...makeDeps({ providers: { stepfun: stdProvider() }, credentialThrows: true }),
        trigger: 'mutation',
      })
      expect(result.kind).toBe('failed')
      expect(warns.some(w => w.includes('变更镜像同步意外异常') && w.includes('不阻断配置写入应答'))).toBe(true)
      expect(warns.some(w => w.includes('不阻断 runtime 启动'))).toBe(false)
    })

    it('deps.paths 缺省 + 缺省路径拼装同步 throw → 不上抛：kind:failed + warn 留痕（S-13）', async () => {
      // 让 defaultZcodeProviderSyncPaths 内的 getDataDir 同步 fail-fast（C-proc-26：非
      // PACKAGED 进程持有 prod 树值 throw，纯词法判定不触磁盘）。修复前该 throw 在 try
      // 之外直接击穿降级契约上抛到调用方
      const prev = process.env.TAIJI_AGENT_DATA_DIR
      process.env.TAIJI_AGENT_DATA_DIR = join(homedir(), '.taiji')
      try {
        const result = await runZcodeProviderStartupSync({
          ...makeDeps({ providers: { stepfun: stdProvider() } }),
          paths: undefined,
        })
        expect(result.kind).toBe('failed')
        expect(warns.some(w => w.includes('启动同步意外异常') && w.includes('prod-admission guard'))).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
        else process.env.TAIJI_AGENT_DATA_DIR = prev
      }
    })
  })

  // ── write-through 触发面工厂 ────────────────────────────────────────────────

  describe('createZcodeProviderMirrorSync', () => {
    it('返回闭包：触发 mutation 镜像并吞掉结果（日志为变更措辞）', async () => {
      const mirror = createZcodeProviderMirrorSync(makeDeps({
        providers: { stepfun: stdProvider() },
        credentials: { stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' } },
      }))
      await expect(mirror()).resolves.toBeUndefined()
      expect(infos.some(w => w.includes('变更镜像同步完成'))).toBe(true)
    })

    it('并发触发串行化：运行中触发不并发启动，结束后按最新状态重跑一次（latest-wins）', async () => {
      let active = 0
      let maxActive = 0
      let resolverCalls = 0
      let releaseFirst!: () => void
      const firstRunGate = new Promise<void>(resolve => { releaseFirst = resolve })

      const providers: Record<string, ProviderConfigView> = { stepfun: stdProvider() }
      const credentials: Record<string, ResolvedProviderCredential | undefined> = {
        stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' },
        secondgw: { key: 'second-key', source: 'models.json', kind: 'api_key' },
      }
      const base = makeDeps({ providers, credentials })
      const mirror = createZcodeProviderMirrorSync({
        ...base,
        credentialResolver: {
          ...base.credentialResolver,
          resolveProviderCredential: async id => {
            resolverCalls += 1
            active += 1
            maxActive = Math.max(maxActive, active)
            if (resolverCalls === 1) await firstRunGate
            active -= 1
            return credentials[id]
          },
        },
      })

      const first = mirror()
      const second = mirror()
      // 首轮运行中新增 provider（变异点在第二次触发之后、重跑读取之前）
      providers.secondgw = {
        name: 'Second GW',
        baseUrl: 'https://second.example/v1',
        apiKey: 'pi-second-key',
        api: 'openai-completions',
        models: [{ id: 'second-model', contextWindow: 32000 }],
      }
      const third = mirror()

      // 首轮被 gate 挂起：后续触发不得并发启动（串行契约）
      expect(resolverCalls).toBe(1)
      expect(maxActive).toBe(1)

      releaseFirst()
      await Promise.all([first, second, third])

      expect(maxActive).toBe(1)
      // 运行中的两次触发合并为一次重跑（latest-wins + 不丢触发：两次写盘而非三次）
      expect(infos.filter(i => i.includes('变更镜像同步完成'))).toHaveLength(2)
      // 末轮读到最新配置：第二次落盘的副本含后加入的 provider（旧快照不会后写覆盖）
      const copy = JSON.parse(readFileSync(paths.syncedCopyPath, 'utf-8')) as {
        config: { providerConfigRules: { providerRules: { providerId: string }[] } }
      }
      expect(copy.config.providerConfigRules.providerRules.map(r => r.providerId)).toEqual(
        expect.arrayContaining(['stepfun', 'secondgw']),
      )
    })

    it('drain 单轮意外异常（deps.log 通道自身 throw）→ 不中断 drain、chain 不 reject、后续触发照常（S-13）', async () => {
      // 构造 runZcodeProviderStartupSync 上抛的唯一路径：resolver 正常 → sync 成功 →
      // log.info throw → 内部 catch → log.warn throw → 上抛。修复前该异常击穿 drain
      // 使 chain reject；修复后单轮 catch 吞掉（logger 留痕，不走故障源 deps.log）
      const explodingLog = {
        warn: (): void => { throw new Error('log channel exploded') },
        info: (): void => { throw new Error('log channel exploded') },
      }
      const deps = makeDeps({
        providers: { stepfun: stdProvider() },
        credentials: { stepfun: { key: 'pi-key', source: 'models.json', kind: 'api_key' } },
      })
      const mirror = createZcodeProviderMirrorSync({ ...deps, log: explodingLog })

      await expect(mirror()).resolves.toBeUndefined()

      // 内部状态未损坏：后续触发照常执行（换正常 log 通道验证 drain 可再入）
      const mirrorCalls: string[] = []
      const mirror2 = createZcodeProviderMirrorSync({
        ...deps,
        log: {
          warn: msg => mirrorCalls.push(msg),
          info: msg => mirrorCalls.push(msg),
        },
      })
      await expect(mirror2()).resolves.toBeUndefined()
      expect(mirrorCalls.some(m => m.includes('变更镜像同步完成'))).toBe(true)
    })
  })

  // ── transport 装配契约：RuntimeServer zcodeProviderMirrorSync 注入分支 ─────────

  describe('RuntimeServer zcodeProviderMirrorSync 注入（transport 装配契约）', () => {
    /** 最小 mock services（server-error-envelope.test.ts makeMockServices 同款形态 + provider mutation 所需 stub）。 */
    function makeServerServices() {
      const sessionService = {
        listPersistedSessions: vi.fn().mockReturnValue([]),
        getRpcClient: vi.fn().mockReturnValue(undefined),
        setOnSessionDestroyed: vi.fn(),
        setOnPlanAborted: vi.fn(),
        restoreSession: vi.fn(),
        create: vi.fn(),
      } as unknown as ISessionService
      const configService = {
        listProviders: vi.fn().mockReturnValue([]),
        getScopedModels: vi.fn().mockReturnValue([]),
        isModelsStoreCorrupted: vi.fn().mockReturnValue(false),
        getDefaultModel: vi.fn().mockReturnValue(null),
        setProvider: vi.fn(async () => ({ newDefault: undefined, quotaAutoEnabled: false })),
      } as unknown as IConfigService
      const modelService = {
        attachSupportedLevels: vi.fn((providers: unknown[]) => providers),
        aggregateModelsWithScoped: vi.fn().mockReturnValue([]),
      } as unknown as IModelService
      return { sessionService, configService, modelService }
    }

    function makeWs() {
      return {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket
    }

    function handleMessageOf(server: RuntimeServer) {
      return (server as unknown as {
        handleMessage(msg: ClientMessage, ws: WebSocket): Promise<void>
      }).handleMessage.bind(server)
    }

    function setProviderMsg(): ClientMessage {
      return { type: 'config.setProvider', id: 'req-1', payload: { providerId: 'stepfun', name: 'StepFun' } } as unknown as ClientMessage
    }

    it('注入后 config.setProvider 处理成功 → 镜像同步恰被调用一次 + reply 照常（真分支接线）', async () => {
      const { sessionService, configService, modelService } = makeServerServices()
      const mirrorSync = vi.fn(async () => {})
      const server = new RuntimeServer(0, '/mock-project-root', 'token')
      server.setServices(sessionService, configService, modelService, {
        skillRegistry: {} as SkillRegistry,
        providerCredentialResolver: {} as IProviderCredentialResolver,
        connectionTester: {} as IModelConnectionTester,
        zcodeProviderMirrorSync: mirrorSync,
      })
      const ws = makeWs()

      await handleMessageOf(server)(setProviderMsg(), ws)

      expect(mirrorSync).toHaveBeenCalledTimes(1)
      const sent = JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string) as { type: string; payload: { providerId: string } }
      expect(sent.type).toBe('config.providerUpdated')
      expect(sent.payload.providerId).toBe('stepfun')
    })

    it('缺省未注入（undefined，存量测试装配形态）→ mutation 照常应答、无镜像调用（假分支不炸）', async () => {
      const { sessionService, configService, modelService } = makeServerServices()
      const server = new RuntimeServer(0, '/mock-project-root', 'token')
      server.setServices(sessionService, configService, modelService, {
        skillRegistry: {} as SkillRegistry,
        providerCredentialResolver: {} as IProviderCredentialResolver,
        connectionTester: {} as IModelConnectionTester,
      })
      const ws = makeWs()

      await handleMessageOf(server)(setProviderMsg(), ws)

      const sent = JSON.parse(vi.mocked(ws.send).mock.calls[0][0] as string) as { type: string; payload: { providerId: string } }
      expect(sent.type).toBe('config.providerUpdated')
      expect(sent.payload.providerId).toBe('stepfun')
    })
  })
});
