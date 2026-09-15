/**
 * Plugin Agent API — 真实 handler 测试
 *
 * 验证 setModel→switchModel、getModel→activeSession.modelId、
 * getActiveTools→toolRegistry schemas、getThinkingLevel 默认值。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import { clearActiveSessionCache } from '../src/services/plugin-service/plugin-rpc-setup.js'
import type { IMessageBroker, ISessionService } from '../src/interfaces.js'
import type { IPluginServiceDeps } from '../src/services/plugin-service/plugin-types.js'
import type { SessionSummary, SessionGroup } from '@taiji/shared'

// ── Fixtures ──────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
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
      lastActiveAt: Date.now(), modelId: 'openai/gpt-4', tokenCount: 0,
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('openai/gpt-4')
  })

  it('getModel returns empty string when no active session', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'idle',
      lastActiveAt: Date.now(), modelId: 'provider/x', tokenCount: 0,
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('')
  })

  it('setModel calls switchModel on active session', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(), modelId: 'provider/old', tokenCount: 0,
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
      lastActiveAt: Date.now(), modelId: 'provider/x', tokenCount: 0,
      thinkingLevel: 'high',
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('high')
  })

  it('getThinkingLevel returns "off" when active session has undefined thinkingLevel', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(), modelId: 'provider/x', tokenCount: 0,
      thinkingLevel: undefined,
    }
    const sessionService = createMockSessionService([session])
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
 * U6 回执普查降级守卫（C-pi-13 消费方契约）：setModel / setThinkingLevel 的 reply
 * 是 pi 生效值（pi pattern 换模 / 钳制时 ≠ 请求值），消费端必须处理空串降级、
 * 禁乐观写请求值。守卫分支零覆盖即契约无锁定。
 */
describe('Agent RPC Handlers — U6 降级守卫返回空串', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearActiveSessionCache()
  })

  it('setModel：无 sessionService → 返回空串（守卫分支 1）', async () => {
    const broker = createMockBroker()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(result).toBe('')
  })

  it('setModel：无活跃 session → 返回空串且不触达 switchModel（守卫分支 2）', async () => {
    const sessionService = createMockSessionService([])
    const service = createService(sessionService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(result).toBe('')
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('setModel：复合串无 "/"（parts < MIN_MODEL_PARTS）→ 返回空串且不触达 switchModel（守卫分支 3）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(), modelId: 'provider/old', tokenCount: 0,
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
      lastActiveAt: Date.now(), modelId: 'provider/old', tokenCount: 0,
    }
    const sessionService = createMockSessionService([session])
    const service = createService(sessionService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    // 请求 'openai/gpt-4'，mock 的 sessionService.switchModel 返回生效值 'provider/model-b'
    expect(result).toBe('provider/model-b')
  })

  it('setThinkingLevel：无 sessionService → 返回空串（守卫分支 1）', async () => {
    const broker = createMockBroker()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('')
  })

  it('setThinkingLevel：无活跃 session → 返回空串（守卫分支 2）', async () => {
    const sessionService = createMockSessionService([])
    const service = createService(sessionService)

    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('')
    expect((sessionService.setThinkingLevel as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('setThinkingLevel：活跃 session → 返回 setThinkingLevel 的生效档（回执契约正向锚点）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(), modelId: 'provider/x', tokenCount: 0,
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
      lastActiveAt: Date.now(), modelId: 'provider/old', tokenCount: 0,
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
      lastActiveAt: Date.now(), modelId: 'provider/x', tokenCount: 0,
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
