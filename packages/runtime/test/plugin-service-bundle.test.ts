import type { IMessageBroker } from '../src/interfaces.js';
import { createCommandsApi, registerCommandRpcHandlers } from '../src/services/plugin-service/api/commands-api.js';
import { SessionEventDispatch, registerSessionRpcHandlers } from '../src/services/plugin-service/api/session-api.js';
import { registerUiRpcHandlers, resetRuntimeUiExitsForTest, wireRuntimeUiExits } from '../src/services/plugin-service/api/ui-api.js';
import { createViewsApi, registerViewRpcHandlers } from '../src/services/plugin-service/api/views-api.js';
import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js';
import { resolveAndValidateFile } from '../src/services/plugin-service/plugin-host.js';
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js';
import { PluginRpcClient } from '../src/services/plugin-service/plugin-rpc-client.js';
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js';
import { clearActiveSessionCache } from '../src/services/plugin-service/plugin-rpc-setup.js';
import { PluginService, findTsxImportArg, resolveEsmLoaderExecArgv } from '../src/services/plugin-service/plugin-service.js';
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js';
import { PluginUiSnapshotStore } from '../src/services/plugin-service/plugin-ui-snapshot-store.js';
import { PluginMessageHandler } from '../src/transport/plugin-message-handler.js';
import type { HeaderActionUpdatePayload } from '@taiji/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/plugin-service.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
import type { ISessionService } from '../src/interfaces.js';
import type { CommandRegistration } from '../src/services/plugin-service/api/commands-api.js';
import type { SessionHandlers } from '../src/services/plugin-service/api/session-api.js';
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js';
import type { ClientPort } from '../src/services/plugin-service/plugin-rpc-client.js';
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js';
import type { IPluginServiceDeps } from '../src/services/plugin-service/plugin-types.js';
import type { ClientMessage, PluginUiSnapshotPayload, SessionGroup, SessionSummary, ViewSnapshotItem } from '@taiji/shared';
import type { HookContext } from '../src/services/plugin-service/plugin-types.js';
import type { PluginModule } from '../src/services/plugin-service/plugin-types.js';
import type { TaijiPackageJson } from '../src/services/plugin-service/plugin-types.js';
import type { PluginContext } from '../src/services/plugin-service/plugin-types.js';
describe('plugin-service', () => {
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
});

// ======================================================================
// ← test/plugin-activator.test.ts
// ======================================================================

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'test-plugin',
    version: '1.0.0',
    displayName: 'Test Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/test-plugin',
    // 默认 built-in：正常激活路径 fixture（激活锁只锁 external，见下方锁语义 describe）。
    // 锁语义用例显式传 source: 'external'。
    source: 'built-in',
    extensionDependencies: [],
    ...overrides,
  }
}


/**
 * 创建 mock PluginHost。
 * postMessage 被调用后，在 microtask 中通过 activator.handleWorkerReply 模拟 Worker 回复。
 */
function createMockHost(
  activator: PluginActivator,
  replyType: 'activated' | 'deactivated' = 'activated',
): ActivatorHost {
  let currentPluginId = 'test-plugin'

  return {
    assignWorker: vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') => {
      return Promise.resolve('worker-1')
    }),
    loadPlugin: vi.fn((_workerId: string, _pluginPath: string) => {
      return Promise.resolve()
    }),
    getWorkerHandle: vi.fn((pluginId: string) => {
      currentPluginId = pluginId
      return {
        workerId: 'worker-1',
        postMessage: vi.fn(() => {
          // 模拟 Worker 回复
          queueMicrotask(() => {
            activator.handleWorkerReply({
              type: replyType,
              pluginId,
            })
          })
        }),
      }
    }),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}


/**
 * 沉默 host：postMessage 后 Worker 不回复（activate 超时路径用——回复型 mock 会在
 * microtask 内 resolve，永远走不到超时 timer）。
 */
function createSilentHost(): ActivatorHost {
  return {
    assignWorker: vi.fn(() => Promise.resolve('worker-1')),
    loadPlugin: vi.fn(() => Promise.resolve()),
    getWorkerHandle: vi.fn(() => ({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-activator', () => {
describe('PluginActivator', () => {
  // ── TC-4-01: registerDescriptors builds eventMap ──────────────
  it('TC-4-01: registerDescriptors builds eventMap and handles getActivePlugins', () => {
    const activator = new PluginActivator()
    const desc1 = makeDescriptor({
      pluginId: 'p1',
      activationEvents: ['onStartupFinished', 'onSlashCommand:hello'],
    })
    const desc2 = makeDescriptor({
      pluginId: 'p2',
      activationEvents: ['onSlashCommand:hello'],
    })

    activator.registerDescriptors([desc1, desc2])

    // 注册后，两个插件都应处于 UNLOADED 状态
    expect(activator.getState('p1')).toBe('UNLOADED')
    expect(activator.getState('p2')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  // ── TC-4-02: handleEvent matches activationEvents ─────────────
  it('TC-4-02: handleEvent matches activationEvents', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'slash-plugin',
      activationEvents: ['onSlashCommand:hello'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    // 匹配的事件应触发激活
    await activator.handleEvent(
      { type: 'onSlashCommand', command: 'hello' },
      host,
    )

    // 激活流程完成（mock host 立即回复 'activated'）
    expect(activator.getState('slash-plugin')).toBe('ACTIVE')
  })

  // ── TC-4-03: activatePlugin sets state to ACTIVE ──────────────
  it('TC-4-03: activatePlugin sets state to ACTIVE', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'act-test' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    expect(activator.getState('act-test')).toBe('UNLOADED')

    await activator.activatePlugin('act-test', { type: 'onStartupFinished' }, host)

    expect(activator.getState('act-test')).toBe('ACTIVE')
    expect(activator.getActivePlugins()).toEqual(['act-test'])
  })

  // ── TC-4-04: deactivatePlugin sets state to UNLOADED ──────────
  it('TC-4-04: deactivatePlugin sets state to UNLOADED', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'deact-test' })
    activator.registerDescriptors([desc])

    // 先激活
    const activateHost = createMockHost(activator, 'activated')
    await activator.activatePlugin('deact-test', { type: 'onStartupFinished' }, activateHost)
    expect(activator.getState('deact-test')).toBe('ACTIVE')

    // 再停用
    const deactivateHost = createMockHost(activator, 'deactivated')
    await activator.deactivatePlugin('deact-test', deactivateHost)
    expect(activator.getState('deact-test')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  // ── 幂等：重复激活应跳过 ──────────────────────────────────────
  it('activatePlugin is idempotent (skip if already ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'idempotent-test' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('idempotent-test', { type: 'onStartupFinished' }, host)
    expect(activator.getState('idempotent-test')).toBe('ACTIVE')

    // 第二次激活应直接跳过（assignWorker 不应被再次调用）
    const assignCallsBefore = (host.assignWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await activator.activatePlugin('idempotent-test', { type: 'onStartupFinished' }, host)
    const assignCallsAfter = (host.assignWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(assignCallsAfter).toBe(assignCallsBefore)
  })

  // ── Worker 回复 error 时状态应为 UNLOADED ─────────────────────
  it('activatePlugin sets UNLOADED when worker replies error', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'error-test' })
    activator.registerDescriptors([desc])

    // 创建一个 host，其 postMessage 触发 error 回复
    const errorHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('worker-1')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'worker-1',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            activator.handleWorkerReply({
              type: 'error',
              pluginId,
              error: 'activation failed',
            })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    await activator.activatePlugin('error-test', { type: 'onStartupFinished' }, errorHost)
    expect(activator.getState('error-test')).toBe('UNLOADED')
  })

  // ── deactivatePlugin 对未激活插件是 no-op ─────────────────────
  it('deactivatePlugin is no-op for UNLOADED plugins', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([makeDescriptor({ pluginId: 'no-op-test' })])

    const host = createMockHost(activator, 'deactivated')
    expect(activator.getState('no-op-test')).toBe('UNLOADED')

    await activator.deactivatePlugin('no-op-test', host)
    expect(activator.getState('no-op-test')).toBe('UNLOADED')
  })

  // ── deactivateAll 停用所有已激活插件 ──────────────────────────
  it('deactivateAll deactivates all active plugins', async () => {
    const activator = new PluginActivator()
    const desc1 = makeDescriptor({ pluginId: 'all-1', activationEvents: ['onStartupFinished'] })
    const desc2 = makeDescriptor({ pluginId: 'all-2', activationEvents: ['onStartupFinished'] })
    activator.registerDescriptors([desc1, desc2])

    const host1 = createMockHost(activator, 'activated')
    const host2 = createMockHost(activator, 'activated')

    await activator.activatePlugin('all-1', { type: 'onStartupFinished' }, host1)
    await activator.activatePlugin('all-2', { type: 'onStartupFinished' }, host2)
    expect(activator.getActivePlugins().length).toBe(2)

    const deactHost = createMockHost(activator, 'deactivated')
    await activator.deactivateAll(deactHost)
    expect(activator.getActivePlugins().length).toBe(0)
    expect(activator.getState('all-1')).toBe('UNLOADED')
    expect(activator.getState('all-2')).toBe('UNLOADED')
  })

  // ── handleEvent 不匹配时不会激活 ──────────────────────────────
  it('handleEvent does not activate when event does not match', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'no-match',
      activationEvents: ['onSlashCommand:hello'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.handleEvent(
      { type: 'onSlashCommand', command: 'other' },
      host,
    )

    expect(activator.getState('no-match')).toBe('UNLOADED')
  })

  // ── 未知插件 activatePlugin 是 no-op ─────────────────────────
  it('activatePlugin is no-op for unknown pluginId', async () => {
    const activator = new PluginActivator()
    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('nonexistent', { type: 'onStartupFinished' }, host)
    expect(activator.getState('nonexistent')).toBe(undefined)
  })
})
describe('external plugin activation hard lock（§6.6 激活侧，IF3）', () => {
  // ── TC-A: external + 开关 true（sandbox 闭环已落地）→ 正常激活 ────────
  it('TC-A: external plugin + EXTERNAL_PLUGIN_ENABLED=true（翻转后）→ 正常激活 (assignWorker called, state ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'ext-allowed', source: 'external' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    // 翻转后：external 来源不再被硬锁跳过（sandbox 子进程 + ESM loader 兜底隔离，
    // 见 plugin-security.ts [翻转记录]）。开关回退 false 时本 guard 重新生效（fail-closed）。
    await activator.activatePlugin('ext-allowed', { type: 'onStartupFinished' }, host)

    // 正常进入激活路径
    expect(activator.getState('ext-allowed')).toBe('ACTIVE')
    expect(host.assignWorker).toHaveBeenCalledTimes(1)
    expect(host.loadPlugin).toHaveBeenCalledTimes(1)
  })

  // ── TC-B: built-in 来源不受影响，正常激活 ─────────────────────
  it('TC-B: built-in plugin unaffected → normal activation path (assignWorker called, state ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'builtin-ok', source: 'built-in' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('builtin-ok', { type: 'onStartupFinished' }, host)

    expect(activator.getState('builtin-ok')).toBe('ACTIVE')
    expect(host.assignWorker).toHaveBeenCalled()
    expect(host.loadPlugin).toHaveBeenCalled()
  })
})
describe('activate 超时覆盖参数（timeout-plugin-service D4：控制范围 30s 保持 + activateTimeoutMs 逃生门）', () => {
  const flushAsync = () => new Promise<void>((r) => setImmediate(r))

  it('激活在途 loadPlugin 被拒 + markCrashed 连坐 → 终态 CRASHED（非 UNLOADED）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      activator.registerDescriptors([makeDescriptor({ pluginId: 'collateral-load' })])

      let rejectLoad!: (err: Error) => void
      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        // load 挂起：模拟死循环插件卡死 Worker 后本插件 load 未获回复
        loadPlugin: vi.fn(() => new Promise<void>((_, reject) => { rejectLoad = reject })),
        getWorkerHandle: vi.fn(() => ({
          workerId: 'worker-1',
          postMessage: vi.fn(),
        })),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }

      const pending = activator.activatePlugin('collateral-load', { type: 'onStartupFinished' }, host)
      await flushAsync()
      expect(host.loadPlugin).toHaveBeenCalledTimes(1)

      // 同宿主 load 超时 crash 链连坐：markCrashed 先落地
      activator.markCrashed('collateral-load')
      rejectLoad(new Error('loadPlugin timeout for worker worker-1 after 10000ms'))
      await pending

      expect(activator.getState('collateral-load')).toBe('CRASHED')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('激活在途中 crash 清理句柄（getWorkerHandle undefined）→ 终态 CRASHED（非 UNLOADED）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      activator.registerDescriptors([makeDescriptor({ pluginId: 'collateral-handle' })])

      let resolveLoad!: () => void
      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        loadPlugin: vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve })),
        // crash 链 removeIndexEntries 后句柄已清理：激活醒来时拿不到 handle
        getWorkerHandle: vi.fn(() => undefined),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }

      const pending = activator.activatePlugin('collateral-handle', { type: 'onStartupFinished' }, host)
      await flushAsync()

      // crash 连坐先落地，load 回复再唤醒挂起中的激活
      activator.markCrashed('collateral-handle')
      resolveLoad()
      await pending

      expect(activator.getState('collateral-handle')).toBe('CRASHED')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('激活在途中 crash 后 activate 握手收到 error 回复 → 终态 CRASHED（非 UNLOADED）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      activator.registerDescriptors([makeDescriptor({ pluginId: 'collateral-handshake' })])

      let resolveLoad!: () => void
      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        loadPlugin: vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve })),
        // Worker 已被 crash 链 terminate：activate 消息无人应答（postMessage 空），
        // 握手结局由迟到 error 回复 resolve(false) 收敛（handleWorkerReply 路径）
        getWorkerHandle: vi.fn(() => ({
          workerId: 'worker-1',
          postMessage: vi.fn(),
        })),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }

      const pending = activator.activatePlugin('collateral-handshake', { type: 'onStartupFinished' }, host)
      await flushAsync()

      activator.markCrashed('collateral-handshake')
      resolveLoad()
      await flushAsync()
      // 挂在 activate 握手上后，注入 error 回复（resolve(false) → 失败终态写点）
      activator.handleWorkerReply({ type: 'error', pluginId: 'collateral-handshake', error: 'worker terminated' })
      await pending

      expect(activator.getState('collateral-handshake')).toBe('CRASHED')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('对照组（无 crash 连坐）：同样的 load 失败路径仍落 UNLOADED（合法语义不回退）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      activator.registerDescriptors([makeDescriptor({ pluginId: 'plain-fail' })])

      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        loadPlugin: vi.fn(() => Promise.reject(new Error('module not found'))),
        getWorkerHandle: vi.fn(() => ({
          workerId: 'worker-1',
          postMessage: vi.fn(),
        })),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }

      await activator.activatePlugin('plain-fail', { type: 'onStartupFinished' }, host)

      expect(activator.getState('plain-fail')).toBe('UNLOADED')
    } finally {
      errSpy.mockRestore()
    }
  })
})
// ══════════════════════════════════════════════════════════════════
// scan→activate 全链 + error 恢复重激活（自 plugin-integration.test.ts 归并；
// TC-int-02「storage round-trip through RPC」未随迁——其 getMethod/setMethod 是
// 测试文件内定义的函数直调 storage，未经 rpcServer.dispatch，与 plugin-storage.test.ts
// TC-5-01/04 同质零增量；RPC 层真实覆盖在 plugin-injection-guard.test.ts）
// ══════════════════════════════════════════════════════════════════

describe('plugin-integration 归并：scan 发现 + 激活全链 + error 恢复', () => {
  let tmpDir: string

  beforeAll(async () => {
    const { mkdtemp, mkdir, cp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join, resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const FIXTURES_DIR = resolve(__dirname, 'fixtures/plugins')
    tmpDir = await mkdtemp(join(tmpdir(), 'plugin-integration-test-'))
    const pluginDir = join(tmpDir, 'resources', 'plugins', 'hello-world')
    // resources/plugins 目录由 registry 映射为 built-in（plugin-registry.ts 第三项），
    // 避免激活锁（IF3 只锁 external）跳过本集成流程的激活步骤。
    await mkdir(pluginDir, { recursive: true })
    await cp(join(FIXTURES_DIR, 'hello-world'), pluginDir, { recursive: true })
  })

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('TC-int-01: registry.scan 发现 → 注册 → 事件激活 → 停用全链', async () => {
    const { PluginRegistry } = await import('../src/services/plugin-service/plugin-registry.js')
    const registry = new PluginRegistry(tmpDir, tmpDir)
    const activator = new PluginActivator()
    // 全链 host 需区分 activate/deactivate 回复（createMockHost 恒回 activated，deactivate 会挂起）
    const host: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('mock-worker-1')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'mock-worker-1',
        postMessage: vi.fn((msg: unknown) => {
          const m = msg as { type: string; pluginId?: string }
          if (m.type === 'activate') {
            queueMicrotask(() => activator.handleWorkerReply({ type: 'activated', pluginId }))
          } else if (m.type === 'deactivate') {
            queueMicrotask(() => activator.handleWorkerReply({ type: 'deactivated', pluginId }))
          }
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    // 1. 扫描发现插件（descriptor 形态断言：scan 发现链唯一覆盖点）
    const descriptors = await registry.scan()
    expect(descriptors.length >= 1).toBeTruthy()
    const hw = descriptors.find(d => d.pluginId === 'hello-world')!
    expect(hw).toBeTruthy()
    expect(hw.trustLevel).toBe('trusted')
    expect(hw.activationEvents.includes('onStartupFinished')).toBeTruthy()

    // 2. 注册描述符 + 事件触发激活
    activator.registerDescriptors(descriptors)
    expect(activator.getState('hello-world')).toBe('UNLOADED')

    await activator.handleEvent({ type: 'onStartupFinished' }, host)
    expect(activator.getState('hello-world')).toBe('ACTIVE')
    expect(activator.getActivePlugins()).toEqual(['hello-world'])

    // 3. slash command 触发已激活插件（幂等）
    await activator.handleEvent({ type: 'onSlashCommand', command: 'hello' }, host)
    expect(activator.getState('hello-world')).toBe('ACTIVE')

    // 4. 停用
    await activator.deactivatePlugin('hello-world', host)
    expect(activator.getState('hello-world')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  it('TC-int-03: error 恢复——激活失败 UNLOADED 后可重新激活到 ACTIVE', async () => {
    const crashActivator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'crash-plugin',
      trustLevel: 'sandbox',
      pluginPath: '/tmp/crash-plugin',
    })

    crashActivator.registerDescriptors([desc])

    // 模拟 Worker 在 activate 时回复 error
    const errorHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('crash-worker')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'crash-worker',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            crashActivator.handleWorkerReply({
              type: 'error',
              pluginId,
              error: 'Worker crashed during activation',
            })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    await crashActivator.activatePlugin('crash-plugin', { type: 'onStartupFinished' }, errorHost)

    // 状态应该是 UNLOADED（不是 ACTIVE）——error 不产生 CRASHED 终态
    expect(crashActivator.getState('crash-plugin')).toBe('UNLOADED')
    expect(crashActivator.getActivePlugins().length).toBe(0)

    // 可以重新尝试激活（恢复）——error 后 recovery 重激活是本用例独有增量
    const recoveryHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('recovery-worker')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'recovery-worker',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            crashActivator.handleWorkerReply({ type: 'activated', pluginId })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    await crashActivator.activatePlugin('crash-plugin', { type: 'onStartupFinished' }, recoveryHost)
    expect(crashActivator.getState('crash-plugin')).toBe('ACTIVE')
  })
})
});

// ======================================================================
// ← test/plugin-message-handler.test.ts
// ======================================================================

interface CapturedReply {
  id: string | undefined
  type: string
  payload: Record<string, unknown>
}


interface CapturedError {  // oe-exempt:20261027:test:
  code: string
  message: string
  id: string | undefined
}


/** 构造 mock ctx + 捕获 reply/error。pluginService 各方法可按用例 override（未给的为 vi.fn()）。 */
function makeHandler(pluginServiceMethods: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const replies: CapturedReply[] = []
  const errors: CapturedError[] = []
  const pluginService = {
    getDiscoveredPlugins: vi.fn().mockReturnValue([]),
    togglePlugin: vi.fn().mockResolvedValue([]),
    uninstallPlugin: vi.fn().mockResolvedValue([]),
    approvePermissions: vi.fn().mockResolvedValue(undefined),
    revokePermissions: vi.fn().mockResolvedValue(undefined),
    denyPermissions: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    getPluginConfig: vi.fn().mockResolvedValue({}),
    setPluginConfig: vi.fn().mockResolvedValue(undefined),
    installPlugin: vi.fn().mockResolvedValue({ success: true }),
    handleUiResponse: vi.fn(),
    syncMountPoints: vi.fn(),
    // provider-plugin-access D9 / D8 / U5
    invokePlugin: vi.fn().mockResolvedValue(undefined),
    deliverPluginUiEvent: vi.fn().mockResolvedValue(undefined),
    listAvailablePlugins: vi.fn().mockResolvedValue({ plugins: [] }),
    getPluginCatalog: vi.fn().mockResolvedValue({ entries: [] }),
    ...pluginServiceMethods,
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id: string | undefined) => {
      errors.push({ code, message, id })
    }),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      replies.push({ id, type, payload })
    }),
    pluginService,
  }
  const handler = new PluginMessageHandler(ctx as unknown as ConstructorParameters<typeof PluginMessageHandler>[0])
  return { replies, errors, handler, pluginService }
}


function buildMsg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS = {} as never

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-message-handler', () => {
describe('PluginMessageHandler — 前置检查（D3）', () => {
  it('pluginService 为 null → sendError handler_error，不触分发表', async () => {
    const { replies, errors, pluginService } = makeHandler()
    const nullCtx = {
      send: vi.fn(),
      sendError: vi.fn((_ws: unknown, code: string, message: string, id: string | undefined) => {
        errors.push({ code, message, id })
      }),
      reply: vi.fn(),
      pluginService: null,
    }
    const handler = new PluginMessageHandler(nullCtx as unknown as ConstructorParameters<typeof PluginMessageHandler>[0])
    await handler.handlePluginMessage(buildMsg('plugin.list', {}), WS)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'handler_error', message: 'Plugin service not available', id: 'm1' })
    expect(replies).toHaveLength(0)
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
  })
})
describe('PluginMessageHandler — 查询/操作类 case', () => {
  it('plugin.list → reply config.plugins {plugins}', async () => {
    const plugins = [{ id: 'p1' }]
    const { replies, handler, pluginService } = makeHandler({ getDiscoveredPlugins: vi.fn().mockReturnValue(plugins) })
    await handler.handlePluginMessage(buildMsg('plugin.list', {}), WS)
    expect(pluginService.getDiscoveredPlugins).toHaveBeenCalledTimes(1)
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins } }])
  })

  it('plugin.toggle → togglePlugin(pluginId, enabled) + reply config.plugins（toggled 返回值）', async () => {
    const toggled = [{ id: 'p2', enabled: false }]
    const { replies, handler, pluginService } = makeHandler({ togglePlugin: vi.fn().mockResolvedValue(toggled) })
    await handler.handlePluginMessage(buildMsg('plugin.toggle', { pluginId: 'p2', enabled: false }), WS)
    expect(pluginService.togglePlugin).toHaveBeenCalledWith('p2', false)
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins: toggled } }])
  })

  it('plugin.uninstall → uninstallPlugin + reply config.plugins', async () => {
    const uninstalled = [{ id: 'p3' }]
    const { replies, handler, pluginService } = makeHandler({ uninstallPlugin: vi.fn().mockResolvedValue(uninstalled) })
    await handler.handlePluginMessage(buildMsg('plugin.uninstall', { pluginId: 'p3' }), WS)
    expect(pluginService.uninstallPlugin).toHaveBeenCalledWith('p3')
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins: uninstalled } }])
  })

  it('plugin.approvePermissions → approvePermissions + reply pong（列表刷新经广播，不现算）', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.approvePermissions', { pluginId: 'p4', permissions: ['fs:read'] }), WS)
    expect(pluginService.approvePermissions).toHaveBeenCalledWith('p4', ['fs:read'])
    // reply = pong ack（对齐 plugin.executeCommand 先例）；插件列表刷新由
    // plugin-service.approvePermissions 广播 config.plugins 承担，handler 不再现算
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('plugin.revokePermissions → revokePermissions + reply pong（无列表刷新广播）', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.revokePermissions', { pluginId: 'p5' }), WS)
    expect(pluginService.revokePermissions).toHaveBeenCalledWith('p5')
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('plugin.denyPermissions → denyPermissions + reply pong（拒绝本次申请，不回收已授权限）', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.denyPermissions', { pluginId: 'p5' }), WS)
    expect(pluginService.denyPermissions).toHaveBeenCalledWith('p5')
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('plugin.executeCommand → executeCommand + reply pong {}', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.executeCommand', { pluginId: 'p6', commandId: 'cmd1', args: { a: 1 } }), WS)
    expect(pluginService.executeCommand).toHaveBeenCalledWith('p6', 'cmd1', { a: 1 })
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('E6: args 含非标量值 → INVALID_ARGS error envelope，不 dispatch handler', async () => {
    const { replies, errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.executeCommand', { pluginId: 'p6', commandId: 'cmd1', args: { nested: { x: 1 } } }), WS)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS', id: 'm1' })
    expect(pluginService.executeCommand).not.toHaveBeenCalled()
    expect(replies).toHaveLength(0)
  })

  it('E6: args 数组形态同样拒绝（非 flat scalar record）', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.executeCommand', { pluginId: 'p6', commandId: 'cmd1', args: ['a'] }), WS)
    expect(errors[0]?.code).toBe('INVALID_ARGS')
    expect(pluginService.executeCommand).not.toHaveBeenCalled()
  })

  it('plugin.uiResponse → handleUiResponse(requestId, result) + reply pong {}', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.uiResponse', { requestId: 'req-9', result: { ok: true } }), WS)
    expect(pluginService.handleUiResponse).toHaveBeenCalledWith('req-9', { ok: true })
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })

  it('plugin.mountPoints.sync → syncMountPoints（覆盖式整表）+ reply pong {}', async () => {
    const { replies, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.mountPoints.sync', { mountPoints: ['a', 'b'] }), WS)
    expect(pluginService.syncMountPoints).toHaveBeenCalledWith(['a', 'b'])
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])
  })
})
describe('PluginMessageHandler — plugin.invoke / plugin.uiEvent / 清单域（provider-plugin-access D8/D9/U5）', () => {
  it('plugin.invoke → invokePlugin(pluginId, method, params) + reply plugin.invoke { result }', async () => {
    const { replies, handler, pluginService } = makeHandler({
      invokePlugin: vi.fn().mockResolvedValue({ loggedIn: true }),
    })
    await handler.handlePluginMessage(buildMsg('plugin.invoke', {
      pluginId: 'wool-workbuddy',
      method: 'getStatus',
      params: { providerId: 'wool-workbuddy' },
    }), WS)
    expect(pluginService.invokePlugin).toHaveBeenCalledWith('wool-workbuddy', 'getStatus', { providerId: 'wool-workbuddy' })
    expect(replies).toEqual([{ id: 'm1', type: 'plugin.invoke', payload: { result: { loggedIn: true } } }])
  })

  it('plugin.invoke method 缺失/空串 → INVALID_ARGS，不触执行链', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.invoke', { pluginId: 'p1', method: '' }), WS)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS', id: 'm1' })
    expect(pluginService.invokePlugin).not.toHaveBeenCalled()
  })

  it('plugin.uiEvent 合法值（标量 / 两层容器）→ deliverPluginUiEvent 原样透传 + reply pong', async () => {
    const { replies, handler, pluginService } = makeHandler()
    // 深度 2 容器（root + 一层）+ 标量叶子 + 标量本身，两种形态都合法
    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy',
      viewId: 'authorize',
      componentId: 'pat',
      event: 'change',
      value: { form: { token: 'abc', remember: true } },
    }), WS)
    expect(pluginService.deliverPluginUiEvent).toHaveBeenCalledWith(
      'wool-workbuddy', 'authorize', 'pat', 'change', { form: { token: 'abc', remember: true } },
    )
    expect(replies).toEqual([{ id: 'm1', type: 'pong', payload: {} }])

    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy', viewId: 'authorize', componentId: 'pat', event: 'change', value: 'scalar-token',
    }), WS)
    expect(pluginService.deliverPluginUiEvent).toHaveBeenCalledTimes(2)
  })

  it('plugin.uiEvent 值深度 > 2 → INVALID_ARGS，不投递（D8 形状校验）', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy',
      viewId: 'authorize',
      componentId: 'pat',
      event: 'change',
      value: { a: { b: { c: 'too-deep' } } },
    }), WS)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS', id: 'm1' })
    expect(errors[0]?.message).toContain('at most 2 levels')
    expect(pluginService.deliverPluginUiEvent).not.toHaveBeenCalled()
  })

  it('plugin.uiEvent 非标量叶子（函数等）→ INVALID_ARGS，不投递', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy',
      viewId: 'authorize',
      componentId: 'pat',
      event: 'change',
      value: { cb: () => undefined },
    }), WS)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS' })
    expect(pluginService.deliverPluginUiEvent).not.toHaveBeenCalled()
  })

  it('plugin.uiEvent 路由字段缺失 → INVALID_ARGS（componentId / event 非空字符串）', async () => {
    const { errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.uiEvent', {
      pluginId: 'wool-workbuddy', viewId: 'authorize', componentId: '', event: 'change', value: 'x',
    }), WS)
    expect(errors[0]).toMatchObject({ code: 'INVALID_ARGS' })
    expect(pluginService.deliverPluginUiEvent).not.toHaveBeenCalled()
  })

  it('plugin.listAvailable / plugin.catalog → reply 同名帧（清单 service 回复透传）', async () => {
    const available = { plugins: [{ packageName: '@acme/plugin-wool-workbuddy', pluginId: 'wool-workbuddy', displayName: 'WorkBuddy', pluginVersion: '1.0.0', installed: false }] }
    const catalog = { entries: [{ packageName: '@acme/plugin-wool-workbuddy', pluginId: 'wool-workbuddy', displayName: 'WorkBuddy', pluginVersion: '1.0.0' }] }
    const { replies, handler } = makeHandler({
      listAvailablePlugins: vi.fn().mockResolvedValue(available),
      getPluginCatalog: vi.fn().mockResolvedValue(catalog),
    })

    await handler.handlePluginMessage(buildMsg('plugin.listAvailable', {}), WS)
    await handler.handlePluginMessage(buildMsg('plugin.catalog', {}), WS)

    expect(replies).toEqual([
      { id: 'm1', type: 'plugin.listAvailable', payload: available },
      { id: 'm1', type: 'plugin.catalog', payload: catalog },
    ])
  })
})
describe('PluginMessageHandler — plugin.config.*', () => {
  it('config.get 带 key → reply plugin:config 单键包装', async () => {
    // key 路径：getPluginConfig(pluginId, key) 返回该 key 的值，handler 包装为 { [key]: value }
    const { replies, handler, pluginService } = makeHandler({ getPluginConfig: vi.fn().mockResolvedValue('dark') })
    await handler.handlePluginMessage(buildMsg('plugin.config.get', { pluginId: 'p7', key: 'theme' }), WS)
    expect(pluginService.getPluginConfig).toHaveBeenCalledWith('p7', 'theme')
    expect(replies).toEqual([{ id: 'm1', type: 'plugin:config', payload: { pluginId: 'p7', config: { theme: 'dark' } } }])
  })

  it('config.get key 缺省 → __all__ 整包路径（config 原样返回）', async () => {
    const allConfig = { theme: 'dark', level: 2 }
    const { replies, handler, pluginService } = makeHandler({ getPluginConfig: vi.fn().mockResolvedValue(allConfig) })
    await handler.handlePluginMessage(buildMsg('plugin.config.get', { pluginId: 'p7' }), WS)
    expect(pluginService.getPluginConfig).toHaveBeenCalledWith('p7', undefined)
    expect(replies).toEqual([{ id: 'm1', type: 'plugin:config', payload: { pluginId: 'p7', config: allConfig } }])
  })

  it('config.set → setPluginConfig + getPluginConfig 全量回读 + reply plugin:config', async () => {
    const allConfig = { key1: 'v1' }
    const { replies, handler, pluginService } = makeHandler({ getPluginConfig: vi.fn().mockResolvedValue(allConfig) })
    await handler.handlePluginMessage(buildMsg('plugin.config.set', { pluginId: 'p8', key: 'key1', value: 'v1' }), WS)
    expect(pluginService.setPluginConfig).toHaveBeenCalledWith('p8', 'key1', 'v1')
    expect(pluginService.getPluginConfig).toHaveBeenCalledTimes(1)
    expect(pluginService.getPluginConfig).toHaveBeenCalledWith('p8')
    expect(replies).toEqual([{ id: 'm1', type: 'plugin:config', payload: { pluginId: 'p8', config: allConfig } }])
  })
})
describe('PluginMessageHandler — plugin.install 三分支', () => {
  it('packageSpec 缺失 → sendError invalid_params Missing packageSpec，不调 installPlugin', async () => {
    const { replies, errors, handler, pluginService } = makeHandler()
    await handler.handlePluginMessage(buildMsg('plugin.install', {}), WS)
    expect(errors).toEqual([{ code: 'invalid_params', message: 'Missing packageSpec', id: 'm1' }])
    expect(replies).toHaveLength(0)
    expect(pluginService.installPlugin).not.toHaveBeenCalled()
  })

  it('安装成功 → reply config.plugins（重取 discovered）', async () => {
    const discovered = [{ id: 'p9' }]
    const { replies, errors, handler, pluginService } = makeHandler({
      installPlugin: vi.fn().mockResolvedValue({ success: true }),
      getDiscoveredPlugins: vi.fn().mockReturnValue(discovered),
    })
    await handler.handlePluginMessage(buildMsg('plugin.install', { packageSpec: 'spec-1' }), WS)
    expect(pluginService.installPlugin).toHaveBeenCalledWith('spec-1')
    expect(replies).toEqual([{ id: 'm1', type: 'config.plugins', payload: { plugins: discovered } }])
    expect(errors).toHaveLength(0)
  })

  it('安装失败 → sendError install_failed（result.error 透传）', async () => {
    const { replies, errors, handler, pluginService } = makeHandler({
      installPlugin: vi.fn().mockResolvedValue({ success: false, error: 'registry unreachable' }),
    })
    await handler.handlePluginMessage(buildMsg('plugin.install', { packageSpec: 'spec-2' }), WS)
    expect(errors).toEqual([{ code: 'install_failed', message: 'registry unreachable', id: 'm1' }])
    expect(replies).toHaveLength(0)
  })

  it('安装失败且 error 缺省 → sendError install_failed Install failed（兜底文案）', async () => {
    const { errors, handler } = makeHandler({
      installPlugin: vi.fn().mockResolvedValue({ success: false }),
    })
    await handler.handlePluginMessage(buildMsg('plugin.install', { packageSpec: 'spec-3' }), WS)
    expect(errors).toEqual([{ code: 'install_failed', message: 'Install failed', id: 'm1' }])
  })
})
describe('PluginMessageHandler — 落空语义与 handles 清单', () => {
  it('未知 type（不在分发表）→ sendError(handler_not_registered)：无 service 调用、无 reply（RT-1#6 显形）', async () => {
    const { replies, errors, handler, pluginService } = makeHandler()
    await expect(handler.handlePluginMessage(buildMsg('plugin.unknown.future', {}), WS)).resolves.toBeUndefined()
    expect(replies).toHaveLength(0)
    // 落空不再静默（RT-1#6）：显式 error 信封让前端 pending Promise 立即失败，而非等到泛化超时。
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      id: 'm1',
      code: 'handler_not_registered',
      message: expect.stringContaining('plugin.unknown.future'),
    })
    expect(pluginService.getDiscoveredPlugins).not.toHaveBeenCalled()
  })

  it('handles 清单含全部 21 个 plugin.* type', () => {
    const { handler } = makeHandler()
    expect(handler.handles).toHaveLength(21)
    expect(handler.handles).toEqual(expect.arrayContaining([
      'plugin.list', 'plugin.toggle', 'plugin.uninstall', 'plugin.approvePermissions', 'plugin.revokePermissions',
      'plugin.denyPermissions',
      'plugin.executeCommand', 'plugin.config.get', 'plugin.config.set', 'plugin.install', 'plugin.uiResponse',
      'plugin.mountPoints.sync', 'plugin.ui.snapshot',
      // provider-plugin-access U2 裁决①：挂载位分区清理（家族切换防陈旧）
      'plugin.ui.clearMount',
      // provider-plugin-access D9/D8/U5：plugin.invoke 业务方法调用、plugin.uiEvent 输入
      // 值回传、清单域两个无参只读 RPC
      'plugin.invoke', 'plugin.uiEvent', 'plugin.listAvailable', 'plugin.catalog',
      // provider-plugin-access U4/U6：两段式安装（prepare 确认停点 / confirm 提交 / cancel 清暂存）
      'plugin.prepareInstall', 'plugin.confirmInstall', 'plugin.cancelInstall',
    ]))
  })
})
});

// ======================================================================
// ← test/plugin-agent-real.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-agent-real', () => {
describe('plugin-agent-real', () => {
/**
 * Plugin Agent API — 真实 handler 测试
 *
 * 验证 setModel→switchModel、getModel→activeSession.modelId、
 * getActiveTools→toolRegistry schemas、getThinkingLevel 默认值。
 */

// ── Fixtures ──────────────────────────────────────────────────

function createMockBroker_m2(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

/**
 * [W3] records = lifecycle 注册表记录最小形状（IManagedSessionView 的 modelId /
 * thinkingLevel 双写缓存字段）——getModel / getThinkingLevel 的读点已从 SessionSummary
 * 改到注册表记录（SessionSummary 三状态字段删除），测试经本参数接线同值记录。
 */
function createMockSessionService_m2(
  sessions: SessionSummary[] = [],
  records: Array<{ id: string; modelId?: string; thinkingLevel?: string }> = [],
): ISessionService {
  const sessionMap = new Map(sessions.map(s => [s.id, s]))
  const recordMap = new Map(records.map(r => [r.id, r]))
  const groups: SessionGroup[] = sessions.length > 0
    ? [{ cwd: sessions[0].cwd, sessions }]
    : []

  return {
    listPersistedSessions: vi.fn().mockReturnValue(groups),
    getSummary: vi.fn((id: string) => sessionMap.get(id)),
    getSession: vi.fn((id: string) => recordMap.get(id)),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue('provider/model-b'),
    setThinkingLevel: vi.fn().mockResolvedValue('off'),
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    restoreSession: vi.fn().mockResolvedValue(undefined),
    hasActiveSession: vi.fn().mockReturnValue(true),
    getRpcClient: vi.fn().mockReturnValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as ISessionService
}

function createService_m2(sessionService?: ISessionService, modelService?: IPluginServiceDeps['modelService']): PluginService {
  const broker = createMockBroker_m2()
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  const deps: IPluginServiceDeps = {
    sessionService,
    modelService,
  }
  return new PluginService(registry, broker, deps)
}

async function callMethod(service: PluginService, method: string, params: Record<string, unknown>): Promise<unknown> {
  const svc = service as unknown as {
    registerRpcMethods(): void
    rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
  }
  svc.registerRpcMethods()
  const handler = svc.rpcServer.methods.get(method)
  if (!handler) throw new Error(`Method not registered: ${method}`)
  return handler(params)
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('Agent RPC Handlers — real implementation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearActiveSessionCache()
  })

  it('getModel returns active session modelId', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session], [{ id: 's1', modelId: 'openai/gpt-4' }])
    const service = createService_m2(sessionService)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('openai/gpt-4')
  })

  it('getModel returns empty string when no active session', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'idle',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session])
    const service = createService_m2(sessionService)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('')
  })

  it('setModel calls switchModel on active session', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session])
    const service = createService_m2(sessionService)

    await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(sessionService.switchModel).toHaveBeenCalledWith('s1', 'openai', 'gpt-4')
  })

  it('setModel is silently ignored when no active session', async () => {
    const sessionService = createMockSessionService_m2([])
    const service = createService_m2(sessionService)

    await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('getThinkingLevel returns "off" when no active session', async () => {
    const service = createService_m2(createMockSessionService_m2())

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('off')
  })

  it('getThinkingLevel returns active session thinkingLevel', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session], [{ id: 's1', thinkingLevel: 'high' }])
    const service = createService_m2(sessionService)

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('high')
  })

  it('getThinkingLevel returns "off" when active session has undefined thinkingLevel', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    // W3：注册表记录无 thinkingLevel 缓存值（undefined）→ 'off' 兜底
    const sessionService = createMockSessionService_m2([session], [{ id: 's1' }])
    const service = createService_m2(sessionService)

    const level = await callMethod(service, 'plugin.agent.getThinkingLevel', {})
    expect(level).toBe('off')
  })

  it('setThinkingLevel is silently accepted', async () => {
    const service = createService_m2(createMockSessionService_m2())

    // Should not throw
    await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
  })

  it('getActiveTools returns tool schema names from toolRegistry', async () => {
    const service = createService_m2(createMockSessionService_m2())
    const svc = service as unknown as {
      registerRpcMethods(): void
      rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
      toolRegistry: Map<string, { schema: { name: string } }>
    }

    // Inject tool entries into registry
    svc.toolRegistry.set('p1:toolA', { schema: { name: 'toolA' } })
    svc.toolRegistry.set('p1:toolB', { schema: { name: 'toolB' } })

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual(['toolA', 'toolB'])
  })

  it('getActiveTools returns empty array when no tools', async () => {
    const service = createService_m2(createMockSessionService_m2())

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual([])
  })

  it('falls back to stub when sessionService is undefined', async () => {
    const broker = createMockBroker_m2()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const model = await callMethod(service, 'plugin.agent.getModel', {})
    expect(model).toBe('')

    const tools = await callMethod(service, 'plugin.agent.getActiveTools', {})
    expect(tools).toEqual([])
  })
})

/**
 * U6 回执普查降级检查（C-pi-13 消费方契约）：setModel / setThinkingLevel 的 reply
 * 是 pi 生效值（pi pattern 换模 / 钳制时 ≠ 请求值），消费端必须处理空串降级、
 * 禁乐观写请求值。检查分支零覆盖即契约无锁定。
 */
describe('Agent RPC Handlers — U6 降级检查返回空串', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearActiveSessionCache()
  })

  it('setModel：无 sessionService → 返回空串（检查分支 1）', async () => {
    const broker = createMockBroker_m2()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(result).toBe('')
  })

  it('setModel：无活跃 session → 返回空串且不触达 switchModel（检查分支 2）', async () => {
    const sessionService = createMockSessionService_m2([])
    const service = createService_m2(sessionService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    expect(result).toBe('')
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('setModel：复合串无 "/"（parts < MIN_MODEL_PARTS）→ 返回空串且不触达 switchModel（检查分支 3）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session])
    const service = createService_m2(sessionService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'gpt-4' })
    expect(result).toBe('')
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('setModel：活跃 session + 合法复合串 → 返回 switchModel 的生效值（回执契约正向锚点）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session])
    const service = createService_m2(sessionService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    // 请求 'openai/gpt-4'，mock 的 sessionService.switchModel 返回生效值 'provider/model-b'
    expect(result).toBe('provider/model-b')
  })

  it('setThinkingLevel：无 sessionService → 返回空串（检查分支 1）', async () => {
    const broker = createMockBroker_m2()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    const service = new PluginService(registry, broker)

    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('')
  })

  it('setThinkingLevel：无活跃 session → 返回空串（检查分支 2）', async () => {
    const sessionService = createMockSessionService_m2([])
    const service = createService_m2(sessionService)

    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('')
    expect((sessionService.setThinkingLevel as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('setThinkingLevel：活跃 session → 返回 setThinkingLevel 的生效档（回执契约正向锚点）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session])
    ;(sessionService.setThinkingLevel as ReturnType<typeof vi.fn>).mockResolvedValue('high')
    const service = createService_m2(sessionService)

    // 请求 max，pi 钳制后生效档 high（事故 B 形态）——回执返回生效档而非请求值
    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('high')
    expect(sessionService.setThinkingLevel).toHaveBeenCalledWith('s1', 'max')
  })

  it('setModel：deps 注入 modelService → 委托 modelService.switchModel 原样返回生效值（生产主臂锚点，session-only 兜底臂零触达）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session])
    const modelService = {
      switchModel: vi.fn().mockResolvedValue('provider/model-unified'),
      setThinkingLevel: vi.fn().mockResolvedValue('high'),
    } as unknown as IPluginServiceDeps['modelService']
    const service = createService_m2(sessionService, modelService)

    const result = await callMethod(service, 'plugin.agent.setModel', { model: 'openai/gpt-4' })
    // 委托返回行是回执契约承重点：若 return 丢失（回执退化为 undefined）此断言红
    expect(result).toBe('provider/model-unified')
    expect(modelService!.switchModel).toHaveBeenCalledWith('s1', 'openai', 'gpt-4')
    // 主臂命中时 session-only fallback 臂不触达
    expect(sessionService.switchModel).not.toHaveBeenCalled()
  })

  it('setThinkingLevel：deps 注入 modelService → 委托 modelService.setThinkingLevel 原样返回生效档（生产主臂锚点）', async () => {
    const session: SessionSummary = {
      id: 's1', label: 'S1', cwd: '/work', status: 'active',
      lastActiveAt: Date.now(),
    }
    const sessionService = createMockSessionService_m2([session])
    const modelService = {
      switchModel: vi.fn().mockResolvedValue('provider/model-unified'),
      setThinkingLevel: vi.fn().mockResolvedValue('high'),
    } as unknown as IPluginServiceDeps['modelService']
    const service = createService_m2(sessionService, modelService)

    const result = await callMethod(service, 'plugin.agent.setThinkingLevel', { level: 'max' })
    expect(result).toBe('high')
    expect(modelService!.setThinkingLevel).toHaveBeenCalledWith('s1', 'max')
    expect(sessionService.setThinkingLevel).not.toHaveBeenCalled()
  })
})
})
describe('plugin-session-real', () => {
/**
 * Plugin Session API — 真实 handler 测试
 *
 * 验证 listSessions/getSession/getActiveSession/sendMessage
 * 通过 deps.sessionService 真实调用（mock ISessionService）。
 */

// ── Fixtures ──────────────────────────────────────────────────

function createMockBroker_m2(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    label: 'Test Session',
    cwd: '/project',
    status: 'active',
    lastActiveAt: Date.now(),
    ...overrides,
  }
}

function createMockSessionService_m2(sessions: SessionSummary[] = []): ISessionService {
  const sessionMap = new Map(sessions.map(s => [s.id, s]))

  const groups: SessionGroup[] = sessions.length > 0
    ? [{ cwd: sessions[0].cwd, sessions }]
    : []

  return {
    listPersistedSessions: vi.fn().mockReturnValue(groups),
    getSummary: vi.fn((id: string) => sessionMap.get(id)),
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    create: vi.fn().mockResolvedValue(createSessionSummary()),
    delete: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue('provider/model-a'),
    compact: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    restoreSession: vi.fn().mockResolvedValue(createSessionSummary()),
    hasActiveSession: vi.fn().mockReturnValue(true),
    getRpcClient: vi.fn().mockReturnValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as ISessionService
}

/** Create PluginService with injected deps */
function createService_m2(sessionService?: ISessionService): PluginService {
  const broker = createMockBroker_m2()
  const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
  const deps: IPluginServiceDeps = {
    sessionService,
  }
  return new PluginService(registry, broker, deps)
}

/** Access RPC server internals for testing */
function getServiceInternals(service: PluginService) {
  const svc = service as unknown as {
    registerRpcMethods(): void
    rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> }
  }
  svc.registerRpcMethods()
  return svc
}

/** Call a registered RPC method by name */
async function callMethod(service: PluginService, method: string, params: Record<string, unknown>): Promise<unknown> {
  const internals = getServiceInternals(service)
  const handler = internals.rpcServer.methods.get(method)
  if (!handler) throw new Error(`Method not registered: ${method}`)
  return handler(params)
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('Session RPC Handlers — real sessionService calls', () => {
  let mockSessionService: ISessionService

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listSessions returns SessionInfo[] from sessionService', async () => {
    const s1 = createSessionSummary({ id: 's1', label: 'S1', status: 'active' })
    const s2 = createSessionSummary({ id: 's2', label: 'S2', status: 'idle' })
    mockSessionService = createMockSessionService_m2([s1, s2])
    const service = createService_m2(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.list', {})
    const list = result as Array<{ id: string; label: string; status: string }>

    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('s1')
    expect(list[0].label).toBe('S1')
    expect(list[0].status).toBe('active')
    expect(list[1].id).toBe('s2')
  })

  it('getSession returns SessionInfo for known session', async () => {
    const s1 = createSessionSummary({ id: 's1', cwd: '/work' })
    mockSessionService = createMockSessionService_m2([s1])
    const service = createService_m2(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.get', { sessionId: 's1' })

    expect(result).toBeDefined()
    const info = result as { id: string; cwd: string }
    expect(info.id).toBe('s1')
    expect(info.cwd).toBe('/work')
  })

  it('getSession returns undefined for unknown session', async () => {
    mockSessionService = createMockSessionService_m2([])
    const service = createService_m2(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.get', { sessionId: 'nonexistent' })
    expect(result).toBeUndefined()
  })

  it('getActiveSession returns the active session', async () => {
    const active = createSessionSummary({ id: 'active-1', status: 'active' })
    const idle = createSessionSummary({ id: 'idle-1', status: 'idle' })
    mockSessionService = createMockSessionService_m2([active, idle])
    const service = createService_m2(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.getActive', {})

    expect(result).toBeDefined()
    const info = result as { id: string }
    expect(info.id).toBe('active-1')
  })

  it('getActiveSession returns undefined when no active session', async () => {
    const idle = createSessionSummary({ id: 'idle-1', status: 'idle' })
    mockSessionService = createMockSessionService_m2([idle])
    const service = createService_m2(mockSessionService)

    const result = await callMethod(service, 'plugin.sessions.getActive', {})
    expect(result).toBeUndefined()
  })

  it('sendMessage calls sessionService.sendMessage', async () => {
    mockSessionService = createMockSessionService_m2([
      createSessionSummary({ id: 's1' }),
    ])
    const service = createService_m2(mockSessionService)

    await callMethod(service, 'plugin.sessions.sendMessage', {
      sessionId: 's1',
      role: 'user',
      content: 'Hello',
    })

    // [D6/u5b] 透传链：dispatcher 签名 (sessionId, content, images?, clientUuid?, requireCommand?)
    expect(mockSessionService.sendMessage).toHaveBeenCalledWith('s1', 'Hello', undefined, undefined, undefined)
  })

  it('falls back to stub when sessionService is undefined', async () => {
    const broker = createMockBroker_m2()
    const registry = new PluginRegistry('/tmp/fake-project', '/tmp/fake-project')
    // No deps → sessionService is undefined
    const service = new PluginService(registry, broker)

    const list = await callMethod(service, 'plugin.sessions.list', {})
    expect(list).toEqual([])

    const single = await callMethod(service, 'plugin.sessions.get', { sessionId: 'x' })
    expect(single).toBeUndefined()

    const active = await callMethod(service, 'plugin.sessions.getActive', {})
    expect(active).toBeUndefined()

    // sendMessage should not throw
    await callMethod(service, 'plugin.sessions.sendMessage', {
      sessionId: 'x',
      role: 'user',
      content: 'test',
    })
  })
})
})
});

// ======================================================================
// ← test/plugin-demo-e2e.test.ts
// ======================================================================

// ── Helpers ──────────────────────────────────────────────────────

/** Path to the demo plugin directory */
const DEMO_DIR = join(__dirname, '..', 'src', 'plugins', 'demo')


/** Creates a mock PluginContext with spy implementations */
function createMockContext(): {
  context: PluginContext
  registeredTools: Array<{ name: string; description: string }>
  registeredHooks: Array<string>
  notifications: Array<{ level: string; message: string }>
} {
  const registeredTools: Array<{ name: string; description: string }> = []
  const registeredHooks: Array<string> = []
  const notifications: Array<{ level: string; message: string }> = []

  const context: PluginContext = {
    pluginId: 'demo-plugin',
    pluginPath: DEMO_DIR,
    globalState: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
    },
    workspaceState: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
    },
    api: {
      // ── tools ─────────────────────────────────────────────
      tools: {
        register: vi.fn(async (registration) => {
          registeredTools.push({ name: registration.name, description: registration.description })
          return `demo-plugin:${registration.name}`
        }),
        unregister: vi.fn(async () => {}),
      },
      // ── hooks ─────────────────────────────────────────────
      hooks: {
        onBeforeSendMessage: vi.fn(async (handler) => {
          registeredHooks.push('onBeforeSendMessage')
          // Store handler for later invocation in tests
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock context 未类型化私有字段 _hookHandlers，测试断言直读
          ;(context as any)._hookHandlers = (context as any)._hookHandlers || []
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock context 未类型化私有字段 _hookHandlers，测试断言直读
          ;(context as any)._hookHandlers.push(handler)
          return { dispose: () => {} }
        }),
        onBeforeToolCall: vi.fn(async () => ({ dispose: () => {} })),
        onAfterToolResult: vi.fn(async () => ({ dispose: () => {} })),
        onPiEvent: vi.fn(async () => ({ dispose: () => {} })),
      },
      // ── storage ──────────────────────────────────────────
      storage: {
        global: {
          get: vi.fn(async () => undefined),
          set: vi.fn(async () => {}),
          delete: vi.fn(async () => {}),
          keys: vi.fn(async () => []),
        },
        workspace: {
          get: vi.fn(async () => undefined),
          set: vi.fn(async () => {}),
          delete: vi.fn(async () => {}),
          keys: vi.fn(async () => []),
        },
      },
      // ── notify ────────────────────────────────────────────
      notify: {
        info: vi.fn(async (_msg: string) => {}),
        warning: vi.fn(async () => {}),
        error: vi.fn(async () => {}),
      },
      // ── sessions ─────────────────────────────────────────
      sessions: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        getActive: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => ({ accepted: true })),
        readEntries: vi.fn(async () => ({ entries: [] })),
        getCommands: vi.fn(async () => []),
        onDidCreateSession: vi.fn(() => ({ dispose: () => {} })),
        onDidDestroySession: vi.fn(() => ({ dispose: () => {} })),
        onDidActivateSession: vi.fn(() => ({ dispose: () => {} })),
        onEntriesInvalidated: vi.fn(() => ({ dispose: () => {} })),
      },
      // ── events ────────────────────────────────────────────
      events: {
        on: vi.fn(() => ({ dispose: () => {} })),
        emit: vi.fn(),
        report: vi.fn(async () => ({ forwarded: true })),
      },
      // ── config ────────────────────────────────────────────
      config: {
        get: vi.fn(async () => undefined),
        getAll: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      // ── sessionData ───────────────────────────────────────
      sessionData: {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        keys: vi.fn(async () => []),
      },
      // ── ui ────────────────────────────────────────────────
      ui: {
        showSelect: vi.fn(async () => undefined),
        showConfirm: vi.fn(async () => false),
        showInput: vi.fn(async () => undefined),
        notify: vi.fn(async (level: string, message: string) => {
          notifications.push({ level, message })
        }),
        updateHeaderAction: vi.fn(async () => ({ updated: true })),
        openUrl: vi.fn(async () => ({ opened: true })),
      },
      // ── agent ─────────────────────────────────────────────
      agent: {
        setModel: vi.fn(async () => ''),
        getModel: vi.fn(async () => ''),
        getThinkingLevel: vi.fn(async () => 'high'),
        setThinkingLevel: vi.fn(async () => ''),
        getActiveTools: vi.fn(async () => []),
      },
      // ── workspace ─────────────────────────────────────────
      workspace: {
        rootPath: '/tmp/test-workspace',
        name: 'test-workspace',
        findFiles: vi.fn(async () => ['file1.ts', 'file2.ts']),
      },
      // ── commands / views（W1 类型层落地，mock 占位）───────
      commands: {
        register: vi.fn(async () => ({ dispose: () => {} })),
        unregister: vi.fn(async () => {}),
      },
      views: {
        update: vi.fn(async () => {}),
        listMountPoints: vi.fn(async () => []),
        onUiEvent: vi.fn(() => ({ dispose: () => {} })),
      },
      // ── providers（provider-plugin-access D4，mock 占位）──
      providers: {
        write: vi.fn(async () => ({ written: true as const, providerId: 'demo-provider' })),
        delete: vi.fn(async () => ({ deleted: false, providerId: 'demo-provider' })),
        credential: vi.fn(async () => ({ providerId: 'demo-provider', unsupported: 'command' } as const)),
      },
    },
    subscriptions: [],
  }

  return { context, registeredTools, registeredHooks, notifications }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-demo-e2e', () => {
// ── Tests ────────────────────────────────────────────────────────

describe('Demo Plugin E2E', () => {
  // ── TC-D01: package.json manifest is valid ──────────────────
  it('TC-D01: package.json manifest is correctly structured', async () => {
    const raw = await readFile(join(DEMO_DIR, 'package.json'), 'utf-8')
    const pkg: TaijiPackageJson = JSON.parse(raw)

    expect(pkg.name).toBe('demo-plugin')
    expect(pkg.version).toBeTruthy()  // version is bumped by release script
    expect(pkg.taijiPlugin).toBeDefined()
    expect(pkg.taijiPlugin.manifestVersion).toBe(1)
    expect(pkg.taijiPlugin.activationEvents).toContain('onStartupFinished')
    expect(pkg.taijiPlugin.trustLevel).toBe('sandbox')

    // contributes
    const contributes = pkg.taijiPlugin.contributes
    expect(contributes).toBeDefined()
    expect(contributes!.tools).toHaveLength(1)
    expect(contributes!.tools![0].name).toBe('demo_search')
    expect(contributes!.hooks).toContain('onBeforeSendMessage')

    // permissions
    expect(pkg.taijiPlugin.permissions).toContain('workspace:file:search')
  })

  // ── TC-D02: PluginModule type is correct ────────────────────
  it('TC-D02: PluginModule has activate and deactivate', async () => {
    // Dynamic import to get the plugin module
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    expect(typeof plugin.activate).toBe('function')
    expect(typeof plugin.deactivate).toBe('function')
  })

  // ── TC-D03: activate registers tools ────────────────────────
  it('TC-D03: activate registers the demo_search tool', async () => {
    const { context, registeredTools } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    expect(registeredTools).toHaveLength(1)
    expect(registeredTools[0].name).toBe('demo_search')
    expect(registeredTools[0].description).toContain('Search for files')
    expect(context.api.tools.register).toHaveBeenCalledOnce()
  })

  // ── TC-D04: activate registers hooks ────────────────────────
  it('TC-D04: activate registers onBeforeSendMessage hook', async () => {
    const { context, registeredHooks } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    expect(registeredHooks).toContain('onBeforeSendMessage')
    expect(context.api.hooks.onBeforeSendMessage).toHaveBeenCalledOnce()
  })

  // ── TC-D05: activate sends UI notification ──────────────────
  it('TC-D05: activate sends info notification', async () => {
    const { context, notifications } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].level).toBe('info')
    expect(notifications[0].message).toContain('Demo plugin activated')
  })

  // ── TC-D06: hook interceptor transforms !important ──────────
  it('TC-D06: hook interceptor transforms !important to IMPORTANT', async () => {
    const { context } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    // Retrieve the handler that was registered
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock context 未类型化私有字段 _hookHandlers，测试断言直读
    const handlers = (context as any)._hookHandlers as Array<(ctx: HookContext) => Promise<unknown>>
    expect(handlers).toHaveLength(1)

    const handler = handlers[0]
    const hookCtx: HookContext = {
      pluginId: 'demo-plugin',
      hookType: 'onBeforeSendMessage',
      data: { content: 'please review this !important change' },
      timestamp: Date.now(),
    }

    const result = await handler(hookCtx) as { proceed: boolean; modifiedData?: unknown }

    expect(result.proceed).toBe(true)
    const modified = result.modifiedData as { content: string }
    expect(modified.content).toBe('please review this IMPORTANT change')
  })

  // ── TC-D07: hook passes through normal content ──────────────
  it('TC-D07: hook passes through normal content unchanged', async () => {
    const { context } = createMockContext()
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    await plugin.activate(context)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock context 未类型化私有字段 _hookHandlers，测试断言直读
    const handlers = (context as any)._hookHandlers as Array<(ctx: HookContext) => Promise<unknown>>
    const handler = handlers[0]

    const hookCtx: HookContext = {
      pluginId: 'demo-plugin',
      hookType: 'onBeforeSendMessage',
      data: { content: 'normal message without markers' },
      timestamp: Date.now(),
    }

    const result = await handler(hookCtx) as { proceed: boolean; modifiedData?: unknown }

    expect(result.proceed).toBe(true)
    expect(result.modifiedData).toBeUndefined()
  })

  // ── TC-D08: deactivate is callable ──────────────────────────
  it('TC-D08: deactivate runs without error', async () => {
    const mod = await import(join(DEMO_DIR, 'index.ts'))
    const plugin: PluginModule = mod.default

    expect(() => plugin.deactivate!()).not.toThrow()
  })
})
});

// ======================================================================
// ← test/plugin-ui-snapshot.test.ts
// ======================================================================

function headerAction(overrides: Partial<HeaderActionUpdatePayload> = {}): HeaderActionUpdatePayload {
  return { pluginId: 'p1', headerActionId: 'a1', sessionId: 's1', ...overrides }
}


function viewItem(overrides: Partial<ViewSnapshotItem> = {}): ViewSnapshotItem {
  return { sessionId: 's1', viewId: 'v1', pluginId: 'p1', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }], updatedAt: 1, generation: 0, ...overrides }
}


/** setView 的返回/存储形态：首次写入代际 = 1（prev 缺省 0 + 1） */
function gen1(item: ViewSnapshotItem): ViewSnapshotItem {
  return { ...item, generation: 1 }
}


// ── 全链写入联动（真实 PluginService 装配）─────────────────────

/** 生产装配全链（plugin-modal-headeraction-contract.test.ts buildBareWiredRpc 同款），deps 带 broadcastFn 捕获广播帧 */
function buildWiredService(): { service: PluginService; broadcasts: unknown[]; dispatch: (id: number, method: string, params: Record<string, unknown>) => Promise<{ result?: Record<string, unknown>; error?: { code?: unknown } | null }> } {
  const registryMock = {
    getDescriptor: () => undefined,
    getAllDescriptors: () => [],
  }
  const broadcasts: unknown[] = []
  const broker: IMessageBroker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
  const service = new PluginService(registryMock as never, broker, {
    configDir: mkdtempSync(join(tmpdir(), 'plugin-ui-snapshot-')),
    broadcastFn: (type: string, payload: unknown) => {
      broadcasts.push({ type, payload })
    },
  } as never)
  ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
  const rpc = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
  const messages: unknown[] = []
  const port = {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  } as never as WorkerPort & { messages: unknown[] }
  rpc.registerWorker('w1', port)

  async function dispatch(id: number, method: string, params: Record<string, unknown>) {
    await rpc.dispatch('w1', { jsonrpc: '2.0', id, method, params })
    const last = port.messages[port.messages.length - 1] as { response?: { result?: Record<string, unknown>; error?: { code?: unknown } | null } } | undefined
    return last?.response ?? {}
  }
  return { service, broadcasts, dispatch }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-ui-snapshot', () => {
// ── store 直测 ──────────────────────────────────────────────

describe('PluginUiSnapshotStore', () => {
  it('写入 + snapshot 全量读出（headerActions / views 两族，条目带 generation）', () => {
    const store = new PluginUiSnapshotStore()
    store.setHeaderAction(headerAction({ badge: '2' }))
    store.setHeaderAction(headerAction({ headerActionId: 'a2', sessionId: 's2', hidden: true }))
    store.setView(viewItem())
    expect(store.snapshot()).toEqual({
      headerActions: [headerAction({ badge: '2' }), headerAction({ headerActionId: 'a2', sessionId: 's2', hidden: true })],
      views: [gen1(viewItem())],
    })
  })

  it('同键二次写入覆盖（最新帧为准）', () => {
    const store = new PluginUiSnapshotStore()
    store.setHeaderAction(headerAction({ badge: '1' }))
    store.setHeaderAction(headerAction({ badge: '3' }))
    expect(store.snapshot().headerActions).toHaveLength(1)
    expect(store.snapshot().headerActions[0].badge).toBe('3')
  })

  it('[null] 树 = 删除分区条目（清除语义，非存 null 树）；返回 undefined 不广播', () => {
    const store = new PluginUiSnapshotStore()
    store.setView(viewItem())
    expect(store.setView(viewItem({ guiTree: [null] }))).toBeUndefined()
    expect(store.snapshot().views).toHaveLength(0)
    // 未写入过的 viewId 直接推 [null]：no-op 不抛
    expect(() => store.setView(viewItem({ viewId: 'ghost', guiTree: [null] }))).not.toThrow()
  })

  it('generation 单调分配：同 (scope, viewId) 递增；清除后从 1 重新起算', () => {
    const store = new PluginUiSnapshotStore()
    expect(store.setView(viewItem())?.generation).toBe(1)
    expect(store.setView(viewItem({ updatedAt: 2 }))?.generation).toBe(2)
    store.setView(viewItem({ guiTree: [null] }))
    expect(store.setView(viewItem())?.generation).toBe(1)
  })

  it('snapshot 过滤：sessionId 收窄两族 / viewId 只收窄视图族', () => {
    const store = new PluginUiSnapshotStore()
    store.setHeaderAction(headerAction())
    store.setHeaderAction(headerAction({ sessionId: 's2' }))
    store.setView(viewItem())
    store.setView(viewItem({ sessionId: 's2', viewId: 'v2' }))

    expect(store.snapshot({ sessionId: 's2' })).toEqual({
      headerActions: [headerAction({ sessionId: 's2' })],
      views: [gen1(viewItem({ sessionId: 's2', viewId: 'v2' }))],
    })
    expect(store.snapshot({ sessionId: 's1', viewId: 'v1' })).toEqual({
      headerActions: [headerAction()],
      views: [gen1(viewItem())],
    })
    // 未命中 = 空集（渲染端按未推送处理）
    expect(store.snapshot({ sessionId: 'missing' })).toEqual({ headerActions: [], views: [] })
  })

  it('全局域分区（U2）：mountId+pluginId 键隔离——双插件同挂载位互不覆盖（S25）', () => {
    const store = new PluginUiSnapshotStore()
    const authorizeA = viewItem({ mountId: 'provider.authorize', sessionId: undefined, pluginId: 'plug-a', viewId: 'flow' })
    const authorizeB = viewItem({ mountId: 'provider.authorize', sessionId: undefined, pluginId: 'plug-b', viewId: 'flow' })
    store.setView(authorizeA)
    store.setView(authorizeB)
    // A 重推同键 = 正常更新（generation 递增），不影响 B 的分区
    expect(store.setView({ ...authorizeA, updatedAt: 2 })?.generation).toBe(2)

    expect(store.snapshot({ mountId: 'provider.authorize', pluginId: 'plug-a' }).views).toEqual([
      { ...authorizeA, updatedAt: 2, generation: 2 },
    ])
    expect(store.snapshot({ mountId: 'provider.authorize', pluginId: 'plug-b' }).views).toEqual([
      gen1(authorizeB),
    ])
    // pluginId 缺省 = 键无法成形 → 空（不猜测插件）；全量含两个分区条目
    expect(store.snapshot({ mountId: 'provider.authorize' }).views).toEqual([])
    expect(store.snapshot().views).toHaveLength(2)
    // 过滤参数都给 = 调用方 bug → 空 + warn（fail-visible）
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(store.snapshot({ sessionId: 's1', mountId: 'provider.authorize' })).toEqual({ headerActions: [], views: [] })
    vi.restoreAllMocks()
  })

  it('clearForSession 清该会话两族；clearForPlugin 跨域按 pluginId 清并移除空分区', () => {
    const store = new PluginUiSnapshotStore()
    store.setHeaderAction(headerAction())
    store.setHeaderAction(headerAction({ headerActionId: 'a2', sessionId: 's2', pluginId: 'p2' }))
    store.setView(viewItem())
    store.setView(viewItem({ sessionId: 's2', viewId: 'v2', pluginId: 'p2' }))
    store.setView(viewItem({ sessionId: undefined, mountId: 'provider.authorize', pluginId: 'p2', viewId: 'flow' }))

    store.clearForSession('s1')
    expect(store.snapshot().headerActions.map((h) => h.sessionId)).toEqual(['s2'])
    expect(store.snapshot().views.map((v) => v.viewId).sort()).toEqual(['flow', 'v2'])

    // clearForPlugin 跨会话/全局域清剩余 p2 条目（插件维度生命周期清理链：crash/disable/uninstall）
    store.clearForPlugin('p2')
    expect(store.snapshot()).toEqual({ headerActions: [], views: [] })
  })

  it('clearForMount 清该挂载位全部插件维度的全局域分区；其他挂载位/会话域不受影响（U2 裁决①家族切换防陈旧）', () => {
    const store = new PluginUiSnapshotStore()
    const authorizeA = viewItem({ mountId: 'provider.authorize', sessionId: undefined, pluginId: 'plug-a', viewId: 'flow' })
    const authorizeB = viewItem({ mountId: 'provider.authorize', sessionId: undefined, pluginId: 'plug-b', viewId: 'flow' })
    const detailA = viewItem({ mountId: 'provider.detail-extra', sessionId: undefined, pluginId: 'plug-a', viewId: 'detail' })
    store.setView(authorizeA)
    store.setView(authorizeB)
    store.setView(detailA)
    store.setView(viewItem({ viewId: 'session-view' }))

    store.clearForMount('provider.authorize')

    // authorize 挂载位两插件维度分区全清（快照恢复源不再含旧家族树）
    expect(store.snapshot({ mountId: 'provider.authorize', pluginId: 'plug-a' }).views).toEqual([])
    expect(store.snapshot({ mountId: 'provider.authorize', pluginId: 'plug-b' }).views).toEqual([])
    // 其他挂载位 / 会话域分区不受影响（S25 键形态，前缀精确匹配）
    expect(store.snapshot({ mountId: 'provider.detail-extra', pluginId: 'plug-a' }).views).toEqual([gen1(detailA)])
    expect(store.snapshot({ sessionId: 's1' }).views).toEqual([gen1(viewItem({ viewId: 'session-view' }))])
    // 前缀不误吞：挂载位名只是前缀相近（provider.authorize2）不受清
    const authorize2 = viewItem({ mountId: 'provider.authorize2', sessionId: undefined, pluginId: 'plug-a', viewId: 'flow' })
    store.setView(authorize2)
    store.clearForMount('provider.authorize')
    expect(store.snapshot({ mountId: 'provider.authorize2', pluginId: 'plug-a' }).views).toEqual([gen1(authorize2)])
  })
})
describe('全链写入联动（plugin.ui.updateHeaderAction / plugin.views.update → PluginUiSnapshotStore）', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plugin-ui-snapshot-root-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('updateHeaderAction 校验出口处写快照 + 广播帧同源发出', async () => {
    const { service, broadcasts, dispatch } = buildWiredService()

    const resp = await dispatch(1, 'plugin.ui.updateHeaderAction', {
      pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '2',
    })
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ updated: true })
    expect(broadcasts).toHaveLength(1)
    expect(service.uiSnapshotStore.snapshot({ sessionId: 's1' })).toEqual({
      headerActions: [{ pluginId: 'scheduler-manager', headerActionId: 'scheduler-manager.open', sessionId: 's1', badge: '2' }],
      views: [],
    })
  })

  it('views.update 校验出口处写快照；[null] 树推送删除分区条目', async () => {
    const { service, dispatch } = buildWiredService()

    await dispatch(1, 'plugin.views.update', {
      pluginId: 'scheduler-manager', viewId: 'scheduler.modal', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }], sessionId: 's1',
    })
    expect(service.uiSnapshotStore.snapshot({ sessionId: 's1' }).views).toHaveLength(1)

    await dispatch(2, 'plugin.views.update', {
      pluginId: 'scheduler-manager', viewId: 'scheduler.modal', guiTree: [null], sessionId: 's1',
    })
    expect(service.uiSnapshotStore.snapshot({ sessionId: 's1' }).views).toHaveLength(0)
  })

  it('views.update 归属二选一校验（U2）：都缺/都给 → INVALID_VIEW_SCOPE，零广播零快照写入', async () => {
    const { service, broadcasts, dispatch } = buildWiredService()

    // 都缺（旧 INVALID_SESSION_ID 契约已被 scope 二选一取代）
    const missing = await dispatch(1, 'plugin.views.update', {
      pluginId: 'p1', viewId: 'v1', guiTree: [],
    })
    expect(missing.error?.code).toBe('INVALID_VIEW_SCOPE')
    // 都给
    const both = await dispatch(2, 'plugin.views.update', {
      pluginId: 'p1', viewId: 'v1', guiTree: [], sessionId: 's1', mountId: 'provider.authorize',
    })
    expect(both.error?.code).toBe('INVALID_VIEW_SCOPE')

    expect(broadcasts).toHaveLength(0)
    expect(service.uiSnapshotStore.snapshot()).toEqual({ headerActions: [], views: [] })
  })

  it('views.update 全局域推树（U2）：mountId 归属落 global 分区，广播帧带 mountId + generation', async () => {
    const { service, broadcasts, dispatch } = buildWiredService()

    const resp = await dispatch(1, 'plugin.views.update', {
      pluginId: 'plug-demo', viewId: 'flow', guiTree: [{ type: 'ansi-text', props: { lines: ['authorize'] } }], mountId: 'provider.authorize',
    })
    expect(resp.error).toBeUndefined()
    expect(service.uiSnapshotStore.snapshot({ mountId: 'provider.authorize', pluginId: 'plug-demo' }).views).toHaveLength(1)
    expect(broadcasts).toHaveLength(1)
    const frame = broadcasts[0] as { type: string; payload: Record<string, unknown> }
    expect(frame.type).toBe('plugin:viewUpdate')
    expect(frame.payload).toMatchObject({
      mountId: 'provider.authorize',
      viewId: 'flow',
      pluginId: 'plug-demo',
      guiTree: [{ type: 'ansi-text', props: { lines: ['authorize'] } }],
      generation: 1,
    })
    expect(typeof frame.payload.updatedAt).toBe('number')
  })

  it('getUiSnapshot 门面读 store（plugin.ui.snapshot WS handler 的 service 侧消费）', () => {
    const { service } = buildWiredService()
    service.uiSnapshotStore.setHeaderAction(headerAction())
    service.uiSnapshotStore.setHeaderAction(headerAction({ headerActionId: 'a2', sessionId: 's2' }))
    service.uiSnapshotStore.setView(viewItem())
    service.uiSnapshotStore.setView(viewItem({ sessionId: 's2', viewId: 'v2' }))

    expect(service.getUiSnapshot().headerActions).toHaveLength(2)
    expect(service.getUiSnapshot().views).toHaveLength(2)
    expect(service.getUiSnapshot({ sessionId: 's2', viewId: 'v2' })).toEqual({
      headerActions: [headerAction({ headerActionId: 'a2', sessionId: 's2' })],
      views: [gen1(viewItem({ sessionId: 's2', viewId: 'v2' }))],
    })
  })

  it('clearMountUiSnapshots 门面清挂载位分区（plugin.ui.clearMount 的 service 侧消费，U2 裁决①）', () => {
    const { service } = buildWiredService()
    service.uiSnapshotStore.setView(viewItem({ sessionId: undefined, mountId: 'provider.authorize', pluginId: 'plug-a', viewId: 'flow' }))
    service.uiSnapshotStore.setView(viewItem({ sessionId: undefined, mountId: 'provider.authorize', pluginId: 'plug-b', viewId: 'flow' }))
    service.uiSnapshotStore.setView(viewItem({ viewId: 'session-view' }))

    service.clearMountUiSnapshots('provider.authorize')

    expect(service.getUiSnapshot({ mountId: 'provider.authorize', pluginId: 'plug-a' }).views).toEqual([])
    expect(service.getUiSnapshot({ mountId: 'provider.authorize', pluginId: 'plug-b' }).views).toEqual([])
    expect(service.getUiSnapshot({ sessionId: 's1' }).views).toHaveLength(1)
  })
})
// ── WS handler 层（表驱动分发接线）────────────────────────────

describe('plugin.ui.snapshot WS handler（PluginMessageHandler 分发表）', () => {
  interface CapturedReply { id: string | undefined; type: string; payload: Record<string, unknown> } // oe-exempt:20261021:framework:WS handler 测试 harness 的回包捕获形状（同 plugin-message-handler.test.ts 家族形态）

  function makeHandler(getUiSnapshot: ReturnType<typeof vi.fn>) {
    const replies: CapturedReply[] = []
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        replies.push({ id, type, payload })
      }),
      pluginService: { getUiSnapshot },
    }
    const handler = new PluginMessageHandler(ctx as unknown as ConstructorParameters<typeof PluginMessageHandler>[0])
    return { replies, handler }
  }

  it('无过滤 → getUiSnapshot({}) 全量，reply plugin:uiSnapshot', async () => {
    const snap: PluginUiSnapshotPayload = { headerActions: [], views: [] }
    const getUiSnapshot = vi.fn(() => snap)
    const { replies, handler } = makeHandler(getUiSnapshot)

    await handler.handlePluginMessage({ type: 'plugin.ui.snapshot', id: 'm1', payload: {} } as never, {} as never)

    expect(getUiSnapshot).toHaveBeenCalledWith({})
    expect(replies).toEqual([{ id: 'm1', type: 'plugin:uiSnapshot', payload: snap }])
  })

  it('过滤参数透传（sessionId + viewId）', async () => {
    const getUiSnapshot = vi.fn(() => ({ headerActions: [], views: [] }))
    const { handler } = makeHandler(getUiSnapshot)

    await handler.handlePluginMessage(
      { type: 'plugin.ui.snapshot', id: 'm2', payload: { sessionId: 's1', viewId: 'v1' } } as never,
      {} as never,
    )
    expect(getUiSnapshot).toHaveBeenCalledWith({ sessionId: 's1', viewId: 'v1' })
  })

  it('过滤参数透传（全局域 mountId + pluginId + viewId，U2）', async () => {
    const getUiSnapshot = vi.fn(() => ({ headerActions: [], views: [] }))
    const { handler } = makeHandler(getUiSnapshot)

    await handler.handlePluginMessage(
      { type: 'plugin.ui.snapshot', id: 'm3', payload: { mountId: 'provider.authorize', pluginId: 'plug-a', viewId: 'flow' } } as never,
      {} as never,
    )
    expect(getUiSnapshot).toHaveBeenCalledWith({ mountId: 'provider.authorize', pluginId: 'plug-a', viewId: 'flow' })
  })
})
describe('plugin.ui.clearMount WS handler（家族切换防陈旧，U2 裁决①）', () => {
  it('mountId 透传 clearMountUiSnapshots，reply pong ack', async () => {
    const replies: Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }> = []
    const clearMountUiSnapshots = vi.fn()
    const ctx = {
      send: vi.fn(),
      sendError: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        replies.push({ id, type, payload })
      }),
      pluginService: { clearMountUiSnapshots },
    }
    const handler = new PluginMessageHandler(ctx as unknown as ConstructorParameters<typeof PluginMessageHandler>[0])

    await handler.handlePluginMessage(
      { type: 'plugin.ui.clearMount', id: 'm4', payload: { mountId: 'provider.authorize' } } as never,
      {} as never,
    )

    expect(clearMountUiSnapshots).toHaveBeenCalledWith('provider.authorize')
    expect(replies).toEqual([{ id: 'm4', type: 'pong', payload: {} }])
  })
})
});
