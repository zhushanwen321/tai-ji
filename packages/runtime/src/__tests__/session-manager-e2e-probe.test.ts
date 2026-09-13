/**
 * session-manager e2e 探针（U4-E2 / U4-E3）— cw 红阶段区分力版。
 *
 * 与 scripts/cw/session-manager-e2e.sh 内嵌 mock 探针的区别：本探针驱动仓库**真实实现**
 * 的完整事件链——event-adapter marker 翻译（translate 的 SESSION_MANAGER_MARKER 检测分支）
 * → EventInterpreter session-manager 路由（onSessionManagerRequest）→ SessionManagerHandler
 * 6 action 分发 → extension_ui_response 回写 pi stdin。mock 只保留两层：
 *   1. pi 子进程 IO 层（JSONL stdout → runtime / runtime → stdin 的 wire 映射）
 *   2. SessionService 数据层（ISessionService fake）
 *
 * 红阶段语义（区分力锚点）：下方 import 的实现符号（SessionManagerHandler / translate /
 * EventInterpreter）在无实现基线树上不存在 → 模块解析失败 → 探针必 FAIL。
 * 禁止在本文件对 import 失败做 try/catch 容错（会把「必挂」退化回「恒真」）。
 *
 * 运行（与 cw spec 验收命令一致）：cd packages/runtime && npx vitest run src/__tests__/session-manager-e2e-probe.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
// ↓ 真实实现 import（红阶段区分力锚点，勿改成动态 import / try-catch）
import { translate } from '../infra/pi/event-adapter.js'
import { EventInterpreter } from '../services/session/event-interpreter.js'
import { createSessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'
import { SessionManagerHandler } from '../transport/session-manager-handler.js'
import { SESSION_MANAGER_MARKER, type SessionManagerAction } from '@xyz-agent/extension-protocol'
import type { PiEvent } from '../infra/pi/pi-protocol.js'
import type { ISessionService } from '../interfaces.js'

/** pi stdout JSONL 行的边界解析形态（与 rpc-client 的行解析边界一致，窄化到本探针消费面） */
interface UiResponseWireLine {
  type: string
  id: string
  value?: string
  cancelled?: boolean
}

/**
 * 模拟 pi 子进程 IO 层。stdinLines 是 runtime 回写 pi stdin 的 JSONL 行缓冲；
 * sendExtensionUiResponse 的 wire 映射与真实 rpc-client（rpc-client.ts）一致——
 * 本探针只覆盖 handler 会走到的两个分支：null → cancelled / select → value。
 */
class FakePiProcessIo {
  readonly stdinLines: string[] = []

  sendExtensionUiResponse(id: string, response: unknown, _method?: string): void {
    const payload: UiResponseWireLine = response === null
      ? { type: 'extension_ui_response', id, cancelled: true }
      : { type: 'extension_ui_response', id, value: String(response) }
    this.stdinLines.push(JSON.stringify(payload))
  }
}

function makeSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    label: 'fake-session',
    cwd: '/test/cwd',
    status: 'active',
    lastActiveAt: 1_755_000_000_000,
    modelId: 'openai/gpt-4',
    tokenCount: 0,
    // 归属校验默认材料：发起方一律 'sid-parent'，目标 s1 默认是其 managed child
    spawnSource: 'agent',
    parentAgentSessionId: 'sid-parent',
    ...overrides,
  }
}

/** fake pi client：delivery port.send 的终点（ensureActive 返回值） */
function makeFakeClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

/** fake session 运行时视图：delivery isIdle 判定 + D7 置位副作用的落点 */
function makeFakeSessionView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    cwd: '/test/cwd',
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    lastActiveAt: 1_755_000_000_000,
    ...overrides,
  }
}

/** SessionService 数据层 fake：5 个管理 action 的默认返回值（形状对齐 ISessionService 契约） */
function makeFakeSessionService(overrides: Partial<ISessionService> = {}): ISessionService {
  return {
    create: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ blocked: false, rejected: false }),
    ensureActive: vi.fn().mockResolvedValue(makeFakeClient()),
    getSession: vi.fn().mockReturnValue(makeFakeSessionView()),
    getHistory: vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      truncated: false,
    }),
    getSummary: vi.fn().mockReturnValue(makeSummary()),
    listPersistedSessions: vi.fn().mockReturnValue([
      { cwd: '/test/cwd', sessions: [makeSummary({ id: 'agent-1', spawnSource: 'agent', parentAgentSessionId: 'sid-parent' }), makeSummary({ id: 'user-1', spawnSource: 'user' })] },
    ]),
    abort: vi.fn().mockResolvedValue(undefined),
    getRpcClient: vi.fn(),
    getActiveSessionIds: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ISessionService
}

/** 构造 pi stdout 上的 extension_ui_request JSONL 行（session-manager extension 的序列化形态） */
function buildUiRequestLine(requestId: string, action: string, params: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'extension_ui_request',
    id: requestId,
    method: 'select',
    title: SESSION_MANAGER_MARKER,
    options: [JSON.stringify({ action, params })],
  })
}

/** 构造 malformed 请求行：options[0] 不是合法 JSON（U4-E3 场景） */
function buildMalformedUiRequestLine(requestId: string): string {
  return JSON.stringify({
    type: 'extension_ui_request',
    id: requestId,
    method: 'select',
    title: SESSION_MANAGER_MARKER,
    options: ['invalid json'],
  })
}

interface E2ePipeline {
  pi: FakePiProcessIo
  /** dispatch 单条 pi stdout JSONL 行：解析 → 真实 translate → 真实 interpret → 等 handler 完成 */
  dispatch(piStdoutLine: string): Promise<void>
  /** 前端 UI 超时注册入口（session-manager 路径不应触发——「不弹前端对话框」断言用） */
  onExtensionUIRequest: ReturnType<typeof vi.fn>
}

/**
 * 组装 e2e 链路。接线与组合根一致（server.ts 的 SessionManagerHandler 构造 +
 * handleSessionManagerRequest fire-and-forget 委托 + EventInterpreter opts 注入），
 * 只把 pi 子进程 IO 与 SessionService 换成 fake。sd-u5 起 delivery 用真实 registry
 * 装配（fake sessionService 提供 getSession/ensureActive 材料层）。
 */
function makeE2ePipeline(sessionService: ISessionService): E2ePipeline {
  const pi = new FakePiProcessIo()
  const onExtensionUIRequest = vi.fn()
  const delivery = createSessionDeliveryRegistry({
    getSession: (sid) => sessionService.getSession(sid),
    ensureActive: (sid) => sessionService.ensureActive(sid),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => null,
  })
  const handler = new SessionManagerHandler({
    sessionService,
    delivery,
    sendExtensionUiResponse: (sessionId, requestId, response, method) =>
      pi.sendExtensionUiResponse(requestId, response, method),
    broadcastSessionList: () => {},
  })
  let handling: Promise<void> = Promise.resolve()
  const interpreter = new EventInterpreter('sid-parent', {
    send: () => {},
    onExtensionUIRequest,
    onSessionManagerRequest: (requestId, sessionId, action, params) => {
      // fire-and-forget 委托（与 server.handleSessionManagerRequest 一致）；promise 暴露给测试 await
      handling = handler.handle(requestId, sessionId, action as SessionManagerAction | '__malformed__', params)
    },
  })
  return {
    pi,
    onExtensionUIRequest,
    async dispatch(piStdoutLine: string): Promise<void> {
      const event = JSON.parse(piStdoutLine) as PiEvent
      interpreter.interpret(translate(event, 'sid-parent'))
      await handling
    },
  }
}

/** 读取 runtime 回写的唯一一条 extension_ui_response 行并解析（多于一条即 fail） */
function readSingleResponse(pi: FakePiProcessIo): UiResponseWireLine {
  expect(pi.stdinLines, `expected exactly 1 response line, got: ${JSON.stringify(pi.stdinLines)}`).toHaveLength(1)
  const parsed = JSON.parse(pi.stdinLines[0]) as UiResponseWireLine
  expect(parsed.type).toBe('extension_ui_response')
  return parsed
}

describe('U4-E1 create e2e probe', () => {
  it('create 全链路：marker request → 真实 handler 创建 session + 直投初始 prompt + 回写 sessionId', async () => {
    const client = makeFakeClient()
    const sessionService = makeFakeSessionService({
      create: vi.fn().mockResolvedValue(makeSummary({ id: 'child-1', spawnSource: 'agent' })),
      ensureActive: vi.fn().mockResolvedValue(client),
    })
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildUiRequestLine('req-create', 'create', {
      cwd: '/test/cwd', label: 'E2E 测试执行', prompt: 'run the suite',
    }))

    // create 以 spawnSource='agent' + parentAgentSessionId=父 session 调用（服务端注入，不信任请求侧）
    expect(sessionService.create).toHaveBeenCalledWith('/test/cwd', 'E2E 测试执行', expect.objectContaining({
      spawnSource: 'agent',
      parentAgentSessionId: 'sid-parent',
    }))
    // 初始 prompt 直投到新 session（sd-u5：delivery.sendDirect → ensureActive + prompt，不走内核队列）
    expect(sessionService.ensureActive).toHaveBeenCalledWith('child-1')
    expect(client.prompt).toHaveBeenCalledWith('run the suite', undefined, undefined)
    // 回写 select value 通道，结果 JSON 含 sessionId/status
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.cancelled).toBeUndefined()
    expect(JSON.parse(resp.value as string)).toEqual(expect.objectContaining({ sessionId: 'child-1', status: 'created' }))
    // 不触发前端 UI（不经 renderer 对话框）
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })
})

describe('U4-E2 manage e2e probe', () => {
  it('marker 翻译：select+SESSION_MANAGER_MARKER → session-manager-ui kind（强类型 action/params）', () => {
    const events = translate(
      JSON.parse(buildUiRequestLine('req-send', 'send', { sessionId: 's1', prompt: 'hello' })) as PiEvent,
      'sid-parent',
    )
    const uiEvent = events.find((e) => e.kind === 'session-manager-ui')
    expect(uiEvent).toBeDefined()
    if (uiEvent?.kind !== 'session-manager-ui') return
    expect(uiEvent.action).toBe('send')
    expect(uiEvent.params).toEqual({ sessionId: 's1', prompt: 'hello' })
    // 不发前端广播：session-manager 请求由 handler 内部消化，extension.ui_request 广播
    // 会被前端 CompanionBand 渲染成无 options 的空壳对话框（2026-08-22 修复回归锁）
    expect(events.some((e) => e.kind === 'message')).toBe(false)
  })

  it.each([
    {
      action: 'send',
      params: { sessionId: 's1', prompt: 'hello' },
      // sd-u5：send 走 delivery.sendChecked——idle 直投受理即回，busy 入队也回 queued
      expected: { queued: true },
    },
    {
      action: 'history',
      params: { sessionId: 's1' },
      expected: {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        truncated: false,
      },
    },
    {
      action: 'status',
      params: { sessionId: 's1' },
      expected: { status: 'active', modelId: 'openai/gpt-4' },
    },
    {
      action: 'list',
      params: {},
      expected: {
        sessions: [
          {
            id: 'agent-1',
            label: 'fake-session',
            cwd: '/test/cwd',
            status: 'active',
            spawnSource: 'agent',
            parentAgentSessionId: 'sid-parent',
          },
        ],
      },
    },
    {
      action: 'abort',
      params: { sessionId: 's1' },
      expected: { success: true },
    },
  ] as const)('$action 全链路：pi stdout 行 → 真实 handler → extension_ui_response 回写 pi stdin', async ({ action, params, expected }) => {
    const sessionService = makeFakeSessionService()
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildUiRequestLine(`req-${action}`, action, params))

    // 1. 回写唯一一条 response，value 是 action 结果 JSON（真实 handler 的 respond 序列化）
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.id).toBe(`req-${action}`)
    expect(resp.cancelled).toBeUndefined()
    expect(JSON.parse(resp.value ?? 'null')).toEqual(expected)

    // 2. 路由正确：走 onSessionManagerRequest（handler 直接回写），不注册前端 UI 超时
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })

  it('history tailTurns 截断：只保留最后一个 user turn 起的消息（真实 handler 逻辑）', async () => {
    const messages = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'reply2' },
    ]
    const pipeline = makeE2ePipeline(makeFakeSessionService({
      getHistory: vi.fn().mockResolvedValue({ messages, truncated: false }),
    }))

    await pipeline.dispatch(buildUiRequestLine('req-history-tail', 'history', { sessionId: 's1', tailTurns: 1 }))

    const resp = readSingleResponse(pipeline.pi)
    expect(JSON.parse(resp.value ?? 'null')).toEqual({
      messages: [
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ],
      truncated: true,
    })
  })
})

describe('U4-E3 malformed e2e probe', () => {
  it('options[0] 非法 JSON → translate 标记 __malformed__ → handler 回 cancelled，不走正常 switch', async () => {
    const sessionService = makeFakeSessionService()
    const pipeline = makeE2ePipeline(sessionService)

    await pipeline.dispatch(buildMalformedUiRequestLine('req-malformed'))

    // 1. 回写 cancelled（真实 handler malformed 兜底：sendExtensionUiResponse(null, 'select')）
    const resp = readSingleResponse(pipeline.pi)
    expect(resp.id).toBe('req-malformed')
    expect(resp.cancelled).toBe(true)
    expect(resp.value).toBeUndefined()

    // 2. 不触发任何 SessionService 调用（malformed 在 switch 之前兜底返回）
    expect(sessionService.sendMessage).not.toHaveBeenCalled()
    expect(sessionService.getHistory).not.toHaveBeenCalled()
    expect(sessionService.getSummary).not.toHaveBeenCalled()
    expect(sessionService.listPersistedSessions).not.toHaveBeenCalled()
    expect(sessionService.abort).not.toHaveBeenCalled()

    // 3. 不弹前端 UI（onSessionManagerRequest 直接消化，不注册前端超时）
    expect(pipeline.onExtensionUIRequest).not.toHaveBeenCalled()
  })

  it('marker 翻译：options[0] 非法 JSON 时 action 仍为 __malformed__（不 fall-through 普通分支）', () => {
    const events = translate(JSON.parse(buildMalformedUiRequestLine('req-m')) as PiEvent, 'sid-parent')
    const uiEvent = events.find((e) => e.kind === 'session-manager-ui')
    expect(uiEvent).toBeDefined()
    if (uiEvent?.kind !== 'session-manager-ui') return
    expect(uiEvent.action).toBe('__malformed__')
    expect(uiEvent.params).toEqual({})
  })
})
