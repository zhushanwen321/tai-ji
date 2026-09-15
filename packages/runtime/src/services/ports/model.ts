/**
 * Model 域 ports —— 经 HTTP 探测 LLM API 获取可用模型列表。
 *
 * 🔒 三层架构：services 定义 port，infra/model-api-discoverer.ts 实现。
 * ModelService 的 aggregateModels 是纯数据转换（ProviderInfo[]→ModelInfo[]），
 * 属业务逻辑留 service；discoverFromApi 是外部 HTTP 调用，经此 port 注入。
 */

/** discoverFromApi 返回的模型元信息。 */
export interface DiscoveredModelMeta {
  id: string
  name: string
  contextWindow?: number
}

export interface IModelSource {
  /**
   * 探测 LLM API 的 /v1/models 端点，返回模型列表。
   * 兼容 anthropic（x-api-key）与 openai-compatible（Bearer）两种鉴权。
   */
  discoverFromApi(baseUrl: string, apiKey?: string, providerType?: string): Promise<DiscoveredModelMeta[]>
}
