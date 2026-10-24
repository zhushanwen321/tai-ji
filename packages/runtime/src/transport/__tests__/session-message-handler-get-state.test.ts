/**
 * SessionMessageHandler session.getState RPC 测试（权威拉取与冷读，W2）。
 *
 * 覆盖：
 * - handles 认领 session.getState（routes/handles 派生单源，漏登记即红）
 * - 透传契约：handler 调 SessionStateQuery.getState，reply 同名
 *   `{ sessionId, modelId?, thinkingLevel? }` 形状（活/冷分派与冷读语义断言在
 *   src/services/session/__tests__/session-state-query.test.ts）
 * - 会话不存在 → SESSION_NOT_FOUND 结构化错误 envelope（不返回空对象伪装成功）
 * - 读失败（service throw 非 SESSION_NOT_FOUND）→ session_get_state_failed envelope
 * - 查询服务未装配（仅测试最小 mock 形态：模块槽未绑定）→ session_state_query_unavailable
 *
 * Mock 边界：全部 mock（ctx 仿 message-count / plan 测试装置），不起真实 pi、不触真实
 * 数据目录。查询服务实例经模块槽注入/清理（生产由 SessionStateProjection 构造期绑定）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'

import { SessionMessageHandler, type SessionHandlerContext } from '../session-message-handler.js'
import {
  SessionStateQuery,
  SessionNotFoundError,
  bindSessionStateQuery,
  _resetSessionStateQueryForTest,
  type SessionStateQueryDeps,
} from '../../services/session/session-state-query.js'
import type { ISessionService } from '../../interfaces.js'
import type { ClientMessage } from '@taiji/shared'

const SID = 'sess-state-1'

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}

function mockContext(sessionService: ISessionService = {} as unknown as ISessionService): SessionHandlerContext {
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

/** 装配一个可操控 reply 的查询服务并绑进模块槽，返回 getState spy */
function bindQuery(reply: unknown): ReturnType<typeof vi.fn> {
  const getState = vi.fn(async () => reply)
  const deps: SessionStateQueryDeps = {
    getClient: () => undefined,
    getReplicatedStates: () => undefined,
    locateMainSessionFileFromCache: () => undefined,
    locateMainSessionFileFromDisk: () => undefined,
    locateBtwLineFile: () => undefined,
  }
  // 直接替换实例方法（查询服务本体行为由 session-state-query.test.ts 锁定，本文件只测接线）
  const query = new SessionStateQuery(deps)
  vi.spyOn(query, 'getState').mockImplementation(getState as never)
  bindSessionStateQuery(query)
  return getState
}

afterEach(() => {
  _resetSessionStateQueryForTest()
  vi.restoreAllMocks()
})

describe('SessionMessageHandler.handles（权威拉取与冷读）', () => {
  it('认领 session.getState', () => {
    const handler = new SessionMessageHandler(mockContext())
    expect(handler.handles).toContain('session.getState')
  })
})

describe('SessionMessageHandler session.getState', () => {
  it('透传：调 SessionStateQuery.getState + reply 同名 { sessionId, modelId?, thinkingLevel? }', async () => {
    const getState = bindQuery({ sessionId: SID, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    const ctx = mockContext()
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.getState', { sessionId: SID }), mockWs())

    expect(getState).toHaveBeenCalledTimes(1)
    expect(getState).toHaveBeenCalledWith(SID)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.getState', {
      sessionId: SID,
      modelId: 'prov-a/model-a',
      thinkingLevel: 'high',
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('快照未就绪 / 冷文件无模型记录：字段缺省正常 reply 非错误（显式未知）', async () => {
    bindQuery({ sessionId: SID })
    const ctx = mockContext()
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.getState', { sessionId: SID }), mockWs())

    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.getState', { sessionId: SID })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('会话不存在 → SESSION_NOT_FOUND 结构化错误 envelope（sessionId 必带，不 reply 空对象）', async () => {
    const getState = vi.fn(async () => {
      throw new SessionNotFoundError(SID)
    })
    const deps: SessionStateQueryDeps = {
      getClient: () => undefined,
      getReplicatedStates: () => undefined,
      locateMainSessionFileFromCache: () => undefined,
      locateMainSessionFileFromDisk: () => undefined,
      locateBtwLineFile: () => undefined,
    }
    const query = new SessionStateQuery(deps)
    vi.spyOn(query, 'getState').mockImplementation(getState as never)
    bindSessionStateQuery(query)

    const ctx = mockContext()
    const handler = new SessionMessageHandler(ctx)
    await handler.handleSessionMessage(msg('session.getState', { sessionId: SID }), mockWs())

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'SESSION_NOT_FOUND',
      expect.any(String),
      'msg-1',
      { sessionId: SID },
    )
  })

  it('读失败（非 SESSION_NOT_FOUND）→ session_get_state_failed envelope', async () => {
    const getState = vi.fn(async () => {
      throw new Error('EACCES: permission denied')
    })
    const deps: SessionStateQueryDeps = {
      getClient: () => undefined,
      getReplicatedStates: () => undefined,
      locateMainSessionFileFromCache: () => undefined,
      locateMainSessionFileFromDisk: () => undefined,
      locateBtwLineFile: () => undefined,
    }
    const query = new SessionStateQuery(deps)
    vi.spyOn(query, 'getState').mockImplementation(getState as never)
    bindSessionStateQuery(query)

    const ctx = mockContext()
    const handler = new SessionMessageHandler(ctx)
    await handler.handleSessionMessage(msg('session.getState', { sessionId: SID }), mockWs())

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'session_get_state_failed',
      expect.any(String),
      'msg-1',
      { sessionId: SID },
    )
  })

  it('查询服务未装配（模块槽未绑定，仅测试最小 mock 形态）→ session_state_query_unavailable', async () => {
    const ctx = mockContext()
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.getState', { sessionId: SID }), mockWs())

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'session_state_query_unavailable',
      expect.any(String),
      'msg-1',
      { sessionId: SID },
    )
  })
})
