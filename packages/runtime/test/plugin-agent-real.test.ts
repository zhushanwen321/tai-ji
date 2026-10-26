/**
 * Plugin RPC Handlers real 实装（Agent handlers / Session handlers）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - plugin-agent-real.test.ts
 * - plugin-session-real.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run test/plugin-agent-real.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionSummary, SessionGroup } from '@taiji/shared'
import type { IMessageBroker, ISessionService } from '../src/interfaces.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import { clearActiveSessionCache } from '../src/services/plugin-service/plugin-rpc-setup.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IPluginServiceDeps } from '../src/services/plugin-service/plugin-types.js'

describe('plugin-agent-real', () => {
/**
 * Plugin Agent API — 真实 handler 测试
 *
 * 验证 setModel→switchModel、getModel→activeSession.modelId、
 * getActiveTools→toolRegistry schemas、getThinkingLevel 默认值。
 */

// ── Fixtures ──────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/**
 * [W3] records = lifecycle 注册表记录最小形状（IManagedSessionView 的 modelId /
 * thinkingLevel 双写缓存字段）——getModel / getThinkingLevel 的读点已从 SessionSummary
 * 改到注册表记录（SessionSummary 三状态字段删除），测试经本参数接线同值记录。
 */
function createMockSessionService(
  sessions: SessionSummary[] = [],
  records: Array<{ id: string; modelId?: string; thinkingLevel?: string }> = [],
): ISessionService {
  const sessionMap = new Map(sessions.map(s => [s.id, s]))
  const recordMap = new Map(records.map(r => [r.id, r]))
  const groups: SessionGroup[] = sessions.length > 0
    ? [{ cwd: sessions[0].cwd, sessions }]
    : []

  return {
    listPersistedSessions: vi.fn().mockReturnValue(groups),
    getSummary: vi.fn((id: string) => sessionMap.get(id)),
    getSession: vi.fn((id: string) => recordMap.get(id)),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue('provider/model-b'),
    setThinkingLevel: vi.fn().mockResolvedValue('off'),
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    restoreSession: vi.fn().mockResolvedValue(undefined),
    hasActiveSession: vi.fn().mockReturnValue(true),
    getRpcClient: vi.fn().mockReturnValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as ISessionService
}

function createService(sessionService?: ISessionService, modelService?: IPluginServiceDeps['modelService']): PluginService {
  const broker = createMockBroker()
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  const deps: IPluginServiceDeps = {
    sessionService,
    modelService,
  }
  return new PluginService(registry, broker, deps)
}

async function callMethod(service: PluginService, method: string, params: Record<string, unknown>): Promise<unknown> {
  const svc = service as unknown as {
    registerRpcMethods(): void
    rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
  }
  svc.registerRpcMethods()
  const handler = svc.rpcServer.methods.get(method)
  if (!handler) throw new Error(`Method not registered: ${method}`)
  return handler(params)
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('Agent RPC Handlers — real implementation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearActiveSessionCache()
  })

  it('getModel returns active session modelId', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session], [{ id: 's1', modelId: 'openai/gpt-4' }])
    const service = createService(sessionService)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('openai/gpt-4')
  })

  it('getModel returns empty string when no active session', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'idle',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('')
  })

  it('setModel calls switchModel on active session', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(sessionService.switchModel).toHaveBeenCalledWith('s1', 'openai', 'gpt-4')
  })

  it('setModel is silently ignored when no active session', async () => {
    const sessionService = createMockSessionService([])
    const service = createService(sessionService)

    await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('getThinkingLevel returns "off" when no active session', async () => {
    const service = createService(createMockSessionService())

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('off')
  })

  it('getThinkingLevel returns active session thinkingLevel', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session], [{ id: 's1', thinkingLevel: 'high' }])
    const service = createService(sessionService)

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('high')
  })

  it('getThinkingLevel returns "off" when active session has undefined thinkingLevel', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    // W3：注册表记录无 thinkingLevel 缓存值（undefined）→ 'off' 兜底
    const sessionService = createMockSessionService([session], [{ id: 's1' }])
    const service = createService(sessionService)

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('off')
  })

  it('setThinkingLevel is silently accepted', async () => {
    const service = createService(createMockSessionService())

    // Should not throw
    await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
  })

  it('getActiveTools returns tool schema names from toolRegistry', async () => {
    const service = createService(createMockSessionService())
    const svc = service as unknown as {
      registerRpcMethods(): void
      rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
      toolRegistry: Map<string, { schema: { name: string } }>
    }

    // Inject tool entries into registry
    svc.toolRegistry.set('p1:toolA', { schema: { name: 'toolA' } })
    svc.toolRegistry.set('p1:toolB', { schema: { name: 'toolB' } })

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual(['toolA', 'toolB'])
  })

  it('getActiveTools returns empty array when no tools', async () => {
    const service = createService(createMockSessionService())

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual([])
  })

  it('falls back to stub when sessionService is undefined', async () => {
    const broker = createMockBroker()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('')

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual([])
  })
})

/**
 * U6 回执普查降级检查（C-pi-13 消费方契约）：setModel / setThinkingLevel 的 reply
 * 是 pi 生效值（pi pattern 换模 / 钳制时 ≠ 请求值），消费端必须处理空串降级、
 * 禁乐观写请求值。检查分支零覆盖即契约无锁定。
 */
describe('Agent RPC Handlers — U6 降级检查返回空串', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearActiveSessionCache()
  })

  it('setModel：无 sessionService → 返回空串（检查分支 1）', async () => {
    const broker = createMockBroker()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(result).toBe('')
  })

  it('setModel：无活跃 session → 返回空串且不触达 switchModel（检查分支 2）', async () => {
    const sessionService = createMockSessionService([])
    const service = createService(sessionService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(result).toBe('')
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('setModel：复合串无 "/"（parts < MIN_MODEL_PARTS）→ 返回空串且不触达 switchModel（检查分支 3）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'gpt-4' })
    expect(result).toBe('')
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('setModel：活跃 session + 合法复合串 → 返回 switchModel 的生效值（回执契约正向锚点）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    // 请求 'openai/gpt-4'，mock 的 sessionService.switchModel 返回生效值 'provider/model-b'
    expect(result).toBe('provider/model-b')
  })

  it('setThinkingLevel：无 sessionService → 返回空串（检查分支 1）', async () => {
    const broker = createMockBroker()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('')
  })

  it('setThinkingLevel：无活跃 session → 返回空串（检查分支 2）', async () => {
    const sessionService = createMockSessionService([])
    const service = createService(sessionService)

    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('')
    expect((sessionService.setThinkingLevel as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('setThinkingLevel：活跃 session → 返回 setThinkingLevel 的生效档（回执契约正向锚点）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session])
    ;(sessionService.setThinkingLevel as ReturnType<typeof vi.fn>).mockResolvedValue('high')
    const service = createService(sessionService)

    // 请求 max，pi 钳制后生效档 high（事故 B 形态）——回执返回生效档而非请求值
    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('high')
    expect(sessionService.setThinkingLevel).toHaveBeenCalledWith('s1', 'max')
  })

  it('setModel：deps 注入 modelService → 委托 modelService.switchModel 原样返回生效值（生产主臂锚点，session-only 兜底臂零触达）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session])
    const modelService = {
      switchModel: vi.fn().mockResolvedValue('provider/model-unified'),
      setThinkingLevel: vi.fn().mockResolvedValue('high'),
    } as unknown as IPluginServiceDeps['modelService']
    const service = createService(sessionService, modelService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    // 委托返回行是回执契约承重点：若 return 丢失（回执退化为 undefined）此断言红
    expect(result).toBe('provider/model-unified')
    expect(modelService!.switchModel).toHaveBeenCalledWith('s1', 'openai', 'gpt-4')
    // 主臂命中时 session-only fallback 臂不触达
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('setThinkingLevel：deps 注入 modelService → 委托 modelService.setThinkingLevel 原样返回生效档（生产主臂锚点）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService([session])
    const modelService = {
      switchModel: vi.fn().mockResolvedValue('provider/model-unified'),
      setThinkingLevel: vi.fn().mockResolvedValue('high'),
    } as unknown as IPluginServiceDeps['modelService']
    const service = createService(sessionService, modelService)

    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('high')
    expect(modelService!.setThinkingLevel).toHaveBeenCalledWith('s1', 'max')
    expect(sessionService.setThinkingLevel).not.toHaveBeenCalled()
  })
})
})

describe('plugin-session-real', () => {
/**
 * Plugin Session API — 真实 handler 测试
 *
 * 验证 listSessions/getSession/getActiveSession/sendMessage
 * 通过 deps.sessionService 真实调用（mock ISessionService）。
 */

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
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
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

    // [D6/u5b] 透传链：dispatcher 签名 (sessionId, content, images?, clientUuid?, requireCommand?)
    expect(mockSessionService.sendMessage).toHaveBeenCalledWith('s1', 'Hello', undefined, undefined, undefined)
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
})
