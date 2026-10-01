/**
 * driver 基座单测（ai-voice-tts 设计 §7.3 错误归一分层）。
 * 重点：网络异常/超时 → tts_network_error（基座归类）、解码 guard（unknown + 运行时收窄）、
 * 120s 防挂死兜底常量与摘要截断契约。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TtsDriverFailure,
  buildAuthHeaders,
  decodeBase64ToPcm,
  decodeHexToPcm,
  joinEndpoint,
  parseVendorJson,
  postTtsRequest,
  snapToNearestSampleRate,
  toErrorSnippet,
  TTS_ERROR_SNIPPET_MAX,
  TTS_REQUEST_TIMEOUT_MS,
} from './base.js'

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
