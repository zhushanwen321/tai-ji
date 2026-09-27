/**
 * 空闲回收编排时序测试（idle-pi-reclamation D3 七步 / D6 竞态三件套，实施计划 u2）。
 *
 * 覆盖（真 SessionLifecycle + 真 SessionService，pm/sessionStore 等依赖全 stub；
 * 零真实子进程、写删目标仅 os.tmpdir() 白名单）：
 * 1. 七步编排主路径（D3）：占座 → 同步最终豁免 → detach → destroy → fire-and-forget
 *    尾扫/收殓 → 代际校验 → 最小摘除 → finally 释放。
 * 2. P6-② kill await 期间并发 switch：等待方不抢跑、释放后走 restore、对已摘除条目
 *    no-op 无二次销毁（destroySession 恰 1 次 + 死亡汇聚点从未触发）。
 * 3. P6-③ 代际校验：摘除前注入并发重建，摘除取消（新条目/新进程不被误摘）。
 * 4. 尾扫单段快照：快照窗口内落地的 relay 条目被首扫捕获；restore 后新 spawn 的 relay
 *    子进程不被迟到的尾扫命中（两段式被否——异步执行阶段禁止再查再杀）。
 * 5. 占座 finally 释放：中途抛异常仍释放（等待方不永久挂起的前提）。
 * 6. D6-2 等待超时只记 ERROR 观测不抢跑（等待方永不抢跑是硬约束）。
 * 7. R4：removeSessionEntry 汇聚点清 lastViewedAt（真删除清、回收态刻意不清）。
 * 8. D5：restoreSession elapsed 耗时日志。
 *
 * 运行命令: cd packages/runtime && npx vitest run test/reclaim-orchestration.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { SessionSummary } from '@taiji/shared'

// normalizeInactiveSessionFileIfNeeded 需要真实文件（statSync ENOENT 即 throw）——本测试
// 目标是编排时序非归一化管线，mock 为 no-op；同模块 seedRestoreMetaOverride 保留真身
//（U8a W3 后只读 get_state + 内存组装，无持久层写入，假路径零副作用）。
vi.mock('../src/services/session/restore-seeding.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/session/restore-seeding.js')>()
  return { ...mod, normalizeInactiveSessionFileIfNeeded: vi.fn() }
})

import { SessionLifecycle, type ReclaimSessionDeps, type ReclaimRelayTarget } from '../src/services/session/session-lifecycle.js'
import { SessionService } from '../src/services/session/session-service.js'
import { ReclaimSeat } from '../src/services/session/idle-pi-reaper.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'
import type { IMessageBroker, IEventAdapter, IExtensionService } from '../src/interfaces.js'

// ── fake 装置 ─────────────────────────────────────────────────

/** 最小 fake pi client（IPiEngine 全成员桩，reclaim/restore/ensure 链路按需消费）。 */
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
    // sessionFile undefined = attach 断言「取不到可比对 sessionFile」跳过分支；restore
    // 用例以 overrides 精确回填登记路径走真实比对。
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

/** 最小 pm 桩：clientsById 是 destroy/get/has 的共享真值源（模拟 pm 双 Map 的 sid 侧）。 */
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

function makeLifecycleDeps() {
  const svc: ILifecycleSessionOps = {
    toSummary: (s) => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'idle', lastActiveAt: s.lastActiveAt,
      modelId: s.modelId, tokenCount: 0,
    }) as unknown as SessionSummary,
    findScannedSession: vi.fn(() => undefined),
    getSkillPaths: vi.fn(() => []),
    getExtensionPaths: vi.fn(async () => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    fetchAndBroadcastContext: vi.fn(async () => {}),
    removeSessionEntry: vi.fn(),
    notifySessionCreated: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: vi.fn((_sid: string, _send: unknown, _cwd?: string) => ({
      attach: vi.fn(),
      detach: vi.fn(),
    }) as unknown as IEventAdapter),
    getMessageBus: () => null,
    broadcastGlobal: vi.fn(),
  }
  return {
    svc,
    registerDeps,
    pm: makeStubPm(),
    configStore: { getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })) } as unknown as IConfigStore,
    sessionStore: {
      refreshAll: vi.fn(),
      invalidateScanCache: vi.fn(),
      scanSessions: vi.fn(() => []),
    } as unknown as ISessionStore,
    workspaceService: { record: vi.fn(), list: vi.fn(() => []) } as unknown as ConstructorParameters<typeof SessionLifecycle>[4],
  }
}

function makeLifecycle(): { lifecycle: SessionLifecycle; deps: ReturnType<typeof makeLifecycleDeps> } {
  const deps = makeLifecycleDeps()
  const lifecycle = new SessionLifecycle(deps.svc, deps.pm, deps.configStore, deps.sessionStore, deps.workspaceService, deps.registerDeps)
  return { lifecycle, deps }
}

/** lifecycle.registerSession 放入 Map 条目 + pm 挂 client（模拟已附着的活跃 session）。 */
async function attachSession(lifecycle: SessionLifecycle, pm: StubPm, sessionId: string): Promise<IPiEngine> {
  const client = makeFakeClient()
  pm.clientsById.set(sessionId, client)
  await lifecycle.registerSession(sessionId, client, tmpdir(), `label-${sessionId}`, join(tmpdir(), `${sessionId}.jsonl`))
  return client
}

/** relay 尾扫 fake：按 mainSessionId 登记目标（kill spy），枚举返回当前在册快照。 */
function makeRelayFake() {
  const byMain = new Map<string, ReclaimRelayTarget[]>()
  const killSpies: Array<ReturnType<typeof vi.fn>> = []
  return {
    byMain,
    register(mainSessionId: string): { kill: ReturnType<typeof vi.fn> } {
      const kill = vi.fn(async () => {})
      killSpies.push(kill)
      const target: ReclaimRelayTarget = { kill }
      const list = byMain.get(mainSessionId) ?? []
      list.push(target)
      byMain.set(mainSessionId, list)
      return { kill }
    },
    list: (mainSessionId: string): ReclaimRelayTarget[] => [...(byMain.get(mainSessionId) ?? [])],
    killSpies,
  }
}

function makeReclaimDeps(seat: ReclaimSeat, relay: ReturnType<typeof makeRelayFake>) {
  return {
    seat,
    listRelayChildrenByMainSession: vi.fn((sid: string) => relay.list(sid)),
    reapBackgroundTasks: vi.fn(async () => {}),
  } satisfies ReclaimSessionDeps
}

/** 真 SessionService（构造依赖全桩化，形态照抄 test/session-viewed-at.test.ts 装置）。 */
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
  // getSkillPaths：restoreSession 的 launch 参数解析链（resolveSkillPaths）消费
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
  return { service, pm, sessionStore }
}

/** 让 reclaim 的 setImmediate 尾扫回调先于本 await 后续执行（setImmediate FIFO）。 */
async function flushSetImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

// ── 七步编排主路径（D3） ──────────────────────────────────────

describe('reclaimManagedSession 七步编排（D3）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('主路径：detach → destroy → 摘除 → 尾扫快照 kill → finally 释放占座', async () => {
    const { lifecycle, deps } = makeLifecycle()
    const pm = deps.pm
    await attachSession(lifecycle, pm, 's-1')
    const seat = new ReclaimSeat()
    const relay = makeRelayFake()
    const reclaimDeps = makeReclaimDeps(seat, relay)
    relay.register('s-1')

    const ok = await lifecycle.reclaimManagedSession('s-1', reclaimDeps)

    expect(ok).toBe(true)
    // ③ detach（adapter 停事件流）
    const record = lifecycle.get('s-1')
    expect(record).toBeUndefined() // ⑥b Map 条目已摘除（detach 后置断言见 detach spy 行）
    expect((deps.registerDeps.adapterFactory as ReturnType<typeof vi.fn>).mock.results[0]?.value.detach).toHaveBeenCalled()
    // ④ 进程销毁
    expect(pm.destroySession).toHaveBeenCalledWith('s-1')
    expect(pm.clientsById.has('s-1')).toBe(false)
    // ⑤① relay 尾扫：setImmediate 后 kill 执行（fire-and-forget 不占座）
    await flushSetImmediate()
    expect(relay.killSpies[0]).toHaveBeenCalledTimes(1)
    // ⑤② 定向后台收殓
    expect(reclaimDeps.reapBackgroundTasks).toHaveBeenCalledWith('s-1')
    // ⑦ finally 释放占座
    expect(seat.isHeld('s-1')).toBe(false)
  })

  it('占座互斥：seat 已被占（并发回收在途）→ 返回 false 且零销毁动作', async () => {
    const { lifecycle, deps } = makeLifecycle()
    await attachSession(lifecycle, deps.pm, 's-1')
    const seat = new ReclaimSeat()
    expect(seat.tryAcquire('s-1')).toBe(true)
    const relay = makeRelayFake()
    const reclaimDeps = makeReclaimDeps(seat, relay)

    const ok = await lifecycle.reclaimManagedSession('s-1', reclaimDeps)

    expect(ok).toBe(false)
    expect(deps.pm.destroySession).not.toHaveBeenCalled()
    expect(lifecycle.get('s-1')).toBeDefined() // 条目未动
    expect(seat.isHeld('s-1')).toBe(true) // 原持有者的占座未被误放
  })

  it('最终豁免检查（步骤②同步块）：occupancy 非空闲 → false，零销毁零摘除', async () => {
    const { lifecycle, deps } = makeLifecycle()
    const client = await attachSession(lifecycle, deps.pm, 's-1')
    // occupancy 翻转（豁免 #1 信号源）
    const record = lifecycle.get('s-1')!
    record.occupancy = { turn: 'generating', compacting: false, bash: false }
    void client
    const seat = new ReclaimSeat()
    const reclaimDeps = makeReclaimDeps(seat, makeRelayFake())

    const ok = await lifecycle.reclaimManagedSession('s-1', reclaimDeps)

    expect(ok).toBe(false)
    expect(deps.pm.destroySession).not.toHaveBeenCalled()
    expect(lifecycle.get('s-1')).toBeDefined()
    expect(seat.isHeld('s-1')).toBe(false) // 早退分支也经 finally 释放
  })

  it('条目不存在（已删/未附着）→ false', async () => {
    const { lifecycle, deps } = makeLifecycle()
    const seat = new ReclaimSeat()
    const ok = await lifecycle.reclaimManagedSession('ghost', makeReclaimDeps(seat, makeRelayFake()))
    expect(ok).toBe(false)
    expect(deps.pm.destroySession).not.toHaveBeenCalled()
  })

  it('占座 finally 释放：中途抛异常（detach / destroy）异常向上传播且 seat 必然释放', async () => {
    const { lifecycle, deps } = makeLifecycle()
    await attachSession(lifecycle, deps.pm, 's-detach-fail')
    // detach 抛错：直接改已注册条目的 adapter（adapterFactory 是共享 mock，注入 once 会
    // 泄漏到本用例后续 attachSession 的条目上）
    const record = lifecycle.get('s-detach-fail')!
    ;(record.adapter as { detach: () => void }).detach = () => {
      throw new Error('detach boom')
    }
    const seat1 = new ReclaimSeat()
    await expect(lifecycle.reclaimManagedSession('s-detach-fail', makeReclaimDeps(seat1, makeRelayFake())))
      .rejects.toThrow('detach boom')
    expect(seat1.isHeld('s-detach-fail')).toBe(false)

    // destroy 抛错路径
    await attachSession(lifecycle, deps.pm, 's-destroy-fail')
    deps.pm.destroySession = vi.fn(async () => {
      throw new Error('destroy boom')
    })
    const seat2 = new ReclaimSeat()
    await expect(lifecycle.reclaimManagedSession('s-destroy-fail', makeReclaimDeps(seat2, makeRelayFake())))
      .rejects.toThrow('destroy boom')
    expect(seat2.isHeld('s-destroy-fail')).toBe(false)
  })

  it('代际校验（D6-3 / P6-③）：kill await 窗口内并发重建 → 摘除取消，新条目与新进程保留', async () => {
    const { lifecycle, deps } = makeLifecycle()
    const pm = deps.pm
    const original = await attachSession(lifecycle, pm, 's-1')
    const seat = new ReclaimSeat()
    const relay = makeRelayFake()
    const reclaimDeps = makeReclaimDeps(seat, relay)

    // 模拟并发重建：destroySession resolve 时（kill 窗口末端），绕过 ensureActive 的
    // 恢复入口已完成 pm.createSession + registerSession（新 client 新条目）。
    let releaseDestroy: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseDestroy = () => {
        // 重建注入（同步完成后才 resolve destroy）
        const newClient = makeFakeClient()
        pm.clientsById.set('s-1', newClient)
        void lifecycle.registerSession('s-1', newClient, tmpdir(), 'reborn', join(tmpdir(), 's-1.jsonl'))
        resolve()
      }
    })
    pm.destroySession = vi.fn(async (sessionId: string) => {
      pm.clientsById.delete(sessionId)
      await gate
    })

    // 先启动 reclaim（同步段走到 await destroySession 挂起），后放行 gate——顺序反了会死锁
    const reclaimPromise = lifecycle.reclaimManagedSession('s-1', reclaimDeps)
    releaseDestroy()
    const ok = await reclaimPromise

    expect(ok).toBe(false)
    // 新条目未被误摘（摘除取消）
    const reborn = lifecycle.get('s-1')
    expect(reborn).toBeDefined()
    expect(reborn?.label).toBe('reborn')
    expect(reborn).not.toBe(original as unknown)
    // 新进程保留
    expect(pm.clientsById.has('s-1')).toBe(true)
    // 占座释放（finally 兜底）
    expect(seat.isHeld('s-1')).toBe(false)
    // 尾扫不执行：代际取消路径未采集快照，relay 孤儿留给下一拍判定
    await flushSetImmediate()
    expect(relay.killSpies).toHaveLength(0)
  })

  it('尾扫单段快照：kill await 窗口内落地的 relay 条目被首扫捕获（P4 场景）', async () => {
    const { lifecycle, deps } = makeLifecycle()
    const pm = deps.pm
    await attachSession(lifecycle, pm, 's-1')
    const relay = makeRelayFake()
    const seat = new ReclaimSeat()
    const reclaimDeps = makeReclaimDeps(seat, relay)

    // pi 空闲期 scheduler 类 extension 经 relay socket spawn：kill 窗口内落地
    let releaseDestroy: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseDestroy = resolve })
    pm.destroySession = vi.fn(async (sessionId: string) => {
      pm.clientsById.delete(sessionId)
      relay.register('s-1') // 检查（判定）与 kill 之间落地
      await gate
    })

    // 先启动 reclaim（同步段挂 gate），后放行
    const reclaimPromise = lifecycle.reclaimManagedSession('s-1', reclaimDeps)
    releaseDestroy()
    const ok = await reclaimPromise
    expect(ok).toBe(true)
    await flushSetImmediate()
    // 单段快照：采集时刻已在注册表的条目（哪怕毫秒级前落地）被首扫捕获
    expect(relay.killSpies[0]).toHaveBeenCalledTimes(1)
    expect(reclaimDeps.listRelayChildrenByMainSession).toHaveBeenCalledTimes(1)
  })

  it('尾扫单段快照：reclaim 完成后 restore 新 spawn 的 relay 子进程不被迟到的尾扫命中（P6 尾扫项）', async () => {
    const { lifecycle, deps } = makeLifecycle()
    const pm = deps.pm
    await attachSession(lifecycle, pm, 's-1')
    const relay = makeRelayFake()
    const seat = new ReclaimSeat()
    const reclaimDeps = makeReclaimDeps(seat, relay)

    const ok = await lifecycle.reclaimManagedSession('s-1', reclaimDeps)
    expect(ok).toBe(true)

    // 回收完成后用户切回 session（restore），新 session 经 relay 合法 spawn 子进程
    const newborn = relay.register('s-1')

    await flushSetImmediate()
    // 迟到的尾扫只消费采集时的快照闭包——新条目不被命中（两段式「异步 kill 后二次复查
    // 再杀」被否的原因即此）
    expect(newborn.kill).not.toHaveBeenCalled()
  })

  it('回收不触发死亡语义：无终态写/无死亡汇聚点回调（D3 被跳过步骤归属）', async () => {
    const { lifecycle, deps } = makeLifecycle()
    await attachSession(lifecycle, deps.pm, 's-1')
    const seat = new ReclaimSeat()
    const reclaimDeps = makeReclaimDeps(seat, makeRelayFake())

    await lifecycle.reclaimManagedSession('s-1', reclaimDeps)

    // svc.removeSessionEntry（死亡清理汇聚点）绝不被 reclaim 触达
    expect(deps.svc.removeSessionEntry).not.toHaveBeenCalled()
    expect(deps.svc.notifySessionCreated).not.toHaveBeenCalled()
  })
})

// ── SessionService 集成：ensureActive 让路 / removeSessionEntry 挂点 / D5 ──

describe('SessionService 编排集成（D6-2 / R4 / D5）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('P6-② kill await 期间并发 switch：等待方不抢跑，释放后走 restore，对已摘除条目 no-op 无二次销毁', async () => {
    const { service, pm } = makeService()
    const seat = new ReclaimSeat()
    service.setReclaimSeat(seat)
    const relay = makeRelayFake()
    // 已附着的活跃 session（initializeManagedSession = lifecycle.registerSession 的公有测试委托）
    const client = makeFakeClient()
    pm.clientsById.set('s-1', client)
    await service.initializeManagedSession('s-1', client, tmpdir(), 'label-s-1', join(tmpdir(), 's-1.jsonl'))

    // destroySession 挂 gate（kill ≤2s 窗口），同步段先删 pm 侧 client（既有语义）
    let releaseDestroy: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseDestroy = resolve })
    pm.destroySession = vi.fn(async (sessionId: string) => {
      pm.clientsById.delete(sessionId)
      await gate
    })

    // 死亡汇聚点探测器：removeSessionEntry 触发 onSessionDestroyedHandlers
    const destroyedHandler = vi.fn()
    service.setOnSessionDestroyed(destroyedHandler)

    const reclaimPromise = service.reclaimSession('s-1', makeReclaimDeps(seat, relay))
    // reclaim 同步段已过（seat 占座 + pm client 已删）→ 并发 switch（ensureActive）进入
    expect(pm.clientsById.has('s-1')).toBe(false)
    const ensurePromise = service.ensureActive('s-1')

    // 等待方挂起中：不抢跑——无第二次销毁、死亡汇聚点未触发
    expect(seat.isHeld('s-1')).toBe(true)
    expect(pm.destroySession).toHaveBeenCalledTimes(1)
    expect(destroyedHandler).not.toHaveBeenCalled()

    // kill 完成 → reclaim 完成摘除 → finally 释放 → 等待方苏醒走 restore
    releaseDestroy()
    expect(await reclaimPromise).toBe(true)
    await expect(ensurePromise).rejects.toThrow(/Persisted session/)
    // 无二次销毁：全程 destroySession 恰 1 次（restore 的 existing 清场对已摘除条目 no-op）
    expect(pm.destroySession).toHaveBeenCalledTimes(1)
    // 死亡汇聚点全程未触发（bus.clearSession/destroyPty/didDestroy 家族均无入口）
    expect(destroyedHandler).not.toHaveBeenCalled()
    expect(seat.isHeld('s-1')).toBe(false)
  })

  it('D6-2 等待超时只记 ERROR 观测，绝不抢跑；释放后继续正常路径', async () => {
    vi.useFakeTimers()
    const { service, pm } = makeService()
    const seat = new ReclaimSeat()
    service.setReclaimSeat(seat)
    // 占座实现 bug 的模拟：seat 持有但不释放（reclaim 的 finally 保证被破坏的异常形态）
    seat.tryAcquire('s-1')
    pm.clientsById.delete('s-1')

    const ensurePromise = service.ensureActive('s-1')
    // 两轮观测超时（5s × 2）：每轮记一行 ERROR，等待继续
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    const observeErrors = errorSpy.mock.calls.filter((args: unknown[]) => String(args[0]).includes('never preempt'))
    expect(observeErrors).toHaveLength(2)
    // 未抢跑：restore 链路（会走 findScannedSession/destroySession）从未启动
    expect(pm.destroySession).not.toHaveBeenCalled()

    // 释放后等待方走正常 restore（scanSessions 空 → not found——「走到了」的信号）
    seat.release('s-1')
    await expect(ensurePromise).rejects.toThrow(/Persisted session/)
  })

  it('seat 未注入（缺省 null）时 ensureActive 行为不变（组合根装配前的兼容回归）', async () => {
    const { service } = makeService()
    // 未调 setReclaimSeat
    await expect(service.ensureActive('never-existed')).rejects.toThrow(/Persisted session/)
  })

  it('R4：removeSessionEntry 汇聚点清 lastViewedAt；回收编排（reclaimSession）不清（D2 #6 回收态保留）', async () => {
    const { service, pm } = makeService()
    const seat = new ReclaimSeat()
    service.setReclaimSeat(seat)
    service.markSessionViewed('s-1')
    expect(service.getSessionLastViewedAt('s-1')).toBeDefined()

    // 回收：条目摘除但 lastViewedAt 保留（非候选无害，恢复后继续有效）
    const client = makeFakeClient()
    pm.clientsById.set('s-1', client)
    await service.initializeManagedSession('s-1', client, tmpdir(), 'label-s-1', join(tmpdir(), 's-1.jsonl'))
    const ok = await service.reclaimSession('s-1', makeReclaimDeps(seat, makeRelayFake()))
    expect(ok).toBe(true)
    expect(service.getSessionLastViewedAt('s-1')).toBeDefined()

    // 真删除（死亡汇聚点）：条目清理
    service.markSessionViewed('s-2')
    service.removeSessionEntry('s-2')
    expect(service.getSessionLastViewedAt('s-2')).toBeUndefined()
  })

  it('D5：restoreSession 成功路径输出 elapsed 耗时日志', async () => {
    const { service, pm } = makeService()
    const sessionStore = (service as unknown as { sessionStore: ISessionStore }).sessionStore
    const filePath = join(mkdtempSync(join(tmpdir(), 'reclaim-orch-')), 's-1.jsonl')
    try {
      const target = {
        id: 's-1', filePath, cwd: tmpdir(), name: 'restored',
        launchPresetId: undefined, modelId: undefined, thinkingLevel: undefined,
      }
      ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([target])
      const client = makeFakeClient({
        // attach 断言：pi 回报的写路径与登记路径一致
        getState: vi.fn(async () => ({ sessionId: 'pi-fake', sessionFile: filePath })),
      })
      pm.createSession = vi.fn(async (sessionId: string) => {
        pm.clientsById.set(sessionId, client)
        return client
      })

      const summary = await service.restoreSession('s-1')

      expect(summary.id).toBe('s-1')
      const elapsedLogs = logSpy.mock.calls.filter((args: unknown[]) => String(args[0]).includes('[session-lifecycle] restore s-1 elapsed='))
      expect(elapsedLogs).toHaveLength(1)
    } finally {
      rmSync(filePath, { force: true })
    }
  })
})
