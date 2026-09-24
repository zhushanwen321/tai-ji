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
 * - message.abort 失效链（D6，plan-mode-state-machine F4①，S15 锚定）：
 *   ① invalidatePendingUiRequests 先于 sessionService.abort 调用（失效帧前置——「失效帧
 *      必达」由本前置腿保证，abort 抛错时帧已发布；finally 在该形态对帧无增量）；
 *   ② sessionService.abort 抛错时失效帧仍发布（归因 = 前置腿，非 finally）；
 *   ③ finally 腿判别断言（删 finally 腿即红）：前置 invalidate 自身抛错时 finally 仍
 *      发布失效帧 / abort 在途窗口内新到挂起被 finally 追加摘除。
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

// ── message.abort 失效链（D6，S15 锚定）────────────────────────

describe('SessionMessageHandler message.abort（D6 失效链：invalidate 前置 + try/finally）', () => {
  it('S15：invalidatePendingUiRequests 先于 sessionService.abort 调用', async () => {
    const callOrder: string[] = []
    const abort = vi.fn(async () => {
      callOrder.push('abort')
    })
    const ctx = mockContext({ abort } as unknown as ISessionService)
    ctx.invalidatePendingUiRequests = vi.fn(() => {
      callOrder.push('invalidate')
    })
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('message.abort', { sessionId: SID }), mockWs())

    expect(ctx.invalidatePendingUiRequests).toHaveBeenCalledWith(SID, 'turn-aborted')
    expect(abort).toHaveBeenCalledWith(SID)
    // 顺序断言：失效帧前置（旧序 abort→invalidate 时 callOrder[0]==='abort'，本断言即红）
    expect(callOrder[0]).toBe('invalidate')
    // ack 契约不变（D round5-must-fix-1）
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'message.status', {
      sessionId: SID,
      status: 'aborted',
    })
  })

  it('S15：sessionService.abort 抛错时失效帧仍发布（必达 = 前置腿保证，finally 此时空转）', async () => {
    const abort = vi.fn(async () => {
      // F4① 实锤形态：pi 不在活跃表时 dispatcher getClientOrThrow 直接 throw（abort 的 try 之外）
      throw new Error('pi not in active table')
    })
    const ctx = mockContext({ abort } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    // abort 极端失败行为不变（D6）：异常继续传播，不 reply ack
    await expect(
      handler.handleSessionMessage(msg('message.abort', { sessionId: SID }), mockWs()),
    ).rejects.toThrow('pi not in active table')

    // 失效帧仍必达（renderer 据此摘除挂起请求，不留僵尸 ready）——归因 = 前置腿
    // （同步先于 await abort 执行，抛错时帧已发布；finally 在本形态对帧无增量）。
    // 本用例锁前置序；finally 腿的独有行为由下方两条判别用例锁定（删 finally 本用例照绿）。
    expect(ctx.invalidatePendingUiRequests).toHaveBeenCalledWith(SID, 'turn-aborted')
    expect(abort).toHaveBeenCalledWith(SID)
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  // ── finally 腿判别断言（无 finally 时以下用例即红，锁 finally 存在性）────────

  it('finally 腿判别：前置 invalidate 自身抛错时 finally 仍发布失效帧', async () => {
    let invalidateCalls = 0
    const invalidatePendingUiRequests = vi.fn(() => {
      invalidateCalls += 1
      if (invalidateCalls === 1) throw new Error('bus publish failed') // 前置腿自身失败
    })
    const abort = vi.fn(async () => {})
    const ctx = mockContext({ abort } as unknown as ISessionService)
    ctx.invalidatePendingUiRequests = invalidatePendingUiRequests
    const handler = new SessionMessageHandler(ctx)

    // 前置腿异常传播（行为不变），abort 未被触达
    await expect(
      handler.handleSessionMessage(msg('message.abort', { sessionId: SID }), mockWs()),
    ).rejects.toThrow('bus publish failed')

    // finally 腿重试并发布失效帧——唯一来源 = finally（无 finally 时只有 1 次失败调用）
    expect(invalidatePendingUiRequests).toHaveBeenCalledTimes(2)
    expect(invalidatePendingUiRequests).toHaveBeenNthCalledWith(2, SID, 'turn-aborted')
    expect(abort).not.toHaveBeenCalled()
  })

  it('finally 腿判别：abort 在途窗口内新到挂起被追加摘除（invalidate 在 abort 完成后再执行一次）', async () => {
    // 迷你 pending 注册表（仿 server.invalidatePendingUiRequests 摘除语义：摘空后再调
    // 空清单不发布，零成本）
    const pending = new Set<string>()
    const removedSnapshots: string[][] = []
    const invalidatePendingUiRequests = vi.fn(() => {
      removedSnapshots.push([...pending])
      pending.clear()
    })
    const abort = vi.fn(async () => {
      // abort 在途窗口（如 cascade 解散期间）新登记的挂起——前置腿已执行，管不到它
      pending.add('req-window-1')
    })
    const ctx = mockContext({ abort } as unknown as ISessionService)
    ctx.invalidatePendingUiRequests = invalidatePendingUiRequests
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('message.abort', { sessionId: SID }), mockWs())

    // 第二次（finally）调用摘掉了窗口内新到挂起（无 finally 时 removedSnapshots=[[]]，
    // req-window-1 残留成挂起注册表孤儿）
    expect(removedSnapshots).toEqual([[], ['req-window-1']])
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'message.status', {
      sessionId: SID,
      status: 'aborted',
    })
  })
})
