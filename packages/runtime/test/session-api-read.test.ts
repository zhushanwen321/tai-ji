/**
 * Session API 读面（AP-4，U2）单测
 *
 * 覆盖 plugin.sessions.readEntries / getCommands / registerEntryInvalidation /
 * unregisterEntryInvalidation 的主线程 handler（customType 服务端过滤投影、
 * sinceEntryId 游标透传、live only 前提 SESSION_NOT_ACTIVE、订阅注册表转调与
 * 拒绝回执、纯查询直连投影收窄、装配缺口 SESSION_READ_NOT_WIRED）与 Worker 侧
 * createSessionApi 代理（readEntries/getCommands RPC 形状、onEntriesInvalidated
 * 注册 → 定向通知派发 → dispose 注销）。
 *
 * 运行命令: cd packages/runtime && npx vitest run test/session-api-read.test.ts
 */

import { describe, it, beforeEach, expect, vi } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'

import {
  registerSessionRpcHandlers,
  createSessionApi,
  SessionEventDispatch,
  SESSION_READ_METHODS,
  SESSION_NOT_ACTIVE,
  SESSION_READ_NOT_WIRED,
} from '../src/services/plugin-service/api/session-api.js'
import type { SessionHandlers, SessionReadDeps } from '../src/services/plugin-service/api/session-api.js'
import { EntryInvalidationDispatch, ENTRY_INVALIDATION_NOTIFY_METHOD } from '../src/services/plugin-service/plugin-entry-invalidation-dispatch.js'
import type { IProcessManager, IPiEngine, PiCommandInfo } from '../src/services/ports/pi-engine.js'

// ── Helper: mock WorkerPort / 响应提取（plugin-api-extended 同模式）──────────

function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

interface LastResponse {
  id?: number
  result?: unknown
  error?: { code?: unknown; message?: string }
}

function lastResponse(port: ReturnType<typeof createMockPort>): LastResponse {
  const last = port.messages[port.messages.length - 1] as { response: LastResponse } | undefined
  return last?.response ?? {}
}

/** dispatch 一条 RPC 并返回响应（含 error.code 断言用的 error 段） */
async function dispatch(
  rpc: PluginRpcServer,
  port: ReturnType<typeof createMockPort>,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<LastResponse> {
  await rpc.dispatch('w1', { jsonrpc: '2.0', id, method, params })
  return lastResponse(port)
}

// ── Helper: 假 pi client + IProcessManager ──────────────────────────────────

interface FakeClientOverrides {
  exited?: boolean
  entries?: unknown[]
  leafId?: string | null
  commands?: PiCommandInfo[]
}

/** 假 IPiEngine：只实现读面消费的 getEntries/getCommands/exited（结构化最小面） */
function createFakeClient(overrides: FakeClientOverrides = {}): IPiEngine {
  return {
    exited: overrides.exited ?? false,
    getEntries: vi.fn(async () => ({
      data: { entries: overrides.entries ?? [], leafId: overrides.leafId ?? null },
    })),
    getCommands: vi.fn(async () => overrides.commands ?? []),
  } as unknown as IPiEngine
}

function createFakePm(clients: Map<string, IPiEngine>): IProcessManager {
  return {
    getClient: (sessionId: string) => clients.get(sessionId),
  } as unknown as IProcessManager
}

const TARGET_CUSTOM_TYPE = 'pi-scheduler:task'

/** 一条目标域 custom entry（形状对齐 pi get_entries 产物的契约字段 + 噪声字段） */
function customEntry(id: string, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    timestamp: `2026-09-19T00:00:0${id.length}Z`,
    type: 'custom',
    customType: TARGET_CUSTOM_TYPE,
    parentId: 'e-parent',
    ...extra,
    data,
  }
}

// ── 主线程 handler ──────────────────────────────────────────────────────────

describe('session read API — registerSessionRpcHandlers（AP-4 读面）', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>
  let clients: Map<string, IPiEngine>
  let fakeClient: IPiEngine
  let dispatchRegistry: EntryInvalidationDispatch
  let registeredHandlers: SessionHandlers

  beforeEach(() => {
    rpc = new PluginRpcServer()
    port = createMockPort()
    rpc.registerWorker('w1', port)
    clients = new Map()
    fakeClient = createFakeClient()
    clients.set('s1', fakeClient)
    dispatchRegistry = new EntryInvalidationDispatch({ sessionExists: (id) => id === 's1' })
    registeredHandlers = {
      listSessions: () => [],
      getSession: () => undefined,
      getActiveSession: () => undefined,
      sendMessage: async () => ({ blocked: false }),
      sessionEvents: new SessionEventDispatch(rpc),
      sessionRead: {
        pm: createFakePm(clients),
        getSessionSummary: (id: string) =>
          id === 's1' ? { sessionFile: '/data/sessions/s1.jsonl' } : undefined,
        entryInvalidation: dispatchRegistry,
      },
    }
    registerSessionRpcHandlers(rpc, registeredHandlers)
  })

  describe('plugin.sessions.readEntries', () => {
    it('按 customType 精确过滤 + 投影五字段形状（type/customType 保留、data 原样、噪声字段剥除）', async () => {
      const taskData = { op: 'toggle', taskId: 'a1b2c3d4', enabled: false }
      fakeClient = createFakeClient({
        entries: [
          { id: 'e-msg', timestamp: 't', type: 'message', data: { text: 'hello' } },
          customEntry('e-task-1', taskData),
          customEntry('e-other', { op: 'x' }, { customType: 'pi-subagent:record' }),
        ],
        leafId: 'e-other',
      })
      clients.set('s1', fakeClient)

      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
        sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
      })

      expect(resp.error).toBeUndefined()
      const result = resp.result as { sessionFile?: string; entries: Array<Record<string, unknown>>; leafEntryId?: string }
      // 只剩目标 customType 条目（message entry 与其他域 custom entry 均被过滤）
      expect(result.entries.length).toBe(1)
      const entry = result.entries[0]
      expect(entry.id).toBe('e-task-1')
      expect(entry.type).toBe('custom')
      expect(entry.customType).toBe(TARGET_CUSTOM_TYPE)
      // data 原样透传（引用相等——域语义插件解，不改写）
      expect(entry.data).toBe(taskData)
      // 投影不含 pi 树结构噪声（parentId 等不出 runtime）
      expect('parentId' in entry).toBe(false)
      // 信封字段：sessionFile（折叠过滤必需）+ leafEntryId（下次 sinceEntryId）
      expect(result.sessionFile).toBe('/data/sessions/s1.jsonl')
      expect(result.leafEntryId).toBe('e-other')
    })

    it('sinceEntryId 透传给 client.getEntries（增量游标）；缺省时不传', async () => {
      await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
        sessionId: 's1', customType: TARGET_CUSTOM_TYPE, sinceEntryId: 'e-cursor-9',
      })
      expect(vi.mocked(fakeClient.getEntries)).toHaveBeenCalledWith('e-cursor-9')

      await dispatch(rpc, port, 2, SESSION_READ_METHODS.readEntries, {
        sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
      })
      expect(vi.mocked(fakeClient.getEntries)).toHaveBeenLastCalledWith(undefined)
    })

    it('无 client → SESSION_NOT_ACTIVE（live only：不调 ensureActive 不 spawn 进程）', async () => {
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
        sessionId: 'missing-session', customType: TARGET_CUSTOM_TYPE,
      })
      expect(resp.error?.code).toBe(SESSION_NOT_ACTIVE)
      expect(resp.error?.message).toContain('missing-session')
    })

    it('client 已 exited → SESSION_NOT_ACTIVE', async () => {
      clients.set('s1', createFakeClient({ exited: true }))
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
        sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
      })
      expect(resp.error?.code).toBe(SESSION_NOT_ACTIVE)
    })

    it('畸形条目丢弃（非对象 / id 或 timestamp 非 string）不进投影', async () => {
      fakeClient = createFakeClient({
        entries: [
          'not-an-object',
          customEntry('e-ok', { op: 'x' }),
          { id: 42, timestamp: 't', type: 'custom', customType: TARGET_CUSTOM_TYPE, data: {} },
          { id: 'e-nots', type: 'custom', customType: TARGET_CUSTOM_TYPE, data: {} },
        ],
      })
      clients.set('s1', fakeClient)
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
        sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
      })
      const result = resp.result as { entries: Array<{ id: string }> }
      expect(result.entries.map(e => e.id)).toEqual(['e-ok'])
    })

    it('leafId 为 null（pi 无叶子）时信封省略 leafEntryId', async () => {
      fakeClient = createFakeClient({ entries: [], leafId: null })
      clients.set('s1', fakeClient)
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
        sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
      })
      const result = resp.result as { leafEntryId?: string }
      expect('leafEntryId' in result).toBe(false)
    })

    it('sessionId 畸形 → INVALID_SESSION_ID（窄校验先例行径）', async () => {
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.readEntries, {
        sessionId: '../etc', customType: TARGET_CUSTOM_TYPE,
      })
      expect(resp.error?.code).toBe('INVALID_SESSION_ID')
    })
  })

  describe('plugin.sessions.getCommands（纯查询直连）', () => {
    it('投影收窄到 {name, description, source}——sourceInfo 等宿主内部元信息不出面', async () => {
      clients.set('s1', createFakeClient({
        commands: [
          { name: 'schedule', description: '定时任务', source: 'extension', sourceInfo: { path: '/ext/scheduler.ts', source: 'extension' } },
          { name: 'compact', source: 'pi' },
        ],
      }))
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.getCommands, { sessionId: 's1' })
      expect(resp.error).toBeUndefined()
      const commands = resp.result as Array<Record<string, unknown>>
      expect(commands).toEqual([
        { name: 'schedule', description: '定时任务', source: 'extension' },
        { name: 'compact', description: undefined, source: 'pi' },
      ])
      // 关键负断言：投影对象上不存在 sourceInfo 键（不是 undefined 而是剥除）
      expect('sourceInfo' in commands[0]).toBe(false)
    })

    it('无 client → SESSION_NOT_ACTIVE', async () => {
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.getCommands, { sessionId: 'missing-session' })
      expect(resp.error?.code).toBe(SESSION_NOT_ACTIVE)
    })
  })

  describe('plugin.sessions.registerEntryInvalidation / unregisterEntryInvalidation', () => {
    it('注册成功：转调注册表（workerId 取 ctx、pluginId/sessionId/customType 入表）+ {registered:true} 回执', async () => {
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.registerEntryInvalidation, {
        pluginId: 'scheduler-manager',
        sessionId: 's1',
        customType: TARGET_CUSTOM_TYPE,
        handlerId: 'entry_invalidate_scheduler-manager_1',
      })
      expect(resp.error).toBeUndefined()
      expect(resp.result).toEqual({ registered: true })
      // 注册表真实收到条目：双键派发命中（u2c 注册表行为核验）
      const deliveries = dispatchRegistry.dispatch('s1', TARGET_CUSTOM_TYPE)
      expect(deliveries).toEqual([{ workerId: 'w1', handlerId: 'entry_invalidate_scheduler-manager_1' }])
    })

    it('sessionId 不在会话列表 → 注册表拒绝并映射 SESSION_NOT_ACTIVE 错误回执（防无界注册表）', async () => {
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.registerEntryInvalidation, {
        pluginId: 'scheduler-manager',
        sessionId: 'ghost-session',
        customType: TARGET_CUSTOM_TYPE,
        handlerId: 'entry_invalidate_scheduler-manager_2',
      })
      expect(resp.error?.code).toBe(SESSION_NOT_ACTIVE)
      expect(resp.error?.message).toContain('ghost-session')
      expect(dispatchRegistry.dispatch('ghost-session', TARGET_CUSTOM_TYPE)).toEqual([])
    })

    it('handlerId 畸形 → INVALID_HANDLER_ID（不进注册表，防毒化投递目标）', async () => {
      const resp = await dispatch(rpc, port, 1, SESSION_READ_METHODS.registerEntryInvalidation, {
        pluginId: 'scheduler-manager',
        sessionId: 's1',
        customType: TARGET_CUSTOM_TYPE,
        handlerId: '../poison',
      })
      expect(resp.error?.code).toBe('INVALID_HANDLER_ID')
      expect(dispatchRegistry.size).toBe(0)
    })

    it('注销转调注册表（幂等，不存在的 handlerId 也回 {unregistered:true}）', async () => {
      await dispatch(rpc, port, 1, SESSION_READ_METHODS.registerEntryInvalidation, {
        pluginId: 'scheduler-manager', sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
        handlerId: 'entry_invalidate_scheduler-manager_3',
      })
      expect(dispatchRegistry.size).toBe(1)
      const resp = await dispatch(rpc, port, 2, SESSION_READ_METHODS.unregisterEntryInvalidation, {
        handlerId: 'entry_invalidate_scheduler-manager_3',
      })
      expect(resp.result).toEqual({ unregistered: true })
      expect(dispatchRegistry.size).toBe(0)
      // 再注销一次（幂等）
      const resp2 = await dispatch(rpc, port, 3, SESSION_READ_METHODS.unregisterEntryInvalidation, {
        handlerId: 'entry_invalidate_scheduler-manager_3',
      })
      expect(resp2.result).toEqual({ unregistered: true })
    })
  })

  describe('sessionRead 缺失（装配缺口显式报错）', () => {
    it('四个读方法各抛 SESSION_READ_NOT_WIRED，不伪装成会话状态错误', async () => {
      const bare: SessionHandlers = {
        listSessions: () => [],
        getSession: () => undefined,
        getActiveSession: () => undefined,
        sendMessage: async () => ({ blocked: false }),
        sessionEvents: new SessionEventDispatch(rpc),
      }
      const bareRpc = new PluginRpcServer()
      const barePort = createMockPort()
      bareRpc.registerWorker('w1', barePort)
      registerSessionRpcHandlers(bareRpc, bare)

      const readResp = await dispatch(bareRpc, barePort, 1, SESSION_READ_METHODS.readEntries, {
        sessionId: 's1', customType: TARGET_CUSTOM_TYPE,
      })
      expect(readResp.error?.code).toBe(SESSION_READ_NOT_WIRED)
      expect(readResp.error?.message).toContain('wiring gap')

      const commandsResp = await dispatch(bareRpc, barePort, 2, SESSION_READ_METHODS.getCommands, { sessionId: 's1' })
      expect(commandsResp.error?.code).toBe(SESSION_READ_NOT_WIRED)

      const registerResp = await dispatch(bareRpc, barePort, 3, SESSION_READ_METHODS.registerEntryInvalidation, {
        pluginId: 'p', sessionId: 's1', customType: 'x', handlerId: 'h1',
      })
      expect(registerResp.error?.code).toBe(SESSION_READ_NOT_WIRED)

      const unregisterResp = await dispatch(bareRpc, barePort, 4, SESSION_READ_METHODS.unregisterEntryInvalidation, {
        handlerId: 'h1',
      })
      expect(unregisterResp.error?.code).toBe(SESSION_READ_NOT_WIRED)
    })
  })
})

// ── Worker 侧 createSessionApi 代理 ─────────────────────────────────────────

interface MockRpcClient {
  requestCalls: Array<{ method: string; params: Record<string, unknown> }>
  requestResults: Map<string, unknown>
  requestFailures: Map<string, unknown>
  onNotificationHandlers: Map<string, (params: unknown) => void>
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  onNotification: (method: string, handler: (params: unknown) => void) => () => void
  notify: (method: string, params: Record<string, unknown>) => void
}

function createMockRpcClient(): MockRpcClient & PluginRpcClient {
  const requestCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const requestResults = new Map<string, unknown>()
  const requestFailures = new Map<string, unknown>()
  const onNotificationHandlers = new Map<string, (params: unknown) => void>()
  return {
    requestCalls,
    requestResults,
    requestFailures,
    onNotificationHandlers,
    request: (method: string, params: Record<string, unknown>) => {
      requestCalls.push({ method, params })
      if (requestFailures.has(method)) return Promise.reject(requestFailures.get(method))
      const result = requestResults.get(method)
      return Promise.resolve(result !== undefined ? result : undefined)
    },
    onNotification: (method: string, handler: (params: unknown) => void) => {
      onNotificationHandlers.set(method, handler)
      return () => { onNotificationHandlers.delete(method) }
    },
    notify: () => {},
  } as unknown as MockRpcClient & PluginRpcClient
}

describe('session read API — createSessionApi（Worker 侧代理）', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
  })

  it('readEntries() 发送 plugin.sessions.readEntries RPC（sessionId/customType/sinceEntryId 形状）', async () => {
    const envelope = { sessionFile: '/data/sessions/s1.jsonl', entries: [], leafEntryId: 'e-leaf' }
    mockClient.requestResults.set(SESSION_READ_METHODS.readEntries, envelope)
    const api = createSessionApi(mockClient, 'test-plugin')
    const result = await api.readEntries('s1', { customType: TARGET_CUSTOM_TYPE, sinceEntryId: 'e-cursor' })
    expect(result).toEqual(envelope)
    const call = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.readEntries)
    expect(call?.params).toEqual({
      pluginId: 'test-plugin', sessionId: 's1',
      customType: TARGET_CUSTOM_TYPE, sinceEntryId: 'e-cursor',
    })
  })

  it('getCommands() 发送 plugin.sessions.getCommands RPC 并回传结果', async () => {
    mockClient.requestResults.set(SESSION_READ_METHODS.getCommands, [
      { name: 'schedule', description: 'x', source: 'extension' },
    ])
    const api = createSessionApi(mockClient, 'test-plugin')
    const result = await api.getCommands('s1')
    expect(result).toEqual([{ name: 'schedule', description: 'x', source: 'extension' }])
    const call = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.getCommands)
    expect(call?.params).toEqual({ pluginId: 'test-plugin', sessionId: 's1' })
  })

  it('onEntriesInvalidated：注册 RPC 携带 (pluginId, sessionId, customType, handlerId)，定向通知派发到 handler', async () => {
    const api = createSessionApi(mockClient, 'test-plugin')
    const received: Array<[string, string]> = []
    const disposable = api.onEntriesInvalidated('s1', TARGET_CUSTOM_TYPE, (sid, ct) => received.push([sid, ct]))

    const call = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.registerEntryInvalidation)
    expect(call).toBeDefined()
    const handlerId = call?.params.handlerId as string
    expect(call?.params.sessionId).toBe('s1')
    expect(call?.params.customType).toBe(TARGET_CUSTOM_TYPE)
    expect(call?.params.pluginId).toBe('test-plugin')

    // 主线程定向通知（ENTRY_INVALIDATION_NOTIFY_METHOD，payload {handlerId, sessionId, customType}）命中
    const notify = mockClient.onNotificationHandlers.get(ENTRY_INVALIDATION_NOTIFY_METHOD)
    expect(notify).toBeDefined()
    notify?.({ handlerId, sessionId: 's1', customType: TARGET_CUSTOM_TYPE })
    expect(received).toEqual([['s1', TARGET_CUSTOM_TYPE]])

    // 未知 handlerId 不派发（Worker 侧 dispatchHandler 命中语义）
    notify?.({ handlerId: 'entry_invalidate_other_99', sessionId: 's1', customType: TARGET_CUSTOM_TYPE })
    expect(received.length).toBe(1)

    disposable.dispose()
    const unregister = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.unregisterEntryInvalidation)
    expect(unregister?.params.handlerId).toBe(handlerId)
  })

  it('onEntriesInvalidated 注册被拒（SESSION_NOT_ACTIVE 回执）时记日志不中断', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockClient.requestFailures.set(SESSION_READ_METHODS.registerEntryInvalidation, new Error('not found'))
      const api = createSessionApi(mockClient, 'test-plugin')
      const disposable = api.onEntriesInvalidated('ghost', TARGET_CUSTOM_TYPE, () => {})
      // 微任务排空后 .catch 分支执行：日志留痕 + dispose 链路不受影响
      await Promise.resolve()
      await Promise.resolve()
      expect(errSpy).toHaveBeenCalledWith('[session-api] registerEntryInvalidation failed:', expect.stringContaining('not found'))
      disposable.dispose()
      const unregister = mockClient.requestCalls.find(c => c.method === SESSION_READ_METHODS.unregisterEntryInvalidation)
      expect(unregister).toBeDefined()
    } finally {
      errSpy.mockRestore()
    }
  })
})
