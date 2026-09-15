/**
 * Worker 端 tool execute / hook invoke RPC handler 测试
 *
 * 经真实 plugin-bootstrap.handleMessage 驱动（type:'rpc' request 分支 →
 * handleIncomingRequest）：此前该文件复制 handleIncomingRequest + toolHandlers 骨架
 * 验证（W01 时 plugin-bootstrap 顶层副作用曾阻断 vitest import），现已实测可直接
 * import（parentPort 为 null 时顶层副作用安全跳过），改为真实函数驱动，消除
 * 复制骨架与源码的漂移面（W01 审查遗留 P-3）。
 *
 * post 通道经 setPostMessage 注入收集器（模块级 post 与传输解耦的设计缝）。
 * 端到端全链路（真实 PluginRpcServer + MessageChannel）见 plugin-hooks-e2e.test.ts。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolExecuteHandler, HostToWorkerMessage } from '../src/services/plugin-service/plugin-types.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'
import { createHookApi } from '../src/services/plugin-service/hook-api.js'
import {
  handleMessage,
  setPostMessage,
  registerToolHandler,
  unregisterToolHandler,
} from '../src/services/plugin-service/plugin-bootstrap.js'
import type { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'

interface RpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

const postedMessages: Array<{ type: string; response: RpcResponse }> = []
const registeredToolKeys: string[] = []

beforeEach(() => {
  postedMessages.length = 0
  setPostMessage((msg: unknown) => {
    const m = msg as { type: string; response?: RpcResponse }
    if (m.type === 'rpc' && m.response) postedMessages.push({ type: 'rpc', response: m.response })
  })
})

/** 注册 tool handler 并登记 key 供清理 */
function registerToolHandlerTracked(toolKey: string, handler: ToolExecuteHandler): void {
  registerToolHandler(toolKey, handler)
  registeredToolKeys.push(toolKey)
}

afterEach(() => {
  for (const key of registeredToolKeys.splice(0)) {
    unregisterToolHandler(key)
  }
})

/** 经真实 handleMessage 驱动 rpc request 分支（handleIncomingRequest 在其内 fire-and-forget，flush 后返回） */
async function dispatchRpcRequest(request: {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: unknown
}): Promise<void> {
  await handleMessage({ type: 'rpc', request } as HostToWorkerMessage)
  await new Promise(resolve => setImmediate(resolve))
}

/** 最小 mock PluginRpcClient（createHookApi 注册 hook 时需要） */
function createMockRpcClient(): PluginRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      return Promise.resolve(undefined)
    },
    onNotification: () => () => {},
    notify: () => {},
    attach: () => {},
    requestCalls,
  } as unknown as PluginRpcClient
}

/** 经 createHookApi 注册一个 onBeforeSendMessage 拦截器，返回其 handlerId */
async function registerTestInterceptor(
  handler: (ctx: unknown) => Promise<{ proceed: boolean; reason?: string; modifiedData?: unknown }>,
): Promise<string> {
  const mockClient = createMockRpcClient()
  const hookApi = createHookApi(mockClient, 'bootstrap-test-plugin')
  await hookApi.onBeforeSendMessage(handler)
  const registerCall = (mockClient as unknown as { requestCalls: Array<{ method: string; params: Record<string, unknown> }> })
    .requestCalls.find(c => c.method === 'plugin.hooks.register')
  return registerCall!.params.handlerId as string
}

describe('plugin-bootstrap tool execute RPC handler', () => {
  it('executes registered handler and returns result', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockResolvedValue({ content: 'ok' })
    registerToolHandlerTracked('p:t', handler)

    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 42,
      method: 'plugin.tool.execute',
      params: { pluginId: 'p', toolName: 't', arguments: { x: 1 } },
    })

    expect(handler).toHaveBeenCalledWith({
      arguments: { x: 1 },
      sessionId: undefined,
      toolCallId: undefined,
    })
    expect(postedMessages).toEqual([
      { type: 'rpc', response: { jsonrpc: '2.0', id: 42, result: { content: 'ok' } } },
    ])
  })

  it('returns error when handler not found', async () => {
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 43,
      method: 'plugin.tool.execute',
      params: { pluginId: 'x', toolName: 'missing', arguments: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 43,
          error: {
            code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
            message: 'Tool handler not found: x:missing',
          },
        },
      },
    ])
  })

  it('returns error when handler throws', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockRejectedValue(new Error('boom'))
    registerToolHandlerTracked('e:f', handler)

    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 44,
      method: 'plugin.tool.execute',
      params: { pluginId: 'e', toolName: 'f', arguments: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 44,
          error: {
            code: PluginRpcErrorCodes.INTERNAL_ERROR,
            message: 'Tool execution error: boom',
          },
        },
      },
    ])
  })

  it('returns error for unknown method', async () => {
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 45,
      method: 'unknown.method',
      params: {},
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 45,
          error: {
            code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
            message: 'Unknown method: unknown.method',
          },
        },
      },
    ])
  })
})

describe('plugin-bootstrap plugin.hooks.invoke request branch (D2-1)', () => {
  it('responds with InterceptorResult when handler blocks', async () => {
    const handlerId = await registerTestInterceptor(async () => ({
      proceed: false,
      reason: 'API key detected',
    }))

    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 51,
      method: 'plugin.hooks.invoke',
      params: { handlerId, hookType: 'onBeforeSendMessage', context: { data: 'x' } },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 51,
          result: { proceed: false, reason: 'API key detected' },
        },
      },
    ])
  })

  it('responds with modifiedData when handler transforms', async () => {
    const handlerId = await registerTestInterceptor(async () => ({
      proceed: true,
      modifiedData: { content: 'IMPORTANT' },
    }))

    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 52,
      method: 'plugin.hooks.invoke',
      params: { handlerId, hookType: 'onBeforeSendMessage', context: { data: { content: '!important' } } },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 52,
          result: { proceed: true, modifiedData: { content: 'IMPORTANT' } },
        },
      },
    ])
  })

  it('responds with {proceed:true} when handler throws (异常放行)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const handlerId = await registerTestInterceptor(async () => {
        throw new Error('handler boom')
      })

      await dispatchRpcRequest({
        jsonrpc: '2.0',
        id: 53,
        method: 'plugin.hooks.invoke',
        params: { handlerId, hookType: 'onBeforeSendMessage', context: {} },
      })

      expect(postedMessages).toEqual([
        {
          type: 'rpc',
          response: {
            jsonrpc: '2.0',
            id: 53,
            result: { proceed: true },
          },
        },
      ])
      // 异常放行分支记 Worker 侧日志（对齐源码行为，P-3 消除漂移）
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('responds with {proceed:true} for unknown handlerId', async () => {
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 54,
      method: 'plugin.hooks.invoke',
      params: { handlerId: 'hook_missing_0', hookType: 'onBeforeSendMessage', context: {} },
    })

    expect(postedMessages).toEqual([
      {
        type: 'rpc',
        response: {
          jsonrpc: '2.0',
          id: 54,
          result: { proceed: true },
        },
      },
    ])
  })

  it('D2-2 observe notification: plugin.hooks.invoke notification executes handler without response', async () => {
    // observe 快捷路径：无 id 通知 → handler 执行 → 不产生任何响应消息（fire-and-forget）
    const collected: Array<{ eventName: string; data: unknown }> = []
    const mockClient = createMockRpcClient()
    const hookApi = createHookApi(mockClient, 'observe-plugin')
    await hookApi.onPiEvent('agent_start', async (eventName, data) => {
      collected.push({ eventName, data })
    })
    const registerCall = (mockClient as unknown as { requestCalls: Array<{ method: string; params: Record<string, unknown> }> })
      .requestCalls.find(c => c.method === 'plugin.hooks.register')!
    const handlerId = registerCall.params.handlerId as string

    await handleMessage({
      type: 'rpc',
      notification: {
        jsonrpc: '2.0',
        method: 'plugin.hooks.invoke',
        params: { handlerId, hookType: 'onPiEvent', context: { eventName: 'agent_start', data: { sessionId: 's1' } } },
      },
    } as HostToWorkerMessage)
    // executeHookRequest 在 notification 分支是 fire-and-forget 调用，flush 微任务
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(collected).toEqual([{ eventName: 'agent_start', data: { sessionId: 's1' } }])
    // 关键断言：通知不产生响应（postedMessages 为空——没有 postRpcResponse 调用）
    expect(postedMessages).toEqual([])
  })
})

// ── Fix-7: 'deactivate' 分支清理本地 tool handler（与主线程清 toolRegistry 对偶） ──

describe('plugin-bootstrap deactivate clears local tool handlers (Fix-7)', () => {
  it("deactivate removes the plugin's tool handlers; other plugins' handlers survive", async () => {
    const handlerP1: ToolExecuteHandler = vi.fn().mockResolvedValue({ content: 'p1' })
    const handlerP2: ToolExecuteHandler = vi.fn().mockResolvedValue({ content: 'p2' })
    registerToolHandlerTracked('p1:toolA', handlerP1)
    registerToolHandlerTracked('p2:toolB', handlerP2)

    // 'deactivate' 分支（无 loadedModule 时 mod?.deactivate 跳过，仍执行清理 + 回 deactivated）
    await handleMessage({ type: 'deactivate', pluginId: 'p1' } as HostToWorkerMessage)
    await new Promise(resolve => setImmediate(resolve))

    // p1 的 handler 摘除：tool.execute 落 METHOD_NOT_FOUND（迟到的工具调用不可达）
    postedMessages.length = 0
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 51,
      method: 'plugin.tool.execute',
      params: { pluginId: 'p1', toolName: 'toolA', arguments: {} },
    })
    expect(postedMessages).toEqual([{
      type: 'rpc',
      response: {
        jsonrpc: '2.0',
        id: 51,
        error: {
          code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
          message: 'Tool handler not found: p1:toolA',
        },
      },
    }])
    expect(handlerP1).not.toHaveBeenCalled()

    // 其他插件的 handler 不受影响
    postedMessages.length = 0
    await dispatchRpcRequest({
      jsonrpc: '2.0',
      id: 52,
      method: 'plugin.tool.execute',
      params: { pluginId: 'p2', toolName: 'toolB', arguments: {} },
    })
    expect(postedMessages).toEqual([{
      type: 'rpc',
      response: { jsonrpc: '2.0', id: 52, result: { content: 'p2' } },
    }])
  })
})

describe('plugin-bootstrap activate lifecycle branch (U09 重构前覆盖缺口补测)', () => {
  it("activate for a module that was never loaded → posts {type:'error', error:'Module not loaded'}", async () => {
    const errorPosts: Array<{ type: string; pluginId?: string; error?: string }> = []
    // 覆盖 beforeEach 注入的 rpc 收集器：本用例只关心 error 消息；
    // 下个用例的 beforeEach 会重新注入 rpc 收集器，无跨用例污染
    setPostMessage((msg: unknown) => {
      const m = msg as { type: string; pluginId?: string; error?: string }
      if (m.type === 'error') errorPosts.push(m)
    })

    await handleMessage({
      type: 'activate',
      pluginId: 'never-loaded-plugin',
      pluginDir: '/tmp/never-loaded-plugin',
      event: { type: 'onStartupFinished' },
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(errorPosts).toEqual([
      { type: 'error', pluginId: 'never-loaded-plugin', error: 'Module not loaded' },
    ])
  })
})
