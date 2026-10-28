import { translate } from '../infra/pi/event-adapter.js';
import type { PiEvent } from '../infra/pi/pi-protocol.js';
import type { ISessionService } from '../interfaces.js';
import { CanvasService } from '../services/canvas/canvas-service.js';
import type { IProviderCredentialResolver, ResolvedProviderCredential } from '../services/ports/provider-credential-resolver.js';
import { ProjectStore, ProjectCommandError } from '../services/project/project-store.js';
import type { QuotaService } from '../services/quota-service.js';
import { EventInterpreter } from '../services/session/event-interpreter.js';
import { readUiPreferences } from '../services/ui-preferences-helper.js';
import { CanvasMessageHandler, canvasNotifyText } from './canvas-message-handler.js';
import { ConfigPreferencesMessageHandler } from './config-preferences-message-handler.js';
import { ModelMessageHandler } from './model-message-handler.js';
import { OauthMessageHandler } from './oauth-message-handler.js';
import { ProjectMessageHandler, type ProjectHandlerContext } from './project-message-handler.js';
import { ProviderMessageHandler } from './provider-message-handler.js';
import { QuotaMessageHandler, type QuotaHandlerContext } from './quota-message-handler.js';
import { SettingsMessageHandler, type SettingsHandlerContext } from './settings-message-handler.js';
import type { ClientMessage } from '@taiji/shared';
import { CANVAS_MARKER, type CanvasMutateReply, type CanvasState } from '@zhushanwen/extension-protocol';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket as WsType } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/transport/canvas-message-handler.test.ts
// ======================================================================

// ── 测试基建 ──────────────────────────────────────────────────────

import type { CanvasServiceDeps } from '../services/canvas/canvas-service.js';
import type { CanvasHandlerContext } from './canvas-message-handler.js';
import type { ProjectStoreState, ServerMessage, ProjectCommandReply } from '@taiji/shared';
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
  dataDir: string
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
  const dataDir = mkdtempSync(join(tmpdir(), 'canvas-transport-'))
  // 广播接线与 server.ts 装配一致（service.onUpdated → handler.broadcastUpdated）；闭包晚绑定
  //（service 先构造，handler 构造后即接线完成，mutate 只发生在测试体内）。
  let broadcastUpdated: CanvasServiceDeps['onUpdated'] = undefined
  const canvasService = new CanvasService({ dataDir, onUpdated: (u) => broadcastUpdated?.(u) })
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
    dataDir,
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


/** marker 通道固定发起会话（makeHarness 的 agentSessionId；服务调用归属参数同值）。 */
const SID = 'sid-agent'


const ws = {} as WsType


/** 收尾：画布目录自建自删 + service 摘除模块级登记。 */
const activeDirs: string[] = []

function trackDir(dir: string): void {
  activeDirs.push(dir)
}


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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('canvas-message-handler', () => {
afterEach(() => {
  for (const dir of activeDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
// ── ① marker 往返翻译（含畸形 payload 结构化错误应答）──────────────

describe('marker 往返翻译（CANVAS_MARKER select 通道）', () => {
  it('create 全链：marker request → 真实 handler 创建画布 + owner 即回推对象（归属即路径）+ 应答回 select 通道', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)

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
    // create 即建立回推通道（owner = 发起会话——归属即路径，无 enter 登记语义）
    expect(h.canvasService.getBoundSessions(body.canvasId)).toEqual(['sid-agent'])
  })

  it('enter 打开形态：读全量 CanvasState + owner 即回推对象（enter 只读不登记）', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)

    await h.dispatch(canvasRequestLine('req-enter', 'enter', { canvasId }))
    const state = readSingleResponse<CanvasState>(h.sentResponses, 'req-enter')
    expect(state.canvasId).toBe(canvasId)
    expect(state.root.statement).toBe('多引擎支持怎么落地')
    // owner 即回推对象（enter 只读不登记——归属持久在落盘路径）
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
    trackDir(h.dataDir)
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
    trackDir(h.dataDir)

    await h.dispatch(canvasRequestLine('req-bad-action', 'self-destruct', { canvasId: 'cvs-x' }))

    const body = readSingleResponse<Extract<CanvasMutateReply, { ok: false }>>(h.sentResponses, 'req-bad-action')
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('invalid_params')
    // service 未被触达（无画布被创建/查询副作用）：翻译层折叠，未到 dispatch
    expect(h.canvasService.listCanvases(SID).canvases).toHaveLength(0)
  })

  it('marker 通道表外动作（agent 权限外）：decide-direction → actor_not_allowed 结构化拒绝', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
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
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)
    const client = makeFakeClient()
    h.clients.set('sid-agent', client)
    const state = h.canvasService.readState(canvasId, SID)

    const msg = canvasWsMsg('canvas.mutate', {
      actor: 'user', sessionId: 'sid-agent', action: 'patch',
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
    // streamingBehavior='followUp' 显式排队（pi 1.0.0 契约：占线且缺省直接 throw——
    // D3-A3 v6 实证连续裁决高频路径回推静默丢失；followUp = 完成当前响应后依次消化）
    expect(client.prompt.mock.calls[0][2]).toBe('followUp')
  })

  it('防回环：marker 通道（agent actor）mutate 成功 → prompt 零调用', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)
    const client = makeFakeClient()
    h.clients.set('sid-agent', client)
    const state = h.canvasService.readState(canvasId, SID)

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
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)
    const client = makeFakeClient()
    h.clients.set('sid-agent', client)
    const state = h.canvasService.readState(canvasId, SID)

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
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)
    const deadClient = makeFakeClient({ exited: true })
    h.clients.set('sid-agent', deadClient)
    const state = h.canvasService.readState(canvasId, SID)

    const msg = canvasWsMsg('canvas.mutate', {
      actor: 'user', sessionId: 'sid-agent', action: 'patch',
      params: { canvasId, nodeId: state.root.nodeId, content: '改', reason: '用户改写' },
    })
    await h.handler.handleCanvasMessage(msg, ws)

    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.mutate', expect.objectContaining({ ok: true }))
    expect(deadClient.prompt).not.toHaveBeenCalled()
  })

  it('回推通道（owner 语义）：GUI create 带 sessionId → owner 即回推对象，patch 成功腿回推 owner', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    // GUI 托盘新建走 WS 通道：create 落 owner（payload.sessionId），回推通道随创建建立
    const msgCreate = canvasWsMsg('canvas.mutate', {
      actor: 'user', sessionId: 'sid-agent', action: 'create',
      params: { statement: 'S', criterias: ['C1'], scopeExclusions: [] },
    })
    await h.handler.handleCanvasMessage(msgCreate, ws)
    const canvasId = (h.reply.mock.calls[0][3] as Extract<CanvasMutateReply, { ok: true }> & { canvasId: string }).canvasId
    const state = h.canvasService.readState(canvasId, SID)
    const client = makeFakeClient()
    h.clients.set('sid-agent', client)

    const msgPatch = canvasWsMsg('canvas.mutate', {
      actor: 'user', sessionId: 'sid-agent', action: 'patch',
      params: { canvasId, nodeId: state.root.nodeId, content: '改', reason: '用户改写' },
    })
    await h.handler.handleCanvasMessage(msgPatch, ws)

    // owner 持久在落盘路径（D4）：回推对象 = 归属会话本身
    expect(h.canvasService.getBoundSessions(canvasId)).toEqual(['sid-agent'])
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.mutate', expect.objectContaining({ ok: true }))
  })

  it('归属校验拒绝：B 会话 WS mutate A 的画布 → forbidden 失败腿（D4 隔离）', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)
    const state = h.canvasService.readState(canvasId, SID)

    const msg = canvasWsMsg('canvas.mutate', {
      actor: 'user', sessionId: 'sid-other', action: 'patch',
      params: { canvasId, nodeId: state.root.nodeId, content: '越会话改写', reason: 'r' },
    })
    await h.handler.handleCanvasMessage(msg, ws)
    const failReply = h.reply.mock.calls[0][3] as Extract<CanvasMutateReply, { ok: false }>
    expect(failReply.ok).toBe(false)
    expect(failReply.error.code).toBe('forbidden')
    expect(failReply.error.recover).toContain('归属会话')
  })

  it('payload 缺 sessionId → invalid_params 结构化拒绝（破坏性协议：schema 层拒绝缺失）', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const msg = canvasWsMsg('canvas.mutate', {
      actor: 'user', action: 'create',
      params: { statement: 'S', criterias: ['C1'], scopeExclusions: [] },
    })
    await h.handler.handleCanvasMessage(msg, ws)
    const failReply = h.reply.mock.calls[0][3] as Extract<CanvasMutateReply, { ok: false }>
    expect(failReply.ok).toBe(false)
    expect(failReply.error.code).toBe('invalid_params')
    expect(failReply.error.message).toContain('sessionId')
    // 未触服务（零画布落盘）
    expect(h.canvasService.listCanvases('sid-agent').canvases).toHaveLength(0)
  })

  it('canvas.list 按 sessionId 过滤：A 的画布不出现在 B 的清单（D4 裁决 3）', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)

    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.list', { sessionId: 'sid-agent' }), ws)
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.list', {
      canvases: [expect.objectContaining({ canvasId, ownerSessionId: 'sid-agent' })],
    })

    h.reply.mockClear()
    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.list', { sessionId: 'sid-other' }), ws)
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.list', { canvases: [] })
  })
})
// ── ③ 广播 payload 形状（canvas.updated 含 evType + 归属 sessionId）──

describe('广播 payload 形状（canvas.updated 全局通道，payload 带归属 sessionId）', () => {
  it('marker create 成功 → broker 全局广播帧：payload 五键（canvasId/sessionId/evType/eventId/summary），sessionId = 归属会话', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)

    await h.dispatch(canvasRequestLine('req-1', 'create', {
      statement: 'S', criterias: ['C1'], scopeExclusions: [],
    }))

    expect(h.broadcast).toHaveBeenCalledTimes(1)
    const frame = h.broadcast.mock.calls[0][0] as { type: string; id: string; payload: Record<string, unknown> }
    expect(frame.type).toBe('canvas.updated')
    expect(frame.id).toBe('push_test_1')
    expect(frame.payload).toEqual({
      canvasId: expect.any(String),
      sessionId: 'sid-agent',
      evType: 'CanvasCreated',
      eventId: expect.any(String),
      summary: expect.any(String),
    })
  })

  it('每次 mutate 成功一条广播：后续 grow 的 evType = NodeCreated（evType 随事件类型分流）', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)
    const state = h.canvasService.readState(canvasId, SID)
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
  it('canvas.list → CanvasListReply；canvas.get → CanvasState（含 activeBindings 绑定徽标派生）；get 未知画布 → canvas_not_found error envelope（hint 恢复动作）', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)

    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.list', { sessionId: 'sid-agent' }), ws)
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.list', {
      canvases: [expect.objectContaining({ canvasId, converged: false })],
    })

    h.reply.mockClear()
    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.get', { canvasId, sessionId: 'sid-agent' }), ws)
    const state = h.reply.mock.calls[0][3] as CanvasState
    expect(state.canvasId).toBe(canvasId)
    expect(state.root.statement).toBe('多引擎支持怎么落地')
    // 绑定在册（sid-agent）但 client 不存在 → 活跃交集 0（徽标「当前无 agent 在响应」
    // 的数据源——绑定记录 ∩ 存活 session，设计 §3.1(3)）
    expect(state.activeBindings).toBe(0)
    // 收敛阻断清单（导出面板门禁区②格逐项呈现数据源，CanvasState.convergenceBlockers
    // 契约注释）：新画布根悬空 + 无执行叶子 → 两类阻断在列
    expect(state.convergenceBlockers).toEqual(
      expect.arrayContaining([expect.stringContaining('就绪递归未成立'), expect.stringContaining('没有执行叶子')]),
    )
    // 查询侧派生只落在 WS get 附加层：domain 产物（service readState）不含该字段
    // ——落盘与 marker 工具结果均不携带（契约注释「optional = marker 通道不携带」）
    expect('convergenceBlockers' in h.canvasService.readState(canvasId, SID)).toBe(false)

    h.reply.mockClear()
    h.sendError.mockClear()
    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.get', { canvasId: 'cvs-missing', sessionId: 'sid-agent' }), ws)
    expect(h.reply).not.toHaveBeenCalled()
    expect(h.sendError).toHaveBeenCalledWith(ws, 'canvas_not_found', expect.any(String), 'rpc-1', expect.objectContaining({ hint: expect.stringContaining('canvas_list') }))
  })

  it('canvas.get activeBindings 派生：owner 存活计 1 / exited 不计 / session 真删除后画布不可达', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)

    // 存活 client 在册 → 活跃交集 1（owner 即回推对象）
    h.clients.set('sid-agent', makeFakeClient())
    h.reply.mockClear()
    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.get', { canvasId, sessionId: 'sid-agent' }), ws)
    expect((h.reply.mock.calls[0][3] as CanvasState).activeBindings).toBe(1)

    // pi 已退出（exited）→ owner 在册不等于活跃：排除（生死二态，无宽限窗）
    h.clients.set('sid-agent', makeFakeClient({ exited: true }))
    h.reply.mockClear()
    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.get', { canvasId, sessionId: 'sid-agent' }), ws)
    expect((h.reply.mock.calls[0][3] as CanvasState).activeBindings).toBe(0)

    // session 真删除 → 内存镜像摘除（磁盘树随 ext-sessions 整树回收归 u-deletion）：
    // 画布对该会话不可达（canvas_not_found error envelope）
    h.canvasService.unbindSession('sid-agent')
    h.sendError.mockClear()
    await h.handler.handleCanvasMessage(canvasWsMsg('canvas.get', { canvasId, sessionId: 'sid-agent' }), ws)
    expect(h.sendError).toHaveBeenCalledWith(ws, 'canvas_not_found', expect.any(String), 'rpc-1', expect.objectContaining({ hint: expect.any(String) }))
  })

  it('canvas.mutate 领域拒绝 → reply 失败腿结构化错误（selection_conflict：一问双选定）', async () => {
    const h = makeHarness()
    trackDir(h.dataDir)
    const canvasId = await createBoundCanvas(h)
    const state = h.canvasService.readState(canvasId, SID)
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
      actor: 'user', sessionId: 'sid-agent', action: 'select',
      params: { canvasId, questionId: state.root.nodeId, optionId: 'opt-a', reason: '先选 A' },
    })
    await h.handler.handleCanvasMessage(msg, ws)
    expect(h.reply).toHaveBeenCalledWith(ws, 'rpc-1', 'canvas.mutate', expect.objectContaining({ ok: true }))

    h.reply.mockClear()
    const msgAgain = canvasWsMsg('canvas.mutate', {
      actor: 'user', sessionId: 'sid-agent', action: 'select',
      params: { canvasId, questionId: state.root.nodeId, optionId: 'opt-b', reason: '未走 replace 迁移直接换选' },
    })
    await h.handler.handleCanvasMessage(msgAgain, ws)
    const failReply = h.reply.mock.calls[0][3] as Extract<CanvasMutateReply, { ok: false }>
    expect(failReply.ok).toBe(false)
    expect(failReply.error.code).toBe('selection_conflict')
    expect(failReply.error.recover).toContain('replace')
  })
})
});

// ======================================================================
// ← src/transport/config-preferences-message-handler.test.ts
// ======================================================================

const WS = {} as never


function mockCtx() {
  const replies: ServerMessage[] = []
  const configService = {
    // ④b 用例：非偏好组消息经主 switch 命中未迁移的既有 case（getAutoRenameEnabled）所需 stub
    getAutoRenameEnabled: vi.fn(() => false),
    // 偏好组 10 case 转发所需 stub（worktree 目录 / setup 脚本 / 裸仓脚本 / 超时 / 默认基分支）
    // 写 stub 返回 {ok:true}（M4/RT-7#1：setter 返回 {ok, code, error}，失败走 sendError）
    getWorktreeRootDir: vi.fn(() => '/wt'),
    setWorktreeRootDir: vi.fn().mockReturnValue({ ok: true }),
    getSetupScript: vi.fn(() => 'custom-hooks/setup-worktree.sh'),
    setSetupScript: vi.fn().mockReturnValue({ ok: true }),
    getBareSetupScript: vi.fn(() => 'custom-hooks/bare-setup.sh'),
    setBareSetupScript: vi.fn().mockReturnValue({ ok: true }),
    getTimeout: vi.fn(() => 90),
    setTimeout: vi.fn().mockReturnValue({ ok: true }),
    getDefaultBaseBranch: vi.fn(() => 'main'),
    setDefaultBaseBranch: vi.fn().mockReturnValue({ ok: true }),
    // u-locale-channel：config.setUiLocale 写盘经 configService.getConfigDir() 推导（用例内覆盖为 tmp 目录）
    getConfigDir: vi.fn(() => '/nonexistent-ui-prefs'),
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload } as unknown as ServerMessage)
    }),
    configService,
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    projectRoot: '/test',
    nextPushId: vi.fn(() => 'push_1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    // D-21 端口化：ctx connectionTester 构造必需——本文件用例不走 mode=test，vi.fn 替身即可
    connectionTester: { supports: vi.fn(), test: vi.fn() },
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, configService }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('config-preferences-message-handler', () => {
describe('ConfigPreferencesMessageHandler · 偏好组转发参数化（S15：12 条转发 case 零断言补测）', () => {
  it.each([
    {
      name: '⑤ config.getWorktreeRootDir 读取转发',
      msg: { type: 'config.getWorktreeRootDir', payload: {} },
      replyType: 'config.worktreeRootDir',
      payload: { dir: '/wt' },
      setter: undefined,
    },
    {
      name: '⑥ config.setWorktreeRootDir 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setWorktreeRootDir', payload: { dir: '/new-wt' } },
      replyType: 'config.worktreeRootDir',
      payload: { dir: '/wt' },
      setter: { fn: 'setWorktreeRootDir', arg: '/new-wt' },
    },
    {
      name: '⑦ config.getDefaultBaseBranch 读取转发',
      msg: { type: 'config.getDefaultBaseBranch', payload: {} },
      replyType: 'config.defaultBaseBranch',
      payload: { baseBranch: 'main' },
      setter: undefined,
    },
    {
      name: '⑧ config.setDefaultBaseBranch 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setDefaultBaseBranch', payload: { baseBranch: 'develop' } },
      replyType: 'config.defaultBaseBranch',
      payload: { baseBranch: 'main' },
      setter: { fn: 'setDefaultBaseBranch', arg: 'develop' },
    },
    {
      name: '⑨ config.setSetupScript 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setSetupScript', payload: { script: 'hooks/init.sh' } },
      replyType: 'config.setupScript',
      payload: { script: 'custom-hooks/setup-worktree.sh' },
      setter: { fn: 'setSetupScript', arg: 'hooks/init.sh' },
    },
    {
      name: '⑩ config.getSetupScript 读取转发',
      msg: { type: 'config.getSetupScript', payload: {} },
      replyType: 'config.setupScript',
      payload: { script: 'custom-hooks/setup-worktree.sh' },
      setter: undefined,
    },
    {
      name: '⑪ config.setBareSetupScript 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setBareSetupScript', payload: { script: 'hooks/bare.sh' } },
      replyType: 'config.bareSetupScript',
      payload: { script: 'custom-hooks/bare-setup.sh' },
      setter: { fn: 'setBareSetupScript', arg: 'hooks/bare.sh' },
    },
    {
      name: '⑫ config.getBareSetupScript 读取转发',
      msg: { type: 'config.getBareSetupScript', payload: {} },
      replyType: 'config.bareSetupScript',
      payload: { script: 'custom-hooks/bare-setup.sh' },
      setter: undefined,
    },
    {
      name: '⑬ config.setTimeout 写转发（原值透传 + 生效值 reply）',
      msg: { type: 'config.setTimeout', payload: { timeout: 120 } },
      replyType: 'config.worktreeTimeout',
      payload: { timeout: 90 },
      setter: { fn: 'setTimeout', arg: 120 },
    },
    {
      name: '⑭ config.getTimeout 读取转发',
      msg: { type: 'config.getTimeout', payload: {} },
      replyType: 'config.worktreeTimeout',
      payload: { timeout: 90 },
      setter: undefined,
    },
  ])('$name', async ({ msg, replyType, payload, setter }) => {
    const { ctx, replies, configService } = mockCtx()
    const handler = new ConfigPreferencesMessageHandler(ctx)
    const handled = await handler.handle({ ...msg, id: 's1' } as unknown as ClientMessage, WS)
    expect(handled).toBe(true)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: replyType, id: 's1' })
    expect(replies[0].payload).toEqual(payload)
    if (setter) {
      // it.each 表格字面量推宽 fn 为 string；收窄回 mock 对象键集合（TS7053，无 any 断言）
      expect(configService[setter.fn as keyof typeof configService]).toHaveBeenCalledWith(setter.arg)
    }
  })
})
describe('ConfigPreferencesMessageHandler · config.setUiLocale（u-locale-channel）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ui-locale-handler-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('写盘成功：回 ack 型 config.uiLocaleSet（空 payload）+ 文件落 zh-CN', async () => {
    const { ctx, replies, configService } = mockCtx()
    configService.getConfigDir.mockReturnValue(root)
    const handler = new ConfigPreferencesMessageHandler(ctx)
    const handled = await handler.handle(
      { type: 'config.setUiLocale', payload: { locale: 'zh-CN' }, id: 'loc1' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'config.uiLocaleSet', id: 'loc1', payload: {} })
    expect(readUiPreferences(root)).toBe('zh-CN')
  })

  it('同值重复推送：短路不重写（updatedAt 保持）且仍回 ack', async () => {
    const { ctx, replies, configService } = mockCtx()
    configService.getConfigDir.mockReturnValue(root)
    const handler = new ConfigPreferencesMessageHandler(ctx)
    const msg = { type: 'config.setUiLocale', payload: { locale: 'en-US' }, id: 'loc2' } as unknown as ClientMessage
    await handler.handle(msg, WS)
    const first = readUiPreferences(root)
    await handler.handle({ ...msg, id: 'loc3' } as unknown as ClientMessage, WS)
    expect(replies).toHaveLength(2)
    expect(replies.every((r) => r.type === 'config.uiLocaleSet')).toBe(true)
    expect(readUiPreferences(root)).toBe(first)
  })

  it('写盘失败：错误信封（不 reply ack 假成功）', async () => {
    const { ctx, replies, configService } = mockCtx()
    // configDir 指向一个已存在的文件 → mkdir/写盘失败
    const notADir = join(root, 'not-a-dir')
    writeFileSync(notADir, 'x', 'utf-8')
    configService.getConfigDir.mockReturnValue(notADir)
    const handler = new ConfigPreferencesMessageHandler(ctx)
    const handled = await handler.handle(
      { type: 'config.setUiLocale', payload: { locale: 'zh-CN' }, id: 'loc4' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(replies).toHaveLength(0)
    expect(ctx.sendError).toHaveBeenCalledWith(WS, 'ui_preferences_io_error', expect.any(String), 'loc4')
  })
})
describe('ConfigPreferencesMessageHandler · 兜底与不串扰', () => {
  it('④ 子 handler 对未知 type 返回 false 且零 reply/零 ConfigService 调用', async () => {
    const { ctx, replies, configService } = mockCtx()
    const handler = new ConfigPreferencesMessageHandler(ctx)
    const handled = await handler.handle(
      { type: 'config.setRetryConfig', payload: {}, id: 'm5' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(false)
    expect(replies).toHaveLength(0)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(configService.getAutoRenameEnabled).not.toHaveBeenCalled()
  })

  it('④b 非偏好组消息经主入口仍由既有 case 消化（偏好组前置委托不吞消息）', async () => {
    const { ctx, replies } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    // config.getAutoRenameEnabled 仍在主 switch（未迁移），子 handler 返回 false 后主 switch 命中
    const handled = await handler.handleSettingsMessage(
      { type: 'config.getAutoRenameEnabled', payload: {}, id: 'm6' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(true)
    expect(replies[0]).toMatchObject({ type: 'config.autoRenameEnabled', id: 'm6' })
  })

  it('④c 未知 type 经主入口走 default 兜底 false（unknown_type 由 server 层处理）', async () => {
    const { ctx, replies } = mockCtx()
    const handler = new SettingsMessageHandler(ctx)
    const handled = await handler.handleSettingsMessage(
      { type: 'config.nonExistent', payload: {}, id: 'm7' } as unknown as ClientMessage,
      WS,
    )
    expect(handled).toBe(false)
    expect(replies).toHaveLength(0)
  })
})
describe('ConfigPreferencesMessageHandler · setter 校验拒绝路径（config.setTimeout）', () => {
  it('config.setTimeout 非法值：校验异常上抛（不吞、零 reply、零 sendError）——sendError 由 server.handleMessage catch 层统一负责', async () => {
    const { ctx, replies, configService } = mockCtx()
    // 校验本体在 ConfigService.setTimeout（worktree-config-helper：正数且 ≤3600，非法 throw）。
    // handler 单测以 mock 抛错模拟该拒绝，锚定 handler 层契约：异常原样上抛、不 reply、
    // 不越层 sendError（错误回包形态由 server.handleMessage 的 catch 统一塑形）。
    configService.setTimeout.mockImplementation(() => {
      throw new Error('timeout must be a positive number in (0, 3600], got -1')
    })
    const handler = new ConfigPreferencesMessageHandler(ctx)
    await expect(
      handler.handle(
        { type: 'config.setTimeout', payload: { timeout: -1 }, id: 'm8' } as unknown as ClientMessage,
        WS,
      ),
    ).rejects.toThrow(/timeout must be a positive number/)
    expect(replies).toHaveLength(0)
    expect(ctx.sendError).not.toHaveBeenCalled()
    // 抛错即止：生效值回读（getTimeout）不达，无「半写」reply
    expect(configService.getTimeout).not.toHaveBeenCalled()
  })
})
});

// ======================================================================
// ← src/transport/model-message-handler.test.ts
// ======================================================================

function makeCtx(resolved: Promise<ResolvedProviderCredential | undefined>) {
  const discoverFromApi = vi.fn(async () => [{ id: 'm-1', name: 'M1' }])
  const testConnections = vi.fn(async () => ({ success: true, results: [] }))
  const resolver: IProviderCredentialResolver = {
    hasProviderCredential: () => false,
    listCredentialBackedProviderIds: () => new Set<string>(),
    resolveProviderCredential: () => resolved,
    resolveProviderApiKeyRaw: async () => undefined,
    resolveProviderBaseUrl: () => undefined,
  }
  const ctx = {
    reply: vi.fn(),
    sendError: vi.fn(),
    modelService: { discoverModelsFromApi: discoverFromApi, testProviderConnections: testConnections },
    providerCredentialResolver: resolver,
    connectionTester: { supports: () => true, test: vi.fn(async () => ({ api: 'a', modelId: 'm', ok: true })) },
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, discoverFromApi, testConnections, reply: ctx.reply }
}


const ws_m2 = {} as WsType


function discoverMsg(mode: 'discover' | 'test'): Extract<ClientMessage, { type: 'config.discoverModels' }> {
  return {
    type: 'config.discoverModels',
    id: 'req-1',
    payload: { baseUrl: 'https://api.example.com', providerId: 'p1', mode },
  } as Extract<ClientMessage, { type: 'config.discoverModels' }>
}


/** handler 的 handle 同步返回（promise 链在后台），flush 微任务后断言 reply。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('model-message-handler', () => {
describe('RT-7#4：unsupported 凭据形态在发请求前拦截（禁止下发 HTTP）', () => {
  it('discover 链：resolver 返回 { unsupported: "command" } → reply 失败中文文案，discoverModelsFromApi 零调用', async () => {
    const { ctx, discoverFromApi, reply } = makeCtx(Promise.resolve({ unsupported: 'command' }))
    const handler = new ModelMessageHandler(ctx)

    expect(handler.handle(discoverMsg('discover'), ws_m2)).toBe(true)
    await flush()

    expect(discoverFromApi).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(ws_m2, 'req-1', 'config.discoveredModels', {
      models: [],
      success: false,
      error: expect.stringContaining('command 形态'),
    })
  })

  it('discover 链：unresolved-env → 同拦，文案指向环境变量', async () => {
    const { ctx, discoverFromApi, reply } = makeCtx(Promise.resolve({ unsupported: 'unresolved-env' }))
    const handler = new ModelMessageHandler(ctx)

    expect(handler.handle(discoverMsg('discover'), ws_m2)).toBe(true)
    await flush()

    expect(discoverFromApi).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(ws_m2, 'req-1', 'config.discoveredModels', {
      models: [],
      success: false,
      error: expect.stringContaining('环境变量'),
    })
  })

  it('test 链：resolver 返回 unsupported → reply 顶层失败，testProviderConnections 零调用', async () => {
    const { ctx, testConnections, reply } = makeCtx(Promise.resolve({ unsupported: 'command' }))
    const handler = new ModelMessageHandler(ctx)

    expect(handler.handle(discoverMsg('test'), ws_m2)).toBe(true)
    await flush()

    expect(testConnections).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(ws_m2, 'req-1', 'config.discoveredModels', {
      models: [],
      success: false,
      error: expect.stringContaining('command 形态'),
      results: [],
    })
  })

  it('对照：resolver 返回明文 key → discover 正常发请求（拦截不误伤正常路径）', async () => {
    const { ctx, discoverFromApi, reply } = makeCtx(Promise.resolve({ key: 'sk-ok', source: 'auth.json', kind: 'api_key' }))
    const handler = new ModelMessageHandler(ctx)

    expect(handler.handle(discoverMsg('discover'), ws_m2)).toBe(true)
    await flush()

    expect(discoverFromApi).toHaveBeenCalledWith('https://api.example.com', 'sk-ok', undefined)
    expect(reply).toHaveBeenCalledWith(ws_m2, 'req-1', 'config.discoveredModels', {
      models: [{ id: 'm-1', name: 'M1' }],
      success: true,
    })
  })
})
});

// ======================================================================
// ← src/transport/oauth-message-handler-mirror.test.ts
// ======================================================================

const WS_m2 = {} as never


function mockCtx_m2(options: {
  providersMutatedSync?: () => Promise<void>
  loginStarted?: boolean
  logoutThrows?: boolean
} = {}) {
  const replies: Array<{ type: string; id?: string; payload: unknown }> = []
  const providersMutatedSync = options.providersMutatedSync ?? vi.fn(async () => {})
  const authService = {
    login: vi.fn((_providerId: string, onAuthenticated?: () => void) => {
      // 模拟流程终态：started 时异步回调（真实实装由 runFlow 在 auth.success 后调用）
      if (options.loginStarted !== false) onAuthenticated?.()
      return options.loginStarted === false
        ? { started: false, error: 'provider "x" 不支持 OAuth' }
        : { started: true }
    }),
    cancel: vi.fn(() => ({ cancelled: false })),
    hasOAuth: vi.fn(async () => false),
    logout: vi.fn(async () => {
      if (options.logoutThrows) throw new Error('EACCES')
    }),
  }
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload })
    }),
    authService,
    providersMutatedSync,
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, authService, providersMutatedSync }
}


function msg(type: string, payload: Record<string, unknown>): ClientMessage {
  return { type, id: 'm1', payload } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('oauth-message-handler-mirror', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
describe('OauthMessageHandler · 凭据域变更触发 zcode provider 镜像（MF-2）', () => {
  it('config.oauthLogin 成功（flow 终态回调）→ providersMutatedSync 恰被调用一次', async () => {
    const { ctx, providersMutatedSync, replies } = mockCtx_m2()
    const handler = new OauthMessageHandler(ctx)

    const handled = await handler.handle(msg('config.oauthLogin', { providerId: 'anthropic' }), WS_m2)

    expect(handled).toBe(true)
    expect(replies.some(r => r.type === 'config.oauthLoginReply')).toBe(true)
    expect(providersMutatedSync).toHaveBeenCalledTimes(1)
  })

  it('config.oauthLogin started:false（无 oauthConfig / 已有 flow）→ 回调不触发、无镜像调用', async () => {
    const { ctx, providersMutatedSync } = mockCtx_m2({ loginStarted: false })
    const handler = new OauthMessageHandler(ctx)

    await handler.handle(msg('config.oauthLogin', { providerId: 'anthropic' }), WS_m2)

    expect(providersMutatedSync).not.toHaveBeenCalled()
  })

  it('config.oauthLogout 成功 → 凭据域变更触发一次镜像', async () => {
    const { ctx, providersMutatedSync, replies } = mockCtx_m2()
    const handler = new OauthMessageHandler(ctx)

    const handled = await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS_m2)

    expect(handled).toBe(true)
    expect(replies.some(r => r.type === 'config.oauthLogoutReply' && (r.payload as { ok?: boolean }).ok === true)).toBe(true)
    expect(providersMutatedSync).toHaveBeenCalledTimes(1)
  })

  it('config.oauthLogout 失败（凭据可能仍在）→ 不触发镜像', async () => {
    const { ctx, providersMutatedSync } = mockCtx_m2({ logoutThrows: true })
    const handler = new OauthMessageHandler(ctx)

    await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS_m2)

    expect(providersMutatedSync).not.toHaveBeenCalled()
  })

  it('ctx 未注入 providersMutatedSync（存量测试装配形态）→ 登录/退出照常应答、不炸', async () => {
    const { ctx, replies } = mockCtx_m2()
    delete (ctx as { providersMutatedSync?: unknown }).providersMutatedSync
    const handler = new OauthMessageHandler(ctx)

    await handler.handle(msg('config.oauthLogin', { providerId: 'anthropic' }), WS_m2)
    await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS_m2)

    expect(replies.map(r => r.type)).toEqual(['config.oauthLoginReply', 'config.oauthLogoutReply'])
  })

  it('镜像 reject → catch 只 console.warn（fire-and-forget，不阻断 OAuth 应答）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, replies } = mockCtx_m2({
      providersMutatedSync: vi.fn(async () => { throw new Error('mirror boom') }),
    })
    const handler = new OauthMessageHandler(ctx)

    await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS_m2)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[oauth-message-handler] zcode provider mirror sync failed:',
      'mirror boom',
    ), { interval: 1 })

    expect(replies.some(r => r.type === 'config.oauthLogoutReply')).toBe(true)
  })

  it('镜像同步 throw（同步异常形态）→ logout 应答仍是单份 ok:true，不回第二份 ok:false（S-8）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, replies } = mockCtx_m2({
      // 同步 throw 而非 rejected promise：挪出主 try 前会走 catch 对同一 msg.id 回
      // 第二份 ok:false；挪出后由 mirrorAfterCredentialMutation 内部捕获只 warn
      providersMutatedSync: vi.fn((): Promise<void> => { throw new Error('sync throw') }),
    })
    const handler = new OauthMessageHandler(ctx)

    const handled = await handler.handle(msg('config.oauthLogout', { providerId: 'anthropic' }), WS_m2)

    expect(handled).toBe(true)
    const logoutReplies = replies.filter(r => r.type === 'config.oauthLogoutReply')
    expect(logoutReplies).toHaveLength(1)
    expect((logoutReplies[0].payload as { ok?: boolean }).ok).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      '[oauth-message-handler] zcode provider mirror sync failed:',
      'sync throw',
    )
  })
})
});

// ======================================================================
// ← src/transport/project-message-handler.test.ts
// ======================================================================

// ProjectMessageHandler 测试（PR #175 R1 S-12：D14 handler 补直接测试；命令通道
// connection-datasync-ssot §6.6/u6a 扩展）。对齐 sibling 惯例：mock Context + 部分实现
// ProjectStore（transport 零业务，只 ctx.reply / sendError / 广播，业务在 ProjectStore）。
// 命令通道的串行队列/归一化/revision 真行为在 services/project/project-store.test.ts
// （真 store + tmp 目录）；本段锚定 handler 编排契约：回执形态 / 拒绝转 error envelope /
// project.changed 广播时机 / 并发到达端到端保序。核心契约锚点：「失败不悬挂」——命令拒绝
// 走 error envelope（pending reject），与 load 恒 reply 同属 RPC 契约；legacy 整表写端点
// 已随命令化拆除（§6.6③），本段不再覆盖其校验分支。

// ── mock helpers ─────────────────────────────────────────────

function mockWs(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}


/** store.load() 返回的全量状态（模拟磁盘现状；命令 mock 不改返回值）。 */
const diskState: ProjectStoreState = {
  projects: [{ id: 'proj-1', name: 'demo', lastUsedAt: 100 }],
  activeProjectId: 'proj-1',
}


/**
 * 部分实现 mock：handler 只调 load/getRevision 与四命令入口，全接口 mock 无断言价值
 * （与 worktree-message-handler.test.ts 的 mockGitService 同策略）。
 */
function mockProjectStore() {
  return {
    load: vi.fn((): ProjectStoreState => diskState),
    getRevision: vi.fn((): number => 0),
  }
}


function mockContext(overrides?: Partial<ProjectHandlerContext>): ProjectHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    projectStore: mockProjectStore() as unknown as ProjectStore,
    broadcastProjectChanged: vi.fn(),
    ...overrides,
  }
}


/**
 * 构造 ClientMessage（payload 用 unknown：校验失败分支需传入不合法结构，
 * 经 as unknown 收窄绕过 protocol payload 类型，被测的正是运行时结构校验）。
 */
function msg_m2(
  type:
    | 'project.load'
    | 'project.createProject'
    | 'project.renameProject'
    | 'project.removeProject'
    | 'project.setActiveProject',
  payload: unknown,
  id = 'msg-1',
): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

/** 真 store + tmp 目录（命令通道并发/端到端用例；fs-guard 白名单 = tmpdir 自建自删）。 */
function realStore(): { store: ProjectStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'u6a-handler-'))
  return { store: new ProjectStore(dir), dir }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('project-message-handler', () => {
// ── handles 清单 ────────────────────────────────────────────

describe('ProjectMessageHandler.handles', () => {
  it('认领 load 与四写命令（§6.6；legacy 整表写端点已拆除）', () => {
    const handler = new ProjectMessageHandler(mockContext())
    expect(handler.handles).toEqual([
      'project.load',
      'project.createProject',
      'project.renameProject',
      'project.removeProject',
      'project.setActiveProject',
    ])
  })
})
// ── project.load ────────────────────────────────────────────

describe('ProjectMessageHandler project.load', () => {
  it('reply project.loaded 携带 store.load() 全量 + revision，不触发 sendError / 广播', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg_m2('project.load', {}), ws)

    expect(ctx.projectStore.load).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'project.loaded', { ...diskState, revision: 0 })
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.broadcastProjectChanged).not.toHaveBeenCalled()
  })

  it('reply 携带请求原 id（多请求并发时不串线）', async () => {
    const ctx = mockContext()
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg_m2('project.load', {}, 'msg-42'), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-42', 'project.loaded', { ...diskState, revision: 0 })
  })
})

// ── 命令通道（§6.6/u6a）：回执 / 拒绝 / project.changed 广播 ──────────

describe('ProjectMessageHandler 命令通道成功路径（mock store）', () => {
  const commandReply: ProjectCommandReply = {
    state: {
      projects: [
        { id: 'proj-default', name: '', lastUsedAt: 0 },
        { id: 'proj-1', name: 'demo', lastUsedAt: 100 },
      ],
      activeProjectId: 'proj-1',
    },
    revision: 1,
  }

  function commandContext(method: keyof ProjectStore) {
    const store = mockProjectStore()
    Object.assign(store, {
      [method]: vi.fn(() => Promise.resolve(commandReply)),
    })
    const ctx = mockContext({ projectStore: store as unknown as ProjectStore })
    return { ctx, store }
  }

  it.each([
    ['project.createProject', 'createProject', { name: 'demo', revision: 0 }, ['demo', 0]] as const,
    [
      'project.renameProject',
      'renameProject',
      { projectId: 'proj-1', name: 'renamed', revision: 0 },
      ['proj-1', 'renamed', 0],
    ] as const,
    ['project.removeProject', 'removeProject', { projectId: 'proj-1', revision: 0 }, ['proj-1', 0]] as const,
    [
      'project.setActiveProject',
      'setActiveProject',
      { projectId: 'proj-1', revision: 0 },
      ['proj-1', 0],
    ] as const,
  ])('%s：回执同名 type + 完整新状态与 revision 新值，并广播 project.changed', async (type, method, payload, args) => {
    const { ctx, store } = commandContext(method as keyof ProjectStore)
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg_m2(type, payload), ws)

    expect(store[method as keyof typeof store]).toHaveBeenCalledWith(...args)
    // reply type 与 request 同名（payload 消费型同名模式），payload = ProjectCommandReply 原样
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', type, commandReply)
    // 失效信号：空负载（每命令恰好一次，不带数据——交错判据走回执 revision）
    expect(ctx.broadcastProjectChanged).toHaveBeenCalledTimes(1)
    expect(ctx.broadcastProjectChanged).toHaveBeenCalledWith()
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})

describe('ProjectMessageHandler 命令通道拒绝（ProjectCommandError → error envelope）', () => {
  it('revision 失配：sendError 携带 code + 请求 id，不 reply、不广播（pending reject，不悬挂）', async () => {
    const store = mockProjectStore()
    Object.assign(store, {
      setActiveProject: vi.fn(() =>
        Promise.reject(
          new ProjectCommandError(
            'project_revision_mismatch',
            'revision 失配：当前 1，命令携带 0——重新 project.load 取最新状态与 revision 后重试',
          ),
        ),
      ),
    })
    const ctx = mockContext({ projectStore: store as unknown as ProjectStore })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(msg_m2('project.setActiveProject', { projectId: 'x', revision: 0 }, 'cmd-9'), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'project_revision_mismatch',
      expect.stringContaining('revision 失配'),
      'cmd-9',
    )
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.broadcastProjectChanged).not.toHaveBeenCalled()
  })

  it('语义拒绝（默认项保护/不存在/空名）同样走 error envelope，code 透传', async () => {
    const store = mockProjectStore()
    Object.assign(store, {
      removeProject: vi.fn(() =>
        Promise.reject(new ProjectCommandError('project_default_protected', '默认项目不可删除（未归类会话的兜底聚合）')),
      ),
    })
    const ctx = mockContext({ projectStore: store as unknown as ProjectStore })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleProjectMessage(
      msg_m2('project.removeProject', { projectId: 'proj-default', revision: 0 }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'project_default_protected',
      expect.any(String),
      'msg-1',
    )
    expect(ctx.broadcastProjectChanged).not.toHaveBeenCalled()
  })

  it('非 ProjectCommandError 的意外异常向上抛（上层 handler_error 兜底，不伪装成命令拒绝）', async () => {
    const store = mockProjectStore()
    Object.assign(store, {
      createProject: vi.fn(() => Promise.reject(new Error('unexpected disk failure'))),
    })
    const ctx = mockContext({ projectStore: store as unknown as ProjectStore })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    await expect(
      handler.handleProjectMessage(msg_m2('project.createProject', { name: 'x', revision: 0 }), ws),
    ).rejects.toThrow('unexpected disk failure')
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.broadcastProjectChanged).not.toHaveBeenCalled()
  })
})

describe('ProjectMessageHandler 命令通道并发到达（真 store + 串行队列端到端）', () => {
  it('两条命令并发 fire（不依序 await）→ 依到达顺序串行执行，回执 revision 连续递增', async () => {
    const { store } = realStore()
    const ctx = mockContext({ projectStore: store })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    // 受控 promise 构造：Promise.all 并发派发（第一条未 await 即发第二条——模拟消息
    // 异步 fire-and-forget 到达）；第二条携带 revision=1（= 第一条执行后的值），只有
    // 第一条已完整执行它才可能通过校验——成功即证明串行时序。
    const first = handler.handleProjectMessage(msg_m2('project.createProject', { name: 'A', revision: 0 }, 'cmd-a'), ws)
    const second = handler.handleProjectMessage(msg_m2('project.createProject', { name: 'B', revision: 1 }, 'cmd-b'), ws)
    await Promise.all([first, second])

    const replies = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls
    expect(replies).toHaveLength(2)
    // reply 顺序 = 到达顺序（cmd-a 先于 cmd-b），revision 依次 1、2
    expect(replies[0][2]).toBe('project.createProject')
    expect(replies[1][2]).toBe('project.createProject')
    const replyA = replies[0][3] as ProjectCommandReply
    const replyB = replies[1][3] as ProjectCommandReply
    expect(replyA.revision).toBe(1)
    expect(replyB.revision).toBe(2)
    // 第二条看到第一条的完整效果（A、B 均在，B 为活跃）
    expect(replyB.state.projects.map((p) => p.name)).toContain('A')
    expect(replyB.state.projects.map((p) => p.name)).toContain('B')
    expect(replyB.state.activeProjectId).toBe(replyB.state.projects.find((p) => p.name === 'B')?.id)
    // 广播与命令一一对应（失效信号每条命令一次）
    expect(ctx.broadcastProjectChanged).toHaveBeenCalledTimes(2)
    store.flushAll()
  })

  it('并发到达时第二条 revision 基于旧水位 → 第一条执行后按新水位拒绝（过时窗口保护端到端）', async () => {
    const { store } = realStore()
    const ctx = mockContext({ projectStore: store })
    const handler = new ProjectMessageHandler(ctx)
    const ws = mockWs()

    const first = handler.handleProjectMessage(msg_m2('project.createProject', { name: 'A', revision: 0 }, 'cmd-a'), ws)
    // 第二条携带过时 revision=0（窗口内并发双写形态）→ 排队执行时校验失败
    const second = handler.handleProjectMessage(msg_m2('project.createProject', { name: 'B', revision: 0 }, 'cmd-b'), ws)
    await Promise.all([first, second])

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'project_revision_mismatch',
      expect.stringContaining('revision 失配'),
      'cmd-b',
    )
    // 拒绝不广播失效信号
    expect(ctx.broadcastProjectChanged).toHaveBeenCalledTimes(1)
    store.flushAll()
  })
})
});

// ======================================================================
// ← src/transport/provider-message-handler.test.ts
// ======================================================================

// ── mock 域依赖（quota presets 注册表 / models-store mtime watch）──

const { listQuotaPresetsMock, startWatchMock } = vi.hoisted(() => ({
  listQuotaPresetsMock: vi.fn(),
  startWatchMock: vi.fn(),
}))


vi.mock('../services/quota-providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/quota-providers/index.js')>()
  return { ...actual, listQuotaPresets: listQuotaPresetsMock, }
})

vi.mock('../services/provider-catalog-refresh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/provider-catalog-refresh.js')>()
  return { ...actual, startModelsStoreMtimeWatch: startWatchMock, }
})


const PRESETS = [
  { fetcher: 'zhipu', label: 'Zhipu Coding Plan', auth: ['api-key'], match: { baseUrlPattern: 'bigmodel.cn', namePattern: 'zhipu' } },
] as never


function mockWs_m2(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}


/** 最小 ctx（被测路由只消费 reply / broadcastProviderList；其余接口成员零消费不 mock）。 */
function mockContext_m2(): SettingsHandlerContext {
  return {
    reply: vi.fn(),
    sendError: vi.fn(),
    broadcastProviderList: vi.fn(),
    configService: {
      refreshProviderCatalogs: vi.fn().mockResolvedValue({ refreshed: [], failed: [], corrupt: [] }),
      refreshRemoteProviders: vi.fn().mockResolvedValue({ updatedProviders: [] }),
    },
  } as unknown as SettingsHandlerContext
}


const WS_m3 = mockWs_m2()


function msg_m3(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-message-handler', () => {
beforeEach(() => {
  listQuotaPresetsMock.mockReset().mockReturnValue(PRESETS)
  startWatchMock.mockReset().mockReturnValue(vi.fn())
})
describe('config.listQuotaPresets（W3c quota presets 下发）', () => {
  it('reply config.quotaPresets 携带注册表合并视图，返回 true', async () => {
    const ctx = mockContext_m2()
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg_m3('config.listQuotaPresets'), WS_m3)

    expect(handled).toBe(true)
    expect(listQuotaPresetsMock).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS_m3, 'msg-1', 'config.quotaPresets', { presets: PRESETS })
  })
})
describe('config.refreshProviderCatalogs（远程目录刷新 + 顺带 remote-config 同步）', () => {
  it('reply 成功 envelope + 广播一次，返回 true', async () => {
    const ctx = mockContext_m2()
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg_m3('config.refreshProviderCatalogs'), WS_m3)

    expect(handled).toBe(true)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS_m3, 'msg-1', 'config.providerCatalogsRefreshed', {
      refreshed: [], failed: [], corrupt: [],
    })
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(1)
  })

  it('远程同步有 provider 合并写盘 → 再广播一次', async () => {
    const ctx = mockContext_m2()
    ;(ctx.configService.refreshRemoteProviders as ReturnType<typeof vi.fn>).mockResolvedValue({ updatedProviders: ['p1'] })
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg_m3('config.refreshProviderCatalogs'), WS_m3)

    expect(handled).toBe(true)
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(2)
  })

  it('远程同步失败 → 降级为 warn 留痕、不上抛（reply 已发成功 envelope，不得对同一 msg.id 补发 error）', async () => {
    const ctx = mockContext_m2()
    ;(ctx.configService.refreshRemoteProviders as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('sync boom'))
    const handler = new ProviderMessageHandler(ctx)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 关键断言：handle 不 reject —— 异常若冒泡到 server.ts handleMessage 的 catch，
    // 会对同一 msg_m3.id 补发 error envelope，形成「成功 reply + error」双回复。
    const handled = await handler.handle(msg_m3('config.refreshProviderCatalogs'), WS_m3)

    expect(handled).toBe(true)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS_m3, 'msg-1', 'config.providerCatalogsRefreshed', {
      refreshed: [], failed: [], corrupt: [],
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('[remote-config] refresh remote providers failed:', 'sync boom')
    warnSpy.mockRestore()
  })
})
describe('config.setProviderCatalogWatch（W1 缝隙 A：models-store mtime watch 启停）', () => {
  it('enable=true → 启动 watch，reply watch-enabled', async () => {
    const ctx = mockContext_m2()
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg_m3('config.setProviderCatalogWatch', { enable: true }), WS_m3)

    expect(handled).toBe(true)
    expect(startWatchMock).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS_m3, 'msg-1', 'message.status', { status: 'watch-enabled' })
  })

  it('已启用时再次 enable=true → 不重复启动（单布尔最后写者赢，watch 不叠加）', async () => {
    const ctx = mockContext_m2()
    const handler = new ProviderMessageHandler(ctx)
    await handler.handle(msg_m3('config.setProviderCatalogWatch', { enable: true }), WS_m3)
    await handler.handle(msg_m3('config.setProviderCatalogWatch', { enable: true }), WS_m3)

    expect(startWatchMock).toHaveBeenCalledTimes(1)
  })

  it('enable=false → 停止 watch（stop 恰好一次），reply watch-disabled', async () => {
    const ctx = mockContext_m2()
    const handler = new ProviderMessageHandler(ctx)
    await handler.handle(msg_m3('config.setProviderCatalogWatch', { enable: true }), WS_m3)
    const stop = startWatchMock.mock.results[0]!.value as ReturnType<typeof vi.fn>
    await handler.handle(msg_m3('config.setProviderCatalogWatch', { enable: false }), WS_m3)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenLastCalledWith(WS_m3, 'msg-1', 'message.status', { status: 'watch-disabled' })
  })

  it('未启用时 enable=false → 不调 stop（幂等关闭），reply watch-disabled', async () => {
    const ctx = mockContext_m2()
    const handler = new ProviderMessageHandler(ctx)
    const handled = await handler.handle(msg_m3('config.setProviderCatalogWatch', { enable: false }), WS_m3)

    expect(handled).toBe(true)
    expect(startWatchMock).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(WS_m3, 'msg-1', 'message.status', { status: 'watch-disabled' })
  })

  it('watch 回调（mtime 变化）→ broadcastProviderList（读侧重读后广播的唯一触发点）', async () => {
    const ctx = mockContext_m2()
    const handler = new ProviderMessageHandler(ctx)
    await handler.handle(msg_m3('config.setProviderCatalogWatch', { enable: true }), WS_m3)

    const onChange = startWatchMock.mock.calls[0]![0] as () => void
    onChange()
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(1)
  })
})
});

// ======================================================================
// ← src/transport/provider-message-handler-mirror.test.ts
// ======================================================================

const WS_m4 = {} as never


function mockCtx_m3(options: { providersMutatedSync?: () => Promise<void> } = {}) {
  const replies: Array<{ type: string; id?: string; payload: unknown }> = []
  const configService = {
    listProviders: vi.fn(() => []),
    getScopedModels: vi.fn(() => []),
    isModelsStoreCorrupted: vi.fn(() => false),
    getDefaultModel: vi.fn(() => null),
    refreshProviderCatalogs: vi.fn(async () => ({ updated: 0, failed: [] as string[] })),
    setProvider: vi.fn(async () => ({ newDefault: undefined, quotaAutoEnabled: false })),
    deleteProvider: vi.fn(async () => ({ removed: true, newDefault: undefined })),
    toggleProviderEnabled: vi.fn(() => ({ newDefault: undefined })),
    removeProviderByKind: vi.fn(async () => ({ removed: true, newDefault: undefined })),
    applyImportProviders: vi.fn(async () => ({
      result: { imported: 1, skipped: 0 } satisfies { imported: number; skipped: number },
    })),
  }
  const providersMutatedSync = options.providersMutatedSync ?? vi.fn(async () => {})
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: unknown) => {
      replies.push({ type, id, payload })
    }),
    configService,
    sessionService: {},
    modelService: {},
    authService: {},
    skillRegistry: {},
    projectRoot: '/test',
    nextPushId: vi.fn(() => 'push_1'),
    broadcast: vi.fn(),
    broadcastProviderList: vi.fn(),
    broadcastSkillList: vi.fn(),
    broadcastSkillCacheInvalidated: vi.fn(),
    broadcastAgentList: vi.fn(),
    broadcastSkillDirs: vi.fn(),
    broadcastAgentDirs: vi.fn(),
    broadcastExtensionDirs: vi.fn(),
    connectionTester: { supports: vi.fn(), test: vi.fn() },
    providersMutatedSync,
  }
  return { ctx: ctx as unknown as SettingsHandlerContext, replies, configService, providersMutatedSync }
}


function msg_m4(type: string, payload: Record<string, unknown>): ClientMessage {
  return { type, id: 'm1', payload } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('provider-message-handler-mirror', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
describe('ProviderMessageHandler · mirrorAfterMutation write-through 触发链（ADR-0142）', () => {
  it.each([
    {
      name: 'config.setProvider',
      message: msg_m4('config.setProvider', { providerId: 'stepfun', name: 'StepFun' }),
      serviceFn: 'setProvider' as const,
    },
    {
      name: 'config.deleteProvider',
      message: msg_m4('config.deleteProvider', { providerId: 'stepfun' }),
      serviceFn: 'deleteProvider' as const,
    },
    {
      name: 'config.toggleProviderEnabled',
      message: msg_m4('config.toggleProviderEnabled', { providerId: 'stepfun', enabled: false }),
      serviceFn: 'toggleProviderEnabled' as const,
    },
    {
      name: 'config.removeProviderByKind',
      message: msg_m4('config.removeProviderByKind', { providerId: 'stepfun', kind: 'custom' }),
      serviceFn: 'removeProviderByKind' as const,
    },
    {
      name: 'config.refreshProviderCatalogs',
      message: msg_m4('config.refreshProviderCatalogs', {}),
      serviceFn: 'refreshProviderCatalogs' as const,
    },
  ])('$name 处理成功 → providersMutatedSync 恰被调用一次', async ({ message, serviceFn }) => {
    const { ctx, providersMutatedSync, configService } = mockCtx_m3()
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(message, WS_m4)

    expect(handled).toBe(true)
    expect(configService[serviceFn]).toHaveBeenCalled()
    expect(providersMutatedSync).toHaveBeenCalledTimes(1)
  })

  it('config.applyImportProviders 成功分支：同步触发 + 目录刷新 .then 回调再触发（共两次）', async () => {
    const { ctx, providersMutatedSync, configService, replies } = mockCtx_m3()
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(
      msg_m4('config.applyImportProviders', { importId: 'imp-1', selectedIds: ['stepfun'] }),
      WS_m4,
    )

    expect(handled).toBe(true)
    expect(replies.some(r => r.type === 'config.providersImported')).toBe(true)
    // 同步一次（mutation 落盘后）+ refreshProviderCatalogs resolve 后 .then 一次
    await vi.waitFor(() => expect(providersMutatedSync).toHaveBeenCalledTimes(2), { interval: 1 })
    expect(configService.applyImportProviders).toHaveBeenCalledWith('imp-1', ['stepfun'])
  })

  it('镜像同步 reject → catch 只 warn，不上抛不阻断 handler（fire-and-forget 语义）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, providersMutatedSync } = mockCtx_m3({
      providersMutatedSync: vi.fn(async () => {
        throw new Error('mirror write failed')
      }),
    })
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(msg_m4('config.setProvider', { providerId: 'stepfun' }), WS_m4)

    expect(handled).toBe(true)
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled(), { interval: 1 })
    const warnText = warnSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    expect(warnText).toContain('[provider-message-handler] zcode provider mirror sync failed')
    expect(warnText).toContain('mirror write failed')
  })

  it('镜像同步 throw（同步异常形态）→ handler 正常返回、配置写入应答照常（S-8 同族）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, replies } = mockCtx_m3({
      // 同步 throw 而非 rejected promise：触发点均在 reply 之后，未防护时会冒泡到
      // server 层对同一 msg_m4.id 补发 error envelope（成功 + 失败双回复）
      providersMutatedSync: vi.fn((): Promise<void> => { throw new Error('sync throw') }),
    })
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(msg_m4('config.setProvider', { providerId: 'stepfun' }), WS_m4)

    expect(handled).toBe(true)
    expect(replies.filter(r => r.type === 'config.providerUpdated')).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[provider-message-handler] zcode provider mirror sync failed:',
      'sync throw',
    )
  })

  it('ctx 未注入（undefined，存量测试装配形态）→ 不调用不炸，配置写入照常应答', async () => {
    const { ctx, replies } = mockCtx_m3()
    delete (ctx as { providersMutatedSync?: unknown }).providersMutatedSync
    const handler = new ProviderMessageHandler(ctx)

    const handled = await handler.handle(msg_m4('config.setProvider', { providerId: 'stepfun' }), WS_m4)

    expect(handled).toBe(true)
    expect(replies.some(r => r.type === 'config.providerUpdated')).toBe(true)
  })
})
});

// ======================================================================
// ← src/transport/quota-message-handler.test.ts
// ======================================================================

function mockContext_m3(quotaService: Partial<QuotaService>): QuotaHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    quotaService: quotaService as QuotaService,
    broadcastProviderList: vi.fn(),
  }
}


function msg_m5(type: string, payload: Record<string, unknown> = {}, id = 'm1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

const WS_m5 = {} as never

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('quota-message-handler', () => {
describe('QuotaMessageHandler · quota.configure await 竞态（A1-5）', () => {
  it('configure 落盘完成（pending）期间 reply 不发出；resolve 后 reply 携带真实结果', async () => {
    // 可控 deferred：configure 返回 pending promise，resolve 时机由测试掌握
    let resolveConfigure!: (v: { ok: boolean }) => void
    const configure = vi.fn().mockImplementation(
      () => new Promise<{ ok: boolean }>(resolve => { resolveConfigure = resolve }),
    )
    const ctx = mockContext_m3({ configure })
    const handler = new QuotaMessageHandler(ctx)

    const pending = handler.handleQuotaMessage(
      msg_m5('quota.configure', { providerId: 'zai-coding-cn', enabled: true }), WS_m5,
    )

    // 排空全部微任务 + 一个宏任务周期：若 handler 去掉 await（回归形态），reply 会在
    // configure 仍 pending 时先行发出——此处即红（时序判别点 1）
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.reply).not.toHaveBeenCalled()

    resolveConfigure({ ok: true })
    await pending
    // reply 携带 resolve 后的真实结果，不是未决 Promise（时序判别点 2：
    // 回归形态下 payload 是 Promise 对象，toEqual 深比较不匹配）
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(WS_m5, 'm1', 'quota.configure:result', { ok: true })
  })

  it('configure 返回 ok:false → reply 原样携带错误范围', async () => {
    const ctx = mockContext_m3({ configure: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) })
    const handler = new QuotaMessageHandler(ctx)

    await handler.handleQuotaMessage(
      msg_m5('quota.configure', { providerId: 'zai-coding-cn', enabled: false }), WS_m5,
    )
    expect(ctx.reply).toHaveBeenCalledWith(WS_m5, 'm1', 'quota.configure:result', { ok: false, error: 'boom' })
    // 失败未落盘，providers.json 无变化 → 不广播（广播旧列表无意义）
    expect(ctx.broadcastProviderList).not.toHaveBeenCalled()
  })

  it('configure 成功 → 广播 provider 列表（renderer providers 快照即时刷新，不依赖重启）', async () => {
    const ctx = mockContext_m3({ configure: vi.fn().mockResolvedValue({ ok: true }) })
    const handler = new QuotaMessageHandler(ctx)

    await handler.handleQuotaMessage(
      msg_m5('quota.configure', { providerId: 'zai-coding-cn', enabled: true }), WS_m5,
    )
    expect(ctx.broadcastProviderList).toHaveBeenCalledTimes(1)
  })

  it('configure 分支整对象透传 wire payload（含 handler 当期不消费的字段，不被逐字段裁剪）', async () => {
    // 防的回归：handler 退回逐参调用（configure(providerId, enabled, cookie, …)）时，上方
    // 3 条用例仍全绿——它们只断 reply/广播时序，不检查入参形状，透传正确性此前仅靠 tsc 的
    // 单参签名强制。payload 里放一个 handler 当期不消费的额外字段（workspace），逐字段解构
    // 重组会把它丢掉或改写形状，两条断言互补可证伪（分工见下方 ①②）。
    const configure = vi.fn().mockResolvedValue({ ok: true })
    const ctx = mockContext_m3({ configure })
    const handler = new QuotaMessageHandler(ctx)
    const payload = {
      providerId: 'zai-coding-cn',
      enabled: true,
      credentialSource: 'exclusive',
      workspace: 'https://wrk.example.com',
    }

    await handler.handleQuotaMessage(msg_m5('quota.configure', payload), WS_m5)

    expect(configure).toHaveBeenCalledTimes(1)
    // ① 关心字段逐一到位（漏传任一字段即红）
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'zai-coding-cn',
      enabled: true,
      credentialSource: 'exclusive',
      workspace: 'https://wrk.example.com',
    }))
    // ② 整对象深比较：handler 凭空补字段（如归一化后再传）同样红——① 对此不变红，
    //    两者可证伪的 mutation 不同，故不互为冗余
    expect(configure).toHaveBeenCalledWith(payload)
  })
})
describe('QuotaMessageHandler · providerId 防御（W3）', () => {
  it.each(['quota.fetch', 'quota.refresh', 'quota.getCached', 'quota.configure'] as const)(
    '%s 缺 providerId → sendError invalid_payload，不触达 service',
    async (type) => {
      const service = {
        fetch: vi.fn(),
        refresh: vi.fn(),
        getCached: vi.fn(),
        configure: vi.fn(),
      }
      const ctx = mockContext_m3(service)
      const handler = new QuotaMessageHandler(ctx)

      await handler.handleQuotaMessage(msg_m5(type, { enabled: true }), WS_m5)

      expect(ctx.sendError).toHaveBeenCalledWith(WS_m5, 'invalid_payload', 'providerId required', 'm1')
      expect(ctx.reply).not.toHaveBeenCalled()
      expect(service.fetch).not.toHaveBeenCalled()
      expect(service.refresh).not.toHaveBeenCalled()
      expect(service.getCached).not.toHaveBeenCalled()
      expect(service.configure).not.toHaveBeenCalled()
    },
  )
})
});
