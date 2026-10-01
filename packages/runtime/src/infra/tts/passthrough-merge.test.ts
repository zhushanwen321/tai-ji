/**
 * passthrough 深合并单测（ai-voice-tts 设计 D2 护栏）。
 * 五护栏在 driver 侧的可测形态：核心叶子恒核心值（②）/ 键恒等搬运零字段名知识（①合并侧）/
 * 鉴权端点与协议行为键剥离（③⑤）/ 同嵌套对象核心与私有子键共存（②）/ 输入不被改动。
 */
import { describe, expect, it } from 'vitest'
import {
  AUTH_RESERVED_PASSTHROUGH_KEYS,
  deepMergeLeaves,
  mergeRequestBody,
  sanitizePassthrough,
} from './passthrough-merge.js'

const POLICY = { reservedKeys: AUTH_RESERVED_PASSTHROUGH_KEYS }

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
