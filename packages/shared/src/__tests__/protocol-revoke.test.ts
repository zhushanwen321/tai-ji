/**
 * 消息撤回（message revoke）协议契约测试（U3，设计 §3.3 D2/D8——D8 错误规格表为 SSOT）。
 *
 * 验证 protocol.ts 的 session.revokeMessage 契约三层：
 * ① reply 成功 / 六错误码形态的判别 union（类型级收窄 + 运行时断言）；
 * ② 错误码字面量闭集与 D8 表逐字对齐（快照式锚定 + 类型级双向穷举）；
 * ③ targetId 两形态（u- 前缀 clientUuid / 8 位 hex pi entryId）的请求序列化往返。
 * 纯契约层验证，不涉及 runtime 编排（U4 交付后另有编排单测）。
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  ClientMessage,
  ReplyPayloadMap,
  ServerMessage,
  RevokeMessageErrorCode,
  SessionRevokeMessageReply,
} from '../protocol'
import { TAIJI_NAV_COMMAND } from '../protocol'
// 跨包可达性守卫：index.ts 对 protocol.ts 是显式 allowlist（非 export *），下游消费方
// 只能经包根入口取符号——漏登记时值导入在解析期红、类型导入在 tsc 红。别名避免与
// '../protocol' 直连导入同名冲突。
import { TAIJI_NAV_COMMAND as TAIJI_NAV_COMMAND_FROM_ROOT } from '../index'
import type {
  RevokeMessageErrorCode as RevokeMessageErrorCodeFromRoot,
  SessionRevokeMessageReply as SessionRevokeMessageReplyFromRoot,
} from '../index'

/**
 * D8 错误规格表六错误码（逐字）。表共七行——另一样是成功行 `revoked: true`，
 * 非错误码；改码 / 加码须先改设计表，再同步 protocol.ts 与本锚定集（类型级
 * 双向穷举让漂移在编译期红，快照式 toEqual 让字面量变动在运行时红）。
 */
const D8_ERROR_CODES = [
  'busy',
  'no-mapping',
  'extension-missing',
  'nav-failed',
  'pi-reclaimed',
  'workflow-running',
] as const

type RevokeOkArm = Extract<SessionRevokeMessageReply, { revoked: true }>
type RevokeErrArm = Extract<SessionRevokeMessageReply, { revoked: false }>

describe('session.revokeMessage 协议契约（U3，D8 SSOT）', () => {
  it('错误码字面量穷举：与 D8 错误规格表六码逐字一致（快照式锚定）', () => {
    expect([...D8_ERROR_CODES]).toEqual([
      'busy',
      'no-mapping',
      'extension-missing',
      'nav-failed',
      'pi-reclaimed',
      'workflow-running',
    ])
    // 类型级双向穷举：协议联合 ⊇ 且 ⊆ 锚定集
    expectTypeOf<RevokeMessageErrorCode>().toEqualTypeOf<(typeof D8_ERROR_CODES)[number]>()
  })

  it('reply 判别 union：成功臂 revoked:true 收窄出 content（剥标记后的用户原文）', () => {
    // 两臂覆盖全联合（无第三形态），content 仅存在于成功臂
    expectTypeOf<RevokeOkArm | RevokeErrArm>().toEqualTypeOf<SessionRevokeMessageReply>()
    expectTypeOf<RevokeOkArm['content']>().toEqualTypeOf<string>()

    const reply: SessionRevokeMessageReply = {
      sessionId: 's1',
      revoked: true,
      content: '帮我写个排序',
    }
    if (reply.revoked) {
      expect(reply.content).toBe('帮我写个排序')
    } else {
      throw new Error('unreachable：revoked:true 下错误臂不可达')
    }
  })

  it.each([...D8_ERROR_CODES])('reply 判别 union：错误臂 revoked:false + error=%s', (code) => {
    expectTypeOf<RevokeErrArm['error']>().toEqualTypeOf<RevokeMessageErrorCode>()

    const reply: SessionRevokeMessageReply = { sessionId: 's1', revoked: false, error: code }
    if (!reply.revoked) {
      expect(reply.error).toBe(code)
      expect(reply.sessionId).toBe('s1')
    } else {
      throw new Error('unreachable：revoked:false 下成功臂不可达')
    }
  })

  it('ServerMessage 载体：reply type 与 request 同名，ReplyPayloadMap 已登记（command 返回类型推导源）', () => {
    const msg: ServerMessage<'session.revokeMessage'> = {
      type: 'session.revokeMessage',
      id: 'r1',
      payload: { sessionId: 's1', revoked: true, content: '原文' },
    }
    expect(msg.type).toBe('session.revokeMessage')
    expect(msg.payload.revoked).toBe(true)
    expectTypeOf<ReplyPayloadMap['session.revokeMessage']>().toEqualTypeOf<SessionRevokeMessageReply>()
  })

  it('boundary：targetId live 形态（u- 前缀 clientUuid）请求序列化往返', () => {
    const targetId = 'u-3f2b8a4e-1c9d-4e7a-9f0b-2d5c8e1a7b3f'
    const msg: ClientMessage = {
      type: 'session.revokeMessage',
      id: 'req-1',
      payload: { sessionId: 's1', targetId },
    }
    // WS 通道走 JSON 序列化：往返后 type 判别与两形态 targetId 均无损
    const round = JSON.parse(JSON.stringify(msg)) as typeof msg
    expect(round).toEqual(msg)
    const payload = (round as Extract<ClientMessage, { type: 'session.revokeMessage' }>).payload
    expect(payload).toEqual({ sessionId: 's1', targetId })
    expect(payload.targetId.startsWith('u-')).toBe(true)
  })

  it('boundary：targetId 基线/重开形态（8 位 hex pi entryId）请求序列化往返', () => {
    const targetId = 'c8d048cb'
    const msg: ClientMessage = {
      type: 'session.revokeMessage',
      id: 'req-2',
      payload: { sessionId: 's1', targetId },
    }
    const round = JSON.parse(JSON.stringify(msg)) as typeof msg
    expect(round).toEqual(msg)
    const payload = (round as Extract<ClientMessage, { type: 'session.revokeMessage' }>).payload
    expect(payload).toEqual({ sessionId: 's1', targetId })
    expect(payload.targetId).toMatch(/^[0-9a-f]{8}$/)
  })

  it('TAIJI_NAV_COMMAND 命令串常量与 agent-ext 注册名逐字一致（D1 信令通道）', () => {
    expect(TAIJI_NAV_COMMAND).toBe('__taiji_nav__')
  })

  it('跨包可达性：三个新符号经包根入口（src/index.ts allowlist）可导入且形状一致', () => {
    expect(TAIJI_NAV_COMMAND_FROM_ROOT).toBe('__taiji_nav__')
    expectTypeOf(TAIJI_NAV_COMMAND_FROM_ROOT).toEqualTypeOf<string>()
    // 根入口 re-export 与 protocol.ts 原始声明同一形状（防 re-export 处被改形）
    expectTypeOf<RevokeMessageErrorCodeFromRoot>().toEqualTypeOf<RevokeMessageErrorCode>()
    expectTypeOf<SessionRevokeMessageReplyFromRoot>().toEqualTypeOf<SessionRevokeMessageReply>()
  })
})
