/**
 * WorkspaceMessageHandler + 写入时机接入测试。
 *
 * 覆盖（execution-plan test-matrix）：
 * - T1.9: RPC 贯穿：handler→service→store reply records
 * - T2.1: SessionLifecycle.create 成功后 record 被调
 * - T2.2: MessageDispatcher.sendPrompt record（line 83 同处）
 * - T2.3: pi create 失败 → record 未被调
 * - T2.4: hook blocked → record 未被调
 * - T2.5: ensureActive 失败 → record 未被调
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/workspace-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import type { ClientMessage } from '@taiji/shared'

// ── T1.9: WorkspaceMessageHandler RPC 贯穿 ─────────────────────

describe('WorkspaceMessageHandler — T1.9 RPC 贯穿', () => {
  it('workspace.listRecent → reply workspace.recentList with records', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const mockRecords = [
      { cwd: '/a', lastUsedAt: 1000, label: 'a' },
      { cwd: '/b', lastUsedAt: 2000, label: 'b' },
    ]
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService: { list: vi.fn().mockReturnValue(mockRecords), record: vi.fn() },
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.listRecent', id: 'req1', payload: {} } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req1',
      type: 'workspace.recentList',
      payload: { records: mockRecords },
    })
  })

  it('workspace.listRecent → empty list returns empty array', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService: { list: vi.fn().mockReturnValue([]), record: vi.fn() },
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.listRecent', id: 'req2', payload: {} } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    expect(cap.replies[0].payload).toMatchObject({ records: [] })
  })

  it('workspace.record → record(cwd) 被调并 reply 最新 records（热更新）', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const mockRecords = [
      { cwd: '/new', lastUsedAt: 3000, label: 'new' },
      { cwd: '/a', lastUsedAt: 1000, label: 'a' },
    ]
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const workspaceService = {
      record: vi.fn(),
      list: vi.fn().mockReturnValue(mockRecords),
    }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService,
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.record', id: 'req3', payload: { cwd: '/new' } } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    // record 被调传入 cwd
    expect(workspaceService.record).toHaveBeenCalledWith('/new')
    expect(workspaceService.record).toHaveBeenCalledTimes(1)
    // reply 返回刷新后的列表（一次往返完成写入+刷新）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req3',
      type: 'workspace.recentList',
      payload: { records: mockRecords },
    })
  })

  it('workspace.record 空 cwd → 仍 reply workspace.recentList（W6：校验失败不破坏 RPC 契约）', async () => {
    const { WorkspaceMessageHandler } = await import('../src/transport/workspace-message-handler.js')
    const mockRecords = [{ cwd: '/a', lastUsedAt: 1000, label: 'a' }]
    const cap = { replies: [] as Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> }
    const workspaceService = {
      record: vi.fn(),
      list: vi.fn().mockReturnValue(mockRecords),
    }
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      workspaceService,
    }
    const handler = new WorkspaceMessageHandler(ctx as unknown as ConstructorParameters<typeof WorkspaceMessageHandler>[0])
    const msg = { type: 'workspace.record', id: 'req4', payload: { cwd: '   ' } } as unknown as ClientMessage
    const WS = {} as never

    await handler.handleWorkspaceMessage(msg, WS)

    // 空 cwd 不应 record（不污染最近工作区列表）
    expect(workspaceService.record).not.toHaveBeenCalled()
    // 但仍必须 reply，否则前端 pending Promise 永不 resolve（破坏 RPC 契约）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'req4',
      type: 'workspace.recentList',
      payload: { records: mockRecords },
    })
  })
})

// ── T2.1-T2.5: 写入时机接入 ────────────────────────────────────

// SessionLifecycle 不再 import readPiState（W2 已删，create 改用 client.getState()）。
// pi-engine.js 仅剩类型导出，无需 vi.mock 运行时值。

describe('SessionLifecycle — 写入时机 record', () => {
  it('T2.1: create 成功后 record(sessionCwd) 被调', async () => {
    // client.getState() 返回 pi session 状态（sessionId/sessionFile）
    const { SessionLifecycle } = await import('../src/services/session/session-lifecycle.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const mockClient = {
      getState: vi.fn().mockResolvedValue({ sessionId: 's1', sessionFile: '/tmp/s1.jsonl' }),
      onEvent: vi.fn().mockReturnValue(() => {}),
    }
    const svc = {
      getExtensionPaths: vi.fn().mockResolvedValue([]),
      getSkillPaths: vi.fn().mockReturnValue([]),
      getReplaceSystemPrompt: vi.fn(() => undefined),
      initializeManagedSession: vi.fn().mockResolvedValue({ id: 's1', cwd: '/test', label: 'test' }),
      toSummary: vi.fn().mockReturnValue({ id: 's1', cwd: '/test', label: 'test' }),
      // S3-W2：创建入口收敛点
      notifySessionCreated: vi.fn(),
    }
    const pm = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      destroySession: vi.fn().mockResolvedValue(undefined),
      rekey: vi.fn(),
    }
    const configStore = { getDefaultModel: vi.fn().mockReturnValue({ provider: 'p', modelId: 'm' }) }
    const sessionStore = { refreshAll: vi.fn() }

    // 当前 SessionLifecycle 只有 4 个构造参数，workspaceService 是本次 W2 新增的第 5 个。
    // 如果测试因"too many arguments"编译失败，说明实现尚未加参数——这是预期的 TDD 失败。
    // 实现后此行应正常编译。
    // S3 写点归位：新增第 6 参 registerDeps（真 registerSession 的装配依赖，fake adapterFactory）。
    const lifecycle = new SessionLifecycle(
      svc as unknown as ConstructorParameters<typeof SessionLifecycle>[0],
      pm as unknown as ConstructorParameters<typeof SessionLifecycle>[1],
      configStore as unknown as ConstructorParameters<typeof SessionLifecycle>[2],
      sessionStore as unknown as ConstructorParameters<typeof SessionLifecycle>[3],
      workspaceService as unknown as ConstructorParameters<typeof SessionLifecycle>[4],
      {
        adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }),
        getMessageBus: () => null,
        broadcastGlobal: () => {},
        notifyMessageComplete: () => {},
      } as ConstructorParameters<typeof SessionLifecycle>[5],
    )

    await lifecycle.create(tmpdir(), 'test')

    expect(workspaceRecord).toHaveBeenCalledWith(tmpdir())
    expect(workspaceRecord).toHaveBeenCalledTimes(1)
  })

  it('T2.3: pi create 失败 → record 未被调', async () => {
    const { SessionLifecycle } = await import('../src/services/session/session-lifecycle.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      getExtensionPaths: vi.fn().mockResolvedValue([]),
      getSkillPaths: vi.fn().mockReturnValue([]),
      getReplaceSystemPrompt: vi.fn(() => undefined),
      initializeManagedSession: vi.fn(),
      toSummary: vi.fn(),
    }
    const pm = {
      createSession: vi.fn().mockRejectedValue(new Error('pi spawn failed')),
      destroySession: vi.fn().mockResolvedValue(undefined),
      rekey: vi.fn(),
    }
    const configStore = { getDefaultModel: vi.fn().mockReturnValue({ provider: 'p', modelId: 'm' }) }
    const sessionStore = { refreshAll: vi.fn() }

    const lifecycle = new SessionLifecycle(
      svc as unknown as ConstructorParameters<typeof SessionLifecycle>[0],
      pm as unknown as ConstructorParameters<typeof SessionLifecycle>[1],
      configStore as unknown as ConstructorParameters<typeof SessionLifecycle>[2],
      sessionStore as unknown as ConstructorParameters<typeof SessionLifecycle>[3],
      workspaceService as unknown as ConstructorParameters<typeof SessionLifecycle>[4],
      {
        adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }),
        getMessageBus: () => null,
        broadcastGlobal: () => {},
        notifyMessageComplete: () => {},
      } as ConstructorParameters<typeof SessionLifecycle>[5],
    )

    await expect(lifecycle.create('/test')).rejects.toThrow('pi spawn failed')
    expect(workspaceRecord).not.toHaveBeenCalled()
  })
})

describe('MessageDispatcher — 写入时机 record', () => {
  it('T2.2: sendPrompt 成功后 record(activeSession.cwd) 被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const mockClient = { prompt: vi.fn().mockResolvedValue(undefined), onEvent: vi.fn().mockReturnValue(() => {}) }
    const activeSession = { cwd: '/project', lastActiveAt: 0, isGenerating: false }
    const svc = {
      ensureActive: vi.fn().mockResolvedValue(mockClient),
      getSessionByClient: vi.fn().mockReturnValue(activeSession),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空守卫分支）
    const pm = { getClient: vi.fn(() => undefined) }
    // wave:perf-w09（D1-2）：dispatcher 4 参（svc/pm/workspace/bus），broker 依赖已删
    const bus = { publish: vi.fn() } as unknown as ConstructorParameters<typeof MessageDispatcher>[3]
    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      bus,
    )

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(result.blocked).toBe(false)
    expect(workspaceRecord).toHaveBeenCalledWith('/project')
    expect(workspaceRecord).toHaveBeenCalledTimes(1)
  })

  it('T2.4: hook blocked → record 未被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      ensureActive: vi.fn(),
      getSessionByClient: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空守卫分支）
    const pm = { getClient: vi.fn(() => undefined) }
    // wave:perf-w09（D1-2）：dispatcher 4 参（svc/pm/workspace/bus），broker 依赖已删
    const bus = { publish: vi.fn() } as unknown as ConstructorParameters<typeof MessageDispatcher>[3]
    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      bus,
    )

    // 注册一个会 block 的 hook
    dispatcher.setSendMessageHook(vi.fn().mockResolvedValue({ blocked: true, reason: 'blocked by hook' }))

    const result = await dispatcher.sendMessage('s1', 'hello')

    expect(result.blocked).toBe(true)
    expect(workspaceRecord).not.toHaveBeenCalled()
  })

  it('T2.5: ensureActive 失败 → record 未被调', async () => {
    const { MessageDispatcher } = await import('../src/services/session/message-dispatcher.js')
    const workspaceRecord = vi.fn()
    const workspaceService = { record: workspaceRecord, list: vi.fn().mockReturnValue([]) }
    const svc = {
      ensureActive: vi.fn().mockRejectedValue(new Error('restore failed')),
      getSessionByClient: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空守卫分支）
    const pm = { getClient: vi.fn(() => undefined) }
    // wave:perf-w09（D1-2）：dispatcher 4 参（svc/pm/workspace/bus），broker 依赖已删
    const bus = { publish: vi.fn() } as unknown as ConstructorParameters<typeof MessageDispatcher>[3]
    const dispatcher = new MessageDispatcher(
      svc as unknown as ConstructorParameters<typeof MessageDispatcher>[0],
      pm as unknown as ConstructorParameters<typeof MessageDispatcher>[1],
      workspaceService as unknown as ConstructorParameters<typeof MessageDispatcher>[2],
      bus,
    )

    await expect(dispatcher.sendMessage('s1', 'hello')).rejects.toThrow('restore failed')
    expect(workspaceRecord).not.toHaveBeenCalled()
  })
})
