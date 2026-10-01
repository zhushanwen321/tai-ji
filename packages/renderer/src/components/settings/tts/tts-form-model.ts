/**
 * TTS 表单状态机（ai-voice-tts 设计 §5.2 / §7.3 D2/D3）——表单编辑态与落盘形状
 * `TtsConfig` 的双向变换，TtsPage 唯一数据通路。
 *
 * 渲染存在性由表单投影（TtsFormModel）静态依赖数据驱动（控件存在性规则：枚举类空数组 =
 * 不渲染；数值类 null = 置灰；开关/结构类不在清单 / 为 0 = 不渲染），本文件不写任何
 * `providerId ===` 分支决定控件存在性。
 *
 * 设计约束「全部内置选项，不手填」（§5.2 开篇）：数值档位（语速/音量/音调/权重/效果器）
 * 由投影 NumberRange 生成为下拉档位，无自由数字输入；表单态数值字段一律以档位 id
 * （string）承载，buildConfig 时经 Number() + 投影 range 钳制转数值。
 *
 * vendor 子树形状知识（每家请求体的键序结构，设计 §7.2）集中在下方三家 buildVendor/
 * parseVendor 对内：渲染由投影驱动、落盘形状按厂商 API 原名原路径（D2 连带裁决——
 * runtime 打包 passthrough = vendor 子树恒等搬运，零字段名知识）。控件 id（投影 toggles
 * 成员、voiceModify tiers/effects 的 id）即厂商请求体对应子键名，键名映射随投影数据走。
 */
import type {
  FormOption,
  TtsConfig,
  TtsFormModel,
  TtsProviderId,
} from '@taiji/shared'

/** 发音词典行（行编辑器 UI 形态；落盘时按家合并为「原文/替换」串，设计 §5.2）。 */
export interface TtsPronunciationRule {
  from: string
  to: string
}

/** 单家表单编辑态（TtsProviderForm v-model 本体；null = 该控件投影不支持/未指定，不提交）。
 *  数值档位字段以档位 id（string）承载——Select 直绑形态，Number 转换收口在 buildConfig。 */
export interface TtsProviderFormState {
  baseUrl: string
  model: string
  voice: string
  /** 语速档位 id（speedRange null = 置灰恒 null，不写 config.speed）。 */
  speed: string | null
  /** 音量档位 id（volumeRange null = 置灰恒 null → vendor 不写）。 */
  volume: string | null
  /** 音调档位 id（pitchRange null = 置灰恒 null → vendor 不写）。 */
  pitch: string | null
  /** 风格指令（supportsInstructions false 恒空串，控件不渲染）。 */
  instructions: string
  /** 采样率（pcmSampleRates 的 string id；null = 投影空数组，控件不渲染）。 */
  sampleRate: string | null
  /** 声道（channels 空数组 = 不渲染恒 null）。 */
  channel: string | null
  /** 情感（emotions 空数组 = 不渲染；null = 「不指定」，vendor 不写）。 */
  emotion: string | null
  /** 语言增强（languages 空数组 = 不渲染；null = 「不指定」，vendor 不写）。 */
  languageBoost: string | null
  /** 开关类（键 = 投影 toggles 成员 id，值 = 开/关）。 */
  toggles: Record<string, boolean>
  /** 混合音色第二音色（maxTimbreVoices 0 = 区不渲染；null = 不混合，vendor 不写）。 */
  secondVoice: string | null
  /** 第二音色权重档位 id（secondVoice null 时无意义）。 */
  secondVoiceWeight: string | null
  /** 效果器档位值（键 = 投影 voiceModify.tiers 成员 id，值 = 档位 id；voiceModify null = 区不渲染）。 */
  voiceModifyValues: Record<string, string>
  /** 效果器效果（voiceModify.effects 选择；null = 不指定，不写 sound_effects）。 */
  voiceModifyEffect: string | null
  /** 发音词典行（hasPronunciationDict false = 区不渲染恒空数组）。 */
  pronunciationRules: TtsPronunciationRule[]
}

/** 语速步进（speedRange 只有 [min,max] 无 step；0.1 覆盖三家档位粒度）。 */
const SPEED_STEP = 0.1

/** 混合音色权重步进与有效域（厂商 [1,100]；主音色占总量减第二权重，故第二权重有效域 [1,99]）。 */
const TIMBRE_WEIGHT_MIN = 1
const TIMBRE_WEIGHT_MAX = 99
const TIMBRE_WEIGHT_STEP = 5
/** 权重总量（厂商百分制：主音色权重 = 总量 − 第二权重）。 */
const TIMBRE_WEIGHT_TOTAL = 100
/** 读第二音色所需的最少 timbre_weights 条目数（主 + 第二成对）。 */
const MIN_TIMBRE_ENTRIES = 2
/** 权重出厂档：主/第二音色各半。 */
const DEFAULT_TIMBRE_WEIGHT = 50

/** 数值档位量化刻度（两位小数，消除浮点步进累积误差）。 */
const RANGE_QUANTIZE_SCALE = 100

/** 效果器档位值域与步进（厂商 [-100,100]，0 = 默认音色；25 步进 = 9 档）。 */
const VOICE_MODIFY_MIN = -100
const VOICE_MODIFY_MAX = 100
const VOICE_MODIFY_STEP = 25

/** 「范围内出厂锚点」：range 含 1 取 1（三家语速/音量 range 均含 1），越界取最近边界。 */
const DEFAULT_UNIT_VALUE = 1

/** 24kHz 是合成默认采样率（设计 §7.3：WAV 头「取 24000 或最近值」），投影含之即默认选中。 */
const DEFAULT_SAMPLE_RATE = 24000

/** clamp 到闭区间（非有限值回退 fallback）。 */
function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** range 内默认档位：含 1 取 1，否则取最近边界（返回档位 id string）。 */
function defaultInRangeId(range: { min: number; max: number }): string {
  if (range.min > DEFAULT_UNIT_VALUE) return String(range.min)
  if (range.max < DEFAULT_UNIT_VALUE) return String(range.max)
  return String(DEFAULT_UNIT_VALUE)
}

/** 数值 range → 内置档位下拉（「全部内置选项，不手填」；整数步进消除浮点累积误差）。 */
export function rangeOptions(range: { min: number; max: number; step: number }): FormOption[] {
  const options: FormOption[] = []
  const steps = Math.round((range.max - range.min) / range.step)
  for (let i = 0; i <= steps; i++) {
    const v = Math.round((range.min + i * range.step) * RANGE_QUANTIZE_SCALE) / RANGE_QUANTIZE_SCALE
    options.push({ id: String(v), label: String(v) })
  }
  return options
}

/** 语速档位（speedRange tuple 无 step，按 SPEED_STEP 展开）。 */
export function speedOptions(form: TtsFormModel): FormOption[] {
  const range = form.capabilities.speedRange
  if (!range) return []
  return rangeOptions({ min: range[0], max: range[1], step: SPEED_STEP })
}

/** 第二音色权重档位。 */
export function timbreWeightOptions(): FormOption[] {
  return rangeOptions({ min: TIMBRE_WEIGHT_MIN, max: TIMBRE_WEIGHT_MAX, step: TIMBRE_WEIGHT_STEP })
}

/** 效果器档位。 */
export function voiceModifyOptions(): FormOption[] {
  return rangeOptions({ min: VOICE_MODIFY_MIN, max: VOICE_MODIFY_MAX, step: VOICE_MODIFY_STEP })
}

/** 档位 label 风格化（语速「1x」/权重「50%」；数值本身是数据非文案，不经 i18n）。 */
export function optionLabelWithSuffix(options: readonly FormOption[], suffix: string): FormOption[] {
  return options.map((o) => ({ id: o.id, label: `${o.label}${suffix}` }))
}

function firstOptionId(options: readonly FormOption[]): string | null {
  return options.length > 0 ? options[0].id : null
}

/** baseUrl 出厂默认 = 投影 isDefault 项（D4「出厂默认值」判定同源），缺省回退首项。 */
function defaultBaseUrl(form: TtsFormModel): string {
  return (form.baseUrlOptions.find((o) => o.isDefault) ?? form.baseUrlOptions[0])?.url ?? ''
}

/** 空白表单态（投影驱动的出厂骨架；getConfig 失败时设置页回默认骨架可重新保存，§5.4 末行）。 */
export function emptyFormState(form: TtsFormModel): TtsProviderFormState {
  const toggles: Record<string, boolean> = {}
  for (const id of form.toggles) toggles[id] = false
  const voiceModifyValues: Record<string, string> = {}
  if (form.voiceModify) {
    for (const tier of form.voiceModify.tiers) voiceModifyValues[tier.id] = '0'
  }
  return {
    baseUrl: defaultBaseUrl(form),
    model: firstOptionId(form.models) ?? '',
    voice: firstOptionId(form.voices) ?? '',
    speed: form.capabilities.speedRange
      ? defaultInRangeId({ min: form.capabilities.speedRange[0], max: form.capabilities.speedRange[1] })
      : null,
    volume: form.volumeRange ? defaultInRangeId(form.volumeRange) : null,
    pitch: form.pitchRange ? '0' : null,
    instructions: '',
    sampleRate: form.capabilities.pcmSampleRates.includes(DEFAULT_SAMPLE_RATE)
      ? String(DEFAULT_SAMPLE_RATE)
      : form.capabilities.pcmSampleRates.length > 0
        ? String(form.capabilities.pcmSampleRates[0])
        : null,
    channel: firstOptionId(form.channels),
    emotion: null,
    languageBoost: null,
    toggles,
    secondVoice: null,
    secondVoiceWeight: String(DEFAULT_TIMBRE_WEIGHT),
    voiceModifyValues,
    voiceModifyEffect: null,
    pronunciationRules: [],
  }
}

/**
 * 选中模型的 per-model 能力。指令上限三态——「perModel 无条目」≠「条目显式 null」（设计 §7.3）：
 * - number：perModel 条目登记的按模型上限（StepFun，maxlength 钳制）；
 * - null：perModel 条目显式声明该模型不支持指令 → 指令位置灰；
 * - undefined：perModel 无条目 = 该家指令不按模型分档（如 MiMo 自然语言无上限）→
 *   默认支持、不置灰不设 maxlength（控件渲染与否由家级 supportsInstructions 决定）。
 * 音色标签：无条目默认支持（不置灰），条目内 voiceLabelSupported=false 才置灰。
 */
export function perModelOf(
  form: TtsFormModel,
  modelId: string,
): { instructionMaxChars: number | null | undefined; voiceLabelSupported: boolean } {
  return form.capabilities.perModel[modelId] ?? { instructionMaxChars: undefined, voiceLabelSupported: true }
}

/**
 * 音色标签（StepFun voice_label）控件渲染条件 = 该家 perModel 表非空（投影登记了 per-model
 * 联动的家才携带该控件；M0 全集：StepFun 非空 → 渲染，MiniMax/MiMo 空 → 不渲染），
 * 可用性再按选中模型的 voiceLabelSupported 置灰。数据驱动，无厂商 id 分支。
 */
export function hasVoiceLabelControl(form: TtsFormModel): boolean {
  return Object.keys(form.capabilities.perModel).length > 0
}

// ── vendor 子树：按家请求体形状（设计 §7.2；渲染存在性与此无关，见文件头）────────

/** 深路径写入（中间层缺省自动创建）。 */
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    const next = node[key]
    if (typeof next !== 'object' || next === null) {
      const created: Record<string, unknown> = {}
      node[key] = created
      node = created
    } else {
      node = next as Record<string, unknown>
    }
  }
  node[path[path.length - 1]] = value
}

/** 深路径读取（任一层缺失返回 undefined）。 */
function getPath(source: Record<string, unknown>, path: readonly string[]): unknown {
  let node: unknown = source
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** 「原文/替换」行 → 词典条目串（MiniMax pronunciation_dict.tone[] / StepFun pronunciation_map[].tone 同格式，设计 §5.2）。 */
function joinPronunciationRule(rule: TtsPronunciationRule): string {
  return `${rule.from}/${rule.to}`
}

/** 词典条目串 → 行（无分隔符的条目按「原文=整串、替换为空」回读，不丢用户数据）。 */
function splitPronunciationRule(entry: string): TtsPronunciationRule {
  const i = entry.indexOf('/')
  if (i === -1) return { from: entry, to: '' }
  return { from: entry.slice(0, i), to: entry.slice(i + 1) }
}

/** 非空词典行过滤（行编辑器允许中途空行存在，保存时剔除全空行）。 */
function nonEmptyRules(rules: readonly TtsPronunciationRule[]): TtsPronunciationRule[] {
  return rules.filter((r) => r.from !== '' || r.to !== '')
}

function buildStepfunVendor(form: TtsFormModel, state: TtsProviderFormState): Record<string, unknown> {
  const vendor: Record<string, unknown> = {}
  if (form.volumeRange && state.volume !== null) {
    vendor.volume = clampNumber(state.volume, form.volumeRange.min, form.volumeRange.max, form.volumeRange.min)
  }
  // 开关类（toggles 清单驱动；StepFun 文本归一是 standard/enhanced 枚举档，开关 = 两档切换）
  if (form.toggles.includes('text_normalization')) {
    vendor.text_normalization = state.toggles['text_normalization'] ? 'enhanced' : 'standard'
  }
  if (form.hasPronunciationDict && state.pronunciationRules.length > 0) {
    const tone = nonEmptyRules(state.pronunciationRules).map((r) => ({ tone: joinPronunciationRule(r) }))
    if (tone.length > 0) vendor.pronunciation_map = tone
  }
  return vendor
}

/** MiniMax toggles → 请求体深路径（键 = 投影 toggles 成员 id；值恒布尔）。 */
const MINIMAX_TOGGLE_PATHS: Record<string, readonly string[]> = {
  text_normalization: ['voice_setting', 'text_normalization'],
  latex_read: ['voice_setting', 'latex_read'],
  aigc_watermark: ['aigc_watermark'],
}

/** 数值档位（音量/音调）→ voice_setting 深路径（投影 range null = 不写）。 */
function applyMinimaxNumericFields(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  if (form.volumeRange && state.volume !== null) {
    setPath(vendor, ['voice_setting', 'vol'], clampNumber(state.volume, form.volumeRange.min, form.volumeRange.max, form.volumeRange.min))
  }
  if (form.pitchRange && state.pitch !== null) {
    setPath(vendor, ['voice_setting', 'pitch'], clampNumber(state.pitch, form.pitchRange.min, form.pitchRange.max, form.pitchRange.min))
  }
}

/** 枚举类字段（情感/声道/语言增强；投影空数组 = 不写）。声道是数值语义（MiniMax audio_setting.channel int64）
 *  ——Select 档位 id 恒 string，写 vendor 必须 Number 化（D3 验收实测：字符串直传被厂商 2013 invalid params 拒）。 */
function applyMinimaxEnumFields(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  if (form.emotions.length > 0 && state.emotion) {
    setPath(vendor, ['voice_setting', 'emotion'], state.emotion)
  }
  if (form.channels.length > 0 && state.channel !== null) {
    setPath(vendor, ['audio_setting', 'channel'], Number(state.channel))
  }
  if (form.languages.length > 0 && state.languageBoost) {
    vendor.language_boost = state.languageBoost
  }
}

/** toggles 清单 → 请求体深路径（MINIMAX_TOGGLE_PATHS 表驱动，键 = 投影 toggles 成员 id）。 */
function applyMinimaxToggles(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  for (const id of form.toggles) {
    const path = MINIMAX_TOGGLE_PATHS[id]
    if (path) setPath(vendor, path, state.toggles[id] === true)
  }
}

/** 双音色混合（maxTimbreVoices 开；主音色权重 = 总量 − 第二权重，M0 开放 2，设计 §5.2）。 */
function applyMinimaxTimbreWeights(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  if (form.maxTimbreVoices > 0 && state.secondVoice) {
    const weight = clampNumber(state.secondVoiceWeight, TIMBRE_WEIGHT_MIN, TIMBRE_WEIGHT_MAX, DEFAULT_TIMBRE_WEIGHT)
    vendor.timbre_weights = [
      { voice_id: state.voice, weight: TIMBRE_WEIGHT_TOTAL - weight },
      { voice_id: state.secondVoice, weight },
    ]
  }
}

/** 效果器（voiceModify 投影驱动：tiers 档位全量写入 + 可选 sound_effects）。 */
function applyMinimaxVoiceModify(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  if (!form.voiceModify) return
  const modify: Record<string, unknown> = {}
  for (const tier of form.voiceModify.tiers) {
    modify[tier.id] = clampNumber(state.voiceModifyValues[tier.id], VOICE_MODIFY_MIN, VOICE_MODIFY_MAX, 0)
  }
  if (state.voiceModifyEffect) modify.sound_effects = state.voiceModifyEffect
  if (Object.keys(modify).length > 0) vendor.voice_modify = modify
}

/** 发音词典（hasPronunciationDict 开；空行剔除后非空才写 pronunciation_dict.tone）。 */
function applyMinimaxPronunciation(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  if (!form.hasPronunciationDict || state.pronunciationRules.length === 0) return
  const tone = nonEmptyRules(state.pronunciationRules).map((r) => joinPronunciationRule(r))
  if (tone.length > 0) setPath(vendor, ['pronunciation_dict', 'tone'], tone)
}

function buildMinimaxVendor(form: TtsFormModel, state: TtsProviderFormState): Record<string, unknown> {
  const vendor: Record<string, unknown> = {}
  applyMinimaxNumericFields(vendor, form, state)
  applyMinimaxEnumFields(vendor, form, state)
  applyMinimaxToggles(vendor, form, state)
  applyMinimaxTimbreWeights(vendor, form, state)
  applyMinimaxVoiceModify(vendor, form, state)
  applyMinimaxPronunciation(vendor, form, state)
  return vendor
}

function buildMimoVendor(_form: TtsFormModel, _state: TtsProviderFormState): Record<string, unknown> {
  // MiMo 借壳形态：采样率固定 24kHz、无音量/音调/情感字段，M0 投影无任何 vendor 控件
  //（toggles/channels/emotions/languages 全空、maxTimbreVoices 0、词典 false，mock 投影同构）。
  return {}
}

const VENDOR_BUILDERS: Record<TtsProviderId, (form: TtsFormModel, state: TtsProviderFormState) => Record<string, unknown>> = {
  stepfun: buildStepfunVendor,
  minimax: buildMinimaxVendor,
  mimo: buildMimoVendor,
}

const VENDOR_PARSERS: Record<TtsProviderId, (form: TtsFormModel, vendor: Record<string, unknown>, state: TtsProviderFormState) => void> = {
  stepfun: parseStepfunVendor,
  minimax: parseMinimaxVendor,
  mimo: () => {},
}

// ── 双向变换 ────────────────────────────────────────────────────────────────

/** 表单态 → 落盘形状（TtsConfig 顶层标准位 + vendor 子树；不含 Key——Key 在独立 secrets）。 */
export function buildConfig(providerId: TtsProviderId, form: TtsFormModel, state: TtsProviderFormState): TtsConfig {
  const speedRange = form.capabilities.speedRange
  const config: TtsConfig = {
    baseUrl: state.baseUrl,
    model: state.model,
    voice: state.voice,
    ...(speedRange && state.speed !== null
      ? {
        speed: clampNumber(
          state.speed,
          speedRange[0],
          speedRange[1],
          Number(defaultInRangeId({ min: speedRange[0], max: speedRange[1] })),
        ),
      }
      : {}),
    ...(form.capabilities.supportsInstructions && state.instructions.trim() !== '' ? { instructions: state.instructions } : {}),
    ...(state.sampleRate !== null ? { sampleRate: clampNumber(state.sampleRate, 0, Number.MAX_SAFE_INTEGER, DEFAULT_SAMPLE_RATE) } : {}),
    vendor: VENDOR_BUILDERS[providerId](form, state),
  }
  return config
}

/** 落盘形状 → 表单态（getConfig 回读投影；vendor 缺失字段回投影出厂默认，往返可逆）。 */
export function formStateFromConfig(providerId: TtsProviderId, form: TtsFormModel, config: TtsConfig): TtsProviderFormState {
  const state = emptyFormState(form)
  const vendor = typeof config.vendor === 'object' && config.vendor !== null ? (config.vendor as Record<string, unknown>) : {}
  state.baseUrl = config.baseUrl || state.baseUrl
  state.model = config.model || state.model
  state.voice = config.voice || state.voice
  if (form.capabilities.speedRange && typeof config.speed === 'number') {
    state.speed = String(config.speed)
  }
  state.instructions = typeof config.instructions === 'string' ? config.instructions : ''
  if (config.sampleRate !== undefined && form.capabilities.pcmSampleRates.includes(config.sampleRate)) {
    state.sampleRate = String(config.sampleRate)
  }
  VENDOR_PARSERS[providerId](form, vendor, state)
  return state
}

function parseStepfunVendor(form: TtsFormModel, vendor: Record<string, unknown>, state: TtsProviderFormState): void {
  if (form.volumeRange && typeof vendor.volume === 'number') state.volume = String(vendor.volume)
  if (form.toggles.includes('text_normalization')) {
    state.toggles['text_normalization'] = vendor.text_normalization === 'enhanced'
  }
  if (form.hasPronunciationDict && Array.isArray(vendor.pronunciation_map)) {
    state.pronunciationRules = (vendor.pronunciation_map as Array<{ tone?: unknown }>)
      .map((e) => (typeof e?.tone === 'string' ? splitPronunciationRule(e.tone) : null))
      .filter((r): r is TtsPronunciationRule => r !== null)
  }
}

/** 数值档位回读（音量/音调；投影 range 开才读，档位 id string 承载）。 */
function parseMinimaxNumericFields(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  const vol = getPath(vendor, ['voice_setting', 'vol'])
  if (form.volumeRange && typeof vol === 'number') state.volume = String(vol)
  const pitch = getPath(vendor, ['voice_setting', 'pitch'])
  if (form.pitchRange && typeof pitch === 'number') state.pitch = String(pitch)
}

/** 枚举类回读（情感/声道/语言增强）。声道兼容两形态：数值（本表单写路规范形态）与历史落盘的字符串档位 id。 */
function parseMinimaxEnumFields(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  const emotion = getPath(vendor, ['voice_setting', 'emotion'])
  if (form.emotions.length > 0 && typeof emotion === 'string') state.emotion = emotion
  const channel = getPath(vendor, ['audio_setting', 'channel'])
  if (form.channels.length > 0 && (typeof channel === 'number' || typeof channel === 'string')) {
    state.channel = String(channel)
  }
  const boost = vendor.language_boost
  if (form.languages.length > 0 && typeof boost === 'string') state.languageBoost = boost
}

/** toggles 回读（MINIMAX_TOGGLE_PATHS 表驱动，值恒布尔）。 */
function parseMinimaxToggles(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  for (const id of form.toggles) {
    const path = MINIMAX_TOGGLE_PATHS[id]
    if (path) state.toggles[id] = getPath(vendor, path) === true
  }
}

/** 双音色回读（timbre_weights 第二条目；voice_id string 才认，weight 缺失保持出厂档）。 */
function parseMinimaxTimbreWeights(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  const weights = vendor.timbre_weights
  if (form.maxTimbreVoices > 0 && Array.isArray(weights) && weights.length >= MIN_TIMBRE_ENTRIES) {
    const second = weights[1] as { voice_id?: unknown; weight?: unknown }
    if (typeof second.voice_id === 'string') {
      state.secondVoice = second.voice_id
      if (typeof second.weight === 'number') state.secondVoiceWeight = String(second.weight)
    }
  }
}

/** 效果器回读（tiers 档位数值化 + sound_effects）。 */
function parseMinimaxVoiceModify(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  const modify = vendor.voice_modify
  if (form.voiceModify && typeof modify === 'object' && modify !== null) {
    const m = modify as Record<string, unknown>
    for (const tier of form.voiceModify.tiers) {
      const v = m[tier.id]
      if (typeof v === 'number') state.voiceModifyValues[tier.id] = String(v)
    }
    if (typeof m.sound_effects === 'string') state.voiceModifyEffect = m.sound_effects
  }
}

/** 发音词典回读（「原文/替换」串 → 行；无分隔符条目按原文整串回读，不丢用户数据）。 */
function parseMinimaxPronunciation(vendor: Record<string, unknown>, form: TtsFormModel, state: TtsProviderFormState): void {
  const tone = getPath(vendor, ['pronunciation_dict', 'tone'])
  if (form.hasPronunciationDict && Array.isArray(tone)) {
    state.pronunciationRules = (tone as unknown[])
      .map((e) => (typeof e === 'string' ? splitPronunciationRule(e) : null))
      .filter((r): r is TtsPronunciationRule => r !== null)
  }
}

function parseMinimaxVendor(form: TtsFormModel, vendor: Record<string, unknown>, state: TtsProviderFormState): void {
  parseMinimaxNumericFields(vendor, form, state)
  parseMinimaxEnumFields(vendor, form, state)
  parseMinimaxToggles(vendor, form, state)
  parseMinimaxTimbreWeights(vendor, form, state)
  parseMinimaxVoiceModify(vendor, form, state)
  parseMinimaxPronunciation(vendor, form, state)
}

/**
 * 每家 toggle 的布局分区：aigc_watermark 归「进阶」区（任务书长尾四区），其余归「风格」区。
 * 这是布局常量（驱动渲染位置），不影响控件存在性（存在性仍全由投影 toggles 清单决定）。
 */
export function isLongtailToggle(id: string): boolean {
  return id === 'aigc_watermark'
}

/** 「不指定」空值选项的哨兵 id（reka SelectItem value 不接受空串；投影枚举 id 空间外）。 */
export const NONE_OPTION_ID = '__none__'
