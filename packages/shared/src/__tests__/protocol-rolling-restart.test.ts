/**
 * protocol-rolling-restart.test.ts — 滚动重启协议契约校验（crash-forensics-and-watchdog
 * §3.3 D5，u7b 定类型契约、u7c 实现状态机、u7d 消费横幅）。
 *
 * 验证 shared/protocol.ts 三组扩展的类型形状（消费方落地前的契约锚点）：
 *  - TC1: ClientMessageType / ClientMessageMap 含 'rollingRestart.status'（无参只读查询）
 *  - TC2: ServerMessageType 含 'rollingRestart.status'（reply 同名）+ 两个推送事件
 *         'rollingRestart:deferred' / 'rollingRestart:forced'（Server→Client 冒号 camelCase）
 *  - TC3: ServerMessageMap 三条目形状 = state 四值 + reason 值域 + 在途摘要（inFlight 可 null）
 *  - TC4: ReplyPayloadMap['rollingRestart.status'] 与 ServerMessageMap 同形（payload 消费型）
 *  - TC5: 两推送事件不在 ReplyPayloadMap（是广播不是 RPC reply）
 *
 * 模式与 __tests__/protocol-occupancy.test.ts 一致：编译期 AssertExtends（tsc --noEmit 保证）
 * + 运行期对象字面量可赋值断言（vitest）。纯类型层，零运行时依赖。
 *
 * 运行：cd packages/shared && pnpm run typecheck && pnpm vitest run
 */
import { describe, it, expect } from 'vitest'
import type {
  ClientMessageMap,
  ClientMessageType,
  ReplyPayloadMap,
  RollingRestartDeferredPayload,
  RollingRestartForcedPayload,
  RollingRestartReason,
  RollingRestartState,
  RollingRestartStatusPayload,
  ServerMessage,
  ServerMessageMap,
  ServerMessageType,
} from '../protocol'

// ── 编译期类型断言辅助（同 protocol-occupancy.test.ts 模式）────────
type AssertHasKey<T, K extends keyof T> = true
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]
type AssertNotHasKey<T, K extends PropertyKey> = K extends keyof T ? ['ERROR: key present', K] : true

// TC1: 请求类型登记
type _Assert_StatusRequest = AssertExtends<'rollingRestart.status', ClientMessageType>
type _Assert_StatusRequestKey = AssertHasKey<ClientMessageMap, 'rollingRestart.status'>
// 无参查询（空请求载荷，对齐 config.sessions 的 Record<string, never> 形态）
type _Assert_StatusRequestPayload = AssertExtends<ClientMessageMap['rollingRestart.status'], Record<string, never>>

// TC2: 响应/推送类型登记
type _Assert_StatusReply = AssertExtends<'rollingRestart.status', ServerMessageType>
type _Assert_DeferredEvent = AssertExtends<'rollingRestart:deferred', ServerMessageType>
type _Assert_ForcedEvent = AssertExtends<'rollingRestart:forced', ServerMessageType>

// TC3: payload 形状（server map）
type _Assert_StatusMapKey = AssertHasKey<ServerMessageMap, 'rollingRestart.status'>
type _Assert_StatusShape = AssertExtends<
  ServerMessageMap['rollingRestart.status'],
  { state: RollingRestartState; reason?: RollingRestartReason; inflight: { inFlight: number | null }; deferDeadlineAt?: number }
>
type _Assert_DeferredShape = AssertExtends<
  ServerMessageMap['rollingRestart:deferred'],
  { reason: 'inflight' | 'absent-report'; inflight: { inFlight: number | null }; deferDeadlineAt: number }
>
type _Assert_ForcedShape = AssertExtends<
  ServerMessageMap['rollingRestart:forced'],
  { reason: 'hard-threshold' | 'defer-limit'; inflight: { inFlight: number | null } }
>
// ServerMessage 泛型按 type 收窄后同样可取到 reason 值域（判别联合通路）
type _Assert_StatusNarrowed = AssertExtends<ServerMessage<'rollingRestart.status'>['payload']['state'], RollingRestartState>

// TC4: RPC reply 映射（payload 消费型）
type _Assert_ReplyMapped = AssertExtends<
  ReplyPayloadMap['rollingRestart.status'],
  ServerMessageMap['rollingRestart.status']
>

// TC5: 两个推送事件是广播（非 RPC reply）——不得出现在 ReplyPayloadMap
type _Assert_DeferredNotReply = AssertNotHasKey<ReplyPayloadMap, 'rollingRestart:deferred'>
type _Assert_ForcedNotReply = AssertNotHasKey<ReplyPayloadMap, 'rollingRestart:forced'>

// ── 运行期对象字面量可赋值断言 ────────────────────────────────────
describe('protocol rollingRestart 契约（u7b）', () => {
  it('TC3: status 四态 + reason 可缺省（idle）+ 在途摘要（errs → null）', () => {
    const frames: RollingRestartStatusPayload[] = [
      { state: 'idle', inflight: { inFlight: 0 } },
      { state: 'deferred', reason: 'inflight', inflight: { inFlight: 3 }, deferDeadlineAt: 1_700_001_800_000 },
      // errs 形态（D5 ④ 钉死）：计数取 null + reason=absent-report 独立标记
      { state: 'deferred', reason: 'absent-report', inflight: { inFlight: null }, deferDeadlineAt: 1_700_001_800_000 },
      { state: 'countdown', reason: 'inflight', inflight: { inFlight: 1 }, deferDeadlineAt: 1_700_001_800_000 },
      { state: 'rolling', reason: 'hard-threshold', inflight: { inFlight: 2 } },
      { state: 'rolling', reason: 'defer-limit', inflight: { inFlight: null } },
    ]
    expect(frames.map(f => f.state)).toEqual(['idle', 'deferred', 'deferred', 'countdown', 'rolling', 'rolling'])
    expect(frames[0].reason).toBeUndefined()
    expect(frames[2].inflight.inFlight).toBeNull()
  })

  it('TC3: deferred 事件两类 reason + 30min 上限时刻；forced 事件两类 reason', () => {
    const deferred: RollingRestartDeferredPayload[] = [
      { reason: 'inflight', inflight: { inFlight: 2 }, deferDeadlineAt: 1_700_001_800_000 },
      { reason: 'absent-report', inflight: { inFlight: null }, deferDeadlineAt: 1_700_001_800_000 },
    ]
    const forced: RollingRestartForcedPayload[] = [
      { reason: 'hard-threshold', inflight: { inFlight: 2 } },
      { reason: 'defer-limit', inflight: { inFlight: null } },
    ]
    expect(deferred.map(d => d.reason)).toEqual(['inflight', 'absent-report'])
    expect(forced.map(f => f.reason)).toEqual(['hard-threshold', 'defer-limit'])
    // 0 = 在场且无在途的已证事实（≠ null 未知）——字段可表达
    expect(deferred[0].inflight.inFlight).toBe(2)
    expect(deferred[1].inflight.inFlight).toBeNull()
  })

  it('TC2/TC5: 推送事件命名走 Server→Client 冒号 camelCase；status reply 与 request 同名', () => {
    const pushTypes: ServerMessageType[] = ['rollingRestart:deferred', 'rollingRestart:forced']
    for (const type of pushTypes) expect(type).toMatch(/^rollingRestart:[a-zA-Z]+$/)
    expect('rollingRestart.status' satisfies ServerMessageType).toBe('rollingRestart.status')
    // 推送事件不在 ReplyPayloadMap（运行时不可枚举类型键，TC5 由编译期断言保证）
    expect(pushTypes).toHaveLength(2)
  })

  it('TC1: 无参查询请求可构造（Record<string, never>）', () => {
    const emptyRequest: ClientMessageMap['rollingRestart.status'] = {}
    expect(Object.keys(emptyRequest)).toHaveLength(0)
  })
})
