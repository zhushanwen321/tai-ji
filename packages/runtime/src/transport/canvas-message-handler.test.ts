/**
 * CanvasMessageHandler 测试（problem-solve-canvas U3 验收条款：L1 单测三件）——
 * ① marker 往返翻译（含畸形 payload 结构化错误应答）；② 回推防回环（actor 维度）；
 * ③ 广播 payload 形状（含 evType）。
 *
 * 链路真实度：marker 用例驱动**真实实现**的完整链——event-adapter translate 的
 * CANVAS_MARKER 检测分支 → EventInterpreter canvas-ui 路由（onCanvasRequest）→
 * CanvasMessageHandler action 分发 → CanvasService（真实领域核心，canvasesDir 注入
 * mkdtemp 自建自删）→ sendExtensionUiResponse 应答收集。mock 只保留两层：
 * pi 子进程 IO（应答收集数组）与 ISessionService（getRpcClient 返回 fake client）。
 * WS RPC 用例直调 handleCanvasMessage（路由表接线由 server.ts 装配面承担，不在此重复）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/canvas-message-handler.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import { CANVAS_MARKER, type CanvasMutateReply, type CanvasState } from '@zhushanwen/extension-protocol'
import { translate } from '../infra/pi/event-adapter.js'
import type { PiEvent } from '../infra/pi/pi-protocol.js'
import { EventInterpreter } from '../services/session/event-interpreter.js'
import { CanvasService } from '../services/canvas/canvas-service.js'
import type { CanvasServiceDeps } from '../services/canvas/canvas-service.js'
import { canvasNotifyText, CanvasMessageHandler } from './canvas-message-handler.js'
import type { CanvasHandlerContext } from './canvas-message-handler.js'
import type { ISessionService } from '../interfaces.js'

// ── 测试基建 ──────────────────────────────────────────────────────

/** marker 应答收集槽（pi stdin 的 extension_ui_response wire 形态）。 */
interface SentResponse { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  sessionId: string
  requestId: string
  value: string
  method?: string
}

/** fake pi client：回推 prompt 的终点（exited 模拟进程死亡）。 */
function makeFakeClient(overrides: { exited?: boolean } = {}): { prompt: ReturnType<typeof vi.fn>; exited: boolean } {
  return { prompt: vi.fn().mockResolvedValue({}), exited: overrides.exited ?? false }
}

interface Harness { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasesDir: string
  canvasService: CanvasService
  handler: CanvasMessageHandler
  sentResponses: SentResponse[]
  broadcast: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
  sendError: ReturnType<typeof vi.fn>
  getRpcClient: ReturnType<typeof vi.fn>
  clients: Map<string, ReturnType<typeof makeFakeClient>>
  /** marker 全链：extension_ui_request JSONL 行 → 真实 translate → 真实 interpret → handler.handle 完成 */
  dispatch(rawLine: string): Promise<void>
}

/**
 * 组装被测链。接线与组合根一致（interpreter.onCanvasRequest → handler.handle
 * fire-and-forget；server.ts 的 sendExtensionUiResponse sessionId 直发语义），只把
 * pi 子进程 IO 与 ISessionService 换成收集数组与 fake。
 */
function makeHarness(agentSessionId = 'sid-agent'): Harness {
  const canvasesDir = mkdtempSync(join(tmpdir(), 'canvas-transport-'))
  // 广播接线与 server.ts 装配一致（service.onUpdated → handler.broadcastUpdated）；闭包晚绑定
  //（service 先构造，handler 构造后即接线完成，mutate 只发生在测试体内）。
  let broadcastUpdated: CanvasServiceDeps['onUpdated'] = undefined
  const canvasService = new CanvasService({ canvasesDir, onUpdated: (u) => broadcastUpdated?.(u) })
  const sentResponses: SentResponse[] = []
  const broadcast = vi.fn()
  const reply = vi.fn()
  const sendError = vi.fn()
  const clients = new Map<string, ReturnType<typeof makeFakeClient>>()
  const getRpcClient = vi.fn((sid: string) => clients.get(sid))
  const sessionService = { getRpcClient } as unknown as ISessionService
  const handler = new CanvasMessageHandler({
    send: () => {},
    reply: reply as unknown as CanvasHandlerContext['reply'],
    sendError: sendError as unknown as CanvasHandlerContext['sendError'],
    sessionService,
    canvasService,
    sendExtensionUiResponse: (sessionId, requestId, response, method) => {
      sentResponses.push({ sessionId, requestId, value: String(response), method })
      return true
    },
    broadcast: broadcast as unknown as CanvasHandlerContext['broadcast'],
    nextPushId: () => 'push_test_1',
  })
  broadcastUpdated = (u) => handler.broadcastUpdated(u)
  let handling: Promise<void> = Promise.resolve()
  const interpreter = new EventInterpreter(agentSessionId, {
    send: () => {},
    onCanvasRequest: (requestId, sessionId, action, params) => {
      // fire-and-forget 委托（与 server.handleCanvasRequest 一致）；promise 暴露给测试 await
      handling = handler.handle(requestId, sessionId, action, params)
    },
  })
  return {
    canvasesDir,
    canvasService,
    handler,
    sentResponses,
    broadcast,
    reply,
    sendError,
    getRpcClient,
    clients,
    async dispatch(rawLine: string): Promise<void> {
      interpreter.interpret(translate(JSON.parse(rawLine) as PiEvent, agentSessionId))
      await handling
    },
  }
}

/** 构造 canvas marker 的 extension_ui_request JSONL 行（pi-canvas callCanvas 序列化形态）。 */
function canvasRequestLine(requestId: string, action: string, params: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'extension_ui_request',
    id: requestId,
    method: 'select',
    title: CANVAS_MARKER,
    options: [JSON.stringify({ action, params })],
  })
}

/** 读取指定 requestId 的唯一应答并解析（多于一条即 fail）。 */
function readSingleResponse<T>(sent: SentResponse[], requestId: string, sessionId = 'sid-agent'): T {
  const found = sent.filter((r) => r.requestId === requestId && r.sessionId === sessionId)
  expect(found, `expected exactly 1 response for ${requestId}, got: ${JSON.stringify(sent)}`).toHaveLength(1)
  return JSON.parse(found[0].value) as T
}

/** WS canvas.* 请求消息构造。 */
function canvasWsMsg<T extends ClientMessage['type']>(type: T, payload: unknown): Extract<ClientMessage, { type: T }> {
  return { type, id: 'rpc-1', payload } as unknown as Extract<ClientMessage, { type: T }>
}

const ws = {} as WsType

/** 收尾：画布目录自建自删 + service 摘除模块级登记。 */
const activeDirs: string[] = []
function trackDir(dir: string): void {
  activeDirs.push(dir)
}
afterEach(() => {
  for (const dir of activeDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 经 marker 通道 create 一个画布（默认绑定到 sid-agent），返回 canvasId。 */
async function createBoundCanvas(h: Harness, requestId = 'req-create-setup'): Promise<string> {
  await h.dispatch(canvasRequestLine(requestId, 'create', {
    statement: '多引擎支持怎么落地',
    criterias: ['方向 MECE', '每节点可证伪'],
    scopeExclusions: ['不做自底向上'],
  }))
  const replyBody = readSingleResponse<Extract<CanvasMutateReply, { ok: true }> & { canvasId: string }>(h.sentResponses, requestId)
  expect(replyBody.ok).toBe(true)
  return replyBody.canvasId
}

// ── ① marker 往返翻译（含畸形 payload 结构化错误应答）──────────────

describe('marker 往返翻译（CANVAS_MARKER select 通道）', () => {
  it('create 全链：marker request → 真实 handler 创建画布 + 登记绑定 + 应答回 select 通道', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)

    await h.dispatch(canvasRequestLine('req-1', 'create', {
      statement: '多引擎支持怎么落地',
      criterias: ['方向 MECE'],
      scopeExclusions: [],
    }))

    // 应答回 marker 通道（select value），成功腿两态信封 + canvasId
    const body = readSingleResponse<Extract<CanvasMutateReply, { ok: true }> & { canvasId: string }>(h.sentResponses, 'req-1')
    expect(h.sentResponses[0].method).toBe('select')
    expect(body.ok).toBe(true)
    expect(body.evType).toBe('CanvasCreated')
    expect(body.canvasId).toMatch(/^cvs-/)
    // create 成功即登记绑定（marker 通道 create 一并登记；回推路由建立）
    expect(h.canvasService.getBoundSessions(body.canvasId)).toEqual(['sid-agent'])
  })

  it('enter 打开形态：读全量 CanvasState + 幂等登记绑定', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)

    await h.dispatch(canvasRequestLine('req-enter', 'enter', { canvasId }))
    const state = readSingleResponse<CanvasState>(h.sentResponses, 'req-enter')
    expect(state.canvasId).toBe(canvasId)
    expect(state.root.statement).toBe('多引擎支持怎么落地')
    // 绑定幂等：重复 enter 同画布无副作用
    expect(h.canvasService.getBoundSessions(canvasId)).toEqual(['sid-agent'])
  })

  it('translate 层：canvas-ui kind 强类型透传，不发前端广播帧（内部通道不降级对话框）', () => {
    const line = canvasRequestLine('req-2', 'read', { canvasId: 'cvs-x' })
    const events = translate(JSON.parse(line) as PiEvent, 'sid-agent')
    const canvasEvent = events.find((e) => e.kind === 'canvas-ui')
    expect(canvasEvent).toBeDefined()
    // 强类型 action/params 透传（session-manager-ui 同款）
    if (canvasEvent?.kind !== 'canvas-ui') return
    expect(canvasEvent.action).toBe('read')
    expect(canvasEvent.params).toEqual({ canvasId: 'cvs-x' })
    // 不产前端帧：marker 请求由 handler 消化，extension.dialog 广播会把 marker title 渲染成对话框（session-manager 修复同款回归锁）
    expect(events.some((e) => e.kind === 'message')).toBe(false)
    expect(events.some((e) => e.kind === 'extension-ui')).toBe(false)
  })

  it('畸形 payload：非法 JSON → __malformed__ → 结构化错误应答（不降级普通对话框、不走 error envelope）', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const malformedLine = JSON.stringify({
      type: 'extension_ui_request', id: 'req-bad', method: 'select', title: CANVAS_MARKER, options: ['not json'],
    })

    await h.dispatch(malformedLine)

    const body = readSingleResponse<Extract<CanvasMutateReply, { ok: false }>>(h.sentResponses, 'req-bad')
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('invalid_params')
    expect(body.error.recover).not.toBe('')
    // 不降级：翻译层无前端帧（translate 内折叠，本应答链路不产生 message kind）
    const events = translate(JSON.parse(malformedLine) as PiEvent, 'sid-agent')
    expect(events.some((e) => e.kind === 'message')).toBe(false)
  })

  it('畸形 payload：action 词表外 → 结构化错误应答（unknown 领域动作不进 service）', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)

    await h.dispatch(canvasRequestLine('req-bad-action', 'self-destruct', { canvasId: 'cvs-x' }))

    const body = readSingleResponse<Extract<CanvasMutateReply, { ok: false }>>(h.sentResponses, 'req-bad-action')
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('invalid_params')
    // service 未被触达（无画布被创建/查询副作用）：翻译层折叠，未到 dispatch
    expect(h.canvasService.listCanvases().canvases).toHaveLength(0)
  })

  it('marker 通道表外动作（agent 权限外）：decide-direction → actor_not_allowed 结构化拒绝', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)

    // decide-direction 仅 user（矩阵）——marker 通道恒 agent，表外组合 fail-fast
    await h.dispatch(canvasRequestLine('req-forbidden', 'decide-direction', {
      canvasId, direction: 'top-down', reason: 'agent 越权拍板',
    }))
    const body = readSingleResponse<Extract<CanvasMutateReply, { ok: false }>>(h.sentResponses, 'req-forbidden')
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('actor_not_allowed')
    expect(body.error.recover).toContain('权限矩阵')
  })
})

// ── ② 回推防回环（actor 维度）＋ 回推派发 ─────────────────────────

describe('回推派发（actor=user 成功腿；防回环 actor 维度）', () => {
  it('WS mutate actor=user → 绑定 session 的现成 client 收到「画布事件通知」回推', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)
    const client = makeFakeClient()
    h.clients.set('sid-agent', client)
    const state = h.canvasService.readState(canvasId)

    const msg = canvasWsMsg('canvas.mutate', {
      actor: 'user', action: 'patch',
      params: { canvasId, nodeId: state.root.nodeId, content: '多引擎支持怎么落地（用户改写）', reason: '用户澄清陈述' },
    })
    await h.handler.handleCanvasMessage(msg, ws)

    // mutate reply 两态信封成功腿
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.mutate', expect.objectContaining({ ok: true }))
    // 回推：绑定 session 的 prompt 收到通知文本（模板锁定：领域摘要 + 「画布事件通知」标注 +
    // canvas_read 响应协议指引 + 画布 id——A3 验收「通知与用户输入可区分」的锚点）
    expect(client.prompt).toHaveBeenCalledTimes(1)
    const text = client.prompt.mock.calls[0][0] as string
    expect(text).toBe(canvasNotifyText(
      '节点「多引擎支持怎么落地（用户改写）」已更新（内容）：用户澄清陈述',
      canvasId,
    ))
    expect(text).toContain('画布事件通知')
    expect(text).toContain('canvas_read')
    expect(text).toContain(canvasId)
  })

  it('防回环：marker 通道（agent actor）mutate 成功 → prompt 零调用', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)
    const client = makeFakeClient()
    h.clients.set('sid-agent', client)
    const state = h.canvasService.readState(canvasId)

    // agent 自己 grow（绑定在册、mutate 成功）——不回推（构造性：marker 通道恒 agent）
    await h.dispatch(canvasRequestLine('req-grow', 'grow', {
      canvasId,
      batch: [{ id: 'n-1', type: 'question', content: 'q1 引擎边界怎么拆', attachTo: state.root.nodeId, edge: 'decompose' }],
      reason: '按 MECE 分解',
    }))

    expect(client.prompt).not.toHaveBeenCalled()
  })

  it('防回环：review-append（review actor）成功写回 → prompt 零调用', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)
    const client = makeFakeClient()
    h.clients.set('sid-agent', client)
    const state = h.canvasService.readState(canvasId)

    // reviewer 报告写回（actor=review，唯一合法格）——成功腿也不回推；契约每条 entry 自带 round
    await h.dispatch(canvasRequestLine('req-append', 'review-append', {
      canvasId,
      round: 1,
      entries: [{ id: 'rev-1', round: 1, dimension: 'completeness', severity: 'must-fix', targetId: state.root.nodeId, note: '判据缺少量化口径' }],
    }))
    const body = readSingleResponse<Extract<CanvasMutateReply, { ok: true }>>(h.sentResponses, 'req-append')
    expect(body.ok).toBe(true)
    expect(client.prompt).not.toHaveBeenCalled()
  })

  it('回推存活过滤：绑定 session 的 pi 已退出 → prompt 零调用（不经 ensureActive 拉活）', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)
    const deadClient = makeFakeClient({ exited: true })
    h.clients.set('sid-agent', deadClient)
    const state = h.canvasService.readState(canvasId)

    const msg = canvasWsMsg('canvas.mutate', {
      actor: 'user', action: 'patch',
      params: { canvasId, nodeId: state.root.nodeId, content: '改', reason: '用户改写' },
    })
    await h.handler.handleCanvasMessage(msg, ws)

    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.mutate', expect.objectContaining({ ok: true }))
    expect(deadClient.prompt).not.toHaveBeenCalled()
  })

  it('回推边界：无绑定记录 → getRpcClient 不被触达（无回推对象）', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    // 不走 marker 通道 create（无绑定）——直接经 WS 通道建画布
    const msgCreate = canvasWsMsg('canvas.mutate', {
      actor: 'user', action: 'create',
      params: { statement: 'S', criterias: ['C1'], scopeExclusions: [] },
    })
    await h.handler.handleCanvasMessage(msgCreate, ws)
    const canvasId = (h.reply.mock.calls[0][3] as Extract<CanvasMutateReply, { ok: true }> & { canvasId: string }).canvasId
    const state = h.canvasService.readState(canvasId)
    h.getRpcClient.mockClear()

    const msgPatch = canvasWsMsg('canvas.mutate', {
      actor: 'user', action: 'patch',
      params: { canvasId, nodeId: state.root.nodeId, content: '改', reason: '用户改写' },
    })
    await h.handler.handleCanvasMessage(msgPatch, ws)

    // 绑定集合为空（GUI 托盘新建不登记绑定）→ 回推路径根本不取 client
    expect(h.canvasService.getBoundSessions(canvasId)).toEqual([])
    expect(h.getRpcClient).not.toHaveBeenCalled()
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.mutate', expect.objectContaining({ ok: true }))
  })
})

// ── ③ 广播 payload 形状（canvas.updated 含 evType，无 sessionId）──

describe('广播 payload 形状（canvas.updated 全局通道）', () => {
  it('marker create 成功 → broker 全局广播帧：payload 四键（canvasId/evType/eventId/summary）无 sessionId，evType 为词表值', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)

    await h.dispatch(canvasRequestLine('req-1', 'create', {
      statement: 'S', criterias: ['C1'], scopeExclusions: [],
    }))

    expect(h.broadcast).toHaveBeenCalledTimes(1)
    const frame = h.broadcast.mock.calls[0][0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(frame.type).toBe('canvas.updated')
    expect(frame.id).toBe('push_test_1')
    expect(frame.payload).toEqual({
      canvasId: expect.any(String),
      evType: 'CanvasCreated',
      eventId: expect.any(String),
      summary: expect.any(String),
    })
    // 无 sid 全局消息走 broker.broadcast（画布不属任何 session；broker session-scoped 哨兵靠 payload 无 sessionId 不触发）
    expect('sessionId' in frame.payload).toBe(false)
  })

  it('每次 mutate 成功一条广播：后续 grow 的 evType = NodeCreated（evType 随事件类型分流）', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)
    const state = h.canvasService.readState(canvasId)
    h.broadcast.mockClear()

    await h.dispatch(canvasRequestLine('req-grow', 'grow', {
      canvasId,
      batch: [{ id: 'n-1', type: 'question', content: 'q1', attachTo: state.root.nodeId, edge: 'decompose' }],
      reason: '分解',
    }))

    expect(h.broadcast).toHaveBeenCalledTimes(1)
    const frame = h.broadcast.mock.calls[0][0] as { payload: { evType: string; canvasId: string } }
    expect(frame.payload.evType).toBe('NodeCreated')
    expect(frame.payload.canvasId).toBe(canvasId)
  })
})

// ── WS RPC 面（canvas.list / canvas.get / mutate 失败腿）─────────

describe('canvas.* RPC 面', () => {
  it('canvas.list → CanvasListReply；canvas.get → CanvasState；get 未知画布 → canvas_not_found error envelope（hint 恢复动作）', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)

    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.list', {}), ws)
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.list', {
      canvases: [expect.objectContaining({ canvasId, converged: false })],
    })

    h.reply.mockClear()
    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.get', { canvasId }), ws)
    const state = h.reply.mock.calls[0][3] as CanvasState
    expect(state.canvasId).toBe(canvasId)
    expect(state.root.statement).toBe('多引擎支持怎么落地')

    h.reply.mockClear()
    h.sendError.mockClear()
    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.get', { canvasId: 'cvs-missing' }), ws)
    expect(h.reply).not.toHaveBeenCalled()
    expect(h.sendError).toHaveBeenCalledWith(ws, 'canvas_not_found', expect.any(String), 'rpc-1', expect.objectContaining({ hint: expect.stringContaining('canvas_list') }))
  })

  it('canvas.mutate 领域拒绝 → reply 失败腿结构化错误（selection_conflict：一问双选定）', async () => {
    const h = makeHarness()
    trackDir(h.canvasesDir)
    const canvasId = await createBoundCanvas(h)
    const state = h.canvasService.readState(canvasId)
    // 两张候选方案（同属根问题）
    await h.dispatch(canvasRequestLine('req-grow', 'grow', {
      canvasId,
      batch: [
        { id: 'opt-a', type: 'option', content: '方案 A', attachTo: state.root.nodeId, edge: 'resolve' },
        { id: 'opt-b', type: 'option', content: '方案 B', attachTo: state.root.nodeId, edge: 'resolve' },
      ],
      reason: '候选并存',
    }))

    const msg = canvasWsMsg('canvas.mutate', {
      actor: 'user', action: 'select',
      params: { canvasId, questionId: state.root.nodeId, optionId: 'opt-a', reason: '先选 A' },
    })
    await h.handler.handleCanvasMessage(msg, ws)
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.mutate', expect.objectContaining({ ok: true }))

    h.reply.mockClear()
    const msgAgain = canvasWsMsg('canvas.mutate', {
      actor: 'user', action: 'select',
      params: { canvasId, questionId: state.root.nodeId, optionId: 'opt-b', reason: '未走 replace 迁移直接换选' },
    })
    await h.handler.handleCanvasMessage(msgAgain, ws)
    const failReply = h.reply.mock.calls[0][3] as Extract<CanvasMutateReply, { ok: false }>
    expect(failReply.ok).toBe(false)
    expect(failReply.error.code).toBe('selection_conflict')
    expect(failReply.error.recover).toContain('replace')
  })
})
