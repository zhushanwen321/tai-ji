/**
 * u4a-outbound-guard 单元测试：server→client 出站帧双通路守卫（crash-resilience §3.3 D3）。
 *
 * 覆盖映射（设计 D3 负面行为声明 + impl-plan u4a 验收条款）：
 * - push 截断后 seq 连续（截断版正常占 seq 入 ring，无 gap）——MessageBus 集成
 * - ring 回放 / 重订阅视角拿到同一份截断版（回放内容 === 在场广播内容）——P-publish-trunc 单测形态
 * - reply 超限替换 envelope 后 type:'error' 形态正确（前端 pending 可 reject 收口）
 * - miss 兜底整条丢弃且后续消息 seq 仍连续（不占 seq 不触发 gap）
 * - 8MB 告警档（warn 日志含消息类型与字节数）；miss/still-oversize 丢弃分支 warn 先于 error
 *   （D3 代价 B「miss 消息必然先打告警」/ A10④「告警档先于截断档出现」）
 * - 注册表未命中类型的小消息完全不受影响（零开销路径）
 * - content / arguments / array / string 四类占位形态契约（array-entry 占位带自增唯一 id，
 *   reducer 幂等消化锚点——同 session 多条截断帧互不折叠）
 *
 * 阈值参数化：测试注入小阈值（warn 1KB / truncate 4KB）走真实行为逻辑；
 * 生产路径用 shared 常量默认值（MessageBus/broker 无参构造即默认）。纯内存逻辑，不触 fs。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import type { ServerMessage } from '@taiji/shared'
import { ServerMessageBroker } from '../../../transport/message-broker.js'
import type { BrokerServices } from '../../../transport/message-broker.js'
import type { BusClient } from '../types.js'
import { MessageBus } from '../message-bus.js'
import {
  type OutboundFrameGuardOptions,
  DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS,
  guardOutboundPushFrame,
  formatTruncationNote,
  formatReplyOversizeMessage,
} from '../outbound-frame-registry.js'

/** 测试小阈值：告警 1KB / 截断 4KB（远小于生产 8MB/32MB，行为逻辑同构）。 */
const SMALL_OPTS: OutboundFrameGuardOptions = { warnBytes: 1024, truncateBytes: 4096 }

afterEach(() => {
  vi.restoreAllMocks()
})

// ── fixture 工厂（对齐 event-adapter.ts / event-interpreter.ts 的真实帧形态） ──

/** message.message_end 帧（toolResult 大结果场景——content 是 block 数组）。 */
function makeMessageEndFrame(content: unknown): ServerMessage {
  return {
    type: 'message.message_end',
    payload: {
      sessionId: 's1',
      entry: {
        type: 'message',
        parentId: null,
        timestamp: '2026-09-09T00:00:00.000Z',
        message: { role: 'toolResult', content },
      },
    },
  } as unknown as ServerMessage
}

/** message.tool_call_start 帧（write 类工具大参数场景）。 */
function makeToolCallStartFrame(argumentsRecord: Record<string, unknown>): ServerMessage {
  return {
    type: 'message.tool_call_start',
    payload: {
      sessionId: 's1',
      entry: { type: 'message', timestamp: '2026-09-09T00:00:00.000Z', messageId: 'm1', arguments: argumentsRecord },
    },
  } as unknown as ServerMessage
}

/** mock BusClient（最小契约：readyState + send；cast 与 test/message-broker.test.ts 同惯例）。 */
function makeClient(): BusClient & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as BusClient & { send: ReturnType<typeof vi.fn> }
}

/** mock WsType（broker reply 通路参数是 ws.WebSocket 类型；cast 与 test/message-broker.test.ts 同惯例）。 */
function makeWsClient(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket
}

/** 取 mock WsType 的 send 调用记录（[0] = 序列化后的 JSON 文本）。 */
function wsSent(ws: WebSocket): unknown[][] {
  return (ws as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls
}

function sentMessages(client: ReturnType<typeof makeClient>): ServerMessage[] {
  return client.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string) as ServerMessage)
}

// ── guardOutboundPushFrame 纯函数 ──────────────────────────────────

describe('guardOutboundPushFrame（push 通路守卫纯函数）', () => {
  it('小消息 passthrough：注册表未命中类型零开销路径，内容原样、入参零污染', () => {
    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }
    const before = JSON.stringify(msg)
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('passthrough')
    if (r.action === 'passthrough') expect(r.message).toBe(msg) // 同一引用，零拷贝零改动
    expect(JSON.stringify(msg)).toBe(before)
  })

  it('8MB 告警档（小阈值 1KB）：介于告警/截断档之间的帧 passthrough 且 warn 日志含类型与字节数', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const big = 'y'.repeat(2000)
    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', note: big } }
    const bytes = Buffer.byteLength(JSON.stringify(msg), 'utf8')
    expect(bytes).toBeGreaterThan(SMALL_OPTS.warnBytes)
    expect(bytes).toBeLessThanOrEqual(SMALL_OPTS.truncateBytes)
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('passthrough')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('message.complete')
    expect(warnSpy.mock.calls[0]?.[0]).toContain(`bytes=${bytes}`)
  })

  it('content 类占位形态：message_end 超限 → content 整字段替换为 [{type:text,text:含截断文案}]，帧其余部分原样', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const msg = makeMessageEndFrame([{ type: 'text', text: 'x'.repeat(5000) }])
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    expect(r.bytesBefore).toBeGreaterThan(SMALL_OPTS.truncateBytes)
    expect(r.bytesAfter).toBeLessThanOrEqual(SMALL_OPTS.truncateBytes)
    expect(r.fieldPaths).toEqual(['payload.entry.message.content'])
    const content = (r.message.payload as { entry: { message: { content: unknown } } }).entry.message.content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toHaveLength(1)
    expect((content as Array<{ type: string; text: string }>)[0]?.type).toBe('text')
    expect((content as Array<{ type: string; text: string }>)[0]?.text).toContain('已在传输层截断')
    expect((content as Array<{ type: string; text: string }>)[0]?.text).toContain('session 文件')
    // 入参零污染：原始 content 保持大文本（调用方 event-adapter 持有的 entry 不被截断污染）
    const originalContent = (msg.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(originalContent[0]?.text).toBe('x'.repeat(5000))
    expect(warnSpy).toHaveBeenCalledOnce() // replaced 也记一条大帧告警
  })

  it('record 类占位形态：tool_call_start 的 arguments 超限 → 类型保持 record {truncated,reason,originalBytes}', () => {
    const msg = makeToolCallStartFrame({ content: 'w'.repeat(5000), file_path: '/tmp/a.txt' })
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    expect(r.fieldPaths).toEqual(['payload.entry.arguments'])
    const args = (r.message.payload as { entry: { arguments: Record<string, unknown> } }).entry.arguments
    // record 契约保持：仍是 plain object，不谎报为其他类型
    expect(typeof args).toBe('object')
    expect(args['truncated']).toBe(true)
    expect(args['reason']).toBe('payload_too_large')
    expect(typeof args['originalBytes']).toBe('number')
    expect(args['originalBytes']).toBeGreaterThan(SMALL_OPTS.warnBytes)
    // 原始 arguments 零污染
    expect((msg.payload as { entry: { arguments: { content: string } } }).entry.arguments.content).toBe('w'.repeat(5000))
  })

  it('array-string 类占位形态：subagent.stream_delta 的 lines 超限 → [占位字符串]（元素与原元素同型）', () => {
    const msg: ServerMessage = {
      type: 'subagent.stream_delta',
      payload: { sessionId: 's1', recordId: 'r1', lines: ['x'.repeat(5000)] },
    }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    const lines = (r.message.payload as { lines: string[] }).lines
    expect(Array.isArray(lines)).toBe(true)
    expect(lines).toHaveLength(1)
    expect(typeof lines[0]).toBe('string')
    expect(lines[0]).toContain('已在传输层截断')
  })

  it('array-entry 类占位形态：traceEntryAppended 的 entries 超限 → 单元素 PiMessageEntry 占位数组（reducer 可消化形态）', () => {
    const msg: ServerMessage = {
      type: 'session.traceEntryAppended',
      payload: {
        sessionId: 's1',
        entries: [{ type: 'message', id: 'e1', timestamp: '2026-09-09T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] } }],
        leafId: 'e1',
      },
    }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    const entries = (r.message.payload as { entries: Array<Record<string, unknown>> }).entries
    expect(Array.isArray(entries)).toBe(true)
    expect(entries).toHaveLength(1)
    const placeholder = entries[0]
    // 占位 entry 带 id（幂等消化锚点——文件头「reducer 按 entry.id 幂等消化」自洽）；
    // 'truncated-<seq>-array-entry' 命名空间与真实 pi entry id（uuidv7）无碰撞
    expect(placeholder['id']).toMatch(/^truncated-\d+-array-entry$/)
    expect(placeholder['type']).toBe('message')
    const body = placeholder['message'] as { role?: string; content?: Array<{ type: string; text: string }> }
    expect(body.role).toBe('assistant')
    expect(body.content?.[0]?.type).toBe('text')
    expect(body.content?.[0]?.text).toContain('已在传输层截断')
  })

  it('array-entry 占位 id 唯一性：同 session 两次截断帧的占位 entry id 互不相同（防 reducer 按 id 折叠两条不同消息）', () => {
    const makeFrame = (): ServerMessage => ({
      type: 'session.traceEntryAppended',
      payload: {
        sessionId: 's1',
        entries: [{ type: 'message', id: 'e1', timestamp: '2026-09-09T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] } }],
        leafId: 'e1',
      },
    } as unknown as ServerMessage)
    const r1 = guardOutboundPushFrame(makeFrame(), 's1', SMALL_OPTS)
    const r2 = guardOutboundPushFrame(makeFrame(), 's1', SMALL_OPTS)
    if (r1.action !== 'replaced' || r2.action !== 'replaced') return
    const id1 = (r1.message.payload as { entries: Array<Record<string, unknown>> }).entries[0]?.['id']
    const id2 = (r2.message.payload as { entries: Array<Record<string, unknown>> }).entries[0]?.['id']
    expect(typeof id1).toBe('string')
    expect(id1).not.toBe(id2)
  })

  it('string 类占位形态：bashResult 的 output 超限 → 占位文案字符串本体（类型保持 string）', () => {
    const msg: ServerMessage = {
      type: 'message.bashResult',
      payload: { sessionId: 's1', command: 'cat big.txt', output: 'x'.repeat(5000), exitCode: 0, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1 },
    }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    const output = (r.message.payload as { output: string }).output
    expect(typeof output).toBe('string')
    expect(output).toContain('已在传输层截断')
  })

  it('miss 兜底：注册表未覆盖类型（message.complete）超限 → dropped(registry_miss)，8MB 告警档 warn 先于 error 日志（D3 代价 B / A10④）', () => {
    const order: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error') })
    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', blob: 'x'.repeat(5000) } }
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('dropped')
    if (r.action !== 'dropped') return
    expect(r.dropReason).toBe('registry_miss')
    // miss 消息必先打告警（哨兵前置暴露），error 随后
    expect(order).toEqual(['warn', 'error'])
    expect(warnSpy.mock.calls[0]?.[0]).toContain('large outbound push frame (warn)')
    expect(warnSpy.mock.calls[0]?.[0]).toContain('message.complete')
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]?.[0]).toContain('registry miss')
    expect(errorSpy.mock.calls[0]?.[0]).toContain('message.complete')
  })

  it('miss 兜底（超限来自未注册字段）：注册字段未超告警档不替换 → dropped(registry_miss)，warn 先于 error', () => {
    const order: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error') })
    // content 只有 500 字节（< warn 1KB），超限来自未注册的 blob 字段
    const msg: ServerMessage = {
      type: 'message.message_end',
      payload: {
        sessionId: 's1',
        entry: {
          type: 'message',
          timestamp: '2026-09-09T00:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(500) }] },
        },
        blob: 'z'.repeat(5000),
      },
    } as unknown as ServerMessage
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('dropped')
    if (r.action !== 'dropped') return
    expect(r.dropReason).toBe('registry_miss')
    expect(order).toEqual(['warn', 'error'])
  })

  it('miss 兜底：注册字段替换后帧仍超截断档 → dropped(still_oversize_after_truncate)，warn 先于 error', () => {
    const order: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error') })
    // content 超限会被替换，但未注册的 blob 字段仍把帧撑过截断档
    const msg: ServerMessage = {
      type: 'message.message_end',
      payload: {
        sessionId: 's1',
        entry: {
          type: 'message',
          timestamp: '2026-09-09T00:00:00.000Z',
          message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
        },
        blob: 'z'.repeat(5000),
      },
    } as unknown as ServerMessage
    const r = guardOutboundPushFrame(msg, 's1', SMALL_OPTS)
    expect(r.action).toBe('dropped')
    if (r.action !== 'dropped') return
    expect(r.dropReason).toBe('still_oversize_after_truncate')
    expect(order).toEqual(['warn', 'error'])
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('守卫零抛错：resolveSessionFilePath 抛错不打断截断流程，占位路径退化为「（见 runtime 日志）」', () => {
    const throwing: OutboundFrameGuardOptions = {
      ...SMALL_OPTS,
      resolveSessionFilePath: () => {
        throw new Error('path resolution exploded')
      },
    }
    const msg = makeMessageEndFrame([{ type: 'text', text: 'x'.repeat(5000) }])
    const r = guardOutboundPushFrame(msg, 's1', throwing)
    expect(r.action).toBe('replaced')
    if (r.action !== 'replaced') return
    const content = (r.message.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(content[0]?.text).toContain('（见 runtime 日志）')
  })

  it('占位文案路径可得时填实路径；formatTruncationNote 含 MB 体积', () => {
    const withPath: OutboundFrameGuardOptions = {
      ...SMALL_OPTS,
      resolveSessionFilePath: (sid) => (sid === 's1' ? '/data/agent/sessions/x/1_s1.jsonl' : null),
    }
    const note = formatTruncationNote(5 * 1024 * 1024, 's1', withPath)
    expect(note).toContain('5.0 MB')
    expect(note).toContain('/data/agent/sessions/x/1_s1.jsonl')
    // 不可得（null / 未注入）→ 占位
    expect(formatTruncationNote(1024, 's2', withPath)).toContain('（见 runtime 日志）')
    expect(formatTruncationNote(1024, 's1', SMALL_OPTS)).toContain('（见 runtime 日志）')
    // 生产默认阈值来自 shared 常量（不重复断言数值本身，只锚定引用关系）
    expect(DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS.warnBytes).toBeGreaterThan(0)
  })
})

// ── MessageBus 集成（seq 连续性 / ring 回放 / 重订阅） ─────────────

describe('MessageBus.publish 出站守卫集成', () => {
  it('push 截断后 seq 连续：超限帧截断版正常占 seq 入 ring 广播，无 gap', () => {
    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } })
    bus.publish('s1', makeMessageEndFrame([{ type: 'text', text: 'x'.repeat(5000) }]))
    bus.publish('s1', { type: 'message.status', payload: { sessionId: 's1', status: 'running' } })

    const received = sentMessages(ws)
    expect(received).toHaveLength(3)
    // seq 1/2/3 连续——截断版占 seq 2，不产生 gap
    expect(received.map((m) => m.seq)).toEqual([1, 2, 3])
    const truncated = received[1]
    expect(truncated.type).toBe('message.message_end')
    const content = (truncated.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(content[0]?.text).toContain('已在传输层截断')
  })

  it('ring 回放/重订阅视角拿到同一份截断版（回放内容 === 在场广播内容）', () => {
    const bus = new MessageBus(100, SMALL_OPTS)
    const liveWs = makeClient()
    bus.subscribe('s1', liveWs)
    bus.publish('s1', makeMessageEndFrame([{ type: 'text', text: 'x'.repeat(5000) }]))

    const liveReceived = sentMessages(liveWs)
    expect(liveReceived).toHaveLength(1)

    // 模拟断连重连：新 ws subscribe → ring 快照回放
    const reconnectWs = makeClient()
    const { snapshot, lastSeq } = bus.subscribe('s1', reconnectWs)
    expect(lastSeq).toBe(1)
    expect(snapshot).toHaveLength(1)
    // 回放版与在场广播版逐字节一致（同一份截断对象）
    expect(JSON.stringify(snapshot[0])).toBe(JSON.stringify(liveReceived[0]))
    const replayContent = (snapshot[0]?.payload as { entry: { message: { content: Array<{ text: string }> } } }).entry.message.content
    expect(replayContent[0]?.text).toContain('已在传输层截断')
  })

  it('miss 兜底：未注册类型超限帧整条丢弃（不占 seq 不广播），后续消息 seq 仍连续；丢弃前先打 8MB 告警档 warn', () => {
    const order: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { order.push('error') })
    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }) // seq 1
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn', blob: 'x'.repeat(5000) } }) // dropped，无 seq
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }) // seq 2

    const received = sentMessages(ws)
    expect(received).toHaveLength(2)
    expect(received.map((m) => m.seq)).toEqual([1, 2])
    expect(received.every((m) => (m.payload as { blob?: string }).blob === undefined)).toBe(true)
    // D3 代价 B：miss 丢弃前必先打告警档 warn
    expect(order).toEqual(['warn', 'error'])
    expect(warnSpy.mock.calls[0]?.[0]).toContain('large outbound push frame (warn)')
    expect(errorSpy).toHaveBeenCalledOnce()

    // 重订阅 lastSeq 同样不包含被丢帧（seq 2，非 3）
    const { lastSeq } = bus.subscribe('s1', makeClient())
    expect(lastSeq).toBe(2)
  })

  it('transient 超限帧截断直传：不占 seq、无 seq 字段、截断版送达', () => {
    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    ws.send.mockClear()

    bus.publish('s1', {
      type: 'terminal.data',
      payload: { sessionId: 's1', data: 'x'.repeat(5000) },
    })

    const received = sentMessages(ws)
    expect(received).toHaveLength(1)
    expect(received[0]?.seq).toBeUndefined()
    expect((received[0]?.payload as { data: string }).data).toContain('已在传输层截断')
    // transient 不占 seq：后续 stream 消息从 seq 1 起
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } })
    expect(sentMessages(ws)[1]?.seq).toBe(1)
  })

  it('小消息完全不受影响：未注册类型小消息内容逐字节原样（零开销路径，stringify 恰好 1 次——w09 TC-V1 契约）', () => {
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    const msg: ServerMessage = { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } }
    const before = JSON.stringify(msg)
    stringifySpy.mockClear()
    bus.publish('s1', msg)
    // 单条消息全程恰好 1 次 stringify（守卫测量复用广播序列化，小消息零额外开销）
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    stringifySpy.mockRestore()
    const received = sentMessages(ws)
    expect(received).toHaveLength(1)
    expect(received[0]?.payload).toEqual({ sessionId: 's1', stopReason: 'end_turn' })
    expect(JSON.stringify({ type: received[0]?.type, payload: received[0]?.payload })).toBe(before)
  })

  it('序列化失败（循环引用）零抛错：丢弃 + seq 回滚（后续消息 seq 连续，不产生断裂）', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new MessageBus(100, SMALL_OPTS)
    const ws = makeClient()
    bus.subscribe('s1', ws)
    const cyclic: Record<string, unknown> = { type: 'message.complete' }
    cyclic['payload'] = { sessionId: 's1', self: cyclic }
    expect(() => bus.publish('s1', cyclic as unknown as ServerMessage)).not.toThrow()
    bus.publish('s1', { type: 'message.complete', payload: { sessionId: 's1', stopReason: 'end_turn' } })
    const received = sentMessages(ws)
    // 循环引用消息被丢且 seq 回滚（后续消息仍从 seq 1 起）
    expect(received).toHaveLength(1)
    expect(received[0]?.seq).toBe(1)
    expect(errorSpy).toHaveBeenCalledOnce()
  })
})

// ── reply 通路（ServerMessageBroker） ──────────────────────────────

/** 最小 BrokerServices（reply 守卫不读 services，构造满足类型即可）。 */
const mockServices = {
  sessionService: { listPersistedSessions: () => [] },
  configService: { listProviders: () => [], getDefaultModel: () => null, loadSkills: () => [], loadAgents: () => [] },
  modelService: { aggregateModels: () => [] },
  pluginService: undefined,
  extensionService: undefined,
  projectRoot: '/mock',
  appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
} as unknown as BrokerServices

describe('ServerMessageBroker.reply 出站守卫', () => {
  it('reply 超限 → 整帧替换 type:error + payload_too_large 错误 envelope（id 保留，前端 pending 可 reject 收口）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })

    broker.reply(ws, 'req-42', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })

    expect(wsSent(ws)).toHaveLength(1)
    const sent = JSON.parse(wsSent(ws)[0][0] as string) as { type: string; id: string; payload: { code: string; message: string; sessionId?: string } }
    // 错误 envelope 形态（core pending.resolveEnvelope 的 reject 收口前提：type==='error' + id 命中）
    expect(sent.type).toBe('error')
    expect(sent.id).toBe('req-42')
    expect(sent.payload.code).toBe('payload_too_large')
    expect(sent.payload.message).toContain('加载更早')
    expect(sent.payload.message).toContain('session 文件')
    expect(sent.payload.sessionId).toBe('s1')
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('reply 超限 + 注入 resolver → 错误 envelope message 含 resolver 解析的 session 文件实路径（u8 两通路接线对称）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices, {
      warnBytes: 1024,
      truncateBytes: 4096,
      resolveSessionFilePath: (sid) => (sid === 's1' ? '/data/agent/sessions/x/1_s1.jsonl' : null),
    })

    broker.reply(ws, 'req-50', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })

    expect(wsSent(ws)).toHaveLength(1)
    const sent = JSON.parse(wsSent(ws)[0][0] as string) as { payload: { code: string; message: string } }
    expect(sent.payload.code).toBe('payload_too_large')
    expect(sent.payload.message).toContain('/data/agent/sessions/x/1_s1.jsonl')
    expect(sent.payload.message).not.toContain('（见 runtime 日志）')
  })

  it('reply 超限 + 未注入 resolver（默认）→ message 退化为「（见 runtime 日志）」占位（回归保护）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })

    broker.reply(ws, 'req-51', 'message.error', { sessionId: 's1', message: 'x'.repeat(5000) })

    expect(wsSent(ws)).toHaveLength(1)
    const sent = JSON.parse(wsSent(ws)[0][0] as string) as { payload: { code: string; message: string } }
    expect(sent.payload.code).toBe('payload_too_large')
    expect(sent.payload.message).toContain('（见 runtime 日志）')
  })

  it('reply 介于告警/截断档之间 → warn 日志但原样送达；小 reply 零日志零改动', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })

    // 告警档：原样送达（type 保持 message.error）
    broker.reply(ws, 'req-1', 'message.error', { sessionId: 's1', message: 'y'.repeat(2000) })
    const warned = JSON.parse(wsSent(ws)[0][0] as string) as { type: string; payload: { message: string } }
    expect(warned.type).toBe('message.error')
    expect(warned.payload.message).toBe('y'.repeat(2000))
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // 小 reply：零日志、原样
    warnSpy.mockClear()
    broker.reply(ws, 'req-2', 'message.complete', { sessionId: 's1', stopReason: 'end_turn' })
    const small = JSON.parse(wsSent(ws)[1][0] as string) as { type: string; id: string }
    expect(small.type).toBe('message.complete')
    expect(small.id).toBe('req-2')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('reply 序列化失败（循环引用）→ 复用 error envelope 收口，不抛错不悬挂', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices, { warnBytes: 1024, truncateBytes: 4096 })

    const cyclic: Record<string, unknown> = { sessionId: 's1' }
    cyclic['self'] = cyclic
    expect(() => broker.reply(ws, 'req-9', 'message.error', cyclic as never)).not.toThrow()

    const sent = JSON.parse(wsSent(ws)[0][0] as string) as { type: string; id: string; payload: { code: string } }
    expect(sent.type).toBe('error')
    expect(sent.id).toBe('req-9')
    expect(sent.payload.code).toBe('reply_serialization_failed')
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('生产默认阈值 = shared 常量（无参构造可发送 8KB 级 reply——低于 8MB 告警档零日志）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = makeWsClient()
    const broker = new ServerMessageBroker({ clients: new Set([ws]) }, mockServices)
    broker.reply(ws, 'req-3', 'message.error', { sessionId: 's1', message: 'z'.repeat(8 * 1024) })
    expect(wsSent(ws)).toHaveLength(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('formatReplyOversizeMessage 含体积与恢复指引（reply/push 两通路文案契约）', () => {
    const msg = formatReplyOversizeMessage(5 * 1024 * 1024, 's1', SMALL_OPTS)
    expect(msg).toContain('5.0 MB')
    expect(msg).toContain('加载更早')
    expect(msg).toContain('（见 runtime 日志）')
  })
})
