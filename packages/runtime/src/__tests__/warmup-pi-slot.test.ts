/**
 * 预热空 pi 单槽单测（session-cold-switch-perf u2-warmup-slot）。
 *
 * 验收覆盖：
 * ① 槽状态机全路径：取用三道检查（槽空 / 签名不匹配 / 探活失败 / 命中）+ 失败即空槽 +
 *    消费驱动补位（无自动重试，下次消费重试）；
 * ② 签名不匹配弃槽回退行为等价断言（接线层：弃槽销毁 + 回退 pm.createSession 现状链；
 *    命中层：rekey 到目标会话而非 createSession）；
 * ③ 冷启动槽恒空断言（构造零副作用、无启动期接线——无消费即无 spawn）；
 * ④ P4 命中率日志四态结构化断言（hit / signature-mismatch / empty / process-dead 各一行）。
 * 附：reattach 让位（busy 推迟 / 上界超时强制发火 / 挂起参数被最新消费覆盖）。
 *
 * 全部用 mock 进程句柄（pid/exited/kill 字面量）与注入时钟，无真实子进程 / 真实 RPC。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WarmupPiSlot,
  WARMUP_SLOT_SESSION_ID,
  isPiProcessAlive,
  type WarmupSlotSchedule,
  type WarmupSlotSpawned,
  type WarmupSlotTarget,
} from '../services/session/warmup-pi-slot.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { IConfigStore } from '../services/ports/config.js'
import type { ISessionStore } from '../services/ports/session.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../services/session/session-internal.js'
import type { IEventAdapter } from '../interfaces.js'

// ── mock 原语 ────────────────────────────────────────────────

/** 冲刷微任务 + 定时器 0 队列（补位 spawn 的 then 链落地）。 */
const flushAsync = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function makeFakeClient(pid: number | null = process.pid, exited = false): IPiEngine {
  // 默认 pid = 测试进程自身（必然存活）——探活是真实 process.kill(pid, 0)，字面量 pid
  // 会被 OS 判 ESRCH 而误入 process-dead 分支。
  return {
    pid,
    exited,
    kill: vi.fn(async () => {}),
  } as unknown as IPiEngine
}

/** 可注入失败序列的 spawn 桩：calls 记录消费参数，failures 队首非空时本次 spawn 抛错。 */
function makeSpawnPool() {
  const calls: Array<{ slotSessionId: string; target: WarmupSlotTarget }> = []
  const clients: IPiEngine[] = []
  const failures: unknown[] = []
  const spawn = vi.fn(async (slotSessionId: string, target: WarmupSlotTarget): Promise<WarmupSlotSpawned> => {
    calls.push({ slotSessionId, target })
    if (failures.length > 0) throw failures.shift()
    const client = makeFakeClient()
    clients.push(client)
    return { client, allExtPaths: [`ext-for-${target.presetId}`] }
  })
  return { calls, clients, failures, spawn }
}

/** 手动时钟 + 定时器队列（reattach 让位轮询的确定性驱动）。 */
function makeManualClock() {
  let nowMs = 0
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  const schedule: WarmupSlotSchedule = (fn, ms) => {
    const t = { at: nowMs + ms, fn, cancelled: false }
    timers.push(t)
    return () => { t.cancelled = true }
  }
  return {
    now: (): number => nowMs,
    schedule,
    /** 推进时钟并按到期序内联驱动全部到期定时器（tick 链在同一次推进内迭代到不动点）。 */
    advance: (ms: number): void => {
      nowMs += ms
      for (;;) {
        const due = timers.find((t) => !t.cancelled && t.at <= nowMs)
        if (!due) break
        due.cancelled = true
        due.fn()
      }
    },
  }
}

interface HarnessOptions { // oe-exempt:20261029:test:测试 harness 参数包（单文件局部，非架构契约）
  spawnPool?: ReturnType<typeof makeSpawnPool>
  isReattachBusy?: () => boolean
}

function makeSlot(options: HarnessOptions = {}): {
  slot: WarmupPiSlot
  spawn: ReturnType<typeof makeSpawnPool>
  destroy: ReturnType<typeof vi.fn>
  busy: { value: boolean }
  clock: ReturnType<typeof makeManualClock>
} {
  const spawn = options.spawnPool ?? makeSpawnPool()
  const destroy = vi.fn(async () => {})
  const busy = { value: false }
  const clock = makeManualClock()
  const slot = new WarmupPiSlot({
    spawnSlotProcess: spawn.spawn,
    destroySlotProcess: destroy,
    isReattachBusy: options.isReattachBusy ?? (() => busy.value),
    schedule: clock.schedule,
    now: clock.now,
  })
  return { slot, spawn, destroy, busy, clock }
}

const TARGET_A: WarmupSlotTarget = { presetId: 'preset-a', cwd: '/proj/a' }
const TARGET_B: WarmupSlotTarget = { presetId: 'preset-b', cwd: '/proj/a' }

/** 测试侧翻转 fake 进程的退出标记（IPiEngine.exited 对消费者只读，fake 对象运行时可写）。 */
function markExited(client: IPiEngine): void {
  ;(client as { exited: boolean }).exited = true
}

/** 预热到「槽已填充」态：一次 empty 消费触发补位 + 冲刷异步链。 */
async function warmViaConsume(slot: WarmupPiSlot, target: WarmupSlotTarget): Promise<void> {
  expect(slot.take(target).kind).toBe('empty')
  await flushAsync()
}

// ── ① 槽状态机：取用三道检查 ─────────────────────────────────

describe('WarmupPiSlot 取用三道检查', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('检查① 槽空：回退 empty，并按消费目标触发补位', async () => {
    const { slot, spawn } = makeSlot()
    const result = slot.take(TARGET_A)
    expect(result).toEqual({ kind: 'empty' })
    await flushAsync()
    expect(spawn.calls).toEqual([{ slotSessionId: WARMUP_SLOT_SESSION_ID, target: TARGET_A }])
  })

  it('检查③通过 = 命中：返回槽进程句柄（用后不回收）+ 槽立刻补位', async () => {
    const { slot, spawn } = makeSlot()
    await warmViaConsume(slot, TARGET_A)
    const warmedClient = spawn.clients[0]

    const result = slot.take(TARGET_A)
    expect(result).toEqual({
      kind: 'hit',
      client: warmedClient,
      allExtPaths: [`ext-for-${TARGET_A.presetId}`],
      fellBackFromPresetId: undefined,
    })
    // 取用即转移所有权：不杀被取用进程（归目标会话生命周期管理），槽补位新空进程。
    expect(warmedClient.kill).not.toHaveBeenCalled()
    await flushAsync()
    expect(spawn.calls).toHaveLength(2)
    expect(spawn.calls[1]?.target).toEqual(TARGET_A)
  })

  it('检查② 参数签名不匹配：弃槽销毁 + 回退 + 按目标会话参数补位', async () => {
    const { slot, spawn, destroy } = makeSlot()
    await warmViaConsume(slot, TARGET_A)
    const slotClient = spawn.clients[0]

    const result = slot.take(TARGET_B)
    expect(result).toEqual({ kind: 'signature-mismatch' })
    // 弃槽 = 杀掉槽进程（fire-and-forget，不阻塞回退链）。
    expect(destroy).toHaveBeenCalledTimes(1)
    await flushAsync()
    // 后台按目标会话参数补位（§3.3-2 检查②）。
    expect(spawn.calls[1]?.target).toEqual(TARGET_B)
    // 槽进程被销毁而非复用（状态残留不可证伪 → 一次性消费）。
    expect(slotClient.kill).not.toHaveBeenCalled()
  })

  it('检查③ 探活失败（进程死）：清槽回退，不立即补位（等下次消费）', async () => {
    const { slot, spawn, destroy } = makeSlot()
    await warmViaConsume(slot, TARGET_A)
    markExited(spawn.clients[0]!)

    const result = slot.take(TARGET_A)
    expect(result).toEqual({ kind: 'process-dead' })
    expect(destroy).toHaveBeenCalledTimes(1)
    await flushAsync()
    // 死亡环境里补位再死 = 空转：本消费不触发补位（§3.3-2 补位策略段）。
    expect(spawn.calls).toHaveLength(1)
  })

  it('补位在途（spawning）：消费视同槽空回退，不重复触发 spawn', async () => {
    let release!: (s: WarmupSlotSpawned) => void
    const gate = new Promise<WarmupSlotSpawned>((resolve) => { release = resolve })
    const spawn = vi.fn((_id: string, target: WarmupSlotTarget) => {
      void target
      return gate
    })
    const slot = new WarmupPiSlot({
      spawnSlotProcess: spawn,
      destroySlotProcess: vi.fn(async () => {}),
      isReattachBusy: () => false,
    })

    expect(slot.take(TARGET_A).kind).toBe('empty')
    // spawn 在途期间再次消费：视同槽空（不阻塞冷切），不重复 spawn。
    expect(slot.take(TARGET_A).kind).toBe('empty')
    expect(spawn).toHaveBeenCalledTimes(1)

    release({ client: makeFakeClient(), allExtPaths: [] })
    await flushAsync()
    // 槽就绪后同签名消费 = 命中。
    expect(slot.take(TARGET_A).kind).toBe('hit')
  })
})

// ── ①（续）失败即空槽 + 消费驱动补位 ─────────────────────────

describe('WarmupPiSlot 失败即空槽 + 消费驱动补位', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('补位 spawn 失败：槽保持空 + 无自动重试；下次消费经检查①天然重试', async () => {
    const pool = makeSpawnPool()
    pool.failures.push(new Error('spawn failed (transient)'))
    const { slot, spawn } = makeSlot({ spawnPool: pool })

    // 首次消费：补位失败，槽保持空。
    expect(slot.take(TARGET_A).kind).toBe('empty')
    await flushAsync()
    expect(spawn.calls).toHaveLength(1)
    expect(warnSpyHas('slot refill failed')).toBe(true)

    // 无自动重试：无消费时槽保持空（无定时器驱动）。
    await flushAsync()
    expect(spawn.calls).toHaveLength(1)

    // 下次消费：empty 分支顺带再触发补位（消费即天然重试点）→ 本次成功填槽。
    expect(slot.take(TARGET_A).kind).toBe('empty')
    await flushAsync()
    expect(spawn.calls).toHaveLength(2)
    expect(slot.take(TARGET_A).kind).toBe('hit')
  })
})

// ── ② 签名不匹配弃槽回退：接线层行为等价断言 ─────────────────

describe('restoreSession 接线（session-lifecycle）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  // 动态 import（避免 ESM 循环，形态同 session-lifecycle-restore-seeding.test.ts）。
  let SessionLifecycle: typeof import('../services/session/session-lifecycle.js').SessionLifecycle
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'warmup-slot-wiring-'))
    vi.resetModules()
    const mod = await import('../services/session/session-lifecycle.js')
    SessionLifecycle = mod.SessionLifecycle
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeSessionFile(sid: string): string {
    const filePath = join(tmpDir, `${sid}.jsonl`)
    writeFileSync(filePath, `{"type":"session","cwd":"${tmpDir}"}\n`)
    return filePath
  }

  function makeWiring(overrides?: { presetBySid?: Record<string, string> }): {
    lifecycle: InstanceType<typeof SessionLifecycle>
    pm: {
      createSession: ReturnType<typeof vi.fn>
      destroySession: ReturnType<typeof vi.fn>
      rekey: ReturnType<typeof vi.fn>
    }
    clientsBySid: Map<string, IPiEngine>
  } {
    const presetBySid = overrides?.presetBySid ?? { 'sid-a': 'preset-a', 'sid-b': 'preset-b' }
    const clientsBySid = new Map<string, IPiEngine>()
    const spawnClient = (sid: string): IPiEngine => {
      const client = makeFakeClient()
      // 附着链保真：switchSession 记录附着目标，getState 回读同值（真实 pi 的
      // switch_session 永久重绑语义）→ I1 附着断言真实走到比对分支且通过，不落 skip。
      const state: { sessionFile: string | undefined } = { sessionFile: undefined }
      ;(client as unknown as Record<string, unknown>).switchSession = vi.fn(async (filePath: string) => {
        state.sessionFile = filePath
      })
      ;(client as unknown as Record<string, unknown>).getState = vi.fn(async () => ({
        sessionId: sid,
        sessionFile: state.sessionFile,
      }))
      ;(client as unknown as Record<string, unknown>).setSessionName = vi.fn(async () => {})
      clientsBySid.set(sid, client)
      return client
    }

    const createSession = vi.fn(async (sessionId: string, _cwd: string, _options?: unknown) => spawnClient(sessionId))
    const destroySession = vi.fn(async () => {})
    const rekey = vi.fn()
    const pm = { createSession, destroySession, rekey, getClient: vi.fn(() => undefined), onSessionExit: vi.fn(() => () => {}) } as unknown as IProcessManager

    const svc = {
      findScannedSession: vi.fn((sid: string) => sid in presetBySid
        ? {
          id: sid,
          filePath: makeSessionFile(sid),
          cwd: tmpDir,
          timestamp: new Date().toISOString(),
          name: sid,
          outcome: null,
          lastModified: Date.now(),
          size: 100,
          launchPresetId: presetBySid[sid],
        }
        : undefined),
      getLaunchPresetOptions: vi.fn(async () => undefined),
      getExtensionPaths: vi.fn(async () => []),
      getSkillPaths: vi.fn(() => []),
      getReplaceSystemPrompt: vi.fn(() => undefined),
      toSummary: vi.fn((s: Record<string, unknown>) => ({ id: String(s.id), label: 'test', cwd: tmpDir, status: 'idle' as const, lastActiveAt: 0 })),
      fetchAndBroadcastContext: vi.fn(async () => {}),
      removeSessionEntry: vi.fn(),
      notifySessionCreated: vi.fn(),
      getActiveSummaries: vi.fn(() => []),
    } as unknown as ILifecycleSessionOps

    const registerDeps = {
      adapterFactory: vi.fn((): IEventAdapter => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter),
      getMessageBus: vi.fn(() => null),
      broadcastGlobal: vi.fn(),
    } as unknown as ISessionRegisterDeps

    const lifecycle = new SessionLifecycle(
      svc,
      pm,
      { getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })) } as unknown as IConfigStore,
      { scanSessions: vi.fn(() => []) } as unknown as ISessionStore,
      {} as unknown as WorkspaceService,
      registerDeps,
    )
    return { lifecycle, pm: { createSession, destroySession, rekey }, clientsBySid }
  }

  it('签名不匹配：弃槽销毁（槽 id）+ 回退 pm.createSession 现状链（行为等价断言）', async () => {
    const { lifecycle, pm } = makeWiring()

    // 首次冷切：槽空 → 回退现状链建 sid-a + 后台补位（槽进程 = createSession(槽 id)）。
    await lifecycle.restoreSession('sid-a')
    expect(pm.createSession).toHaveBeenCalledWith(
      WARMUP_SLOT_SESSION_ID,
      tmpDir,
      expect.objectContaining({ inheritSessionModel: true }),
    )
    await flushAsync()

    // 第二次冷切不同 preset 会话：签名不匹配 → 弃槽销毁 + 回退现状链建 sid-b。
    await lifecycle.restoreSession('sid-b')
    expect(pm.destroySession).toHaveBeenCalledWith(WARMUP_SLOT_SESSION_ID)
    expect(pm.createSession).toHaveBeenCalledWith(
      'sid-b',
      tmpDir,
      expect.objectContaining({ inheritSessionModel: true }),
    )
  })

  it('命中：槽进程 rekey 到目标会话（归属转移），不经 createSession 重开', async () => {
    const { lifecycle, pm, clientsBySid } = makeWiring({ presetBySid: { 'sid-a': 'preset-a', 'sid-b': 'preset-a' } })

    await lifecycle.restoreSession('sid-a')
    await flushAsync()
    const slotClient = clientsBySid.get(WARMUP_SLOT_SESSION_ID)
    expect(slotClient).toBeDefined()

    // 同 preset 同 cwd 的第二次冷切：三道检查全过 → rekey 归属转移（tee 树随迁 + exit 反查正确）。
    await lifecycle.restoreSession('sid-b')
    expect(pm.rekey).toHaveBeenCalledWith(WARMUP_SLOT_SESSION_ID, 'sid-b')
  })
})

// ── ③ 冷启动槽恒空（无启动期接线）────────────────────────────

describe('冷启动槽恒空', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('构造零副作用：不 spawn、不挂定时器（无启动期预热接线）', async () => {
    const { slot, spawn } = makeSlot()
    expect(spawn.calls).toHaveLength(0)
    await flushAsync()
    // 无任何消费驱动下，槽保持空 = 冷启动（lastViewedAtBySession 空表、无 switch）恒空。
    expect(slot.take(TARGET_A).kind).toBe('empty')
  })
})

// ── ④ P4 命中率结构化日志（四态）─────────────────────────────

describe('P4 命中率日志（消费路径一行结构化）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  function outcomeLines(): string[] {
    return logSpy.mock.calls
      .map((args: unknown[]) => args.map(String).join(' '))
      .filter((line: string) => line.startsWith('[warmup] slot outcome='))
  }

  it('四态各产生一行 outcome=<态> 结构化日志', async () => {
    const { slot, spawn } = makeSlot()

    // empty。
    slot.take(TARGET_A)
    expect(outcomeLines().at(-1)).toContain('outcome=empty')
    await flushAsync()

    // hit。
    slot.take(TARGET_A)
    expect(outcomeLines().at(-1)).toContain('outcome=hit')
    await flushAsync()

    // signature-mismatch：以不同签名消费（弃槽 + 按目标参数补位）。
    slot.take(TARGET_B)
    expect(outcomeLines().at(-1)).toContain('outcome=signature-mismatch')
    await flushAsync()

    // process-dead：补位就绪（槽 = B）后标记退出，同签名消费命中检查③。
    markExited(spawn.clients.at(-1)!)
    slot.take(TARGET_B)
    expect(outcomeLines().at(-1)).toContain('outcome=process-dead')

    // 四态各恰一行（本用例内每种 outcome 恰好消费一次）。
    const outcomes = outcomeLines().map((line) => line.replace('[warmup] slot outcome=', '').split(' ')[0])
    expect(outcomes).toEqual(['empty', 'hit', 'signature-mismatch', 'process-dead'])
  })
})

// ── reattach 让位（§3.3-6）───────────────────────────────────

describe('WarmupPiSlot reattach 让位', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('reattach 活跃：补位推迟；busy 解除后至多一个轮询间隔内发火', async () => {
    const { slot, spawn, busy, clock } = makeSlot()

    // busy 期间消费：回退照常（不阻塞冷切），补位被推迟（无 spawn）。
    busy.value = true
    expect(slot.take(TARGET_A).kind).toBe('empty')
    await flushAsync()
    expect(spawn.calls).toHaveLength(0)

    // busy 解除：下一个轮询 tick 发火，补位参数 = 挂起的消费目标。
    busy.value = false
    clock.advance(1_000)
    await flushAsync()
    expect(spawn.calls).toEqual([{ slotSessionId: WARMUP_SLOT_SESSION_ID, target: TARGET_A }])
  })

  it('busy 持续超让位上界（60s）：强制发火', async () => {
    const { slot, spawn, busy, clock } = makeSlot()
    busy.value = true
    expect(slot.take(TARGET_A).kind).toBe('empty')
    await flushAsync()
    expect(spawn.calls).toHaveLength(0)

    clock.advance(60_000)
    await flushAsync()
    expect(spawn.calls).toHaveLength(1)
  })

  it('让位推迟期间的后续消费更新挂起参数（最新消费意图即最新候选）', async () => {
    const { slot, spawn, busy, clock } = makeSlot()
    busy.value = true
    expect(slot.take(TARGET_A).kind).toBe('empty')
    expect(slot.take(TARGET_B).kind).toBe('empty')

    busy.value = false
    clock.advance(1_000)
    await flushAsync()
    // 只发火一次，且参数 = 最后一次消费的目标。
    expect(spawn.calls).toEqual([{ slotSessionId: WARMUP_SLOT_SESSION_ID, target: TARGET_B }])
  })
})

// ── idle 超时自杀（§3.3-2 资源兜底）──────────────────────────

describe('WarmupPiSlot idle 超时自杀（§3.3-2 资源兜底）', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  /** 手动时钟 + 注入短 idle 超时的槽（idle 超时 = 实现参数，测试注入可控值）。 */
  function makeIdleSlot(idleTimeoutMs: number) {
    const spawn = makeSpawnPool()
    const destroy = vi.fn(async () => {})
    const clock = makeManualClock()
    const slot = new WarmupPiSlot({
      spawnSlotProcess: spawn.spawn,
      destroySlotProcess: destroy,
      isReattachBusy: () => false,
      schedule: clock.schedule,
      now: clock.now,
      idleTimeoutMs,
    })
    return { slot, spawn, destroy, clock }
  }

  it('槽就绪后空闲满超时：销毁槽进程清槽；下次消费经 empty 回退 + 补位（重预热）', async () => {
    const { slot, spawn, destroy, clock } = makeIdleSlot(5_000)
    await warmViaConsume(slot, TARGET_A)
    expect(spawn.calls).toHaveLength(1)

    clock.advance(4_999)
    expect(destroy).not.toHaveBeenCalled()
    clock.advance(1)
    expect(destroy).toHaveBeenCalledTimes(1) // idle 自杀清槽

    // 设计「超时自杀，被取用时重预热」：下次消费走检查①（empty → 回退 + 顺带补位）。
    expect(slot.take(TARGET_A).kind).toBe('empty')
    await flushAsync()
    expect(spawn.calls).toHaveLength(2)
    expect(spawn.calls[1]?.target).toEqual(TARGET_A)
  })

  it('消费命中取消 idle 定时器：被取用进程不因 idle 到期被销毁，新补位槽按新生命周期计时', async () => {
    const { slot, spawn, destroy, clock } = makeIdleSlot(5_000)
    await warmViaConsume(slot, TARGET_A)
    const warmedClient = spawn.clients[0]!

    expect(slot.take(TARGET_A).kind).toBe('hit') // 消费命中（timer 已取消）
    await flushAsync() // 命中触发的补位落定（新槽 timer 计时起点）
    expect(warmedClient.kill).not.toHaveBeenCalled()

    clock.advance(4_999)
    expect(destroy).not.toHaveBeenCalled() // 旧 timer（已取消）不误发；新槽未满超时
    clock.advance(1)
    expect(destroy).toHaveBeenCalledTimes(1) // 到期自杀的是新补位槽，非被取用进程
  })

  it('世代防护：条目被替换后旧 idle 定时器作废（不误杀新槽）', async () => {
    const { slot, spawn, destroy, clock } = makeIdleSlot(5_000)
    await warmViaConsume(slot, TARGET_A) // 槽 A 落定（timer A 计 5s）
    // 签名不匹配弃槽 A（销毁 1 次）+ 补位 B（timer B 重新计 5s）；timer A 随取消作废。
    expect(slot.take(TARGET_B).kind).toBe('signature-mismatch')
    expect(destroy).toHaveBeenCalledTimes(1)
    await flushAsync()

    clock.advance(5_000)
    // 唯一新增销毁 = timer B 的自杀（恰第 2 次）；timer A 若误发会多出第 3 次。
    expect(destroy).toHaveBeenCalledTimes(2)
    expect(slot.take(TARGET_B).kind).toBe('empty') // 槽已被 B 的自杀清空
  })
})

// ── 探活原语（存在性检查，禁 RPC）────────────────────────────

describe('isPiProcessAlive（pid 存活 + exited 标记）', () => {
  it('exited 标记 = 死；pid null = 死；pid 存活 = 活', () => {
    expect(isPiProcessAlive({ exited: true, pid: 4242 })).toBe(false)
    expect(isPiProcessAlive({ exited: false, pid: null })).toBe(false)
    expect(isPiProcessAlive({ exited: false, pid: process.pid })).toBe(true)
  })

  it('pid 存活检查走 process.kill(pid, 0)：ESRCH = 死，EPERM = 活', () => {
    const esrch = new Error('esrch') as NodeJS.ErrnoException
    esrch.code = 'ESRCH'
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch
    })
    try {
      expect(isPiProcessAlive({ exited: false, pid: 12345 })).toBe(false)
    } finally {
      killSpy.mockRestore()
    }

    const eperm = new Error('eperm') as NodeJS.ErrnoException
    eperm.code = 'EPERM'
    const killSpy2 = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw eperm
    })
    try {
      expect(isPiProcessAlive({ exited: false, pid: 12345 })).toBe(true)
    } finally {
      killSpy2.mockRestore()
    }
  })
})

// ── 断言辅助 ─────────────────────────────────────────────────

function warnSpyHas(substring: string): boolean {
  return vi.mocked(console.warn).mock.calls.some((args) => args.map(String).join(' ').includes(substring))
}
