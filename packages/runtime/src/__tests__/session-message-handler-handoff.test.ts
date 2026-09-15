/**
 * SessionMessageHandler handoff abort 路由测试（agent-driven wave2）。
 *
 * 锁定 session.abortHandoff 的 ack / 广播 / 错误路由（W1：abortHandoff 返回 boolean）：
 * - TC3: 正常路径 → abortHandoff(sid) resolve(true) → broadcast handoffAborted + reply message.status{aborted}
 * - TC3b: no-op 路径 → abortHandoff(sid) resolve(false)（无 inflight）→ 不广播，但仍 reply ack
 * - TC4: handoffService 未注入（undefined）→ sendError('handoff_unsupported')，不 reply / broadcast
 * - TC5: abortHandoff reject → sendError('handoff_failed')，不 reply / broadcast
 *
 * mock 模式参考 session-message-handler-bash.test.ts（makeHandler + Captured reply/error/broadcast）。
 *
 * 运行：npx vitest run src/__tests__/session-message-handler-handoff.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
  broadcasts: ServerMessage[]
}

interface MakeHandlerOpts {
  handoffService?: { abortHandoff: ReturnType<typeof vi.fn> } | undefined
}

function makeHandler(opts: MakeHandlerOpts = {}) {
  const cap: Captured = { replies: [], errors: [], broadcasts: [] }
  const sessionService = {
    // stub（handler 构造可能引用，保留最小实现避免 NPE）
    ensureActive: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    broadcast: vi.fn((msg: ServerMessage) => {
      cap.broadcasts.push(msg)
    }),
    sessionService,
    handoffService: opts.handoffService,
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcastSessionList: vi.fn(),
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { ctx, cap, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('SessionMessageHandler —— session.abortHandoff 路由', () => {
  // TC3: 主路径 → abortHandoff resolve(true) → broadcast handoffAborted + reply message.status{aborted}
  // W1：abortHandoff 返回 boolean，true=真正中断才广播；本用例 inflight 存在 → true。
  it('TC3: session.abortHandoff（true）→ 调 abortHandoff(sid) + broadcast session.handoffAborted + reply message.status{aborted}', async () => {
    const abortHandoff = vi.fn().mockResolvedValue(true)
    const { ctx, cap, handler } = makeHandler({ handoffService: { abortHandoff } })
    await handler.handleSessionMessage(
      msg('session.abortHandoff', { sessionId: 's1' }),
      WS,
    )

    // abortHandoff 被调一次，参数透传
    expect(abortHandoff).toHaveBeenCalledTimes(1)
    expect(abortHandoff).toHaveBeenCalledWith('s1')
    // broadcast session.handoffAborted
    expect(cap.broadcasts).toHaveLength(1)
    expect(cap.broadcasts[0]).toMatchObject({
      type: 'session.handoffAborted',
      id: 'push-1',
      payload: { srcSessionId: 's1' },
    })
    // reply message.status{aborted}
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req-1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'aborted' },
    })
    // 无 error
    expect(cap.errors).toHaveLength(0)
    // nextPushId 被调（广播 id 用）
    expect(ctx.nextPushId).toHaveBeenCalled()
  })

  // TC3b: W1 no-op 路径 → abortHandoff resolve(false)（无 inflight）→ 不广播但仍 reply ack
  it('TC3b: session.abortHandoff（false / no-op）→ 不 broadcast handoffAborted，仍 reply message.status{aborted}', async () => {
    const abortHandoff = vi.fn().mockResolvedValue(false)
    const { ctx, cap, handler } = makeHandler({ handoffService: { abortHandoff } })
    await handler.handleSessionMessage(
      msg('session.abortHandoff', { sessionId: 's1' }),
      WS,
    )

    // abortHandoff 仍被调（handler 不预判，由 service 返回值决定是否广播）
    expect(abortHandoff).toHaveBeenCalledTimes(1)
    expect(abortHandoff).toHaveBeenCalledWith('s1')
    // no-op 不广播 handoffAborted（前端不重复复位，避免 aborted→complete 抖动）
    expect(cap.broadcasts).toHaveLength(0)
    // RPC ack 始终发（让 renderer pending resolve）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req-1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'aborted' },
    })
    expect(cap.errors).toHaveLength(0)
    // no-op 不广播 → nextPushId 不该被调
    expect(ctx.nextPushId).not.toHaveBeenCalled()
  })

  // TC4: handoffService 未注入 → sendError('handoff_unsupported')，不 reply / broadcast
  it('TC4: handoffService 未注入 → sendError(handoff_unsupported)，不 reply / broadcast', async () => {
    const { cap, handler } = makeHandler({ handoffService: undefined })
    await handler.handleSessionMessage(
      msg('session.abortHandoff', { sessionId: 's1' }),
      WS,
    )

    // sendError 被调
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'req-1',
      code: 'handoff_unsupported',
      message: expect.stringContaining('handoff service not available'),
      details: { sessionId: 's1' },
    })
    // 不得 reply / broadcast
    expect(cap.replies).toHaveLength(0)
    expect(cap.broadcasts).toHaveLength(0)
  })

  // TC5: abortHandoff reject → sendError('handoff_failed', message 含 'boom')，不 reply / broadcast
  it('TC5: abortHandoff reject → sendError(handoff_failed, message 含 boom)，不 reply / broadcast', async () => {
    const abortHandoff = vi.fn().mockRejectedValue(new Error('boom'))
    const { cap, handler } = makeHandler({ handoffService: { abortHandoff } })
    await handler.handleSessionMessage(
      msg('session.abortHandoff', { sessionId: 's1' }),
      WS,
    )

    // abortHandoff 被调一次（即使最终失败）
    expect(abortHandoff).toHaveBeenCalledTimes(1)
    expect(abortHandoff).toHaveBeenCalledWith('s1')
    // sendError 被调（code handoff_failed, message 含 boom）
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'req-1',
      code: 'handoff_failed',
      message: expect.stringContaining('boom'),
      details: { sessionId: 's1' },
    })
    // 不得 reply message.status{aborted}
    const abortedReply = cap.replies.find((r) => r.payload.status === 'aborted')
    expect(abortedReply).toBeUndefined()
    // 不得 broadcast
    expect(cap.broadcasts).toHaveLength(0)
  })
})
