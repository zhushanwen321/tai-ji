/**
 * 测试连接（per-协议真实最小请求）—— IModelConnectionTester 的 infra 实现。
 *
 * 🔒 归属（三层架构）：infra 层，外部 HTTP 调用放这里（对齐 model-api-discoverer.ts 的
 * 归属模式）；编排（代表模型双过滤 + baseUrl 回落链）在 services/model-service.ts。
 *
 * 背景（design catalog-provider-field-authority §3.3 D4）：GET /v1/models 与真实聊天端点
 * 脱节——真实聊天按 `model.api` 协议 POST 到 `model.baseUrl`（pi-ai `dist/models.js` 按
 * model.api dispatch），且 pi 生态没有任何内置 provider 接线 fetchModels。故「测试连接」
 * = 对每个协议组的代表模型发该协议的**真实最小请求**：
 *
 *   anthropic-messages → POST {baseUrl}/v1/messages     body 含 max_tokens: 1
 *   openai-completions → POST {baseUrl}/chat/completions body 含 max_tokens: 1
 *   openai-responses   → POST {baseUrl}/responses        body 含 max_output_tokens: 16
 *
 * 端点形状与 pi-ai 一致：三个协议都由 SDK 在 baseURL 后追加 path，baseURL 即 model.baseUrl
 * （`pi-ai/dist/api/anthropic-messages.js:681`、`openai-completions.js:575`、
 * `openai-responses.js:191`）——所以直接拼 path 与 pi 实际聊天请求同源。
 *
 * P-test-req 实测（2026-09-10）：
 *   - anthropic-messages：真实端点（kimi-coding `https://api.kimi.com/coding`）`/v1/messages`
 *     + max_tokens:1 → 200；错误 key → 401 + JSON error body（可区分）
 *   - openai-completions：真实端点（deepseek `https://api.deepseek.com`、xiaomi
 *     `https://token-plan-cn.xiaomimimo.com/v1`）`/chat/completions` + max_tokens:1 → 200；
 *     错误 key → 401（可区分）
 *   - openai-responses：本机无 responses 凭据，用本地 stub 验证 URL/鉴权头/body 形状；
 *     **max_output_tokens 下限 16** 是协议硬约束（pi-ai `api/openai-responses.js:16-17`
 *     「OpenAI Responses rejects max_output_tokens below 16」，pi 自身发请求前也 clamp），
 *     故取 16 而非设计字面值 1——用 1 会对全部 responses provider 稳定误报 400
 *   - 网络错（不可达 host）→ `TypeError: fetch failed`
 *
 * 错误编码（`error` 字段，供 transport / 前端消费；本模块不产生面向用户的本地化文案）：
 *   `http_error|<status>|<响应体截断>`   非 2xx（如实带回状态码与真实响应原因）
 *   `network_error|<message>`           fetch 层失败（不可达 / 超时 / DNS）
 * 解析约定：按 `|` 切分，首段 = code、末段（含自身 `|`）= message；未知 code 走通用失败文案。
 */
import { toErrorMessage } from '../utils/errors.js'
// 接口已端口化（D-21，对齐 IModelSource 先例）：声明 SSOT 在 services/ports，本文件是
// infra 实现 + 既有 type-importer（model-service.ts 等）的兼容 re-export 面。
import type { ConnectionTestRequest, ConnectionTestResult, IModelConnectionTester } from '../services/ports/model-connection-tester.js'

export type { ConnectionTestRequest, ConnectionTestResult, IModelConnectionTester } from '../services/ports/model-connection-tester.js'

/** 首版支持连接测试的协议集（以 P-test-req 实测为准，见文件头；集合外 → 「暂不支持」）。 */
export const CONNECTION_TEST_APIS = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const

export type ConnectionTestApi = (typeof CONNECTION_TEST_APIS)[number]

/** 单次测试连接的墙钟上限（控制面单请求 = 秒级，design §3.3 D4 已接受代价①）。 */
const CONNECTION_TEST_TIMEOUT_MS = 10_000

/** 最小请求的生成上限（1 token 级；responses 另有协议下限，见下）。 */
const MIN_OUTPUT_TOKENS = 1

/** openai-responses 的 max_output_tokens 下限（pi-ai 同源常量，见文件头 P-test-req）。 */
const RESPONSES_MIN_OUTPUT_TOKENS = 16

/** HTTP 错误响应体在 error 里的截断长度（如实带回真实原因，不吞成固定文案）。 */
const ERROR_BODY_MAX_LEN = 200

/** anthropic 协议版本头（与 model-api-discoverer 同源值）。 */
const ANTHROPIC_VERSION = '2023-06-01'

/** 探活提示词（最小非空 content，anthropic / openai 两族均要求非空 messages）。 */
const PING_PROMPT = 'ping'

interface WireRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 协议 → 最小真实请求（URL / 鉴权头 / body）。未知协议返回 undefined（调用方转 unsupported 行）。 */
function buildWireRequest(request: ConnectionTestRequest): WireRequest | undefined {
  const base = request.baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (request.apiKey) {
    // anthropic 用 x-api-key，openai 两协议用 Bearer（与 pi-ai 各 SDK 的默认鉴权同源）
    if (request.api === 'anthropic-messages') headers['x-api-key'] = request.apiKey
    else headers.authorization = `Bearer ${request.apiKey}`
  }
  const messages = [{ role: 'user', content: PING_PROMPT }]
  switch (request.api) {
    case 'anthropic-messages':
      return {
        url: `${base}/v1/messages`,
        headers: { ...headers, 'anthropic-version': ANTHROPIC_VERSION },
        body: { model: request.modelId, max_tokens: MIN_OUTPUT_TOKENS, messages },
      }
    case 'openai-completions':
      return {
        url: `${base}/chat/completions`,
        headers,
        body: { model: request.modelId, max_tokens: MIN_OUTPUT_TOKENS, messages },
      }
    case 'openai-responses':
      return {
        url: `${base}/responses`,
        headers,
        body: { model: request.modelId, max_output_tokens: RESPONSES_MIN_OUTPUT_TOKENS, input: PING_PROMPT },
      }
    default:
      return undefined
  }
}

/** 响应体压缩成单行 + 截断（CLI / 日志 / 前端行内展示友好，内容仍忠实）。 */
function toErrorSnippet(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_MAX_LEN)
}

export class ModelConnectionTester implements IModelConnectionTester {
  supports(api: string): boolean {
    return (CONNECTION_TEST_APIS as readonly string[]).includes(api)
  }

  async test(request: ConnectionTestRequest): Promise<ConnectionTestResult> {
    const row = { api: request.api, modelId: request.modelId }
    const wire = buildWireRequest(request)
    if (!wire) return { ...row, ok: false, error: 'unsupported' }
    try {
      const res = await fetch(wire.url, {
        method: 'POST',
        headers: wire.headers,
        body: JSON.stringify(wire.body),
        signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
      })
      // 读干响应体：1 token 级响应很小，读完让连接立即释放（不读会挂到 GC）
      const bodyText = await res.text().catch(() => '')
      if (!res.ok) {
        return { ...row, ok: false, error: `http_error|${res.status}|${toErrorSnippet(bodyText)}` }
      }
      return { ...row, ok: true }
    } catch (e) {
      return { ...row, ok: false, error: `network_error|${toErrorSnippet(toErrorMessage(e))}` }
    }
  }
}
