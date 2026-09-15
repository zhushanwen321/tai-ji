import { describe, it, expect } from 'vitest'
import {
  isBridgeErrorResponse,
  isBridgeToolExecuteResponse,
  isBridgeSyncPayload,
  isBridgeInterceptResponse,
  isSyncedTool,
} from './guards'

/**
 * 回包形状守卫族钉值（D11 迁入后守卫与类型同住本模块）。正例形态照
 * plugin-bridge 现有测试的回包夹具（sync-and-registration / forwarding）；
 * 守卫是信任边界（回包经 select 通道 JSON 往返，外部可控），负例钉死
 * 排数组 / 字段类型不符的拒绝行为，防后续改动静默放宽。
 */
describe('plugin-bridge 回包形状守卫族', () => {
  it('isBridgeErrorResponse：{error}（hint 可选）通过；缺 error 字符串 / 数组拒绝', () => {
    expect(isBridgeErrorResponse({ error: 'Plugin system not available' })).toBe(true)
    expect(isBridgeErrorResponse({ error: 'Plugin system not available', hint: 'check runtime logs' })).toBe(true)
    expect(isBridgeErrorResponse({ hint: 'error field missing' })).toBe(false)
    expect(isBridgeErrorResponse([{ error: 'array is not a record' }])).toBe(false)
    expect(isBridgeErrorResponse(null)).toBe(false)
  })

  it('isBridgeToolExecuteResponse：{content, isError?} 通过；content 非 string / isError 非 boolean 拒绝', () => {
    expect(isBridgeToolExecuteResponse({ content: 'done' })).toBe(true)
    expect(isBridgeToolExecuteResponse({ content: 'boom', isError: true })).toBe(true)
    expect(isBridgeToolExecuteResponse({ content: 42 })).toBe(false)
    expect(isBridgeToolExecuteResponse({ content: 'boom', isError: 'yes' })).toBe(false)
  })

  it('isBridgeSyncPayload：{tools, success:true} 通过；success 非 true / tools 非数组拒绝', () => {
    expect(
      isBridgeSyncPayload({
        tools: [{ name: 'sleep-tool', description: 'Sleep for a duration', parameters: { type: 'object' } }],
        success: true,
      }),
    ).toBe(true)
    expect(isBridgeSyncPayload({ tools: [], success: false })).toBe(false)
    expect(isBridgeSyncPayload({ tools: {}, success: true })).toBe(false)
  })

  it('isBridgeInterceptResponse：{injectedMessages}（blocked/reason 可选）通过；缺 injectedMessages 拒绝', () => {
    expect(isBridgeInterceptResponse({ injectedMessages: [] })).toBe(true)
    expect(isBridgeInterceptResponse({ blocked: true, reason: 'policy', injectedMessages: [{ content: 'x' }] })).toBe(true)
    expect(isBridgeInterceptResponse({ blocked: true })).toBe(false)
    expect(isBridgeInterceptResponse('not a record')).toBe(false)
  })

  it('isSyncedTool：{name, description, parameters:{type:"object"}} 通过；顶层 type 非 object 拒绝', () => {
    expect(isSyncedTool({ name: 'sleep-tool', description: 'Sleep for a duration', parameters: { type: 'object', properties: { ms: { type: 'number' } } } })).toBe(true)
    expect(isSyncedTool({ name: 'bad-schema', description: 'top-level not object', parameters: { type: 'string' } })).toBe(false)
    expect(isSyncedTool({ name: 42, description: 'name not string', parameters: { type: 'object' } })).toBe(false)
  })
})
