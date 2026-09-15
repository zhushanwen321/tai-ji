/**
 * Tool Execution via RPC — TDD tests for BG1 Task 1
 *
 * Tests the full tool execution path:
 *   PluginService.handleBridgeToolExecute
 *     → toolRegistry.find → PluginHost.getWorkerHandle
 *     → resolveToolTimeoutMs(entry.schema.timeoutMs)（D1 取值链：声明优先 /
 *       <=0 或 Infinity opt-out / 非法回落默认 / clamp 上界）
 *     → PluginRpcServer.invoke(workerId, 'plugin.tool.execute', params, timeoutMs)
 *     → BridgeToolExecuteResponse
 *
 * Also tests PluginRpcServer.invoke() directly, the resolveToolTimeoutMs
 * branch table, the honest timeout error message (§5.2), and the
 * late-reply-after-timeout drop path (P-9, fake timers).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import {
  handleBridgeToolExecute,
  resolveToolTimeoutMs,
  DEFAULT_TOOL_EXECUTE_TIMEOUT_MS,
} from '../src/services/plugin-service/bridge-interop.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { ToolEntry, BridgeToolExecuteRequest } from '../src/services/plugin-service/plugin-types.js'

// ── Helpers ────────────────────────────────────────────────────

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/** Access PluginService internals for test setup */
function internals(service: PluginService) {
  return service as unknown as {
    toolRegistry: Map<string, ToolEntry>
    rpcServer: PluginRpcServer
    host: {
      getWorkerHandle(pluginId: string): { workerId: string; postMessage(message: unknown): void } | undefined
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// PluginRpcServer.invoke
// ══════════════════════════════════════════════════════════════════

describe('PluginRpcServer.invoke', () => {
  let rpcServer: PluginRpcServer

  beforeEach(() => {
    rpcServer = new PluginRpcServer()
  })

  it('sends RPC request and resolves on response', async () => {
    // Mock a worker port that captures messages
    const sentMessages: unknown[] = []
    const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
    rpcServer.registerWorker('worker-1', mockPort)

    // Invoke in background
    const invokePromise = rpcServer.invoke('worker-1', 'plugin.tool.execute', { toolName: 'hello' }, 5_000)

    // Should have sent a request message
    expect(sentMessages).toHaveLength(1)
    const sent = sentMessages[0] as { type: string; request: Record<string, unknown> }
    expect(sent.type).toBe('rpc')
    expect(sent.request.method).toBe('plugin.tool.execute')
    expect(sent.request.params).toEqual({ toolName: 'hello' })
    expect(typeof sent.request.id).toBe('number')

    // Simulate response from worker
    const requestId = sent.request.id as number
    rpcServer.handleResponse({ jsonrpc: '2.0', id: requestId, result: { content: 'Hello!', isError: false } })

    const result = await invokePromise
    expect(result).toEqual({ content: 'Hello!', isError: false })
  })

  it('rejects on timeout', async () => {
    vi.useFakeTimers()

    const mockPort = { postMessage: vi.fn() }
    rpcServer.registerWorker('worker-1', mockPort)

    const invokePromise = rpcServer.invoke('worker-1', 'plugin.tool.execute', {}, 5_000)

    // Advance past timeout
    vi.advanceTimersByTime(5_100)

    await expect(invokePromise).rejects.toThrow('RPC timeout')

    vi.useRealTimers()
  })

  it('rejects with error response from worker', async () => {
    const sentMessages: unknown[] = []
    const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
    rpcServer.registerWorker('worker-1', mockPort)

    const invokePromise = rpcServer.invoke('worker-1', 'test.method', {}, 5_000)

    const sent = sentMessages[0] as { request: Record<string, unknown> }
    const requestId = sent.request.id as number

    // Simulate error response
    rpcServer.handleResponse({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32603, message: 'Internal error' },
    })

    await expect(invokePromise).rejects.toThrow('Internal error')
  })

  it('throws for unknown worker', async () => {
    await expect(
      rpcServer.invoke('unknown-worker', 'test.method', {}, 5_000),
    ).rejects.toThrow('Worker not found')
  })
})

// ══════════════════════════════════════════════════════════════════
// PluginService.handleBridgeToolExecute
// ══════════════════════════════════════════════════════════════════

describe('PluginService.handleBridgeToolExecute (BG1 T1)', () => {
  // ── Happy path: tool found, worker executes, result returned ──
  it('routes tool execution to worker and returns result', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    // Setup: tool registered
    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: 'Says hello', parameters: {} },
    })

    // Setup: mock host.getWorkerHandle
    const mockHandle = {
      workerId: 'worker-1',
      postMessage: vi.fn(),
    }
    reg.host.getWorkerHandle = vi.fn().mockReturnValue(mockHandle)

    // Setup: mock rpcServer.invoke
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      content: 'Hello, World!',
      isError: false,
    })

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: { name: 'World' },
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({ content: 'Hello, World!', isError: false })
    expect(reg.host.getWorkerHandle).toHaveBeenCalledWith('p1')
    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.tool.execute',
      expect.objectContaining({
        pluginId: 'p1',
        toolName: 'hello',
        arguments: { name: 'World' },
      }),
      DEFAULT_TOOL_EXECUTE_TIMEOUT_MS,
    )
  })

  // ── Tool not found → error ──
  it('returns error when tool not found', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'nonexistent',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({
      content: 'Tool not found: nonexistent',
      isError: true,
    })
  })

  // ── Worker crashed → error ──
  it('returns error when worker handle not found (crashed)', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    // Worker handle not found
    reg.host.getWorkerHandle = vi.fn().mockReturnValue(undefined)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({
      content: 'Plugin worker crashed',
      isError: true,
    })
  })

  // ── RPC timeout → error ──
  it('returns error on RPC timeout', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    // Simulate timeout
    const timeoutError = new Error('RPC timeout')
    reg.rpcServer.invoke = vi.fn().mockRejectedValue(timeoutError)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result.isError).toBe(true)
    // 诚实化文案（§5.2）：等了多久 / 声明来源 / handler 仍在跑 / 调整指引
    expect(result.content).toContain(
      `Plugin tool 'hello' timed out after 30min (default;`,
    )
    expect(result.content).toContain(
      'plugin handler may still be running, its result will be discarded',
    )
    expect(result.content).toContain(
      'pass timeoutMs in registerTool() to extend or opt out (<=0 = no limit)',
    )
  })

  // ── Worker execution error → error ──
  it('returns error on worker execution failure', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    const execError = new Error('Something went wrong in plugin')
    reg.rpcServer.invoke = vi.fn().mockRejectedValue(execError)

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Plugin tool execution failed')
    expect(result.content).toContain('Something went wrong in plugin')
  })

  // ── Worker returns error result → forwarded as-is ──
  it('forwards worker error result as-is', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      content: 'something went wrong',
      isError: true,
    })

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: {},
    }
    const result = await service.handleBridgeToolExecute(request)

    expect(result).toEqual({
      content: 'something went wrong',
      isError: true,
    })
  })

  // ── Passes sessionId and toolCallId through to RPC params ──
  it('passes sessionId and toolCallId in RPC params', async () => {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)

    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: { name: 'hello', description: '', parameters: {} },
    })

    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })

    reg.rpcServer.invoke = vi.fn().mockResolvedValue({
      content: 'ok',
      isError: false,
    })

    const request: BridgeToolExecuteRequest = {
      type: 'bridge.tool.execute',
      toolName: 'hello',
      parameters: { name: 'test' },
      sessionId: 'session-123',
      toolCallId: 'call-456',
    }
    await service.handleBridgeToolExecute(request)

    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.tool.execute',
      expect.objectContaining({
        sessionId: 'session-123',
        toolCallId: 'call-456',
      }),
      DEFAULT_TOOL_EXECUTE_TIMEOUT_MS,
    )
  })
})

// ══════════════════════════════════════════════════════════════════
// resolveToolTimeoutMs — D1 取值链全分支
// ══════════════════════════════════════════════════════════════════

/** Node setTimeout 域上界 2^31-1（bridge-interop 内 MAX_TIMER_DELAY_MS 的值；
 * 该常量未导出，测试以字面锚定规格，漂移即红）。 */
const TIMER_DOMAIN_MAX_MS = 2_147_483_647

describe('resolveToolTimeoutMs', () => {
  it('uses a valid positive declaration as-is (clamp no-op below the limit)', () => {
    expect(resolveToolTimeoutMs(1)).toBe(1)
    expect(resolveToolTimeoutMs(10_000)).toBe(10_000)
    expect(resolveToolTimeoutMs(600_000)).toBe(600_000)
  })

  it('clamps oversized declarations to the Node timer domain limit', () => {
    expect(resolveToolTimeoutMs(TIMER_DOMAIN_MAX_MS)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(TIMER_DOMAIN_MAX_MS + 1)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(5_000_000_000)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(TIMER_DOMAIN_MAX_MS)
  })

  it('treats <=0 and ±Infinity as explicit opt-out (clamped upper bound ≈ no limit)', () => {
    expect(resolveToolTimeoutMs(0)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(-1)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(-60_000)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(Number.POSITIVE_INFINITY)).toBe(TIMER_DOMAIN_MAX_MS)
    expect(resolveToolTimeoutMs(Number.NEGATIVE_INFINITY)).toBe(TIMER_DOMAIN_MAX_MS)
  })

  it('falls back to the default for NaN / undefined (dirty values never disarm the watchdog)', () => {
    expect(resolveToolTimeoutMs(Number.NaN)).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
    expect(resolveToolTimeoutMs(undefined)).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
    expect(resolveToolTimeoutMs()).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
  })
})

// ══════════════════════════════════════════════════════════════════
// 超时错误消息诚实化（设计 §5.2）：声明来源 + 时长 + 调整指引
// ══════════════════════════════════════════════════════════════════

describe('handleBridgeToolExecute timeout error message', () => {
  /** 组装：注册带额外 schema 字段的工具 + mock invoke 恒超时（变量中转携带
   * timeoutMs，绕开对 ToolRegistration 的字面量 excess property check——U2 落地
   * 字段后可直接写进类型） */
  function setupWithSchema(schema: ToolEntry['schema']) {
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)
    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema,
    })
    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })
    reg.rpcServer.invoke = vi.fn().mockRejectedValue(new Error('RPC timeout'))
    return service
  }

  function makeRequest(): BridgeToolExecuteRequest {
    return { type: 'bridge.tool.execute', toolName: 'hello', parameters: {} }
  }

  it('reports the declared duration and source when timeoutMs is declared', async () => {
    const declaredSchema = { name: 'hello', description: '', parameters: {}, timeoutMs: 10_000 }
    const service = setupWithSchema(declaredSchema)

    const result = await service.handleBridgeToolExecute(makeRequest())

    expect(result.isError).toBe(true)
    expect(result.content).toContain(`Plugin tool 'hello' timed out after 10s (declared;`)
    expect(result.content).toContain('its result will be discarded')
    expect(result.content).toContain('<=0 = no limit')
  })

  it('reports the default duration and source when no timeoutMs declared', async () => {
    const plainSchema = { name: 'hello', description: '', parameters: {} }
    const service = setupWithSchema(plainSchema)

    const result = await service.handleBridgeToolExecute(makeRequest())

    expect(result.isError).toBe(true)
    expect(result.content).toContain(
      `timed out after 30min (default;`,
    )
  })

  it('falls back to default source for an illegal (NaN) declaration', async () => {
    const nanSchema = { name: 'hello', description: '', parameters: {}, timeoutMs: Number.NaN }
    const service = setupWithSchema(nanSchema)

    const result = await service.handleBridgeToolExecute(makeRequest())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out after 30min (default;')
  })

  it('passes the resolved declared timeout to invoke', async () => {
    const declaredSchema = { name: 'hello', description: '', parameters: {}, timeoutMs: 10_000 }
    const broker = createMockBroker()
    const service = new PluginService({} as never, broker)
    const reg = internals(service)
    reg.toolRegistry.set('p1:hello', {
      pluginId: 'p1',
      handlerId: 'p1:hello',
      schema: declaredSchema,
    })
    reg.host.getWorkerHandle = vi.fn().mockReturnValue({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })
    reg.rpcServer.invoke = vi.fn().mockResolvedValue({ content: 'ok', isError: false })

    await service.handleBridgeToolExecute(makeRequest())

    expect(reg.rpcServer.invoke).toHaveBeenCalledWith(
      'worker-1',
      'plugin.tool.execute',
      expect.objectContaining({ toolName: 'hello' }),
      10_000,
    )
  })
})

// ══════════════════════════════════════════════════════════════════
// P-9：迟到回包 miss 不炸（fake timers 驱动真实 invoke 链）
// ══════════════════════════════════════════════════════════════════

describe('late reply after tool timeout (P-9)', () => {
  it('drops the late reply without error and keeps the pending tracker clean', async () => {
    vi.useFakeTimers()
    try {
      const broker = createMockBroker()
      const service = new PluginService({} as never, broker)
      const reg = internals(service)

      const declaredSchema = { name: 'slow', description: '', parameters: {}, timeoutMs: 5_000 }
      reg.toolRegistry.set('p1:slow', {
        pluginId: 'p1',
        handlerId: 'p1:slow',
        schema: declaredSchema,
      })
      reg.host.getWorkerHandle = vi.fn().mockReturnValue({
        workerId: 'worker-1',
        postMessage: vi.fn(),
      })
      // 真实 PluginRpcServer（不 mock invoke）——PendingTracker timer 由 fake timers 驱动
      const sentMessages: unknown[] = []
      reg.rpcServer.registerWorker('worker-1', {
        postMessage: (msg: unknown) => { sentMessages.push(msg) },
      })

      const request: BridgeToolExecuteRequest = {
        type: 'bridge.tool.execute',
        toolName: 'slow',
        parameters: {},
      }
      const execution = service.handleBridgeToolExecute(request)

      // 推进超过声明超时（5s）→ invoke reject → 诚实 isError
      await vi.advanceTimersByTimeAsync(5_100)
      const result = await execution
      expect(result.isError).toBe(true)
      expect(result.content).toContain('timed out after 5s (declared')

      // 迟到回包到达：登记项已随超时删除 → miss（返回 false），不得抛异常
      const timedOutId = (sentMessages[0] as { request: { id: number } }).request.id
      let lateHandled: boolean | undefined
      expect(() => {
        lateHandled = reg.rpcServer.handleResponse({
          jsonrpc: '2.0',
          id: timedOutId,
          result: { content: 'late result', isError: false },
        })
      }).not.toThrow()
      expect(lateHandled).toBe(false)

      // 登记表未被污染：后续请求正常收发
      const followUp = reg.rpcServer.invoke('worker-1', 'plugin.tool.execute', {}, 5_000)
      const followUpId = (sentMessages[1] as { request: { id: number } }).request.id
      reg.rpcServer.handleResponse({
        jsonrpc: '2.0',
        id: followUpId,
        result: { content: 'ok', isError: false },
      })
      await expect(followUp).resolves.toEqual({ content: 'ok', isError: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
