/**
 * SubagentMessageHandler 测试（subagent-model-switch §7.1 入口层，U1 验收面）。
 *
 * 覆盖（mock 宿主应答回执范式）：
 * - 应答到达才回执：reply 载荷 = mock gateway 应答原样透传（chat 两型 / run 级聚合
 *   三形态各一），handler 不改写应答值（回执写状态在前端，禁乐观写由前端用例钉）；
 * - 错误分型经 sendError：gateway 分型错误（e.code）透传 + **sessionId 必带**
 *   （gateway.resolveSessionId 解析——subagent.setModel payload 无 sessionId 字段，
 *   会话隔离红线由本用例钉住）；
 * - 目标二选一守卫（双缺 / 双给 → invalid_payload）；
 * - gateway 未注入 → subagent_model_switch_unwired 可操作错误（不落 unknown_type）。
 *
 * 测试框架：vitest（从子包目录运行）。
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/subagent-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { SubagentSetModelAggregateReply, SubagentSetModelReply } from '@taiji/shared'
import { SubagentMessageHandler } from '../subagent-message-handler.js'
import type { SubagentHandlerContext } from '../subagent-message-handler.js'
import type { SubagentModelSwitchGateway } from '../../interfaces.js'

// ── mock helpers ─────────────────────────────────────────────

function mockWs(): WsType {
  return {} as WsType
}

function setModelMsg(payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type: 'subagent.setModel', payload, id } as unknown as ClientMessage
}

/** mock 宿主网关：setModel 应答/拒绝与 sessionId 解析由测试注入。 */
function mockGateway(overrides?: Partial<SubagentModelSwitchGateway>): SubagentModelSwitchGateway {
  return {
    setModel: vi.fn(async () => ({ kind: 'recorded', note: '已记录，下次执行生效' }) satisfies SubagentSetModelReply),
    resolveSessionId: vi.fn(() => 'main-session-1'),
    ...overrides,
  }
}

function mockCtx(gateway: SubagentModelSwitchGateway | undefined): {
  ctx: SubagentHandlerContext
  reply: ReturnType<typeof vi.fn>
  sendError: ReturnType<typeof vi.fn>
} {
  const reply = vi.fn()
  const sendError = vi.fn()
  const ctx: SubagentHandlerContext = {
    send: vi.fn(),
    sendError,
    reply,
    ...(gateway !== undefined ? { modelSwitchGateway: gateway } : {}),
  }
  return { ctx, reply, sendError }
}

// ── 回执范式（应答到达才写状态，应答值原样透传）──────────────────

describe('SubagentMessageHandler — subagent.setModel 回执范式', () => {
  it('chat 域已生效型：reply 透传 mock 宿主应答的生效值（生效模型 + 生效档位）', async () => {
    const gateway = mockGateway({
      setModel: vi.fn(async () => ({
        kind: 'effective',
        effectiveModel: { provider: 'zai-coding-cn', modelId: 'glm-5.3-flash' },
        effectiveThinkingLevel: 'high',
      }) satisfies SubagentSetModelReply),
    })
    const { ctx, reply } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'zai-coding-cn', modelId: 'glm-5.3-flash' }),
      mockWs(),
    )

    expect(gateway.setModel).toHaveBeenCalledWith({
      recordId: 'sa-1',
      provider: 'zai-coding-cn',
      modelId: 'glm-5.3-flash',
    })
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      'req-1',
      'subagent.modelSet',
      expect.objectContaining({ kind: 'effective', effectiveThinkingLevel: 'high' }),
    )
    // 回执值 = 宿主应答值（handler 不改写——回执写状态范式的前端前提）
    const payload = reply.mock.calls[0]?.[3] as { effectiveModel: { modelId: string } }
    expect(payload.effectiveModel.modelId).toBe('glm-5.3-flash')
    expect(sendErrorNever(ctx)).toBeUndefined()
  })

  it('chat 域已记账型：不携带档位值的应答原样回执', async () => {
    const { ctx, reply } = mockCtx(mockGateway())
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }),
      mockWs(),
    )

    const payload = reply.mock.calls[0]?.[3] as { kind: string; note?: string; effectiveThinkingLevel?: string }
    expect(payload.kind).toBe('recorded')
    expect(payload.effectiveThinkingLevel).toBeUndefined()
  })

  it('run 级聚合应答：三组件（members/failures/summary）原样回执', async () => {
    const aggregate: SubagentSetModelAggregateReply = {
      members: [
        { runId: 'sa-a', state: 'switched', effectiveModel: { provider: 'p', modelId: 'm' }, effectiveThinkingLevel: 'high' },
        { runId: 'sa-b', state: 'not-active' },
      ],
      failures: [],
      summary: '已切换，未派发步骤生效',
    }
    const gateway = mockGateway({ setModel: vi.fn(async () => aggregate satisfies SubagentSetModelReply) })
    const { ctx, reply } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ runId: 'wf-1', provider: 'p', modelId: 'm' }),
      mockWs(),
    )

    expect(gateway.setModel).toHaveBeenCalledWith({ runId: 'wf-1', provider: 'p', modelId: 'm' })
    const payload = reply.mock.calls[0]?.[3] as SubagentSetModelAggregateReply
    expect(payload.members).toHaveLength(2)
    expect(payload.failures).toEqual([])
    expect(payload.summary).toContain('未派发步骤生效')
  })

  it('gateway 应答前不回执（无乐观回执——应答到达才写状态的 runtime 半边）', async () => {
    let resolveSetModel: (reply: SubagentSetModelReply) => void = () => {}
    const gateway = mockGateway({
      setModel: vi.fn(
        () =>
          new Promise<SubagentSetModelReply>((resolve) => {
            resolveSetModel = resolve
          }),
      ),
    })
    const { ctx, reply } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    const pending = handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }),
      mockWs(),
    )
    // 宿主应答未到达：零回执零错误（前端状态保持旧真值的前提）
    expect(reply).not.toHaveBeenCalled()
    resolveSetModel({ kind: 'effective', effectiveModel: { provider: 'p', modelId: 'm' }, effectiveThinkingLevel: 'low' })
    await pending
    expect(reply).toHaveBeenCalledTimes(1)
  })
})

// ── 错误分型 + 会话隔离红线 ───────────────────────────────────

describe('SubagentMessageHandler — 错误分型与 sessionId 信封', () => {
  it('gateway 分型错误：code 透传 + sendError 带 resolveSessionId 解析的 sessionId', async () => {
    const gateway = mockGateway({
      setModel: vi.fn(async () => {
        const err = new Error('模型 X 缺少 API key，切换未生效，当前执行未受影响') as Error & { code?: string }
        err.code = 'engine_credential_missing'
        throw err
      }),
    })
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }),
      mockWs(),
    )

    expect(sendError).toHaveBeenCalledTimes(1)
    const [ws, code, message, id, details] = sendError.mock.calls[0] as unknown as [
      WsType,
      string,
      string,
      string,
      { sessionId?: string },
    ]
    expect(code).toBe('engine_credential_missing')
    expect(message).toContain('API key')
    expect(id).toBe('req-1')
    // 会话隔离红线：payload 无 sessionId 的域消息，错误信封必须补齐 sessionId
    expect(details.sessionId).toBe('main-session-1')
    expect(ws).toBeDefined()
  })

  it('run 级目标的错误信封按 runId 解析 sessionId', async () => {
    const gateway = mockGateway({
      setModel: vi.fn(async () => {
        throw new Error('run 已终局，无后续步骤可应用')
      }),
      resolveSessionId: vi.fn(({ runId }) => (runId !== undefined ? `session-for-${String(runId)}` : undefined)),
    })
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(setModelMsg({ runId: 'wf-1', provider: 'p', modelId: 'm' }), mockWs())

    expect(gateway.resolveSessionId).toHaveBeenCalledWith({ runId: 'wf-1' })
    const details = sendError.mock.calls[0]?.[4] as { sessionId?: string }
    expect(details.sessionId).toBe('session-for-wf-1')
  })

  it('resolveSessionId 解析不到（undefined）：信封缺省 details 而非带空 sessionId', async () => {
    const gateway = mockGateway({
      setModel: vi.fn(async () => {
        throw new Error('目标不存在')
      }),
      resolveSessionId: vi.fn(() => undefined),
    })
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-unknown', provider: 'p', modelId: 'm' }),
      mockWs(),
    )

    const details = sendError.mock.calls[0]?.[4]
    expect(details).toBeUndefined()
  })
})

// ── 守卫与未接线形态 ─────────────────────────────────────────

describe('SubagentMessageHandler — 目标守卫与未接线', () => {
  it('recordId 与 runId 双缺：invalid_payload，不触达 gateway', async () => {
    const gateway = mockGateway()
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(setModelMsg({ provider: 'p', modelId: 'm' }), mockWs())

    expect(gateway.setModel).not.toHaveBeenCalled()
    expect(sendError.mock.calls[0]?.[1]).toBe('invalid_payload')
  })

  it('recordId 与 runId 双给：invalid_payload，不触达 gateway', async () => {
    const gateway = mockGateway()
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', runId: 'wf-1', provider: 'p', modelId: 'm' }),
      mockWs(),
    )

    expect(gateway.setModel).not.toHaveBeenCalled()
    expect(sendError.mock.calls[0]?.[1]).toBe('invalid_payload')
  })

  it('gateway 未注入（组合根未接线）：subagent_model_switch_unwired 可操作错误', async () => {
    const { ctx, sendError } = mockCtx(undefined)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }),
      mockWs(),
    )

    const [ws, code, message] = sendError.mock.calls[0] as unknown as [WsType, string, string]
    expect(code).toBe('subagent_model_switch_unwired')
    expect(message).toContain('U2/U5')
    expect(ws).toBeDefined()
  })

  it('handles 清单只认领 subagent.setModel（中央分发表 disjoint 约束）', () => {
    const { ctx } = mockCtx(undefined)
    const handler = new SubagentMessageHandler(ctx)
    expect(handler.handles).toEqual(['subagent.setModel'])
  })
})

/** 断言助手：整个用例零 sendError 调用（显式失败信息优于隐式 toHaveBeenCalledTimes）。 */
function sendErrorNever(ctx: SubagentHandlerContext): Error | undefined {
  const calls = (ctx.sendError as ReturnType<typeof vi.fn>).mock.calls
  return calls.length > 0 ? new Error(`unexpected sendError: ${JSON.stringify(calls[0])}`) : undefined
}
