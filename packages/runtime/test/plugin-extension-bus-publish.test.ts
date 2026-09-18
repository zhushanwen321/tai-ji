/**
 * wave:perf-w08（02 文档 D1-1）——plugin / extension 消息接 MessageBus 的回归保护。
 *
 * 覆盖 plan.md W08 验收点的断言：
 * - plugin:viewUpdate（transient）：bus 装配时经 publish 定向——订阅者收到、无 seq、
 *   不入 ring、seq 计数不推进、不再全局 broadcast；bus 未装配回退全局广播。
 * - plugin:uiRequest（stream）：sid 为 string 且 bus 装配 → publish 定向（有 seq、
 *   入 ring 可回放）且不再 broadcast；sid undefined（无活跃 session）保持全局 broadcast。
 *
 * 测试框架：vitest（禁止 node:test）。运行：
 * cd packages/runtime && npx vitest run test/plugin-extension-bus-publish.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { MessageBus } from '../src/services/message-bus/message-bus.js'
import type { BusClient } from '../src/services/message-bus/types.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { RpcRequest } from '../src/services/plugin-service/plugin-types.js'
import type { IMessageBroker, ISessionService } from '../src/interfaces.js'
import type { IPluginServiceDeps } from '../src/services/plugin-service/plugin-types.js'

// ── fixtures ──────────────────────────────────────────────────

/** message-bus.test.ts 同款 mock 订阅者：sent 捕获全部 send 调用。 */
function createMockClient(): BusClient & { sent: string[] } {
  const sent: string[] = []
  return {
    readyState: 1,
    send: (data: string) => {
      sent.push(data)
    },
    sent,
  }
}

function createMockBroker(): IMessageBroker & { broadcasts: unknown[] } {
  const broadcasts: unknown[] = []
  return {
    broadcasts,
    send: vi.fn(),
    broadcast: vi.fn((msg) => {
      broadcasts.push(msg)
    }),
    sendError: vi.fn(),
  }
}

/** 活跃 session 桩：ActiveSessionResolver 经 listPersistedSessions 扫描 status==='active'。 */
function createActiveSessionStub(sessionId: string): ISessionService {
  return {
    listPersistedSessions: () => [{
      cwd: '/tmp',
      sessions: [{ id: sessionId, label: sessionId, cwd: '/tmp', status: 'active', lastActiveAt: 1, modelId: 'test-model' }],
    }],
  } as unknown as ISessionService
}

/** 记录 postMessage 的 mock WorkerPort（plugin-commands-views.test.ts 同款）。 */
function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  } as unknown as WorkerPort & { messages: unknown[] }
}

/**
 * 构造已接线的 PluginService（registerRpcMethods + rpcServer 注册 mock worker），
 * 返回 service + rpcServer + 依赖注入点（bus / broadcastFn / broker）。
 */
function wiredPluginService(opts: { sessionService?: ISessionService } = {}) {
  const broker = createMockBroker()
  const broadcastFn = vi.fn()
  const deps: IPluginServiceDeps = { broadcastFn, ...opts }
  const service = new PluginService(new PluginRegistry('/tmp/fake-project', '/tmp/fake-project'), broker, deps)
  ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
  const rpcServer = (service as unknown as { rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>>; registerWorker(w: string, p: WorkerPort): void; dispatch(w: string, message: RpcRequest): Promise<void> } }).rpcServer
  const port = createMockPort()
  rpcServer.registerWorker('w1', port)
  const dispatch = (method: string, params: Record<string, unknown>) =>
    rpcServer.dispatch('w1', { jsonrpc: '2.0', id: 1, method, params })
  return { service, broker, broadcastFn, dispatch }
}

// ══════════════════════════════════════════════════════════════
// plugin:viewUpdate —— transient 类（不占 seq、不入 ring、直传订阅者）
// ══════════════════════════════════════════════════════════════

describe('W08: plugin:viewUpdate 经 bus publish（transient）', () => {
  it('bus 装配 + 活跃 session → 订阅者收到、无 seq、不入 ring、seq 计数不变、不再 broadcast', async () => {
    const bus = new MessageBus()
    const { service, broker, broadcastFn, dispatch } = wiredPluginService({ sessionService: createActiveSessionStub('s1') })
    service.setMessageBus(bus)

    const ws = createMockClient()
    bus.subscribe('s1', ws)

    await dispatch('plugin.views.update', { pluginId: 'p1', viewId: 'v1', guiTree: [] })

    // 订阅者收到（直传）
    expect(ws.sent).toHaveLength(1)
    const parsed = JSON.parse(ws.sent[0]!) as { type: string; payload: { sessionId: string; viewId: string; pluginId: string }; seq?: number }
    expect(parsed.type).toBe('plugin:viewUpdate')
    expect(parsed.payload.sessionId).toBe('s1')
    expect(parsed.payload.viewId).toBe('v1')
    expect(parsed.payload.pluginId).toBe('p1')
    // transient：无 seq 字段
    expect(parsed.seq).toBeUndefined()

    // transient：不入 ring、seq 计数不推进（第二个订阅者回放视角）
    const ws2 = createMockClient()
    const snap = bus.subscribe('s1', ws2)
    expect(snap.snapshot).toHaveLength(0)
    expect(snap.lastSeq).toBe(0)

    // 不再 broadcast（02 D1-1：sid 为 string 时只 publish）
    expect(broadcastFn).not.toHaveBeenCalled()
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('bus 未装配 → 回退全局广播（broadcastFn），消息不丢', async () => {
    const { broadcastFn, dispatch } = wiredPluginService({ sessionService: createActiveSessionStub('s1') })

    await dispatch('plugin.views.update', { pluginId: 'p1', viewId: 'v1', guiTree: [] })

    expect(broadcastFn).toHaveBeenCalledTimes(1)
    const [type, payload] = broadcastFn.mock.calls[0] as [string, { sessionId: string; viewId: string }]
    expect(type).toBe('plugin:viewUpdate')
    expect(payload.sessionId).toBe('s1')
    expect(payload.viewId).toBe('v1')
  })

  it('m3: 同 tick 连续 views.update → push id 单调递增不碰撞（原 vu_${Date.now()} 同毫秒碰撞）', async () => {
    const bus = new MessageBus()
    const { service } = wiredPluginService({ sessionService: createActiveSessionStub('s1') })
    service.setMessageBus(bus)
    const ws = createMockClient()
    bus.subscribe('s1', ws)

    // 直接调 publishViewUpdate 两次（rpc dispatch 路径等价，绕开 worker 回环更聚焦 id 语义）
    const mkPayload = (viewId: string) => ({
      sessionId: 's1', viewId, pluginId: 'p1',
      // 空树字面量推断 never[]，可赋给 GuiComponent[]（原 `as unknown[]` 逃逸类型检查，tsc 报错）
      guiTree: [], updatedAt: Date.now(),
    })
    service.publishViewUpdate(mkPayload('v1'))
    service.publishViewUpdate(mkPayload('v2'))

    expect(ws.sent).toHaveLength(2)
    const id1 = (JSON.parse(ws.sent[0]!) as { id: string }).id
    const id2 = (JSON.parse(ws.sent[1]!) as { id: string }).id
    expect(id1).toMatch(/^vu_\d+$/)
    expect(id2).toMatch(/^vu_\d+$/)
    expect(id1).not.toBe(id2)
  })
})

// ══════════════════════════════════════════════════════════════
// plugin:uiRequest —— stream 类（分配 seq、入 ring 可回放）
// ══════════════════════════════════════════════════════════════

describe('W08: plugin:uiRequest 经 bus publish（stream）', () => {
  /** 触发一次 uiRequest：调 plugin.ui.showConfirm RPC，返回 confirm promise。 */
  function triggerUiRequest(service: PluginService): Promise<unknown> {
    const rpcServer = (service as unknown as { rpcServer: { methods: Map<string, (params: Record<string, unknown>) => Promise<unknown>> } }).rpcServer
    return rpcServer.methods.get('plugin.ui.showConfirm')!({
      pluginId: 'test-plugin',
      title: 'Confirm?',
      message: 'Are you sure?',
    })
  }

  it('bus 装配 + 活跃 session → 订阅者收到、有 seq、入 ring；不再全局 broadcast', async () => {
    const bus = new MessageBus()
    const broker = createMockBroker()
    const service = new PluginService(
      new PluginRegistry('/tmp/fake-project', '/tmp/fake-project'),
      broker,
      { broadcastFn: vi.fn(), sessionService: createActiveSessionStub('s1') },
    )
    service.setMessageBus(bus)
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()

    const ws = createMockClient()
    bus.subscribe('s1', ws)

    const confirmPromise = triggerUiRequest(service)

    // 订阅者收到（stream 类）
    expect(ws.sent).toHaveLength(1)
    const parsed = JSON.parse(ws.sent[0]!) as { type: string; payload: { sessionId: string; requestId: string }; seq?: number }
    expect(parsed.type).toBe('plugin:uiRequest')
    expect(parsed.payload.sessionId).toBe('s1')
    expect(parsed.payload.requestId).toBeTruthy()
    expect(parsed.seq).toBe(1)

    // 入 ring：第二个订阅者回放可见
    const ws2 = createMockClient()
    const snap = bus.subscribe('s1', ws2)
    expect(snap.snapshot).toHaveLength(1)
    expect(snap.snapshot[0]!.type).toBe('plugin:uiRequest')
    expect(snap.snapshot[0]!.seq).toBe(1)
    expect(snap.lastSeq).toBe(1)

    // sid 为 string 时不再全局 broadcast（02 D1-1）
    expect(broker.broadcast).not.toHaveBeenCalled()

    // 收尾：respond 避免悬挂 promise
    service.handleUiResponse(parsed.payload.requestId, true)
    await expect(confirmPromise).resolves.toBe(true)
  })

  it('无活跃 session（sid undefined）+ bus 装配 → 保持全局 broadcast，bus 零 publish', async () => {
    const bus = new MessageBus()
    const publishSpy = vi.spyOn(bus, 'publish')
    const broker = createMockBroker()
    const service = new PluginService(
      new PluginRegistry('/tmp/fake-project', '/tmp/fake-project'),
      broker,
      { broadcastFn: (type, payload) => broker.broadcast({ type, payload } as never) },
    )
    service.setMessageBus(bus)
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()

    const confirmPromise = triggerUiRequest(service)

    // sid undefined：全局 broadcast 兜底（无活跃 session 的弹窗必达全部连接）
    expect(broker.broadcast).toHaveBeenCalledTimes(1)
    const bcast = broker.broadcasts[0] as { type: string; payload: { requestId: string; sessionId?: string } }
    expect(bcast.type).toBe('plugin:uiRequest')
    expect(bcast.payload.sessionId).toBeUndefined()
    expect(publishSpy).not.toHaveBeenCalled()

    service.handleUiResponse(bcast.payload.requestId, true)
    await expect(confirmPromise).resolves.toBe(true)
  })
})
