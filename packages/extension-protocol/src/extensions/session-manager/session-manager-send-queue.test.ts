import { describe, it, expect } from 'vitest'
import type {
  SessionManagerSendResult,
  SessionManagerErrorResult,
  SessionManagerSendParams,
} from './types'
import { SESSION_MANAGER_ACTIONS } from './marker'

/**
 * A8: sd-u5 协议类型形状测试（SendResult {blocked, rejected} → {queued: true} + 错误形状）。
 *
 * 类型级断言（@ts-expect-error 锁旧形状拒绝）+ 运行时形状断言（JSON 往返——
 * select 通道的 wire 形态正是 JSON 字符串，协议形状即 wire 契约）。
 */
describe('A8-protocol-types-vitest: SendResult 排队语义的协议形状', () => {
  it('成功形状：{queued: true} 是唯一合法的 SendResult', () => {
    const result: SessionManagerSendResult = { queued: true }
    expect(result).toEqual({ queued: true })
    // wire 往返（handler respond 经 JSON.stringify 走 select 通道）
    expect(JSON.parse(JSON.stringify(result))).toEqual({ queued: true })
  })

  it('旧形状 {blocked, rejected} 被类型系统拒绝', () => {
    // @ts-expect-error - 旧拒绝形状不再可赋值（sd-u5 起 busy 排队，不拒绝）
    const oldResult: SessionManagerSendResult = { blocked: true, rejected: true }
    expect(oldResult).toBeDefined()
  })

  it('部分形状 {queued: false} 同样被拒绝（queued 是字面量 true）', () => {
    // @ts-expect-error - queued: false 不在 'queued: true' 判别内
    const notQueued: SessionManagerSendResult = { queued: false }
    expect(notQueued).toBeDefined()
  })

  it('错误形状：send 同步失败走 SessionManagerErrorResult（error + hint）', () => {
    const errorResult: SessionManagerErrorResult = {
      error: 'pi process died',
      hint: 'target session unreachable; retry send_to_session after checking get_session_status',
    }
    expect(errorResult.error).toBe('pi process died')
    expect(errorResult.hint).toContain('retry send_to_session')
    // wire 往返：agent 在工具结果里看到的正是这两个键
    expect(Object.keys(JSON.parse(JSON.stringify(errorResult))).sort()).toEqual(['error', 'hint'])
  })

  it('send params 形状不变（sessionId + prompt），action 集合含 send', () => {
    const params: SessionManagerSendParams = { sessionId: 's1', prompt: 'hello' }
    expect(params).toEqual({ sessionId: 's1', prompt: 'hello' })
    expect(SESSION_MANAGER_ACTIONS).toContain('send')
  })
})
