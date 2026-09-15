/**
 * Hook API 测试
 *
 * 验证主线程侧 registerHookRpcHandlers 和 Worker 侧 createHookApi：
 * - plugin.hooks.register 注册成功 → 返回 { registered: true }
 * - 多个 handler 按优先级排序存储
 * - createHookApi.onPiEvent 注册并经 executeHookRequest 触发回调（D2-1 request 直连）
 * - executeHookRequest 的 block / transform / 放行三形态
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import {
  registerHookRpcHandlers,
  createHookApi,
  executeHookRequest,
  disposePluginHooks,
} from '../src/services/plugin-service/hook-api.js'
import type { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { HookEntry, PluginDescriptor, Disposable } from '../src/services/plugin-service/plugin-types.js'
import type { RpcResponse } from '../src/services/plugin-service/plugin-types.js'

// ── Helper: mock WorkerPort ──────────────────────────────────────────────

function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

function extractLastResponse(port: ReturnType<typeof createMockPort>): RpcResponse & { error?: { code: number; message: string } } {
  const last = port.messages[port.messages.length - 1] as { response: RpcResponse }
  return last.response as RpcResponse & { error?: { code: number; message: string } }
}

// ── Helper: mock PluginRpcClient ─────────────────────────────────────────

interface MockRpcClient {
  requestCalls: Array<{ method: string; params: Record<string, unknown> }>
  requestResults: Map<string, unknown>
  onNotificationHandlers: Map<string, (params: unknown) => void>
  // 暴露与 PluginRpcClient 相同的接口
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  onNotification: (method: string, handler: (params: unknown) => void) => () => void
  notify: (method: string, params: Record<string, unknown>) => void
}

function createMockRpcClient(): MockRpcClient & PluginRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const requestResults = new Map<string, unknown>()
  const onNotificationHandlers = new Map<string, (params: unknown) => void>()

  return {
    requestCalls,
    requestResults,
    onNotificationHandlers,

    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      const result = requestResults.get(method)
      return Promise.resolve(result !== undefined ? result : undefined)
    },

    onNotification: (method: string, handler: (params: unknown) => void) => {
      // 每个 method 只允许一个 handler（在当前测试场景中够用）
      onNotificationHandlers.set(method, handler)
      return () => {
        onNotificationHandlers.delete(method)
      }
    },

    notify: (_method: string, _params: Record<string, unknown>) => {
      // 测试中不需要
    },
  } as unknown as MockRpcClient & PluginRpcClient
}

// ── 主线程侧：registerHookRpcHandlers ─────────────────────────────────

describe('Hook API — registerHookRpcHandlers', () => {
  let rpc: PluginRpcServer
  let hookRegistry: Map<string, HookEntry[]>
  let port: ReturnType<typeof createMockPort>

  /** mock getDescriptor：根据 source/trustLevel 返回不同优先级 */
  let mockDescriptors = new Map<string, PluginDescriptor>()

  beforeEach(() => {
    rpc = new PluginRpcServer()
    hookRegistry = new Map()
    mockDescriptors = new Map()

    registerHookRpcHandlers(rpc, {
      hookRegistry,
      getDescriptor: (pluginId) => mockDescriptors.get(pluginId),
    })

    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  // ── TC-HK-01: 注册成功 ──────────────────────────────────────────

  it('TC-HK-01: register hook → returns { registered: true }', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.hooks.register',
      params: {
        pluginId: 'my-plugin',
        hookType: 'onBeforeSendMessage',
        handlerId: 'hook_my-plugin_1',
      },
    })

    const resp = extractLastResponse(port)
    expect(resp.id).toBe(1)
    expect('result' in resp).toBeTruthy()
    expect((resp as { result: unknown }).result).toEqual({ registered: true })

    // 验证 registry
    const entries = hookRegistry.get('onBeforeSendMessage')!
    expect(entries).toBeTruthy()
    expect(entries.length).toBe(1)
    expect(entries[0].handlerId).toBe('hook_my-plugin_1')
    // 没有 descriptor → 默认 priority 200
    expect(entries[0].priority).toBe(200)
  })

  // ── TC-HK-02: 多个 handler 按优先级排序 ─────────────────────────

  it('TC-HK-02: multiple handlers sorted by priority (lowest first)', async () => {
    // 注册三个 handler，模拟不同 trustLevel
    mockDescriptors.set('plugin-builtin', {
      pluginId: 'plugin-builtin',
      version: '1.0.0',
      displayName: 'Built-in',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'trusted',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: '/tmp/builtin',
      source: 'built-in',
      extensionDependencies: [],
    })
    mockDescriptors.set('plugin-trusted', {
      pluginId: 'plugin-trusted',
      version: '1.0.0',
      displayName: 'Trusted',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'trusted',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: '/tmp/trusted',
      source: 'external',
      extensionDependencies: [],
    })
    mockDescriptors.set('plugin-sandboxed', {
      pluginId: 'plugin-sandboxed',
      version: '1.0.0',
      displayName: 'Sandboxed',
      description: '',
      main: 'index.js',
      activationEvents: [],
      trustLevel: 'sandbox',
      status: 'ACTIVE',
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: '/tmp/sandbox',
      source: 'external',
      extensionDependencies: [],
    })

    // 按乱序注册 → 验证优先级排序结果
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 1, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-sandboxed', hookType: 'onBeforeSendMessage', handlerId: 'h_sandbox' },
    })
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 2, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-builtin', hookType: 'onBeforeSendMessage', handlerId: 'h_builtin' },
    })
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 3, method: 'plugin.hooks.register',
      params: { pluginId: 'plugin-trusted', hookType: 'onBeforeSendMessage', handlerId: 'h_trusted' },
    })

    const entries = hookRegistry.get('onBeforeSendMessage')!
    expect(entries).toBeTruthy()
    expect(entries.length).toBe(3)

    // 期望顺序: built-in (priority=0) → trusted (priority=100) → sandbox (priority=200)
    expect(entries[0].handlerId).toBe('h_builtin')
    expect(entries[0].priority).toBe(0)

    expect(entries[1].handlerId).toBe('h_trusted')
    expect(entries[1].priority).toBe(100)

    expect(entries[2].handlerId).toBe('h_sandbox')
    expect(entries[2].priority).toBe(200)
  })
})

// ── Worker 侧：createHookApi ──────────────────────────────────────────

describe('Hook API — createHookApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient
  let invokedParams: unknown[]

  beforeEach(() => {
    mockClient = createMockRpcClient()
    invokedParams = []
  })

  // ── TC-HK-03: onPiEvent 注册并触发 ────────────────────────────

  it('TC-HK-03: onPiEvent registers handler and triggers via executeHookRequest', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    // 注册 onPiEvent handler
    const collected: Array<{ eventName: string; data: unknown }> = []
    const disposable = await hookApi.onPiEvent('session:create', async (eventName, data) => {
      collected.push({ eventName, data })
    })

    // 验证注册请求已发送
    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    expect(registerCall).toBeTruthy()
    expect(registerCall.params.pluginId).toBe('test-plugin')
    // D2-4：注册 key 统一泛型 'onPiEvent'（事件名经 context 传给 handler，插件自滤）
    expect(registerCall.params.hookType).toBe('onPiEvent')
    expect(typeof registerCall.params.handlerId === 'string').toBeTruthy()

    const handlerId = registerCall.params.handlerId as string

    // 模拟主线程的 plugin.hooks.invoke request（D2-1 request 直连执行入口）
    const result = await executeHookRequest({
      handlerId,
      context: { eventName: 'session:create', data: { sessionId: 's1' } },
    })

    // handler 被调用
    expect(collected.length).toBe(1)
    expect(collected[0].eventName).toBe('session:create')
    expect(collected[0].data).toEqual({ sessionId: 's1' })

    // observer 类 hook 不产拦截结果（invoke 包装器返回 undefined，主线程按放行处理）
    expect(result).toBeUndefined()

    // 清理
    disposable.dispose()
  })

  // ── TC-HK-04: onBeforeSendMessage 注册并触发 ───────────────────

  it('TC-HK-04: onBeforeSendMessage registers and intercepts via executeHookRequest', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    const interceptorResult = { blocked: true, proceed: false, modifiedContent: 'SECRET' } as const
    const disposable = await hookApi.onBeforeSendMessage(async (ctx) => {
      invokedParams.push(ctx)
      return interceptorResult
    })

    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    expect(registerCall).toBeTruthy()
    expect(registerCall.params.hookType).toBe('onBeforeSendMessage')

    const handlerId = registerCall.params.handlerId as string

    const result = await executeHookRequest({
      handlerId,
      context: { pluginId: 'test-plugin', hookType: 'onBeforeSendMessage', data: { text: 'hello' }, timestamp: Date.now() },
    })

    expect(invokedParams.length).toBe(1)
    expect((invokedParams[0] as Record<string, unknown>).hookType).toBe('onBeforeSendMessage')

    // InterceptorResult 原样回传（字段映射在主线程 HookPipeline，D2-3）
    expect(result).toEqual(interceptorResult)

    disposable.dispose()
  })

  // ── TC-HK-05: dispose 清理本地 handler ─────────────────────────

  it('TC-HK-05: dispose removes handler, executeHookRequest proceeds after dispose', async () => {
    const hookApi = createHookApi(mockClient, 'test-plugin')

    const collected: number[] = []
    const disposable = await hookApi.onBeforeToolCall(async (ctx) => {
      collected.push(1)
      return { blocked: false, proceed: true }
    })

    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    expect(registerCall).toBeTruthy()
    const handlerId = registerCall.params.handlerId as string

    // dispose
    disposable.dispose()

    // 再次执行 invoke → 不触发 handler（已清除），返回放行
    const result = await executeHookRequest({ handlerId, context: {} })
    expect(collected.length).toBe(0) // handler should not be called after dispose
    expect(result).toEqual({ proceed: true })

    // 验证 unregister 请求已发送
    const unregisterCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.unregister')!
    expect(unregisterCall).toBeTruthy()
    expect(unregisterCall.params.handlerId).toBe(handlerId)
  })
})

// ── Fix-2: onPiEvent context 形状适配（三类调用方 payload/eventName 解析） ──

describe('onPiEvent context shape adaptation (Fix-2)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
  })

  /** 注册 onPiEvent 并返回（handlerId 采集器 + 收集到的 (eventName, data)） */
  async function registerObserver(registeredAs: string): Promise<{
    handlerId: () => string
    collected: Array<{ eventName: string; data: unknown }>
  }> {
    const hookApi = createHookApi(mockClient, 'shape-plugin')
    const collected: Array<{ eventName: string; data: unknown }> = []
    await hookApi.onPiEvent(registeredAs, async (eventName, data) => {
      collected.push({ eventName, data })
    })
    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    return { handlerId: () => registerCall.params.handlerId as string, collected }
  }

  it('interpreter flat shape {event, ...payload}: data excludes the event field itself', async () => {
    const { handlerId, collected } = await registerObserver('agent_start')
    await executeHookRequest({
      handlerId: handlerId(),
      // event-interpreter 平铺形状（event-interpreter.ts:310 等）
      context: { event: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', input: { cmd: 'ls' } },
    })
    expect(collected).toEqual([{
      eventName: 'tool_execution_start',
      // handler 的 data 只含业务负载，不混入 event 元字段（Fix-2 主断言）
      data: { toolCallId: 'tc-1', toolName: 'bash', input: { cmd: 'ls' } },
    }])
  })

  it('interpreter flat shape with top-level data field: eventName stays the received event, not the registered one', async () => {
    const { handlerId, collected } = await registerObserver('agent_start')
    await executeHookRequest({
      handlerId: handlerId(),
      // 平铺 payload 恰含顶层 data 字段且其内无 eventName——不得误判为 bridge 包装、
      // 不得用注册时事件名覆盖实际收到的 event 字段（Fix-2 错报边界）
      context: { event: 'tool_execution_end', toolCallId: 'tc-2', data: { output: 'ok' } },
    })
    expect(collected).toEqual([{
      eventName: 'tool_execution_end',
      data: { toolCallId: 'tc-2', data: { output: 'ok' } },
    }])
  })

  it('bridge wrapped shape data:{eventName, data}: unwraps inner data (unchanged semantics)', async () => {
    const { handlerId, collected } = await registerObserver('agent_start')
    await executeHookRequest({
      handlerId: handlerId(),
      // bridge（handleBridgeEvent）/ 标准 HookContext 形状
      context: { data: { eventName: 'session_start', data: { sessionId: 's-9' } } },
    })
    expect(collected).toEqual([{
      eventName: 'session_start',
      data: { sessionId: 's-9' },
    }])
  })

  it('flat variant {eventName, data} at top level: takes top-level data', async () => {
    const { handlerId, collected } = await registerObserver('agent_start')
    await executeHookRequest({
      handlerId: handlerId(),
      context: { eventName: 'session_tree', data: { nodes: 3 } },
    })
    expect(collected).toEqual([{
      eventName: 'session_tree',
      data: { nodes: 3 },
    }])
  })
})

// ── D2-1 request 直连：executeHookRequest 形态 ──────────────────────

describe('executeHookRequest (D2-1 request direct path)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
  })

  /** 注册一个 onBeforeSendMessage 拦截器并返回其 handlerId */
  async function registerInterceptor(
    handler: (ctx: unknown) => Promise<{ proceed: boolean; reason?: string; modifiedData?: unknown }>,
  ): Promise<{ handlerId: string; dispose: () => void }> {
    const hookApi = createHookApi(mockClient, 'direct-plugin')
    const disposable = await hookApi.onBeforeSendMessage(handler)
    const registerCall = mockClient.requestCalls.find(c => c.method === 'plugin.hooks.register')!
    return { handlerId: registerCall.params.handlerId as string, dispose: () => disposable.dispose() }
  }

  // ── block 形态 ─────────────────────────────────────────────────

  it('returns block form when handler returns proceed:false', async () => {
    const { handlerId, dispose } = await registerInterceptor(async () => ({
      proceed: false,
      reason: 'API key detected',
    }))

    const result = await executeHookRequest({ handlerId, context: { data: 'x' } })

    expect(result).toEqual({ proceed: false, reason: 'API key detected' })
    dispose()
  })

  // ── transform 形态 ─────────────────────────────────────────────

  it('returns transform form when handler returns modifiedData', async () => {
    const { handlerId, dispose } = await registerInterceptor(async () => ({
      proceed: true,
      modifiedData: { content: 'IMPORTANT' },
    }))

    const result = await executeHookRequest({ handlerId, context: { data: { content: '!important' } } })

    expect(result).toEqual({ proceed: true, modifiedData: { content: 'IMPORTANT' } })
    dispose()
  })

  // ── 放行形态 ───────────────────────────────────────────────────

  it('returns { proceed: true } for unknown handlerId', async () => {
    await registerInterceptor(async () => ({ proceed: true }))
    const result = await executeHookRequest({ handlerId: 'hook_nobody_999', context: {} })
    expect(result).toEqual({ proceed: true })
  })

  it('returns { proceed: true } for malformed params (no handlerId)', async () => {
    const result = await executeHookRequest({})
    expect(result).toEqual({ proceed: true })
  })
})

// ── P-5: 多执行器互不串扰（NOT_CLAIMED 链式认领） ──────────────────────

describe('multiple hook executors (P-5)', () => {
  it('two createHookApi instances claim their own handlerIds without cross-talk', async () => {
    const clientA = createMockRpcClient()
    const clientB = createMockRpcClient()
    const apiA = createHookApi(clientA, 'plugin-a')
    const apiB = createHookApi(clientB, 'plugin-b')

    const callsA: string[] = []
    const callsB: string[] = []
    await apiA.onBeforeSendMessage(async () => {
      callsA.push('a')
      return { proceed: true, modifiedData: 'FROM_A' }
    })
    await apiB.onBeforeSendMessage(async () => {
      callsB.push('b')
      return { proceed: false, reason: 'FROM_B' }
    })

    const handlerIdA = (clientA.requestCalls.find(c => c.method === 'plugin.hooks.register')!).params.handlerId as string
    const handlerIdB = (clientB.requestCalls.find(c => c.method === 'plugin.hooks.register')!).params.handlerId as string
    expect(handlerIdA).not.toBe(handlerIdB)

    // 分别 invoke：各自 executor 认领，另一 executor 返回 {claimed:false} 链式跳过
    const resultA = await executeHookRequest({ handlerId: handlerIdA, context: {} })
    const resultB = await executeHookRequest({ handlerId: handlerIdB, context: {} })

    expect(resultA).toEqual({ proceed: true, modifiedData: 'FROM_A' })
    expect(resultB).toEqual({ proceed: false, reason: 'FROM_B' })
    expect(callsA).toEqual(['a'])
    expect(callsB).toEqual(['b'])
  })

  it('disposePluginHooks removes one plugin entirely; the other executor keeps working (P-1/P-2)', async () => {
    const clientA = createMockRpcClient()
    const clientB = createMockRpcClient()
    const apiA = createHookApi(clientA, 'stays-alive')
    const apiB = createHookApi(clientB, 'gets-deactivated')

    const callsA: number[] = []
    const callsB: number[] = []
    await apiA.onBeforeToolCall(async () => {
      callsA.push(1)
      return { proceed: true }
    })
    await apiB.onBeforeToolCall(async () => {
      callsB.push(1)
      return { proceed: true }
    })
    const handlerIdA = (clientA.requestCalls.find(c => c.method === 'plugin.hooks.register')!).params.handlerId as string
    const handlerIdB = (clientB.requestCalls.find(c => c.method === 'plugin.hooks.register')!).params.handlerId as string

    // 'deactivate'：plugin-b 的全部本地 handler 被清 + 执行器从 Set 摘除
    disposePluginHooks('gets-deactivated')

    const resultB = await executeHookRequest({ handlerId: handlerIdB, context: {} })
    expect(resultB).toEqual({ proceed: true }) // 未认领 → 放行
    expect(callsB).toEqual([]) // handler 不再执行（P-1：禁用插件的 hook 不再执行）

    // 另一插件的执行器不受影响
    const resultA = await executeHookRequest({ handlerId: handlerIdA, context: {} })
    expect(resultA).toEqual({ proceed: true })
    expect(callsA).toEqual([1])
  })
})
