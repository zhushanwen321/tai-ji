/**
 * Model 字段映射纯函数（R6 收敛）。
 *
 * 此前 `ConfigModelDefinition → ProviderInfo.models 元素`（config-service.listProviders）
 * 与 `ProviderInfo.models 元素 → ModelInfo`（model-service.aggregateModels）各自手工逐字段
 * 展开同一组 capability 字段（reasoning/contextWindow/maxTokens/thinkingLevelMap/cost）。
 * 两处输出形状不同：ProviderInfo.models 保留 input/baseUrl/compat；ModelInfo 扁平化 provider
 * 信息 + 派生 enabled。故只抽**共同 capability 字段拷贝**，不强行合并形状差异。
 */
import type { ModelInfo, ProviderId } from '@taiji/shared'

/**
 * 一个 model 定义所需的最小 capability 字段集（两处映射共同拷贝的部分）。
 * 兼容 ConfigModelDefinition 与 ProviderInfo.models 元素（结构同构）。
 */
interface ModelCapabilityFields {
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

/**
 * 拷贝两个映射点共同展开的 capability 字段（reasoning/contextWindow/maxTokens/thinkingLevelMap/cost）。
 * config-service.listProviders 与 model-service.aggregateModels 都经此函数，消除逐字段复制。
 */
export function pickModelCapabilityFields<T extends ModelCapabilityFields>(m: T): ModelCapabilityFields {
  return {
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    thinkingLevelMap: m.thinkingLevelMap,
    cost: m.cost,
  }
}

/**
 * 把单个 model 定义展平为 ModelInfo（model-service.aggregateModels 的逐项映射）。
 *
 * 相比 config-service 的 provider-info model 元素，ModelInfo 扁平化 provider 信息（providerId/
 * providerName）、派生 api（model 缺省回落 provider api）与 enabled，且不含 input/baseUrl/compat
 * （ModelInfo 类型无此字段）。capability 字段经 {@link pickModelCapabilityFields} 拷贝。
 *
 * @param providerId    所属 provider id
 * @param providerName  所属 provider 展示名
 * @param providerApi   所属 provider 的 api 标识（model 缺省 api 时回落）
 * @param m             源 model 定义（ConfigModelDefinition 或 ProviderInfo.models 元素）
 */
export function toModelInfo<T extends { id: string; name?: string; api?: string; enabled?: boolean } & ModelCapabilityFields>(
  providerId: ProviderId,
  providerName: string,
  providerApi: string | undefined,
  m: T,
): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    providerId,
    providerName,
    // 本回落路径在 catalog 混合协议 provider 上真实可达（设计 §3.3 D5 消费点表）：这类 provider
    // 的 provider 级协议不是定义权威（协议随模型走，聚合层对混合协议下发 providerApi=undefined），
    // 故 model 与 provider 同时无 api 时 ModelInfo.api 即 undefined。该字段只作元数据展示
    // （provider 详情 / 模型列表），聊天协议由 pi 侧按模型自身定义解析，不读此处——
    // 不要把 undefined 当作「协议缺失」的错误信号。
    api: m.api ?? providerApi,
    // W2：从 model.enabled 读，undefined/true 视为启用（向上兼容存量无此字段的 model）
    enabled: m.enabled !== false,
    ...pickModelCapabilityFields(m),
  }
}
