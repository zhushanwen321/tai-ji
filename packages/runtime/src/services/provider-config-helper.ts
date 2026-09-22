/**
 * Provider CRUD + 双体系聚合 helper（从 config-service.ts 抽出，控 max-lines 500）。
 * 含 provider 增删改查 + catalog∪custom 双源聚合 + builtin 模板 + env 检测 + 默认模型。
 * setProvider/listProviders 同属「provider CRUD + 双体系聚合」高内聚（共享 builtin 索引与
 * ProviderInfo 构造逻辑），不再细分。ConfigService 仅保留单行委托，行为/签名/import 零变化
 *（复用 worktree-config-helper accessors 注入模式，依赖经 configStore/authStorage 参数注入）。
 */
// wave 2（WC1）：import inline 方式消费 generated JSON——tsup bundle 把 JSON 打进 index.cjs，
// 避免运行时 fs/路径解析（打包后 asar 路径问题）。tsc 类型检查需 resolveJsonModule（tsconfig.json 已加）。
import builtinData from '../generated/builtin-providers.json'
import { type ProviderInfo, type BuiltinProviderTemplate, type ProviderId } from '@taiji/shared'
import { isCatalogProvider, deriveEnabled, getMergedCatalogModels } from './provider-catalog.js'
// U6①：模型项 id 谓词（写侧与启动清洗侧共享单点，分层说明见该模块 JSDoc）
import { normalizeModelIdOrReject } from './provider-model-item.js'
export { normalizeModelIdOrReject }
import type { IConfigStore, ConfigModelDefinition, ConfigProviderConfig, UpsertProviderResult } from './ports/config.js'
import type { AuthStorage, CredentialWriter } from './auth/auth-storage.js'
import type { TaijiProviderStore, ProviderExtras } from './provider-extras-store.js'
import { readAllExtrasWithFallback, type ProviderExtrasReader } from './migration/provider-extras-migration.js'
import { pickModelCapabilityFields } from './model-mapper.js'
import type { IProviderCredentialResolver } from './ports/provider-credential-resolver.js'

/** auth.json 存储能力（ConfigService 注入，与 ConfigService 构造函数 authStorage 同构）。
 * 不含 'set'——写入唯一经 credentialWriter（A1-4 收口，AuthService.saveCredential）。 */
type AuthStorageAccessors = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>

/**
 * providers.json 存储能力（ConfigService 注入，A1-5 写侧切换）。
 * getExtrasSync：modelStates 清理的写入守卫先读（避免无谓写盘/空条目）。
 * cleanScopedModelsResidue：scoped-model——删除链清顶层 scopedModels 中该 provider 条目。
 */
export type ProviderExtrasAccessors = Pick<TaijiProviderStore, 'modify' | 'getExtrasSync' | 'cleanScopedModelsResidue'>

/**
 * providers.json 删除链清理能力（deleteProvider / removeProviderByKind 消费）。
 * M5-05「清残留」不变式扩展到 extras：delete 清 per-provider extras 条目
 * （quota/modelStates/authMethod 不残留，同 id 重建不静默继承旧配置）；
 * cleanScopedModelsResidue（scoped-model）清顶层 scopedModels 的 `providerId/` 前缀条目。
 */
export type ProviderExtrasDeleter = Pick<TaijiProviderStore, 'delete' | 'cleanScopedModelsResidue'>

/**
 * ConfigService 构造器注入的 providers.json 全量能力（四类能力组合，能力分域语义见
 * 各自类型注释）：写（modify）/ 读（getExtrasSync+readAllSync 双读回退）/ 删除链清理
 * （delete + cleanScopedModelsResidue）/ scopedModels 顶层读写。
 */
export type ProviderExtrasServiceDeps = ProviderExtrasAccessors & ProviderExtrasDeleter & ProviderExtrasReader
  & Pick<TaijiProviderStore, 'getScopedModelsSync' | 'modifyScopedModels'>

/**
 * quota 副产物清理回调（D12/改动 5，生产形态 = QuotaService.clearProviderState 绑定）。
 * 清除内容：`secrets/<pid>-{cookie,apikey}.txt` 明文 + 内存 lastFailure/lastFetchTime
 * + 额度缓存条目。经 ConfigService.setQuotaStateCleaner 后置回填——ConfigService 不反依赖
 * QuotaService（后者构造依赖前者）；删除链在 extras 条目确认清除后才调用（排序约束见
 * cleanDeleteTail）。
 */
export type QuotaStateCleaner = (providerId: string) => Promise<void>

/** setProvider 的入参形状（原 ConfigService.setProvider 内联类型提取，逐字一致）。 */
export type SetProviderInput = {
  name?: string
  type?: string
  apiKey?: string
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  baseUrl?: string
  /** provider 级自定义请求头（B-4a，pi ProviderConfigSchema 内字段）。 */
  headers?: Record<string, string>
  /** 是否把 apiKey 写入 Authorization header（B-4a，pi ProviderConfigSchema 内字段）。 */
  authHeader?: boolean
  models?: Array<string | { id: string; name?: string; api?: string; baseUrl?: string; reasoning?: boolean; maxTokens?: number; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null>; enabled?: boolean; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> }; headers?: Record<string, string>; compat?: Record<string, unknown> }>
  enabled?: boolean
}

/**
 * BuiltinModelSummary → ProviderInfo.models 元素形状（T9 合并兜底用）。
 * 差异：BuiltinModelSummary.input 是 string[]（恒输出 11 键），ProviderInfo 元素 input 是
 * Array<'text' | 'image'>——过滤 + null→undefined 归一。
 * A1-3：builtin 副本同样应用 modelStates（providers.json 模型启停对 catalog 内置模型
 * 生效）；有值才设 enabled（与 builtin 模板无 enabled 字段的现状一致，消费方
 * `enabled !== false` 兼容 undefined）。
 */
function toProviderModel(
  m: BuiltinProviderTemplate['models'][number],
  modelStates?: Record<string, { enabled: boolean }>,
): ProviderInfo['models'][number] {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: m.input.filter((v): v is 'text' | 'image' => v === 'text' || v === 'image'),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens ?? undefined,
    thinkingLevelMap: m.thinkingLevelMap ?? undefined,
    compat: m.compat ?? undefined,
    ...(modelStates?.[m.id] !== undefined ? { enabled: modelStates[m.id].enabled } : {}),
  }
}

/** builtin provider id → 完整模板索引（wave2 catalog 源聚合用；T9/M5 合并兜底取 .models 同源）。 */
const builtinProvidersById = new Map<string, BuiltinProviderTemplate>(
  (builtinData.providers ?? []).map(p => [p.id, p as unknown as BuiltinProviderTemplate]),
)

/**
 * ConfigModelDefinition → ProviderInfo.models 元素（wave2 双源共用，提取 custom 内联逻辑避免重复）。
 * A1-3 读源切换：model 级 enabled 以 providers.json modelStates 优先（迁移后唯一来源），
 * models.json m.enabled 兜底（迁移失败窗口 + setProvider 仍写 m.enabled 的写侧残留路径）。
 */
function toUserInfoModel(
  m: ConfigModelDefinition,
  modelStates?: Record<string, { enabled: boolean }>,
): ProviderInfo['models'][number] {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    input: m.input,
    compat: m.compat,
    // model 级 headers 读侧透传（B-4b 与写路径对称）：ModelInfo 无此字段，故不走
    // pickModelCapabilityFields（双映射共用 picker，加进去会给 ModelInfo 塞未声明字段），
    // 与 compat/api/baseUrl 同款在此显式透传。undefined 消费方按缺省处理（向后兼容）。
    headers: m.headers,
    enabled: modelStates?.[m.id]?.enabled ?? (m.enabled !== false),
    ...pickModelCapabilityFields(m),
  }
}

/**
 * 按 models.json config 推断 authMethod（I6：$开头→env_var / 非空→api_key）。
 * 显式标注（extras.authMethod，providers.json 优先 + models.json 旧字段兜底）在聚合层
 * 优先于本推断（A1-3）；本函数不再读 config.authMethod——双读回退已覆盖该值，且
 * 「providers.json 已有条目时丢弃 models.json 旧值」的合并策略要求标注不穿透
 * （防 stale 旧值复活）。config 缺省→undefined。
 */
function deriveAuthMethod(config?: ConfigProviderConfig): ProviderInfo['authMethod'] {
  if (!config) return undefined
  return typeof config.apiKey === 'string' && config.apiKey.startsWith('$')
    ? 'env_var' as const
    : config.apiKey ? 'api_key' as const : undefined
}

/** Runtime type guard for thinkingLevelMap values. */
function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => val === null || typeof val === 'string')
}

/**
 * headers 校验 + prototype-pollution 清洗（B-4a/B-4b，对齐 compat 的 sanitize 模式：
 * 类型守卫通过后、赋值前剔除 __proto__/prototype/constructor）。
 * 与 compat 的差异：headers 契约是 Record<string, string>，value 非 string 直接 throw
 * （pi schema Type.Record(String, String)——静默剔除坏 value 会让「保存成功但 header 丢失」
 * 无从排查）；compat value 是 unknown 只剔 undefined。
 */
function sanitizeHeaders(v: unknown, ctx: string): Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`Invalid ${ctx}: expected Record<string, string>`)
  }
  const sanitized: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue
    if (typeof val !== 'string') {
      throw new Error(`Invalid ${ctx}: value of "${k}" must be a string`)
    }
    sanitized[k] = val
  }
  return sanitized
}

/**
 * model 级 cost 校验（B-4b）。pi 0.84.1 ModelDefinitionSchema 的 cost 四字段是必填
 * `Type.Number()`（model-config.js ModelCostSchema）——缺字段或非法类型写入会让 pi 拒载
 * 整个 models.json，故此处 throw 而非静默丢弃。非负校验：价格为负无业务语义。
 * tiers 可选透传（存在时必须是数组，元素结构由 pi schema 自行把关）。
 */
function sanitizeModelCost(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`Invalid ${ctx}: expected an object with input/output/cacheRead/cacheWrite numbers`)
  }
  const raw = v as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const val = raw[field]
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
      throw new Error(`Invalid ${ctx}: field "${field}" must be a non-negative number`)
    }
    result[field] = val
  }
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) {
      throw new Error(`Invalid ${ctx}: "tiers" must be an array`)
    }
    result.tiers = raw.tiers
  }
  return result
}

/**
 * modelStates 按保留集合重建（S2，round 1 review suggestion）：retainIds 外的键剔除
 * （已删除模型的启停残留），retainIds 内 updates 优先、current 兜底（未显式传 enabled
 * 的模型保留既有状态）。结果为空（保留集合内无任何状态）返回 undefined——调用方据此
 * 不落 modelStates 字段。
 */
function mergeModelStates(
  current: Record<string, { enabled: boolean }> | undefined,
  updates: Record<string, { enabled: boolean }>,
  retainIds: ReadonlySet<string>,
): Record<string, { enabled: boolean }> | undefined {
  const merged: Record<string, { enabled: boolean }> = {}
  for (const id of retainIds) {
    const state = updates[id] ?? current?.[id]
    if (state !== undefined) merged[id] = state
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * modelStates 按保留集合重建后落 providers.json（S2 + G3 写侧切换，从 setProvider 提取）。
 * 保留集合（retainIds）计算：
 * - custom provider：payload 即全集（编辑体全量回传），retainIds = payload 模型 id 集；
 * - catalog provider：builtin 模型启停是合法状态（B-2 后 payload 只含 override 条目，
 *   builtin id 不在其中），retainIds = payload ∪ builtin 模板模型 id——既非 payload 也
 *   非 builtin 的键（已删除的 override 模型）剔除。
 * 写入守卫（避免无谓写盘与空条目）：有显式启停更新，或已有 modelStates 需按保留
 * 集合清理时才 modify。先读（getExtrasSync）与 modify 锁内重读有微小 TOCTOU 窗口
 * （同 provider 并发写），最坏情况跳过一次清理，不损坏数据。
 * await 对齐 authMethod 的 MF-1 语义：modify 失败 reject 上抛（handler try-catch
 * 转 sendError），不静默吞。返回 modify promise（结果 ProviderExtras 被丢弃，故
 * Promise<unknown>）供调用方条件 await（守卫不通过时返回 undefined，不产生微任务
 * 边界——同 applyProviderCredentials 的时序契约）。
 */
function persistModelStates(
  extrasStore: ProviderExtrasAccessors,
  providerId: string,
  mergedModels: ConfigModelDefinition[],
  statesUpdates: Record<string, { enabled: boolean }>,
): Promise<unknown> | undefined {
  const payloadIds = new Set(mergedModels.map(m => m.id))
  const retainIds = isCatalogProvider(providerId)
    ? new Set([...payloadIds, ...(builtinProvidersById.get(providerId)?.models ?? []).map(m => m.id)])
    : payloadIds
  const currentExtras = extrasStore.getExtrasSync(providerId)
  const hasUpdates = Object.keys(statesUpdates).length > 0
  const hasExistingStates = currentExtras?.modelStates !== undefined
    && Object.keys(currentExtras.modelStates).length > 0
  if (hasUpdates || hasExistingStates) {
    return extrasStore.modify(providerId, current => {
      const next = mergeModelStates(current?.modelStates, statesUpdates, retainIds)
      // next=undefined（保留集合内无任何状态）时显式置 undefined——序列化丢该键，
      // 条目降级为仅含其余字段（authMethod/quota）；不落空 modelStates 字段。
      return { ...current, modelStates: next }
    })
  }
  return undefined
}

// ── 默认模型 ──

export function getDefaultModel(configStore: IConfigStore): { provider: ProviderId; modelId: string } | null {
  return configStore.getDefaultModel()
}

export function setDefaultModel(configStore: IConfigStore, provider: ProviderId, modelId: string): void {
  configStore.setDefaultModel(provider, modelId)
}

// ── Provider 列举 / 查询 ──

/**
 * catalog 候选 id 收集：(auth.json keys ∪ models.json catalog keys)（F1 修复核心的集合前半）。
 * 旧实现只遍历 models.json providers，catalog 凭据在 auth.json（models.json 无条目）时不显示。
 * 现聚合 auth.json 有凭据的 catalog provider，即使 models.json 无该条目也显示。
 */
function collectCatalogCandidateIds(
  providers: Record<string, ConfigProviderConfig>,
  authIds: string[],
): Set<string> {
  const catalogCandidateIds = new Set<string>()
  for (const id of authIds) {
    if (isCatalogProvider(id)) catalogCandidateIds.add(id)
  }
  for (const [id] of Object.entries(providers)) {
    if (isCatalogProvider(id)) catalogCandidateIds.add(id)
  }
  return catalogCandidateIds
}

/**
 * catalog 源 models 装配（B-2 聚合层配合，design §3.6）：混合合并——builtin 副本（未被
 * override 同 id 覆盖的）+ override 条目，替换旧「override 非空即整体替换」。旧逻辑与 pi
 * 真实行为漂移：pi 侧 catalog override 与内置目录合并显示、内置模型恒在（design D1 探针实测）。
 * source 在合并点标注（不做事后猜测）：override 条目（含同 id 覆盖 builtin 的）标 'override'——
 * 它已被用户定义覆盖；builtin 副本条目标 'builtin'。builtin 在前与 design §3.1 场景 A
 * 的混合列表形态一致（内置在前、自定义追加在后）。
 * 远程目录 overlay（settings-provider 页进入时刷新）：合并逻辑收拢在 provider-catalog
 * 单点（D4，与 pi-provider-store 校验视图同源）——快照打底，仅 fresh 态 overlay 并入
 * （同 id 覆盖、新 id 追加，对齐 pi mergeModels 语义；expired/never-seen 态等于纯快照），
 * override 用户定义仍最高优先。
 */
function buildCatalogProviderModels(
  providerId: string,
  builtinP: BuiltinProviderTemplate,
  overrideModels: ConfigModelDefinition[],
  modelStates?: Record<string, { enabled: boolean }>,
): ProviderInfo['models'] {
  const overrideIds = new Set(overrideModels.map(m => m.id))
  const mergedCatalog = getMergedCatalogModels(providerId)
  const mergedBuiltin = new Map<string, BuiltinProviderTemplate['models'][number]>(
    (mergedCatalog?.models ?? builtinP.models ?? []).map(m => [m.id, m]),
  )
  const builtinNotOverridden = [...mergedBuiltin.values()].filter(m => !overrideIds.has(m.id))
  return [
    ...builtinNotOverridden.map(m => ({ ...toProviderModel(m, modelStates), source: 'builtin' as const })),
    ...overrideModels.map(m => ({ ...toUserInfoModel(m, modelStates), source: 'override' as const })),
  ]
}

/**
 * 合并模型集的 provider 级字段派生（D5 派生兜底）：取全模型该字段的非空唯一值——
 * 全模型非空且同值 → 该值；存在 >1 种非空值（混合协议/混合端点）或全部空/缺省 → undefined。
 *
 * 为什么需要派生：provider 级 `api`/`baseUrl` 在 pi 侧不是单值权威（协议与端点是模型级
 * 属性，pi-ai 按 `model.api` 分发、按 `model.baseUrl` 路由），快照 provider 级字段是构建期
 * artifact（gen-builtin-providers.mjs 取 models[0].api / `provider.baseUrl ?? ''` 捏造）。
 * 混合 provider 无法用单值表达，只能 undefined 由展示层转译为「按模型分发 / 内置目录未提供」。
 */
function deriveUniformModelField(
  models: Array<{ api?: string; baseUrl?: string }>,
  field: 'api' | 'baseUrl',
): string | undefined {
  let value: string | undefined
  for (const m of models) {
    const current = m[field]
    if (typeof current !== 'string' || current === '') continue
    if (value === undefined) value = current
    else if (value !== current) return undefined
  }
  return value
}

/**
 * catalog 源展示字段装配（设计 catalog-provider-field-authority §3.3 D5）。
 *
 * provider 级字段的下发语义是**网关优先 + 派生兜底**（对齐 pi 真实生效顺序）：
 * - `baseUrl`：override 非空 baseUrl = **用户网关**（pi 官方覆盖式网关机制，
 *   provider-composer.js:98 对全部内置模型执行 `baseUrl: config.baseUrl ?? model.baseUrl`
 *   ——镜像站/代理/企业网关工作流）→ 原值下发，前端展示「自定义网关：{url}」；
 *   无网关（未带键 / 空串——空串是清除语义、不落盘）→ 对合并模型集派生。
 * - `api`：无用户语义（写侧 D1③ 对 catalog 忽略 provider 级 type）→ 纯派生。
 *
 * 计算放 runtime 聚合层（前端零推导，对齐 supportedLevels 的 view-ready 原则）：
 * 快照 provider 级 artifact（BuiltinProviderTemplate.api/baseUrl）不再是展示源。
 * 派生数据源 = getMergedCatalogModels（快照 ⊕ overlay 单点，与校验视图同源）；overlay
 * expired/never-seen 时合并视图退化为纯快照，派生值随之变化（如 pi.dev 目录新增模型
 * 改变同值性）——预期行为：派生值跟随数据权威变化，非缺陷（设计检查点 6 实施确认）。
 *
 * 语义收窄的消费点已逐处判定（设计 D5「已接受代价」消费点表）：model-mapper.ts:61
 * toModelInfo 的 `m.api ?? providerApi` 回落路径在混合 provider 下可达（providerApi
 * undefined → 回落模型自身 api），ModelInfo.api 仅作 composer 元数据展示，聊天协议由
 * pi 侧解析；quota preset 相关 provider 实测单协议单 baseUrl，派生值 = 原值，匹配不变。
 */
function resolveCatalogDisplayFields(
  id: string,
  override: ConfigProviderConfig | undefined,
  builtinP: BuiltinProviderTemplate,
  extras: ProviderExtras | undefined,
): Pick<ProviderInfo, 'name' | 'api' | 'baseUrl' | 'authMethod'> {
  // 合并视图缺失（provider 不在快照内，理论不可达——调用方已 ∩ builtinData）时退回模板模型集
  const mergedModels = getMergedCatalogModels(id)?.models ?? builtinP.models ?? []
  // trim 后空串同视「未设置」（与写侧防线②③/D2 清洗口径一致）：空白串不是合法网关
  const gateway = override?.baseUrl
  const hasGateway = typeof gateway === 'string' && gateway.trim() !== ''
  return {
    name: override?.name || builtinP.name || id,
    api: deriveUniformModelField(mergedModels, 'api'),
    baseUrl: hasGateway ? gateway : deriveUniformModelField(mergedModels, 'baseUrl'),
    // 显式标注（extras.authMethod）优先；无标注退回 apiKey 格式推断（I6）
    authMethod: extras?.authMethod ?? deriveAuthMethod(override),
  }
}

/** catalog 源单条 ProviderInfo 装配（listProviders catalog 循环体提取，行为逐字保持）。 */
function buildCatalogProviderInfo(
  id: string,
  override: ConfigProviderConfig | undefined,
  builtinP: BuiltinProviderTemplate,
  extras: ProviderExtras | undefined,
  credentialIdSet: Set<string>,
  enabledModels: string[],
): ProviderInfo {
  // C1 契约「catalog 凭据 = id ∈ 有凭据源」；override?.apiKey 是 catalog provider
  // 手动填 key 的旧数据（迁移前错位）合理扩展，双源判定避免遗漏。
  // D3 链 5（凭据收口）：credentialIdSet 由 resolver 批量 sync 版单次给出（auth.json ∪
  // models.json，构造必需注入——M2fg）。
  const apiKeySet = credentialIdSet.has(id) || !!override?.apiKey
  const overrideModels = override?.models ?? []
  const display = resolveCatalogDisplayFields(id, override, builtinP, extras)
  // id 来自 models.json / auth.json 的磁盘 key（反序列化边界，design D5）→ as ProviderId 提升
  // key 顺序与 HEAD catalog 循环逐字对齐（apiKeySet 先于 authMethod；JSON 序列化字节序不变）
  return {
    id: id as ProviderId,
    name: display.name,
    api: display.api,
    baseUrl: display.baseUrl,
    apiKeySet,
    authMethod: display.authMethod,
    // catalog 凭据在 auth.json：apiKeySet 已含 auth.json 判定（credentialIdSet），
    // 与旧 status 逻辑（hasCredentialSync(id)）等价，避免重复读 auth.json。
    status: apiKeySet ? 'connected' as const : 'not_configured' as const,
    models: buildCatalogProviderModels(id, builtinP, overrideModels, extras?.modelStates),
    // DM3：enabled 从 enabledModels 派生，不读 models.json provider.enabled（F2）
    enabled: deriveEnabled(id, enabledModels),
    kind: 'catalog' as const,
    hasOverride: !!override,
    quota: extras?.quota,
  }
}

/** custom 源单条 ProviderInfo 装配（listProviders custom 循环体提取，行为逐字保持）。 */
function buildCustomProviderInfo(
  id: string,
  config: ConfigProviderConfig,
  extras: ProviderExtras | undefined,
  credentialIdSet: Set<string>,
  enabledModels: string[],
): ProviderInfo {
  const userModels = (config.models ?? []).map(m => toUserInfoModel(m, extras?.modelStates))
  const apiKeySet = !!config.apiKey
  // id 来自 models.json 的磁盘 key（反序列化边界，design D5）→ as ProviderId 提升
  return {
    id: id as ProviderId,
    name: config.name || id,
    // W2：回填 provider 级 api 字段，修复前端编辑 provider 时 type 下拉丢失（P0-1）
    api: config.api,
    baseUrl: config.baseUrl,
    apiKeySet,
    // 显式标注（extras.authMethod）优先；无标注退回 apiKey 格式推断（I6）
    authMethod: extras?.authMethod ?? deriveAuthMethod(config),
    // M6 status 派生：apiKey 或凭据源任一 → connected。
    // B3/D3 链 5：复用批量单次读的 credentialIdSet（resolver sync 版，构造必需注入——M2fg），
    // 消除每次循环 hasCredentialSync 的 N+1 读盘。
    status: (config.apiKey || credentialIdSet.has(id))
      ? 'connected' as const
      : 'not_configured' as const,
    // T9/M5 models 合并：用户自定义 models 非空 → 保留；为空 → builtin models 兜底
    models: userModels.length > 0
      ? userModels
      : (builtinProvidersById.get(id)?.models.map(m => toProviderModel(m, extras?.modelStates)) ?? userModels),
    // DM3：enabled 从 enabledModels 派生，不读 models.json provider.enabled（F2）
    enabled: deriveEnabled(id, enabledModels),
    kind: 'custom' as const,
    quota: extras?.quota,
  }
}

/**
 * catalog ∪ custom 双源聚合 provider 列表。
 * 纯函数：configStore / authStorage / extrasStore 经参数注入（原 ConfigService.listProviders 搬迁）。
 *
 * A1-3 读源切换：taiji 私有字段（authMethod 显式标注 / quota / modelStates 模型启停）
 * 经 readAllExtrasWithFallback 双读——providers.json 优先 + models.json 旧寄生字段兜底
 * （迁移失败窗口兼容）。未注入 extrasStore 时 extras 恒空：authMethod 退回 apiKey 推断、
 * quota 为 undefined（与迁移后 models.json 已剥离寄生字段的读值一致）。
 *
 * D3 链 5（凭据读路径收口）：apiKeySet / status 的凭据判定经 credentialResolver 的批量
 * sync 版单次取（`listCredentialBackedProviderIds`，auth.json ∪ models.json 各单次读）。
 * resolver 构造必需（M2fg 收口：生产组合根恒注入，`new Set(authIds)` 内联回退已删除）——
 * 保持批量单次读盘的 B3 不变量，禁止退回 per-provider 循环。
 */
export function listProviders(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasReader | undefined,
  credentialResolver: IProviderCredentialResolver,
): ProviderInfo[] {
  const models = configStore.readModels()
  const enabledModels = configStore.getEnabledModels()
  const extrasAll = extrasStore ? readAllExtrasWithFallback(extrasStore, configStore) : {}
  const authIds = authStorage?.listCredentialIds() ?? []
  const credentialIdSet = credentialResolver.listCredentialBackedProviderIds()

  const result: ProviderInfo[] = []
  // catalog id 去重集合：catalog 源处理过的 id，custom 源跳过（避免 catalog id 重复出现）
  const catalogIdsHandled = new Set<string>()

  // ── catalog 源：(auth.json keys ∪ models.json catalog keys) ∩ builtinData（F1 修复核心）──
  const catalogCandidateIds = collectCatalogCandidateIds(models.providers, authIds)

  for (const id of catalogCandidateIds) {
    const builtinP = builtinProvidersById.get(id)
    if (!builtinP) continue // 只聚合 builtin 内的 catalog provider（∩ builtinData）
    catalogIdsHandled.add(id)
    result.push(buildCatalogProviderInfo(id, models.providers[id], builtinP, extrasAll[id], credentialIdSet, enabledModels))
  }

  // ── custom 源：models.json providers where !isCatalogProvider(id)（保留旧逻辑，kind='custom'）──
  // catalogIdsHandled 已收录 models.json 里的 catalog 条目（上面聚合时加入），此处跳过避免重复。
  for (const [id, config] of Object.entries(models.providers)) {
    if (catalogIdsHandled.has(id)) continue
    result.push(buildCustomProviderInfo(id, config, extrasAll[id], credentialIdSet, enabledModels))
  }

  return result
}

/**
 * 列出内置 provider 模板（wave 2，import generated JSON，无参只读，纯函数）。
 * builtinData 模块级 import 即缓存，不触 ConfigStore 依赖。wave 1 生成时已排除 radius。
 *
 * 浅校验 guard（review M-9 修复）：生成物损坏/格式不符（非数组、条目缺 id/name）时
 * 返回空列表（前端隐藏内置入口），不抛错——内置模板是增强能力，坏了不能拖垮 Settings。
 */
export function listBuiltinProviders(): BuiltinProviderTemplate[] {
  const raw = builtinData.providers
  if (!Array.isArray(raw)) {
    console.warn('[config-service] builtin-providers.json malformed (providers is not an array), falling back to empty list')
    return []
  }
  for (const p of raw) {
    if (typeof p !== 'object' || p === null || typeof p.id !== 'string' || typeof p.name !== 'string') {
      console.warn('[config-service] builtin-providers.json malformed (provider missing id/name), falling back to empty list')
      return []
    }
  }
  // JSON import 的推断类型与 BuiltinProviderTemplate 有 optional 字段差异，浅校验后断言
  return raw as unknown as BuiltinProviderTemplate[]
}

export function checkEnvVars(names: string[]): Record<string, boolean> {
  // 去重（I3 契约）+ 空串不算已设置（env 值为空串时 pi resolveConfigValue 同样视为未配置）
  const results: Record<string, boolean> = {}
  for (const name of new Set(names)) {
    const value = process.env[name]
    results[name] = value !== undefined && value !== ''
  }
  return results
}

export function getProvider(configStore: IConfigStore, providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined {
  return configStore.getProviderConfig(providerId)
}

// ── Provider 增删改 ──

/**
 * apiKey 写入的分体系处理（I9 清理① + catalog 分体系，从 setProvider 提取）：
 * - catalog provider：apiKey 归 auth.json (api_key overwrites oauth natively)
 * - custom provider：apiKey 写 models.json，清 auth.json oauth (I9 cleanup)
 *
 * 返回 auth.json 侧落盘 flush promise（catalog 写入 / custom 清理，RT-7#3 后两者均
 * await 后再 upsert，失败上抛）供调用方 await；无落盘路径返回 undefined——调用方
 * 条件 await 保持「无实际 await 分支时 setProvider 同步执行到底」的时序契约。
 */
function applyProviderCredentials(
  merged: Record<string, unknown>,
  authStorage: AuthStorageAccessors | undefined,
  credentialWriter: CredentialWriter | undefined,
  providerId: string,
  data: SetProviderInput,
): Promise<void> | undefined {
  // 防线② 空串转译（trim 后空串同视）：apiKey 空串 = 清除语义——不写 auth.json / models.json，
  // 由下游载体 applyProviderWritePolicy 删 merged 既有键（清除的正确落盘形态是删键）。
  const { apiKey } = data
  if (apiKey !== undefined && apiKey.trim() !== '') {
    if (isCatalogProvider(providerId) && credentialWriter) {
      // catalog provider: apiKey → auth.json (0600), strip from models.json
      // A1-4 收口：写入经 credentialWriter（AuthService.saveCredential），authStorage.set
      // 的直接调用全 runtime 只剩 auth-service.ts 内部。
      // MF-1（stale 广播 + 静默丢 key）：await 落盘后再 delete merged.apiKey +
      // upsertProvider。fire-and-forget 时 withFileLock 未落盘 → handler 同步返回后
      // broadcastProviderList 裸读 auth.json 拿到 stale（catalog 显示 not_configured）；
      // 且写失败只 warn，apiKey 既未进 auth.json 又已从 models.json 删 → 凭据静默丢失。
      // 落盘失败 promise reject 上抛（调用方 await，handler try-catch 转 sendError），
      // 不静默吞、不 stale 广播。与 deleteProvider/removeProviderByKind 的
      // cleanAuthCredential await 对称（写入路径对齐删除路径）。
      return credentialWriter.saveCredential(providerId, { type: 'api_key', key: apiKey })
        .then(() => {
          // Don't write apiKey to models.json for catalog providers
          // （await 点后执行：落盘成功才 strip，语义同内联 await + delete）
          delete merged.apiKey
        })
    }
    // custom provider or no credentialWriter: keep existing behavior (apiKey in models.json)
    // I9: clear oauth credential before writing apiKey.
    // RT-7#3（MF-1 对称）：清理 await 后再 upsert（失败上抛，调用方 await → handler
    // try-catch 转 sendError，不静默吞）。原因：凭据解析唯一通道（provider-credential-resolver）
    // 的源优先级 auth.json 在前，fire-and-forget 时清理未落盘/失败会残留旧 oauth 条目，
    // 后续解析仍读到已作废的 oauth access（「UI 显示已切 api_key、实际请求用旧 oauth」）。
    // 与 catalog 分支 MF-1、deleteProvider/removeProviderByKind 的 cleanAuthCredential
    // await 先例同语义（写入路径对齐删除路径）。
    // M5-01 边界保持：catalog + 无 credentialWriter 时 apiKey 不落 models.json（宁丢不
    // 写错位，生产恒注入 credentialWriter）；auth.json 清理仍执行（I9 语义不因写入通道
    // 缺失而豁免——旧 oauth 条目清除与 apiKey 落哪里是两个独立决定）。
    if (!isCatalogProvider(providerId)) merged.apiKey = apiKey
    return authStorage?.remove(providerId)
  }
  return undefined
}

// ── 写侧防线载体（设计 D1 防线②③；catalog-provider-field-authority v3.3）──

/**
 * 写入体系（调用方经 isCatalogProvider(providerId) 派生后传入——载体不读 catalog 快照，
 * 保持可独立测试的纯函数形态）。
 */
export type ProviderWriteKind = 'catalog' | 'custom'

/**
 * 写入来源语义（设计 D1 防线载体段）：
 * - 'settings'：用户在 taiji UI/CLI 显式设置——catalog 非空 baseUrl = 用户网关（写入 models.json，
 *   并产出 gatewayToSet 供调用方落 extras 标记）；
 * - 'import'：外部 pi 配置导入——导入数据不是用户在 UI 显式设置的网关，catalog provider 级
 *   baseUrl/api 一律剥除（不产生隐形网关）。
 */
export type ProviderWriteSource = 'settings' | 'import'

/**
 * 防线载体统一入参形态（各写入入口归一后传入，设计 D1「入参字段名归一」）：
 * - 字段名以 pi models.json 为准——provider 级 api 的入参名是 `api`（不叫 type）：
 *   setProvider 入口把 `SetProviderData.type` 经 IConfigStore.applyTypeTranslation 归一为 api；
 *   importer 侧 PiProviderConfig 天然同形（api/baseUrl/apiKey/name/models 直传）。
 * - `models`：传了即**整体替换** merged.models（原始条目 → 防线② 模型级转译后写入）。
 *   仅适用于「调用方持有原始条目、本该整体写盘」的入口（importer）。
 *   切不可把 setProvider 的原始 payload 传给已装配好合并结果的 merged（会丢掉
 *   mergeProviderModel 的 base spread 合并）；setProvider 侧应**不传 models**，
 *   skipUpsert 判定直接读 merged.models（见 hasSubstantiveProviderFields）。
 */
export interface ProviderWritePolicyInput {
  name?: string
  baseUrl?: string
  apiKey?: string
  api?: string
  models?: Array<Record<string, unknown>>
}

/** 防线载体返回信号（extras 落盘等外部编排归调用方，载体零外部副作用）。 */
export interface ProviderWritePolicyResult {
  /** 就地更新后的 merged（与入参同一引用，含删键）。 */
  merged: Record<string, unknown>
  /** catalog + settings + 非空 baseUrl = 用户网关：调用方据此写 extras.gatewayBaseUrl 标记。 */
  gatewayToSet?: string
  /** catalog + 显式空串 baseUrl（带键）= 清除网关：调用方据此清 extras.gatewayBaseUrl 标记。 */
  gatewayToClear?: boolean
  /** 无实质字段（pi 空壳判定八字段全缺）：调用方据此跳过 upsertProvider，不物化空壳条目。 */
  skipUpsert?: boolean
  /**
   * 被丢弃的非法模型项描述（U6②：「id 类毒化」的**可见性**承载）。
   *
   * 丢弃是有意行为（非法 id 条目落盘会让 pi 拒载**整个** models.json = 全部 provider 一起
   * 失效）；但静默丢弃违反 P0「故障要响亮」契约——调用方据此把丢弃项surface 到用户可见
   * 通道（import 路径 → `ProviderImportedItem.warnings`；settings 路径 → 既有 warn 日志）。
   * 形态：`<id 或占位>（missing/non-string id）` 等人类可读描述。
   */
  droppedModels?: string[]
}

/** 防线② 空串判定：trim 后为空即同视空串（拦 CLI/脚本发的纯空白串 '  '）。 */
function isBlankString(v: string): boolean {
  return v.trim() === ''
}

/**
 * 防线② 模型级空串转译（pi ModelDefinitionSchema 的 minLength:1 字段集 =
 * id/name/api/baseUrl，node_modules 实装 model-config.js:137-140 核实）：
 * - `id` 是 pi 必需字段——**缺失/空串/不可强转 → 整条模型丢弃**（U6①：既有实现只覆盖空串，
 *   而「不写 id」同样让 pi 拒载整个文件——本函数 JSDoc 早写明了该意图，本次补完实现）；
 * - `name`/`api`/`baseUrl`——trim 后空 → 删键（空串无语义且 minLength 违规）。
 * 就地改写传入的 model 副本，返回 false 表示该模型不可写入。
 */
function translateModelSchemaFields(model: Record<string, unknown>, providerId: string): boolean {
  const idCheck = normalizeModelIdOrReject(model)
  if (!idCheck.ok) {
    console.warn(`[config-service] dropped model with ${idCheck.reason} for ${providerId}`)
    return false
  }
  for (const field of ['name', 'api', 'baseUrl'] as const) {
    const value = model[field]
    if (typeof value === 'string' && isBlankString(value)) {
      console.warn(`[config-service] dropped empty-string ${field} for ${providerId} model "${String(model.id ?? '')}"`)
      delete model[field]
    }
  }
  return true
}

/**
 * 「实质字段」判定（防线③ 不物化空壳）：pi 空壳判定八字段任一在场即非空壳。
 * 字段集与语义对齐 pi-provider-repair.isInvalidProvider（infra/pi 层，services 不可 import
 * ——C-comm-03 分层约束，故此处本地复刻；该判定改动须两侧同步）。
 * 与 pi 判定同构：models 需非空数组、modelOverrides 需非空对象、authHeader 用
 * `!== undefined`（显式 false 是在场），其余按 truthiness。
 */
function hasSubstantiveProviderFields(merged: Record<string, unknown>): boolean {
  const hasModels = Array.isArray(merged.models) && merged.models.length > 0
  const hasOverrides = typeof merged.modelOverrides === 'object' && merged.modelOverrides !== null
    && Object.keys(merged.modelOverrides as object).length > 0
  return hasModels
    || !!merged.baseUrl
    || !!merged.headers
    || !!merged.compat
    || hasOverrides
    || !!merged.apiKey
    || !!merged.oauth
    || merged.authHeader !== undefined
}

// ── 防线载体 · 字段族子函数（从 applyProviderWritePolicy 提取，逐字段族一个入口）──

/**
 * 防线② provider 级 apiKey 转译：空串 = 清除语义 → 删键（「清除」的正确落盘形态是删键，
 * 不是写空串；与 index.ts clearApiKey 闭包同构）。catalog 的非空 apiKey 归 auth.json
 * （applyProviderCredentials 通道），载体不写 models.json 侧。
 */
function applyApiKeyWritePolicy(
  merged: Record<string, unknown>,
  data: ProviderWritePolicyInput,
  kind: ProviderWriteKind,
): void {
  if (data.apiKey === undefined) return
  if (isBlankString(data.apiKey)) {
    delete merged.apiKey
    return
  }
  if (kind !== 'catalog') merged.apiKey = data.apiKey
}

/** 防线② provider 级 name 转译：空串（trim 后同视）= 未指定 → 不写键 + warn（base spread 保留既有值）。 */
function applyNameWritePolicy(
  merged: Record<string, unknown>,
  data: ProviderWritePolicyInput,
  providerId: string,
): void {
  if (data.name === undefined) return
  if (isBlankString(data.name)) {
    console.warn(`[config-service] dropped empty-string name for ${providerId}`)
    return
  }
  merged.name = data.name
}

/**
 * 防线③ catalog 体系 baseUrl 分体系语义：import = 剥除（导入数据不是用户在 UI 显式设置的
 * 网关，不产生隐形网关）；settings 非空 = 用户网关（pi 覆盖式网关机制）→ 写入 + 产出
 * gatewayToSet 标记信号；settings 显式空串**带键** = 清除网关（回退内置端点）→ 删键 +
 * 产出 gatewayToClear；未带键（undefined）= 不变（既有 merge 协议）。
 */
function applyCatalogBaseUrlWritePolicy(
  merged: Record<string, unknown>,
  data: ProviderWritePolicyInput,
  source: ProviderWriteSource,
  result: ProviderWritePolicyResult,
): void {
  if (data.baseUrl === undefined) return
  if (source === 'import') {
    delete merged.baseUrl
    return
  }
  if (!isBlankString(data.baseUrl)) {
    merged.baseUrl = data.baseUrl
    result.gatewayToSet = data.baseUrl
    return
  }
  if (merged.baseUrl !== undefined) delete merged.baseUrl
  result.gatewayToClear = true
}

/**
 * 防线② custom 体系 baseUrl：空串（trim 后同视）= 未指定 → 不写键 + warn（base spread 保留
 * 既有值）。custom 清空 baseUrl 保存 = 不变更既有值（custom 无「默认」可回退，删除用删除功能）。
 */
function applyCustomBaseUrlWritePolicy(
  merged: Record<string, unknown>,
  data: ProviderWritePolicyInput,
  providerId: string,
): void {
  if (data.baseUrl === undefined) return
  if (isBlankString(data.baseUrl)) {
    console.warn(`[config-service] dropped empty-string baseUrl for ${providerId}`)
    return
  }
  merged.baseUrl = data.baseUrl
}

/**
 * 防线②③ provider 级 api 分体系语义：catalog —— import 剥除（同 baseUrl：导入不产生非用户
 * 意图的协议缺省）/ settings 忽略 + warn（provider 级 api 对 catalog 无用户语义，协议是模型级
 * 属性）；custom —— 空串（trim 后同视）= 未指定 → 不写键 + warn。
 */
function applyApiWritePolicy(
  merged: Record<string, unknown>,
  data: ProviderWritePolicyInput,
  kind: ProviderWriteKind,
  source: ProviderWriteSource,
  providerId: string,
): void {
  if (data.api === undefined) return
  if (kind !== 'catalog') {
    applyCustomApiWritePolicy(merged, data.api, providerId)
    return
  }
  if (source === 'import') {
    delete merged.api
    return
  }
  console.warn(`[config-service] ignored provider-level type for catalog ${providerId}`)
}

/** 防线② custom 体系 provider 级 api：空串（trim 后同视）= 未指定 → 不写键 + warn。 */
function applyCustomApiWritePolicy(
  merged: Record<string, unknown>,
  api: string,
  providerId: string,
): void {
  if (isBlankString(api)) {
    console.warn(`[config-service] dropped empty-string api for ${providerId}`)
    return
  }
  merged.api = api
}

/**
 * 防线② 模型级转译（translateModelSchemaFields）：传了才触碰 merged.models，整体替换。
 *
 * RT-5#2（M15）：本函数是导入路径的模型装配点（importer 传 models；setProvider 侧自行走
 * mergeProviderModel 装配后不传 models），转译后追加 B-4b 校验型白名单（applyValidatedModelFields
 * ——settings 路径同源），外部配置的畸形 cost/headers/reasoning/maxTokens 不再裸透传写盘：
 * pi 0.84.4 ModelConfig.load 对 schema 违规**整表拒载**（node_modules dist core/model-config.js
 * validateModelsConfig.Check 失败 → 空 providers Map + error），一条畸形模型毒死全部自定义
 * provider。非法值 throw 由导入链 per-entry catch 折叠为该条 `status:'failed'` + reason。
 */
function applyModelsWritePolicy(
  merged: Record<string, unknown>,
  data: ProviderWritePolicyInput,
  providerId: string,
  result: ProviderWritePolicyResult,
): void {
  if (data.models === undefined) return
  const kept: Array<Record<string, unknown>> = []
  const dropped: string[] = []
  for (const raw of data.models) {
    const model = { ...raw }
    // U6②：丢弃项进可见性信号（描述 = 尽力取原 id 或占位 + 丢弃原因）
    const rawId = (raw as Record<string, unknown>)?.id
    const label = typeof rawId === 'string' && rawId !== '' ? rawId : '(no id)'
    const droppedDesc = `${label} (dropped: invalid id — pi requires a non-empty model id)`
    // 缺 id 与空白 id 同口径（normalizeModelIdOrReject 只拦空白串/非法形态）：pi 的 id 是
    // 必填 minLength:1 字段，缺 id 条目写盘同样触发整表拒载——整条丢弃 + warn + 可见性信号。
    if (model.id === undefined || model.id === null) {
      console.warn(`[config-service] dropped model without id for ${providerId}`)
      dropped.push(droppedDesc)
      continue
    }
    if (translateModelSchemaFields(model, providerId)) {
      applyValidatedModelFields(model, model, String(model.id))
      kept.push(model)
    } else {
      dropped.push(droppedDesc)
    }
  }
  merged.models = kept
  if (dropped.length > 0) result.droppedModels = dropped
}

/**
 * 防线载体共享纯函数（设计 D1「防线载体（结构约束）」段）——防线②③ 的核心转译逻辑单点：
 * 空串转译（provider 级 name/baseUrl/apiKey/api + 模型级 id/name/api/baseUrl）+ catalog
 * 分体系语义（type 忽略 / baseUrl 网关写入·清除 / 不物化空壳）。
 *
 * setProvider 与 importer 两条写入路径共用（importer 直调 infra upsertProvider，不经过
 * setProvider——防线落在写入点而非某个调用方）。
 *
 * **零外部副作用**：extras 网关标记的落盘、跳过 upsert 的动作都不在本函数内发生，只产出
 * 信号（gatewayToSet / gatewayToClear / skipUpsert）由调用方编排。函数就地更新并原样返回
 * 传入的 merged（含删键）。
 *
 * **维护约定（S-10 登记）**：merged 形参故意宽化为 Record<string, unknown>（字段族子函数
 * 逐字段拼装，不做整体类型收窄）；调用方（provider-importer 等）把它传给
 * `upsertProvider(name, config: PiProviderConfig)` 时需 `as PiProviderConfig` 断言 ——
 * 断言的安全性依赖本函数各字段族子函数只写入 PiProviderConfig 形状内的键。**新增字段族
 * 子函数时必须保持 merged 产出与 PiProviderConfig 形状兼容**；长期方向 = 本函数返回
 * 类型化产物（形状收编进 ProviderWritePolicyResult），届时调用方断言可删。
 *
 * @param merged 既有条目展开后的目标对象（调用方已持有同一引用）
 * @param data 归一后的 provider 配置入参（见 ProviderWritePolicyInput）
 * @param kind 写入体系（调用方经 isCatalogProvider 派生）
 * @param source 写入来源（settings = 用户显式设置 / import = 外部配置导入）
 * @param providerId 仅用于诊断日志
 */
export function applyProviderWritePolicy(
  merged: Record<string, unknown>,
  data: ProviderWritePolicyInput,
  kind: ProviderWriteKind,
  source: ProviderWriteSource,
  providerId: string,
): ProviderWritePolicyResult {
  const result: ProviderWritePolicyResult = { merged }

  // 字段族调度（顺序契约：apiKey → name → baseUrl → api → models → 不物化空壳判定——与拆分前
  // 逐字段处理顺序一致；空壳判定必须看到全部字段族与 models 的装配结果）
  applyApiKeyWritePolicy(merged, data, kind)
  applyNameWritePolicy(merged, data, providerId)
  if (kind === 'catalog') {
    applyCatalogBaseUrlWritePolicy(merged, data, source, result)
  } else {
    applyCustomBaseUrlWritePolicy(merged, data, providerId)
  }
  applyApiWritePolicy(merged, data, kind, source, providerId)
  applyModelsWritePolicy(merged, data, providerId, result)

  // ── 不物化空壳（防线③）：剥除/清除后八字段全缺 → 产出跳过 upsert 信号（对既有条目是
  //    no-op 而非删除——调用方跳过 upsert 即可，盘上旧条目保持原状，对齐 M5-01「宁丢不写错位」）──
  if (!hasSubstantiveProviderFields(merged)) {
    console.warn(`[config-service] skipped empty provider entry ${providerId}`)
    result.skipUpsert = true
  }

  return result
}

/**
 * provider 级 headers/authHeader 白名单写入 merged（从 setProvider 提取，B-4a 校验写）。
 * undefined = 不变（base spread 保留既有值），显式传值才覆盖；非法值 throw 上抛
 * （handler try-catch 转 sendError）。
 *
 * baseUrl/name/apiKey/api 的空串转译与 catalog 分体系语义不在本函数——统一委托共享载体
 * applyProviderWritePolicy，由 setProvider 在 models 装配**之后**调用一次（载体做
 * 「不物化空壳」判定时需要看到 headers/authHeader 与装配完成的 merged.models）。
 * 本函数保持在载体调用之前执行，保证 headers/authHeader 对判定可见。
 */
function applyProviderHeaderFields(
  merged: Record<string, unknown>,
  providerId: string,
  data: SetProviderInput,
): void {
  // B-4a 断链修复（design §2.1 场景 D）：headers/authHeader 是 pi ProviderConfigSchema 内
  // 字段，写入 models.json provider 条目。跟随 baseUrl/name 的 merged 赋值模式：undefined =
  // 不变（base spread 保留既有值），显式传值才覆盖——headers 传空对象 {} 即清空（pi schema
  // Type.Record 允许空对象；null 不在契约内，由 sanitizeHeaders 拒绝）。不做 apiKey 式
  // __CLEAR__ 哨兵：apiKey 需要 '' 哨兵是因 string 空串已被复用，对象 {} 天然可作清空值。
  if (data.headers !== undefined) {
    merged.headers = sanitizeHeaders(data.headers, `headers for provider "${providerId}"`)
  }
  if (data.authHeader !== undefined) {
    if (typeof data.authHeader !== 'boolean') {
      throw new Error(`Invalid authHeader for provider "${providerId}": must be a boolean`)
    }
    // boolean 不能用 truthiness 判定：显式 false 是合法值（关闭 Authorization header 注入）
    merged.authHeader = data.authHeader
  }
}

/**
 * 基础字段装配（从 setProvider 模型合并 arrow 提取）：name / contextWindow / input /
 * thinkingLevelMap。保持原赋值顺序；thinkingLevelMap 非法值静默忽略 + 显式 undefined 时
 * 删除 base 残留（buildMap() returned undefined (all passthrough)）语义不变。
 *
 * 防线②（model 级 name）：trim 后空串 = 未指定 → 不写键（base spread 保留既有值）——纯空白
 * 串（'  '）长度非 0 会绕过 pi minLength 之外的任何检查，直写即毒化整个 models.json。
 */
function applyModelBaseFields(
  model: Record<string, unknown>,
  m: Record<string, unknown>,
  base: Partial<ConfigModelDefinition>,
): void {
  if (typeof m.name === 'string' && isBlankString(m.name)) {
    console.warn(`[config-service] dropped empty-string name for model "${String(model.id ?? '')}"`)
  } else if (m.name) {
    model.name = String(m.name)
  }
  if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
  if (Array.isArray(m.input)) {
    model.input = (m.input as unknown[]).filter(
      (v): v is 'text' | 'image' => v === 'text' || v === 'image',
    )
  }
  if (isValidThinkingLevelMap(m.thinkingLevelMap)) {
    model.thinkingLevelMap = m.thinkingLevelMap
  } else if (m.thinkingLevelMap === undefined && base.thinkingLevelMap) {
    // buildMap() returned undefined (all passthrough) → remove from model
    delete model.thinkingLevelMap
  }
}

/** model 级 enabled 收集到 modelStatesUpdates（G3 写侧切换；显式传值才记录，id 为空跳过）。 */
function recordModelStateUpdate(
  modelStatesUpdates: Record<string, { enabled: boolean }>,
  id: string,
  enabled: unknown,
): void {
  if (typeof enabled === 'boolean' && id) {
    modelStatesUpdates[id] = { enabled }
  }
}

/**
 * api / baseUrl 回写（review must_fix #1：前端回传的 model 级值必须写回，否则编辑保存即丢失）。
 *
 * 防线②（model 级 api/baseUrl）：trim 后空串同视空串 = 未指定 → 不写键 + warn（base spread
 * 保留既有值）。这两个字段是 pi ModelDefinitionSchema 的 minLength:1 字段（实装
 * model-config.js:138-139）——写空串会让 pi TypeBox 校验拒绝整个 models.json。
 */
function applyModelRoutingFields(model: Record<string, unknown>, m: Record<string, unknown>): void {
  for (const field of ['api', 'baseUrl'] as const) {
    const value = m[field]
    if (typeof value !== 'string') continue
    if (isBlankString(value)) {
      console.warn(`[config-service] dropped empty-string ${field} for model "${String(model.id ?? '')}"`)
    } else {
      model[field] = value
    }
  }
}

/**
 * 校验型字段装配（B-4b 模型写入白名单：reasoning/maxTokens/cost/headers，全是 pi
 * ModelDefinitionSchema 内字段）。undefined = 不变（base spread 保留）；显式传值走校验，
 * 非法值 throw 上抛（handler try-catch 转 sendError）而非静默丢弃——静默会让「保存成功
 * 但参数丢失」无从排查。与存量字段（name/contextWindow 等的静默忽略）模式不同：新字段
 * 从第一天就走校验路径，存量字段保持行为兼容不动。保持原校验顺序（reasoning → maxTokens
 * → cost → headers），throw 文案逐字节不变。
 */
function applyValidatedModelFields(
  model: Record<string, unknown>,
  m: Record<string, unknown>,
  id: string,
): void {
  if (m.reasoning !== undefined) {
    if (typeof m.reasoning !== 'boolean') {
      throw new Error(`Invalid reasoning for model "${id}": must be a boolean`)
    }
    model.reasoning = m.reasoning
  }
  if (m.maxTokens !== undefined) {
    if (typeof m.maxTokens !== 'number' || !Number.isInteger(m.maxTokens) || m.maxTokens <= 0) {
      throw new Error(`Invalid maxTokens for model "${id}": must be a positive integer`)
    }
    model.maxTokens = m.maxTokens
  }
  if (m.cost !== undefined) {
    // 四字段必填对齐 pi ModelCostSchema（缺字段写入 → pi 拒载整个 models.json）
    model.cost = sanitizeModelCost(m.cost, `cost for model "${id}"`)
  }
  if (m.headers !== undefined) {
    // 清空语义对齐 provider 级：传 {} 即清空（pi Record 允许空对象）
    model.headers = sanitizeHeaders(m.headers, `headers for model "${id}"`)
  }
}

/**
 * compat 透传/清洗/删除（前端 compat 编辑器回传的兼容性覆盖必须写回，否则编辑保存即丢失
 * 用户手动配置的 compat）。类型守卫对齐 isValidThinkingLevelMap：必须排除 null
 * （typeof null === 'object'）与数组（typeof [] === 'object'），否则下游遍历 null 会崩
 * 或把数组当对象写入。显式 undefined + base 有值 → 删除（「清除所有 compat」按钮语义）。
 */
function applyModelCompat(
  model: Record<string, unknown>,
  m: Record<string, unknown>,
  base: Partial<ConfigModelDefinition>,
): void {
  if (m.compat != null && typeof m.compat === 'object' && !Array.isArray(m.compat)) {
    // sanitize compat（守卫通过后、赋值前）：
    // - 剔除 __proto__/prototype/constructor 防 prototype pollution（compat 类型是
    //   Record<string, unknown> 前向兼容扩展点，不能假定 key 安全）
    // - 剔除 undefined value（避免 JSON 序列化丢 key 造成困惑）
    // 不做 key 白名单：compat schema 未稳定，白名单会限制前向扩展。
    const sanitized: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(m.compat)) {
      if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue
      if (v === undefined) continue
      sanitized[k] = v
    }
    model.compat = sanitized
  } else if (m.compat === undefined && base.compat) {
    // 前端 clearAll 发 undefined → 删除盘上已有的 compat（对齐 thinkingLevelMap undefined 分支），
    // 否则 base spread 会保留旧 compat，导致「清除所有 compat」按钮失效。
    delete model.compat
  }
}

/**
 * 单个 model 条目合并（setProvider 模型合并 arrow 提取，白名单装配 + G3 收集）。
 * 字段赋值/校验顺序与原实现逐字保持：base spread → 基础字段 → enabled 剥除与收集 →
 * api/baseUrl → 校验型字段 → compat。
 *
 * 返回 null 表示该模型不可写入（防线② 模型级空 id，见下）；调用方 filter 剔除。
 */
function mergeProviderModel(
  m: Record<string, unknown>,
  existingModels: ConfigModelDefinition[],
  modelStatesUpdates: Record<string, { enabled: boolean }>,
  providerId: string,
): ConfigModelDefinition | null {
  // 防线②（model 级 id）：pi ModelDefinitionSchema 的 id 是必需 minLength:1 字段
  // （node_modules 实装 model-config.js:137），空/纯空白 id 写盘会毒化整个 models.json
  // （pi TypeBox 拒载整个文件）。与防线载体 translateModelSchemaFields 同口径：整条丢弃
  // + warn，不产出 id:"" 条目（旧实现 String(m.id ?? '') 空串锚定正是要消灭的行为）。
  const id = m.id === undefined || m.id === null ? '' : String(m.id)
  if (isBlankString(id)) {
    console.warn(`[config-service] dropped model with empty-string id for ${providerId}`)
    return null
  }
  const base = existingModels.find(em => em.id === id) ?? {} as Partial<ConfigModelDefinition>
  const model: Record<string, unknown> = { ...base, id }
  applyModelBaseFields(model, m, base)
  // review must_fix #1：前端回传的 model 级 api/baseUrl 必须写回，
  // 否则编辑保存即丢失（新模型 base={} 全丢，编辑现有模型被 base 旧值覆盖）。
  // 对齐 provider 级的「if (m.X !== undefined) model.X = ...」模式。
  // enabled 例外（G3）：pi schema 外寄生字段不写 models.json，迁 providers.json
  // modelStates——base 残留的旧 enabled（迁移失败窗口数据）一并剥除，保证本
  // 路径不再序列化该字段进 models.json。
  delete model.enabled
  recordModelStateUpdate(modelStatesUpdates, id, m.enabled)
  applyModelRoutingFields(model, m)
  applyValidatedModelFields(model, m, id)
  applyModelCompat(model, m, base)
  return model as unknown as ConfigModelDefinition
}

/**
 * authMethod 落 providers.json（A1-5 写侧切换，从 setProvider 提取）：不再寄生 models.json。
 *
 * 返回 modify promise 供调用方条件 await（未传 authMethod / extrasStore 未注入返回 undefined，
 * 不产生微任务边界，保持同步前缀时序契约——同 applyProviderCredentials）。await 对齐 catalog
 * apiKey 的 MF-1 语义：modify 失败直接 reject 上抛，handler try-catch 转 sendError，不静默吞、
 * 不 stale 广播。extrasStore 未注入时丢弃 + warn（宁丢不写错位——生产恒注入，与 catalog
 * apiKey 无 authStorage 时的处理对称）。
 */
function persistAuthMethod(
  extrasStore: ProviderExtrasAccessors | undefined,
  providerId: string,
  authMethod: SetProviderInput['authMethod'],
): Promise<unknown> | undefined {
  if (authMethod === undefined) return undefined
  if (!extrasStore) {
    console.warn(`[config-service] authMethod dropped for ${providerId}: providerExtrasStore not injected (A1-5)`)
    return undefined
  }
  return extrasStore.modify(providerId, current => ({ ...current, authMethod }))
}

/**
 * model 级 enabled 状态落 providers.json（G3 写侧切换，从 setProvider 提取）：extrasStore 注入
 * 时委托 persistModelStates（保留集合计算与写入守卫见该函数），未注入 + 有显式启停更新时丢弃 +
 * warn（宁丢不写错位——生产恒注入）。
 *
 * 返回 modify promise 供调用方条件 await（守卫不通过 / 未注入返回 undefined，不产生微任务
 * 边界）。await 对齐 authMethod 的 MF-1 语义：modify 失败 reject 上抛（handler try-catch 转
 * sendError），不静默吞。
 */
function persistModelStatesIfInjected(
  extrasStore: ProviderExtrasAccessors | undefined,
  providerId: string,
  mergedModels: ConfigModelDefinition[],
  statesUpdates: Record<string, { enabled: boolean }>,
): Promise<unknown> | undefined {
  if (extrasStore) {
    return persistModelStates(extrasStore, providerId, mergedModels, statesUpdates)
  }
  if (Object.keys(statesUpdates).length > 0) {
    console.warn(`[config-service] model enabled states dropped for ${providerId}: providerExtrasStore not injected (G3 写侧切换)`)
  }
  return undefined
}

/**
 * api 入口归一（从 setProvider 提取）：`type` 是 SetProviderData 的历史字段名，pi 终值字段名是
 * `api`——未传 type（undefined）= 不变（不触发翻译，保持既有值）。
 */
function resolveProviderApi(configStore: IConfigStore, type: string | undefined): string | undefined {
  if (type === undefined) return undefined
  return configStore.applyTypeTranslation(type)
}

/**
 * 网关标记落 extras（设计 D1③ 写序契约第一步，从 setProvider 提取）：设置网关 = 先写 extras
 * 标记、后写 models.json——崩溃中间态为「标记在、键未落盘」（多余标记，D2 启动清洗自愈）；
 * 反向序会让用户网关在崩溃窗口被当成无标记 artifact 剥除（静默丢网关）。
 *
 * 返回 modify promise 供调用方条件 await（无网关写入 / extrasStore 未注入返回 undefined，不
 * 产生微任务边界）。extrasStore 未注入时丢弃 + warn（宁丢不写错位，生产恒注入）。
 */
function persistGatewayMarker(
  extrasStore: ProviderExtrasAccessors | undefined,
  providerId: string,
  gatewayBaseUrl: string | undefined,
): Promise<unknown> | undefined {
  if (gatewayBaseUrl === undefined) return undefined
  if (!extrasStore) {
    console.warn(`[config-service] gateway marker dropped for ${providerId}: providerExtrasStore not injected (D1③)`)
    return undefined
  }
  return extrasStore.modify(providerId, current => ({ ...current, gatewayBaseUrl }))
}

/**
 * 防线③① 不物化**新**空壳判定（从 setProvider 提取）：新建（existingConfig === undefined）且八
 * 字段全缺 → 跳过 upsert，不产生 models.json 条目（对齐 M5-01「宁丢不写错位」）。既有条目一律
 * upsert（剥除/清除必须落盘，详见 setProvider 调用点注释）。
 */
function shouldSkipUpsert(skipUpsert: boolean | undefined, existingConfig: unknown): boolean {
  return skipUpsert === true && existingConfig === undefined
}

/**
 * 清网关标记 - 写序契约第二步（从 setProvider 提取）：先删 models.json 键（已由载体删除）、后清
 * extras 标记。仅 gatewayToClear 信号为真时才读 extras；先读一次，标记不存在则短路不调 modify
 * （extrasStore.modify 无内容 diff 守卫，避免无谓写盘）。本函数在 upsert 之后调用。
 *
 * 返回 modify promise 供调用方条件 await（信号为假 / 标记不存在返回 undefined，不产生微任务
 * 边界）。
 */
function clearGatewayMarker(
  extrasStore: ProviderExtrasAccessors | undefined,
  providerId: string,
  gatewayToClear: boolean | undefined,
): Promise<unknown> | undefined {
  if (gatewayToClear !== true) return undefined
  const currentExtras = extrasStore?.getExtrasSync(providerId)
  if (!extrasStore || currentExtras?.gatewayBaseUrl === undefined) return undefined
  return extrasStore.modify(providerId, current => {
    const next = { ...current }
    delete next.gatewayBaseUrl
    return next
  })
}

/**
 * 新建 / 更新 provider（wave3 边界1 白名单守卫 + I9 auth.json 清理 + catalog 分体系）。
 * 纯函数：configStore / authStorage / extrasStore / credentialWriter 经参数注入
 * （原 ConfigService.setProvider 逐字搬迁）。
 *
 * A1-5 写侧切换：authMethod 写 config/providers.json（extrasStore），不再寄生 models.json；
 * quota 分支已删除（历史死分支，无前端调用方——防复活，quota 配置唯一写路径是
 * QuotaService.configure → providers.json）。
 * A1-4 收口：catalog apiKey 写入经 credentialWriter（AuthService.saveCredential），
 * 不再直接持有 authStorage.set。
 */
export async function setProvider(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasAccessors | undefined,
  credentialWriter: CredentialWriter | undefined,
  providerId: string,
  data: SetProviderInput,
): Promise<{ newDefault?: { provider: ProviderId; modelId: string } }> {
  // wave3：existingConfig===undefined 判定「新建 provider」（边界1 白名单守卫用）
  const existingConfig = configStore.getProviderConfig(providerId)
  const existing = existingConfig ?? {}
  // A1：merged 提前声明——catalog 分支 delete merged.apiKey 需在声明之后（原顺序触发 TDZ TS2448/2454）
  // TODO: 当 pi models.json 支持 schema 后收窄类型（现有 Record<string, unknown> 是架构限制）
  const merged: Record<string, unknown> = { ...existing }
  // I9 清理① + catalog 分体系 + M5-01 只归 auth.json 决策：见 applyProviderCredentials。
  // 条件 await：无落盘路径（undefined）不产生微任务边界，保持同步前缀时序契约。
  const credentialsFlush = applyProviderCredentials(merged, authStorage, credentialWriter, providerId, data)
  if (credentialsFlush) await credentialsFlush
  // I6 + A1-5 写侧切换：authMethod 写 config/providers.json（不再寄生 models.json）——
  // 「条件 await」时序契约与丢弃语义见 persistAuthMethod。
  const authMethodFlush = persistAuthMethod(extrasStore, providerId, data.authMethod)
  if (authMethodFlush) await authMethodFlush
  // headers/authHeader 白名单写入。baseUrl/name/apiKey/api 的空串转译与 catalog 分体系
  // 语义委托防线载体（下方 models 装配后统一调用一次，见 applyProviderWritePolicy）。
  applyProviderHeaderFields(merged, providerId, data)
  // wave3 C5/TC6：停用 provider 级 enabled 写入——provider 启用改由 enabledModels 白名单承载
  // （wave2 listProviders 已不读 models.json provider.enabled）。前端 onToggleEnabled 改走
  // toggleProviderEnabled（wave4），不再传 data.enabled 给 setProvider。data.enabled 参数声明保留
  // （向后兼容），但不写入 models.json。model 级 enabled（下文 model 合并逻辑）保留。
  // A1-5：quota 写入分支已删除（历史死分支：无前端调用方传 quota；quota 配置唯一写路径是
  // QuotaService.configure → config/providers.json）。禁止恢复经 setProvider 写 models.json quota。
  if (data.models !== undefined) {
    const rawModels = data.models as Array<Record<string, unknown>>
    const existingModels = (existing.models ?? []) as ConfigModelDefinition[]
    // G3 写侧切换：model 级 enabled 收集到 providers.json modelStates（下方 modify 落盘），
    // 不再写 models.json（pi schema 外寄生字段）。
    const modelStatesUpdates: Record<string, { enabled: boolean }> = {}
    // 防线②（模型级空 id）：mergeProviderModel 对空/纯空白 id 返回 null，此处剔除——
    // 空 id 条目落盘会毒化整个 models.json（pi id 是必需 minLength:1 字段）。
    merged.models = rawModels
      .map(m => mergeProviderModel(m, existingModels, modelStatesUpdates, providerId))
      .filter((m): m is ConfigModelDefinition => m !== null)
    // G3 写侧切换：model 级 enabled 落 providers.json modelStates。await 对齐 authMethod
    // 的 MF-1 语义：modify 失败 reject 上抛（handler try-catch 转 sendError），不静默吞。
    // extrasStore 未注入时丢弃 + warn（宁丢不写错位——生产恒注入）。
    //
    // S2（round 1 review suggestion）：旧实现只合并不清理（{...current, ...updates}）——
    // 编辑体删除某自定义模型后其 modelStates 条目残留，同 id 重新添加时旧 disabled 复活。
    // 改按保留集合（retainIds）重建（保留集合计算与写入守卫见 persistModelStates）。
    // 保留集合内：本次显式 enabled 优先，未显式传的保留既有状态（不丢未标注模型的状态）。
    // （「条件 await」与丢弃分支归 persistModelStatesIfInjected。）
    const modelStatesFlush = persistModelStatesIfInjected(
      extrasStore,
      providerId,
      merged.models as ConfigModelDefinition[],
      modelStatesUpdates,
    )
    if (modelStatesFlush) await modelStatesFlush
  }
  // ── 防线②③ 载体接线（设计 D1）──
  // 必须在 models 装配**之后**调用：载体产出 skipUpsert 时读的是装配完成的 merged.models，
  // 传原始 payload 会覆盖 mergeProviderModel 的 base spread 合并（见 ProviderWritePolicyInput.models
  // 注释）。入口归一：type 是 SetProviderData 的历史字段名，pi 终值字段名是 api。
  const api = resolveProviderApi(configStore, data.type)
  const { gatewayToSet, gatewayToClear, skipUpsert } = applyProviderWritePolicy(
    merged,
    { name: data.name, baseUrl: data.baseUrl, apiKey: data.apiKey, api },
    isCatalogProvider(providerId) ? 'catalog' : 'custom',
    'settings',
    providerId,
  )
  // 写序契约（设计 D1③）第一步：设置网关 = 先写 extras 标记、后写 models.json（见
  // persistGatewayMarker；extrasStore 未注入时丢弃 + warn——宁丢不写错位，生产恒注入）。
  const gatewayFlush = persistGatewayMarker(extrasStore, providerId, gatewayToSet)
  if (gatewayFlush) await gatewayFlush
  let result: UpsertProviderResult = {}
  // 防线③ 语义（设计 D1③）——两层必须分清：
  //  ① 不物化**新**空壳：新建（existingConfig === undefined）且八字段全缺 → 跳过 upsert，
  //     不产生 models.json 条目（对齐 M5-01「宁丢不写错位」）。载体已 warn
  //     `skipped empty provider entry`。
  //  ② 既有条目的剥除/清除**必须落盘**：既有条目一律 upsert。载体已把 merged 剥除干净
  //     （无 schema 违规值），不重新引入毒化；若此处也跳过，用户「清空网关/字段」就是静默
  //     no-op（盘上旧 baseUrl 仍在 → 展示回内置端点但 pi 仍打旧网关，违反 G1「展示 = 生效」
  //     与验收场景 A'/5）。设计 D1③ 的「对既有条目是 no-op 而非删除」指**不删除既有条目**
  //     （用户全清空后旧条目仍在盘上、由 D2 启动清洗接管），不是「既有条目跳过写盘」。
  if (!shouldSkipUpsert(skipUpsert, existingConfig)) {
    result = configStore.upsertProvider(providerId, merged)
  }
  // 边界1（wave3 TC5 / C2）：新建 provider 时若 enabledModels 非空，加 <id>/* 白名单守卫——
  // 否则在白名单语义下新 provider 默认不启用（与 importer applyImport 的 upsertProvider 后
  // 守卫对称，共用水台函数 ensureProviderInWhitelist）。**不受 skipUpsert 影响**：catalog
  // 定义在 pi 内置 catalog，无 models.json 条目时 provider 依然存在可用（内置定义 + auth.json
  // 凭据），`<id>/*` 不是死引用；且守卫幂等（pattern 已存在 no-op），首次配置凭据的 catalog
  // 用户不能因「不物化条目」而漏启用。
  if (existingConfig === undefined) {
    configStore.ensureProviderInWhitelist(providerId)
  }
  // 清除网关 = 写序契约第二步：先落 models.json 键删除（已由载体删除）、后清 extras 标记
  // （见 clearGatewayMarker，本调用点在 upsert 之后）。
  const gatewayClearFlush = clearGatewayMarker(extrasStore, providerId, gatewayToClear)
  if (gatewayClearFlush) await gatewayClearFlush
  return result
}

/**
 * 切换 provider 启用状态（wave3 IF2 / C1）——写 enabledModels 白名单。
 * 纯函数：configStore 经参数注入（原 ConfigService.toggleProviderEnabled 逐字搬迁）。
 * credentialResolver 必需（M2fg）：defaultModel 重选（pickEnabledDefaultModel → listProviders
 * 的 B1 凭据优先判定）经唯一凭据通道批量 sync 版。
 *
 * enabled=true: 若 enabledModels 非空，加 `<id>/*`；空/undefined 时 no-op（CL1——
 *   全可用语义下 toggle(true) 无意义，加 pattern 反把其他 provider 隐式禁用）。
 * enabled=false: 移除所有 `<id>/*` 和 `<id>/<model>` pattern（provider 级 + model 级全清）。
 *   - 边界3（TC3）：重算后空 → clearEnabledModels（delete 字段，CL2），非 setEnabledModels([])。
 *   - 边界2（TC4）：若 defaultModel 承载该 provider，重选启用 provider 的 model + setDefaultModel，
     返回 newDefault 供前端同步。
 *
 * @returns 触发 defaultModel 重选时含 newDefault；否则空对象。
 */
export function toggleProviderEnabled(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasReader | undefined,
  credentialResolver: IProviderCredentialResolver,
  providerId: string,
  enabled: boolean,
): { newDefault?: { provider: ProviderId; modelId: string } } {
  const current = configStore.getEnabledModels()

  if (enabled) {
    // CL1：全可用（空/undefined）时 no-op——此时所有 provider 已启用，加 pattern 反而禁用其他
    if (current.length === 0) return {}
    const pattern = `${providerId}/*`
    if (current.includes(pattern)) return {} // 幂等
    configStore.setEnabledModels([...current, pattern])
    return {}
  }

  // enabled === false：移除所有 <id>/* 与 <id>/<model> pattern（startsWith('<id>/') 统一匹配两者）
  const prefix = `${providerId}/`
  const remaining = current.filter(p => !p.startsWith(prefix))
  if (remaining.length === current.length) {
    // 无 pattern 被移除（provider 不在白名单 / 白名单空）——幂等 no-op
    return {}
  }
  // 边界2（TC4）：先读 default 再更新白名单。生产 PiConfigStore.getDefaultModel 内部
  // findValidDefaultModel 会 auto-fix 写回（wasFixed:true）——若先更新白名单再读，被禁用
  // 的 default provider 已触发 auto-fix 重选（oldDefault 变成别的 provider），下方
  // oldDefault.provider === providerId 恒 false，pickEnabledDefaultModel 的 B1 凭据优先
  // 重选不可达（M5-02）。白名单更新前读取时该 provider 仍启用，default 若承载它返回原值。
  const oldDefault = configStore.getDefaultModel()
  // 边界3（TC3）：重算后空 → delete 字段（CL2），非写空数组（pi 语义空=全可用，写 [] 语义反转）；
  // 非空 → 写回新白名单
  if (remaining.length === 0) {
    configStore.clearEnabledModels()
  } else {
    configStore.setEnabledModels(remaining)
  }

  if (oldDefault && oldDefault.provider === providerId) {
    // 若 defaultModel 承载被禁用的 provider，显式「重选 + 持久化」（否则 pi session
    // scopedModels 不含该 provider，defaultModel 与 scope 错位）。复用 listProviders
    //（wave2 双源聚合 + deriveEnabled + B1 凭据优先）选新 default 并 setDefaultModel 写回，
    // 不依赖 getDefaultModel 的惰性 auto-fix（其 fallback 只扫 models.json，看不到
    // auth.json-only 的 catalog provider）。
    const newDefault = pickEnabledDefaultModel(configStore, authStorage, extrasStore, credentialResolver, providerId)
    if (newDefault) {
      configStore.setDefaultModel(newDefault.provider, newDefault.modelId)
      return { newDefault }
    }
  }
  return {}
}

/**
 * 边界2 重选 defaultModel（wave3 TC4）：从启用 provider 中选首个有 model 的。
 *
 * 复用 listProviders（wave2：catalog ∪ custom 双源聚合 + deriveEnabled 派生 enabled），
 * 避免重复实现聚合/凭据/catalog 兜底逻辑。excludedId 跳过被禁用的 provider 自身。
 * credentialResolver 必需（M2fg）：透传给 listProviders（凭据判定唯一通道）。
 * 返回 undefined 表示无可用启用 provider（UI 层 wave4 拒绝禁用最后一个）。
 */
function pickEnabledDefaultModel(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasReader | undefined,
  credentialResolver: IProviderCredentialResolver,
  excludedId: string,
): { provider: ProviderId; modelId: string } | undefined {
  const providers = listProviders(configStore, authStorage, extrasStore, credentialResolver)
  // B1：优先选有凭据（apiKeySet）的启用 provider 作 default，
  // 避免重选到无凭据的 catalog provider（用户禁用某 provider 触发重选时）。
  // 有凭据优先，找不到再 fallback 到任意启用 provider（含 ambient 认证如 bedrock）。
  // MF-3：候选 provider 选 model 时校验 model 级 enabled——p.models[0] 可能被用户显式禁用
  //（enabled:false，listProviders 经 toUserInfoModel 透传该字段），旧实现只校验 provider 级
  // p.enabled + p.models[0] 存在性，会把已禁用 model 写成新 default。改为 find 首个启用 model。
  const candidates = providers
    .filter(p => p.id !== excludedId && p.enabled)
    .map(p => ({ p, m: p.models.find(m => m.enabled !== false) }))
    .filter(x => x.m)
  const withCred = candidates.find(x => x.p.apiKeySet)
  if (withCred) return { provider: withCred.p.id, modelId: withCred.m!.id }
  const any = candidates[0]
  return any ? { provider: any.p.id, modelId: any.m!.id } : undefined
}

/**
 * 清 auth.json 凭据（api_key / oauth token），失败仅 console.warn 不抛出。
 *
 * 设计约束：auth.json 清理是 provider 删除的「附带卫生操作」（主语义是 models.json
 * 条目/override 删除），凭据清理失败不应阻断删除主流程，故 try-catch 吞错只记 warn。
 *
 * 必须 await（而非 fire-and-forget）：AuthStorage.remove 内部 withFileLock（统一
 * mkdir 锁 @zhushanwen/pi-file-lock/core，无 compromise 检测）是真异步，
 * fire-and-forget 时锁尚未获取、auth.json 未改写，紧随其后的 broadcastProviderList
 * → listProviders 会读到旧凭据，导致 catalog provider 删除后首次广播仍含该 provider。
 */
async function cleanAuthCredential(
  authStorage: AuthStorageAccessors | undefined,
  providerId: string,
  ctx: string,
): Promise<void> {
  if (!authStorage) return
  try {
    await authStorage.remove(providerId)
  // eslint-disable-next-line taste/no-silent-catch -- 凭据清理失败不阻断删除主流程（条目删除是主语义），warn 记录便于诊断
  } catch (err) {
    console.warn(`[config-service] auth.json cleanup failed ${ctx}:`, err)
  }
}

/**
 * 清 providers.json extras 条目（round 1 review suggestion：删除链不清理 extras →
 * custom provider 删除后 quota 绑定/modelStates/authMethod 永久残留、catalog「移除」
 * 后 quota.enabled 仍 true、同 id 重建静默继承旧配置）。M5-05「清残留」不变式扩展：
 * 与 cleanEnabledModelsResidue / cleanAuthCredential 同属删除链卫生操作。
 *
 * - 必须 await（而非 fire-and-forget）：TaijiProviderStore.delete 内部 withFileLock 是
 *   真异步，紧随其后的 broadcastProviderList → listProviders 双读 providers.json 会
 *   读到旧 extras（quota.enabled 仍 true）→ 广播 stale。
 * - 失败仅 warn 不阻断（与 cleanAuthCredential 同语义：条目删除是主语义）。
 * - 返回 boolean 失败信号（D12/改动 5）：true = 条目已删或本就不存在（幂等成功），
 *   false = IO 异常未确认删除。调用方 cleanDeleteTail 据此决定是否继续清 quota 副产物。
 *   未注入 extras 通道时同样返回 false——无法确认标记已清，按排序约束取保守方向。
 * - 幂等：条目不存在时跳过写、文件不存在不物化（TaijiProviderStore.delete 保证）。
 */
async function cleanProviderExtras(
  extrasStore: ProviderExtrasDeleter | undefined,
  providerId: string,
  ctx: string,
): Promise<boolean> {
  if (!extrasStore) return false
  try {
    await extrasStore.delete(providerId)
    return true
  } catch (err) {
    console.warn(`[config-service] providers.json extras cleanup failed ${ctx}:`, err)
    return false
  }
}

/**
 * 删除链共享尾部（D12/改动 5）：清 providers.json extras 条目，**确认成功之后**才清 quota 副产物。
 *
 * 排序约束（为什么两者不能并列清理）：quota 副产物清理会删 `secrets/<pid>-{cookie,apikey}.txt`
 * 明文，而 `quota.apiKeySet` / `cookieSet` 标记还写在 providers.json extras 里。extras 删失败
 * 却先删了 secrets 会留下「标记 true + 文件已删」的幽灵标记——同 id 重建的凭证归属判定会读到
 * 假状态，正是 D12 要对齐的 M5-05「同 id 重建不静默继承旧配置」缺口。两个失败方向里宁可留下
 * 「标记与文件一致」的残留（重试删除即清），也不制造幽灵标记。
 *
 * 清理回调失败只 warn 不阻断删除主流程（对齐 cleanAuthCredential / cleanProviderExtras 既有
 * 语义）；extras 未确认清除时整段跳过。三处落点（deleteProvider 尾 + removeProviderByKind 的
 * catalog / custom 两分支尾）共享本函数，避免排序逻辑写三遍（设计 §7.3 改动 5）。
 */
async function cleanDeleteTail(
  extrasStore: ProviderExtrasDeleter | undefined,
  quotaStateCleaner: QuotaStateCleaner | undefined,
  providerId: string,
  ctx: string,
): Promise<void> {
  const extrasCleared = await cleanProviderExtras(extrasStore, providerId, ctx)
  if (!extrasCleared || !quotaStateCleaner) return
  try {
    await quotaStateCleaner(providerId)
  } catch (err) {
    // quota 副产物清理失败不阻断删除主流程（best-effort，同 cleanProviderExtras 语义）：
    // 条目删除是主语义且此处已确认成功，故只记录不重抛（删除链的调用方无法补救一次
    // 已失败的副产物清理）；留 warn 便于诊断，残留的孤立 secrets 文件由下次同 id 删除
    // 的幂等清理兜底。注释内置而非抑制指令 —— taste/no-silent-catch 的 best-effort 放行
    // 口径正是「catch 体内含解释性注释」，无需 suppression 注释。
    console.warn(`[config-service] quota state cleanup failed ${ctx}:`, err)
  }
}

/**
 * 删除链共享前置（M5-05「清残留」不变式）：删 models.json 条目 + 清 enabledModels
 * 残留（`<id>/*` 与 `<id>/<model>` pattern，否则列表/白名单残留已删 provider 的死引用）
 * + 清 scopedModels 中该 provider 的残留条目。deleteProvider / removeProviderByKind
 * catalog 与 custom 三路径同序执行，返回 removeProvider 的 default 重选结果。
 */
async function removeProviderCore(
  configStore: IConfigStore,
  extrasStore: ProviderExtrasDeleter | undefined,
  providerId: string,
): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }> {
  const result = configStore.removeProvider(providerId)
  configStore.cleanEnabledModelsResidue(providerId)
  if (extrasStore) {
    await extrasStore.cleanScopedModelsResidue(providerId)
  }
  return result
}

/**
 * 删除 provider（I8：await 清 auth.json 凭据）。
 * 纯函数：configStore / authStorage / extrasStore 经参数注入。
 *
 * quotaStateCleaner（D12）：可选注入的 quota 副产物清理回调，只在 extras 条目确认清除后执行
 * （排序约束见 cleanDeleteTail）；未注入时该步 no-op（可选注入语义，生产恒注入）。
 */
export async function deleteProvider(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: ProviderExtrasDeleter | undefined,
  providerId: string,
  quotaStateCleaner?: QuotaStateCleaner,
): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }> {
  // I8：删 provider 后 await 清 auth.json 凭据（OAuth token 强绑定，不能残留）。
  // 幂等：auth.json 无该 provider 时 no-op。顺序：先删条目（同步生效）→ 再 await 清凭据，
  // 保证 handler await 返回时条目+凭据都已清，broadcastProviderList 拿到干净列表。
  const result = await removeProviderCore(configStore, extrasStore, providerId)
  await cleanAuthCredential(authStorage, providerId, `(I8) ${providerId}`)
  // extras 同步清理（review suggestion）：quota/modelStates/authMethod 不残留，同 id 重建
  // 不静默继承旧配置。幂等（无条目 no-op）；quota 副产物清理只在 extras 确认清除后执行（D12）。
  await cleanDeleteTail(extrasStore, quotaStateCleaner, providerId, `(deleteProvider) ${providerId}`)
  return result
}

/**
 * 按体系移除 provider（wave4 IF3 / C2）——catalog 与 custom 分体系处理。
 * 纯函数：configStore / authStorage / extrasStore 经参数注入。
 * credentialResolver 必需（M2fg）：defaultModel 重选（pickEnabledDefaultModel → listProviders
 * 的 B1 凭据优先判定）经唯一凭据通道批量 sync 版。
 *
 * 与 deleteProvider 的区别：deleteProvider 不分体系直接 configStore.removeProvider（向后兼容
 * 保留）；removeProviderByKind 按 ProviderInfo.kind 收窄，避免误删 catalog 定义。
 *
 * - catalog：定义来自 pi 二进制内置（不可删），只清用户侧状态——auth.json 凭据
 *   （authStorage.remove）+ models.json override 条目（configStore.removeProvider 若有 override）
 *   + enabledModels 残留 + providers.json extras 条目（「移除=清用户状态」语义：quota 绑定/
 *   modelStates/authMethod 一并清，否则额度链路继续对无凭证 provider 发查询）。清后该
 *   catalog provider 凭据全无，listProviders 双源聚合不再显示。
 * - custom：定义全在 models.json，删条目即删定义——configStore.removeProvider + 清残留
 *   + extras 清理（同 id 重建不静默继承旧 quota/启停配置）。
 *
 * newDefault：configStore.removeProvider 内部在 default 承载被删 provider 时重选并返回
 * （wave3 既有行为），透传给 transport 层广播 config.defaults。
 *
 * @param kind ProviderInfo.kind（renderer 传入，wave2 聚合层权威标注）
 * @param quotaStateCleaner （D12）可选 quota 副产物清理回调，catalog / custom 两分支都只在
 *   extras 条目确认清除后执行（排序约束见 cleanDeleteTail）；未注入时该步 no-op。
 */
export async function removeProviderByKind(
  configStore: IConfigStore,
  authStorage: AuthStorageAccessors | undefined,
  extrasStore: (ProviderExtrasReader & ProviderExtrasDeleter) | undefined,
  credentialResolver: IProviderCredentialResolver,
  providerId: string,
  kind: 'catalog' | 'custom',
  quotaStateCleaner?: QuotaStateCleaner,
): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }> {
  if (kind === 'catalog') {
    // 清 models.json override 条目（若有）。无 override 时 removeProvider 返回 { removed: false }，
    // 不影响后续清残留——catalog 的「移除」语义是清用户侧状态，override 本就可能不存在。
    // MF-2（顺序缺陷）：预读 oldDefault 在所有 mutation 之前（removeProvider /
    // cleanEnabledModelsResidue）。生产 PiConfigStore.getDefaultModel 内部 findValidDefaultModel
    // 会 auto-fix 写回（wasFixed）——若在 cleanEnabledModelsResidue（白名单变更）之后读取，
    // 被删 catalog provider 的白名单 pattern 已被清除触发 auto-fix 重选，oldDefault.provider
    // 已变成别的 provider，下方 oldDefault.provider === providerId 恒 false，M5-03 显式 B1
    // 凭据优先重选（pickEnabledDefaultModel）不可达。与 toggleProviderEnabled（先读 default 再
    // 更新白名单）顺序对齐。override 分支（removeProvider 返回 removed:true）内部自重选 default，
    // 不消费 oldDefault，预读对其无影响（无 override 时 removeProvider 返回 removed:false 不 mutate）。
    const oldDefault = configStore.getDefaultModel()
    // MF1 修复（exec-review must-fix）：catalog override 承载 defaultModel 时 removeProvider 内部
    // 重选 default + mutate settings.json，透传 newDefault 让 handler 广播 config.defaults
    // （与 custom 分支 + deleteProvider 对称，否则 renderer 收不到重选通知）。
    // （MF-2 oldDefault 预读与 default 重选逻辑见下方，removeProviderCore 含清残留三连）
    let overrideResult = await removeProviderCore(configStore, extrasStore, providerId)
    // M5-03（G2 增删入口自动维护 defaultModel）：catalog provider 无 models.json override 时
    // removeProvider 提前 return { removed:false }，跳过 defaultProvider/defaultModel 清理重选
    //（「导入后无 override 的 catalog provider 承载 default」正是 G4 移除流程的常态形态，
    // MF1 修复只覆盖 override 分支）。default 承载该 provider 时显式重选并持久化（复用
    // toggle 边界2 的 pickEnabledDefaultModel，B1 凭据优先），透传 newDefault 广播 config.defaults。
    if (!overrideResult.removed) {
      if (oldDefault && oldDefault.provider === providerId) {
        const newDefault = pickEnabledDefaultModel(configStore, authStorage, extrasStore, credentialResolver, providerId)
        if (newDefault) {
          configStore.setDefaultModel(newDefault.provider, newDefault.modelId)
          overrideResult = { removed: false, newDefault }
        }
      }
    }
    // 清 auth.json 凭据（api_key / oauth token，强绑定凭据不能残留）。await：remove 内部
    // withFileLock 是真异步，fire-and-forget 会导致 broadcastProviderList 读到旧凭据 → 广播
    // stale 列表（catalog provider 删除后首次广播仍含该 provider 的根因）。失败仅 warn 不阻断。
    await cleanAuthCredential(authStorage, providerId, `for catalog provider ${providerId}`)
    // 清 providers.json extras（review suggestion）：catalog「移除」语义=清用户侧状态，
    // quota.enabled=true 残留会让额度链路继续对无凭证 provider 发查询。幂等无风险。
    // D12：extras 确认清除后才清 quota 副产物（secrets 明文 + 失败/节流标记 + 缓存条目）。
    await cleanDeleteTail(extrasStore, quotaStateCleaner, providerId, `for catalog provider ${providerId}`)
    // catalog 定义不可删（pi 二进制内置），「移除」= 清凭据/override/残留。removed=true 表示
    // 用户侧状态已清，listProviders 双源聚合（凭据 ∪ override）将不再显示该 provider。
    return { removed: true, newDefault: overrideResult.newDefault }
  }
  // custom：删 models.json 条目（= 删定义）+ 清残留。removeProvider 内部含 defaultModel 重选。
  // custom 凭据随条目存在 models.json（apiKey 字段），删条目即清；auth.json 无需单独清理。
  const result = await removeProviderCore(configStore, extrasStore, providerId)
  // extras 同步清理（review suggestion）：同 deleteProvider，防同 id 重建继承旧配置。
  // D12：extras 确认清除后才清 quota 副产物（同 catalog 分支，共享 cleanDeleteTail）。
  await cleanDeleteTail(extrasStore, quotaStateCleaner, providerId, `for custom provider ${providerId}`)
  return result
}
