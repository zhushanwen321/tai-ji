/**
 * provider-plugin-access 插件侧消费面往返单测（D4 / D5 / D8 / D9 插件侧）。
 *
 * 覆盖 U6 修复面：插件 SDK 出口（createAgentAPI 装配的 events.report / ui.openUrl /
 * providers.* / views.onUiEvent）→ Worker 出站 → 宿主 handler（provider-write-proxy /
 * plugin-rpc-setup 注册的 plugin.event 与 plugin.ui.openUrl）→ 回执/投递回 Worker。
 * 宿主侧 handler 自身的行为矩阵（scheme 正反例细节、身份伪造覆写等）由
 * plugin-openurl-scheme.test.ts / plugin-ui-event-channel.test.ts /
 * wool-provider-write-proxy.test.ts 承载，本文件只断言「插件侧 API 真实可达宿主」的
 * 往返与关键拒绝路径的错误可见性。
 *
 * 对连形态：真实 PluginRpcServer + 真实 PluginRpcClient（bootstrap 模块级单例
 * workerRpcClient，e2e attach 内存端口先例）经双向泵直连——不经真实 Worker 线程。
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-provider-access-plugin-side.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { registerProviderWriteProxy } from '../src/services/provider-write-proxy.js'
import type { ProviderWriteProxyDeps } from '../src/services/provider-write-proxy.js'
import {
  registerOpenUrlRpcHandler,
  registerPluginEventRpcHandler,
  PLUGIN_UI_EVENT_NOTIFY,
} from '../src/services/plugin-service/plugin-rpc-setup.js'
import {
  createAgentAPI,
  workerRpcClient,
  disposePluginUiEventHandlers,
} from '../src/services/plugin-service/plugin-bootstrap.js'
import type { PluginEventPayload } from '@taiji/shared'

const PLUGIN_ID = 'plugin-wool-workbuddy' // deriveNamespace → 'wool-workbuddy'
const NS_PROVIDER_ID = 'wool-workbuddy'

/** 伪 manifest（provider-write-proxy 身份/命名空间/能力判定的输入） */
function manifestDeps(overrides: Partial<ProviderWriteProxyDeps> = {}): ProviderWriteProxyDeps {
  return {
    setProvider: vi.fn(async () => ({})),
    deleteProvider: vi.fn(async () => ({ removed: true })),
    resolveProviderCredential: vi.fn(async () => ({ key: 'sk-test', source: 'models.json', kind: 'api_key' } as const)),
    readPluginManifest: () => ({ pkgName: PLUGIN_ID, capabilities: ['network.http'] }),
    ...overrides,
  }
}

/**
 * Worker ↔ 宿主 双向泵：workerRpcClient 出站请求喂 rpcServer.dispatch；server 回包 /
 * 通知转回 client。in-flight dispatch 收集在 settle 里排干（出口 promise 依赖回喂，
 * 先 await 出口再 settle 一次排掉余量）。
 */
function wireLoop(rpcServer: PluginRpcServer) {
  const inflight: Array<Promise<void>> = []
  const port = {
    postMessage(msg: unknown) {
      const m = msg as {
        response?: unknown
        notification?: unknown
        method?: string
        id?: number
        params?: Record<string, unknown>
      }
      if (m.response !== undefined) {
        workerRpcClient.handleResponse(m.response as Parameters<typeof workerRpcClient.handleResponse>[0])
        return
      }
      if (m.notification !== undefined) {
        workerRpcClient.handleNotification(m.notification as Parameters<typeof workerRpcClient.handleNotification>[0])
        return
      }
      if (typeof m.method === 'string') {
        inflight.push(
          rpcServer
            .dispatch('w1', { jsonrpc: '2.0', id: m.id ?? 0, method: m.method, params: m.params ?? {} })
            .then(() => {}),
        )
      }
    },
  } as unknown as WorkerPort
  rpcServer.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: PLUGIN_ID })
  workerRpcClient.attach(port)
  return {
    async settle() {
      await Promise.all(inflight.splice(0))
    },
  }
}

describe('providers.write 往返（D4 插件侧 → 宿主写策略链）', () => {
  it('命名空间内写入：SDK 出口载荷到达 setProvider，回执 {written,providerId} 回到插件侧', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const receipt = await api.providers.write({
      providerId: NS_PROVIDER_ID,
      apiKey: 'sk-test',
      displayName: 'Wool WorkBuddy',
      headers: { 'x-a': '1' },
      models: ['m1', { id: 'm2', name: 'Model Two' }],
    })
    await loop.settle()

    expect(receipt).toEqual({ written: true, providerId: NS_PROVIDER_ID })
    expect(deps.setProvider).toHaveBeenCalledTimes(1)
    // handleProviderWrite 对 models 对象条目只挡越形、不裁字段（结构细节交写策略链
    // 既有防线，provider-write-proxy.ts「本层只挡明显越形」）——断言与实装同形
    expect(deps.setProvider).toHaveBeenCalledWith(NS_PROVIDER_ID, {
      name: 'Wool WorkBuddy',
      apiKey: 'sk-test',
      headers: { 'x-a': '1' },
      models: ['m1', { id: 'm2', name: 'Model Two' }],
    })
  })

  it('越权 providerId：宿主 NAMESPACE_MISMATCH 拒绝经 RPC 错误回执回到插件侧可见', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    await expect(api.providers.write({ providerId: 'other-provider', apiKey: 'sk-x' })).rejects.toThrow(
      /NAMESPACE_MISMATCH/,
    )
    await loop.settle()
    expect(deps.setProvider).not.toHaveBeenCalled()
  })
})

describe('providers.credential 往返（D4 受控明文回读）', () => {
  it('已声明 network.http：唯一读通道回执直透插件侧（定向 reply）', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const reply = await api.providers.credential(NS_PROVIDER_ID)
    await loop.settle()

    expect(reply).toEqual({ providerId: NS_PROVIDER_ID, key: 'sk-test', source: 'models.json', kind: 'api_key' })
    expect(deps.resolveProviderCredential).toHaveBeenCalledWith(NS_PROVIDER_ID)
  })

  it('未声明 network.http：宿主 PERMISSION_DENIED 拒绝回到插件侧（读通道不触达）', async () => {
    const deps = manifestDeps({ readPluginManifest: () => ({ pkgName: PLUGIN_ID, capabilities: [] }) })
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    await expect(api.providers.credential(NS_PROVIDER_ID)).rejects.toThrow(/PERMISSION_DENIED/)
    await loop.settle()
    expect(deps.resolveProviderCredential).not.toHaveBeenCalled()
  })
})

describe('providers.delete 往返（D4 卸载清理通道）', () => {
  it('命名空间内删除：deleteProvider 触达，回执 {deleted,providerId} 回到插件侧', async () => {
    const deps = manifestDeps()
    const server = new PluginRpcServer()
    registerProviderWriteProxy(server, deps)
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const receipt = await api.providers.delete(NS_PROVIDER_ID)
    await loop.settle()

    expect(receipt).toEqual({ deleted: true, providerId: NS_PROVIDER_ID })
    expect(deps.deleteProvider).toHaveBeenCalledWith(NS_PROVIDER_ID)
  })
})

describe('ui.openUrl 往返（D9 授权页打开）', () => {
  it('https URL：scheme 白名单放行，宿主唤起出口收到 URL，回执 {opened:true}', async () => {
    const openExternal = vi.fn()
    const server = new PluginRpcServer()
    registerOpenUrlRpcHandler(server, { openExternal })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const receipt = await api.ui.openUrl('https://auth.example.com/oauth')
    await loop.settle()

    expect(receipt).toEqual({ opened: true })
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.com/oauth')
  })

  it('file:// URL：入口拒绝（INVALID_URL_SCHEME 回到插件侧），唤起出口不触达', async () => {
    const openExternal = vi.fn()
    const server = new PluginRpcServer()
    registerOpenUrlRpcHandler(server, { openExternal })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    await expect(api.ui.openUrl('file:///etc/passwd')).rejects.toThrow(/INVALID_URL_SCHEME/)
    await loop.settle()
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('events.report 往返（D9 插件 → renderer 业务事件上报）', () => {
  it('上报经宿主 plugin.event handler 校验后广播，pluginId 取通道身份，回执 {forwarded:true}', async () => {
    const broadcasts: PluginEventPayload[] = []
    const server = new PluginRpcServer()
    registerPluginEventRpcHandler(server, {
      broadcast: (payload) => broadcasts.push(payload),
    })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const receipt = await api.events.report('credential-status', { loggedIn: false, reason: 'upstream-401' })
    await loop.settle()

    expect(receipt).toEqual({ forwarded: true })
    expect(broadcasts).toEqual([
      {
        pluginId: PLUGIN_ID, // 通道身份（registerWorker 注册），非载荷自报
        channel: 'credential-status',
        payload: { loggedIn: false, reason: 'upstream-401' },
      },
    ])
  })

  it('payload 超 PLUGIN_EVENT_PAYLOAD_MAX_BYTES 在入口拒绝（C-comm-14 全局广播通路入口防线，D5 F1-23）', async () => {
    const broadcasts: PluginEventPayload[] = []
    const server = new PluginRpcServer()
    registerPluginEventRpcHandler(server, {
      broadcast: (payload) => broadcasts.push(payload),
    })
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)

    const huge = 'x'.repeat(129 * 1024) // 129KB > 128KB 上限
    await expect(api.events.report('huge-payload', { blob: huge })).rejects.toMatchObject({
      code: 'PLUGIN_EVENT_PAYLOAD_TOO_LARGE',
    })
    await loop.settle()
    expect(broadcasts).toEqual([]) // 超限不进广播
  })
})

describe('views.onUiEvent 接收注册（D8 输入值回传）', () => {
  it('宿主 PLUGIN_UI_EVENT_NOTIFY 通知到达 Worker 后分发到插件 handler（载荷四字段透传）', async () => {
    const server = new PluginRpcServer()
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)
    const received: Array<{ viewId: string; componentId: string; event: string; value: unknown }> = []
    const disposable = api.views.onUiEvent((event) => received.push(event))

    server.notify('w1', PLUGIN_UI_EVENT_NOTIFY, {
      viewId: 'authorize-view',
      componentId: 'pat-input',
      event: 'change',
      value: 'token-123',
    })
    await loop.settle()

    expect(received).toEqual([
      { viewId: 'authorize-view', componentId: 'pat-input', event: 'change', value: 'token-123' },
    ])
    disposable.dispose()
  })

  it('handler dispose 后不再投递；deactivate 对偶清理（disposePluginUiEventHandlers）同效', async () => {
    const server = new PluginRpcServer()
    const loop = wireLoop(server)
    const api = createAgentAPI(PLUGIN_ID)
    const received: unknown[] = []
    const disposable = api.views.onUiEvent((event) => received.push(event))

    disposable.dispose()
    server.notify('w1', PLUGIN_UI_EVENT_NOTIFY, { viewId: 'v', componentId: 'c', event: 'change', value: 1 })
    await loop.settle()
    expect(received).toHaveLength(0)

    // deactivate 清理路径：重新注册后经模块级清理函数摘除（handleDeactivate 分支同款）
    api.views.onUiEvent((event) => received.push(event))
    disposePluginUiEventHandlers(PLUGIN_ID)
    server.notify('w1', PLUGIN_UI_EVENT_NOTIFY, { viewId: 'v', componentId: 'c', event: 'change', value: 2 })
    await loop.settle()
    expect(received).toHaveLength(0)
  })
})
