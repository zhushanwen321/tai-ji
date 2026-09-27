/**
 * Plugin Session API — 真实 handler 测试
 *
 * 验证 listSessions/getSession/getActiveSession/sendMessage
 * 通过 deps.sessionService 真实调用（mock ISessionService）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { IMessageBroker, ISessionService } from '../src/interfaces.js'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import type { IPluginServiceDeps } from '../src/services/plugin-service/plugin-types.js'

// ── Fixtures ──────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    label: 'Test Session',
    cwd: '/project',
    status: 'active',
    lastActiveAt: Date.now(),
    modelId: 'provider/model-a',
    tokenCount: 0,
    ...overrides,
  }
}

function createMockSessionService(sessions: SessionSummary[] = []): ISessionService {
  const sessionMap = new Map(sessions.map(s => [s.id, s]))

  const groups: SessionGroup[] = sessions.length > 0
    ? [{ cwd: sessions[0].cwd, sessions }]
    : []

  return {
    listPersistedSessions: vi.fn().mockReturnValue(groups),
    getSummary: vi.fn((id: string) => sessionMap.get(id)),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(createSessionSummary()),
    delete: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue('provider/model-a'),
    compact: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    restoreSession: vi.fn().mockResolvedValue(createSessionSummary()),
    hasActiveSession: vi.fn().mockReturnValue(true),
    getRpcClient: vi.fn().mockReturnValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as ISessionService
}

/** Create PluginService with injected deps */
function createService(sessionService?: ISessionService): PluginService {
  const broker = createMockBroker()
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  const deps: IPluginServiceDeps = {
    sessionService,
  }
  return new PluginService(registry, broker, deps)
}

/** Access RPC server internals for testing */
function getServiceInternals(service: PluginService) {
  const svc = service as unknown as {
    registerRpcMethods(): void
    rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
  }
  svc.registerRpcMethods()
  return svc
}

/** Call a registered RPC method by name */
async function callMethod(service: PluginService, method: string, params: Record<string, unknown>): Promise<unknown> {
  const internals = getServiceInternals(service)
  const handler = internals.rpcServer.methods.get(method)
  if (!handler) throw new Error(`Method not registered: ${method}`)
  return handler(params)
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('Session RPC Handlers — real sessionService calls', () => {
  let mockSessionService: ISessionService

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listSessions returns SessionInfo[] from sessionService', async () => {
    const s1 = createSessionSummary({ id: 's1', label: 'S1', status: 'active' })
    const s2 = createSessionSummary({ id: 's2', label: 'S2', status: 'idle' })
    mockSessionService = createMockSessionService([s1, s2])
    const service = createService(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.list', {})
    const list = result as Array<{ id: string; label: string; status: string }>

    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('s1')
    expect(list[0].label).toBe('S1')
    expect(list[0].status).toBe('active')
    expect(list[1].id).toBe('s2')
  })

  it('getSession returns SessionInfo for known session', async () => {
    const s1 = createSessionSummary({ id: 's1', cwd: '/work' })
    mockSessionService = createMockSessionService([s1])
    const service = createService(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.get', { sessionId: 's1' })

    expect(result).toBeDefined()
    const info = result as { id: string; cwd: string }
    expect(info.id).toBe('s1')
    expect(info.cwd).toBe('/work')
  })

  it('getSession returns undefined for unknown session', async () => {
    mockSessionService = createMockSessionService([])
    const service = createService(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.get', { sessionId: 'nonexistent' })
    expect(result).toBeUndefined()
  })

  it('getActiveSession returns the active session', async () => {
    const active = createSessionSummary({ id: 'active-1', status: 'active' })
    const idle = createSessionSummary({ id: 'idle-1', status: 'idle' })
    mockSessionService = createMockSessionService([active, idle])
    const service = createService(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.getActive', {})

    expect(result).toBeDefined()
    const info = result as { id: string }
    expect(info.id).toBe('active-1')
  })

  it('getActiveSession returns undefined when no active session', async () => {
    const idle = createSessionSummary({ id: 'idle-1', status: 'idle' })
    mockSessionService = createMockSessionService([idle])
    const service = createService(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.getActive', {})
    expect(result).toBeUndefined()
  })

  it('sendMessage calls sessionService.sendMessage', async () => {
    mockSessionService = createMockSessionService([
      createSessionSummary({ id: 's1' }),
    ])
    const service = createService(mockSessionService)

    await callMethod(service, 'plugin.sessions.sendMessage', {
      sessionId: 's1',
      role: 'user',
      content: 'Hello',
    })

    expect(mockSessionService.sendMessage).toHaveBeenCalledWith('s1', 'Hello')
  })

  it('falls back to stub when sessionService is undefined', async () => {
    const broker = createMockBroker()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    // No deps → sessionService is undefined
    const service = new PluginService(registry, broker)

    const list = await callMethod(service, 'plugin.sessions.list', {})
    expect(list).toEqual([])

    const single = await callMethod(service, 'plugin.sessions.get', { sessionId: 'x' })
    expect(single).toBeUndefined()

    const active = await callMethod(service, 'plugin.sessions.getActive', {})
    expect(active).toBeUndefined()

    // sendMessage should not throw
    await callMethod(service, 'plugin.sessions.sendMessage', {
      sessionId: 'x',
      role: 'user',
      content: 'test',
    })
  })
})
