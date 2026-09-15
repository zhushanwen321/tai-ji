/**
 * u8-pi-respawn 组装级测试（crash-resilience §3.3 D7）：真实 SessionService 构造器接线
 * （onSessionExit 链尾部 schedule / removeSessionEntry 汇聚点 cancel / ensureActive join）。
 *
 * 覆盖验收必测断言（组装级，编排器本体行为见 pi-respawn.test.ts）：
 * - ①集成：非主动退出（triggerExit）→ 5s 后自动 restore 恰好一次；
 * - ②反向（A7）：forceQuit 不触发自动恢复——事实核验（只读确认）：forceQuitSession 在
 *   message-dispatcher.ts:470-490 手工编排（detach → destroy → persist stopped → 广播
 *   exited → removeEntry），不经 pm.onSessionExit 链；真实 kill 路径的 exit 事件被双层
 *   守卫拦截（rpc-client.kill 置 _killing 跳过 exitCallback + process-manager 按
 *   clientToId 无条目拦截 intentional destroy）——本 mock 的 destroySession 与真实行为
 *   同构（仅删 Map 不触发 exitCb），故 forceQuit 后推进时间不可能产生 restore；
 * - ③join：恢复窗口内并发 ensureActive 返回同一 in-flight Promise、restore 内核只
 *   spawn 一个（pm.createSession 进程数断言）、两个调用方都在恢复完成后拿到同一 client
 *   （③c = timer 已触发的自动恢复进行中变体——自动恢复经 ensureRestored 登记 in-flight，
 *   ensureActive join 之，双向构造性成立，D7-③）；
 * - ⑧session 删除取消：removeSessionEntry 汇聚点（lifecycle.delete 主动删的汇聚路径）
 *   取消 pending timer；
 * - ⑨restored/restoreFailed 消息形态：messageBus.publish 的 payload 必带 sessionId
 *   （仓规规则 7）。
 * - shutdown 入口：cancelAllPendingRespawns 清 pending（index.ts shutdown 序列接线，
 *   先于 server.stop→destroyAll 的顺序由组合根代码保证，编排器层 timer 清理断言见
 *   pi-respawn.test.ts ⑦）。
 *
 * restore 内核以 spyOn(service, 'restoreSession') 模拟（不触碰 lifecycle spawn 链 /
 * 真实文件系统 / 真实 ~/.taiji——fs 红线；spawn 进程数断言经 mock impl 内对
 * pm.createSession 的一次调用表达）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import type { IMessageBroker, IEventAdapter, IExtensionService } from '../src/interfaces.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IProcessManager, IPiEngine, PiEventListener } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type { ServerMessage } from '@taiji/shared'
import { SessionService } from '../src/services/session/session-service.js'
import { RESPAWN_DELAY_MS } from '../src/services/session/pi-respawn.js'

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
    // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
    // 到达 fake client——fake 须补齐该接口成员（IPiEngine 结构要求）
    touchActivity: vi.fn(),
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
    //（process-manager.ts:174-175）——triggerExit 同构模拟，否则 respawn 的 isActive
    // 守卫读到残留 client 而错误 no-op。
    triggerExit: (sid, code, stderr = '') => {
      clientMap.delete(sid)
      exitCb?.(sid, code, stderr)
    },
    register,
    spyRestoreWithDeferred,
  }
}

describe('u8-pi-respawn 组装级（SessionService 接线，crash-resilience D7）', () => {
  beforeEach(() => {
    // 只 fake setTimeout/clearTimeout（恢复编排只消费这对）——SessionService 构造的
    // BackgroundTaskService 2s 轮询 setInterval 保持真实，否则 runAllTimersAsync 会把
    // 轮询 interval 无限推进触发 vitest 10k timers 熔断。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('①集成：非主动退出 → 5s 后自动 restore 恰好一次，推 session.restored（sessionId 必带 ⑨）', async () => {
    const setup = createSetup()
    setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = vi.spyOn(setup.service, 'restoreSession').mockResolvedValue({ id: 's1' } as never)
    setup.triggerExit('s1', 1, 'boom')
    // 进程退出链：session.exited 照常发布（既有行为不回归）
    expect(setup.messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'session.exited' }))
    // 5s 前不恢复
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS - 1)
    expect(restoreSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    expect(restoreSpy).toHaveBeenCalledWith('s1')
    await vi.runAllTimersAsync()
    const restored = vi.mocked(setup.messageBus.publish).mock.calls.find(([, m]) => (m as ServerMessage).type === 'session.restored')
    expect(restored).toBeDefined()
    const [, msg] = restored as [string, ServerMessage]
    expect(msg.payload).toMatchObject({ sessionId: 's1' })
    // 且只一次
    await vi.runAllTimersAsync()
    expect(restoreSpy).toHaveBeenCalledTimes(1)
  })

  it('②反向（A7）：forceQuit 不触发自动恢复（forceQuitSession 手工编排不经 onSessionExit 链）', async () => {
    const setup = createSetup()
    const restoreSpy = vi.spyOn(setup.service, 'restoreSession').mockResolvedValue({ id: 's1' } as never)
    // 挂一个活跃 client（不注册 lifecycle Map——真实 forceQuit 场景 session 在 Map，但
    // 本断言的核心是 forceQuit 链路自身不产生 exit 通知 / 不调 schedule）
    setup.clientMap.set('s1', makeMockClient())
    await setup.service.forceQuit('s1')
    // session.exited 照常广播（用户可见的强制退出反馈）
    expect(setup.messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'session.exited' }))
    // 时间充分推进：无自动恢复、无 restored
    await vi.runAllTimersAsync()
    expect(restoreSpy).not.toHaveBeenCalled()
    expect(vi.mocked(setup.messageBus.publish).mock.calls.some(([, m]) => (m as ServerMessage).type === 'session.restored')).toBe(false)
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

  it('③c timer 已触发、自动恢复进行中（spawn+attach 未完成）→ 并发 ensureActive join 同一恢复，只 spawn 一个 pi（P-respawn-join）', async () => {
    const setup = createSetup()
    setup.register('s9', '/fake/s9.jsonl')
    const deferred = setup.spyRestoreWithDeferred('s9')
    setup.triggerExit('s9', 1, 'boom')
    // timer 触发 → 自动恢复启动，restoreSession 进行中（spawn+attach 未完成）
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS)
    expect(deferred.spy).toHaveBeenCalledTimes(1)
    // 恢复窗口内用户发消息 → ensureActive 查无活 client → join 自动恢复的 in-flight Promise
    const userCall = setup.service.ensureActive('s9')
    expect(deferred.spy).toHaveBeenCalledTimes(1)
    let settled = false
    void userCall.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    // 自动恢复的 spawn+attach 完成 → join 方与自动恢复同时收口，进程数 = 1（无双 spawn）
    deferred.resolve()
    const client = await userCall
    expect(settled).toBe(true)
    expect(deferred.spy).toHaveBeenCalledTimes(1)
    expect(setup.createSessionSpy).toHaveBeenCalledTimes(1)
    expect(setup.clientMap.get('s9')).toBe(client)
  })

  it('⑧session 删除取消：removeSessionEntry 汇聚点（lifecycle.delete 主动删的汇聚路径）取消 pending timer', async () => {
    const setup = createSetup()
    setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = vi.spyOn(setup.service, 'restoreSession').mockResolvedValue({ id: 's1' } as never)
    setup.triggerExit('s1', 1, 'boom')
    // 5s 窗口内用户删除 session（主动删经 removeSessionEntry 汇聚点）
    setup.service.removeSessionEntry('s1')
    await vi.runAllTimersAsync()
    expect(restoreSpy).not.toHaveBeenCalled()
    expect(vi.mocked(setup.messageBus.publish).mock.calls.some(([, m]) => (m as ServerMessage).type === 'session.restored')).toBe(false)
  })

  it('shutdown 入口：cancelAllPendingRespawns 清 pending 自动恢复（组合根 shutdown 序列消费）', async () => {
    const setup = createSetup()
    setup.register('s1', '/fake/s1.jsonl')
    const restoreSpy = vi.spyOn(setup.service, 'restoreSession').mockResolvedValue({ id: 's1' } as never)
    setup.triggerExit('s1', 1, 'boom')
    setup.service.cancelAllPendingRespawns()
    await vi.runAllTimersAsync()
    expect(restoreSpy).not.toHaveBeenCalled()
  })

  it('⑨失败推送形态：自动恢复失败推 session.restoreFailed（sessionId 必带），熔断后停在 willRetry=false', async () => {
    const setup = createSetup()
    setup.register('s1', '/fake/s1.jsonl')
    vi.spyOn(setup.service, 'restoreSession').mockRejectedValue(new Error('attach hard-fail'))
    setup.triggerExit('s1', 1, 'boom')
    await vi.runAllTimersAsync()
    const failures = vi.mocked(setup.messageBus.publish).mock.calls.filter(([, m]) => (m as ServerMessage).type === 'session.restoreFailed')
    expect(failures).toHaveLength(2)
    for (const [sid, msg] of failures as Array<[string, ServerMessage]>) {
      expect(sid).toBe('s1')
      expect(msg.payload).toMatchObject({ sessionId: 's1' })
    }
    expect((failures[0][1] as ServerMessage).payload).toMatchObject({ willRetry: true })
    expect((failures[1][1] as ServerMessage).payload).toMatchObject({ willRetry: false })
  })
})
