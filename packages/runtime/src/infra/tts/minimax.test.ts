/**
 * MiniMax driver 单测（ai-voice-tts 设计 §7.2 t2a_v2 列 + 错误翻译表）。
 * 点名用例（任务书验收①）：passthrough audio_setting.channel=2 → 最终请求体含该字段
 * 且 synthesizeChunk 返回 channels=2（WAV 头 numChannels 数据链）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMinimaxDriver,
  buildMinimaxRequestBody,
  decodeMinimaxResponse,
  minimaxCapabilities,
  minimaxFormModel,
} from './minimax.js'
import { logger } from '../logger.js'
import type { InternalSpeechRequest } from '@taiji/shared'

const BASE_URL = 'https://api.minimax.cn/v1'
const API_KEY = 'test-key-minimax'

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function stubFetch(handler: (init: RequestInit) => Response | Promise<Response>): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = []
  vi.stubGlobal(
    'fetch',
    async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(_url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return await handler(init ?? {})
    },
  )
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function baseReq(overrides: Partial<InternalSpeechRequest> = {}): InternalSpeechRequest {
  return { model: 'speech-2.8-hd', input: '你好', voice: 'male-qn-qingse', ...overrides }
}

function successPayload(hex: string): unknown {
  return { data: { audio: hex, status: 2 }, base_resp: { status: 0, status_code: 0 } }
}

describe('请求组装（§7.2 t2a_v2 搬家列）', () => {
  it('端点 {baseUrl}/t2a_v2 + Bearer + input→text / voice→voice_setting.voice_id / format=pcm', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify(successPayload('00ff'))))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL })
    await driver.synthesizeChunk(baseReq({ speed: 1 }), API_KEY)
    expect(calls[0].url).toBe(`${BASE_URL}/t2a_v2`)
    expect(calls[0].headers['authorization']).toBe(`Bearer ${API_KEY}`)
    expect(calls[0].body).toMatchObject({
      model: 'speech-2.8-hd',
      text: '你好',
      voice_setting: { voice_id: 'male-qn-qingse', speed: 1 },
      audio_setting: { format: 'pcm', sample_rate: 24_000 },
    })
  })

  it('语速钳制 [0.5,2]：3 → 2', () => {
    const body = buildMinimaxRequestBody(baseReq({ speed: 3 }))
    expect((body['voice_setting'] as Record<string, unknown>)['speed']).toBe(2)
  })

  it('instructions 无对应字段 → 丢弃 + 日志（supportsInstructions=false）', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const body = buildMinimaxRequestBody(baseReq({ instructions: '用温柔的语气' }))
    expect(JSON.stringify(body)).not.toContain('用温柔的语气')
    expect(body['instruction']).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledOnce()
    const { calls } = stubFetch(() => new Response(JSON.stringify(successPayload('00'))))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL })
    await driver.synthesizeChunk(baseReq({ instructions: '用温柔的语气' }), API_KEY)
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
      return new Response(JSON.stringify(successPayload('deadbeef')))
    })
    const driver = createMinimaxDriver({ baseUrl: BASE_URL })
    const chunk = await driver.synthesizeChunk(
      baseReq({ passthrough: { audio_setting: { channel: 2 } } }),
      API_KEY,
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
    const body = buildMinimaxRequestBody(baseReq())
    expect((body['audio_setting'] as Record<string, unknown>)['channel']).toBeUndefined()
    const captured: CapturedRequest[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> } as CapturedRequest)
      return new Response(JSON.stringify(successPayload('aa')))
    })
    const driver = createMinimaxDriver({ baseUrl: BASE_URL })
    const chunk = await driver.synthesizeChunk(baseReq(), API_KEY)
    expect(chunk.channels).toBe(1)
  })
})

describe('采样率（snap 到可用枚举，请求值 = WAV 头事实值）', () => {
  it('枚举内直传 / 漂移值钳最近 / 缺席默认 24000', () => {
    expect((buildMinimaxRequestBody(baseReq({ sample_rate: 44_100 }))['audio_setting'] as Record<string, unknown>)['sample_rate']).toBe(44_100)
    expect((buildMinimaxRequestBody(baseReq({ sample_rate: 6000 }))['audio_setting'] as Record<string, unknown>)['sample_rate']).toBe(8000)
    expect((buildMinimaxRequestBody(baseReq())['audio_setting'] as Record<string, unknown>)['sample_rate']).toBe(24_000)
  })
})

describe('响应归一（data.audio hex + status:2）', () => {
  it('hex 解码为 PCM 字节', () => {
    expect(decodeMinimaxResponse(Buffer.from(JSON.stringify(successPayload('deadbeef'))))).toEqual(
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
    const driver = createMinimaxDriver({ baseUrl: BASE_URL })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({
      code: 'tts_auth_failed',
      snippet: expect.stringContaining('status_code=1004'),
    })
  })

  it.each([1042, 2013, 1008])('base_resp.status_code=%i → tts_vendor_error', async (statusCode) => {
    stubFetch(() => new Response(JSON.stringify({ base_resp: { status: statusCode, status_code: statusCode } })))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({ code: 'tts_vendor_error' })
  })

  it('HTTP 层 401 → tts_auth_failed；402 → tts_quota_exceeded；400 → tts_vendor_error', async () => {
    for (const [status, code] of [
      [401, 'tts_auth_failed'],
      [402, 'tts_quota_exceeded'],
      [400, 'tts_vendor_error'],
    ] as const) {
      stubFetch(() => new Response('err', { status }))
      const driver = createMinimaxDriver({ baseUrl: BASE_URL })
      await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({ code })
    }
  })

  it('2xx 非 JSON → tts_vendor_error；网络异常 → tts_network_error', async () => {
    stubFetch(() => new Response('not-json', { status: 200 }))
    const driver = createMinimaxDriver({ baseUrl: BASE_URL })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({ code: 'tts_vendor_error' })
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({ code: 'tts_network_error' })
  })
})

describe('能力表与表单投影（§7.3）', () => {
  it('能力表：t2a_v2 / maxInputChars 3000 / 不支持指令 / speedRange [0.5,2]', () => {
    expect(minimaxCapabilities.endpointPath).toBe('/t2a_v2')
    expect(minimaxCapabilities.authHeader).toBe('bearer')
    expect(minimaxCapabilities.maxInputChars).toBe(3000)
    expect(minimaxCapabilities.speedRange).toEqual([0.5, 2])
    expect(minimaxCapabilities.supportsInstructions).toBe(false)
  })

  it('表单投影：情感 ×9 / 声道枚举单双 / 音量音调值域 / 默认 baseUrl 唯一', () => {
    expect(minimaxFormModel.emotions).toHaveLength(9)
    expect(minimaxFormModel.channels.map((c) => c.id)).toEqual(['1', '2'])
    expect(minimaxFormModel.volumeRange).toEqual({ min: 0.5, max: 10, step: 0.5 })
    expect(minimaxFormModel.pitchRange).toEqual({ min: -12, max: 12, step: 2 })
    expect(minimaxFormModel.voiceModify).not.toBeNull()
    expect(minimaxFormModel.hasPronunciationDict).toBe(true)
    expect(minimaxFormModel.baseUrlOptions.filter((o) => o.isDefault).map((o) => o.url)).toEqual(['https://api.minimax.cn/v1'])
    expect(minimaxFormModel.baseUrlOptions.map((o) => o.url)).toContain('https://api.minimaxi.com/v1')
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
