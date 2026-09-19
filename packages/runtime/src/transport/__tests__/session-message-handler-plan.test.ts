/**
 * SessionMessageHandler plan 域 RPC 测试（plan 模式重设计 D1⑥/D5/E9，u1-rpc）。
 *
 * 覆盖：
 * - handles 认领 session.getPlanState / session.abortPlan
 * - getPlanState：冷路径复用断言（handler 透传 sessionService.getPlanState 结果不自行派生，
 *   D1「派生代码唯一」不变量在传输层的体现）+ reply 复用 session.planState 广播 payload 形状；
 *   端口缺省（SessionService 未组装转发，仅测试最小 mock 形态）→ plan_state_unsupported
 *   error envelope（防御分支，对齐 backgroundTasks 惯例）
 * - abortPlan 三分支（D5/E9）：
 *   ① ensureActive resolve（已活直返 / 未活自动恢复两态对 handler 同构）→ client.prompt('/plan abort')
 *      直发（绕 busy 预检，workflowAction 先例）+ reply message.status ack；
 *      顺序断言：ensureActive 先于 prompt（pi 未活窗口恢复先行）
 *   ② ensureActive throw（恢复失败）→ abort_plan_failed error envelope（msg.id + sessionId 必带），
 *      不 reply——前端 sendCommand 检查 reply success 失败后经 sendError 呈现 E9 恢复指引
 *   ③ prompt throw（直发失败）→ 同 error envelope
 *
 * Mock 边界：全部 mock（ctx 仿 session-message-handler-background-task 测试装置），不起真实 pi。
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler-plan.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'

import { SessionMessageHandler, type SessionHandlerContext } from '../session-message-handler.js'
import type { ISessionService, IRpcClient } from '../../interfaces.js'
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
  /** ensureActive + prompt mock 装置（prompt 内检查 ensureActive 已完成——顺序断言）。 */
  function makeAbortService(ensureActiveImpl: () => Promise<IRpcClient>) {
    const prompt = vi.fn(async () => ({}))
    const ensureActive = vi.fn(ensureActiveImpl)
    return { prompt, ensureActive }
  }

  it('① 已活直发：ensureActive 返回 client → prompt("/plan abort") 直发 + message.status ack', async () => {
    const { prompt, ensureActive } = makeAbortService(async () => ({ prompt }) as unknown as IRpcClient)
    const ctx = mockContext({ ensureActive } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.abortPlan', { sessionId: SID }), mockWs())

    expect(ensureActive).toHaveBeenCalledTimes(1)
    expect(ensureActive).toHaveBeenCalledWith(SID)
    // 直发参数断言：extension command 字面量（pi 对 / 前缀 prompt 先行执行，不经 LLM）
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('/plan abort')
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'message.status', {
      sessionId: SID,
      status: 'sent',
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('①-续 pi 未活窗口：ensureActive（自动恢复，join 语义）先于 prompt——恢复完成后才直发', async () => {
    let ensureActiveSettled = false
    const { prompt, ensureActive } = makeAbortService(async () => {
      // 模拟恢复耗时（restoreSession spawn pi）：resolve 前 prompt 不得被调
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      ensureActiveSettled = true
      return { prompt } as unknown as IRpcClient
    })
    const promptOrderCheck = vi.fn(async () => {
      expect(ensureActiveSettled).toBe(true)
      return {}
    })
    ;(prompt as ReturnType<typeof vi.fn>).mockImplementation(promptOrderCheck)
    const ctx = mockContext({ ensureActive } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.abortPlan', { sessionId: SID }), mockWs())

    expect(ensureActive).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalled()
  })

  it('② ensureActive throw（恢复失败，E9）→ abort_plan_failed error envelope，不 reply', async () => {
    const ensureActive = vi.fn(async () => {
      throw new Error('Session file corrupted')
    })
    const ctx = mockContext({ ensureActive } as unknown as ISessionService)
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

  it('③ prompt throw（直发失败）→ abort_plan_failed error envelope', async () => {
    const prompt = vi.fn(async () => {
      throw new Error('client gone')
    })
    const ensureActive = vi.fn(async () => ({ prompt }) as unknown as IRpcClient)
    const ctx = mockContext({ ensureActive } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.abortPlan', { sessionId: SID }), mockWs())

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'abort_plan_failed',
      expect.stringContaining('client gone'),
      'msg-1',
      { sessionId: SID },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
