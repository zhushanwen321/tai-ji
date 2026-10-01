/* eslint-disable no-magic-numbers -- 字面量均为厂商协议数据（HTTP 状态码与业务码翻译表 / 采样率枚举 / 情感与值域枚举），非逻辑魔数；逻辑数值已命名（MINIMAX_AUTH_STATUS_CODE / MINIMAX_AUDIO_STATUS_FINISHED） */
/**
 * MiniMax TTS driver——ai-voice-tts 设计 §7.2 映射表实装。
 *
 * 协议形态：POST {baseUrl}/t2a_v2 · Authorization Bearer · 响应 JSON（data.audio hex + 成功
 * data.status=2；错误在 base_resp.status_code）。核心字段搬家：input→text、voice→
 * voice_setting.voice_id、speed→voice_setting.speed（钳制 [0.5,2]）、response_format→
 * audio_setting.format='pcm'、sample_rate→audio_setting.sample_rate（枚举内最近值）。
 * instructions 无对应字段 → 丢弃 + 日志（supportsInstructions=false，指令控件在该家不渲染，
 * 设计 D1 否决有损降级映射）。
 *
 * 声道回报：passthrough 的 audio_setting.channel 合并进请求体后按实际值回报
 * （synthesizeChunk.channels），WAV 头 numChannels 由此写（双声道交织 PCM 防 mono 头错写）。
 *
 * 音量（vol）/音调（pitch）/情感（emotion ×9）等无内部标准位：经 passthrough 私有通道（D2）。
 * 错误翻译（本家私有知识，§7.2 表）：HTTP 层 401→鉴权、402→额度；业务层 base_resp.status_code
 * 1004→tts_auth_failed、其余非零（1042 非法字符 / 2013 参数等）→ tts_vendor_error。
 */
import type { InternalSpeechRequest, TtsCapabilities, TtsErrorCode, TtsFormModel } from '@taiji/shared'
import type { TtsDriver, TtsSynthesisChunk } from '../../services/ports/tts.js'
import { logger } from '../logger.js'
import {
  ttsFailure,
  TtsDriverFailure,
  buildAuthHeaders,
  joinEndpoint,
  postTtsRequest,
  translateHttpFailure,
  snapToNearestSampleRate,
  clampSpeed,
  decodeHexToPcm,
  isRecord,
  parseVendorJson,
  DEFAULT_PCM_SAMPLE_RATE,
} from './base.js'
import { AUTH_RESERVED_POLICY, mergeRequestBody, type PassthroughPolicy } from './passthrough-merge.js'

const SAMPLE_RATES: number[] = [8000, 16_000, 22_050, 24_000, 32_000, 44_100]

/** 鉴权失败的业务码（base_resp.status_code；§7.2 表 1004）。 */
const MINIMAX_AUTH_STATUS_CODE = 1004

/** 音频就绪业务位（data.status=2，§7.2「status:2」）；存在且非 2 视为未就绪。 */
const MINIMAX_AUDIO_STATUS_FINISHED = 2

/** 出厂 policy：仅鉴权保留键（本家无协议行为键，护栏⑤无本家补充）。 */
const PASSTHROUGH_POLICY: PassthroughPolicy = AUTH_RESERVED_POLICY

/** 业务错误翻译（本家私有知识：1004 鉴权，其余非零 → 厂商错误，摘要带原始码）。 */
function translateBusinessError(statusCode: number, bodySnippet: string): TtsDriverFailure {
  const code: TtsErrorCode = statusCode === MINIMAX_AUTH_STATUS_CODE ? 'tts_auth_failed' : 'tts_vendor_error'
  return ttsFailure(code, `base_resp.status_code=${statusCode}: ${bodySnippet}`)
}

export const minimaxCapabilities: TtsCapabilities = {
  endpointPath: '/t2a_v2',
  authHeader: 'bearer',
  maxInputChars: 3000,
  speedRange: [0.5, 2],
  pcmSampleRates: SAMPLE_RATES,
  supportsInstructions: false,
  perModel: {},
}

/**
 * 音色：官方系统音色清单的核心中文（普通话）子集（2026-09-30 官方清单抓取——全集 229+
 * 条含多语言与 beta 变体，M0 下拉内置核心八音色；male-qn-qingse 实测 200）。设置页表单
 * 是唯一参数入口（D2——vendor 子树由表单生成，用户不接触 JSON），未内置音色在 M0
 * 无配置入口；扩充即往本数组增项，由表单投影透传到下拉。
 */
const VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'male-qn-qingse', label: '青涩青年音色' },
  { id: 'male-qn-jingying', label: '精英青年音色' },
  { id: 'male-qn-badao', label: '霸道青年音色' },
  { id: 'male-qn-daxuesheng', label: '青年大学生音色' },
  { id: 'female-shaonv', label: '少女音色' },
  { id: 'female-yujie', label: '御姐音色' },
  { id: 'female-chengshu', label: '成熟女性音色' },
  { id: 'female-tianmei', label: '甜美女性音色' },
]

/** 情感枚举 ×9（§5.2；fluent/whisper 仅 2.6 系）。 */
const EMOTIONS = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'] as const

/**
 * 语言增强枚举：官方 language_boost 全集（2026-10-01 platform.minimax.cn 文档
 * speech-t2a-http 抓取，与 platform.minimax.io 国际站逐项一致——40 语言 + auto；
 * speech-01/02 系不支持其中 Persian/Filipino/Tamil，M0 模型全为 speech-2.6/2.8 系
 * 不受限。设计 §7.3/§5.2 声明的「37 语言」为设计期官方快照，随官方扩充更新至此）。
 */
const LANGUAGES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'auto', label: 'auto（全自动）' },
  { id: 'Chinese', label: 'Chinese' },
  { id: 'Chinese,Yue', label: 'Chinese,Yue（含粤语）' },
  { id: 'English', label: 'English' },
  { id: 'Arabic', label: 'Arabic' },
  { id: 'Russian', label: 'Russian' },
  { id: 'Spanish', label: 'Spanish' },
  { id: 'French', label: 'French' },
  { id: 'Portuguese', label: 'Portuguese' },
  { id: 'German', label: 'German' },
  { id: 'Turkish', label: 'Turkish' },
  { id: 'Dutch', label: 'Dutch' },
  { id: 'Ukrainian', label: 'Ukrainian' },
  { id: 'Vietnamese', label: 'Vietnamese' },
  { id: 'Indonesian', label: 'Indonesian' },
  { id: 'Japanese', label: 'Japanese' },
  { id: 'Italian', label: 'Italian' },
  { id: 'Korean', label: 'Korean' },
  { id: 'Thai', label: 'Thai' },
  { id: 'Polish', label: 'Polish' },
  { id: 'Romanian', label: 'Romanian' },
  { id: 'Greek', label: 'Greek' },
  { id: 'Czech', label: 'Czech' },
  { id: 'Finnish', label: 'Finnish' },
  { id: 'Hindi', label: 'Hindi' },
  { id: 'Bulgarian', label: 'Bulgarian' },
  { id: 'Danish', label: 'Danish' },
  { id: 'Hebrew', label: 'Hebrew' },
  { id: 'Malay', label: 'Malay' },
  { id: 'Persian', label: 'Persian' },
  { id: 'Slovak', label: 'Slovak' },
  { id: 'Swedish', label: 'Swedish' },
  { id: 'Croatian', label: 'Croatian' },
  { id: 'Filipino', label: 'Filipino' },
  { id: 'Hungarian', label: 'Hungarian' },
  { id: 'Norwegian', label: 'Norwegian' },
  { id: 'Slovenian', label: 'Slovenian' },
  { id: 'Catalan', label: 'Catalan' },
  { id: 'Nynorsk', label: 'Nynorsk' },
  { id: 'Tamil', label: 'Tamil' },
  { id: 'Afrikaans', label: 'Afrikaans' },
]

export const minimaxFormModel: TtsFormModel = {
  capabilities: minimaxCapabilities,
  baseUrlOptions: [
    { url: 'https://api.minimax.cn/v1', label: '默认（api.minimax.cn）', isDefault: true },
    { url: 'https://api.minimaxi.com/v1', label: '国际域名（api.minimaxi.com，同 Key 可用）', isDefault: false },
  ],
  models: [
    { id: 'speech-2.8-hd', label: 'speech-2.8-hd' },
    { id: 'speech-2.8-turbo', label: 'speech-2.8-turbo' },
    { id: 'speech-2.6-hd', label: 'speech-2.6-hd' },
    { id: 'speech-2.6-turbo', label: 'speech-2.6-turbo' },
  ],
  voices: VOICES,
  volumeRange: { min: 0.5, max: 10, step: 0.5 },
  pitchRange: { min: -12, max: 12, step: 2 },
  channels: [
    { id: '1', label: '单声道' },
    { id: '2', label: '双声道' },
  ],
  emotions: EMOTIONS.map((id) => ({ id, label: id })),
  languages: LANGUAGES,
  // toggles 成员 id = vendor 子键名裸键（renderer MINIMAX_TOGGLE_PATHS 按裸键查落盘路径 +
  // i18n label 按 settings.tts.toggle.${id} 命中；带请求体路径前缀会使查表 miss 静默丢值，
  // D5 终态同步 F1-8/F1-14 裁决 code-right）
  toggles: ['text_normalization', 'latex_read', 'aigc_watermark'],
  voiceModify: {
    // tiers id = vendor.voice_modify 子键名（官方维度名裸键；renderer modify[tier.id] 直写，
    // 路径前缀形态会产出 voice_modify.voice_modify.* 双前缀错位，D5 F1-11/F1-24 裁决 code-right）
    tiers: [
      { id: 'pitch', label: '明亮度' },
      { id: 'intensity', label: '力度' },
      { id: 'timbre', label: '音色厚度' },
    ],
    effects: [
      { id: 'spacious_echo', label: '空旷回音' },
      { id: 'auditorium_echo', label: '礼堂广播' },
      { id: 'lofi_telephone', label: '电话失真' },
      { id: 'robotic', label: '电音' },
    ],
  },
  maxTimbreVoices: 2,
  hasPronunciationDict: true,
}

/** 请求体组装：核心字段搬进 voice_setting/audio_setting 精确叶子（§7.2），passthrough 深合并共存。 */
export function buildMinimaxRequestBody(req: InternalSpeechRequest): Record<string, unknown> {
  if (req.instructions) {
    // supportsInstructions=false：无对应字段，丢弃 + 日志（§7.2；不做有损降级映射，D1 否决记录）
    logger.warn('tts minimax: instructions dropped (vendor has no instruction field)', { chars: req.instructions.length })
  }
  const speedRange = minimaxCapabilities.speedRange
  const voiceSetting: Record<string, unknown> = { voice_id: req.voice }
  if (req.speed !== undefined && speedRange) voiceSetting['speed'] = clampSpeed(req.speed, speedRange)
  const core: Record<string, unknown> = {
    model: req.model,
    text: req.input,
    voice_setting: voiceSetting,
    audio_setting: {
      format: 'pcm',
      sample_rate: snapToNearestSampleRate(req.sample_rate, minimaxCapabilities.pcmSampleRates),
    },
  }
  return mergeRequestBody(core, req.passthrough, PASSTHROUGH_POLICY)
}

/** 声道数从合并后的请求体取（passthrough audio_setting.channel；非正整数值回退单声道）。 */
function extractChannels(body: Record<string, unknown>): number {
  const setting = body['audio_setting']
  const channel = isRecord(setting) ? setting['channel'] : undefined
  return typeof channel === 'number' && Number.isInteger(channel) && channel >= 1 ? channel : 1
}

/** WAV 头采样率事实值 = 实际发出的 audio_setting.sample_rate（请求值即响应值，snap 后恒可用枚举内）。 */
function readSampleRate(body: Record<string, unknown>): number {
  const setting = body['audio_setting']
  const rate = isRecord(setting) ? setting['sample_rate'] : undefined
  return typeof rate === 'number' ? rate : DEFAULT_PCM_SAMPLE_RATE
}

/** 响应解码：base_resp 业务错误翻译 → data.audio hex 归一 PCM。 */
export function decodeMinimaxResponse(raw: Buffer | string): Buffer {
  const payload = parseVendorJson(raw, 'minimax')
  if (!isRecord(payload)) throw ttsFailure('tts_vendor_error', 'minimax: response is not an object')
  const baseResp = payload['base_resp']
  const statusCode = isRecord(baseResp) ? baseResp['status_code'] : undefined
  if (typeof statusCode === 'number' && statusCode !== 0) {
    throw translateBusinessError(statusCode, JSON.stringify(payload))
  }
  const data = payload['data']
  const audio = isRecord(data) ? data['audio'] : undefined
  const pcm = decodeHexToPcm(audio, 'minimax')
  // 防御性复核（设计 §7.2「status:2」）：字段存在且非就绪位视为未完成，不产出错误产物
  const dataStatus = isRecord(data) ? data['status'] : undefined
  if (typeof dataStatus === 'number' && dataStatus !== MINIMAX_AUDIO_STATUS_FINISHED) {
    throw ttsFailure('tts_vendor_error', `minimax: data.status=${dataStatus} (expected ${MINIMAX_AUDIO_STATUS_FINISHED})`)
  }
  return pcm
}

/** 工厂：baseUrl 由配置注入（service 现读 tts.json；MiniMax key 双域名可用无集群绑定，D4）。 */
export function createMinimaxDriver(options: { baseUrl: string }): TtsDriver {
  const url = joinEndpoint(options.baseUrl, minimaxCapabilities.endpointPath)
  return {
    id: 'minimax',
    capabilities: minimaxCapabilities,
    formModel: minimaxFormModel,
    async synthesizeChunk(req: InternalSpeechRequest, apiKey: string): Promise<TtsSynthesisChunk> {
      const body = buildMinimaxRequestBody(req)
      const res = await postTtsRequest(url, buildAuthHeaders(minimaxCapabilities.authHeader, apiKey), body)
      if (!res.ok) throw translateHttpFailure(res.status, res.errorText)
      const pcm = decodeMinimaxResponse(res.bytes)
      return { pcm, sampleRate: readSampleRate(body), channels: extractChannels(body) }
    },
  }
}
