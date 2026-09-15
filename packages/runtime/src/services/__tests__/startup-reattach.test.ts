/**
 * reattach 编排单测（crash-forensics-and-watchdog §3.3 D3，实施单元 u5）。
 *
 * 验收条款逐条对照（impl-plan u5）：
 * - **A1 过滤公式真值表**：shouldReattachEntry 五条件各自独立命中 / 全不命中 / 边界值
 *   （idle 恰等 2h、viewed 恰等 30min——边界走恢复方向，reaper「恰好等于阈值不回收」的对偶）。
 * - **A2 快照布尔反向形态**：backgroundTasks=true 陈旧快照（任务已结束、checkpoint 未刷新）
 *   → 仍恢复；「多恢复自收敛」由新 runtime reaper 按 checkpoint 时间戳正常回收（既有行为，
 *   idle-pi-reaper.checkpoint.test.ts 守卫），本文件断言恢复判定读快照布尔。
 * - **A3 live 孤儿未收割完不 spawn**：收割 promise 未 resolve 时编排不启动 restore（假收割
 *   promise 控制时序）；收割超上界 → 全部候选 reattach-skipped + 删 checkpoint。
 * - **A4 高水位延迟不依赖采样环**：冷启动逐拍即时查询——首拍高压推迟、缓解后恢复；
 *   mem-pressure 纯函数侧单样本判定的证据见 infra/__tests__/mem-pressure.test.ts。
 * - **A5 reattach-skipped 逐 session**：staleness 命中 / restore 失败 / 收割超时各自产生
 *   台账行（sessionId/reason 断言）；过滤排除不记（设计内「不恢复」语义，非异常）。
 * - **A6 checkpoint 删除属主**：全部尝试完后文件被删（含全跳过/零候选形态）。
 * - **组合根挂点**：index.ts 源码顺序断言——runStartupReattach 在 await server.start() 之后
 *   （D3「listen 后」硬约束）。
 * - **收割 promise 交付**：startup-background-init 的 onOrphanReapChainScheduled 在调度后
 *   同步交付、链尾 settle 后 resolve（u5 消费面的接线证据）。
 *
 * 全部文件目标 = mkdtempSync(tmpdir) 自建自删（fs-guard 白名单）；递归删除带 maxRetries。
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/startup-reattach.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent, CrashJournalWriter } from '@taiji/shared'
import { RUN_CHECKPOINT_FILENAME as CHECKPOINT_FILENAME } from '@taiji/shared/paths'
import { RuntimeCheckpointStore } from '../session/runtime-checkpoint.js'
import type { RuntimeCheckpointEntry } from '../session/runtime-checkpoint.js'
import type { MemPressureSample } from '../../infra/mem-pressure.js'
import {
  DEFAULT_HIGH_WATER_POLL_MS,
  REATTACH_SKIP_REAP_TIMEOUT,
  REATTACH_SKIP_RESTORE_FAILED,
  REATTACH_SKIP_STALENESS,
  runStartupReattach,
  shouldReattachEntry,
  type StartupReattachDeps,
  type StartupReattachOptions,
} from '../startup-reattach.js'
import { runStartupBackgroundInit } from '../startup-background-init.js'
import type { ExtensionService } from '../extension-service.js'
import type { ProcessManager } from '../../infra/pi/process-manager.js'
import type { SkillRegistry } from '../skill-registry.js'
import type { PluginService } from '../plugin-service/plugin-service.js'
import type { PiConfigStore } from '../../infra/pi/pi-config-store.js'
import type { AuthStorage } from '../auth/auth-storage.js'

const HOUR = 3_600_000
const MIN = 60_000
/** 恒定可控时钟（A1 边界值精确到毫秒）。 */
const T0 = 1_700_000_000_000

/** mem-pressure 注入样本：常态（swap 未知 + 空闲 50% → 不高压）。 */
const calmSample: MemPressureSample = { swapUsedMB: null, swapTotalMB: null, freeMB: 8 * 1024, totalMB: 16 * 1024 }
/** mem-pressure 注入样本：swap 近耗尽（占比 0.99 ≥ 0.95 → 高压）。 */
const highSample: MemPressureSample = { swapUsedMB: 990, swapTotalMB: 1000, freeMB: 8 * 1024, totalMB: 16 * 1024 }

const createdDirs: string[] = []
let runDir: string

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'startup-reattach-'))
  createdDirs.push(runDir)
  // 收殓 mock 调用计数按用例隔离（收割交付用例断言 toHaveBeenCalledTimes）
  rh.reapOrphanPiProcesses.mockClear()
})

afterAll(() => {
  // maxRetries + retryDelay（教训 d9ad39cb8）：teardown 递归删除瞬态重试
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/** 构造 checkpoint 条目（缺省 = 全条件不命中：无占用、无布尔、无时间戳）。 */
function entry(overrides: Partial<RuntimeCheckpointEntry>): RuntimeCheckpointEntry {
  return {
    piSessionId: 's1',
    filePath: join(runDir, 's1.jsonl'),
    lastActivityAt: null,
    lastViewedAt: null,
    occupancy: 'idle',
    backgroundTasks: false,
    relayChildren: false,
    ...overrides,
  }
}

/** A1 基准窗口：与 reaper 既有 shared SSOT 同值（2h / 30min）。 */
const filterInput = { nowMs: T0, idleWindowMs: 2 * HOUR, viewedWindowMs: 30 * MIN }

interface Harness {
  store: RuntimeCheckpointStore
  events: CrashJournalEvent[]
  journal: CrashJournalWriter
  /** restore spy（vi.fn 实例，断言 toHaveBeenCalled* 直接可用）。 */
  restore: (sessionId: string) => Promise<unknown>
  checkpointPath: string
  /** A3 时序控制柄：resolve 收割 promise。 */
  settleHarvest: () => void
  harvestPromise: Promise<void>
}

function makeHarness(): Harness {
  const events: CrashJournalEvent[] = []
  const journal: CrashJournalWriter = { append: (e) => { events.push(e) } }
  const store = new RuntimeCheckpointStore({ dir: runDir, now: () => T0, journal })
  let settleHarvest: () => void = () => {}
  const harvestPromise = new Promise<void>((resolve) => { settleHarvest = resolve })
  const restore = vi.fn(async (_sessionId: string) => undefined)
  return {
    store,
    events,
    journal,
    restore,
    checkpointPath: join(runDir, CHECKPOINT_FILENAME),
    settleHarvest,
    harvestPromise,
  }
}

/** 编排依赖：缺省 restore=spy、收割=pending（settleHarvest 手动放行）。 */
function makeDeps(h: Harness, overrides: Partial<StartupReattachDeps> = {}): StartupReattachDeps {
  return {
    restore: (sid) => h.restore(sid),
    waitForOrphanReap: () => h.harvestPromise,
    ...overrides,
  }
}

/** 编排选项基线：时钟恒定 / delay 即过 / mem 常态 / 文件存在性恒真（非 staleness 用例的探针免建真实文件）。 */
function makeOptions(h: Harness, overrides: Partial<StartupReattachOptions> = {}): StartupReattachOptions {
  return {
    now: () => T0,
    journal: h.journal,
    checkpoint: h.store,
    delay: async () => {},
    queryMemPressure: async () => calmSample,
    fileExists: () => true,
    ...overrides,
  }
}

/** 写入候选并落盘 checkpoint（store.upsertSession 即落盘）。 */
function seed(h: Harness, entries: RuntimeCheckpointEntry[]): void {
  for (const e of entries) {
    h.store.upsertSession({
      sessionId: e.piSessionId,
      filePath: e.filePath,
      activityAt: e.lastActivityAt ?? undefined,
      viewedAt: e.lastViewedAt ?? undefined,
      occupancy: e.occupancy,
      backgroundTasks: e.backgroundTasks,
      relayChildren: e.relayChildren,
    })
  }
}

function skipEvents(events: CrashJournalEvent[]): CrashJournalEvent[] {
  return events.filter((e) => e.event === 'reattach-skipped')
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 过滤公式真值表（shouldReattachEntry 纯函数）
// ─────────────────────────────────────────────────────────────────────────────

describe('A1 shouldReattachEntry 真补集过滤公式（D3）', () => {
  it('条件①：occupancy 非 idle（三维占用任一命中）→ 恢复，与其他条件无关', () => {
    expect(shouldReattachEntry(entry({ occupancy: 'occupied' }), filterInput)).toBe(true)
    // 安静长 turn 反例④：idle 超 2h、从未查看，但占用中 → 必须恢复
    expect(shouldReattachEntry(entry({
      occupancy: 'occupied',
      lastActivityAt: T0 - 3 * HOUR,
    }), filterInput)).toBe(true)
  })

  it('条件②：backgroundTasks 快照 true → 恢复（反例③：后台任务结束后切走）', () => {
    expect(shouldReattachEntry(entry({
      backgroundTasks: true,
      lastActivityAt: T0 - 3 * HOUR,
    }), filterInput)).toBe(true)
  })

  it('条件③：relayChildren 快照 true → 恢复', () => {
    expect(shouldReattachEntry(entry({
      relayChildren: true,
      lastActivityAt: T0 - 3 * HOUR,
    }), filterInput)).toBe(true)
  })

  it('条件④：idle 3min → 恢复（反例②：崩溃前的活跃 session）', () => {
    expect(shouldReattachEntry(entry({ lastActivityAt: T0 - 3 * MIN }), filterInput)).toBe(true)
  })

  it('条件④边界：idle 恰等 2h → 恢复（边界走恢复方向：reaper idleMs > 阈值才回收的对偶）', () => {
    expect(shouldReattachEntry(entry({ lastActivityAt: T0 - 2 * HOUR }), filterInput)).toBe(true)
  })

  it('条件④越界：idle 2h+1ms（viewed 缺失、无豁免）→ 不恢复（reaper 将回收的形态）', () => {
    expect(shouldReattachEntry(entry({ lastActivityAt: T0 - 2 * HOUR - 1 }), filterInput)).toBe(false)
  })

  it('条件⑤：viewed 10min 前 → 恢复（反例①：45min 未活动但刚查看过）', () => {
    expect(shouldReattachEntry(entry({
      lastActivityAt: T0 - 45 * MIN,
      lastViewedAt: T0 - 10 * MIN,
    }), filterInput)).toBe(true)
  })

  it('条件⑤边界：viewed 恰等 30min → 恢复（reaper 豁免 #6「≤ 30 分钟」字面）', () => {
    expect(shouldReattachEntry(entry({ lastViewedAt: T0 - 30 * MIN }), filterInput)).toBe(true)
  })

  it('条件⑤越界：viewed 30min+1ms 且 idle > 2h → 不恢复', () => {
    expect(shouldReattachEntry(entry({
      lastActivityAt: T0 - 3 * HOUR,
      lastViewedAt: T0 - 30 * MIN - 1,
    }), filterInput)).toBe(false)
  })

  it('全不命中（闲置 3h、40min 未查看、无占用无豁免）→ 不恢复（验收 A3 反例②）', () => {
    expect(shouldReattachEntry(entry({
      lastActivityAt: T0 - 3 * HOUR,
      lastViewedAt: T0 - 40 * MIN,
    }), filterInput)).toBe(false)
  })

  it('时间戳 null = 未知 → 该条不命中、其余条照判（errs 方向 = 偏漏恢复，不冒进 spawn）', () => {
    expect(shouldReattachEntry(entry({ lastActivityAt: null, lastViewedAt: null }), filterInput)).toBe(false)
    // lastActivityAt 未知但刚查看过 → viewed 条独立命中
    expect(shouldReattachEntry(entry({ lastViewedAt: T0 - MIN }), filterInput)).toBe(true)
  })

  it('时钟偏斜（lastActivityAt 在未来）→ idle 为负 ≤ 窗口 → 恢复（偏恢复方向，errs-safe）', () => {
    expect(shouldReattachEntry(entry({ lastActivityAt: T0 + 5 * MIN }), filterInput)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A2 快照布尔反向形态（多恢复 → reaper 自收敛）
// ─────────────────────────────────────────────────────────────────────────────

describe('A2 快照布尔反向形态（陈旧 backgroundTasks=true 多恢复，自收敛）', () => {
  it('任务 T 结束、T+≤5min 内崩溃时快照仍 true：idle 超 2h 也恢复（多恢复形态成立）', async () => {
    const h = makeHarness()
    // 陈旧快照：后台任务早已结束但 reaper tick 未刷新布尔；时间戳同样陈旧
    const staleTrue = entry({
      piSessionId: 'stale-bg',
      lastActivityAt: T0 - 5 * HOUR,
      backgroundTasks: true,
    })
    seed(h, [staleTrue])
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(report.candidates).toEqual(['stale-bg'])
    expect(h.restore).toHaveBeenCalledWith('stale-bg')
    // 自收敛的另一半：条目按 checkpoint 时间戳留档，新 runtime reaper 后续拍按
    // lastActivityAt 正常回收（既有行为由 idle-pi-reaper.checkpoint.test.ts 守卫不回归）。
    // 排查口径：持续多恢复且不自收敛 = 公式错误；偶发单次后自收敛 = 快照滞后（D3 原文）。
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A3 live 孤儿未收割完不 spawn / 收割超上界跳过
// ─────────────────────────────────────────────────────────────────────────────

describe('A3 收割等待（P9 消灭双持）', () => {
  it('收割 promise 未 resolve 时编排不启动 restore；resolve 后恢复执行', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'live', lastActivityAt: T0 - MIN })])
    // delay 永不 resolve → race 只能由收割 arm 赢，时序完全由收割 promise 控制
    const pending = runStartupReattach(makeDeps(h), makeOptions(h, {
      delay: () => new Promise<void>(() => {}),
    }))
    // 让编排跑到 race await：收割未完成 → 零 spawn
    await new Promise((r) => setTimeout(r, 0))
    expect(h.restore).not.toHaveBeenCalled()

    h.settleHarvest()
    const report = await pending
    expect(h.restore).toHaveBeenCalledTimes(1)
    expect(h.restore).toHaveBeenCalledWith('live')
    expect(report.restored).toEqual(['live'])
    expect(report.checkpointDeleted).toBe(true)
  })

  it('收割超上界（delay arm 先赢）→ 全部候选记 reap-wait-timeout + 零 spawn + 删 checkpoint', async () => {
    const h = makeHarness()
    const neverHarvest = new Promise<void>(() => {})
    seed(h, [
      entry({ piSessionId: 'a', lastActivityAt: T0 - MIN }),
      entry({ piSessionId: 'b', lastViewedAt: T0 - MIN }),
    ])
    const report = await runStartupReattach(
      makeDeps(h, { waitForOrphanReap: () => neverHarvest }),
      makeOptions(h), // delay 即过 → race 上界 arm 立即赢（超上界形态）
    )
    expect(h.restore).not.toHaveBeenCalled()
    expect(report.restored).toEqual([])
    expect(report.skipped.map((s) => s.reason)).toEqual([REATTACH_SKIP_REAP_TIMEOUT, REATTACH_SKIP_REAP_TIMEOUT])
    const skips = skipEvents(h.events)
    expect(skips).toHaveLength(2)
    expect(skips.map((e) => e.sessionId).sort()).toEqual(['a', 'b'])
    for (const e of skips) expect(e.reason).toBe(REATTACH_SKIP_REAP_TIMEOUT)
    // 超界跳过 = 本实例内全部尝试已终态：checkpoint 删除（A6 语义）
    expect(report.checkpointDeleted).toBe(true)
    expect(existsSync(h.checkpointPath)).toBe(false)
  })

  it('收割 promise 意外 reject（契约违背的防御面）→ 按未收割处理（宁 lazy 不双持）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    const report = await runStartupReattach(
      makeDeps(h, { waitForOrphanReap: () => Promise.reject(new Error('harvest boom')) }),
      makeOptions(h),
    )
    expect(h.restore).not.toHaveBeenCalled()
    expect(report.skipped.map((s) => s.reason)).toEqual([REATTACH_SKIP_REAP_TIMEOUT])
    expect(report.checkpointDeleted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A4 高水位延迟（即时查询，无采样环历史）
// ─────────────────────────────────────────────────────────────────────────────

describe('A4 高水位延迟（mem-pressure 即时查询）', () => {
  it('冷启动首拍即高压 → 推迟 spawn 并轮询，缓解后立即恢复（逐拍即时判定，无历史依赖）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    h.settleHarvest()
    // 查询序列：高压 → 高压 → 常态——每拍都来自当次即时查询（冷启动零历史可用）
    const samples = [highSample, highSample, calmSample]
    const queryMemPressure = vi.fn(async () => samples.shift() ?? calmSample)
    const report = await runStartupReattach(makeDeps(h), makeOptions(h, { queryMemPressure }))
    expect(queryMemPressure).toHaveBeenCalledTimes(3)
    expect(report.highWaterWaits).toBe(2)
    expect(h.restore).toHaveBeenCalledTimes(1)
    expect(report.restored).toEqual(['a'])
    expect(report.checkpointDeleted).toBe(true)
  })

  it('判定时刻无高压 → 零延迟直接恢复（常态路径不被兜底拖累）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    h.settleHarvest()
    const queryMemPressure = vi.fn(async () => calmSample)
    const report = await runStartupReattach(makeDeps(h), makeOptions(h, { queryMemPressure }))
    expect(queryMemPressure).toHaveBeenCalledTimes(1)
    expect(report.highWaterWaits).toBe(0)
    expect(report.restored).toEqual(['a'])
  })

  it('mem 查询意外抛错（契约违背的防御面）→ 不阻塞恢复', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h, {
      queryMemPressure: async () => { throw new Error('query boom') },
    }))
    expect(report.highWaterWaits).toBe(0)
    expect(report.restored).toEqual(['a'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A5 reattach-skipped 逐 session 台账
// ─────────────────────────────────────────────────────────────────────────────

describe('A5 reattach-skipped 事件（逐 session 一条）', () => {
  it('staleness 命中：filePath=null 与文件缺失各自产生一条（reason=file-missing），不 spawn', async () => {
    const h = makeHarness()
    const missingPath = join(runDir, 'deleted-by-user.jsonl')
    const healthyPath = join(runDir, 'healthy.jsonl')
    seed(h, [
      entry({ piSessionId: 'unknown-path', filePath: null }), // pi 延迟写入窗口
      entry({ piSessionId: 'user-deleted', filePath: missingPath }), // 用户已删除
      entry({ piSessionId: 'healthy', filePath: healthyPath }),
    ])
    writeFileSync(healthyPath, '', 'utf8')
    h.settleHarvest()
    // 本用例走真实 fs 存在性查询（tmp 白名单内），校验 guard 默认实现形态
    const report = await runStartupReattach(makeDeps(h), makeOptions(h, { fileExists: (p) => existsSync(p) }))
    // 只有 healthy 尝试 spawn（staleness guard 先于 restore）
    expect(h.restore).toHaveBeenCalledTimes(1)
    expect(h.restore).toHaveBeenCalledWith('healthy')
    expect(report.restored).toEqual(['healthy'])
    expect(report.skipped).toEqual([
      { sessionId: 'unknown-path', reason: REATTACH_SKIP_STALENESS },
      { sessionId: 'user-deleted', reason: REATTACH_SKIP_STALENESS },
    ])
    const skips = skipEvents(h.events)
    expect(skips).toHaveLength(2)
    expect(skips[0]).toMatchObject({ layer: 'runtime', event: 'reattach-skipped', sessionId: 'unknown-path', reason: 'file-missing' })
    expect(String(skips[0]?.detailDigest)).toContain('delayed-write')
    expect(skips[1]).toMatchObject({ sessionId: 'user-deleted', reason: 'file-missing' })
    expect(String(skips[1]?.detailDigest)).toContain(missingPath)
  })

  it('过滤排除不记台账（设计内「不恢复」语义，非异常）', async () => {
    const h = makeHarness()
    seed(h, [
      entry({ piSessionId: 'resting', lastActivityAt: T0 - 3 * HOUR, lastViewedAt: T0 - 40 * MIN }),
      entry({ piSessionId: 'active', lastActivityAt: T0 - MIN }),
    ])
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(report.excluded).toEqual(['resting'])
    expect(report.candidates).toEqual(['active'])
    // 唯一台账行只属于候选失败/跳过面——resting 无任何事件
    expect(skipEvents(h.events)).toHaveLength(0)
    expect(h.restore).not.toHaveBeenCalledWith('resting')
  })

  it('restore 失败：逐 session 记 restore-failed（detailDigest 含错误），批次内其余继续（并发 2 容错）', async () => {
    const h = makeHarness()
    seed(h, [
      entry({ piSessionId: 'boom', lastActivityAt: T0 - MIN }),
      entry({ piSessionId: 'fine', lastActivityAt: T0 - MIN }),
    ])
    h.settleHarvest()
    const restore = vi.fn(async (sid: string) => {
      if (sid === 'boom') throw new Error('pi spawn failed')
      return undefined
    })
    const report = await runStartupReattach(makeDeps(h, { restore }), makeOptions(h))
    expect(restore).toHaveBeenCalledTimes(2) // 失败不阻断批次
    expect(report.restored).toEqual(['fine'])
    expect(report.skipped).toEqual([{ sessionId: 'boom', reason: REATTACH_SKIP_RESTORE_FAILED }])
    const skips = skipEvents(h.events)
    expect(skips).toHaveLength(1)
    expect(skips[0]).toMatchObject({ sessionId: 'boom', reason: 'restore-failed' })
    expect(String(skips[0]?.detailDigest)).toContain('pi spawn failed')
  })

  it('分批并发 2：三候选按 2+1 两批逐批执行，单 session 失败不阻断下一批', async () => {
    const h = makeHarness()
    seed(h, [
      entry({ piSessionId: 'a', lastActivityAt: T0 - MIN }),
      entry({ piSessionId: 'b', lastActivityAt: T0 - MIN }),
      entry({ piSessionId: 'c', lastActivityAt: T0 - MIN }),
    ])
    h.settleHarvest()
    const restore = vi.fn(async (sid: string) => {
      if (sid === 'b') throw new Error('b failed')
      return undefined
    })
    const report = await runStartupReattach(makeDeps(h, { restore }), makeOptions(h))
    expect(restore).toHaveBeenCalledTimes(3)
    expect(report.restored.sort()).toEqual(['a', 'c'])
    expect(report.skipped).toEqual([{ sessionId: 'b', reason: REATTACH_SKIP_RESTORE_FAILED }])
    expect(report.checkpointDeleted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A6 checkpoint 删除属主（D3 契约 1 第二轨）
// ─────────────────────────────────────────────────────────────────────────────

describe('A6 checkpoint 删除（全部尝试完后无条件删）', () => {
  it('全部 restore 成功 → 文件被删', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    h.settleHarvest()
    await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(existsSync(h.checkpointPath)).toBe(false)
  })

  it('中途全跳过（staleness 全命中）→ 文件仍被删（A6「全跳过也删」）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'ghost', filePath: null })])
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(h.restore).not.toHaveBeenCalled()
    expect(report.skipped).toHaveLength(1)
    expect(existsSync(h.checkpointPath)).toBe(false)
    expect(report.checkpointDeleted).toBe(true)
  })

  it('零候选（全被补集排除）→ 零尝试仍删', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'resting', lastActivityAt: T0 - 3 * HOUR, lastViewedAt: T0 - 40 * MIN })])
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(report.candidates).toEqual([])
    expect(h.restore).not.toHaveBeenCalled()
    expect(existsSync(h.checkpointPath)).toBe(false)
    expect(report.checkpointDeleted).toBe(true)
  })

  it('无 checkpoint（clean exit / 首次启动）→ 零动作零 spawn（A3b 冷启动维持 lazy）', async () => {
    const h = makeHarness()
    let harvestAwaited = false
    const report = await runStartupReattach(
      makeDeps(h, { waitForOrphanReap: () => { harvestAwaited = true; return h.harvestPromise } }),
      makeOptions(h),
    )
    expect(report.checkpointFound).toBe(false)
    expect(report.candidates).toEqual([])
    expect(h.restore).not.toHaveBeenCalled()
    // 零动作形态下不应等待收割（无 spawn 风险面）
    expect(harvestAwaited).toBe(false)
    expect(report.checkpointDeleted).toBe(false)
  })

  it('默认删除路径（无注入）：真实 tmp 文件被 unlink（D3 删除属主第二轨走 store.checkpointPath）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    h.settleHarvest()
    const report = await runStartupReattach(makeDeps(h), makeOptions(h))
    expect(report.checkpointDeleted).toBe(true)
    expect(existsSync(h.checkpointPath)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 组合根挂点（D3「listen 后」硬约束）+ 收割 promise 交付（startup-background-init 消费面）
// ─────────────────────────────────────────────────────────────────────────────

describe('组合根挂点与收割 promise 交付', () => {
  it('index.ts 源码顺序断言：runStartupReattach 调用点位于 await server.start() 之后', () => {
    const candidates = [
      join(process.cwd(), 'src/index.ts'),
      join(process.cwd(), 'packages/runtime/src/index.ts'),
    ]
    const srcFile = candidates.find((p) => existsSync(p))
    if (!srcFile) throw new Error(`index.ts not found from cwd=${process.cwd()}`)
    const src = readFileSync(srcFile, 'utf-8')
    const listenAt = src.indexOf('await server.start()')
    const reattachAt = src.indexOf('runStartupReattach(')
    expect(listenAt).toBeGreaterThan(-1)
    expect(reattachAt).toBeGreaterThan(-1)
    expect(reattachAt).toBeGreaterThan(listenAt)
  })

  it('onOrphanReapChainScheduled：调度后同步交付完成 promise，5s 定时器触发且收殓链 settle 后 resolve', async () => {
    vi.useFakeTimers()
    try {
      const delivered: Promise<void>[] = []
      await runStartupBackgroundInit(makeBgDeps((p) => { delivered.push(p) }))
      // 调度即交付（同步段内回调），reattach 编排 await 的就是这份 promise
      expect(delivered).toHaveLength(1)
      let settled = false
      void delivered[0]!.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mockReap.reapOrphanPiProcesses).toHaveBeenCalledTimes(1)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('未传 onOrphanReapChainScheduled 时零行为变化（既有 fire-and-forget 形态不破）', async () => {
    vi.useFakeTimers()
    try {
      await expect(runStartupBackgroundInit(makeBgDeps(undefined))).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mockReap.reapOrphanPiProcesses).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── runStartupBackgroundInit 测试装配（收割交付用例专用）─────────────────────

const rh = vi.hoisted(() => ({
  reapOrphanPiProcesses: vi.fn(async () => ({ scanned: 0, reaped: [], failed: [], unsupported: false })),
}))

vi.mock('../reap-orphan-pi.js', () => ({
  ORPHAN_REAP_DELAY_MS: 5_000,
  reapOrphanPiProcesses: rh.reapOrphanPiProcesses,
}))

vi.mock('../migration/legacy-provider-migration.js', () => ({
  migrateProviderConfig: vi.fn(async () => ({
    catalog: { migrated: [], kept: [], skipped: [], failed: [], errors: [] },
    enabled: { migratedEnabled: false, fullDisabledWarn: false },
  })),
}))

vi.mock('../worktree-config-helper.js', () => ({
  ensureAutoRenameDefault: vi.fn(),
}))

vi.mock('../extension-startup-config.js', () => ({
  ensureDeclaredStartupConfigs: vi.fn(() => ({ ensured: 0, skipped: 0, failed: 0 })),
}))

vi.mock('../session/background-task-reaper.js', () => ({
  reapAllSessionsBackgroundTasks: vi.fn(async () => undefined),
}))

const mockReap = rh

/** runStartupBackgroundInit 最小依赖组（除收殓链外全部 spy/常量对象）。 */
function makeBgDeps(onOrphanReapChainScheduled?: (completion: Promise<void>) => void) {
  // u17 判据 v2：readSpawnMarkers 现为必填 dep（本用例不触发收殓清单消费，null = 清单缺席 fail-safe）
  const readSpawnMarkers = vi.fn(() => null)
  const extensionService = {
    migrateBuiltinExtensions: vi.fn(async () => undefined),
    checkAndAutoUpgrade: vi.fn(async () => []),
    getExtensionPaths: vi.fn(async () => []),
  } as unknown as ExtensionService
  const pm = {
    getPiVersion: vi.fn(async () => '9.9.9'),
  } as unknown as ProcessManager
  const skillRegistry = {
    initGlobal: vi.fn(async () => undefined),
    getGlobalSkills: vi.fn(() => []),
  } as unknown as SkillRegistry
  const pluginService = {
    initialize: vi.fn(async () => undefined),
  } as unknown as PluginService
  return {
    readSpawnMarkers,
    configStore: {} as PiConfigStore,
    authStorage: {} as AuthStorage,
    credentialWriter: { saveCredential: vi.fn() },
    extensionService,
    pm,
    appInfo: { appVersion: '1.2.3', piVersion: 'unknown' },
    broadcastAppInfo: vi.fn(),
    skillRegistry,
    pluginService,
    ...(onOrphanReapChainScheduled ? { onOrphanReapChainScheduled } : {}),
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// #27 reattach:deferred 广播挂点（高水位延迟进入/缓解退出，u7d 承接的横幅半腿）
// ─────────────────────────────────────────────────────────────────────────────

describe('#27 reattach:deferred 广播（进入单发 + 缓解退出单发）', () => {
  it('高压两拍后缓解：进入帧（active=true）与退出帧（active=false）各一次，含 pollMs 与 reason（fake timers 走默认 30s 节拍）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    h.settleHarvest()
    const samples = [highSample, highSample, calmSample]
    const queryMemPressure = vi.fn(async () => samples.shift() ?? calmSample)
    const onDeferredBroadcast = vi.fn()
    // 不注入 delay → 走默认真实 setTimeout（30s 节拍），用 fake timers 推进轮询循环
    const overrides: Partial<StartupReattachOptions> = { queryMemPressure }
    vi.useFakeTimers()
    try {
      const pendingReport = runStartupReattach(makeDeps(h, { onDeferredBroadcast }), makeOptions(h, { queryMemPressure }))
      await vi.advanceTimersByTimeAsync(DEFAULT_HIGH_WATER_POLL_MS)
      await vi.advanceTimersByTimeAsync(DEFAULT_HIGH_WATER_POLL_MS)
      const report = await pendingReport
      expect(report.highWaterWaits).toBe(2)
      expect(h.restore).toHaveBeenCalledTimes(1) // 缓解后恢复执行（广播不阻塞编排链）
      expect(onDeferredBroadcast).toHaveBeenCalledTimes(2)
      expect(onDeferredBroadcast).toHaveBeenNthCalledWith(1, {
        active: true, reason: 'high-memory', pollMs: DEFAULT_HIGH_WATER_POLL_MS,
      })
      expect(onDeferredBroadcast).toHaveBeenNthCalledWith(2, {
        active: false, reason: 'high-memory', pollMs: DEFAULT_HIGH_WATER_POLL_MS,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('判定时刻无高压 → 零广播（常态路径不产生任何帧）', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    h.settleHarvest()
    const onDeferredBroadcast = vi.fn()
    await runStartupReattach(makeDeps(h, { onDeferredBroadcast }), makeOptions(h))
    expect(onDeferredBroadcast).not.toHaveBeenCalled()
  })

  it('广播出口抛错（契约违背的防御面）→ 异常被吞、进入/退出两帧都尝试、编排照常完成', async () => {
    const h = makeHarness()
    seed(h, [entry({ piSessionId: 'a', lastActivityAt: T0 - MIN })])
    h.settleHarvest()
    const samples = [highSample, calmSample]
    const onDeferredBroadcast = vi.fn(() => { throw new Error('broadcast boom') })
    const report = await runStartupReattach(makeDeps(h, { onDeferredBroadcast }), makeOptions(h, {
      queryMemPressure: async () => samples.shift() ?? calmSample,
    }))
    expect(onDeferredBroadcast).toHaveBeenCalledTimes(2) // 进入帧与退出帧都未被异常中断
    expect(report.restored).toEqual(['a'])
    expect(report.checkpointDeleted).toBe(true)
  })

  it('组合根接线（#27）：index.ts 的 runStartupReattach 调用带 onDeferredBroadcast → server.broadcast reattach:deferred', () => {
    const candidates = [
      join(process.cwd(), 'src/index.ts'),
      join(process.cwd(), 'packages/runtime/src/index.ts'),
    ]
    const srcFile = candidates.find((p) => existsSync(p))
    if (!srcFile) throw new Error(`index.ts not found from cwd=${process.cwd()}`)
    const src = readFileSync(srcFile, 'utf-8')
    expect(src).toContain("onDeferredBroadcast: (payload) => server.broadcast({ type: 'reattach:deferred', payload })")
  })
})
