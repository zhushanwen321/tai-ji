/* eslint-disable no-magic-numbers -- 字面量均为厂商协议数据（HTTP 状态码翻译表 / 采样率枚举 / 值域枚举），非逻辑魔数；逻辑数值已命名（DEFAULT_INSTRUCTION_MAX_CHARS 等） */
/**
 * StepFun（阶跃星辰）TTS driver——ai-voice-tts 设计 §7.2 映射表实装。
 *
 * 协议形态：POST {baseUrl}/audio/speech · OpenAI 同形 · Authorization Bearer · 响应裸二进制。
 * 字段基本直传；instructions → instruction（按 per-model 上限截断：2.5 系 200 / 3 系 500，
 * §7.2 表 + capabilities.perModel）；response_format 恒 'pcm'（D9：内部恒 pcm 系，driver
 * 定死本家具体值——req.response_format 只参与缓存键，不透传异家值）。
 *
 * 音量（volume）与 voice_label 等无内部标准位：经 passthrough 私有通道（D2），值域见
 * formModel.volumeRange（0.1–2）。错误翻译（本家私有知识，§7.2 注④实测四形态）：
 * 401 → tts_auth_failed、402 → tts_quota_exceeded、其余非 2xx → tts_vendor_error。
 */
import type { InternalSpeechRequest, TtsCapabilities, TtsFormModel, TtsProviderId } from '@taiji/shared'
import type { TtsDriver, TtsSynthesisChunk } from '../../services/ports/tts.js'
import { buildAuthHeaders, joinEndpoint, postTtsRequest, translateHttpFailure, snapToNearestSampleRate, clampSpeed, binaryToPcm, DEFAULT_PCM_SAMPLE_RATE } from './base.js'
import { AUTH_RESERVED_POLICY, mergeRequestBody, type PassthroughPolicy } from './passthrough-merge.js'

/** 单段合成默认 instruction 截断上限（perModel 无该模型条目时的表缺省，§7.2 表 ≤200）。 */
const DEFAULT_INSTRUCTION_MAX_CHARS = 200

const SAMPLE_RATES: number[] = [8000, 16_000, 22_050, 24_000, 48_000]

/** 护栏⑤：协议行为参数 taiji 内部固定（不进配置面，设计 §5.2/§7.3）——passthrough 出现即剥离。 */
const PROTOCOL_FIXED_KEYS = ['timestamp', 'return_url', 'stream_format', 'markdown_filter'] as const

const PASSTHROUGH_POLICY: PassthroughPolicy = {
  ...AUTH_RESERVED_POLICY,
  protocolKeys: PROTOCOL_FIXED_KEYS,
}

/** instructions → instruction，按当前模型的 per-model 上限截断（未知模型走表缺省 200）。 */
function truncateInstruction(instructions: string, model: string): string {
  const cap = stepfunCapabilities.perModel[model]?.instructionMaxChars ?? DEFAULT_INSTRUCTION_MAX_CHARS
  return instructions.slice(0, cap)
}

export const stepfunCapabilities: TtsCapabilities = {
  endpointPath: '/audio/speech',
  authHeader: 'bearer',
  maxInputChars: 1000,
  speedRange: [0.5, 2],
  pcmSampleRates: SAMPLE_RATES,
  supportsInstructions: true,
  // voiceLabelSupported 全 false 口径：stepaudio-2.5/3 系官方声明不支持 voice_label（设计 §5.2
  // 实测注记「2.5/3 系报错」）；step-tts-2 / step-tts-mini 未实测，按保守缺省 false（支持位放开
  // 前须实测 voice_label 不报错，消费端按该位置灰）。
  perModel: {
    'stepaudio-2.5-tts': { instructionMaxChars: 200, voiceLabelSupported: false },
    'stepaudio-3-tts': { instructionMaxChars: 500, voiceLabelSupported: false },
    'step-tts-2': { instructionMaxChars: 200, voiceLabelSupported: false },
    'step-tts-mini': { instructionMaxChars: 200, voiceLabelSupported: false },
  },
}

/**
 * 音色枚举：官方清单 36 个 Voice ID 全集（2026-09-30 官方文档抓取；设计前提 10——
 * cixingnansheng 实测合成通过，`default` 非法值 400 voice_id_invalid）。
 * 注：末四个仅 stepaudio-2.5-tts / step-tts-2 支持（step-tts-mini 不支持），模型×音色
 * 组合约束不进 M0 表单投影形状，无效组合由厂商 4xx → tts_vendor_error 暴露。
 */
const VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'cixingnansheng', label: '磁性男声' },
  { id: 'vibrant-youth', label: '活力青年' },
  { id: 'lively-girl', label: '活力少女' },
  { id: 'soft-spoken-gentleman', label: '温文男声' },
  { id: 'magnetic-voiced-male', label: '磁性男声（英文音色）' },
  { id: 'zixinnansheng', label: '自信男声' },
  { id: 'elegantgentle-female', label: '气质温婉女声' },
  { id: 'livelybreezy-female', label: '活力轻快女声' },
  { id: 'wenrounansheng', label: '温柔男声' },
  { id: 'wenrougongzi', label: '温柔公子' },
  { id: 'yuanqinansheng', label: '元气男声' },
  { id: 'jingdiannvsheng', label: '经典女声' },
  { id: 'wenroushunv', label: '温柔熟女' },
  { id: 'tianmeinvsheng', label: '甜美女声' },
  { id: 'qingchunshaonv', label: '清纯少女' },
  { id: 'yuanqishaonv', label: '元气少女' },
  { id: 'linjiajiejie', label: '邻家姐姐' },
  { id: 'zhengpaiqingnian', label: '正派青年' },
  { id: 'qingniandaxuesheng', label: '青年大学生' },
  { id: 'boyinnansheng', label: '播音男声' },
  { id: 'ruyananshi', label: '儒雅男士' },
  { id: 'shenchennanyin', label: '深沉男音' },
  { id: 'qinqienvsheng', label: '亲切女声' },
  { id: 'wenrounvsheng', label: '温柔女声' },
  { id: 'jilingshaonv', label: '机灵少女' },
  { id: 'ruanmengnvsheng', label: '软萌女声' },
  { id: 'youyanvsheng', label: '优雅女声' },
  { id: 'lengyanyujie', label: '冷艳御姐' },
  { id: 'shuangkuaijiejie', label: '爽快姐姐' },
  { id: 'wenjingxuejie', label: '文静学姐' },
  { id: 'linjiameimei', label: '邻家妹妹' },
  { id: 'zhixingjiejie', label: '知性姐姐' },
  { id: 'shuangkuainansheng', label: '爽快男声' },
  { id: 'ganliannvsheng', label: '干练女声' },
  { id: 'qinhenvsheng', label: '亲和女声' },
  { id: 'huolinvsheng', label: '活力女声' },
]

export const stepfunFormModel: TtsFormModel = {
  capabilities: stepfunCapabilities,
  baseUrlOptions: [
    { url: 'https://api.stepfun.com/v1', label: '默认（api.stepfun.com）', isDefault: true },
    { url: 'https://api.stepfun.com/step_plan/v1', label: 'Step Plan 集群（Step Plan Key 专用）', isDefault: false },
  ],
  models: [
    { id: 'stepaudio-2.5-tts', label: 'stepaudio-2.5-tts' },
    { id: 'stepaudio-3-tts', label: 'stepaudio-3-tts' },
    { id: 'step-tts-2', label: 'step-tts-2' },
    { id: 'step-tts-mini', label: 'step-tts-mini' },
  ],
  voices: VOICES,
  volumeRange: { min: 0.1, max: 2, step: 0.1 },
  pitchRange: null,
  channels: [],
  emotions: [],
  languages: [],
  // text_normalization(standard/enhanced) M0 表单化（设计 §5.2 参数全集 + §4.2 增量裁决④；
  // renderer 两档开关已就绪，空清单曾使真机控件不渲染——D5 F1-1/F1-13 修复）
  toggles: ['text_normalization'],
  voiceModify: null,
  maxTimbreVoices: 0,
  hasPronunciationDict: true,
}

/** 请求体组装：核心映射（§7.2 直传列）按键深合并写覆盖 passthrough 底（护栏②）。 */
export function buildStepfunRequestBody(req: InternalSpeechRequest): Record<string, unknown> {
  const sampleRate = snapToNearestSampleRate(req.sample_rate, stepfunCapabilities.pcmSampleRates)
  const speedRange = stepfunCapabilities.speedRange
  const core: Record<string, unknown> = {
    model: req.model,
    input: req.input,
    voice: req.voice,
    response_format: 'pcm',
    sample_rate: sampleRate,
  }
  if (req.speed !== undefined && speedRange) core['speed'] = clampSpeed(req.speed, speedRange)
  if (req.instructions) core['instruction'] = truncateInstruction(req.instructions, req.model)
  return mergeRequestBody(core, req.passthrough, PASSTHROUGH_POLICY)
}

/** 工厂：baseUrl 由配置注入（service 现读 tts.json，每 speak 现取；§7.4 步骤 1）。 */
export function createStepfunDriver(options: { baseUrl: string }): TtsDriver {
  const url = joinEndpoint(options.baseUrl, stepfunCapabilities.endpointPath)
  return {
    id: 'stepfun' satisfies TtsProviderId,
    capabilities: stepfunCapabilities,
    formModel: stepfunFormModel,
    async synthesizeChunk(req: InternalSpeechRequest, apiKey: string): Promise<TtsSynthesisChunk> {
      const body = buildStepfunRequestBody(req)
      const res = await postTtsRequest(url, buildAuthHeaders(stepfunCapabilities.authHeader, apiKey), body)
      if (!res.ok) throw translateHttpFailure(res.status, res.errorText)
      const sampleRate = typeof body['sample_rate'] === 'number' ? body['sample_rate'] : DEFAULT_PCM_SAMPLE_RATE
      return { pcm: binaryToPcm(res.bytes), sampleRate, channels: 1 }
    },
  }
}
