/**
 * SessionMessageHandler workflow 可视化两 RPC 分发测试（workflow-visualization U3，
 * 设计 §3.1-4 / §3.1-5）：
 *
 * - handles 认领 session.getWorkflowRunEvents / session.getWorkflowDag
 * - 结构化错误臂（领域回执 { runId, code, message } 闭集）经 reply 正常返回，不走
 *   error envelope（renderer 按码分流降级形态）
 * - RPC 通道错误（service throw）→ error envelope（reportFailure 收口，sessionId 必带）
 * - 端口缺省（SessionService 未组装转发，仅测试最小 mock 形态）→ *_unsupported
 *   error envelope（对齐 getPlanState / revokeMessage 防御分支口径）
 *
 * 装置：ctx 仿 session-message-handler-background-task 测试的 mockContext 范式。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler-workflow-viz.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SessionMessageHandler, type SessionHandlerContext } from '../session-message-handler.js'
import type { ISessionService } from '../../interfaces.js'
import type { ClientMessage, WorkflowDagReply, WorkflowRunEventsReply } from '@taiji/shared'

const SID = 's1'
const RUN_ID = 'run-1'

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as unknown as import('ws').WebSocket
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

/** sessionService 桩：仅注入本域可选交叉成员（缺省形态 = 端口未组装防御分支）。 */
function fakeSessionService(overrides: Partial<ISessionService & Record<string, unknown>> = {}): ISessionService {
  return overrides as unknown as ISessionService
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SessionMessageHandler.handles（workflow-viz 域）', () => {
  it('认领 session.getWorkflowRunEvents / session.getWorkflowDag 两消息', () => {
    const handler = new SessionMessageHandler(mockContext(fakeSessionService()))
    expect(handler.handles).toContain('session.getWorkflowRunEvents')
    expect(handler.handles).toContain('session.getWorkflowDag')
  })
})

describe('SessionMessageHandler workflow-viz 端口缺省', () => {
  it('转发未组装 → *_unsupported error envelope（sessionId 必带，防御分支）', async () => {
    const ctx = mockContext(fakeSessionService())
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.getWorkflowRunEvents', { sessionId: SID, runId: RUN_ID }), ws)
    await handler.handleSessionMessage(msg('session.getWorkflowDag', { sessionId: SID, runId: RUN_ID }), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(2)
    const codes = vi.mocked(ctx.sendError).mock.calls.map((call) => call[1])
    expect(codes).toEqual(['workflow_run_events_unsupported', 'workflow_dag_unsupported'])
    for (const call of vi.mocked(ctx.sendError).mock.calls) {
      expect(call[4]).toEqual({ sessionId: SID })
    }
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})

describe('SessionMessageHandler session.getWorkflowRunEvents', () => {
  it('成功与结构化错误臂都经 reply 正常返回（领域回执不走 error envelope）', async () => {
    const eventsReply: WorkflowRunEventsReply = { runId: RUN_ID, events: [] }
    const notFoundReply: WorkflowRunEventsReply = { runId: RUN_ID, code: 'record_not_found', message: 'gone' }
    const svc = fakeSessionService({
      getWorkflowRunEvents: vi.fn().mockResolvedValueOnce(eventsReply).mockResolvedValueOnce(notFoundReply),
    })
    const ctx = mockContext(svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.getWorkflowRunEvents', { sessionId: SID, runId: RUN_ID }, 'm1'), ws)
    await handler.handleSessionMessage(msg('session.getWorkflowRunEvents', { sessionId: SID, runId: RUN_ID }, 'm2'), ws)

    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenNthCalledWith(1, ws, 'm1', 'session.workflowRunEvents', eventsReply)
    expect(ctx.reply).toHaveBeenNthCalledWith(2, ws, 'm2', 'session.workflowRunEvents', notFoundReply)
  })

  it('通道错误：service throw → workflow_run_events_failed error envelope（sessionId 必带）', async () => {
    const svc = fakeSessionService({
      getWorkflowRunEvents: vi.fn(async () => { throw new Error('disk unavailable') }),
    })
    const ctx = mockContext(svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.getWorkflowRunEvents', { sessionId: SID, runId: RUN_ID }), ws)

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'workflow_run_events_failed', expect.stringContaining('disk unavailable'), 'msg-1', { sessionId: SID })
  })
})

describe('SessionMessageHandler session.getWorkflowDag', () => {
  it('成功与结构化错误臂（四码闭集形态）都经 reply 正常返回', async () => {
    const dagReply: WorkflowDagReply = { runId: RUN_ID, dag: { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] } }
    const parseFailedReply: WorkflowDagReply = { runId: RUN_ID, code: 'parse_failed', message: 'unsupported syntax' }
    const svc = fakeSessionService({
      getWorkflowDag: vi.fn().mockResolvedValueOnce(dagReply).mockResolvedValueOnce(parseFailedReply),
    })
    const ctx = mockContext(svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.getWorkflowDag', { sessionId: SID, runId: RUN_ID }, 'm1'), ws)
    await handler.handleSessionMessage(msg('session.getWorkflowDag', { sessionId: SID, runId: RUN_ID }, 'm2'), ws)

    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenNthCalledWith(1, ws, 'm1', 'session.workflowDag', dagReply)
    expect(ctx.reply).toHaveBeenNthCalledWith(2, ws, 'm2', 'session.workflowDag', parseFailedReply)
  })

  it('通道错误：service throw → workflow_dag_failed error envelope（sessionId 必带）', async () => {
    const svc = fakeSessionService({
      getWorkflowDag: vi.fn(async () => { throw new Error('unexpected fs failure') }),
    })
    const ctx = mockContext(svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.getWorkflowDag', { sessionId: SID, runId: RUN_ID }), ws)

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'workflow_dag_failed', expect.stringContaining('unexpected fs failure'), 'msg-1', { sessionId: SID })
  })
})
