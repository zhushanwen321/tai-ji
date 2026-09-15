/**
 * SessionMessageHandler bash 请求路由测试（composer-bash-execute W1）。
 *
 * 锁定 message.bash / message.abortBash 的 ack 路由：
 * - T11: message.bash 正常 → 调 sendBash(sid, cmd, excludeFromContext) → reply message.status{sent}
 * - T12: sendBash 返回 {blocked:true}（非 rejected）→ sendError('message_blocked') 非 reply status{sent}
 * - T13: message.bash 被预检拒绝（result.rejected）→ reply message.status{rejected}
 * - T14: message.abortBash → 调 abortBash(sid) → reply message.status{aborted}
 *
 * mock 模式参考 test/session-message-handler.test.ts（makeHandler + Captured reply/error）。
 *
 * 运行：npx vitest run src/__tests__/session-message-handler-bash.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import type { ClientMessage } from '@taiji/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeHandler(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    sendBash: vi.fn().mockResolvedValue({ blocked: false }),
    // P6 断言④回执真实化：abortBash 返回 { sent }，默认 sent=true（abort_bash 发出且 pi 确认）
    abortBash: vi.fn().mockResolvedValue({ sent: true }),
    // 其他方法 stub（handler 构造可能引用，保留最小实现避免 NPE）
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    ensureActive: vi.fn().mockResolvedValue(undefined),
    ...sessionOverrides,
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    sessionService,
    nextPushId: vi.fn().mockReturnValue('p1'),
    broadcastSessionList: vi.fn(),
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { ctx, cap, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('SessionMessageHandler —— message.bash 路由', () => {
  // T11: 正常路径 → sendBash 调用 + reply status{sent}
  it('T11: message.bash → 调 sendBash(sid, cmd, excludeFromContext) + reply message.status{sent}', async () => {
    const { ctx, cap, handler } = makeHandler()
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'ls', excludeFromContext: false }),
      WS,
    )

    // sendBash 被调，参数透传
    expect(ctx.sessionService.sendBash).toHaveBeenCalledWith('s1', 'ls', false)
    // reply status{sent}
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'sent' },
    })
    // 无 error
    expect(cap.errors).toHaveLength(0)
  })

  // T12: blocked（执行失败，非 rejected）→ sendError('message_blocked')
  it('T12: sendBash 返回 {blocked:true}（非 rejected）→ sendError(message_blocked) 非 reply status{sent}', async () => {
    const { ctx, cap, handler } = makeHandler({
      sendBash: vi.fn().mockResolvedValue({ blocked: true }),
    })
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'git status' }),
      WS,
    )

    // sendError 而非 reply status
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'message_blocked',
      details: { sessionId: 's1' },
    })
    // 不得 reply status{sent}
    const sentReply = cap.replies.find((r) => r.payload.status === 'sent')
    expect(sentReply).toBeUndefined()
  })

  // T13: rejected（预检拒绝）→ reply status{rejected}
  it('T13: sendBash 返回 {blocked:true, rejected:true} → reply message.status{rejected}', async () => {
    const { cap, handler } = makeHandler({
      sendBash: vi.fn().mockResolvedValue({ blocked: true, rejected: true }),
    })
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'ls' }),
      WS,
    )

    expect(cap.replies[0]).toMatchObject({
      type: 'message.status',
      payload: { sessionId: 's1', status: 'rejected' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  // T11b: excludeFromContext 透传给 sendBash（undefined 时走 pi 默认）
  it('T11b: message.bash 不带 excludeFromContext → sendBash 第三参为 undefined', async () => {
    const { ctx, handler } = makeHandler()
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'pwd' }),
      WS,
    )
    expect(ctx.sessionService.sendBash).toHaveBeenCalledWith('s1', 'pwd', undefined)
  })
})

describe('SessionMessageHandler —— message.abortBash 路由', () => {
  // T14: abortBash（sent=true，abort_bash 已发出且 pi 确认）→ reply status{aborted}
  it('T14: message.abortBash → 调 abortBash(sid) + reply message.status{aborted}', async () => {
    const { ctx, cap, handler } = makeHandler()
    await handler.handleSessionMessage(
      msg('message.abortBash', { sessionId: 's1' }),
      WS,
    )

    // abortBash 被调
    expect(ctx.sessionService.abortBash).toHaveBeenCalledWith('s1')
    // reply status{aborted}
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'aborted' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  // T14b（P6 断言④回执真实化）：sent=false（守卫短路无 bash 可取消 / abort_bash 发送失败）
  // → 不得谎报 aborted，走 error envelope（renderer useChat.abortBash catch → stopFailed 兜底）
  it('T14b: abortBash 返回 {sent:false} → sendError(abort_bash_not_sent)，不得回 message.status{aborted}', async () => {
    const { cap, handler } = makeHandler({
      abortBash: vi.fn().mockResolvedValue({ sent: false }),
    })
    await handler.handleSessionMessage(
      msg('message.abortBash', { sessionId: 's1' }),
      WS,
    )

    // 不得回 aborted（未发送 abort 时谎报已取消 = P6 实证缺口）
    const abortedReply = cap.replies.find((r) => r.payload.status === 'aborted')
    expect(abortedReply).toBeUndefined()
    expect(cap.replies).toHaveLength(0)
    // error envelope（诚实报错）
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'abort_bash_not_sent',
      details: { sessionId: 's1' },
    })
  })
})
