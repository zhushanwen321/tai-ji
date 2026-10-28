import { logger } from '../logger.js';
import { stubFetch, stubFetchFailure, type CapturedRequest } from './__tests__/driver-fetch-stub.js';
import { TTS_ERROR_SNIPPET_MAX, TTS_REQUEST_TIMEOUT_MS, TtsDriverFailure, buildAuthHeaders, decodeBase64ToPcm, decodeHexToPcm, joinEndpoint, parseVendorJson, postTtsRequest, snapToNearestSampleRate, toErrorSnippet } from './base.js';
import { createTtsDriver, getTtsFormModels } from './index.js';
import { MIMO_PCM_SAMPLE_RATE, buildMimoRequestBody, createMimoDriver, decodeMimoResponse, mimoCapabilities, mimoFormModel } from './mimo.js';
import { buildMinimaxRequestBody, createMinimaxDriver, decodeMinimaxResponse, minimaxCapabilities, minimaxFormModel } from './minimax.js';
import { AUTH_RESERVED_PASSTHROUGH_KEYS, deepMergeLeaves, mergeRequestBody, sanitizePassthrough } from './passthrough-merge.js';
import { buildStepfunRequestBody, createStepfunDriver, stepfunCapabilities, stepfunFormModel } from './stepfun.js';
import type { InternalSpeechRequest } from '@taiji/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← mimo.test.ts
// ======================================================================

const BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'

const API_KEY = 'test-key-mimo'


function baseReq(overrides: Partial<InternalSpeechRequest> = {}): InternalSpeechRequest {
  return { model: 'mimo-v2.5-tts', input: '你好太极', voice: 'mimo_default', ...overrides }
}


function successPayload(base64: string): unknown {
  return { choices: [{ message: { audio: { data: base64 } } }] }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mimo', () => {
afterEach(() => {
  vi.unstubAllGlobals()
})
describe('请求组装（§7.2 借壳列）', () => {
  it('端点 {baseUrl}/chat/completions + api-key 头（不是 Bearer）', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify(successPayload('AA=='))))
    const driver = createMimoDriver({ baseUrl: BASE_URL })
    await driver.synthesizeChunk(baseReq(), API_KEY)
    expect(calls[0].url).toBe(`${BASE_URL}/chat/completions`)
    expect(calls[0].headers['api-key']).toBe(API_KEY)
    expect(calls[0].headers['authorization']).toBeUndefined()
  })

  it('input → messages[assistant]；audio 段固定 voice + pcm16', () => {
    const body = buildMimoRequestBody(baseReq())
    expect(body['messages']).toEqual([{ role: 'assistant', content: '你好太极' }])
    expect(body['audio']).toEqual({ voice: 'mimo_default', format: 'pcm16' })
    expect(body['model']).toBe('mimo-v2.5-tts')
  })

  it('instructions → messages[user]（在正文之前），正文恒最后一条', () => {
    const body = buildMimoRequestBody(baseReq({ instructions: '以新闻播报的风格朗读' }))
    expect(body['messages']).toEqual([
      { role: 'user', content: '以新闻播报的风格朗读' },
      { role: 'assistant', content: '你好太极' },
    ])
  })

  it('speed 无字段 → 丢弃（speedRange=null，请求体不含任何语速位）', () => {
    const body = buildMimoRequestBody(baseReq({ speed: 1.5 }))
    expect(JSON.stringify(body)).not.toContain('speed')
    expect(mimoCapabilities.speedRange).toBeNull()
  })

  it('sample_rate 传入忽略（协议固定 24kHz，§7.2）', () => {
    const body = buildMimoRequestBody(baseReq({ sample_rate: 48_000 }))
    expect(JSON.stringify(body)).not.toContain('48')
  })

  it('passthrough 与 audio 对象共存（私有 optimize_text_preview 不剥核心 voice/format）', () => {
    const body = buildMimoRequestBody(baseReq({ passthrough: { audio: { optimize_text_preview: true } } }))
    expect(body['audio']).toEqual({ voice: 'mimo_default', format: 'pcm16', optimize_text_preview: true })
  })
})
describe('响应归一（choices[0].message.audio.data base64）', () => {
  it('base64 → PCM；采样率固定 24000、声道 1', async () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6])
    const { calls } = stubFetch(() => new Response(JSON.stringify(successPayload(pcm.toString('base64')))))
    const driver = createMimoDriver({ baseUrl: BASE_URL })
    const chunk = await driver.synthesizeChunk(baseReq(), API_KEY)
    expect(chunk.pcm).toEqual(pcm)
    expect(chunk.sampleRate).toBe(MIMO_PCM_SAMPLE_RATE)
    expect(chunk.sampleRate).toBe(24_000)
    expect(chunk.channels).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('形状不符（缺 audio.data）→ tts_vendor_error', () => {
    expect(() => decodeMimoResponse(JSON.stringify({ choices: [{ message: {} }] }))).toThrow(/audio\.data/)
    expect(() => decodeMimoResponse(JSON.stringify({ choices: [] }))).toThrow(/audio\.data/)
  })

  it('base64 非法字符 → tts_vendor_error', () => {
    expect(() => decodeMimoResponse(JSON.stringify(successPayload('!!not-base64!!')))).toThrow(/base64/)
  })
})
describe('错误码翻译表（§7.2 注④）', () => {
  it('401 → tts_auth_failed；402 → tts_quota_exceeded；404/400 → tts_vendor_error', async () => {
    for (const [status, code] of [
      [401, 'tts_auth_failed'],
      [402, 'tts_quota_exceeded'],
      [404, 'tts_vendor_error'],
      [400, 'tts_vendor_error'],
    ] as const) {
      stubFetch(() => new Response(`{"error":{"code":"x_${status}"}}`, { status }))
      const driver = createMimoDriver({ baseUrl: BASE_URL })
      await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({ code })
    }
  })

  it('网络异常 → tts_network_error（基座归类，摘要带 network 带因）', async () => {
    stubFetchFailure(new DOMException('aborted due to timeout', 'TimeoutError'))
    const driver = createMimoDriver({ baseUrl: BASE_URL })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({
      code: 'tts_network_error',
      snippet: expect.stringContaining('network'),
    })
  })
})
describe('能力表与表单派生视图（§7.3）', () => {
  it('能力表：借壳端点 / api-key 头 / maxInputChars 1000 / 无语速 / 固定 24kHz', () => {
    expect(mimoCapabilities.endpointPath).toBe('/chat/completions')
    expect(mimoCapabilities.authHeader).toBe('api-key')
    expect(mimoCapabilities.maxInputChars).toBe(1000)
    expect(mimoCapabilities.speedRange).toBeNull()
    expect(mimoCapabilities.pcmSampleRates).toEqual([24_000])
    expect(mimoCapabilities.supportsInstructions).toBe(true)
  })

  it('表单派生视图：音色 ×9 全集 / 境内外集群 baseUrl / 音量音调置灰 / 无效果器', () => {
    expect(mimoFormModel.voices.map((v) => v.id)).toEqual([
      'mimo_default',
      '冰糖',
      '茉莉',
      '苏打',
      '白桦',
      'Mia',
      'Chloe',
      'Milo',
      'Dean',
    ])
    expect(mimoFormModel.baseUrlOptions.filter((o) => o.isDefault).map((o) => o.url)).toEqual(['https://api.xiaomimimo.com/v1'])
    expect(mimoFormModel.baseUrlOptions.map((o) => o.url)).toEqual([
      'https://api.xiaomimimo.com/v1',
      'https://token-plan-cn.xiaomimimo.com/v1',
      'https://token-plan-ams.xiaomimimo.com/v1',
      'https://token-plan-sgp.xiaomimimo.com/v1',
    ])
    expect(mimoFormModel.volumeRange).toBeNull()
    expect(mimoFormModel.pitchRange).toBeNull()
    expect(mimoFormModel.voiceModify).toBeNull()
    expect(mimoFormModel.hasPronunciationDict).toBe(false)
    expect(mimoFormModel.models.map((m) => m.id)).toEqual(['mimo-v2.5-tts'])
  })
})
});

// ======================================================================
// ← minimax.test.ts
// ======================================================================

const BASE_URL_m2_m2 = 'https://api.minimax.cn/v1'

const API_KEY_m2_m2 = 'test-key-minimax'


function baseReq_m2_m2(overrides: Partial<InternalSpeechRequest> = {}): InternalSpeechRequest {
  return { model: 'speech-2.8-hd', input: '你好', voice: 'male-qn-qingse', ...overrides }
}


function successPayload_m2(hex: string): unknown {
  return { data: { audio: hex, status: 2 }, base_resp: { status: 0, status_code: 0 } }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('minimax', () => {
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('请求组装（§7.2 t2a_v2 搬家列）', () => {
  it('端点 {baseUrl}/t2a_v2 + Bearer + input→text / voice→voice_setting.voice_id / format=pcm', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify(successPayload_m2('00ff'))))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
    await driver.synthesizeChunk(baseReq_m2_m2({ speed: 1 }), API_KEY_m2_m2)
    expect(calls[0].url).toBe(`${BASE_URL_m2_m2}/t2a_v2`)
    expect(calls[0].headers['authorization']).toBe(`Bearer ${API_KEY_m2_m2}`)
    expect(calls[0].body).toMatchObject({
      model: 'speech-2.8-hd',
      text: '你好',
      voice_setting: { voice_id: 'male-qn-qingse', speed: 1 },
      audio_setting: { format: 'pcm', sample_rate: 24_000 },
    })
  })

  it('语速钳制 [0.5,2]：3 → 2', () => {
    const body = buildMinimaxRequestBody(baseReq_m2_m2({ speed: 3 }))
    expect((body['voice_setting'] as Record<string, unknown>)['speed']).toBe(2)
  })

  it('instructions 无对应字段 → 丢弃 + 日志（supportsInstructions=false）', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const body = buildMinimaxRequestBody(baseReq_m2_m2({ instructions: '用温柔的语气' }))
    expect(JSON.stringify(body)).not.toContain('用温柔的语气')
    expect(body['instruction']).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledOnce()
    const { calls } = stubFetch(() => new Response(JSON.stringify(successPayload_m2('00'))))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
    await driver.synthesizeChunk(baseReq_m2_m2({ instructions: '用温柔的语气' }), API_KEY_m2_m2)
    expect(JSON.stringify(calls[0].body)).not.toContain('用温柔的语气')
  })
})
describe('channel 回报点名用例（任务书验收①）', () => {
  it('passthrough audio_setting.channel=2 → 最终请求体含该字段且 synthesizeChunk 返回 channels=2', async () => {
    const captured: CapturedRequest[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      captured.push({
        url: String(_url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(JSON.stringify(successPayload_m2('deadbeef')))
    })
    const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
    const chunk = await driver.synthesizeChunk(
      baseReq_m2_m2({ passthrough: { audio_setting: { channel: 2 } } }),
      API_KEY_m2_m2,
    )
    const audioSetting = captured[0].body['audio_setting'] as Record<string, unknown>
    expect(audioSetting['channel']).toBe(2)
    // 核心叶子与私有子键共存：channel 与核心 format/sample_rate 同对象
    expect(audioSetting['format']).toBe('pcm')
    expect(audioSetting['sample_rate']).toBe(24_000)
    expect(chunk.channels).toBe(2)
    expect(chunk.pcm).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  })

  it('无 channel 透传 → 回报单声道 1', async () => {
    const body = buildMinimaxRequestBody(baseReq_m2_m2())
    expect((body['audio_setting'] as Record<string, unknown>)['channel']).toBeUndefined()
    const captured: CapturedRequest[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> } as CapturedRequest)
      return new Response(JSON.stringify(successPayload_m2('aa')))
    })
    const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
    const chunk = await driver.synthesizeChunk(baseReq_m2_m2(), API_KEY_m2_m2)
    expect(chunk.channels).toBe(1)
  })
})
describe('采样率（snap 到可用枚举，请求值 = WAV 头事实值）', () => {
  it('枚举内直传 / 漂移值钳最近 / 缺席默认 24000', () => {
    expect((buildMinimaxRequestBody(baseReq_m2_m2({ sample_rate: 44_100 }))['audio_setting'] as Record<string, unknown>)['sample_rate']).toBe(44_100)
    expect((buildMinimaxRequestBody(baseReq_m2_m2({ sample_rate: 6000 }))['audio_setting'] as Record<string, unknown>)['sample_rate']).toBe(8000)
    expect((buildMinimaxRequestBody(baseReq_m2_m2())['audio_setting'] as Record<string, unknown>)['sample_rate']).toBe(24_000)
  })
})
describe('响应归一（data.audio hex + status:2）', () => {
  it('hex 解码为 PCM 字节', () => {
    expect(decodeMinimaxResponse(Buffer.from(JSON.stringify(successPayload_m2('deadbeef'))))).toEqual(
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    )
  })

  it('data.status 存在且非 2 → tts_vendor_error（不产出错误产物）', () => {
    const payload = { data: { audio: 'ff', status: 1 }, base_resp: { status: 0, status_code: 0 } }
    expect(() => decodeMinimaxResponse(JSON.stringify(payload))).toThrow(/data\.status/)
  })

  it('缺 data.audio → tts_vendor_error', () => {
    expect(() => decodeMinimaxResponse(JSON.stringify({ data: {}, base_resp: { status: 0, status_code: 0 } }))).toThrow(
      /hex/,
    )
  })
})
describe('错误码翻译表（业务层 base_resp + HTTP 层）', () => {
  it('base_resp.status_code=1004 → tts_auth_failed（摘要带原始码）', async () => {
    stubFetch(() => new Response(JSON.stringify({ base_resp: { status: 1004, status_code: 1004 } })))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
    await expect(driver.synthesizeChunk(baseReq_m2_m2(), API_KEY_m2_m2)).rejects.toMatchObject({
      code: 'tts_auth_failed',
      snippet: expect.stringContaining('status_code=1004'),
    })
  })

  it('base_resp.status_code=2049（invalid api key，2026-10-01 实测）→ tts_auth_failed 而非厂商通用错误', async () => {
    stubFetch(() => new Response(JSON.stringify({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } })))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
    await expect(driver.synthesizeChunk(baseReq_m2_m2(), API_KEY_m2_m2)).rejects.toMatchObject({
      code: 'tts_auth_failed',
      snippet: expect.stringContaining('status_code=2049'),
    })
  })

  it.each([1042, 2013, 1008])('base_resp.status_code=%i → tts_vendor_error', async (statusCode) => {
    stubFetch(() => new Response(JSON.stringify({ base_resp: { status: statusCode, status_code: statusCode } })))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
    await expect(driver.synthesizeChunk(baseReq_m2_m2(), API_KEY_m2_m2)).rejects.toMatchObject({ code: 'tts_vendor_error' })
  })

  it('HTTP 层 401 → tts_auth_failed；402 → tts_quota_exceeded；400 → tts_vendor_error', async () => {
    for (const [status, code] of [
      [401, 'tts_auth_failed'],
      [402, 'tts_quota_exceeded'],
      [400, 'tts_vendor_error'],
    ] as const) {
      stubFetch(() => new Response('err', { status }))
      const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
      await expect(driver.synthesizeChunk(baseReq_m2_m2(), API_KEY_m2_m2)).rejects.toMatchObject({ code })
    }
  })

  it('2xx 非 JSON → tts_vendor_error；网络异常 → tts_network_error', async () => {
    stubFetch(() => new Response('not-json', { status: 200 }))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL_m2_m2 })
    await expect(driver.synthesizeChunk(baseReq_m2_m2(), API_KEY_m2_m2)).rejects.toMatchObject({ code: 'tts_vendor_error' })
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    await expect(driver.synthesizeChunk(baseReq_m2_m2(), API_KEY_m2_m2)).rejects.toMatchObject({ code: 'tts_network_error' })
  })
})
describe('能力表与表单派生视图（§7.3）', () => {
  it('能力表：t2a_v2 / maxInputChars 3000 / 不支持指令 / speedRange [0.5,2]', () => {
    expect(minimaxCapabilities.endpointPath).toBe('/t2a_v2')
    expect(minimaxCapabilities.authHeader).toBe('bearer')
    expect(minimaxCapabilities.maxInputChars).toBe(3000)
    expect(minimaxCapabilities.speedRange).toEqual([0.5, 2])
    expect(minimaxCapabilities.supportsInstructions).toBe(false)
  })

  it('表单派生视图：情感 ×9 / 声道枚举单双 / 音量音调值域 / 默认 baseUrl 唯一', () => {
    expect(minimaxFormModel.emotions).toHaveLength(9)
    expect(minimaxFormModel.channels.map((c) => c.id)).toEqual(['1', '2'])
    expect(minimaxFormModel.volumeRange).toEqual({ min: 0.5, max: 10, step: 0.5 })
    expect(minimaxFormModel.pitchRange).toEqual({ min: -12, max: 12, step: 2 })
    expect(minimaxFormModel.voiceModify).not.toBeNull()
    expect(minimaxFormModel.hasPronunciationDict).toBe(true)
    expect(minimaxFormModel.baseUrlOptions.filter((o) => o.isDefault).map((o) => o.url)).toEqual(['https://api.minimax.cn/v1'])
    expect(minimaxFormModel.baseUrlOptions.map((o) => o.url)).toContain('https://api.minimaxi.com/v1')
  })

  it('派生视图 id 形态：toggles 与 voiceModify tiers 均为 vendor 子键名裸键（D5 F1-8/F1-11 回归——renderer 按裸键查落盘路径/直写子树，路径前缀形态静默丢值或双前缀错位）', () => {
    expect(minimaxFormModel.toggles).toEqual(['text_normalization', 'latex_read', 'aigc_watermark'])
    expect(minimaxFormModel.voiceModify?.tiers.map((t) => t.id)).toEqual(['pitch', 'intensity', 'timbre'])
    expect(minimaxFormModel.voiceModify?.effects.map((e) => e.id)).toEqual(['spacious_echo', 'auditorium_echo', 'lofi_telephone', 'robotic'])
    expect(minimaxFormModel.maxTimbreVoices).toBe(2) // M0 表单开放值（非厂商上限 4）
  })

  it('音色枚举：官方核心中文八音色，实测音色 male-qn-qingse 首位', () => {
    expect(minimaxFormModel.voices).toHaveLength(8)
    expect(minimaxFormModel.voices[0]).toEqual({ id: 'male-qn-qingse', label: '青涩青年音色' })
  })

  it('语言增强枚举：官方 language_boost 全集 41 项（auto + 40 语言，2026-10-01 官方文档抓取）', () => {
    expect(minimaxFormModel.languages).toHaveLength(41)
    expect(minimaxFormModel.languages[0]).toEqual({ id: 'auto', label: 'auto（全自动）' })
    // 官方扩充的三语种在列（speech-01/02 系不支持，M0 的 2.6/2.8 系不受限）
    expect(minimaxFormModel.languages.map((l) => l.id)).toEqual(
      expect.arrayContaining(['Persian', 'Filipino', 'Tamil', 'Chinese,Yue']),
    )
  })
})
});

// ======================================================================
// ← stepfun.test.ts
// ======================================================================

const BASE_URL_m2_m2_d1 = 'https://api.stepfun.com/v1'

const API_KEY_m2_m2_d1 = 'test-key-stepfun'


function baseReq_m2_m2_d1(overrides: Partial<InternalSpeechRequest> = {}): InternalSpeechRequest {
  return { model: 'stepaudio-2.5-tts', input: '你好', voice: 'cixingnansheng', ...overrides }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('stepfun', () => {
afterEach(() => {
  vi.unstubAllGlobals()
})
describe('请求组装（§7.2 直传列）', () => {
  it('端点 {baseUrl}/audio/speech + Authorization Bearer + 核心字段直传', async () => {
    const { calls } = stubFetch(() => new Response(Buffer.from([1, 2])))
    const driver = createStepfunDriver({ baseUrl: BASE_URL_m2_m2_d1 })
    await driver.synthesizeChunk(baseReq_m2_m2_d1({ speed: 1, instructions: '温柔' }), API_KEY_m2_m2_d1)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE_URL_m2_m2_d1}/audio/speech`)
    expect(calls[0].headers['authorization']).toBe(`Bearer ${API_KEY_m2_m2_d1}`)
    expect(calls[0].headers['content-type']).toBe('application/json')
    expect(calls[0].body).toMatchObject({
      model: 'stepaudio-2.5-tts',
      input: '你好',
      voice: 'cixingnansheng',
      speed: 1,
      instruction: '温柔',
      response_format: 'pcm',
      sample_rate: 24_000,
    })
  })

  it('语速钳制读能力表：超出 [0.5,2] 两端钳制', () => {
    expect(buildStepfunRequestBody(baseReq_m2_m2_d1({ speed: 5 }))['speed']).toBe(2)
    expect(buildStepfunRequestBody(baseReq_m2_m2_d1({ speed: 0.1 }))['speed']).toBe(0.5)
    expect(buildStepfunRequestBody(baseReq_m2_m2_d1({ speed: 1.25 }))['speed']).toBe(1.25)
  })

  it('instruction 按 per-model 上限截断：2.5 系 200 / 3 系 500 / 未知模型缺省 200', () => {
    const long = 'a'.repeat(600)
    expect((buildStepfunRequestBody(baseReq_m2_m2_d1({ instructions: long, model: 'stepaudio-2.5-tts' }))['instruction'] as string).length).toBe(200)
    expect((buildStepfunRequestBody(baseReq_m2_m2_d1({ instructions: long, model: 'stepaudio-3-tts' }))['instruction'] as string).length).toBe(500)
    expect((buildStepfunRequestBody(baseReq_m2_m2_d1({ instructions: long, model: 'step-tts-mini' }))['instruction'] as string).length).toBe(200)
  })

  it('sample_rate 枚举内直传；缺席默认 24000（D9/WAV 头事实值同源）', () => {
    expect(buildStepfunRequestBody(baseReq_m2_m2_d1({ sample_rate: 48_000 }))['sample_rate']).toBe(48_000)
    expect(buildStepfunRequestBody(baseReq_m2_m2_d1())['sample_rate']).toBe(24_000)
  })

  it('passthrough 深合并共存；协议行为键（return_url/stream_format/timestamp/markdown_filter）剥离', () => {
    const body = buildStepfunRequestBody(
      baseReq_m2_m2_d1({ passthrough: { voice_label: { emotion: '温柔' }, volume: 1.5, return_url: true, stream_format: 'sse' } }),
    )
    expect(body['voice_label']).toEqual({ emotion: '温柔' })
    expect(body['volume']).toBe(1.5)
    expect(body['return_url']).toBeUndefined()
    expect(body['stream_format']).toBeUndefined()
  })
})
describe('响应归一（裸二进制）', () => {
  it('二进制响应原样为 PCM，采样率回报请求值、声道恒 1', async () => {
    const pcm = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    const { calls } = stubFetch(() => new Response(pcm))
    const driver = createStepfunDriver({ baseUrl: BASE_URL_m2_m2_d1 })
    const chunk = await driver.synthesizeChunk(baseReq_m2_m2_d1({ sample_rate: 22_050 }), API_KEY_m2_m2_d1)
    expect(chunk.pcm).toEqual(pcm)
    expect(chunk.sampleRate).toBe(22_050)
    expect(chunk.channels).toBe(1)
    expect(calls).toHaveLength(1)
  })
})
describe('错误码翻译表（§7.2 注④实测四形态）', () => {
  const cases: Array<{ status: number; body: string; code: string }> = [
    { status: 401, body: '{"error":{"message":"invalid api key"}}', code: 'tts_auth_failed' },
    { status: 402, body: '{"error":{"code":"quota_exceeded"}}', code: 'tts_quota_exceeded' },
    { status: 404, body: '{"error":{"code":"model_invalid"}}', code: 'tts_vendor_error' },
    { status: 400, body: '{"error":{"code":"voice_id_invalid"}}', code: 'tts_vendor_error' },
  ]
  it.each(cases)('HTTP $status → $code（摘要带 status 与原文）', async ({ status, body, code }) => {
    stubFetch(() => new Response(body, { status }))
    const driver = createStepfunDriver({ baseUrl: BASE_URL_m2_m2_d1 })
    await expect(driver.synthesizeChunk(baseReq_m2_m2_d1(), API_KEY_m2_m2_d1)).rejects.toMatchObject({ code })
    await expect(driver.synthesizeChunk(baseReq_m2_m2_d1(), API_KEY_m2_m2_d1)).rejects.toSatisfy((e: unknown) => {
      const failure = e as TtsDriverFailure
      return failure.snippet.startsWith(`HTTP ${status}`) && failure.snippet.length <= 200
    })
  })

  it('非 2xx 摘要超长截断到 200 字符', async () => {
    stubFetch(() => new Response('y'.repeat(500), { status: 500 }))
    const driver = createStepfunDriver({ baseUrl: BASE_URL_m2_m2_d1 })
    await expect(driver.synthesizeChunk(baseReq_m2_m2_d1(), API_KEY_m2_m2_d1)).rejects.toSatisfy((e: unknown) => {
      return (e as TtsDriverFailure).snippet.length <= 200
    })
  })

  it('网络异常 → tts_network_error（基座归类）', async () => {
    stubFetchFailure(new TypeError('fetch failed'))
    const driver = createStepfunDriver({ baseUrl: BASE_URL_m2_m2_d1 })
    await expect(driver.synthesizeChunk(baseReq_m2_m2_d1(), API_KEY_m2_m2_d1)).rejects.toMatchObject({ code: 'tts_network_error' })
  })
})
describe('能力表与表单派生视图（§7.3）', () => {
  it('能力表：端点 / Bearer / maxInputChars 1000 / speedRange [0.5,2] / 指令支持', () => {
    expect(stepfunCapabilities.endpointPath).toBe('/audio/speech')
    expect(stepfunCapabilities.authHeader).toBe('bearer')
    expect(stepfunCapabilities.maxInputChars).toBe(1000)
    expect(stepfunCapabilities.speedRange).toEqual([0.5, 2])
    expect(stepfunCapabilities.supportsInstructions).toBe(true)
    expect(stepfunCapabilities.perModel['stepaudio-3-tts']).toEqual({ instructionMaxChars: 500, voiceLabelSupported: false })
  })

  it('表单派生视图：baseUrlOptions 默认项唯一（isDefault）且含 Step Plan 集群', () => {
    const defaults = stepfunFormModel.baseUrlOptions.filter((o) => o.isDefault).map((o) => o.url)
    expect(defaults).toEqual(['https://api.stepfun.com/v1'])
    expect(stepfunFormModel.baseUrlOptions.map((o) => o.url)).toContain('https://api.stepfun.com/step_plan/v1')
  })

  it('音色枚举：官方清单 36 全集，实测音色 cixingnansheng 在列', () => {
    expect(stepfunFormModel.voices).toHaveLength(36)
    expect(stepfunFormModel.voices.map((v) => v.id)).toContain('cixingnansheng')
  })
})
});


// ======================================================================
// ← src/infra/tts/passthrough-merge.test.ts
// ======================================================================

const POLICY = { reservedKeys: AUTH_RESERVED_PASSTHROUGH_KEYS }

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('tts-bundle', () => {
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/infra/tts/base.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('base', () => {
afterEach(() => {
  vi.unstubAllGlobals()
})
describe('契约常量', () => {
  it('单段合成 120s 防挂死兜底（任务书 §1）与摘要截断 200 字符', () => {
    expect(TTS_REQUEST_TIMEOUT_MS).toBe(120_000)
    expect(TTS_ERROR_SNIPPET_MAX).toBe(200)
  })
})
describe('buildAuthHeaders（表驱动鉴权头）', () => {
  it('bearer：Authorization Bearer（StepFun/MiniMax）', () => {
    expect(buildAuthHeaders('bearer', 'sk-1')).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-1',
    })
  })

  it('api-key：api-key 头而非 Bearer（MiMo 借壳，§7.2）', () => {
    expect(buildAuthHeaders('api-key', 'mk-1')).toEqual({
      'content-type': 'application/json',
      'api-key': 'mk-1',
    })
  })
})
describe('joinEndpoint', () => {
  it('剥 baseUrl 尾斜杠后拼端点路径', () => {
    expect(joinEndpoint('https://api.example.com/v1/', '/audio/speech')).toBe('https://api.example.com/v1/audio/speech')
    expect(joinEndpoint('https://api.example.com/v1', '/t2a_v2')).toBe('https://api.example.com/v1/t2a_v2')
  })
})
describe('toErrorSnippet', () => {
  it('压缩空白 + 截断到 200 字符', () => {
    expect(toErrorSnippet('  a\n\t b  ')).toBe('a b')
    const long = 'x'.repeat(500)
    expect(toErrorSnippet(long)).toHaveLength(200)
  })
})
describe('postTtsRequest 错误归一分层（基座管网络，厂商错误不在此翻译）', () => {
  it('fetch throw（DNS/不可达）→ tts_network_error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    await expect(postTtsRequest('https://x.example.com', {}, {})).rejects.toMatchObject({
      code: 'tts_network_error',
    })
  })

  it('超时 abort（TimeoutError DOMException）→ tts_network_error（每段 120s 兜底的归类形态）', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    await expect(postTtsRequest('https://x.example.com', {}, {})).rejects.toBeInstanceOf(TtsDriverFailure)
    await expect(postTtsRequest('https://x.example.com', {}, {})).rejects.toMatchObject({
      code: 'tts_network_error',
    })
  })

  it('非 2xx 不翻译：原样返回 status 与响应文本，交本家 driver 翻译表', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"quota"}', { status: 402 }))
    const res = await postTtsRequest('https://x.example.com', {}, {})
    expect(res.ok).toBe(false)
    expect(res.status).toBe(402)
    expect(res.errorText).toBe('{"error":"quota"}')
  })

  it('2xx 二进制：字节本体原样返回', async () => {
    const pcm = Buffer.from([1, 2, 3, 4])
    vi.stubGlobal('fetch', async () => new Response(pcm))
    const res = await postTtsRequest('https://x.example.com', {}, {})
    expect(res.ok).toBe(true)
    expect(res.bytes).toEqual(pcm)
  })

  it('fetch 请求形态：POST JSON + AbortSignal 兜底 signal 在位', async () => {
    let captured: RequestInit | undefined
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      captured = init
      return new Response('{}')
    })
    await postTtsRequest('https://x.example.com', { 'content-type': 'application/json' }, { model: 'm' })
    expect(captured?.method).toBe('POST')
    expect(captured?.body).toBe(JSON.stringify({ model: 'm' }))
    expect(captured?.signal).toBeInstanceOf(AbortSignal)
  })
})
describe('解码归一（厂商响应形状 unknown + 运行时 guard）', () => {
  it('hex → PCM：合法 hex 解码为字节；非法形态 → tts_vendor_error', () => {
    expect(decodeHexToPcm('deadbeef', 'minimax')).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
    expect(() => decodeHexToPcm('xyz', 'minimax')).toThrow(TtsDriverFailure)
    expect(() => decodeHexToPcm('xyz', 'minimax')).toThrow(/hex/)
    expect(() => decodeHexToPcm(42, 'minimax')).toThrow(TtsDriverFailure)
    expect(() => decodeHexToPcm('', 'minimax')).toThrow(TtsDriverFailure)
    try {
      decodeHexToPcm('nothex', 'minimax')
    } catch (e) {
      expect((e as TtsDriverFailure).code).toBe('tts_vendor_error')
    }
  })

  it('base64 → PCM：合法 base64 解码；非法形态 → tts_vendor_error', () => {
    expect(decodeBase64ToPcm('AQIDBA==', 'mimo')).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(() => decodeBase64ToPcm('not base64!!', 'mimo')).toThrow(/base64/)
    expect(() => decodeBase64ToPcm(undefined, 'mimo')).toThrow(TtsDriverFailure)
  })

  it('JSON 解析失败 → tts_vendor_error（摘要含原文片段）', () => {
    expect(() => parseVendorJson(Buffer.from('not-json{'), 'minimax')).toThrow(TtsDriverFailure)
    try {
      parseVendorJson('nope', 'minimax')
    } catch (e) {
      expect((e as TtsDriverFailure).code).toBe('tts_vendor_error')
      expect((e as TtsDriverFailure).snippet).toContain('nope')
    }
  })
})
describe('snapToNearestSampleRate', () => {
  const RATES = [8000, 16_000, 22_050, 24_000, 32_000, 44_100]
  it('缺席 → 默认 24000（枚举含默认值时）', () => {
    expect(snapToNearestSampleRate(undefined, RATES)).toBe(24_000)
  })
  it('枚举内原样用', () => {
    expect(snapToNearestSampleRate(44_100, RATES)).toBe(44_100)
  })
  it('漂移值钳到最近可用项（请求值 = WAV 头事实值）', () => {
    expect(snapToNearestSampleRate(5000, RATES)).toBe(8000)
    expect(snapToNearestSampleRate(48_000, RATES)).toBe(44_100)
    expect(snapToNearestSampleRate(Number.NaN, RATES)).toBe(24_000)
  })
})
});
// ======================================================================
// ← src/infra/tts/index.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('index', () => {
describe('createTtsDriver 分发', () => {
  it('三家 id 各自返回对应 driver（端点路径与鉴权头按 §7.2 各归各家）', () => {
    expect(createTtsDriver('stepfun', 'https://api.stepfun.com/v1').capabilities.endpointPath).toBe('/audio/speech')
    expect(createTtsDriver('minimax', 'https://api.minimax.cn/v1').capabilities.endpointPath).toBe('/t2a_v2')
    expect(createTtsDriver('mimo', 'https://token-plan-cn.xiaomimimo.com/v1').capabilities.endpointPath).toBe('/chat/completions')
    expect(createTtsDriver('mimo', 'https://x/v1').capabilities.authHeader).toBe('api-key')
  })

  it('id 与 formModel 同源（driver 内嵌能力表，映射即本家数据）', () => {
    const driver = createTtsDriver('minimax', 'https://api.minimax.cn/v1')
    expect(driver.id).toBe('minimax')
    expect(driver.formModel.capabilities).toBe(driver.capabilities)
  })
})
describe('getTtsFormModels', () => {
  it('三家表单派生视图全集齐备（tts.getCapabilities reply forms 载荷形状）', () => {
    const forms = getTtsFormModels()
    expect(Object.keys(forms).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
    for (const form of Object.values(forms)) {
      expect(form.baseUrlOptions.length).toBeGreaterThan(0)
      expect(form.baseUrlOptions.filter((o) => o.isDefault)).toHaveLength(1)
      expect(form.models.length).toBeGreaterThan(0)
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('passthrough-merge', () => {
describe('mergeRequestBody 顺序语义（护栏②）', () => {
  it('核心叶子恒核心值：passthrough 同路径写覆盖不生效（顶层标量键）', () => {
    const body = mergeRequestBody(
      { model: 'core-model', input: 'core-text' },
      { model: 'evil-model', input: 'evil-text', temperature: 0.5 },
      POLICY,
    )
    expect(body['model']).toBe('core-model')
    expect(body['input']).toBe('core-text')
    expect(body['temperature']).toBe(0.5)
  })

  it('核心叶子恒核心值：嵌套精确叶子路径（voice_setting.voice_id / voice_setting.speed）', () => {
    const body = mergeRequestBody(
      { voice_setting: { voice_id: 'core-voice', speed: 1.5 } },
      { voice_setting: { voice_id: 'evil-voice', speed: 9 } },
      POLICY,
    )
    expect(body['voice_setting']).toEqual({ voice_id: 'core-voice', speed: 1.5 })
  })

  it('同嵌套对象核心与私有子键共存：MiniMax voice_setting 下 voice_id+speed 与 vol+emotion 共存', () => {
    const body = mergeRequestBody(
      { model: 'm', text: 't', voice_setting: { voice_id: 'male-qn-qingse', speed: 1 }, audio_setting: { format: 'pcm' } },
      { voice_setting: { vol: 2, emotion: 'happy' }, pronunciation_dict: { tone: ['处理/(chu3)(li3)'] } },
      POLICY,
    )
    expect(body['voice_setting']).toEqual({ voice_id: 'male-qn-qingse', speed: 1, vol: 2, emotion: 'happy' })
    expect(body['audio_setting']).toEqual({ format: 'pcm' })
    expect(body['pronunciation_dict']).toEqual({ tone: ['处理/(chu3)(li3)'] })
  })

  it('passthrough 缺席：纯核心请求体', () => {
    expect(mergeRequestBody({ model: 'm' }, undefined, POLICY)).toEqual({ model: 'm' })
  })
})
describe('键恒等搬运（护栏①合并侧：零字段名知识）', () => {
  it('外来键（他家私有键）不做本家过滤，原样进请求体由厂商 4xx 暴露', () => {
    const body = mergeRequestBody(
      { model: 'm' },
      { voice_setting: { vol: 1 }, 'audio.voice': 'foreign', messages: [{ role: 'user', content: 'x' }] },
      POLICY,
    )
    expect(body['voice_setting']).toEqual({ vol: 1 })
    expect(body['messages']).toEqual([{ role: 'user', content: 'x' }])
  })

  it('数组值整体替换（叶子语义）：同键核心值胜出，passthrough 独有数组逐字保留', () => {
    const body = mergeRequestBody(
      { base: [1, 2] },
      { base: [3], dict: { tone: ['处理/(chu3)(li3)'] } },
      POLICY,
    )
    expect(body['base']).toEqual([1, 2])
    expect(body['dict']).toEqual({ tone: ['处理/(chu3)(li3)'] })
  })
})
describe('保留键剥离（护栏③⑤，merge 前生效）', () => {
  it.each(AUTH_RESERVED_PASSTHROUGH_KEYS)('鉴权与端点键 %s 被剥离', (key) => {
    const body = mergeRequestBody({ model: 'm' }, { [key]: 'injected' }, POLICY)
    expect(body[key]).toBeUndefined()
  })

  it('大小写不敏感：Authorization / BaseURL 剥离；嵌套同名键不误伤', () => {
    const body = mergeRequestBody(
      { model: 'm' },
      { Authorization: 'Bearer x', BaseURL: 'http://evil', voice_setting: { url: 'vendor-field' } },
      POLICY,
    )
    expect(body['Authorization']).toBeUndefined()
    expect(body['BaseURL']).toBeUndefined()
    expect(body['voice_setting']).toEqual({ url: 'vendor-field' })
  })

  it('协议行为键（护栏⑤）：本家 protocolKeys 剥离（StepFun return_url/stream_format 等）', () => {
    const body = mergeRequestBody(
      { model: 'm', input: 't' },
      { return_url: true, stream_format: 'sse', timestamp: true, markdown_filter: true },
      { reservedKeys: AUTH_RESERVED_PASSTHROUGH_KEYS, protocolKeys: ['timestamp', 'return_url', 'stream_format', 'markdown_filter'] },
    )
    expect(Object.keys(body).sort()).toEqual(['input', 'model'])
  })

  it('sanitizePassthrough 直接暴露剥离语义（副本返回）', () => {
    const input = { authorization: 'x', keep: 1 }
    const out = sanitizePassthrough(input, POLICY)
    expect(out).toEqual({ keep: 1 })
    expect(input).toEqual({ authorization: 'x', keep: 1 })
  })
})
describe('输入不可变性', () => {
  it('core 与 passthrough 入参均不被改动', () => {
    const core = { voice_setting: { voice_id: 'v' } }
    const passthrough = { voice_setting: { vol: 2 } }
    mergeRequestBody(core, passthrough, POLICY)
    expect(core).toEqual({ voice_setting: { voice_id: 'v' } })
    expect(passthrough).toEqual({ voice_setting: { vol: 2 } })
  })
})
describe('deepMergeLeaves 基元', () => {
  it('对象键递归、标量覆盖', () => {
    expect(deepMergeLeaves({ a: { b: 1, c: 2 } }, { a: { b: 9 } })).toEqual({ a: { b: 9, c: 2 } })
  })
})
});
});
