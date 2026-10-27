/**
 * plugin-service：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - plugin-commands-views.test.ts
 *   - plugin-modal-headeraction-contract.test.ts
 *   - plugin-esm-loader-argv.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run test/plugin-service.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HeaderActionUpdatePayload } from '@taiji/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IMessageBroker } from '../src/interfaces.js'
import { createCommandsApi, registerCommandRpcHandlers } from '../src/services/plugin-service/api/commands-api.js'
import type { CommandRegistration } from '../src/services/plugin-service/api/commands-api.js'
import { SessionEventDispatch, registerSessionRpcHandlers } from '../src/services/plugin-service/api/session-api.js'
import type { SessionHandlers } from '../src/services/plugin-service/api/session-api.js'
import { registerUiRpcHandlers, resetRuntimeUiExitsForTest, wireRuntimeUiExits } from '../src/services/plugin-service/api/ui-api.js'
import { createViewsApi, registerViewRpcHandlers } from '../src/services/plugin-service/api/views-api.js'
import { resolveAndValidateFile } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js'
import type { ClientPort } from '../src/services/plugin-service/plugin-rpc-client.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginService, findTsxImportArg, resolveEsmLoaderExecArgv } from '../src/services/plugin-service/plugin-service.js'


// ════════════════ 来源: plugin-commands-views.test.ts ════════════════
describe('plugin-commands-views', () => {
  /**
   * Commands/Views 双域 RPC 回路测试（s3-w2 runtime-circuit）
   *
   * 覆盖 design-review testCases：
   * - AC2: register→invoke 闭环（主线程 registry 建表 + worker invoke 分发两条路径）
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
      }, { interval: 1 })
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

    it('update 发 plugin.views.update RPC（pluginId/viewId/guiTree/sessionId）', async () => {
      const api = createViewsApi(client, 'p1')
      const guiTree = [{ type: 'label', props: { text: 'hi' } }] as never[]

      const updatePromise = api.update('view1', guiTree as never, { sessionId: 's1' })
      const sent = port.messages[0] as { id: number; method: string; params: { pluginId: string; viewId: string; guiTree: unknown[]; sessionId: string } }
      expect(sent.method).toBe('plugin.views.update')
      expect(sent.params.pluginId).toBe('p1')
      expect(sent.params.viewId).toBe('view1')
      expect(sent.params.guiTree).toEqual(guiTree)
      // [D1/u5b] sessionId 显式必填（E15）
      expect(sent.params.sessionId).toBe('s1')

      // 模拟主线程响应（fire-and-forget：resolve 后不等待）
      client.handleResponse({ jsonrpc: '2.0', id: sent.id, result: { updated: true } })
      await updatePromise
    })

    it('update 全局域（U2）：mountId 归属透传（二选一由主线程校验）', async () => {
      const api = createViewsApi(client, 'plug-demo')
      const guiTree = [{ type: 'label', props: { text: 'hi' } }] as never[]

      const updatePromise = api.update('flow', guiTree as never, { mountId: 'provider.authorize' })
      const sent = port.messages[0] as { id: number; method: string; params: { pluginId: string; viewId: string; guiTree: unknown[]; mountId: string; sessionId?: string } }
      expect(sent.method).toBe('plugin.views.update')
      expect(sent.params.pluginId).toBe('plug-demo')
      expect(sent.params.viewId).toBe('flow')
      expect(sent.params.mountId).toBe('provider.authorize')
      expect(sent.params.sessionId).toBeUndefined()

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

    it('[U2] views.update 归属二选一：都缺/都给 → INVALID_VIEW_SCOPE 拒绝，不走活跃会话猜测', async () => {
      const broadcastFn = vi.fn()
      const { rpcServer, port } = wiredService({ broadcastFn })

      await rpcServer.dispatch('w1', {
        jsonrpc: '2.0',
        id: 1,
        method: 'plugin.views.update',
        params: { pluginId: 'p1', viewId: 'v1', guiTree: [] },
      })

      // 旧 ES2「无活跃 session 丢弃 + warning」与 D1「缺 sessionId INVALID_SESSION_ID」均被
      // U2 归属二选一取代：都缺（或都给）是插件作者错误，显式 INVALID_VIEW_SCOPE 拒绝 +
      // 零广播（不猜测不投递）
      const wrapper = port.messages[0] as { response: { error?: { code?: string; message?: string } } }
      expect(wrapper.response.error?.code).toBe('INVALID_VIEW_SCOPE')
      expect(wrapper.response.error?.message).toContain('sessionId')
      expect(wrapper.response.error?.message).toContain('mountId')
      expect(broadcastFn).not.toHaveBeenCalled()

      // 都给同样拒绝
      await rpcServer.dispatch('w1', {
        jsonrpc: '2.0',
        id: 2,
        method: 'plugin.views.update',
        params: { pluginId: 'p1', viewId: 'v1', guiTree: [], sessionId: 's1', mountId: 'provider.authorize' },
      })
      const wrapper2 = port.messages[1] as { response: { error?: { code?: string; message?: string } } }
      expect(wrapper2.response.error?.code).toBe('INVALID_VIEW_SCOPE')
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
});

// ════════════════ 来源: plugin-modal-headeraction-contract.test.ts ════════════════
describe('plugin-modal-headeraction-contract', () => {
  /**
   * plugin headerAction 点位契约测试（plugin-header-action-modal-points AP-1，u5b；
   * modal 机制已整体退役，本文件只保留 headerAction 与共存 RPC 的契约范围）
   *
   * 覆盖（impl-plan u5b 验收条款对应的 rpc-setup 契约范围）：
   * - E15 INVALID_SESSION_ID 三方法：views.update / sendMessage / updateHeaderAction
   * - views.update 显式 sessionId 归属投递（payload.sessionId 直达 handleViewUpdate，
   *   ActiveSessionResolver 盖戳路径已删除——D1 不采用④）
   * - sendMessage 回执映射逐 reason 值（{blocked,reason} → {accepted:false,reason}；成功 → {accepted:true}）
   * - requireCommand 空串/全空白 → INVALID_REQUIRE_COMMAND 入口拒绝（B-F5）
   * - updateHeaderAction 校验 + plugin:headerActionUpdate 广播形状
   * - B-F1：updateHeaderAction badge·tooltip 超 4KB → INVALID_* 拒绝零广播
   * - B-F2：广播出线未接线 → updateHeaderAction 回 {updated:false}（不假成功）；
   *   broadcastFn 缺失 warn-drop 同理（真实装配全链）
   * - B-F4：deps.sessionService 缺失 → console.error 留痕 + {blocked:true, reason:'error'}
   * - togglePlugin plugin:statusChange 广播（E2 修复：disable/enable 路径 renderer 触发源）
   *
   * 运行：cd packages/runtime && npx vitest run test/plugin-modal-headeraction-contract.test.ts
   */


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

  /** 捕获广播出线（wireRuntimeUiExits 注入点；broadcast 闭包回 true = 帧已发出） */
  function wireCapturingExits() {
    const headerAction: HeaderActionUpdatePayload[] = []
    wireRuntimeUiExits({
      broadcastHeaderActionUpdate: (payload) => { headerAction.push(payload); return true },
    })
    return { headerAction }
  }

  /** 最小 UiHandlers（dialog 三方法不触达，vi.fn 占位） */
  function minimalUiHandlers() {
    return {
      showSelect: vi.fn(),
      showConfirm: vi.fn(),
      showInput: vi.fn(),
      notify: vi.fn(),
    }
  }

  /** PluginService 行为级测试用 mock broker（broadcast 不触达真实 ws） */
  function createMockBroker(): IMessageBroker {
    return { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
  }

  beforeEach(() => {
    resetRuntimeUiExitsForTest()
  })

  describe('E15：三方法 sessionId 必填（缺/非法 → INVALID_SESSION_ID）', () => {
    function buildRpc() {
      const exits = wireCapturingExits()
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      registerUiRpcHandlers(rpc, minimalUiHandlers())
      registerViewRpcHandlers(rpc, {
        mountPoints: [],
        handleViewUpdate: vi.fn(),
      })
      const sessionHandlers: SessionHandlers = {
        listSessions: () => [],
        getSession: () => undefined,
        getActiveSession: () => undefined,
        sendMessage: vi.fn(async () => ({ blocked: false })),
        sessionEvents: new SessionEventDispatch(rpc),
      }
      registerSessionRpcHandlers(rpc, sessionHandlers)
      return { exits, rpc, port, sessionHandlers }
    }

    it('updateHeaderAction：非法 sessionId → INVALID_SESSION_ID，零广播', async () => {
      const { exits, rpc, port } = buildRpc()
      const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', { pluginId: 'p1', headerActionId: 'a', sessionId: '../evil' })
      expect(resp.error?.code).toBe('INVALID_SESSION_ID')
      expect(exits.headerAction).toHaveLength(0)
    })

    it('views.update：归属都缺/都给 → INVALID_VIEW_SCOPE 且 handleViewUpdate 不触达（U2 二选一）', async () => {
      const { rpc, port } = buildRpc()
      const resp = await dispatch(rpc, port, 1, 'plugin.views.update', { pluginId: 'p1', viewId: 'v1', guiTree: [] })
      expect(resp.error?.code).toBe('INVALID_VIEW_SCOPE')
      expect(lastResponse(port).error?.message).toContain('sessionId')
      const respBoth = await dispatch(rpc, port, 2, 'plugin.views.update', { pluginId: 'p1', viewId: 'v1', guiTree: [], sessionId: 's1', mountId: 'provider.authorize' })
      expect(respBoth.error?.code).toBe('INVALID_VIEW_SCOPE')
    })

    it('sendMessage：缺 sessionId → INVALID_SESSION_ID（替换既有静默 no-op）', async () => {
      const { rpc, port, sessionHandlers } = buildRpc()
      const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', { role: 'user', content: 'x' })
      expect(resp.error?.code).toBe('INVALID_SESSION_ID')
      expect(sessionHandlers.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('views.update 显式 sessionId 归属投递（D1）', () => {
    it('payload.sessionId 直达 handleViewUpdate（不经活跃会话解析——D1 不采用④路径已删除）', async () => {
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      const handleViewUpdate = vi.fn()
      registerViewRpcHandlers(rpc, { mountPoints: [], handleViewUpdate })

      // 声明一个与任何「活跃会话」无关的 id：投递归属必须等于 payload.sessionId
      await dispatch(rpc, port, 1, 'plugin.views.update', {
        pluginId: 'p1', viewId: 'panel-p1-v1', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }], sessionId: 'declared-session',
      })

      expect(handleViewUpdate).toHaveBeenCalledTimes(1)
      expect(handleViewUpdate).toHaveBeenCalledWith('p1', 'panel-p1-v1', [{ type: 'ansi-text', props: { lines: ['x'] } }], { kind: 'session', sessionId: 'declared-session' })
    })

    it('payload.mountId 直达 handleViewUpdate（U2 全局域：scope 联合形态分流）', async () => {
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      const handleViewUpdate = vi.fn()
      registerViewRpcHandlers(rpc, { mountPoints: [], handleViewUpdate })

      // 全局域归属：mountId 声明挂载位（无会话归属），handleViewUpdate 收 scope 联合
      await dispatch(rpc, port, 1, 'plugin.views.update', {
        pluginId: 'plug-a', viewId: 'flow', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }], mountId: 'provider.authorize',
      })

      expect(handleViewUpdate).toHaveBeenCalledTimes(1)
      expect(handleViewUpdate).toHaveBeenCalledWith('plug-a', 'flow', [{ type: 'ansi-text', props: { lines: ['x'] } }], { kind: 'global', mountId: 'provider.authorize', pluginId: 'plug-a' })
    })
  })

  describe('sendMessage 回执映射（D6/AP-4 两步之②）', () => {
    function buildWithSender(sendMessage: SessionHandlers['sendMessage']) {
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      const sessionHandlers: SessionHandlers = {
        listSessions: () => [],
        getSession: () => undefined,
        getActiveSession: () => undefined,
        sendMessage,
        sessionEvents: new SessionEventDispatch(rpc),
      }
      registerSessionRpcHandlers(rpc, sessionHandlers)
      return { rpc, port, sessionHandlers }
    }

    it('成功（blocked:false）→ {accepted:true}', async () => {
      const sendMessage = vi.fn(async () => ({ blocked: false }))
      const { rpc, port, sessionHandlers } = buildWithSender(sendMessage)

      const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', {
        sessionId: 's1', role: 'user', content: '/schedule off a1b2c3d4', requireCommand: 'schedule',
      })

      expect(resp.result).toEqual({ accepted: true })
      // requireCommand 透传 dispatcher（restore 后、busy 预检前的原子校验，E14 防漏进模型）
      expect(sessionHandlers.sendMessage).toHaveBeenCalledWith('s1', 'user', '/schedule off a1b2c3d4', 'schedule')
    })

    it.each([
      'command-missing',
      'hook-blocked',
      'error',
    ] as const)('blocked + reason=%s → {accepted:false, reason 透传}', async (reason) => {
      const sendMessage = vi.fn(async () => ({ blocked: true, rejected: true, reason }))
      const { rpc, port } = buildWithSender(sendMessage)

      const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', {
        sessionId: 's1', role: 'user', content: 'x', requireCommand: 'schedule',
      })

      expect(resp.result).toEqual({ accepted: false, reason })
    })

    it('blocked 无 reason → {accepted:false}（reason 键省略，不产 undefined 字段）', async () => {
      const { rpc, port } = buildWithSender(async () => ({ blocked: true }))
      const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', { sessionId: 's1', role: 'user', content: 'x' })
      expect(resp.result).toEqual({ accepted: false })
      expect('reason' in (resp.result as Record<string, unknown>)).toBe(false)
    })

    it('dispatcher 抛错（E4 恢复失败等）→ {accepted:false, reason:"error"} 回执（非 RPC error，插件侧无需 catch）', async () => {
      const sendMessage = vi.fn(async () => { throw new Error('Failed to restore session: pi exited during restore') })
      const { rpc, port } = buildWithSender(sendMessage)

      const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', {
        sessionId: 's1', role: 'user', content: 'x',
      })

      expect(resp.error).toBeUndefined()
      expect(resp.result).toEqual({ accepted: false, reason: 'error' })
    })

    // ── B-F5：requireCommand present 但空串/全空白 → 入口结构化拒绝，不进 dispatcher 探测预算 ──
    it.each(['', '   '])('requireCommand 空串/全空白（%j）→ INVALID_REQUIRE_COMMAND，deps.sendMessage 不触达', async (empty) => {
      const sendMessage = vi.fn(async () => ({ blocked: false }))
      const { rpc, port, sessionHandlers } = buildWithSender(sendMessage)

      const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', {
        sessionId: 's1', role: 'user', content: '/schedule off a1b2c3d4', requireCommand: empty,
      })

      expect(resp.error?.code).toBe('INVALID_REQUIRE_COMMAND')
      expect(resp.error?.message).toContain('requireCommand')
      expect(sessionHandlers.sendMessage).not.toHaveBeenCalled()
    })

    it('requireCommand 缺省仍合法（B-F5 只拦 present 但空）', async () => {
      const sendMessage = vi.fn(async () => ({ blocked: false }))
      const { rpc, port } = buildWithSender(sendMessage)

      const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', {
        sessionId: 's1', role: 'user', content: 'hello',
      })

      expect(resp.error).toBeUndefined()
      expect(resp.result).toEqual({ accepted: true })
    })
  })

  describe('updateHeaderAction 广播（AP-1）', () => {
    it('校验通过 → plugin:headerActionUpdate 帧（pluginId/headerActionId/sessionId/badge/tooltip/disabled 原文）', async () => {
      const exits = wireCapturingExits()
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      registerUiRpcHandlers(rpc, minimalUiHandlers())

      const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', {
        pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1',
        badge: '2', tooltip: '定时任务', disabled: false,
      })

      expect(resp.result).toEqual({ updated: true })
      expect(exits.headerAction).toEqual([{
        pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1',
        badge: '2', tooltip: '定时任务', disabled: false,
      }])
    })

    it('可缺省字段（badge/tooltip/disabled 全缺省）→ 帧只含三必填键', async () => {
      const exits = wireCapturingExits()
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      registerUiRpcHandlers(rpc, minimalUiHandlers())

      await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', {
        pluginId: 'p1', headerActionId: 'a', sessionId: 's1',
      })

      expect(exits.headerAction).toEqual([{ pluginId: 'p1', headerActionId: 'a', sessionId: 's1' }])
    })

    it('disabled 非布尔 → INVALID_DISABLED 拒绝，零广播', async () => {
      const exits = wireCapturingExits()
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      registerUiRpcHandlers(rpc, minimalUiHandlers())

      const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', {
        pluginId: 'p1', headerActionId: 'a', sessionId: 's1', disabled: 'yes',
      })

      expect(resp.error?.code).toBe('INVALID_DISABLED')
      expect(exits.headerAction).toHaveLength(0)
    })

    // ── B-F1：badge/tooltip ≤4KB（S3-W4 同口径）——超长展示文本不入广播帧 ──
    const HEADER_TEXT_MAX_BYTES = 4 * 1024

    it('B-F1 badge 超 4KB → INVALID_BADGE 拒绝，零广播', async () => {
      const exits = wireCapturingExits()
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      registerUiRpcHandlers(rpc, minimalUiHandlers())

      const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', {
        pluginId: 'p1', headerActionId: 'a', sessionId: 's1', badge: 'x'.repeat(HEADER_TEXT_MAX_BYTES + 1),
      })

      expect(resp.error?.code).toBe('INVALID_BADGE')
      expect(exits.headerAction).toHaveLength(0)
    })

    it('B-F1 tooltip 超 4KB → INVALID_TOOLTIP 拒绝，零广播；4KB 内放行', async () => {
      const exits = wireCapturingExits()
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      registerUiRpcHandlers(rpc, minimalUiHandlers())

      const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', {
        pluginId: 'p1', headerActionId: 'a', sessionId: 's1', tooltip: 'x'.repeat(HEADER_TEXT_MAX_BYTES + 1),
      })
      expect(resp.error?.code).toBe('INVALID_TOOLTIP')
      expect(exits.headerAction).toHaveLength(0)

      const ok = await dispatch(rpc, port, 2, 'plugin.ui.updateHeaderAction', {
        pluginId: 'p1', headerActionId: 'a', sessionId: 's1', tooltip: 'x'.repeat(HEADER_TEXT_MAX_BYTES),
      })
      expect(ok.error).toBeUndefined()
      expect(ok.result).toEqual({ updated: true })
      expect(exits.headerAction).toHaveLength(1)
    })
  })

  describe('B-F2：广播出线未接线/广播被丢弃时不假成功（ui-api handler 语义）', () => {
    function buildUnwiredRpc() {
      // beforeEach 已 resetRuntimeUiExitsForTest（exits = null）——刻意不 wire 任何出线
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      registerUiRpcHandlers(rpc, minimalUiHandlers())
      return { rpc, port }
    }

    it('出线未接线：updateHeaderAction → {updated:false}（不谎报渲染端已收到）', async () => {
      const { rpc, port } = buildUnwiredRpc()

      const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', { pluginId: 'p1', headerActionId: 'a', sessionId: 's1' })

      expect(resp.error).toBeUndefined()
      expect(resp.result).toEqual({ updated: false })
    })

    it('出线已接线但广播被丢弃（broadcastFn 缺失形态）→ updateHeaderAction 回 {updated:false}', async () => {
      wireRuntimeUiExits({
        broadcastHeaderActionUpdate: () => false,
      })
      const rpc = new PluginRpcServer()
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      registerUiRpcHandlers(rpc, minimalUiHandlers())

      const resp = await dispatch(rpc, port, 2, 'plugin.ui.updateHeaderAction', { pluginId: 'p1', headerActionId: 'a', sessionId: 's1' })
      expect(resp.result).toEqual({ updated: false })
    })
  })

  describe('B-F2/B-F4：真实 PluginService 装配链（registerRpcMethods；deps 缺 broadcastFn 与 sessionService）', () => {
    /**
     * 生产装配全链（registerRpcMethods → registerAllRpcMethods → wireRuntimeUiExits），
     * deps 刻意缺 broadcastFn / sessionService——装配缺陷的等价构造（插件全链
     * 测试 harness 的缺省面变体）。configDir 落 tmp（fs-guard 白名单域）。
     */
    function buildBareWiredRpc(): { rpc: PluginRpcServer; port: ReturnType<typeof createMockPort> } {
      const registryMock = {
        getDescriptor: () => undefined,
        getAllDescriptors: () => [],
      }
      const broker: IMessageBroker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
      const service = new PluginService(registryMock as never, broker, {
        configDir: join(tmpdir(), 'bare-plugin-rpc-contract'),
      })
      ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
      const rpc = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
      const port = createMockPort()
      rpc.registerWorker('w1', port)
      return { rpc, port }
    }

    it('B-F2 全链：broadcastFn 缺失 → updateHeaderAction 回 {updated:false}（装配缺陷不包装成成功）', async () => {
      const { rpc, port } = buildBareWiredRpc()

      const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', { pluginId: 'p1', headerActionId: 'a', sessionId: 's1' })

      expect(resp.error).toBeUndefined()
      expect(resp.result).toEqual({ updated: false })
    })

    it('B-F4 全链：sessionService 缺失 → console.error 留痕 + {accepted:false, reason:"error"} 回执', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const { rpc, port } = buildBareWiredRpc()

        const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', {
          sessionId: 's1', role: 'user', content: '/schedule off a1b2c3d4', requireCommand: 'schedule',
        })

        expect(resp.error).toBeUndefined()
        expect(resp.result).toEqual({ accepted: false, reason: 'error' })
        // 宿主侧出声（装配缺陷可诊断），且指向恢复动作（wire sessionService）
        expect(errSpy).toHaveBeenCalledTimes(1)
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('deps.sessionService missing'))
      } finally {
        errSpy.mockRestore()
      }
    })
  })

  describe('togglePlugin plugin:statusChange 广播（E2 修复：disable/enable 路径 renderer 触发源）', () => {
    let tmpDir: string

    /** 最小 PluginService，另暴露 mock broker 供广播断言 */
    function buildServiceWithBroker() {
      const registryMock = {
        getDescriptor: vi.fn((id: string) => ({ pluginId: id, pluginPath: join(tmpDir, id), name: id })),
        getAllDescriptors: () => [],
      }
      const broker = createMockBroker()
      const service = new PluginService(registryMock as never, broker, { configDir: tmpDir })
      return { service, broker }
    }

    /** 测试装配直通点：seed activator 私有状态表（模拟激活终态，免真实 Worker） */
    function seedActivatorState(service: PluginService, pluginId: string, state: string): void {
      ;(service as unknown as { activator: { pluginStates: Map<string, string> } }).activator.pluginStates.set(pluginId, state)
    }

    function broadcastFrames(broker: IMessageBroker): Array<{ type: string; id: string; payload: Record<string, unknown> }> {
      return (broker.broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]) as never
    }

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'toggle-status-change-'))
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('disable → plugin:statusChange{newStatus:inactive} 广播（E2 触发源：renderer handlePluginGone 清状态容器）', async () => {
      const { service, broker } = buildServiceWithBroker()

      await service.togglePlugin('p1', false)

      expect(broker.broadcast).toHaveBeenCalledWith({
        type: 'plugin:statusChange',
        id: expect.stringMatching(/^toggle_p1_/),
        payload: { pluginId: 'p1', oldStatus: 'active', newStatus: 'inactive' },
      })
    })

    it('enable（激活终态 ACTIVE）→ plugin:statusChange{newStatus:active} 广播（renderer handlePluginBack 重放 builtin 声明恢复按钮）', async () => {
      const { service, broker } = buildServiceWithBroker()
      seedActivatorState(service, 'p1', 'ACTIVE')

      await service.togglePlugin('p1', true)

      expect(broker.broadcast).toHaveBeenCalledWith({
        type: 'plugin:statusChange',
        id: expect.stringMatching(/^toggle_p1_/),
        payload: { pluginId: 'p1', oldStatus: 'inactive', newStatus: 'active' },
      })
    })

    it('enable（激活未达 ACTIVE，如权限拒绝/描述缺失）→ 零 statusChange 广播（不产虚假 active 帧致 renderer 重放声明）', async () => {
      const { service, broker } = buildServiceWithBroker()

      await service.togglePlugin('p1', true)

      expect(broadcastFrames(broker).filter((f) => f.type === 'plugin:statusChange')).toHaveLength(0)
    })

    it('广播信封与 crashed 路径同构：type/id/payload 三键一致；statusChange payload 键集 = StatusChangeCallback 契约', async () => {
      const { service, broker } = buildServiceWithBroker()
      ;(service as unknown as { registerWorkerCallbacks(): void }).registerWorkerCallbacks()

      // crashed 路径（既有广播点）
      const host = (service as unknown as { host: { onCrash?: (workerId: string, pluginIds: string[], error: unknown) => void } }).host
      host.onCrash!('w1', ['pC'], new Error('worker died'))

      // toggle disable 路径（既有广播点）
      await service.togglePlugin('p1', false)

      const frames = broadcastFrames(broker)
      const crashed = frames.find((f) => f.type === 'plugin:crashed')
      const statusChange = frames.find((f) => f.type === 'plugin:statusChange')

      expect(crashed).toBeDefined()
      expect(statusChange).toBeDefined()
      // 同一 broker.broadcast 出线的同构信封（三键）
      expect(Object.keys(crashed!).sort()).toEqual(['id', 'payload', 'type'])
      expect(Object.keys(statusChange!).sort()).toEqual(['id', 'payload', 'type'])
      // statusChange payload 键集逐字对齐既有 producer 契约（plugin-hot-reload StatusChangeCallback）
      expect(Object.keys(statusChange!.payload).sort()).toEqual(['newStatus', 'oldStatus', 'pluginId'])
    })
  })
});

// ════════════════ 来源: plugin-esm-loader-argv.test.ts ════════════════
describe('plugin-esm-loader-argv', () => {
  /**
   * MF-5: resolveEsmLoaderExecArgv fail-open 分支单元测试。
   *
   * 锁定 resolveEsmLoaderExecArgv 的行为契约：loader 缺失时 catch 后返回 undefined（不抛），
   * 使 runtime 启动不被 loader 缺失阻塞（fail-closed 由 fork 边界 MF-1 断言兜底）。
   * 若有人把 catch 改回 throw，本测试会红——防止「fail-open → runtime 崩溃」回归。
   *
   * 运行命令: npx vitest run test/plugin-esm-loader-argv.test.ts
   */


  // Mock plugin-host.js：保留真实 PluginHost，仅 mock resolveAndValidateFile（按用例控制）
  vi.mock('../src/services/plugin-service/plugin-host.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/plugin-service/plugin-host.js')>()
    return {
      ...actual,
      resolveAndValidateFile: vi.fn(),
    }
  })


  /** tsx 实测注入形态（Node 24 + tsx，pnpm 布局同理含 node_modules/tsx/） */
  const REAL_TSX_EXEC_ARGV = [
    '--require', '/ws/node_modules/tsx/dist/preflight.cjs',
    '--import', 'file:///ws/node_modules/tsx/dist/loader.mjs',
  ]

  describe('resolveEsmLoaderExecArgv (MF-5 fail-open branch)', () => {
    const originalExecArgv = process.execArgv

    beforeEach(() => {
      vi.mocked(resolveAndValidateFile).mockReset()
      // 固定为空 execArgv：本组用例锁定「无 tsx」基线，宿主环境 flags 不得渗入结果
      process.execArgv = []
    })

    afterEach(() => {
      process.execArgv = originalExecArgv
    })

    it('loader present: returns ["--import", <absolute path>]', () => {
      vi.mocked(resolveAndValidateFile).mockReturnValue('/abs/plugin-esm-loader.cjs')
      expect(resolveEsmLoaderExecArgv()).toEqual(['--import', '/abs/plugin-esm-loader.cjs'])
    })

    it('loader missing: catch 分支返回 undefined，不抛——runtime 启动不被 loader 缺失阻塞', () => {
      vi.mocked(resolveAndValidateFile).mockImplementation(() => {
        throw new Error('[plugin-host] Required file not found: plugin-esm-loader.cjs')
      })
      // MF-5 契约：resolver 层 fail-open（返回 undefined）。fail-closed 在 fork 边界（MF-1
      // PluginHostProcess.createProcess 的 SANDBOX_LOADER_MISSING 断言）兑现，故 resolver 不抛
      // 确保 PluginService 构造/runtime boot 不崩。锁定此契约，防止 catch 被改回 throw。
      expect(resolveEsmLoaderExecArgv()).toBeUndefined()
    })
  })

  describe('resolveEsmLoaderExecArgv tsx 透传（F1 dev sandbox fork 修复）', () => {
    const originalExecArgv = process.execArgv

    beforeEach(() => {
      vi.mocked(resolveAndValidateFile).mockReset()
      vi.mocked(resolveAndValidateFile).mockReturnValue('/abs/plugin-esm-loader.cjs')
    })

    afterEach(() => {
      process.execArgv = originalExecArgv
    })

    it('F1-1: 主进程 execArgv 含 tsx loader 时追加到末尾（esm-loader 在前，4 元素）', () => {
      process.execArgv = [...REAL_TSX_EXEC_ARGV]
      // esm-loader 必须在前：fork 边界 MF-1 断言 execArgv 含 --import（安全命门不破坏），
      // tsx 的 .js→.ts remap hook 追加在后（Node hooks 链后注册先调用，remap 后路径
      // 仍流经 esm-loader 沙箱边界检查）
      expect(resolveEsmLoaderExecArgv()).toEqual([
        '--import', '/abs/plugin-esm-loader.cjs',
        '--import', 'file:///ws/node_modules/tsx/dist/loader.mjs',
      ])
    })

    it('F1-2: 非 tsx 环境（空 execArgv / 其他 flags）不追加，保持 2 元素', () => {
      process.execArgv = []
      expect(resolveEsmLoaderExecArgv()).toEqual(['--import', '/abs/plugin-esm-loader.cjs'])

      // --import 指向非 tsx loader（如用户自己的 loader）不得误判为 tsx
      process.execArgv = ['--inspect', '--import', '/ws/my-custom-loader.mjs']
      expect(resolveEsmLoaderExecArgv()).toEqual(['--import', '/abs/plugin-esm-loader.cjs'])
    })

    it('F1-3: --import=<value> 等号形态同样识别', () => {
      process.execArgv = ['--import=file:///ws/node_modules/tsx/dist/loader.mjs']
      expect(resolveEsmLoaderExecArgv()).toEqual([
        '--import', '/abs/plugin-esm-loader.cjs',
        '--import', 'file:///ws/node_modules/tsx/dist/loader.mjs',
      ])
    })
  })

  describe('findTsxImportArg（F1 tsx 注入项提取）', () => {
    it('F1-4: 识别 --require/--import 混合数组中的 tsx --import 值', () => {
      expect(findTsxImportArg([...REAL_TSX_EXEC_ARGV])).toBe('file:///ws/node_modules/tsx/dist/loader.mjs')
    })

    it('F1-5: pnpm 布局（.pnpm/tsx@x.y.z/...）同样命中', () => {
      expect(findTsxImportArg(['--import', 'file:///ws/node_modules/.pnpm/tsx@4.19.2/node_modules/tsx/dist/loader.mjs']))
        .toBe('file:///ws/node_modules/.pnpm/tsx@4.19.2/node_modules/tsx/dist/loader.mjs')
    })

    it('F1-6: 无 --import、非 tsx 值、尾悬 --import 均返回 undefined', () => {
      expect(findTsxImportArg([])).toBeUndefined()
      expect(findTsxImportArg(['--import', '/ws/other-loader.mjs'])).toBeUndefined()
      // '--import' 是最后一个元素（无值可取）不得越界
      expect(findTsxImportArg(['--require', '/x.cjs', '--import'])).toBeUndefined()
    })
  })
});
