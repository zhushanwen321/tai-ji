/**
 * Tool API 测试
 *
 * 验证 registerToolRpcHandlers 的主线程侧 RPC handler：
 * - plugin.tools.register 注册工具 → 返回 toolKey
 * - plugin.tools.register name 重名 → 抛出错误
 * - plugin.tools.unregister 已注册工具 → 成功删除（复合键归属隔离，D7）
 * - plugin.tools.unregister 不存在工具 → 静默成功
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { registerToolRpcHandlers } from '../src/services/plugin-service/tool-api.js'
import type { ToolEntry } from '../src/services/plugin-service/plugin-types.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'
import type { RpcResponse } from '../src/services/plugin-service/plugin-types.js'

/** 创建 mock WorkerPort，记录所有 postMessage 消息 */
function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

/** 从 mock port 的消息列表中提取最后一个 RPC 响应 */
function extractLastResponse(port: ReturnType<typeof createMockPort>): RpcResponse & { error?: { code: number; message: string } } {
  const last = port.messages[port.messages.length - 1] as { response: RpcResponse }
  return last.response as RpcResponse & { error?: { code: number; message: string } }
}

describe('Tool API — registerToolRpcHandlers', () => {
  let rpc: PluginRpcServer
  let toolRegistry: Map<string, ToolEntry>
  let syncCalls: number
  let port: ReturnType<typeof createMockPort>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    toolRegistry = new Map()
    syncCalls = 0

    registerToolRpcHandlers(rpc, {
      toolRegistry,
      syncToolsToBridge: async () => {
        syncCalls++
      },
    })

    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  // ── 注册成功 ──────────────────────────────────────────────────

  it('register tool → returns toolKey and stores in registry', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.tools.register',
      params: {
        pluginId: 'my-plugin',
        name: 'my-tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
      },
    })

    const resp = extractLastResponse(port)
    expect(resp.id).toBe(1)
    expect('result' in resp).toBeTruthy()
    expect((resp as { result: unknown }).result).toBe('my-plugin:my-tool')

    // 验证注册表
    expect(toolRegistry.size).toBe(1)
    const entry = toolRegistry.get('my-plugin:my-tool')!
    expect(entry).toBeTruthy()
    expect(entry.pluginId).toBe('my-plugin')
    expect(entry.schema.name).toBe('my-tool')
    expect(entry.schema.description).toBe('A test tool')

    // 验证 sync 被调用
    expect(syncCalls).toBe(1)
  })

  // ── 重复注册 ──────────────────────────────────────────────────

  it('register duplicate tool name → throws TOOL_NAME_CONFLICT error', async () => {
    // 先注册一次
    toolRegistry.set('my-plugin:my-tool', {
      pluginId: 'my-plugin',
      handlerId: 'my-plugin:my-tool',
      schema: { name: 'my-tool', description: '', parameters: {} },
    })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'plugin.tools.register',
      params: {
        pluginId: 'my-plugin',
        name: 'my-tool',
        description: 'Duplicate',
        parameters: {},
      },
    })

    const resp = extractLastResponse(port)
    expect(resp.id).toBe(2)
    expect('error' in resp).toBeTruthy()
    expect(resp.error!.message.includes('already registered')).toBeTruthy()
    // 注册表大小不变
    expect(toolRegistry.size).toBe(1)
    // sync 不应被调用
    expect(syncCalls).toBe(0)
  })

  // ── 注销已注册工具 ────────────────────────────────────────────

  it('unregister existing tool → deletes from registry and calls sync', async () => {
    // 预先注册
    toolRegistry.set('my-plugin:my-tool', {
      pluginId: 'my-plugin',
      handlerId: 'my-plugin:my-tool',
      schema: { name: 'my-tool', description: '', parameters: {} },
    })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'plugin.tools.unregister',
      params: { pluginId: 'my-plugin', toolKey: 'my-plugin:my-tool' },
    })

    const resp = extractLastResponse(port)
    expect(resp.id).toBe(3)
    expect('result' in resp).toBeTruthy()
    // unregister 不返回特定值，但应成功（无 error）
    expect(toolRegistry.size).toBe(0)
    expect(syncCalls).toBe(1)
  })

  // ── 注销不存在工具 ────────────────────────────────────────────

  it('unregister non-existent tool → succeeds silently', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 4,
      method: 'plugin.tools.unregister',
      params: { pluginId: 'nonexistent', toolKey: 'nonexistent:tool' },
    })

    const resp = extractLastResponse(port)
    expect(resp.id).toBe(4)
    expect('result' in resp).toBeTruthy()
    // sync 不被调用（没有删除操作）
    expect(syncCalls).toBe(0)
  })

  // ── D7 归属隔离（MF-1）─────────────────────────────────

  it('unregister requires pluginId in params (缺省 → INVALID_PLUGIN_ID，他人工具不被删)', async () => {
    // D7 归属校验：pluginId 必填（fail-closed）——Worker 代理 createToolApi 恒携带，
    // 缺省只可能是绕过 SDK 的裸 RPC 调用，拒绝且不删除任何注册。
    toolRegistry.set('other:tool', {
      pluginId: 'other',
      handlerId: 'other:tool',
      schema: { name: 'tool', description: '', parameters: {} },
    })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 5,
      method: 'plugin.tools.unregister',
      params: { toolKey: 'other:tool' },
    })

    const resp = extractLastResponse(port)
    expect('error' in resp).toBeTruthy()
    expect(String(resp.error!.code)).toBe('INVALID_PLUGIN_ID')
    expect(toolRegistry.size).toBe(1)
  })

  it('unregister 跨插件 toolKey（B 传 A:xxx）→ no-op，A 的注册不受影响', async () => {
    toolRegistry.set('A:xxx', {
      pluginId: 'A',
      handlerId: 'A:xxx',
      schema: { name: 'xxx', description: '', parameters: {} },
    })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 6,
      method: 'plugin.tools.unregister',
      params: { pluginId: 'B', toolKey: 'A:xxx' },
    })

    const resp = extractLastResponse(port)
    expect('result' in resp).toBeTruthy()
    expect(toolRegistry.has('A:xxx')).toBe(true)
    expect(syncCalls).toBe(0)
  })
})
