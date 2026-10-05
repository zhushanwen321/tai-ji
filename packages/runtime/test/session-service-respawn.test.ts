/**
 * u8 组装级测试（崩溃上报 + 惰性恢复 join；发布判别 msg-pipeline-debloat D3）：真实
 * SessionService 构造器接线（onSessionExit 链尾部 crashExit / removeSessionEntry 汇聚点
 * cancel / ensureActive join）。
 *
 * [ADR-0122 退役登记] 原「5s 延迟自动恢复 + 熔断 + restoreFailed 推送」机制的组装级
 * 用例（①/③c/⑨/D3-①b/①c/⑥ 的 timer 维度）随机制退役。现覆盖：
 * - 崩溃上报集成：非主动退出（triggerExit）→ crashExit 显式上报（不做自动 restore）；
 * - ②反向（A7）：forceQuit 不触发崩溃上报——事实核验（只读确认）：forceQuitSession 在
 *   message-dispatcher 手工编排，不经 pm.onSessionExit 链；真实 kill 路径的 exit 事件被
 *   双层守卫拦截（rpc-client.kill 置 _killing 跳过 exitCallback + process-manager 按
 *   clientToId 无条目拦截 intentional destroy）——本 mock 的 destroySession 与真实行为
 *   同构（仅删 Map 不触发 exitCb），故 forceQuit 后不可能产生崩溃上报；
 * - ③join：恢复窗口内并发 ensureActive 返回同一 in-flight Promise、restore 内核只
 *   spawn 一个（pm.createSession 进程数断言）、两个调用方都在恢复完成后拿到同一 client；
 * - ③b join 失败传导；
 * - ⑧session 删除核销：removeSessionEntry 汇聚点核销崩溃登记（删除后的恢复不发布）；
 * - shutdown 入口：cancelAllPendingRespawns 核销（组合根 shutdown 序列接线）；
 * - [D3] 发布判别：崩溃后恢复成功 → 恰好一条 session.restored；无崩溃上下文的 restore
 *   （普通懒 spawn / startup-reattach 形态）静默不发布。restoreSession 替身一律按生产
 *   契约在成功尾部调用 service.onRestoreSuccess（spy 掉 lifecycle FS 链后出口须补齐）。
 *
 * restore 内核以 spyOn(service, 'restoreSession') 模拟（不触碰 lifecycle spawn 链 /
 * 真实文件系统 / 真实 ~/.taiji——fs 红线；spawn 进程数断言经 mock impl 内对
 * pm.createSession 的一次调用表达）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import type { IMessageBroker, IEventAdapter, IExtensionService } from '../src/interfaces.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IProcessManager, IPiEngine, PiEventListener } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type { ServerMessage } from '@taiji/shared'
import { SessionService } from '../src/services/session/session-service.js'

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
    // lastActivityAt：活动时钟观测面（IPiEngine 结构要求）
    lastActivityAt: 0,
    exited: false,
    ...overrides,
  }
  return client as unknown as MockClient
}

interface Setup {
  service: SessionService
  messageBus: IMessageBus
  clientMap: Map<string, MockClient>
  createSessionSpy: ReturnType<typeof vi.fn>
  triggerExit: (sessionId: string, code: number | null, stderr?: string) => void
  /** 注册一个 session 到 lifecycle Map（绕过 spawn 链，直接走注册汇聚点）。 */
  register: (sessionId: string, sessionFilePath?: string) => MockClient
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

  const register = (sessionId: string, sessionFilePath?: string): MockClient => {
    const client = makeMockClient()
    clientMap.set(sessionId, client)
    // 同步注册汇聚点（create/restore 共用的 initializeManagedSession 委托）。
    void service.initializeManagedSession(sessionId, client, tmpdir(), 'label', sessionFilePath)
    return client
  }

  const spyRestoreWithDeferred = (sessionId: string) => {
    let resolveFn: (() => void) | null = null
    let rejectFn: ((e: unknown) => void) | null = null
    const spy = vi.spyOn(service, 'restoreSession').mockImplementationOnce(async (id: string) => {
      // deferred 先于 spawn await 登记（async 函数体首语句同步执行，reject/resolve 可
      // 在调用方无微任务窗口时立即生效）；spawn（进程数观测点）在 deferred 挂起期间发生。
      await new Promise<void>((res, rej) => {
        resolveFn = () => res()
        rejectFn = (e: unknown) => rej(e)
      })
      await pm.createSession(id, tmpdir())
      // [D3] 被替身替换的 facade 跳过 lifecycle 链，但成功尾部出口必须按生产契约
      // 补齐——session.restored 的唯一发布点在 facade 尾部（onRestoreSuccess）。
      service.onRestoreSuccess(id)
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
    //——triggerExit 同构模拟，否则 crashExit 的 isActive 守卫读到残留 client 而错误 no-op。
    triggerExit: (sid, code, stderr = '') => {
      clientMap.delete(sid)
      exitCb?.(sid, code, stderr)
    },
    register,
    spyRestoreWithDeferred,
  }
}

/** [D3] 恢复成功替身：跳过 lifecycle FS 链 + 按生产契约在成功尾部收尾出口。 */
function spyRestoreSuccessWithFacadeTail(setup: Setup, summary: Record<string, unknown> = { id: 's1' }): ReturnType<typeof vi.fn> {
  return vi.spyOn(setup.service, 'restoreSession').mockImplementation(async (id: string) => {
    setup.service.onRestoreSuccess(id)
    return summary as never
  })
}

/** [D3] session.restored 发布帧收集（S3①「恰好一条」断言面）。 */
function restoredPublishCalls(setup: Setup): Array<[string, ServerMessage]> {
  return vi.mocked(setup.messageBus.publish).mock.calls.filter(([, m]) => (m as ServerMessage).type === 'session.restored') as Array<[string, ServerMessage]>
}

describe('u8 组装级（SessionService 接线：崩溃上报 + 惰性恢复 join）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('崩溃上报集成：非主动退出（triggerExit）→ 崩溃显式上报，不做自动 restore；手动恢复成功后恰好一条 restored', async () => {
    const setup = createSetup()
    setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = spyRestoreSuccessWithFacadeTail(setup)
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
    const restoreSpy = vi.spyOn(setup.service, 'restoreSession').mockResolvedValue({ id: 's1' } as never)
    // 挂一个活跃 client（不注册 lifecycle Map——真实 forceQuit 场景 session 在 Map，但
    // 本断言的核心是 forceQuit 链路自身不产生 exit 通知 / 不调 crashExit）
    setup.clientMap.set('s1', makeMockClient())
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
    setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = spyRestoreSuccessWithFacadeTail(setup)
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
    setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = spyRestoreSuccessWithFacadeTail(setup)
    setup.triggerExit('s1', 1, 'boom')
    setup.service.cancelAllPendingRespawns()
    await setup.service.restoreSession('s1')
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(restoredPublishCalls(setup)).toHaveLength(0)
  })

  it('D3-反向 无崩溃上下文的 restore（普通懒 spawn / startup-reattach 形态）→ 静默不发布 restored', async () => {
    const setup = createSetup()
    const restoreSpy = spyRestoreSuccessWithFacadeTail(setup, { id: 's-fresh' })
    // 从未崩溃（无崩溃登记）的恢复入口
    await setup.service.restoreSession('s-fresh')
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(restoredPublishCalls(setup)).toHaveLength(0)
  })
})
