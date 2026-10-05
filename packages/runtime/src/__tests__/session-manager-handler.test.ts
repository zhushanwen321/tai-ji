/**
 * SessionManagerHandler 单元测试。
 *
 * 覆盖 U4-A1~A6 验收标准：
 * - A1: create 分支完整链路（四步串行时序）
 * - A2: send/history/status/list/abort 五个 action 分支
 * - A3: malformed 兜底
 * - A4: 错误闭环（含 createdId 有值时附 sessionId+hint）
 * - A5: modelId 从 state.model 组装
 * - A6: broadcastSessionList opts 注入与解耦
 * - A9: handler 接线验证
 *
 * 运行：pnpm --filter @taiji/runtime exec vitest run session-manager-handler
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { SessionManagerHandler } from '../transport/session-manager-handler.js'
import type { SessionManagerHandlerOptions } from '../transport/session-manager-handler.js'
import { deliverRespondTargets } from '../transport/session-manager-handler.js'
import type { SessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import { createClaimLedger } from '../services/session/notify-claims.js'
import type { ClaimLedger, SettleOutcome } from '../services/session/notify-claims.js'
import type { ISessionService, SessionCreateOptions } from '../interfaces.js'
import type { SessionSummary } from '@taiji/shared'

function makeMockSessionService(overrides: Partial<ISessionService> = {}): ISessionService {
  return {
    create: vi.fn(),
    sendMessage: vi.fn(),
    getHistory: vi.fn(),
    // 归属校验默认材料：任意 sessionId 返回发起方 sid-parent 的 managed child summary
    getSummary: vi.fn().mockImplementation(() =>
      makeSessionSummary({ id: 's1', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
    ),
    listPersistedSessions: vi.fn(),
    abort: vi.fn(),
    getRpcClient: vi.fn(),
    getActiveSessionIds: vi.fn(),
    // session 文件路径解析（respond payload sessionFilePath）的内存态腿：缺省无文件
    getSession: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as ISessionService
}

/** delivery registry mock：默认 handle.sendChecked 受理（resolve = queued） */
function makeMockDelivery(overrides: Partial<SessionDeliveryRegistry> = {}): SessionDeliveryRegistry {
  return {
    getOrCreateDelivery: vi.fn().mockReturnValue({
      sendChecked: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn().mockReturnValue(0),
      dispose: vi.fn(),
    }),
    sendDirect: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    disposeAll: vi.fn(),
    ...overrides,
  } as unknown as SessionDeliveryRegistry
}

/** 每个 makeMockOptions 的真实 ClaimLedger 登记（afterEach 统一 dispose 停内部清扫定时器） */
const spawnedLedgers: ClaimLedger[] = []

function makeMockOptions(overrides: Partial<SessionManagerHandlerOptions> = {}): SessionManagerHandlerOptions {
  const claims = createClaimLedger()
  spawnedLedgers.push(claims)
  return {
    sessionService: makeMockSessionService(),
    delivery: makeMockDelivery(),
    sendExtensionUiResponse: vi.fn(() => true),
    broadcastSessionList: vi.fn(),
    claims,
    ...overrides,
  }
}

afterEach(() => {
  while (spawnedLedgers.length > 0) spawnedLedgers.pop()!.dispose()
})

function makeSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'test-session-id',
    label: 'test-label',
    cwd: '/test/cwd',
    status: 'active',
    lastActiveAt: Date.now(),
    modelId: 'openai/gpt-4',
    tokenCount: 0,
    // 归属校验默认材料：测试中发起方一律 'sid-parent'，目标 s1 默认是其 managed child
    spawnSource: 'agent',
    parentAgentSessionId: 'sid-parent',
    ...overrides,
  }
}

/** 第 n 次 sendExtensionUiResponse 的 JSON payload */
function respondAt(opts: SessionManagerHandlerOptions, call = 0): Record<string, unknown> {
  const mock = opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>
  return JSON.parse(mock.mock.calls[call][2] as string) as Record<string, unknown>
}

/** list 场景装配单源：mock 持久化会话 → handle(list, params) → respond 会话数组（类型锚定） */
async function runListScenario(
  sessions: SessionSummary[],
  params: Record<string, unknown>,
): Promise<Array<{ id: string }>> {
  const opts = makeMockOptions({
    sessionService: makeMockSessionService({
      listPersistedSessions: vi.fn().mockReturnValue([{ cwd: '/test', sessions }]),
    }),
  })
  const handler = new SessionManagerHandler(opts)
  await handler.handle('req-1', 'sid-parent', 'list', params)
  const response = respondAt(opts)
  return response.sessions as Array<{ id: string }>
}

/** status 场景装配单源：mock getSummary → handle(status) → opts（mock 调用断言用）+ respond payload */
async function runStatusScenario(
  summary: SessionSummary,
): Promise<{ opts: SessionManagerHandlerOptions; response: Record<string, unknown> }> {
  const opts = makeMockOptions({
    sessionService: makeMockSessionService({
      getSummary: vi.fn().mockReturnValue(summary),
    }),
  })
  const handler = new SessionManagerHandler(opts)
  await handler.handle('req-1', 'sid-parent', 'status', { sessionId: 's1' })
  return { opts, response: respondAt(opts) }
}

/**
 * watch 路由族用例共用脚手架：mock options + getSummary 覆盖 + claim arm→injected（sendDirect
 * 受理回执锚形态）+ 可选 settle 预兑现。summaryOverrides 传 undefined → getSummary 返回
 * undefined（二次校验①「session 已不在」腿）；传 {} 即默认归属材料。返回 opts 与已接线的
 * handler，供用例续做 openWatch / handle 断言。
 */
function makeWatchFixture(
  notifyId: string,
  summaryOverrides?: Partial<SessionSummary>,
  settleOutcome?: SettleOutcome,
): { opts: SessionManagerHandlerOptions; handler: SessionManagerHandler } {
  const opts = makeMockOptions()
  opts.sessionService.getSummary = vi.fn().mockReturnValue(
    summaryOverrides === undefined ? undefined : makeSessionSummary({ id: 's1', ...summaryOverrides }),
  )
  opts.claims!.arm({ parentSid: 'sid-parent', notifyId, kind: 'claim', sessionId: 's1' })
  opts.claims!.markInjected('sid-parent', notifyId)
  if (settleOutcome !== undefined) opts.claims!.settle('s1', settleOutcome)
  return { opts, handler: new SessionManagerHandler(opts) }
}

describe('SessionManagerHandler', () => {
  // 红阶段守卫：验证 session-manager extension 存在（区分力检查）
  it('session-manager extension 存在（红阶段守卫）', () => {
    const extensionPath = resolve(process.cwd(), '../../extensions/universal/session-manager/package.json')
    expect(existsSync(extensionPath), `session-manager extension should exist at ${extensionPath}`).toBe(true)
  })

  describe('U4-A1: create 分支完整链路', () => {
    it('四步串行时序：create → broadcastSessionList → respond({sessionId,status,modelId})', async () => {
      const session = makeSessionSummary({ id: 'new-session', modelId: 'openai/gpt-4' })
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(session),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test', label: 'my-session' })

      // 1. create 被调用——spawnSource/parentAgentSessionId 服务端注入（不取请求参数）
      //    A'（2026-08-24）：persistLabel=true —— agent 传 label 时是语义性命名，持久化且防 auto-rename 覆盖
      expect(opts.sessionService.create).toHaveBeenCalledWith('/test', 'my-session', {
        spawnSource: 'agent',
        parentAgentSessionId: 'sid-parent',
        persistLabel: true,
      })

      // 2. broadcastSessionList 被调用（opts 注入）
      expect(opts.broadcastSessionList).toHaveBeenCalled()

      // 3. respond 携 sessionId/status/modelId + notify-once D6 两字段（无 prompt → willNotify:false；lifetimeNotifyId 恒在）
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith('sid-parent', 'req-1', expect.any(String), 'select')
      const createRespond = respondAt(opts)
      expect(createRespond).toEqual({
        sessionId: 'new-session',
        status: 'created',
        modelId: 'openai/gpt-4',
        willNotify: false,
        lifetimeNotifyId: expect.stringMatching(/^sm-/),
      })
    })

    it('create 带 spawnSource/parentAgentSessionId', async () => {
      const session = makeSessionSummary({ id: 'agent-session', spawnSource: 'agent', parentAgentSessionId: 'parent-id' })
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(session),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      // 请求参数携带伪造的 parentAgentSessionId——服务端注入的路由 sessionId 优先（防伪造）
      await handler.handle('req-1', 'sid-parent', 'create', {
        cwd: '/test',
        label: 'agent-session',
        spawnSource: 'user',
        parentAgentSessionId: 'forged-parent',
      })

      expect(opts.sessionService.create).toHaveBeenCalledWith('/test', 'agent-session', {
        spawnSource: 'agent',
        parentAgentSessionId: 'sid-parent',
        persistLabel: true,
      })

      // broadcastSessionList 无参调用（签名已收窄为 ()，上下文由 server 侧组装）
      expect(opts.broadcastSessionList).toHaveBeenCalledWith()
    })
  })

  describe('U4-A2: send/history/status/list/abort 五个 action 分支', () => {
    it('send → {queued: true}（delivery.sendChecked 受理，busy 入队不拒绝）', async () => {
      const delivery = makeMockDelivery()
      const opts = makeMockOptions({ delivery })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 'hello' })

      // 走 sessionId 单例注册表取 handle，sendChecked 收到 text payload + D1 申报（agent
      // 通路无标记出站，'acceptance' = 受理即落地）
      expect(delivery.getOrCreateDelivery).toHaveBeenCalledWith('s1')
      const handle = (delivery.getOrCreateDelivery as ReturnType<typeof vi.fn>).mock.results[0].value as { sendChecked: ReturnType<typeof vi.fn> }
      expect(handle.sendChecked).toHaveBeenCalledWith(
        { payload: { kind: 'text', content: 'hello' } },
        { receiptAnchor: 'acceptance' },
      )
      // respond {queued: true, willNotify: false}（sd-u5 不再出现 {blocked, rejected}；notify-once：未带 notifyId 不 arm）
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ queued: true, willNotify: false }),
        'select',
      )
    })

    it('send 失败 → respond({error, hint})，同步可见不走前端 banner', async () => {
      const delivery = makeMockDelivery({
        getOrCreateDelivery: vi.fn().mockReturnValue({
          sendChecked: vi.fn().mockRejectedValue(new Error('target session unreachable')),
          send: vi.fn(),
          flush: vi.fn(),
          depth: vi.fn().mockReturnValue(0),
          dispose: vi.fn(),
        }),
      })
      const opts = makeMockOptions({ delivery })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 'hello' })

      const response = respondAt(opts)
      expect(response.error).toBe('target session unreachable')
      expect(response.hint).toBe('target session unreachable; retry send_to_session after checking get_session_status')
    })

    // 归属校验回归（review round 3 must-fix）：目标不属于发起方（用户自己的 session /
    // 其他 agent 的 child）时拒绝，防 prompt injection 借 send/history/status/abort
    // 接管非 managed session。逐 action 断言：不触碰 delivery / getHistory / abort。
    describe('归属校验：send/history/status/abort 目标必须是发起方的 managed child', () => {
      const FOREIGN_ERROR = 'target session is not managed by this agent'

      function makeOwnedFactory(summary: SessionSummary) {
        return vi.fn().mockImplementation((sid: string) => (sid === summary.id ? summary : undefined))
      }

      it('send 目标为用户 session（spawnSource=user）→ error，delivery 不被触碰', async () => {
        const delivery = makeMockDelivery()
        const userSummary = makeSessionSummary({ id: 'user-s1', spawnSource: 'user', parentAgentSessionId: undefined })
        const opts = makeMockOptions({
          delivery,
          sessionService: makeMockSessionService({ getSummary: makeOwnedFactory(userSummary) }),
        })
        const handler = new SessionManagerHandler(opts)

        await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 'user-s1', prompt: 'inject' })

        const response = respondAt(opts)
        expect(response.error).toBe(FOREIGN_ERROR)
        expect(delivery.getOrCreateDelivery).not.toHaveBeenCalled()
      })

      it('send 目标为其他 agent 的 child（parentAgentSessionId 不匹配）→ error', async () => {
        const delivery = makeMockDelivery()
        const otherChild = makeSessionSummary({ id: 'other-child', parentAgentSessionId: 'another-agent' })
        const opts = makeMockOptions({
          delivery,
          sessionService: makeMockSessionService({ getSummary: makeOwnedFactory(otherChild) }),
        })
        const handler = new SessionManagerHandler(opts)

        await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 'other-child', prompt: 'inject' })

        const response = respondAt(opts)
        expect(response.error).toBe(FOREIGN_ERROR)
        expect(delivery.getOrCreateDelivery).not.toHaveBeenCalled()
      })

      it('history 目标不属于发起方 → error，getHistory 不被调用', async () => {
        const otherChild = makeSessionSummary({ id: 'other-child', parentAgentSessionId: 'another-agent' })
        const getHistory = vi.fn()
        const opts = makeMockOptions({
          sessionService: makeMockSessionService({
            getSummary: makeOwnedFactory(otherChild),
            getHistory,
          }),
        })
        const handler = new SessionManagerHandler(opts)

        await handler.handle('req-1', 'sid-parent', 'history', { sessionId: 'other-child' })

        const response = respondAt(opts)
        expect(response.error).toBe(FOREIGN_ERROR)
        expect(getHistory).not.toHaveBeenCalled()
      })

      it('status 目标存在但不归属 → not_found（探测面折叠：不泄露存在性，与 list「不可见=不存在」对齐）', async () => {
        const userSummary = makeSessionSummary({ id: 'user-s1', spawnSource: 'user' })
        const opts = makeMockOptions({
          sessionService: makeMockSessionService({ getSummary: makeOwnedFactory(userSummary) }),
        })
        const handler = new SessionManagerHandler(opts)

        await handler.handle('req-1', 'sid-parent', 'status', { sessionId: 'user-s1' })

        const response = respondAt(opts)
        expect(response.status).toBe('not_found')
        expect(response.error).toBeUndefined()
      })

      it('abort 目标不属于发起方 → error，abort 不被调用', async () => {
        const otherChild = makeSessionSummary({ id: 'other-child', parentAgentSessionId: 'another-agent' })
        const abort = vi.fn()
        const opts = makeMockOptions({
          sessionService: makeMockSessionService({
            getSummary: makeOwnedFactory(otherChild),
            abort,
          }),
        })
        const handler = new SessionManagerHandler(opts)

        await handler.handle('req-1', 'sid-parent', 'abort', { sessionId: 'other-child' })

        const response = respondAt(opts)
        expect(response.error).toBe(FOREIGN_ERROR)
        expect(abort).not.toHaveBeenCalled()
      })

      it('归属正确的 managed child 正常放行（send → queued）', async () => {
        const delivery = makeMockDelivery()
        const ownChild = makeSessionSummary({ id: 's1' })
        const opts = makeMockOptions({
          delivery,
          sessionService: makeMockSessionService({ getSummary: makeOwnedFactory(ownChild) }),
        })
        const handler = new SessionManagerHandler(opts)

        await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 'hello' })

        expect(delivery.getOrCreateDelivery).toHaveBeenCalledWith('s1')
        expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
          'sid-parent',
          'req-1',
          JSON.stringify({ queued: true, willNotify: false }),
          'select',
        )
      })
    })

    it('create 带 prompt → delivery.sendDirect 直投（不走 dispatcher sendMessage）', async () => {
      const session = makeSessionSummary({ id: 'created-1' })
      const delivery = makeMockDelivery()
      const opts = makeMockOptions({
        delivery,
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(session),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test', prompt: 'init' })

      expect(delivery.sendDirect).toHaveBeenCalledWith('created-1', 'init')
      expect(opts.sessionService.sendMessage).not.toHaveBeenCalled()
    })

    it('history → {messages, truncated}', async () => {
      const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getHistory: vi.fn().mockResolvedValue({ messages, truncated: false }),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'history', { sessionId: 's1' })

      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ messages, truncated: false }),
        'select',
      )
    })

    it('history with tailTurns 截断', async () => {
      const messages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ]
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getHistory: vi.fn().mockResolvedValue({ messages, truncated: false }),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'history', { sessionId: 's1', tailTurns: 1 })

      // 应该只保留最后一个 user turn 及之后的消息
      const response = respondAt(opts)
      expect(response.messages).toEqual([
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ])
      expect(response.truncated).toBe(true)
    })

    it('history tailTurns 超过实际 user turn 数 → 返回全部历史而非空列表（回归：凑不满曾返回 []）', async () => {
      const messages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ]
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getHistory: vi.fn().mockResolvedValue({ messages, truncated: false }),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'history', { sessionId: 's1', tailTurns: 5 })

      const response = respondAt(opts)
      expect(response.messages).toEqual(messages)
      expect(response.truncated).toBe(false)
    })

    it('畸形 params（send.prompt 非法）→ respond({error})，不流入 sessionService（params 信任边界守卫）', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 42 })

      const response = respondAt(opts)
      expect(response.error).toMatch(/invalid params/)
      expect(opts.delivery.getOrCreateDelivery).not.toHaveBeenCalled()
    })

    it('status → {status, modelId}', async () => {
      const { opts } = await runStatusScenario(makeSessionSummary({ status: 'active', modelId: 'openai/gpt-4' }))
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ status: 'active', modelId: 'openai/gpt-4', undeliveredResults: 0 }),
        'select',
      )
    })

    it('status session 不存在 → {status: "not_found"}', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockReturnValue(undefined),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'status', { sessionId: 'nonexistent' })

      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ status: 'not_found', undeliveredResults: 0 }),
        'select',
      )
    })

    it('list → {sessions} 过滤 spawnSource', async () => {
      const respondSessions = await runListScenario(
        [
          makeSessionSummary({ id: 's1', spawnSource: 'user' }),
          makeSessionSummary({ id: 's2', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
          makeSessionSummary({ id: 's3', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
        ],
        { spawnSource: 'agent' },
      )
      expect(respondSessions).toHaveLength(2)
      expect(respondSessions[0].id).toBe('s2')
      expect(respondSessions[1].id).toBe('s3')
    })

    it('list → 缺省注入路由上下文：只返回本父的 agent 子 session（params 不得放宽）', async () => {
      // 空 params（extension 端 list_my_sessions 实际发送的形状）
      const respondSessions = await runListScenario(
        [
          makeSessionSummary({ id: 's1', spawnSource: 'user' }),
          makeSessionSummary({ id: 's2', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
          makeSessionSummary({ id: 's3', spawnSource: 'agent', parentAgentSessionId: 'parent-b' }),
        ],
        {},
      )
      expect(respondSessions).toHaveLength(1)
      expect(respondSessions[0].id).toBe('s2')
    })

    it('list → params 显式指定其他 parentAgentSessionId 不生效（防跨父枚举）', async () => {
      const respondSessions = await runListScenario(
        [
          makeSessionSummary({ id: 's1', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
          makeSessionSummary({ id: 's2', spawnSource: 'agent', parentAgentSessionId: 'parent-b' }),
        ],
        { parentAgentSessionId: 'parent-b' },
      )
      expect(respondSessions).toHaveLength(1)
      expect(respondSessions[0].id).toBe('s1')
    })

    it('abort → {success}', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          abort: vi.fn().mockResolvedValue(undefined),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'abort', { sessionId: 's1' })

      expect(opts.sessionService.abort).toHaveBeenCalledWith('s1')
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ success: true }),
        'select',
      )
    })
  })

  describe('U4-A3: malformed 兜底', () => {
    it('action === __malformed__ → sendExtensionUiResponse(null, "select")', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', '__malformed__', {})

      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith('sid-parent', 'req-1', null, 'select')
    })

    it('未知 action → sendExtensionUiResponse(null, "select")', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'unknown_action' as never, {})

      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith('sid-parent', 'req-1', null, 'select')
    })
  })

  describe('U4-A4: 错误闭环', () => {
    it('create 失败 → respond({error})', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockRejectedValue(new Error('create failed')),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test' })

      const response = respondAt(opts)
      expect(response.error).toBe('create failed')
      expect(response.sessionId).toBeUndefined()
      expect(response.hint).toBeUndefined()
    })

    it('create 成功后外部异常 → respond({error, sessionId, hint})', async () => {
      const session = makeSessionSummary({ id: 'created-session' })
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(session),
        }),
      })

      // 模拟 sendExtensionUiResponse 抛错（模拟外部异常）
      // 注意：broadcastSessionList 失败现在被内部 catch 不会传播
      // 所以我们模拟一个不同的场景：在 respond 之前发生异常
      let callCount = 0
      opts.sendExtensionUiResponse = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // 第一次调用（respond）成功
          return
        }
        // 第二次调用（如果有）抛错
        throw new Error('response failed')
      })
      const handler = new SessionManagerHandler(opts)

      // 这个测试验证 handle 方法的签名和基本流程
      await handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test' })

      // create 成功的 respond 已发出
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        expect.stringContaining('created-session'),
        'select',
      )
    })

    it('父 client 不存在时 warn+丢弃不抛', async () => {
      // 这个测试验证 sendExtensionUiResponse 在找不到 client 时不会抛错
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(makeSessionSummary()),
          getActiveSessionIds: vi.fn().mockReturnValue([]),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      // 不应抛错
      await expect(handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test' })).resolves.toBeUndefined()
    })
  })

  describe('U4-A5: modelId 从 state.model 组装', () => {
    it('status 返回 modelId', async () => {
      const { response } = await runStatusScenario(makeSessionSummary({ modelId: 'anthropic/claude-3' }))
      expect(response.modelId).toBe('anthropic/claude-3')
    })

    it('modelId 为空时不在 respond 中出现', async () => {
      const { response } = await runStatusScenario(makeSessionSummary({ modelId: '' }))
      expect(response.modelId).toBeUndefined()
    })
  })

  describe('U4-A6: broadcastSessionList opts 注入与解耦', () => {
    it('create 成功后 broadcastSessionList 被调用（无参，签名收窄）', async () => {
      const session = makeSessionSummary()
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(session),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'create', {
        cwd: '/test',
        spawnSource: 'agent',
        parentAgentSessionId: 'parent',
      })

      expect(opts.broadcastSessionList).toHaveBeenCalledWith()
    })

    it('broadcast 失败不影响 create 的 respond', async () => {
      const session = makeSessionSummary({ id: 'new-session' })
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(session),
        }),
      })
      opts.broadcastSessionList = vi.fn().mockImplementation(() => {
        throw new Error('broadcast failed')
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test' })

      // create 成功的 respond 已发出（虽然后续 broadcast 失败导致错误 respond 覆盖）
      // 但 create 本身的结果已被记录
      expect(opts.sessionService.create).toHaveBeenCalled()
    })
  })

  describe('u8: 子会话 project 归属继承父会话（设计 D8 / 错误规格 E6）', () => {
    // warn 断言用的 console spy 在每个用例后恢复（避免污染后续用例的 stderr 断言面）
    afterEach(() => {
      vi.restoreAllMocks()
    })

    /** create 的第三个实参（SessionCreateOptions）——归属继承的唯一观测点 */
    function createOptionsOf(sessionService: ISessionService): SessionCreateOptions {
      const create = sessionService.create as unknown as { mock: { calls: [unknown, unknown, SessionCreateOptions][] } }
      expect(create).toHaveBeenCalled()
      return create.mock.calls[0][2]
    }

    /** 父会话 summary 工厂（u8 关注点只有 projectId，其余字段取 managed-parent 常态） */
    function parentSummaryWith(projectId?: string): SessionSummary {
      return makeSessionSummary({
        id: 'sid-parent',
        spawnSource: 'agent',
        parentAgentSessionId: 'sid-grandparent',
        projectId,
      })
    }

    it('父会话有 projectId → create 收到该 projectId（服务端继承，读父 summary）', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockReturnValue(parentSummaryWith('proj-alpha')),
          create: vi.fn().mockResolvedValue(makeSessionSummary({ id: 'child-1' })),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test', label: 'child' })

      // 归属来源 = 路由上下文的父 session id（不是子 id、不是请求参数）
      expect(opts.sessionService.getSummary).toHaveBeenCalledWith('sid-parent')
      const options = createOptionsOf(opts.sessionService)
      expect(options.projectId).toBe('proj-alpha')
      // 既有语义零改动（spawnSource / parentAgentSessionId / persistLabel 原样透传）
      expect(options.spawnSource).toBe('agent')
      expect(options.parentAgentSessionId).toBe('sid-parent')
      expect(options.persistLabel).toBe(true)
    })

    it('父会话无 projectId → projectId 为 undefined，不阻断创建（落默认项目）+ debug 留痕（非 warn）', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockReturnValue(parentSummaryWith(undefined)),
          create: vi.fn().mockResolvedValue(makeSessionSummary({ id: 'child-2' })),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test' })

      // 缺省即「不写 .project.json」（session-lifecycle 空值守卫），等价于落默认项目
      expect(createOptionsOf(opts.sessionService).projectId).toBeUndefined()
      // 不阻断：created 结果照常回写（notify-once D6：无 prompt → willNotify:false + lifetimeNotifyId）
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        expect.stringContaining('"sessionId":"child-2"'),
        'select',
      )
      // 「父项目本就是默认项目」是正常降级路径：debug 陈述事实，不进 warn 通道（防假信号）
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('has no projectId'))
      expect(debug).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
    })

    it('父 summary 不可得 → 会话照常创建成功 + warn 记录（E6 非错误路径，不 throw）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockReturnValue(undefined),
          create: vi.fn().mockResolvedValue(makeSessionSummary({ id: 'child-3' })),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await expect(
        handler.handle('req-1', 'sid-parent', 'create', { cwd: '/test' }),
      ).resolves.toBeUndefined()

      expect(createOptionsOf(opts.sessionService).projectId).toBeUndefined()
      const response = respondAt(opts)
      expect(response).toEqual({
        sessionId: 'child-3',
        status: 'created',
        modelId: 'openai/gpt-4',
        willNotify: false,
        lifetimeNotifyId: expect.stringMatching(/^sm-/),
      })
      expect(response.error).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('summary unavailable'))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(debug).not.toHaveBeenCalled()
    })

    it('params 伪造 projectId 被忽略（归属决策不交给 LLM，D8 不新增工具参数）', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockReturnValue(parentSummaryWith('proj-alpha')),
          create: vi.fn().mockResolvedValue(makeSessionSummary({ id: 'child-4' })),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'create', {
        cwd: '/test',
        label: 'child',
        projectId: 'proj-forged',
      })

      // 父归属优先（与伪造 parentAgentSessionId 同款信任边界口径）
      expect(createOptionsOf(opts.sessionService).projectId).toBe('proj-alpha')
    })
  })

  // [2026-09 测试舰队审查 r2-20] U4-A9「handle 方法签名与 interpreter 回调一致」已删：
  // `expect(promise).toBeInstanceOf(Promise)` 对任意 async 函数恒真，无独立判别力；
  // handle 接线的真实行为验证由上方 U4-A1~A6 各 action 用例承担。

  // ─── notify-once watch 桥（设计 D2/D6/U3；验收：params 守卫两面 / 路由三分支 /
  //     respond 回写 / ownership / 二次校验两态 / TTL 已挂 watch 同步 respond）────────
  describe('notify-once watch 路由：单键寻址三分支 + respond 前二次归属校验', () => {
    const VALID_NID = 'sm-12345678-1234-4234-8234-123456789012'
    const VALID_NID2 = 'sm-12345678-1234-4234-8234-123456789013'

    /** create 带 prompt+notifyId 的 shortcut（应答面取首个 respond 调用）。 */
    async function createAndRespond(opts: SessionManagerHandlerOptions, handler: SessionManagerHandler): Promise<Record<string, unknown>> {
      await handler.handle('req-1', 'sid-parent', 'create', { cwd: '/t', prompt: 'init', notifyId: VALID_NID })
      return respondAt(opts)
    }

    it('params 守卫通过：封闭单键 {notifyId}（sm- 形态）→ 进入路由零 error', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)
      await handler.handle('req-watch', 'sid-parent', 'watch', { notifyId: VALID_NID })
      const payload = respondAt(opts)
      expect(payload.error).toBeUndefined()
      expect(payload.reason).toBe('cancelled') // 查无 claim → fail-closed（守卫通过后的路由应答）
    })

    it('params 守卫拒绝：空载荷 / 夹带额外字段 / notifyId 形态非法 → respond({error}) error envelope', async () => {
      const badParams: Array<Record<string, unknown>> = [
        {},
        { notifyId: VALID_NID, parentSid: 'forged' },
        { notifyId: 'not-a-valid-id' },
        { notifyId: 42 },
      ]
      for (const params of badParams) {
        const opts = makeMockOptions()
        const handler = new SessionManagerHandler(opts)
        await handler.handle('req-watch', 'sid-parent', 'watch', params)
        const payload = respondAt(opts)
        expect(payload.error, `params=${JSON.stringify(params)} 应被守卫拒绝`).toMatch(/invalid params for session-manager action 'watch'/)
      }
    })

    it('fail-closed：查无 claim → 立即 respond {reason:cancelled} 不携 sessionId（D-4），通道 = 发起方 select、requestId=watchId', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)
      await handler.handle('req-watch-9', 'sid-parent', 'watch', { notifyId: VALID_NID })
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-watch-9',
        JSON.stringify({ reason: 'cancelled' }),
        'select',
      )
    })

    it('wait：claim armed/injected 未兑现 → 零 respond（deferred 长挂，单键挂起）', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)
      opts.claims!.arm({ parentSid: 'sid-parent', notifyId: VALID_NID, kind: 'claim', sessionId: 's1' })
      await handler.handle('req-watch', 'sid-parent', 'watch', { notifyId: VALID_NID })
      expect(opts.sendExtensionUiResponse).not.toHaveBeenCalled()
      // 单 watch 槽：新覆盖旧（第二次开表同样零应答）
      await handler.handle('req-watch-2', 'sid-parent', 'watch', { notifyId: VALID_NID })
      expect(opts.sendExtensionUiResponse).not.toHaveBeenCalled()
      expect(opts.claims!.getClaim('sid-parent', VALID_NID)?.watchId).toBe('req-watch-2')
    })

    it('deferred 晚达应答：wait 后 settle → 经写回通道回 req-watch（reason/settleSeq/fulfillsN/sessionFilePath）', async () => {
      const { opts, handler } = makeWatchFixture(VALID_NID, { sessionFile: '/tmp/s1.jsonl' })
      await handler.handle('req-watch', 'sid-parent', 'watch', { notifyId: VALID_NID })
      expect(opts.sendExtensionUiResponse).not.toHaveBeenCalled() // 挂起

      // settle 兑现腿（组合根形态：素材回执循环 + handler 写回通道）
      const batch = opts.claims!.settle('s1', 'done')
      deliverRespondTargets(opts.claims!, batch.targets, handler.watchRespond, {
        sessionFilePath: '/tmp/s1.jsonl',
      })
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledTimes(1)
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-watch',
        JSON.stringify({ reason: 'completed', sessionId: 's1', settleSeq: 1, fulfillsN: 1, sessionFilePath: '/tmp/s1.jsonl' }),
        'select',
      )
      // onRespond(true) → 记录删除：再次开表 fail-closed
      await handler.handle('req-watch-3', 'sid-parent', 'watch', { notifyId: VALID_NID })
      expect(respondAt(opts, 1)).toEqual({ reason: 'cancelled' })
    })

    it('catch-up：watch 晚于兑现到达 → 立即 respond 快照 + onRespond 删记录', async () => {
      // 'error' 预兑现：兑现时无 watch（fulfilled-no-watch）
      const { opts, handler } = makeWatchFixture(VALID_NID, { sessionFile: '/tmp/s1.jsonl' }, 'error')

      await handler.handle('req-watch-late', 'sid-parent', 'watch', { notifyId: VALID_NID })
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-watch-late',
        JSON.stringify({ reason: 'failed', sessionId: 's1', settleSeq: 1, fulfillsN: 1, sessionFilePath: '/tmp/s1.jsonl' }),
        'select',
      )
      expect(opts.claims!.getClaim('sid-parent', VALID_NID)).toBeUndefined()
    })

    it('二次校验两态①：应答时 session 已不在（getSummary 缺失）→ 按 exited 应答（死亡通知不凭空消失）', async () => {
      const { opts, handler } = makeWatchFixture(VALID_NID, undefined, 'done')

      await handler.handle('req-watch', 'sid-parent', 'watch', { notifyId: VALID_NID })
      expect(respondAt(opts)).toEqual({ reason: 'exited', sessionId: 's1' })
      expect(opts.claims!.getClaim('sid-parent', VALID_NID)).toBeUndefined()
    })

    it('二次校验两态②：session 仍在但归属失效 → 按 cancelled 应答（静默，不伪造死亡通知）', async () => {
      const { opts, handler } = makeWatchFixture(VALID_NID, { parentAgentSessionId: 'another-agent' }, 'done')

      await handler.handle('req-watch', 'sid-parent', 'watch', { notifyId: VALID_NID })
      expect(respondAt(opts)).toEqual({ reason: 'cancelled', sessionId: 's1' })
    })

    it('已终结态 catch-up：aborted → cancelled / orphaned → orphaned（终态词形直达）', async () => {
      const { opts, handler } = makeWatchFixture(VALID_NID, {})
      opts.claims!.openWatch('sid-parent', VALID_NID, 'w-old')
      const abortBatch = opts.claims!.abortClaims('s1')
      deliverRespondTargets(opts.claims!, abortBatch.targets, handler.watchRespond)
      expect(respondAt(opts)).toEqual({ reason: 'cancelled', sessionId: 's1' })

      // orphaned 吸收态：迟到 watch → orphaned（记录保留至 onRespond）
      opts.claims!.arm({ parentSid: 'sid-parent', notifyId: VALID_NID2, kind: 'claim', sessionId: 's1' })
      opts.claims!.openWatch('sid-parent', VALID_NID2, 'w2')
      opts.claims!.onRespond('sid-parent', VALID_NID2, false) // respond 失败 → orphaned
      await handler.handle('req-orphan', 'sid-parent', 'watch', { notifyId: VALID_NID2 })
      expect(respondAt(opts, 1)).toEqual({ reason: 'orphaned', sessionId: 's1' })
    })

        it('send 带合法 notifyId → arm + willNotify:true + notifyId/parentSid 穿 envelope meta', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)
      await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 'hello', notifyId: VALID_NID })

      expect(opts.claims!.getClaim('sid-parent', VALID_NID)?.state).toBe('armed')
      const respond = respondAt(opts)
      expect(respond).toEqual({ queued: true, willNotify: true })
      const handle = (opts.delivery.getOrCreateDelivery as ReturnType<typeof vi.fn>).mock.results[0].value as {
        sendChecked: ReturnType<typeof vi.fn>
      }
      // 两参形态（融合：notifyId 穿 envelope meta（theirs D2）+ receiptAnchor 申报制第二参（ours D1））
      expect(handle.sendChecked).toHaveBeenCalledWith(
        {
          payload: { kind: 'text', content: 'hello' },
          meta: { notifyId: VALID_NID, parentSid: 'sid-parent' },
        },
        { receiptAnchor: 'acceptance' },
      )
    })

    it('send 重复 notifyId（同父同键）→ isError 回包（幂等不变量执行点）+ 不重复建债', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)
      await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 'a', notifyId: VALID_NID })
      await handler.handle('req-2', 'sid-parent', 'send', { sessionId: 's1', prompt: 'b', notifyId: VALID_NID })
      const second = respondAt(opts, 1)
      expect(second.error).toMatch(/duplicate notifyId/)
    })

    it('send 投递失败（sendChecked reject）→ catch 同步 disarm：记录删除，零 undelivered（E7）', async () => {
      const opts = makeMockOptions({
        delivery: makeMockDelivery({
          getOrCreateDelivery: vi.fn().mockReturnValue({
            sendChecked: vi.fn().mockRejectedValue(new Error('target session unreachable')),
            send: vi.fn(),
            flush: vi.fn(),
            depth: vi.fn().mockReturnValue(0),
            dispose: vi.fn(),
          }),
        }),
      })
      const handler = new SessionManagerHandler(opts)
      await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 'hello', notifyId: VALID_NID })
      expect(opts.claims!.getClaim('sid-parent', VALID_NID)).toBeUndefined()
      expect(opts.claims!.undeliveredCount('s1')).toBe(0)
      const respond = respondAt(opts)
      expect(respond.error).toBe('target session unreachable')
      expect(respond.willNotify).toBeUndefined() // error 结果不携 willNotify
    })

    it('create 带 prompt+notifyId → claim arm + lifetime 独立键 arm + willNotify:true + markInjected（sendDirect 受理回执）', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(makeSessionSummary({ id: 'created-1' })),
        }),
      })
      const handler = new SessionManagerHandler(opts)
      const respond = await createAndRespond(opts, handler)
      expect(respond.willNotify).toBe(true)
      const lifetime = respond.lifetimeNotifyId as string
      expect(lifetime).toMatch(/^sm-/)
      expect(lifetime).not.toBe(VALID_NID) // 双键独立（杜绝撞幂等键）
      expect(opts.claims!.getClaim('sid-parent', VALID_NID)?.state).toBe('injected')
      expect(opts.claims!.getClaim('sid-parent', lifetime)?.kind).toBe('lifetime')
      expect(opts.claims!.getClaim('sid-parent', lifetime)?.state).toBe('armed')
    })

    it('create sendDirect throw → claim + lifetime 一并原子回滚 + 错误携 sessionId/hint（C-1 登记路径）', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          create: vi.fn().mockResolvedValue(makeSessionSummary({ id: 'created-1' })),
        }),
        delivery: makeMockDelivery({ sendDirect: vi.fn().mockRejectedValue(new Error('restore failed')) }),
      })
      const handler = new SessionManagerHandler(opts)
      const respond = await createAndRespond(opts, handler)
      expect(respond.error).toBe('restore failed')
      expect(respond.sessionId).toBe('created-1')
      expect(respond.hint).toBe('use send_to_session to retry')
      expect(opts.claims!.count()).toBe(0) // claim 与 lifetime 均已 disarm
      expect(opts.claims!.undeliveredCount('created-1')).toBe(0)
    })

    it('handleAbort 入口同步抹除：先于 await abort 抹债并 respond cancelled（防 settled stopped 抢兑）', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          abort: vi.fn().mockImplementation(async () => {
            // abort 执行时点断言：此刻债权已销账（入口同步抹除先于 await）
            expect(opts.claims!.getClaim('sid-parent', VALID_NID)).toBeUndefined()
          }),
        }),
      })
      const handler = new SessionManagerHandler(opts)
      opts.claims!.arm({ parentSid: 'sid-parent', notifyId: VALID_NID, kind: 'claim', sessionId: 's1' })
      opts.claims!.markInjected('sid-parent', VALID_NID)
      opts.claims!.openWatch('sid-parent', VALID_NID, 'w-abort')

      await handler.handle('req-abort', 'sid-parent', 'abort', { sessionId: 's1' })
      const mock = opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>
      expect(mock).toHaveBeenCalledTimes(2)
      expect(mock.mock.calls[0]).toEqual(['sid-parent', 'w-abort', JSON.stringify({ reason: 'cancelled', sessionId: 's1' }), 'select'])
      expect(mock.mock.calls[1]).toEqual(['sid-parent', 'req-abort', JSON.stringify({ success: true }), 'select'])
      expect(opts.claims!.undeliveredCount('s1')).toBe(0) // aborted 不入 undelivered
    })

    it('status/list 透出 undeliveredResults 事实计数（orphaned 分桶求和）', async () => {
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockImplementation((sid: string) =>
            sid === 's1' ? makeSessionSummary({ id: 's1' }) : undefined),
          listPersistedSessions: vi.fn().mockReturnValue([
            { cwd: '/w', sessions: [makeSessionSummary({ id: 's1', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' })] },
          ]),
        }),
      })
      const handler = new SessionManagerHandler(opts)
      // 制造一笔 orphaned（respond 失败腿）→ 计数 +1
      opts.claims!.arm({ parentSid: 'sid-parent', notifyId: VALID_NID2, kind: 'claim', sessionId: 's1' })
      opts.claims!.onRespond('sid-parent', VALID_NID2, false)
      expect(opts.claims!.undeliveredCount('s1')).toBe(1)

      await handler.handle('req-status', 'sid-parent', 'status', { sessionId: 's1' })
      await handler.handle('req-list', 'sid-parent', 'list', {})
      expect(respondAt(opts).undeliveredResults).toBe(1)
      expect(respondAt(opts, 1).undeliveredResults).toBe(1)
    })

    it('claims 停用象限（未注入）：send 不 arm、willNotify:false、watch fail-closed、计数 0', async () => {
      const opts = makeMockOptions({ claims: undefined })
      const handler = new SessionManagerHandler(opts)
      await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 'hi', notifyId: VALID_NID })
      await handler.handle('req-2', 'sid-parent', 'watch', { notifyId: VALID_NID })
      await handler.handle('req-3', 'sid-parent', 'status', { sessionId: 's1' })
      expect(respondAt(opts)).toEqual({ queued: true, willNotify: false })
      expect(respondAt(opts, 1)).toEqual({ reason: 'cancelled' })
      expect(respondAt(opts, 2).undeliveredResults).toBe(0)
    })
  })

  // ─── notify-once once 日志（D6 兼容矩阵象限2 观测信号：无 notifyId 不 arm →
  //     每进程只记一条降级陈述，混装象限的观测入口）──────────────────────────────
  describe('notify-once once 日志：无 notifyId 降级陈述每进程只记一条', () => {
    it('两次无 notifyId 的 send → console.info 恰 1 次', async () => {
      // once 额度是 handler 模块级布尔（组合根单例），既有用例已命中消费；
      // vi.resetModules + 动态重导入取得全新模块实例，断言不依赖用例执行顺序。
      vi.resetModules()
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      try {
        const { SessionManagerHandler: FreshHandler } = await import('../transport/session-manager-handler.js')
        const handler = new FreshHandler(makeMockOptions())

        await handler.handle('req-log-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 'a' })
        await handler.handle('req-log-2', 'sid-parent', 'send', { sessionId: 's1', prompt: 'b' })

        expect(info).toHaveBeenCalledTimes(1)
        expect(info).toHaveBeenCalledWith(expect.stringContaining('send arrived without a valid notifyId'))
        expect(info).toHaveBeenCalledWith(expect.stringContaining('log once'))
      } finally {
        info.mockRestore()
      }
    })
  })

})
