/**
 * SessionMessageHandler 分发路由特征锚定测试（复杂度债务偿还 W1 回归保护）。
 *
 * 背景：handleSessionMessage 从 ~40 分支 switch 重构为表驱动分发（routes map + case 体
 * 提取为私有 helper）。本文件锁定「消息 type → service 调用 → reply/error 形态」的对应
 * 关系与错误文案，重构若漂移路由键或错误路径，此处先红。
 *
 * 覆盖此前无测试的分支：
 * - session.restore 三错误分支（MODEL_NOT_CONFIGURED / SESSION_NOT_FOUND / RESTORE_FAILED 兜底）
 * - session.handoff 本体（unsupported / 成功 sent / handoff_failed）
 * - session.unsubscribe（bus 未注入 unsupported / 正常 ack）
 * - message.abort 成功 ack / message.follow_up 成功 queued
 * - config.sessions / session.getCommands / session.getContext（null payload 分支）/
 *   session.rename 等纯转发抽样
 * - 未知 type 落空（不发任何消息、不抛错）
 *
 * 运行：cd packages/runtime && npx vitest run test/session-message-handler-dispatch.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import { errorWithCode, MODEL_NOT_CONFIGURED, SESSION_NOT_FOUND, RESTORE_FAILED } from '../src/utils/errors.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
  broadcasts: ServerMessage[]
}

function makeHandler(overrides: Record<string, ReturnType<typeof vi.fn>> = {}, ctxExtras: Record<string, unknown> = {}) {
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
    followUpMessage: vi.fn().mockResolvedValue(undefined),
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

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('SessionMessageHandler 分发路由（W1 表驱动重构回归锚定）', () => {
  describe('session.restore 三错误分支', () => {
    it('MODEL_NOT_CONFIGURED → sendError(MODEL_NOT_CONFIGURED)，不 reply success', async () => {
      const { cap, handler } = makeHandler({
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
      const { cap, handler } = makeHandler({
        restoreSession: vi.fn().mockRejectedValue(errorWithCode('session gone', SESSION_NOT_FOUND)),
      })
      await handler.handleSessionMessage(msg('session.restore', { sessionId: 's1' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: SESSION_NOT_FOUND, message: 'session gone' })
      expect(cap.replies).toHaveLength(0)
    })

    it('其它错误 → sendError(RESTORE_FAILED) 兜底（spawn pi / initialize 失败统一归口）', async () => {
      const { cap, handler } = makeHandler({
        restoreSession: vi.fn().mockRejectedValue(new Error('pi spawn failed')),
      })
      await handler.handleSessionMessage(msg('session.restore', { sessionId: 's1' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: RESTORE_FAILED, message: 'pi spawn failed' })
      expect(cap.replies).toHaveLength(0)
    })

    it('成功 → reply session.created 后 broadcastSessionList（顺序锚定）', async () => {
      const order: string[] = []
      const { ctx, cap, handler } = makeHandler({
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
      const { cap, handler } = makeHandler()
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
      const { cap, handler } = makeHandler({}, { handoffService: { runHandoff } })
      await handler.handleSessionMessage(msg('session.handoff', { sessionId: 's1', reply: 'r1' }), WS)
      expect(runHandoff).toHaveBeenCalledWith('s1', 'r1', { modelOverride: undefined, thinkingOverride: undefined })
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { sessionId: 's1', status: 'sent' } })
      expect(cap.errors).toHaveLength(0)
    })

    it('runHandoff 失败 → sendError(handoff_failed)（文案含底层错误），不 reply success', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const runHandoff = vi.fn().mockRejectedValue(new Error('history is empty'))
      const { cap, handler } = makeHandler({}, { handoffService: { runHandoff } })
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
      const { cap, handler } = makeHandler()
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
      const { cap, handler } = makeHandler({}, { messageBus: { unsubscribe } })
      await handler.handleSessionMessage(msg('session.unsubscribe', { sessionId: 's1' }), WS)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledWith('s1', WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { sessionId: 's1', status: 'unsubscribed' } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('message.abort / message.follow_up 成功路径（失败路径已有回归测试）', () => {
    it('message.abort → abort(sid) + reply message.status{aborted}（pending ack 契约）', async () => {
      const { ctx, cap, handler } = makeHandler()
      await handler.handleSessionMessage(msg('message.abort', { sessionId: 's1' }), WS)
      expect(ctx.sessionService.abort).toHaveBeenCalledWith('s1')
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { sessionId: 's1', status: 'aborted' } })
      expect(ctx.invalidatePendingUiRequests).toHaveBeenCalledWith('s1', 'turn-aborted')
      expect(cap.errors).toHaveLength(0)
    })

    it('message.follow_up 成功 → reply message.status{queued}', async () => {
      const { ctx, cap, handler } = makeHandler()
      await handler.handleSessionMessage(msg('message.follow_up', { sessionId: 's1', content: 'next' }), WS)
      expect(ctx.sessionService.followUpMessage).toHaveBeenCalledWith('s1', 'next')
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'message.status', payload: { sessionId: 's1', status: 'queued' } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('纯转发路由抽样（表驱动 key ↔ service 方法 ↔ reply type 对应）', () => {
    it('config.sessions → reply config.sessions { groups: listPersistedSessions() }', async () => {
      const listPersistedSessions = vi.fn().mockReturnValue([{ id: 'a' }])
      const { cap, handler } = makeHandler({ listPersistedSessions })
      await handler.handleSessionMessage(msg('config.sessions', {}), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'config.sessions', payload: { groups: [{ id: 'a' }] } })
    })

    it('session.getCommands → getCommands(sid) + reply session.commands（规则 7：payload 带 sessionId）', async () => {
      const getCommands = vi.fn().mockResolvedValue([{ name: 'run' }])
      const { ctx, cap, handler } = makeHandler({ getCommands })
      await handler.handleSessionMessage(msg('session.getCommands', { sessionId: 's1' }), WS)
      expect(ctx.sessionService.getCommands).toHaveBeenCalledWith('s1')
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.commands', payload: { sessionId: 's1', commands: [{ name: 'run' }] } })
    })

    it('session.getContext：fetchContext 返回 null → reply context.update 仅含 sessionId（「未知」不编码为 0/null 字段）', async () => {
      const { cap, handler } = makeHandler({ fetchContext: vi.fn().mockResolvedValue(null) })
      await handler.handleSessionMessage(msg('session.getContext', { sessionId: 's1' }), WS)
      expect(cap.replies[0]).toEqual({ id: 'm1', type: 'context.update', payload: { sessionId: 's1' } })
    })

    it('session.getContext：fetchContext 有值 → reply context.update { sessionId, ...payload }', async () => {
      const { cap, handler } = makeHandler({ fetchContext: vi.fn().mockResolvedValue({ tokens: 100 }) })
      await handler.handleSessionMessage(msg('session.getContext', { sessionId: 's1' }), WS)
      expect(cap.replies[0]).toMatchObject({ type: 'context.update', payload: { sessionId: 's1', tokens: 100 } })
    })

    it('session.rename → renameSession + reply session.renamed + broadcastSessionList（顺序锚定）', async () => {
      const order: string[] = []
      const { ctx, cap, handler } = makeHandler({
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
    const { ctx, cap, handler } = makeHandler()
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
    const { cap, handler } = makeHandler()
    await handler.handleSessionMessage(msg('session.nonexistent', { sessionId: 's9' }), WS)
    expect(cap.errors[0]?.details).toEqual({ sessionId: 's9' })
  })
})
