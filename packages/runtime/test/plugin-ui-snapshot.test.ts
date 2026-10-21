/**
 * PluginUiSnapshotStore + plugin.ui.snapshot 拉取链测试（ADR-0097 拉为主，scheduler-quickcard-pull-based）。
 *
 * 覆盖：
 * - store 直测：写入 / 同键覆盖 / `[null]` 清除语义（与渲染端 ViewHostStore.consumeWidget
 *   同构）/ snapshot 过滤（sessionId / viewId / 全量）/ clearForSession / clearForPlugin
 * - 全链写入联动（真实 PluginService 装配）：plugin.ui.updateHeaderAction 与
 *   plugin.views.update 的校验出口处快照写入（广播独立成败不影响快照真值）+
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
import type { HeaderActionUpdatePayload, PluginUiSnapshotPayload } from '@taiji/shared'

function headerAction(overrides: Partial<HeaderActionUpdatePayload> = {}): HeaderActionUpdatePayload {
  return { pluginId: 'p1', headerActionId: 'a1', sessionId: 's1', ...overrides }
}

function viewItem(overrides: Record<string, unknown> = {}): { sessionId: string; viewId: string; pluginId: string; guiTree: unknown[]; updatedAt: number } {
  return { sessionId: 's1', viewId: 'v1', pluginId: 'p1', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }], updatedAt: 1, ...overrides }
}

// ── store 直测 ──────────────────────────────────────────────

describe('PluginUiSnapshotStore', () => {
  it('写入 + snapshot 全量读出（headerActions / views 两族）', () => {
    const store = new PluginUiSnapshotStore()
    store.setHeaderAction(headerAction({ badge: '2' }))
    store.setHeaderAction(headerAction({ headerActionId: 'a2', sessionId: 's2', hidden: true }))
    store.setView(viewItem())
    expect(store.snapshot()).toEqual({
      headerActions: [headerAction({ badge: '2' }), headerAction({ headerActionId: 'a2', sessionId: 's2', hidden: true })],
      views: [viewItem()],
    })
  })

  it('同键二次写入覆盖（最新帧为准）', () => {
    const store = new PluginUiSnapshotStore()
    store.setHeaderAction(headerAction({ badge: '1' }))
    store.setHeaderAction(headerAction({ badge: '3' }))
    expect(store.snapshot().headerActions).toHaveLength(1)
    expect(store.snapshot().headerActions[0].badge).toBe('3')
  })

  it('[null] 树 = 删除分区条目（清除语义，非存 null 树）', () => {
    const store = new PluginUiSnapshotStore()
    store.setView(viewItem())
    store.setView(viewItem({ guiTree: [null] }))
    expect(store.snapshot().views).toHaveLength(0)
    // 未写入过的 viewId 直接推 [null]：no-op 不抛
    expect(() => store.setView(viewItem({ viewId: 'ghost', guiTree: [null] }))).not.toThrow()
  })

  it('snapshot 过滤：sessionId 收窄两族 / viewId 只收窄视图族', () => {
    const store = new PluginUiSnapshotStore()
    store.setHeaderAction(headerAction())
    store.setHeaderAction(headerAction({ sessionId: 's2' }))
    store.setView(viewItem())
    store.setView(viewItem({ sessionId: 's2', viewId: 'v2' }))

    expect(store.snapshot({ sessionId: 's2' })).toEqual({
      headerActions: [headerAction({ sessionId: 's2' })],
      views: [viewItem({ sessionId: 's2', viewId: 'v2' })],
    })
    expect(store.snapshot({ sessionId: 's1', viewId: 'v1' })).toEqual({
      headerActions: [headerAction()],
      views: [viewItem()],
    })
    // 未命中 = 空集（渲染端按未推送处理）
    expect(store.snapshot({ sessionId: 'missing' })).toEqual({ headerActions: [], views: [] })
  })

  it('clearForSession 清该会话两族；clearForPlugin 跨会话按 pluginId 清并移除空分区', () => {
    const store = new PluginUiSnapshotStore()
    store.setHeaderAction(headerAction())
    store.setHeaderAction(headerAction({ headerActionId: 'a2', sessionId: 's2', pluginId: 'p2' }))
    store.setView(viewItem())
    store.setView(viewItem({ sessionId: 's2', viewId: 'v2', pluginId: 'p2' }))

    store.clearForSession('s1')
    expect(store.snapshot().headerActions.map((h) => h.sessionId)).toEqual(['s2'])
    expect(store.snapshot().views.map((v) => v.sessionId)).toEqual(['s2'])

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
      views: [viewItem({ sessionId: 's2', viewId: 'v2' })],
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
})
