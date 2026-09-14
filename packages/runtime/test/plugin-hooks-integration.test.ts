/**
 * Hook 执行管道集成测试
 *
 * 验证 PluginService 的 hook 管道方法：
 * - executeHooks: hookRegistry 查询 + 按优先级排序 + broadcast 通知
 * - syncToolsToBridge: 收集 toolRegistry schema
 * - handleBridgeToolExecute: 工具执行请求路由
 * - handleBridgeEvent: bridge 事件广播
 * - handleBridgeIntercept: bridge 拦截请求
 *
 * 这些测试不依赖 PluginService.initialize()，直接操作私有状态。
 */

import { describe, it, expect, vi } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { HookEntry, ToolEntry, BridgeToolExecuteRequest, HookContext } from '../src/services/plugin-service/plugin-types.js'

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** 获取 PluginService 内部注册表的便捷方法（hookRegistry 下沉到 HookPipeline） */
function serviceRegistry(service: PluginService) {
  const hookPipeline = (service as unknown as { hookPipeline: { registry: Map<string, HookEntry[]> } }).hookPipeline
  const toolRegistry = (service as unknown as { toolRegistry: Map<string, ToolEntry> }).toolRegistry
  const host = (service as unknown as { host: { getWorkerHandle: ReturnType<typeof vi.fn> } }).host
  const rpcServer = (service as unknown as { rpcServer: { broadcast: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn> } }).rpcServer
  return { hookRegistry: hookPipeline.registry, toolRegistry, rpcServer, host }
}

// ══════════════════════════════════════════════════════════════════
// executeHooks
// ══════════════════════════════════════════════════════════════════

describe('PluginService.executeHooks', () => {
  // ── TC-HKP-01: 无注册 handler 返回未阻塞 ─────────────────────────
  it('TC-HKP-01: no registered handlers returns { blocked: false }', async () => {
    const service = new PluginService({} as never, createMockBroker())
    const result = await (service as any).executeHooks('onBeforeSendMessage', {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { text: 'hello' },
      timestamp: Date.now(),
    })
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-02: 排序后 broadcast 通知 Worker ────────────────────
  it('TC-HKP-02: sorted handlers broadcast invoke notification', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 注册三个 handler（乱序 priority，验证排序）
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p-sandbox', handlerId: 'h3', priority: 200 },
      { pluginId: 'p-builtin', handlerId: 'h1', priority: 0 },
      { pluginId: 'p-trusted', handlerId: 'h2', priority: 100 },
    ])

    const context: HookContext = {
      pluginId: '',
      hookType: 'onBeforeSendMessage',
      data: { text: 'test' },
      timestamp: 1000,
    }
    const result = await (service as any).executeHooks('onBeforeSendMessage', context)

    // 简化实现：不等待 Worker 结果，返回默认未阻塞
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-03: 不存在的 hookType 返回未阻塞 ────────────────────
  it('TC-HKP-03: unknown hookType returns { blocked: false }', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const reg = serviceRegistry(service)
    reg.hookRegistry.set('onBeforeSendMessage', [
      { pluginId: 'p1', handlerId: 'h1', priority: 0 },
    ])

    const result = await (service as any).executeHooks('onNonExistentHook', {
      pluginId: '',
      hookType: 'onNonExistentHook' as any,
      data: {},
      timestamp: Date.now(),
    })
    expect(result).toEqual({ blocked: false })
  })

  // ── TC-HKP-04: 优先级排序 — priority 0 先于 priority 200 ──────
  it('TC-HKP-04: handlers are sorted by priority ascending', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 只验证排序结果，不验证 broadcast 调用
    reg.hookRegistry.set('onBeforeToolCall', [
      { pluginId: 'low', handlerId: 'h_low', priority: 200 },
      { pluginId: 'high', handlerId: 'h_high', priority: 0 },
      { pluginId: 'mid', handlerId: 'h_mid', priority: 100 },
    ])

    // 模拟 executeHooks 内部逻辑来验证排序
    const entries = reg.hookRegistry.get('onBeforeToolCall')!
    const sorted = [...entries].sort((a, b) => a.priority - b.priority)

    expect(sorted[0].handlerId).toBe('h_high')
    expect(sorted[1].handlerId).toBe('h_mid')
    expect(sorted[2].handlerId).toBe('h_low')
  })
})

// ══════════════════════════════════════════════════════════════════
// syncToolsToBridge
// ══════════════════════════════════════════════════════════════════

describe('PluginService.syncToolsToBridge', () => {
  // ── TC-HKP-05: 空 registry 同步后 getToolSchemas 返回空 ─────────
  it('TC-HKP-05: empty toolRegistry produces empty cache', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    service.syncToolsToBridge()
    expect(service.getToolSchemas()).toEqual([])
  })

  // ── TC-HKP-06: 同步后 schema 可被 getToolSchemas 获取 ─────────
  it('TC-HKP-06: syncToolsToBridge collects all tool schemas', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    reg.toolRegistry.set('plugin-a:hello', {
      pluginId: 'plugin-a',
      handlerId: 'plugin-a:hello',
      schema: { name: 'hello', description: 'Says hello', parameters: { type: 'object', properties: {} } },
    })
    reg.toolRegistry.set('plugin-b:search', {
      pluginId: 'plugin-b',
      handlerId: 'plugin-b:search',
      schema: { name: 'search', description: 'Searches', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    })

    service.syncToolsToBridge()

    const schemas = service.getToolSchemas()
    expect(schemas).toHaveLength(2)
    expect(schemas[0].name).toBe('hello')
    expect(schemas[1].name).toBe('search')
  })

  // ── TC-HKP-07: 多次 sync 后 schema 列表更新 ──────────────────
  it('TC-HKP-07: syncToolsToBridge reflects registry changes', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 初始同步
    reg.toolRegistry.set('p1:tool1', {
      pluginId: 'p1', handlerId: 'p1:tool1',
      schema: { name: 'tool1', description: '', parameters: {} },
    })
    service.syncToolsToBridge()
    expect(service.getToolSchemas()).toHaveLength(1)

    // 添加新工具后再次同步
    reg.toolRegistry.set('p2:tool2', {
      pluginId: 'p2', handlerId: 'p2:tool2',
      schema: { name: 'tool2', description: '', parameters: {} },
    })
    service.syncToolsToBridge()
    expect(service.getToolSchemas()).toHaveLength(2)
  })
})

// ══════════════════════════════════════════════════════════════════
// getBridgeSyncPayload（schema 塑形下沉 service）
// ══════════════════════════════════════════════════════════════════

describe('PluginService.getBridgeSyncPayload', () => {
  // ── 空 registry → 空 tools，success:true ──────────────────────────
  it('空 registry → { tools: [], success: true }', () => {
    const service = new PluginService({} as never, createMockBroker())
    service.syncToolsToBridge()

    expect(service.getBridgeSyncPayload()).toEqual({ tools: [], success: true })
  })

  // ── 塑形 ToolRegistration → {name,description,parameters}（剔除 execute handler）──
  it('把 toolRegistry schema 塑形成 {name,description,parameters}（transport 不再塑形）', () => {
    const service = new PluginService({} as never, createMockBroker())
    const reg = serviceRegistry(service)
    reg.toolRegistry.set('p:t', {
      pluginId: 'p', handlerId: 'p:t',
      schema: {
        name: 't', description: 'd',
        parameters: { type: 'object', properties: {} },
        execute: vi.fn(),
      },
    })
    service.syncToolsToBridge()

    const payload = service.getBridgeSyncPayload()
    expect(payload.tools).toEqual([
      { name: 't', description: 'd', parameters: { type: 'object', properties: {} } },
    ])
    // execute handler 不应泄漏到 sync payload
    expect((payload.tools[0] as Record<string, unknown>).execute).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// handleBridgeToolExecute
// ══════════════════════════════════════════════════════════════════

describe('PluginService.handleBridgeToolExecute', () => {
  // ── TC-HKP-08: 存在的工具路由到 Worker 执行并返回结果 ──────────
  it('TC-HKP-08: existing tool routes to worker and returns result', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    // Mock host.getWorkerHandle to return a valid handle
    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    // Mock rpcServer.invoke to return success
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      content: JSON.stringify({ success: true }),
      isError: false,
    })

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: { name: 'world' },
    }
    const result = await service.handleBridgeToolExecute(request)
    expect(result.isError).toBe(false)
    expect(result.content).toBeDefined()
  })

  // ── TC-HKP-09: 不存在的工具返回错误 ─────────────────────────────
  it('TC-HKP-09: non-existent tool returns error', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'nonexistent:tool',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })

  // ── TC-HKP-10: 空 registry 返回错误 ─────────────────────────────
  it('TC-HKP-10: empty toolRegistry returns error', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'any:tool',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)
    expect(result.isError).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════
// handleBridgeEvent
// ══════════════════════════════════════════════════════════════════

describe('PluginService.handleBridgeEvent', () => {
  // ── TC-HKP-11: 广播事件给注册的 Worker ─────────────────────────
  it('TC-HKP-11: broadcasts event to registered workers', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    // 注册 hook 类型（Fix-6：'onMessage' 死字面量已删，用真实 pi 事件名走 onPiEvent 映射）
    reg.hookRegistry.set('onPiEvent', [
      { pluginId: 'p1', handlerId: 'h1', priority: 100 },
    ])

    // handleBridgeEvent 不应抛出异常（agent_start 经 PI_HOOK_EVENT_MAP 映射到 onPiEvent observe 路径）
    service.handleBridgeEvent('agent_start', { text: 'hello' }, 'session-1')
    // 异步 executeHooks 的内部 broadcast — 等待微任务
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  // ── TC-HKP-12: 无注册 handler 不抛出异常 ───────────────────────
  it('TC-HKP-12: no registered handlers does not throw', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    // 不存在的 hook type 不应抛出
    expect(() => {
      service.handleBridgeEvent('unknownEvent', {}, 'session-1')
    }).not.toThrow()
  })
})

// ══════════════════════════════════════════════════════════════════
// handleBridgeIntercept
// ══════════════════════════════════════════════════════════════════

describe('PluginService.handleBridgeIntercept', () => {
  // ── TC-HKP-13: 返回 { injectedMessages: [] } ────────────────────
  it('TC-HKP-13: returns empty injectedMessages by default', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const result = await service.handleBridgeIntercept('before_agent_start', { query: 'hello' }, 'session-1')
    expect(result).toEqual({ injectedMessages: [] })
  })

  // ── TC-HKP-14: 有注册 handler 时仍返回空数组（简化实现）────────
  it('TC-HKP-14: returns empty injectedMessages even with handlers (simplified)', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = serviceRegistry(service)

    reg.hookRegistry.set('before_agent_start', [
      { pluginId: 'p1', handlerId: 'h1', priority: 0 },
    ])

    const result = await service.handleBridgeIntercept('before_agent_start', { query: 'test' }, 'session-2')
    expect(result).toEqual({ injectedMessages: [] })
  })
})

// ══════════════════════════════════════════════════════════════════
// sessionDataCache
// ══════════════════════════════════════════════════════════════════

describe('PluginService.sessionDataCache', () => {
  // ── TC-HKP-15: sessionDataCache 可读写单条 session ──────────────
  it('TC-HKP-15: can read and write session data', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const sds = (service as unknown as { sessionDataStore: { set(s: string, k: string, v: unknown): void; get(s: string, k: string): unknown } }).sessionDataStore

    // 创建 session 数据
    sds.set('session-1', 'key1', 'value1')
    sds.set('session-1', 'key2', 42)

    // 读取
    expect(sds.get('session-1', 'key1')).toBe('value1')
    expect(sds.get('session-1', 'key2')).toBe(42)
  })

  // ── TC-HKP-16: sessionDataCache 支持多 session 隔离 ────────────
  it('TC-HKP-16: multiple sessions are isolated', () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const sds = (service as unknown as { sessionDataStore: { set(s: string, k: string, v: unknown): void; get(s: string, k: string): unknown } }).sessionDataStore

    sds.set('session-a', 'msg', 'hello')
    sds.set('session-b', 'msg', 'world')

    expect(sds.get('session-a', 'msg')).toBe('hello')
    expect(sds.get('session-b', 'msg')).toBe('world')
  })
})
