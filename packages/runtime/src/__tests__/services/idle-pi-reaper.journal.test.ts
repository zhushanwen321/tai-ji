/**
 * 空闲回收 → 崩溃台账 reclaimed 事件接线测试（crash-forensics-and-watchdog §3.3 D1
 * reclaimed 行——idle-pi-reclamation.md 预登记「阶段二台账落地后追加」的兑现，实施单元
 * u1d2）。
 *
 * 锁定（验收条款逐条对照）：
 * - ② reclaim 成功 → 台账 reclaimed 事件：layer=pi、sessionId、idleMs（判定时刻空闲
 *   时长，与 D7 日志行同源）、lastViewedAt（epoch ms；从未被查看落显式 null）。
 * - ④ 防误记：未到空闲阈值（belowThreshold，含恰好等于阈值的边界语义）、reclaim 被
 *   最终豁免拦截（返回 false）、七类豁免命中 → 零台账事件。
 *
 * 台账走真实 writer（initCrashJournal → mkdtemp tmp → closeCrashJournal 确定性 flush
 * 后逐行 JSON.parse），顺带锁住「writer spread 序列化保留 schema 外扩展字段（idleMs /
 * lastViewedAt）」的行为。reaper 依赖全部 fake（零真实进程/真实数据目录）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/services/idle-pi-reaper.journal.test.ts
 */
import { describe, expect, it } from 'vitest'
import { closeCrashJournal, initCrashJournal } from '../../infra/crash-journal.js'
import { setupCrashJournalHarness } from '../helpers/crash-journal-test-support.js'
import {
  ReclaimSeat,
  startIdlePiReaper,
  type IdlePiReaperOptions,
  type ReclaimExemptions,
} from '../../services/session/idle-pi-reaper.js'

/** 台账装置：mkdtemp 数据目录生命周期 + 活跃档读取（两处 journal 直测共享 helper）。 */
const journal = setupCrashJournalHarness('reaper-journal-')

// ── fake 装置 ─────────────────────────────────────────────────

/** 恒定时钟基准（idleMs 断言可精确到毫秒）。 */
const NOW = 1_000_000
/** 空闲阈值 60s；被查看窗口 30s（makeHarness 内）。 */
const IDLE_THRESHOLD_MS = 60_000

interface FakeState {
  activityAt?: number
  viewedAt?: number
}

interface Harness {
  options: IdlePiReaperOptions
  states: Map<string, FakeState>
}

/**
 * 最小 fake 装置：NOW 恒定、七类豁免默认全放行、reclaim 结果可注入。
 * startIdlePiReaper 后用 handle.runOnce() 触发单拍（tick 传超大值，interval 永不到期，
 * stop 兜底收尾——不依赖 fake timers）。
 */
function makeHarness(seed: Record<string, FakeState>, reclaimResult = true): Harness {
  const states = new Map(Object.entries(seed))
  const seat = new ReclaimSeat()
  const exemptions: ReclaimExemptions = {
    isOccupied: () => false,
    hasRunningBackgroundTasks: () => false,
    hasInflightRelayChildren: () => false,
    hasHandoffInflight: () => false,
    hasQueuedDeliveries: () => false,
    getLastViewedAt: (sid) => states.get(sid)?.viewedAt,
    isRestoring: () => false,
    hasPendingUiRequest: () => false,
  }
  return {
    states,
    options: {
      seat,
      exemptions,
      getClientActivity: (sid) => states.get(sid)?.activityAt,
      listCandidateSessionIds: () => [...states.keys()],
      reclaim: async () => reclaimResult,
      broadcast: () => {},
      now: () => NOW,
      // tick 传超大值：测试只走 runOnce()，interval 永不到期（stop 兜底收尾）
      tickIntervalMs: Number.MAX_SAFE_INTEGER,
      idleThresholdMs: IDLE_THRESHOLD_MS,
      viewedWindowMs: 30_000,
    },
  }
}

describe('idle-pi-reaper → 崩溃台账 reclaimed 事件（D1 矩阵 reclaimed 行）', () => {
  /**
   * 单拍回收驱动（用例共形装置）：init 台账 → 装置种子（可选豁免预调）→ runOnce
   * 单拍 → close flush → 返回台账行。零事件用例直接 toEqual([])，事件用例逐字段断言。
   */
  async function runOnceAndReadJournal(
    seed: Record<string, FakeState>,
    opts: { reclaimResult?: boolean; prepare?: (h: Harness) => void } = {},
  ) {
    initCrashJournal(journal.getDataDir())
    const h = makeHarness(seed, opts.reclaimResult ?? true)
    opts.prepare?.(h)
    const handle = startIdlePiReaper(h.options)
    await handle.runOnce()
    handle.stop()
    await closeCrashJournal()
    return journal.readJournalRecords()
  }

  it('② reclaim 成功：reclaimed 事件含 sessionId/idleMs/lastViewedAt（被查看过的 session）', async () => {
    // activityAt = NOW - 61_000 → idleMs = 61_000，严格大于阈值（恰好等于不回收的
    // 边界语义见 reaper 注释）才进入回收；viewedAt = NOW - 40_000，在 30s 查看豁免
    // 窗口之外（窗口内会被豁免 #6 跳过，不产生回收）
    const viewedAt = NOW - 40_000
    const records = await runOnceAndReadJournal({
      'sid-viewed': { activityAt: NOW - 61_000, viewedAt },
    })
    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.layer).toBe('pi')
    expect(rec.event).toBe('reclaimed')
    expect(rec.sessionId).toBe('sid-viewed')
    expect(rec.idleMs).toBe(61_000)
    expect(rec.lastViewedAt).toBe(viewedAt)
  })

  it('② 从未被查看（viewedAt undefined）：lastViewedAt 落显式 null（不知道 ≠ 没打点）', async () => {
    const records = await runOnceAndReadJournal({
      'sid-never-viewed': { activityAt: NOW - 100_000 },
    })
    expect(records).toHaveLength(1)
    expect(records[0]!.event).toBe('reclaimed')
    expect(records[0]!.sessionId).toBe('sid-never-viewed')
    expect(records[0]!.idleMs).toBe(100_000)
    expect(records[0]!.lastViewedAt).toBeNull()
  })

  it('④ 防误记：空闲未到阈值（belowThreshold）→ 零台账事件', async () => {
    expect(await runOnceAndReadJournal({
      'sid-fresh': { activityAt: NOW - 500 }, // idle = 500 < 60_000
    })).toEqual([])
  })

  it('④ 防误记：恰好等于阈值（边界语义 idleMs > threshold 才回收）→ 零台账事件', async () => {
    expect(await runOnceAndReadJournal({
      'sid-exact': { activityAt: NOW - IDLE_THRESHOLD_MS }, // idleMs === threshold
    })).toEqual([])
  })

  it('④ 防误记：reclaim 返回 false（最终豁免拦截/代际校验取消）→ 零台账事件', async () => {
    expect(await runOnceAndReadJournal(
      { 'sid-blocked': { activityAt: NOW - 200_000 } },
      { reclaimResult: false },
    )).toEqual([])
  })

  it('④ 防误记：七类豁免命中（occupied）→ 零台账事件', async () => {
    expect(await runOnceAndReadJournal(
      { 'sid-occupied': { activityAt: NOW - 300_000 } },
      // 覆写豁免 #1 为命中（装置默认全放行）
      { prepare: (h) => { (h.options.exemptions as { isOccupied: (sid: string) => boolean }).isOccupied = () => true } },
    )).toEqual([])
  })

  it('一拍多回收：每 session 一条 reclaimed 事件，sessionId 与回收清单一致', async () => {
    const records = await runOnceAndReadJournal({
      'sid-a': { activityAt: NOW - 200_000 },
      'sid-b': { activityAt: NOW - 150_000, viewedAt: NOW - 60_000 }, // viewed 距今 > 窗口，不豁免
    })
    expect(records).toHaveLength(2)
    expect(records.map(r => r.sessionId).sort()).toEqual(['sid-a', 'sid-b'])
    for (const rec of records) {
      expect(rec.event).toBe('reclaimed')
      expect(rec.layer).toBe('pi')
    }
  })
})
