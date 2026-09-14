/**
 * bridge marker 通道（select + BRIDGE_MARKER，协议 v2）— 识别 / 序列化 / 登记测试。
 *
 * 设计 docs/design/bridge-rewrite-pi-0.84.md §3.3-D6（已删除，git 可追溯；U3 验收 + 探针 P-10）：
 * - marker 命中 → bridge-ui kind 产出形状（四 method 各一例）
 * - marker 未命中（普通 select / ASK_USER_MARKER / SESSION_MANAGER_MARKER）→ 不走
 *   bridge 分支（P-10 三态防误伤）
 * - malformed 哨兵三态：payload 非 JSON / 缺 method / method 非法
 * - bridge-handler 回包序列化：6 处存量 + malformed case 的 sendExtensionUiResponse
 *   调用都是 (id, string, 'select') 形态且 JSON.parse 可还原（rpc-client 对 select 走
 *   `String(response)`，传裸对象会变 '[object Object]'——设计 §3.3-D1 陷阱）
 * - bridgeRequestIds 登记：marker 命中后 timeout-manager 有记录（前端误发 ui_response
 *   的拦截依据）
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { translate } from '../src/infra/pi/event-adapter.js'
import { BridgeHandler } from '../src/transport/bridge-handler.js'
import { ExtensionTimeoutManager } from '../src/services/extension-timeout-manager.js'
import {
  BRIDGE_MARKER,
  BRIDGE_METHODS,
  ASK_USER_MARKER,
  SESSION_MANAGER_MARKER,
} from '@xyz-agent/extension-protocol'
import type { PiEvent } from '../src/infra/pi/pi-protocol.js'
import type { PiTranslatedEvent } from '../src/services/session/types.js'
import type { IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IPluginService } from '../src/interfaces.js'

// ── 辅助：构造 pi extension_ui_request select 事件（marker 通道帧形态）──

function makeSelectEvent(title: string | undefined, options: unknown[], id = 'req-1'): PiEvent {
  // PiEvent 联合收窄自 wire JSON——测试 fixture 与 GUI marker 测试（event-adapter-gui.test.ts）
  // 同款局部断言，字段形态对齐 pi rpc-mode select 帧 {method:'select', id, title, options}
  return { type: 'extension_ui_request', method: 'select', id, title, options } as PiEvent
}

/** 运行时类型守卫：从翻译结果中提取 bridge-ui kind 事件 */
function findBridgeUi(events: PiTranslatedEvent[]):
  | { kind: 'bridge-ui'; requestId: string; sessionId: string; method: string; data: Record<string, unknown> }
  | undefined {
  return events.find((e): e is Extract<PiTranslatedEvent, { kind: 'bridge-ui' }> => e.kind === 'bridge-ui')
}

// ── 辅助：bridge-handler 的最小依赖 mock ──

/** BridgeHandler 只消费 client.sendExtensionUiResponse 一个方法（结构窄化 mock） */
function makeMockClient(): { client: IPiEngine; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const client = { sendExtensionUiResponse: send } as unknown as IPiEngine
  return { client, send }
}

/** pluginService 最小 mock：按需提供 bridge 消费的方法（缺省方法模拟 not-available 分支） */
function makePluginService(overrides: Record<string, unknown> = {}): IPluginService {
  return {
    getBridgeSyncPayload: () => ({ tools: [], commands: [], success: true }),
    handleBridgeToolExecute: vi.fn().mockResolvedValue({ content: 'tool ok' }),
    handleBridgeEvent: vi.fn(),
    handleBridgeIntercept: vi.fn().mockResolvedValue({ injectedMessages: [] }),
    ...overrides,
  } as unknown as IPluginService
}

// ── marker 识别（event-adapter）──

describe('event-adapter: bridge marker 识别', () => {
  it.each([...BRIDGE_METHODS])('marker 命中 + method=%s → 产出 bridge-ui kind', (bridgeMethod: string) => {
    // 各 method 的典型载荷（协议 v2 BridgeRequest 形状）
    const payloadByMethod: Record<string, Record<string, unknown>> = {
      'bridge:sync': { method: bridgeMethod },
      'bridge:tool_execute': { method: bridgeMethod, toolName: 'sleep-tool', toolCallId: 'tc-1', params: { ms: 90 }, sessionId: 'sess-src' },
      'bridge:event': { method: bridgeMethod, eventName: 'agent_start', data: { turn: 1 } },
      'bridge:intercept': { method: bridgeMethod, eventName: 'before_agent_start', data: { prompt: 'hi' } },
    }
    const events = translate(makeSelectEvent(BRIDGE_MARKER, [JSON.stringify(payloadByMethod[bridgeMethod])], 'req-m'), 'sess-1')

    const bridgeUi = findBridgeUi(events)
    expect(bridgeUi).toBeDefined()
    expect(bridgeUi!.requestId).toBe('req-m')
    expect(bridgeUi!.sessionId).toBe('sess-1')
    expect(bridgeUi!.method).toBe(bridgeMethod)
    // data = BridgeRequest 除 method 外的字段集（照 bridge-handler 消费形状组装）
    const expectedData: Record<string, unknown> = { ...payloadByMethod[bridgeMethod] }
    delete expectedData.method
    expect(bridgeUi!.data).toEqual(expectedData)
    // 不产 extension-ui kind（不弹前端、不注册弹窗超时——与 session-manager 分支同构）
    expect(events.some(e => e.kind === 'extension-ui')).toBe(false)
    // 不发 extension.ui_request 前端广播
    expect(events.some(e => e.kind === 'message')).toBe(false)
  })

  it.each([...BRIDGE_METHODS])('marker 命中但该 method 载荷缺省字段 → data 只含实际出现的字段（%s）', (bridgeMethod: string) => {
    const events = translate(makeSelectEvent(BRIDGE_MARKER, [JSON.stringify({ method: bridgeMethod })], 'req-m'), 'sess-1')
    const bridgeUi = findBridgeUi(events)
    expect(bridgeUi).toBeDefined()
    expect(bridgeUi!.data).toEqual({})
  })
})

// ── marker 未命中（P-10 防误伤）──

describe('event-adapter: marker 未命中不走 bridge 分支（P-10）', () => {
  it('普通 select → extension-ui kind + 前端广播，不产 bridge-ui', () => {
    const events = translate(makeSelectEvent('Pick one', ['a', 'b'], 'req-p'), 'sess-1')
    expect(findBridgeUi(events)).toBeUndefined()
    expect(events.some(e => e.kind === 'extension-ui')).toBe(true)
    expect(events.some(e => e.kind === 'message')).toBe(true)
  })

  it('ASK_USER_MARKER → ask-user 富交互（extension-ui kind），不产 bridge-ui', () => {
    const payload = JSON.stringify({ questions: [{ question: 'q', options: ['a'] }], allowCancel: true })
    const events = translate(makeSelectEvent(ASK_USER_MARKER, [payload], 'req-a'), 'sess-1')
    expect(findBridgeUi(events)).toBeUndefined()
    const extUi = events.find(e => e.kind === 'extension-ui')
    expect(extUi).toBeDefined()
    // ask-user 载荷带 questions 透传（前端路由 AskUserOverlay）
    const payloadFields = extUi && 'payload' in extUi ? extUi.payload as Record<string, unknown> : {}
    expect(Array.isArray(payloadFields.askUserQuestions)).toBe(true)
    expect(payloadFields.askUser).toBe(true)
  })

  it('SESSION_MANAGER_MARKER → session-manager-ui kind，不产 bridge-ui', () => {
    const payload = JSON.stringify({ action: 'list', params: {} })
    const events = translate(makeSelectEvent(SESSION_MANAGER_MARKER, [payload], 'req-s'), 'sess-1')
    expect(findBridgeUi(events)).toBeUndefined()
    const smUi = events.find(e => e.kind === 'session-manager-ui')
    expect(smUi).toBeDefined()
  })
})

// ── malformed 哨兵三态 ──

describe('event-adapter: malformed 哨兵三态', () => {
  it('payload 非 JSON → bridge:malformed 哨兵，data.raw 回退原始 options 字符串', () => {
    const events = translate(makeSelectEvent(BRIDGE_MARKER, ['{not json'], 'req-bad'), 'sess-1')
    const bridgeUi = findBridgeUi(events)
    expect(bridgeUi).toBeDefined()
    expect(bridgeUi!.method).toBe('bridge:malformed')
    expect(bridgeUi!.data.raw).toBe('{not json')
  })

  it('payload 合法 JSON 但缺 method → bridge:malformed，data.raw 带解析后对象', () => {
    const events = translate(makeSelectEvent(BRIDGE_MARKER, [JSON.stringify({ toolName: 'x' })], 'req-bad'), 'sess-1')
    const bridgeUi = findBridgeUi(events)
    expect(bridgeUi!.method).toBe('bridge:malformed')
    expect(bridgeUi!.data.raw).toEqual({ toolName: 'x' })
  })

  it('payload method 不在 BRIDGE_METHODS 集合 → bridge:malformed，data.raw 带解析后对象', () => {
    const events = translate(makeSelectEvent(BRIDGE_MARKER, [JSON.stringify({ method: 'bridge:evil' })], 'req-bad'), 'sess-1')
    const bridgeUi = findBridgeUi(events)
    expect(bridgeUi!.method).toBe('bridge:malformed')
    expect(bridgeUi!.data.raw).toEqual({ method: 'bridge:evil' })
  })
})

// ── bridge-handler 回包序列化（6 处存量 + malformed case）──

describe('bridge-handler: sendExtensionUiResponse 序列化形状', () => {
  // 序列化契约断言：第二参必须是 JSON 字符串、第三参 'select'、JSON.parse 可还原
  function expectSelectJsonSerialization(
    send: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
  ): void {
    expect(send).toHaveBeenCalledTimes(1)
    const [id, response, method] = send.mock.calls[0] as [string, unknown, string | undefined]
    expect(typeof id).toBe('string')
    expect(method).toBe('select')
    expect(typeof response).toBe('string')
    expect(JSON.parse(response as string)).toEqual(expected)
  }

  it('bridge:sync（设计 §3.3-D6 枚举的 6 处存量之一）→ payload JSON 字符串 + select', async () => {
    const syncPayload = { tools: [{ name: 'sleep-tool', description: 'd', parameters: {} }], commands: [], success: true }
    const { client, send } = makeMockClient()
    const handler = new BridgeHandler(makePluginService({ getBridgeSyncPayload: () => syncPayload }))
    await handler.handleBridgeRequest('sess-1', 'req-1', 'bridge:sync', {}, client)
    expectSelectJsonSerialization(send, syncPayload)
  })

  it('bridge:tool_execute 无 pluginService（§3.3-D6 not-available 防御分支）→ JSON 字符串 + select', async () => {
    const { client, send } = makeMockClient()
    const handler = new BridgeHandler(null)
    await handler.handleBridgeRequest('sess-1', 'req-2', 'bridge:tool_execute', { toolName: 't' }, client)
    expectSelectJsonSerialization(send, { content: 'Plugin system not available', isError: true })
  })

  it('bridge:tool_execute 正常结果（设计 §3.3-D6 枚举的 6 处存量之一）→ result JSON 字符串 + select', async () => {
    const toolResult = { content: 'slept 90s', isError: false }
    const { client, send } = makeMockClient()
    const handler = new BridgeHandler(makePluginService({
      handleBridgeToolExecute: vi.fn().mockResolvedValue(toolResult),
    }))
    await handler.handleBridgeRequest('sess-1', 'req-3', 'bridge:tool_execute', { toolName: 'sleep-tool', params: { ms: 90 }, toolCallId: 'tc-1' }, client)
    expectSelectJsonSerialization(send, toolResult)
  })

  it('bridge:event（§3.3-D6 序列化例外：恒 null 回包）→ cancelled 帧（bridge 侧 void 丢弃）', async () => {
    const { client, send } = makeMockClient()
    const handler = new BridgeHandler(makePluginService())
    await handler.handleBridgeRequest('sess-1', 'req-4', 'bridge:event', { eventName: 'agent_start', data: {} }, client)
    expect(send).toHaveBeenCalledTimes(1)
    const [, response] = send.mock.calls[0] as [string, unknown, string | undefined]
    expect(response).toBeNull()
  })

  it('bridge:intercept（设计 §3.3-D6 枚举的 6 处存量之一）→ result JSON 字符串 + select', async () => {
    const interceptResult = { injectedMessages: [{ role: 'user', content: 'injected' }] }
    const { client, send } = makeMockClient()
    const handler = new BridgeHandler(makePluginService({
      handleBridgeIntercept: vi.fn().mockResolvedValue(interceptResult),
    }))
    await handler.handleBridgeRequest('sess-1', 'req-5', 'bridge:intercept', { eventName: 'before_agent_start', data: {} }, client)
    expectSelectJsonSerialization(send, interceptResult)
  })

  it('bridge:malformed（第 7 处新回包点）→ E5 错误 JSON + select，warn 留痕', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client, send } = makeMockClient()
      const handler = new BridgeHandler(null)
      await handler.handleBridgeRequest('sess-1', 'req-6', 'bridge:malformed', { raw: '{not json' }, client)
      expectSelectJsonSerialization(send, {
        error: 'malformed bridge request',
        hint: 'bridge extension and runtime protocol mismatch — redeploy same-version runtime+bridge',
      })
      // raw payload 进日志留痕（E5 排查依据）
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed bridge request'), '{not json')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('default 未知 method（设计 §3.3-D6 枚举的 6 处存量之一）→ 错误 JSON 字符串 + select', async () => {
    const { client, send } = makeMockClient()
    const handler = new BridgeHandler(null)
    await handler.handleBridgeRequest('sess-1', 'req-7', 'bridge:unknown', {}, client)
    expectSelectJsonSerialization(send, { error: 'Unknown bridge method: bridge:unknown' })
  })

  it('catch 路径（设计 §3.3-D6 枚举的 6 处存量之一）→ {error} JSON 字符串 + select', async () => {
    const { client, send } = makeMockClient()
    const handler = new BridgeHandler(makePluginService({
      handleBridgeToolExecute: vi.fn().mockRejectedValue(new Error('boom')),
    }))
    await handler.handleBridgeRequest('sess-1', 'req-8', 'bridge:tool_execute', { toolName: 't' }, client)
    expect(send).toHaveBeenCalledTimes(1)
    const [, response, method] = send.mock.calls[0] as [string, unknown, string | undefined]
    expect(method).toBe('select')
    expect(typeof response).toBe('string')
    expect((JSON.parse(response as string) as { error: string }).error).toContain('boom')
  })
})

// ── bridgeRequestIds 登记 ──

describe('bridgeRequestIds 登记（marker 命中 → timeout-manager 有记录）', () => {
  it('handleBridgeRequest 到达即登记（含 malformed），B6 应答即删，clearForSession 兑底仍有效', async () => {
    const mgr = new ExtensionTimeoutManager()
    const addSpy = vi.spyOn(mgr, 'addBridgeRequest')
    const handler = new BridgeHandler(null, mgr)
    const { client } = makeMockClient()

    // sync：await 完成点已摘除（B6 应答即删），「到达即登记」事实经 spy 锁定
    await handler.handleBridgeRequest('sess-1', 'req-reg-1', 'bridge:sync', {}, client)
    expect(addSpy).toHaveBeenCalledWith('sess-1', 'req-reg-1')
    expect(mgr.isBridgeRequest('req-reg-1')).toBe(false)

    // malformed 哨兵请求同样登记过（前端不得抢答 runtime 内部应答的请求）+ 应答后摘除
    await handler.handleBridgeRequest('sess-1', 'req-reg-2', 'bridge:malformed', { raw: 'x' }, client)
    expect(addSpy).toHaveBeenCalledWith('sess-1', 'req-reg-2')
    expect(mgr.isBridgeRequest('req-reg-2')).toBe(false)

    // bridge:event 例外不登记：fire-and-forget 恒 null 回包无抢答窗口，且事件频率
    // = pi agent 事件频率，登记只会在 session 销毁时清理（长会话单调累积）
    const addCountBeforeEvent = addSpy.mock.calls.length
    await handler.handleBridgeRequest('sess-1', 'req-reg-ev', 'bridge:event', { eventName: 'agent_start', data: {} }, client)
    expect(addSpy.mock.calls.length).toBe(addCountBeforeEvent)
    expect(mgr.isBridgeRequest('req-reg-ev')).toBe(false)

    // 在途可见性（登记的语义窗口）：tool_execute await 窗口内可查——前端误发抢答
    // 防御依赖的就是这个窗口；应答后摘除
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const ps = makePluginService({ handleBridgeToolExecute: vi.fn(() => gate.then(() => ({ content: 'ok' }))) })
    const handler2 = new BridgeHandler(ps, mgr)
    const pending = handler2.handleBridgeRequest('sess-1', 'req-inflight', 'bridge:tool_execute', { toolName: 't' }, makeMockClient().client)
    expect(mgr.isBridgeRequest('req-inflight')).toBe(true)
    release()
    await pending
    expect(mgr.isBridgeRequest('req-inflight')).toBe(false)

    // session 级跟踪：clearForSession（session 销毁兑底路径）仍清理 bridgeRequestIds
    mgr.addBridgeRequest('sess-1', 'req-manual')
    mgr.clearForSession('sess-1')
    expect(mgr.isBridgeRequest('req-manual')).toBe(false)
  })

  it('端到端链路：marker 帧翻译 → bridge-ui kind → handler → timeout-manager 有记录', async () => {
    // 模拟生产链路（interpreter 'bridge-ui' case → onBridgeUIRequest → server.handleBridgeRequest
    // → bridge-handler），仅省略 server 中转（纯转发层）
    const events = translate(
      makeSelectEvent(BRIDGE_MARKER, [JSON.stringify({ method: 'bridge:tool_execute', toolName: 'sleep-tool', toolCallId: 'tc-1', params: { ms: 90 } })], 'req-e2e'),
      'sess-e2e',
    )
    const bridgeUi = findBridgeUi(events)
    expect(bridgeUi).toBeDefined()

    const mgr = new ExtensionTimeoutManager()
    const addSpy = vi.spyOn(mgr, 'addBridgeRequest')
    const handler = new BridgeHandler(makePluginService(), mgr)
    const { client } = makeMockClient()
    await handler.handleBridgeRequest(bridgeUi!.sessionId, bridgeUi!.requestId, bridgeUi!.method, bridgeUi!.data, client)

    // 到达即登记（链路完整性）+ B6 应答即删（完成后不残留）
    expect(addSpy).toHaveBeenCalledWith(bridgeUi!.sessionId, 'req-e2e')
    expect(mgr.isBridgeRequest('req-e2e')).toBe(false)
  })

  it('未注入 timeoutManager 时回包照常（登记可选，不阻塞主链路）', async () => {
    const { client, send } = makeMockClient()
    const handler = new BridgeHandler(null)
    await handler.handleBridgeRequest('sess-1', 'req-no-mgr', 'bridge:sync', {}, client)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

// ── addBridgeRequest：marker 通道唯一的 bridge 登记路径 ──

describe('ExtensionTimeoutManager.addBridgeRequest', () => {
  it('登记 bridgeRequestIds + session 跟踪，clearForSession 清理（marker 通道唯一登记路径）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.addBridgeRequest('sess-1', 'req-a')
    mgr.addBridgeRequest('sess-2', 'req-b')

    expect(mgr.isBridgeRequest('req-a')).toBe(true)
    expect(mgr.isBridgeRequest('req-b')).toBe(true)

    // session 级跟踪：按各自 session 清理互不影响
    mgr.clearForSession('sess-1')
    expect(mgr.isBridgeRequest('req-a')).toBe(false)
    expect(mgr.isBridgeRequest('req-b')).toBe(true)
  })

  it('registerTimeout 不再登记 bridge 请求（旧 bridge: 前缀分支已删，防回归）', () => {
    const mgr = new ExtensionTimeoutManager()
    // 旧通道入参形态（防御性锁定）：registerTimeout 只服务 extension-ui kind，
    // bridge 登记责任单落在 BridgeHandler 入口的 addBridgeRequest——误传 bridge:
    // method 不得再进 bridgeRequestIds（否则前端误发拦截依据出现第二来源）
    mgr.registerTimeout('sess-x', 'req-old-style', 'bridge:sync', () => {})
    expect(mgr.isBridgeRequest('req-old-style')).toBe(false)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
