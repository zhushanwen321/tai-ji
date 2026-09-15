/**
 * idle-pi-reaper → runtime checkpoint 搭车刷新测试（crash-forensics-and-watchdog §3.3 D3，
 * 实施单元 u4）。
 *
 * 锁定（验收条款逐条对照）：
 * - reaper 5min tick **搭车**刷新 checkpoint 内该 session 的 lastActivityAt / lastViewedAt
 *   （不新增定时器、不新增探测：本拍判定用过的量顺带写入）。
 * - 三长时豁免快照（occupancy / backgroundTasks / relayChildren）同拍写入——它们是 reattach
 *   真补集公式（u5）的输入，豁免查询本来就要算，零新增探测。
 * - 只更新**已存在**条目：未附着候选不因出现在候选表就被写进 checkpoint。
 * - 回收成功的 session 不复活（条目已被 session-service 的 reclaim 挂点摘除）。
 *
 * 台账/checkpoint 走真实 writer（tmp 目录，fs-guard 白名单内）；reaper 依赖全部 fake。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/services/idle-pi-reaper.checkpoint.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRuntimeCheckpointStore, initRuntimeCheckpointStore } from '../../services/session/runtime-checkpoint.js'
import {
  ReclaimSeat,
  startIdlePiReaper,
  type IdlePiReaperOptions,
  type ReclaimExemptions,
} from '../../services/session/idle-pi-reaper.js'

let runDir: string

beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'reaper-checkpoint-'))
  // 单例首调即绑定本目录（幂等，后续 init 不再改绑）
  initRuntimeCheckpointStore({ dir: runDir })
})

beforeEach(() => {
  // 内存清单逐用例复位；磁盘旧版不参与（覆盖式写入）
  getRuntimeCheckpointStore().reset()
})

afterAll(() => {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 恒定时钟（时间戳断言精确到毫秒）。 */
const NOW = 1_000_000
/** 空闲阈值 60s；查看窗口 30s。 */
const IDLE_THRESHOLD_MS = 60_000

interface FakeState {
  activityAt?: number
  viewedAt?: number
  occupied?: boolean
  bgTasks?: boolean
  relay?: boolean
}

interface Harness {
  options: IdlePiReaperOptions
  states: Map<string, FakeState>
  reclaimCalls: string[]
}

/**
 * 最小 fake 装置（形态对齐 idle-pi-reaper.journal.test.ts）：reclaim 成功时模拟
 * session-service 的 reclaim 挂点（从 checkpoint 摘除条目）——「回收不复活」断言的装置基础。
 */
function makeHarness(seed: Record<string, FakeState>): Harness {
  const states = new Map(Object.entries(seed))
  const seat = new ReclaimSeat()
  const reclaimCalls: string[] = []
  const exemptions: ReclaimExemptions = {
    isOccupied: (sid) => states.get(sid)?.occupied ?? false,
    hasRunningBackgroundTasks: (sid) => states.get(sid)?.bgTasks ?? false,
    hasInflightRelayChildren: (sid) => states.get(sid)?.relay ?? false,
    hasHandoffInflight: () => false,
    hasQueuedDeliveries: () => false,
    getLastViewedAt: (sid) => states.get(sid)?.viewedAt,
    isRestoring: () => false,
  }
  const options: IdlePiReaperOptions = {
    seat,
    exemptions,
    getClientActivity: (sid) => states.get(sid)?.activityAt,
    listCandidateSessionIds: () => [...states.keys()],
    reclaim: async (sid) => {
      reclaimCalls.push(sid)
      getRuntimeCheckpointStore().removeSession(sid)
      return true
    },
    broadcast: () => {},
    now: () => NOW,
    tickIntervalMs: Number.MAX_SAFE_INTEGER,
    idleThresholdMs: IDLE_THRESHOLD_MS,
    viewedWindowMs: 30_000,
  }
  return { options, states, reclaimCalls }
}

/** 读 checkpoint 主文件全部条目（不存在 = undefined）。 */
function readCheckpointSessions(): Array<Record<string, unknown>> | undefined {
  const p = getRuntimeCheckpointStore().checkpointPath
  if (!existsSync(p)) return undefined
  return (JSON.parse(readFileSync(p, 'utf8')) as { sessions: Array<Record<string, unknown>> }).sessions
}

describe('idle-pi-reaper 搭车刷新 runtime checkpoint（D3 时效性裁决）', () => {
  it('tick 刷新 lastActivityAt/lastViewedAt（超阈与未超阈候选都刷——时效字段与回收判定解耦）', async () => {
    const store = getRuntimeCheckpointStore()
    store.upsertSession({ sessionId: 'sid-fresh', activityAt: 1, viewedAt: 1 })
    store.upsertSession({ sessionId: 'sid-idle', activityAt: 1 })

    // sid-fresh：idle 500ms < 60s 阈值（belowThreshold）；sid-idle：idle 200s > 阈值
    const h = makeHarness({
      'sid-fresh': { activityAt: NOW - 500, viewedAt: NOW - 400 },
      'sid-idle': { activityAt: NOW - 200_000, viewedAt: NOW - 40_000 },
    })
    const handle = startIdlePiReaper(h.options)
    await handle.runOnce()
    handle.stop()

    const entries = readCheckpointSessions()!
    const byId = new Map(entries.map((e) => [e.piSessionId as string, e]))
    expect(byId.get('sid-fresh')).toMatchObject({ lastActivityAt: NOW - 500, lastViewedAt: NOW - 400 })
    // sid-idle 被回收（reclaim 挂点摘除条目）——不复活；其刷新值不残留
    expect(byId.has('sid-idle')).toBe(false)
    expect(h.reclaimCalls).toEqual(['sid-idle'])
  })

  it('三长时豁免快照同拍写入（reattach 真补集公式的输入）', async () => {
    const store = getRuntimeCheckpointStore()
    for (const sid of ['sid-occ', 'sid-bg', 'sid-relay']) {
      store.upsertSession({ sessionId: sid, activityAt: 1 })
    }
    const h = makeHarness({
      'sid-occ': { activityAt: NOW - 300_000, occupied: true },
      'sid-bg': { activityAt: NOW - 300_000, bgTasks: true },
      'sid-relay': { activityAt: NOW - 300_000, relay: true },
    })
    const handle = startIdlePiReaper(h.options)
    await handle.runOnce()
    handle.stop()

    const byId = new Map(readCheckpointSessions()!.map((e) => [e.piSessionId as string, e]))
    expect(byId.get('sid-occ')).toMatchObject({ occupancy: 'occupied', backgroundTasks: false, relayChildren: false })
    expect(byId.get('sid-bg')).toMatchObject({ occupancy: 'idle', backgroundTasks: true, relayChildren: false })
    expect(byId.get('sid-relay')).toMatchObject({ occupancy: 'idle', backgroundTasks: false, relayChildren: true })
    // 三者都被豁免拦截 → 零回收
    expect(h.reclaimCalls).toEqual([])
  })

  it('只更新已存在条目：未附着候选不因出现在候选表就被写进 checkpoint', async () => {
    getRuntimeCheckpointStore().upsertSession({ sessionId: 'sid-known', activityAt: 1 })
    const h = makeHarness({
      'sid-known': { activityAt: NOW - 500 },
      'sid-unknown': { activityAt: NOW - 500 },
    })
    const handle = startIdlePiReaper(h.options)
    await handle.runOnce()
    handle.stop()

    expect(readCheckpointSessions()!.map((e) => e.piSessionId)).toEqual(['sid-known'])
  })

  it('回收成功不复活：条目由 reclaim 挂点摘除，拍尾刷新不重建', async () => {
    const store = getRuntimeCheckpointStore()
    store.upsertSession({ sessionId: 'sid-reclaimed', activityAt: 1 })
    const h = makeHarness({ 'sid-reclaimed': { activityAt: NOW - 500_000 } })
    const handle = startIdlePiReaper(h.options)
    await handle.runOnce()
    handle.stop()

    expect(h.reclaimCalls).toEqual(['sid-reclaimed'])
    expect(readCheckpointSessions()).toEqual([])
    expect(store.hasSession('sid-reclaimed')).toBe(false)
  })

  it('空拍（零候选）不落盘：tick 自身不产生 checkpoint 写入', async () => {
    const p = getRuntimeCheckpointStore().checkpointPath
    const before = existsSync(p) ? readFileSync(p, 'utf8') : undefined
    const h = makeHarness({})
    const handle = startIdlePiReaper(h.options)
    await handle.runOnce()
    handle.stop()
    expect(existsSync(p) ? readFileSync(p, 'utf8') : undefined).toBe(before)
  })
})
