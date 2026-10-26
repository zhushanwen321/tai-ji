/**
 * config-service-providers：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - config-service-listproviders.test.ts
 *   - config-service-model-source.test.ts
 *   - config-service-removebykind.test.ts
 *   - config-service-toggle.test.ts
 *   - provider-read-source-switch.test.ts
 *   - config-service.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/__tests__/config-service-providers.test.ts
 */

import { existsSync, mkdirSync, mkdtemp, mkdtempSync, readFileSync, rm, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { LlmRetryConfig } from '@taiji/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PiConfigStore } from '../../infra/pi/pi-config-store.js'
import { type PiModelsConfig, clearEnabledModels, ensureProviderInWhitelist, refreshModels, setEnabledModels, setModelsPath, writeModels } from '../../infra/pi/pi-provider-store.js'
import { invalidateSettingsCache, setSettingsPath } from '../../infra/pi/pi-settings-store.js'
import { AuthStorage } from '../auth/auth-storage.js'
import { ProviderCredentialResolver } from '../auth/provider-credential-resolver.js'
import { ConfigService } from '../config-service.js'
import type { ConfigModelsConfig, ConfigProviderConfig, IConfigStore } from '../ports/config.js'
import type { ILlmRetrySettings, LlmRetryConfigSnapshot } from '../ports/llm-retry-settings.js'
import { deriveEnabled } from '../provider-catalog.js'
import { type ProviderExtrasFile, TaijiProviderStore } from '../provider-extras-store.js'


// ════════════════ 来源: config-service-listproviders.test.ts ════════════════
describe('config-service-listproviders', () => {
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

  /** ConfigService 构造函数期望的 authStorage Pick（全方法，mock 只实现被调用的）。 */
  type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

  interface MakeOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
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

  describe('headers/authHeader 读侧回显——装配下发（幽灵数据修复）', () => {
    // 事故背景：装配函数漏带这两个字段，models.json 已存的 headers 成「界面看不见、
    // 保存「空=不动」语义又删不掉」的幽灵数据（空值 x-opencode-session 压制 pi 自动注入）
    it('catalog override 带 headers/authHeader → ProviderInfo 原值下发', () => {
      const svc = makeService({
        models: { openai: { headers: { 'x-flag': 'v1' }, authHeader: true } },
      })
      const openai = byId(svc)['openai']
      expect(openai.kind).toBe('catalog')
      expect(openai.headers).toEqual({ 'x-flag': 'v1' })
      expect(openai.authHeader).toBe(true)
    })

    it('custom config 带 headers/authHeader → ProviderInfo 原值下发', () => {
      const svc = makeService({
        models: { 'my-custom': { apiKey: 'sk-x', headers: { trace: 'on' }, authHeader: false, models: [] } },
      })
      const custom = byId(svc)['my-custom']
      expect(custom.kind).toBe('custom')
      expect(custom.headers).toEqual({ trace: 'on' })
      expect(custom.authHeader).toBe(false)
    })

    it('未配置 → headers/authHeader 缺省 undefined', () => {
      const svc = makeService({ models: { openai: {} } })
      const openai = byId(svc)['openai']
      expect(openai.headers).toBeUndefined()
      expect(openai.authHeader).toBeUndefined()
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
});

// ════════════════ 来源: config-service-model-source.test.ts ════════════════
describe('config-service-model-source', () => {
  /**
   * B-2 聚合层 source 标注测试（provider-config-quota-architecture design §3.6 决策 2 /
   * Phase B-2「聚合层配合」）。
   *
   * catalog provider 的混合模型列表（builtin 副本未被覆盖的 + models.json override）逐条标注
   * source：'builtin' | 'override'。custom provider 全部是用户定义，不标（undefined）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-model-source.test.ts
   *
   * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
   * 与 provider-read-source-switch.test.ts 同模式。zai-coding-cn 是真实 builtin catalog
   * provider（builtin 副本含 glm-4.5-air/glm-4.7/glm-5-turbo/glm-5.1/glm-5.2/glm-5v-turbo），
   * 同 id 替换用例用真实存在的 glm-5.2，新增 id 用例用 glm-my-alias。
   */

  let dir: string
  let agentDir: string
  let configStore: PiConfigStore

  function writeModelsJson(providers: Record<string, unknown>): void {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
  }

  function makeSvc(authIds: string[] = []): ConfigService {
    const auth = authIds.length > 0
      ? { listCredentialIds: () => authIds, hasCredentialSync: () => true } as never
      : undefined
    // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（真 PiConfigStore 读同一 models.json）
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth ?? { listCredentialIds: () => [] as string[], hasCredentialSync: () => false },
      configStore,
    })
    return new ConfigService('/tmp/project', configStore, auth, undefined, undefined, resolver)
  }

  function providerModels(svc: ConfigService, id: string): ReturnType<ConfigService['listProviders']>[number]['models'] {
    const p = svc.listProviders().find(x => x.id === id)
    expect(p).toBeDefined()
    return p!.models
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-service-model-source-'))
    agentDir = join(dir, 'agent')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    process.env.TAIJI_AGENT_DATA_DIR = dir
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()
    configStore = new PiConfigStore()
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('B-2：catalog provider 无 override → 全部标 source:"builtin"', () => {
    it('凭据在 auth.json、models.json 无条目 → builtin 副本逐条 builtin 标注', () => {
      writeModelsJson({})
      const models = providerModels(makeSvc(['zai-coding-cn']), 'zai-coding-cn')

      expect(models.length).toBeGreaterThan(0)
      for (const m of models) {
        expect(m.source).toBe('builtin')
      }
      // 真实 builtin 副本非空（防御生成物损坏导致的假通过；清单锚 pi-ai 1.0.0 快照）
      expect(models.map(m => m.id)).toContain('glm-5.3')
    })
  })

  describe('B-2：catalog provider 有 override models → 混合列表逐条标注', () => {
    it('新增 id + 同 id 替换：override 条目（含覆盖 builtin 同 id 的）标 override，其余标 builtin，同 id 不重复', () => {
      writeModelsJson({
        'zai-coding-cn': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          models: [
            // 同 id 替换 builtin 的 glm-5.3（用户覆写 contextWindow）
            { id: 'glm-5.3', name: 'GLM 5.3 (custom)', contextWindow: 111000 },
            // 新增自定义模型（builtin 无此 id）
            { id: 'glm-my-alias', name: 'My Alias', contextWindow: 200000 },
          ],
        },
      })

      const models = providerModels(makeSvc(), 'zai-coding-cn')
      const bySource = (s: 'builtin' | 'override') => models.filter(m => m.source === s).map(m => m.id)

      // override 两条均标 'override'——同 id 被 override 替换的也标 'override'（已被用户定义覆盖）
      expect(bySource('override')).toEqual(['glm-5.3', 'glm-my-alias'])
      // 其余 builtin 条目标 'builtin'（混合列表：override 存在时未被覆盖的内置条目仍在，
      // 对齐 pi 真实行为 design D1 探针——旧「override 非空即整体替换」与 pi 漂移）
      expect(bySource('builtin')).not.toContain('glm-5.3')
      expect(bySource('builtin')).toContain('glm-4.6v')
      expect(bySource('builtin')).toContain('glm-5.3-flash')
      // 同 id 不重复出现（覆盖而非并列）
      expect(models.filter(m => m.id === 'glm-5.3')).toHaveLength(1)
      // 覆盖条目取 override 定义值
      const overridden = models.find(m => m.id === 'glm-5.3')!
      expect(overridden.name).toBe('GLM 5.3 (custom)')
      expect(overridden.contextWindow).toBe(111000)
      // 混合列表顺序：builtin 在前、override 追加在后（design §3.1 场景 A 形态）
      const lastSource = models[models.length - 1].source
      expect(lastSource).toBe('override')
    })

    it('override 空数组（models: []）→ 退回纯 builtin 列表全标 builtin', () => {
      writeModelsJson({
        'zai-coding-cn': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', models: [] },
      })

      const models = providerModels(makeSvc(), 'zai-coding-cn')
      expect(models.length).toBeGreaterThan(0)
      for (const m of models) {
        expect(m.source).toBe('builtin')
      }
    })
  })

  describe('B-2：custom provider → 不标 source（全部用户定义，无歧义）', () => {
    it('custom provider 的 models 元素 source 为 undefined', () => {
      writeModelsJson({
        'my-proxy': { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }, { id: 'm2' }] },
      })

      const models = providerModels(makeSvc(), 'my-proxy')
      expect(models.map(m => m.id)).toEqual(['m1', 'm2'])
      for (const m of models) {
        expect(m.source).toBeUndefined()
      }
    })
  })
});

// ════════════════ 来源: config-service-removebykind.test.ts ════════════════
describe('config-service-removebykind', () => {
  /**
   * removeProviderByKind 测试（wave4，provider-dual-system-r2::provider-ui-by-kind IF3）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-removebykind.test.ts
   *
   * 覆盖 design TC2/TC3 + 边界3(a)：
   *   - TC2 catalog 分支：清 auth.json 凭据 + 清 models.json override（removeProvider）+ 清 enabledModels 残留。
   *     不删 pi catalog 定义（本测试只验证 taiji 侧清理动作，pi 定义不可触达故不断言）。
   *   - TC3 custom 分支：删 models.json 条目（removeProvider）+ 清残留。
   *   - 边界3(a) 残留清除空数组检查：清完残留后白名单空 → cleanEnabledModelsResidue 调 clearEnabledModels（非 setEnabledModels([])）。
   *
   * 策略：mock IConfigStore（写方法 vi.fn 断言路由）+ mock authStorage.remove 断言清凭据调用。
   * makeStore 借鉴 config-service-toggle.test.ts 的状态化 mock 模式，但本测试聚焦「调用路由」
   * 而非 read-after-write，故 store 用最小 mock（getEnabledModels 返固定白名单即可）。
   */

  type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

  interface StoreOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    /** models.json providers（默认空）。 */
    models?: ConfigModelsConfig['providers']
    /** settings.json.enabledModels（默认空 = 全启用）。 */
    enabledModels?: string[]
  }

  /**
   * 最小 mock IConfigStore：写方法 vi.fn 供断言路由，读方法返固定值。
   * removeProvider 返回 removed:true（catalog override 存在时；custom 删除时）。
   */
  function makeStore(opts: StoreOpts = {}) {
    const models: ConfigModelsConfig['providers'] = opts.models ? JSON.parse(JSON.stringify(opts.models)) : {}
    return {
      readModels: vi.fn(() => ({ providers: models })),
      getEnabledModels: vi.fn(() => [...(opts.enabledModels ?? [])]),
      getDefaultModel: vi.fn(() => null),
      getProviderConfig: vi.fn((id: string) => (id in models ? JSON.parse(JSON.stringify(models[id])) : undefined)),
      setEnabledModels: vi.fn(),
      clearEnabledModels: vi.fn(),
      setDefaultModel: vi.fn(),
      ensureProviderInWhitelist: vi.fn(),
      cleanEnabledModelsResidue: vi.fn(),
      upsertProvider: vi.fn(),
      applyTypeTranslation: vi.fn((t: string) => t),
      removeProvider: vi.fn(() => ({ removed: true })),
    } as unknown as IConfigStore & {
      setEnabledModels: ReturnType<typeof vi.fn>
      clearEnabledModels: ReturnType<typeof vi.fn>
      cleanEnabledModelsResidue: ReturnType<typeof vi.fn>
      removeProvider: ReturnType<typeof vi.fn>
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

  function makeService(opts: StoreOpts = {}): { svc: ConfigService; store: ReturnType<typeof makeStore>; auth: FullAuthPick } {
    const store = makeStore(opts)
    const auth = makeAuth()
    // M2fg 恒注入形态：凭据判定（含 M5-03 重选凭据优先）经 resolver 批量 sync 版，
    // 同源于上方 store/auth mock
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth,
      configStore: store,
    })
    const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
    return { svc, store, auth }
  }

  // ══ TC2: catalog 分支——清 auth.json 凭据 + 清 override + 清残留 ═══════════════════════

  describe('TC2: removeProviderByKind(catalog) 清 auth.json 凭据 + override + enabledModels 残留', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('调 authStorage.remove（清 catalog 凭据）', async () => {
      const { svc, auth } = makeService({ enabledModels: ['openai/*'] })
      await svc.removeProviderByKind('openai', 'catalog')
      expect(auth.remove).toHaveBeenCalledWith('openai')
    })

    it('调 configStore.removeProvider（清 models.json override 条目，若有）', async () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      await svc.removeProviderByKind('openai', 'catalog')
      expect(store.removeProvider).toHaveBeenCalledWith('openai')
    })

    it('调 configStore.cleanEnabledModelsResidue（清 enabledModels 残留 <id>/* 与 <id>/model）', async () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai/gpt-4', 'anthropic/*'] })
      await svc.removeProviderByKind('openai', 'catalog')
      expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
    })

    it('返回 removed:true（catalog 定义不可删，用户侧状态已清即视为移除成功）', async () => {
      const { svc } = makeService({ enabledModels: ['openai/*'] })
      const ret = await svc.removeProviderByKind('openai', 'catalog')
      expect(ret).toEqual({ removed: true })
    })

    it('MF1（exec-review must-fix）：catalog override 承载 default 时透传 removeProvider 的 newDefault', async () => {
      // 场景：catalog provider openai 有 override 且承载 defaultModel，removeProvider 删 override 时
      // 内部重选 default（anthropic/claude-3）+ mutate settings.json。catalog 分支须透传 newDefault，
      // 否则 handler 不广播 config.defaults → renderer 收不到重选通知（confirmDelete 防御性清空仅缓解显示）。
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        removed: true,
        newDefault: { provider: 'anthropic', modelId: 'claude-3' },
      })
      const ret = await svc.removeProviderByKind('openai', 'catalog')
      expect(ret).toEqual({ removed: true, newDefault: { provider: 'anthropic', modelId: 'claude-3' } })
    })

    it('authStorage.remove 失败（reject）不阻塞移除主流程（cleanAuthCredential try-catch warn）', async () => {
      const { svc, store, auth } = makeService({ enabledModels: ['openai/*'] })
      ;(auth.remove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'))
      // await 完成：cleanAuthCredential try-catch 吞掉凭据清理异常，删除主流程不阻断
      const ret = await svc.removeProviderByKind('openai', 'catalog')
      expect(ret).toEqual({ removed: true })
      expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
    })

    it('回归：catalog 删除 await 凭据清理完成，返回后 listProviders 即不含该 provider（修复广播 stale）', async () => {
      // 模拟真实 AuthStorage.remove 的异步性：withFileLock（proper-lockfile）获锁有延迟，
      // fire-and-forget 时凭据未即时落盘。本测试构造带延迟的 remove，验证 removeProviderByKind
      // await 其完成才返回 → 返回后 listProviders 立即反映凭据已清（广播拿到的就是干净列表）。
      const credentialIds = new Set<string>(['openai'])
      const auth = {
        listCredentialIds: vi.fn(() => [...credentialIds]),
        hasCredentialSync: vi.fn((id: string) => credentialIds.has(id)),
        remove: vi.fn(async (id: string) => {
          await new Promise(r => setTimeout(r, 5))
          credentialIds.delete(id)
        }),
        set: vi.fn().mockResolvedValue(undefined),
        hasOAuth: vi.fn(() => false),
        hasOAuthSync: vi.fn(() => false),
      } as unknown as FullAuthPick
      const store = makeStore({})
      // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（同源于本用例 auth mock——
      // remove 后 listCredentialIds 返回的集合随之变化，resolver 读同一 mock）
      const resolver = new ProviderCredentialResolver({
        authService: { getCredential: async () => undefined },
        authStorage: auth,
        configStore: store,
      })
      const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)

      // 删除前：openai 凭据在 auth.json → listProviders catalog 聚合显示
      expect(svc.listProviders().some(p => p.id === 'openai')).toBe(true)

      await svc.removeProviderByKind('openai', 'catalog')

      // 关键回归断言：await 返回时凭据已清，listProviders 不再显示 openai。
      // 若改回 fire-and-forget，此断言失败（凭据 5ms 后才删，返回后立即查仍在）。
      expect(svc.listProviders().some(p => p.id === 'openai')).toBe(false)
    })

    it('M5-03：catalog 无 override（removeProvider 返回 removed:false）且 default 承载该 provider → 显式重选并持久化', async () => {
      // 场景：catalog provider openai 无 models.json override（导入后常态形态），但 settings.json
      // default 承载它。removeProvider 提前 return {removed:false} 跳过默认清理（旧实现残留
      // 指向无凭据 provider 的 default）。修复：显式 pickEnabledDefaultModel 重选
      // + setDefaultModel 持久化 + 透传 newDefault 供广播。
      // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，重选结果随
      // builtin 目录漂移——custom 候选集固定为 mock 的 models，聚焦重选触发本身）。
      const { svc, store } = makeService({
        models: { 'other-llm': { models: [{ id: 'their-m' }] } },
        enabledModels: ['openai/*', 'other-llm/*'],
      })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
      ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'openai', modelId: 'gpt-4' })

      const ret = await svc.removeProviderByKind('openai', 'catalog')

      expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
      expect(ret).toEqual({ removed: true, newDefault: { provider: 'other-llm', modelId: 'their-m' } })
    })

    it('M5-03：catalog 无 override + default 承载该 provider + 无其他启用 provider → 不重选（无候选）', async () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
      ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'openai', modelId: 'gpt-4' })

      const ret = await svc.removeProviderByKind('openai', 'catalog')

      expect(store.setDefaultModel).not.toHaveBeenCalled()
      expect(ret).toEqual({ removed: true })
    })

    it('M5-03：catalog 无 override 且 default 不承载该 provider → 不重选', async () => {
      const { svc, store } = makeService({
        models: { anthropic: { models: [{ id: 'claude-3' }] } },
        enabledModels: ['anthropic/*'],
      })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })
      ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockReturnValueOnce({ provider: 'anthropic', modelId: 'claude-3' })

      const ret = await svc.removeProviderByKind('openai', 'catalog')

      expect(store.setDefaultModel).not.toHaveBeenCalled()
      expect(ret).toEqual({ removed: true })
    })

    it('MF-2：cleanEnabledModelsResidue 改白名单后 getDefaultModel auto-fix 不应跳过重选（预读修复）', async () => {
      // 复现生产缺陷：PiConfigStore.getDefaultModel 内部 findValidDefaultModel 在白名单变更后
      // auto-fix 重选。旧实现在 cleanEnabledModelsResidue（白名单变更）之后才读 default，
      // oldDefault.provider 已被 auto-fix 成别的 provider，oldDefault.provider === providerId
      // 恒 false，M5-03 显式 B1 凭据优先重选不可达。
      // 状态化 mock：getDefaultModel 在 cleanEnabledModelsResidue 前返 openai（真旧 default），
      // 之后返 other-llm（auto-fix 重选值）。修复（预读）后 getDefaultModel 在 clean 前被调用 →
      // oldDefault=openai，重选触发。旧实现该断言失败（setDefaultModel 未调用）。
      // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，重选结果随
      // builtin 目录漂移——custom 候选集固定为 mock 的 models）。
      const { svc, store } = makeService({
        models: { 'other-llm': { models: [{ id: 'their-m' }] } },
        enabledModels: ['openai/*', 'other-llm/*'],
      })
      let cleanCalled = false
      ;(store.getDefaultModel as ReturnType<typeof vi.fn>).mockImplementation(() =>
        cleanCalled ? { provider: 'other-llm', modelId: 'their-m' } : { provider: 'openai', modelId: 'gpt-4' },
      )
      ;(store.cleanEnabledModelsResidue as ReturnType<typeof vi.fn>).mockImplementation(() => { cleanCalled = true })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({ removed: false })

      const ret = await svc.removeProviderByKind('openai', 'catalog')

      // 修复后：预读 oldDefault=openai（clean 前），重选触发，setDefaultModel 被调
      expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
      expect(ret).toEqual({ removed: true, newDefault: { provider: 'other-llm', modelId: 'their-m' } })
    })

    // [2026-09 测试舰队审查 r2-24] MF-3（M5-03 路径）用例已删：与 config-service-toggle.test.ts
    // MF-3（M5-02 路径）同测 pickEnabledDefaultModel 跳过禁用 model，二留一保留 toggle 版
    // （其状态化 mock 更接近生产路径）。
  })

  // ══ TC3: custom 分支——删 models.json 条目 + 清残留 ═══════════════════════════════════

  describe('TC3: removeProviderByKind(custom) 删 models.json 条目 + 清 enabledModels 残留', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('调 configStore.removeProvider（删 custom 定义条目）', async () => {
      const { svc, store } = makeService({ enabledModels: ['my-custom/*'] })
      await svc.removeProviderByKind('my-custom', 'custom')
      expect(store.removeProvider).toHaveBeenCalledWith('my-custom')
    })

    it('调 configStore.cleanEnabledModelsResidue（清残留）', async () => {
      const { svc, store } = makeService({ enabledModels: ['my-custom/*', 'openai/*'] })
      await svc.removeProviderByKind('my-custom', 'custom')
      expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('my-custom')
    })

    it('不调 authStorage.remove（custom 凭据在 models.json，删条目即清，不走 auth.json）', async () => {
      const { svc, auth } = makeService({ enabledModels: ['my-custom/*'] })
      await svc.removeProviderByKind('my-custom', 'custom')
      expect(auth.remove).not.toHaveBeenCalled()
    })

    it('透传 removeProvider 返回值（含 default 重选 newDefault）', async () => {
      const { svc, store } = makeService({ enabledModels: ['my-custom/*'] })
      ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        removed: true,
        newDefault: { provider: 'openai', modelId: 'gpt-4' },
      })
      const ret = await svc.removeProviderByKind('my-custom', 'custom')
      expect(ret).toEqual({ removed: true, newDefault: { provider: 'openai', modelId: 'gpt-4' } })
    })
  })

  // ══ 边界3(a): cleanEnabledModelsResidue 空数组检查（pi-provider-store 层） ════════════
  // 注：removeProviderByKind 调 configStore.cleanEnabledModelsResidue（port），实际检查逻辑
  // 在 pi-provider-store.cleanEnabledModelsResidue。此用例直接测 pi-provider-store 导出函数，
  // 验证「重算空 → clearEnabledModels（delete 字段，非 setEnabledModels([])）」的边界3(a) 检查。


  describe('边界3(a): cleanEnabledModelsResidue 重算空 → clearEnabledModels（delete 字段，CL2）', () => {
    let dir: string
    let agentDir: string

    beforeEach(() => {
      vi.clearAllMocks()
      dir = mkdtempSync(join(tmpdir(), 'clean-residue-'))
      agentDir = join(dir, 'agent')
      mkdirSync(agentDir, { recursive: true })
      process.env.TAIJI_AGENT_DATA_DIR = dir
    })

    afterEach(() => {
      delete process.env.TAIJI_AGENT_DATA_DIR
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('多 pattern 移除后非空 → setEnabledModels(remaining)；再清至空 → delete enabledModels 字段', async () => {
      // 动态 import：测试体内拿函数引用，确保 setModelsPath/setSettingsPath 已指向临时目录后再调用
      const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
      const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
      setModelsPath(join(agentDir, 'models.json'))
      setSettingsPath(join(agentDir, 'settings.json'))
      invalidateSettingsCache()

      // 先写非空白名单（含 openai 多个 pattern + anthropic）
      setEnabledModels(['openai/*', 'openai/gpt-4', 'anthropic/*'])

      // 清 openai 残留 → 剩 anthropic/*（非空）→ setEnabledModels(['anthropic/*'])
      cleanEnabledModelsResidue('openai')
      let raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['anthropic/*'])

      // 再清 anthropic 残留 → 剩空 → clearEnabledModels（delete 字段，CL2——非写空数组）
      cleanEnabledModelsResidue('anthropic')
      raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect('enabledModels' in raw).toBe(false)
    })

    it('startsWith 带斜杠防前缀碰撞：清 openai 不误删 openai-compatible/*', async () => {
      const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
      const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
      setModelsPath(join(agentDir, 'models.json'))
      setSettingsPath(join(agentDir, 'settings.json'))
      invalidateSettingsCache()

      setEnabledModels(['openai/*', 'openai-compatible/*'])
      cleanEnabledModelsResidue('openai')
      const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['openai-compatible/*'])
    })

    it('幂等：provider 不在白名单时 no-op（文件不重复写）', async () => {
      const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
      const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
      setModelsPath(join(agentDir, 'models.json'))
      setSettingsPath(join(agentDir, 'settings.json'))
      invalidateSettingsCache()

      setEnabledModels(['anthropic/*'])
      cleanEnabledModelsResidue('openai') // openai 本不在白名单
      const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['anthropic/*']) // 无变化
    })
  })
});

// ════════════════ 来源: config-service-toggle.test.ts ════════════════
describe('config-service-toggle', () => {
  /**
   * toggleProviderEnabled + 边界检查 + setProvider 停用 enabled 测试（wave3，provider-dual-system-r2::enabledmodels-dual-consume）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-toggle.test.ts
   *
   * 策略：
   *   - TC1/TC2/TC3/TC6：mock configStore，断言写方法调用路由（setEnabledModels vs clearEnabledModels、
   *     setProvider merged 不含 provider 级 enabled）。
   *   - TC4/TC7：状态化 mock（写反映到读），验证 defaultModel 重选 + listProviders 联动。
   *   - 边界3 持久化（CL2）：真实 pi-settings-store（临时 settings 文件），验证 clearEnabledModels
   *     后 settings.json 物理无 enabledModels key（JSON.stringify 丢弃 delete 后的 undefined）。
   *
   * 覆盖 design TC1-TC4/TC6/TC7 + CL1（toggle(true) 空白名单 no-op）+ setProvider 边界1 检查。
   */
  // M5-02：mock 镜像生产 getDefaultModel 的 auto-fix 语义需要 deriveEnabled（与
  // pi-provider-store.findValidDefaultModel 同源判定）。本文件不 mock provider-catalog。
  // 真实 pi-settings-store（边界3 持久化验证用）

  type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

  interface StoreOpts { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    /** models.json providers（默认空）。 */
    models?: ConfigModelsConfig['providers']
    /** settings.json.enabledModels（默认空 = 全启用，DM3）。 */
    enabledModels?: string[]
    /** settings.json defaultProvider/defaultModel（默认 null）。 */
    defaultModel?: { provider: string; modelId: string } | null
    /** auth.json 顶层 providerId 列表（catalog 凭据源，listProviders 联动用）。 */
    authIds?: string[]
  }

  /**
   * 状态化 mock IConfigStore：写操作（setEnabledModels/clearEnabledModels/setDefaultModel/
   * ensureProviderInWhitelist/upsertProvider）反映到后续读（getEnabledModels/getDefaultModel/
   * readModels/getProviderConfig）。TC4 边界2 重选 + TC7 联动需要 read-after-write 一致性。
   */
  function makeStore(opts: StoreOpts = {}) {
    let enabledModels = [...(opts.enabledModels ?? [])]
    let defaultModel = opts.defaultModel ?? null
    const models: ConfigModelsConfig['providers'] = opts.models ? JSON.parse(JSON.stringify(opts.models)) : {}
    return {
      readModels: vi.fn(() => ({ providers: models })),
      getEnabledModels: vi.fn(() => [...enabledModels]),
      getDefaultModel: vi.fn(() => {
        // M5-02：镜像生产 PiConfigStore.getDefaultModel（findValidDefaultModel + wasFixed
        // auto-fix 写回）。default 有效（provider 在 models、有 models、启用、modelId 存在）
        // → 原值返回；无效 → 重选 models 中第一个启用且有 models 的 provider 并写回
        //（wasFixed 语义）；无可用 → null（生产 catalog 兜底 wasFixed:false 不写回，mock 简化为 null）。
        // 若 mock 仍是「无条件返回初值」，TC4 测的是生产不可达路径（旧实现顺序 bug 漏网）。
        if (!defaultModel) return null
        const cur = defaultModel
        const cfg = models[cur.provider]
        const isEnabled = deriveEnabled(cur.provider, enabledModels)
        if (cfg?.models?.length && isEnabled && cfg.models.some(m => m.id === cur.modelId)) {
          return cur
        }
        for (const [pid, pcfg] of Object.entries(models)) {
          if (pcfg.models?.length && deriveEnabled(pid, enabledModels)) {
            defaultModel = { provider: pid, modelId: pcfg.models[0].id }
            return defaultModel
          }
        }
        return null
      }),
      getProviderConfig: vi.fn((id: string) => (id in models ? JSON.parse(JSON.stringify(models[id])) : undefined)),
      setEnabledModels: vi.fn((p: string[]) => { enabledModels = [...p] }),
      clearEnabledModels: vi.fn(() => { enabledModels = [] }),
      setDefaultModel: vi.fn((provider: string, modelId: string) => { defaultModel = { provider, modelId } }),
      ensureProviderInWhitelist: vi.fn((id: string) => {
        // 与 pi-provider-store.ensureProviderInWhitelist 同语义（状态化镜像，供 TC4/TC7 read-after-write）
        if (enabledModels.length === 0) return
        const pattern = `${id}/*`
        if (enabledModels.includes(pattern)) return
        enabledModels = [...enabledModels, pattern]
      }),
      upsertProvider: vi.fn((id: string, merged: ConfigProviderConfig) => {
        models[id] = merged
        return {}
      }),
      applyTypeTranslation: vi.fn((t: string) => t),
      removeProvider: vi.fn(() => ({ removed: true })),
    } as unknown as IConfigStore & {
      setEnabledModels: ReturnType<typeof vi.fn>
      clearEnabledModels: ReturnType<typeof vi.fn>
      setDefaultModel: ReturnType<typeof vi.fn>
      ensureProviderInWhitelist: ReturnType<typeof vi.fn>
      upsertProvider: ReturnType<typeof vi.fn>
    }
  }

  function makeAuth(authIds: string[] = []): FullAuthPick {
    return {
      listCredentialIds: vi.fn(() => authIds),
      hasCredentialSync: vi.fn(() => false),
      remove: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      hasOAuth: vi.fn(() => false),
      hasOAuthSync: vi.fn(() => false),
    } as unknown as FullAuthPick
  }

  function makeService(opts: StoreOpts = {}): { svc: ConfigService; store: ReturnType<typeof makeStore> } {
    const store = makeStore(opts)
    const auth = makeAuth(opts.authIds ?? [])
    // M2fg 恒注入形态：凭据判定（含 B1 重选凭据优先）经 resolver 批量 sync 版，
    // 同源于上方 store/auth mock
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth,
      configStore: store,
    })
    const svc = new ConfigService('/tmp/project', store, auth, undefined, undefined, resolver)
    return { svc, store }
  }

  // ══ TC1: toggleProviderEnabled(true) 加 <id>/* 到 enabledModels ════════════════════

  describe('TC1: toggleProviderEnabled(true) 加 <id>/* 到 enabledModels', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('enabledModels 非空 → 加 <id>/*', () => {
      const { svc, store } = makeService({ enabledModels: ['anthropic/*'] })
      svc.toggleProviderEnabled('openai', true)
      expect(store.setEnabledModels).toHaveBeenCalledWith(['anthropic/*', 'openai/*'])
    })

    it('CL1: enabledModels 空（全可用）→ no-op（不加 pattern，避免禁用其他）', () => {
      const { svc, store } = makeService({ enabledModels: [] })
      const ret = svc.toggleProviderEnabled('openai', true)
      expect(store.setEnabledModels).not.toHaveBeenCalled()
      expect(ret).toEqual({})
    })

    it('CL1: enabledModels undefined（全可用）→ no-op', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      svc.toggleProviderEnabled('openai', true)
      // 幂等：pattern 已在白名单，不重复加
      expect(store.setEnabledModels).not.toHaveBeenCalled()
    })
  })

  // ══ TC2: toggleProviderEnabled(false) 移除 <id>/* 与 <id>/model pattern ═════════════

  describe('TC2: toggleProviderEnabled(false) 移除 <id>/* 与 <id>/model pattern', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('移除 provider 级（<id>/*）+ model 级（<id>/<model>）所有 pattern', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai/gpt-4', 'anthropic/*'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.setEnabledModels).toHaveBeenCalledWith(['anthropic/*'])
    })

    it('startsWith 带斜杠防前缀碰撞：openai 不误删 openai-compatible/*', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai-compatible/*'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.setEnabledModels).toHaveBeenCalledWith(['openai-compatible/*'])
    })

    it('幂等：provider 不在白名单时 no-op', () => {
      const { svc, store } = makeService({ enabledModels: ['anthropic/*'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.setEnabledModels).not.toHaveBeenCalled()
      expect(store.clearEnabledModels).not.toHaveBeenCalled()
    })
  })

  // ══ TC3: 边界3 空数组检查——重算空时 clearEnabledModels（非写空数组）══════════════════

  describe('TC3: 边界3 空数组检查——重算空时 clearEnabledModels（delete 字段，CL2）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('移除最后一个 pattern → clearEnabledModels 调用，setEnabledModels 不调用（非写空数组）', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.clearEnabledModels).toHaveBeenCalledTimes(1)
      expect(store.setEnabledModels).not.toHaveBeenCalled()
    })

    it('model 级 pattern 移除至空 → 同样 clearEnabledModels', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/gpt-4'] })
      svc.toggleProviderEnabled('openai', false)
      expect(store.clearEnabledModels).toHaveBeenCalledTimes(1)
      expect(store.setEnabledModels).not.toHaveBeenCalled()
    })
  })

  // ══ TC4: 边界2 defaultModel 检查——禁用承载 default 的 provider 时重选 ════════════════

  describe('TC4: 边界2 defaultModel 检查——禁用承载 default 的 provider 时重选', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('defaultModel=openai/gpt-4，禁用 openai → 重选为剩余 provider 的 model，返回 newDefault', () => {
      // B-2 混合合并后：catalog provider（如 anthropic）的 models 含 builtin 副本条目，
      // 重选结果随 builtin 目录漂移。候选用 custom id（other-llm）固定 mock 的 models 集，
      // 本用例聚焦「重选发生 + 写回」本身。
      const { svc, store } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          'other-llm': { models: [{ id: 'their-m' }] },
        },
        enabledModels: ['openai/*', 'other-llm/*'],
        defaultModel: { provider: 'openai', modelId: 'gpt-4' },
      })
      const ret = svc.toggleProviderEnabled('openai', false)
      // 重选写入 other-llm/their-m
      expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'their-m')
      expect(ret.newDefault).toEqual({ provider: 'other-llm', modelId: 'their-m' })
    })

    it('禁用的 provider 不承载 default → 不重选，返回空对象', () => {
      const { svc, store } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          anthropic: { models: [{ id: 'claude-3' }] },
        },
        enabledModels: ['openai/*', 'anthropic/*'],
        defaultModel: { provider: 'anthropic', modelId: 'claude-3' },
      })
      const ret = svc.toggleProviderEnabled('openai', false)
      expect(store.setDefaultModel).not.toHaveBeenCalled()
      expect(ret).toEqual({})
    })

    it('M5-02：剩余可用 provider 是 auth.json-only catalog → 重选凭据优先的 anthropic（生产真实路径）', () => {
      // 场景：openai 承载 default，禁用后唯一剩余可用是 auth.json 凭据的 catalog provider
      // anthropic（不在 models.json——生产 findValidDefaultModel 的 fallback 只扫 models.json，
      // 看不到它；pickEnabledDefaultModel 的 B1 凭据优先经 listProviders 双源聚合能看到）。
      const { svc, store } = makeService({
        models: { openai: { models: [{ id: 'gpt-4' }] } },
        enabledModels: ['openai/*'],
        defaultModel: { provider: 'openai', modelId: 'gpt-4' },
        authIds: ['anthropic'],
      })
      const ret = svc.toggleProviderEnabled('openai', false)
      // 白名单更新前读到旧 default（openai）→ 重选 anthropic 并持久化
      expect(store.setDefaultModel).toHaveBeenCalledWith('anthropic', expect.any(String))
      expect(ret.newDefault?.provider).toBe('anthropic')
      // 关键：setDefaultModel 被调用（非惰性等下次 getDefaultModel auto-fix）
      expect(store.setDefaultModel).toHaveBeenCalledTimes(1)
    })

    it('MF-3：重选 default 时跳过候选 provider 的已禁用 model（model 级 enabled 校验，M5-02 路径）', () => {
      // 场景：openai 承载 default，禁用 openai 后重选到候选 provider，但其 models[0]
      // 被用户显式禁用（enabled:false）。旧实现 pickEnabledDefaultModel 只校验 provider 级
      // p.enabled + p.models[0] 存在性，会把已禁用 model 写成新 default。修复后 find 首个启用 model。
      // 候选用 custom id（B-2 混合合并后 catalog 候选的 models 含 builtin 条目，会掩盖
      // 「跳过禁用 model」的意图——custom 候选集固定为 mock 的 models）。
      const { svc, store } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          'other-llm': { models: [{ id: 'disabled-m', enabled: false }, { id: 'enabled-m', enabled: true }] },
        },
        enabledModels: ['openai/*', 'other-llm/*'],
        defaultModel: { provider: 'openai', modelId: 'gpt-4' },
      })
      const ret = svc.toggleProviderEnabled('openai', false)
      // 重选跳过 disabled-m，选 enabled-m（首个启用 model）
      expect(store.setDefaultModel).toHaveBeenCalledWith('other-llm', 'enabled-m')
      expect(ret.newDefault).toEqual({ provider: 'other-llm', modelId: 'enabled-m' })
    })
  })

  // ══ TC6: setProvider 停用 provider 级 enabled 写入 ══════════════════════════════════

  describe('TC6: setProvider 停用 provider 级 enabled 写入（C5）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('provider 级 enabled（data.enabled）不写入 models.json', () => {
      const { svc, store } = makeService({
        models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
      })
      svc.setProvider('openai', { enabled: false })
      const merged = store.upsertProvider.mock.calls[0][1] as Record<string, unknown>
      // provider 级 enabled 不写入（停用——改由 enabledModels 承载）
      expect('enabled' in merged).toBe(false)
    })

    it('model 级 enabled（data.models[].enabled）不写入 models.json（G3 写侧切换，0161efce4）', () => {
      // model 级启停迁 config/providers.json modelStates（providers.json 侧的写入断言见
      // provider-write-side-switch.test.ts「model enabled 写 providers.json modelStates」），
      // models.json 不再落 pi schema 外的寄生 enabled 字段。
      const { svc, store } = makeService({
        models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
      })
      svc.setProvider('openai', { models: [{ id: 'gpt-4', enabled: false }] })
      const merged = store.upsertProvider.mock.calls[0][1] as { models: Array<{ id: string; enabled?: boolean }> }
      expect('enabled' in merged.models[0]).toBe(false)
    })
  })

  // ══ setProvider 边界1 检查——新建 provider 加白名单 ══════════════════════════════════

  describe('setProvider 边界1检查：新建 provider 时 ensureProviderInWhitelist（TC5 setProvider 路径）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('新建 provider（existingConfig===undefined）→ ensureProviderInWhitelist 调用', () => {
      const { svc, store } = makeService({ enabledModels: ['openai/*'] })
      svc.setProvider('my-custom', { name: 'My', models: [{ id: 'm1' }] })
      expect(store.ensureProviderInWhitelist).toHaveBeenCalledWith('my-custom')
    })

    it('已有 provider（existingConfig!==undefined）→ ensureProviderInWhitelist 不调用', () => {
      const { svc, store } = makeService({
        models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
        enabledModels: ['openai/*'],
      })
      svc.setProvider('openai', { name: 'OpenAI Renamed' })
      expect(store.ensureProviderInWhitelist).not.toHaveBeenCalled()
    })
  })

  // ══ TC7: 联动验证——toggle 后 listProviders 的 enabled 派生正确 ═══════════════════════

  describe('TC7: 联动——toggle 后 listProviders 的 enabled 派生正确反映', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('toggle(openai,false) 后 listProviders：openai→false，anthropic→true', () => {
      const { svc } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          anthropic: { models: [{ id: 'claude-3' }] },
        },
        enabledModels: ['openai/*', 'anthropic/*'],
      })
      svc.toggleProviderEnabled('openai', false)
      const byId = Object.fromEntries(svc.listProviders().map(p => [p.id, p]))
      expect(byId['openai'].enabled).toBe(false)
      expect(byId['anthropic'].enabled).toBe(true)
    })

    it('toggle(openai,true) 加白名单后 listProviders：openai→true', () => {
      const { svc } = makeService({
        models: {
          openai: { models: [{ id: 'gpt-4' }] },
          anthropic: { models: [{ id: 'claude-3' }] },
        },
        enabledModels: ['anthropic/*'],
      })
      // toggle 前 openai 未在白名单 → enabled=false
      expect(Object.fromEntries(svc.listProviders().map(p => [p.id, p]))['openai'].enabled).toBe(false)
      svc.toggleProviderEnabled('openai', true)
      expect(Object.fromEntries(svc.listProviders().map(p => [p.id, p]))['openai'].enabled).toBe(true)
    })
  })

  // ══ 边界3 持久化（CL2）：真实 pi-settings-store 验证 delete 字段后 settings.json 无 key ════

  describe('边界3 持久化（CL2）：clearEnabledModels 后 settings.json 物理无 enabledModels key', () => {
    let dir: string
    let agentDir: string

    beforeEach(() => {
      vi.clearAllMocks()
      dir = mkdtempSync(join(tmpdir(), 'toggle-bd3-'))
      agentDir = join(dir, 'agent')
      mkdirSync(agentDir, { recursive: true })
      process.env.TAIJI_AGENT_DATA_DIR = dir
      setModelsPath(join(agentDir, 'models.json'))
      setSettingsPath(join(agentDir, 'settings.json'))
      invalidateSettingsCache()
    })

    afterEach(() => {
      delete process.env.TAIJI_AGENT_DATA_DIR
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it("setEnabledModels(['openai/*']) 后 clearEnabledModels → settings.json 无 enabledModels key", () => {
      // 先写一个非空白名单
      setEnabledModels(['openai/*'])
      let raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['openai/*'])

      // clearEnabledModels 用 updateSettingsFields('model', delete) 删字段
      clearEnabledModels()
      // 文件仍存在（只删 key，非删文件）
      expect(existsSync(join(agentDir, 'settings.json'))).toBe(true)
      // JSON.stringify 丢弃 undefined 字段 → settings.json 物理无 enabledModels key
      raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect('enabledModels' in raw).toBe(false)
    })

    it("ensureProviderInWhitelist：enabledModels 非空时加 <id>/*，空时 no-op（真实行为）", () => {
      // 空（全可用）→ no-op，settings.json 不出现 enabledModels
      ensureProviderInWhitelist('openai')
      expect(existsSync(join(agentDir, 'settings.json'))).toBe(false)

      // 非空 → 加 pattern
      setEnabledModels(['anthropic/*'])
      ensureProviderInWhitelist('openai')
      const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw.enabledModels).toEqual(['anthropic/*', 'openai/*'])

      // 幂等：重复加同 id 不重复
      ensureProviderInWhitelist('openai')
      const raw2 = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
      expect(raw2.enabledModels).toEqual(['anthropic/*', 'openai/*'])
    })
  })
});

// ════════════════ 来源: provider-read-source-switch.test.ts ════════════════
describe('provider-read-source-switch', () => {
  /**
   * A1-3 读源切换测试：listProviders 聚合层的 taiji 私有字段（authMethod/quota/modelStates）
   * 从 config/providers.json 双读回退（providers.json 优先 + models.json 旧寄生字段兜底）。
   *
   * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
   * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-read-source-switch.test.ts
   *
   * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + TAIJI_AGENT_DATA_DIR env），
   * 与 provider-write-side-switch.test.ts 同模式。isCatalogProvider 走真实实现
   * （zai-coding-cn 是 builtin catalog provider）。
   */

  let dir: string
  let agentDir: string
  let extrasStore: TaijiProviderStore
  let configStore: PiConfigStore

  function writeModelsJson(providers: Record<string, unknown>): void {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
  }

  function writeExtrasJson(providers: ProviderExtrasFile['providers']): void {
    const file: ProviderExtrasFile = { version: 1, providers }
    writeFileSync(join(agentDir, 'config', 'providers.json'), JSON.stringify(file, null, 2))
  }

  function makeSvc(authIds: string[] = []): ConfigService {
    // catalog 源候选 = (auth.json keys ∪ models.json catalog keys) ∩ builtinData——
    // builtin 副本路径测试需注入 authStorage 让凭据型 catalog provider 进入聚合
    const auth = authIds.length > 0
      ? { listCredentialIds: () => authIds, hasCredentialSync: () => true } as never
      : undefined
    // M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（真 PiConfigStore 读同一 models.json）
    const resolver = new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: auth ?? { listCredentialIds: () => [] as string[], hasCredentialSync: () => false },
      configStore,
    })
    return new ConfigService('/tmp/project', configStore, auth, extrasStore, undefined, resolver)
  }

  function byId(svc: ConfigService): Record<string, ReturnType<ConfigService['listProviders']>[number]> {
    return Object.fromEntries(svc.listProviders().map(p => [p.id, p]))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provider-read-source-switch-'))
    agentDir = join(dir, 'agent')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    process.env.TAIJI_AGENT_DATA_DIR = dir
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()
    extrasStore = new TaijiProviderStore(join(agentDir, 'config', 'providers.json'))
    configStore = new PiConfigStore()
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('A1-3 验收 1：聚合层读源（providers.json 优先）', () => {
    it('providers.json 有 authMethod/quota → catalog 与 custom 均读到（models.json 无寄生字段）', () => {
      writeModelsJson({
        'zai-coding-cn': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
        'my-proxy': { apiKey: 'sk-x', baseUrl: 'https://proxy.example.com' },
      })
      writeExtrasJson({
        'zai-coding-cn': { authMethod: 'api_key', quota: { fetcher: 'zhipu', enabled: true, apiKeySet: true } },
        'my-proxy': { authMethod: 'env_var', quota: { fetcher: 'kimi', enabled: false } },
      })

      const m = byId(makeSvc())

      // catalog 源：显式 authMethod 标注 + quota 来自 providers.json
      expect(m['zai-coding-cn'].authMethod).toBe('api_key')
      expect(m['zai-coding-cn'].quota).toEqual({ fetcher: 'zhipu', enabled: true, apiKeySet: true })
      // custom 源同
      expect(m['my-proxy'].authMethod).toBe('env_var')
      expect(m['my-proxy'].quota).toEqual({ fetcher: 'kimi', enabled: false })
    })

    it('fallback：providers.json 无条目 + models.json 有旧寄生字段（迁移失败窗口）→ 仍能读到', () => {
      writeModelsJson({
        'zai-coding-cn': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          authMethod: 'oauth',
          quota: { fetcher: 'zhipu', enabled: true, cookieSet: true },
        },
        'my-proxy': {
          apiKey: '$MY_KEY',
          authMethod: 'env_var',
          quota: { fetcher: 'kimi', enabled: true },
        },
      })
      // providers.json 文件不存在（无条目）→ 双读回退 models.json 旧寄生字段

      const m = byId(makeSvc())

      expect(m['zai-coding-cn'].authMethod).toBe('oauth')
      expect(m['zai-coding-cn'].quota).toEqual({ fetcher: 'zhipu', enabled: true, cookieSet: true })
      expect(m['my-proxy'].authMethod).toBe('env_var')
      expect(m['my-proxy'].quota).toEqual({ fetcher: 'kimi', enabled: true })
    })

    it('providers.json 优先级：两处同 id 时 providers.json 胜（models.json 旧值不复活）', () => {
      writeModelsJson({
        'zai-coding-cn': {
          authMethod: 'oauth',
          quota: { fetcher: 'stale-fetcher', enabled: false },
        },
      })
      writeExtrasJson({
        'zai-coding-cn': { authMethod: 'api_key', quota: { fetcher: 'zhipu', enabled: true } },
      })

      const m = byId(makeSvc())

      expect(m['zai-coding-cn'].authMethod).toBe('api_key')
      expect(m['zai-coding-cn'].quota).toEqual({ fetcher: 'zhipu', enabled: true })
    })

    it('两处皆无 → authMethod 走 derive 推断、quota 为 undefined', () => {
      writeModelsJson({
        'zai-coding-cn': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
        'env-provider': { apiKey: '$MY_TOKEN', baseUrl: 'https://x.example.com' },
        'key-provider': { apiKey: 'sk-plain', baseUrl: 'https://y.example.com' },
        'bare-provider': { baseUrl: 'https://z.example.com' },
      })

      const m = byId(makeSvc())

      // catalog 无 override 凭据且无标注 → undefined；apiKey 推断：$开头→env_var / 非空→api_key / 缺省→undefined
      expect(m['zai-coding-cn'].authMethod).toBeUndefined()
      expect(m['env-provider'].authMethod).toBe('env_var')
      expect(m['key-provider'].authMethod).toBe('api_key')
      expect(m['bare-provider'].authMethod).toBeUndefined()
      // quota 双读皆 miss → undefined
      expect(m['zai-coding-cn'].quota).toBeUndefined()
      expect(m['env-provider'].quota).toBeUndefined()
    })
  })

  describe('A1-3 验收 2：modelStates 过滤（models[].enabled 迁移后等价）', () => {
    it('override models 路径：providers.json modelStates enabled=false → 聚合输出过滤行为与迁移前一致', () => {
      // 迁移前形态（models.json 寄生 enabled）——等价基准
      writeModelsJson({
        'zai-coding-cn': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          models: [
            { id: 'glm-5.3', name: 'GLM 5.3' },
            { id: 'glm-5.2', name: 'GLM 5.2', enabled: false },
          ],
        },
      })
      const before = byId(makeSvc())['zai-coding-cn'].models
      expect(before.find(x => x.id === 'glm-5.3')?.enabled).toBe(true)
      expect(before.find(x => x.id === 'glm-5.2')?.enabled).toBe(false)

      // 迁移后形态（providers.json modelStates）——同一过滤结果
      writeModelsJson({
        'zai-coding-cn': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          models: [
            { id: 'glm-5.3', name: 'GLM 5.3' },
            { id: 'glm-5.2', name: 'GLM 5.2' },
          ],
        },
      })
      writeExtrasJson({
        'zai-coding-cn': { modelStates: { 'glm-5.2': { enabled: false } } },
      })
      const after = byId(makeSvc())['zai-coding-cn'].models
      expect(after.find(x => x.id === 'glm-5.3')?.enabled).toBe(true)
      expect(after.find(x => x.id === 'glm-5.2')?.enabled).toBe(false)
    })

    it('custom provider 的 modelStates 同样生效', () => {
      writeModelsJson({
        'my-proxy': {
          apiKey: 'sk-x',
          models: [{ id: 'm1' }, { id: 'm2' }],
        },
      })
      writeExtrasJson({ 'my-proxy': { modelStates: { m1: { enabled: false } } } })

      const models = byId(makeSvc())['my-proxy'].models
      expect(models.find(x => x.id === 'm1')?.enabled).toBe(false)
      expect(models.find(x => x.id === 'm2')?.enabled).toBe(true)
    })

    it('builtin 副本路径：modelStates 对 catalog 内置模型生效（providers.json 手写场景）', () => {
      // catalog provider 无 override、凭据在 auth.json → models 兜底 builtin 副本；modelStates 仍应用
      writeModelsJson({})
      writeExtrasJson({ 'zai-coding-cn': { modelStates: {} } })
      // 先取一个真实 builtin model id 构造禁用态
      const svc = makeSvc(['zai-coding-cn'])
      const firstModel = byId(svc)['zai-coding-cn'].models[0]
      expect(firstModel).toBeDefined()

      writeExtrasJson({ 'zai-coding-cn': { modelStates: { [firstModel.id]: { enabled: false } } } })
      const models = byId(makeSvc(['zai-coding-cn']))['zai-coding-cn'].models
      expect(models.find(x => x.id === firstModel.id)?.enabled).toBe(false)
    })
  })
});

// ════════════════ 来源: config-service.test.ts ════════════════
describe('config-service', () => {
  /**
   * ConfigService — runtime enabled 读写链路（W2）端到端单测。
   *
   * 用真实 PiConfigStore（指向临时目录的 models.json）验证：
   * U1 listProviders 返回 provider 级 api 字段（修复编辑回填丢失 api，P0-1）+ enabled
   * U2 setProvider 写入 enabled 并被 listProviders 读回（真实读写 models.json，非硬编码）
   * U3 setProvider 写入 model 级 enabled 并被 aggregateModels 过滤（在 model-service.test.ts 验证过滤逻辑，
   *    此处只验证 listProviders 读回 model 级 enabled 字段）
   *
   * setup 模式复用 pi-provider-store.test.ts：setModelsPath/setSettingsPath 指向临时目录 +
   * writeModels 落盘 + refreshModels 刷缓存。
   */


  const mkdtempP = promisify(mkdtemp)
  const rmP = promisify(rm)

  let tmpDir: string
  let configStore: PiConfigStore
  let configService: ConfigService

  /**
   * M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（D3 唯一通道）。
   * auth.json 路径指向临时目录（零凭据 miss），models.json 路径经真 configStore。
   */
  function makeResolver(store: PiConfigStore): ProviderCredentialResolver {
    return new ProviderCredentialResolver({
      authService: { getCredential: async () => undefined },
      authStorage: new AuthStorage(join(tmpDir, 'agent', 'auth.json')),
      configStore: store,
    })
  }

  beforeEach(async () => {
    tmpDir = await mkdtempP(join(tmpdir(), 'config-service-test-'))
    mkdirSync(join(tmpDir, 'agent'), { recursive: true })
    // 指向临时目录，避免污染真实 ~/.taiji/agent
    setModelsPath(join(tmpDir, 'agent', 'models.json'))
    setSettingsPath(join(tmpDir, 'agent', 'settings.json'))
    refreshModels()
    // ConfigService 接受 IConfigStore；用真实 PiConfigStore 走完整读写链路
    configStore = new PiConfigStore()
    configService = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, makeResolver(configStore))
  })

  afterEach(async () => {
    await rmP(tmpDir, { recursive: true, force: true })
  })

  // ── U1: listProviders 返回 provider 级 api 字段 ────────────────────
  // 修复编辑回填丢失 api：前端编辑 provider 时需用 api 字段回填 type 下拉，
  // listProviders 不返回 api 会导致编辑后 type 丢失（P0-1）。
  describe('ConfigService.listProviders · provider 级 api 字段（U1，修复 P0-1）', () => {
    it('返回 provider 的 api 字段（非 undefined）', () => {
      const models: PiModelsConfig = {
        providers: {
          p1: {
            api: 'anthropic-messages',
            apiKey: 'sk-x',
            enabled: true,
            models: [],
          },
        },
      }
      writeModels(models)
      refreshModels()

      const providers = configService.listProviders()
      expect(providers).toHaveLength(1)
      expect(providers[0]!.id).toBe('p1')
      // 关键断言：api 字段必须回填，否则前端编辑 provider 时 type 下拉丢失
      expect(providers[0]!.api).toBe('anthropic-messages')
    })

    it('enabled=true 的 provider 返回 enabled === true', () => {
      const models: PiModelsConfig = {
        providers: {
          p1: {
            apiKey: 'sk-x',
            enabled: true,
            models: [],
          },
        },
      }
      writeModels(models)
      refreshModels()

      const providers = configService.listProviders()
      expect(providers[0]!.enabled).toBe(true)
    })
  })

  // ── U2: provider 级 enabled 读写链路（enabledModels 白名单模型）────────
  // wave3/wave4 演进：provider 级 enabled 从「models.json provider.enabled 字段」迁移到
  // 「settings.json enabledModels 白名单」。setProvider 不再写 provider.enabled（wave3 C5/TC6：
  // 前端 provider 启用切换改走 toggleProviderEnabled），listProviders 的 enabled 从
  // deriveEnabled(id, enabledModels) 派生（DM3/F2，不读 models.json provider.enabled）。
  //
  // 故 U2 的读写链路 = toggleProviderEnabled 写 enabledModels 白名单 → listProviders 经
  // deriveEnabled 读回。白名单空/undefined = 全可用（deriveEnabled 恒 true）；非空 = 白名单匹配才启用。
  // 要测「禁用」语义，须先让白名单非空（模拟用户已显式收窄启用范围）——空白名单下 toggle(false) 幂等 no-op。
  describe('ConfigService · provider 级 enabled 读写链路（U2，enabledModels 白名单模型）', () => {
    it('toggleProviderEnabled(p1, false) 后 listProviders 读回 enabled === false', () => {
      writeModels({
        providers: {
          p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
          p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
        },
      })
      refreshModels()
      // 建立非空白名单（模拟用户已显式启用部分 provider）。空白名单=全可用，toggle(false) 幂等 no-op。
      configStore.setEnabledModels(['p1/*', 'p2/*'])

      configService.toggleProviderEnabled('p1', false)

      const providers = configService.listProviders()
      // p1 被移出白名单 → deriveEnabled(p1) === false
      expect(providers.find(p => p.id === 'p1')?.enabled).toBe(false)
      // 副作用断言：禁用 p1 不误伤 p2（startsWith('p1/') 不匹配 'p2/*'，防 openai vs openai-compatible 前缀碰撞）
      expect(providers.find(p => p.id === 'p2')?.enabled).toBe(true)
    })

    it('toggleProviderEnabled(p1, true) 把已禁用的 p1 加回白名单后读回 enabled === true', () => {
      writeModels({
        providers: {
          p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
          p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
        },
      })
      refreshModels()
      // p1 不在白名单（已被禁用），p2 在 → 非空白名单下 deriveEnabled(p1) === false
      configStore.setEnabledModels(['p2/*'])
      expect(configService.listProviders().find(p => p.id === 'p1')?.enabled).toBe(false)

      // toggle(true) 在白名单非空时补加 p1/*（空白名单下 no-op，故前置条件必须非空）
      configService.toggleProviderEnabled('p1', true)

      expect(configService.listProviders().find(p => p.id === 'p1')?.enabled).toBe(true)
    })

    it('toggleProviderEnabled(p1, false) 后盘上 settings.json 持久化移除 p1 pattern（端到端非硬编码）', () => {
      writeModels({
        providers: {
          p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
          p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
        },
      })
      refreshModels()
      configStore.setEnabledModels(['p1/*', 'p2/*'])

      configService.toggleProviderEnabled('p1', false)

      // 直接读盘验证（绕过 service 缓存）：enabledModels 白名单落盘到 settings.json（非 models.json）
      const raw = readFileSync(
        join(tmpDir, 'agent', 'settings.json'),
        'utf-8',
      )
      const parsed = JSON.parse(raw) as { enabledModels?: string[] }
      // p1 的 pattern 被移除，仅剩 p2（startsWith('p1/') 统一匹配 provider 级与 model 级 pattern）
      expect(parsed.enabledModels).toEqual(['p2/*'])
      expect(parsed.enabledModels?.some(p => p.startsWith('p1/'))).toBe(false)
    })
  })

  // ── 向上兼容：存量 provider 无 enabled 字段时默认视为启用 ──────────
  // config.enabled !== false 语义：undefined 和 true 都视为启用，
  // 只有显式 false 才禁用（向上兼容存量无此字段的 provider）。
  describe('ConfigService.listProviders · 向上兼容（无 enabled 字段默认 true）', () => {
    it('存量 provider 无 enabled 字段时 enabled === true（向上兼容）', () => {
      // 故意不写 enabled 字段（模拟存量 models.json）
      const models: PiModelsConfig = {
        providers: {
          legacy: {
            apiKey: 'sk-legacy',
            models: [{ id: 'm1' }],
          },
        },
      }
      writeModels(models)
      refreshModels()

      const providers = configService.listProviders()
      expect(providers[0]!.enabled).toBe(true)
    })
  })

  // ── U3 前置：listProviders 读回 model 级 enabled（aggregateModels 过滤在 model-service.test.ts 验证）──
  describe('ConfigService.listProviders · model 级 enabled 透传', () => {
    it('model 级 enabled=false 透传到 listProviders 结果', () => {
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            models: [
              { id: 'm1', name: 'M1', enabled: false },
              { id: 'm2', name: 'M2', enabled: true },
            ],
          },
        },
      })
      refreshModels()

      const providers = configService.listProviders()
      const models = providers[0]!.models
      // model 级 enabled 透传，供 aggregateModels 过滤判断
      expect(models.find(m => m.id === 'm1')?.enabled).toBe(false)
      expect(models.find(m => m.id === 'm2')?.enabled).toBe(true)
    })
  })

  // ── U3b: setProvider 的 model 合并写路径必须保留传入的 enabled/api/baseUrl ──
  // review 发现：setProvider 的 model 合并循环只写 name/contextWindow/input/thinkingLevelMap，
  // 前端回传的 api/baseUrl/enabled 被丢弃。新模型（base={}）和编辑现有模型场景都会丢字段。
  // 此 describe 走 setProvider 写路径（而非 writeModels 直写），断言字段真落盘。
  // [G3 写侧切换] enabled 的落点改为 providers.json modelStates（models.json 不再写寄生字段）。
  describe('ConfigService.setProvider · model 级字段写路径（U3b，修复 review must_fix #1）', () => {
    it('新模型经 setProvider 保存后 enabled 生效（G3：落 providers.json modelStates，models.json 不落 enabled）', async () => {
      // 先建空 provider
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            models: [],
          },
        },
      })
      refreshModels()

      // [G3] enabled 落 providers.json modelStates——注入 extrasStore（生产恒注入）；
      // 未注入时 enabled 丢弃 + warn（宁丢不写错位，provider-write-side-switch.test.ts 覆盖）
      const extrasStore = new TaijiProviderStore(join(tmpDir, 'agent', 'config', 'providers.json'))
      const svc = new ConfigService(tmpDir, configStore, undefined, extrasStore, undefined, makeResolver(configStore))

      // setProvider 传入含 enabled 的 model（新模型，base={}）。modelStates 写入经
      // withFileLock 异步 RMW——必须 await 落盘后再断言
      await svc.setProvider('p1', {
        models: [
          { id: 'm1', enabled: false },
          { id: 'm2', enabled: true },
        ],
      })

      // 聚合层读 modelStates：enabled 语义保留（编辑保存不丢失）
      const providers = svc.listProviders()
      const models = providers[0]!.models
      expect(models.find(m => m.id === 'm1')?.enabled).toBe(false)
      expect(models.find(m => m.id === 'm2')?.enabled).toBe(true)

      // models.json 不再序列化 enabled（pi schema 外寄生字段禁复活）
      const raw = JSON.parse(readFileSync(join(tmpDir, 'agent', 'models.json'), 'utf-8'))
      const rawModels = raw.providers.p1.models as Array<Record<string, unknown>>
      expect(rawModels.find(m => m.id === 'm1')).not.toHaveProperty('enabled')
      expect(rawModels.find(m => m.id === 'm2')).not.toHaveProperty('enabled')
    })

    it('model 级 api/baseUrl 经 setProvider 保存后落盘（编辑场景）', () => {
      // 先建含 m1 的 provider（m1 无 api/baseUrl）
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            api: 'anthropic-messages',
            models: [{ id: 'm1', name: 'M1' }],
          },
        },
      })
      refreshModels()

      // 编辑 m1，补 model 级 api/baseUrl（覆盖 provider 默认）
      configService.setProvider('p1', {
        models: [
          { id: 'm1', name: 'M1', api: 'openai-completions', baseUrl: 'https://m1.example.com' },
        ],
      })

      const providers = configService.listProviders()
      const m1 = providers[0]!.models.find(m => m.id === 'm1')
      expect(m1?.api).toBe('openai-completions')
      expect(m1?.baseUrl).toBe('https://m1.example.com')
    })

    it('model 级 compat 经 setProvider 保存后落盘（修复隐性数据丢失 bug）', () => {
      // 先建含 m1 的 provider（m1 已有 compat——模拟用户手改 json 配好的）
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            api: 'openai-completions',
            models: [{
              id: 'm1',
              name: 'M1',
              compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' },
            }],
          },
        },
      })
      refreshModels()

      // 前端编辑 provider（不改 m1 的 compat——localModels 经 ...m 展开回传）
      // bug 复现：setProvider 合并逻辑若不透传 compat，m1.compat 会被静默丢弃
      configService.setProvider('p1', {
        models: [
          { id: 'm1', name: 'M1', compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' } },
        ],
      })

      const providers = configService.listProviders()
      const m1 = providers[0]!.models.find(m => m.id === 'm1')
      expect(m1?.compat).toEqual({ supportsDeveloperRole: false, thinkingFormat: 'deepseek' })
    })

    it('model 级 compat 显式覆盖：编辑后 compat 更新落盘', () => {
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            api: 'openai-completions',
            models: [{ id: 'm1', compat: { supportsDeveloperRole: true } }],
          },
        },
      })
      refreshModels()

      // 用户在 UI 把 supportsDeveloperRole 改成 false
      configService.setProvider('p1', {
        models: [
          { id: 'm1', compat: { supportsDeveloperRole: false } },
        ],
      })

      const m1 = configService.listProviders()[0]!.models.find(m => m.id === 'm1')
      expect(m1?.compat).toEqual({ supportsDeveloperRole: false })
    })

    it('setProvider 删除已存在的 compat（compat === undefined 触发删除）', () => {
      // 1. 先写一个带 compat 的 model（模拟用户已配好的 compat）
      writeModels({
        providers: {
          p1: {
            apiKey: 'sk-x',
            api: 'openai-completions',
            models: [{ id: 'm1', compat: { thinkingFormat: 'xml' } }],
          },
        },
      })
      refreshModels()

      // 2. setProvider 传 models 不含 compat 字段（compat 为 undefined）——模拟前端 clearAll 按钮
      //    buildMap() 全 passthrough 时 buildCompat 返回 undefined，前端整体提交 models 时
      //    该 model 无 compat 键，应触发 else if 删除分支。
      configService.setProvider('p1', {
        models: [{ id: 'm1' }],
      })

      // 3. 读回的 compat 应为 undefined（被 delete，而非保留盘上旧值）
      const m1 = configService.listProviders()[0]!.models.find(m => m.id === 'm1')
      expect(m1?.compat).toBeUndefined()
    })
  })

  // ── W1: loadAgents sourceType 必须随来源目录推断（不再恒 'pi'）──────
  // 背景：config-service.loadAgents 旧版把每个 agent 硬编码 source/sourceType = 'pi'，
  // 导致 Settings Agent 页按 Claude/Agents tab 过滤时永远空（即便文件来自 ~/.claude/agents）。
  // W1 修复：agent-crud.listAgentFiles 扫描时按 discovered 目录 inferSourceType 填 sourceType，
  // config-service.loadAgents 透传该字段。
  // 这里 mock configStore.listAgentFiles 返回带不同 sourceType 的 entry，
  // 验证 loadAgents 不再恒 pi，而是如实透传。
  describe('ConfigService.loadAgents · sourceType 随来源推断（W1，修复 tab 过滤失效）', () => {
    /**
     * 构造一个最小 fake configStore：只实现 loadAgents 用到的方法。
     * listAgentFiles 按 mockFiles 返回（含 sourceType），其余方法返回安全空值。
     * 跳过真实 PiConfigStore 是为了隔离：本测只验证「f.sourceType → AgentInfo.sourceType 透传」，
     * 不关心目录扫描/去重逻辑（那部分在 agent-crud 层，由真实文件验证更合适）。
     */
    function makeFakeStore(
      mockFiles: Array<{ name: string; path: string; content: string; sourceType: string }>,
    ) {
      return {
        getPiAgentDir: () => '/fake/agent',
        getAgentDirs: () => [] as string[],
        listAgentFiles: () => mockFiles,
        // 以下方法 loadAgents 不会触达，给空实现满足 ConfigService 构造签名
        getDefaultModel: () => null,
        setDefaultModel: () => undefined,
        readModels: () => ({ providers: {} }),
        getProviderConfig: () => undefined,
        upsertProvider: () => ({}),
        removeProvider: () => ({ removed: false }),
        applyTypeTranslation: (t: string) => t,
        getSkillPaths: () => [] as string[],
        setSkillPaths: () => undefined,
        addSkillPath: () => undefined,
        removeSkillPath: () => undefined,
        migrateSettingsSkillsToDiscovery: () => undefined,
        setAgentDirs: () => undefined,
        writeAgentFile: () => undefined,
        deleteAgentFile: () => false,
        getConfigDir: () => '/fake/config',
      }
    }

    it('claude 目录来源的 agent sourceType === "claude"（非 pi）', () => {
      const store = makeFakeStore([
        {
          name: 'code-review',
          path: '/home/u/.claude/agents/code-review.md',
          content: '---\nname: Code Review\n---\nreview code',
          sourceType: 'claude',
        },
      ])
      const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

      const agents = svc.loadAgents('/fake/project')
      expect(agents).toHaveLength(1)
      // 关键断言：sourceType 必须如实透传，不能恒 pi（否则 Claude tab 过滤失效）
      expect(agents[0]!.sourceType).toBe('claude')
      expect(agents[0]!.source).toBe('claude')
    })

    it('agents 目录来源的 agent sourceType === "agents"', () => {
      const store = makeFakeStore([
        {
          name: 'builder',
          path: '/home/u/.agents/agents/builder.md',
          content: '---\nname: Builder\n---\nbuild things',
          sourceType: 'agents',
        },
      ])
      const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

      const agents = svc.loadAgents('/fake/project')
      expect(agents[0]!.sourceType).toBe('agents')
      expect(agents[0]!.source).toBe('agents')
    })

    it('混合来源各自透传（claude / agents / pi 共存）', () => {
      const store = makeFakeStore([
        {
          name: 'reviewer',
          path: '/h/.claude/agents/reviewer.md',
          content: '---\nname: Reviewer\n---',
          sourceType: 'claude',
        },
        {
          name: 'planner',
          path: '/h/.agents/agents/planner.md',
          content: '---\nname: Planner\n---',
          sourceType: 'agents',
        },
        {
          name: 'default',
          path: '/h/.taiji/agent/agents/default.md',
          content: '---\nname: Default\n---',
          sourceType: 'pi',
        },
      ])
      const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

      const agents = svc.loadAgents('/fake/project')
      const byId = new Map(agents.map(a => [a.id, a]))
      expect(byId.get('reviewer')?.sourceType).toBe('claude')
      expect(byId.get('planner')?.sourceType).toBe('agents')
      expect(byId.get('default')?.sourceType).toBe('pi')
    })

    it('sourceType 缺失时兜底为 pi（向后兼容旧 entry 无此字段）', () => {
      // 旧版 agent-crud 不填 sourceType（字段缺失 = undefined，非空串）；
      // config-service 用 ?? 'pi' 兜底，避免 undefined 污染前端。
      // 注意：?? 只兜底 null/undefined，不兜底空串——而 inferSourceType 运行时
      // 至少返回 'custom'，不会产出空串，故这里只测 undefined 这条兜底路径。
      const store = makeFakeStore([
        {
          name: 'legacy',
          path: '/h/somewhere/legacy.md',
          content: '---\nname: Legacy\n---',
          sourceType: '',
        },
      ])
      // 模拟「字段缺失」：删除 sourceType（等价于旧 entry 无此字段）
      delete (store.listAgentFiles()[0] as { sourceType?: string }).sourceType
      const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

      const agents = svc.loadAgents('/fake/project')
      // undefined → 兜底 pi
      expect(agents[0]!.sourceType).toBe('pi')
      expect(agents[0]!.source).toBe('pi')
    })
  })

  // ── LLM retry 域委托（llm-retry-settings 设计 §3.4：单行委托注入 port）──────────

  describe('ConfigService · resolver 显式检查访问器（R2 S-1 修复契约机器锁定，R3 S-4 补测）', () => {
    it('两参构造 + 调 provider 三方法 → 带恢复指引的 Error（非静默成功 / 非深处 TypeError）', async () => {
      // 与上方 llmRetrySettings 未注入抛错用例同模式：少参构造 = 测试构造错误，报错指向恢复动作
      const svc = new ConfigService(tmpDir, configStore)
      const expected = '[config-service] providerCredentialResolver 未注入'
      expect(() => svc.listProviders()).toThrow(expected)
      expect(() => svc.toggleProviderEnabled('p1', true)).toThrow(expected)
      // removeProviderByKind 是 async 方法：同步段抛错 → 拒绝的 Promise，用 rejects 断言
      await expect(svc.removeProviderByKind('p1', 'custom')).rejects.toThrow(expected)
      // 恢复指引文案可操作：指向注入 resolver / 改用 provider 无关实例（错误 → 权威源 → 重试闭环）
      try {
        svc.listProviders()
        expect.unreachable('listProviders should have thrown')
      } catch (e) {
        expect((e as Error).message).toContain('注入 resolver')
        expect((e as Error).message).toContain('listProviders / toggleProviderEnabled / removeProviderByKind')
      }
    })
  })

  describe('ConfigService · LLM retry 域（llmRetrySettings port）', () => {
    it('未注入 port：getRetryConfig / setRetryConfig 抛错（可选注入防御，生产恒注入）', () => {
      // beforeEach 构造的 configService 只传 2 个参数（未注入 llmRetrySettings）
      expect(() => configService.getRetryConfig()).toThrow('[config-service] llmRetrySettings not available (getRetryConfig)')
      expect(() => configService.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1000 })).toThrow(
        '[config-service] llmRetrySettings not available (setRetryConfig)',
      )
    })

    it('注入 port：读写单行委托（参数与返回值透传，ConfigService 不做 retry 域业务）', () => {
      const snapshot: LlmRetryConfigSnapshot = {
        configured: false,
        config: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
      }
      const getRetryConfig = vi.fn(() => snapshot)
      const setRetryConfig = vi.fn((): { ok: boolean; error?: string } => ({ ok: true }))
      const svc = new ConfigService(tmpDir, configStore, undefined, undefined, {
        getRetryConfig,
        setRetryConfig,
      } as unknown as ILlmRetrySettings)

      expect(svc.getRetryConfig()).toBe(snapshot)
      expect(getRetryConfig).toHaveBeenCalledTimes(1)

      const arg: LlmRetryConfig = { enabled: true, maxRetries: 1, baseDelayMs: 1000 }
      expect(svc.setRetryConfig(arg)).toEqual({ ok: true })
      expect(setRetryConfig).toHaveBeenCalledWith(arg)
    })
  })

  // ── M2c：D3 链 5 接线（构造器注入 → listProviders 消费）────────────────────────
  // 「装配点真的传了」的落点 = ConfigService 构造器（组合根 index.ts 以第 6 参传入）与
  // listProviders 的透传。本组用真实 ConfigService 构造 + 真实 PiConfigStore，证明 resolver
  // 经构造器到达 listProvidersImpl 并真实参与凭据判定（而非只测「listProvidersImpl 注入了就生效」）。
  describe('M2c: ConfigService 构造器注入 providerCredentialResolver（D3 链 5 接线）', () => {
    /** 假 resolver：仅暴露接口三方法（批量方法返回值可控，用于证明其输出被消费）。 */
    function makeSetResolver(credentialIds: string[]) {
      const listCredentialBackedProviderIds = vi.fn(() => new Set(credentialIds))
      return {
        resolver: {
          hasProviderCredential: vi.fn(() => false),
          listCredentialBackedProviderIds,
          resolveProviderCredential: vi.fn(async () => undefined),
          resolveProviderApiKeyRaw: async () => undefined,
          resolveProviderBaseUrl: vi.fn(() => undefined),
        },
        listCredentialBackedProviderIds,
      }
    }

    it('注入后 listProviders 经 resolver 批量 sync 版判定凭据（调用 + 输出被消费）', () => {
      // 该 provider 在 models.json 无 apiKey：status=connected 只能来自 resolver 的批量结果
      writeModels({ providers: { 'custom-no-key': { name: 'NoKey', models: [{ id: 'm1' }] } } })
      refreshModels()
      const { resolver, listCredentialBackedProviderIds } = makeSetResolver(['custom-no-key'])
      const svc = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, resolver)

      const providers = svc.listProviders()

      expect(listCredentialBackedProviderIds).toHaveBeenCalledTimes(1)
      expect(providers.find(p => p.id === 'custom-no-key')?.status).toBe('connected')
      expect(providers.find(p => p.id === 'custom-no-key')?.apiKeySet).toBe(false)
    })

    it('对照：resolver 空集 → 同一份数据不判 connected（差异证明 resolver 输出被消费；M2fg 恒注入形态）', () => {
      writeModels({ providers: { 'custom-no-key': { name: 'NoKey', models: [{ id: 'm1' }] } } })
      refreshModels()
      const { resolver } = makeSetResolver([])
      const svc = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, resolver)

      const providers = svc.listProviders()

      expect(providers.find(p => p.id === 'custom-no-key')?.status).toBe('not_configured')
    })
  })
});
