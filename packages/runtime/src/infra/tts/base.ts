/**
 * TTS driver 基座——三家共享的 HTTP 执行、错误归一分层与解码归一（ai-voice-tts 设计 §7.3）。
 *
 * 🔒 外部 HTTP 只准出现在 infra/tts/（仓库硬约束）；本基座是唯一 fetch 调用点。
 *
 * 错误归一分层（2026-09-30 用户裁决：厂商错误知识封装在厂商调用层）：
 * - 基座（本文件）：网络异常与超时（fetch throw / AbortError / TimeoutError）→ tts_network_error；
 * - 各家 driver：厂商错误形态 → 统一错误码的翻译表是该家私有知识（MiniMax 知道 base_resp.status_code
 *   1004=鉴权、1042/2013=参数）；OpenAI 同形三家（StepFun/MiMo/MiniMax）的 HTTP 非 2xx 语义一致
 *   （401=鉴权、402=额度、其余=厂商错误），同表收敛在 translateHttpFailure 供 driver 显式调用——
 *   postTtsRequest 本身不翻译，非 2xx 原样交本家 driver（基座职责边界不变）。
 * 统一层（service 与协议面）只消费统一错误码，零厂商判断。
 *
 * 超时形态照 model-connection-tester.ts 实装（范式源）：test(request) 签名无外部 signal，
 * AbortSignal.timeout 在 fetch 调用点内部构造。墙钟量级按被保护对象校准（仓库超时默认原则）：
 * 合成是任务级动作（数秒到数十秒/段），兜底取 120s——防挂死兜底，不是任务预算。
 */
import { toErrorMessage } from '../../utils/errors.js'
import type { TtsErrorCode } from '@taiji/shared'
import type { TtsDriverError } from '../../services/ports/tts.js'

/** 单段合成 HTTP 墙钟上限（防挂死兜底；Phase 2 真取消随流式一并裁决，§7.5 要点 2）。 */
export const TTS_REQUEST_TIMEOUT_MS = 120_000

/** 错误摘要截断长度（设计 §7.3：toErrorSnippet 截断 200 字符）。 */
export const TTS_ERROR_SNIPPET_MAX = 200

/** 默认 PCM 采样率（配置缺省时的请求值与 WAV 头事实值；三家 24kHz 均实测/文档核实）。 */
export const DEFAULT_PCM_SAMPLE_RATE = 24_000

/**
 * driver 失败的统一承载：rejection 值结构上满足 TtsDriverError（{ code, snippet }），
 * 同时是 Error 实例（保留 stack 供 runtime 日志归因）。
 */
export class TtsDriverFailure extends Error implements TtsDriverError {
  readonly code: TtsErrorCode
  readonly snippet: string

  constructor(failure: TtsDriverError) {
    super(`[${failure.code}] ${failure.snippet}`)
    this.name = 'TtsDriverFailure'
    this.code = failure.code
    this.snippet = failure.snippet
  }
}

/** 构造统一错误形态（snippet 在此单点截断到 TTS_ERROR_SNIPPET_MAX）。 */
export function ttsFailure(code: TtsErrorCode, snippet: string): TtsDriverFailure {
  return new TtsDriverFailure({ code, snippet: toErrorSnippet(snippet) })
}

/** HTTP 401：鉴权失败（三家 vendor 同语义）。 */
const HTTP_UNAUTHORIZED = 401
/** HTTP 402：额度不足（Payment Required；三家 vendor 借此表达 quota 耗尽）。 */
const HTTP_PAYMENT_REQUIRED = 402

/**
 * OpenAI 同形 HTTP status → 统一错误码翻译（三家同表：401 鉴权、402 额度、其余厂商错误，
 * §7.2 错误翻译表）。供各 driver 的非 2xx 分支显式调用；postTtsRequest 不调用（非 2xx 原样
 * 返回交本家 driver，见文件头分层裁决）。
 */
export function translateHttpFailure(status: number, bodySnippet: string): TtsDriverFailure {
  const code: TtsErrorCode =
    status === HTTP_UNAUTHORIZED ? 'tts_auth_failed' : status === HTTP_PAYMENT_REQUIRED ? 'tts_quota_exceeded' : 'tts_vendor_error'
  return ttsFailure(code, `HTTP ${status}: ${bodySnippet}`)
}

/** 语速钳制到能力表 speedRange 值域（driver 共用；钳制判断读能力表不写 if——设计 D3）。 */
export function clampSpeed(speed: number, range: [number, number]): number {
  return Math.min(range[1], Math.max(range[0], speed))
}

/** 响应体压缩成单行 + 截断（日志/错误摘要行内展示友好，内容仍忠实）。 */
export function toErrorSnippet(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, TTS_ERROR_SNIPPET_MAX)
}

/** 运行时 guard：未知响应形状收窄为键值对象（厂商响应形状一律 unknown 进入，禁 any）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 鉴权头组装（表驱动：capabilities.authHeader；MiMo 是 api-key 头，其余两家 Bearer）。 */
export function buildAuthHeaders(authHeader: 'bearer' | 'api-key', apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authHeader === 'bearer') headers.authorization = `Bearer ${apiKey}`
  else headers['api-key'] = apiKey
  return headers
}

/** 端点拼接：去 baseUrl 尾斜杠 + capabilities.endpointPath（如 /audio/speech）。 */
export function joinEndpoint(baseUrl: string, endpointPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${endpointPath}`
}

/** 基座响应载体：字节本体 + 非 2xx 时的文本摘要（厂商错误翻译的输入）。 */
export interface TtsRawResponse {
  status: number
  ok: boolean
  bytes: Buffer
  /** 非 2xx 时的响应文本（单行化 + 截断）；2xx 为空串。 */
  errorText: string
}

/**
 * 基座 HTTP 执行：POST JSON，AbortSignal.timeout 每段 120s 防挂死兜底。
 * fetch throw（含超时 signal 的 TimeoutError/AbortError）与响应体读取失败 → tts_network_error
 * （基座归类）；非 2xx 不在此翻译，原样返回交本家 driver 的错误翻译表。
 */
export async function postTtsRequest(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<TtsRawResponse> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    // fetch throw = 传输层失败（DNS / 不可达 / 超时 abort），基座统一归类网络错误
    throw ttsFailure('tts_network_error', `network: ${toErrorMessage(e)}`)
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    throw ttsFailure('tts_network_error', `network: read body failed: ${toErrorMessage(e)}`)
  }
  if (!res.ok) {
    return { status: res.status, ok: false, bytes, errorText: toErrorSnippet(bytes.toString('utf8')) }
  }
  return { status: res.status, ok: true, bytes, errorText: '' }
}

/** 响应 JSON 解析（厂商 JSON 响应入口；形状不符 → tts_vendor_error，摘要含原文片段）。 */
export function parseVendorJson(raw: Buffer | string, vendor: string): unknown {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw ttsFailure('tts_vendor_error', `${vendor}: response is not valid JSON: ${toErrorSnippet(text)}`)
  }
}

const HEX_PATTERN = /^[0-9a-fA-F]+$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/** hex 编码音频 → PCM Buffer（MiniMax data.audio；非字符串/空/非法字符 → tts_vendor_error）。 */
export function decodeHexToPcm(value: unknown, vendor: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !HEX_PATTERN.test(value)) {
    throw ttsFailure('tts_vendor_error', `${vendor}: response audio is not a hex string`)
  }
  return Buffer.from(value, 'hex')
}

/** base64 编码音频 → PCM Buffer（MiMo choices[0].message.audio.data；形状不符 → tts_vendor_error）。 */
export function decodeBase64ToPcm(value: unknown, vendor: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_PATTERN.test(value)) {
    throw ttsFailure('tts_vendor_error', `${vendor}: response audio is not a base64 string`)
  }
  return Buffer.from(value, 'base64')
}

/** 裸二进制音频 → PCM Buffer（StepFun 非 2xx 之外的 2xx 响应本体）。 */
export function binaryToPcm(bytes: Buffer): Buffer {
  return bytes
}

/**
 * 采样率取可用枚举内最近值（设计 §7.3 pcmSampleRates：取 24000 或最近值写进 WAV 头）。
 * 配置值在枚举内原样用；漂移值（如手编 tts.json）钳到最近可用项，请求值 = 头事实值。
 */
export function snapToNearestSampleRate(sampleRate: number | undefined, available: readonly number[]): number {
  if (sampleRate === undefined || !Number.isFinite(sampleRate)) {
    return available.includes(DEFAULT_PCM_SAMPLE_RATE) ? DEFAULT_PCM_SAMPLE_RATE : (available[0] ?? DEFAULT_PCM_SAMPLE_RATE)
  }
  if (available.includes(sampleRate)) return sampleRate
  return available.reduce((best, cur) => (Math.abs(cur - sampleRate) < Math.abs(best - sampleRate) ? cur : best), available[0] ?? DEFAULT_PCM_SAMPLE_RATE)
}
