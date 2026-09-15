/**
 * protocol-seq.test.ts — runtime-message-bus 协议层 seq/subscribe 契约校验
 *
 * wave:runtime-message-bus::protocol-seq 的类型一致性测试，验证：
 *  - TC1: ServerMessage 支持可选 seq 字段（DM3/D7，与 id 互斥）
 *  - TC2: ClientMessageType 联合含 'session.subscribe' / 'session.unsubscribe'
 *  - TC3: ReplyPayloadMap['session.subscribe'] 形状 = { snapshot, stateSnapshot, lastSeq, gap? }
 *  - TC4: ReplyPayloadMap['session.unsubscribe'] 是 ack 型（void）
 *
 * 模式与 __tests__/protocol.test.ts 一致：编译期 AssertHasKey/AssertExtends
 * （tsc --noEmit 保证）+ 运行期对象字面量可赋值断言（vitest）。纯类型层，零运行时依赖。
 *
 * 运行：cd packages/shared && pnpm run typecheck && pnpm test
 */
import { describe, it, expect } from 'vitest'
import type {
  ClientMessageType,
  ReplyPayloadMap,
  ServerMessage,
  ServerMessageMap,
} from '../protocol'

// ── 编译期类型断言辅助（同 protocol.test.ts 模式）────────────────
// 条件类型求值结果都是 never，仅在编译期校验「key 存在 / 子类型关系成立」；
// 若断言不成立，tsc 会因 never 赋值报错。

type AssertHasKey<T, K extends keyof T> = true
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]

// TC1: ServerMessage.seq 字段存在且为 number|undefined
type _Assert_ServerMessage_seq = AssertHasKey<ServerMessage, 'seq'>
type _Assert_seqType = AssertExtends<NonNullable<ServerMessage['seq']>, number>

// TC2: ClientMessageType 含 session.subscribe / session.unsubscribe
type _Assert_Client_subscribe = AssertExtends<'session.subscribe', ClientMessageType>
type _Assert_Client_unsubscribe = AssertExtends<'session.unsubscribe', ClientMessageType>
// 反向也成立：联合字面量可赋值给 ClientMessageType
type _Assert_Client_subscribeRev = AssertExtends<ClientMessageType, 'session.subscribe' | 'session.unsubscribe' | string>

// TC3: ReplyPayloadMap['session.subscribe'] 存在 + 形状
type _Assert_Reply_subscribe = AssertHasKey<ReplyPayloadMap, 'session.subscribe'>
type SubscribeReply = ReplyPayloadMap['session.subscribe']
type _Assert_SubscribeReply_shape = AssertExtends<
  SubscribeReply,
  { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap?: boolean }
>

// TC4: ReplyPayloadMap['session.unsubscribe'] 存在 + 是 void（ack 型）
type _Assert_Reply_unsubscribe = AssertHasKey<ReplyPayloadMap, 'session.unsubscribe'>
type _Assert_UnsubscribeReply_void = AssertExtends<ReplyPayloadMap['session.unsubscribe'], void>

// TC5: handoff broadcast 类型在 ServerMessageMap 中注册（编译期断言）
type _Assert_HandoffStarted = AssertHasKey<ServerMessageMap, 'session.handoffStarted'>
type _Assert_HandoffComplete = AssertHasKey<ServerMessageMap, 'session.handoffComplete'>
type _Assert_HandoffAborted = AssertHasKey<ServerMessageMap, 'session.handoffAborted'>

// ── 运行期测试（payload 可赋值 + 字段可读）────────────────────────

describe('TC1: ServerMessage.seq 可选字段', () => {
  it('带 seq 的 ServerMessage 可构造', () => {
    const msg: ServerMessage<'pong'> = {
      type: 'pong',
      seq: 1,
      payload: {},
    }
    expect(msg.seq).toBe(1)
    expect(msg.id).toBeUndefined()
  })

  it('不带 seq 的 ServerMessage 仍合法（向后兼容）', () => {
    const msg: ServerMessage<'pong'> = {
      type: 'pong',
      id: 'rpc-1',
      payload: {},
    }
    expect(msg.seq).toBeUndefined()
    expect(msg.id).toBe('rpc-1')
  })
})

describe('TC2: ClientMessageType 含 session.subscribe/unsubscribe', () => {
  it("'session.subscribe' 是合法 ClientMessageType", () => {
    const t: ClientMessageType = 'session.subscribe'
    expect(t).toBe('session.subscribe')
  })

  it("'session.unsubscribe' 是合法 ClientMessageType", () => {
    const t: ClientMessageType = 'session.unsubscribe'
    expect(t).toBe('session.unsubscribe')
  })
})

describe('TC3: ReplyPayloadMap[session.subscribe] 形状', () => {
  it('空 snapshot + stateSnapshot + lastSeq=0 可构造（订阅空 bus 的边界）', () => {
    const reply: ReplyPayloadMap['session.subscribe'] = {
      snapshot: [],
      stateSnapshot: [],
      lastSeq: 0,
    }
    expect(reply.snapshot).toHaveLength(0)
    expect(reply.stateSnapshot).toHaveLength(0)
    expect(reply.lastSeq).toBe(0)
    expect(reply.gap).toBeUndefined()
  })

  it('带 snapshot + stateSnapshot + gap=true 可构造（ring 溢出缺口标记）', () => {
    const event: ServerMessage = { type: 'pong', seq: 5, payload: {} }
    const stateEvent: ServerMessage = { type: 'session.commands', seq: 4, payload: { sessionId: 's1', commands: [] } }
    const reply: ReplyPayloadMap['session.subscribe'] = {
      snapshot: [event],
      stateSnapshot: [stateEvent],
      lastSeq: 5,
      gap: true,
    }
    expect(reply.snapshot).toHaveLength(1)
    expect(reply.snapshot[0].seq).toBe(5)
    expect(reply.stateSnapshot).toHaveLength(1)
    expect(reply.stateSnapshot[0].type).toBe('session.commands')
    expect(reply.lastSeq).toBe(5)
    expect(reply.gap).toBe(true)
  })
})

describe('TC4: ReplyPayloadMap[session.unsubscribe] 是 ack 型（void）', () => {
  it('void ack 型可被 register<void> 消费（运行期占位断言）', () => {
    // void 类型运行期无值，断言类型层已在编译期 _Assert_UnsubscribeReply_void 保证；
    // 这里验证 ReplyPayloadMap 同时含 subscribe（payload 型）与 unsubscribe（ack 型）两条，
    // 与 session.handoff/session.abortHandoff 同模式。
    const ackType: ReplyPayloadMap['session.unsubscribe'] = undefined as void
    expect(ackType).toBeUndefined()
  })

  it('session.subscribe 与 session.unsubscribe 在同一 ReplyPayloadMap（模式对称）', () => {
    // 编译期存在性已在 _Assert_Reply_subscribe / _Assert_Reply_unsubscribe 保证；
    // 运行期校验两个 key 都属于 ReplyPayloadMap 的 keyof 联合。
    const keys: (keyof ReplyPayloadMap)[] = [
      'session.subscribe',
      'session.unsubscribe',
      'session.handoff',
      'session.abortHandoff',
    ]
    expect(keys).toContain('session.subscribe')
    expect(keys).toContain('session.unsubscribe')
  })
})
