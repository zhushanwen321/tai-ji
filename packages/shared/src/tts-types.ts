/**
 * 语音合成朗读（TTS）契约类型 —— shared 协议层 SSOT。
 *
 * 设计文档：.tmp/tech-design/ai-voice-tts.md §7.1（WS 协议面）/ §7.3（driver 接口与能力表）。
 * 全部形状以该设计 §7.3 TS 块为唯一权威；消费方：
 * - runtime driver（infra/tts/，u2）：实现 TtsDriver，消费 TtsCapabilities / InternalSpeechRequest
 * - runtime service / transport（u3）：打包 InternalSpeechRequest、reply 协议载荷
 * - renderer 设置页（u4 TtsPage）：消费 tts.getCapabilities 回的 TtsFormModel 渲染表单
 * - core 传输域（transport/api/domains/tts.ts）：reply 载荷类型引用
 *
 * 纯类型无 node 依赖，barrel 安全（renderer 整包 import 不触发 node:os/:path）。
 */

/** TTS 服务商 id（M0 三家；新增厂商 = 加一个 driver + 能力表与表单投影各一份声明，设计 §2）。 */
export type TtsProviderId = 'stepfun' | 'minimax' | 'mimo'

/**
 * TTS 统一错误码词表（设计 §7.1；renderer 按码映射 i18n toast，§5.4 表）。
 * - tts_not_configured：未配置（无服务商或无 Key；tts.json parse 失败同按此码处理，§7.4 步骤 1）
 * - tts_auth_failed：厂商鉴权失败（401 / MiniMax base_resp 1004）
 * - tts_quota_exceeded：厂商/plan 额度耗尽（402 quota 类——恢复指引查额度而非重试，§5.4）
 * - tts_vendor_error：其余厂商侧错误（非 2xx、业务码非零、响应形状不符）
 * - tts_network_error：网络异常与超时（fetch throw / AbortError，driver 基座归类）
 * - tts_text_too_long：清洗后文本超 MAX_SPEAK_CHARS（§7.6）
 * - tts_empty_text：清洗后无文本（§7.4 步骤 2）
 */
export type TtsErrorCode =
  | 'tts_not_configured'
  | 'tts_auth_failed'
  | 'tts_quota_exceeded'
  | 'tts_vendor_error'
  | 'tts_network_error'
  | 'tts_text_too_long'
  | 'tts_empty_text'

/** per-model 联动数据（设计 §7.3 TtsCapabilities.perModel 的条目形状；键 = 模型 id）。 */
export interface PerModelCapabilities {
  /** 指令长度上限（StepFun 2.5 系 200 / 3 系 500）；null = 该模型不支持指令。 */
  instructionMaxChars: number | null
  /** voice_label 支持位（StepFun 2.5/3 系 false → 控件置灰）。 */
  voiceLabelSupported: boolean
}

/** 表单下拉/枚举的单个选项（设计 §7.3）。 */
export interface FormOption {
  id: string
  label: string
}

/** 「凭据」服务地址下拉项（设计 §7.3）：isDefault 项即 D4 Key 联动「出厂默认值」的判定数据。 */
export interface BaseUrlOption {
  url: string
  label: string
  isDefault: boolean
}

/** 数值控件值域（设计 §7.3；音量/音调档位）。 */
export interface NumberRange {
  min: number
  max: number
  step: number
}

/**
 * 合成能力表：driver 钳制/丢弃的唯一数据源（唯一权威声明见设计 D3；三家数据本体定义在
 * runtime driver 侧，本文件只登记形状）。
 */
export interface TtsCapabilities {
  /** 厂商 API 端点路径，拼在配置的 baseUrl 后。 */
  endpointPath: string
  /** 鉴权头形态（MiMo 是 api-key，其余两家 Bearer，设计 §7.2）。 */
  authHeader: 'bearer' | 'api-key'
  /** 单段输入上限（service 分句依据；1000 / 3000 / 1000，设计 §7.2）。 */
  maxInputChars: number
  /** 语速值域；null = 不支持（MiMo 无语速字段 → 丢弃 + UI 置灰）。 */
  speedRange: [number, number] | null
  /** 实际可用采样率，WAV 头取 24000 或最近值（声道数不在能力表——driver 按请求组装值回报）。 */
  pcmSampleRates: number[]
  /** false = 该家无指令对应字段（MiniMax）：指令控件不渲染、speak 带指令时丢弃 + 日志。 */
  supportsInstructions: boolean
  /** per-model 联动数据（键 = 模型 id），驱动指令长度上限与 voice_label 置灰。 */
  perModel: Record<string, PerModelCapabilities>
}

/**
 * 表单投影数据：设置页表单渲染的唯一数据源（tts.getCapabilities 的 reply 载荷，设计 §7.3）。
 * 与该家能力表同文件定义在 driver——派生关系 = 内嵌能力表（联动置灰读 speedRange/perModel 等）
 * + 表单专属枚举与值域。控件存在性规则：枚举类空数组 = 控件不渲染；数值类 null = 控件置灰；
 * 开关/结构类不在清单 / 为 0 = 不渲染。
 */
export interface TtsFormModel {
  capabilities: TtsCapabilities
  /** 「凭据」服务地址下拉（各家默认域名与集群变体）——renderer 不内置厂商域名。 */
  baseUrlOptions: readonly BaseUrlOption[]
  /** 「基础」模型下拉（三家 model 枚举）。 */
  models: readonly FormOption[]
  /** 音色下拉（混合音色选择器复用同一可选集）。 */
  voices: readonly FormOption[]
  /** 音量值域（MiMo null → 置灰）。 */
  volumeRange: NumberRange | null
  /** 音调值域（仅 MiniMax；其余两家 null → 置灰）。 */
  pitchRange: NumberRange | null
  /** 「音频」声道枚举（MiniMax 单/双声道）。 */
  channels: readonly FormOption[]
  /** 「风格」情感枚举（MiniMax ×9；其余家空数组 = 控件不渲染）。 */
  emotions: readonly FormOption[]
  /** 语言增强枚举（MiniMax language_boost；其余家空数组 = 不渲染）。 */
  languages: readonly FormOption[]
  /** 开关类控件 id（文本归一 / LaTeX 朗读 / AIGC 水印…；不在清单 = 不渲染）。 */
  toggles: readonly string[]
  /** 声音效果器档位与效果枚举（仅 MiniMax，null = 不渲染）。 */
  voiceModify: { tiers: readonly FormOption[]; effects: readonly FormOption[] } | null
  /** 混合音色上限（0 = 该家不支持；MiniMax 4，M0 开放 2）。 */
  maxTimbreVoices: number
  /** 发音词典行编辑器存在性（行格式固定「原文 → 替换」）。 */
  hasPronunciationDict: boolean
}

/**
 * 表单值落盘形状（tts.json 每家一个条目，设计 D4/§7.3；长尾字段按厂商 API 原名原路径存，
 * D2 连带裁决——service 打包 passthrough = vendor 子树恒等搬运，零字段名知识、零厂商判断）。
 * 标准位字段占顶层（跨家通用名，值经表单投影校验）；厂商私有字段收在 vendor 子树。
 */
export interface TtsConfig {
  baseUrl: string
  model: string
  voice: string
  /** MiMo 无此字段不存（置灰）。 */
  speed?: number
  instructions?: string
  /** MiMo 固定 24kHz 不存（传入忽略）。 */
  sampleRate?: number
  /** 该家厂商私有字段子树（原名原路径，键序结构与该家请求体一致）。 */
  vendor: Record<string, unknown>
}

/**
 * 内部统一合成请求（OpenAI `POST /v1/audio/speech` 形 + 受控扩展，设计 D1/§7.3）。
 * driver 职责 = 字段换家 + 钳制/丢弃；`response_format` 恒 pcm 系值（D9——进类型面使
 * D5 缓存键全集与类型面逐项对齐）：StepFun `pcm` / MiniMax `audio_setting.format=pcm` / MiMo `pcm16`。
 * `passthrough` 是 speak 时由 TtsConfig.vendor 子树恒等搬运组装出的请求字段（派生值，不落盘），
 * driver 将其 deep-merge 进厂商请求体（护栏见设计 D2）。
 */
export interface InternalSpeechRequest {
  model: string
  input: string
  voice: string
  response_format?: 'pcm' | 'pcm16'
  sample_rate?: number
  instructions?: string
  speed?: number
  passthrough?: Record<string, unknown>
}

/** 单家配置的脱敏投影条目（tts.getConfig reply；永不回 Key 本体，Key 在独立 secrets 文件）。 */
export interface SanitizedTtsProviderState {
  /** 该家表单值（TtsConfig 本身不含 Key 字段——Key 唯一权威在 secrets/tts-<厂商>-apikey.txt）。 */
  config: TtsConfig
  /** 该家是否已配置专属 Key（secrets 文件存在且非空）。 */
  hasApiKey: boolean
  /** 供应商 Key 联动检测信号（D4）：仅 MiniMax/MiMo 参与联动（经 IProviderCredentialResolver 判定），StepFun 恒 false。 */
  providerKeyAvailable: boolean
}

/**
 * tts.getConfig reply 的 config 载荷（设计 §7.1）：activeProvider + 三家脱敏投影。
 * 敏感信息只含 hasApiKey 与 providerKeyAvailable 两个布尔（永不回 Key 本体，D4「明文不出 runtime」）；
 * 表单值本身非敏感（u4 保存/读取往返单测依赖此载荷回读一致）。
 */
export interface SanitizedTtsConfig {
  /** 默认朗读服务商（设置页卡片单选；朗读与「保存并测试」都用它）。 */
  activeProvider: TtsProviderId
  /** 三家各自的表单值 + 敏感投影（每家独立记忆，互不影响）。 */
  providers: Record<TtsProviderId, SanitizedTtsProviderState>
}

/**
 * tts.configure 的 apiKeys 传入值语义（设计 §7.1）：
 * - 缺席 = 不动；字符串 = 写入（空串由 runtime 按清除处理）；null = 清除；
 * - `'from-provider'` = 联动带入（runtime 经 IProviderCredentialResolver 读对应 provider 的
 *   Key 写入 TTS secrets，同时按 provider baseUrl 预填同集群地址——仅 MiMo 家预填，D4）。
 */
export type TtsApiKeyInput = string | null | 'from-provider'
