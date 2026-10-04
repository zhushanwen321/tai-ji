/**
 * IModelSource 的 infra 实现 —— 经 HTTP 探测 LLM API 获取可用模型列表。
 *
 * 🔒 归属（R3c1，三层架构）：infra 层，实现 services/ports.ts 的 IModelSource。
 * 从 model-service.ts 迁入（R3c1）：fetch 外部 LLM API 是外部系统调用，
 * 归属 infra 而非 service。service 只做 aggregateModels（纯数据转换）。
 *
 * 兼容两种鉴权：anthropic（x-api-key + anthropic-version）、openai-compatible（Bearer）。
 */
import type { IModelSource, DiscoveredModelMeta } from '../services/ports/model.js'

const API_FETCH_TIMEOUT_MS = 10_000

/** 错误响应体回显截断长度（RT-7#9：照 model-connection-tester 的 ERROR_BODY_MAX_LEN
 * 形态——上游 body 可能整页 HTML，未截断直传会把技术长串原样透进 UI/error message）。 */
const ERROR_BODY_MAX_LEN = 200

/** 响应体压缩成单行 + 截断（与 model-connection-tester.toErrorSnippet 同形态）。 */
function toErrorSnippet(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_MAX_LEN)
}

export class ModelApiDiscoverer implements IModelSource {
  async discoverFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<DiscoveredModelMeta[]> {
    const base = baseUrl.replace(/\/+$/, '')
    let url: string
    const headers: Record<string, string> = {}

    if (providerType === 'anthropic' || providerType === 'anthropic-messages') {
      url = `${base}/v1/models`
      if (apiKey) {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      }
    } else {
      url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      const body = toErrorSnippet(await res.text().catch(() => ''))
      // message 前缀格式是 model-service.classifyDiscoveryError 的 429 匹配锚
      // （同仓内 discoverer ↔ service 契约，改动须两侧同步）
      throw new Error(`API 返回 ${res.status}: ${body || res.statusText}`)
    }

    const data = await res.json() as Record<string, unknown>

    const modelList = Array.isArray(data.data)
      ? data.data as Array<Record<string, unknown>>
      : Array.isArray(data.models)
        ? data.models as Array<Record<string, unknown>>
        : []

    return modelList
      .filter(m => typeof m.id === 'string')
      .map(m => ({
        id: m.id as string,
        name: (m.name ?? m.id) as string,
      }))
  }
}
