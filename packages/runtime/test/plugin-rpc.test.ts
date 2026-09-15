import { describe, it, expect, beforeEach, vi } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort, RpcMethodHandler } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'
import type { RpcRequest, RpcResponse } from '../src/services/plugin-service/plugin-types.js'

/** 记录 postMessage 收到的消息 */
function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

describe('PluginRpcServer', () => {
  let rpc: PluginRpcServer

  beforeEach(() => {
    rpc = new PluginRpcServer()
  })

  // ── TC-3-01: registerMethod + dispatch → success response ─────
  it('TC-3-01: registerMethod + dispatch → success response', async () => {
    const handler: RpcMethodHandler = async (params) => {
      return { echo: params.msg }
    }
    rpc.registerMethod('test.echo', handler)

    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'test.echo',
      params: { msg: 'hello' },
    })

    expect(port.messages.length).toBe(1)
    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    expect(wrapper.type).toBe('rpc')
    const resp = wrapper.response
    expect(resp.jsonrpc).toBe('2.0')
    expect(resp.id).toBe(1)
    expect('result' in resp).toBeTruthy()
    expect((resp as { result: unknown }).result).toEqual({ echo: 'hello' })
  })

  // ── TC-3-02: unregistered method → METHOD_NOT_FOUND error ────
  it('TC-3-02: unregistered method → METHOD_NOT_FOUND error', async () => {
    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'nonexistent.method',
      params: {},
    })

    expect(port.messages.length).toBe(1)
    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    expect(wrapper.type).toBe('rpc')
    const resp = wrapper.response
    expect('error' in resp).toBeTruthy()
    expect((resp as { error: { code: number; message: string } }).error.code).toBe(PluginRpcErrorCodes.METHOD_NOT_FOUND)
    expect((resp as { error: { code: number; message: string } }).error.message.includes('nonexistent.method')).toBeTruthy()
  })

  // ── TC-3-03: handler throws → INTERNAL_ERROR response ─────────
  it('TC-3-03: handler throws → INTERNAL_ERROR response', async () => {
    const handler: RpcMethodHandler = async () => {
      throw new Error('boom')
    }
    rpc.registerMethod('test.fail', handler)

    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'test.fail',
      params: {},
    })

    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    expect(wrapper.type).toBe('rpc')
    const resp = wrapper.response
    expect('error' in resp).toBeTruthy()
    // 无自定义 code → 默认 INTERNAL_ERROR
    expect((resp as { error: { code: number; message: string } }).error.code).toBe(PluginRpcErrorCodes.INTERNAL_ERROR)
    expect((resp as { error: { code: number; message: string } }).error.message).toBe('boom')
  })

  // ── TC-3-04: notify → sends notification to worker ────────────
  it('TC-3-04: notify → sends notification to specific worker', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    rpc.registerWorker('w1', port1)
    rpc.registerWorker('w2', port2)

    rpc.notify('w1', 'test.event', { data: 42 })

    expect(port1.messages.length).toBe(1)
    expect(port2.messages.length).toBe(0)

    const msg = port1.messages[0] as { type: string; notification: { jsonrpc: string; method: string; params: Record<string, unknown> } }
    expect(msg.type).toBe('rpc')
    expect(msg.notification.jsonrpc).toBe('2.0')
    expect(msg.notification.method).toBe('test.event')
    expect(msg.notification.params).toEqual({ data: 42 })
  })

  // ── TC-3-05: broadcast → sends to all workers ─────────────────
  it('TC-3-05: broadcast → sends to all registered workers', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    const port3 = createMockPort()
    rpc.registerWorker('w1', port1)
    rpc.registerWorker('w2', port2)
    rpc.registerWorker('w3', port3)

    rpc.broadcast('system.update', { version: '2.0' })

    expect(port1.messages.length).toBe(1)
    expect(port2.messages.length).toBe(1)
    expect(port3.messages.length).toBe(1)

    for (const port of [port1, port2, port3]) {
      const msg = port.messages[0] as { type: string; notification: { method: string } }
      expect(msg.type).toBe('rpc')
      expect(msg.notification.method).toBe('system.update')
    }
  })

  // ── Fix-4: notification 被权限拒绝 → 不回包但必须落日志 ──────────
  it('Fix-4: permission-denied notification does not reply but logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handler: RpcMethodHandler = async () => ({ ok: true })
      rpc.registerMethod('plugin.secret.read', handler)
      rpc.setPermissionChecker(() => false) // 全拒

      const port = createMockPort()
      rpc.registerWorker('w1', port)

      // notification（无 id）：不回包。dispatch 签名是 RpcRequest（id 必填），但运行时
      // 按 id 判 notification——生产路径经 dispatchHostRpcMessage 的同构 cast 进入，
      // 此处 cast 模拟 Worker 扁平 notification 的真实线上输入形状
      const notification = {
        jsonrpc: '2.0',
        method: 'plugin.secret.read',
        params: { pluginId: 'p-denied' },
      }
      await rpc.dispatch('w1', notification as unknown as RpcRequest)

      expect(port.messages.length).toBe(0) // JSON-RPC 语义：notification 不回包
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0][0])).toContain('plugin.secret.read')
      expect(String(warnSpy.mock.calls[0][0])).toContain('p-denied')

      // 对照：request（带 id）被拒 → 回 PERMISSION_DENIED 错误响应
      await rpc.dispatch('w1', {
        jsonrpc: '2.0',
        id: 9,
        method: 'plugin.secret.read',
        params: { pluginId: 'p-denied' },
      })
      const wrapper = port.messages[0] as { type: string; response: RpcResponse }
      expect(wrapper.type).toBe('rpc')
      expect((wrapper.response as { error: { code: number } }).error.code).toBe(PluginRpcErrorCodes.PERMISSION_DENIED)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
