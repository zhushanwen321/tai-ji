// src/__tests__/commands.test.ts
//
// 命令帧组装测试：prompt（streamingBehavior 语义 + images 映射）/ steer / followUp /
// switch_session（仅主 agent 消费）/ get_state / extension_ui_response 两侧形态。

import { describe, expect, it, vi } from 'vitest'

import {
  buildPromptParams,
  buildSteerParams,
  buildFollowUpParams,
  buildSwitchSessionParams,
  buildPromptCommandFrame,
  buildGetStateCommandFrame,
  buildUiResponseFrame,
  buildExtensionUiResponsePayload,
  serializeCommandFrame,
} from '../commands.ts'

describe('buildPromptParams', () => {
  it('最小形态：{message}（pi 用 message 字段非 content）；省略键不出现', () => {
    const params = buildPromptParams({ message: 'hi' })
    expect(params).toEqual({ message: 'hi' })
    expect('images' in params).toBe(false)
    expect('streamingBehavior' in params).toBe(false)
  })

  it('images：shared {data,mimeType} → pi {type:"image",data,mimeType}（唯一组装点补 type）', () => {
    const params = buildPromptParams({ message: 'm', images: [{ data: 'b64', mimeType: 'image/png' }] })
    expect(params.images).toEqual([{ type: 'image', data: 'b64', mimeType: 'image/png' }])
  })

  it('images 空数组 → 归一化不传键（避免 pi 收到空数组）', () => {
    const params = buildPromptParams({ message: 'm', images: [] })
    expect('images' in params).toBe(false)
  })

  it('streamingBehavior：steer / followUp 透传；省略不传键', () => {
    expect(buildPromptParams({ message: 'm', streamingBehavior: 'steer' }).streamingBehavior).toBe('steer')
    expect(buildPromptParams({ message: 'm', streamingBehavior: 'followUp' }).streamingBehavior).toBe('followUp')
    expect('streamingBehavior' in buildPromptParams({ message: 'm' })).toBe(false)
  })
})

describe('steer / followUp / switch_session params', () => {
  it('steer / followUp：{message}（pi 命令名 steer / follow_up 由调用方 sendCommand 定）', () => {
    expect(buildSteerParams('interrupt')).toEqual({ message: 'interrupt' })
    expect(buildFollowUpParams('queue')).toEqual({ message: 'queue' })
  })

  it('switch_session：{sessionPath}（仅主 agent 消费——subagent 续聊走 spawn --session 直续）', () => {
    expect(buildSwitchSessionParams('/a/b.jsonl')).toEqual({ sessionPath: '/a/b.jsonl' })
  })
})

describe('完整命令帧（fire-and-forget 形态，pi-subagent-cli 消费）', () => {
  it('buildPromptCommandFrame：{id,type:"prompt",message[,streamingBehavior]}，不含换行', () => {
    const frame = buildPromptCommandFrame('req-1', { message: 'task text' })
    expect(frame).toBe('{"id":"req-1","type":"prompt","message":"task text"}')
    expect(frame.endsWith('\n')).toBe(false)

    const withBehavior = buildPromptCommandFrame('req-2', { message: 'm', streamingBehavior: 'followUp' })
    expect(JSON.parse(withBehavior)).toEqual({ id: 'req-2', type: 'prompt', message: 'm', streamingBehavior: 'followUp' })
  })

  it('buildGetStateCommandFrame：仅 id + type 两键', () => {
    const frame = buildGetStateCommandFrame('gs-1')
    expect(JSON.parse(frame)).toEqual({ id: 'gs-1', type: 'get_state' })
    expect(Object.keys(JSON.parse(frame)).sort()).toEqual(['id', 'type'])
  })

  it('serializeCommandFrame：{id,type,...params} 键序', () => {
    expect(serializeCommandFrame('i', 'abort', {})).toBe('{"id":"i","type":"abort"}')
  })
})

describe('buildUiResponseFrame（subagent 形态：UiResponse tag 判别）', () => {
  it('value / confirmed / cancelled 三分支形状', () => {
    expect(JSON.parse(buildUiResponseFrame('r1', { value: 'hello' })!)).toEqual({
      type: 'extension_ui_response', id: 'r1', value: 'hello',
    })
    expect(JSON.parse(buildUiResponseFrame('r2', { confirmed: false })!)).toEqual({
      type: 'extension_ui_response', id: 'r2', confirmed: false,
    })
    expect(JSON.parse(buildUiResponseFrame('r3', { cancelled: true })!)).toEqual({
      type: 'extension_ui_response', id: 'r3', cancelled: true,
    })
  })

  it('ack（fire-and-forget method，SR-5）→ undefined（不写 stdin）', () => {
    expect(buildUiResponseFrame('r4', { ack: true })).toBeUndefined()
  })

  it('判别优先级：value > confirmed > cancelled（复合形状按 value 取）', () => {
    const frame = buildUiResponseFrame('r5', { value: 'v', confirmed: true })
    expect(JSON.parse(frame!)).toEqual({ type: 'extension_ui_response', id: 'r5', value: 'v' })
  })

  it('序列化失败（循环引用/BigInt）→ onSerializeError 出声 + 降级 cancelled', () => {
    const onSerializeError = vi.fn()
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const frame = buildUiResponseFrame('r6', { value: circular }, { onSerializeError })
    expect(JSON.parse(frame!)).toEqual({ type: 'extension_ui_response', id: 'r6', cancelled: true })
    expect(onSerializeError).toHaveBeenCalledTimes(1)
    // 降级路径自身不受坏值影响（catch 后构造纯数据帧）
    expect(() => JSON.parse(frame!)).not.toThrow()
  })

  it('value 为合法 JSON 字符串 → 原样透传不二次转义', () => {
    const payload = JSON.stringify({ q: 'ans' })
    const frame = buildUiResponseFrame('r7', { value: payload })
    expect(JSON.parse(frame!).value).toBe(payload)
  })
})

describe('buildExtensionUiResponsePayload（主 agent / bridge 形态：raw + method 判别）', () => {
  it('response === null → cancelled:true（取消/超时，无论 method）', () => {
    expect(buildExtensionUiResponsePayload('r1', null)).toEqual({
      type: 'extension_ui_response', id: 'r1', cancelled: true,
    })
    expect(buildExtensionUiResponsePayload('r2', null, 'confirm')).toEqual({
      type: 'extension_ui_response', id: 'r2', cancelled: true,
    })
  })

  it("method === 'confirm' → confirmed:boolean（原值透传）", () => {
    expect(buildExtensionUiResponsePayload('r3', true, 'confirm')).toEqual({
      type: 'extension_ui_response', id: 'r3', confirmed: true,
    })
    expect(buildExtensionUiResponsePayload('r4', false, 'confirm').confirmed).toBe(false)
  })

  it('其余（select/input/editor）→ value:String(response)（对象 String 化为 [object Object] 是调用方序列化责任）', () => {
    expect(buildExtensionUiResponsePayload('r5', 'option-a')).toEqual({
      type: 'extension_ui_response', id: 'r5', value: 'option-a',
    })
    const objValue = buildExtensionUiResponsePayload('r6', { a: 1 }, 'select').value
    expect(objValue).toBe('[object Object]')
  })
})
