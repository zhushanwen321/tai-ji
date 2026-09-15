/**
 * D6a（integrity-hardening §3.6）：挂起 UI 请求的汇聚清理测试（修 M8 幽灵弹窗）。
 *
 * 锁定三条链路：
 * 1. server.setServices 装配时把 extensionTimeoutMgr 清理挂到 onSessionDestroyed 回调
 *    （extensionTimeoutMgr 是 server 私有，清理经 clearForSession：pendingRequests /
 *    bridgeRequestIds / session 跟踪三者一并清，且 per-session 分区互不影响）。
 * 2. 真实 SessionService 的「进程意外退出」路径（pm.onSessionExit → removeSessionEntry）
 *    触发全部 onSessionDestroyed 回调——这是修复前不触发清理的漏点。
 * 3. 真实 SessionService 的「主动删除」路径（lifecycle.delete → removeSessionEntry）同样触发
 *    （回调列表语义：多方注册共存，单 handler 异常不阻断其余）。
 *
 * 运行：cd packages/runtime && npx vitest run test/server-destroyed-converged-cleanup.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { RuntimeServer } from '../src/transport/server.js'
import { SessionService } from '../src/services/session/session-service.js'
import { MessageBus } from '../src/services/message-bus/message-bus.js'
import { ExtensionTimeoutManager } from '../src/services/extension-timeout-manager.js'
import { applySessionOccupancyTransition } from '../src/services/session/event-interpreter.js'
import { createMockSessionServiceClass } from './helpers/service-mocks.js'
import type { ISessionService } from '../src/interfaces.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { SessionSummary, ServerMessage } from '@taiji/shared'

// ── 分层 1：server 装配的汇聚清理（extensionTimeoutMgr 真实例） ──────────────

describe('D6a: server.setServices 注册 onSessionDestroyed 汇聚清理', () => {
  it('回调触发 → extensionTimeoutMgr.clearForSession 生效（pendingRequests + bridgeRequestIds 清空，分区隔离）', () => {
    const MockSvc = createMockSessionServiceClass()
    const sessionService = new MockSvc() as unknown as ISessionService
    const server = new RuntimeServer(0, '/tmp/test-project')
    server.setServices(sessionService, {} as never, {} as never)

    // 装配时注册了回调（追加式列表槽，PluginService 后续注册共存）
    const registered = vi.mocked(sessionService.setOnSessionDestroyed)
    expect(registered).toHaveBeenCalledTimes(1)
    const handler = registered.mock.calls[0]![0]

    // 模拟挂起的 ask-user 请求（pending 缓存）+ bridge 请求（bridgeRequestIds）。
    // bridge 登记走 addBridgeRequest（marker 通道唯一入口，旧 registerTimeout 的
    // bridge: 前缀分支已删）；bridge 请求不产 extension-ui kind → 不入 pendingRequests
    server.registerExtensionTimeout('s1', 'req-ask', 'ask-user', { question: 'continue?' })
    server.registerExtensionTimeout('s2', 'req-other', 'ask-user', { question: 'other' })
    const mgr = (server as unknown as { extensionTimeoutMgr: ExtensionTimeoutManager }).extensionTimeoutMgr
    mgr.addBridgeRequest('s1', 'req-bridge')
    // pending 缓存只含 ask-user（bridge 请求经 marker 通道不经 pendingRequests）
    expect(mgr.getPendingRequests('s1')).toHaveLength(1)
    expect(mgr.isBridgeRequest('req-bridge')).toBe(true)

    // 触发点传 summary（removeSessionEntry 删除前缓存；Map 无条目时是最小形状，id 恒可靠）
    handler({ id: 's1', label: 's1', cwd: '', status: 'dead', lastActiveAt: 0, modelId: '', tokenCount: 0 })

    expect(mgr.getPendingRequests('s1')).toHaveLength(0)
    expect(mgr.isBridgeRequest('req-bridge')).toBe(false)
    // per-session 分区：s2 不受 s1 清理影响
    expect(mgr.getPendingRequests('s2')).toHaveLength(1)
  })
})

// ── 分层 2/3：真实 SessionService 两条销毁路径都触发回调列表 ──────────────────

/**
 * 真实 SessionService 环境（对齐 session-service-w07-bus.test.ts 的 makeEnv）。
 * pm.onSessionExit 捕获 handler 供测试显式触发（模拟 pi 进程意外退出）。
 */
function makeRealServiceEnv() {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker

  let exitHandler: ((sessionId: string, code: number | null, stderr: string) => void) | null = null
  const client = {
    getCommands: vi.fn(async () => []),
    getState: vi.fn(async () => ({ sessionName: 'd6a', thinkingLevel: 'low', model: { id: 'm', provider: 'p' } })),
    getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } })),
  } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn((h: (sessionId: string, code: number | null, stderr: string) => void) => {
      exitHandler = h
    }),
    getClient: vi.fn(() => client),
    // 主动删除路径（lifecycle.delete → pm.destroySession）
    destroySession: vi.fn(async () => undefined),
  } as unknown as IProcessManager

  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'p', modelId: 'm' }) } as never, // configStore
    {
      scanSessions: vi.fn(() => []),
      extractSessionOutcome: vi.fn(() => null),
      persistSessionEnd: vi.fn(),
      invalidateScanCache: vi.fn(),
      refreshAll: vi.fn(),
    } as never, // sessionStore（delete 尾部两个失效调用）
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService：SessionLifecycle 构造存引用，被测路径未触发
    bus,
  )
  svc.setMessageBus(bus)
  return {
    svc,
    bus,
    triggerExit: (sid: string, code: number | null, stderr: string) => {
      if (!exitHandler) throw new Error('onSessionExit handler not registered')
      exitHandler(sid, code, stderr)
    },
  }
}

/** 模拟组合根注册：PluginService 风格 handler + server 汇聚清理 handler 共存。 */
function registerHandlers(svc: SessionService): { plugin: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn> } {
  const plugin = vi.fn()
  const cleanup = vi.fn()
  svc.setOnSessionDestroyed((summary) => { plugin(summary.id) })
  svc.setOnSessionDestroyed((summary) => { cleanup(summary.id) })
  return { plugin, cleanup }
}

describe('D6a: 真实 SessionService 两条销毁路径触发 onSessionDestroyed 回调列表', () => {
  it('进程意外退出（onSessionExit → removeSessionEntry）触发全部回调 + occupancy 全复位帧先于 clearSession（A3）', async () => {
    const { svc, bus, triggerExit } = makeRealServiceEnv()
    const { plugin, cleanup } = registerHandlers(svc)
    const session = await svc.initializeManagedSession('s-exit', {} as unknown as IPiEngine, '/tmp', 'test')

    // 构造「占用中 pi 死亡」场景（D3 转移 #10 的主防线语义）：占用中 agent_settled /
    // compaction_end 永不到达，onSessionExit 全复位是唯一兜底——否则重连 renderer 经
    // stateSnapshot 回放恢复的是永久占用投影。先置占用投影（订阅前，received 只收
    // triggerExit 后的帧），再订阅并触发退出。
    applySessionOccupancyTransition(session, bus, 'generating')
    applySessionOccupancyTransition(session, bus, 'compacting-start')

    // 订阅 bus（BusClient 最小契约 readyState + send）捕获 publish 帧；spy 记录
    // clearSession（removeSessionEntry 内部清订阅者集合）相对顺序
    const received: ServerMessage[] = []
    const ws = { readyState: 1, send: (data: string) => { received.push(JSON.parse(data) as ServerMessage) } }
    bus.subscribe('s-exit', ws as never)
    const clearSessionSpy = vi.spyOn(bus, 'clearSession')
    const publishSpy = vi.spyOn(bus, 'publish')

    triggerExit('s-exit', 1, 'boom')

    expect(plugin).toHaveBeenCalledWith('s-exit')
    expect(cleanup).toHaveBeenCalledWith('s-exit')

    // occupancy 全复位帧：{turn:'idle', compacting:false, bash:false}（D3 转移 #10）
    const occFrames = received.filter((m) => m.type === 'session.occupancy')
    expect(occFrames).toHaveLength(1)
    expect(occFrames[0]!.payload).toMatchObject({ sessionId: 's-exit', turn: 'idle', compacting: false, bash: false })
    // session.exited 同样经 bus publish 到达订阅者（broadcast 腿已删，publish 唯一通道）
    expect(received.some((m) => m.type === 'session.exited')).toBe(true)

    // 帧序约束：occupancy 复位 publish 先于 clearSession 清空——clearSession 之后订阅者
    // 集合为空，届时才 publish 等于送空集合，订阅 renderer 一条也收不到（占用卡死）。
    const occCallIdx = publishSpy.mock.calls.findIndex((c) => (c[1] as ServerMessage).type === 'session.occupancy')
    expect(occCallIdx).toBeGreaterThanOrEqual(0)
    expect(publishSpy.mock.invocationCallOrder[occCallIdx]!).toBeLessThan(clearSessionSpy.mock.invocationCallOrder[0]!)
  })

  it('主动删除（lifecycle.delete → removeSessionEntry）触发全部回调', async () => {
    const { svc } = makeRealServiceEnv()
    const { plugin, cleanup } = registerHandlers(svc)
    await svc.initializeManagedSession('s-del', {} as unknown as IPiEngine, '/tmp', 'test')

    await svc.delete('s-del')

    expect(plugin).toHaveBeenCalledWith('s-del')
    expect(cleanup).toHaveBeenCalledWith('s-del')
  })

  it('回调列表隔离：首个 handler 抛错不阻断后续 handler，也不外抛', async () => {
    const { svc, triggerExit } = makeRealServiceEnv()
    const second = vi.fn()
    svc.setOnSessionDestroyed(() => { throw new Error('plugin didDestroy boom') })
    svc.setOnSessionDestroyed((summary: SessionSummary) => { second(summary.id) })
    await svc.initializeManagedSession('s-iso', {} as unknown as IPiEngine, '/tmp', 'test')

    expect(() => triggerExit('s-iso', 1, '')).not.toThrow()
    expect(second).toHaveBeenCalledWith('s-iso')
  })
})
