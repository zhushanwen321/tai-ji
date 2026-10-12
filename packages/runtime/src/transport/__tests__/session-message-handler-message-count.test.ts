/**
 * SessionMessageHandler 消息计数 RPC 测试（悬停详情卡消息计数，ui-replica-demo-fidelity 通道 2）。
 *
 * 覆盖：
 * - handles 认领 session.getMessageCount
 * - 透传契约：handler 调 sessionService.getMessageCount（SessionRecords 路径解析 + 流式计数的
 *   转发面），reply session.getMessageCount { sessionId, count } 形状（计数语义断言在
 *   src/services/session/__tests__/session-message-count.test.ts）
 * - 端口缺省（SessionService 未组装转发，仅测试最小 mock 形态）→ message_count_unsupported
 *   error envelope（防御分支，对齐 getPlanState 惯例）
 * - 读失败（service throw）→ message_count_failed error envelope（msg.id + sessionId 必带），
 *   不 reply——renderer 收 error 后计数段占位不渲染
 *
 * Mock 边界：全部 mock（ctx 仿 session-message-handler-plan 测试装置），不起真实 pi、不触
 * 真实数据目录（计数正确性的 fixture 断言在 session-message-count.test.ts，tmpdir 自建自删）。
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler-message-count.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'

import { SessionMessageHandler, type SessionHandlerContext } from '../session-message-handler.js'
import type { ISessionService } from '../../interfaces.js'
import type { ClientMessage } from '@taiji/shared'

const SID = 'sess-count-1'

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}

function mockContext(sessionService: ISessionService): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// ── handles 清单 ────────────────────────────────────────────────

describe('SessionMessageHandler.handles（消息计数）', () => {
  it('认领 session.getMessageCount', () => {
    const handler = new SessionMessageHandler(mockContext({} as unknown as ISessionService))
    expect(handler.handles).toContain('session.getMessageCount')
  })
})

// ── session.getMessageCount（通道 2 按需拉取）────────────────────

describe('SessionMessageHandler session.getMessageCount', () => {
  it('透传：调 sessionService.getMessageCount + reply 同名 { sessionId, count } 形状', async () => {
    const getMessageCount = vi.fn(async () => 42)
    const ctx = mockContext({ getMessageCount } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.getMessageCount', { sessionId: SID }), mockWs())

    expect(getMessageCount).toHaveBeenCalledTimes(1)
    expect(getMessageCount).toHaveBeenCalledWith(SID)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.getMessageCount', {
      sessionId: SID,
      count: 42,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('count 0（文件缺失 pi 延迟写入窗口 / 空会话）正常 reply 非错误', async () => {
    const getMessageCount = vi.fn(async () => 0)
    const ctx = mockContext({ getMessageCount } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.getMessageCount', { sessionId: SID }), mockWs())

    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.getMessageCount', {
      sessionId: SID,
      count: 0,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('端口缺省（SessionService 未组装转发）→ message_count_unsupported error envelope（sessionId 必带）', async () => {
    const ctx = mockContext({} as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.getMessageCount', { sessionId: SID }), mockWs())

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'message_count_unsupported',
      expect.any(String),
      'msg-1',
      { sessionId: SID },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('读失败（service throw，非 ENOENT 类）→ message_count_failed error envelope，不 reply', async () => {
    const getMessageCount = vi.fn(async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    const ctx = mockContext({ getMessageCount } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(
      msg('session.getMessageCount', { sessionId: SID }, 'msg-err'),
      mockWs(),
    )

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'message_count_failed',
      expect.stringContaining('EACCES'),
      'msg-err',
      { sessionId: SID },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
