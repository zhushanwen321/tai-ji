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
 * - requireCommand 空串/全空白 → INVALID_REQUIRE_COMMAND 入口拒绝（B-F5）
 * - updateHeaderAction 校验 + plugin:headerActionUpdate 广播形状
 * - B-F1：showModal title / updateHeaderAction badge·tooltip 超 4KB → INVALID_* 拒绝零广播
 * - B-F2：广播出线未接线 → showModal 拒 MODAL_BROADCAST_NOT_WIRED、updateHeaderAction 回
 *   {updated:false}（不假成功）；broadcastFn 缺失 warn-drop 同理（真实装配全链）
 * - B-F4：deps.sessionService 缺失 → console.error 留痕 + {blocked:true, reason:'error'}
 * - hideModal 走与宿主 dismiss 相同的 closed 路径（owner 匹配 + dismissed）
 * - plugin-gone 槽清理（closeRuntimeModalForPlugin）
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-modal-headeraction-contract.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { registerViewRpcHandlers } from '../src/services/plugin-service/api/views-api.js'
import { registerSessionRpcHandlers, SessionEventDispatch } from '../src/services/plugin-service/api/session-api.js'
import type { SessionHandlers } from '../src/services/plugin-service/api/session-api.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import {
  registerUiRpcHandlers,
  wireRuntimeModalExits,
  resetRuntimeModalSlotForTest,
  getRuntimeModalSlot,
  openRuntimeModalSlot,
  closeRuntimeModalForPlugin,
  dismissRuntimeModalForPluginGone,
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

/** 捕获广播/notify 出线（wireRuntimeModalExits 注入面；broadcast 闭包回 true = 帧已发出） */
function wireCapturingExits(overrides: { hasPendingUiRequest?: () => boolean } = {}) {
  const modalState: PluginModalStatePayload[] = []
  const headerAction: HeaderActionUpdatePayload[] = []
  const modalClosedNotifies: Array<{ workerId: string; payload: { modalId: string; reason: string } }> = []
  wireRuntimeModalExits({
    broadcastModalState: (payload) => { modalState.push(payload); return true },
    broadcastHeaderActionUpdate: (payload) => { headerAction.push(payload); return true },
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

/** PluginService 行为级测试用 mock broker（broadcast 不触达真实 ws） */
function createMockBroker(): IMessageBroker {
  return { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
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

describe('showModal title 限界（B-F1：S3-W4 同口径 ≤4KB）', () => {
  it('title 超 4KB → INVALID_TITLE 拒绝，不开层不广播', async () => {
    const exits = wireCapturingExits()
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', {
      pluginId: 'p1', modalId: 'm1', sessionId: 's1', title: 'x'.repeat(4 * 1024 + 1),
    })

    expect(resp.error?.code).toBe('INVALID_TITLE')
    expect(exits.modalState).toHaveLength(0)
    expect(getRuntimeModalSlot()).toBeNull()
  })

  it('title 4KB 内正常开层（payload 原文透传）', async () => {
    const exits = wireCapturingExits()
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', {
      pluginId: 'p1', modalId: 'm1', sessionId: 's1', title: 'x'.repeat(4 * 1024),
    })

    expect(resp.error).toBeUndefined()
    expect(exits.modalState[0]).toMatchObject({ title: 'x'.repeat(4 * 1024), state: 'open' })
  })
})

describe('B-F2：广播出线未接线/广播被丢弃时不假成功（ui-api handler 语义）', () => {
  function buildUnwiredRpc() {
    // beforeEach 已 resetRuntimeModalSlotForTest（exits = null）——刻意不 wire 任何出线
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())
    return { rpc, port }
  }

  it('出线未接线：showModal → MODAL_BROADCAST_NOT_WIRED，不开层', async () => {
    const { rpc, port } = buildUnwiredRpc()

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })

    expect(resp.error?.code).toBe('MODAL_BROADCAST_NOT_WIRED')
    expect(resp.error?.message).toContain('wiring gap')
    expect(getRuntimeModalSlot()).toBeNull()
  })

  it('出线未接线：updateHeaderAction → {updated:false}（不谎报渲染端已收到）', async () => {
    const { rpc, port } = buildUnwiredRpc()

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.updateHeaderAction', { pluginId: 'p1', headerActionId: 'a', sessionId: 's1' })

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ updated: false })
  })

  it('出线已接线但广播被丢弃（broadcastFn 缺失形态）→ showModal 报错且回滚槽；updateHeaderAction 回 {updated:false}', async () => {
    wireRuntimeModalExits({
      broadcastModalState: () => false,
      broadcastHeaderActionUpdate: () => false,
      notifyModalClosed: () => {},
    })
    const rpc = new PluginRpcServer()
    const port = createMockPort()
    rpc.registerWorker('w1', port)
    registerUiRpcHandlers(rpc, minimalUiHandlers())

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })
    expect(resp.error?.code).toBe('MODAL_BROADCAST_NOT_WIRED')
    expect(getRuntimeModalSlot()).toBeNull() // 槽已回滚，不残留不可见层

    const resp2 = await dispatch(rpc, port, 2, 'plugin.ui.updateHeaderAction', { pluginId: 'p1', headerActionId: 'a', sessionId: 's1' })
    expect(resp2.result).toEqual({ updated: false })
  })
})

describe('B-F2/B-F4：真实 PluginService 装配链（registerRpcMethods；deps 缺 broadcastFn 与 sessionService）', () => {
  /**
   * 生产装配全链（registerRpcMethods → registerAllRpcMethods → wireRuntimeModalExits），
   * deps 刻意缺 broadcastFn / sessionService——装配缺陷的等价构造（statusline 全链
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

  it('B-F2 全链：broadcastFn 缺失 → showModal 拒 MODAL_BROADCAST_NOT_WIRED，槽不残留', async () => {
    const { rpc, port } = buildBareWiredRpc()

    const resp = await dispatch(rpc, port, 1, 'plugin.ui.showModal', { pluginId: 'p1', modalId: 'm1', sessionId: 's1' })

    expect(resp.error?.code).toBe('MODAL_BROADCAST_NOT_WIRED')
    expect(getRuntimeModalSlot()).toBeNull()
  })

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

  it('dismissRuntimeModalForPluginGone（接线便捷函数）：命中 → 广播 closed{plugin-gone} + notify owner + 清槽', () => {
    const exits = wireCapturingExits()
    openRuntimeModalSlot({ pluginId: 'p1', modalId: 'm1', sessionId: 's1', workerId: 'w1' })

    expect(dismissRuntimeModalForPluginGone('p1')).toBe(true)
    expect(exits.modalState).toHaveLength(1)
    expect(exits.modalState[0]).toMatchObject({
      pluginId: 'p1', modalId: 'm1', sessionId: 's1', state: 'closed', epoch: 1, reason: 'plugin-gone',
    })
    expect(exits.modalClosedNotifies).toEqual([{ workerId: 'w1', payload: { modalId: 'm1', reason: 'plugin-gone' } }])
    expect(getRuntimeModalSlot()).toBeNull()
  })

  it('dismissRuntimeModalForPluginGone：无该插件的 open 层 → false 且零广播零 notify', () => {
    const exits = wireCapturingExits()
    // 槽属其他插件（或无槽）→ 不命中、不广播
    openRuntimeModalSlot({ pluginId: 'p2', modalId: 'm2', sessionId: 's2', workerId: 'w2' })

    expect(dismissRuntimeModalForPluginGone('p1')).toBe(false)
    expect(exits.modalState).toHaveLength(0)
    expect(exits.modalClosedNotifies).toHaveLength(0)
    expect(getRuntimeModalSlot()).toMatchObject({ pluginId: 'p2' })
  })
})

describe('PluginService 三路清理接线（AP-2 关②：crash / disable / uninstall → closed{plugin-gone}）', () => {
  let tmpDir: string

  /** 最小 PluginService（不 initialize：清理点不依赖 Worker 侧状态，UNLOADED 插件 deactivate no-op） */
  function buildService() {
    const registryMock = {
      getDescriptor: vi.fn((id: string) => ({ pluginId: id, pluginPath: join(tmpDir, id), name: id })),
      getAllDescriptors: () => [],
    }
    const service = new PluginService(registryMock as never, createMockBroker(), { configDir: tmpDir })
    return service
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'modal-plugin-gone-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('disable 路：togglePlugin(false) 命中 open 层 → 广播 closed{plugin-gone} 且槽清空', async () => {
    const exits = wireCapturingExits()
    const service = buildService()
    openRuntimeModalSlot({ pluginId: 'p1', modalId: 'm1', sessionId: 's1', workerId: 'w1' })

    await service.togglePlugin('p1', false)

    expect(exits.modalState).toHaveLength(1)
    expect(exits.modalState[0]).toMatchObject({ state: 'closed', reason: 'plugin-gone', pluginId: 'p1', modalId: 'm1', sessionId: 's1' })
    expect(getRuntimeModalSlot()).toBeNull()
  })

  it('disable 路：无该插件的 open 层 → 零广播（closed 对未开层 no-op）', async () => {
    const exits = wireCapturingExits()
    const service = buildService()
    openRuntimeModalSlot({ pluginId: 'p2', modalId: 'm2', sessionId: 's2', workerId: 'w2' })

    await service.togglePlugin('p1', false)

    expect(exits.modalState).toHaveLength(0)
    expect(getRuntimeModalSlot()).toMatchObject({ pluginId: 'p2' })
  })

  it('crash 路：Worker 崩溃回调触发 → 崩溃插件的 open 层 closed{plugin-gone} 广播', () => {
    const exits = wireCapturingExits()
    const service = buildService()
    openRuntimeModalSlot({ pluginId: 'pA', modalId: 'm1', sessionId: 's1', workerId: 'w1' })

    ;(service as unknown as { registerWorkerCallbacks(): void }).registerWorkerCallbacks()
    const host = (service as unknown as { host: { onCrash?: (workerId: string, pluginIds: string[], error: unknown) => void } }).host
    expect(host.onCrash).toBeTypeOf('function')
    host.onCrash!('w1', ['pA'], new Error('worker died'))

    expect(exits.modalState).toHaveLength(1)
    expect(exits.modalState[0]).toMatchObject({ state: 'closed', reason: 'plugin-gone', pluginId: 'pA', modalId: 'm1' })
    expect(getRuntimeModalSlot()).toBeNull()
  })

  it('三路接线守卫：crash / disable / uninstall 各恰好一处 dismissRuntimeModalForPluginGone 调用', () => {
    const source = readFileSync(new URL('../src/services/plugin-service/plugin-service.ts', import.meta.url), 'utf8')

    expect(source.match(/dismissRuntimeModalForPluginGone\(pluginId\)/g)).toHaveLength(3)
  })
})

describe('togglePlugin plugin:statusChange 广播（E2 修复：disable/enable 腿 renderer 触发源）', () => {
  let tmpDir: string

  /** 同三路清理接线的最小 PluginService，另暴露 mock broker 供广播断言 */
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

  it('disable → plugin:statusChange{newStatus:inactive} 广播（E2 触发源：renderer handlePluginGone 清三容器/顶栏/modal）', async () => {
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

  it('广播信封与 crashed 腿同构：type/id/payload 三键一致；statusChange payload 键集 = StatusChangeCallback 契约', async () => {
    const { service, broker } = buildServiceWithBroker()
    ;(service as unknown as { registerWorkerCallbacks(): void }).registerWorkerCallbacks()

    // crashed 腿（既有广播点）
    const host = (service as unknown as { host: { onCrash?: (workerId: string, pluginIds: string[], error: unknown) => void } }).host
    host.onCrash!('w1', ['pC'], new Error('worker died'))

    // toggle disable 腿（本次新增广播点）
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

describe('modalClosed notify 通道名（server→Worker notify，非 WS 帧）', () => {
  it('PLUGIN_MODAL_CLOSED_NOTIFY_METHOD 与 Worker 侧监听方法一致', () => {
    expect(PLUGIN_MODAL_CLOSED_NOTIFY_METHOD).toBe('plugin.ui.modalClosed')
  })
})
