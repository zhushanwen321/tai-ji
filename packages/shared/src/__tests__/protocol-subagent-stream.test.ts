/**
 * protocol-subagent-stream.test.ts — subagent 增量流式协议契约校验（B2 subagent-stream-chunk §4.1）
 *
 * 验证新增两条 additive 协议条目在三处映射全部登记且 payload 形状逐字对齐设计：
 *  - SC1: ServerMessageMap 含 'subagent.stream_chunk'（transient 语义，唯一内容推送通道）
 *  - SC2: ClientMessageType / ClientMessageMap 含 'session.getSubagentStreamState'
 *  - SC3: ServerMessageMap / ReplyPayloadMap 含同名 reply，形状 { found, msgSeq, lastDeltaSeq, lines }
 *  - SC4: found:false 边界形态可构造（该 record 无进行中流 = 合法回执，非错误）
 *  - SC5: 失败走既有统一 error envelope（'error' 条目原样承载，无新增错误帧/错误码）
 *
 * 模式与 protocol-seq.test.ts 一致。编译期防线的实际生效范围（探针实证）：AssertHasKey
 * 约束违例真报错（TS2344，key 缺失即拦）；AssertExtends 以未使用类型别名形态实例化时
 * 违例零报错（条件类型静默解析为错误元组，无赋值位置即无检查点）——本文件全部
 * AssertExtends 裸别名属文档性断言，形状防线的承载 = 同文件值位置构造（payload/reply
 * 对象字面量赋给目标类型，excess/missing 属性检查真实生效）。另有运行期对象字面量
 * 可赋值断言（vitest）+ transient 标注源码扫描（注释字样属文本面，编译器不保护，
 * 运行期 grep 式断言守卫）。
 *
 * 运行：cd packages/shared && npx tsc --noEmit && npx vitest run
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ClientMessageMap,
  ClientMessageType,
  ReplyPayloadMap,
  ServerMessageMapBase,
} from '../protocol'

// ── 编译期类型断言辅助（同 protocol-seq.test.ts 模式）──────────────
// key 缺失 → AssertHasKey 约束违例报 TS2344；形状漂移的编译期防线在值位置构造
// （对象字面量赋目标类型的 excess/missing 属性检查），裸 AssertExtends 别名不独立报错。

type AssertHasKey<T, K extends keyof T> = true
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]

// SC1: stream_chunk 消息型登记 + payload 字段逐字锚定（msgSeq/deltaSeq/delta）
type _Assert_Chunk = AssertHasKey<ServerMessageMapBase, 'subagent.stream_chunk'>
type _Assert_Chunk_shape = AssertExtends<
  ServerMessageMapBase['subagent.stream_chunk'],
  { sessionId: string; recordId: string; msgSeq: number; deltaSeq: number; delta: string }
>

// SC2: getSubagentStreamState 请求登记（type 联合 + payload map）
type _Assert_StateReq_type = AssertExtends<'session.getSubagentStreamState', ClientMessageType>
type _Assert_StateReq_map = AssertHasKey<ClientMessageMap, 'session.getSubagentStreamState'>
type _Assert_StateReq_shape = AssertExtends<
  ClientMessageMap['session.getSubagentStreamState'],
  { sessionId: string; recordId: string }
>

// SC3: 同名 reply 登记于 ServerMessageMapBase 与 ReplyPayloadMap，形状逐字锚定
type _Assert_StateReply_server = AssertHasKey<ServerMessageMapBase, 'session.getSubagentStreamState'>
type _Assert_StateReply_replyMap = AssertHasKey<ReplyPayloadMap, 'session.getSubagentStreamState'>
type _Assert_StateReply_shape = AssertExtends<
  ServerMessageMapBase['session.getSubagentStreamState'],
  { found: boolean; msgSeq: number; lastDeltaSeq: number; lines: string[] }
>
type _Assert_StateReply_sameAsMap = AssertExtends<
  ReplyPayloadMap['session.getSubagentStreamState'],
  ServerMessageMapBase['session.getSubagentStreamState']
>

// SC5: 既有 error envelope 条目可承载本 RPC 失败（code/message 闭集扩展不强制——
// 设计内失败形态是 found:false 回执，error 只兜传输级失败）
type _Assert_ErrorEnvelope = AssertHasKey<ServerMessageMapBase, 'error'>

// ── transient 标注源码扫描（编译器不保护注释文本，运行期守卫）──────

const PROTOCOL_TS = resolve(fileURLToPath(import.meta.url), '..', '..', 'protocol.ts')
const PROTOCOL_SOURCE = readFileSync(PROTOCOL_TS, 'utf8')

// ── 运行期测试 ─────────────────────────────────────────────────

describe('SC1: subagent.stream_chunk 消息型（transient）', () => {
  it('payload 形状：sessionId + recordId + msgSeq + deltaSeq + delta 可构造', () => {
    const payload: ServerMessageMapBase['subagent.stream_chunk'] = {
      sessionId: 'subagent:main-1:sa-1',
      recordId: 'rec-1',
      msgSeq: 1,
      deltaSeq: 0,
      delta: 'hello ',
    }
    expect(payload.msgSeq).toBe(1)
    expect(payload.deltaSeq).toBe(0)
    expect(payload.delta).toBe('hello ')
  })

  it('delta 为真增量片段（可空串，非累积全文形态——lines 数组不在此消息上）', () => {
    const payload: ServerMessageMapBase['subagent.stream_chunk'] = {
      sessionId: 's', recordId: 'r', msgSeq: 1, deltaSeq: 7, delta: '',
    }
    expect(payload.delta).toBe('')
    expect('lines' in payload).toBe(false)
  })

  it('transient 语义标注存在于类型声明与条目注释（grep 式源码扫描）', () => {
    // ServerMessageType 联合处与 ServerMessageMapBase 条目处各标注一次 transient
    const typeIdx = PROTOCOL_SOURCE.indexOf("  | 'subagent.stream_delta' | 'subagent.stream_chunk'")
    expect(typeIdx, 'ServerMessageType 联合缺 stream_chunk 条目').toBeGreaterThan(-1)
    const mapEntryIdx = PROTOCOL_SOURCE.indexOf("'subagent.stream_chunk': {")
    expect(mapEntryIdx, 'ServerMessageMapBase 缺 stream_chunk 条目').toBeGreaterThan(-1)
    expect(
      PROTOCOL_SOURCE.slice(typeIdx - 300, typeIdx).includes('transient'),
      'ServerMessageType 处缺 transient 标注',
    ).toBe(true)
    expect(
      PROTOCOL_SOURCE.slice(mapEntryIdx - 600, mapEntryIdx).includes('transient'),
      'ServerMessageMapBase 条目注释缺 transient 标注',
    ).toBe(true)
  })
})

describe('SC2: session.getSubagentStreamState 请求', () => {
  it('type 是合法 ClientMessageType', () => {
    const t: ClientMessageType = 'session.getSubagentStreamState'
    expect(t).toBe('session.getSubagentStreamState')
  })

  it('入参形状：sessionId + recordId 双参数（recordId 定位 record，无可选字段）', () => {
    const payload: ClientMessageMap['session.getSubagentStreamState'] = {
      sessionId: 'main-1',
      recordId: 'rec-1',
    }
    expect(Object.keys(payload).sort()).toEqual(['recordId', 'sessionId'])
  })
})

describe('SC3: session.getSubagentStreamState reply（同名）', () => {
  it('found=true 形态：msgSeq/lastDeltaSeq/lines 承载当前流状态快照', () => {
    const reply: ReplyPayloadMap['session.getSubagentStreamState'] = {
      found: true,
      msgSeq: 2,
      lastDeltaSeq: 41,
      lines: ['第一段', '第二段'],
    }
    expect(reply.found).toBe(true)
    expect(reply.msgSeq).toBe(2)
    expect(reply.lastDeltaSeq).toBe(41)
    expect(reply.lines).toHaveLength(2)
  })

  it('lines 为空数组合法（流刚开始、尚无累积文本）', () => {
    const reply: ServerMessageMapBase['session.getSubagentStreamState'] = {
      found: true,
      msgSeq: 1,
      lastDeltaSeq: 0,
      lines: [],
    }
    expect(reply.lines).toEqual([])
  })
})

describe('SC4: found:false 边界形态（无进行中流 = 合法回执）', () => {
  it('found=false + msgSeq 0 + lastDeltaSeq 0 + lines 空数组可构造', () => {
    const reply: ReplyPayloadMap['session.getSubagentStreamState'] = {
      found: false,
      msgSeq: 0,
      lastDeltaSeq: 0,
      lines: [],
    }
    expect(reply.found).toBe(false)
    expect(reply.msgSeq).toBe(0)
    expect(reply.lastDeltaSeq).toBe(0)
    expect(reply.lines).toEqual([])
  })
})

describe('SC5: 失败走既有统一 error envelope', () => {
  it('error envelope 条目原样承载本 RPC 失败（code/message 形状，无新增错误帧）', () => {
    const envelope: ServerMessageMapBase['error'] = {
      code: 'unknown_type',
      message: 'record not found',
      sessionId: 'main-1',
    }
    expect(envelope.code).toBe('unknown_type')
    expect(envelope.message).toBe('record not found')
    expect(envelope.sessionId).toBe('main-1')
  })
})
