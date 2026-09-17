/**
 * ModelService — model aggregation, API discovery, and model/thinking-level orchestration.
 *
 * The unified business entry for switchModel and setThinkingLevel.
 * All callers (frontend WS handler, plugin RPC) must go through this
 * service to ensure consistent side-effects (broadcast).
 *
 * session 级状态（modelId / thinkingLevel / inputTokens / usagePercent）的单一 owner 是
 * SessionService；本服务只负责委托 SessionService 做 session 级 RPC/缓存/broadcast。
 * usagePercent 不再在此计算（去重到 SessionService.computeUsage）。
 *
 * D4（composer-model-session-isolation）：switchModel 不再广播 config.defaults——
 * 全局默认回归 Settings 配置单一语义（sendInitialState 推送），session 级切换不再改全局默认。
 *
 * aggregateModels is pure data transformation (stays here). discoverFromApi is
 * external HTTP — delegated to IModelSource (injected, infra implements).
 *
 * discoverModelsFromApi 负责把 infra 抛出的原始错误（ByteString / fetch failed 等）
 * 分类成结构化 ModelDiscoveryError（含 code + 中文文案）。transport 只 catch + reply，
 * 不再硬编码中文错误文案。
 */
import type { ProviderInfo, ModelInfo, ProviderId } from '@taiji/shared'
import type { IModelService, ISessionService, IConfigService, IMessageBroker } from '../interfaces.js'
import type { IModelSource } from './ports/model.js'
// port 类型从本源导入（ports 文件头自述消费模式；infra 仅作实现侧 re-export 不作类型消费源）
import type {
  ConnectionTestRequest,
  ConnectionTestResult,
  IModelConnectionTester,
} from './ports/model-connection-tester.js'
import { toErrorMessage } from '../utils/errors.js'
import { toModelInfo } from './model-mapper.js'
import { isCatalogProvider } from './provider-catalog.js'
import {
  attachSupportedLevels,
  runCapabilityReconcile,
  type CapabilityDrift,
} from './model-capability.js'

/** discoverModelsFromApi 错误码（domain→文案映射归 service）。 */
export type ModelDiscoveryErrorCode =
  | 'INVALID_AUTH_CHARS' // ByteString：Base URL / API Key 含 HTTP 不支持的字符
  | 'UNREACHABLE'        // fetch failed：无法访问目标 /v1/models
  | 'UNKNOWN'

/**
 * 结构化模型发现错误。code 供调用方分支判断，message 为可直接展示的中文文案。
 *
 * 与 ExtensionInstallError（extension-service）/ FileError 范式对称：readonly code + super(message)。
 */
export class ModelDiscoveryError extends Error {
  readonly code: ModelDiscoveryErrorCode

  constructor(code: ModelDiscoveryErrorCode, message: string) {
    super(message)
    this.name = 'ModelDiscoveryError'
    this.code = code
  }
}

// ── 测试连接（per-协议真实最小请求，design catalog-provider-field-authority §3.3 D4）──────

/**
 * test 模式 provider 级错误码（`config.discoveredModels` reply 顶层 error）。
 * 行级错误码见 `ConnectionTestPlanEntry.error`（`<code>|<params>` 语法在 infra 实现内定义）。
 * 前端按 code 选 i18n key（settings.providerEdit.testNoApiKey / testNoModels 等），未知 code 走通用失败文案。
 */
export const PROVIDER_CONNECTION_TEST_ERRORS = {
  /** providerId 不在聚合列表（前端传错 / provider 已删）。 */
  providerNotFound: 'provider_not_found',
  /** provider 无模型（或全部模型无协议信息，pi 侧同样无法路由）。 */
  noModels: 'no_models',
  /** 凭据 resolver 全源 miss（含未注入 resolver 且 models.json 无 apiKey 的降级路径）。 */
  noApiKey: 'no_api_key',
  /** 注入的 modelService 未提供测试连接能力（测试替身 / 极旧装配的防御分支）。 */
  testUnavailable: 'test_unavailable',
} as const

/** test 模式结果：成功 = 逐协议行（行内可含失败）；provider 级失败 = 单个 code（无逐协议行）。 */
export type ProviderConnectionTestOutcome =
  | { success: true; results: ConnectionTestResult[] }
  | { success: false; error: string }

/** 行级错误码（`results[].error` 前缀；行级错误也参与 reply 顶层 success:true）。 */
export type ConnectionTestRowErrorCode =
  | 'unsupported'      // 协议不在首版支持集
  | 'no_base_url'      // 该协议组代表模型无可用 baseUrl（含空串，azure 类 host 型目录）
  | 'no_enabled_model' // 该协议组全部模型被禁用
  | 'http_error'       // 非 2xx（error = `http_error|<status>|<响应体截断>`）
  | 'network_error'    // fetch 层失败（error = `network_error|<message>`）

/** 测试连接能力面（transport 经 `SettingsHandlerContext.modelService` 的 Partial 交集调用）。 */
export interface ProviderConnectionTestService {
  testProviderConnections(
    providerId: string,
    apiKey: string | undefined,
    tester: IModelConnectionTester,
  ): Promise<ProviderConnectionTestOutcome>
}

/** 一条测试计划：`settled` = 已定论不发请求（协议不支持 / 无启用模型 / 无 baseUrl）；`target` = 待发包。 */
export type ConnectionTestPlanEntry =
  | { api: string; modelId: string; settled: ConnectionTestResult }
  | { api: string; modelId: string; target: ConnectionTestRequest }

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * 协议分组：模型级 api 优先、provider 级兜底（pi `provider-composer.js:49` modelFromJson
 * `definition.api ?? providerConfig.api`）；两者皆缺的模型无从分组（pi 侧同样无法路由）故跳过。
 * 组序 = 模型首现序（结果行序稳定可断言）。
 */
function groupModelsByApi(provider: ProviderInfo): Map<string, ProviderInfo['models']> {
  const groups = new Map<string, ProviderInfo['models']>()
  for (const model of provider.models) {
    const api = nonEmpty(model.api) ?? nonEmpty(provider.api)
    if (!api) continue
    const bucket = groups.get(api)
    if (bucket) bucket.push(model)
    else groups.set(api, [model])
  }
  return groups
}

/**
 * 单模型的生效 baseUrl（pi 权威顺序分两类，`provider-composer.js`）：
 * - catalog：provider 级 baseUrl = 用户网关，**覆盖**全部内置模型端点（`:98` applyModelsJson
 *   `config.baseUrl ?? model.baseUrl`）——网关优先于模型级；
 * - custom：模型级优先、provider 级兜底（`:55` modelFromJson `definition.baseUrl ?? providerConfig.baseUrl`）。
 * providerBaseUrl 传 models.json 条目的原始 provider 级 baseUrl（catalog 场景即网关 override；
 * 不消费 ProviderInfo.baseUrl——它含构建期 artifact）。
 */
function resolveModelBaseUrl(
  providerId: string,
  model: ProviderInfo['models'][number],
  providerBaseUrl: string | undefined,
): string | undefined {
  const modelLevel = nonEmpty(model.baseUrl)
  const providerLevel = nonEmpty(providerBaseUrl)
  return isCatalogProvider(providerId) ? (providerLevel ?? modelLevel) : (modelLevel ?? providerLevel)
}

/**
 * 测试连接计划（纯函数，无 IO）：按协议分组 → 每组选代表模型（双过滤：`enabled !== false`
 * 且生效 baseUrl 非空）→ 支持集内协议产出发包目标，其余产已定论错误行。
 * 双过滤语义：被禁用的模型不代表该协议；无可用 baseUrl 的模型不冒充网络错误（如实报 no_base_url）。
 */
export function planConnectionTests(
  providerId: string,
  provider: ProviderInfo,
  providerBaseUrl: string | undefined,
  tester: IModelConnectionTester,
): ConnectionTestPlanEntry[] {
  const entries: ConnectionTestPlanEntry[] = []
  for (const [api, models] of groupModelsByApi(provider)) {
    if (!tester.supports(api)) {
      entries.push({ api, modelId: '', settled: { api, modelId: '', ok: false, error: 'unsupported' } })
      continue
    }
    if (!models.some(m => m.enabled !== false)) {
      entries.push({ api, modelId: '', settled: { api, modelId: '', ok: false, error: 'no_enabled_model' } })
      continue
    }
    let target: ConnectionTestRequest | undefined
    for (const model of models) {
      if (model.enabled === false) continue
      const baseUrl = resolveModelBaseUrl(providerId, model, providerBaseUrl)
      if (baseUrl === undefined) continue
      target = { api, modelId: model.id, baseUrl }
      break
    }
    if (target) entries.push({ api, modelId: target.modelId, target })
    else entries.push({ api, modelId: '', settled: { api, modelId: '', ok: false, error: 'no_base_url' } })
  }
  return entries
}

export class ModelService implements IModelService, ProviderConnectionTestService {
  private sessionService!: ISessionService
  private configService!: IConfigService
  private broker!: IMessageBroker
  private nextPushId: () => string

  constructor(
    private readonly modelSource: IModelSource,
    pushIdFactory?: () => string,
  ) {
    this.nextPushId = pushIdFactory ?? (() => `push_${Date.now()}`)
  }

  /** Wire runtime dependencies (called after all services are constructed). */
  setServices(session: ISessionService, config: IConfigService, broker: IMessageBroker): void {
    if (!session || !config || !broker) {
      throw new Error('ModelService.setServices: all dependencies are required')
    }
    this.sessionService = session
    this.configService = config
    this.broker = broker
  }

  private ensureInitialized(): void {
    if (!this.sessionService || !this.configService || !this.broker) {
      throw new Error('ModelService not initialized — call setServices() first')
    }
  }

  /**
   * Unified switchModel entry point.
   *
   * 编排：pi RPC + 缓存更新 + 广播 session 级状态（全部委托 SessionService.switchModel，
   * 它是 session 级状态唯一 owner）。D4 移除 config.defaults 广播。
   *
   * 全局默认模型持久化：pi 0.84.4 实装中 setModel 不传 options.persist，
   * 只写 session 级 entries，不写 settings.json（全局默认）。全局默认
   * 回归 Settings 页配置的单一语义（sendInitialState 推送）。taiji 不再冗余写（D1d）。
   *
   * session.state_changed 的广播由 SessionService.switchModel 内部负责（含新 modelId +
   * thinkingLevel；usage 已随 D1 协议收敛移出该帧，经 context.update 单帧贯穿），
   * 本方法不再自己 broadcastSessionState。
   */
  async switchModel(sessionId: string, provider: ProviderId, modelId: string): Promise<string> {
    this.ensureInitialized()
    // 1. pi RPC + 缓存更新 + 广播 session.state_changed（session 级状态单一 owner；
    //    pi 0.84.4 setModel 只写 session 级 entries，不持久化全局默认）
    // U6 回执普查：透传 get_state 读回的生效模型复合串（pi pattern 换模时 ≠ 请求值）
    const effective = await this.sessionService.switchModel(sessionId, provider, modelId)

    // D4：移除 config.defaults 广播——全局默认回归 Settings 配置单一语义，
    // session 级切换不再改全局默认（landing 新任务默认模型改用 lastUsedModel，见 U4）。
    return effective
  }

  /**
   * Unified setThinkingLevel entry point.
   *
   * Delegates to SessionService (pi RPC). Thinking level is per-session
   * runtime state — no persistence needed. Returns pi-effective level
   * (P3: pi clamps levels unsupported by the model family).
   */
  async setThinkingLevel(sessionId: string, level: string): Promise<string> {
    this.ensureInitialized()
    return this.sessionService.setThinkingLevel(sessionId, level)
  }

  aggregateModels(providers: ProviderInfo[]): ModelInfo[] {
    // 对齐 switchModel/setThinkingLevel 既有范式：访问注入依赖前先检查已初始化
    this.ensureInitialized()
    return this.aggregateModelsWithScoped(providers, this.configService.getScopedModels())
  }

  /**
   * 双参版聚合：scopedModels 由调用方传入（读盘值跨 config.providers / model.list
   * 两条消息复用，消除 buildProviderListMsgs 双读盘间写者落盘导致的一帧不一致）。
   * 独立命名而非给公开 aggregateModels 加参——design D2 否决改其签名（单参语义
   * 「内部读白名单」已有多调用方依赖）。纯数据变换，不访问注入依赖。
   */
  aggregateModelsWithScoped(providers: ProviderInfo[], scopedModels: string[]): ModelInfo[] {
    // W2：runtime enabled 过滤——provider.enabled===false 时其下所有 model 不进结果；
    // model.enabled===false 时该 model 不进结果。缺省/true 视为启用（向上兼容存量）。
    // 过滤在 listProviders 读出 ProviderInfo 之后做，config.enabled !== false 语义统一在此处收敛。
    const allModels = providers
      .filter(p => p.enabled !== false)
      .flatMap(p =>
        p.models
          .filter(m => m.enabled !== false)
          .map(m => toModelInfo(p.id, p.name, p.api, m)),
      )

    // scoped model 过滤/排序（design §3.3 D2）：scopedModels 非空时按白名单过滤 + 按序重排
    if (scopedModels.length === 0) return allModels

    // 建立 model 索引（provider/modelId → ModelInfo）
    const modelIndex = new Map<string, ModelInfo>()
    for (const m of allModels) {
      modelIndex.set(`${m.providerId}/${m.id}`, m)
    }

    // 按 scopedModels 序输出（跨 provider 交错序保留）
    const result: ModelInfo[] = []
    for (const scoped of scopedModels) {
      const m = modelIndex.get(scoped)
      if (m) result.push(m) // 解析不到模型的 scoped 条目静默跳过
    }
    return result
  }

  async discoverModelsFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<Array<{ id: string; name: string; contextWindow?: number }>> {
    try {
      return await this.modelSource.discoverFromApi(baseUrl, apiKey, providerType)
    } catch (e) {
      // infra 原始错误分类成结构化 ModelDiscoveryError（含 code + 中文文案）。
      // 文案映射归 service（域决策），transport 只 catch + reply，不硬编码中文。
      throw this.classifyDiscoveryError(e, baseUrl)
    }
  }

  /** 把 infra 抛出的原始错误分类成 ModelDiscoveryError（domain→文案）。 */
  private classifyDiscoveryError(e: unknown, baseUrl: string): ModelDiscoveryError {
    const raw = toErrorMessage(e)
    if (raw.includes('ByteString')) {
      return new ModelDiscoveryError('INVALID_AUTH_CHARS', '请求失败：Base URL 或 API Key 包含 HTTP 不支持的字符')
    }
    if (raw.includes('fetch failed')) {
      return new ModelDiscoveryError('UNREACHABLE', `连接失败：无法访问 ${baseUrl}/v1/models`)
    }
    return new ModelDiscoveryError('UNKNOWN', raw)
  }

  /**
   * 测试连接编排（test 模式）：读聚合 provider → 计划（分组 + 双过滤 + baseUrl 回落链）→
   * 逐协议并发发真实最小请求（HTTP 归 infra 的 IModelConnectionTester，由调用方注入）。
   *
   * provider 级失败按 `PROVIDER_CONNECTION_TEST_ERRORS` 返回单 code（凭据 miss 是硬停——
   * 无凭据时任何协议都只会有 401，逐协议报错无信息量）；成功时逐协议行齐全（行内可失败）。
   */
  async testProviderConnections(
    providerId: string,
    apiKey: string | undefined,
    tester: IModelConnectionTester,
  ): Promise<ProviderConnectionTestOutcome> {
    this.ensureInitialized()
    const provider = this.configService.listProviders().find(p => p.id === providerId)
    if (!provider) return { success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.providerNotFound }
    if (provider.models.length === 0) return { success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noModels }
    if (!apiKey) return { success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noApiKey }
    // 原始 models.json provider 级 baseUrl（catalog = 网关 override；custom = provider 级定义），
    // 不取 ProviderInfo.baseUrl（含构建期 artifact）。
    const providerBaseUrl = this.configService.getProvider(providerId)?.baseUrl
    const entries = planConnectionTests(providerId, provider, providerBaseUrl, tester)
    // 全部模型无协议信息 → 无任何行可报，等同于无可用模型
    if (entries.length === 0) return { success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.noModels }
    // 协议组互不依赖：allSettled 保「单组异常不吞掉其他组结果」（组序 = entries 序）
    const settledResults = await Promise.allSettled(
      entries.map(entry => 'settled' in entry
        ? Promise.resolve(entry.settled)
        : tester.test({ ...entry.target, apiKey })),
    )
    const results = settledResults.map((outcome, index) => outcome.status === 'fulfilled'
      ? outcome.value
      // 防御分支：tester 约定内部归类不抛（infra 实现如此），抛出即按网络层失败成行
      : { api: entries[index].api, modelId: entries[index].modelId, ok: false, error: `network_error|${toErrorMessage(outcome.reason)}` })
    return { success: true, results }
  }

  // ── 能力注册表服务面（U5，pi-boundary-reliability design D2）──────────
  /** drift 事件上报出口（WS 协议消息类型属后续单元，宿主经 setCapabilityDriftSink 订阅）。 */
  private capabilityDriftSink: ((drifts: CapabilityDrift[]) => void) | undefined

  /** 订阅对账 drift 事件（重复调用覆盖：单订阅者语义，广播化需求出现时再扩）。 */
  setCapabilityDriftSink(sink: (drifts: CapabilityDrift[]) => void): void {
    this.capabilityDriftSink = sink
  }

  /**
   * 给 ProviderInfo.models 逐模型标注 supportedLevels（view-ready，renderer 零推导）。
   * piVersion 形参为 IModelService 契约位（缓存键时代的组分，接口签名由
   * interfaces.ts 钉死），直调形态下不消费。
   */
  attachSupportedLevels(providers: ProviderInfo[], _piVersion?: string): ProviderInfo[] {
    return attachSupportedLevels(providers)
  }

  /**
   * 在线对账：session 附着后调用（编排 / 降级路径见 runCapabilityReconcile——引擎
   * 不可用或 RPC 失败降级返回 []，绝不反噬附着主链路）。返回本次 drift 项（空 =
   * 一致）；对账结果不缓存不落盘（每附着一次对一次）。
   */
  async reconcileModelCapabilities(sessionId: string): Promise<CapabilityDrift[]> {
    this.ensureInitialized()
    return runCapabilityReconcile({
      sessionId,
      getEngine: () => this.sessionService.getRpcClient(sessionId),
      getConfigProviders: () => this.configService.listProviders(),
      onDrift: drifts => this.capabilityDriftSink?.(drifts),
    })
  }
}
