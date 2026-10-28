import { PiConfigStore } from '../src/infra/pi/pi-config-store.js';
import { PiSessionStore } from '../src/infra/pi/session-store.js';
import { IEventAdapter, type IExtensionService, type IMessageBroker } from '../src/interfaces.js';
import type { IMessageBus } from '../src/services/message-bus/message-bus.js';
import { SessionEventDispatch } from '../src/services/plugin-service/api/session-api.js';
import type { IConfigStore } from '../src/services/ports/config.js';
import type { IGitInfoReader } from '../src/services/ports/git-info.js';
import { IPiEngine, PiEventListener, type IProcessManager } from '../src/services/ports/pi-engine.js';
import type { ISessionStore } from '../src/services/ports/session.js';
import type { SessionRecords } from '../src/services/session/session-records.js';
import { SessionService } from '../src/services/session/session-service.js';
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js';
import { SessionMessageHandler } from '../src/transport/session-message-handler.js';
import { SessionSummary, SubagentRecord, type ClientMessage, type Message, type ServerMessage } from '@taiji/shared';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/session-activate-relay.test.ts
// ======================================================================

// ── session-service 侧（追加式回调列表语义，contract-hardening removeSessionEntry 用例同款最小装配）──

function makeSessionService(): SessionService {
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => undefined),
    destroySession: vi.fn(async () => {}),
    destroyAll: vi.fn(async () => {}),
  } as unknown as ConstructorParameters<typeof SessionService>[0] as IProcessManager
  const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as unknown as IMessageBroker
  return new SessionService(
    pm,
    broker,
    vi.fn(),
    '/project-root',
    {} as unknown as IExtensionService,
    {} as unknown as IConfigStore,
    {} as unknown as ISessionStore,
    {} as unknown as ConstructorParameters<typeof SessionService>[7],
    {} as unknown as WorkspaceService,
  )
}


const summaryOf = (id: string): SessionSummary =>
  ({ id, label: `L-${id}`, cwd: '/p', status: 'active', lastActiveAt: 1 }) as SessionSummary


// ── transport relay ①（session.switch 成功分支 → notifySessionActivated）──

type SwitchCtx = {
  replies: Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>
  errors: Array<{ code: string; message: string }>
  notifySpy: ReturnType<typeof vi.fn> | undefined
  summaries: Array<SessionSummary | undefined>
  restoredSummary: SessionSummary | undefined
  ensureActiveError: Error | undefined
}


function makeSwitchHarness(opts: { notify?: boolean } = {}) {
  const cap: SwitchCtx = {
    replies: [],
    errors: [],
    notifySpy: opts.notify === false ? undefined : vi.fn(),
    summaries: [],
    restoredSummary: undefined,
    ensureActiveError: undefined,
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string) => {
      cap.errors.push({ code, message })
    }),
    sessionService: {
      markSessionViewed: vi.fn(),
      getSummary: vi.fn((_sid: string) => {
        // 首查（switch 入口）按队列返回（可为 undefined = 未命中走 restore）；restore 后
        // 再查返回 restoredSummary
        if (cap.summaries.length > 0) return cap.summaries.shift()
        return cap.restoredSummary ?? undefined
      }),
      ensureActive: vi.fn(async () => {
        if (cap.ensureActiveError) throw cap.ensureActiveError
        return { touchActivity: vi.fn() }
      }),
      ...(cap.notifySpy ? { notifySessionActivated: cap.notifySpy } : {}),
    },
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  const switchMsg = (sid: string): ClientMessage =>
    ({ type: 'session.switch', id: 'req-1', payload: { sessionId: sid } }) as unknown as ClientMessage
  return { handler, cap, switchMsg }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-activate-relay', () => {
describe('session-service.notifySessionActivated 追加式回调（u5a：禁单槽回归锁）', () => {
  it('多个回调都收到（二次注册不覆盖——setOnSessionCreated 式单槽的反面教材不再现）', () => {
    const svc = makeSessionService()
    const seen1: string[] = []
    const seen2: string[] = []
    const seen3: string[] = []
    svc.onSessionActivated(s => seen1.push(s.id))
    svc.onSessionActivated(s => seen2.push(s.id))
    svc.onSessionActivated(s => seen3.push(s.id))

    svc.notifySessionActivated(summaryOf('s-a'))
    svc.notifySessionActivated(summaryOf('s-b'))

    expect(seen1).toEqual(['s-a', 's-b'])
    expect(seen2).toEqual(['s-a', 's-b'])
    expect(seen3).toEqual(['s-a', 's-b'])
  })

  it('单回调异常被隔离：其余回调照常收到，异常不外抛（notifySessionCreated 同款 best-effort）', () => {
    const svc = makeSessionService()
    const seen: string[] = []
    svc.onSessionActivated(() => { throw new Error('listener boom') })
    svc.onSessionActivated(s => seen.push(s.id))

    expect(() => svc.notifySessionActivated(summaryOf('s-x'))).not.toThrow()
    expect(seen).toEqual(['s-x'])
  })

  it('无回调时 no-op 不抛', () => {
    const svc = makeSessionService()
    expect(() => svc.notifySessionActivated(summaryOf('s-y'))).not.toThrow()
  })
})
describe('relay ①：session.switch 成功 → notifySessionActivated 投递（mock ctx）', () => {
  it('summary 命中分支：注册的回调收到该 summary，switch reply 不变', async () => {
    const { handler, cap, switchMsg } = makeSwitchHarness()
    cap.summaries = [summaryOf('s-live')]

    await handler.handleSessionMessage(switchMsg('s-live'), {} as never)

    expect(cap.notifySpy).toHaveBeenCalledTimes(1)
    expect(cap.notifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: 's-live' }))
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]!.type).toBe('session.switched')
    expect(cap.replies[0]!.payload).toMatchObject({ sessionId: 's-live' })
  })

  it('自动 restore 分支：restore 成功 → 回调收到 restored summary（冷启动/崩溃恢复补充拉取承接）', async () => {
    const { handler, cap, switchMsg } = makeSwitchHarness()
    cap.summaries = [undefined] // 入口首查未命中 → 走 ensureActive
    cap.restoredSummary = summaryOf('s-restored')

    await handler.handleSessionMessage(switchMsg('s-restored'), {} as never)

    expect(cap.notifySpy).toHaveBeenCalledTimes(1)
    expect(cap.notifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: 's-restored' }))
    expect(cap.replies[0]!.type).toBe('session.switched')
  })

  it('restore 失败：不投递（error envelope 路径），回调零调用', async () => {
    const { handler, cap, switchMsg } = makeSwitchHarness()
    cap.summaries = [undefined]
    cap.ensureActiveError = new Error('restore boom')

    await handler.handleSessionMessage(switchMsg('s-dead'), {} as never)

    expect(cap.notifySpy).not.toHaveBeenCalled()
    expect(cap.replies).toHaveLength(0)
    expect(cap.errors).toHaveLength(1)
  })

  it('最小 mock 缺 notifySessionActivated 成员：switch 照常成功（可选链防御，与 markSessionViewed 同款）', async () => {
    const { handler, cap, switchMsg } = makeSwitchHarness({ notify: false })
    cap.summaries = [summaryOf('s-min')]

    await expect(handler.handleSessionMessage(switchMsg('s-min'), {} as never)).resolves.toBeUndefined()
    expect(cap.replies[0]!.type).toBe('session.switched')
  })
})
// ── relay ③ 消费侧（SessionEventDispatch.didActivate：u5b 落地前表恒空 = no-op）──

describe('SessionEventDispatch.didActivate（u5a 最小接口）', () => {
  it('无注册者时零 notify、不抛（registerActivate 随 u5b 落地后此表才开始有条目）', () => {
    const notify = vi.fn()
    const dispatch = new SessionEventDispatch({ notify } as unknown as ConstructorParameters<typeof SessionEventDispatch>[0])

    expect(() => dispatch.didActivate({ id: 's1', label: 'l', cwd: '/p', status: 'active', createdAt: 0, lastActiveAt: 1 })).not.toThrow()
    expect(notify).not.toHaveBeenCalled()
  })
})
});

// ======================================================================
// ← test/session-service-agent-call.test.ts
// ======================================================================

vi.mock('../src/infra/pi/session-file-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/session-file-utils.js')>()
  return { ...actual, scanPiSessions: () => [], parseSessionHeader: vi.fn() }
})

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/tmp/pi-agent' }
})

vi.mock('../src/services/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-history.js')>()
  return { ...actual, getHistoryFromFile: vi.fn().mockResolvedValue([]),
  getHistoryFromFilePath: vi.fn().mockResolvedValue([]), }
})

vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return {
    ...actual,
    refreshAll: vi.fn(),
    getDefaultModel: () => ({ provider: 'test', modelId: 'test' }),
    getSkillPaths: () => [],
    readModels: () => ({ providers: {} }),
    readSettings: () => ({}),
  }
})

vi.mock('../src/infra/system/trash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/system/trash.js')>()
  return { ...actual, trash: vi.fn() }
})

vi.mock('../src/infra/pi/message-converter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/message-converter.js')>()
  return { ...actual, convertPiHistory: vi.fn((r) => r) }
})
function createService(): SessionService {
  const pm = {
    getClient: vi.fn(() => null),
    list: vi.fn(() => []),
    createSession: vi.fn(),
    destroySession: vi.fn(),
    hasClient: vi.fn(() => false),
    onSessionExit: vi.fn(),
    destroyAll: vi.fn(),
  } as never
  const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as never
  const adapterFactory = vi.fn(() => ({ attach: vi.fn(), detach: vi.fn() })) as never
  const extensionService = { getExtensionPaths: vi.fn().mockResolvedValue([]) } as never
  const gitInfoReader = { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() } as never
  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) } as never
  return new SessionService(
    pm,
    broker,
    adapterFactory,
    '/tmp',
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService,
  )
}


// ── getAgentCallFilePath（自 session-service-agent-call-path.test.ts 并入）──────────
// agent call 经 record.sessionFile 定位（subagentId → record）。返回路径字符串，
// 找不到 record / 无 sessionFile / 路径穿越 → 空串（展示型功能，不 throw）。

/** S6 迁移：getSubagents 实现落位 session-records，观察点随迁到 records 实例。 */
function recordsRef(service: SessionService): SessionRecords {
  return (service as unknown as { records: SessionRecords }).records
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-agent-call', () => {
describe('SessionService.getAgentCallHistory', () => {
  it('委托 getSubagentHistory：同参透传 + 返回其结果（agent call 是 subagent，sa-xxx 经 record 查找）', async () => {
    const service = createService()
    const fakeMessages: Message[] = [
      { id: 'm1', role: 'user', content: 'hello', status: 'complete', timestamp: 1689222883000 },
    ]
    // S6 迁移：getSubagentHistory 实现落位 session-records，观察点随迁到 records 实例
    //（Facade.getAgentCallHistory 一行委托 → records.getAgentCallHistory → records.getSubagentHistory）
    const { records } = service as unknown as { records: SessionRecords }
    const spy = vi.spyOn(records, 'getSubagentHistory').mockResolvedValue({ messages: fakeMessages, truncated: false })

    const result = await service.getAgentCallHistory('main-sess-001', 'sa-agentcall-001')

    expect(spy).toHaveBeenCalledWith('main-sess-001', 'sa-agentcall-001')
    expect(result).toEqual({ messages: fakeMessages, truncated: false })
  })

  it('getSubagentHistory 返回空数组时透传（找不到 record 不 throw，前端显空对话流非错误态）', async () => {
    const service = createService()
    const { records } = service as unknown as { records: SessionRecords }
    vi.spyOn(records, 'getSubagentHistory').mockResolvedValue({ messages: [], truncated: false })

    const result = await service.getAgentCallHistory('main-sess', 'sa-missing')

    expect(result).toEqual({ messages: [], truncated: false })
  })
})
describe('SessionService.getAgentCallFilePath', () => {
  beforeEach(() => vi.clearAllMocks())

  it('record 有 sessionFile（在 piAgentDir 下）→ 返回路径', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue({
      records: [
        { subagentId: 'sa-001', sessionFile: '/tmp/pi-agent/subagents/enc/sa-001.jsonl' } as SubagentRecord,
      ],
      oversize: false,
      found: true,
    })
    const result = await service.getAgentCallFilePath('main-sess', 'sa-001')
    expect(result).toBe('/tmp/pi-agent/subagents/enc/sa-001.jsonl')
  })

  it('找不到 record → 空串', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue({ records: [], oversize: false, found: true })
    expect(await service.getAgentCallFilePath('main-sess', 'sa-missing')).toBe('')
  })

  it('record 无 sessionFile（null）→ 空串', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue({
      records: [
        { subagentId: 'sa-001', sessionFile: null } as SubagentRecord,
      ],
      oversize: false,
      found: true,
    })
    expect(await service.getAgentCallFilePath('main-sess', 'sa-001')).toBe('')
  })

  it('sessionFile 路径穿越（不在 piAgentDir 下）→ 空串（isStrictlyUnder 安全校验）', async () => {
    const service = createService()
    vi.spyOn(recordsRef(service), 'getSubagents').mockResolvedValue({
      records: [
        { subagentId: 'sa-001', sessionFile: '/etc/passwd' } as SubagentRecord,
      ],
      oversize: false,
      found: true,
    })
    expect(await service.getAgentCallFilePath('main-sess', 'sa-001')).toBe('')
  })
})
});

// ======================================================================
// ← test/session-service-respawn.test.ts
// ======================================================================

type MockClient = IPiEngine & { exited: boolean; kill: ReturnType<typeof vi.fn> }


function makeMockClient(overrides: Partial<Record<string, unknown>> = {}): MockClient {
  const client = {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    setSessionName: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ data: { messages: [] } }),
    getEntries: vi.fn().mockResolvedValue({ data: { entries: [], leafId: null } }),
    sendCommand: vi.fn().mockResolvedValue({ data: {} }),
    switchSession: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ sessionId: 'pi-x', sessionFile: '/fake/pi-x.jsonl' }),
    getCommands: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue({}),
    onEvent: vi.fn((_l: PiEventListener) => () => {}),
    onExit: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    // lastActivityAt：活动时钟观测范围（IPiEngine 结构要求）
    lastActivityAt: 0,
    exited: false,
    ...overrides,
  }
  return client as unknown as MockClient
}


interface Setup {  // oe-exempt:20261027:test:
  service: SessionService
  messageBus: IMessageBus
  clientMap: Map<string, MockClient>
  /** pm.createSession 的 spy（进程数观测点）；交叉签名供替身内直接调用（spawn 步镜像）。 */
  createSessionSpy: ReturnType<typeof vi.fn> & ((sessionId: string, cwd: string) => Promise<IPiEngine>)
  triggerExit: (sessionId: string, code: number | null, stderr?: string) => void
  /** 注册一个 session 到 lifecycle Map（绕过 spawn 链，直接走注册汇聚点；await 落 Map 后返回）。 */
  register: (sessionId: string, sessionFilePath?: string) => Promise<MockClient>
  /** 以受控 deferred 模拟 restore 内核（含一次 pm.createSession = spawn 进程数观测点）。 */
  spyRestoreWithDeferred: (sessionId: string) => { spy: ReturnType<typeof vi.fn>; resolve: () => void; reject: (e: unknown) => void }
}


function createSetup(): Setup {
  const clientMap = new Map<string, MockClient>()
  let exitCb: ((sessionId: string, code: number | null, stderr: string) => void) | null = null
  const createSessionSpy = vi.fn(async (id: string) => {
    const client = makeMockClient()
    clientMap.set(id, client)
    return client as unknown as IPiEngine
  })

  const pm: IProcessManager = {
    createSession: createSessionSpy,
    // 与真实 destroySession 同构：先删 Map 条目（exit 回调按 clientToId 无条目拦截），
    // 不触发 exitCb——forceQuit 反向测试（②）的结构前提。
    destroySession: vi.fn(async (id: string) => { clientMap.delete(id) }),
    getClient: vi.fn((id: string) => clientMap.get(id)),
    getSessionIdByClient: vi.fn((client: IPiEngine) => {
      for (const [k, v] of clientMap) if (v === client) return k
      return undefined
    }),
    hasClient: vi.fn((id: string) => clientMap.has(id)),
    rekey: vi.fn(),
    onSessionExit: vi.fn((cb) => { exitCb = cb }),
    destroyAll: vi.fn(async () => { clientMap.clear() }),
    withEphemeralPi: vi.fn(),
  } as unknown as IProcessManager

  const broker = {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker

  const messageBus = {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  } as unknown as IMessageBus

  const extensionService = {
    getExtensionPaths: vi.fn().mockResolvedValue([]),
  } as unknown as IExtensionService

  const adapterFactory = (): IEventAdapter => ({
    attach: vi.fn(),
    detach: vi.fn(),
  }) as unknown as IEventAdapter

  const gitInfoReader = {
    readGitInfo: vi.fn(() => undefined),
    pruneStaleCache: vi.fn(),
  } as unknown as IGitInfoReader

  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) }

  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
    getSkillPaths: vi.fn(() => []),
  } as unknown as IConfigStore

  const sessionStore = {
    scanSessions: vi.fn(() => []),
    extractSessionOutcome: vi.fn(() => 'done'),
    persistSessionEnd: vi.fn(),
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    invalidateMetaCache: vi.fn(),
  } as unknown as ISessionStore

  const service = new SessionService(
    pm,
    broker,
    adapterFactory,
    tmpdir(),
    extensionService,
    configStore,
    sessionStore,
    gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
    messageBus,
  )
  service.setMessageBus(messageBus)

  const register = async (sessionId: string, sessionFilePath?: string): Promise<MockClient> => {
    const client = makeMockClient()
    clientMap.set(sessionId, client)
    // 同步注册汇聚点（create/restore 共用的 initializeManagedSession 委托）；await 确保
    // 断言前 Map 条目已落（restoreSession facade 的 getSummary 后置条件依赖注册态）。
    await service.initializeManagedSession(sessionId, client, tmpdir(), 'label', sessionFilePath)
    return client
  }

  const spyRestoreWithDeferred = (sessionId: string) => {
    let resolveFn: (() => void) | null = null
    let rejectFn: ((e: unknown) => void) | null = null
    // [switch-race-window] 替身挂 lifecycle 内核（门控全部恢复入口）；镜像生产内核契约：
    // deferred 挂起 → spawn（pm.createSession = 进程数观测点）→ 注册汇聚点落 Map
    //（registerRestoredSession 的等价步——facade getSummary 后置条件的成立前提）。
    // onRestoreSuccess 不进替身：它是真实内核（deps.restore）尾部，随替身 resolve 自动执行。
    const lc = service as unknown as { lifecycle: { restoreSession: (sessionId: string) => Promise<unknown> } }
    const spy = vi.spyOn(lc.lifecycle, 'restoreSession').mockImplementationOnce(async (id: string) => {
      // deferred 先于 spawn await 登记（async 函数体首语句同步执行，reject/resolve 可
      // 在调用方无微任务窗口时立即生效）；spawn（进程数观测点）在 deferred 挂起期间发生。
      await new Promise<void>((res, rej) => {
        resolveFn = () => res()
        rejectFn = (e: unknown) => rej(e)
      })
      const client = await pm.createSession(id, tmpdir())
      await service.initializeManagedSession(id, client, tmpdir(), 'label', `/fake/${id}.jsonl`)
      return { id } as never
    })
    return {
      spy,
      resolve: () => { resolveFn?.() },
      reject: (e: unknown) => { rejectFn?.(e) },
    }
  }

  return {
    service,
    messageBus,
    clientMap,
    createSessionSpy,
    // 真实 process-manager 的 onExit 在回调上层前先清 processes/clientToId 条目
    //——triggerExit 同构模拟，否则 crashExit 的 isActive 检查读到残留 client 而错误 no-op。
    triggerExit: (sid, code, stderr = '') => {
      clientMap.delete(sid)
      exitCb?.(sid, code, stderr)
    },
    register,
    spyRestoreWithDeferred,
  }
}


/** [D3] 恢复内核替身（成功形态）：跳过 lifecycle FS 链的 FS 段；替身镜像生产内核契约的
 * spawn + 注册步（spawnRestoreClient → registerRestoredSession 等价）——崩溃后的重恢复
 * 场景 clientMap 旧条目已被 exit 收殓链清除、lifecycle Map 条目已被 removeSessionEntry
 * 摘除，生产语义 = 重 spawn 新 pi 重注册；成功出口（onRestoreSuccess）是真实内核尾部
 * 随替身 resolve 自动执行。facade getSummary 后置条件（恢复成功 ⇒ summary 可查）由此成立。 */
function spyRestoreSuccess(setup: Setup, summary: Record<string, unknown> = { id: 's1' }): ReturnType<typeof vi.fn> {
  const lc = setup.service as unknown as { lifecycle: { restoreSession: (sessionId: string) => Promise<unknown> } }
  return vi.spyOn(lc.lifecycle, 'restoreSession').mockImplementation(async (id: string) => {
    const client = await setup.createSessionSpy(id, tmpdir())
    await setup.service.initializeManagedSession(id, client, tmpdir(), 'label', `/fake/${id}.jsonl`)
    return summary as never
  })
}


/** [D3] session.restored 发布帧收集（S3①「恰好一条」断言范围）。 */
function restoredPublishCalls(setup: Setup): Array<[string, ServerMessage]> {
  return vi.mocked(setup.messageBus.publish).mock.calls.filter(([, m]) => (m as ServerMessage).type === 'session.restored') as Array<[string, ServerMessage]>
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-respawn', () => {
describe('u8 组装级（SessionService 接线：崩溃上报 + 惰性恢复 join）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('崩溃上报集成：非主动退出（triggerExit）→ 崩溃显式上报，不做自动 restore；手动恢复成功后恰好一条 restored', async () => {
    const setup = createSetup()
    await setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = spyRestoreSuccess(setup)
    setup.triggerExit('s1', 1, 'boom')
    // 进程退出链：session.exited 照常发布（既有行为不回归）
    expect(setup.messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'session.exited' }))
    // ADR-0122：不再自动恢复——restore 不被调用
    expect(restoreSpy).not.toHaveBeenCalled()

    // 用户手动恢复：facade 尾部出口发布恰好一条（崩溃登记命中）
    await setup.service.restoreSession('s1')
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    const restored = restoredPublishCalls(setup)
    expect(restored).toHaveLength(1)
    expect(restored[0][0]).toBe('s1')
    expect(restored[0][1].payload).toMatchObject({ sessionId: 's1', attempts: 1 })
  })

  it('②反向（A7）：forceQuit 不触发崩溃上报（forceQuitSession 手工编排不经 onSessionExit 链）', async () => {
    const setup = createSetup()
    const restoreSpy = spyRestoreSuccess(setup)
    // 注册态播种（register 同时挂活跃 client——真实 forceQuit 场景 session 在 Map）。
    // facade getSummary 后置条件（恢复成功 ⇒ summary 可查）也依赖此注册态。
    await setup.register('s1', '/fake/s1.jsonl')
    await setup.service.forceQuit('s1')
    // session.exited 照常广播（用户可见的强制退出反馈）
    expect(setup.messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'session.exited' }))
    // 无崩溃登记：后续恢复成功不发布 restored
    await setup.service.restoreSession('s1')
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(restoredPublishCalls(setup)).toHaveLength(0)
  })

  it('③join：恢复窗口内并发 ensureActive 返回同一 Promise，restore 内核只 spawn 一个 pi，完成后双方拿到同一 client', async () => {
    const setup = createSetup()
    const deferred = setup.spyRestoreWithDeferred('s9')
    const p1 = setup.service.ensureActive('s9')
    const p2 = setup.service.ensureActive('s9')
    // join：restore 内核只进入一次（无第二路并发恢复）
    expect(deferred.spy).toHaveBeenCalledTimes(1)
    // 恢复未完成前调用方不返回（消息等待恢复完成后继续）
    let settled = false
    void Promise.all([p1, p2]).then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    deferred.resolve()
    const [c1, c2] = await Promise.all([p1, p2])
    expect(settled).toBe(true)
    // 进程数断言（P-respawn-join）：join 下 restore 内核只 spawn 一个 pi
    expect(setup.createSessionSpy).toHaveBeenCalledTimes(1)
    expect(c1).toBe(c2)
    expect(setup.clientMap.get('s9')).toBeDefined()
  })

  it('③b join 失败传导：原恢复失败时 join 方得到同一失败（不吞错）', async () => {
    const setup = createSetup()
    const deferred = setup.spyRestoreWithDeferred('s9')
    const p1 = setup.service.ensureActive('s9')
    const p2 = setup.service.ensureActive('s9')
    deferred.reject(new Error('attach failed'))
    await expect(p1).rejects.toThrow('attach failed')
    await expect(p2).rejects.toThrow('attach failed')
    // 失败后 in-flight 登记清空：后续 ensureActive 可重新发起恢复
    const retry = setup.spyRestoreWithDeferred('s9')
    const p3 = setup.service.ensureActive('s9')
    retry.resolve()
    await expect(p3).resolves.toBeDefined()
  })

  it('⑧session 删除核销：removeSessionEntry 汇聚点核销崩溃登记（删除后的恢复不发布 restored）', async () => {
    const setup = createSetup()
    await setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = spyRestoreSuccess(setup)
    setup.triggerExit('s1', 1, 'boom')
    // 用户删除 session（主动删经 removeSessionEntry 汇聚点）
    setup.service.removeSessionEntry('s1')
    // 恢复成功：崩溃登记已被核销，不发布 restored
    await setup.service.restoreSession('s1')
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(restoredPublishCalls(setup)).toHaveLength(0)
  })

  it('shutdown 入口：cancelAllPendingRespawns 核销崩溃登记（组合根 shutdown 序列消费）', async () => {
    const setup = createSetup()
    await setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = spyRestoreSuccess(setup)
    setup.triggerExit('s1', 1, 'boom')
    setup.service.cancelAllPendingRespawns()
    await setup.service.restoreSession('s1')
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(restoredPublishCalls(setup)).toHaveLength(0)
  })

  it('D3-反向 无崩溃上下文的 restore（普通懒 spawn / startup-reattach 形态）→ 静默不发布 restored', async () => {
    const setup = createSetup()
    // 注册态播种：facade getSummary 后置条件（恢复成功 ⇒ summary 可查）的前提
    await setup.register('s-fresh', '/fake/s-fresh.jsonl')
    const restoreSpy = spyRestoreSuccess(setup, { id: 's-fresh' })
    // 从未崩溃（无崩溃登记）的恢复入口
    await setup.service.restoreSession('s-fresh')
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(restoredPublishCalls(setup)).toHaveLength(0)
  })

  it('[switch-race-window] 窗口竞态主回归（事故形态）：内核 spawn 完成、附着进行中（client 已登记、Map 未落），switch 腿 join 不误报', async () => {
    const setup = createSetup()
    const lc = setup.service as unknown as { lifecycle: { restoreSession: (sessionId: string) => Promise<unknown> } }
    let resolveAttach!: () => void
    const attachGate = new Promise<void>((res) => { resolveAttach = res })
    // 内核替身按事故时序编排：spawn 先行（client 登记进程表）→ 附着挂起（registerSession
    // 未落 Map）——正是冷启动 reattach 恢复的 ~700ms 窗口形态
    const kernelSpy = vi.spyOn(lc.lifecycle, 'restoreSession').mockImplementationOnce(async (id: string) => {
      const client = await setup.createSessionSpy(id, tmpdir())
      await attachGate
      await setup.service.initializeManagedSession(id, client, tmpdir(), 'label', `/fake/${id}.jsonl`)
      return { id } as never
    })
    // reattach 形态：不经 ensureActive 直连 facade 发起恢复
    const restoreP = setup.service.restoreSession('s-win')
    // 等内核推进到附着挂起（client 已入进程表）
    await vi.waitFor(() => {
      if (!setup.clientMap.has('s-win')) throw new Error('kernel spawn not yet run')
    }, { interval: 1 })
    // 窗口态断言（事故复现前提）：client 已在进程表、summary 不可查
    expect(setup.clientMap.get('s-win')).toBeDefined()
    expect(setup.service.getSummary('s-win')).toBeUndefined()
    // 窗口内 session.switch 到达：getSummary 落空 → ensureActive
    const switchP = setup.service.ensureActive('s-win')
    let switchSettled = false
    void switchP.then(() => { switchSettled = true })
    let allSettled = false
    void Promise.all([restoreP, switchP]).then(() => { allSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    // 切换腿在窗口内不得提前返回（原缺陷：快路径直返半成品 client → getSummary 落空误报）
    expect(switchSettled).toBe(false)
    expect(allSettled).toBe(false)
    resolveAttach()
    const [summary, client] = await Promise.all([restoreP, switchP])
    // 恢复完成后切换腿拿到完整注册态：summary 可查、client 与内核 spawn 的一致
    expect(summary).toMatchObject({ id: 's-win' })
    expect(client).toBe(setup.clientMap.get('s-win'))
    expect(kernelSpy).toHaveBeenCalledTimes(1)
    // join 不双跑（P-respawn-join）：restore 内核只 spawn 一个 pi——无双 spawn / 无 K3 杀重开
    expect(setup.createSessionSpy).toHaveBeenCalledTimes(1)
  })

  it('[switch-race-window] 窗口内并发手动 restore（session.restore RPC 形态）→ join 等待同一内核，双方拿到同一 summary，不双跑', async () => {
    const setup = createSetup()
    const deferred = setup.spyRestoreWithDeferred('s-manual')
    const p1 = setup.service.restoreSession('s-manual')
    const p2 = setup.service.restoreSession('s-manual')
    deferred.resolve()
    const [s1, s2] = await Promise.all([p1, p2])
    // 同一恢复：内核只进入一次、只 spawn 一个 pi（原缺陷：第二路直连内核清场杀掉在途 pi 重开）
    expect(deferred.spy).toHaveBeenCalledTimes(1)
    expect(setup.createSessionSpy).toHaveBeenCalledTimes(1)
    expect(s1).toEqual(s2)
  })
})
});

// ======================================================================
// ← test/session-viewed-at.test.ts
// ======================================================================

// ── 真 SessionService 装置（构造器只存引用，桩面照抄 session-service.test.ts）──

/** 最小 pm 桩：SessionService 构造器只消费 onSessionExit 注册位，其余面不触达。 */
function makePmStub(): IProcessManager {
  return {
    createSession: vi.fn(),
    destroySession: vi.fn(),
    getClient: vi.fn(() => undefined),
    getSessionIdByClient: vi.fn(() => undefined),
    hasClient: vi.fn(() => false),
    rekey: vi.fn(),
    onSessionExit: vi.fn(),
    destroyAll: vi.fn(),
  } as unknown as IProcessManager
}


/** 构造真 SessionService（依赖全桩化；路径推导经 globalSetup tmp 重定向，不触真实数据目录）。 */
function makeRealService(): SessionService {
  const broker: IMessageBroker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as unknown as IMessageBroker
  const adapterFactory = (): IEventAdapter => ({ attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter)
  const extensionService: IExtensionService = { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService
  const gitInfoReader: IGitInfoReader = { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() }
  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) }
  return new SessionService(
    makePmStub(),
    broker,
    adapterFactory,
    tmpdir(),
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
  )
}


// ── handler 装置（照抄 session-message-handler-switch-reply.test.ts 的 makeHandler 模式）──

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string }[]
}


interface HandlerServiceShape {  // oe-exempt:20261027:test:
  getSummary: ReturnType<typeof vi.fn>
  ensureActive: ReturnType<typeof vi.fn>
  markSessionViewed?: (sessionId: string) => void
}


function makeHandler(service: HandlerServiceShape) {
  const cap: Captured = { replies: [], errors: [] }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      cap.errors.push({ id, code, message })
    }),
    sessionService: service,
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { cap, handler }
}


function switchMsg(sessionId: string, id = 'req-1'): ClientMessage {
  return { type: 'session.switch', id, payload: { sessionId } } as unknown as ClientMessage
}


const SUMMARY = { id: 's-1', label: 'test', cwd: '/tmp' }

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-viewed-at', () => {
// ── 第 1 层：SessionService per-sid Map 语义（真实例）──

describe('lastViewedAt 查看时间戳：SessionService per-sid Map（idle pi reclamation D2 #6）', () => {
  it('未记录的 sid 查询返回 undefined（非 0——0 是合法 epoch，误用会豁免全部 session）', () => {
    const service = makeRealService()
    expect(service.getSessionLastViewedAt('never-viewed-sid')).toBeUndefined()
  })

  it('markSessionViewed 后查询返回记录时刻的时间戳；重复查看覆盖更新（保留最近一次）', () => {
    const service = makeRealService()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      service.markSessionViewed('s-1')
      expect(service.getSessionLastViewedAt('s-1')).toBe(1_000)
      nowSpy.mockReturnValue(2_000)
      service.markSessionViewed('s-1')
      // 覆盖语义：查看窗口锚定最近一次查看，旧时间戳必须被顶掉
      expect(service.getSessionLastViewedAt('s-1')).toBe(2_000)
      // per-sid 隔离：s-1 的记录不外溢到其他 sid
      expect(service.getSessionLastViewedAt('s-2')).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
  })
})
// ── 第 2/3 层：session.switch 处理器记录与失败隔离 ──

describe('lastViewedAt 查看时间戳：session.switch 处理器记录（入口挂点 + 失败隔离）', () => {
  it('switch 请求 → markSessionViewed 以目标 sid 调用（summary 命中分支）', async () => {
    const markSessionViewed = vi.fn()
    const { cap, handler } = makeHandler({
      getSummary: vi.fn(() => SUMMARY),
      ensureActive: vi.fn(),
      markSessionViewed,
    })
    await handler.handleSessionMessage(switchMsg('s-1'), {} as never)
    expect(markSessionViewed).toHaveBeenCalledWith('s-1')
    expect(markSessionViewed).toHaveBeenCalledTimes(1)
    // 记录不改变 switch 既有回复语义
    expect(cap.errors).toHaveLength(0)
    expect(cap.replies[0]?.type).toBe('session.switched')
  })

  it('getSummary 未命中（ensureActive 恢复分支）同样记录——入口挂点覆盖两条分支', async () => {
    const markSessionViewed = vi.fn()
    let call = 0
    const { cap, handler } = makeHandler({
      // 首次 getSummary（handler 内）返回 undefined → 恢复后再取返回 summary
      getSummary: vi.fn(() => {
        call++
        return call === 1 ? undefined : SUMMARY
      }),
      ensureActive: vi.fn().mockResolvedValue(undefined),
      markSessionViewed,
    })
    await handler.handleSessionMessage(switchMsg('s-restore'), {} as never)
    expect(markSessionViewed).toHaveBeenCalledWith('s-restore')
    expect(cap.replies[0]?.type).toBe('session.switched')
  })

  it('记录失败（markSessionViewed 抛错）不影响 switch 主流程：仍正常 reply，不产生 error envelope', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { cap, handler } = makeHandler({
        getSummary: vi.fn(() => SUMMARY),
        ensureActive: vi.fn(),
        markSessionViewed: vi.fn(() => { throw new Error('boom') }),
      })
      // 修复前若记录异常向上传播，handleSessionMessage reject / reply 丢失；
      // 修复后 try/catch 隔离，主流程照常
      await expect(handler.handleSessionMessage(switchMsg('s-1'), {} as never)).resolves.toBeUndefined()
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]?.type).toBe('session.switched')
      expect(cap.errors).toHaveLength(0)
      // 失败落 warn 留排查线索（非静默吞）
      expect(warnSpy).toHaveBeenCalledWith('[runtime] session.switch markSessionViewed failed:', expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('sessionService 缺省 markSessionViewed 成员（最小 mock 兼容）→ 静默跳过，主流程不受影响', async () => {
    const { cap, handler } = makeHandler({
      getSummary: vi.fn(() => SUMMARY),
      ensureActive: vi.fn(),
      // 刻意不提供 markSessionViewed：可选成员契约（backgroundTasks 同款形态）
    })
    await expect(handler.handleSessionMessage(switchMsg('s-1'), {} as never)).resolves.toBeUndefined()
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]?.type).toBe('session.switched')
    expect(cap.errors).toHaveLength(0)
  })
})
});
