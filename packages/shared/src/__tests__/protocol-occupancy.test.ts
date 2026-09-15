/**
 * protocol-occupancy.test.ts — session-occupancy-send-closure u1-foundation 协议契约校验
 *
 * 验证 shared/protocol.ts 三组扩展的类型形状（消费方 u2-u5b 落地前的契约锚点）：
 *  - TC1: ServerMessageType 联合含 'session.occupancy'
 *  - TC2: ServerMessageMap['session.occupancy'] 形状 = { sessionId, turn 四值, compacting, bash }
 *  - TC3: 'send.rejected' payload reason 三值联合 + 可选 clientUuid
 *  - TC4: ClientMessageMap['message.send'] 可选 clientUuid（透传，拒绝广播原样带回）
 *
 * 模式与 __tests__/protocol-seq.test.ts 一致：编译期 AssertHasKey/AssertExtends
 * （tsc --noEmit 保证）+ 运行期对象字面量可赋值断言（vitest）。纯类型层，零运行时依赖。
 *
 * 运行：cd packages/shared && pnpm run typecheck && pnpm vitest run
 */
import { describe, it, expect } from 'vitest'
import type {
  ClientMessageMap,
  ServerMessage,
  ServerMessageMap,
  ServerMessageType,
} from '../protocol'

// ── 编译期类型断言辅助（同 protocol-seq.test.ts 模式）────────────────
type AssertHasKey<T, K extends keyof T> = true
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]

// TC1: ServerMessageType 含 'session.occupancy'
type _Assert_OccupancyInUnion = AssertExtends<'session.occupancy', ServerMessageType>

// TC2: 'session.occupancy' payload 形状（occupancy 三维结构快照，D3）
type OccupancyPayload = ServerMessageMap['session.occupancy']
type _Assert_OccupancyKey = AssertHasKey<ServerMessageMap, 'session.occupancy'>
type _Assert_OccupancyShape = AssertExtends<
  OccupancyPayload,
  {
    sessionId: string
    turn: 'idle' | 'dispatching' | 'generating' | 'settling'
    compacting: boolean
    bash: boolean
  }
>

// TC3: 'send.rejected' payload：reason 三值 + 可选 clientUuid
type SendRejectedPayload = ServerMessageMap['send.rejected']
type _Assert_RejectedKey = AssertHasKey<ServerMessageMap, 'send.rejected'>
type _Assert_RejectedReasons = AssertExtends<
  SendRejectedPayload,
  { sessionId: string; reason: 'busy' | 'compacting' | 'processing'; message: string; clientUuid?: string }
>
// ServerMessage 泛型按 type 收窄后同样可取到三值联合（判别联合通路）
type _Assert_RejectedNarrowed = AssertExtends<
  ServerMessage<'send.rejected'>['payload']['reason'],
  'busy' | 'compacting' | 'processing'
>

// TC4: ClientMessageMap['message.send'] 可选 clientUuid
type _Assert_ClientSendKey = AssertHasKey<ClientMessageMap, 'message.send'>
type _Assert_ClientSendUuid = AssertExtends<
  ClientMessageMap['message.send'],
  { sessionId: string; content: string; images?: Array<{ data: string; mimeType: string }>; clientUuid?: string }
>

// ── 运行期对象字面量可赋值断言 ────────────────────────────────────
describe('protocol occupancy/send-rejected 契约（u1-foundation）', () => {
  it('TC1/TC2: session.occupancy 四值 turn + compacting/bash 二维', () => {
    const frames: OccupancyPayload[] = [
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
      { sessionId: 's1', turn: 'dispatching', compacting: false, bash: false },
      { sessionId: 's1', turn: 'generating', compacting: true, bash: false },
      { sessionId: 's1', turn: 'settling', compacting: true, bash: true },
    ]
    expect(frames).toHaveLength(4)
    expect(frames[3].turn).toBe('settling')
  })

  it("TC3: send.rejected reason 三值合法（busy/compacting/processing）+ clientUuid 可选", () => {
    const withoutUuid: SendRejectedPayload = { sessionId: 's1', reason: 'busy', message: 'Agent 正在处理' }
    const compacting: SendRejectedPayload = { sessionId: 's1', reason: 'compacting', message: '压缩中', clientUuid: 'u-1' }
    const processing: SendRejectedPayload = { sessionId: 's1', reason: 'processing', message: '收尾中' }
    expect(withoutUuid.clientUuid).toBeUndefined()
    expect(compacting.clientUuid).toBe('u-1')
    expect(processing.reason).toBe('processing')
  })

  it("TC4: message.send 请求可携带可选 clientUuid", () => {
    const withUuid: ClientMessageMap['message.send'] = { sessionId: 's1', content: 'hello', clientUuid: 'u-1' }
    const withoutUuid: ClientMessageMap['message.send'] = { sessionId: 's1', content: 'hello' }
    expect(withUuid.clientUuid).toBe('u-1')
    expect(withoutUuid.clientUuid).toBeUndefined()
  })
})
