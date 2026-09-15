/**
 * W3 TDD tests：SessionService 副作用迁移（U7 + E2）。
 *
 * 背景：attachUsageListener（第二条 pi 事件订阅）承载副作用，W3 迁移到中间事件链路：
 *   1. isGenerating 复位（agent_end）—— handleTurnEndSideEffects
 *   2. tokenCount 写入（turn_end + agent_end）—— applyContextUpdate 接收 totalTokens
 *   3. project sidecar 兜底 —— handleTurnUsageSideEffects / handleTurnEndSideEffects
 *
 * W1（数据源治理）改写：label 持久化不再经 turn_end/agent_end 兜底直写（机制已删），
 * 活跃 label 唯一写入口 = renameSession / create / forkSession 的 set_session_name RPC。
 * 本文件保留「turn/agent 结束不再直写 session_info」回归守卫。
 *
 * U7：副作用经中间事件链路保留（不走 attachUsageListener）
 *   - onTurnFinalize→handleTurnEndSideEffects：isGenerating=false
 *   - onContextUpdate 含 totalTokens→applyContextUpdate：tokenCount 写入
 * E2：完整 pi 事件流集成（message_start→...→turn_end→agent_end），断言终态
 *   isGenerating===false + tokenCount>0 + inputTokens>0
 *
 * Mock 边界与 session-service.test.ts 一致（pm/broker/extensionService 注入 mock，existsSync 真实）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type {
  IMessageBroker,
  IEventAdapter,
  IExtensionService,
} from '../src/interfaces.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IProcessManager, IPiEngine, PiEventListener } from '../src/services/ports/pi-engine.js'
import type { MockInstance } from 'vitest'

// ── vi.hoisted：在 vi.mock 工厂执行前就绪的 mock 句柄 ───────────────
const mocks = vi.hoisted(() => ({
  mockScannedSessions: [] as Array<{
    id: string; filePath: string; cwd: string; name: string | null
    lastModified: number; timestamp: string; size: number
  }>,
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
}))

vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    scanPiSessions: () => mocks.mockScannedSessions,
  }
})
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: vi.fn(),
    getDefaultModel: () => mocks.defaultModel.value,
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/mock/taiji/agent' }
})
vi.mock('../src/infra/system/trash.js', () => ({ trash: vi.fn() }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: vi.fn((raw: unknown) => raw) }))
vi.mock('../src/services/session-history.js', () => ({ getHistoryFromFile: vi.fn().mockResolvedValue([]) }))

// ── Mock 之后再 import 被测对象 ─────────────────────────────────────
import { SessionService } from '../src/services/session/session-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

type SendCommandFn = (type: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>

interface MockClient {
  prompt: MockInstance<(content: string) => Promise<unknown>>
  abort: MockInstance<() => Promise<unknown>>
  steer: MockInstance<(content: string) => Promise<unknown>>
  followUp: MockInstance<(content: string) => Promise<unknown>>
  setModel: MockInstance<(provider: string, modelId: string) => Promise<unknown>>
  setThinkingLevel: MockInstance<(level: string) => Promise<unknown>>
  /** set_session_name RPC mock（W1：create 显式 label / 活跃 rename 经此持久化）。 */
  setSessionName: MockInstance<(name: string) => Promise<unknown>>
  compact: MockInstance<() => Promise<unknown>>
  clear: MockInstance<() => Promise<unknown>>
  getHistory: MockInstance<() => Promise<unknown>>
  sendCommand: MockInstance<SendCommandFn>
  /** 切换 pi session 文件（W2 收口：替代 sendCommand('switch_session')）。 */
  switchSession: MockInstance<(sessionPath: string) => Promise<void>>
  /** 查询 pi get_state（W2 收口：替代 readPiState/sendCommand('get_state')）。 */
  getState: MockInstance<() => Promise<Record<string, unknown> | undefined>>
  getCommands: MockInstance<() => Promise<unknown>>
  getSessionStats: MockInstance<() => Promise<unknown>>
  onEvent: MockInstance<(listener: PiEventListener) => () => void>
  onExit: MockInstance<(callback: (code: number | null) => void) => void>
  kill: MockInstance<() => Promise<void>>
  start: MockInstance<() => Promise<void>>
  /** touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）。 */
  touchActivity: MockInstance<() => void>
  eventListeners: PiEventListener[]
}

function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  const eventListeners: PiEventListener[] = []
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    setSessionName: vi.fn<(name: string) => Promise<unknown>>().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ data: { messages: [] } }),
    sendCommand: vi.fn<SendCommandFn>().mockResolvedValue({ data: {} }),
    switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockResolvedValue(undefined),
    getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({}),
    getCommands: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue({}),
    onEvent: vi.fn<(listener: PiEventListener) => () => void>((listener) => {
      eventListeners.push(listener)
      return () => {}
    }),
    onExit: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
    // 到达 fake client——fake 须补齐该接口成员
    touchActivity: vi.fn(),
    eventListeners,
    ...overrides,
  }
}

let autoId = 0

function createSetup() {
  const clientMap = new Map<string, MockClient>()
  let exitCb: ((sessionId: string, code: number | null, stderr: string) => void) | null = null

  const pm: IProcessManager = {
    createSession: vi.fn(async () => {
      const piSid = `pi-auto-${++autoId}`
      const client = makeMockClient({
        // W2 收口后 create 用 client.getState()（返回归一后的 state 对象）
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
          sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl`,
        }),
      })
      clientMap.set(piSid, client)
      return client
    }),
    destroySession: vi.fn(async (id: string) => { clientMap.delete(id) }),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn((client: MockClient) => {
      for (const [k, v] of clientMap) if (v === client) return k
      return undefined
    }),
    hasClient: vi.fn((id: string) => clientMap.has(id)),
    rekey: vi.fn(),
    onSessionExit: vi.fn((cb) => { exitCb = cb }),
    destroyAll: vi.fn(async () => { clientMap.clear() }),
  } as unknown as IProcessManager

  const broker: IMessageBroker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker

  const extensionService: IExtensionService = {
    getExtensionPaths: vi.fn().mockResolvedValue([]),
  } as unknown as IExtensionService

  const adapterFactory = (_sid: string, _send: unknown): IEventAdapter => ({
    attach: vi.fn(),
    detach: vi.fn(),
  })

  const gitInfoReader: IGitInfoReader = {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  }

  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) }

  const service = new SessionService(
    pm, broker, adapterFactory, '/tmp', extensionService,
    new PiConfigStore(), new PiSessionStore(), gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
  )

  const seedSession = async (opts: { label?: string; sessionFile?: string } = {}) => {
    const piSid = `pi-seed-${++autoId}`
    const client = makeMockClient({
      // W2 收口后 create 用 client.getState()（返回归一后的 state 对象）
      getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
        sessionId: piSid, sessionFile: opts.sessionFile ?? `/fake/${piSid}.jsonl`,
      }),
    })
    vi.mocked(pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    clientMap.set(piSid, client)
    await service.create(tmpdir(), opts.label ?? 'seed')
    return { id: piSid, client }
  }

  return {
    service, pm, broker, clientMap,
    seedSession,
    triggerExit: (sid: string, code: number | null, stderr = '') => exitCb?.(sid, code, stderr),
  }
}

interface Setup {
  service: SessionService
  pm: IProcessManager
  broker: IMessageBroker
  clientMap: Map<string, MockClient>
  seedSession: (opts?: { label?: string; sessionFile?: string }) => Promise<{ id: string; client: MockClient }>
  triggerExit: (sid: string, code: number | null, stderr?: string) => void
}

function resetMockState(): void {
  mocks.mockScannedSessions.length = 0
  mocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
}

describe('SessionService · W3 副作用迁移（U7）', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  // ── handleTurnUsageSideEffects（turn_end：label 兜底直写已随 W1 机制删除）──
  describe('handleTurnUsageSideEffects（turn_end → label 不再直写）', () => {
    it('session 文件已存在时也不直写 session_info（W1：label 持久化唯一路径 = set_session_name RPC）', async () => {
      // 用真实临时文件让 existsSync 返回 true——即便文件存在也不再写（回归守卫：
      // 直写与 pi rename-session 扩展构成 last-write-wins，会覆盖用户手动命名）
      const dir = mkdtempSync(join(tmpdir(), 'w3-tu-'))
      try {
        const filePath = join(dir, 's.jsonl')
        writeFileSync(filePath, '{}')
        const { id } = await setup.seedSession({ label: 'my-label', sessionFile: filePath })
        const before = readFileSync(filePath, 'utf-8')

        setup.service.handleTurnUsageSideEffects(id)

        // W11 后 taiji 已无任何直写 session JSONL 的代码路径（R1 无条件检查），文件字节不变
        expect(readFileSync(filePath, 'utf-8')).toBe(before)
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('未知 session 不抛错（静默 no-op）', () => {
      expect(() => setup.service.handleTurnUsageSideEffects('ghost')).not.toThrow()
    })
  })

  // ── handleTurnEndSideEffects（agent_end：isGenerating 复位；label 兜底直写已删）──
  describe('handleTurnEndSideEffects（agent_end → isGenerating 复位；label 不再直写）', () => {
    it('复位 isGenerating=false（不迁移则 session 永远 busy，下条消息被拒）', async () => {
      const { id } = await setup.seedSession()
      // 先标记为生成中（模拟 sendPrompt 后的状态）
      await setup.service.sendMessage(id, 'hi')
      expect(setup.service.getSummary(id)?.status).toBe('active')

      setup.service.handleTurnEndSideEffects(id)

      // isGenerating 复位
      expect(setup.service.getSummary(id)?.status).toBe('idle')
    })

    it('agent_end 也不直写 session_info（W1：兜底直写机制已整体删除）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'w3-te-'))
      try {
        const filePath = join(dir, 's.jsonl')
        writeFileSync(filePath, '{}')
        const { id } = await setup.seedSession({ label: 'fallback-label', sessionFile: filePath })
        const before = readFileSync(filePath, 'utf-8')

        setup.service.handleTurnEndSideEffects(id)

        expect(readFileSync(filePath, 'utf-8')).toBe(before)
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('未知 session 不抛错', () => {
      expect(() => setup.service.handleTurnEndSideEffects('ghost')).not.toThrow()
    })
  })

  // ── applyContextUpdate 接收 totalTokens（W10：tokenCount 改由 usage 实例快照派生）──
  describe('applyContextUpdate 接收 totalTokens（W10：tokenCount 派生自 usage 快照）', () => {
    it('tokenCount 不再被事件直写，派生自 usage 实例快照（事件链路 totalTokens 与 inputTokens 同值）', async () => {
      const { id, client } = await setup.seedSession()
      // 初始 tokenCount=0（快照未播种）
      expect(setup.service.getSummary(id)?.tokenCount).toBe(0)

      // 事件到达：只失效，不直写 tokenCount
      setup.service.applyContextUpdate(id, 25000, 30000)
      expect(setup.service.getSummary(id)?.tokenCount).toBe(0)

      // 快照播种（fetch get_session_stats 唯一数据写路径）后派生
      client.getSessionStats.mockResolvedValue({
        contextUsage: { tokens: 25000, contextWindow: 100000, percent: 25 },
      })
      setup.service.getScalarReplicatedStates(id)?.usage.refetch()
      await new Promise<void>(r => setTimeout(r, 0))
      expect(setup.service.getSummary(id)?.tokenCount).toBe(25000)
    })

    it('inputTokens=0 时 applyContextUpdate 早退（不广播），快照派生值保持', async () => {
      const { id, client } = await setup.seedSession()
      client.getSessionStats.mockResolvedValue({
        contextUsage: { tokens: 18000, contextWindow: 100000, percent: 18 },
      })
      setup.service.getScalarReplicatedStates(id)?.usage.refetch()
      await new Promise<void>(r => setTimeout(r, 0))
      setup.service.applyContextUpdate(id, 0, 0)
      // inputTokens=0 守卫早退；tokenCount/inputTokens 保持快照派生值
      expect(setup.service.getSummary(id)?.tokenCount).toBe(18000)
      expect(setup.service.getInputTokens(id)).toBe(18000)
    })
  })
})

// ════════════════════════════════════════════════════════════════════
// E2：完整 pi 事件流集成（mock RpcClient 发完整事件序列，
//     经 EventAdapter→Interpreter→SessionService 全链路，断言终态）
// ════════════════════════════════════════════════════════════════════
describe('SessionService · W3 E2：完整 pi 事件流集成', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  it('全链路：message_start→text_delta→tool_execution_*→turn_end→agent_end → 终态 isGenerating=false + tokenCount>0 + inputTokens>0', async () => {
    // 用真实的 createAdapter 组合根装配（不走 mock adapterFactory）
    // 重新构造 service，注入真实 EventAdapter + EventInterpreter + 回调连线
    const { EventAdapter } = await import('../src/infra/pi/event-adapter.js')
    const { EventInterpreter } = await import('../src/services/session/event-interpreter.js')

    const clientMap = new Map<string, MockClient>()
    let exitCb: ((sessionId: string, code: number | null, stderr: string) => void) | null = null
    const pm: IProcessManager = {
      createSession: vi.fn(async () => {
        const piSid = `pi-e2-${++autoId}`
        const client = makeMockClient({
          // W2 收口后 create 用 client.getState()
          getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
            sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl`,
          }),
        })
        clientMap.set(piSid, client)
        return client
      }),
      destroySession: vi.fn(async (id: string) => { clientMap.delete(id) }),
      getClient: vi.fn((id: string) => clientMap.get(id)),
      getSessionIdByClient: vi.fn((client: MockClient) => {
        for (const [k, v] of clientMap) if (v === client) return k
        return undefined
      }),
      hasClient: vi.fn((id: string) => clientMap.has(id)),
      rekey: vi.fn(),
      onSessionExit: vi.fn((cb) => { exitCb = cb }),
      destroyAll: vi.fn(async () => { clientMap.clear() }),
    } as unknown as IProcessManager
    const broker: IMessageBroker = {
      send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn(),
    } as unknown as IMessageBroker

    // 前向引用：createAdapter 闭包需引用 service（在构造后才赋值），
    // 用 holder 变量使闭包读到构造后的实例（组合根同样靠闭包捕获，sessionService 在 adapterFactory 之后赋值）。
    const holder: { service: SessionService } = { service: null as unknown as SessionService }
    const createAdapter = (sessionId: string, send: (msg: import('@taiji/shared').ServerMessage) => void) => {
      const interpreter = new EventInterpreter(sessionId, {
        send,
        onContextUpdate: (sid, ctxData) => {
          holder.service.applyContextUpdate(sid, ctxData.inputTokens, ctxData.totalTokens)
        },
        onTurnUsage: (sid) => holder.service.handleTurnUsageSideEffects(sid),
        onTurnFinalize: (sid) => holder.service.handleTurnEndSideEffects(sid),
      })
      return new EventAdapter(sessionId, (events) => interpreter.interpret(events))
    }
    // 用真实 createAdapter 组合根装配（EventAdapter → Interpreter → SessionService 全链路）
    // wave:perf-w09（D1-2）：session 级消息单通道走 bus（构造参数注入喂 dispatcher + send 回调）
    const bus = { publish: vi.fn() } as unknown as IMessageBus
    const service2 = new SessionService(
      pm, broker, createAdapter, '/tmp',
      { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
      new PiConfigStore(), new PiSessionStore(),
      { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() } as unknown as IGitInfoReader,
      { record: vi.fn(), list: vi.fn().mockReturnValue([]) } as unknown as ConstructorParameters<typeof SessionService>[8],
      bus,
    )
    service2.setMessageBus(bus)
    holder.service = service2

    const piSid = `pi-e2-final-${++autoId}`
    const eventListeners: PiEventListener[] = []
    const client = makeMockClient({
      // W2 收口后 create 用 client.getState()
      getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
        sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl`,
      }),
      // W10：get_session_stats 是 usage 唯一数据源——E2 断言的 inputTokens/tokenCount
      // 派生自 usage 实例快照（agent_end 事件 usage 与此快照口径同源，tokens 一致）。
      getSessionStats: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        contextUsage: { tokens: 163500, contextWindow: 200000, percent: 81.75 },
      }),
      onEvent: vi.fn<(listener: PiEventListener) => () => void>((listener) => {
        eventListeners.push(listener)
        return () => {}
      }),
    })
    vi.mocked(pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    clientMap.set(piSid, client)

    const summary = await service2.create(tmpdir(), 'e2-label')
    expect(summary.id).toBe(piSid)

    // 标记生成中（模拟 sendPrompt）
    await service2.sendMessage(piSid, 'do something')
    expect(service2.getSummary(piSid)?.status).toBe('active')

    // 派发完整 pi 事件序列到 EventAdapter 注册的 listener
    const dispatch = (ev: Record<string, unknown>) => {
      eventListeners.forEach((fn) => fn(ev))
    }
    dispatch({ type: 'message_start', message: undefined }) // assistant turn 开始
    dispatch({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
    dispatch({
      type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'ls' },
    })
    dispatch({
      type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash',
      result: { content: [{ type: 'text', text: 'file.txt' }] },
    })
    // turn_end：单 turn 用量（onTurnUsage + onContextUpdate）
    dispatch({
      type: 'turn_end',
      message: { role: 'assistant', usage: { input: 163418, output: 82, totalTokens: 163500 } },
    })
    // agent_end：整循环结束（onTurnFinalize + onContextUpdate）
    dispatch({
      type: 'agent_end',
      messages: [{
        stopReason: 'stop',
        usage: { input: 163418, output: 82, totalTokens: 163500 },
      }],
    })
    // flush 异步 hook（tool-call-* 是 void this.handle...）
    await new Promise<void>(r => setTimeout(r, 10))

    // W10：事件只失效——usage 实例 markDirty 后防抖（真 timers 300ms）未到点，显式 refetch
    // 让快照收敛权威值（模拟防抖到点的拉取），再断言派生读点。
    service2.getScalarReplicatedStates(piSid)?.usage.refetch()
    await new Promise<void>(r => setTimeout(r, 10))

    // ── 断言终态（3 个副作用全迁移后应满足）──
    const finalSummary = service2.getSummary(piSid)
    expect(finalSummary).toBeDefined()
    // 1. isGenerating 复位（agent_end onTurnFinalize → handleTurnEndSideEffects）
    expect(finalSummary!.status).toBe('idle')
    // 2. tokenCount 派生（>0，usage 实例快照 inputTokens 投影，W10 事件直写已删）
    expect(finalSummary!.tokenCount).toBeGreaterThan(0)
    // 3. inputTokens 派生（>0，usage 实例快照读点）
    expect(service2.getInputTokens(piSid)).toBeGreaterThan(0)

    // 附带验证：message.complete 已发布（EventAdapter handleAgentEnd → interpreter 转发；
    // wave:perf-w09 后 session 级消息走 bus.publish，不再经 broker.broadcast）
    const published = vi.mocked(bus.publish).mock.calls.map(c => c[1].type)
    expect(published).toContain('message.complete')
  })
})
