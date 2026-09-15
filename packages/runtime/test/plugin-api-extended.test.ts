/**
 * Extended API 测试
 *
 * 验证 6 个 API 模块的 RPC handler（主线程侧）和 Worker 侧代理：
 *
 * - session-api：plugin.sessions.list / get / getActive / sendMessage
 * - config-api：plugin.config.get / getAll / set
 * - session-data-api：plugin.sessionData.get / set / delete / keys
 * - ui-api：plugin.ui.showSelect / showConfirm / showInput / notify / updateStatusBarItem
 * - agent-api：plugin.agent.setModel / getModel / getThinkingLevel / setThinkingLevel / getActiveTools
 * - workspace-api：plugin.workspace.rootPath / name / findFiles
 */

import { describe, it, beforeEach, expect, vi } from 'vitest'
import assert from 'node:assert/strict'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'

import { registerSessionRpcHandlers, createSessionApi, SessionEventDispatch } from '../src/services/plugin-service/api/session-api.js'
import type { SessionHandlers } from '../src/services/plugin-service/api/session-api.js'
import { registerConfigRpcHandlers, createConfigApi } from '../src/services/plugin-service/api/config-api.js'
import type { ConfigHandlers } from '../src/services/plugin-service/api/config-api.js'
import { registerSessionDataRpcHandlers, createSessionDataApi } from '../src/services/plugin-service/api/session-data-api.js'
import type { SessionDataHandlers } from '../src/services/plugin-service/api/session-data-api.js'
import { SessionDataStore } from '../src/services/plugin-service/session-data-store.js'
import { registerUiRpcHandlers, createUiApi } from '../src/services/plugin-service/api/ui-api.js'
import type { UiHandlers } from '../src/services/plugin-service/api/ui-api.js'
import { registerAgentRpcHandlers, createAgentApi } from '../src/services/plugin-service/api/agent-api.js'
import type { AgentHandlers } from '../src/services/plugin-service/api/agent-api.js'
import { registerWorkspaceRpcHandlers, createWorkspaceApi } from '../src/services/plugin-service/api/workspace-api.js'
import type { WorkspaceHandlers } from '../src/services/plugin-service/api/workspace-api.js'

import type { SessionInfo, RpcResponse } from '../src/services/plugin-service/plugin-types.js'

// ── Helper: mock WorkerPort ────────────────────────────────────────

function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

function extractLastResponse(port: ReturnType<typeof createMockPort>): any {
  if (port.messages.length === 0) return { jsonrpc: '2.0', id: 0, result: undefined }
  const last = port.messages[port.messages.length - 1] as { response: RpcResponse }
  return last.response as any
}

// ── Helper: mock PluginRpcClient ───────────────────────────────────

interface MockRpcClient {
  requestCalls: Array<{ method: string; params: Record<string, unknown> }>
  requestResults: Map<string, unknown>
  onNotificationHandlers: Map<string, (params: unknown) => void>
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
      onNotificationHandlers.set(method, handler)
      return () => { onNotificationHandlers.delete(method) }
    },
    notify: (_method: string, _params: Record<string, unknown>) => {
      // not needed for tests
    },
  } as unknown as MockRpcClient & PluginRpcClient
}

// ══════════════════════════════════════════════════════════════════════
// Session API
// ══════════════════════════════════════════════════════════════════════

describe('Session API — registerSessionRpcHandlers', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>
  let mockSessions: SessionInfo[]

  beforeEach(() => {
    rpc = new PluginRpcServer()
    mockSessions = [
      { id: 's1', label: 'Session 1', cwd: '/tmp', status: 'active', createdAt: 100, lastActiveAt: 200 },
      { id: 's2', label: 'Session 2', cwd: '/tmp', status: 'idle', createdAt: 300, lastActiveAt: 400 },
    ]

    registerSessionRpcHandlers(rpc, {
      listSessions: () => mockSessions,
      getSession: (id: string) => mockSessions.find(s => s.id === id),
      getActiveSession: () => mockSessions.find(s => s.status === 'active'),
      sendMessage: async (_sessionId: string | undefined, _role: string, _content: string) => {},
      // S3-W2：session 事件注册表（本测试不触事件投递，空表即可）
      sessionEvents: new SessionEventDispatch(rpc),
    })

    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  it('plugin.sessions.list → returns all sessions', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.sessions.list', params: {} })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.id, 1)
    assert.ok('result' in resp)
    const sessions = resp.result as SessionInfo[]
    assert.strictEqual(sessions.length, 2)
    assert.strictEqual(sessions[0].id, 's1')
    assert.strictEqual(sessions[1].id, 's2')
  })

  it('plugin.sessions.get → returns session by id', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.sessions.get', params: { sessionId: 's1' } })
    const resp = extractLastResponse(port)
    const session = resp.result as SessionInfo | undefined
    assert.ok(session)
    assert.strictEqual(session.id, 's1')
    assert.strictEqual(session.label, 'Session 1')
  })

  it('plugin.sessions.get → returns undefined for unknown id', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 3, method: 'plugin.sessions.get', params: { sessionId: 'nonexistent' } })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, undefined)
  })

  it('plugin.sessions.getActive → returns active session', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 4, method: 'plugin.sessions.getActive', params: {} })
    const resp = extractLastResponse(port)
    const session = resp.result as SessionInfo | undefined
    assert.ok(session)
    assert.strictEqual(session.id, 's1')
    assert.strictEqual(session.status, 'active')
  })

  it('plugin.sessions.getActive → undefined when no active session', async () => {
    mockSessions = [
      { id: 's2', label: 'Session 2', cwd: '/tmp', status: 'idle', createdAt: 300, lastActiveAt: 400 },
    ]
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 5, method: 'plugin.sessions.getActive', params: {} })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, undefined)
  })

  it('plugin.sessions.sendMessage → succeeds without error', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 6, method: 'plugin.sessions.sendMessage',
      params: { sessionId: 's1', role: 'user', content: 'hello' },
    })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.id, 6)
    assert.ok('result' in resp, 'sendMessage should succeed')
  })
})

describe('Session API — createSessionApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
  })

  it('list() sends plugin.sessions.list RPC', async () => {
    mockClient.requestResults.set('plugin.sessions.list', [
      { id: 's1', label: 'S1', cwd: '/tmp', status: 'active', createdAt: 100, lastActiveAt: 200 },
    ])
    const api = createSessionApi(mockClient, 'test-plugin')
    const result = await api.list()
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].id, 's1')
  })

  it('sendMessage() sends plugin.sessions.sendMessage RPC', async () => {
    const api = createSessionApi(mockClient, 'test-plugin')
    await api.sendMessage({ sessionId: 's1', role: 'user', content: 'hello' })
    const call = mockClient.requestCalls.find(c => c.method === 'plugin.sessions.sendMessage')
    assert.ok(call)
    assert.strictEqual((call.params as Record<string, unknown>).sessionId, 's1')
    assert.strictEqual((call.params as Record<string, unknown>).role, 'user')
  })

  it('onDidCreateSession registers and triggers on notification', async () => {
    const api = createSessionApi(mockClient, 'test-plugin')
    const collected: SessionInfo[] = []
    const disposable = api.onDidCreateSession((s) => { collected.push(s) })

    // 验证注册请求已发出
    const regCall = mockClient.requestCalls.find(c => c.method === 'plugin.sessions.registerCreate')
    assert.ok(regCall)
    const handlerId = (regCall.params as Record<string, unknown>).handlerId as string

    // 模拟通知
    const notifHandler = mockClient.onNotificationHandlers.get('plugin.sessions.didCreate')
    assert.ok(notifHandler)
    notifHandler({ handlerId, session: { id: 's3', label: 'S3', cwd: '/tmp', status: 'active', createdAt: 500, lastActiveAt: 500 } })

    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(collected.length, 1)
    assert.strictEqual(collected[0].id, 's3')

    disposable.dispose()
  })
})

// ══════════════════════════════════════════════════════════════════════
// Config API
// ══════════════════════════════════════════════════════════════════════

describe('Config API — registerConfigRpcHandlers', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>
  const configStore = new Map<string, unknown>()

  beforeEach(() => {
    rpc = new PluginRpcServer()
    configStore.clear()
    configStore.set('theme', 'dark')
    configStore.set('timeout', 5000)

    const deps: ConfigHandlers = {
      get: async (_pluginId: string, key: string) => configStore.get(key),
      getAll: async (_pluginId: string) => {
        const result: Record<string, unknown> = {}
        for (const [k, v] of configStore) result[k] = v
        return result
      },
      set: async (_pluginId: string, key: string, value: unknown) => {
        configStore.set(key, value)
      },
    }

    registerConfigRpcHandlers(rpc, deps)
    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  it('plugin.config.get → returns stored value', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.config.get', params: { pluginId: 'p', key: 'theme' } })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, 'dark')
  })

  it('plugin.config.get → undefined for unknown key', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.config.get', params: { pluginId: 'p', key: 'missing' } })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, undefined)
  })

  it('plugin.config.getAll → returns all config', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 3, method: 'plugin.config.getAll', params: { pluginId: 'p' } })
    const resp = extractLastResponse(port)
    const all = resp.result as Record<string, unknown>
    assert.strictEqual(all.theme, 'dark')
    assert.strictEqual(all.timeout, 5000)
  })

  it('plugin.config.set → stores value', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 4, method: 'plugin.config.set', params: { pluginId: 'p', key: 'fontSize', value: 14 } })
    const resp = extractLastResponse(port)
    assert.ok('result' in resp, 'set should succeed')
    assert.strictEqual(configStore.get('fontSize'), 14)
  })

  it('plugin.config.set → overwrites existing value', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 5, method: 'plugin.config.set', params: { pluginId: 'p', key: 'theme', value: 'light' } })
    assert.strictEqual(configStore.get('theme'), 'light')
  })
})

describe('Config API — createConfigApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
  })

  it('get() sends plugin.config.get RPC', async () => {
    mockClient.requestResults.set('plugin.config.get', 'dark')
    const api = createConfigApi(mockClient, 'test-plugin')
    const val = await api.get('theme')
    assert.strictEqual(val, 'dark')
  })

  it('getAll() sends plugin.config.getAll RPC', async () => {
    mockClient.requestResults.set('plugin.config.getAll', { theme: 'dark', timeout: 5000 })
    const api = createConfigApi(mockClient, 'test-plugin')
    const all = await api.getAll()
    assert.strictEqual(all.theme, 'dark')
    assert.strictEqual(all.timeout, 5000)
  })

  it('set() sends plugin.config.set RPC', async () => {
    const api = createConfigApi(mockClient, 'test-plugin')
    await api.set('fontSize', 14)
    const call = mockClient.requestCalls.find(c => c.method === 'plugin.config.set')
    assert.ok(call)
    assert.strictEqual((call.params as Record<string, unknown>).key, 'fontSize')
  })
})

// ══════════════════════════════════════════════════════════════════════
// SessionData API
// ══════════════════════════════════════════════════════════════════════

describe('SessionData API — registerSessionDataRpcHandlers', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>
  let store: SessionDataStore

  beforeEach(() => {
    rpc = new PluginRpcServer()
    store = new SessionDataStore('')

    const deps: SessionDataHandlers = {
      get: (sid, key) => store.get(sid, key),
      set: (sid, key, val) => store.set(sid, key, val),
      delete: (sid, key) => store.delete(sid, key),
      keys: (sid) => store.keys(sid),
    }

    registerSessionDataRpcHandlers(rpc, deps)
    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  it('plugin.sessionData.set → updates cache', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 1, method: 'plugin.sessionData.set',
      params: { sessionId: 's1', key: 'goal-state', value: { active: true } },
    })
    const resp = extractLastResponse(port)
    assert.ok('result' in resp)

    // 验证缓存
    assert.deepStrictEqual(store.get('s1', 'goal-state'), { active: true })
  })

  it('plugin.sessionData.get → reads from cache', async () => {
    // 预先填充缓存
    store.set('s1', 'goal-state', { active: true })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 2, method: 'plugin.sessionData.get',
      params: { sessionId: 's1', key: 'goal-state' },
    })
    const resp = extractLastResponse(port)
    assert.deepStrictEqual(resp.result, { active: true })
  })

  it('plugin.sessionData.get → undefined for missing session', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 3, method: 'plugin.sessionData.get',
      params: { sessionId: 'nonexistent', key: 'goal-state' },
    })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, undefined)
  })

  it('plugin.sessionData.get → undefined for missing key', async () => {
    store.set('s1', 'other', 'val')

    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 4, method: 'plugin.sessionData.get',
      params: { sessionId: 's1', key: 'missing' },
    })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, undefined)
  })

  it('plugin.sessionData.delete → removes from cache', async () => {
    store.set('s1', 'goal-state', 'data')

    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 5, method: 'plugin.sessionData.delete',
      params: { sessionId: 's1', key: 'goal-state' },
    })
    assert.strictEqual(store.get('s1', 'goal-state'), undefined)
  })

  it('plugin.sessionData.keys → returns all keys', async () => {
    store.set('s1', 'k1', 'v1')
    store.set('s1', 'k2', 'v2')

    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 6, method: 'plugin.sessionData.keys',
      params: { sessionId: 's1' },
    })
    const resp = extractLastResponse(port)
    assert.deepStrictEqual(resp.result, ['k1', 'k2'])
  })

  it('plugin.sessionData.keys → empty for missing session', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 7, method: 'plugin.sessionData.keys',
      params: { sessionId: 'nonexistent' },
    })
    const resp = extractLastResponse(port)
    assert.deepStrictEqual(resp.result, [])
  })
})

describe('SessionData API — createSessionDataApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
  })

  it('set() sends plugin.sessionData.set RPC', async () => {
    const api = createSessionDataApi(mockClient, 'test-plugin')
    await api.set('s1', 'key1', { data: 42 })
    const call = mockClient.requestCalls.find(c => c.method === 'plugin.sessionData.set')
    assert.ok(call)
    assert.strictEqual((call.params as Record<string, unknown>).sessionId, 's1')
    assert.strictEqual((call.params as Record<string, unknown>).key, 'key1')
  })

  it('keys() sends plugin.sessionData.keys RPC', async () => {
    mockClient.requestResults.set('plugin.sessionData.keys', ['k1', 'k2'])
    const api = createSessionDataApi(mockClient, 'test-plugin')
    const keys = await api.keys('s1')
    assert.deepStrictEqual(keys, ['k1', 'k2'])
  })
})

// ══════════════════════════════════════════════════════════════════════
// UI API
// ══════════════════════════════════════════════════════════════════════

describe('UI API — registerUiRpcHandlers', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>
  let lastNotify: { level: string; message: string } | null = null

  beforeEach(() => {
    rpc = new PluginRpcServer()
    lastNotify = null

    const deps: UiHandlers = {
      showSelect: async () => 'option2',
      showConfirm: async () => true,
      showInput: async () => 'user input',
      notify: async (_pluginId: string, level: string, message: string) => {
        lastNotify = { level, message }
      },
      updateStatusBarItem: async () => {},
    }

    registerUiRpcHandlers(rpc, deps)
    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  it('plugin.ui.showSelect → returns chosen option', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 1, method: 'plugin.ui.showSelect',
      params: { pluginId: 'p', title: 'Pick', options: ['a', 'b', 'c'] },
    })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, 'option2')
  })

  it('plugin.ui.showConfirm → returns boolean', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 2, method: 'plugin.ui.showConfirm',
      params: { pluginId: 'p', title: 'Confirm', message: 'Sure?' },
    })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, true)
  })

  it('plugin.ui.showInput → returns input string', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 3, method: 'plugin.ui.showInput',
      params: { pluginId: 'p', title: 'Input', defaultValue: 'default' },
    })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, 'user input')
  })

  it('plugin.ui.notify → calls notify handler', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 4, method: 'plugin.ui.notify',
      params: { pluginId: 'p', level: 'info', message: 'test message' },
    })
    assert.strictEqual(lastNotify?.level, 'info')
    assert.strictEqual(lastNotify?.message, 'test message')
  })

  it('plugin.ui.updateStatusBarItem → succeeds', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 5, method: 'plugin.ui.updateStatusBarItem',
      params: { pluginId: 'p', id: 'status1', text: 'ready' },
    })
    const resp = extractLastResponse(port)
    assert.ok('result' in resp, 'updateStatusBarItem should succeed')
  })
})

describe('UI API — createUiApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
    mockClient.requestResults.set('plugin.ui.showConfirm', true)
    mockClient.requestResults.set('plugin.ui.showSelect', 'opt1')
    mockClient.requestResults.set('plugin.ui.showInput', 'hello')
  })

  it('showConfirm() sends plugin.ui.showConfirm RPC', async () => {
    const api = createUiApi(mockClient, 'test-plugin')
    const result = await api.showConfirm('Title', 'Message?')
    assert.strictEqual(result, true)
    const call = mockClient.requestCalls.find(c => c.method === 'plugin.ui.showConfirm')
    assert.ok(call)
  })

  it('showSelect() returns option', async () => {
    const api = createUiApi(mockClient, 'test-plugin')
    const result = await api.showSelect('Pick', ['a', 'b'])
    assert.strictEqual(result, 'opt1')
  })

  it('showInput() returns input', async () => {
    const api = createUiApi(mockClient, 'test-plugin')
    const result = await api.showInput('Input')
    assert.strictEqual(result, 'hello')
  })

  it('notify() sends plugin.ui.notify RPC', async () => {
    const api = createUiApi(mockClient, 'test-plugin')
    await api.notify('info', 'hello')
    const call = mockClient.requestCalls.find(c => c.method === 'plugin.ui.notify')
    assert.ok(call)
    assert.strictEqual((call.params as Record<string, unknown>).level, 'info')
    assert.strictEqual((call.params as Record<string, unknown>).message, 'hello')
  })
})

// ══════════════════════════════════════════════════════════════════════
// Agent API
// ══════════════════════════════════════════════════════════════════════

describe('Agent API — registerAgentRpcHandlers', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>
  let currentModel: string
  let currentThinking: string
  let activeTools: string[]

  beforeEach(() => {
    rpc = new PluginRpcServer()
    currentModel = 'gpt-4'
    currentThinking = 'high'
    activeTools = ['goal_manager', 'todo']

    registerAgentRpcHandlers(rpc, {
      getModel: () => currentModel,
      setModel: (model: string) => { currentModel = model; return '' },
      getThinkingLevel: () => currentThinking,
      setThinkingLevel: (level: string) => { currentThinking = level; return '' },
      getActiveTools: () => activeTools,
    })

    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  it('plugin.agent.getModel → returns current model', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.agent.getModel', params: {} })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, 'gpt-4')
  })

  it('plugin.agent.setModel → updates model', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.agent.setModel', params: { pluginId: 'p', model: 'claude-3' } })
    assert.strictEqual(currentModel, 'claude-3')
  })

  it('plugin.agent.getThinkingLevel → returns level', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 3, method: 'plugin.agent.getThinkingLevel', params: {} })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, 'high')
  })

  it('plugin.agent.setThinkingLevel → updates level', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 4, method: 'plugin.agent.setThinkingLevel', params: { pluginId: 'p', level: 'low' } })
    assert.strictEqual(currentThinking, 'low')
  })

  it('plugin.agent.getActiveTools → returns tool list', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 5, method: 'plugin.agent.getActiveTools', params: {} })
    const resp = extractLastResponse(port)
    assert.deepStrictEqual(resp.result, ['goal_manager', 'todo'])
  })
})

describe('Agent API — createAgentApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
    mockClient.requestResults.set('plugin.agent.getModel', 'gpt-4')
    mockClient.requestResults.set('plugin.agent.getThinkingLevel', 'high')
    mockClient.requestResults.set('plugin.agent.getActiveTools', ['goal_manager'])
  })

  it('getModel() sends plugin.agent.getModel RPC', async () => {
    const api = createAgentApi(mockClient, 'test-plugin')
    const model = await api.getModel()
    assert.strictEqual(model, 'gpt-4')
  })

  it('setModel() sends plugin.agent.setModel RPC', async () => {
    const api = createAgentApi(mockClient, 'test-plugin')
    await api.setModel('claude-3')
    const call = mockClient.requestCalls.find(c => c.method === 'plugin.agent.setModel')
    assert.ok(call)
    assert.strictEqual((call.params as Record<string, unknown>).model, 'claude-3')
  })

  it('getActiveTools() returns tools', async () => {
    const api = createAgentApi(mockClient, 'test-plugin')
    const tools = await api.getActiveTools()
    assert.deepStrictEqual(tools, ['goal_manager'])
  })
})

// ══════════════════════════════════════════════════════════════════════
// Workspace API
// ══════════════════════════════════════════════════════════════════════

describe('Workspace API — registerWorkspaceRpcHandlers', () => {
  let rpc: PluginRpcServer
  let port: ReturnType<typeof createMockPort>

  beforeEach(() => {
    rpc = new PluginRpcServer()

    registerWorkspaceRpcHandlers(rpc, {
      getRootPath: () => '/test/workspace',
      getName: () => 'workspace',
      findFiles: async (pattern: string) => {
        if (pattern === '*.ts') return ['a.ts', 'b.ts']
        return []
      },
    })

    port = createMockPort()
    rpc.registerWorker('w1', port)
  })

  it('plugin.workspace.rootPath → returns root path', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 1, method: 'plugin.workspace.rootPath', params: {} })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, '/test/workspace')
  })

  it('plugin.workspace.name → returns workspace name', async () => {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id: 2, method: 'plugin.workspace.name', params: {} })
    const resp = extractLastResponse(port)
    assert.strictEqual(resp.result, 'workspace')
  })

  it('plugin.workspace.findFiles → returns matched files', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 3, method: 'plugin.workspace.findFiles',
      params: { pattern: '*.ts' },
    })
    const resp = extractLastResponse(port)
    assert.deepStrictEqual(resp.result, ['a.ts', 'b.ts'])
  })

  it('plugin.workspace.findFiles → empty array for no matches', async () => {
    await rpc.dispatch('w1', {
      jsonrpc: '2.0', id: 4, method: 'plugin.workspace.findFiles',
      params: { pattern: '*.js' },
    })
    const resp = extractLastResponse(port)
    assert.deepStrictEqual(resp.result, [])
  })
})

describe('Workspace API — createWorkspaceApi (Worker side)', () => {
  let mockClient: MockRpcClient & PluginRpcClient

  beforeEach(() => {
    mockClient = createMockRpcClient()
    mockClient.requestResults.set('plugin.workspace.rootPath', '/test/workspace')
    mockClient.requestResults.set('plugin.workspace.name', 'workspace')
  })

  it('rootPath and name are cached from RPC on creation', async () => {
    const api = createWorkspaceApi(mockClient, 'test-plugin')
    // 等待 RPC 缓存
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.strictEqual(api.rootPath, '/test/workspace')
    assert.strictEqual(api.name, 'workspace')
  })

  it('findFiles() sends plugin.workspace.findFiles RPC', async () => {
    mockClient.requestResults.set('plugin.workspace.findFiles', ['a.ts', 'b.ts'])
    const api = createWorkspaceApi(mockClient, 'test-plugin')
    const files = await api.findFiles('*.ts')
    assert.deepStrictEqual(files, ['a.ts', 'b.ts'])
    const call = mockClient.requestCalls.find(c => c.method === 'plugin.workspace.findFiles')
    assert.ok(call)
    assert.strictEqual((call.params as Record<string, unknown>).pattern, '*.ts')
  })
})
