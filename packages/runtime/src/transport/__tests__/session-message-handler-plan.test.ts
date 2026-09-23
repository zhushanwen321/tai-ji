/**
 * SessionMessageHandler plan 域 RPC 测试（plan 模式重设计 D1⑥/D5/E9，u1-rpc）。
 *
 * 覆盖：
 * - handles 认领 session.getPlanState / session.abortPlan
 * - getPlanState：冷路径复用断言（handler 透传 sessionService.getPlanState 结果不自行派生，
 *   D1「派生代码唯一」不变量在传输层的体现）+ reply 复用 session.planState 广播 payload 形状；
 *   端口缺省（SessionService 未组装转发，仅测试最小 mock 形态）→ plan_state_unsupported
 *   error envelope（防御分支，对齐 backgroundTasks 惯例）
 * - abortPlan 两分支（D5/E9；MF-1-7 编排下沉后 handler 契约 = 纯透传）：
 *   ① sessionService.abortPlan resolve → reply message.status ack（失效链不经 handler，
 *      单一出口在 server.ts 的 setOnPlanAborted 消费）；
 *   ② abortPlan throw（恢复失败 / 直发失败，E9）→ abort_plan_failed error envelope
 *      （msg.id + sessionId 必带），不 reply——前端 sendCommand 检查 reply success 失败后
 *      经 sendError 呈现 E9 恢复指引。编排语义断言在
 *      src/services/session/__tests__/session-service-abort-plan.test.ts
 *
 * Mock 边界：全部 mock（ctx 仿 session-message-handler-background-task 测试装置），不起真实 pi。
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler-plan.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'

import { SessionMessageHandler, type SessionHandlerContext } from '../session-message-handler.js'
import type { ISessionService } from '../../interfaces.js'
import type { ClientMessage, PlanStateView } from '@taiji/shared'

const SID = 'sess-plan-1'

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

const ACTIVE_VIEW: PlanStateView = {
  isActive: true,
  planFilePath: '/tmp/.taiji-harness/some-slug/plan.md',
  requirement: '重构 auth 模块',
  templateName: null,
  skills: ['tech-design', 'dev-flow'],
  reviewState: 'awaiting',
}

// ── handles 清单 ────────────────────────────────────────────────

describe('SessionMessageHandler.handles（plan 域）', () => {
  it('认领 session.getPlanState / session.abortPlan', () => {
    const handler = new SessionMessageHandler(mockContext({} as unknown as ISessionService))
    expect(handler.handles).toContain('session.getPlanState')
    expect(handler.handles).toContain('session.abortPlan')
  })
})

// ── session.getPlanState（D1⑥ 冷启动首拉）───────────────────────

describe('SessionMessageHandler session.getPlanState', () => {
  it('冷路径透传：调 sessionService.getPlanState（SessionRecords 冷路径消费口）+ reply session.planState 形状', async () => {
    const getPlanState = vi.fn(async () => ACTIVE_VIEW)
    const ctx = mockContext({ getPlanState } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.getPlanState', { sessionId: SID }), mockWs())

    expect(getPlanState).toHaveBeenCalledTimes(1)
    expect(getPlanState).toHaveBeenCalledWith(SID)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    // reply 复用 session.planState 广播 payload（shared 协议同 getSubagents → session.subagents 复用形态）
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.planState', {
      sessionId: SID,
      planState: ACTIVE_VIEW,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('端口缺省（SessionService 未组装转发）→ plan_state_unsupported error envelope（sessionId 必带）', async () => {
    const ctx = mockContext({} as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.getPlanState', { sessionId: SID }), mockWs())

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'plan_state_unsupported',
      expect.any(String),
      'msg-1',
      { sessionId: SID },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})

// ── session.abortPlan（D5/E9 横幅退出命令）──────────────────────

describe('SessionMessageHandler session.abortPlan', () => {
  // MF-1-7 编排下沉后 handler 契约 = 纯透传：调 sessionService.abortPlan，resolve →
  // reply message.status ack；throw → abort_plan_failed error envelope。ensureActive→prompt
  // 顺序 / '/plan abort' 字面量 / 失效回调上抛等编排语义的断言迁 service 层
  // （src/services/session/__tests__/session-service-abort-plan.test.ts）。

  it('① abortPlan resolve → message.status ack + 失效链不经 handler（单一出口在 server.ts）', async () => {
    const abortPlan = vi.fn(async () => {})
    const ctx = mockContext({ abortPlan } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.abortPlan', { sessionId: SID }), mockWs())

    expect(abortPlan).toHaveBeenCalledTimes(1)
    expect(abortPlan).toHaveBeenCalledWith(SID)
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'message.status', {
      sessionId: SID,
      status: 'sent',
    })
    // 失效链消费已下沉（server.setServices 注册 setOnPlanAborted），handler ctx 不再触碰
    expect(ctx.invalidatePendingUiRequests).not.toHaveBeenCalled()
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('② abortPlan throw（恢复失败 / 直发失败，E9）→ abort_plan_failed error envelope，不 reply', async () => {
    const abortPlan = vi.fn(async () => {
      throw new Error('Session file corrupted')
    })
    const ctx = mockContext({ abortPlan } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.abortPlan', { sessionId: SID }, 'msg-err'), mockWs())

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'abort_plan_failed',
      expect.stringContaining('Session file corrupted'),
      'msg-err',
      { sessionId: SID },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
