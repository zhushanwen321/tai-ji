/**
 * protocol-occupancy.test.ts — session-occupancy-send-closure u1-foundation 协议契约校验
 *
 * 验证 shared/protocol.ts 三组扩展的类型形状（消费方 u2-u5b 落地前的契约锚点）：
 *  - TC1: ServerMessageType 联合含 'session.occupancy'
 *  - TC2: ServerMessageMap['session.occupancy'] 形状 = { sessionId, turn 四值, compacting, bash,
 *          handingOff? }（handingOff 第四维 = chat-flow-consistency §6「交接在途状态归属」裁决；
 *          可选 = 契约根先行过渡形态，U1 落地后帧恒带四维）
 *  - TC3: 'send.rejected' payload reason 三值联合 + 可选 clientUuid
 *  - TC4: ClientMessageMap['message.send'] 可选 clientUuid（透传，拒绝广播原样带回）
 *  - TC5: ServerMessageMap['message.message_end'] 可选 messageId（chat-flow-consistency §6
 *          「D3 定位升级」裁决的帧级锚点，U3 定稿重建定位消费；仅 assistant 帧携带）
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
import type { PiMessageEntry } from '../pi-entry'

// ── 编译期类型断言辅助（同 protocol-seq.test.ts 模式）────────────────
type AssertHasKey<T, K extends keyof T> = true
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]

// TC1: ServerMessageType 含 'session.occupancy'
type _Assert_OccupancyInUnion = AssertExtends<'session.occupancy', ServerMessageType>

// TC2: 'session.occupancy' payload 形状（occupancy 结构快照，D3；handingOff 第四维 =
// chat-flow-consistency §6 裁决）。双向断言：正向锁字段形态存在；反向锁 handingOff
// 可选性（若误改必填，缺字段字面量 extends payload 失败即编译期红）。
type OccupancyPayload = ServerMessageMap['session.occupancy']
type _Assert_OccupancyKey = AssertHasKey<ServerMessageMap, 'session.occupancy'>
type _Assert_OccupancyShape = AssertExtends<
  OccupancyPayload,
  {
    sessionId: string
    turn: 'idle' | 'dispatching' | 'generating' | 'settling'
    compacting: boolean
    bash: boolean
    handingOff?: boolean
  }
>
type _Assert_HandingOffOptional = AssertExtends<
  { sessionId: string; turn: 'idle'; compacting: false; bash: false },
  OccupancyPayload
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

// TC5: 'message.message_end' 帧可选 messageId（chat-flow-consistency §6「D3 定位升级」锚点）。
// 双向断言：正向锁字段形态；反向锁 messageId 可选性（user/toolResult/custom 帧不带，
// 文件重放路径也不带——缺字段字面量必须仍可赋给 payload）。
type MessageEndPayload = ServerMessageMap['message.message_end']
type _Assert_MessageEndKey = AssertHasKey<ServerMessageMap, 'message.message_end'>
type _Assert_MessageEndShape = AssertExtends<
  MessageEndPayload,
  { sessionId: string; entry: PiMessageEntry; messageId?: string }
>
type _Assert_MessageEndIdOptional = AssertExtends<
  { sessionId: string; entry: PiMessageEntry },
  MessageEndPayload
>

// ── 运行期对象字面量可赋值断言 ────────────────────────────────────
describe('protocol occupancy/send-rejected 契约（u1-foundation）', () => {
  it('TC1/TC2: session.occupancy 四值 turn + compacting/bash/handingOff 维', () => {
    const frames: OccupancyPayload[] = [
      { sessionId: 's1', turn: 'idle', compacting: false, bash: false },
      { sessionId: 's1', turn: 'dispatching', compacting: false, bash: false },
      { sessionId: 's1', turn: 'generating', compacting: true, bash: false },
      { sessionId: 's1', turn: 'settling', compacting: true, bash: true },
      // handingOff 维（chat-flow-consistency §6）：可选——U1 落地前帧不带、落地后恒带
      { sessionId: 's1', turn: 'generating', compacting: false, bash: false, handingOff: true },
    ]
    expect(frames).toHaveLength(5)
    expect(frames[3].turn).toBe('settling')
    expect(frames[4].handingOff).toBe(true)
    expect(frames[0].handingOff).toBeUndefined()
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

  it('TC5: message.message_end 帧可选 messageId（assistant 锚点，其余帧不带）', () => {
    const entry: PiMessageEntry = {
      type: 'message',
      message: { role: 'assistant', content: [] },
      timestamp: '2026-10-24T00:00:00.000Z',
    }
    const withId: MessageEndPayload = { sessionId: 's1', entry, messageId: 'a-uuid-1' }
    const withoutId: MessageEndPayload = { sessionId: 's1', entry }
    expect(withId.messageId).toBe('a-uuid-1')
    expect(withoutId.messageId).toBeUndefined()
  })
})
