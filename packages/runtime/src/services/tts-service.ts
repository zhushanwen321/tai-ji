/**
 * TtsService —— 语音合成朗读编排服务（ai-voice-tts 设计 §7.4）。
 *
 * 职责（每步失败映射 §7.1 错误码，统一经 TtsServiceError 抛出——server handleMessage
 * 的顶层 catch 把 `error.code` 透传进 error envelope，renderer 按码映射 i18n toast）：
 * - speak 八步编排：读配置/Key → 清洗复核 → 组参数+缓存键 → 分句 → 逐段合成
 *   → PCM 拼接+WAV 头 → 原子写+双条件 FIFO 封顶 → 回 filePath
 * - getConfig：脱敏投影（hasApiKey + providerKeyAvailable 两布尔，永不回 Key 本体）
 * - configure：runtime 复核（写路整条拒绝 invalid_payload，不落半改状态）→ 原子写 tts.json
 *   → secret 写删（quota 范式：persist 成功后才动 secrets）→ Key 联动（D4）
 * - getCapabilities：三家表单投影（数据权威在 infra/tts 表单投影，本层零厂商枚举）
 *
 * 分层纪律：本层只消费 TtsDriver port 与 IProviderCredentialResolver port；厂商协议知识
 * （字段换家/钳制丢弃/错误翻译）全部在 driver（infra/tts/，u2），统一层零厂商判断——
 * 唯二例外是 D4 显式裁决的两张常量映射表（TTS provider id → 模型 provider id，见下方常量）。
 * driver 实例按 (providerId, config.baseUrl) 在合成前现建（端点跟随 tts.json 配置），
 * 与 baseUrl 无关的知识（skeleton/校验/getCapabilities）走表单投影，不构造 driver。
 *
 * 外部 HTTP 只准出现在 infra/tts/（仓库硬约束）；本文件 fs 写入点全部有归属（设计 §7.4
 * 写入点清单）：tts.json（唯一写入者 = configure，原子写）、secrets/tts-<id>-apikey.txt、
 * tts-cache/*.wav（可重建缓存）。
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type {
  InternalSpeechRequest,
  SanitizedTtsConfig,
  SanitizedTtsProviderState,
  TtsApiKeyInput,
  TtsConfig,
  TtsErrorCode,
  TtsFormModel,
  TtsProviderId,
} from '@taiji/shared'
import { cleanTextForSpeech, MAX_SPEAK_CHARS, TTS_CACHE_MAX_BYTES, TTS_CACHE_MAX_FILES } from '@taiji/shared'
import { getDataDir, getTtsCacheDir } from '@taiji/shared/paths'
import { logger } from '../infra/logger.js'
import type { IProviderCredentialResolver } from './ports/provider-credential-resolver.js'
import type { TtsDriver } from './ports/tts.js'
import { toErrorMessage } from '../utils/errors.js'
import { canonicalSerialize, enforceTtsCacheFifoCap, splitIntoChunks, wrapWavHeader } from './tts-audio.js'

/** 服务失败的统一错误形态：code 供 server 顶层 catch 透传 error envelope（§7.1 错误码词表）。 */
export class TtsServiceError extends Error {
  readonly code: TtsErrorCode | 'invalid_payload'
  constructor(code: TtsErrorCode | 'invalid_payload', message: string) {
    super(message)
    this.name = 'TtsServiceError'
    this.code = code
  }
}

/** tts.configure 的输入载荷（形状与 protocol ClientMessageMap['tts.configure'] 逐字段一致）。 */
export interface TtsConfigurePayload {
  providerId: TtsProviderId
  config: TtsConfig
  apiKeys?: Partial<Record<TtsProviderId, TtsApiKeyInput>>
}

/** tts.configure 的返回（形状与 protocol ServerMessageMap['tts.configure:result'] 一致）。 */
export interface TtsConfigureResult {
  config?: SanitizedTtsConfig
  ok: boolean
  error?: string
}

/** tts.json 落盘形状（D4：activeProvider + 每家一个 TtsConfig 条目）。 */
interface TtsStoreShape {
  activeProvider: TtsProviderId
  providers: Partial<Record<TtsProviderId, TtsConfig>>
}

/** TtsProviderId 字面量全集（运行时判型用；类型面以 shared 联合为权威）。 */
const TTS_PROVIDER_IDS = ['stepfun', 'minimax', 'mimo'] as const satisfies readonly TtsProviderId[]

/** getConfig 的兜底 activeProvider（全部未配置时投影仍需一个确定值；联合首成员，无行为影响）。 */
const DEFAULT_ACTIVE_PROVIDER: TtsProviderId = 'stepfun'

/** tts.json 文件名（落 <dataDir>/ 根，D4）。 */
const TTS_CONFIG_FILENAME = 'tts.json'

/** TTS 专属 secret 文件名前缀（secrets/tts-<厂商>-apikey.txt，D4 命名空间声明）。 */
const TTS_SECRET_PREFIX = 'tts-'
/** secret 文件后缀（与 quota 同目录并存，精确路径读写、无目录枚举，两侧互不感知）。 */
const TTS_SECRET_SUFFIX = '-apikey.txt'

/** secret 文件权限：仅属主可读写（quota 范式）。 */
const SECRET_FILE_MODE = 0o600
/** secrets / tts-cache 目录权限：仅属主可读写执行（quota 范式）。 */
const SECRET_DIR_MODE = 0o700
/** tts.json 落盘缩进（人可读调试友好，与仓内 JSON 落盘惯例一致）。 */
const TTS_JSON_INDENT_SPACES = 2

/**
 * TTS provider id → 模型 provider id 映射（D4 显式裁决，内置模板稳定常量）：
 * Key 联动与 MiMo baseUrl 预填的匹配键。StepFun 无内置模板不参与联动（空表 → 恒 false）。
 */
const TTS_PROVIDER_TO_MODEL_PROVIDER_IDS: Record<TtsProviderId, readonly string[]> = {
  stepfun: [],
  minimax: ['minimax', 'minimax-cn'],
  mimo: ['xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'],
}

/** TtsErrorCode 运行时词表（driver 拒绝形态的 code 判型用）。 */
const TTS_ERROR_CODES: ReadonlySet<string> = new Set([
  'tts_not_configured',
  'tts_auth_failed',
  'tts_quota_exceeded',
  'tts_vendor_error',
  'tts_network_error',
  'tts_text_too_long',
  'tts_empty_text',
])

function isTtsProviderId(value: unknown): value is TtsProviderId {
  return typeof value === 'string' && (TTS_PROVIDER_IDS as readonly string[]).includes(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 单家驱动缺省配置骨架（D3 零厂商判断：默认值全部从该家表单投影推导，无硬编码枚举）。
 *  数据源是表单投影而非 driver 实例——骨架与 baseUrl 无关，先于 driver 现建发生。 */
function skeletonConfigOf(formModel: TtsFormModel): TtsConfig {
  const defaultBaseUrl = formModel.baseUrlOptions.find((option) => option.isDefault)
  return {
    baseUrl: defaultBaseUrl?.url ?? '',
    model: formModel.models[0]?.id ?? '',
    voice: formModel.voices[0]?.id ?? '',
    vendor: {},
  }
}

/** 存量条目向骨架合并（防御性读取：字段级判型，畸形字段落回骨架值，不抛）。 */
function mergeStoredConfig(skeleton: TtsConfig, stored: unknown): TtsConfig {
  if (!isPlainObject(stored)) return skeleton
  const merged: TtsConfig = {
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : skeleton.baseUrl,
    model: typeof stored.model === 'string' ? stored.model : skeleton.model,
    voice: typeof stored.voice === 'string' ? stored.voice : skeleton.voice,
    vendor: isPlainObject(stored.vendor) ? stored.vendor : {},
  }
  if (typeof stored.speed === 'number') merged.speed = stored.speed
  if (typeof stored.instructions === 'string') merged.instructions = stored.instructions
  if (typeof stored.sampleRate === 'number') merged.sampleRate = stored.sampleRate
  return merged
}

export interface TtsServiceOptions {
  /** 数据目录（默认 getDataDir()；测试注入 mkdtemp 目录）。 */
  dataDir?: string
  /**
   * driver 工厂（infra/tts createTtsDriver 直传）：speak 合成前按 tts.json 现读 baseUrl
   * 现建 driver，请求端点跟随用户配置（构造期固化出厂默认会使非默认集群配置失效）。
   */
  createDriver: (id: TtsProviderId, baseUrl: string) => TtsDriver
  /**
   * 三家表单投影（infra/tts getTtsFormModels 产出）：skeleton 默认值 / configure 校验 /
   * getCapabilities 投影的数据源。capabilities 内嵌于投影且与 driver 实例同源常量，
   * 这些知识均与 baseUrl 无关，故与 driver 实例解耦（不为此构造 driver）。
   */
  formModels: Record<TtsProviderId, TtsFormModel>
  /** Provider 凭据解析唯一通道（u7 扩展后的 port：resolveProviderCredential + resolveProviderBaseUrl）。 */
  credentialResolver: IProviderCredentialResolver
  /** 缓存封顶文件数上限（默认 shared TTS_CACHE_MAX_FILES；测试注入小值）。 */
  cacheMaxFiles?: number
  /** 缓存封顶字节上限（默认 shared TTS_CACHE_MAX_BYTES；测试注入小值）。 */
  cacheMaxBytes?: number
  /**
   * 缓存封顶的文件删除通道（默认 rmSync force；测试注入失败形态如 EBUSY 用，生产不传）。
   * 语义契约见 enforceTtsCacheFifoCap 的 remove 注入点。
   */
  cacheRemove?: (filePath: string) => void
}

export class TtsService {
  private readonly dataDir: string
  private readonly createDriver: (id: TtsProviderId, baseUrl: string) => TtsDriver
  private readonly formModels: Record<TtsProviderId, TtsFormModel>
  private readonly credentialResolver: IProviderCredentialResolver
  private readonly cacheMaxFiles: number
  private readonly cacheMaxBytes: number
  private readonly cacheRemove: ((filePath: string) => void) | undefined
  /** 进程内 tmp 序号：同进程多次原子写的 tmp 名互不碰撞（fs-utils 同款语义，二进制版就地实现）。 */
  private tmpSeq = 0

  constructor(options: TtsServiceOptions) {
    this.dataDir = options.dataDir ?? getDataDir()
    this.createDriver = options.createDriver
    this.formModels = options.formModels
    this.credentialResolver = options.credentialResolver
    this.cacheMaxFiles = options.cacheMaxFiles ?? TTS_CACHE_MAX_FILES
    this.cacheMaxBytes = options.cacheMaxBytes ?? TTS_CACHE_MAX_BYTES
    this.cacheRemove = options.cacheRemove
  }

  // ── tts.speak：八步编排（§7.4）───────────────────────────────────────────

  /**
   * 合成并落盘，返回可播放的 WAV 文件路径。reply 只回 filePath——fromCache/chars/chunks
   * 只进日志不进协议面（§7.1）。
   */
  async speak(text: string, sessionId?: string): Promise<{ filePath: string }> {
    // ① 读 tts.json + secrets/tts-<id>-apikey.txt（现读现用，无缓存）
    const { store, parseFailed } = this.readTtsStore()
    const providerId = store.activeProvider
    if (parseFailed || !isTtsProviderId(providerId)) {
      if (parseFailed) logger.warn('[tts] tts.json parse failed, treating as not configured')
      throw new TtsServiceError('tts_not_configured', 'TTS is not configured')
    }
    const formModel = this.formModels[providerId]
    const storedEntry = store.providers[providerId]
    if (!formModel || !storedEntry) {
      throw new TtsServiceError('tts_not_configured', `TTS provider not configured: ${providerId}`)
    }
    const config = mergeStoredConfig(skeletonConfigOf(formModel), storedEntry)
    const apiKey = this.readSecretFile(providerId)
    if (!apiKey) {
      throw new TtsServiceError('tts_not_configured', `API key missing for TTS provider: ${providerId}`)
    }

    // ② 清洗复核（renderer 已洗，此处幂等重洗兜底）
    const cleaned = cleanTextForSpeech(text)
    if (!cleaned) throw new TtsServiceError('tts_empty_text', 'no speakable text after cleaning')
    if (cleaned.length > MAX_SPEAK_CHARS) {
      throw new TtsServiceError(
        'tts_text_too_long',
        `text too long after cleaning: ${cleaned.length} > ${MAX_SPEAK_CHARS}`,
      )
    }

    // ③ 组装合成参数 + 缓存键（键全集见 D5；命中即跳过厂商请求）
    const request = this.buildSpeechRequest(config, cleaned)
    const cacheKey = this.cacheKey(providerId, config, cleaned)
    const cacheDir = getTtsCacheDir(this.dataDir)
    const filePath = join(cacheDir, `${cacheKey}.wav`)
    if (existsSync(filePath)) {
      logger.info('[tts] speak cache hit', { fromCache: true, chars: cleaned.length, providerId, sessionId })
      return { filePath }
    }

    // ④ 分句（句边界优先，每段 ≤ capabilities.maxInputChars）+ 合成前现建 driver：
    // 端点取 config.baseUrl（speak 时跟随 tts.json 配置，§7.4 步骤 1）；缓存命中不触厂商
    // 请求故不建。capabilities 内嵌于表单投影（三家同源常量，与 driver 实例无差）。
    const driver = this.createDriver(providerId, config.baseUrl)
    const chunks = splitIntoChunks(cleaned, formModel.capabilities.maxInputChars)

    // ⑤ 逐段顺序调 driver.synthesizeChunk（顺序而非并行：厂商限流未知，M0 保守）
    const parts: Awaited<ReturnType<TtsDriver['synthesizeChunk']>>[] = []
    for (const chunk of chunks) {
      try {
        parts.push(await driver.synthesizeChunk({ ...request, input: chunk }, apiKey))
      } catch (err) {
        throw this.normalizeDriverError(err)
      }
    }

    // ⑥ PCM 拼接 + WAV 头（采样率/声道取首段 driver 回报实际值；多段不一致以第一段为准）
    const pcm = Buffer.concat(parts.map((part) => part.pcm))
    const wav = wrapWavHeader(pcm, parts[0].sampleRate, parts[0].channels)

    // ⑦ 原子写 <dataDir>/tts-cache/<hash>.wav（同目录临时文件 + rename）+ 双条件 FIFO 封顶
    this.ensureDirWithMode(cacheDir)
    this.atomicWriteBinary(filePath, wav)
    enforceTtsCacheFifoCap(cacheDir, {
      maxFiles: this.cacheMaxFiles,
      maxBytes: this.cacheMaxBytes,
      remove: this.cacheRemove,
    })

    // ⑧ reply filePath（观测字段只进日志）
    logger.info('[tts] speak synthesized', {
      fromCache: false,
      chars: cleaned.length,
      chunks: chunks.length,
      providerId,
      sessionId,
    })
    return { filePath }
  }

  /** OpenAI 形统一请求组装（标准位字段取 TtsConfig 顶层；passthrough = vendor 子树恒等搬运，D2）。 */
  private buildSpeechRequest(config: TtsConfig, cleaned: string): InternalSpeechRequest {
    const request: InternalSpeechRequest = {
      model: config.model,
      input: cleaned,
      voice: config.voice,
      // 内部恒 pcm 系（D9）；MiMo 的 pcm16 是 driver 换家映射的内部值，缓存键含 provider id，
      // per-provider 常量不损键唯一性
      response_format: 'pcm',
      passthrough: { ...config.vendor },
    }
    if (config.speed !== undefined) request.speed = config.speed
    if (config.instructions !== undefined) request.instructions = config.instructions
    if (config.sampleRate !== undefined) request.sample_rate = config.sampleRate
    return request
  }

  /**
   * 缓存键（D5）：清洗后文本 + provider id + baseUrl + 全部标准位字段 + passthrough 的
   * canonical 序列化 → sha1。凡影响合成产物的字段全集参与键；sessionId 不参与（纯函数语义）。
   */
  private cacheKey(providerId: TtsProviderId, config: TtsConfig, cleanedText: string): string {
    const keyInput = {
      text: cleanedText,
      provider: providerId,
      baseUrl: config.baseUrl,
      model: config.model,
      voice: config.voice,
      speed: config.speed,
      instructions: config.instructions,
      response_format: 'pcm' satisfies InternalSpeechRequest['response_format'],
      sample_rate: config.sampleRate,
      passthrough: config.vendor,
    }
    return createHash('sha1').update(canonicalSerialize(keyInput)).digest('hex')
  }

  /** driver 拒绝形态归一：契约形态（code+snippet）→ 同码 TtsServiceError；其余原样上抛（归因内部 bug）。 */
  private normalizeDriverError(err: unknown): unknown {
    if (isPlainObject(err) && typeof err.code === 'string' && TTS_ERROR_CODES.has(err.code)) {
      const snippet = typeof err.snippet === 'string' ? err.snippet : ''
      return new TtsServiceError(err.code as TtsErrorCode, `TTS synthesis failed: ${snippet}`)
    }
    return err
  }

  // ── tts.getConfig：脱敏投影 ─────────────────────────────────────────────

  /** 设置页首屏投影：每家只回 hasApiKey + providerKeyAvailable 两敏感布尔，永不回 Key 本体。 */
  async getConfig(): Promise<SanitizedTtsConfig> {
    const { store, parseFailed } = this.readTtsStore()
    if (parseFailed) {
      // parse 失败降级：回默认骨架配置（恢复指引见设计 §5.4 表末行），parse 错误已日志
      logger.warn('[tts] tts.json parse failed, returning skeleton config')
    }
    const providers = {} as Record<TtsProviderId, SanitizedTtsProviderState>
    for (const id of TTS_PROVIDER_IDS) {
      providers[id] = {
        config: mergeStoredConfig(skeletonConfigOf(this.formModels[id]), store.providers[id]),
        hasApiKey: this.readSecretFile(id) !== undefined,
        providerKeyAvailable: await this.computeProviderKeyAvailable(id),
      }
    }
    return {
      activeProvider: isTtsProviderId(store.activeProvider) ? store.activeProvider : DEFAULT_ACTIVE_PROVIDER,
      providers,
    }
  }

  /**
   * 供应商 Key 联动检测信号（D4）：对映射 provider id 逐一 resolveProviderCredential，
   * 任一命中 { key } 即 true；{ unsupported } 判别形态与 undefined 均 false——resolve 通道
   * 一次判定同时覆盖存在性与形态排除，与 configure 带入通道同源（检测与带入所见一致）。
   * 明文只在本调用内判形态、不随 reply 外发。
   */
  private async computeProviderKeyAvailable(providerId: TtsProviderId): Promise<boolean> {
    for (const modelProviderId of TTS_PROVIDER_TO_MODEL_PROVIDER_IDS[providerId]) {
      const resolved = await this.credentialResolver.resolveProviderCredential(modelProviderId)
      if (resolved === undefined) continue
      if ('key' in resolved) return true
      return false // { unsupported }：条目存在但形态不可用（command / unresolved-env）
    }
    return false
  }

  /** tts.getCapabilities：三家表单投影（数据权威在 infra/tts 表单投影，本层纯转发）。 */
  getCapabilities(): Record<TtsProviderId, TtsFormModel> {
    const forms = {} as Record<TtsProviderId, TtsFormModel>
    for (const id of TTS_PROVIDER_IDS) forms[id] = this.formModels[id]
    return forms
  }

  // ── tts.configure：配置写路 + secret 写删 + Key 联动 ─────────────────────

  /**
   * 配置写路（三段式照 quota 范式：全部校验与计算 → persist → persist 成功后动 secrets，
   * 不落半改状态）。校验失败整条拒绝（invalid_payload error envelope，由调用方 handler
   * 捕获 TtsServiceError 上抛）；联动带入失败返回 ok:false + error 指引（reply 内联呈现）。
   */
  async configure(payload: TtsConfigurePayload): Promise<TtsConfigureResult> {
    const { providerId, config, apiKeys } = payload
    if (!isTtsProviderId(providerId)) {
      throw new TtsServiceError('invalid_payload', `unknown TTS provider id: ${String(providerId)}`)
    }
    const formModel = this.formModels[providerId]
    if (!isPlainObject(config)) {
      throw new TtsServiceError('invalid_payload', 'config must be an object')
    }
    // ── 第一段：全部校验与计算（零物理副作用）──
    const validated = this.validateTtsConfig(formModel, config)
    // Key 联动（D4）：from-provider 预解析（读明文只在本调用内，解析失败整条拒绝、不写 secrets）
    const resolvedKeys = new Map<TtsProviderId, string | null>()
    if (apiKeys) {
      for (const [keyProviderId, input] of Object.entries(apiKeys) as [TtsProviderId, TtsApiKeyInput][]) {
        if (!isTtsProviderId(keyProviderId)) {
          throw new TtsServiceError('invalid_payload', `unknown TTS provider id in apiKeys: ${String(keyProviderId)}`)
        }
        if (input === 'from-provider') {
          const resolved = await this.resolveFromProviderKey(keyProviderId)
          if ('error' in resolved) return { ok: false, error: resolved.error }
          resolvedKeys.set(keyProviderId, resolved.key)
          // baseUrl 联动仅 MiMo 家（D4）：该家 baseUrl 为空或仍为出厂默认值时，
          // 按「Key 实际命中」的 provider id 读集群地址写入（与带入严格同源）
          if (keyProviderId === 'mimo') this.applyMimoBaseUrlLinkage(validated, formModel, resolved.hitId)
        } else {
          resolvedKeys.set(keyProviderId, input === '' ? null : input)
        }
      }
    }

    // ── 第二段：persist（tts.json 唯一写入者 = configure，原子写；选中即同步写 activeProvider）──
    const { store } = this.readTtsStore()
    const nextStore: TtsStoreShape = {
      activeProvider: providerId,
      providers: { ...store.providers, [providerId]: validated },
    }
    try {
      this.writeTtsStore(nextStore)
    } catch (err) {
      return { ok: false, error: `failed to persist tts config: ${toErrorMessage(err)}` }
    }

    // ── 第三段：persist 成功后执行 secrets 物理写入/删除（失败不回滚 persist，quota 同款残余窗口）──
    for (const [keyProviderId, key] of resolvedKeys) {
      try {
        if (key === null) {
          this.removeSecretFile(keyProviderId)
        } else {
          this.ensureDirWithMode(this.secretsDir())
          this.writeSecretFile(keyProviderId, key)
        }
      } catch (err) {
        return { ok: false, error: `failed to write TTS api key secret: ${toErrorMessage(err)}` }
      }
    }

    return { ok: true, config: await this.getConfig() }
  }

  /** runtime 复核（设计 §7.4）：必填形状、speed 域内、发音词典条目格式（wire 数据未经信任，运行时判型）。 */
  private validateTtsConfig(formModel: TtsFormModel, config: TtsConfig): TtsConfig {
    const invalid = (message: string): TtsServiceError => new TtsServiceError('invalid_payload', message)
    if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') throw invalid('config.baseUrl required')
    if (typeof config.model !== 'string' || config.model.trim() === '') throw invalid('config.model required')
    if (typeof config.voice !== 'string' || config.voice.trim() === '') throw invalid('config.voice required')
    if (!isPlainObject(config.vendor)) throw invalid('config.vendor must be an object')
    if (config.speed !== undefined) {
      if (typeof config.speed !== 'number' || !Number.isFinite(config.speed)) {
        throw invalid('config.speed must be a finite number')
      }
      const range = formModel.capabilities.speedRange
      if (!range) throw invalid('speed is not supported by this provider')
      if (config.speed < range[0] || config.speed > range[1]) {
        throw invalid(`config.speed out of range [${range[0]}, ${range[1]}]`)
      }
    }
    if (config.instructions !== undefined && typeof config.instructions !== 'string') {
      throw invalid('config.instructions must be a string')
    }
    if (config.sampleRate !== undefined && (typeof config.sampleRate !== 'number' || !Number.isFinite(config.sampleRate))) {
      throw invalid('config.sampleRate must be a finite number')
    }
    this.validatePronunciationDict(config.vendor)
    const validated: TtsConfig = {
      baseUrl: config.baseUrl,
      model: config.model,
      voice: config.voice,
      vendor: config.vendor,
    }
    if (config.speed !== undefined) validated.speed = config.speed
    if (config.instructions !== undefined) validated.instructions = config.instructions
    if (config.sampleRate !== undefined) validated.sampleRate = config.sampleRate
    return validated
  }

  /**
   * 发音词典条目格式「原文/替换」（runtime 复核清单第三项）：vendor 子树内存在
   * pronunciation_dict.tone 数组时逐条校验——含 '/' 且两侧非空白（替换侧自身含 '/' 不限制）。
   */
  private validatePronunciationDict(vendor: Record<string, unknown>): void {
    const dict = vendor.pronunciation_dict
    if (dict === undefined) return
    if (!isPlainObject(dict)) throw new TtsServiceError('invalid_payload', 'vendor.pronunciation_dict must be an object')
    const tone = dict.tone
    if (tone === undefined) return
    if (!Array.isArray(tone)) throw new TtsServiceError('invalid_payload', 'vendor.pronunciation_dict.tone must be an array')
    for (const entry of tone) {
      if (typeof entry !== 'string') {
        throw new TtsServiceError('invalid_payload', 'pronunciation dict entries must be strings')
      }
      const slashIndex = entry.indexOf('/')
      if (
        slashIndex <= 0 ||
        slashIndex === entry.length - 1 ||
        entry.slice(0, slashIndex).trim() === '' ||
        entry.slice(slashIndex + 1).trim() === ''
      ) {
        throw new TtsServiceError('invalid_payload', `pronunciation dict entry must be "原文/替换": ${JSON.stringify(entry)}`)
      }
    }
  }

  /**
   * from-provider 明文解析：按映射表顺序逐 id resolve，首个 { key } 即用；
   * { unsupported } 判别形态 → error + 手动粘贴指引（不写入 secrets、不静默落空）；
   * 全源未命中 → error + 手动粘贴指引。
   */
  private async resolveFromProviderKey(
    providerId: TtsProviderId,
  ): Promise<{ key: string; hitId: string } | { error: string }> {
    const guidance = '该供应商凭据形态不支持自动带入，请手动粘贴 API Key'
    for (const modelProviderId of TTS_PROVIDER_TO_MODEL_PROVIDER_IDS[providerId]) {
      const resolved = await this.credentialResolver.resolveProviderCredential(modelProviderId)
      if (resolved === undefined) continue
      if ('key' in resolved) return { key: resolved.key, hitId: modelProviderId }
      return { error: guidance }
    }
    return { error: '未检测到供应商配置的 Key，请手动粘贴 API Key' }
  }

  /**
   * MiMo baseUrl 预填（D4，仅该家；MiniMax 不联动）：当前 baseUrl 为空或仍等于该家表单投影
   * baseUrlOptions 中 isDefault 项 url（「未手动改过」的判定代理）时，按 keyHitId（Key 带入
   * 实际命中的 provider id）经 resolveProviderBaseUrl 两级数据源（models.json 网关值 → 内置
   * catalog 兜底）读该 id 实际生效集群写入；undefined → 只带 Key、baseUrl 留当前值不写。
   * 手动改过的值任何家不覆盖。D3 验收实测缺陷修复：预填 id 必须与 Key 带入命中 id 同源——
   * 此前独立遍历映射表时首位 'xiaomi'（无集群绑定语义）经 catalog 恒返回默认集群并短路，
   * 实际凭据所属集群（token-plan-cn）永远轮不到。
   */
  private applyMimoBaseUrlLinkage(config: TtsConfig, formModel: TtsFormModel, keyHitId: string): void {
    const isDefaultUrl = formModel.baseUrlOptions.find((option) => option.isDefault)?.url
    const untouched = config.baseUrl === '' || (isDefaultUrl !== undefined && config.baseUrl === isDefaultUrl)
    if (!untouched) return
    const baseUrl = this.credentialResolver.resolveProviderBaseUrl(keyHitId)
    if (baseUrl !== undefined) config.baseUrl = baseUrl
  }

  // ── tts.json / secrets / cache 的 fs 读写（写入点归属见文件头注释）─────────

  private ttsConfigPath(): string {
    return join(this.dataDir, TTS_CONFIG_FILENAME)
  }

  private secretsDir(): string {
    return join(this.dataDir, 'secrets')
  }

  private secretPath(providerId: TtsProviderId): string {
    return join(this.secretsDir(), `${TTS_SECRET_PREFIX}${providerId}${TTS_SECRET_SUFFIX}`)
  }

  /** 读 tts.json：missing / parse 失败均回默认骨架（parse 失败由调用方记日志并按未配置处置）。 */
  private readTtsStore(): { store: TtsStoreShape; parseFailed: boolean } {
    const skeleton: TtsStoreShape = { activeProvider: DEFAULT_ACTIVE_PROVIDER, providers: {} }
    const path = this.ttsConfigPath()
    if (!existsSync(path)) return { store: skeleton, parseFailed: false }
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (!isPlainObject(parsed)) return { store: skeleton, parseFailed: true }
      const store: TtsStoreShape = {
        activeProvider: isTtsProviderId(parsed.activeProvider) ? parsed.activeProvider : DEFAULT_ACTIVE_PROVIDER,
        providers: {},
      }
      if (isPlainObject(parsed.providers)) {
        for (const id of TTS_PROVIDER_IDS) {
          if (parsed.providers[id] !== undefined) store.providers[id] = parsed.providers[id] as TtsConfig
        }
      }
      return { store, parseFailed: false }
    } catch {
      return { store: skeleton, parseFailed: true }
    }
  }

  /** tts.json 原子写（同目录临时文件 + rename，auth.json 先例——撕裂/半写 JSON 会使朗读与设置页双双失效）。 */
  private writeTtsStore(store: TtsStoreShape): void {
    mkdirSync(this.dataDir, { recursive: true })
    this.atomicWriteString(this.ttsConfigPath(), JSON.stringify(store, null, TTS_JSON_INDENT_SPACES))
  }

  /** 读 TTS 专属 secret：文件存在且内容 trim 非空才返回（缺文件/空内容 = 未配置 Key）。 */
  private readSecretFile(providerId: TtsProviderId): string | undefined {
    const path = this.secretPath(providerId)
    if (!existsSync(path)) return undefined
    try {
      const content = readFileSync(path, 'utf-8').trim()
      return content === '' ? undefined : content
    } catch {
      return undefined
    }
  }

  private writeSecretFile(providerId: TtsProviderId, key: string): void {
    const path = this.secretPath(providerId)
    writeFileSync(path, key, { encoding: 'utf-8', mode: SECRET_FILE_MODE })
    // chmod 后置：覆盖已存在文件时 mode 选项不生效（quota 范式）
    chmodSync(path, SECRET_FILE_MODE)
  }

  /** secret 删除（幂等：文件不存在视为成功；预检是 TOCTOU，直接 unlink 按 ENOENT 判定）。 */
  private removeSecretFile(providerId: TtsProviderId): void {
    try {
      unlinkSync(this.secretPath(providerId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }

  /** 0700 目录创建（quota ensureSecretsDir 范式：临时清零 umask 保证 mode 不被过滤）。 */
  private ensureDirWithMode(dir: string): void {
    if (existsSync(dir)) return
    const prevUmask = process.umask(0)
    try {
      mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE })
    } finally {
      process.umask(prevUmask)
    }
  }

  /** 文本原子写（tts.json 用）。 */
  private atomicWriteString(filePath: string, data: string): void {
    const tmpPath = `${filePath}.tmp_${process.pid}-${this.nextTmpSeq()}`
    try {
      writeFileSync(tmpPath, data, 'utf-8')
      renameSync(tmpPath, filePath)
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        void 0 /* 清理失败不掩盖原错误（fs-utils 同款语义） */
      }
      throw err
    }
  }

  /** 二进制原子写（WAV 缓存用；fs-utils atomicWrite 是 utf-8 字符串签名，Buffer 就地实现同语义）。 */
  private atomicWriteBinary(filePath: string, data: Buffer): void {
    const tmpPath = `${filePath}.tmp_${process.pid}-${this.nextTmpSeq()}`
    try {
      writeFileSync(tmpPath, data)
      renameSync(tmpPath, filePath)
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        void 0 /* 清理失败不掩盖原错误 */
      }
      throw err
    }
  }

  private nextTmpSeq(): number {
    this.tmpSeq = (this.tmpSeq + 1) % Number.MAX_SAFE_INTEGER
    return this.tmpSeq
  }
}
