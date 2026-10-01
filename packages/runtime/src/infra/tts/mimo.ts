/* eslint-disable no-magic-numbers -- 字面量均为厂商协议数据（HTTP 状态码翻译表 / 固定采样率 / 音色枚举计数），非逻辑魔数；逻辑数值已命名（MIMO_PCM_SAMPLE_RATE） */
/**
 * MiMo（小米）TTS driver——ai-voice-tts 设计 §7.2 映射表实装。
 *
 * 协议形态：POST {baseUrl}/chat/completions 借壳 · api-key 头（不是 Bearer）· 响应 JSON
 * （choices[0].message.audio.data base64）。核心字段变形：input → messages[assistant].content、
 * instructions → messages[user].content（自然语言风格指令）；audio.format='pcm16' 固定
 * 24kHz 16-bit LE 单声道（采样率无独立字段，req.sample_rate 传入忽略，§7.2）。
 * speed 无对应字段 → 丢弃（speedRange=null，UI 置灰由能力表驱动，§7.2）。
 *
 * 集群绑定（前提 6 实测硬约束）：token plan key 仅 token-plan-cn 集群有效，默认集群 401——
 * baseUrl 必须与 key 同集群（联动带入见 D4，手填场景走 baseUrlOptions 下拉）。
 *
 * 音色为中文枚举 ×9（前提 10 实测全集）；错误翻译（本家私有知识，OpenAI 同形借壳）：
 * 401 → tts_auth_failed、402 → tts_quota_exceeded、其余非 2xx → tts_vendor_error。
 */
import type { InternalSpeechRequest, TtsCapabilities, TtsFormModel } from '@taiji/shared'
import type { TtsDriver, TtsSynthesisChunk } from '../../services/ports/tts.js'
import {
  ttsFailure,
  toErrorSnippet,
  buildAuthHeaders,
  joinEndpoint,
  postTtsRequest,
  translateHttpFailure,
  decodeBase64ToPcm,
  isRecord,
  parseVendorJson,
} from './base.js'
import { AUTH_RESERVED_POLICY, mergeRequestBody, type PassthroughPolicy } from './passthrough-merge.js'

/** pcm16 固定采样率（协议无独立字段；前提 7 实测 0.96s 样本 duration 精确印证）。 */
export const MIMO_PCM_SAMPLE_RATE = 24_000

/** 出厂 policy：仅鉴权保留键（本家无协议行为键，护栏⑤无本家补充）。 */
const PASSTHROUGH_POLICY: PassthroughPolicy = AUTH_RESERVED_POLICY

export const mimoCapabilities: TtsCapabilities = {
  endpointPath: '/chat/completions',
  authHeader: 'api-key',
  maxInputChars: 1000,
  speedRange: null,
  pcmSampleRates: [MIMO_PCM_SAMPLE_RATE],
  supportsInstructions: true,
  perModel: {},
}

/** 音色枚举全集 ×9（前提 10 实测：mimo.mi.com 官方清单，国内集群全过）。 */
const VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'mimo_default', label: '默认音色' },
  { id: '冰糖', label: '冰糖（中文女声）' },
  { id: '茉莉', label: '茉莉（中文女声）' },
  { id: '苏打', label: '苏打（中文男声）' },
  { id: '白桦', label: '白桦（中文男声）' },
  { id: 'Mia', label: 'Mia（英文女声）' },
  { id: 'Chloe', label: 'Chloe（英文女声）' },
  { id: 'Milo', label: 'Milo（英文男声）' },
  { id: 'Dean', label: 'Dean（英文男声）' },
]

export const mimoFormModel: TtsFormModel = {
  capabilities: mimoCapabilities,
  baseUrlOptions: [
    { url: 'https://api.xiaomimimo.com/v1', label: '默认集群（api.xiaomimimo.com）', isDefault: true },
    { url: 'https://token-plan-cn.xiaomimimo.com/v1', label: 'token plan 国内集群（token plan Key 必选）', isDefault: false },
    { url: 'https://token-plan-ams.xiaomimimo.com/v1', label: 'token plan 境外集群（ams，TTS 可用性未实测）', isDefault: false },
    { url: 'https://token-plan-sgp.xiaomimimo.com/v1', label: 'token plan 境外集群（sgp，TTS 可用性未实测）', isDefault: false },
  ],
  models: [{ id: 'mimo-v2.5-tts', label: 'mimo-v2.5-tts（内置音色）' }],
  voices: VOICES.map((v) => ({ id: v.id, label: v.label })),
  volumeRange: null,
  pitchRange: null,
  channels: [],
  emotions: [],
  languages: [],
  toggles: [],
  voiceModify: null,
  maxTimbreVoices: 0,
  hasPronunciationDict: false,
}

/** 请求体组装：messages 变形（指令 user 在前、正文 assistant 在后）+ audio 段固定 pcm16。 */
export function buildMimoRequestBody(req: InternalSpeechRequest): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = []
  if (req.instructions) messages.push({ role: 'user', content: req.instructions })
  messages.push({ role: 'assistant', content: req.input })
  const core: Record<string, unknown> = {
    model: req.model,
    messages,
    audio: { voice: req.voice, format: 'pcm16' },
  }
  return mergeRequestBody(core, req.passthrough, PASSTHROUGH_POLICY)
}

/** 响应解码：choices[0].message.audio.data base64 → PCM（形状不符逐级 guard，摘要带缺什么）。 */
export function decodeMimoResponse(raw: Buffer | string): Buffer {
  const payload = parseVendorJson(raw, 'mimo')
  if (!isRecord(payload)) throw ttsFailure('tts_vendor_error', 'mimo: response is not an object')
  const choices = payload['choices']
  const first = Array.isArray(choices) ? choices[0] : undefined
  const message = isRecord(first) ? first['message'] : undefined
  const audio = isRecord(message) ? message['audio'] : undefined
  const data = isRecord(audio) ? audio['data'] : undefined
  if (data === undefined) {
    throw ttsFailure(
      'tts_vendor_error',
      `mimo: response missing choices[0].message.audio.data: ${toErrorSnippet(JSON.stringify(payload))}`,
    )
  }
  return decodeBase64ToPcm(data, 'mimo')
}

/** 工厂：baseUrl 由配置注入（集群绑定：token plan key 必须配同集群地址，前提 6）。 */
export function createMimoDriver(options: { baseUrl: string }): TtsDriver {
  const url = joinEndpoint(options.baseUrl, mimoCapabilities.endpointPath)
  return {
    id: 'mimo',
    capabilities: mimoCapabilities,
    formModel: mimoFormModel,
    async synthesizeChunk(req: InternalSpeechRequest, apiKey: string): Promise<TtsSynthesisChunk> {
      const body = buildMimoRequestBody(req)
      const res = await postTtsRequest(url, buildAuthHeaders(mimoCapabilities.authHeader, apiKey), body)
      if (!res.ok) throw translateHttpFailure(res.status, res.errorText)
      return { pcm: decodeMimoResponse(res.bytes), sampleRate: MIMO_PCM_SAMPLE_RATE, channels: 1 }
    },
  }
}
