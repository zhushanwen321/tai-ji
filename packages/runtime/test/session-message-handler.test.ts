/**
 * SessionMessageHandler 单测 — 覆盖 round-7 引入的请求级 error envelope 回归保护。
 *
 * 重点（report #4）：message.send blocked / steer·follow_up 失败 / session.compact 三路 / session.switch ENOENT。
 * 这些路径专为修 pendingMap 永挂泄漏，无测试下次重构极易回退。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/session-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeHandler(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    steerMessage: vi.fn().mockResolvedValue(undefined),
    followUpMessage: vi.fn().mockResolvedValue(undefined),
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

  describe('message.steer', () => {
    it('失败 → sendError(steer_failed)', async () => {
      const { cap, handler } = makeHandler({ steerMessage: vi.fn().mockRejectedValue(new Error('no active pi')) })
      await handler.handleSessionMessage(msg('message.steer', { sessionId: 's1', content: 'x' }), WS)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'steer_failed', details: { sessionId: 's1' } })
    })
    it('成功 → reply queued... 实为 steered', async () => {
      const { cap, handler } = makeHandler()
      await handler.handleSessionMessage(msg('message.steer', { sessionId: 's1', content: 'x' }), WS)
      expect(cap.replies[0].payload).toMatchObject({ status: 'steered' })
    })
  })

  describe('message.follow_up', () => {
    it('失败 → sendError(follow_up_failed)', async () => {
      const { cap, handler } = makeHandler({ followUpMessage: vi.fn().mockRejectedValue(new Error('boom')) })
      await handler.handleSessionMessage(msg('message.follow_up', { sessionId: 's1', content: 'x' }), WS)
      expect(cap.errors[0]).toMatchObject({ code: 'follow_up_failed', details: { sessionId: 's1' } })
    })
  })

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
  // 本 describe 锁定路由行为（deleteByCwd 调用 / reply / broadcast / invalid_payload 守卫）。
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
