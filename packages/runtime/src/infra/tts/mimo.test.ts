/**
 * MiMo driver 单测（ai-voice-tts 设计 §7.2 借壳列：api-key 头 / messages 变形 / base64 解码）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMimoDriver, buildMimoRequestBody, decodeMimoResponse, mimoCapabilities, mimoFormModel, MIMO_PCM_SAMPLE_RATE } from './mimo.js'
import { stubFetch, stubFetchFailure, type CapturedRequest } from './__tests__/driver-fetch-stub.js'
import type { InternalSpeechRequest } from '@taiji/shared'

const BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'
const API_KEY = 'test-key-mimo'

afterEach(() => {
  vi.unstubAllGlobals()
})

function baseReq(overrides: Partial<InternalSpeechRequest> = {}): InternalSpeechRequest {
  return { model: 'mimo-v2.5-tts', input: '你好太极', voice: 'mimo_default', ...overrides }
}

function successPayload(base64: string): unknown {
  return { choices: [{ message: { audio: { data: base64 } } }] }
}

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

describe('能力表与表单投影（§7.3）', () => {
  it('能力表：借壳端点 / api-key 头 / maxInputChars 1000 / 无语速 / 固定 24kHz', () => {
    expect(mimoCapabilities.endpointPath).toBe('/chat/completions')
    expect(mimoCapabilities.authHeader).toBe('api-key')
    expect(mimoCapabilities.maxInputChars).toBe(1000)
    expect(mimoCapabilities.speedRange).toBeNull()
    expect(mimoCapabilities.pcmSampleRates).toEqual([24_000])
    expect(mimoCapabilities.supportsInstructions).toBe(true)
  })

  it('表单投影：音色 ×9 全集 / 境内外集群 baseUrl / 音量音调置灰 / 无效果器', () => {
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
