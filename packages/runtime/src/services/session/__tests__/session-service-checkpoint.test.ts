/**
 * SessionService × runtime checkpoint 接线测试（crash-forensics-and-watchdog §3.3 D3，u4）。
 *
 * 锁定（验收条款逐条对照）：
 * - attach / respawn 成功（同一 registerSession 汇聚点经 onSessionRegistered 直发）→
 *   checkpoint 写入该 session（piSessionId / filePath / lastActivityAt 取 pi client 空闲信号 /
 *   lastViewedAt 取 per-sid 查看表 / occupancy 快照）。
 * - detach（removeSessionEntry 汇聚点，覆盖主动删 / 进程退出 / forceQuit / restore 清场）→
 *   条目摘除；**文件不删**（删除属主在 main 退出链与 u5 reattach 编排——契约 1）。
 * - reclaim 成功 → 条目摘除；reclaim 未成功（返回 false）→ 零改动（防误摘）。
 * - 不在每次 touch 刷盘（D3 时效性裁决）：markSessionViewed 不触发任何 checkpoint 写入
 *   （lastViewedAt 由 reaper tick 搭车刷新，见 idle-pi-reaper.checkpoint.test.ts）。
 *
 * 装置：真 SessionService（轻量 deps 桩，session-service-background-task.test.ts createSetup
 * 同款）+ 目录注入的 checkpoint store（mkdtemp tmp 自建自删，fs-guard 白名单）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service-checkpoint.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReclaimSeat } from '../idle-pi-reaper.js'
import { getRuntimeCheckpointStore, initRuntimeCheckpointStore } from '../runtime-checkpoint.js'
import type { IPiEngine } from '../../ports/pi-engine.js'
import { createSetup } from './helpers/session-service-setup.js'

const SID = 'sid-checkpoint'
/** client 空闲信号（u1a）——checkpoint 的 lastActivityAt 权威源。 */
const CLIENT_ACTIVITY_AT = 1_700_000_500_000

let runDir: string

beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'session-service-checkpoint-'))
  initRuntimeCheckpointStore({ dir: runDir })
})

beforeEach(() => {
  getRuntimeCheckpointStore().reset()
  // 磁盘旧版不参与判定（覆盖式写入），但清掉以免跨用例读到上一拍的清单
  rmSync(join(runDir, 'runtime-checkpoint.json'), { force: true })
})

afterAll(() => {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 读 checkpoint 主文件条目（不存在返回空数组）。 */
function readEntries(): Array<Record<string, unknown>> {
  const p = join(runDir, 'runtime-checkpoint.json')
  if (!existsSync(p)) return []
  return (JSON.parse(readFileSync(p, 'utf8')) as { sessions: Array<Record<string, unknown>> }).sessions
}

describe('SessionService × runtime checkpoint（D3 attach/detach/reclaim 挂点）', () => {
  it('attach：onSessionRegistered 汇聚点写入条目（filePath / client lastActivityAt / viewedAt）', async () => {
    const { service } = createSetup()
    service.markSessionViewed(SID) // 先于 attach 的查看记录（真实序列：switch 处理器写表）

    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    const entries = readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      piSessionId: SID,
      filePath: '/project/s.jsonl',
      lastActivityAt: CLIENT_ACTIVITY_AT,
      occupancy: 'idle',
      backgroundTasks: false,
      relayChildren: false,
    })
    expect(typeof entries[0]!.lastViewedAt).toBe('number')
  })

  it('detach（removeSessionEntry 汇聚点）：条目摘除且 checkpoint 文件保留', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    service.removeSessionEntry(SID)

    expect(getRuntimeCheckpointStore().hasSession(SID)).toBe(false)
    expect(readEntries()).toEqual([])
    // 契约 1：runtime 侧任何路径都不删文件（删除属主 = main 退出链 / u5 reattach 编排）
    expect(existsSync(join(runDir, 'runtime-checkpoint.json'))).toBe(true)
  })

  it('respawn 成功：重新附着（同一 registerSession 汇聚点）把条目加回清单', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    service.removeSessionEntry(SID) // pi 崩死 → 条目摘除（respawn pending 不进 checkpoint）
    expect(readEntries()).toEqual([])

    // respawn 成功的真实形态 = restoreSession → lifecycle.restoreSession → registerSession
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    expect(readEntries().map((e) => e.piSessionId)).toEqual([SID])
  })

  it('reclaim 成功：条目摘除；reclaim 返回 false：零改动', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // 未占用 → 七步编排走通（destroySession 桩）→ 摘除条目
    const seat = new ReclaimSeat()
    const reclaimed = await service.reclaimSession(SID, { seat, listRelayChildrenByMainSession: () => [] })
    expect(reclaimed).toBe(true)
    expect(getRuntimeCheckpointStore().hasSession(SID)).toBe(false)

    // 再审：session 已摘出 Map → 编排返回 false（无条目）→ 不得改动清单
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    const seat2 = new ReclaimSeat()
    seat2.tryAcquire(SID) // 占座被占 → 立即 false（未回收）
    const again = await service.reclaimSession(SID, { seat: seat2, listRelayChildrenByMainSession: () => [] })
    expect(again).toBe(false)
    expect(getRuntimeCheckpointStore().hasSession(SID)).toBe(true)
  })

  it('不在每次 touch 刷盘（时效性裁决）：markSessionViewed 不写 checkpoint', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    const before = readFileSync(join(runDir, 'runtime-checkpoint.json'), 'utf8')

    service.markSessionViewed(SID)
    service.markSessionViewed(SID)

    expect(readFileSync(join(runDir, 'runtime-checkpoint.json'), 'utf8')).toBe(before)
  })
})
