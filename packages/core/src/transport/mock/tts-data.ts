/* eslint-disable no-magic-numbers -- mock fixture 数据（三家能力表枚举值/值域）的字面量数值属领域数据，非逻辑魔数（data.ts 同形态） */
/**
 * TTS mock 演示数据（VITE_MOCK 测试基建）——三家最小可用 TtsFormModel 样例 + 默认配置骨架。
 *
 * mock 本职 = 模拟 runtime（内嵌假数据不违反「数据走 runtime 链路」纪律，设计 §7.5）：
 * 形状逐字段照 shared tts-types（协议 tts.getCapabilities reply 载荷），枚举值取设计
 * 前提 10 的实测清单子集（「最小可用」= 能驱动表单控件存在性三分支渲染：枚举渲染 / null
 * 置灰 / 空数组不渲染，非厂商全集）。真实能力表与表单投影数据本体在 runtime driver（u2）。
 */
import type { SanitizedTtsConfig, TtsFormModel, TtsProviderId } from '@taiji/shared'

/** StepFun 最小表单投影（指令控件可用 / 音调与声道与情感不渲染）。 */
const stepfunForm: TtsFormModel = {
  capabilities: {
    endpointPath: '/audio/speech',
    authHeader: 'bearer',
    maxInputChars: 1000,
    speedRange: [0.5, 2],
    pcmSampleRates: [16000, 24000, 32000, 44100, 48000],
    supportsInstructions: true,
    perModel: { 'stepaudio-2.5-tts': { instructionMaxChars: 200, voiceLabelSupported: false } },
  },
  baseUrlOptions: [
    { url: 'https://api.stepfun.com/v1', label: '默认', isDefault: true },
    { url: 'https://api.stepfun.com/step_plan/v1', label: 'Step Plan 集群', isDefault: false },
  ],
  models: [{ id: 'stepaudio-2.5-tts', label: 'StepAudio 2.5 TTS' }],
  voices: [{ id: 'cixingnansheng', label: '磁性男声' }],
  volumeRange: { min: 0.1, max: 2, step: 0.1 },
  pitchRange: null,
  channels: [],
  emotions: [],
  languages: [],
  toggles: ['text_normalization'],
  voiceModify: null,
  maxTimbreVoices: 0,
  hasPronunciationDict: true,
}

/** MiniMax 最小表单投影（情感/声道/效果器/词典渲染，音调置灰唯一全功能家演示）。 */
const minimaxForm: TtsFormModel = {
  capabilities: {
    endpointPath: '/t2a_v2',
    authHeader: 'bearer',
    maxInputChars: 3000,
    speedRange: [0.5, 2],
    pcmSampleRates: [16000, 24000, 32000],
    supportsInstructions: false,
    perModel: {},
  },
  baseUrlOptions: [
    { url: 'https://api.minimax.cn/v1', label: '国内', isDefault: true },
    { url: 'https://api.minimaxi.com/v1', label: '国际', isDefault: false },
  ],
  models: [
    { id: 'speech-2.6-hd', label: 'Speech 2.6 HD' },
    { id: 'speech-2.8-hd', label: 'Speech 2.8 HD' },
  ],
  voices: [{ id: 'male-qn-qingse', label: '青涩青年音色' }],
  volumeRange: { min: 1, max: 10, step: 1 },
  pitchRange: { min: -12, max: 12, step: 1 },
  channels: [{ id: '1', label: '单声道' }, { id: '2', label: '双声道' }],
  emotions: [
    { id: 'happy', label: '开心' },
    { id: 'sad', label: '悲伤' },
    { id: 'angry', label: '愤怒' },
    { id: 'fearful', label: '恐惧' },
    { id: 'disgusted', label: '厌恶' },
    { id: 'surprised', label: '惊讶' },
    { id: 'cold', label: '冷漠' },
    { id: 'neutral', label: '中性' },
    { id: 'calm', label: '平静' },
  ],
  languages: [{ id: 'auto', label: '自动' }, { id: 'zh', label: '中文' }, { id: 'en', label: 'English' }],
  toggles: ['text_normalization', 'latex_read', 'aigc_watermark'],
  voiceModify: {
    tiers: [{ id: 'bright', label: '明亮度' }],
    effects: [{ id: 'telephone', label: '电话' }],
  },
  maxTimbreVoices: 4,
  hasPronunciationDict: true,
}

/** MiMo 最小表单投影（语速/音量/音调全置灰——无对应字段的 null 三分支演示）。 */
const mimoForm: TtsFormModel = {
  capabilities: {
    endpointPath: '/chat/completions',
    authHeader: 'api-key',
    maxInputChars: 1000,
    speedRange: null,
    pcmSampleRates: [24000],
    supportsInstructions: true,
    perModel: {},
  },
  baseUrlOptions: [
    { url: 'https://api.xiaomimimo.com/v1', label: '默认集群', isDefault: true },
    { url: 'https://token-plan-cn.xiaomimimo.com/v1', label: '国内 Token Plan 集群', isDefault: false },
  ],
  models: [{ id: 'mimo-v2.5-tts', label: 'MiMo 2.5 TTS' }],
  voices: [
    { id: 'mimo_default', label: '默认音色' },
    { id: '冰糖', label: '冰糖' },
    { id: '茉莉', label: '茉莉' },
    { id: '苏打', label: '苏打' },
    { id: '白桦', label: '白桦' },
    { id: 'Mia', label: 'Mia' },
    { id: 'Chloe', label: 'Chloe' },
    { id: 'Milo', label: 'Milo' },
    { id: 'Dean', label: 'Dean' },
  ],
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

/** 三家表单投影（tts.getCapabilities reply 载荷）。 */
export const MOCK_TTS_FORMS: Record<TtsProviderId, TtsFormModel> = {
  stepfun: stepfunForm,
  minimax: minimaxForm,
  mimo: mimoForm,
}

/** mock 初始配置（每家默认骨架 = 该家 baseUrlOptions 的 isDefault 项 + 首个 model/voice）。 */
export function mockDefaultTtsConfig(): SanitizedTtsConfig {
  return {
    activeProvider: 'minimax',
    providers: {
      stepfun: {
        config: { baseUrl: 'https://api.stepfun.com/v1', model: 'stepaudio-2.5-tts', voice: 'cixingnansheng', vendor: {} },
        hasApiKey: false,
        providerKeyAvailable: false,
      },
      minimax: {
        config: { baseUrl: 'https://api.minimax.cn/v1', model: 'speech-2.6-hd', voice: 'male-qn-qingse', vendor: {} },
        hasApiKey: false,
        providerKeyAvailable: false,
      },
      mimo: {
        config: { baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-tts', voice: 'mimo_default', vendor: {} },
        hasApiKey: false,
        providerKeyAvailable: false,
      },
    },
  }
}
