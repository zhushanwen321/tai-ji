/**
 * SessionService 行为测试（架构重构 Phase 3 第一步 · TDD 护栏）。
 *
 * 目的：在拆分 session-service.ts（722 行巨石）为 3 协作模块之前，
 * 用测试钉住全部 21 个 public 方法 + onSessionExit 回调的现有行为。
 * 拆分后此测试保持绿即证明行为不变。
 *
 * Mock 边界（不 spawn 真 pi、不碰真文件系统）：
 * - pi-config-bridge / trash / message-converter / session-history 全部 vi.mock。
 * - IGitInfoReader 经构造注入（不再 vi.mock 模块），createSetup 提供桩实现。
 * - 构造函数依赖（pm / broker / extensionService）注入 mock 对象。
 * - pm 通过共享 clientMap 让 getClient/hasClient/rekey/getSessionIdByClient 行为自洽。
 * - existsSync 用真实 node:fs，测试数据用真实存在的 cwd（tmpdir）。
 *
 * 覆盖分类（对应 plan 归属表）：
 * - dispatcher：sendMessage / abort / steerMessage / followUpMessage / compact
 *   （[HISTORICAL] sendSubagentMessage 已随 marker 通道废弃删除，composer 四符号设计 D2）
 * - lifecycle：create / delete / renameSession / restoreSession
 * - Facade：switchModel / setThinkingLevel / getHistory / hasActiveSession / getRpcClient /
 *           ensureActive / listPersistedSessions / getSummary / destroyAll / setSendMessageHook
 * - onSessionExit：构造函数注册的进程退出回调
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { tmpdir, homedir } from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { IGitInfoReader } from '../src/services/ports/git-info.js'

import type {
  IMessageBroker,
  IEventAdapter,
  IExtensionService,
} from '../src/interfaces.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IProcessManager, IPiEngine, PiEventListener } from '../src/services/ports/pi-engine.js'
import type { SessionSummary, SessionGroup, Message, ServerMessage, ProviderId, SegmentsMetadataEntry, SegmentsMetadataFile } from '@xyz-agent/shared'
import { HISTORY_BUDGET } from '@xyz-agent/shared'
import { getAttachmentsDir } from '@xyz-agent/shared/paths'

// ── vi.hoisted：在 vi.mock 工厂执行前就绪的 mock 句柄 ───────────────

const mocks = vi.hoisted(() => ({
  mockScannedSessions: [] as Array<{
    id: string
    filePath: string
    cwd: string
    name: string | null
    lastModified: number
    timestamp: string
    size: number
    outcome: 'done' | 'error' | 'stopped' | null
  }>,
  // 可重新赋值：null 表示未配置 model
  defaultModel: {
    value: { provider: 'test-provider', modelId: 'test-model' } as
      { provider: string; modelId: string } | null,
  },
  refreshAllMock: vi.fn(),
  trashMock: vi.fn(),
  convertPiHistoryMock: vi.fn((raw: unknown) => raw),
  // entry-tree-builder.rebuildHistoryFromEntries mock：默认 identity-ish（返 entries 当 messages），
  // 单测按需 mockReturnValueOnce 控制重建结果。与 convertPiHistoryMock 同范式（隔离重建逻辑）。
  // orphanToolResults 可选：仅增量路径消费（getHistory 缓存命中分支直接访问），增量用例显式提供。
  rebuildHistoryFromEntriesMock: vi.fn((entries: unknown[]): { messages: unknown[]; clientUuidMap: Map<string, string>; orphanToolResults?: unknown[] } => ({ messages: entries as unknown[], clientUuidMap: new Map<string, string>() })),
  getHistoryFromFileMock: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePathMock: vi.fn().mockResolvedValue([]),
  getHistoryTailFromFileMock: vi.fn().mockResolvedValue({ messages: [], truncated: false }),
}))

const { mockScannedSessions } = mocks

// pi-config-bridge 已拆分：session 函数迁入 session-file-utils，model/settings 函数
// 归 pi-provider-store，配置目录归 pi-paths。按 session-store/pi-config-store 的实际
// import 来源分别 mock 各符号（其余实现保留原模块，importOriginal）。
vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return {
    ...actual,
    scanPiSessions: () => mockScannedSessions,
  }
})
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: mocks.refreshAllMock,
    getDefaultModel: () => mocks.defaultModel.value,
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getPiAgentDir: () => '/mock/xyz-agent/agent',
  }
})

vi.mock('../src/infra/system/trash.js', () => ({ trash: mocks.trashMock }))
vi.mock('../src/infra/pi/message-converter.js', () => ({ convertPiHistory: mocks.convertPiHistoryMock }))
vi.mock('../src/infra/pi/entry-tree-builder.js', () => ({ rebuildHistoryFromEntries: mocks.rebuildHistoryFromEntriesMock }))
vi.mock('../src/services/session-history.js', () => ({
  getHistoryFromFile: mocks.getHistoryFromFileMock,
  getHistoryFromFilePath: mocks.getHistoryFromFilePathMock,
  getHistoryTailFromFile: mocks.getHistoryTailFromFileMock,
}))

// ── Mock 之后再 import 被测对象 ─────────────────────────────────────

import { SessionService } from '../src/services/session/session-service.js'
import { encodeDirectiveText } from '../src/services/session/session-records.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'

// ── Mock client / 依赖工厂 ─────────────────────────────────────────

// sendCommand 的完整签名（与 IPiEngine.sendCommand 对齐），复用于多处 mock。
type SendCommandFn = (type: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>

/**
 * IPiEngine 的最小可断言 mock。
 * 每个方法用 MockInstance<具体签名>，保证 MockClient 可结构赋给 IPiEngine，
 * 同时允许测试直接访问 client.xxx.mock.calls。
 */
interface MockClient {
  prompt: MockInstance<(content: string) => Promise<unknown>>
  abort: MockInstance<() => Promise<unknown>>
  steer: MockInstance<(content: string) => Promise<unknown>>
  followUp: MockInstance<(content: string) => Promise<unknown>>
  setModel: MockInstance<(provider: string, modelId: string) => Promise<unknown>>
  setThinkingLevel: MockInstance<(level: string) => Promise<unknown>>
  /** set_session_name RPC mock（W1 数据源治理：活跃 label 持久化唯一写入口）。 */
  setSessionName: MockInstance<(name: string) => Promise<unknown>>
  compact: MockInstance<() => Promise<unknown>>
  clear: MockInstance<() => Promise<unknown>>
  getHistory: MockInstance<() => Promise<unknown>>
  /** get_entries RPC mock（entry 树重建路径）。默认空 entries（触发 fallback 尾读）。 */
  getEntries: MockInstance<(since?: string) => Promise<unknown>>
  sendCommand: MockInstance<SendCommandFn>
  /** 切换 pi session 文件（W2 收口：替代 sendCommand('switch_session')）。 */
  switchSession: MockInstance<(sessionPath: string) => Promise<void>>
  /** 查询 pi get_state（W2 收口：替代 readPiState/sendCommand('get_state')），返回归一后的 state 对象。 */
  getState: MockInstance<() => Promise<Record<string, unknown> | undefined>>
  getCommands: MockInstance<() => Promise<unknown>>
  getSessionStats: MockInstance<() => Promise<unknown>>
  onEvent: MockInstance<(listener: PiEventListener) => () => void>
  onExit: MockInstance<(callback: (code: number | null) => void) => void>
  kill: MockInstance<() => Promise<void>>
  start: MockInstance<() => Promise<void>>
  /** touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）。 */
  touchActivity: MockInstance<() => void>
  exited: boolean
  /** onEvent 注册的 listener 列表（测试触发 agent_end 用） */
  eventListeners: PiEventListener[]
}

function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  const eventListeners: PiEventListener[] = []
  return {
    prompt: vi.fn<(content: string) => Promise<unknown>>().mockResolvedValue(undefined),
    abort: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    steer: vi.fn<(content: string) => Promise<unknown>>().mockResolvedValue(undefined),
    followUp: vi.fn<(content: string) => Promise<unknown>>().mockResolvedValue(undefined),
    setModel: vi.fn<(provider: string, modelId: string) => Promise<unknown>>().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn<(level: string) => Promise<unknown>>().mockResolvedValue(undefined),
    setSessionName: vi.fn<(name: string) => Promise<unknown>>().mockResolvedValue(undefined),
    compact: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    clear: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    getHistory: vi.fn<() => Promise<unknown>>().mockResolvedValue({ data: { messages: [] } }),
    // 默认空 entries → getHistory 走 fallback 尾读（与旧 getHistory 空 messages 行为一致）
    getEntries: vi.fn<(since?: string) => Promise<unknown>>().mockResolvedValue({ data: { entries: [], leafId: null } }),
    sendCommand: vi.fn<SendCommandFn>().mockResolvedValue({ data: {} }),
    switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockResolvedValue(undefined),
    getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({}),
    getCommands: vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
    getSessionStats: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    // 保存 listener 到 eventListeners，测试可取出触发 agent_end 事件
    onEvent: vi.fn<(listener: PiEventListener) => () => void>((listener) => {
      eventListeners.push(listener)
      return () => { /* noop unsub */ }
    }),
    onExit: vi.fn<(callback: (code: number | null) => void) => void>(),
    kill: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
    // 到达 fake client——fake 须补齐该接口成员
    touchActivity: vi.fn(),
    exited: false,
    eventListeners,
    ...overrides,
  }
}

/** 重置跨用例共享状态。 */
function resetMockState(): void {
  mockScannedSessions.length = 0
  mocks.defaultModel.value = { provider: 'test-provider', modelId: 'test-model' }
  mocks.convertPiHistoryMock.mockImplementation((raw: unknown) => raw)
  mocks.rebuildHistoryFromEntriesMock.mockImplementation((entries: unknown[]) => ({ messages: entries as unknown[], clientUuidMap: new Map<string, string>() }))
  mocks.getHistoryFromFileMock.mockResolvedValue([])
}

/** 一份完整测试装置：service + 各 mock 依赖 + clientMap + exit 触发器。 */
interface Setup {
  service: SessionService
  pm: IProcessManager
  broker: IMessageBroker
  /** mock IMessageBus（wave:perf-w09 单通道：session 级消息的发布目标） */
  messageBus: IMessageBus
  extensionService: IExtensionService
  clientMap: Map<string, MockClient>
  /** mock 的 IGitInfoReader（readGitInfo 恒 undefined → 摘要 git 字段留空）。供 localSession 复用。 */
  gitInfoReader: IGitInfoReader
  triggerExit: (sessionId: string, code: number | null, stderr?: string) => void
  /** 直接挂载一个 client 到 clientMap（不走 create），用于 dispatcher 类测试。 */
  mountClient: (sessionId: string, client?: MockClient) => MockClient
  /** 走真实 create 建立一个 session，返回其 id + client。 */
  seedSession: (opts?: {
    label?: string
    cwd?: string
    sessionFile?: string
    commands?: Array<{ name: string; source: string; sourceInfo?: Record<string, unknown> }>
    hidden?: boolean
  }) => Promise<{ id: string; client: MockClient }>
}

let autoId = 0

function createSetup(): Setup {
  const clientMap = new Map<string, MockClient>()
  let exitCb: ((sessionId: string, code: number | null, stderr: string) => void) | null = null

  const pm: IProcessManager = {
    // createSession：默认返回一个带唯一 pi sessionId 的 client（模拟 pi get_state）。
    createSession: vi.fn(async (_id: string, _cwd: string) => {
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
    rekey: vi.fn((oldId: string, newId: string) => {
      const c = clientMap.get(oldId)
      if (c) { clientMap.delete(oldId); clientMap.set(newId, c) }
    }),
    onSessionExit: vi.fn((cb) => { exitCb = cb }),
    destroyAll: vi.fn(async () => { clientMap.clear() }),
    // W11：短命 pi 附着 mock——默认以新 ephemeral client 执行 fn（受控可断言）
    withEphemeralPi: vi.fn(async <T,>(_sessionFile: string, fn: (c: IPiEngine) => Promise<T>) =>
      fn(makeMockClient() as unknown as IPiEngine)),
  } as unknown as IProcessManager

  const broker: IMessageBroker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker

  // wave:perf-w09（02 文档 D1-2）：session 级消息单通道走 bus.publish（broker 双写腿已删）。
  // dispatcher（构造参数注入）与 session-service 自身（setMessageBus，对齐组合根）共用此 mock。
  const messageBus: IMessageBus = {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  } as unknown as IMessageBus

  const extensionService: IExtensionService = {
    getExtensionPaths: vi.fn().mockResolvedValue([]),
  } as unknown as IExtensionService

  const adapterFactory = (_sid: string, _interceptor: unknown): IEventAdapter => ({
    attach: vi.fn(),
    detach: vi.fn(),
  })

  // IGitInfoReader 桩：readGitInfo 恒 undefined（摘要 git 字段留空），pruneStaleCache no-op。
  // 经构造注入（git-info 已 port 化，不再 vi.mock 模块）。
  const gitInfoReader: IGitInfoReader = {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  }

  // WorkspaceService 桩：record no-op，list 返空（W2 构造注入）。
  const workspaceService = {
    record: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  }

  const service = new SessionService(
    pm,
    broker,
    adapterFactory,
    '/tmp',
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
    messageBus,
  )
  service.setMessageBus(messageBus)

  const mountClient = (sessionId: string, client?: MockClient): MockClient => {
    const c = client ?? makeMockClient()
    clientMap.set(sessionId, c)
    return c
  }

  const seedSession: Setup['seedSession'] = async (opts = {}) => {
    const piSid = `pi-seed-${++autoId}`
    const client = makeMockClient({
      // W2 收口后 create 用 client.getState()（返回归一后的 state 对象）
      getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
        sessionId: piSid, sessionFile: opts.sessionFile ?? `/fake/${piSid}.jsonl`,
      }),
      getCommands: vi.fn<() => Promise<unknown>>().mockResolvedValue(opts.commands ?? []),
    })
    // 让 createSession mock 本次返回该 client
    vi.mocked(pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    clientMap.set(piSid, client)
    await service.create(opts.cwd ?? tmpdir(), opts.label ?? 'seed', { hidden: opts.hidden })
    return { id: piSid, client }
  }

  return {
    service, pm, broker, messageBus, extensionService, clientMap, gitInfoReader,
    triggerExit: (sid, code, stderr = '') => exitCb?.(sid, code, stderr),
    mountClient, seedSession,
  }
}

/** 辅助：找指定 type 的已发布消息（按 type 收窄返回 payload 类型）。
 * wave:perf-w09（D1-2）双通道查询：session 级消息走 bus.publish（call[1]），
 * 全局消息（config.sessions 等）仍走 broker.broadcast（call[0]）。 */
function findBroadcast<T extends ServerMessage['type']>(setup: Setup, type: T): ServerMessage<T> | undefined {
  for (const call of vi.mocked(setup.messageBus.publish).mock.calls) {
    if (call[1].type === type) return call[1] as ServerMessage<T>
  }
  for (const call of vi.mocked(setup.broker.broadcast).mock.calls) {
    if (call[0].type === type) return call[0] as ServerMessage<T>
  }
  return undefined
}

/**
 * W12：按 type 取**最后一条** publish——state 话题快照挂钩在多实例收敛过程中可能发
 * 中间组合帧（如 modelId 先收敛、thinkingLevel 在途），终态 = 最后一条（last-value 语义，
 * 与 renderer stateSnapshot 回放同口径）。
 */
function findLastBroadcast<T extends ServerMessage['type']>(setup: Setup, type: T): ServerMessage<T> | undefined {
  const calls = vi.mocked(setup.messageBus.publish).mock.calls
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]![1].type === type) return calls[i]![1] as ServerMessage<T>
  }
  return undefined
}

/**
 * W10：播种 usage 实例快照（inputTokens 唯一数据源 = get_session_stats，旧 setInputTokens
 * 缓存直写已删——用例需要预设 inputTokens 时经权威源播种，对齐生产行为）。
 * refetch 绕过防抖立即拉取，flush 一个 macrotask 等 doFetch promise 落位。
 */
async function seedUsageSnapshot(
  setup: Setup,
  id: string,
  client: MockClient,
  contextUsage: { tokens: number; contextWindow: number; percent: number },
): Promise<void> {
  client.getSessionStats.mockResolvedValue({ contextUsage })
  setup.service.getScalarReplicatedStates(id)?.usage.refetch()
  await new Promise<void>(r => setTimeout(r, 0))
}

/**
 * W12：等 state 话题快照挂钩发布落地——事件/查询失效后防抖 300ms（SCALAR_STATE_DEBOUNCE_MS）
 * + 快照 fetch（mock 即时 resolve）+ setTimeout 0 挂钩宏任务，400ms 覆盖整链
 *（真 timers，本文件无 fake timers）。
 */
async function waitForSnapshotPublish(): Promise<void> {
  await new Promise<void>(r => setTimeout(r, 400))
}

// ───────────────────────────────────────────────────────────────────
// dispatcher 类
// ───────────────────────────────────────────────────────────────────

describe('SessionService · dispatcher', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  describe('sendMessage', () => {
    it('calls client.prompt with the user content on normal send', async () => {
      const client = setup.mountClient('sid-1')
      await setup.service.sendMessage('sid-1', 'hello pi')
      expect(client.prompt).toHaveBeenCalledWith('hello pi', undefined)
    })

    it('does not call prompt when hook blocks, and broadcasts message.error with reason', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => ({ blocked: true, reason: 'plugin says no' }))
      await setup.service.sendMessage('sid-1', 'try')
      expect(client.prompt).not.toHaveBeenCalled()
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ sessionId: 'sid-1', message: 'plugin says no' })
    })

    it('uses default reason when hook blocks without reason', async () => {
      setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => ({ blocked: true }))
      await setup.service.sendMessage('sid-1', 'try')
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ message: 'Message blocked by plugin hook' })
    })

    it('passes through when hook returns blocked:false', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => ({ blocked: false }))
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).toHaveBeenCalledWith('go', undefined)
    })

    it('passes through when hook returns null', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => null)
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).toHaveBeenCalledWith('go', undefined)
    })

    // Fix-1：onBeforeSendMessage 的 transform 语义消费侧——hook 返回 modifiedContent
    // 时 dispatcher 用改写后的文本发 pi（demo 插件 !important → IMPORTANT 的消费链路）
    it('sends the hook-modified content when hook returns modifiedContent', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async (_sid, content) => ({
        blocked: false,
        modifiedContent: content.replace('!important', 'IMPORTANT'),
      }))
      await setup.service.sendMessage('sid-1', 'hello !important world')
      expect(client.prompt).toHaveBeenCalledTimes(1)
      expect(client.prompt).toHaveBeenCalledWith('hello IMPORTANT world', undefined)
    })

    it('blocks take precedence over modifiedContent (no prompt sent)', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => ({
        blocked: true,
        reason: 'denied',
        modifiedContent: 'should not be sent',
      }))
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).not.toHaveBeenCalled()
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ message: 'denied' })
    })

    it('broadcasts message.error and skips prompt when hook throws', async () => {
      const client = setup.mountClient('sid-1')
      setup.service.setSendMessageHook(async () => { throw new Error('hook boom') })
      await setup.service.sendMessage('sid-1', 'go')
      expect(client.prompt).not.toHaveBeenCalled()
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ sessionId: 'sid-1' })
      expect(String(err?.payload.message)).toContain('hook boom')
    })

    it('broadcasts message.error when prompt rejects', async () => {
      const client = setup.mountClient('sid-1')
      client.prompt.mockRejectedValueOnce(new Error('pi down'))
      await setup.service.sendMessage('sid-1', 'go')
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ sessionId: 'sid-1', message: 'pi down' })
    })

    it('marks session isGenerating when session is active (via create)', async () => {
      const { id } = await setup.seedSession()
      await setup.service.sendMessage(id, 'hi')
      const summary = setup.service.getSummary(id)
      expect(summary?.status).toBe('active')
    })
  })

  describe('abort / steer / followUp', () => {
    it('abort calls client.abort', async () => {
      const client = setup.mountClient('sid-a')
      await setup.service.abort('sid-a')
      expect(client.abort).toHaveBeenCalledTimes(1)
    })

    // [HISTORICAL] abort 必须广播 message.complete{stopReason:'aborted'} 终态。
    // handoff 2026-07-04 P2：pi 卡死（静默不退出）时不发 agent_end，若 abort 只调
    // client.abort() 不广播终态，前端 isStreaming 永不复位（违反规则 #3）。
    // session-message-handler 的 message.status reply 走 pending 通道，不触发
    // chat store 收口逻辑——必须走流式 message.complete 广播。
    it('abort broadcasts message.complete with stopReason aborted', async () => {
      setup.mountClient('sid-a')
      await setup.service.abort('sid-a')
      const complete = findBroadcast(setup, 'message.complete')
      expect(complete?.payload).toMatchObject({ sessionId: 'sid-a', stopReason: 'aborted' })
    })

    it('abort broadcasts message.error when client.abort fails', async () => {
      const client = setup.mountClient('sid-a')
      client.abort.mockRejectedValueOnce(new Error('pi gone'))
      // abort 失败不 rethrow（已广播 message.error 终态，与 sendPrompt 错误路径对称）
      await setup.service.abort('sid-a')
      const err = findBroadcast(setup, 'message.error')
      expect(err?.payload).toMatchObject({ sessionId: 'sid-a' })
      expect(String(err?.payload?.message)).toContain('pi gone')
    })

    it('abort throws when session has no client', async () => {
      await expect(setup.service.abort('missing')).rejects.toThrow('Session missing not found')
    })

    it('steerMessage calls client.steer with content', async () => {
      const client = setup.mountClient('sid-s')
      await setup.service.steerMessage('sid-s', 'steer me')
      expect(client.steer).toHaveBeenCalledWith('steer me')
    })

    it('steerMessage throws when session not active', async () => {
      await expect(setup.service.steerMessage('missing', 'x')).rejects.toThrow('not active')
    })

    it('followUpMessage calls client.followUp with content', async () => {
      const client = setup.mountClient('sid-f')
      await setup.service.followUpMessage('sid-f', 'follow')
      expect(client.followUp).toHaveBeenCalledWith('follow')
    })

    it('followUpMessage throws when session not active', async () => {
      await expect(setup.service.followUpMessage('missing', 'x')).rejects.toThrow('not active')
    })
  })

  describe('compact', () => {
    it('M4 事件驱动：零 compaction 广播 + client.compact 调用', async () => {
      const client = setup.mountClient('sid-c')
      await setup.service.compact('sid-c')
      expect(client.compact).toHaveBeenCalledTimes(1)
      // 零 compaction 广播（compacting/compacted/summary 由 interpreter 从 pi 事件唯一编排）
      const types = [
        ...vi.mocked(setup.broker.broadcast).mock.calls.map(c => c[0].type),
        ...vi.mocked(setup.messageBus.publish).mock.calls.map(c => c[1].type),
      ]
      const compactionTypes = types.filter(t =>
        ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes(t),
      )
      expect(compactionTypes).toHaveLength(0)
    })

    it('M4 事件驱动：client.compact 失败 → rethrow + 零 compaction 广播（失败提示归 interpreter）', async () => {
      const client = setup.mountClient('sid-c')
      client.compact.mockRejectedValueOnce(new Error('compact fail'))
      await expect(setup.service.compact('sid-c')).rejects.toThrow('compact fail')
      // 零 compaction 广播（pi 手动失败必发 compaction_end{errorMessage}，interpreter 统一编排提示）
      const compacted = findBroadcast(setup, 'session.compacted')
      expect(compacted).toBeUndefined()
    })

    it('throws when session has no client', async () => {
      await expect(setup.service.compact('missing')).rejects.toThrow('Session missing not found')
    })
  })
})

// ───────────────────────────────────────────────────────────────────
// lifecycle 类
// ───────────────────────────────────────────────────────────────────

describe('SessionService · lifecycle', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  describe('create', () => {
    it('builds a managed session: rekeys to pi sessionId, registers summary', async () => {
      const summary = await setup.service.create(tmpdir(), 'my-label')
      // summary.id 来自 mock client 的 get_state
      expect(summary.id).toMatch(/^pi-auto-\d+$/)
      expect(summary.label).toBe('my-label')
      // rekey 被调用（tempId → piSid）
      expect(setup.pm.rekey).toHaveBeenCalledTimes(1)
      expect(vi.mocked(setup.pm.rekey).mock.calls[0][1]).toBe(summary.id)
      // session 进入 sessions Map
      expect(setup.service.getSummary(summary.id)?.label).toBe('my-label')
    })

    it('queries commands and broadcasts session.commands on create', async () => {
      const { id } = await setup.seedSession({ commands: [{ name: 'xyz-navigate', source: 'extension' }] })
      // W12：激活发布 = 播种 fetch 快照应用后的挂钩（异步宏任务），等落地
      await waitForSnapshotPublish()
      // commands 广播给前端
      const cmds = findBroadcast(setup, 'session.commands')
      expect(cmds?.payload).toMatchObject({ sessionId: id })
    })

    it('broadcasts session.commands 含 sourceInfo 透传（W2）', async () => {
      const { id } = await setup.seedSession({
        commands: [
          {
            name: 'fix',
            source: 'skill',
            sourceInfo: { path: '/proj/skills/fix/SKILL.md', source: 'skill', scope: 'project' },
          },
        ],
      })
      // W12：激活发布经快照挂钩，等落地
      await waitForSnapshotPublish()
      const cmds = findBroadcast(setup, 'session.commands')
      // sourceInfo 从 pi get_commands 透传到快照（commands 实例整字段持有）再到广播 payload
      expect(cmds?.payload.commands[0]).toMatchObject({
        name: 'fix',
        source: 'skill',
        sourceInfo: { path: '/proj/skills/fix/SKILL.md', source: 'skill', scope: 'project' },
      })
      expect(id).toBeDefined()
    })

    it('throws when no default model configured', async () => {
      mocks.defaultModel.value = null
      await expect(setup.service.create(tmpdir())).rejects.toThrow('No model configured')
    })

    it('throws and destroys session when pi returns no sessionId', async () => {
      // W2 收口后 create 用 client.getState()，返回空对象 → 无 sessionId → 抛错
      const stateless = makeMockClient({
        getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({}),
      })
      vi.mocked(setup.pm.createSession).mockResolvedValueOnce(stateless as unknown as IPiEngine)
      await expect(setup.service.create(tmpdir())).rejects.toThrow('did not return a session ID')
      expect(setup.pm.destroySession).toHaveBeenCalledTimes(1)
    })

    it('calls refreshAll after create', async () => {
      await setup.service.create(tmpdir())
      expect(mocks.refreshAllMock).toHaveBeenCalledTimes(1)
    })

    // INV-7: create 收到不存在的 cwd → 降级 homedir（与 restoreSession fallback 对称）
    it('falls back to homedir when requested cwd does not exist (INV-7)', async () => {
      const nonexistentCwd = '/tmp/xyz-agent-test-cwd-nonexistent-' + Date.now()
      const summary = await setup.service.create(nonexistentCwd, 'label')
      // createSession 收到 homedir 而非不存在的路径（existsSync 真实，路径保证不存在）
      expect(setup.pm.createSession).toHaveBeenCalledWith(
        expect.any(String),
        homedir(),
        expect.any(Object),
      )
      // 返回的 summary.cwd 也是 homedir（前端据此比对发现 fallback 并 toast）
      expect(summary.cwd).toBe(homedir())
      // workspaceService.record 记录的是 fallback 后的 homedir
      expect(vi.mocked(setup.pm.createSession).mock.calls[0][1]).not.toContain('nonexistent')
    })
  })

  describe('delete', () => {
    it('detaches, destroys process, removes from map (active session)', async () => {
      const { id } = await setup.seedSession()
      await setup.service.delete(id)
      expect(setup.pm.destroySession).toHaveBeenCalledWith(id)
      expect(setup.service.getSummary(id)).toBeUndefined()
      expect(mocks.refreshAllMock).toHaveBeenCalled()
    })

    it('trashes the session file when it exists on disk (non-active scanned)', async () => {
      // 用真实临时文件让 existsSync 返回 true
      const dir = mkdtempSync(join(tmpdir(), 'del-'))
      try {
        const filePath = join(dir, 's.jsonl')
        writeFileSync(filePath, '{}')
        mockScannedSessions.push({
          id: 'scan-del', filePath, cwd: dir, name: null,
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
        })
        await setup.service.delete('scan-del')
        expect(mocks.trashMock).toHaveBeenCalledWith(filePath)
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('throws when session neither active nor scanned', async () => {
      await expect(setup.service.delete('ghost')).rejects.toThrow('Session ghost not found')
    })
  })

  describe('renameSession', () => {
    it('active session：新名经 pi set_session_name RPC 持久化（W1：不再直写 session JSONL）', async () => {
      const { id, client } = await setup.seedSession({ sessionFile: '/fake/x.jsonl' })
      await setup.service.renameSession(id, 'new name')
      // W1 接口契约：活跃分支唯一写入口 = setSessionName RPC（seedSession 的 create 显式
      // label 也走同一 RPC，故断言最后一次调用是 rename 的新名）
      expect(client.setSessionName).toHaveBeenLastCalledWith('new name')
      // 直写路径已随 W11 全删（persistSessionName 不存在），回归守卫由 R1 检查承担
      expect(mocks.refreshAllMock).toHaveBeenCalled()
      expect(setup.service.getSummary(id)?.label).toBe('new name')
    })

    it('active session：pi client 不可用（崩溃窗口）时 throw，不静默丢写', async () => {
      const { id } = await setup.seedSession({ sessionFile: '/fake/x.jsonl' })
      // 模拟 pi 崩溃：clientMap 移除该 session 的 client（pm.getClient 返回 undefined）
      setup.clientMap.delete(id)
      await expect(setup.service.renameSession(id, 'new name')).rejects.toThrow('pi process is not available')
      // 未持久化、内存 label 也未变（先 RPC 后改内存，失败保留旧名可重试）
      expect(setup.service.getSummary(id)?.label).toBe('seed')
    })

    it('non-active session：短命 pi 附着后 set_session_name RPC（W11：直写全删）', async () => {
      mockScannedSessions.push({
        id: 'scan-ren', filePath: '/fake/scan-ren.jsonl', cwd: tmpdir(), name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      const ephemeral = makeMockClient()
      vi.mocked(setup.pm.withEphemeralPi).mockImplementationOnce(async (_f, fn) =>
        fn(ephemeral as unknown as IPiEngine))
      await setup.service.renameSession('scan-ren', 'renamed')
      // 非活跃分支经短命 pi 附着目标文件后 RPC（xyz 不再直写 session JSONL）
      expect(setup.pm.withEphemeralPi).toHaveBeenCalledWith('/fake/scan-ren.jsonl', expect.any(Function))
      expect(ephemeral.setSessionName).toHaveBeenCalledWith('renamed')
    })
  })

  describe('restoreSession', () => {
    it('reuses scanned sessionId and sends switch_session with file path', async () => {
      // B7: restoreSession 直读 JSONL 文件（stripSessionEnd 已删），需真实文件
      const dir = mkdtempSync(join(tmpdir(), 'restore-'))
      const filePath = join(dir, 'persist-1.jsonl')
      writeFileSync(filePath, JSON.stringify({ type: 'session_info', name: 'old' }))
      try {
        mockScannedSessions.push({
          id: 'persist-1', filePath, cwd: dir, name: 'old',
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
        })
        const client = makeMockClient()
        vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
        const summary = await setup.service.restoreSession('persist-1')
        expect(summary.id).toBe('persist-1')
        // [W1 语义变更：直附着正式文件] switchSession 收到原 filePath（不再写
        // $TMPDIR tmpFile 后切 tmp——pi switch_session 永久重绑读写目标）
        expect(client.switchSession).toHaveBeenCalledWith(filePath)
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('throws when persisted session not found', async () => {
      await expect(setup.service.restoreSession('nope')).rejects.toThrow('Persisted session nope not found')
    })

    it('throws when no default model configured', async () => {
      mockScannedSessions.push({
        id: 'persist-2', filePath: '/fake/p2.jsonl', cwd: tmpdir(), name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      mocks.defaultModel.value = null
      await expect(setup.service.restoreSession('persist-2')).rejects.toThrow('No model configured')
    })

    // W3 事件监听器所有权（自 session-pool-restoresession.test.ts 归并）：
    // 同 id 二次 restore 必须先 detach 第一次的 adapter（EventAdapter 是 pi 事件监听唯一 owner）
    it('detaches the first adapter when the same sessionId is restored twice', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'restore-detach-'))
      const filePath = join(dir, 'persist-detach.jsonl')
      writeFileSync(filePath, JSON.stringify({ type: 'session_info' }))
      try {
        mockScannedSessions.push({
          id: 'persist-detach', filePath, cwd: dir, name: null,
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
        })
        const detachSpy = vi.fn()
        const attachSpy = vi.fn()
        const localSetup = createSetup()
        // 用可观测的 adapter 工厂捕获 detach（同 Facade 组 onSessionExited detach 先例）
        const localService = new SessionService(
          localSetup.pm,
          localSetup.broker,
          () => ({ attach: attachSpy, detach: detachSpy }),
          '/tmp',
          localSetup.extensionService,
          new PiConfigStore(),
          new PiSessionStore(),
          localSetup.gitInfoReader,
          { record: vi.fn(), list: vi.fn().mockReturnValue([]) } as unknown as ConstructorParameters<typeof SessionService>[8],
        )
        const client = makeMockClient()
        vi.mocked(localSetup.pm.createSession).mockResolvedValue(client as unknown as IPiEngine)

        await localService.restoreSession('persist-detach')
        expect(detachSpy).not.toHaveBeenCalled()

        // 同 id 二次 restore——应先 detach 第一次的 adapter
        await localService.restoreSession('persist-detach')
        expect(detachSpy).toHaveBeenCalledTimes(1)
        expect(attachSpy).toHaveBeenCalledTimes(2)
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    // cwd fallback（自 session-pool-restoresession.test.ts 归并）：死路径 cwd → homedir 兜底
    it('falls back to home dir when the scanned session cwd does not exist', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'restore-cwd-'))
      const filePath = join(dir, 'persist-cwd.jsonl')
      writeFileSync(filePath, JSON.stringify({ type: 'session_info' }))
      try {
        const nonexistentCwd = join(dir, 'xyz-agent-test-cwd-nonexistent')
        mockScannedSessions.push({
          id: 'persist-cwd', filePath, cwd: nonexistentCwd, name: null,
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
        })
        const client = makeMockClient()
        vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)

        await setup.service.restoreSession('persist-cwd')

        // createSession 收到的 cwd 不含死路径（F3 归一化兜底 homedir）
        expect(vi.mocked(setup.pm.createSession).mock.calls[0]?.[1]).not.toContain('xyz-agent-test-cwd-nonexistent')
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })

    it('destroys created session when switch_session fails', async () => {
      // B7: restoreSession 直读 JSONL 文件，需真实文件
      const dir = mkdtempSync(join(tmpdir(), 'restore-fail-'))
      const filePath = join(dir, 'persist-3.jsonl')
      writeFileSync(filePath, JSON.stringify({ type: 'session_info' }))
      try {
        mockScannedSessions.push({
          id: 'persist-3', filePath, cwd: dir, name: null,
          lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
        })
        const client = makeMockClient({
          // W2 收口后 restoreSession 用 client.switchSession，失败时抛错触发清理
          switchSession: vi.fn<(sessionPath: string) => Promise<void>>().mockRejectedValue(new Error('switch failed')),
        })
        vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
        await expect(setup.service.restoreSession('persist-3')).rejects.toThrow('switch failed')
        expect(setup.pm.destroySession).toHaveBeenCalledWith('persist-3')
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })
})

// ───────────────────────────────────────────────────────────────────
// Facade 类
// ───────────────────────────────────────────────────────────────────

describe('SessionService · Facade', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  describe('switchModel（session 级状态单一 owner：RPC + 缓存 + 广播）', () => {
    it('calls client.setModel and updates cached modelId', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.setModel).mockClear()
      const returned = await setup.service.switchModel(id, 'anthropic' as ProviderId, 'claude-x')
      // U6 回执普查：返回 get_state 读回的生效模型复合串（非 sessionId）
      expect(returned).toBe('anthropic/claude-x')
      expect(client.setModel).toHaveBeenCalledWith('anthropic', 'claude-x')
      expect(setup.service.getSummary(id)?.modelId).toBe('anthropic/claude-x')
    })

    it('throws when session not in map (W1/L7: fail-fast，不再静默成功)', async () => {
      await expect(setup.service.switchModel('ghost', 'p' as ProviderId, 'm')).rejects.toThrow('session not active')
    })

    it('切换后广播 session.state_changed（payload 来自 modelId/thinkingLevel 快照，W12；usage 走 context.update，D1）', async () => {
      const { id, client } = await setup.seedSession()
      // W18：resolver 注入链已删（W12 后生产零消费）——payload 数值全部来自 pi 快照
      // W10：inputTokens 唯一数据源 = usage 实例快照（播种替代旧 setInputTokens 直写）
      await seedUsageSnapshot(setup, id, client, { tokens: 12000, contextWindow: 200000, percent: 6 })
      vi.mocked(client.setModel).mockClear()
      vi.mocked(setup.broker.broadcast).mockClear()
      vi.mocked(setup.messageBus.publish).mockClear()
      // W12：get_state 权威翻新（thinkingLevel + 新模型）——mockResolvedValue 持续，
      // modelId / thinkingLevel 两实例防抖重拉都消费同一权威值
      vi.mocked(client.getState).mockResolvedValue({
        thinkingLevel: 'high',
        model: { id: 'claude-x', provider: 'anthropic' },
      })

      await setup.service.switchModel(id, 'anthropic' as ProviderId, 'claude-x')
      // W12：即时广播退役——三实例防抖重拉收敛后经快照挂钩发布
      await waitForSnapshotPublish()

      // D1 协议收敛：state_changed 只携带 sessionId/modelId/thinkingLevel（usage 三字段已删）
      const stateChanged = findLastBroadcast(setup, 'session.state_changed')
      expect(stateChanged).toBeDefined()
      expect(stateChanged!.payload).toMatchObject({
        sessionId: id,
        modelId: 'anthropic/claude-x',
        thinkingLevel: 'high',
      })
      // usage 快照真值经 context.update 帧贯穿（单帧单数据，D1）
      const contextUpdate = findLastBroadcast(setup, 'context.update')
      expect(contextUpdate).toBeDefined()
      expect(contextUpdate!.payload).toMatchObject({
        sessionId: id,
        inputTokens: 12000,
        contextLimit: 200000,
        usagePercent: 6,
      })
    })

    it('未注入 resolver 时 usage 帧仍读快照真值（旧「resolver 缺省 0」口径随 W12 退役；断言移至 context.update，D1）', async () => {
      const { id, client } = await setup.seedSession()
      // 不注入 resolver；快照播种 inputTokens（usage 真值经 context.update 帧透出）
      await seedUsageSnapshot(setup, id, client, { tokens: 5000, contextWindow: 100000, percent: 5 })

      await setup.service.switchModel(id, 'anthropic' as ProviderId, 'claude-x')
      await waitForSnapshotPublish()

      // state_changed 帧恒不含 usage（D1 协议不变量）
      const stateChanged = findBroadcast(setup, 'session.state_changed')
      expect(stateChanged).toBeDefined()
      expect(JSON.stringify(stateChanged!.payload)).not.toContain('usagePercent')
      // usage 快照三字段真值在 context.update 帧
      const contextUpdate = findBroadcast(setup, 'context.update')
      expect(contextUpdate).toBeDefined()
      expect(contextUpdate!.payload).toMatchObject({
        contextLimit: 100000,
        usagePercent: 5,
        inputTokens: 5000,
      })
    })

    it('get_state 失败时不阻塞：快照播种失败，payload 回退缓存值（fetch 失败兜底发布）', async () => {
      const { id, client } = await setup.seedSession()
      // thinkingLevel 过渡期缓存播种（getSummary fallback 值）：经公开 setThinkingLevel
      // 写入（旧 setThinkingLevelCache 直写缓存已随 W12 移交死代码删除）
      await setup.service.setThinkingLevel(id, 'medium')
      // W12：get_state 持续失败 → modelId/thinkingLevel 实例退避重试、快照缺失 →
      // fetch 落定兜底发布（对齐旧 broadcastSessionState「失败不阻塞、thinkingLevel 回退缓存」）
      vi.mocked(client.getState).mockRejectedValue(new Error('get_state boom'))

      await setup.service.switchModel(id, 'anthropic' as ProviderId, 'claude-x')
      await waitForSnapshotPublish()

      const stateChanged = findBroadcast(setup, 'session.state_changed')
      expect(stateChanged).toBeDefined()
      expect(stateChanged!.payload).toMatchObject({ thinkingLevel: 'medium' })
    })
  })

  describe('setThinkingLevel', () => {
    it('updates cache and calls client.setThinkingLevel', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.setThinkingLevel).mockClear()
      await setup.service.setThinkingLevel(id, 'high')
      expect(client.setThinkingLevel).toHaveBeenCalledWith('high')
      expect(setup.service.getSummary(id)?.thinkingLevel).toBe('high')
    })
  })

  describe('getInputTokens（W10：usage 实例快照派生，唯一数据源 = get_session_stats）', () => {
    it('U-setInput-1：快照播种后 getInputTokens 读回快照 inputTokens', async () => {
      const { id, client } = await setup.seedSession()
      await seedUsageSnapshot(setup, id, client, { tokens: 12345, contextWindow: 200000, percent: 6 })
      expect(setup.service.getInputTokens(id)).toBe(12345)
    })

    it('U-setInput-2：不存在的 session（无实例）返回 0，不抛错', () => {
      expect(setup.service.getInputTokens('nonexistent')).toBe(0)
    })

    it('U-setInput-3：applyContextUpdate 事件不直写快照（事件只做失效，W10 五写点收编）', async () => {
      const { id, client } = await setup.seedSession()
      await seedUsageSnapshot(setup, id, client, { tokens: 12345, contextWindow: 200000, percent: 6 })
      setup.service.applyContextUpdate(id, 99999)
      // 事件参数不直写：快照保持播种值（真 timers 下防抖未到点，无重拉）
      expect(setup.service.getInputTokens(id)).toBe(12345)
    })
  })

  describe('applyContextUpdate（session 级状态单一 owner：W12 事件只失效，发布归快照挂钩）', () => {
    it('失效收敛后广播 context.update（payload 全字段来自 usage 快照），不直写快照', async () => {
      const { id, client } = await setup.seedSession()
      await seedUsageSnapshot(setup, id, client, { tokens: 10000, contextWindow: 100000, percent: 10 })
      // pi 侧权威已翻新为事件值 25000（同源：turn_end 事件与 get_session_stats 同一数据，
      // 事件即时值即快照将收敛的值——等价性依据）
      client.getSessionStats.mockResolvedValue({ contextUsage: { tokens: 25000, contextWindow: 100000, percent: 25 } })
      vi.mocked(setup.broker.broadcast).mockClear()
      vi.mocked(setup.messageBus.publish).mockClear()

      // W12：事件只失效（markDirty），发布由防抖重拉的快照挂钩承担
      setup.service.applyContextUpdate(id, 25000)
      await waitForSnapshotPublish()

      const ctxUpdate = findLastBroadcast(setup, 'context.update')
      expect(ctxUpdate).toBeDefined()
      expect(ctxUpdate!.payload).toMatchObject({
        sessionId: id,
        inputTokens: 25000,
        contextLimit: 100000,
        usagePercent: 25, // round(pi percent 25)——与旧「事件值 + resolver 重算」round(25000/100000*100) 同值
      })
      // 快照经唯一数据写路径（fetch）收敛 pi 权威值
      expect(setup.service.getInputTokens(id)).toBe(25000)
    })

    it('inputTokens 为 0 时不广播（agent_end 前的空 usage；markDirty 失效仍发出）', async () => {
      const { id } = await setup.seedSession()
      vi.mocked(setup.broker.broadcast).mockClear()

      setup.service.applyContextUpdate(id, 0)

      expect(setup.service.getInputTokens(id)).toBe(0) // 快照未播种（mock getSessionStats 默认 {} → 拉取失败保留空）
      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('session 不存在时不广播', async () => {
      expect(() => setup.service.applyContextUpdate('ghost', 1000)).not.toThrow()
      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('未注入 resolver：payload 读快照 pi 权威值（resolver 不再参与，W12）', async () => {
      const { id, client } = await setup.seedSession()
      await seedUsageSnapshot(setup, id, client, { tokens: 5000, contextWindow: 100000, percent: 5 })

      setup.service.applyContextUpdate(id, 5000)
      await waitForSnapshotPublish()

      const ctxUpdate = findBroadcast(setup, 'context.update')
      expect(ctxUpdate).toBeDefined()
      expect(ctxUpdate!.payload).toMatchObject({ contextLimit: 100000, usagePercent: 5, inputTokens: 5000 })
    })
  })

  describe('getUsagePercent（W10：usage 实例快照派生 pi 权威 percent）', () => {
    it('读快照 usagePercent（pi get_session_stats 投影，不再本地按缓存重算）', async () => {
      const { id, client } = await setup.seedSession()
      await seedUsageSnapshot(setup, id, client, { tokens: 100000, contextWindow: 200000, percent: 50 })

      expect(setup.service.getUsagePercent(id)).toBe(50)
    })

    it('快照 percent 已被 pi clamp 到 100（inputTokens 超过 contextWindow）', async () => {
      const { id, client } = await setup.seedSession()
      await seedUsageSnapshot(setup, id, client, { tokens: 150000, contextWindow: 100000, percent: 100 })

      expect(setup.service.getUsagePercent(id)).toBe(100)
    })

    it('快照未播种（percent 缺失）返回 0', async () => {
      const { id } = await setup.seedSession()
      expect(setup.service.getUsagePercent(id)).toBe(0)
    })

    it('session 不存在返回 0', () => {
      expect(setup.service.getUsagePercent('ghost')).toBe(0)
    })
  })

  describe('setLabelCache 回写缓存（session_info_changed 打通用例，MF-3 ③）', () => {
    // 链路：pi session_info_changed → interpreter onSessionRenamed → setLabelCache →
    // 内存 session.label（唯一数据源，commit 9aec7748a toSummary 直读 session.label）→
    // getSummary / listPersistedSessions（broadcastSessionList 数据源）。缺刻痕时 runtime
    // 内存 label 过期会覆盖前端 rename（本批修复的核心 bug）。
    it('U-setLabel-1：setLabelCache 写入后 getSummary().label 读回新值', async () => {
      const { id } = await setup.seedSession({ label: 'old-label' })
      expect(setup.service.getSummary(id)?.label).toBe('old-label')
      // 模拟 EventInterpreter onSessionRenamed 回调（pi auto-rename）
      setup.service.setLabelCache(id, 'renamed-by-pi')
      expect(setup.service.getSummary(id)?.label).toBe('renamed-by-pi')
    })

    it('U-setLabel-2：setLabelCache 后 listPersistedSessions()（broadcastSessionList 数据源）summary.label 为新值', async () => {
      const cwd = tmpdir()
      const { id } = await setup.seedSession({ cwd, label: 'old-label' })
      setup.service.setLabelCache(id, 'renamed-by-pi')
      const groups = setup.service.listPersistedSessions()
      const summary = groups.flatMap(g => g.sessions).find(s => s.id === id)
      expect(summary?.label).toBe('renamed-by-pi')
    })

    it('U-setLabel-3：setLabelCache 对不存在的 session 不抛错（迟到事件的迟到回调）', () => {
      expect(() => setup.service.setLabelCache('ghost', 'x')).not.toThrow()
    })

    it('U-setLabel-empty：空串 label 是权威空值必须写入（pi 清空 session name 场景，组合根 name ?? "" 兜底的下游路径）', async () => {
      // 链路：pi session_info_changed name 为空 → interpreter onSessionRenamed 透传
      // undefined → 组合根 index.ts name ?? '' 兜底为 '' → setLabelCache(id, '')。
      // '' 是 pi 的权威「未命名」声明（sessionName 空 = 未命名合法态）——若 setLabelCache
      // 对空值 return early，内存 label 永远停留在旧名，getSummary/listPersistedSessions
      // 与 pi 侧持久化漂移（旧名复活 bug）。
      const { id } = await setup.seedSession({ label: 'old-label' })
      setup.service.setLabelCache(id, '')
      expect(setup.service.getSummary(id)?.label).toBe('')

      // broadcastSessionList 数据源同值（空串覆盖旧名，非「字段不动」）
      const groups = setup.service.listPersistedSessions()
      const summary = groups.flatMap(g => g.sessions).find(s => s.id === id)
      expect(summary?.label).toBe('')
    })
  })

  describe('inputTokens / tokenCount（W3 事件链路迁移 → W10 usage 实例收编）', () => {
    // W3：attachUsageListener 已删除，回写经中间事件链路（applyContextUpdate /
    // handleTurnEndSideEffects）。W10：applyContextUpdate 不再直写 inputTokens/tokenCount
    //   - applyContextUpdate(sid, inputTokens, totalTokens)：只失效 usage 实例 + 即时广播
    //   - getInputTokens / tokenCount（toSummary）：usage 实例快照派生
    //   - handleTurnEndSideEffects(sid)：复位 isGenerating（agent_end 副作用）
    it('getInputTokens / tokenCount 均派生自 usage 实例快照（唯一数据源）', async () => {
      const { id, client } = await setup.seedSession()
      // 播种权威快照（事件链路三条路径 totalTokens 与 inputTokens 同值，tokenCount 同语义派生）
      await seedUsageSnapshot(setup, id, client, { tokens: 15000, contextWindow: 100000, percent: 15 })
      expect(setup.service.getInputTokens(id)).toBe(15000)
      expect(setup.service.getSummary(id)?.tokenCount).toBe(15000)
    })

    it('agent_end 无 usage（inputTokens=0）时 applyContextUpdate 早退，快照保持', async () => {
      const { id, client } = await setup.seedSession()
      await seedUsageSnapshot(setup, id, client, { tokens: 15000, contextWindow: 100000, percent: 15 })
      // inputTokens=0 守卫：不广播（markDirty 失效仍发出，真 timers 防抖未到点无重拉）
      setup.service.applyContextUpdate(id, 0, 0)
      expect(setup.service.getInputTokens(id)).toBe(15000)
    })

    it('handleTurnEndSideEffects 复位 isGenerating（agent_end 迁移）', async () => {
      const { id } = await setup.seedSession()
      await setup.service.sendMessage(id, 'hi') // 标记 generating
      expect(setup.service.getSummary(id)?.status).toBe('active')
      setup.service.handleTurnEndSideEffects(id)
      expect(setup.service.getSummary(id)?.status).toBe('idle')
    })

    it('getInputTokens 对未知 session 返回 0', () => {
      expect(setup.service.getInputTokens('ghost')).toBe(0)
    })
  })

  describe('fetchAndBroadcastContext（session 恢复后推送用量）', () => {
    it('contextUsage.tokens 有值 → 查询失效收敛后经快照挂钩广播 context.update（W12）', async () => {
      const { id, client } = await setup.seedSession()
      // mockResolvedValue 持续：fetchContext 查询 RPC 与防抖重拉 RPC 拿同一权威值
      client.getSessionStats.mockResolvedValue({
        contextUsage: { tokens: 69000, contextWindow: 512000, percent: 13.5 },
      })

      await setup.service.fetchAndBroadcastContext(id)
      // W12：fetchAndBroadcastContext 只做查询失效，发布归 usage fetch 快照挂钩
      await waitForSnapshotPublish()

      const msg = findBroadcast(setup, 'context.update')
      expect(msg).toBeDefined()
      expect(msg!.payload).toMatchObject({
        sessionId: id,
        inputTokens: 69000,
        contextLimit: 512000,
        usagePercent: 14, // Math.round(13.5)
      })
    })

    it('contextUsage.tokens=null（compaction 后未跑新 turn）→ 不广播', async () => {
      const client = setup.mountClient('sid-null')
      client.getSessionStats.mockResolvedValueOnce({
        contextUsage: { tokens: null, contextWindow: 512000, percent: null },
      })

      await setup.service.fetchAndBroadcastContext('sid-null')

      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('contextUsage 缺失 → 不广播', async () => {
      const client = setup.mountClient('sid-no-ctx')
      client.getSessionStats.mockResolvedValueOnce({})

      await setup.service.fetchAndBroadcastContext('sid-no-ctx')

      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('session 不存在（client 未挂载）→ no-op 不抛错', async () => {
      await expect(setup.service.fetchAndBroadcastContext('ghost-session')).resolves.toBeUndefined()
      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })

    it('getSessionStats 抛错 → 不广播，不抛错（fire-and-forget）', async () => {
      const client = setup.mountClient('sid-err')
      client.getSessionStats.mockRejectedValueOnce(new Error('pi rpc timeout'))

      await expect(setup.service.fetchAndBroadcastContext('sid-err')).resolves.toBeUndefined()
      expect(findBroadcast(setup, 'context.update')).toBeUndefined()
    })
  })

  describe('fetchContext（RPC handler session.getContext 调用，返回 payload）', () => {
    it('contextUsage.tokens 有值 → 返回 {inputTokens, contextLimit, usagePercent}', async () => {
      const client = setup.mountClient('sid-fc')
      client.getSessionStats.mockResolvedValueOnce({
        contextUsage: { tokens: 1630000, contextWindow: 2000000, percent: 81.5 },
      })

      const payload = await setup.service.fetchContext('sid-fc')
      expect(payload).toEqual({
        inputTokens: 1630000,
        contextLimit: 2000000,
        usagePercent: 82, // Math.round(81.5)
      })
    })

    it('contextUsage.tokens=null → 返回 null（不广播、handler reply 空对象）', async () => {
      const client = setup.mountClient('sid-fc-null')
      client.getSessionStats.mockResolvedValueOnce({
        contextUsage: { tokens: null, contextWindow: 512000, percent: null },
      })

      expect(await setup.service.fetchContext('sid-fc-null')).toBeNull()
    })

    it('session 未激活（client 未挂载）→ 抛错（handler 调方 catch）', async () => {
      await expect(setup.service.fetchContext('ghost')).rejects.toThrow('not active')
    })
  })

  describe('hasActiveSession / getRpcClient', () => {
    it('hasActiveSession delegates to pm.hasClient', () => {
      setup.mountClient('sid-h')
      expect(setup.service.hasActiveSession('sid-h')).toBe(true)
      expect(setup.service.hasActiveSession('missing')).toBe(false)
    })

    it('getRpcClient returns the underlying client', () => {
      const client = setup.mountClient('sid-g')
      expect(setup.service.getRpcClient('sid-g')).toBe(client)
      expect(setup.service.getRpcClient('missing')).toBeUndefined()
    })
  })

  describe('getSummary', () => {
    it('returns undefined for unknown session', () => {
      expect(setup.service.getSummary('ghost')).toBeUndefined()
    })

    it('returns summary for active session', async () => {
      const { id } = await setup.seedSession({ label: 'sum' })
      expect(setup.service.getSummary(id)?.label).toBe('sum')
    })
  })

  describe('ensureActive', () => {
    it('returns existing client without restoring', async () => {
      const client = setup.mountClient('sid-e')
      const got = await setup.service.ensureActive('sid-e')
      expect(got).toBe(client)
    })

    it('restores session when client missing and returns new client', async () => {
      mockScannedSessions.push({
        id: 'persist-ens', filePath: '/fake/ens.jsonl', cwd: tmpdir(), name: null,
        lastModified: Date.now(), timestamp: new Date().toISOString(), size: 0, outcome: null,
      })
      const client = makeMockClient()
      // mockResolvedValueOnce 会绕过 createSession 默认实现（后者负责写 clientMap），
      // 因此手动把 client 关联进 clientMap，让 ensureActive 末尾的 getClient 能取到。
      vi.mocked(setup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
      setup.clientMap.set('persist-ens', client)
      const got = await setup.service.ensureActive('persist-ens')
      expect(got).toBe(client)
    })

    it('joins the same in-flight restore when called concurrently (crash-resilience D7-3 join)', async () => {
      // [HISTORICAL] 原断言第二个并发调用被 already being restored 拒绝（throw 语义）；
      // u8（crash-resilience D7-③）throw→join：并发调用等待同一 in-flight Promise，
      // restore 内核只进入一次（不报错不双跑）。
      // 让 restoreSession 挂起，模拟并发 restore。不能 mountClient，否则 ensureActive
      // 走 fast path（直接返回现有 client），不会进入 restoring 分支。
      let resolveRestore!: (v: SessionSummary) => void
      const pending = new Promise<SessionSummary>(r => { resolveRestore = r })
      const restoreSpy = vi.spyOn(setup.service, 'restoreSession').mockReturnValueOnce(pending)

      const first = setup.service.ensureActive('dedup-sid')
      const second = setup.service.ensureActive('dedup-sid')
      // join：restore 内核只进入一次（没有第二路并发 restore）
      expect(restoreSpy).toHaveBeenCalledTimes(1)
      resolveRestore({} as SessionSummary)
      // 双方都等恢复完成后继续；随后都因 getClient 无 client 而 reject（符合无进程的真实场景）
      await expect(first).rejects.toThrow('client not available')
      await expect(second).rejects.toThrow('client not available')
      expect(restoreSpy).toHaveBeenCalledTimes(1)
      restoreSpy.mockRestore()
    })
  })

  describe('getHistory', () => {
    it('rebuilds history via entry-tree-builder when getEntries returns entries', async () => {
      const fakeEntries = [{ type: 'message', id: 'e1', message: { role: 'user', content: 'hi' } }]
      const client = setup.mountClient('sid-hist')
      client.getEntries.mockResolvedValueOnce({ data: { entries: fakeEntries, leafId: 'e1' } })
      mocks.rebuildHistoryFromEntriesMock.mockReturnValueOnce({ messages: ['rebuilt' as unknown as Message], clientUuidMap: new Map() })
      const result = await setup.service.getHistory('sid-hist')
      // rebuildHistoryFromEntries 收到原始 entries（getEntries 路径，取代旧 get_messages + convertPiHistory）
      expect(mocks.rebuildHistoryFromEntriesMock).toHaveBeenCalledWith(fakeEntries, null)
      // getEntries 路径返回双预算窗口（u4b：mock 消息无 role 字段 → 病态兜底视为单 turn 完整放行）
      expect(result).toEqual({ messages: ['rebuilt'], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    })

    it('R-12: returns empty array (short-circuit) when getEntries returns empty and session is idle', async () => {
      const { id } = await setup.seedSession()
      const client = setup.clientMap.get(id)!
      client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: null } })
      // wave:perf-w20（R-12）：pi RPC 是活跃 session 的权威视图，空 entries 短路返回空列表，
      // 不走尾读 fallback（尾读会给最多 20 turn 的文件尾部视图，与 RPC 视图闪变不一致）。
      // 尾读降级仅在 getEntries 抛错时触发（见下方 throws 用例）。
      const result = await setup.service.getHistory(id)
      expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      expect(mocks.getHistoryTailFromFileMock).not.toHaveBeenCalled()
    })

    it('returns empty array when getEntries empty and session is generating', async () => {
      const { id, client } = await setup.seedSession()
      // 进入 generating：发一条消息
      await setup.service.sendMessage(id, 'x')
      client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: null } })
      const result = await setup.service.getHistory(id)
      // generating session getEntries 空 → 直接返回空（不走 fallback 尾读）
      expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      expect(mocks.getHistoryTailFromFileMock).not.toHaveBeenCalled()
    })

    it('falls back to file read when getEntries throws', async () => {
      const { id, client } = await setup.seedSession()
      client.getEntries.mockRejectedValueOnce(new Error('rpc boom'))
      mocks.getHistoryTailFromFileMock.mockResolvedValueOnce({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      await setup.service.getHistory(id)
      // [D4] 尾读降级带字节预算缺省（与游标分支同源 HISTORY_BUDGET.MAX_BYTES——原样透传
      // undefined 会退化为仅 turn 数截取，20 大 turn 的 reply 超 32MB 被 payload_too_large 拒绝）
      expect(mocks.getHistoryTailFromFileMock).toHaveBeenCalledWith(
        id, expect.anything(), expect.anything(), { maxBytes: HISTORY_BUDGET.MAX_BYTES },
      )
    })

    it('D4: 增量路径非 EntryNotFound 错误降级尾读——同样带字节预算缺省', async () => {
      const client = setup.mountClient('sid-inc-fallback')
      const e1 = { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'q1' } }
      const m1 = { id: 'm1', role: 'user', content: 'q1', piEntryId: 'e1' } as unknown as Message
      client.getEntries.mockResolvedValueOnce({ data: { entries: [e1], leafId: 'e1' } })
      mocks.rebuildHistoryFromEntriesMock.mockReturnValueOnce({ messages: [m1], clientUuidMap: new Map() })
      await setup.service.getHistory('sid-inc-fallback') // 写缓存（leafId='e1'）

      // 增量拉取抛非 EntryNotFound 错误 → 降级尾读（缓存不动）
      client.getEntries.mockRejectedValueOnce(new Error('rpc boom'))
      mocks.getHistoryTailFromFileMock.mockResolvedValueOnce({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      await setup.service.getHistory('sid-inc-fallback')
      expect(mocks.getHistoryTailFromFileMock).toHaveBeenCalledWith(
        'sid-inc-fallback', expect.anything(), expect.anything(), { maxBytes: HISTORY_BUDGET.MAX_BYTES },
      )
    })

    it('终审 minor：全量重建与缓存新鲜路径返回浅拷贝——调用方就地变更不打穿缓存', async () => {
      const client = setup.mountClient('sid-alias')
      const e1 = { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'q1' } }
      const m1 = { id: 'm1', role: 'user', content: 'q1' } as unknown as Message
      // 全量重建路径：getEntries() → entries [e1] → rebuild → 写缓存（leafId='e1'）
      client.getEntries.mockResolvedValueOnce({ data: { entries: [e1], leafId: 'e1' } })
      mocks.rebuildHistoryFromEntriesMock.mockReturnValueOnce({ messages: [m1], clientUuidMap: new Map() })
      const first = await setup.service.getHistory('sid-alias')
      expect(first.messages).toHaveLength(1)

      // 调用方就地污染全量重建的返回数组（模拟未来消费方就地 sort/splice/push）
      first.messages.push({ id: 'polluted' } as unknown as Message)

      // 缓存新鲜路径（空增量 = R-12 短路）：返回缓存副本，不受上面 push 影响
      client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e1' } })
      const second = await setup.service.getHistory('sid-alias')
      expect(second.messages).toHaveLength(1)
      // 且 second 与缓存本体分离：就地清空后第三次读取仍干净
      second.messages.length = 0
      client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e1' } })
      const third = await setup.service.getHistory('sid-alias')
      expect(third.messages).toHaveLength(1)
      expect(third.messages[0]).toBe(m1)
    })

    it('终审 minor：增量合并路径返回浅拷贝——就地清空返回数组不影响缓存', async () => {
      const client = setup.mountClient('sid-alias-inc')
      const m1 = { id: 'm1', role: 'user', content: 'q1', piEntryId: 'e1' } as unknown as Message
      client.getEntries.mockResolvedValueOnce({ data: { entries: [{ type: 'message', id: 'e1' }], leafId: 'e1' } })
      mocks.rebuildHistoryFromEntriesMock.mockReturnValueOnce({ messages: [m1], clientUuidMap: new Map() })
      await setup.service.getHistory('sid-alias-inc') // 写缓存（leafId='e1'）

      // 增量路径：delta 首条 parentId === cached.leafId → merge → 写缓存 → 返回 merged 副本
      const m2 = { id: 'm2', role: 'assistant', content: 'a1', piEntryId: 'e2' } as unknown as Message
      client.getEntries.mockResolvedValueOnce({
        data: { entries: [{ type: 'message', id: 'e2', parentId: 'e1' }], leafId: 'e2' },
      })
      // 增量路径直接访问 rebuilt.orphanToolResults（无 undefined 保护），mock 必须带该字段
      mocks.rebuildHistoryFromEntriesMock.mockReturnValueOnce({ messages: [m2], clientUuidMap: new Map(), orphanToolResults: [] })
      const inc = await setup.service.getHistory('sid-alias-inc')
      expect(inc.messages).toHaveLength(2)

      // 就地清空返回数组 → 缓存本体不受影响（随后空增量仍返回 2 条）
      inc.messages.length = 0
      client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e2' } })
      const after = await setup.service.getHistory('sid-alias-inc')
      expect(after.messages).toHaveLength(2)
    })

    it('reads from file directly when no active client', async () => {
      mocks.getHistoryTailFromFileMock.mockResolvedValueOnce({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      await setup.service.getHistory('no-client')
      // [D4] 离线尾读带字节预算缺省（与游标分支同源——原样透传 undefined 时仅按 turn 数截取）
      expect(mocks.getHistoryTailFromFileMock).toHaveBeenCalledWith(
        'no-client', expect.anything(), expect.anything(), { maxBytes: HISTORY_BUDGET.MAX_BYTES },
      )
    })
  })

  describe('listPersistedSessions', () => {
    it('groups persisted sessions by cwd', () => {
      mockScannedSessions.push(
        { id: 'a', filePath: '/fake/a.jsonl', cwd: '/proj', name: null, lastModified: 1, timestamp: '', size: 0, outcome: null },
        { id: 'b', filePath: '/fake/b.jsonl', cwd: '/proj', name: null, lastModified: 2, timestamp: '', size: 0, outcome: null },
        { id: 'c', filePath: '/fake/c.jsonl', cwd: '/other', name: null, lastModified: 3, timestamp: '', size: 0, outcome: null },
      )
      const groups = setup.service.listPersistedSessions() as SessionGroup[]
      const projGroup = groups.find(g => g.cwd === '/proj')
      expect(projGroup?.sessions.map(s => s.id).sort()).toEqual(['a', 'b'])
      expect(groups.find(g => g.cwd === '/other')?.sessions.length).toBe(1)
    })

    it('includes active sessions and excludes their duplicate file entries', async () => {
      const { id } = await setup.seedSession({ sessionFile: '/fake/dup.jsonl', cwd: tmpdir() })
      mockScannedSessions.push({
        id, filePath: '/fake/dup.jsonl', cwd: tmpdir(), name: null,
        lastModified: 1, timestamp: '', size: 0, outcome: null,
      })
      const groups = setup.service.listPersistedSessions()
      const allIds = groups.flatMap(g => g.sessions.map(s => s.id))
      // 活跃 session 出现一次，持久化副本被过滤
      expect(allIds.filter(x => x === id).length).toBe(1)
    })

    it('excludes hidden sessions (公共 session 不进 sidebar 列表)', async () => {
      const cwd = tmpdir()
      // 普通session：可见
      const { id: visibleId } = await setup.seedSession({ cwd, label: 'visible' })
      // 隐藏 session（公共 session）：应被过滤
      const { id: hiddenId } = await setup.seedSession({ cwd, label: 'public', hidden: true })

      const groups = setup.service.listPersistedSessions()
      const allIds = groups.flatMap(g => g.sessions.map(s => s.id))
      expect(allIds).toContain(visibleId)
      expect(allIds).not.toContain(hiddenId)
    })
  })

  describe('workflowAction + subagentAction（扩展 slash command 转发）', () => {
    it('workflowAction 转发 /workflows <action> <runId> 到 pi prompt', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.prompt).mockClear()
      await setup.service.workflowAction(id, 'abort', 'wf-run-1')
      expect(client.prompt).toHaveBeenCalledWith('/workflows abort wf-run-1')
    })

    it('workflowAction session 不活跃 → throw', async () => {
      await expect(setup.service.workflowAction('ghost', 'abort', 'wf-x')).rejects.toThrow('not active')
    })

    it('subagentAction cancel 转发 /subagents cancel <subagentId> 到 pi prompt', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.prompt).mockClear()
      await setup.service.subagentAction(id, 'cancel', { subagentId: 'bg-abc-1-123' })
      expect(client.prompt).toHaveBeenCalledWith('/subagents cancel bg-abc-1-123')
    })

    it('subagentAction session 不活跃 → throw', async () => {
      await expect(setup.service.subagentAction('ghost', 'cancel', { subagentId: 'bg-x' })).rejects.toThrow('not active')
    })

    it('subagentAction message 转发 /subagents message <subagentId> <text>', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.prompt).mockClear()
      await setup.service.subagentAction(id, 'message', { subagentId: 'sa-1', text: '汇报当前进度' })
      expect(client.prompt).toHaveBeenCalledWith('/subagents message sa-1 汇报当前进度')
    })

    it('subagentAction start 转发 /subagents start <slug> <task>', async () => {
      const { id, client } = await setup.seedSession()
      vi.mocked(client.prompt).mockClear()
      await setup.service.subagentAction(id, 'start', { slug: 'fix-login', task: '修复登录页 并写测试' })
      expect(client.prompt).toHaveBeenCalledWith('/subagents start fix-login 修复登录页 并写测试')
    })

    // ── 换行编码（转义协议，composer 四符号 §3.3.3 / 探针 P3）──
    // 命令必须单行：真实换行编码为字面 \n 两字符，原生反斜杠编码为 \\（防歧义），
    // extension 侧 decodeNewlineEscapes 互逆还原（两侧测试对同一 wire 协议双向钉死）。

    it('message text 含真实换行 → 编码为字面 \\n（命令保持单行）', async () => {
      const { id, client } = await setup.seedSession()
      await setup.service.subagentAction(id, 'message', { subagentId: 'sa-1', text: '第一行\n第二行' })
      // 期望串是字面反斜杠+n（源码里写 \\n）
      expect(client.prompt).toHaveBeenCalledWith('/subagents message sa-1 第一行\\n第二行')
    })

    it('message text 含字面反斜杠+n（如路径 C:\\new）→ 反斜杠转义，不与换行歧义', async () => {
      const { id, client } = await setup.seedSession()
      // 源码 'C:\\new' = 字面反斜杠 + n
      await setup.service.subagentAction(id, 'message', { subagentId: 'sa-1', text: '路径 C:\\new 的说明' })
      // 期望：反斜杠翻倍为 \\，n 保持字面
      expect(client.prompt).toHaveBeenCalledWith('/subagents message sa-1 路径 C:\\\\new 的说明')
    })

    it('start task 同样走换行编码', async () => {
      const { id, client } = await setup.seedSession()
      await setup.service.subagentAction(id, 'start', { slug: 'my-slug', task: '任务一\n任务二' })
      expect(client.prompt).toHaveBeenCalledWith('/subagents start my-slug 任务一\\n任务二')
    })

    // ── 转义协议互逆（encode ↔ extension decodeNewlineEscapes）──
    // decode 镜像：extension 侧 decodeNewlineEscapes 的等价实现（runtime 不依赖
    // extension 包，互逆性靠两侧测试对同一 wire 协议各自钉死）。
    const decodeMirror = (s: string): string =>
      s.replace(/\\\\|\\n/g, (m) => (m === '\\\\' ? '\\' : '\n'))

    it.each([
      ['原文含字面 \\n（反斜杠+n）', '路径 C:\\new folder'],
      ['原文含反斜杠（非 n 前缀）', '正则 \\d+ 与 \\\\server\\share'],
      ['原文含真实换行', '第一行\n第二行'],
      ['混合：反斜杠 + 真实换行 + 字面 \\n 同文', 'C:\\new\n正则 \\d+\n收尾'],
    ])('encodeDirectiveText 互逆（%s）→ decode(encode(x)) === x', (_label, original) => {
      expect(decodeMirror(encodeDirectiveText(original))).toBe(original)
    })

    it('encodeDirectiveText 产物不含真实换行（命令单行不变式）', () => {
      const encoded = encodeDirectiveText('a\nb\nc\\d')
      expect(encoded.includes('\n')).toBe(false)
    })

    // ── 必填字段 fail-fast（错误指向恢复动作：调用方补齐字段）──

    it('cancel 缺 subagentId → throw', async () => {
      const { id } = await setup.seedSession()
      await expect(setup.service.subagentAction(id, 'cancel', {})).rejects.toThrow('subagentId is required')
    })

    it('message 缺 text → throw', async () => {
      const { id } = await setup.seedSession()
      await expect(setup.service.subagentAction(id, 'message', { subagentId: 'sa-1' })).rejects.toThrow('subagentId and text are required')
    })

    it('start 缺 slug → throw', async () => {
      const { id } = await setup.seedSession()
      await expect(setup.service.subagentAction(id, 'start', { task: 't' })).rejects.toThrow('slug and task are required')
    })
  })

  describe('setSendMessageHook', () => {
    it('stores the hook (subsequent sendMessage uses it)', async () => {
      const client = setup.mountClient('sid-hook')
      const hook = vi.fn(async () => ({ blocked: false }))
      setup.service.setSendMessageHook(hook)
      await setup.service.sendMessage('sid-hook', 'x')
      expect(hook).toHaveBeenCalledWith('sid-hook', 'x')
    })
  })

  describe('destroyAll', () => {
    it('detaches, calls pm.destroyAll, clears map', async () => {
      const { id: id1 } = await setup.seedSession({ label: 's1' })
      const { id: id2 } = await setup.seedSession({ label: 's2' })
      await setup.service.destroyAll()
      expect(setup.pm.destroyAll).toHaveBeenCalledTimes(1)
      expect(setup.service.getSummary(id1)).toBeUndefined()
      expect(setup.service.getSummary(id2)).toBeUndefined()
    })
  })
})

// ───────────────────────────────────────────────────────────────────
// onSessionExit 回调（构造函数注册）
// ───────────────────────────────────────────────────────────────────

describe('SessionService · onSessionExit callback', () => {
  let setup: Setup
  beforeEach(() => {
    vi.clearAllMocks()
    resetMockState()
    autoId = 0
    setup = createSetup()
  })

  it('constructor registers a callback on pm.onSessionExit', () => {
    expect(setup.pm.onSessionExit).toHaveBeenCalledTimes(1)
    expect(typeof vi.mocked(setup.pm.onSessionExit).mock.calls[0][0]).toBe('function')
  })

  it('on exit: removes session, broadcasts list + session.exited', async () => {
    const { id } = await setup.seedSession()
    setup.triggerExit(id, 1)
    // session 已移除
    expect(setup.service.getSummary(id)).toBeUndefined()
    // 广播 config.sessions（刷新列表，D1 重命名 session.list → config.sessions）
    const listMsg = findBroadcast(setup, 'config.sessions')
    expect(listMsg).toBeDefined()
    // 广播 session.exited（含 exit code），不再用 message.error（消除双广播 + 语义分离）
    const exitedMsg = findBroadcast(setup, 'session.exited')
    expect(exitedMsg?.payload).toMatchObject({ sessionId: id, code: 1 })
    expect(String(exitedMsg?.payload.reason)).toContain('code: 1')
    // 不应再广播 message.error（session.exited 取代了它）
    const errMsg = findBroadcast(setup, 'message.error')
    expect(errMsg).toBeUndefined()
  })

  it('on exit: session.exited reason includes stderr when provided', async () => {
    const { id } = await setup.seedSession()
    setup.triggerExit(id, 1, 'Error: Failed to load extension "bad-ext"')
    const exitedMsg = findBroadcast(setup, 'session.exited')
    expect(exitedMsg?.payload).toMatchObject({ sessionId: id, code: 1 })
    // reason 含 stderr 内容（诊断价值）
    expect(String(exitedMsg?.payload.reason)).toContain('Failed to load extension')
  })

  it('on exit: session.exited reason is concise when stderr is empty', async () => {
    const { id } = await setup.seedSession()
    setup.triggerExit(id, 0, '')
    const exitedMsg = findBroadcast(setup, 'session.exited')
    expect(exitedMsg?.payload).toMatchObject({ sessionId: id, code: 0 })
    expect(String(exitedMsg?.payload.reason)).toBe('Session process exited (code: 0)')
  })

  it('on exit: adapter.detach is invoked (W3: usage listener removed, EventAdapter sole listener)', async () => {
    // 用可观测的 adapter 工厂捕获 detach
    const detachSpy = vi.fn()
    const attachSpy = vi.fn()
    const localSetup = createSetup()
    // 替换 adapterFactory：直接 new 一个带 spy 的 service
    const localService = new SessionService(
      localSetup.pm,
      localSetup.broker,
      () => ({ attach: attachSpy, detach: detachSpy }),
      '/tmp',
      localSetup.extensionService,
      new PiConfigStore(),
      new PiSessionStore(),
      localSetup.gitInfoReader,
      { record: vi.fn(), list: vi.fn().mockReturnValue([]) } as unknown as ConstructorParameters<typeof SessionService>[8],
    )
    const piSid = 'pi-detach-1'
    const client = makeMockClient({
      // W2 收口后 create 用 client.getState()，返回归一后的 state 对象
      getState: vi.fn<() => Promise<Record<string, unknown> | undefined>>().mockResolvedValue({
        sessionId: piSid, sessionFile: `/fake/${piSid}.jsonl`,
      }),
    })
    vi.mocked(localSetup.pm.createSession).mockResolvedValueOnce(client as unknown as IPiEngine)
    localSetup.clientMap.set(piSid, client)
    await localService.create(tmpdir(), 'l')
    expect(attachSpy).toHaveBeenCalledTimes(1)
    localSetup.triggerExit(piSid, 0)
    expect(detachSpy).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the exited session is unknown', async () => {
    setup.triggerExit('ghost', 0)
    // 不应该广播 session.exited（只有已知 session 才广播）
    const exitedMsg = findBroadcast(setup, 'session.exited')
    expect(exitedMsg).toBeUndefined()
  })
})

// ── wave:runtime-patch ipc-converge-a3 W2：业务持久化写迁移的安全守卫回归 ──
// 背景：write-session-image / migrate-session-image / write-segments-metadata 三个 IPC handler
// 从 main 迁到 runtime session-service（WS：session.writeImage/migrateImage/writeSegments）时，
// 原 Electron 测试（apps/electron/main/test/privileged-handlers.test.ts，-476 行）未随迁，
// 安全守卫（20MB 上限 / mimeType image/* / name sanitize 防目录穿越 / fromPath 白名单 /
// segments.json 原子写 + 损坏恢复）失去唯一回归保护。以下用例按 runtime 真实 API 签名
// （service 直接调用，非 IPC handler 形态）移植，断言强度与原用例一致（TC3 零削弱）。
//
// 真实文件 I/O：writeImage/migrateImage/writeSegmentsMetadata 写真实 attachments/tmpdir 文件，
// 测试读回校验后清理。不 mock node:fs/os/path——这些模块 mock 会破坏同文件其他用例。
// dataDir 由 vitest globalSetup 的 XYZ_AGENT_DATA_DIR 指向 tmp 目录，不会污染用户数据。
describe('SessionService · 业务持久化写安全守卫（W2 ipc-converge-a3 移植）', () => {
  let service: SessionService

  beforeEach(() => {
    vi.clearAllMocks()
    service = createSetup().service
  })

  const writtenPaths: string[] = []
  afterEach(() => {
    for (const p of writtenPaths.splice(0)) {
      try { rmSync(p) } catch { /* 忽略清理失败 */ }
    }
  })

  describe('writeImage（原 write-session-image IPC handler）', () => {
    it('W3TC3: panel 态（sessionId 非空）→ 写 attachments/<sessionId>/ 返回 {path,fileName,displayName,id,persisted:true}', async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
      const result = await service.writeImage('sess-panel-1', bytes.toString('base64'), 'image/png', 'shot.png')
      writtenPaths.push(result.path)
      // path 在 <dataDir>/attachments/sess-panel-1/ 下
      const expectedDir = getAttachmentsDir('sess-panel-1')
      expect(result.path.startsWith(expectedDir)).toBe(true)
      // 文件真实写入 + 内容 round-trip
      expect(existsSync(result.path)).toBe(true)
      expect(Array.from(readFileSync(result.path))).toEqual(Array.from(bytes))
      // fileName 是 uuid-shot.png 格式（含 uuid 前缀）
      expect(result.fileName).toMatch(/^[0-9a-f-]+-shot\.png$/)
      // displayName 用 sanitized basename（无 uuid 前缀），用户传 'shot.png' → 'shot.png'
      expect(result.displayName).toBe('shot.png')
      // id 是 uuid 格式
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      // M1：sessionId 非空 → 落 attachments → persisted=true（不需迁移）
      expect(result.persisted).toBe(true)
    })

    it('W3TC4: landing 降级（sessionId 为空）→ 写 tmpdir 返回 {path,fileName,displayName,id,persisted:false}', async () => {
      const bytes = Buffer.from([0x01])
      const result = await service.writeImage('', bytes.toString('base64'), 'image/png', 'x.png')
      writtenPaths.push(result.path)
      // path 在 tmpdir 下（降级路径）
      expect(result.path.startsWith(tmpdir())).toBe(true)
      expect(existsSync(result.path)).toBe(true)
      // id 是 uuid 格式
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      // M1：sessionId 空 → 落 tmpdir → persisted=false（session 创建后需迁移）
      expect(result.persisted).toBe(false)
    })

    it('W3TC5: 非 image/* mimeType → throw「mimeType must start with image/」（ERR1）', async () => {
      await expect(service.writeImage('s1', 'x', 'text/plain', 'x')).rejects.toThrow('mimeType must start with image/')
    })

    it('W3TC6: 超过 20MB → throw「图片过大...20MB」（ERR2 ATTACH_TOO_LARGE）不写文件', async () => {
      const targetBytes = 21 * 1024 * 1024
      const base64Len = Math.ceil((targetBytes * 4) / 3)
      await expect(service.writeImage('s1', 'A'.repeat(base64Len), 'image/png', 'big.png')).rejects.toThrow(/图片过大.*20MB/)
    })

    it('W3TC7: name 含路径分隔符 → sanitize 剥离，path 不逃逸 attachments 目录', async () => {
      const result = await service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/png', '../../etc/passwd.png')
      writtenPaths.push(result.path)
      // path 不含穿越片段
      expect(result.path).not.toContain('etc/passwd')
      // path 仍在 attachments/s1 下
      const expectedDir = getAttachmentsDir('s1')
      expect(result.path.startsWith(expectedDir)).toBe(true)
      expect(existsSync(result.path)).toBe(true)
    })

    it('W3TC8: 19MB（上限内）→ 正常写入不 throw', async () => {
      // 用 19MB（上限 20MB 内，留余量避开 base64 padding 估算误差）验证大图正常落地。
      const bytes = Buffer.alloc(19 * 1024 * 1024, 0x01)
      const result = await service.writeImage('s1', bytes.toString('base64'), 'image/png', 'big.png')
      writtenPaths.push(result.path)
      expect(existsSync(result.path)).toBe(true)
    })

    it('mimeType=image/jpeg → ext=jpg', async () => {
      const result = await service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/jpeg', 'pic')
      writtenPaths.push(result.path)
      expect(result.fileName.endsWith('.jpg')).toBe(true)
      expect(result.displayName.endsWith('.jpg')).toBe(true)
    })

    it('拖拽/+菜单（name 非空）→ displayName 用原 basename（sanitized + .ext）', async () => {
      const result = await service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/png', 'photo.png')
      writtenPaths.push(result.path)
      // displayName 用 sanitized basename，无 uuid 前缀
      expect(result.displayName).toBe('photo.png')
      // fileName 含 uuid 前缀
      expect(result.fileName).toMatch(/^[0-9a-f-]+-photo\.png$/)
    })

    it('粘贴截图（name 为空，sanitized 退化 image）→ displayName 形如 截图-YYYYMMDD-HHMM.png', async () => {
      const result = await service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/png', '')
      writtenPaths.push(result.path)
      // fileName 仍是 uuid-image.png 形式（uuid 前缀 + 占位 basename）
      expect(result.fileName).toMatch(/^[0-9a-f-]+-image\.png$/)
      // displayName 走截图-时间戳 分支（正则校验，不硬编码时间）
      expect(result.displayName).toMatch(/^截图-\d{8}-\d{4}\.png$/)
    })

    it('写入失败 → throw「write-session-image failed」+ console.error（超长文件名触发 ENAMETOOLONG）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(
        service.writeImage('s1', Buffer.from([0x01]).toString('base64'), 'image/png', 'a'.repeat(5000)),
      ).rejects.toThrow('write-session-image failed')
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })

  describe('migrateImage（原 migrate-session-image IPC handler）', () => {
    // 真实文件 I/O：migrate 把 tmpdir 文件 move 到 attachments 目录。
    it('happy path: landing 写 tmpdir 后 migrate 到 attachments/<sessionId>/，原 tmpdir 文件已 move', async () => {
      // 1. landing 态先写 tmpdir（sessionId 为空）
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const writeResult = await service.writeImage('', bytes.toString('base64'), 'image/png', 'shot.png')
      writtenPaths.push(writeResult.path)
      const tmpPath = writeResult.path
      expect(existsSync(tmpPath)).toBe(true)
      // 2. session 创建后 migrate 到真实 sessionId
      const migrateResult = await service.migrateImage(tmpPath, 'sess-real-1', writeResult.fileName)
      writtenPaths.push(migrateResult.path)
      // 新 path 在 attachments 目录下
      const expectedDir = getAttachmentsDir('sess-real-1')
      expect(migrateResult.path.startsWith(expectedDir)).toBe(true)
      expect(migrateResult.path.endsWith(writeResult.fileName)).toBe(true)
      // 新文件存在 + 内容 round-trip
      expect(existsSync(migrateResult.path)).toBe(true)
      expect(Array.from(readFileSync(migrateResult.path))).toEqual(Array.from(bytes))
      // 原 tmpdir 文件已被 move（不存在）—— rename 是 move 不是 copy
      expect(existsSync(tmpPath)).toBe(false)
    })

    it('fromPath 不存在 → reject（throw），可被 catch 降级', async () => {
      const ghostPath = join(tmpdir(), 'definitely-not-exist-' + Date.now() + '.png')
      expect(existsSync(ghostPath)).toBe(false)
      await expect(service.migrateImage(ghostPath, 'sess-1', 'x.png')).rejects.toThrow(/source file not found/)
    })

    it('sessionId 为空 → throw requires non-empty sessionId', async () => {
      // 先写一个 tmpdir 文件让 fromPath 真实存在，验证空 sessionId 早于 fs 检查就 throw
      const writeResult = await service.writeImage('', Buffer.from([0x01]).toString('base64'), 'image/png', 'x.png')
      writtenPaths.push(writeResult.path)
      await expect(service.migrateImage(writeResult.path, '', writeResult.fileName)).rejects.toThrow(
        'migrate-session-image requires non-empty sessionId',
      )
    })

    it('B1: fromPath 在白名单外（home 目录）→ throw，不 move 文件（防任意文件移动）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // 白名单外 fixture：需同时满足「vitest fs-guard 可写区」与「migrateImage 白名单
      // （tmpdir ∪ attachments）之外」——差集 = dev 数据目录 ~/.xyz-agent-dev（fs-guard
      // 白名单成员，不在 tmpdir 前缀内）。原 home 路径在 fs-guard 下不可写。
      const guardWritableDir = join(homedir(), '.xyz-agent-dev')
      mkdirSync(guardWritableDir, { recursive: true })
      const evilFile = join(guardWritableDir, '.xyz-agent-test-evil-' + Date.now() + '.txt')
      writeFileSync(evilFile, 'secret')
      writtenPaths.push(evilFile)
      expect(existsSync(evilFile)).toBe(true)
      await expect(service.migrateImage(evilFile, 'sess-b1', 'leaked.txt')).rejects.toThrow('migrate-session-image failed')
      // 原文件仍在原位（未被 move）
      expect(existsSync(evilFile)).toBe(true)
      // 目标 attachments 目录下没有 leaked.txt
      expect(existsSync(join(getAttachmentsDir('sess-b1'), 'leaked.txt'))).toBe(false)
      errSpy.mockRestore()
    })

    it('B1: fileName 含路径分隔符 → sanitize 剥离，newPath 落在 attachments/<sid>/ 下不穿越', async () => {
      // 先在 tmpdir 造一个 fromPath（合法来源）
      const bytes = Buffer.from([0x01, 0x02])
      const fromPath = join(tmpdir(), 'xyz-test-migrate-' + Date.now() + '.png')
      writeFileSync(fromPath, bytes)
      writtenPaths.push(fromPath)
      // fileName 含穿越片段
      const result = await service.migrateImage(fromPath, 'sess-sanitize', '../../../etc/foo.png')
      writtenPaths.push(result.path)
      // newPath 落在 attachments/sess-sanitize/ 下（starts with 守门，穿越后不会满足）
      const expectedDir = getAttachmentsDir('sess-sanitize')
      expect(result.path.startsWith(expectedDir)).toBe(true)
      // 路径分隔符被剥离——结果路径相对 expectedDir 只剩一个扁平文件名（不含任何 / 或 \ 段）
      const rel = relative(expectedDir, result.path)
      expect(rel).not.toMatch(/[\\/]/)
      // 文件已 move 到 newPath，内容 round-trip
      expect(existsSync(result.path)).toBe(true)
      expect(Array.from(readFileSync(result.path))).toEqual(Array.from(bytes))
      expect(existsSync(fromPath)).toBe(false)
    })

    it('B1: sessionId 含 ../ → throw（getAttachmentsDir 校验防路径穿越）', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // 在 tmpdir 造合法来源文件（绕过 fromPath 白名单，专门测 sessionId 校验）
      const fromPath = join(tmpdir(), 'xyz-test-migrate-sid-' + Date.now() + '.png')
      writeFileSync(fromPath, Buffer.from([0x01]))
      writtenPaths.push(fromPath)
      await expect(service.migrateImage(fromPath, '../etc', 'x.png')).rejects.toThrow('migrate-session-image failed')
      // 原文件未被 move
      expect(existsSync(fromPath)).toBe(true)
      errSpy.mockRestore()
    })
  })

  describe('writeSegmentsMetadata（原 write-segments-metadata IPC handler）', () => {
    // 真实文件 I/O：复用 writeImage 测试的 tmpdir 清理模式（afterEach rmSync）。
    // 每个用例用独立 sessionId 子目录，互不干扰（getAttachmentsDir 按 sessionId 分区）。
    //
    // 注意：read-segments-metadata handler 已删除（W6），原 round-trip 校验改用 readFileSync
    // 直接读 segments.json 验证落地内容（不再经 IPC read）。
    const writtenDirs: string[] = []
    afterEach(() => {
      for (const d of writtenDirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) } catch { /* 忽略清理失败 */ }
      }
    })

    /** 构造一条测试用 segments entry（含 text/image/file 段，覆盖实际 user message 形态） */
    function makeEntry(clientUuid: string, timestamp = 1234567890): SegmentsMetadataEntry {
      return {
        clientUuid,
        segments: [
          { type: 'text', text: '看下这张图' },
          {
            type: 'image',
            id: 'img-id-1',
            path: '/tmp/foo.png',
            fileName: 'foo.png',
            displayName: 'foo.png',
          },
          { type: 'file', path: '/repo/src/index.ts', lineRange: [10, 20] },
        ],
        timestamp,
      }
    }

    /** 读 segments.json 并 parse（替代已删的 read-segments-metadata IPC，纯测试辅助） */
    function readSidecar(sessionId: string): SegmentsMetadataFile {
      const raw = readFileSync(join(getAttachmentsDir(sessionId), 'segments.json'), 'utf-8')
      return JSON.parse(raw) as SegmentsMetadataFile
    }

    it('write 单条 → 落地 segments.json 含该条（round-trip 保真）', async () => {
      const sessionId = 'seg-test-write-read-single'
      writtenDirs.push(getAttachmentsDir(sessionId))

      const entry = makeEntry('u-aaa')
      await service.writeSegmentsMetadata(sessionId, entry)

      const file = readSidecar(sessionId)
      expect(file.version).toBe(1)
      expect(file.entries).toHaveLength(1)
      expect(file.entries[0]).toEqual(entry)
    })

    it('write 多条（不同 clientUuid）→ 落地含全部', async () => {
      const sessionId = 'seg-test-write-multi'
      writtenDirs.push(getAttachmentsDir(sessionId))

      await service.writeSegmentsMetadata(sessionId, makeEntry('u-1', 1000))
      await service.writeSegmentsMetadata(sessionId, makeEntry('u-2', 2000))
      await service.writeSegmentsMetadata(sessionId, makeEntry('u-3', 3000))

      const file = readSidecar(sessionId)
      expect(file.entries).toHaveLength(3)
      expect(file.entries.map((e) => e.clientUuid).sort()).toEqual(['u-1', 'u-2', 'u-3'])
    })

    it('write 同 clientUuid 两次（editAndResend 场景）→ 后者覆盖前者，不重复', async () => {
      const sessionId = 'seg-test-edit-resend'
      writtenDirs.push(getAttachmentsDir(sessionId))

      const v1 = makeEntry('u-overwrite', 1000)
      const v2 = makeEntry('u-overwrite', 9999)
      // 改 v2 的 segments 内容，验证覆盖的是后者而非前者
      v2.segments = [{ type: 'text', text: 'edited' }]
      await service.writeSegmentsMetadata(sessionId, v1)
      await service.writeSegmentsMetadata(sessionId, v2)

      const file = readSidecar(sessionId)
      expect(file.entries).toHaveLength(1)
      expect(file.entries[0].timestamp).toBe(9999)
      expect(file.entries[0].segments).toEqual([{ type: 'text', text: 'edited' }])
    })

    it('write 时目录不存在 → 自动创建并写入', async () => {
      const sessionId = 'seg-test-mkdir-' + Date.now()
      const dir = getAttachmentsDir(sessionId)
      writtenDirs.push(dir)
      // 目录不存在
      expect(existsSync(dir)).toBe(false)

      await service.writeSegmentsMetadata(sessionId, makeEntry('u-mkdir'))
      // 目录 + segments.json 已创建
      expect(existsSync(dir)).toBe(true)
      expect(existsSync(join(dir, 'segments.json'))).toBe(true)
      const file = readSidecar(sessionId)
      expect(file.entries).toHaveLength(1)
    })

    it('write 到已损坏的 segments.json → 隔离现场后写入成功（D1c，best-effort，不阻断）', async () => {
      const sessionId = 'seg-test-write-corrupted-' + Date.now()
      const dir = getAttachmentsDir(sessionId)
      writtenDirs.push(dir)
      // 先构造半截 JSON（模拟写盘半途崩溃的磁盘残留）
      mkdirSync(dir, { recursive: true })
      const halfJson = '{"version": 1, "entries": [{"clientUuid": "u-lo'
      writeFileSync(join(dir, 'segments.json'), halfJson, 'utf-8')

      // fake timers 冻结时间戳 → .corrupt-<ts> 副本路径确定可断言（json-store.test.ts 同款）
      const FROZEN_ISO = '2026-01-01T00:00:00.000Z'
      vi.useFakeTimers()
      vi.setSystemTime(new Date(FROZEN_ISO))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // write 不抛（隔离半截文件 → 以空文件基底写入成功）
      await service.writeSegmentsMetadata(sessionId, makeEntry('u-recover'))

      // error 日志含路径与恢复指引（断言在 mockRestore 前——restore 会清 mock.calls）
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logMsg = String(errorSpy.mock.calls[0]!.join(' '))
      expect(logMsg).toContain('segments.json malformed')
      expect(logMsg).toContain('恢复指引')
      errorSpy.mockRestore()
      vi.useRealTimers()

      // 原文隔离至 .corrupt-<ts> 副本且内容不变（取证现场），原位置是合法新文件
      const corruptPath = join(dir, `segments.json.corrupt-${FROZEN_ISO.replace(/[:.]/g, '')}`)
      expect(existsSync(corruptPath)).toBe(true)
      expect(readFileSync(corruptPath, 'utf-8')).toBe(halfJson)
      const file = readSidecar(sessionId)
      expect(file.entries).toHaveLength(1)
      expect(file.entries[0].clientUuid).toBe('u-recover')
    })

    it('write 空 sessionId → throw requires non-empty sessionId', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(service.writeSegmentsMetadata('', makeEntry('u-x'))).rejects.toThrow(
        'write-segments-metadata requires non-empty sessionId',
      )
      errSpy.mockRestore()
    })

    it('atomic 写：临时文件 .tmp 写完才 rename（写后 .tmp 不残留）', async () => {
      const sessionId = 'seg-test-atomic-' + Date.now()
      const dir = getAttachmentsDir(sessionId)
      writtenDirs.push(dir)

      await service.writeSegmentsMetadata(sessionId, makeEntry('u-atomic'))
      // segments.json 存在，.tmp 不残留（已 rename 走）
      expect(existsSync(join(dir, 'segments.json'))).toBe(true)
      expect(existsSync(join(dir, 'segments.json.tmp'))).toBe(false)
    })
  })
})
