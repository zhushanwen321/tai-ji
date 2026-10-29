/**
 * session.historyCacheReady 广播帧协议契约测试（session-cold-switch-perf u-foundation，设计 §3.3-1）。
 *
 * 验证 protocol.ts 的帧名单点登记：
 * ① 字段完整性——帧名入 ServerMessageType 联合 + payload 三字段形状
 *   （sessionId / snapshotLeafId 必需，error 可选）经 ServerMessageMap 收窄；
 * ② error 可选形态——成功帧（省略 error）与失败帧（error 非空）两用皆可构造。
 * 纯契约层验证；runtime 构造点（u1）与 renderer 监听点（u3）引用同一类型定义。
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type { ServerMessage, ServerMessageMap, ServerMessageType } from '../protocol'
// 跨包可达性：index.ts 对 protocol.ts 是显式 allowlist（非 export *），协议联合经包根
// 入口 re-export（ServerMessageType 在 allowlist 内）——下游消费方按同形状导入。
import type { ServerMessageType as ServerMessageTypeFromRoot } from '../index'

// payload 类型查询 = ServerMessageMap SSOT 查询形态（ServerMessage<T> 是泛型接口非判别
// 联合，对它 Extract 不收窄——收窄联合是 ServerMessageUnion）。
type HistoryCacheReadyPayload = ServerMessageMap['session.historyCacheReady']

describe('session.historyCacheReady 协议契约（session-cold-switch-perf §3.3-1）', () => {
  it('字段完整性：帧名入 ServerMessageType（经包根入口可达），payload 三字段（sessionId/snapshotLeafId 必需 + error 可选）', () => {
    // 帧名对账由类型层承载：字面量不在联合内时 Extract 产 never，本行编译红
    expectTypeOf<Extract<ServerMessageType, 'session.historyCacheReady'>>().toEqualTypeOf<'session.historyCacheReady'>()
    expectTypeOf<Extract<ServerMessageTypeFromRoot, 'session.historyCacheReady'>>().toEqualTypeOf<'session.historyCacheReady'>()
    // payload 收窄为具名形状（未在 ServerMessageMapBase 登记时落 Record<string, unknown> 占位，本行红）
    expectTypeOf<HistoryCacheReadyPayload>().toEqualTypeOf<{
      sessionId: string
      snapshotLeafId: string
      error?: string
    }>()

    const msg: ServerMessage<'session.historyCacheReady'> = {
      type: 'session.historyCacheReady',
      id: 'b1',
      payload: { sessionId: 's1', snapshotLeafId: 'c8d048cb', error: 'rebuild failed' },
    }
    expect(msg.type).toBe('session.historyCacheReady')
    expect(msg.payload.sessionId).toBe('s1')
    expect(msg.payload.snapshotLeafId).toBe('c8d048cb')
    expect(msg.payload.error).toBe('rebuild failed')
  })

  it('error 可选形态：成功帧省略 error 可构造（renderer 据 error 是否缺省分流重拉/收敛）', () => {
    const msg: ServerMessage<'session.historyCacheReady'> = {
      type: 'session.historyCacheReady',
      id: 'b2',
      payload: { sessionId: 's1', snapshotLeafId: 'c8d048cb' },
    }
    expect('error' in msg.payload).toBe(false)
    expect(msg.payload.error).toBeUndefined()
  })
})
