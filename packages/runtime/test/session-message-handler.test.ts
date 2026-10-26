/**
 * SessionMessageHandler 合并测试（cluster runtime-C04：8 文件折叠）。
 *
 * 来源（分节注释见内）：
 * - session-message-handler（原主文件：error envelope 回归）
 * - session-message-handler-bash / -handoff / -image-routes / -switch-reply
 * - fetch-current-prompt（fetchCurrentSystemPrompt 链路；顶层 beforeEach/afterEach
 *   为该节引入的通用 mock 清理，保留在顶层无语义冲突）
 * - session-message-handler-dispatch（W1 表驱动路由）/ -error-code
 *
 * 运行：cd packages/runtime && npx vitest run test/session-message-handler.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import { errorWithCode, MODEL_NOT_CONFIGURED, SESSION_NOT_FOUND, RESTORE_FAILED } from '../src/utils/errors.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import { makeSessionServiceEnv } from '../src/services/session/__tests__/helpers/session-service-test-env.js'

// ════════════════ 来源: session-message-handler.test.ts（原主文件）════════════════
interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeHandler(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    ensureActive: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    getSummary: vi.fn().mockReturnValue(undefined),
    restoreSession: vi.fn().mockResolvedValue({ id: 's1' }),
    deleteByCwd: vi.fn().mockResolvedValue({ cwd: '', deleted: [], failed: [] }),
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
const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' })

describe('SessionMessageHandler — error envelope 回归', () => {
  describe('message.send', () => {
    it('blocked (hook拦截/prompt失败) → sendError(message_blocked) + 不 reply success', async () => {
      const { cap, handler } = makeHandler({ sendMessage: vi.fn().mockResolvedValue({ blocked: true }) })
      await handler.handleSessionMessage(msg('message.send', { sessionId: 's1', content: 'hi' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'message_blocked', details: { sessionId: 's1' } })
      expect(cap.replies).toHaveLength(0) // 关键：不得 reply success，否则 pending.resolve 误判成功
    })

    it('未 blocked → reply message.status sent', async () => {
      const { cap, handler } = makeHandler()
      await handler.handleSessionMessage(msg('message.send', { sessionId: 's1', content: 'hi' }), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { status: 'sent' } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  // [MF-1-8 退役] message.steer / message.follow_up 路由已删除（u5a 退役条件兑现）：
  // 发送统一收敛 delivery.submit，error envelope 用例随路由一并退役。

  describe('session.compact', () => {
    it('ensureActive 失败 → sendError(compact_failed)', async () => {
      const { cap, handler } = makeHandler({ ensureActive: vi.fn().mockRejectedValue(new Error('restore fail')) })
      await handler.handleSessionCompact(msg('session.compact', { sessionId: 's1' }) as never, WS)
      expect(cap.errors[0]).toMatchObject({ code: 'compact_failed', id: 'm1' })
      expect(cap.replies).toHaveLength(0)
    })
    it('compact 失败 → sendError(compact_failed)', async () => {
      const { cap, handler } = makeHandler({ compact: vi.fn().mockRejectedValue(new Error('pi error')) })
      await handler.handleSessionCompact(msg('session.compact', { sessionId: 's1' }) as never, WS)
      expect(cap.errors[0]).toMatchObject({ code: 'compact_failed' })
    })
    it('成功 → reply session.compacted (带 ack id)', async () => {
      const { cap, handler } = makeHandler()
      await handler.handleSessionCompact(msg('session.compact', { sessionId: 's1' }) as never, WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.compacted', payload: { status: 'compacted' } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('session.switch auto-restore', () => {
    it('ENOENT → sendError(file_not_found)', async () => {
      const { cap, handler } = makeHandler({
        getSummary: vi.fn().mockReturnValue(undefined),
        ensureActive: vi.fn().mockRejectedValue(enoent),
      })
      await handler.handleSessionMessage(msg('session.switch', { sessionId: 's1' }), WS)
      expect(cap.errors[0]).toMatchObject({ code: 'file_not_found', id: 'm1' })
    })
    it('普通失败 → sendError(not_found)', async () => {
      const { cap, handler } = makeHandler({
        getSummary: vi.fn().mockReturnValue(undefined),
        ensureActive: vi.fn().mockRejectedValue(new Error('other')),
      })
      await handler.handleSessionMessage(msg('session.switch', { sessionId: 's1' }), WS)
      expect(cap.errors[0].code).toBe('not_found')
    })
  })

  describe('session.workflowAction + session.subagentAction（扩展 slash command 转发）', () => {
    it('workflowAction 成功 → reply session.workflowActionDone', async () => {
      const { cap, handler } = makeHandler({ workflowAction: vi.fn().mockResolvedValue(undefined) })
      await handler.handleSessionMessage(msg('session.workflowAction', { sessionId: 's1', action: 'abort', runId: 'wf-1' }), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.workflowActionDone', payload: { sessionId: 's1', action: 'abort', runId: 'wf-1' } })
      expect(cap.errors).toHaveLength(0)
    })

    it('subagentAction 成功 → reply session.subagentActionDone', async () => {
      const { cap, handler } = makeHandler({ subagentAction: vi.fn().mockResolvedValue(undefined) })
      await handler.handleSessionMessage(msg('session.subagentAction', { sessionId: 's1', action: 'cancel', subagentId: 'bg-1' }), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.subagentActionDone', payload: { sessionId: 's1', action: 'cancel', subagentId: 'bg-1' } })
      expect(cap.errors).toHaveLength(0)
    })

    it('subagentAction 失败 → 抛出（由 server.ts 外层 catch 转 sendError，handler 内不包裹）', async () => {
      const { cap, handler } = makeHandler({ subagentAction: vi.fn().mockRejectedValue(new Error('session not active')) })
      await expect(handler.handleSessionMessage(msg('session.subagentAction', { sessionId: 's1', action: 'cancel', subagentId: 'bg-1' }), WS)).rejects.toThrow('session not active')
      // handler 内不 sendError 也不 reply（由 server.ts 外层 catch 处理）
      expect(cap.replies).toHaveLength(0)
    })
  })

  describe('session.forceQuit（强杀 pi 进程）', () => {
    // reply message.status ack 契约（与 message.abort 对称）：缺失会让 renderer pending.register(msg.id) 永挂。
    it('成功 → reply message.status {status:"force_quit"} ack', async () => {
      const { cap, handler, ctx } = makeHandler({ forceQuit: vi.fn().mockResolvedValue(undefined) })
      await handler.handleSessionMessage(msg('session.forceQuit', { sessionId: 's1' }), WS)
      expect((ctx.sessionService as Record<string, unknown>).forceQuit).toHaveBeenCalledWith('s1')
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { sessionId: 's1', status: 'force_quit' } })
      expect(cap.errors).toHaveLength(0)
    })

    it('forceQuit 抛错 → 异常上抛（由 server.ts 外层 catch 转 sendError），不 reply', async () => {
      const { cap, handler } = makeHandler({ forceQuit: vi.fn().mockRejectedValue(new Error('kill failed')) })
      await expect(handler.handleSessionMessage(msg('session.forceQuit', { sessionId: 's1' }), WS)).rejects.toThrow('kill failed')
      expect(cap.replies).toHaveLength(0)
    })
  })

  // ── session.deleteByCwd（自 session-message-handler-deletebycwd.test.ts 并入）────────
  // D6a（integrity-hardening §3.6）后契约：handler 不再逐个直接调 clearExtensionTimeoutsForSession
  // ——挂起 UI 请求清理已汇聚到 onSessionDestroyed 回调（见 server-destroyed-converged-cleanup.test.ts）。
  // 本 describe 锁定路由行为（deleteByCwd 调用 / reply / broadcast / invalid_payload 检查）。
  describe('session.deleteByCwd', () => {
    it('W1TC4 正常 deleteByCwd + reply + broadcastSessionList（清理经 onSessionDestroyed 汇聚点，不经 handler）', async () => {
      const { cap, handler, ctx } = makeHandler({
        deleteByCwd: vi.fn().mockResolvedValue({ cwd: '/p', deleted: ['s1', 's3'], failed: [] }),
      })
      await handler.handleSessionMessage(msg('session.deleteByCwd', { cwd: '/p' }), WS)

      // deleteByCwd 调用参数透传
      expect(ctx.sessionService.deleteByCwd).toHaveBeenCalledWith('/p')
      // reply 1 次，payload 透传 BatchDeleteResult
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]).toMatchObject({
        id: 'm1',
        type: 'session.deletedByCwd',
        payload: { cwd: '/p', deleted: ['s1', 's3'], failed: [] },
      })
      // broadcastSessionList 1 次
      expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
    })

    it('W1TC5 部分失败 → reply 含 failed 数组（清理语义同上，经汇聚点）', async () => {
      const { cap, handler, ctx } = makeHandler({
        deleteByCwd: vi.fn().mockResolvedValue({
          cwd: '/p',
          deleted: ['s1'],
          failed: [{ sessionId: 's2', error: 'EPERM' }],
        }),
      })
      await handler.handleSessionMessage(msg('session.deleteByCwd', { cwd: '/p' }), WS)

      expect(cap.replies[0].payload).toEqual({
        cwd: '/p',
        deleted: ['s1'],
        failed: [{ sessionId: 's2', error: 'EPERM' }],
      })
      expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
    })

    it('W1TC6 空 cwd → sendError invalid_payload（不调 deleteByCwd）', async () => {
      const { cap, handler, ctx } = makeHandler({
        deleteByCwd: vi.fn().mockResolvedValue({ cwd: '', deleted: [], failed: [] }),
      })
      await handler.handleSessionMessage(msg('session.deleteByCwd', { cwd: '' }), WS)

      expect(ctx.sessionService.deleteByCwd).not.toHaveBeenCalled()
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'invalid_payload',
        message: 'session.deleteByCwd requires a non-empty "cwd" string',
      })
      expect(cap.replies).toHaveLength(0)
    })
  })
})

// ════════════════ 来源: session-message-handler-bash.test.ts ════════════════
// ---- 原文件头注释 ----
// SessionMessageHandler bash 请求路由测试（composer-bash-execute W1）。
// 锁定 message.bash / message.abortBash 的 ack 路由（回执契约 = bash 投递可靠性，dmg-r1-2）：
// - T11: message.bash 正常 → 调 sendBash(sid, cmd, excludeFromContext) → reply message.status{settled}
// - T12: sendBash 返回 settled+error（执行失败）→ reply 携带 error（失败不得伪装成无 error 成功回执，
// 也不再走 error envelope——error envelope 会让 pending.reject，消费方拿不到执行状态）
// - T13: message.bash 被预检拒绝（回执 rejected）→ reply message.status{rejected}
// - T14: message.abortBash → 调 abortBash(sid) → reply message.status{aborted}
// mock 模式参考 test/session-message-handler.test.ts（makeHandler + Captured reply/error）。
// /

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeBashHandler(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    sendBash: vi.fn().mockResolvedValue({ status: 'settled' }),
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


describe('SessionMessageHandler —— message.bash 路由', () => {
  // T11: 正常路径 → sendBash 调用 + reply 回执 settled
  it('T11: message.bash → 调 sendBash(sid, cmd, excludeFromContext) + reply message.status{settled}', async () => {
    const { ctx, cap, handler } = makeBashHandler()
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'ls', excludeFromContext: false }),
      WS,
    )

    // sendBash 被调，参数透传
    expect(ctx.sessionService.sendBash).toHaveBeenCalledWith('s1', 'ls', false)
    // reply 回执 settled（成功回执不带 error）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'settled' },
    })
    expect(cap.replies[0]!.payload.error).toBeUndefined()
    // 无 error envelope
    expect(cap.errors).toHaveLength(0)
  })

  // T12: 执行失败（回执 settled+error）→ reply 携带 error（失败不得伪装成无 error 成功回执）
  it('T12: sendBash 返回 settled+error（执行失败）→ reply 携带 error，不走 error envelope（消费方据回执判定，不再误判双执行）', async () => {
    const { ctx, cap, handler } = makeBashHandler({
      sendBash: vi.fn().mockResolvedValue({ status: 'settled', error: 'Bash execution failed' }),
    })
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'git status' }),
      WS,
    )

    // 回执携带执行状态 + 失败原因（消费方拿到 status 才能安全判定是否恢复草稿）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'message.status',
      payload: { sessionId: 's1', status: 'settled', error: 'Bash execution failed' },
    })
    // 不得伪装成无 error 的成功回执
    expect(cap.replies[0]!.payload.error).toBeDefined()
    // 不走 error envelope（error envelope 会让 pending.reject，回执状态就丢了）
    expect(cap.errors).toHaveLength(0)
  })

  // T13: rejected（预检拒绝/未执行）→ reply 回执 rejected
  it('T13: sendBash 返回回执 rejected → reply message.status{rejected}', async () => {
    const { cap, handler } = makeBashHandler({
      sendBash: vi.fn().mockResolvedValue({ status: 'rejected' }),
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

  // T12b: restore 失败（回执 rejected+error）→ reply 携带 error，未执行语义不变
  it('T12b: sendBash 返回 rejected+error（restore 失败）→ reply status{rejected}+error（未执行，可恢复草稿）', async () => {
    const { cap, handler } = makeBashHandler({
      sendBash: vi.fn().mockResolvedValue({ status: 'rejected', error: 'Failed to restore session: boom' }),
    })
    await handler.handleSessionMessage(
      msg('message.bash', { sessionId: 's1', command: 'ls' }),
      WS,
    )

    expect(cap.replies[0]).toMatchObject({
      type: 'message.status',
      payload: { sessionId: 's1', status: 'rejected', error: 'Failed to restore session: boom' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  // T11b: excludeFromContext 透传给 sendBash（undefined 时走 pi 默认）
  it('T11b: message.bash 不带 excludeFromContext → sendBash 第三参为 undefined', async () => {
    const { ctx, handler } = makeBashHandler()
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
    const { ctx, cap, handler } = makeBashHandler()
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

  // T14b（P6 断言④回执真实化）：sent=false（检查短路无 bash 可取消 / abort_bash 发送失败）
  // → 不得谎报 aborted，走 error envelope（renderer useChat.abortBash catch → markStreamingBashError 内联兜底）
  it('T14b: abortBash 返回 {sent:false} → sendError(abort_bash_not_sent)，不得回 message.status{aborted}', async () => {
    const { cap, handler } = makeBashHandler({
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

// ════════════════ 来源: session-message-handler-handoff.test.ts ════════════════
// ---- 原文件头注释 ----
// SessionMessageHandler handoff abort 路由测试（agent-driven wave2）。
// 锁定 session.abortHandoff 的 ack / 广播 / 错误路由（W1：abortHandoff 返回 boolean）：
// - TC3: 正常路径 → abortHandoff(sid) resolve(true) → broadcast handoffAborted + reply message.status{aborted}
// - TC3b: no-op 路径 → abortHandoff(sid) resolve(false)（无 inflight）→ 不广播，但仍 reply ack
// - TC4: handoffService 未注入（undefined）→ sendError('handoff_unsupported')，不 reply / broadcast
// - TC5: abortHandoff reject → sendError('handoff_failed')，不 reply / broadcast
// mock 模式参考 session-message-handler-bash.test.ts（makeHandler + Captured reply/error/broadcast）。
// /

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
  broadcasts: ServerMessage[]
}

interface MakeHandlerOpts {
  handoffService?: { abortHandoff: ReturnType<typeof vi.fn> } | undefined
}

function makeHandoffHandler(opts: MakeHandlerOpts = {}) {
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

function msgReq(type: string, payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


describe('SessionMessageHandler —— session.abortHandoff 路由', () => {
  // TC3: 主路径 → abortHandoff resolve(true) → broadcast handoffAborted + reply message.status{aborted}
  // W1：abortHandoff 返回 boolean，true=真正中断才广播；本用例 inflight 存在 → true。
  it('TC3: session.abortHandoff（true）→ 调 abortHandoff(sid) + broadcast session.handoffAborted + reply message.status{aborted}', async () => {
    const abortHandoff = vi.fn().mockResolvedValue(true)
    const { ctx, cap, handler } = makeHandoffHandler({ handoffService: { abortHandoff } })
    await handler.handleSessionMessage(
      msgReq('session.abortHandoff', { sessionId: 's1' }),
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
    const { ctx, cap, handler } = makeHandoffHandler({ handoffService: { abortHandoff } })
    await handler.handleSessionMessage(
      msgReq('session.abortHandoff', { sessionId: 's1' }),
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
    const { cap, handler } = makeHandoffHandler({ handoffService: undefined })
    await handler.handleSessionMessage(
      msgReq('session.abortHandoff', { sessionId: 's1' }),
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
    const { cap, handler } = makeHandoffHandler({ handoffService: { abortHandoff } })
    await handler.handleSessionMessage(
      msgReq('session.abortHandoff', { sessionId: 's1' }),
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

// ════════════════ 来源: session-message-handler-image-routes.test.ts ════════════════
// ---- 原文件头注释 ----
// SessionMessageHandler 业务持久化写 WS 路由测试（ipc-converge-a3 W2）。
// 锁定 session.writeImage / session.migrateImage / session.writeSegments 的 ack 路由：
// - 正常 → 调 sessionService.writeImage/migrateImage/writeSegmentsMetadata → reply
// session.writeImage:result / session.migrateImage:result / session.writeSegments:result
// - 失败 → sendError（write_image_failed / migrate_image_failed / write_segments_failed）
// 带 msg.id + payload.sessionId（缺失 sessionId 的消息前端忽略，见 AGENTS.md 规则 7）
// 安全检查本身（20MB 上限 / mimeType image/* / name sanitize 防目录穿越 / fromPath 白名单 /
// segments.json 原子写）在 test/session-service.test.ts「业务持久化写安全检查」覆盖，
// 本文件只测 WS 路由分支（reply/error 分叉）。
// mock 模式参考 src/__tests__/session-message-handler-bash.test.ts（makeHandler + Captured reply/error）。
// /

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeImageHandler(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    writeImage: vi.fn().mockResolvedValue({ path: '/att/x.png', persisted: true }),
    migrateImage: vi.fn().mockResolvedValue({ path: '/att/y.png' }),
    writeSegmentsMetadata: vi.fn().mockResolvedValue(undefined),
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


describe('SessionMessageHandler —— session.writeImage 路由', () => {
  it('正常 → 调 writeImage(sessionId, base64, mimeType, name) + reply session.writeImage:result', async () => {
    const { ctx, cap, handler } = makeImageHandler()
    const payload = { sessionId: 's1', base64: 'AQ==', mimeType: 'image/png', name: 'x.png' }
    await handler.handleSessionMessage(msg('session.writeImage', payload), WS)

    // 参数透传
    expect(ctx.sessionService.writeImage).toHaveBeenCalledWith('s1', 'AQ==', 'image/png', 'x.png')
    // reply result（含 persisted）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'session.writeImage:result',
      payload: { path: '/att/x.png', persisted: true },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('失败（如超 20MB）→ sendError(write_image_failed) 带 msg.id + sessionId，不 reply', async () => {
    const { cap, handler } = makeImageHandler({
      writeImage: vi.fn().mockRejectedValue(new Error('图片过大（21MB），上限 20MB')),
    })
    await handler.handleSessionMessage(
      msg('session.writeImage', { sessionId: 's1', base64: 'x', mimeType: 'image/png', name: 'big.png' }),
      WS,
    )

    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'write_image_failed',
      message: '图片过大（21MB），上限 20MB',
      details: { sessionId: 's1' },
    })
    // 失败不得 reply result
    expect(cap.replies).toHaveLength(0)
  })
})

describe('SessionMessageHandler —— session.migrateImage 路由', () => {
  it('正常 → 调 migrateImage(fromPath, sessionId, fileName) + reply session.migrateImage:result', async () => {
    const { ctx, cap, handler } = makeImageHandler()
    await handler.handleSessionMessage(
      msg('session.migrateImage', { fromPath: '/tmp/a.png', sessionId: 's1', fileName: 'a.png' }),
      WS,
    )

    // 参数透传
    expect(ctx.sessionService.migrateImage).toHaveBeenCalledWith('/tmp/a.png', 's1', 'a.png')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'session.migrateImage:result',
      payload: { path: '/att/y.png' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('失败（fromPath 在白名单外）→ sendError(migrate_image_failed) 带 msg.id + sessionId', async () => {
    const { cap, handler } = makeImageHandler({
      migrateImage: vi.fn().mockRejectedValue(new Error('migrate-session-image failed')),
    })
    await handler.handleSessionMessage(
      msg('session.migrateImage', { fromPath: '/Users/x/evil.txt', sessionId: 's1', fileName: 'x.txt' }),
      WS,
    )

    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'migrate_image_failed',
      message: 'migrate-session-image failed',
      details: { sessionId: 's1' },
    })
    expect(cap.replies).toHaveLength(0)
  })
})

describe('SessionMessageHandler —— session.writeSegments 路由', () => {
  it('正常 → 调 writeSegmentsMetadata(sessionId, entry) + reply session.writeSegments:result {}', async () => {
    const { ctx, cap, handler } = makeImageHandler()
    const entry = { clientUuid: 'u-1', segments: [{ type: 'text', text: 'hi' }], timestamp: 123 }
    await handler.handleSessionMessage(msg('session.writeSegments', { sessionId: 's1', entry }), WS)

    // 参数透传（entry 原样）
    expect(ctx.sessionService.writeSegmentsMetadata).toHaveBeenCalledWith('s1', entry)
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.writeSegments:result', payload: {} })
    expect(cap.errors).toHaveLength(0)
  })

  it('失败（sessionId 为空）→ sendError(write_segments_failed) 带 msg.id + sessionId', async () => {
    const { cap, handler } = makeImageHandler({
      writeSegmentsMetadata: vi.fn().mockRejectedValue(new Error('write-segments-metadata requires non-empty sessionId')),
    })
    await handler.handleSessionMessage(msg('session.writeSegments', { sessionId: '', entry: {} }), WS)

    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'write_segments_failed',
      message: 'write-segments-metadata requires non-empty sessionId',
      details: { sessionId: '' },
    })
    expect(cap.replies).toHaveLength(0)
  })
})

// ════════════════ 来源: session-message-handler-switch-reply.test.ts ════════════════
// ---- 原文件头注释 ----
// session.switch reply 瘦身测试（wave:perf-w20，R-11）。
// 锁定两条语义：
// - switch reply 类型是 session.switched（payload { sessionId, session }），**无 messages 字段**——
// switch 不再无条件全量 getHistory 塞 reply（长 session 数 MB 的纯浪费序列化）
// - handler 不调 getHistory（历史消费路径是 renderer selectSession 内显式 session.history RPC）
// renderer 兼容性佐证：renderer switchSession 返回 void 不读 reply payload（core
// use-session.ts selectSession 在 switchSession 后显式 chat.getHistory 拉历史），
// renderer 侧现有用例全绿（rpc-type-pairing.test.ts 已同步更新映射断言）。
// mock 模式参考 session-message-handler-subscribe.test.ts（makeHandler + Captured）。
// /

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string }[]
}

function makeSwitchHandler(getSummaryResult: Record<string, unknown> | undefined) {
  const cap: Captured = { replies: [], errors: [] }
  const getHistory = vi.fn(async () => ({ messages: [], truncated: false }))
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      cap.errors.push({ id, code, message })
    }),
    sessionService: {
      getSummary: vi.fn(() => getSummaryResult),
      ensureActive: vi.fn().mockResolvedValue(undefined),
      getHistory,
    },
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { cap, handler, getHistory, ctx }
}

function switchMsg(sessionId: string, id = 'req-1'): ClientMessage {
  return { type: 'session.switch', id, payload: { sessionId } } as unknown as ClientMessage
}

const SUMMARY = { id: 's-1', label: 'test', cwd: '/tmp' }

describe('session.switch reply 瘦身（R-11）', () => {
  it('getSummary 命中：reply session.switched { sessionId, session }，无 messages 字段且不调 getHistory', async () => {
    const { cap, handler, getHistory } = makeSwitchHandler(SUMMARY)
    await handler.handleSessionMessage(switchMsg('s-1'), {} as never)

    expect(cap.errors).toHaveLength(0)
    expect(cap.replies).toHaveLength(1)
    const reply = cap.replies[0]
    expect(reply.type).toBe('session.switched')
    expect(reply.payload).toEqual({ sessionId: 's-1', session: SUMMARY })
    // messages 字段不存在（reply 类型 session.switched 无此字段——R-11 瘦身的类型级锁定）
    expect('messages' in reply.payload).toBe(false)
    expect('historyTruncated' in reply.payload).toBe(false)
    // switch 不再拉历史（renderer 显式 session.history RPC 才是历史消费路径）
    expect(getHistory).not.toHaveBeenCalled()
  })

  it('getSummary 未命中：ensureActive 后 reply session.switched，同样无 messages 且不调 getHistory', async () => {
    const { cap, handler, getHistory, ctx } = makeSwitchHandler(undefined)
    // 首次 getSummary（handler 内）返回 undefined，restore 后再取返回 summary
    let call = 0
    ;(ctx.sessionService as { getSummary: ReturnType<typeof vi.fn> }).getSummary.mockImplementation(() => {
      call++
      return call === 1 ? undefined : SUMMARY
    })

    await handler.handleSessionMessage(switchMsg('s-restore'), {} as never)
    expect(cap.errors).toHaveLength(0)
    expect(cap.replies[0]?.type).toBe('session.switched')
    expect(cap.replies[0]?.payload).toEqual({ sessionId: 's-restore', session: SUMMARY })
    expect('messages' in (cap.replies[0]?.payload ?? {})).toBe(false)
    expect(getHistory).not.toHaveBeenCalled()
  })

  it('restore 失败：仍走 error envelope（not_found），reply 不含历史 payload', async () => {
    const cap: Captured = { replies: [], errors: [] }
    const ctx = {
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
        cap.errors.push({ id, code, message })
      }),
      sessionService: {
        getSummary: vi.fn(() => undefined),
        ensureActive: vi.fn().mockRejectedValue(new Error('restore failed')),
        getHistory: vi.fn(),
      },
    }
    const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    await handler.handleSessionMessage(switchMsg('s-missing'), {} as never)
    expect(cap.replies).toHaveLength(0)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]?.code).toBe('not_found')
  })
})

// ════════════════ 来源: fetch-current-prompt.test.ts ════════════════
// ---- 原文件头注释 ----
// fetchCurrentSystemPrompt runtime 链路测试（session-trace design §3.1 失败路径 / D2）。
// 覆盖：
// - 非活跃 session（无 pi 进程）→ throw code=session_not_active
// - busy 预检（isGenerating/isCompacting）→ throw code=session_busy
// - 成功路径：prompt 发 /__taiji_get_system_prompt__ → 轮询 get_entries(since=基线) 命中
// taiji:current-system-prompt custom entry → 返回 fullText/charCount/fetchedAt +
// traceLeafCache 基线滚动 + bus.publish session.traceEntryAppended（DATA 行留痕）
// - 轮询超时（命令未产出 entry）→ throw code=fetch_current_prompt_timeout
// - WS handler：reply session.currentSystemPrompt（含 sessionId，规则 7）/ 错误 sendError code
// SessionService 装配（makeSessionStore / makeSessionServiceEnv）收敛
// __tests__/helpers/session-service-test-env.ts。
// /


const SID = 'sid-fetch-prompt'

/** 轮询超时用例：get_entries 全量/增量恒空（命令未产出 entry）。 */
function mockGetEntriesAlwaysEmpty(client: ReturnType<typeof makeSessionServiceEnv>['client']): void {
  client.getEntries.mockImplementation(async (since?: string) =>
    since === undefined
      ? { data: { entries: [], leafId: 'leaf0' } }
      : { data: { entries: [], leafId: 'leaf0' } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchCurrentSystemPrompt（常驻扩展现取通道）', () => {
  it('非活跃 session（无 pi 进程）→ throw code=session_not_active', async () => {
    const { svc } = makeSessionServiceEnv({ active: false, sid: SID })
    await expect(svc.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_not_active' })
  })

  it('busy 预检：isGenerating → throw code=session_busy（命令会排队，预检拒绝更诚实）', async () => {
    const { svc, busyReady } = makeSessionServiceEnv({ busy: true, sid: SID })
    await busyReady
    await expect(svc.fetchCurrentSystemPrompt(SID)).rejects.toMatchObject({ code: 'session_busy' })
  })

  it('成功路径：发命令 → 轮询 since 命中 custom entry → 返回值 + 基线滚动 + journal 增量广播', async () => {
    const { svc, client, publishSpy, promptCalls, sinceBaselineRef } = makeSessionServiceEnv({ active: true, sid: SID })
    const result = await svc.fetchCurrentSystemPrompt(SID)
    // 命令发出（双下划线内部命令，不经 LLM）
    expect(promptCalls).toEqual(['/__taiji_get_system_prompt__'])
    // 增量轮询以全量建的基线为 since
    expect(sinceBaselineRef()).toBe('leaf0')
    // 返回值 = entry data 提取
    expect(result).toEqual({
      sessionId: SID,
      fullText: 'PROMPT-BODY',
      charCount: 11,
      fetchedAt: '2026-08-20T10:00:00.000Z',
    })
    // journal 增量：traceEntryAppended 广播（含 sessionId，规则 7）带现取 entry
    const push = publishSpy.mock.calls.find(([, m]) => (m as ServerMessage).type === 'session.traceEntryAppended')
    expect(push).toBeDefined()
    const payload = (push?.[1] as { payload: { sessionId: string; entries: unknown[]; leafId: string | null } }).payload
    expect(payload.sessionId).toBe(SID)
    expect(payload.leafId).toBe('leaf1')
    expect((payload.entries[0] as { customType?: string }).customType).toBe('taiji:current-system-prompt')
    // 基线滚动：后续 trace 增量从 leaf1 起（第二次 since）
    expect(client.getEntries).toHaveBeenCalledWith('leaf0')
  })

  it('轮询超时（命令未产出 entry）→ throw code=fetch_current_prompt_timeout', async () => {
    vi.useFakeTimers()
    const { svc, client } = makeSessionServiceEnv({ active: true, sid: SID })
    // 增量恒空（命令未产出）
    mockGetEntriesAlwaysEmpty(client)
    const pending = svc.fetchCurrentSystemPrompt(SID)
    // 先 attach rejection 断言再推进 timer（否则 rejection 发生时无 handler，报 unhandled）
    const expectation = expect(pending).rejects.toMatchObject({ code: 'fetch_current_prompt_timeout' })
    await vi.advanceTimersByTimeAsync(8500)
    await expectation
  })
})

describe('session.fetchCurrentSystemPrompt WS handler', () => {
  it('reply session.currentSystemPrompt（含 sessionId）；非活跃 → sendError code=session_not_active', async () => {
    const { svc } = makeSessionServiceEnv({ active: true, sid: SID })
    const replies: { type: string; payload: Record<string, unknown> }[] = []
    const errors: { code: string }[] = []
    const handler = new SessionMessageHandler({
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, _id: string | undefined, type: string, payload: Record<string, unknown>) => {
        replies.push({ type, payload })
      }),
      sendError: vi.fn((_ws: unknown, code: string) => {
        errors.push({ code })
      }),
      sessionService: svc,
    } as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    const WS = { readyState: 1, send: vi.fn() } as never

    await handler.handleSessionMessage({ type: 'session.fetchCurrentSystemPrompt', id: 'm1', payload: { sessionId: SID } } as never, WS)
    expect(replies[0]?.type).toBe('session.currentSystemPrompt')
    expect(replies[0]?.payload.sessionId).toBe(SID)
    expect(replies[0]?.payload.fullText).toBe('PROMPT-BODY')

    const { svc: deadSvc } = makeSessionServiceEnv({ active: false, sid: SID })
    const handler2 = new SessionMessageHandler({
      send: vi.fn(),
      reply: vi.fn(),
      sendError: vi.fn((_ws: unknown, code: string) => {
        errors.push({ code })
      }),
      sessionService: deadSvc,
    } as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    await handler2.handleSessionMessage({ type: 'session.fetchCurrentSystemPrompt', id: 'm2', payload: { sessionId: SID } } as never, WS)
    expect(errors.map((e) => e.code)).toContain('session_not_active')
  })
})

// ════════════════ 来源: session-message-handler-dispatch.test.ts ════════════════
// ---- 原文件头注释 ----
// SessionMessageHandler 分发路由特征锚定测试（复杂度债务偿还 W1 回归保护）。
// 背景：handleSessionMessage 从 ~40 分支 switch 重构为表驱动分发（routes map + case 体
// 提取为私有 helper）。本文件锁定「消息 type → service 调用 → reply/error 形态」的对应
// 关系与错误文案，重构若漂移路由键或错误路径，此处先红。
// 覆盖此前无测试的分支：
// - session.restore 三错误分支（MODEL_NOT_CONFIGURED / SESSION_NOT_FOUND / RESTORE_FAILED 兜底）
// - session.handoff 本体（unsupported / 成功 sent / handoff_failed）
// - session.unsubscribe（bus 未注入 unsupported / 正常 ack）
// - message.abort 成功 ack（[MF-1-8] message.follow_up 路由已退役，随 delivery.submit 收敛）
// - config.sessions / session.getCommands / session.getContext（null payload 分支）/
// session.rename 等纯转发抽样
// - 未知 type 落空（不发任何消息、不抛错）
// /

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
  broadcasts: ServerMessage[]
}

function makeDispatchHandler(overrides: Record<string, ReturnType<typeof vi.fn>> = {}, ctxExtras: Record<string, unknown> = {}) {
  const cap: Captured = { replies: [], errors: [], broadcasts: [] }
  const sessionService = {
    restoreSession: vi.fn().mockResolvedValue({ id: 's1' }),
    listPersistedSessions: vi.fn().mockReturnValue([]),
    getSummary: vi.fn().mockReturnValue(undefined),
    ensureActive: vi.fn().mockResolvedValue(undefined),
    getCommands: vi.fn().mockResolvedValue([]),
    fetchContext: vi.fn().mockResolvedValue(null),
    renameSession: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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
    nextPushId: vi.fn().mockReturnValue('push-1'),
    broadcastSessionList: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
    ...ctxExtras,
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { ctx, cap, handler }
}


describe('SessionMessageHandler 分发路由（W1 表驱动重构回归锚定）', () => {
  describe('session.restore 三错误分支', () => {
    it('MODEL_NOT_CONFIGURED → sendError(MODEL_NOT_CONFIGURED)，不 reply success', async () => {
      const { cap, handler } = makeDispatchHandler({
        restoreSession: vi.fn().mockRejectedValue(errorWithCode('No model configured', MODEL_NOT_CONFIGURED)),
      })
      await handler.handleSessionMessage(msg('session.restore', { sessionId: 's1' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: MODEL_NOT_CONFIGURED,
        message: expect.stringContaining('No model configured'),
      })
      expect(cap.replies).toHaveLength(0)
    })

    it('SESSION_NOT_FOUND → sendError(SESSION_NOT_FOUND)，不 reply success', async () => {
      const { cap, handler } = makeDispatchHandler({
        restoreSession: vi.fn().mockRejectedValue(errorWithCode('session gone', SESSION_NOT_FOUND)),
      })
      await handler.handleSessionMessage(msg('session.restore', { sessionId: 's1' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: SESSION_NOT_FOUND, message: 'session gone' })
      expect(cap.replies).toHaveLength(0)
    })

    it('其它错误 → sendError(RESTORE_FAILED) 兜底（spawn pi / initialize 失败统一汇入此处）', async () => {
      const { cap, handler } = makeDispatchHandler({
        restoreSession: vi.fn().mockRejectedValue(new Error('pi spawn failed')),
      })
      await handler.handleSessionMessage(msg('session.restore', { sessionId: 's1' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: RESTORE_FAILED, message: 'pi spawn failed' })
      expect(cap.replies).toHaveLength(0)
    })

    it('成功 → reply session.created 后 broadcastSessionList（顺序锚定）', async () => {
      const order: string[] = []
      const { ctx, cap, handler } = makeDispatchHandler({
        restoreSession: vi.fn().mockImplementation(async () => {
          order.push('restoreSession')
          return { id: 's1' }
        }),
      })
      ;(ctx.broadcastSessionList as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('broadcastSessionList') })
      await handler.handleSessionMessage(msg('session.restore', { sessionId: 's1' }), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.created', payload: { session: { id: 's1' } } })
      expect(ctx.broadcastSessionList).toHaveBeenCalledOnce()
      expect(order).toEqual(['restoreSession', 'broadcastSessionList'])
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('session.handoff 本体（abortHandoff 已有独立测试文件）', () => {
    it('handoffService 未注入 → sendError(handoff_unsupported, "handoff service not available")，不 reply', async () => {
      const { cap, handler } = makeDispatchHandler()
      await handler.handleSessionMessage(msg('session.handoff', { sessionId: 's1', reply: 'r1' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'handoff_unsupported',
        message: 'handoff service not available',
        details: { sessionId: 's1' },
      })
      expect(cap.replies).toHaveLength(0)
    })

    it('runHandoff 成功 → reply message.status{sent}（不经 broadcast）', async () => {
      const runHandoff = vi.fn().mockResolvedValue(undefined)
      const { cap, handler } = makeDispatchHandler({}, { handoffService: { runHandoff } })
      await handler.handleSessionMessage(msg('session.handoff', { sessionId: 's1', reply: 'r1' }), WS)
      expect(runHandoff).toHaveBeenCalledWith('s1', 'r1', { modelOverride: undefined, thinkingOverride: undefined })
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { sessionId: 's1', status: 'sent' } })
      expect(cap.errors).toHaveLength(0)
    })

    it('runHandoff 失败 → sendError(handoff_failed)（文案含底层错误），不 reply success', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const runHandoff = vi.fn().mockRejectedValue(new Error('history is empty'))
      const { cap, handler } = makeDispatchHandler({}, { handoffService: { runHandoff } })
      await handler.handleSessionMessage(msg('session.handoff', { sessionId: 's1', reply: 'r1' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'handoff_failed',
        message: 'history is empty',
        details: { sessionId: 's1' },
      })
      expect(cap.replies).toHaveLength(0)
      consoleSpy.mockRestore()
    })
  })

  describe('session.unsubscribe（IF7）', () => {
    it('messageBus 未注入 → sendError(subscribe_unsupported, "message bus not available")，不 reply', async () => {
      const { cap, handler } = makeDispatchHandler()
      await handler.handleSessionMessage(msg('session.unsubscribe', { sessionId: 's1' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'subscribe_unsupported',
        message: 'message bus not available',
        details: { sessionId: 's1' },
      })
      expect(cap.replies).toHaveLength(0)
    })

    it('bus 注入 → bus.unsubscribe(sessionId, ws) + reply message.status{unsubscribed} ack', async () => {
      const unsubscribe = vi.fn()
      const { cap, handler } = makeDispatchHandler({}, { messageBus: { unsubscribe } })
      await handler.handleSessionMessage(msg('session.unsubscribe', { sessionId: 's1' }), WS)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledWith('s1', WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { sessionId: 's1', status: 'unsubscribed' } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('message.abort 成功路径（失败路径已有回归测试）', () => {
    it('message.abort → abort(sid) + reply message.status{aborted}（pending ack 契约）', async () => {
      const { ctx, cap, handler } = makeDispatchHandler()
      await handler.handleSessionMessage(msg('message.abort', { sessionId: 's1' }), WS)
      expect(ctx.sessionService.abort).toHaveBeenCalledWith('s1')
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { sessionId: 's1', status: 'aborted' } })
      expect(ctx.invalidatePendingUiRequests).toHaveBeenCalledWith('s1', 'turn-aborted')
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('纯转发路由抽样（表驱动 key ↔ service 方法 ↔ reply type 对应）', () => {
    it('config.sessions → reply config.sessions { groups: listPersistedSessions() }', async () => {
      const listPersistedSessions = vi.fn().mockReturnValue([{ id: 'a' }])
      const { cap, handler } = makeDispatchHandler({ listPersistedSessions })
      await handler.handleSessionMessage(msg('config.sessions', {}), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'config.sessions', payload: { groups: [{ id: 'a' }] } })
    })

    it('session.list → listSessions(query) + reply session.list { groups }（W4b 通用查询，过滤参数透传）', async () => {
      const listSessions = vi.fn().mockReturnValue([{ cwd: '/repo', sessions: [{ id: 'line-1', surface: 'btw' }] }])
      const { cap, handler } = makeDispatchHandler({ listSessions })
      await handler.handleSessionMessage(msg('session.list', { surface: 'btw', mainSessionId: 'main-1' }), WS)
      expect(listSessions).toHaveBeenCalledWith({ surface: 'btw', mainSessionId: 'main-1' })
      expect(cap.replies[0]).toMatchObject({
        id: 'm1',
        type: 'session.list',
        payload: { groups: [{ cwd: '/repo', sessions: [{ id: 'line-1', surface: 'btw' }] }] },
      })
    })

    it('session.list → 缺省过滤键不落 payload（undefined 键显式剔除，query 形态稳定）', async () => {
      const listSessions = vi.fn().mockReturnValue([])
      const { handler } = makeDispatchHandler({ listSessions })
      await handler.handleSessionMessage(msg('session.list', {}), WS)
      expect(listSessions).toHaveBeenCalledWith({})
    })

    it('session.list → listSessions 未装配（测试最小 mock）= session_list_unsupported，不静默空回复', async () => {
      const { cap, handler } = makeDispatchHandler()
      await handler.handleSessionMessage(msg('session.list', { surface: 'btw' }), WS)
      expect(cap.replies).toHaveLength(0)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'session_list_unsupported' })
    })

    it('session.getCommands → getCommands(sid) + reply session.commands（规则 7：payload 带 sessionId）', async () => {
      const getCommands = vi.fn().mockResolvedValue([{ name: 'run' }])
      const { ctx, cap, handler } = makeDispatchHandler({ getCommands })
      await handler.handleSessionMessage(msg('session.getCommands', { sessionId: 's1' }), WS)
      expect(ctx.sessionService.getCommands).toHaveBeenCalledWith('s1')
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.commands', payload: { sessionId: 's1', commands: [{ name: 'run' }] } })
    })

    it('session.getContext：fetchContext 返回 null → reply context.update 仅含 sessionId（「未知」不编码为 0/null 字段）', async () => {
      const { cap, handler } = makeDispatchHandler({ fetchContext: vi.fn().mockResolvedValue(null) })
      await handler.handleSessionMessage(msg('session.getContext', { sessionId: 's1' }), WS)
      expect(cap.replies[0]).toEqual({ id: 'm1', type: 'context.update', payload: { sessionId: 's1' } })
    })

    it('session.getContext：fetchContext 有值 → reply context.update { sessionId, ...payload }', async () => {
      const { cap, handler } = makeDispatchHandler({ fetchContext: vi.fn().mockResolvedValue({ tokens: 100 }) })
      await handler.handleSessionMessage(msg('session.getContext', { sessionId: 's1' }), WS)
      expect(cap.replies[0]).toMatchObject({ type: 'context.update', payload: { sessionId: 's1', tokens: 100 } })
    })

    it('session.rename → renameSession + reply session.renamed + broadcastSessionList（顺序锚定）', async () => {
      const order: string[] = []
      const { ctx, cap, handler } = makeDispatchHandler({
        renameSession: vi.fn().mockImplementation(async () => { order.push('renameSession') }),
      })
      ;(ctx.broadcastSessionList as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('broadcastSessionList') })
      await handler.handleSessionMessage(msg('session.rename', { sessionId: 's1', name: 'new-name' }), WS)
      expect(ctx.sessionService.renameSession).toHaveBeenCalledWith('s1', 'new-name')
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.renamed', payload: { sessionId: 's1', name: 'new-name' } })
      expect(ctx.broadcastSessionList).toHaveBeenCalledOnce()
      expect(order).toEqual(['renameSession', 'broadcastSessionList'])
    })
  })

  it('未知 type → 查表落空：sendError(handler_not_registered)，不发 reply（RT-1#6 显形）', async () => {
    const { ctx, cap, handler } = makeDispatchHandler()
    await expect(handler.handleSessionMessage(msg('session.nonexistent', {}), WS)).resolves.toBeUndefined()
    expect(cap.replies).toHaveLength(0)
    // 落空不再静默（RT-1#6）：显式 error 信封让前端 pending Promise 立即失败，而非等到泛化超时。
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'handler_not_registered',
      message: expect.stringContaining('session.nonexistent'),
    })
    expect(ctx.broadcast).not.toHaveBeenCalled()
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
  })

  it('落空信封透传 payload.sessionId（session 隔离裁决：错误可归属）', async () => {
    const { cap, handler } = makeDispatchHandler()
    await handler.handleSessionMessage(msg('session.nonexistent', { sessionId: 's9' }), WS)
    expect(cap.errors[0]?.details).toEqual({ sessionId: 's9' })
  })
})

// ════════════════ 来源: session-message-handler-error-code.test.ts ════════════════
// ---- 原文件头注释 ----
// W1 / L4: session.create/fork model 未配置时返回差异化 error code（MODEL_NOT_CONFIGURED）。
// 背景：原实现 session.create/fork 失败走 server.ts 统一 catch → 'handler_error'，
// 前端无法区分「model 未配置」和「其他错误」，无法引导用户去 Settings 配置。
// 修复：lifecycle 层用 errorWithCode 抛带 .code 的 Error；handler 层 try/catch
// 捕获 MODEL_NOT_CONFIGURED 并 sendError(MODEL_NOT_CONFIGURED)，让前端据此引导。
// /

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeErrCodeHandler(createImpl: ReturnType<typeof vi.fn>, forkImpl?: ReturnType<typeof vi.fn>, deleteImpl?: ReturnType<typeof vi.fn>) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    create: createImpl,
    forkSession: forkImpl ?? vi.fn().mockResolvedValue({ id: 'forked' }),
    delete: deleteImpl ?? vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    ensureActive: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    getSummary: vi.fn().mockReturnValue(undefined),
    restoreSession: vi.fn().mockResolvedValue({ id: 's1' }),
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


describe('W1/L4: session.create/fork model 未配置返回 MODEL_NOT_CONFIGURED', () => {
  it('create: model 未配置 → 错误上抛（MODEL_NOT_CONFIGURED 信封由 server 中央透传等价给出）', async () => {
    const createError = errorWithCode(
      'No model configured. Please configure a provider and model in Settings before starting a session.',
      MODEL_NOT_CONFIGURED,
    )
    const { cap, handler } = makeErrCodeHandler(vi.fn().mockRejectedValue(createError))
    // [R3-b22-S2] create/fork 的专用 try/catch 已删——错误上抛 server.ts 外层 catch，
    // code 信封逐字节等价由 server-error-envelope 套件锁定；此处断言不吞错且 code 不变
    await expect(handler.handleSessionMessage(
      msg('session.create', { cwd: '/repo', label: 'repo' }),
      WS,
    )).rejects.toMatchObject({ code: MODEL_NOT_CONFIGURED })
    expect(cap.replies).toHaveLength(0)
  })

  it('fork: model 未配置 → 错误上抛（MODEL_NOT_CONFIGURED 信封由 server 中央透传等价给出）', async () => {
    const forkError = errorWithCode(
      'No model configured. Please configure a provider and model in Settings before forking a session.',
      MODEL_NOT_CONFIGURED,
    )
    const { cap, handler } = makeErrCodeHandler(
      vi.fn().mockResolvedValue({ id: 's1' }),
      vi.fn().mockRejectedValue(forkError),
    )
    await expect(handler.handleSessionMessage(
      msg('session.fork', { srcSessionId: 'src1', fromPiEntryId: 'entry1', includeFrom: true }),
      WS,
    )).rejects.toMatchObject({ code: MODEL_NOT_CONFIGURED })
    expect(cap.replies).toHaveLength(0)
  })

  it('create: 非 MODEL_NOT_CONFIGURED 错误 → rethrow（走 server.ts 统一 handler_error）', async () => {
    const otherError = new Error('pi spawn failed')
    const { cap, handler } = makeErrCodeHandler(vi.fn().mockRejectedValue(otherError))
    // 非 MODEL_NOT_CONFIGURED 错误应向上抛出（不被 handler 吞掉）
    await expect(
      handler.handleSessionMessage(
        msg('session.create', { cwd: '/repo', label: 'repo' }),
        WS,
      ),
    ).rejects.toThrow('pi spawn failed')
    // handler 自身不 sendError（由 server.ts 统一 catch 处理）
    expect(cap.errors).toHaveLength(0)
  })
})

// u-h4/P4-1 回归锁（timeout-audit-hygiene-batch §3.4）：trash 失败时 delete case 不吞错误、
// 不 reply 成功——错误向上抛给 server.ts handleMessage 外层统一 catch → sendError
//（e.code ?? 'handler_error'），handler 内不加 try/catch（设计 P4-1 判定：外层收尾已存在）。
describe('u-h4: session.delete trash 失败错误通道', () => {
  it('delete: sessionService.delete throw（移废纸篓失败）→ rethrow 不吞、不 reply session.deleted', async () => {
    const trashError = new Error(
      '移入废纸篓失败（Finder 未在 5s 内响应或命令失败）。文件已保留在原位置，未做任何删除：/s/abc.jsonl。👉 稍后重试删除；或手动在访达中将该文件拖入废纸篓。',
    )
    const { cap, handler } = makeErrCodeHandler(
      vi.fn().mockResolvedValue({ id: 's1' }),
      undefined,
      vi.fn().mockRejectedValue(trashError),
    )
    await expect(
      handler.handleSessionMessage(msg('session.delete', { sessionId: 'del-1' }), WS),
    ).rejects.toThrow('移入废纸篓失败')
    // 关键：失败时绝不 reply session.deleted（否则前端误判删除成功）
    expect(cap.replies).toHaveLength(0)
    // handler 自身不 sendError——sendError 由 server.ts 外层统一收尾负责
    expect(cap.errors).toHaveLength(0)
  })
})
