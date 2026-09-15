/**
 * SessionMessageHandler session.subscribe 路由测试（wave:perf-w06，D5-3/R-03）。
 *
 * 锁定 subscribe handler 的 gap 判定语义（真实 MessageBus，mock 传输）：
 * - TC1: state+stream 混合 session（5 state + 3 stream）→ 无 fromSeq 订阅 → gap=false、
 *   snapshot 只含 stream（3 条）、stateSnapshot 含 5 个 state last-value、lastSeq=8
 *   （R-03 探针：state 类不入 ring 不产生假最旧 seq，混合 session 不误报 gap）
 * - TC2: ring 溢出（容量 3，publish 4 条 stream）→ fromSeq=1 早于最旧 seq 2 → gap=true，
 *   snapshot 不做增量过滤（全量 3 条，renderer 全量重拉）
 * - TC3: fromSeq 落在 ring 覆盖范围内 → gap=false，snapshot 增量过滤（seq > fromSeq）
 * - TC4: messageBus 未注入 → sendError('subscribe_unsupported')
 *
 * mock 模式参考 session-message-handler-handoff.test.ts（makeHandler + Captured reply/error）。
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-message-handler-subscribe.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string }[]
}

interface MakeHandlerOpts {
  messageBus?: MessageBus | undefined
}

function makeHandler(opts: MakeHandlerOpts = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      cap.errors.push({ id, code, message })
    }),
    sessionService: { ensureActive: vi.fn().mockResolvedValue(undefined) },
    messageBus: opts.messageBus,
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { cap, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

function pushMsg(type: string, payload: Record<string, unknown>): ServerMessage {
  return { type, payload } as ServerMessage
}

// ws 需满足 BusClient 契约（subscribe 会把 handler 收到的 ws 注册为订阅者）。
const WS = { readyState: 1, send: vi.fn() } as never

describe('SessionMessageHandler —— session.subscribe gap 判定（D5-3/R-03）', () => {
  // TC1: R-03 探针——state+stream 混合 session 正常订阅不误报 gap
  it('TC1: mixed session (5 state + 3 stream) — gap=false, stream-only snapshot, complete stateSnapshot', async () => {
    const bus = new MessageBus()
    const sid = 's1'
    bus.publish(sid, pushMsg('session.commands', { sessionId: sid, commands: [] })) // seq 1 state
    bus.publish(sid, pushMsg('message.message_start', { sessionId: sid, n: 1 })) // seq 2 stream
    bus.publish(sid, pushMsg('context.update', { sessionId: sid, usagePercent: 50 })) // seq 3 state
    bus.publish(sid, pushMsg('message.tool_call_start', { sessionId: sid, n: 2 })) // seq 4 stream
    bus.publish(sid, pushMsg('session.subagents', { sessionId: sid, subagents: [] })) // seq 5 state
    bus.publish(sid, pushMsg('message.complete', { sessionId: sid, n: 3 })) // seq 6 stream
    bus.publish(sid, pushMsg('session.workflowUpdate', { sessionId: sid, runId: 'w1' })) // seq 7 state
    bus.publish(sid, pushMsg('session.state_changed', { sessionId: sid, modelId: 'm1' })) // seq 8 state

    const { cap, handler } = makeHandler({ messageBus: bus })
    await handler.handleSessionMessage(msg('session.subscribe', { sessionId: sid }), WS)

    expect(cap.errors).toHaveLength(0)
    expect(cap.replies).toHaveLength(1)
    const reply = cap.replies[0]
    expect(reply.type).toBe('session.subscribe')
    const { snapshot, stateSnapshot, lastSeq, gap } = reply.payload as {
      snapshot: ServerMessage[]
      stateSnapshot: ServerMessage[]
      lastSeq: number
      gap: boolean
    }
    // 旧死 gauge（seqCounter > ring.length = 8 > 3 恒真）会误报；R-03 后 gap 只在
    // fromSeq 早于 ring 最旧 seq 时为 true——本用例无 fromSeq，恒 false。
    expect(gap).toBe(false)
    // snapshot 只含 stream 类（state 不入 ring），按 seq 顺序
    expect(snapshot.map((m) => m.seq)).toEqual([2, 4, 6])
    // stateSnapshot 是 5 个 state topic 的 last-value
    expect(stateSnapshot).toHaveLength(5)
    expect(stateSnapshot.map((m) => m.type).sort()).toEqual([
      'context.update',
      'session.commands',
      'session.state_changed',
      'session.subagents',
      'session.workflowUpdate',
    ])
    expect(lastSeq).toBe(8)
  })

  // TC2: ring 溢出 + fromSeq 早于最旧 seq → gap=true，snapshot 全量不过滤
  it('TC2: ring overflow (cap 3, 4 stream) + fromSeq=1 → gap=true with full snapshot (no incremental filter)', async () => {
    const bus = new MessageBus(3)
    const sid = 's1'
    for (let i = 1; i <= 4; i++) {
      bus.publish(sid, pushMsg('message.status', { sessionId: sid, n: i })) // seq 1..4，seq1 被覆盖淘汰
    }

    const { cap, handler } = makeHandler({ messageBus: bus })
    await handler.handleSessionMessage(
      msg('session.subscribe', { sessionId: sid, fromSeq: 1 }),
      WS,
    )

    expect(cap.errors).toHaveLength(0)
    const reply = cap.replies[0].payload as {
      snapshot: ServerMessage[]
      lastSeq: number
      gap: boolean
    }
    // fromSeq=1 < ring 最旧 seq=2 → 溢出缺口，gap=true
    expect(reply.gap).toBe(true)
    // 全量回放路径：snapshot 未被 fromSeq 过滤（renderer 拿全量后自行全量重拉）
    expect(reply.snapshot.map((m) => m.seq)).toEqual([2, 3, 4])
    expect(reply.lastSeq).toBe(4)
  })

  // TC3: fromSeq 落在 ring 覆盖范围内 → gap=false，增量过滤
  it('TC3: fromSeq within ring coverage → gap=false with incremental snapshot (seq > fromSeq)', async () => {
    const bus = new MessageBus(3)
    const sid = 's1'
    for (let i = 1; i <= 4; i++) {
      bus.publish(sid, pushMsg('message.status', { sessionId: sid, n: i }))
    }

    const { cap, handler } = makeHandler({ messageBus: bus })
    await handler.handleSessionMessage(
      msg('session.subscribe', { sessionId: sid, fromSeq: 2 }),
      WS,
    )

    expect(cap.errors).toHaveLength(0)
    const reply = cap.replies[0].payload as {
      snapshot: ServerMessage[]
      gap: boolean
    }
    // fromSeq=2 等于 ring 最旧 seq → 无缺口，增量模式
    expect(reply.gap).toBe(false)
    expect(reply.snapshot.map((m) => m.seq)).toEqual([3, 4])
  })

  // TC4: messageBus 未注入 → sendError('subscribe_unsupported')
  it('TC4: messageBus not injected → sendError(subscribe_unsupported)', async () => {
    const { cap, handler } = makeHandler({ messageBus: undefined })
    await handler.handleSessionMessage(
      msg('session.subscribe', { sessionId: 's1' }),
      WS,
    )
    expect(cap.replies).toHaveLength(0)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0].code).toBe('subscribe_unsupported')
  })
})
