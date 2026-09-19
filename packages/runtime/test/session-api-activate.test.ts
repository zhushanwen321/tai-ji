/**
 * 会话激活订阅族单测（plugin-header-action-modal-points AP-4，u5b 六点扩表）
 *
 * 覆盖：
 * - registerActivate/unregisterActivate RPC handler → SessionEventDispatch 'activate' 表
 * - didActivate 定向投递（payload {handlerId, session}；create/destroy/activate 三表按
 *   handlerId 隔离，投递只命中 activate 表）
 * - clearForPlugin 覆盖 activateHandlers（crash/disable/uninstall 三路共用同一条清理
 *   代码路径——u5a/u2c 已把三路调用点接到 SessionEventDispatch.clearForPlugin，本单测
 *   锁「清理后不再投递」的语义）+ clearAll 同覆盖
 * - Worker 侧 createSessionApi.onDidActivateSession：注册 RPC 携带 (pluginId, handlerId)、
 *   didActivate 通知派发到 handler、dispose 发送 unregisterActivate
 *
 * 运行：cd packages/runtime && npx vitest run test/session-api-activate.test.ts
 */
import { describe, it, beforeEach, expect, vi } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import {
  registerSessionRpcHandlers,
  createSessionApi,
  SessionEventDispatch,
  SESSION_ACTIVATE_METHODS,
} from '../src/services/plugin-service/api/session-api.js'
import type { SessionHandlers } from '../src/services/plugin-service/api/session-api.js'
import type { SessionInfo } from '../src/services/plugin-service/plugin-types.js'

function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

function lastResponse(port: ReturnType<typeof createMockPort>): { id?: number; result?: unknown; error?: { code?: unknown; message?: string } } {
  const last = port.messages[port.messages.length - 1] as { response: { id?: number; result?: unknown; error?: { code?: unknown; message?: string } } } | undefined
  return last?.response ?? {}
}

async function dispatch(
  rpc: PluginRpcServer,
  port: ReturnType<typeof createMockPort>,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<{ id?: number; result?: Record<string, unknown>; error?: { code?: unknown; message?: string } }> {
  await rpc.dispatch('w1', { jsonrpc: '2.0', id, method, params })
  return lastResponse(port) as never
}

const SESSION: SessionInfo = { id: 's1', label: 'L', cwd: '/tmp', status: 'active', createdAt: 0, lastActiveAt: 0 }

describe('activate 订阅族（主线程 handler + SessionEventDispatch 六点扩表）', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>
  let dispatchTable: SessionEventDispatch

  beforeEach(() => {
    rpc = new PluginRpcServer()
    port = createMockPort()
    rpc.registerWorker('w1', port)
    dispatchTable = new SessionEventDispatch(rpc)
    const handlers: SessionHandlers = {
      listSessions: () => [],
      getSession: () => undefined,
      getActiveSession: () => undefined,
      sendMessage: async () => ({ blocked: false }),
      sessionEvents: dispatchTable,
    }
    registerSessionRpcHandlers(rpc, handlers)
  })

  it('registerActivate → {registered:true}，didActivate 定向投递到该 handlerId', async () => {
    const resp = await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, {
      pluginId: 'scheduler-manager', handlerId: 'session_activate_scheduler-manager_1',
    })
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ registered: true })

    dispatchTable.didActivate(SESSION)

    const sent = port.messages.filter(m => (m as { notification?: { method: string } }).notification)
    const last = sent[sent.length - 1] as { notification: { method: string; params: { handlerId: string; session: SessionInfo } } }
    expect(last.notification.method).toBe('plugin.sessions.didActivate')
    expect(last.notification.params).toEqual({ handlerId: 'session_activate_scheduler-manager_1', session: SESSION })
    expect(dispatchTable.size).toBe(1)
  })

  it('三表按 handlerId 隔离：activate 投递不惊动 create/destroy 订阅', async () => {
    await dispatch(rpc, port, 1, 'plugin.sessions.registerCreate', { pluginId: 'p1', handlerId: 'h_create' })
    await dispatch(rpc, port, 2, 'plugin.sessions.registerDestroy', { pluginId: 'p1', handlerId: 'h_destroy' })
    await dispatch(rpc, port, 3, SESSION_ACTIVATE_METHODS.register, { pluginId: 'p1', handlerId: 'h_activate' })
    expect(dispatchTable.size).toBe(3)

    port.messages.length = 0
    dispatchTable.didActivate(SESSION)

    const notified = port.messages.map(m => (m as { notification: { params: { handlerId: string } } }).notification.params.handlerId)
    expect(notified).toEqual(['h_activate'])
  })

  it('unregisterActivate → 注销后不再投递（幂等）', async () => {
    await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, { pluginId: 'p1', handlerId: 'h1' })
    await dispatch(rpc, port, 2, SESSION_ACTIVATE_METHODS.unregister, { handlerId: 'h1' })
    expect(dispatchTable.size).toBe(0)

    port.messages.length = 0
    dispatchTable.didActivate(SESSION)
    expect(port.messages).toHaveLength(0)

    // 再注销一次（幂等）
    const resp = await dispatch(rpc, port, 3, SESSION_ACTIVATE_METHODS.unregister, { handlerId: 'h1' })
    expect(resp.result).toEqual({ unregistered: true })
  })

  it('handlerId 畸形 → INVALID_HANDLER_ID（防毒化投递目标，与 create/destroy 同守卫）', async () => {
    const resp = await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, { pluginId: 'p1', handlerId: '../poison' })
    expect(resp.error?.code).toBe('INVALID_HANDLER_ID')
    expect(dispatchTable.size).toBe(0)
  })

  it('clearForPlugin 覆盖 activate 表（crash/disable/uninstall 三路共用）：清理后不再投递，他插件不受扰', async () => {
    await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, { pluginId: 'gone', handlerId: 'h_gone' })
    await dispatch(rpc, port, 2, SESSION_ACTIVATE_METHODS.register, { pluginId: 'stay', handlerId: 'h_stay' })

    dispatchTable.clearForPlugin('gone')
    expect(dispatchTable.size).toBe(1)

    port.messages.length = 0
    dispatchTable.didActivate(SESSION)
    const notified = port.messages.map(m => (m as { notification: { params: { handlerId: string } } }).notification.params.handlerId)
    expect(notified).toEqual(['h_stay'])
  })

  it('clearAll 覆盖 activate 表（runtime 关停）', async () => {
    await dispatch(rpc, port, 1, SESSION_ACTIVATE_METHODS.register, { pluginId: 'p1', handlerId: 'h1' })
    dispatchTable.clearAll()
    expect(dispatchTable.size).toBe(0)
    port.messages.length = 0
    dispatchTable.didActivate(SESSION)
    expect(port.messages).toHaveLength(0)
  })
})

// ── Worker 侧 createSessionApi.onDidActivateSession ─────────────────────────

interface MockRpcClient {
  requestCalls: Array<{ method: string; params: Record<string, unknown> }>
  requestFailures: Map<string, unknown>
  onNotificationHandlers: Map<string, (params: unknown) => void>
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  onNotification: (method: string, handler: (params: unknown) => void) => () => void
  notify: (method: string, params: Record<string, unknown>) => void
}

function createMockRpcClient(): MockRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const requestFailures = new Map<string, unknown>()
  const onNotificationHandlers = new Map<string, (params: unknown) => void>()
  return {
    requestCalls,
    requestFailures,
    onNotificationHandlers,
    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      if (requestFailures.has(method)) return Promise.reject(requestFailures.get(method))
      return Promise.resolve(undefined)
    },
    onNotification: (method: string, handler: (params: unknown) => void) => {
      onNotificationHandlers.set(method, handler)
      return () => { onNotificationHandlers.delete(method) }
    },
    notify: () => {},
  } as unknown as MockRpcClient
}

describe('createSessionApi.onDidActivateSession（Worker 侧代理）', () => {
  it('注册 RPC 携带 (pluginId, handlerId)，didActivate 通知派发到 handler，dispose 发 unregister', async () => {
    const mockClient = createMockRpcClient()
    const api = createSessionApi(mockClient as never, 'test-plugin')
    const received: SessionInfo[] = []
    const disposable = api.onDidActivateSession(session => received.push(session))

    const call = mockClient.requestCalls.find(c => c.method === SESSION_ACTIVATE_METHODS.register)
    expect(call).toBeDefined()
    expect(call?.params.pluginId).toBe('test-plugin')
    const handlerId = call?.params.handlerId as string
    expect(handlerId).toMatch(/^session_activate_test-plugin_\d+$/)

    const notify = mockClient.onNotificationHandlers.get('plugin.sessions.didActivate')
    expect(notify).toBeDefined()
    notify?.({ handlerId, session: SESSION })
    notify?.({ handlerId: 'session_activate_other_99', session: SESSION })
    expect(received).toEqual([SESSION])

    disposable.dispose()
    const unregister = mockClient.requestCalls.find(c => c.method === SESSION_ACTIVATE_METHODS.unregister)
    expect(unregister?.params.handlerId).toBe(handlerId)
  })

  it('注册 RPC 被拒时记日志不中断（onDidCreateSession 同款处置）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const mockClient = createMockRpcClient()
      mockClient.requestFailures.set(SESSION_ACTIVATE_METHODS.register, new Error('not wired'))
      const api = createSessionApi(mockClient as never, 'test-plugin')
      const disposable = api.onDidActivateSession(() => {})
      await Promise.resolve()
      await Promise.resolve()
      expect(errSpy).toHaveBeenCalledWith('[session-api] registerActivate failed:', expect.stringContaining('not wired'))
      disposable.dispose()
    } finally {
      errSpy.mockRestore()
    }
  })
})
