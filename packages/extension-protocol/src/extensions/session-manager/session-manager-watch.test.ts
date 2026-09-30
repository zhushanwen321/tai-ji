import { describe, it, expect } from 'vitest'
import { isChannelErrorResult, formatChannelErrorText } from '../../core/select-rpc'
import { SESSION_MANAGER_ACTIONS } from './marker'
import {
  isSessionManagerNotifyId,
  isSessionManagerWatchParams,
  isSessionManagerWatchRespondPayload,
  isSessionManagerSendParams,
  isSessionManagerCreateParams,
} from './types'
import type { SessionManagerWatchRespondPayload, SessionManagerWatchReason } from './types'

/**
 * notify-once U1 协议契约：watch action（单键寻址 + notifyId 形态入站自检）、
 * send/create optional-notifyId 守卫、watch respond payload、error envelope。
 *
 * boundary 帧全覆盖（任务红线）：空载荷 / 非法 notifyId 形态 / 缺字段 / 超限——
 * 全部在协议层守卫上钉死，不只测 happy-path。
 */

const VALID_NOTIFY_ID = 'sm-123e4567-e89b-12d3-a456-426614174000'

describe('watch action 入站集合', () => {
  it('SESSION_MANAGER_ACTIONS 含 watch（event-adapter 收窄面——缺席即折叠 __malformed__）', () => {
    expect(SESSION_MANAGER_ACTIONS).toContain('watch')
    expect(SESSION_MANAGER_ACTIONS).toHaveLength(7)
  })
})

describe('isSessionManagerNotifyId 形态入站自检（lifetimeNotifyId 同一函数）', () => {
  it('happy-path：sm- + RFC4122 十六进制 UUID 通过（大小写不敏感）', () => {
    expect(isSessionManagerNotifyId(VALID_NOTIFY_ID)).toBe(true)
    expect(isSessionManagerNotifyId('sm-123E4567-E89B-12D3-A456-426614174000')).toBe(true)
  })

  it('boundary：非 string（缺字段语义的另一面）一律拒绝', () => {
    expect(isSessionManagerNotifyId(undefined)).toBe(false)
    expect(isSessionManagerNotifyId(null)).toBe(false)
    expect(isSessionManagerNotifyId(42)).toBe(false)
    expect(isSessionManagerNotifyId({ notifyId: VALID_NOTIFY_ID })).toBe(false)
    expect(isSessionManagerNotifyId([VALID_NOTIFY_ID])).toBe(false)
  })

  it('boundary：非法形态（空串 / 错前缀 / 非 UUID 体 / 截断）拒绝', () => {
    expect(isSessionManagerNotifyId('')).toBe(false)
    expect(isSessionManagerNotifyId('sm-')).toBe(false)
    expect(isSessionManagerNotifyId('not-sm-prefixed-uuid')).toBe(false)
    expect(isSessionManagerNotifyId('bt-123e4567-e89b-12d3-a456-426614174000')).toBe(false)
    expect(isSessionManagerNotifyId('sm-not-a-uuid')).toBe(false)
    expect(isSessionManagerNotifyId('sm-123e4567-e89b-12d3-a456')).toBe(false) // 截断
    expect(isSessionManagerNotifyId('sm-123e4567e89b12d3a456426614174000')).toBe(false) // 缺分段
  })

  it('boundary：超限（10KB 注入帧）拒绝——形状构造性钉死 39 字符，无独立长度条款也不漏', () => {
    const oversized = `sm-${'a'.repeat(10_000)}`
    expect(oversized.length).toBeGreaterThan(39)
    expect(isSessionManagerNotifyId(oversized)).toBe(false)
  })
})

describe('isSessionManagerWatchParams（封闭单键 + 形态自检）', () => {
  it('happy-path：{notifyId} 单键通过', () => {
    expect(isSessionManagerWatchParams({ notifyId: VALID_NOTIFY_ID })).toBe(true)
  })

  it('boundary：空载荷 / 非 record 拒绝', () => {
    expect(isSessionManagerWatchParams({})).toBe(false)
    expect(isSessionManagerWatchParams(null)).toBe(false)
    expect(isSessionManagerWatchParams(undefined)).toBe(false)
    expect(isSessionManagerWatchParams('watch')).toBe(false)
    expect(isSessionManagerWatchParams([{ notifyId: VALID_NOTIFY_ID }])).toBe(false) // 排数组严版
  })

  it('boundary：缺字段（无 notifyId / 键名错）拒绝', () => {
    expect(isSessionManagerWatchParams({ sessionId: 's' })).toBe(false)
    expect(isSessionManagerWatchParams({ notify_id: VALID_NOTIFY_ID })).toBe(false)
  })

  it('boundary：非法 notifyId 形态（缺 sm- 前缀 / 非 string / 超限）拒绝', () => {
    expect(isSessionManagerWatchParams({ notifyId: '123e4567-e89b-12d3-a456-426614174000' })).toBe(false)
    expect(isSessionManagerWatchParams({ notifyId: 42 })).toBe(false)
    expect(isSessionManagerWatchParams({ notifyId: `sm-${'a'.repeat(500)}` })).toBe(false)
  })

  it('单键寻址：夹带 parentSid/sessionId 等额外字段拒绝（parentSid 归 runtime 连接身份，协议面不定义）', () => {
    expect(isSessionManagerWatchParams({ notifyId: VALID_NOTIFY_ID, parentSid: 'sid-parent' })).toBe(false)
    expect(isSessionManagerWatchParams({ notifyId: VALID_NOTIFY_ID, sessionId: 'child' })).toBe(false)
  })

  it('lifetime 同形态：runtime 生成的 lifetimeNotifyId 过同一守卫（防 kind=lifetime watch 被自检拒掉）', () => {
    const lifetimeNotifyId = 'sm-9f2c4a10-11aa-4bbb-8ccc-426614174999'
    expect(isSessionManagerNotifyId(lifetimeNotifyId)).toBe(true)
    expect(isSessionManagerWatchParams({ notifyId: lifetimeNotifyId })).toBe(true)
  })
})

describe('send/create optional-notifyId 守卫（缺省放行 + 类型面，形态归 arm 判据）', () => {
  it('send：notifyId 缺省 → 守卫通过（缺省不 arm，不构成 params 错误）', () => {
    expect(isSessionManagerSendParams({ sessionId: 's', prompt: 'p' })).toBe(true)
  })

  it('send：notifyId 形态合法 → 通过', () => {
    expect(
      isSessionManagerSendParams({ sessionId: 's', prompt: 'p', notifyId: VALID_NOTIFY_ID }),
    ).toBe(true)
  })

  it('send：notifyId 形态畸形（字符串）→ params 守卫仍通过（畸形 → 不 arm + willNotify:false，动作照常）', () => {
    expect(isSessionManagerSendParams({ sessionId: 's', prompt: 'p', notifyId: 'garbage' })).toBe(true)
    // arm 判据（runtime 受理点消费同一函数）对畸形串返回 false —— 两层职责分工
    expect(isSessionManagerNotifyId('garbage')).toBe(false)
  })

  it('send：notifyId 非 string（类型违规）→ 拒绝（error envelope 路径）', () => {
    expect(isSessionManagerSendParams({ sessionId: 's', prompt: 'p', notifyId: 42 })).toBe(false)
    expect(isSessionManagerSendParams({ sessionId: 's', prompt: 'p', notifyId: { id: 'x' } })).toBe(false)
    // 必填字段缺失照旧拒绝（既有契约不松动）
    expect(isSessionManagerSendParams({ prompt: 'p' })).toBe(false)
    expect(isSessionManagerSendParams({})).toBe(false)
  })

  it('create：notifyId 三态（缺省 / 合法 / 形态畸形字符串）通过，非 string 拒绝', () => {
    expect(isSessionManagerCreateParams({ cwd: '/tmp' })).toBe(true)
    expect(isSessionManagerCreateParams({ prompt: 'do it', notifyId: VALID_NOTIFY_ID })).toBe(true)
    expect(isSessionManagerCreateParams({ prompt: 'do it', notifyId: 'garbage' })).toBe(true)
    expect(isSessionManagerCreateParams({ notifyId: 7 })).toBe(false)
    expect(isSessionManagerCreateParams(null)).toBe(false)
  })
})

describe('watch respond payload（sessionId 回带 + meta 可选字段）', () => {
  it('settle 兑现应答：reason + sessionId 回带 + settleSeq + fulfillsN，wire 往返无损', () => {
    const payload: SessionManagerWatchRespondPayload = {
      reason: 'completed',
      sessionId: 'child-a1b2',
      settleSeq: 3,
      fulfillsN: 2,
    }
    expect(isSessionManagerWatchRespondPayload(payload)).toBe(true)
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('death 应答：deathSeq + fulfillsN + exitCode + stderrTail 全 additive meta 可选', () => {
    const payload: SessionManagerWatchRespondPayload = {
      reason: 'exited',
      sessionId: 'child-a1b2',
      deathSeq: 1,
      fulfillsN: 1,
      exitCode: 1,
      stderrTail: 'FATAL: boom',
    }
    expect(isSessionManagerWatchRespondPayload(payload)).toBe(true)
    // exitCode 可为 null（信号杀无退出码形态）
    expect(isSessionManagerWatchRespondPayload({ reason: 'deleted', sessionId: 's', exitCode: null })).toBe(true)
  })

  it('fail-closed 查无 claim：{reason: cancelled} 无 sessionId 也合法（该路径静默不消费 sessionId）', () => {
    expect(isSessionManagerWatchRespondPayload({ reason: 'cancelled' })).toBe(true)
    expect(isSessionManagerWatchRespondPayload({ reason: 'orphaned', sessionId: 's' })).toBe(true)
  })

  it('类型面：sessionFilePath 携/不携两形态均合法（additive optional，D9 Full transcript 指针行数据源）', () => {
    const withPath: SessionManagerWatchRespondPayload = {
      reason: 'exited',
      sessionId: 'child-a1b2',
      deathSeq: 1,
      fulfillsN: 1,
      sessionFilePath: '/data/agent/sessions/child-a1b2.jsonl',
    }
    const withoutPath: SessionManagerWatchRespondPayload = { reason: 'cancelled' }
    expect(withPath.sessionFilePath).toContain('child-a1b2.jsonl')
    expect(withoutPath.sessionFilePath).toBeUndefined()
    // wire 往返（select value 通道 JSON）
    expect(JSON.parse(JSON.stringify(withPath))).toEqual(withPath)
  })

  it('守卫：sessionFilePath 缺席放行、string 放行、类型不符拒绝', () => {
    expect(isSessionManagerWatchRespondPayload({ reason: 'completed', sessionId: 's' })).toBe(true)
    expect(
      isSessionManagerWatchRespondPayload({
        reason: 'completed',
        sessionId: 's',
        sessionFilePath: '/data/agent/sessions/s.jsonl',
      }),
    ).toBe(true)
    expect(
      isSessionManagerWatchRespondPayload({ reason: 'completed', sessionId: 's', sessionFilePath: 42 }),
    ).toBe(false)
  })

  it('7 值 reason 词表逐个通过（与 mapReasonToStatus 4 新 case 同词形）', () => {
    const reasons: SessionManagerWatchReason[] = [
      'completed',
      'failed',
      'stopped',
      'exited',
      'deleted',
      'cancelled',
      'orphaned',
    ]
    for (const reason of reasons) {
      expect(isSessionManagerWatchRespondPayload({ reason, sessionId: 's' })).toBe(true)
    }
  })

  it('boundary：null（旧 runtime 兼容象限 respond null）/ 空载荷 / 词表外 reason 拒绝', () => {
    expect(isSessionManagerWatchRespondPayload(null)).toBe(false)
    expect(isSessionManagerWatchRespondPayload(undefined)).toBe(false)
    expect(isSessionManagerWatchRespondPayload({})).toBe(false)
    expect(isSessionManagerWatchRespondPayload({ sessionId: 's' })).toBe(false) // 缺 reason
    expect(isSessionManagerWatchRespondPayload({ reason: 'stopped ', sessionId: 's' })).toBe(false)
    expect(isSessionManagerWatchRespondPayload({ reason: 42 })).toBe(false)
    expect(isSessionManagerWatchRespondPayload('{"reason":"completed"}')).toBe(false)
  })

  it('boundary：meta 类型不符拒绝（deathSeq 字符串 / exitCode 字符串 / stderrTail 非 string）', () => {
    expect(isSessionManagerWatchRespondPayload({ reason: 'completed', sessionId: 's', deathSeq: 'x' })).toBe(false)
    expect(isSessionManagerWatchRespondPayload({ reason: 'exited', sessionId: 's', exitCode: '1' })).toBe(false)
    expect(isSessionManagerWatchRespondPayload({ reason: 'exited', sessionId: 's', stderrTail: 9 })).toBe(false)
    expect(isSessionManagerWatchRespondPayload({ reason: 'completed', sessionId: 9 })).toBe(false)
  })
})

describe('error envelope（watch 守卫拒绝时 handler 错误闭环的回包形状）', () => {
  it('watch 非法 params 的 error envelope：{error} 可被 isChannelErrorResult 检测并格式化', () => {
    // handler dispatch 对 isParams false 抛错 → handle respond({error}) 走同一 select value 通道
    const envelope = { error: "invalid params for session-manager action 'watch'" }
    expect(isChannelErrorResult(envelope)).toBe(true)
    expect(formatChannelErrorText(envelope)).toContain("'watch'")
  })

  it('带 hint/sessionId 的扩展 envelope（create 已成功分支）仍被同一守卫捕获', () => {
    const envelope = {
      error: 'prompt failed',
      hint: 'use send_to_session to retry',
      sessionId: 'child-1',
    }
    expect(isChannelErrorResult(envelope)).toBe(true)
    expect(formatChannelErrorText(envelope)).toContain('hint: use send_to_session to retry')
  })

  it('envelope 与 respond payload 互不误判（判别字段正交：error vs reason）', () => {
    const envelope = { error: "invalid params for session-manager action 'watch'" }
    const payload: SessionManagerWatchRespondPayload = { reason: 'completed', sessionId: 's' }
    expect(isSessionManagerWatchRespondPayload(envelope)).toBe(false) // 无 reason
    expect(isChannelErrorResult(payload)).toBe(false) // 无 error
    expect(isChannelErrorResult({})).toBe(false) // 空载荷
    expect(isChannelErrorResult(null)).toBe(false)
  })
})
