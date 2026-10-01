/**
 * TtsService 单测（ai-voice-tts 任务书 u3：mock driver / mock resolver / tmpdir 真实文件系统）。
 *
 * 覆盖任务书六组 + configure 写路校验与 Key 联动 + message-handler 协议往返形状：
 * 1. 缓存键稳定性：改 instructions / sample_rate / baseUrl / passthrough 任一项键必变；同配置命中缓存
 * 2. FIFO 双条件封顶：文件数条件、字节条件、并发幂等（force rm 目标已删不抛）、单文件失败（EBUSY）跳过 speak 不失败
 * 3. 配置脱敏投影：reply 永无 Key 本体
 * 4. tts.json 原子写（无 tmp 残留）+ parse 失败降级（getConfig 回骨架 / speak 报 tts_not_configured）
 * 5. providerKeyAvailable 判定：{ key } true / { unsupported } false / undefined false / stepfun 恒 false
 * 6. 八步编排 happy path：mock driver 两段拼接，WAV 头采样率/声道取第一段回报值
 * 7. configure 校验（speed 域内/词典格式/不落半改）+ Key 联动（from-provider 带入/unsupported 指引/MiMo baseUrl 预填）
 * 8. handler 协议往返：payload/reply 键名与 §7.1 表逐字段一致 + invalid_payload 入口防御
 * 9. speak 请求端点跟随配置 baseUrl（真 driver + fetch 桩）：非默认 baseUrl 打到该地址 /
 *    缺 baseUrl 回退表单投影出厂默认 / 出厂默认回归锁定
 *
 * 失败注入手段：FS 上限经构造参数注入小值（默认取 shared SSOT）；封顶删除通道经
 * cacheRemove / remove 注入 stub——不 vi.mock node:fs（fs-guard 全局 mock 会被文件级
 * 重 mock 覆盖致防线失效，fs-guard.ts 边界注释明令禁止）。写删目标全部 mkdtempSync 自建自删。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/tts-service.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  InternalSpeechRequest,
  TtsCapabilities,
  TtsConfig,
  TtsFormModel,
  TtsProviderId,
} from '@taiji/shared'
import { MAX_SPEAK_CHARS, TTS_CACHE_MAX_BYTES, TTS_CACHE_MAX_FILES } from '@taiji/shared'
import { getTtsCacheDir } from '@taiji/shared/paths'
import type { ResolvedProviderCredential } from '../ports/provider-credential-resolver.js'
import type { IProviderCredentialResolver } from '../ports/provider-credential-resolver.js'
import type { TtsDriver, TtsSynthesisChunk } from '../ports/tts.js'
import { TtsService, TtsServiceError, type TtsConfigureResult } from '../tts-service.js'
import {
  canonicalSerialize,
  enforceTtsCacheFifoCap,
  splitIntoChunks,
  wrapWavHeader,
} from '../tts-audio.js'
import { TtsMessageHandler, type TtsHandlerContext } from '../../transport/tts-message-handler.js'
import { createTtsDriver, getTtsFormModels } from '../../infra/tts/index.js'
import type { ClientMessage } from '@taiji/shared'
import type { WebSocket as WsType } from 'ws'

vi.mock('../../infra/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
import { logger } from '../../infra/logger.js'

// ── fixture 工厂 ─────────────────────────────────────────────────────────

let dir: string

const DEFAULT_BASE_URL = 'https://default.example.com/v1'
const SECRET_VALUE = 'sk-secret-key-abc123'

function baseCapabilities(overrides: Partial<TtsCapabilities> = {}): TtsCapabilities {
  return {
    endpointPath: '/v1/audio/speech',
    authHeader: 'bearer',
    maxInputChars: 1000,
    speedRange: [0.5, 2],
    pcmSampleRates: [24000],
    supportsInstructions: true,
    perModel: {},
    ...overrides,
  }
}

function baseFormModel(capabilities: TtsCapabilities): TtsFormModel {
  return {
    capabilities,
    baseUrlOptions: [{ url: DEFAULT_BASE_URL, label: 'default', isDefault: true }],
    models: [{ id: 'm1', label: 'M1' }],
    voices: [{ id: 'v1', label: 'V1' }],
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
}

interface DriverCall {
  req: InternalSpeechRequest
  apiKey: string
}

/** mock driver：记录每次调用；chunks 序列按调用次序回放（耗尽后重复末段）。 */
function makeDriver(
  id: TtsProviderId,
  opts: { capabilities?: Partial<TtsCapabilities>; chunks?: TtsSynthesisChunk[] } = {},
): { driver: TtsDriver; calls: DriverCall[] } {
  const calls: DriverCall[] = []
  const capabilities = baseCapabilities(opts.capabilities)
  const driver: TtsDriver = {
    id,
    capabilities,
    formModel: baseFormModel(capabilities),
    async synthesizeChunk(req, apiKey) {
      calls.push({ req, apiKey })
      const chunks = opts.chunks
      if (!chunks || chunks.length === 0) return { pcm: Buffer.from([0, 0]), sampleRate: 24000, channels: 1 }
      return chunks[Math.min(calls.length - 1, chunks.length - 1)]
    },
  }
  return { driver, calls }
}

function makeResolver(
  outcomes: Record<string, ResolvedProviderCredential | undefined> = {},
  baseUrls: Record<string, string | undefined> = {},
): IProviderCredentialResolver {
  return {
    // 与生产语义对齐：凭据 outcomes 登记过的 id = 持凭据（D3 验收后守卫依赖此判定）
    hasProviderCredential: (id) => id in outcomes,
    listCredentialBackedProviderIds: () => new Set<string>(Object.keys(outcomes)),
    resolveProviderCredential: async (id) => outcomes[id],
    resolveProviderBaseUrl: (id) => baseUrls[id],
  }
}

interface ServiceDeps {
  stepfun: { driver: TtsDriver; calls: DriverCall[] }
  minimax: { driver: TtsDriver; calls: DriverCall[] }
  mimo: { driver: TtsDriver; calls: DriverCall[] }
  resolver: IProviderCredentialResolver
}

function makeServiceDeps(): ServiceDeps {
  return {
    stepfun: makeDriver('stepfun'),
    minimax: makeDriver('minimax'),
    mimo: makeDriver('mimo', { capabilities: { speedRange: null } }),
    resolver: makeResolver(),
  }
}

function makeService(deps: ServiceDeps): TtsService {
  return new TtsService({
    dataDir: dir,
    // driver 现建工厂：按 id 返回对应 mock driver（合成调用经 calls 观测）；表单投影取自
    // 同一 mock driver（capabilities 同源，与生产接线 getTtsFormModels + createTtsDriver 同构）
    createDriver: (id) => deps[id].driver,
    formModels: {
      stepfun: deps.stepfun.driver.formModel,
      minimax: deps.minimax.driver.formModel,
      mimo: deps.mimo.driver.formModel,
    },
    credentialResolver: deps.resolver,
  })
}

/** 直接落盘 tts.json（读写契约形状 = D4 store 形状）。 */
function writeTtsJson(providers: Partial<Record<TtsProviderId, TtsConfig>>, activeProvider: TtsProviderId = 'stepfun'): void {
  writeFileSync(join(dir, 'tts.json'), JSON.stringify({ activeProvider, providers }, null, 2))
}

function writeSecret(providerId: TtsProviderId, value: string = SECRET_VALUE): void {
  mkdirSync(join(dir, 'secrets'), { recursive: true })
  writeFileSync(join(dir, 'secrets', `tts-${providerId}-apikey.txt`), value)
}

function baseStepfunConfig(overrides: Partial<TtsConfig> = {}): TtsConfig {
  return {
    baseUrl: 'https://api.stepfun.example/v1',
    model: 'm1',
    voice: 'v1',
    vendor: {},
    ...overrides,
  }
}

function listWavFiles(): string[] {
  const cacheDir = getTtsCacheDir(dir)
  if (!existsSync(cacheDir)) return []
  return readdirSync(cacheDir).filter((name) => name.endsWith('.wav'))
}

/** 封顶后的缓存内容断言（新文件 + 指定残留文件名全集，恰等）。 */
function expectCacheContents(newFilePath: string, ...keptNames: string[]): void {
  const remaining = listWavFiles().sort()
  expect(remaining).toHaveLength(keptNames.length + 1)
  expect(remaining).toContain(basename(newFilePath))
  for (const name of keptNames) expect(remaining).toContain(name)
}

/** 读回落盘 tts.json 的 providers 表（配置写路用例共用）。 */
function readStoredProviders(): Partial<Record<TtsProviderId, TtsConfig>> {
  return (JSON.parse(readFileSync(join(dir, 'tts.json'), 'utf-8')) as { providers: Partial<Record<TtsProviderId, TtsConfig>> }).providers
}

/** minimax from-provider 带入（联动指引类用例共用载荷）。 */
function configureMinimaxFromProvider(svc: TtsService): Promise<TtsConfigureResult> {
  return svc.configure({ providerId: 'minimax', config: baseStepfunConfig(), apiKeys: { minimax: 'from-provider' } })
}

/** mimo from-provider 带入（baseUrl 联动类用例共用载荷；overrides 透传 baseStepfunConfig）。 */
async function configureMimoFromProvider(svc: TtsService, overrides: Partial<TtsConfig> = {}): Promise<TtsConfigureResult> {
  return svc.configure({ providerId: 'mimo', config: baseStepfunConfig(overrides), apiKeys: { mimo: 'from-provider' } })
}

/** 老缓存文件制造（可指定字节大小与 mtime 先后）。 */
function seedCacheFile(name: string, sizeBytes: number, mtime: Date): string {
  const cacheDir = getTtsCacheDir(dir)
  mkdirSync(cacheDir, { recursive: true })
  const filePath = join(cacheDir, name)
  writeFileSync(filePath, Buffer.alloc(sizeBytes))
  utimesSync(filePath, mtime, mtime)
  return filePath
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tts-service-'))
  vi.mocked(logger.warn).mockClear()
  vi.mocked(logger.info).mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 1. 缓存键稳定性 ──────────────────────────────────────────────────────

describe('缓存键稳定性（D5）', () => {
  async function speakWith(config: TtsConfig): Promise<{ filePath: string; calls: DriverCall[] }> {
    const deps = makeServiceDeps()
    writeTtsJson({ stepfun: config })
    writeSecret('stepfun')
    const svc = makeService(deps)
    const result = await svc.speak('你好世界。再见！')
    return { filePath: result.filePath, calls: deps.stepfun.calls }
  }

  it('同配置两次 speak 命中缓存：同路径且 driver 只调一次', async () => {
    const deps = makeServiceDeps()
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const svc = makeService(deps)
    const first = await svc.speak('你好世界。再见！')
    expect(deps.stepfun.calls).toHaveLength(1)
    const second = await svc.speak('你好世界。再见！')
    expect(second.filePath).toBe(first.filePath)
    expect(deps.stepfun.calls).toHaveLength(1) // 缓存命中跳过厂商请求
    expect(existsSync(second.filePath)).toBe(true)
  })

  it('改 instructions / sampleRate / baseUrl / vendor（passthrough）任一项键必变', async () => {
    const base = await speakWith(baseStepfunConfig())
    const withInstructions = await speakWith(baseStepfunConfig({ instructions: '温柔' }))
    const withSampleRate = await speakWith(baseStepfunConfig({ sampleRate: 32000 }))
    const withBaseUrl = await speakWith(baseStepfunConfig({ baseUrl: 'https://other.example.com/v1' }))
    const withVendor = await speakWith(baseStepfunConfig({ vendor: { voice_label: { emotion: '温柔' } } }))

    const paths = [base.filePath, withInstructions.filePath, withSampleRate.filePath, withBaseUrl.filePath, withVendor.filePath]
    expect(new Set(paths).size).toBe(paths.length)
  })
})

// ── 2. FIFO 双条件封顶 ───────────────────────────────────────────────────

describe('缓存双条件 FIFO 封顶（§7.4 步骤 7）', () => {
  const OLD = new Date('2026-01-01T00:00:00Z')
  const OLDER = new Date('2025-01-01T00:00:00Z')

  function makeCapService(overrides: { maxFiles?: number; maxBytes?: number; cacheRemove?: (p: string) => void }): TtsService {
    const deps = makeServiceDeps()
    return new TtsService({
      dataDir: dir,
      createDriver: (id) => deps[id].driver,
      formModels: {
        stepfun: deps.stepfun.driver.formModel,
        minimax: deps.minimax.driver.formModel,
        mimo: deps.mimo.driver.formModel,
      },
      credentialResolver: deps.resolver,
      cacheMaxFiles: overrides.maxFiles ?? TTS_CACHE_MAX_FILES,
      cacheMaxBytes: overrides.maxBytes ?? TTS_CACHE_MAX_BYTES,
      cacheRemove: overrides.cacheRemove,
    })
  }

  async function prepareAndSpeak(svc: TtsService): Promise<string> {
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const result = await svc.speak('你好世界。再见！')
    return result.filePath
  }

  it('字节条件：总字节超限时删最旧至满足（新文件保留）', async () => {
    seedCacheFile('old-a.wav', 600, OLDER)
    seedCacheFile('old-b.wav', 600, OLD)
    // 上限 1000：写新文件后总量 1246 > 1000 → 删最旧 old-a → 646 ≤ 1000 停
    const newFilePath = await prepareAndSpeak(makeCapService({ maxBytes: 1000 }))
    expectCacheContents(newFilePath, 'old-b.wav')
  })

  it('文件数条件：超限删最旧至满足', async () => {
    seedCacheFile('a.wav', 10, OLDER)
    seedCacheFile('b.wav', 10, OLD)
    seedCacheFile('c.wav', 10, new Date('2026-02-01T00:00:00Z'))
    // 上限 2：写新文件后 4 个 → 删最旧 a、b → 剩 c + 新文件
    const newFilePath = await prepareAndSpeak(makeCapService({ maxFiles: 2 }))
    expectCacheContents(newFilePath, 'c.wav')
  })

  it('并发幂等：目标已被删除时 force rm 不抛、封顶照常收敛', () => {
    seedCacheFile('a.wav', 10, OLDER)
    seedCacheFile('b.wav', 10, OLD)
    seedCacheFile('c.wav', 10, new Date('2026-02-01T00:00:00Z'))
    // remove 注入：真实 rmSync 连调两次——第二次命中已被「对方窗口」删除的目标，
    // force:true 语义下不抛（本实现的默认删除通道即 rmSync force，此处锁该契约）
    expect(() =>
      enforceTtsCacheFifoCap(getTtsCacheDir(dir), {
        maxFiles: 1,
        maxBytes: TTS_CACHE_MAX_BYTES,
        remove: (p) => {
          rmSync(p, { force: true })
          rmSync(p, { force: true })
        },
      }),
    ).not.toThrow()
    expect(listWavFiles()).toEqual(['c.wav'])
  })

  it('单文件删除失败（EBUSY 形态）：记 warn 跳过、speak 不失败、其余照删', async () => {
    const victim = seedCacheFile('victim.wav', 10, OLDER)
    seedCacheFile('healthy.wav', 10, OLD)
    const svc = makeCapService({
      maxFiles: 2,
      cacheRemove: (p) => {
        if (p === victim) {
          const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException
          err.code = 'EBUSY'
          throw err
        }
        rmSync(p, { force: true })
      },
    })
    const newFilePath = await prepareAndSpeak(svc) // 不抛 = speak 不失败
    expect(existsSync(newFilePath)).toBe(true)
    expect(existsSync(victim)).toBe(true) // 删不掉的留待下次封顶重试
    expect(listWavFiles()).toHaveLength(2) // healthy 被删、新文件 + victim
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[tts] cache cap: failed to remove cached file, skipped',
      expect.objectContaining({ filePath: victim }),
    )
  })
})

// ── 3. 配置脱敏投影 ──────────────────────────────────────────────────────

describe('getConfig 脱敏投影（永不回 Key 本体）', () => {
  it('hasApiKey 反映 secrets 状态；投影串不含 Key 本体', async () => {
    const deps = makeServiceDeps()
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const svc = makeService(deps)

    const withKey = await svc.getConfig()
    expect(withKey.providers.stepfun.hasApiKey).toBe(true)
    expect(withKey.providers.minimax.hasApiKey).toBe(false)
    // 全量序列化后搜不到 Key 本体（脱敏投影的结构性证明）
    expect(JSON.stringify(withKey)).not.toContain(SECRET_VALUE)

    // 清除 Key 后投影跟随
    rmSync(join(dir, 'secrets', 'tts-stepfun-apikey.txt'))
    const withoutKey = await svc.getConfig()
    expect(withoutKey.providers.stepfun.hasApiKey).toBe(false)
  })
})

describe('getCapabilities 表单投影（三家键，本层纯转发）', () => {
  it('返回三家键的全集投影，数据源 = 构造注入的 formModels（本层零加工）', () => {
    const deps = makeServiceDeps()
    const svc = makeService(deps)
    const forms = svc.getCapabilities()
    expect(Object.keys(forms).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
    // 投影与注入源同对象引用（纯转发语义，与生产接线 getTtsFormModels 同构）
    expect(forms.stepfun).toBe(deps.stepfun.driver.formModel)
    expect(forms.minimax).toBe(deps.minimax.driver.formModel)
    expect(forms.mimo).toBe(deps.mimo.driver.formModel)
  })
})

// ── 4. tts.json 原子写 + parse 失败降级 ──────────────────────────────────────

describe('tts.json 原子写与 parse 失败降级', () => {
  it('configure 原子写：落盘可解析且无 tmp 残留', async () => {
    const deps = makeServiceDeps()
    const svc = makeService(deps)
    const result = await svc.configure({ providerId: 'stepfun', config: baseStepfunConfig() })
    expect(result.ok).toBe(true)
    const store = JSON.parse(readFileSync(join(dir, 'tts.json'), 'utf-8')) as { activeProvider: string; providers: Record<string, unknown> }
    expect(store.activeProvider).toBe('stepfun')
    expect(store.providers.stepfun).toEqual(baseStepfunConfig())
    const residue = readdirSync(dir).filter((name) => name.includes('.tmp_'))
    expect(residue).toEqual([])
  })

  it('parse 失败：getConfig 回默认骨架配置（无异常）', async () => {
    writeFileSync(join(dir, 'tts.json'), '{ not json')
    const deps = makeServiceDeps()
    const svc = makeService(deps)
    const config = await svc.getConfig()
    expect(config.providers.stepfun.config.baseUrl).toBe(DEFAULT_BASE_URL) // 骨架值来自表单投影 isDefault
    expect(config.providers.stepfun.config.vendor).toEqual({})
  })

  it('parse 失败：speak 按 tts_not_configured 处置并记 parse 日志', async () => {
    writeFileSync(join(dir, 'tts.json'), '{ not json')
    writeSecret('stepfun')
    const deps = makeServiceDeps()
    const svc = makeService(deps)
    await expect(svc.speak('文本')).rejects.toMatchObject({ code: 'tts_not_configured' })
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('[tts] tts.json parse failed, treating as not configured')
  })
})

// ── 5. providerKeyAvailable 判定 ─────────────────────────────────────────

describe('providerKeyAvailable 判定（D4 联动检测通道）', () => {
  it('{ key } 命中即 true（含映射表非首个 id 命中）；{ unsupported } 与 undefined 均 false', async () => {
    writeTtsJson({})
    const deps = makeServiceDeps()
    deps.resolver = makeResolver({
      // minimax 首映射 id 缺席、次映射 id（minimax-cn）命中
      'minimax-cn': { key: 'sk-mm', source: 'auth.json' },
      // mimo 首映射 id 命中 unsupported 形态
      xiaomi: { unsupported: 'command' },
    })
    const svc = makeService(deps)
    const config = await svc.getConfig()
    expect(config.providers.minimax.providerKeyAvailable).toBe(true)
    expect(config.providers.mimo.providerKeyAvailable).toBe(false) // unsupported 形态 false
    expect(config.providers.stepfun.providerKeyAvailable).toBe(false) // 不参与联动恒 false
  })

  it('全部映射 id 未命中 → false', async () => {
    writeTtsJson({})
    const svc = makeService(makeServiceDeps())
    const config = await svc.getConfig()
    expect(config.providers.minimax.providerKeyAvailable).toBe(false)
    expect(config.providers.mimo.providerKeyAvailable).toBe(false)
  })
})

// ── 6. 八步编排 happy path ───────────────────────────────────────────────

describe('speak 八步编排 happy path（两段拼接，WAV 头取第一段回报）', () => {
  it('分句两段顺序合成、PCM 拼接、WAV 头采样率/声道取第一段、落盘可读', async () => {
    const deps = makeServiceDeps()
    deps.stepfun = makeDriver('stepfun', {
      capabilities: { maxInputChars: 6 },
      chunks: [
        { pcm: Buffer.from([1, 2, 3, 4]), sampleRate: 24000, channels: 1 },
        { pcm: Buffer.from([5, 6]), sampleRate: 48000, channels: 2 }, // 多段不一致：以第一段为准
      ],
    })
    writeTtsJson({ stepfun: baseStepfunConfig({ vendor: { voice_label: { emotion: '温柔' } } }) })
    writeSecret('stepfun')
    const svc = makeService(deps)

    // 清洗规则集（D7）含链接保文本：清洗后「你好世界。再见！」（8 字 > maxInputChars 6 → 句边界两段）
    const result = await svc.speak('[你好世界](https://example.com/x)。再见！', 'sess-1')

    // ④ 分句：句边界两段（清洗后「你好世界。再见！」）
    expect(deps.stepfun.calls).toHaveLength(2)
    expect(deps.stepfun.calls[0].req.input).toBe('你好世界。')
    expect(deps.stepfun.calls[1].req.input).toBe('再见！')
    // ③ 组装：标准位字段取顶层 + vendor 恒等搬运 + apiKey 透传
    expect(deps.stepfun.calls[0].req).toMatchObject({
      model: 'm1',
      voice: 'v1',
      response_format: 'pcm',
      passthrough: { voice_label: { emotion: '温柔' } },
    })
    expect(deps.stepfun.calls[0].apiKey).toBe(SECRET_VALUE)
    // ⑥⑦ WAV 头：采样率/声道取第一段回报；data 长度 = 两段 PCM 之和（4+2）
    const wav = readFileSync(result.filePath)
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(40)).toBe(6)
    expect(wav.readUInt32LE(4)).toBe(36 + 6)
    // ⑧ reply 只回 filePath
    expect(Object.keys(result)).toEqual(['filePath'])
  })

  it('清洗后为空 → tts_empty_text；超上限 → tts_text_too_long', async () => {
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const svc = makeService(makeServiceDeps())
    await expect(svc.speak('```js\ncode()\n```')).rejects.toMatchObject({ code: 'tts_empty_text' })
    await expect(svc.speak('a'.repeat(MAX_SPEAK_CHARS + 1))).rejects.toMatchObject({ code: 'tts_text_too_long' })
  })

  it('未配置（无 tts.json / 无 Key）→ tts_not_configured', async () => {
    const svc = makeService(makeServiceDeps())
    await expect(svc.speak('文本')).rejects.toMatchObject({ code: 'tts_not_configured' })
    writeTtsJson({ stepfun: baseStepfunConfig() })
    await expect(svc.speak('文本')).rejects.toMatchObject({ code: 'tts_not_configured' })
  })

  it('driver 统一错误形态归一为同码 TtsServiceError（snippet 进消息）', async () => {
    const deps = makeServiceDeps()
    deps.stepfun.driver.synthesizeChunk = async () => {
      throw { code: 'tts_auth_failed', snippet: 'HTTP 401 invalid key' }
    }
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const svc = makeService(deps)
    const err = await svc.speak('文本').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TtsServiceError)
    expect((err as TtsServiceError).code).toBe('tts_auth_failed')
    expect((err as TtsServiceError).message).toContain('HTTP 401 invalid key')
  })
})

// ── 纯函数单测：分句 / WAV 头 / canonical 序列化 ─────────────────────────

describe('splitIntoChunks / wrapWavHeader / canonicalSerialize', () => {
  it('分句：不超限整段单发；超限句边界贪心打包，超长句硬切', () => {
    expect(splitIntoChunks('你好世界。再见！', 10)).toEqual(['你好世界。再见！']) // 未超限不多切
    expect(splitIntoChunks('你好世界。再见！', 6)).toEqual(['你好世界。', '再见！'])
    // 硬切片段 'aa。'（3 字）+ 'bb'（2 字）= 5 > 4 → 不合包；末尾 'bb' 为独立段
    expect(splitIntoChunks('aaaaaaaaaa。bb', 4)).toEqual(['aaaa', 'aaaa', 'aa。', 'bb'])
    expect(splitIntoChunks('', 10)).toEqual([])
  })

  it('WAV 头：44 字节、PCM 格式、blockAlign/byteRate 与声道一致', () => {
    const wav = wrapWavHeader(Buffer.from([1, 2, 3, 4]), 32000, 2)
    expect(wav).toHaveLength(48)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.readUInt32LE(24)).toBe(32000)
    expect(wav.readUInt32LE(28)).toBe(32000 * 2 * 2)
    expect(wav.readUInt16LE(32)).toBe(4)
    expect(wav.toString('ascii', 36, 40)).toBe('data')
  })

  it('canonical 序列化：键序无关、undefined 字段剔除', () => {
    expect(canonicalSerialize({ b: 1, a: 2 })).toBe(canonicalSerialize({ a: 2, b: 1 }))
    expect(canonicalSerialize({ a: 1, b: undefined })).toBe(canonicalSerialize({ a: 1 }))
    expect(canonicalSerialize({ z: { y: 1, x: [2, 1] } })).toBe('{"z":{"x":[2,1],"y":1}}')
  })
})

// ── 7. configure 写路校验 + Key 联动 ─────────────────────────────────────

describe('configure 写路校验（整条拒绝，不落半改状态）', () => {
  it('speed 超域 / 该家不支持 speed / 词典条目缺「原文/替换」→ invalid_payload 且 tts.json 不落盘', async () => {
    const deps = makeServiceDeps()
    const svc = makeService(deps)
    await expect(
      svc.configure({ providerId: 'stepfun', config: baseStepfunConfig({ speed: 9 }) }),
    ).rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(
      svc.configure({ providerId: 'mimo', config: { ...baseStepfunConfig(), speed: 1 } }),
    ).rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(
      svc.configure({
        providerId: 'minimax',
        config: { ...baseStepfunConfig(), vendor: { pronunciation_dict: { tone: ['没有斜杠'] } } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_payload' })
    expect(existsSync(join(dir, 'tts.json'))).toBe(false)
  })

  it('词典合法条目通过；speed 域内通过', async () => {
    const deps = makeServiceDeps()
    const svc = makeService(deps)
    const result = await svc.configure({
      providerId: 'minimax',
      config: {
        ...baseStepfunConfig({ speed: 1.5 }),
        vendor: { pronunciation_dict: { tone: ['处理/(chu3)(li3)'] } },
      },
    })
    expect(result.ok).toBe(true)
  })
})

describe('configure Key 联动（D4）', () => {
  it("apiKeys 'from-provider'：经 resolver 读明文写 secrets", async () => {
    const deps = makeServiceDeps()
    deps.resolver = makeResolver({ minimax: { key: 'sk-provider-1', source: 'auth.json' } })
    const svc = makeService(deps)
    const result = await svc.configure({
      providerId: 'minimax',
      config: baseStepfunConfig(),
      apiKeys: { minimax: 'from-provider' },
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, 'secrets', 'tts-minimax-apikey.txt'), 'utf-8')).toBe('sk-provider-1')
    expect(result.config?.providers.minimax.hasApiKey).toBe(true)
  })

  it("resolver 命中 unsupported 形态：ok:false + 手动粘贴指引，不写 secrets 不落 tts.json", async () => {
    const deps = makeServiceDeps()
    deps.resolver = makeResolver({ minimax: { unsupported: 'unresolved-env' } })
    const svc = makeService(deps)
    const result = await configureMinimaxFromProvider(svc)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('手动粘贴')
    expect(existsSync(join(dir, 'secrets', 'tts-minimax-apikey.txt'))).toBe(false)
    expect(existsSync(join(dir, 'tts.json'))).toBe(false)
  })

  it('全源未命中：ok:false + 手动粘贴指引', async () => {
    const svc = makeService(makeServiceDeps())
    const result = await configureMinimaxFromProvider(svc)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('手动粘贴')
  })

  it('MiMo baseUrl 联动：出厂默认值时经 resolveProviderBaseUrl 预填实际生效集群；手动改过不覆盖', async () => {
    const deps = makeServiceDeps()
    // 凭据在 xiaomi-token-plan-cn（生产形态）→ 带入命中该 id → 预填其集群地址
    deps.resolver = makeResolver(
      { 'xiaomi-token-plan-cn': { key: 'sk-1', source: 'auth.json' } },
      { 'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1' },
    )
    const svc = makeService(deps)
    // baseUrl == isDefault 出厂默认 → 联动写入
    await configureMimoFromProvider(svc, { baseUrl: DEFAULT_BASE_URL })
    expect(readStoredProviders().mimo?.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/v1')

    // 手动改过的值不覆盖
    await configureMimoFromProvider(svc, { baseUrl: 'https://my-own.example.com/v1' })
    expect(readStoredProviders().mimo?.baseUrl).toBe('https://my-own.example.com/v1')
  })

  it('MiMo baseUrl 联动跟随 Key 带入命中 id（D3 验收缺陷回归：独立遍历映射表时首位无凭据 id 经 catalog 短路成默认集群）', async () => {
    const deps = makeServiceDeps()
    // 真实 catalog 形态复现：xiaomi（无集群绑定语义）恒有默认集群 catalog 值，凭据实际在
    // xiaomi-token-plan-cn 下——带入与预填必须命中同一 id，选 token plan 集群
    deps.resolver = makeResolver(
      { 'xiaomi-token-plan-cn': { key: 'sk-plan', source: 'auth.json' } },
      {
        xiaomi: 'https://api.xiaomimimo.com/v1',
        'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1',
      },
    )
    const svc = makeService(deps)
    await configureMimoFromProvider(svc, { baseUrl: DEFAULT_BASE_URL })
    expect(readStoredProviders().mimo?.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/v1')
  })

  it('MiniMax 不联动 baseUrl（默认值保留）', async () => {
    const deps = makeServiceDeps()
    deps.resolver = makeResolver(
      { minimax: { key: 'sk-1', source: 'auth.json' } },
      { minimax: 'https://api.minimax.io/anthropic' },
    )
    const svc = makeService(deps)
    await svc.configure({
      providerId: 'minimax',
      config: baseStepfunConfig({ baseUrl: DEFAULT_BASE_URL }),
      apiKeys: { minimax: 'from-provider' },
    })
    const store = JSON.parse(readFileSync(join(dir, 'tts.json'), 'utf-8')) as { providers: Record<string, TtsConfig> }
    expect(store.providers.minimax.baseUrl).toBe(DEFAULT_BASE_URL)
  })

  it("apiKeys null / 空串清除 secret；字符串写入", async () => {
    const deps = makeServiceDeps()
    const svc = makeService(deps)
    writeSecret('stepfun')
    await svc.configure({ providerId: 'stepfun', config: baseStepfunConfig(), apiKeys: { stepfun: null } })
    expect(existsSync(join(dir, 'secrets', 'tts-stepfun-apikey.txt'))).toBe(false)
    await svc.configure({ providerId: 'stepfun', config: baseStepfunConfig(), apiKeys: { stepfun: 'sk-new' } })
    expect(readFileSync(join(dir, 'secrets', 'tts-stepfun-apikey.txt'), 'utf-8')).toBe('sk-new')
  })
})

// ── 8. message-handler 协议往返形状（§7.1 逐字段）────────────────────────

describe('TtsMessageHandler.handles（路由认领清单）', () => {
  it('认领 tts 四 RPC（且仅这四个类型）', () => {
    const ctx = { send: vi.fn(), sendError: vi.fn(), reply: vi.fn(), ttsService: makeService(makeServiceDeps()) } as unknown as TtsHandlerContext
    const handler = new TtsMessageHandler(ctx)
    expect(handler.handles).toEqual(['tts.getConfig', 'tts.configure', 'tts.speak', 'tts.getCapabilities'])
  })
})

describe('TtsMessageHandler 协议往返（payload/reply 键名与 §7.1 表一致）', () => {
  let deps: ServiceDeps
  let reply: ReturnType<typeof vi.fn>
  let sendError: ReturnType<typeof vi.fn>
  let handler: TtsMessageHandler
  const ws = {} as WsType

  beforeEach(() => {
    deps = makeServiceDeps()
    reply = vi.fn()
    sendError = vi.fn()
    const ctx = { send: vi.fn(), sendError, reply, ttsService: makeService(deps) } as unknown as TtsHandlerContext
    handler = new TtsMessageHandler(ctx)
  })

  it('tts.getConfig → reply { config }（SanitizedTtsConfig 形状）', async () => {
    const msg = { type: 'tts.getConfig', id: 'r1', payload: {} } as ClientMessage
    await handler.handleTtsMessage(msg, ws)
    expect(reply).toHaveBeenCalledTimes(1)
    const [, id, type, payload] = reply.mock.calls[0] as [WsType, string, string, Record<string, unknown>]
    expect(id).toBe('r1')
    expect(type).toBe('tts.getConfig:result')
    expect(Object.keys(payload)).toEqual(['config'])
    const config = payload.config as { activeProvider: string; providers: Record<string, unknown> }
    expect(Object.keys(config.providers).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
    expect(Object.keys(config.providers.stepfun as Record<string, unknown>).sort()).toEqual([
      'config',
      'hasApiKey',
      'providerKeyAvailable',
    ])
  })

  it('tts.configure → reply { config?, ok, error? }；成功含 config 无 error', async () => {
    const msg = {
      type: 'tts.configure',
      id: 'r2',
      payload: { providerId: 'stepfun', config: baseStepfunConfig() },
    } as ClientMessage
    await handler.handleTtsMessage(msg, ws)
    const [, , type, payload] = reply.mock.calls[0] as [WsType, string, string, Record<string, unknown>]
    expect(type).toBe('tts.configure:result')
    expect(payload.ok).toBe(true)
    expect(payload.config).toBeDefined()
    expect(payload.error).toBeUndefined()
  })

  it('tts.speak → reply { filePath }；缺 text → invalid_payload 信封', async () => {
    writeTtsJson({ stepfun: baseStepfunConfig() })
    writeSecret('stepfun')
    const msg = { type: 'tts.speak', id: 'r3', payload: { text: '你好世界。再见！' } } as ClientMessage
    await handler.handleTtsMessage(msg, ws)
    const [, , type, payload] = reply.mock.calls[0] as [WsType, string, string, Record<string, unknown>]
    expect(type).toBe('tts.speak:result')
    expect(Object.keys(payload)).toEqual(['filePath'])

    const bad = { type: 'tts.speak', id: 'r4', payload: {} } as unknown as ClientMessage
    await handler.handleTtsMessage(bad, ws)
    expect(sendError).toHaveBeenCalledWith(ws, 'invalid_payload', 'text required', 'r4')
  })

  it('tts.getCapabilities → reply { forms }（三家键）', async () => {
    const msg = { type: 'tts.getCapabilities', id: 'r5', payload: {} } as ClientMessage
    await handler.handleTtsMessage(msg, ws)
    const [, , type, payload] = reply.mock.calls[0] as [WsType, string, string, Record<string, unknown>]
    expect(type).toBe('tts.getCapabilities:result')
    expect(Object.keys(payload)).toEqual(['forms'])
    expect(Object.keys(payload.forms as Record<string, unknown>).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
  })

  it('tts.configure 非法 providerId / config → invalid_payload 信封', async () => {
    const badId = {
      type: 'tts.configure',
      id: 'r6',
      payload: { providerId: 'nope', config: baseStepfunConfig() },
    } as unknown as ClientMessage
    await handler.handleTtsMessage(badId, ws)
    expect(sendError).toHaveBeenCalledWith(ws, 'invalid_payload', expect.stringContaining('providerId'), 'r6')

    const badConfig = {
      type: 'tts.configure',
      id: 'r7',
      payload: { providerId: 'stepfun', config: 'nope' },
    } as unknown as ClientMessage
    await handler.handleTtsMessage(badConfig, ws)
    expect(sendError).toHaveBeenCalledWith(ws, 'invalid_payload', expect.stringContaining('config'), 'r7')
  })

  it('领域失败（未配置）→ TtsServiceError 携 §7.1 码上抛（由 server 顶层透传 envelope）', async () => {
    const msg = { type: 'tts.speak', id: 'r8', payload: { text: '文本' } } as ClientMessage
    await expect(handler.handleTtsMessage(msg, ws)).rejects.toMatchObject({ code: 'tts_not_configured' })
    expect(reply).not.toHaveBeenCalled()
  })
})

// ── 9. speak 请求端点跟随配置 baseUrl（构造期固化缝隙修复）────────────────

describe('speak 请求端点跟随配置 baseUrl（真 driver + fetch 桩）', () => {
  const PCM = Buffer.from([1, 2, 3, 4])

  /** fetch 桩：返回最小 2xx 音频响应（stepfun 2xx = 裸 PCM 二进制）；不触真实网络。 */
  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => PCM.buffer.slice(PCM.byteOffset, PCM.byteOffset + PCM.byteLength),
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  /** 生产同构接线：真 driver 工厂 + 真三家表单投影（infra/tts 唯一装配出口）。 */
  function makeRealDriverService(): TtsService {
    return new TtsService({
      dataDir: dir,
      createDriver: createTtsDriver,
      formModels: getTtsFormModels(),
      credentialResolver: makeResolver(),
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tts.json 配非默认 baseUrl：厂商请求打到该地址（fetch 层断言 URL 前缀与端点）', async () => {
    const altBase = 'https://token-plan-cn.xiaomimimo.com/v1'
    const fetchMock = stubFetch()
    writeTtsJson({ stepfun: baseStepfunConfig({ baseUrl: altBase }) })
    writeSecret('stepfun')
    await makeRealDriverService().speak('文本')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url.startsWith(altBase)).toBe(true)
    expect(url).toBe(`${altBase}/audio/speech`)
  })

  it('tts.json 缺 baseUrl 字段：回退表单投影出厂默认（与 skeleton 行为一致）', async () => {
    const fetchMock = stubFetch()
    writeFileSync(
      join(dir, 'tts.json'),
      JSON.stringify({ activeProvider: 'stepfun', providers: { stepfun: { model: 'm1', voice: 'v1', vendor: {} } } }),
    )
    writeSecret('stepfun')
    await makeRealDriverService().speak('文本')
    const defaultUrl =
      getTtsFormModels().stepfun.baseUrlOptions.find((option) => option.isDefault)?.url ?? ''
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toBe(`${defaultUrl}/audio/speech`)
  })

  it('配置为出厂默认 baseUrl：端点与默认行为一致（回归锁定）', async () => {
    const defaultUrl =
      getTtsFormModels().stepfun.baseUrlOptions.find((option) => option.isDefault)?.url ?? ''
    const fetchMock = stubFetch()
    writeTtsJson({ stepfun: baseStepfunConfig({ baseUrl: defaultUrl }) })
    writeSecret('stepfun')
    await makeRealDriverService().speak('文本')
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toBe(`${defaultUrl}/audio/speech`)
  })
})
