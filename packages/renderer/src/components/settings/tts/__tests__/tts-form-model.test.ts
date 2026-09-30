// @vitest-environment happy-dom
/**
 * TTS 表单状态机单测（ai-voice-tts 任务书 u4 验收 3：保存/读取往返一致 + 脱敏无 Key）。
 *
 * 数据通路走 core mock（@taiji/core/transport/mock 的 tts 域内存态：configure → getConfig
 * 回读一致），表单投影数据源 = mock/tts-data.ts 三家最小 TtsFormModel（u1 产出）。
 *
 * 覆盖：
 * 1. 三家编辑态 → buildConfig → tts.configure → tts.getConfig → formStateFromConfig 深比较一致
 * 2. vendor 子树形状（设计 §7.2 请求体同名原路径：MiniMax voice_setting.* / StepFun 顶层 / MiMo 空）
 * 3. 控件存在性规则的提交面：置灰字段（MiMo speed/volume/pitch）不进 config；MiniMax
 *    supportsInstructions=false 时 instructions 即使有值也不提交（D1 不降级映射）
 * 4. 脱敏：getConfig 载荷每家无 Key 本体字段（D4「明文不出 runtime」）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/tts/__tests__/tts-form-model.test.ts
 */
import { describe, it, expect } from 'vitest'
import { tts } from '@taiji/core/transport/mock'
import { MOCK_TTS_FORMS, mockDefaultTtsConfig } from '@taiji/core/transport/mock/tts-data'
import {
  buildConfig,
  emptyFormState,
  formStateFromConfig,
  perModelOf,
  type TtsProviderFormState,
} from '../tts-form-model'
import type { TtsProviderId } from '@taiji/shared'

/** 深拷贝（core mock 态是模块单例，用例间隔离快照）。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function formOf(pid: TtsProviderId) {
  return clone(MOCK_TTS_FORMS)[pid]
}

/** 以投影出厂骨架为基，按家填满全部支持控件（模拟用户逐项编辑；不渲染的控件不填——
 *  控件存在性规则的提交面：MiniMax 无指令、MiMo 无词典，填了也不提交）。 */
function editedState(pid: TtsProviderId): TtsProviderFormState {
  const form = formOf(pid)
  const state = emptyFormState(form)
  state.baseUrl = form.baseUrlOptions[form.baseUrlOptions.length - 1].url
  if (form.capabilities.supportsInstructions) state.instructions = '用温柔的语气朗读'
  if (form.hasPronunciationDict) {
    state.pronunciationRules = [
      { from: '处理', to: '(chu3)(li3)' },
      { from: '扁舟', to: '偏舟(bian1 zhou1)' },
    ]
  }
  if (form.capabilities.speedRange) state.speed = '0.75'
  if (form.volumeRange) state.volume = '2'
  if (form.pitchRange) state.pitch = '-4'
  if (form.capabilities.pcmSampleRates.length > 1) state.sampleRate = String(form.capabilities.pcmSampleRates[0])
  if (form.emotions.length > 0) state.emotion = form.emotions[0].id
  if (form.languages.length > 0) state.languageBoost = form.languages[0].id
  if (form.channels.length > 0) state.channel = form.channels[form.channels.length - 1].id
  for (const id of form.toggles) state.toggles[id] = true
  if (form.maxTimbreVoices > 0) {
    state.secondVoice = form.voices[0].id
    state.secondVoiceWeight = '30'
  }
  if (form.voiceModify) {
    for (const tier of form.voiceModify.tiers) state.voiceModifyValues[tier.id] = '25'
    state.voiceModifyEffect = form.voiceModify.effects[0].id
  }
  return state
}

describe('保存/读取往返（表单值 → configure → getConfig 回读一致，走 core mock）', () => {
  it.each(['stepfun', 'minimax', 'mimo'] as const)('%s：编辑态往返深比较一致', async (pid) => {
    const form = formOf(pid)
    const state = editedState(pid)
    const config = buildConfig(pid, form, state)

    await tts.configure({ providerId: pid, config })
    const { config: readBack } = await tts.getConfig()
    const reparsed = formStateFromConfig(pid, form, readBack.providers[pid].config)

    expect(reparsed).toEqual(state)
  })

  it('activeProvider 经 configure 同步（卡片单选即默认朗读服务商）', async () => {
    await tts.configure({ providerId: 'stepfun', config: buildConfig('stepfun', formOf('stepfun'), editedState('stepfun')) })
    const { config } = await tts.getConfig()
    expect(config.activeProvider).toBe('stepfun')
  })
})

describe('vendor 子树形状（厂商 API 原名原路径，设计 §7.2）', () => {
  it('MiniMax：voice_setting.* 深路径 + audio_setting.channel + pronunciation_dict.tone', () => {
    const form = formOf('minimax')
    const state = editedState('minimax')
    state.emotion = 'happy'
    state.pronunciationRules = [{ from: '处理', to: '(chu3)(li3)' }]
    const vendor = buildConfig('minimax', form, state).vendor as Record<string, unknown>

    expect(vendor).toMatchObject({
      voice_setting: { vol: 2, pitch: -4, emotion: 'happy', text_normalization: true, latex_read: true },
      // channel 数值语义：Select 档位 id 恒 string，写 vendor 必须 Number 化
      //（D3 验收实测：字符串直传被 MiniMax 2013 invalid params 拒）
      audio_setting: { channel: 2 },
      language_boost: 'auto',
      aigc_watermark: true,
      pronunciation_dict: { tone: ['处理/(chu3)(li3)'] },
    })
    // 双音色：主音色 + 第二音色按权重混合（timbre_weights，M0 开放 2）
    expect(vendor.timbre_weights).toEqual([
      { voice_id: state.voice, weight: 70 },
      { voice_id: state.secondVoice, weight: 30 },
    ])
    expect(vendor.voice_modify).toMatchObject({ pitch: 25, sound_effects: 'lofi_telephone' })
  })

  it('StepFun：顶层原名字段 + 词典 pronunciation_map[].tone', () => {
    const form = formOf('stepfun')
    const state = editedState('stepfun')
    const vendor = buildConfig('stepfun', form, state).vendor as Record<string, unknown>

    expect(vendor).toMatchObject({
      volume: 2,
      text_normalization: 'enhanced',
      pronunciation_map: [{ tone: '处理/(chu3)(li3)' }, { tone: '扁舟/偏舟(bian1 zhou1)' }],
    })
  })

  it('MiMo：M0 投影无任何 vendor 控件 → vendor 恒空对象', () => {
    const vendor = buildConfig('mimo', formOf('mimo'), editedState('mimo')).vendor
    expect(vendor).toEqual({})
  })

  it('空词典行剔除：全空行不进 vendor，混合空行保留有效行', () => {
    const form = formOf('minimax')
    const state = emptyFormState(form)
    state.pronunciationRules = [
      { from: '', to: '' },
      { from: '扁舟', to: '偏舟' },
    ]
    const vendor = buildConfig('minimax', form, state).vendor as Record<string, unknown>
    expect((vendor.pronunciation_dict as { tone: string[] }).tone).toEqual(['扁舟/偏舟'])
  })
})

describe('控件存在性规则的提交面（置灰/不渲染字段不进 config）', () => {
  it('MiMo：speedRange null → 无 speed 键（语速置灰不提交）', () => {
    const config = buildConfig('mimo', formOf('mimo'), editedState('mimo'))
    expect(config.speed).toBeUndefined()
  })

  it('MiniMax：supportsInstructions=false → instructions 不提交（即使表单态有值，D1 不降级映射）', () => {
    const form = formOf('minimax')
    const state = emptyFormState(form)
    state.instructions = '不应被提交的指令'
    const config = buildConfig('minimax', form, state)
    expect(config.instructions).toBeUndefined()
  })

  it('StepFun：支持指令 → instructions 提交；MiMo 单值采样率照常提交', () => {
    expect(buildConfig('stepfun', formOf('stepfun'), editedState('stepfun')).instructions).toBe('用温柔的语气朗读')
    const mimoConfig = buildConfig('mimo', formOf('mimo'), editedState('mimo'))
    expect(mimoConfig.sampleRate).toBe(24000)
  })

  it('「不指定」null 语义不写 vendor：MiniMax 情感/语言增强 null → 键不存在', () => {
    const form = formOf('minimax')
    const state = emptyFormState(form)
    const vendor = buildConfig('minimax', form, state).vendor as Record<string, unknown>
    const voiceSetting = vendor.voice_setting as Record<string, unknown>
    expect(voiceSetting.emotion).toBeUndefined()
    expect(vendor.language_boost).toBeUndefined()
    // 不混合第二音色 → 无 timbre_weights
    expect(vendor.timbre_weights).toBeUndefined()
  })
})

describe('perModelOf 三态（「perModel 无条目」≠「条目显式 null=不支持」，设计 §7.3）', () => {
  it('perModel 无条目 → 默认支持、无上限（instructionMaxChars undefined，MiMo 指令不置灰）', () => {
    const r = perModelOf(formOf('mimo'), 'mimo-v2.5-tts')
    expect(r.instructionMaxChars).toBeUndefined()
    expect(r.voiceLabelSupported).toBe(true)
  })

  it('perModel 显式条目 → 原值消费（StepFun 2.5 系上限 200 / voiceLabel false）', () => {
    expect(perModelOf(formOf('stepfun'), 'stepaudio-2.5-tts')).toEqual({
      instructionMaxChars: 200,
      voiceLabelSupported: false,
    })
  })
})

describe('脱敏（D4「明文不出 runtime」；回读载荷无 Key 本体字段）', () => {
  it('getConfig 每家条目只含 config/hasApiKey/providerKeyAvailable 三键', async () => {
    const { config } = await tts.getConfig()
    for (const pid of ['stepfun', 'minimax', 'mimo'] as const) {
      expect(Object.keys(config.providers[pid]).sort()).toEqual(['config', 'hasApiKey', 'providerKeyAvailable'])
    }
  })

  it('TtsConfig 顶层与 vendor 子树无 key/apiKey/token 形态字段', async () => {
    await tts.configure({ providerId: 'minimax', config: buildConfig('minimax', formOf('minimax'), editedState('minimax')) })
    const { config } = await tts.getConfig()
    const entry = config.providers.minimax
    for (const pid of ['stepfun', 'minimax', 'mimo'] as const) {
      const c = config.providers[pid].config
      expect(Object.keys(c)).not.toContain('apiKey')
      expect(JSON.stringify(c.vendor).toLowerCase()).not.toContain('apikey')
    }
    expect(entry.hasApiKey).toBe(false)
  })

  it('mock 初始骨架与投影形状自洽（默认 baseUrl = isDefault 项或集群变体，voice/model 在枚举内）', () => {
    const skeleton = mockDefaultTtsConfig()
    for (const pid of ['stepfun', 'minimax', 'mimo'] as const) {
      const form = MOCK_TTS_FORMS[pid]
      const c = skeleton.providers[pid].config
      expect(form.models.some((m) => m.id === c.model)).toBe(true)
      expect(form.voices.some((v) => v.id === c.voice)).toBe(true)
    }
  })
})
