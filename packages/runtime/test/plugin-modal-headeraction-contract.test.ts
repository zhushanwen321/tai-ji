/**
 * plugin modal/headerAction 点位契约测试（plugin-header-action-modal-points AP-1/AP-2，u5b）
 *
 * 覆盖（impl-plan u5b 验收条款①②对应的 rpc-setup 契约面）：
 * - showModal 仲裁：epoch 单调递增 / 同 (pluginId,modalId) duplicate open 不产生 replaced
 *   但 epoch 递增且总是广播 open / 不同 owner → 旧层 closed{replaced} + notify + 新层 open
 * - E15 INVALID_SESSION_ID 四方法：views.update / showModal / sendMessage / updateHeaderAction
 * - E1 降级：runtime 不读声明（D4），modalId 未声明不拒开（以调用参数开层）
 * - E10：pending ui-request 存在时 showModal 拒绝 MODAL_BLOCKED_BY_UI_REQUEST 且零广播
 * - views.update 显式 sessionId 归属投递（payload.sessionId 直达 handleViewUpdate，
 *   ActiveSessionResolver 盖戳路径已删除——D1 被否④）
 * - sendMessage 回执映射逐 reason 值（{blocked,reason} → {accepted:false,reason}；成功 → {accepted:true}）
 * - updateHeaderAction 校验 + plugin:headerActionUpdate 广播形状
 * - hideModal 走与宿主 dismiss 相同的 closed 路径（owner 匹配 + dismissed）
 * - plugin-gone 槽清理（closeRuntimeModalForPlugin）
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-modal-headeraction-contract.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { registerViewRpcHandlers } from '../src/services/plugin-service/api/views-api.js'
import { registerSessionRpcHandlers, SessionEventDispatch } from '../src/services/plugin-service/api/session-api.js'
import type { SessionHandlers } from '../src/services/plugin-service/api/session-api.js'
import {
  registerUiRpcHandlers,
  wireRuntimeModalExits,
  resetRuntimeModalSlotForTest,
  getRuntimeModalSlot,
  openRuntimeModalSlot,
  closeRuntimeModalForPlugin,
  PLUGIN_MODAL_CLOSED_NOTIFY_METHOD,
} from '../src/services/plugin-service/api/ui-api.js'
import type { PluginModalStatePayload, HeaderActionUpdatePayload } from '@taiji/shared'

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

/** 捕获广播/notify 出线（wireRuntimeModalExits 注入面） */
function wireCapturingExits(overrides: { hasPendingUiRequest?: () => boolean } = {}) {
  const modalState: PluginModalStatePayload[] = []
  const headerAction: HeaderActionUpdatePayload[] = []
  const modalClosedNotifies: Array<{ workerId: string; payload: { modalId: string; reason: string } }> = []
  wireRuntimeModalExits({
    broadcastModalState: (payload) => { modalState.push(payload) },
    broadcastHeaderActionUpdate: (payload) => { headerAction.push(payload) },
    notifyModalClosed: (workerId, payload) => { modalClosedNotifies.push({ workerId, payload }) },
    hasPendingUiRequest: overrides.hasPendingUiRequest,
  })
  return { modalState, headerAction, modalClosedNotifies }
}

/** 最小 UiHandlers（dialog 三方法不触达，vi.fn 占位） */
function minimalUiHandlers() {
  return {
    showSelect: vi.fn(),
    showConfirm: vi.fn(),
    showInput: vi.fn(),
    notify: vi.fn(),
    updateStatusBarItem: vi.fn(),
  }
}

beforeEach(() => {
  resetRuntimeModalSlotForTest()
})

describe('showModal 仲裁（AP-2 开②：epoch / replaced / duplicate-open）', () => {
  it('首次 open：epoch=1，广播 open 帧（payload = 调用参数原文），槽记录 worker 归属', async () => {
    const exits = wireCapturingExits()
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', {
      pluginId: 'scheduler-manager', modalId: 'scheduler-manager.panel', sessionId: 's1', title: '定时任务', width: 'md',
    })

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ opened: true, epoch: 1 })
    expect(exits.modalState).toEqual([{
      pluginId: 'scheduler-manager', modalId: 'scheduler-manager.panel', sessionId: 's1',
      title: '定时任务', width: 'md', state: 'open', epoch: 1,
    }])
    expect(getRuntimeModalSlot()).toMatchObject({ pluginId: 'scheduler-manager', modalId: 'scheduler-manager.panel', workerId: 'w1', epoch: 1 })
  })

  it('同 (pluginId,modalId) duplicate open：不算换主（零 replaced closed/零 notify），epoch 递增并重播 open（renderer 幂等渲染）', async () => {
    const exits = wireCapturingExits()
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })
    const resp = await dispatch(rpc, port, 2, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })

    expect(resp.result).toEqual({ opened: true, epoch: 2 })
    // 两条 open 帧（epoch 1 / 2），无 closed、无 notify
    expect(exits.modalState.map(f => ({ state: f.state, epoch: f.epoch }))).toEqual([
      { state: 'open', epoch: 1 }, { state: 'open', epoch: 2 },
    ])
    expect(exits.modalClosedNotifies).toHaveLength(0)
  })

  it('不同 owner open → 旧层 closed{replaced} + notify 旧 owner（携带旧槽的 workerId/modalId），新层 open epoch 递增', async () => {
    const exits = wireCapturingExits()
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })
    await dispatch(rpc, port, 2, 'plugin.ui.showModal', { pluginId: 'p2', modalId: 'm2', sessionId: 's2' })

    expect(exits.modalState).toEqual([
      { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'open', epoch: 1 },
      { pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 1, reason: 'replaced' },
      { pluginId: 'p2', modalId: 'm2', sessionId: 's2', state: 'open', epoch: 2 },
    ])
    expect(exits.modalClosedNotifies).toEqual([
      { workerId: 'w1', payload: { modalId: 'm1', reason: 'replaced' } },
    ])
    expect(getRuntimeModalSlot()).toMatchObject({ pluginId: 'p2', modalId: 'm2', epoch: 2 })
  })

  it('width 越界 → INVALID_WIDTH 拒绝，不开层不广播', async () => {
    const exits = wireCapturingExits()
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1', width: 'xl' })

    expect(resp.error?.code).toBe('INVALID_WIDTH')
    expect(exits.modalState).toHaveLength(0)
    expect(getRuntimeModalSlot()).toBeNull()
  })
})

describe('E15：四方法 sessionId 必填（缺/非法 → INVALID_SESSION_ID）', () => {
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

  it('showModal：缺 sessionId → INVALID_SESSION_ID，零广播零开层', async () => {
    const { exits, rpc, port } = buildRpc()
    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1' })
    expect(resp.error?.code).toBe('INVALID_SESSION_ID')
    expect(exits.modalState).toHaveLength(0)
    expect(getRuntimeModalSlot()).toBeNull()
  })

  it('updateHeaderAction：非法 sessionId → INVALID_SESSION_ID，零广播', async () => {
    const { exits, rpc, port } = buildRpc()
    const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', { pluginId: 'p1', headerActionId: 'a', sessionId: '../evil' })
    expect(resp.error?.code).toBe('INVALID_SESSION_ID')
    expect(exits.headerAction).toHaveLength(0)
  })

  it('views.update：缺 sessionId → INVALID_SESSION_ID 且 handleViewUpdate 不触达', async () => {
    const { rpc, port } = buildRpc()
    const resp = await dispatch(rpc, port, 1, 'plugin.views.update', { pluginId: 'p1', viewId: 'v1', guiTree: [] })
    expect(resp.error?.code).toBe('INVALID_SESSION_ID')
    expect(lastResponse(port).error?.message).toContain('sessionId')
  })

  it('sendMessage：缺 sessionId → INVALID_SESSION_ID（替换既有静默 no-op）', async () => {
    const { rpc, port, sessionHandlers } = buildRpc()
    const resp = await dispatch(rpc, port, 1, 'plugin.sessions.sendMessage', { role: 'user', content: 'x' })
    expect(resp.error?.code).toBe('INVALID_SESSION_ID')
    expect(sessionHandlers.sendMessage).not.toHaveBeenCalled()
  })
})

describe('E1 降级 / E10 拒绝', () => {
  it('E1：modalId 未声明（runtime 无声明表可查）不拒开——以调用参数开层（updateStatusBarItem 能力面不校验声明同口径）', async () => {
    const exits = wireCapturingExits()
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    // 未在任何声明表登记的 modalId（如第三方临时 id）——开层成立，仅日志留痕
    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'ad-hoc', modalId: 'never-declared', sessionId: 's1' })
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ opened: true, epoch: 1 })
    expect(exits.modalState).toHaveLength(1)
  })

  it('E10：pending ui-request 存在 → showModal 拒绝 MODAL_BLOCKED_BY_UI_REQUEST，不建层不广播', async () => {
    const exits = wireCapturingExits({ hasPendingUiRequest: () => true })
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })

    expect(resp.error?.code).toBe('MODAL_BLOCKED_BY_UI_REQUEST')
    expect(resp.error?.message).toContain('pending')
    expect(exits.modalState).toHaveLength(0)
    expect(getRuntimeModalSlot()).toBeNull()
  })

  it('E10 不误伤：pending 清空后 showModal 正常开层', async () => {
    let pending = true
    const exits = wireCapturingExits({ hasPendingUiRequest: () => pending })
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })
    expect(lastResponse(port).error?.code).toBe('MODAL_BLOCKED_BY_UI_REQUEST')

    pending = false
    const resp = await dispatch(rpc, port, 2, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })
    expect(resp.result).toEqual({ opened: true, epoch: 1 })
    expect(exits.modalState).toHaveLength(1)
  })
})

describe('views.update 显式 sessionId 归属投递（D1）', () => {
  it('payload.sessionId 直达 handleViewUpdate（不经活跃会话解析——D1 被否④路径已删除）', async () => {
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    const handleViewUpdate = vi.fn()
    registerViewRpcHandlers(rpc, { mountPoints: [], handleViewUpdate })

    // 声明一个与任何「活跃会话」无关的 id：投递归属必须等于 payload.sessionId
    await dispatch(rpc, port, 1, 'plugin.views.update', {
      pluginId: 'p1', viewId: 'modal-p1-m1', guiTree: [{ type: 'ansi-text', props: { lines: ['x'] } }], sessionId: 'declared-session',
    })

    expect(handleViewUpdate).toHaveBeenCalledTimes(1)
    expect(handleViewUpdate).toHaveBeenCalledWith('p1', 'modal-p1-m1', [{ type: 'ansi-text', props: { lines: ['x'] } }], 'declared-session')
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
    'busy',
    'compacting',
    'bash',
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
})

describe('hideModal / plugin-gone（closed 路径复用）', () => {
  it('hideModal：owner 匹配 → closed{dismissed} 广播 + notify + 清槽；未开层 no-op', async () => {
    const exits = wireCapturingExits()
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })
    const resp = await dispatch(rpc, port, 2, 'plugin.ui.hideModal', { pluginId: 'p1', modalId: 'm1' })

    expect(resp.result).toEqual({ closed: true })
    expect(exits.modalState).toHaveLength(2)
    expect(exits.modalState[1]).toMatchObject({ state: 'closed', epoch: 1, reason: 'dismissed' })
    expect(exits.modalClosedNotifies).toEqual([{ workerId: 'w1', payload: { modalId: 'm1', reason: 'dismissed' } }])

    // 已关层再 hide → no-op（closed 幂等）
    const resp2 = await dispatch(rpc, port, 3, 'plugin.ui.hideModal', { pluginId: 'p1', modalId: 'm1' })
    expect(resp2.result).toEqual({ closed: false })
    expect(exits.modalState).toHaveLength(2)
  })

  it('closeRuntimeModalForPlugin：插件消失（E2）清槽并返回条目（closed{plugin-gone} 由调用方发起）', () => {
    wireCapturingExits()
    // 无该插件的 open 层 → null
    expect(closeRuntimeModalForPlugin('p-missing')).toBeNull()

    openRuntimeModalSlot({ pluginId: 'p1', modalId: 'm1', sessionId: 's1', workerId: 'w1' })
    const entry = closeRuntimeModalForPlugin('p1')
    expect(entry).toMatchObject({ pluginId: 'p1', modalId: 'm1', sessionId: 's1', epoch: 1 })
    expect(getRuntimeModalSlot()).toBeNull()

    // 非该插件 → 不误清
    openRuntimeModalSlot({ pluginId: 'p2', modalId: 'm2', sessionId: 's2', workerId: 'w1' })
    expect(closeRuntimeModalForPlugin('p1')).toBeNull()
    expect(getRuntimeModalSlot()).toMatchObject({ pluginId: 'p2' })
  })
})

describe('modalClosed notify 通道名（server→Worker notify，非 WS 帧）', () => {
  it('PLUGIN_MODAL_CLOSED_NOTIFY_METHOD 与 Worker 侧监听方法一致', () => {
    expect(PLUGIN_MODAL_CLOSED_NOTIFY_METHOD).toBe('plugin.ui.modalClosed')
  })
})
