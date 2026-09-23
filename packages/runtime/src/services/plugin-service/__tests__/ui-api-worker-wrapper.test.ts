/**
 * ui-api Worker 侧包装面 + B-F2 广播缺失降级包装测试（MF-1-23）。
 *
 * 两块此前无测试的面（运行时仲裁面已有 contract 测试，但 Worker 侧包装面与装配侧
 * 降级包装没有）：
 *   1. createUiApi（Worker 侧）：onModalClosed 多订阅派发（单 notification listener +
 *      本地 Set——双订阅互不覆盖、dispose 后停派）与 showModal/hideModal/
 *      updateHeaderAction 的 RPC 转发体（method/params 组装 + result 透传）。走真实
 *      PluginRpcClient（fake port 捕获出站帧 + handleResponse/handleNotification 回注），
 *      不 mock client——链路即生产形态。
 *   2. plugin-rpc-setup 的 B-F2 降级包装：registerAllRpcMethods 装配的
 *      broadcastModalState/broadcastHeaderActionUpdate 在 deps.broadcastFn 缺失时返回
 *      false + warn 丢弃——ui-api 据此不谎报成功（showModal reject
 *      MODAL_BROADCAST_NOT_WIRED、updateHeaderAction 回 {updated:false}）。对照：
 *      broadcastFn 在场时开层成功且帧真正发出。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PluginRpcClient } from '../plugin-rpc-client.js'
import { PluginRpcServer } from '../plugin-rpc-server.js'
import type { WorkerPort } from '../plugin-rpc-server.js'
import { createUiApi, resetRuntimeModalSlotForTest, PLUGIN_MODAL_CLOSED_NOTIFY_METHOD } from '../api/ui-api.js'
import { registerAllRpcMethods } from '../plugin-rpc-setup.js'
import type { RpcSetupContext } from '../plugin-rpc-setup.js'
import type { IPluginServiceDeps } from '../plugin-types.js'
import { SessionEventDispatch, ActiveSessionResolver } from '../api/session-api.js'
import { EntryInvalidationDispatch } from '../plugin-entry-invalidation-dispatch.js'
import { PluginStorage } from '../plugin-storage.js'

/** modal 关闭事件形状（onModalClosed handler 入参）。 */
interface ModalClosedEvent {
  modalId: string
  reason: string
}

/** Worker 侧出站帧（RpcRequest & { type: 'rpc' }）。 */
interface OutboundRpcFrame {
  type: string
  method: string
  id?: number
  params: Record<string, unknown>
}

/** 真实 PluginRpcClient + fake port：捕获出站帧，测试侧回注 response/notification。 */
function makeWorkerClient(): { client: PluginRpcClient; sent: OutboundRpcFrame[] } {
  const sent: OutboundRpcFrame[] = []
  const client = new PluginRpcClient()
  client.attach({ postMessage: (m: unknown) => { sent.push(m as OutboundRpcFrame) } })
  return { client, sent }
}

/** 对指定出站请求帧回注成功响应（request 帧必有 id——运行时 guard 收窄可选类型）。 */
function replyResult(client: PluginRpcClient, frame: OutboundRpcFrame, result: unknown): void {
  if (frame.id === undefined) throw new Error(`outbound frame missing id: ${frame.method}`)
  client.handleResponse({ jsonrpc: '2.0', id: frame.id, result })
}

describe('createUiApi Worker 侧包装面', () => {
  it('onModalClosed 多订阅派发：同一 modalClosed 通知派发到全部订阅 handler（互不覆盖）', () => {
    const { client } = makeWorkerClient()
    const api = createUiApi(client, 'plugin-a')
    const seen1: ModalClosedEvent[] = []
    const seen2: ModalClosedEvent[] = []
    api.onModalClosed((e) => seen1.push(e))
    api.onModalClosed((e) => seen2.push(e))

    client.handleNotification({
      jsonrpc: '2.0',
      method: PLUGIN_MODAL_CLOSED_NOTIFY_METHOD,
      params: { modalId: 'm1', reason: 'dismissed' },
    })

    expect(seen1).toEqual([{ modalId: 'm1', reason: 'dismissed' }])
    expect(seen2).toEqual([{ modalId: 'm1', reason: 'dismissed' }])
  })

  it('onModalClosed dispose 语义：注销后停派，其余 handler 不受影响', () => {
    const { client } = makeWorkerClient()
    const api = createUiApi(client, 'plugin-a')
    const h1 = vi.fn()
    const h2 = vi.fn()
    api.onModalClosed(h1)
    const disposable2 = api.onModalClosed(h2)

    const notify = (): void => {
      client.handleNotification({
        jsonrpc: '2.0',
        method: PLUGIN_MODAL_CLOSED_NOTIFY_METHOD,
        params: { modalId: 'm1', reason: 'replaced' },
      })
    }
    notify()
    disposable2.dispose()
    notify()

    expect(h1).toHaveBeenCalledTimes(2)
    expect(h2).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenLastCalledWith({ modalId: 'm1', reason: 'replaced' })
  })

  it('showModal 转发体：method/params 组装 + result 透传', async () => {
    const { client, sent } = makeWorkerClient()
    const api = createUiApi(client, 'plugin-a')
    const pending = api.showModal('m1', { sessionId: 's1', title: 'T', width: 'md' })

    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('plugin.ui.showModal')
    expect(sent[0].params).toEqual({ pluginId: 'plugin-a', modalId: 'm1', sessionId: 's1', title: 'T', width: 'md' })

    replyResult(client, sent[0], { opened: true, epoch: 3 })
    await expect(pending).resolves.toEqual({ opened: true, epoch: 3 })
  })

  it('hideModal 转发体：method/params 组装 + result 透传', async () => {
    const { client, sent } = makeWorkerClient()
    const api = createUiApi(client, 'plugin-a')
    const pending = api.hideModal('m1')

    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('plugin.ui.hideModal')
    expect(sent[0].params).toEqual({ pluginId: 'plugin-a', modalId: 'm1' })

    replyResult(client, sent[0], { closed: true })
    await expect(pending).resolves.toEqual({ closed: true })
  })

  it('updateHeaderAction 转发体：headerActionId 映射 + opts 展开 + result 透传', async () => {
    const { client, sent } = makeWorkerClient()
    const api = createUiApi(client, 'plugin-a')
    const pending = api.updateHeaderAction('ha1', { sessionId: 's1', badge: '3', tooltip: 'tips' })

    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('plugin.ui.updateHeaderAction')
    expect(sent[0].params).toEqual({
      pluginId: 'plugin-a',
      headerActionId: 'ha1',
      sessionId: 's1',
      badge: '3',
      tooltip: 'tips',
    })

    replyResult(client, sent[0], { updated: true })
    await expect(pending).resolves.toEqual({ updated: true })
  })
})

// ── B-F2 广播缺失降级包装（plugin-rpc-setup 装配侧）──────────────────────────

/** dispatch 回包帧（host → worker port postMessage 形态）。 */
interface HostReplyFrame {
  type: string
  response: { id?: number | string | null; result?: unknown; error?: { code: unknown; message: string } }
}

/**
 * 真实 PluginRpcServer + registerAllRpcMethods 全量装配：dispatch plugin.ui.* 请求，
 * 从 fake worker port 捕获回包。deps 按用例注入（broadcastFn 缺失 / 在场两分支）；
 * broadcastCalls 捕获在场分支的广播帧参数。
 */
function assemble(deps: IPluginServiceDeps): {
  server: PluginRpcServer
  frames: HostReplyFrame[]
  broadcastCalls: unknown[][]
} {
  const frames: HostReplyFrame[] = []
  const broadcastCalls: unknown[][] = []
  const port: WorkerPort = { postMessage: (m: unknown) => { frames.push(m as HostReplyFrame) } }
  const server = new PluginRpcServer()
  server.registerWorker('w1', port)
  const broadcastDeps: IPluginServiceDeps = deps.broadcastFn
    ? { ...deps, broadcastFn: (type: string, payload: unknown) => { broadcastCalls.push([type, payload]) } }
    : deps
  const ctx = {
    rpcServer: server,
    storage: new PluginStorage(),
    toolRegistry: new Map(),
    hookRegistry: new Map(),
    statusBarItems: new Map(),
    deps: broadcastDeps,
    broadcastStatusBarItems: vi.fn(),
    handleUiRequest: vi.fn(),
    cancelUiRequest: vi.fn(),
    syncToolsToBridge: vi.fn(),
    getDescriptor: vi.fn(),
    sessionDataStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn(() => []) },
    activeSessionResolver: new ActiveSessionResolver(broadcastDeps),
    commandRegistry: new Map(),
    sessionEvents: new SessionEventDispatch(server),
    entryInvalidation: new EntryInvalidationDispatch({ sessionExists: () => true }),
    mountPoints: [],
    deliverInvokeResult: vi.fn(),
    publishViewUpdate: vi.fn(),
  } as unknown as RpcSetupContext
  registerAllRpcMethods(ctx)
  return { server, frames, broadcastCalls }
}

describe('B-F2 广播缺失降级包装（registerAllRpcMethods → wireRuntimeModalExits）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // modal 槽是模块级单例（ui-api 文件头「测试用 resetRuntimeModalSlotForTest 复位」）
    resetRuntimeModalSlotForTest()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('broadcastFn 缺失：showModal 的 modal-open 广播被 warn 丢弃 → 拒开层（MODAL_BROADCAST_NOT_WIRED，不回假成功）', async () => {
    const { server, frames } = assemble({})
    await server.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.ui.showModal',
      params: { pluginId: 'plugin-a', modalId: 'm1', sessionId: 's1' },
    })

    expect(frames).toHaveLength(1)
    const error = frames[0].response.error
    expect(error).toBeDefined()
    // plugin 域字符串码按既有契约原样透传（plugin-rpc-server replyHandlerError 分支③）
    expect(error?.code).toBe('MODAL_BROADCAST_NOT_WIRED')
    // 降级包装出声：warn 丢弃可观测（不静默）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('plugin:modalState broadcast dropped: no broadcastFn configured'),
    )
  })

  it('broadcastFn 缺失：updateHeaderAction 回 {updated:false}（不谎报渲染端已收到）+ warn', async () => {
    const { server, frames } = assemble({})
    await server.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'plugin.ui.updateHeaderAction',
      params: { pluginId: 'plugin-a', headerActionId: 'ha1', sessionId: 's1', badge: '3' },
    })

    expect(frames).toHaveLength(1)
    expect(frames[0].response.result).toEqual({ updated: false })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('plugin:headerActionUpdate broadcast dropped: no broadcastFn configured'),
    )
  })

  it('对照：broadcastFn 在场 → showModal 开层成功且 plugin:modalState 帧真正发出', async () => {
    const { server, frames, broadcastCalls } = assemble({
      broadcastFn: () => {},
    })
    await server.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'plugin.ui.showModal',
      params: { pluginId: 'plugin-a', modalId: 'm1', sessionId: 's1', title: 'T' },
    })

    expect(frames).toHaveLength(1)
    expect(frames[0].response.result).toEqual({ opened: true, epoch: 1 })
    expect(broadcastCalls).toHaveLength(1)
    const [type, payload] = broadcastCalls[0] as [string, Record<string, unknown>]
    expect(type).toBe('plugin:modalState')
    expect(payload).toMatchObject({ pluginId: 'plugin-a', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 })
  })
})
