/**
 * 空闲回收豁免访问器（idle-pi-reclamation D2 豁免信号在实装侧缺失的只读查询面，u3a）。
 *
 * 覆盖四访问器中的三个（第四个 relay 枚举 listTargetsByMainSessionId 的真值表在
 * src/__tests__/infra/relay/relay-registry.test.ts——真 socket 环回 + 假 pi 形态，
 * 需要真子进程杀链）：
 * 1. HandoffService.hasInflightHandoff（D2 #4）：runHandoff 在途 true / settle 后
 *    false——真 HandoffService + 真 inflight 生命周期链，最小 DI（sessionService 全
 *    fake，settle 走 abort 路径避开 create/注入/广播重链）。
 * 2. createSessionDeliveryRegistry(...).hasDeliveryActivity（D2 #5）：handle 未创建
 *    false / 空队列 handle false / 有未终态投递 true（真 delivery 内核，ensureActive
 *    挂起模拟投递停于在途）/ dispose 后 false。
 * 3. SessionService.getSessionOccupancy（D2 #1）：未附着 undefined / 附着初值 idle /
 *    投影翻转跟随（活引用非快照）/ 条目摘除后 undefined。
 *
 * 全部零真实子进程；写删目标仅 os.tmpdir()（fs-guard 白名单）。
 * 运行命令: cd packages/runtime && npx vitest run test/reclaim-accessors.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HandoffService } from '../src/services/handoff-service.js'
import { createSessionDeliveryRegistry } from '../src/services/session/session-delivery-registry.js'
import type { DeliveryHandle } from '@zhushanwen/session-delivery'
import { SessionService } from '../src/services/session/session-service.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type { IMessageBroker, IEventAdapter, IExtensionService } from '../src/interfaces.js'

// ── HandoffService.hasInflightHandoff（D2 #4）──────────────────

describe('HandoffService.hasInflightHandoff（D2 #4）', () => {
  /**
   * 最小 DI 装置：真 HandoffService，sessionService 全 fake。settle 路径选 abort
   * （abortHandoff → entry.reject → finalize → cleanupInflight）——不拖入 create /
   * 注入 / 广播重链（那需要更多 fake 成员且与本访问器目标无关）。
   */
  function makeHandoffFixture() {
    // prompt 立即 resolve（runHandoff 第 6 步 await 只等 ack）；agent_end 永不到来，
    // runHandoff 停在 await agentEndPromise——正是「handoff 进行中」窗口
    const fakeClient = {
      prompt: vi.fn(async () => ({})),
      onEvent: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      abort: vi.fn(async () => {}),
    }
    const sessionService = {
      getHistory: vi.fn(async () => ({ messages: [{ role: 'user', content: 'hello' }] })),
      getSession: vi.fn(() => ({ id: 's-1', cwd: tmpdir(), label: 'src' })),
      findScannedSession: vi.fn(() => undefined),
      ensureActive: vi.fn(async () => fakeClient),
    }
    const broker: IMessageBroker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as unknown as IMessageBroker
    const svc = new HandoffService({
      sessionService: sessionService as unknown as SessionService,
      broker,
      broadcastSessionList: vi.fn(),
      nextPushId: vi.fn(() => 'push-1'),
    })
    return { svc, sessionService, fakeClient }
  }

  it('runHandoff 在途（等 agent_end）→ true；settle（abort）后 → false', async () => {
    const { svc } = makeHandoffFixture()
    // 起始态：无 inflight（未记录 sid 与「结束后」同形）
    expect(svc.hasInflightHandoff('s-1')).toBe(false)

    const running = svc.runHandoff('s-1')
    // inflight 注册发生在 runHandoff 第 5 步（prompt await 之前的 Promise executor
    // 同步段）——getHistory/ensureActive 两个 await 之后微任务级到达
    await vi.waitFor(() => expect(svc.hasInflightHandoff('s-1')).toBe(true))
    // per-sid 精度：其他 sid 不受影响
    expect(svc.hasInflightHandoff('s-other')).toBe(false)

    // settle：abort → reject → finalize 清理 inflight（W4 语义）→ runHandoff 抛 'handoff aborted'
    await svc.abortHandoff('s-1')
    await expect(running).rejects.toThrow('handoff aborted')
    // 条目生命周期与「handoff 在途」同界：结束后查询回落 false
    expect(svc.hasInflightHandoff('s-1')).toBe(false)
  })
})

// ── hasDeliveryActivity（D2 #5）────────────────────────────────

describe('hasDeliveryActivity（D2 #5）', () => {
  /** 窄 deps 装置：views 只放 isIdle 读的三个标志（真内核 gate 消费面）。 */
  function makeDeliveryFixture() {
    const views = new Map<string, IManagedSessionView>()
    const deps = {
      getSession: (sid: string) => views.get(sid),
      // ensureActive 永挂：投递受理后停于「在途」（内核 depth 文档语义 = 等待队列 +
      // 在途含错误重试，inflight 未终态前 depth > 0）
      ensureActive: vi.fn(() => new Promise<IPiEngine>(() => {})),
      subscribeAgentSettled: vi.fn(() => () => {}),
      recordWorkspace: vi.fn(),
      getMessageBus: () => null,
    }
    return { deps, views }
  }

  it('handle 未创建 / handle 存在但队列为空 → false（存在性不是活跃）', () => {
    const { deps } = makeDeliveryFixture()
    const registry = createSessionDeliveryRegistry(deps)
    expect(registry.hasDeliveryActivity('s-1')).toBe(false)
    registry.getOrCreateDelivery('s-1')
    // 单例 handle 常驻（D3 归属表在回收态还刻意保留 sid→handle 映射）——存在性恒真
    // 不可作豁免信号，空队列 handle 必须判否（否则回收饿死）
    expect(registry.hasDeliveryActivity('s-1')).toBe(false)
  })

  it('真内核：sendChecked 受理后停于在途 → true；dispose 后 → false', async () => {
    const { deps, views } = makeDeliveryFixture()
    // isIdle 三维全 false → 内核 gate 放行，sendChecked 立即 attemptSend → port.send
    // （deliverText → ensureActive）挂起，消息停在 inflightBatch
    views.set('s-1', { isGenerating: false, isCompacting: false, isBashRunning: false } as IManagedSessionView)
    const registry = createSessionDeliveryRegistry(deps)
    const handle = registry.getOrCreateDelivery('s-1')
    const pending = handle.sendChecked({ payload: { kind: 'text', content: 'backflow-notify' } })
    await vi.waitFor(() => expect(registry.hasDeliveryActivity('s-1')).toBe(true))
    // dispose：条目移除（handle.dispose + Map.delete）；内核契约 = 挂起的 sendChecked 显式 reject
    registry.dispose('s-1')
    await expect(pending).rejects.toThrow('delivery handle disposed')
    expect(registry.hasDeliveryActivity('s-1')).toBe(false)
  })

  it('factory 注入替身 handle：depth > 0 即命中——查询面是 handle.depth() 委托', () => {
    const { deps } = makeDeliveryFixture()
    const registry = createSessionDeliveryRegistry(deps)
    // 替身 handle（接口注释明示 factory 供测试注入替身）：depth() 是 DeliveryHandle
    // 唯一队列状态查询，registry 判定只委托它，不反推内核内部
    registry.getOrCreateDelivery('s-2', () => ({
      send: vi.fn(),
      sendChecked: vi.fn(async () => {}),
      flush: vi.fn(),
      depth: () => 3,
      dispose: vi.fn(),
    }) as unknown as DeliveryHandle)
    expect(registry.hasDeliveryActivity('s-2')).toBe(true)
    expect(registry.hasDeliveryActivity('s-1')).toBe(false)
  })
})

// ── SessionService.getSessionOccupancy（D2 #1）─────────────────

// 装置照抄 test/reclaim-orchestration.test.ts（真 SessionService，构造依赖全桩化）

/** 最小 fake pi client（IPiEngine 全成员桩，initializeManagedSession 链路按需消费）。 */
function makeFakeClient(overrides: Partial<Record<string, unknown>> = {}): IPiEngine {
  const client = {
    prompt: vi.fn(async () => ({})),
    abort: vi.fn(async () => ({})),
    steer: vi.fn(async () => ({})),
    followUp: vi.fn(async () => ({})),
    setModel: vi.fn(async () => ({})),
    setThinkingLevel: vi.fn(async () => ({})),
    setSessionName: vi.fn(async () => ({})),
    getHistory: vi.fn(async () => ({})),
    getEntries: vi.fn(async () => ({})),
    getCommands: vi.fn(async () => []),
    getSessionStats: vi.fn(async () => ({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } })),
    switchSession: vi.fn(async () => {}),
    getState: vi.fn(async () => ({ sessionId: 'pi-fake' })),
    sendExtensionUiResponse: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    compact: vi.fn(async () => ({ summary: '', firstKeptEntryId: '', tokensBefore: 0 })),
    clear: vi.fn(async () => ({})),
    bash: vi.fn(async () => ({ output: '', exitCode: 0, cancelled: false, truncated: false })),
    abortBash: vi.fn(async () => ({})),
    start: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    onExit: vi.fn(() => () => {}),
    exited: false,
    lastActivityAt: Date.now(),
    touchActivity: vi.fn(),
    ...overrides,
  }
  return client as unknown as IPiEngine
}

interface StubPm extends IProcessManager {
  /** sid → fake client（测试直接操纵模拟 pm 双 Map 的 sid 侧）。 */
  clientsById: Map<string, IPiEngine>
}

function makeStubPm(): StubPm {
  const clientsById = new Map<string, IPiEngine>()
  const pm = {
    clientsById,
    createSession: vi.fn(async (sessionId: string) => {
      const c = makeFakeClient()
      clientsById.set(sessionId, c)
      return c
    }),
    destroySession: vi.fn(async (sessionId: string) => {
      clientsById.delete(sessionId)
    }),
    getClient: vi.fn((sessionId: string) => clientsById.get(sessionId)),
    getSessionIdByClient: vi.fn(() => undefined),
    hasClient: vi.fn((sessionId: string) => clientsById.has(sessionId)),
    rekey: vi.fn(),
    onSessionExit: vi.fn(() => () => {}),
    destroyAll: vi.fn(async () => {}),
    withEphemeralPi: vi.fn(async () => {
      throw new Error('not implemented in stub')
    }),
    getPiVersion: vi.fn(async () => 'test'),
  }
  return pm as unknown as StubPm
}

/** 真 SessionService（构造依赖全桩化，形态照抄 reclaim-orchestration 的 makeService）。 */
function makeService() {
  const pm = makeStubPm()
  const broker: IMessageBroker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as unknown as IMessageBroker
  const adapterFactory = vi.fn(() => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter)
  const extensionService: IExtensionService = { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService
  const gitInfoReader: IGitInfoReader = { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() }
  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) }
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    scanSessions: vi.fn(() => []),
  } as unknown as ISessionStore
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
    getSkillPaths: vi.fn(() => []),
  } as unknown as IConfigStore
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
  )
  return { service, pm }
}

/** 附着活跃 session（initializeManagedSession = lifecycle.registerSession 的公有测试委托）。 */
async function attachSession(service: SessionService, pm: StubPm, sessionId: string): Promise<IPiEngine> {
  const client = makeFakeClient()
  pm.clientsById.set(sessionId, client)
  await service.initializeManagedSession(sessionId, client, tmpdir(), `label-${sessionId}`, join(tmpdir(), `${sessionId}.jsonl`))
  return client
}

describe('SessionService.getSessionOccupancy（D2 #1）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('未附着 / 不存在的 sid → undefined', () => {
    const { service } = makeService()
    expect(service.getSessionOccupancy('ghost')).toBeUndefined()
  })

  it('附着后初值 = 全 idle；occupancy 投影翻转跟随（活引用非快照）', async () => {
    const { service, pm } = makeService()
    await attachSession(service, pm, 's-1')
    // registerSession 显式初始化 idle（session-occupancy-send-closure D3 转移 #10）
    expect(service.getSessionOccupancy('s-1')).toEqual({ turn: 'idle', compacting: false, bash: false })
    // 记录引用可变语义（ADR-0049）：真实写方 updateSessionOccupancy 直写字段——访问器
    // 读的是同一活对象，投影翻转立即可见
    const view = service.getSession('s-1')!
    view.occupancy = { turn: 'generating', compacting: false, bash: false }
    expect(service.getSessionOccupancy('s-1')).toEqual({ turn: 'generating', compacting: false, bash: false })
  })

  it('Map 条目摘除（removeSessionEntry / 回收同路）后 → undefined（无条目即无占用信号）', async () => {
    const { service, pm } = makeService()
    await attachSession(service, pm, 's-1')
    expect(service.getSessionOccupancy('s-1')).toBeDefined()
    // 死亡汇聚点与回收（reclaimManagedSession 第 6 步）都是 lifecycle Map removeEntry——
    // 条目摘除后访问器回落 undefined（reaper 侧「无信号」语义）
    service.removeSessionEntry('s-1')
    expect(service.getSessionOccupancy('s-1')).toBeUndefined()
  })
})
