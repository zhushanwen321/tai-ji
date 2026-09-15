/**
 * runtime checkpoint 持续交接单测（crash-forensics-and-watchdog §3.3 D3，实施单元 u4）。
 *
 * 覆盖（验收条款逐条对照，五契约中本模块落的 4 条）：
 * - **完整性降级 / 原子写**：tmp+rename（写成功不留 tmp；残留 tmp 不影响 read——「中途崩
 *   溃读旧版」的可观测形态）；写失败（只读目录）主文件保持上一版完整内容。
 * - **解析失败降级**：损坏文件 → 一条 `checkpoint-corrupt` 台账事件 + 失败现场隔离 +
 *   read 返回 undefined（不抛，调用方退 lazy）。
 * - **失败现场**：`runtime-checkpoint-failed-<ts>.json` 保留最近 3 份（新失败覆盖最旧）。
 * - **rename 同域失败幂等**：ENOENT = already-absent（已隔离）；EACCES = residual（原地
 *   残留静默，不抛）；重复失败不重复记事件（进程内 once）。
 * - **持续维护**：upsert / remove / refresh 三条写入路径的落盘内容与「不新增条目」语义。
 * - **时效性（lag 方向）**：lastActivityAt 只在 tick 刷新 → checkpoint 值 ≤ 真实值 →
 *   消费侧算出 idle ≥ 真实 idle（**偏漏恢复**，与 D3 声明口径一致，非偏多恢复）。
 *
 * 单例形态：getRuntimeCheckpointStore() 懒初始化走 `<dataDir>/run`（生产零新增组合根接线），
 * initRuntimeCheckpointStore 幂等。全部文件目标 = mkdtempSync(tmpdir) 自建自删（fs-guard 白名单）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/runtime-checkpoint.test.ts
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent, CrashJournalWriter } from '@taiji/shared'
import {
  RUN_CHECKPOINT_FAILED_PREFIX as CHECKPOINT_FAILED_PREFIX,
  RUN_CHECKPOINT_FAILED_RETENTION as DEFAULT_FAILED_SNAPSHOT_RETENTION,
  RUN_CHECKPOINT_FILENAME as CHECKPOINT_FILENAME,
  getDataDir,
} from '@taiji/shared/paths'
import {
  RuntimeCheckpointStore,
  getRuntimeCheckpointStore,
  initRuntimeCheckpointStore,
} from '../runtime-checkpoint.js'

// root 下 chmod 权限位不生效（写/rename 照常成功）——权限类用例在 root 环境跳过
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const createdDirs: string[] = []
let runDir: string

/** 恒定可控时钟（时间戳/排序断言可精确到毫秒）。 */
const T0 = 1_700_000_000_000

interface Harness {
  store: RuntimeCheckpointStore
  events: CrashJournalEvent[]
  setNow: (ms: number) => void
}

function makeHarness(dir: string): Harness {
  const events: CrashJournalEvent[] = []
  const journal: CrashJournalWriter = { append: (e) => { events.push(e) } }
  let nowMs = T0
  const store = new RuntimeCheckpointStore({ dir, now: () => nowMs, journal })
  return { store, events, setNow: (ms) => { nowMs = ms } }
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'runtime-checkpoint-'))
  createdDirs.push(runDir)
})

afterAll(() => {
  // maxRetries + retryDelay（教训 d9ad39cb8）：teardown 递归删除瞬态重试
  for (const dir of createdDirs) {
    try {
      chmodSync(dir, 0o700) // 权限用例可能把目录留在只读态
    // eslint-disable-next-line taste/no-silent-catch -- best-effort 清理前恢复权限，失败不阻断 teardown
    } catch {
      // no-op
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

/** 读主文件（不存在返回 undefined）。 */
function readMainFile(dir: string): Record<string, unknown> | undefined {
  const p = join(dir, CHECKPOINT_FILENAME)
  if (!existsSync(p)) return undefined
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

/** 取主文件里的 sessions 数组。 */
function readSessions(dir: string): Array<Record<string, unknown>> {
  return (readMainFile(dir)?.sessions ?? []) as Array<Record<string, unknown>>
}

/** 失败现场文件名（已排序）。 */
function listFailedSnapshots(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith(CHECKPOINT_FAILED_PREFIX)).sort()
}

describe('runtime checkpoint 原子写与完整性降级（D3 契约 3）', () => {
  it('upsert 原子落盘：主文件可解析、无 .tmp 残留', () => {
    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's1', filePath: '/repo/s1.jsonl', activityAt: T0, viewedAt: T0 - 1000 })

    const parsed = readMainFile(runDir)
    expect(parsed?.version).toBe(1)
    expect(parsed?.updatedAt).toBe(new Date(T0).toISOString())
    expect(readSessions(runDir)).toHaveLength(1)
    expect(readSessions(runDir)[0]).toMatchObject({
      piSessionId: 's1',
      filePath: '/repo/s1.jsonl',
      lastActivityAt: T0,
      lastViewedAt: T0 - 1000,
      occupancy: 'idle',
      backgroundTasks: false,
      relayChildren: false,
    })
    // 原子写完成态：tmp 已被 rename 消费
    expect(existsSync(join(runDir, `${CHECKPOINT_FILENAME}.tmp`))).toBe(false)
  })

  it('中途崩溃读旧版：残留 .tmp（写后未 rename 即崩）不影响 read，且被下次写入覆盖', () => {
    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's-old', activityAt: T0 })
    const before = readFileSync(join(runDir, CHECKPOINT_FILENAME), 'utf8')
    // 模拟上一进程在 writeFileSync(tmp) 之后、rename 之前死亡：tmp 半截 JSON
    writeFileSync(join(runDir, `${CHECKPOINT_FILENAME}.tmp`), '{"version":1,"sessions":[', 'utf8')

    // 主文件仍是完整旧版（消费方读不到半截 JSON）
    expect(h.store.read()?.sessions.map((s) => s.piSessionId)).toEqual(['s-old'])
    expect(readFileSync(join(runDir, CHECKPOINT_FILENAME), 'utf8')).toBe(before)

    // 下次写入接管 tmp 名并落定新版本
    h.store.upsertSession({ sessionId: 's-new', activityAt: T0 + 1 })
    expect(existsSync(join(runDir, `${CHECKPOINT_FILENAME}.tmp`))).toBe(false)
    expect(h.store.read()?.sessions.map((s) => s.piSessionId)).toEqual(['s-old', 's-new'])
  })

  it.skipIf(isRoot)('写失败（只读目录）保留上一版完整内容 + 不留 tmp + 不抛', () => {
    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0 })
    const before = readFileSync(join(runDir, CHECKPOINT_FILENAME), 'utf8')

    chmodSync(runDir, 0o500) // 目录不可写：writeFileSync(tmp) EACCES
    expect(() => h.store.upsertSession({ sessionId: 's2', activityAt: T0 + 1 })).not.toThrow()
    chmodSync(runDir, 0o700)

    expect(readFileSync(join(runDir, CHECKPOINT_FILENAME), 'utf8')).toBe(before)
    expect(existsSync(join(runDir, `${CHECKPOINT_FILENAME}.tmp`))).toBe(false)
    // 内存态与磁盘态分叉是容忍的（best-effort 旁路设施）；下次成功写入整体覆盖
    h.store.upsertSession({ sessionId: 's3', activityAt: T0 + 2 })
    expect(readSessions(runDir).map((s) => s.piSessionId).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('read 文件不存在 → undefined（不是空清单：staleness guard 的第 0 步语义）', () => {
    const h = makeHarness(runDir)
    expect(h.store.read()).toBeUndefined()
  })
})

describe('runtime checkpoint 解析失败降级 + 失败现场（D3 契约 3/4）', () => {
  it('损坏文件：read 返回 undefined（不抛）+ 一条 checkpoint-corrupt + 隔离进失败现场', () => {
    const h = makeHarness(runDir)
    writeFileSync(join(runDir, CHECKPOINT_FILENAME), '{ this is not json', 'utf8')

    expect(() => h.store.read()).not.toThrow()
    expect(h.store.read()).toBeUndefined()

    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ layer: 'runtime', event: 'checkpoint-corrupt', reason: 'parse-failed' })
    expect(h.events[0]!.detailPath).toBe(join(runDir, CHECKPOINT_FILENAME))
    // 失败现场：主位已腾空（消灭「陈旧清单 × 后续真 unclean」误配对窗口）
    expect(existsSync(join(runDir, CHECKPOINT_FILENAME))).toBe(false)
    expect(listFailedSnapshots(runDir)).toHaveLength(1)
  })

  it('形状不合法（sessions 非数组 / 条目无 piSessionId）同样降级', () => {
    const h = makeHarness(runDir)
    writeFileSync(join(runDir, CHECKPOINT_FILENAME), JSON.stringify({ version: 1, sessions: {} }), 'utf8')
    expect(h.store.read()).toBeUndefined()
    expect(h.events).toHaveLength(1)

    writeFileSync(join(runDir, CHECKPOINT_FILENAME), JSON.stringify({ sessions: [{ filePath: '/x' }] }), 'utf8')
    const h2 = makeHarness(runDir)
    expect(h2.store.read()).toBeUndefined()
    expect(h2.events[0]).toMatchObject({ event: 'checkpoint-corrupt' })
  })

  it('失败现场保留最近 3 份（新失败覆盖最旧）', () => {
    const h = makeHarness(runDir)
    for (let i = 0; i < DEFAULT_FAILED_SNAPSHOT_RETENTION + 1; i++) {
      h.setNow(T0 + i * 1000)
      writeFileSync(join(runDir, CHECKPOINT_FILENAME), 'garbage', 'utf8')
      expect(h.store.read()).toBeUndefined()
    }
    const snapshots = listFailedSnapshots(runDir)
    expect(snapshots).toHaveLength(DEFAULT_FAILED_SNAPSHOT_RETENTION)
    // 最旧（T0）被最晚（T0+3000）覆盖，保留 T0+1000..T0+3000
    expect(snapshots[0]).toContain('2023-11-14T22-13-21-000Z')
    expect(snapshots.at(-1)).toContain('2023-11-14T22-13-23-000Z')
  })

  it('保留份数可注入（构造参数）', () => {
    const events: CrashJournalEvent[] = []
    let nowMs = T0
    const store = new RuntimeCheckpointStore({
      dir: runDir,
      now: () => nowMs,
      journal: { append: (e) => { events.push(e) } },
      failedSnapshotRetention: 1,
    })
    for (let i = 0; i < 3; i++) {
      nowMs = T0 + i * 1000
      writeFileSync(join(runDir, CHECKPOINT_FILENAME), 'garbage', 'utf8')
      expect(store.read()).toBeUndefined()
    }
    expect(listFailedSnapshots(runDir)).toHaveLength(1)
  })
})

describe('runtime checkpoint rename 同域失败幂等（D3 降级声明）', () => {
  it('ENOENT：源不存在 → already-absent（视为已隔离，非失败）', () => {
    const h = makeHarness(runDir)
    expect(h.store.isolateResidual()).toBe('already-absent')
    expect(h.events).toEqual([])
  })

  it.skipIf(isRoot)('EACCES：rename 与 unlink 同域失败 → 原地残留静默（不抛、主位文件仍在）', () => {
    const h = makeHarness(runDir)
    writeFileSync(join(runDir, CHECKPOINT_FILENAME), 'garbage', 'utf8')
    chmodSync(runDir, 0o500)
    try {
      expect(h.store.isolateResidual()).toBe('residual')
      expect(listFailedSnapshots(runDir)).toEqual([])
      // 反复失败幂等：仍是 residual，且不产生任何事件（静默）
      expect(h.store.isolateResidual()).toBe('residual')
      expect(h.events).toEqual([])
    } finally {
      chmodSync(runDir, 0o700)
    }
    // 权限恢复后重试隔离成功（收敛通道①：下次启动重试）——unlink 同域失败同款
    expect(h.store.isolateResidual()).toBe('isolated')
    expect(listFailedSnapshots(runDir)).toHaveLength(1)
  })

  it.skipIf(isRoot)('重复失败不重复记事件：损坏 + EACCES 原地残留形态 read 两次只记一次', () => {
    const h = makeHarness(runDir)
    writeFileSync(join(runDir, CHECKPOINT_FILENAME), 'garbage', 'utf8')
    chmodSync(runDir, 0o500)
    try {
      expect(h.store.read()).toBeUndefined() // 记 checkpoint-corrupt + 隔离失败（residual）
      expect(h.store.read()).toBeUndefined() // 重复失败：不重复记事件
      expect(h.events).toHaveLength(1)
      expect(existsSync(join(runDir, CHECKPOINT_FILENAME))).toBe(true) // 原地残留（未静默删除）
    } finally {
      chmodSync(runDir, 0o700)
    }
  })
})

describe('runtime checkpoint 持续维护（D3 生命周期事件挂点的写入语义）', () => {
  it('upsert 覆盖式写入（attach / respawn 成功整条刷新）', () => {
    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's1', filePath: '/a.jsonl', activityAt: T0, viewedAt: T0 })
    h.setNow(T0 + 5000)
    h.store.upsertSession({ sessionId: 's1', filePath: '/a.jsonl', activityAt: T0 + 5000, occupancy: 'occupied' })

    const sessions = readSessions(runDir)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ lastActivityAt: T0 + 5000, occupancy: 'occupied', lastViewedAt: null })
  })

  it('removeSession：摘除条目并落盘；未知 session 不落盘（防误删/空写）', () => {
    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0 })
    h.store.upsertSession({ sessionId: 's2', activityAt: T0 })
    h.store.removeSession('s1')
    expect(readSessions(runDir).map((s) => s.piSessionId)).toEqual(['s2'])

    const before = readFileSync(join(runDir, CHECKPOINT_FILENAME), 'utf8')
    h.store.removeSession('s-unknown')
    expect(readFileSync(join(runDir, CHECKPOINT_FILENAME), 'utf8')).toBe(before)
  })

  it('refreshSessions：只更新已存在条目（不新增——未附着候选不入清单）', () => {
    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0, viewedAt: T0 })
    h.setNow(T0 + 300_000)
    h.store.refreshSessions([
      { sessionId: 's1', activityAt: T0 + 299_000, viewedAt: T0 + 298_000, occupancy: 'occupied', backgroundTasks: true, relayChildren: false },
      { sessionId: 's-ghost', activityAt: T0 + 299_000 },
    ])

    expect(h.store.hasSession('s-ghost')).toBe(false)
    const sessions = readSessions(runDir)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      piSessionId: 's1',
      lastActivityAt: T0 + 299_000,
      lastViewedAt: T0 + 298_000,
      occupancy: 'occupied',
      backgroundTasks: true,
      relayChildren: false,
    })
  })

  it('refreshSessions：本拍未判定的字段保留现值（undefined ≠ 判定为 false/idle）', () => {
    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0, viewedAt: T0 - 10, occupancy: 'occupied', backgroundTasks: true })
    h.store.refreshSessions([{ sessionId: 's1', activityAt: T0 + 1000 }])

    expect(readSessions(runDir)[0]).toMatchObject({
      lastActivityAt: T0 + 1000,
      lastViewedAt: T0 - 10,
      occupancy: 'occupied',
      backgroundTasks: true,
    })
  })

  it('refreshSessions：无匹配条目 → 不落盘（checkpoint 文件不因空 tick 被创建）', () => {
    const h = makeHarness(runDir)
    mkdirSync(runDir, { recursive: true })
    h.store.refreshSessions([{ sessionId: 's-ghost', activityAt: T0 }])
    expect(existsSync(join(runDir, CHECKPOINT_FILENAME))).toBe(false)
  })

  it('reset：清内存清单且不动磁盘文件（删除属主在 main / u5，不在本模块）', () => {
    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0 })
    h.store.reset()
    expect(h.store.listEntries()).toEqual([])
    expect(existsSync(join(runDir, CHECKPOINT_FILENAME))).toBe(true)
  })

  it('覆盖式写入不 seed 磁盘旧文件（残留清单不被当成本进程活跃集复活）', () => {
    // 预置一份「上次遗留」文件（含用户已删的 session）
    writeFileSync(join(runDir, CHECKPOINT_FILENAME), JSON.stringify({
      version: 1,
      updatedAt: new Date(T0).toISOString(),
      sessions: [{ piSessionId: 's-stale', lastActivityAt: T0, occupancy: 'idle', backgroundTasks: false, relayChildren: false }],
    }), 'utf8')

    const h = makeHarness(runDir)
    h.store.upsertSession({ sessionId: 's-live', activityAt: T0 + 1 })
    expect(readSessions(runDir).map((s) => s.piSessionId)).toEqual(['s-live'])
  })
})

describe('runtime checkpoint 时效性（lag 方向 = 偏漏恢复，D3 显式口径）', () => {
  it('lastActivityAt 只在 tick 刷新：checkpoint 值 ≤ 真实值 → 消费侧算出的 idle ≥ 真实 idle', () => {
    const h = makeHarness(runDir)
    const attachAt = T0
    h.store.upsertSession({ sessionId: 's1', activityAt: attachAt, viewedAt: attachAt })

    // attach 后用户又交互了一次（真实活动时刻 = attachAt + 20min），但本进程尚未到 5min tick
    const realActivityAt = attachAt + 20 * 60 * 1000
    const crashAt = attachAt + 40 * 60 * 1000
    h.setNow(crashAt)

    const entry = h.store.listEntries()[0]!
    const realIdle = crashAt - realActivityAt // 20min
    const computedIdle = crashAt - entry.lastActivityAt! // 40min
    expect(computedIdle).toBeGreaterThanOrEqual(realIdle) // 偏「漏恢复」方向的数学事实

    // tick 搭车刷新后才回到真实值（reaper 每拍调用 refreshSessions 的语义）
    h.store.refreshSessions([{ sessionId: 's1', activityAt: realActivityAt, viewedAt: realActivityAt }])
    expect(h.store.listEntries()[0]!.lastActivityAt).toBe(realActivityAt)
  })
})

describe('runtime checkpoint 单例（生产零新增组合根接线）', () => {
  it('getRuntimeCheckpointStore 懒初始化走 <dataDir>/run/runtime-checkpoint.json', () => {
    const store = getRuntimeCheckpointStore()
    expect(store.runDir).toBe(join(getDataDir(), 'run'))
    expect(store.checkpointPath).toBe(join(getDataDir(), 'run', CHECKPOINT_FILENAME))
  })

  it('initRuntimeCheckpointStore 幂等（重复 init 返回同一实例）', () => {
    const first = initRuntimeCheckpointStore({ dir: runDir })
    const second = initRuntimeCheckpointStore({ dir: join(runDir, 'other') })
    expect(second).toBe(first)
    expect(second.runDir).toBe(first.runDir)
  })
})
