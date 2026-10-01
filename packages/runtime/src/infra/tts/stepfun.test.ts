/**
 * StepFun driver 单测（ai-voice-tts 设计 §7.2 映射表直传列 + 错误翻译表）。
 * mock fetch 注入、零 token；断言请求 URL / 鉴权头 / 请求体组装与钳制、响应归一、错误码翻译。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStepfunDriver, buildStepfunRequestBody, stepfunCapabilities, stepfunFormModel } from './stepfun.js'
import { TtsDriverFailure } from './base.js'
import { stubFetch, stubFetchFailure, type CapturedRequest } from './__tests__/driver-fetch-stub.js'
import type { InternalSpeechRequest } from '@taiji/shared'

const BASE_URL = 'https://api.stepfun.com/v1'
const API_KEY = 'test-key-stepfun'

afterEach(() => {
  vi.unstubAllGlobals()
})

function baseReq(overrides: Partial<InternalSpeechRequest> = {}): InternalSpeechRequest {
  return { model: 'stepaudio-2.5-tts', input: '你好', voice: 'cixingnansheng', ...overrides }
}

describe('请求组装（§7.2 直传列）', () => {
  it('端点 {baseUrl}/audio/speech + Authorization Bearer + 核心字段直传', async () => {
    const { calls } = stubFetch(() => new Response(Buffer.from([1, 2])))
    const driver = createStepfunDriver({ baseUrl: BASE_URL })
    await driver.synthesizeChunk(baseReq({ speed: 1, instructions: '温柔' }), API_KEY)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE_URL}/audio/speech`)
    expect(calls[0].headers['authorization']).toBe(`Bearer ${API_KEY}`)
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
    expect(buildStepfunRequestBody(baseReq({ speed: 5 }))['speed']).toBe(2)
    expect(buildStepfunRequestBody(baseReq({ speed: 0.1 }))['speed']).toBe(0.5)
    expect(buildStepfunRequestBody(baseReq({ speed: 1.25 }))['speed']).toBe(1.25)
  })

  it('instruction 按 per-model 上限截断：2.5 系 200 / 3 系 500 / 未知模型缺省 200', () => {
    const long = 'a'.repeat(600)
    expect((buildStepfunRequestBody(baseReq({ instructions: long, model: 'stepaudio-2.5-tts' }))['instruction'] as string).length).toBe(200)
    expect((buildStepfunRequestBody(baseReq({ instructions: long, model: 'stepaudio-3-tts' }))['instruction'] as string).length).toBe(500)
    expect((buildStepfunRequestBody(baseReq({ instructions: long, model: 'step-tts-mini' }))['instruction'] as string).length).toBe(200)
  })

  it('sample_rate 枚举内直传；缺席默认 24000（D9/WAV 头事实值同源）', () => {
    expect(buildStepfunRequestBody(baseReq({ sample_rate: 48_000 }))['sample_rate']).toBe(48_000)
    expect(buildStepfunRequestBody(baseReq())['sample_rate']).toBe(24_000)
  })

  it('passthrough 深合并共存；协议行为键（return_url/stream_format/timestamp/markdown_filter）剥离', () => {
    const body = buildStepfunRequestBody(
      baseReq({ passthrough: { voice_label: { emotion: '温柔' }, volume: 1.5, return_url: true, stream_format: 'sse' } }),
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
    const driver = createStepfunDriver({ baseUrl: BASE_URL })
    const chunk = await driver.synthesizeChunk(baseReq({ sample_rate: 22_050 }), API_KEY)
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
    const driver = createStepfunDriver({ baseUrl: BASE_URL })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({ code })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toSatisfy((e: unknown) => {
      const failure = e as TtsDriverFailure
      return failure.snippet.startsWith(`HTTP ${status}`) && failure.snippet.length <= 200
    })
  })

  it('非 2xx 摘要超长截断到 200 字符', async () => {
    stubFetch(() => new Response('y'.repeat(500), { status: 500 }))
    const driver = createStepfunDriver({ baseUrl: BASE_URL })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toSatisfy((e: unknown) => {
      return (e as TtsDriverFailure).snippet.length <= 200
    })
  })

  it('网络异常 → tts_network_error（基座归类）', async () => {
    stubFetchFailure(new TypeError('fetch failed'))
    const driver = createStepfunDriver({ baseUrl: BASE_URL })
    await expect(driver.synthesizeChunk(baseReq(), API_KEY)).rejects.toMatchObject({ code: 'tts_network_error' })
  })
})

describe('能力表与表单投影（§7.3）', () => {
  it('能力表：端点 / Bearer / maxInputChars 1000 / speedRange [0.5,2] / 指令支持', () => {
    expect(stepfunCapabilities.endpointPath).toBe('/audio/speech')
    expect(stepfunCapabilities.authHeader).toBe('bearer')
    expect(stepfunCapabilities.maxInputChars).toBe(1000)
    expect(stepfunCapabilities.speedRange).toEqual([0.5, 2])
    expect(stepfunCapabilities.supportsInstructions).toBe(true)
    expect(stepfunCapabilities.perModel['stepaudio-3-tts']).toEqual({ instructionMaxChars: 500, voiceLabelSupported: false })
  })

  it('表单投影：baseUrlOptions 默认项唯一（isDefault）且含 Step Plan 集群', () => {
    const defaults = stepfunFormModel.baseUrlOptions.filter((o) => o.isDefault).map((o) => o.url)
    expect(defaults).toEqual(['https://api.stepfun.com/v1'])
    expect(stepfunFormModel.baseUrlOptions.map((o) => o.url)).toContain('https://api.stepfun.com/step_plan/v1')
  })

  it('音色枚举：官方清单 36 全集，实测音色 cixingnansheng 在列', () => {
    expect(stepfunFormModel.voices).toHaveLength(36)
    expect(stepfunFormModel.voices.map((v) => v.id)).toContain('cixingnansheng')
  })
})
