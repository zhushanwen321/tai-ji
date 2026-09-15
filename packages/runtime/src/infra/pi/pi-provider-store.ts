/**
 * Pi Provider/Model/Settings Store — pi 配置文件读写层。
 *
 * 重构说明（Phase 1 拆分）：本文件曾 883 行超 ESLint max-lines(500)，现按职责拆到
 * pi-maintenance / pi-enabled-models / pi-skill-paths / pi-provider-repair。本文件保留
 * models.json 读写 + provider CRUD + defaultModel 校验 + refresh + sanitizeInvalidProviders
 *（依赖 modelsStore 模块级缓存）+ barrel re-export 保 import 路径不变，行为/签名零变化。
 */

// builtin provider catalog（QuickSetup 模板源）：sanitizeInvalidProviders 对 catalog 已知的
// 空壳 provider 合并 models 修复而非删除（对齐 config-service 的 builtinModelsById 先例）。
import builtinData from '../../generated/builtin-providers.json'
import { deriveEnabled, getMergedCatalogModels, isCatalogProvider } from '../../services/provider-catalog.js'
// 链 3（凭据读路径收口，D3）：infra 层只 type-only import 接口，不 value import 实现
// （C-comm-03；实现在 services/auth，由组合根经模块级 init setter 注入）。
import type { IProviderCredentialResolver } from '../../services/ports/provider-credential-resolver.js'
import { JsonStore } from '../../utils/json-store.js'
import { getModelsPath } from './pi-paths.js'
// settings.json 的唯一读写层（D17 收口）：readSettings/updateSettingsFields/PiSettings/缓存/
// 跨进程锁/原子写都收敛到 pi-settings-store，model 域（本文件）与 extension 域共享同一
// 所有者 + 缓存 + 锁。
import {
  readSettings,
  updateSettingsFields,
  invalidateSettingsCache,
} from './pi-settings-store.js'
// enabledModels 白名单读写（Phase 1 拆出到 pi-enabled-models）：本文件的 pickFirstModelProvider /
// findValidDefaultModel 经 getEnabledModels 派生启用状态，不直接碰 settings.enabledModels。
import { getEnabledModels } from './pi-enabled-models.js'
// provider 有效性校验（Phase 1 拆出到 pi-provider-repair）：sanitizeInvalidProviders 启动时
// 剔除空壳 provider 用。isInvalidProvider 是纯函数，不碰 modelsStore。
import { isInvalidProvider } from './pi-provider-repair.js'
import type { ProviderId } from '@taiji/shared'

// ── 类型定义（对齐 pi models.json / settings.json 的 schema）────

export interface PiModelDefinition {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  /** model 级启停（W1）。省略时默认 true，向上兼容存量数据。 */
  enabled?: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
  headers?: Record<string, string>
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  compat?: Record<string, unknown>
  thinkingLevelMap?: Record<string, string | null>
}

export interface PiProviderConfig {
  name?: string
  baseUrl?: string
  apiKey?: string
  api?: string
  /** 认证方式（寄生字段，仅存量数据兼容读）。A1 后权威存 config/providers.json（TaijiProviderStore）。 */
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  /** provider 级启停（W1）。省略时默认 true，向上兼容存量数据。 */
  enabled?: boolean
  headers?: Record<string, string>
  authHeader?: boolean
  models?: PiModelDefinition[]
  modelOverrides?: Record<string, Record<string, unknown>>
  /**
   * Coding Plan 额度查询配置（寄生字段，仅存量数据兼容读）。
   * A1 后权威存 config/providers.json（TaijiProviderStore），models.json 不再写入；
   * 此字段仅供迁移（stripParasiticFields）与迁移失败窗口的双读回退读取。
   */
  quota?: {
    /** 用户手动指定的 fetcher id（省略时 QuotaService 自动按 baseUrl/name 匹配）。 */
    fetcher?: string
    /** 是否启用额度查询。 */
    enabled: boolean
    /** cookie 类 provider 的 cookie 是否已写入 secrets（布尔态，明文不入 models.json）。 */
    cookieSet?: boolean
    /**
     * api-key 类 provider 是否有 Coding Plan 专属 API Key（明文存 secrets，不写 models.json）。
     * 未设置/false = 复用 provider.apiKey。
     */
    apiKeySet?: boolean
  }
}

export interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>
}

export type { PiSettings } from './pi-settings-store.js'

// ── 缓存 ─────────────────────────────────────────────────────
// 注：settings.json 的缓存 + readSettings/writeSettings 收敛到 pi-settings-store（D17）。
// 此处 models.json 的 read-through 缓存 + 原子读写收敛到 JsonStore（P0-1）。

/**
 * models.json 路径。生产用 getModelsPath()（= <dataDir>/agent/models.json）。
 * 测试可经 setModelsPath() 指向临时目录，与 setSettingsPath 对称。
 */
let modelsFilePath: string = getModelsPath()

/** models.json 存储：read-through（TTL 缓存 + ENOENT 容错）+ atomicWrite。 */
let modelsStore = createModelsStore(modelsFilePath)

function createModelsStore(path: string): JsonStore<PiModelsConfig> {
  return new JsonStore<PiModelsConfig>(path, { providers: {} }, {
    ttlMs: 3_000,
    deserialize: (raw): PiModelsConfig => {
      if (!raw || typeof raw !== 'object' || typeof (raw as PiModelsConfig).providers !== 'object') {
        console.warn(`[provider-store] ${path} schema 不匹配，使用 fallback`)
        return { providers: {} }
      }
      return raw as PiModelsConfig
    },
  })
}

/**
 * 覆盖 models.json 路径（仅测试用）。生产不应调用。
 * 重建 store 实例并清空缓存，确保后续读拿到新路径的文件。
 */
export function setModelsPath(path: string): void {
  modelsFilePath = path
  modelsStore = createModelsStore(path)
}

// ── Models.json 操作 ──────────────────────────────────────────

export function readModels(): PiModelsConfig {
  return modelsStore.read()
}

export function writeModels(config: PiModelsConfig): void {
  modelsStore.write(config)
}

export function getProviderNames(): string[] {
  return Object.keys(readModels().providers)
}

export function getProviderConfig(providerId: string): PiProviderConfig | undefined {
  const config = readModels().providers[providerId]
  return config ? JSON.parse(JSON.stringify(config)) : undefined
}

/**
 * 扫描 providers，返回第一个含 model 的 provider 及其第一个 model id（D10）。
 *
 * upsertProvider / removeProvider 在 default 失效时各内联了一遍同样的「找第一个有
 * models 的 provider」循环。返回 undefined 表示无可用 provider。
 */
function pickFirstModelProvider(
  providers: Record<string, PiProviderConfig>,
): { provider: ProviderId; modelId: string } | undefined {
  // A8：跳过被 enabledModels 禁用的 provider（与 findValidDefaultModel 主路径守卫一致），
  // 避免 removeProvider/upsertProvider 重选与 findValidDefaultModel fallback 选到用户已禁用的 provider。
  // enabledModels 空（全启用）时 deriveEnabled 恒 true，行为不变。重选场景 enabledModels 不变，
  // 实时读 getEnabledModels 安全（无 updateSettingsFields 回调内 stale 风险）。
  const enabledModels = getEnabledModels()
  for (const [pid, pcfg] of Object.entries(providers)) {
    if (!deriveEnabled(pid, enabledModels)) continue
    if (pcfg.models && pcfg.models.length > 0) {
      // pid 来自 models.json 磁盘 key（反序列化边界，design D5）→ as ProviderId
      return { provider: pid as ProviderId, modelId: pcfg.models[0].id }
    }
  }
  return undefined
}

/**
 * Provider 凭据解析唯一通道（D3 链 3 消费面）：模块级 init 注入（检查点 5 首选形态）。
 *
 * 为什么是模块级 setter 而非构造参数：本模块的消费点（findValidDefaultModel / getDefaultModel）
 * 是模块级函数，调用方（rpc-client spawn / session 激活 / PiConfigStore 委托）到不了构造参数。
 * 组合根（index.ts）在装配期调用 initProviderCredentialResolver，且**必须先于任何
 * findValidDefaultModel 调用**——本模块在未注入时的降级是「视为无凭据」（安全、不抛错），
 * 旧的私有裸读（直读 agentDir/auth.json）已随本单元删除——这正是要消灭的第 3 条解析链。
 * resolver 构造无 IO、读取懒发生（auth.json 经 AuthStorage 同步原语 + models.json 经 configStore）。
 */
let credentialResolver: IProviderCredentialResolver | undefined

/**
 * 注入凭据 resolver（生产 = 组合根装配期调用；测试可传 undefined 清空注入，用于断言
 * 「未注入 → 视为无凭据」的安全降级行为与装配序契约）。
 */
export function initProviderCredentialResolver(resolver: IProviderCredentialResolver | undefined): void {
  credentialResolver = resolver
}

/**
 * 更新 provider 配置并同步校验 defaultModel。
 * 全程同步（无 await），避免竞态窗口。
 */
export function upsertProvider(providerId: string, config: PiProviderConfig): {
  newDefault?: { provider: ProviderId; modelId: string }
} {
  const models: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
  models.providers[providerId] = config
  writeModels(models)

  // 同步校验 defaultModel：经 updateSettingsFields('model') 单次锁内 RMW。
  // 结果通过外层变量捕获（mutator 不返回值）。
  let outcome: { newDefault?: { provider: ProviderId; modelId: string } } = {}
  updateSettingsFields('model', s => {
    if (s.defaultProvider !== providerId) { outcome = {}; return }

    // models 未参与本次更新（partial upsert：clearApiKey 剥离 apiKey / quota 覆写 /
    // QuickSetup 保存不携带 models）时跳过 default 校验——builtin override-only provider
    // 的 models.json 条目本无 models 数组，把 undefined 视作「模型被清空」会把
    // defaultProvider/defaultModel 静默删除并回退到别的 provider（用户默认模型在 OAuth
    // 授权成功瞬间被改写，spec §8 未授权该副作用）。显式传 models（含空数组）仍走校验。
    if (config.models === undefined) { outcome = {}; return }

    const newModelList = config.models
    // catalog provider 的 models.json 条目只承载用户 override（B-2 前端保存只回传
    // override 条目，无 override 时为 []），builtin 模型不在列表内——default 校验必须以
    // 「override ∪ catalog」为有效模型列表，否则 catalog 默认 provider 保存
    // override-only 条目时 builtin 默认模型被误判失效：models:[] 会删除 default 回退到
    // 其他 provider、models:[override] 会把 defaultModel 静默改写为 override 首项
    //（round 1 review must-fix #1）。非 catalog provider catalog 集为空，行为不变。
    // D4：catalog 集改从合并视图取（fresh overlay 并入，expired/never-seen == 快照），
    // overlay-only 模型在保存校验中同样合法。
    const catalogModels = getMergedCatalogModels(providerId)?.models ?? []
    const effectiveModelList = [
      ...newModelList,
      ...catalogModels.filter(bm => !newModelList.some(m => m.id === bm.id)),
    ]
    if (effectiveModelList.length === 0) {
      delete s.defaultProvider
      delete s.defaultModel
      const fallback = pickFirstModelProvider(models.providers)
      if (fallback) {
        s.defaultProvider = fallback.provider
        s.defaultModel = fallback.modelId
      }
      outcome = s.defaultProvider
        ? { newDefault: { provider: s.defaultProvider as ProviderId, modelId: s.defaultModel! } }
        : {}
      return
    }

    const currentModelId = s.defaultModel
    if (currentModelId && !effectiveModelList.find(m => m.id === currentModelId)) {
      s.defaultModel = effectiveModelList[0].id
      console.warn(`[provider-store] defaultModel "${currentModelId}" no longer in provider "${providerId}" (overrides ∪ builtin), falling back to "${effectiveModelList[0].id}"`)
    }
    outcome = { newDefault: { provider: providerId as ProviderId, modelId: s.defaultModel! } }
  })
  return outcome
}

/**
 * 删除 provider 并同步清理 defaultProvider/defaultModel。
 * 全程同步（无 await），避免竞态窗口。
 */
export function removeProvider(providerId: string): {
  removed: boolean
  newDefault?: { provider: ProviderId; modelId: string }
} {
  const models: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
  if (!(providerId in models.providers)) return { removed: false }
  delete models.providers[providerId]
  writeModels(models)

  // 同步清理 defaultProvider/defaultModel：经 updateSettingsFields('model') 单次锁内 RMW。
  let outcome: { removed: boolean; newDefault?: { provider: ProviderId; modelId: string } } = { removed: true }
  updateSettingsFields('model', s => {
    if (s.defaultProvider !== providerId) { outcome = { removed: true }; return }
    delete s.defaultProvider
    delete s.defaultModel
    const fallback = pickFirstModelProvider(models.providers)
    if (fallback) {
      s.defaultProvider = fallback.provider
      s.defaultModel = fallback.modelId
    }
    outcome = s.defaultProvider
      ? { removed: true, newDefault: { provider: s.defaultProvider as ProviderId, modelId: s.defaultModel! } }
      : { removed: true }
  })
  return outcome
}

/**
 * 清除 provider 的 models.json apiKey（I9 both 清理②：OAuth 授权成功后清另一种凭据）。
 *
 * 语义契约（纯删键 RMW）：条目存在且含 apiKey 键时，以「去掉 apiKey 的 rest」重新 upsert——
 * 盘上结果是键被删除，**绝不写空串**（空串是 pi schema 违规值：minLength:1，会让 pi 拒绝
 * 整个 models.json）。models 未参与本次更新时 upsertProvider 的 default 校验自动跳过。
 *
 * 从组合根闭包提取为具名函数：index.ts 不可 import（import 即执行 main()），提取后 I9
 * 清理②的落盘语义（删键而非空串）可在单测中直接断言。
 */
export function clearProviderApiKey(providerId: string): void {
  const existing = getProviderConfig(providerId)
  if (!existing || !('apiKey' in existing)) return
  const { apiKey: _removed, ...rest } = existing
  upsertProvider(providerId, rest)
}

export function getAllModels(): Array<PiModelDefinition & { providerId: string }> {
  const result: Array<PiModelDefinition & { providerId: string }> = []
  const models = readModels()
  for (const [providerId, providerConfig] of Object.entries(models.providers)) {
    for (const model of providerConfig.models ?? []) {
      result.push({ ...model, providerId })
    }
  }
  return result
}

// ── Settings.json 操作 ───────────────────────────────────────
// readSettings/writeSettings/setSettingsPath 收敛到 pi-settings-store（D17 唯一读写层）；
// updateSettingsFields 不在此 re-export（零外部消费者，直接从 pi-settings-store import）。
export { readSettings, writeSettings, setSettingsPath } from './pi-settings-store.js'

/** findValidDefaultModel 主路径：defaultProvider 有 models.json override 且未被禁用时的裁定。null = 未裁定，走 fallback。 */
function adjudicateOverrideDefault(
  defaultProvider: string,
  defaultModel: string,
  providerConfig: { models?: Array<{ id: string }> },
  isEnabled: boolean,
): { result: { provider: ProviderId; modelId: string } | null; wasFixed: boolean } | null {
  if (!providerConfig?.models?.length || !isEnabled) return null
  const found = providerConfig.models.find(m => m.id === defaultModel)
  if (found) {
    // defaultProvider 来自 settings.json 磁盘读（反序列化边界，design D5）→ as ProviderId
    return { result: { provider: defaultProvider as ProviderId, modelId: defaultModel }, wasFixed: false }
  }
  // D4/D5：catalog provider 的有效模型集不止 models.json override（builtin ⊕ overlay
  // 恒在，B-2 语义）——override 未命中时以合并视图继续裁定；非 catalog provider
  // （合并视图 undefined）维持旧语义（override 即全集）。
  const mergedCatalog = getMergedCatalogModels(defaultProvider)
  if (mergedCatalog) {
    // D5 态 3（never-seen，overlay 从未见过该 provider）：pass-through——不判定有效性、
    // 不触发 auto-fix，原值直传 pi 由执行侧解析。态 3 的常态是「该 provider 从未经过
    // overlay 通道」而非「配置有误」，静默改写合法配置（失败模式 A）比让错误显式暴露更糟。
    if (mergedCatalog.overlayState.state === 'never-seen') {
      return { result: { provider: defaultProvider as ProviderId, modelId: defaultModel }, wasFixed: false }
    }
    // D5 态 1/态 2：合并视图裁定。态 2 时 overlay 已被过滤，合并视图 == 快照 → 快照裁定。
    // 附带修复：用户在 UI 选的非 override 模型（builtin/overlay 模型）不再被误判失效改写。
    if (mergedCatalog.models.some(m => m.id === defaultModel)) {
      return { result: { provider: defaultProvider as ProviderId, modelId: defaultModel }, wasFixed: false }
    }
  }
  console.warn(`[provider-store] defaultModel "${defaultModel}" not found in provider "${defaultProvider}", falling back to "${providerConfig.models[0].id}"`)
  return { result: { provider: defaultProvider as ProviderId, modelId: providerConfig.models[0].id }, wasFixed: true }
}

/**
 * findValidDefaultModel 副路径：auth.json-only catalog provider（OAuth 形态）无
 * models.json 条目时的裁定。null = 未裁定（无合并视图或无凭据或被禁用），走 fallback。
 * D5：有效集从纯快照升级为合并视图，并按 overlay 三态区分行为——
 * 态 1（fresh）合并视图判定，overlay-only 模型合法不 auto-fix；
 * 态 2（expired，含 404/501 落盘的 lastModified:0）合并视图已退化为快照 → 快照裁定，
 * 允许 auto-fix（远程明确声明过时/不存在是明确信号，快照是更权威基线）；
 * 态 3（never-seen）pass-through 不改写（见下方分支注释）。
 */
function adjudicateCatalogOnlyDefault(
  defaultProvider: string,
  defaultModel: string,
  isEnabled: boolean,
): { result: { provider: ProviderId; modelId: string } | null; wasFixed: boolean } | null {
  const mergedCatalog = getMergedCatalogModels(defaultProvider)
  if (!mergedCatalog || mergedCatalog.models.length === 0) return null
  // 链 3（D3 收口）：凭据判定经唯一通道 sync 布尔版（auth.json → models.json 双源），
  // 未注入 resolver 时视为无凭据（安全降级：不抛错、不误选，装配序由组合根保证）。
  const hasCredential = credentialResolver?.hasProviderCredential(defaultProvider) ?? false
  if (!hasCredential || !isEnabled) return null
  // D5 态 3（never-seen）：pass-through——不判定有效性、不触发 auto-fix、不改写
  // settings.json，`--model` 直传 pi 由执行侧解析（模型确实不存在时 pi 报
  // model-not-found，错误 surfaced 给用户而非 taiji 静默改写；垃圾模型名的 auto-fix
  // 「救回」被有意放弃，见设计 D5 态 3 trade-off）。
  if (mergedCatalog.overlayState.state === 'never-seen') {
    return { result: { provider: defaultProvider as ProviderId, modelId: defaultModel }, wasFixed: false }
  }
  // D5 态 1/态 2：合并视图判定（态 2 == 快照裁定）
  const foundInCatalog = mergedCatalog.models.find(m => m.id === defaultModel)
  if (foundInCatalog) {
    return { result: { provider: defaultProvider as ProviderId, modelId: defaultModel }, wasFixed: false }
  }
  // defaultModel 不在有效集（真无效），用有效集第一个（快照打底，[0] 恒为快照首模型）
  return { result: { provider: defaultProvider as ProviderId, modelId: mergedCatalog.models[0].id }, wasFixed: true }
}

/**
 * catalog 兜底：models.json 无可用 provider 时，查 builtin-providers 副本找
 * 「凭据可解析」的 catalog provider 作默认候选（决策 4：校验 auth.json credential /
 * models.json apiKey 任一）。遍历而非取排序第一个——amazon-bedrock 等 ambient 认证
 * provider 无凭据时不可用，不能作为默认。
 * wasFixed=false：兜底是临时展示，不是配置修复——写回 settings.json 会污染用户配置
 * （曾踩坑：兜底结果经 updateSettingsFields 覆盖用户默认 provider，见 2026-08-09 回归）。
 */
function pickCredentialBackedCatalogProvider(): {
  result: { provider: ProviderId; modelId: string } | null
  wasFixed: boolean
} { // eslint-disable-line indent -- standard TS function signature with multi-line return type
  const builtinProviders = (builtinData.providers ?? []) as Array<{
    id: string
    models?: Array<{ id: string }>
  }>
  // 链 3（D3 收口）：遍历 39 个 builtin 候选用**批量形态**——auth.json / models.json 各单次
  // 读盘（B3 先例：消除 N+1；逐个 hasProviderCredential 会对 auth.json 做 N 次同步读）。
  // 未注入 resolver 时视为无凭据（安全降级：不抛错、不误选）。
  const credentialBackedIds = credentialResolver?.listCredentialBackedProviderIds() ?? new Set<string>()
  for (const bp of builtinProviders) {
    const hasCredential = credentialBackedIds.has(bp.id)
    // ES3：被 enabledModels 禁用的 catalog provider 不作 default 候选（避免返回用户已禁用的 provider）。
    // deriveEnabled 复用 listProviders 的启用判定（DM3），保持「可用 provider」语义一致。
    if (hasCredential && deriveEnabled(bp.id, getEnabledModels()) && bp.models && bp.models.length > 0) {
      return {
        // bp.id 来自 builtin-providers.json 磁盘读（反序列化边界，design D5）→ as ProviderId
        result: { provider: bp.id as ProviderId, modelId: bp.models[0].id },
        wasFixed: false,
      }
    }
  }
  return { result: null, wasFixed: false }
}

/**
 * 纯校验：检查 defaultProvider/defaultModel 在 models.json 中是否有效。
 * 无副作用，不修改任何文件。
 */
export function findValidDefaultModel(): {
  result: { provider: ProviderId; modelId: string } | null
  wasFixed: boolean
} { // eslint-disable-line indent -- standard TS function signature with multi-line return type
  const settings = readSettings()
  const models = readModels()
  const { defaultProvider, defaultModel } = settings

  if (defaultProvider && defaultModel) {
    const providerConfig = models.providers[defaultProvider]
    // A8：被 enabledModels 禁用的 default provider 不走主路径，fall through 到 fallback 重选
    // （主路径原只校验 provider/model 有效，未过滤 enabledModels，被禁用的 default 会直接返回）。
    const isEnabled = deriveEnabled(defaultProvider, getEnabledModels())
    const overrideOutcome = adjudicateOverrideDefault(defaultProvider, defaultModel, providerConfig, isEnabled)
    if (overrideOutcome) return overrideOutcome
    if (!providerConfig?.models?.length) {
      // D3 修复：auth.json-only catalog provider（OAuth 形态）无 models.json 条目时，
      // 校验 defaultModel ∈ 该 provider 的有效模型集，通过则不 fallback 不写回。
      const catalogOnlyOutcome = adjudicateCatalogOnlyDefault(defaultProvider, defaultModel, isEnabled)
      if (catalogOnlyOutcome) return catalogOnlyOutcome
      console.warn(`[provider-store] defaultProvider "${defaultProvider}" not found in models.json`)
    }
    // isEnabled===false：default provider 被禁用，静默 fall through 到 fallback（不 warn 误导）
  }

  const fallback = pickFirstModelProvider(models.providers)
  if (fallback) {
    return { result: { provider: fallback.provider, modelId: fallback.modelId }, wasFixed: true }
  }

  return pickCredentialBackedCatalogProvider()
}

/**
 * 获取默认模型，带有效性校验和自动修复。
 */
export function getDefaultModel(): { provider: ProviderId; modelId: string } | null {
  const { result, wasFixed } = findValidDefaultModel()
  if (wasFixed && result) {
    updateSettingsFields('model', s => {
      s.defaultProvider = result.provider
      s.defaultModel = result.modelId
    })
    // warn 非 log：auto-fix 是对用户配置的改写，必须显著可见（G2/D5——态 2 唯一例外
    // 伴随 console.warn；验收 A9 以「日志有 auto-fix 记录」为通过标准之一）
    console.warn(`[provider-store] auto-fixed defaultModel: ${result.provider}/${result.modelId}`)
  }
  return result
}

export function setDefaultModel(provider: ProviderId, modelId: string): void {
  updateSettingsFields('model', s => {
    s.defaultProvider = provider
    s.defaultModel = modelId
  })
}

export function getDefaultThinkingLevel(): string {
  return readSettings().defaultThinkingLevel ?? 'high'
}

export function setDefaultThinkingLevel(level: string): void {
  updateSettingsFields('model', s => { s.defaultThinkingLevel = level })
}

// ── models.json 无效 provider 清理（重装后 "Model not found" 自愈）──────
//
// 背景见下 sanitizeInvalidProviders JSDoc（bundled pi 0.80.3 严格校验空壳 provider 致整个 models.json 加载失败）。
//
// MF-5（R3 review）：catalog 已知内置 provider 的空壳不删除——QuickSetup 保存 baseUrl
// 为空串模板（amazon-bedrock/azure-openai-responses/cloudflare-*/google-vertex/opencode* 等
// 7 个）时条目五字段全缺，旧实现重启即删除（用户刚保存的 apiKey/authMethod 静默丢失）。
// 这类空壳从 catalog 合并 models 修复（模型级 baseUrl 由 catalog 提供），保留用户数据且
// 仍满足 bundled pi 严格校验；非 catalog 的空壳（外部脚本 fixture）维持删除语义。
// [W1b 语义变更] 无效判定已对齐 pi 0.84.1 八字段（isInvalidProvider，锚点见
// pi-provider-repair.ts）：QuickSetup 条目通常含 apiKey → 直接合法，不再进修复路径；
// 修复路径仅剩八字段全缺（连 apiKey 都无）的 catalog 空壳。曾被旧五字段判定误删的
// 配置不追溯恢复（known-issue，见 pi-provider-repair.ts）。
// MF-6（R4 review）：修复前提是 catalog models 每个模型都有可用 baseUrl（见下）。
// azure-openai-responses 的 38 个 catalog models 全为空串 baseUrl，合并即毒化 pi 组合，
// 排除出修复名单（维持删除语义）——目录中不存在任何可用 baseUrl 数据。

/**
 * 快照 catalog 索引（provider id → 快照 models），仅剩 sanitizeInvalidProviders 空壳
 * 修复在用（MF-5）。
 *
 * 为什么修复路径不用合并视图（D4；[D7 前提更新]）：修复是**写盘动作**，其输入必须是
 * 与运行期缓存状态无关的确定性数据源——MF-6 守卫要求 catalog models 每个模型都有真实
 * baseUrl（every(m => !!m.baseUrl)），编译期快照（构建期权威）满足该要求；合并视图不满足：
 * overlay never-seen/expired 时它退化为快照、fresh 时混入远程模型，修复名单随运行期缓存
 * 漂移（同一份 models.json 在不同启动时刻可能得到「修复」与「删除」两种处置），用户数据
 * 丢失风险正来自这种不确定性。故修复数据源固定为编译期快照。
 *
 * [HISTORICAL] 本注释原论证前提是「overlay 条目归一化时 baseUrl 缺省填 ''，混入合并视图会
 * 让 every(!!baseUrl) 误判」——该前提随设计 D7（overlayToCatalogModel 不再产空串）失效。
 * 判据换成「数据源的确定性 + 构建期权威」，不依赖 overlay 会不会填空串这一会漂移的细节。
 *
 * 默认模型有效性判定（upsertProvider / findValidDefaultModel）已改走
 * getMergedCatalogModels 合并视图单点（D4/D5），不再消费本索引。
 */
const snapshotCatalogModelsById = new Map<string, PiModelDefinition[]>(
  (builtinData.providers ?? []).map(p => [p.id, p.models] as [string, PiModelDefinition[]]),
)

/**
 * 清洗段的 providers.json 标记读取注入面（设计 D2 分层约束，审查 R3-3）。
 *
 * providers.json 的唯一读写者是 services 层 TaijiProviderStore（C-comm-03）——本层（infra/pi）
 * 不得 value import 其实现，标记读取经调用方注入的同步原语（与 TaijiProviderStore.getExtrasSync
 * 同形）。判定语义 = **仅存在性**（键在不在），禁按值比对（标记值 stale 不影响判定）。
 */
export interface SanitizeProviderMarkerReader {
  getExtrasSync: (providerId: string) => { gatewayBaseUrl?: string } | undefined
}

/** sanitizeInvalidProviders 结果（removed/repaired 为既有语义，新增待清标记清单）。 */
export interface SanitizeInvalidProvidersOutcome {
  /** 被剔除（非 catalog 空壳 / catalog 无可修复模型）的 provider id。 */
  removed: string[]
  /** 被修复（合并快照 catalog models）的 catalog 空壳 provider id。 */
  repaired: string[]
  /**
   * 待清 extras 网关标记清单（设计 D2② 写读错位）：extras 有 gatewayBaseUrl 标记、但
   * models.json 条目无 baseUrl 键（写序契约「先写标记、后写 models.json」的崩溃中间态）。
   * 清标记是 **async 锁内写**，不在同步清洗段执行——由调用方（组合根启动流程）编排
   * `extrasStore.modify`。
   */
  staleGatewayMarkers: string[]
}

/**
 * pi schema 的 `minLength: 1` 字段集（node_modules 实装 model-config.js:137-140 模型级 /
 * :170-173 provider 级）——这些字段写入空串会让 pi TypeBox 校验拒绝**整个** models.json（P-poison 实测）。
 * 模型级 `id` 是必需字段（不在「删键」组，见 stripEmptyStringSchemaKeys）。
 */
const EMPTY_STRING_PROVIDER_KEYS = ['name', 'baseUrl', 'apiKey', 'api'] as const
const EMPTY_STRING_MODEL_KEYS = ['name', 'api', 'baseUrl'] as const

/**
 * D2① 空串键剥除（幂等）：pi minLength:1 全集字段值为空串（trim 后同视——拦纯空白串）
 * 即删该键。模型级 `id` 例外：空 id 的模型无有效标识，整条丢弃（只删键会留下无 id 条目，
 * 同样过不了 pi 校验；与 M1b 写侧防线 translateModelSchemaFields 同口径）。
 *
 * 就地改写 cfg，返回被剥除的键路径（诊断日志用，形如 `baseUrl` / `models[0].api`；
 * 空数组 = 无剥除 = 不触发写盘）。
 */
function stripEmptyStringSchemaKeys(cfg: PiProviderConfig): string[] {
  const raw = cfg as Record<string, unknown>
  const stripped: string[] = []
  for (const key of EMPTY_STRING_PROVIDER_KEYS) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim() === '') {
      delete raw[key]
      stripped.push(key)
    }
  }
  if (Array.isArray(raw.models)) {
    const kept: unknown[] = []
    raw.models.forEach((model, index) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) {
        kept.push(model) // 非对象模型不归本清洗段管（pi schema 层拒绝）
        return
      }
      const m = model as Record<string, unknown>
      if (typeof m.id === 'string' && m.id.trim() === '') {
        stripped.push(`models[${index}].id`)
        return // 空 id 模型整条丢弃
      }
      for (const key of EMPTY_STRING_MODEL_KEYS) {
        const value = m[key]
        if (typeof value === 'string' && value.trim() === '') {
          delete m[key]
          stripped.push(`models[${index}].${key}`)
        }
      }
      kept.push(m)
    })
    raw.models = kept
  }
  const overrides = raw.modelOverrides
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [modelId, override] of Object.entries(overrides as Record<string, unknown>)) {
      if (!override || typeof override !== 'object' || Array.isArray(override)) continue
      const o = override as Record<string, unknown>
      if (typeof o.name === 'string' && o.name.trim() === '') {
        delete o.name
        stripped.push(`modelOverrides.${modelId}.name`)
      }
    }
  }
  return stripped
}

/**
 * D2② catalog 条目的 provider 级键处置（设计 D2，判定锚 = extras 的 gatewayBaseUrl 标记，
 * **仅存在性判定**）：
 * - `api` 键一律剥除——taiji 对 catalog 的 provider 级 api 无合法写入通道（编辑体撤输入框 /
 *   QuickSetup 死键清理 / importer 走写入策略后不写），保留只会成为「pi 消费（override 模型
 *   协议缺省）但 taiji 不展示」的不可见生效配置；
 * - `baseUrl` 键：有标记 = 用户网关 → 保留；无标记 = 冻结 artifact / 模板默认值 → 剥除。
 *
 * 就地改写 cfg，返回被剥除的 provider 级键（诊断日志用）。
 */
function stripCatalogProviderLevelKeys(cfg: PiProviderConfig, hasGatewayMarker: boolean): string[] {
  const raw = cfg as Record<string, unknown>
  const stripped: string[] = []
  if (raw.api !== undefined) {
    delete raw.api
    stripped.push('api')
  }
  if (raw.baseUrl !== undefined && !hasGatewayMarker) {
    delete raw.baseUrl
    stripped.push('baseUrl')
  }
  return stripped
}

// ── 启动清洗 · 条目级处理段（从 sanitizeInvalidProviders 提取；执行顺序契约见主函数）──

/**
 * 单条目清洗结果累积器（sanitizeInvalidProviders 拆分后的状态载体）：前三个数组即返回值字段，
 * strippedAny = 本条目有键剥除（触发写盘）。
 */
interface SanitizeAccumulator {
  removed: string[]
  repaired: string[]
  staleGatewayMarkers: string[]
  strippedAny: boolean
}

/**
 * cfg 是可写对象判定（非 null / 非数组）——原内联句 `cfg && typeof cfg === 'object' &&
 * !Array.isArray(cfg)` 的命名谓词，判定不变（JSON.parse 结果的实际形状不可信，故保留运行时守卫）。
 */
function isPlainProviderRecord(cfg: unknown): cfg is PiProviderConfig {
  return !!cfg && typeof cfg === 'object' && !Array.isArray(cfg)
}

/**
 * D2① 空串键剥除（顺序契约第一步）：pi minLength:1 字段集空串键删键 + 模型级空 id 整条丢弃
 * （见 stripEmptyStringSchemaKeys），命中才记日志并置写盘标记。
 */
function stripEmptyStringKeysForEntry(id: string, cfg: PiProviderConfig, acc: SanitizeAccumulator): void {
  const strippedKeys = stripEmptyStringSchemaKeys(cfg)
  if (strippedKeys.length === 0) return
  acc.strippedAny = true
  console.log(`[provider-repair] stripped empty-string schema keys on "${id}": ${strippedKeys.join(', ')}`)
}

/**
 * D2② catalog 条目的 provider 级键处置（顺序契约第二步，均先于既有空壳判定）：判定锚 = extras
 * 的 gatewayBaseUrl 标记（仅存在性判定，禁按值比对）；api 一律剥除 / baseUrl 按标记保留。
 *
 * 写读错位（写序契约崩溃中间态：标记在、models.json 无 baseUrl 键）→ 待清清单；清标记的 async
 * 锁内写归调用方（本段同步，不在此写 extras）。
 */
function stripCatalogEntryKeys(
  id: string,
  cfg: PiProviderConfig,
  deps: SanitizeProviderMarkerReader | undefined,
  acc: SanitizeAccumulator,
): void {
  if (!isCatalogProvider(id)) return
  const hasGatewayMarker = deps?.getExtrasSync(id)?.gatewayBaseUrl !== undefined
  const strippedProviderKeys = stripCatalogProviderLevelKeys(cfg, hasGatewayMarker)
  if (strippedProviderKeys.length > 0) {
    acc.strippedAny = true
    console.log(`[provider-repair] stripped unmarked provider-level keys on "${id}": ${strippedProviderKeys.join(', ')}`)
  }
  if (hasGatewayMarker && (cfg as Record<string, unknown>).baseUrl === undefined) {
    acc.staleGatewayMarkers.push(id)
  }
}

/**
 * 既有空壳判定 + 修复/删除（顺序契约第三步，MF-5 语义不变）：catalog 已知内置 provider 的空壳
 * → 合并 catalog models 修复（保留 name/authMethod 等既有字段；[W1b 语义变更] 含 apiKey 的
 * 条目直接合法，不进此分支）。
 *
 * MF-6（R4 review）：catalog models 含空 baseUrl 的 provider 不可修复——pi modelFromJson
 * 对每个自定义模型强制非空 baseUrl（空串非 nullish，`??` 不跳过 → 直接 throw），任一空
 * baseUrl 模型即毒化整个 provider 组合（composeModelProvider 抛错 → pi 回退 builtin base，
 * 用户 apiKey 静默失效且条目 isInvalidProvider===false 无自愈路径）。这类 provider
 * （azure-openai-responses 38/38 模型空 baseUrl）维持删除语义；过滤空 baseUrl 模型会退回
 * models:[] 八字段全缺态再次被删（transient 非法态），合成 baseUrl 不可接受（catalog 无数据）。
 */
function repairOrRemoveInvalidEntry(
  id: string,
  cfg: PiProviderConfig,
  draft: PiModelsConfig,
  acc: SanitizeAccumulator,
): void {
  if (!isInvalidProvider(cfg)) return
  const catalogModels = snapshotCatalogModelsById.get(id)
  if (catalogModels && catalogModels.length > 0 && catalogModels.every(m => !!m.baseUrl)) {
    draft.providers[id] = { ...cfg, models: catalogModels }
    acc.repaired.push(id)
    return
  }
  delete draft.providers[id]
  acc.removed.push(id)
}

/** 写盘守卫：有删除/修复/剥除才触发出盘；无变化 = 不写（幂等）。 */
function hasSanitizeChanges(acc: SanitizeAccumulator): boolean {
  return acc.removed.length > 0 || acc.repaired.length > 0 || acc.strippedAny
}

/** 清洗结果日志：removed/repaired 各自非空才打（文案与顺序不变，均在 writeModels 之后）。 */
function logSanitizeOutcome(acc: SanitizeAccumulator): void {
  if (acc.removed.length > 0) {
    console.log('[provider-store] sanitized invalid providers:', acc.removed)
  }
  if (acc.repaired.length > 0) {
    console.log('[provider-store] repaired catalog-known invalid providers (merged builtin models):', acc.repaired)
  }
}

/**
 * 启动时清理 models.json 里的无效 provider（八字段全缺的空壳，判定 = isInvalidProvider，
 * 对齐 pi 0.84.1 applyModelsJson 抛错条件，锚点与 known-issue 见 pi-provider-repair.ts）。
 *
 * 注：本函数的 `isInvalidProvider` 判定与 services 层防线载体的 `hasSubstantiveProviderFields`
 * （provider-config-helper.ts，八字段任一在场即非空壳）是**双份本地复刻**——C-comm-03 分层约束
 * 下 services 不可 value import 本层，两侧必须保持同口径，任一改动须同步另一侧。
 *
 * 修复根因（历史）：空壳 provider（如仅 {name}，八字段全缺）导致 bundled pi 0.80.3
 * 严格校验时整个 models.json 加载失败。系统 pi 0.83 对此容错但 bundled 0.80.3 不容错，
 * 重装后切换 bundled pi 必现 "Model not found"。本函数让 taiji 自愈这种脏数据。
 *
 * [W1b 语义变更] 0.84.1 判定放宽为八字段（apiKey/oauth/authHeader 在场即合法）：
 * 只配 apiKey 的合法 provider 不再被删（旧五字段判定的误删是数据丢失级 bug，审计 A-02；
 * 被误删数据不追溯恢复——known-issue 见 pi-provider-repair.ts）。
 *
 * MF-5：catalog 已知内置 provider 的空壳不删除，合并 catalog models 修复（条目合法化，
 * name/authMethod 等既有字段保留，模型级 baseUrl 由 catalog 提供）。[W1b 语义变更]
 * QuickSetup 保存的条目含 apiKey 时直接合法、不进修复路径；修复路径仅剩无 apiKey 的
 * catalog 空壳。非 catalog 空壳维持删除语义（外部 fixture 不留存）。
 * MF-6：修复前提是 catalog models 每个模型均有非空 baseUrl（pi modelFromJson 对空 baseUrl
 * 直接 throw，毒化整个 provider 组合且无自愈路径）。catalog models 含空 baseUrl 的 provider
 * （azure-openai-responses）排除出修复名单，维持删除语义；catalog 未来补全 baseUrl 后自动恢复修复。
 *
 * [D2 新增] 清洗顺序契约（设计 catalog-provider-field-authority v3.3 §3.3 D2）：先 ① 空串键剥除、
 * 再 ② catalog 条目的 provider 级键处置（api 一律剥除 / baseUrl 按 extras 网关标记），最后做
 * **既有**空壳判定/修复（MF-5 语义不变）——剥完只剩 name 的条目由既有修复分支接管，不新增第三套
 * 空壳语义。② 的判定锚 = providers.json extras 的 gatewayBaseUrl 标记（仅存在性），标记读取经
 * deps 注入；「清多余标记」是 async 锁内写，本函数只产出 staleGatewayMarkers 清单由调用方编排。
 *
 * 启动时一次性调用（index.ts cleanLeakedPackages 之后）。幂等：无剥除/无效 provider 时不触发写。
 * 永不抛错：失败仅 warn 不阻塞启动（对齐 cleanLeakedPackages ES1 风格）。
 *
 * @param deps 注入的 providers.json 标记读取原语（见 SanitizeProviderMarkerReader）；缺省 = 无标记
 */
export function sanitizeInvalidProviders(
  deps?: SanitizeProviderMarkerReader,
): SanitizeInvalidProvidersOutcome {
  try {
    modelsStore.invalidate()
    const draft: PiModelsConfig = JSON.parse(JSON.stringify(readModels()))
    const acc: SanitizeAccumulator = { removed: [], repaired: [], staleGatewayMarkers: [], strippedAny: false }
    for (const [id, cfg] of Object.entries(draft.providers)) {
      // ① 空串键剥除 + ② catalog provider 级键处置（顺序契约：均先于下方既有空壳判定）
      if (isPlainProviderRecord(cfg)) {
        stripEmptyStringKeysForEntry(id, cfg, acc)
        stripCatalogEntryKeys(id, cfg, deps, acc)
      }
      repairOrRemoveInvalidEntry(id, cfg, draft, acc)
    }
    if (hasSanitizeChanges(acc)) {
      writeModels(draft)
      logSanitizeOutcome(acc)
    }
    return { removed: acc.removed, repaired: acc.repaired, staleGatewayMarkers: acc.staleGatewayMarkers }
  } catch (e) {
    // best-effort 降级：models.json 异常不阻塞启动（pi 自身加载时也会容错或报错）
    console.warn('[provider-store] sanitizeInvalidProviders failed:', e)
    return { removed: [], repaired: [], staleGatewayMarkers: [] }
  }
}

// ── 缓存控制 ─────────────────────────────────────────────────

export function refreshModels(): void {
  modelsStore.invalidate()
}

export function refreshSettings(): void {
  // settings.json 缓存归属 pi-settings-store（D17），这里委托失效。
  invalidateSettingsCache()
}

export function refreshAll(): void {
  refreshModels()
  refreshSettings()
}

// ── Barrel re-export（Phase 1 拆分：保 import 路径不变）──────────────────
// 以下函数已拆到 pi-maintenance / pi-enabled-models / pi-skill-paths / pi-provider-repair，
// re-export 保 import 路径不变（现有测试零改动即全绿 = 行为零变化证据）。
export { isLeakedPackage, cleanLeakedPackages } from './pi-maintenance.js'
export {
  getEnabledModels,
  setEnabledModels,
  clearEnabledModels,
  ensureProviderInWhitelist,
  cleanEnabledModelsResidue,
} from './pi-enabled-models.js'
export {
  getSkillPaths,
  getSkillPathScopes,
  setSkillPaths,
  addSkillPath,
  removeSkillPath,
  migrateSettingsSkillsToDiscovery,
} from './pi-skill-paths.js'
export { isInvalidProvider }
