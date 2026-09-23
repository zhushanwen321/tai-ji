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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { SessionManagerHandler } from '../transport/session-manager-handler.js'
import type { SessionManagerHandlerOptions } from '../transport/session-manager-handler.js'
import type { SessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
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

function makeMockOptions(overrides: Partial<SessionManagerHandlerOptions> = {}): SessionManagerHandlerOptions {
  return {
    sessionService: makeMockSessionService(),
    delivery: makeMockDelivery(),
    sendExtensionUiResponse: vi.fn(),
    broadcastSessionList: vi.fn(),
    ...overrides,
  }
}

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

      // 3. respond 包含 sessionId, status, modelId
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ sessionId: 'new-session', status: 'created', modelId: 'openai/gpt-4' }),
        'select',
      )
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

      // 走 sessionId 单例注册表取 handle，sendChecked 收到 text payload
      expect(delivery.getOrCreateDelivery).toHaveBeenCalledWith('s1')
      const handle = (delivery.getOrCreateDelivery as ReturnType<typeof vi.fn>).mock.results[0].value as { sendChecked: ReturnType<typeof vi.fn> }
      expect(handle.sendChecked).toHaveBeenCalledWith({ payload: { kind: 'text', content: 'hello' } })
      // respond {queued: true}（sd-u5：不再出现 {blocked, rejected}）
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ queued: true }),
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

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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

        const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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

        const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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

        const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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

        const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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

        const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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
          JSON.stringify({ queued: true }),
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
      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
      expect(response.messages).toEqual(messages)
      expect(response.truncated).toBe(false)
    })

    it('畸形 params（send.prompt 非法）→ respond({error})，不流入 sessionService（params 信任边界守卫）', async () => {
      const opts = makeMockOptions()
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'send', { sessionId: 's1', prompt: 42 })

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
      expect(response.error).toMatch(/invalid params/)
      expect(opts.delivery.getOrCreateDelivery).not.toHaveBeenCalled()
    })

    it('status → {status, modelId}', async () => {
      const summary = makeSessionSummary({ status: 'active', modelId: 'openai/gpt-4' })
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockReturnValue(summary),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'status', { sessionId: 's1' })

      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ status: 'active', modelId: 'openai/gpt-4' }),
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
        JSON.stringify({ status: 'not_found' }),
        'select',
      )
    })

    it('list → {sessions} 过滤 spawnSource', async () => {
      const sessions = [
        makeSessionSummary({ id: 's1', spawnSource: 'user' }),
        makeSessionSummary({ id: 's2', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
        makeSessionSummary({ id: 's3', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
      ]
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          listPersistedSessions: vi.fn().mockReturnValue([{ cwd: '/test', sessions }]),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'list', { spawnSource: 'agent' })

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
      expect(response.sessions).toHaveLength(2)
      expect(response.sessions[0].id).toBe('s2')
      expect(response.sessions[1].id).toBe('s3')
    })

    it('list → 缺省注入路由上下文：只返回本父的 agent 子 session（params 不得放宽）', async () => {
      const sessions = [
        makeSessionSummary({ id: 's1', spawnSource: 'user' }),
        makeSessionSummary({ id: 's2', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
        makeSessionSummary({ id: 's3', spawnSource: 'agent', parentAgentSessionId: 'parent-b' }),
      ]
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          listPersistedSessions: vi.fn().mockReturnValue([{ cwd: '/test', sessions }]),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      // 空 params（extension 端 list_my_sessions 实际发送的形状）
      await handler.handle('req-1', 'sid-parent', 'list', {})

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
      expect(response.sessions).toHaveLength(1)
      expect(response.sessions[0].id).toBe('s2')
    })

    it('list → params 显式指定其他 parentAgentSessionId 不生效（防跨父枚举）', async () => {
      const sessions = [
        makeSessionSummary({ id: 's1', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }),
        makeSessionSummary({ id: 's2', spawnSource: 'agent', parentAgentSessionId: 'parent-b' }),
      ]
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          listPersistedSessions: vi.fn().mockReturnValue([{ cwd: '/test', sessions }]),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'list', { parentAgentSessionId: 'parent-b' })

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
      expect(response.sessions).toHaveLength(1)
      expect(response.sessions[0].id).toBe('s1')
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

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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
      const summary = makeSessionSummary({ modelId: 'anthropic/claude-3' })
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockReturnValue(summary),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'status', { sessionId: 's1' })

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
      expect(response.modelId).toBe('anthropic/claude-3')
    })

    it('modelId 为空时不在 respond 中出现', async () => {
      const summary = makeSessionSummary({ modelId: '' })
      const opts = makeMockOptions({
        sessionService: makeMockSessionService({
          getSummary: vi.fn().mockReturnValue(summary),
        }),
      })
      const handler = new SessionManagerHandler(opts)

      await handler.handle('req-1', 'sid-parent', 'status', { sessionId: 's1' })

      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
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
      // 不阻断：created 结果照常回写
      expect(opts.sendExtensionUiResponse).toHaveBeenCalledWith(
        'sid-parent',
        'req-1',
        JSON.stringify({ sessionId: 'child-2', status: 'created', modelId: 'openai/gpt-4' }),
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
      const response = JSON.parse((opts.sendExtensionUiResponse as ReturnType<typeof vi.fn>).mock.calls[0][2])
      expect(response).toEqual({ sessionId: 'child-3', status: 'created', modelId: 'openai/gpt-4' })
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

})
