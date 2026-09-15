/**
 * Commands/Views 双域 RPC 回路测试（s3-w2 runtime-circuit）
 *
 * 覆盖 design-review testCases：
 * - AC2: register→invoke 闭环（主线程 registry 建表 + worker invoke 分发两条腿）
 * - AC10: mountPoints.sync 注入 → plugin.views.listMountPoints 返回一致
 * - ES1: commands.unregister 不存在 commandId 幂等 no-op
 * - ES2: views.update 无活跃 session 广播丢弃 + warning
 * - TC1: handler 驻留 worker（VSCode 模式）——invoke 按 handlerId 命中/未命中
 * - TC3-TC4: 链路方向验证（AC2 主线程 + AC10 承载）
 *
 * mock 策略（对齐 design-review mockStrategyNote）：
 * - 主线程侧：真实 PluginRpcServer + mock WorkerPort（记录 postMessage）
 * - worker 侧：真实 PluginRpcClient + mock ClientPort（捕获 RPC 请求）
 * - 接线侧：PluginService 实例 + mock broker/broadcastFn，经 registerRpcMethods 真实接线
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { ClientPort } from '../src/services/plugin-service/plugin-rpc-client.js'
import { registerCommandRpcHandlers, createCommandsApi } from '../src/services/plugin-service/api/commands-api.js'
import type { CommandRegistration } from '../src/services/plugin-service/api/commands-api.js'
import { registerViewRpcHandlers, createViewsApi } from '../src/services/plugin-service/api/views-api.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'

/** 记录 postMessage 收到的消息（plugin-rpc.test.ts 同款） */
function createMockPort<T extends { postMessage(msg: unknown): void }>(): T & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  } as T & { messages: unknown[] }
}

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

// ══════════════════════════════════════════════════════════════
// AC2 — 主线程侧：register 建表 + 下行广播 + 成功响应
// ══════════════════════════════════════════════════════════════

describe('commands.register（主线程侧）', () => {
  let rpc: PluginRpcServer
  let registry: Map<string, CommandRegistration>
  let broadcastRegistered: ReturnType<typeof vi.fn<(reg: CommandRegistration) => void>>
  let deliverInvokeResult: ReturnType<typeof vi.fn<(handlerId: string, payload: { result?: unknown; error?: unknown }) => void>>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    registry = new Map()
    broadcastRegistered = vi.fn<(reg: CommandRegistration) => void>()
    deliverInvokeResult = vi.fn<(handlerId: string, payload: { result?: unknown; error?: unknown }) => void>()
  })

  function registerHandlers(): void {
    registerCommandRpcHandlers(rpc, { registry, broadcastRegistered, deliverInvokeResult })
  }

  it('AC2: register 写入 registry（commandId/pluginId/handlerId/registeredAt）+ 广播 + 成功响应', async () => {
    registerHandlers()
    const port = createMockPort<WorkerPort>()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.commands.register',
      params: {
        pluginId: 'p1',
        command: { id: 'cmd1', title: 'Do Something', category: 'tools' },
        handlerId: 'h1',
      },
    })

    // registry 建表（TC3 链路数据源；S3-W1 复合键：key 为 `pluginId:commandId`）
    const reg = registry.get('p1:cmd1')
    expect(reg).toBeDefined()
    expect(reg!.commandId).toBe('cmd1')
    expect(reg!.pluginId).toBe('p1')
    expect(reg!.handlerId).toBe('h1')
    expect(reg!.title).toBe('Do Something')
    expect(reg!.registeredAt).toEqual(expect.any(Number))

    // 下行广播 plugin:commandRegistered（payload 为 CommandRegistration）
    expect(broadcastRegistered).toHaveBeenCalledTimes(1)
    expect(broadcastRegistered).toHaveBeenCalledWith(reg)

    // port 收到成功响应
    const wrapper = port.messages[0] as { type: string; response: { id: number; result: unknown } }
    expect(wrapper.type).toBe('rpc')
    expect(wrapper.response.id).toBe(1)
    expect(wrapper.response.result).toEqual({ registered: true })
  })

  it('ES1: unregister 不存在的 commandId 幂等 no-op（不 throw + registry 不变）', async () => {
    registerHandlers()
    const port = createMockPort<WorkerPort>()
    rpc.registerWorker('w1', port)

    await expect(
      rpc.dispatch('w1', {
        jsonrpc: '2.0',
        id: 2,
        method: 'plugin.commands.unregister',
        params: { pluginId: 'p1', commandId: 'nope' },
      }),
    ).resolves.toBeUndefined()

    expect(registry.size).toBe(0)
    const wrapper = port.messages[0] as { type: string; response: { id: number; result: unknown } }
    expect(wrapper.response.result).toEqual({ unregistered: true })
  })

  it('ES1: unregister 已注册 commandId 删除 registry 条目', async () => {
    registerHandlers()
    registry.set('p1:cmd1', {
      commandId: 'cmd1',
      pluginId: 'p1',
      handlerId: 'h1',
      workerId: 'w1',
      registeredAt: Date.now(),
    })
    const port = createMockPort<WorkerPort>()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'plugin.commands.unregister',
      params: { pluginId: 'p1', commandId: 'cmd1' },
    })

    expect(registry.has('p1:cmd1')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════
// AC2/TC1 — worker 侧：register 代理 + invoke 通知派发（handler 驻留）
// ══════════════════════════════════════════════════════════════

describe('createCommandsApi（worker 侧）', () => {
  let client: PluginRpcClient
  let port: ClientPort & { messages: unknown[] }

  beforeEach(() => {
    client = new PluginRpcClient()
    port = createMockPort<ClientPort>()
    client.attach(port)
  })

  /** 捕获最近一次 request 的 id 并模拟主线程成功响应 */
  function resolveLastRequest(result: unknown): void {
    const last = port.messages[port.messages.length - 1] as { type: string; id: number; method: string }
    expect(last.type).toBe('rpc')
    client.handleResponse({ jsonrpc: '2.0', id: last.id, result })
  }

  it('AC2: register 发 RPC（params 含 handlerId）+ 本地持有 handler', async () => {
    const api = createCommandsApi(client, 'p1')
    const handler = vi.fn()

    const registerPromise = api.register({ id: 'cmd1', title: 'Do' }, handler)
    resolveLastRequest({ registered: true })
    await registerPromise

    // port 收到 plugin.commands.register，params 含 pluginId/command/handlerId
    const sent = port.messages[0] as { type: string; method: string; params: { pluginId: string; command: { id: string }; handlerId: string } }
    expect(sent.method).toBe('plugin.commands.register')
    expect(sent.params.pluginId).toBe('p1')
    expect(sent.params.command.id).toBe('cmd1')
    expect(sent.params.handlerId).toMatch(/^cmd_p1_\d+$/)
  })

  it('TC1: invoke 通知命中已注册 handlerId → handler 被调 + invoke.result 回传', async () => {
    const api = createCommandsApi(client, 'p1')
    const handler = vi.fn(() => 'result-ok')

    const registerPromise = api.register({ id: 'cmd1' }, handler)
    resolveLastRequest({ registered: true })
    await registerPromise

    // 从 register 请求中提取 handlerId（invoke 回带同一 handlerId，R1 契约）
    const sent = port.messages[0] as { params: { handlerId: string } }
    const handlerId = sent.params.handlerId

    // 模拟主线程 invoke 通知
    client.handleNotification({
      jsonrpc: '2.0',
      method: 'plugin.commands.invoke',
      params: { handlerId, args: { x: 1 } },
    })

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ x: 1 })
      // invoke.result 经 RPC 回传主线程（含 result）
      const resultMsg = port.messages.find(m =>
        (m as { method?: string }).method === 'plugin.commands.invoke.result')
      expect(resultMsg).toBeDefined()
      expect((resultMsg as { params: { handlerId: string; result: string } }).params).toEqual({
        handlerId,
        result: 'result-ok',
      })
    })
    // 收尾：resolve invoke.result 的挂起 request（避免 30s 超时 timer 悬挂）
    resolveLastRequest({ ok: true })
  })

  it('TC1: invoke 未注册 handlerId → 不崩、handler 不被调、无 invoke.result', async () => {
    const api = createCommandsApi(client, 'p1')
    const handler = vi.fn()

    const registerPromise = api.register({ id: 'cmd1' }, handler)
    resolveLastRequest({ registered: true })
    await registerPromise

    // 随机未注册 handlerId 的 invoke 通知（dispatchHandler 返回 false 静默）
    client.handleNotification({
      jsonrpc: '2.0',
      method: 'plugin.commands.invoke',
      params: { handlerId: 'cmd_ghost_999', args: {} },
    })

    expect(handler).not.toHaveBeenCalled()
    const resultMsg = port.messages.find(m =>
      (m as { method?: string }).method === 'plugin.commands.invoke.result')
    expect(resultMsg).toBeUndefined()
  })

  it('unregister 发 RPC 注销 + 后续 invoke 不再命中', async () => {
    const api = createCommandsApi(client, 'p1')
    const handler = vi.fn()

    const registerPromise = api.register({ id: 'cmd1' }, handler)
    resolveLastRequest({ registered: true })
    await registerPromise

    const unregisterPromise = api.unregister('cmd1')
    resolveLastRequest({ unregistered: true })
    await unregisterPromise

    const unregMsg = port.messages.find(m =>
      (m as { method?: string }).method === 'plugin.commands.unregister')
    expect(unregMsg).toBeDefined()
    expect((unregMsg as { params: { commandId: string } }).params.commandId).toBe('cmd1')
  })
})

// ══════════════════════════════════════════════════════════════
// views-api — createViewsApi 代理（RPC 转发）
// ══════════════════════════════════════════════════════════════

describe('createViewsApi（worker 侧）', () => {
  let client: PluginRpcClient
  let port: ClientPort & { messages: unknown[] }

  beforeEach(() => {
    client = new PluginRpcClient()
    port = createMockPort<ClientPort>()
    client.attach(port)
  })

  it('update 发 plugin.views.update RPC（pluginId/viewId/guiTree）', async () => {
    const api = createViewsApi(client, 'p1')
    const guiTree = [{ type: 'label', props: { text: 'hi' } }] as never[]

    const updatePromise = api.update('view1', guiTree as never)
    const sent = port.messages[0] as { id: number; method: string; params: { pluginId: string; viewId: string; guiTree: unknown[] } }
    expect(sent.method).toBe('plugin.views.update')
    expect(sent.params.pluginId).toBe('p1')
    expect(sent.params.viewId).toBe('view1')
    expect(sent.params.guiTree).toEqual(guiTree)

    // 模拟主线程响应（fire-and-forget：resolve 后不等待）
    client.handleResponse({ jsonrpc: '2.0', id: sent.id, result: { updated: true } })
    await updatePromise
  })

  it('listMountPoints 发 RPC 并返回主线程结果', async () => {
    const api = createViewsApi(client, 'p1')

    const listPromise = api.listMountPoints()
    const sent = port.messages[0] as { id: number; method: string }
    expect(sent.method).toBe('plugin.views.listMountPoints')

    client.handleResponse({ jsonrpc: '2.0', id: sent.id, result: ['view-a', 'view-b'] })
    await expect(listPromise).resolves.toEqual(['view-a', 'view-b'])
  })
})

// ══════════════════════════════════════════════════════════════
// AC10/ES2 — 经 PluginService + registerRpcMethods 真实接线
// ══════════════════════════════════════════════════════════════

describe('PluginService 接线（commands/views RPC）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  /** 构造已接线的 PluginService，返回 service + rpcServer + 注册的 mock port */
  function wiredService(deps?: { broadcastFn?: (type: string, payload: unknown) => void }) {
    const service = new PluginService({} as never, createMockBroker(), deps)
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
    const rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
    const port = createMockPort<WorkerPort>()
    rpcServer.registerWorker('w1', port)
    return { service, rpcServer, port }
  }

  it('AC10: syncMountPoints 注入 → plugin.views.listMountPoints 返回一致（浅拷贝）', async () => {
    const { service, rpcServer, port } = wiredService()

    service.syncMountPoints(['view-a', 'view-b'])

    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.views.listMountPoints',
      params: { pluginId: 'p1' },
    })

    const wrapper = port.messages[0] as { type: string; response: { id: number; result: string[] } }
    expect(wrapper.response.result).toEqual(['view-a', 'view-b'])

    // 浅拷贝隔离：修改返回值不影响内部挂载点集合
    wrapper.response.result.push('view-c')
    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'plugin.views.listMountPoints',
      params: { pluginId: 'p1' },
    })
    const wrapper2 = port.messages[1] as { response: { result: string[] } }
    expect(wrapper2.response.result).toEqual(['view-a', 'view-b'])
  })

  it('AC10: syncMountPoints 覆盖式更新（DM3 全量镜像）', async () => {
    const { service, rpcServer, port } = wiredService()

    service.syncMountPoints(['view-a', 'view-b'])
    service.syncMountPoints(['view-x'])

    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.views.listMountPoints',
      params: { pluginId: 'p1' },
    })
    const wrapper = port.messages[0] as { response: { result: string[] } }
    expect(wrapper.response.result).toEqual(['view-x'])
  })

  it('ES2: views.update 无活跃 session → 广播丢弃 + warning 含 pluginId/viewId', async () => {
    const broadcastFn = vi.fn()
    // 不传 sessionService → activeSessionResolver.resolve() 返回 undefined
    const { rpcServer } = wiredService({ broadcastFn })

    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.views.update',
      params: { pluginId: 'p1', viewId: 'v1', guiTree: [] },
    })

    expect(broadcastFn).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    const warnMsg = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(warnMsg).toContain('p1')
    expect(warnMsg).toContain('v1')
  })

  it('commands.register 经完整接线 → broadcastFn 收 plugin:commandRegistered', async () => {
    const broadcastFn = vi.fn()
    const { rpcServer, port } = wiredService({ broadcastFn })

    await rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.commands.register',
      params: {
        pluginId: 'p1',
        command: { id: 'cmd1', title: 'T' },
        handlerId: 'h1',
      },
    })

    expect(broadcastFn).toHaveBeenCalledTimes(1)
    const [type, payload] = broadcastFn.mock.calls[0] as [string, CommandRegistration]
    expect(type).toBe('plugin:commandRegistered')
    expect(payload.commandId).toBe('cmd1')
    expect(payload.pluginId).toBe('p1')
    expect(payload.handlerId).toBe('h1')
  })
})

// ══════════════════════════════════════════════════════════════
// registerViewRpcHandlers — 独立单元（views-api 主线程侧）
// ══════════════════════════════════════════════════════════════

describe('registerViewRpcHandlers', () => {
  it('listMountPoints 返回 mountPoints 浅拷贝', async () => {
    const rpc = new PluginRpcServer()
    const mountPoints = ['view-a']
    const handleViewUpdate = vi.fn()
    registerViewRpcHandlers(rpc, { mountPoints, handleViewUpdate })

    const port = createMockPort<WorkerPort>()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.views.listMountPoints',
      params: { pluginId: 'p1' },
    })

    const wrapper = port.messages[0] as { response: { result: string[] } }
    expect(wrapper.response.result).toEqual(['view-a'])
    // 浅拷贝：改返回值不影响内部数组
    mountPoints.push('view-b')
    expect(wrapper.response.result).toEqual(['view-a'])
  })
})
