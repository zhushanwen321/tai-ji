/**
 * PluginUiSnapshotStore + plugin.ui.snapshot 拉取链测试（ADR-0097 拉为主，scheduler-quickcard-pull-based）。
 *
 * 覆盖：
 * - store 直测：写入 / 同键覆盖 / `[null]` 清除语义（与渲染端 ViewHostStore.consumeWidget
 *   同构）/ snapshot 过滤（scope 二选一：sessionId / mountId+pluginId / viewId / 全量）/
 *   clearForSession / clearForPlugin / generation 单调分配（U2 全量替换代际）
 * - 全链写入联动（真实 PluginService 装配）：plugin.ui.updateHeaderAction 与
 *   plugin.views.update 的校验出口处快照写入（广播独立成败不影响快照真值）+
 *   plugin.views.update 归属二选一校验（U2：都缺/都给 → INVALID_VIEW_SCOPE）+
 *   plugin.ui.snapshot WS handler 读出回包（handler_error 前置 / reply payload 形状）
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-ui-snapshot.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PluginMessageHandler } from '../src/transport/plugin-message-handler.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginUiSnapshotStore } from '../src/services/plugin-service/plugin-ui-snapshot-store.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { HeaderActionUpdatePayload, PluginUiSnapshotPayload, ViewSnapshotItem } from '@taiji/shared'

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

    // clearForPlugin 跨会话/全局域清剩余 p2 条目（挂载位分区由插件维度清理链兜底——
    // clearForMount 已随 D5 F1-15 裁决删除：零消费方，现实清理场景全部走 clearForPlugin）
    store.clearForPlugin('p2')
    expect(store.snapshot()).toEqual({ headerActions: [], views: [] })
  })
})

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
