/**
 * SessionService × in-flight mirror 生命周期接线测试（crash-forensics §3.3 D5，
 * impl-plan 偏差 #20 会话服务侧接线）。
 *
 * 锁定（mirror 挂点 = u4 checkpoint 同点位）：
 * - attach 预置 0：onSessionRegistered 汇聚点（create / restore / respawn / fork 全 spawn
 *   形态经 registerSession 收敛）→ query 返回预置形态 inFlight=0 + hasEverReported=false
 *   + injected=false（新 reporting epoch）。
 * - errsShape 断言口径（u7b 语义核实）：presetZero 不触碰 injected——新条目 injected=false
 *   → errsShape=null（判「无在途」，非 errs）；'absent-report' 只在注入列表含
 *   subagent-workflow（registerSession 汇聚点按 spawnExtensionPaths 判定，D5 ①）之后、
 *   首报到达之前呈——首报（含 count=0 初始帧）到达即回 null。
 * - detach（removeSessionEntry 汇聚点）→ 条目摘除（query 回 undefined 口径）。
 * - respawn 重注册 = 新 epoch：曾上报条目经 detach + 重注册回预置 0。
 * - reclaim 成功 → 条目摘除；reclaim 返回 false（未回收）→ 条目保留（与 checkpoint 同语义）。
 * - fork：新 sessionId 带血缘参数走同一 registerSession 汇聚点 → 预置（fork 归属核实收口；
 *   完整 forkSession 编排无现成测试装置，用 session-lifecycle-register.test.ts 同款
 *   parentSession/forkEntryId 注册形态覆盖汇聚点语义）。
 *
 * 装置：复用 session-service-checkpoint.test.ts 同款（真 SessionService + 轻 deps 桩 +
 * mkdtemp 注入 checkpoint store——attach 订阅体内 checkpoint 写入需要真实落盘目录，
 * 测试禁触真实数据目录）。inflightMirror 是模块级单例，beforeEach/afterAll 逐 sid
 * dropSession 隔离（对齐 checkpoint store reset 形态）。
 *
 * 运行：cd packages/runtime && pnpm exec vitest run src/services/session/__tests__/session-service-mirror-preset.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from '../session-service.js'
import { inflightMirror } from '../inflight-mirror.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import { ReclaimSeat } from '../idle-pi-reaper.js'
import { getRuntimeCheckpointStore, initRuntimeCheckpointStore } from '../runtime-checkpoint.js'
import type { SubagentInFlightReport } from '@xyz-agent/extension-protocol'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { IExtensionService } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

const SID = 'sid-mirror'
const FORK_SID = 'sid-mirror-fork'
/** 模块级单例逐 sid 隔离清单（对齐 checkpoint store reset 形态）。 */
const MIRROR_SIDS = [SID, FORK_SID]

let runDir: string

beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'session-service-mirror-preset-'))
  initRuntimeCheckpointStore({ dir: runDir })
})

beforeEach(() => {
  for (const sid of MIRROR_SIDS) inflightMirror.dropSession(sid)
  getRuntimeCheckpointStore().reset()
  rmSync(join(runDir, 'runtime-checkpoint.json'), { force: true })
})

afterAll(() => {
  for (const sid of MIRROR_SIDS) inflightMirror.dropSession(sid)
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

interface Setup {
  service: SessionService
  pm: {
    getClient: ReturnType<typeof vi.fn>
    hasClient: ReturnType<typeof vi.fn>
    destroySession: ReturnType<typeof vi.fn>
  }
}

/** 最小装置：真 SessionService（构造期零 fs 触点），pm 只桩本域触达的方法（checkpoint 测试同款）。 */
function createSetup(): Setup {
  const client = { lastActivityAt: 1_700_000_500_000, exited: false } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
    hasClient: vi.fn(() => false),
    destroySession: vi.fn(async () => undefined),
    destroyAll: vi.fn(async () => undefined),
  }
  const pmStub = pm as unknown as IProcessManager
  const service = new SessionService(
    pmStub,
    { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() },
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
  return { service, pm }
}

/** 预置 0 条目的完整形态（新 reporting epoch：inFlight=0 + 未上报 + 未注入）。 */
const PRESET_ZERO = { injected: false, hasEverReported: false, inFlight: 0 }

/** 合法在途帧（SubagentInFlightReport 最小构造，emittedAt 固定值便于断言）。 */
function report(inFlight: number): SubagentInFlightReport {
  return { inFlight, emittedAt: 1_700_000_000_000 }
}

describe('SessionService × in-flight mirror（D5 预置 0 / detach / reclaim 生命周期接线）', () => {
  it('attach：onSessionRegistered 汇聚点预置 0（新 epoch 形态 + errsShape=null 口径）', async () => {
    const { service } = createSetup()

    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // 预置形态：inFlight=0 / 未上报 / 未注入（presetZero 不触碰 injected，新条目恒 false）
    expect(inflightMirror.query(SID)).toEqual(PRESET_ZERO)
    // errsShape 口径（u7b 语义核实）：未注入 → 判「无在途」（null），不是 'absent-report'
    expect(inflightMirror.errsShape(SID)).toBeNull()
  })

  it('absent-report 语义：注入后未收首报 → absent-report；首报到达 → 按 inFlight 判', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // spawn 执行者（u4/u5）按实际注入列表声明注入态（与预置顺序无关，injected 不被抹掉）
    inflightMirror.setInjected(SID, true)
    expect(inflightMirror.query(SID)).toEqual({ ...PRESET_ZERO, injected: true })
    // 已注入且本 epoch 从未上报 → errs 推迟形态（直到首报到达）
    expect(inflightMirror.errsShape(SID)).toBe('absent-report')

    // 首报（含初始帧）到达 → hasEverReported 置位 → errs 推迟解除，按绝对计数判
    inflightMirror.applyReport(SID, report(2))
    expect(inflightMirror.errsShape(SID)).toBeNull()
    expect(inflightMirror.query(SID)).toMatchObject({ inFlight: 2, hasEverReported: true })
  })

  it('detach（removeSessionEntry 汇聚点）：条目摘除（query 回 undefined）', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    expect(inflightMirror.query(SID)).toEqual(PRESET_ZERO)

    service.removeSessionEntry(SID)

    expect(inflightMirror.query(SID)).toBeUndefined()
    expect(inflightMirror.errsShape(SID)).toBeNull()
  })

  it('respawn 重注册：条目重建为新 reporting epoch（曾上报态不继承）', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    inflightMirror.applyReport(SID, report(3))
    expect(inflightMirror.query(SID)).toMatchObject({ inFlight: 3, hasEverReported: true })

    // pi 崩死 → detach 摘除 → respawn 成功重注册（同一 registerSession 汇聚点）
    service.removeSessionEntry(SID)
    expect(inflightMirror.query(SID)).toBeUndefined()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // 新 epoch：旧「曾上报」不可继承（inFlight 归零 + hasEverReported 清空）
    expect(inflightMirror.query(SID)).toEqual(PRESET_ZERO)
  })

  it('reclaim 成功：条目摘除；reclaim 返回 false（未回收）：条目保留', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // 未占用 → 七步回收编排走通（destroySession 桩）→ 条目摘除
    const seat = new ReclaimSeat()
    const reclaimed = await service.reclaimSession(SID, { seat, listRelayChildrenByMainSession: () => [] })
    expect(reclaimed).toBe(true)
    expect(inflightMirror.query(SID)).toBeUndefined()

    // 再注册建条目 → 占座被占 → reclaim false（未回收）→ 零改动（防误摘）
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    const seat2 = new ReclaimSeat()
    seat2.tryAcquire(SID)
    const again = await service.reclaimSession(SID, { seat: seat2, listRelayChildrenByMainSession: () => [] })
    expect(again).toBe(false)
    expect(inflightMirror.query(SID)).toEqual(PRESET_ZERO)
  })

  it('fork：新 sessionId 带血缘参数经同一汇聚点预置，源 session 条目不受影响', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // fork 产物 = 新 sessionId 走 registerSession（parentSession/forkEntryId 血缘形态，
    // session-lifecycle-register.test.ts 同款基建——fork 全形态经该汇聚点收敛）
    await service.initializeManagedSession(
      FORK_SID, {} as unknown as IPiEngine, '/project', 'forked', '/project/f.jsonl',
      undefined, SID, 'entry-1',
    )

    expect(inflightMirror.query(FORK_SID)).toEqual(PRESET_ZERO)
    expect(inflightMirror.query(SID)).toEqual(PRESET_ZERO)
  })
})

describe('injected 接线（D5 ①：registerSession 汇聚点按 spawn 注入列表判定）', () => {
  it('注入列表含 subagent-workflow：注册即 injected=true → errsShape=absent-report（presetZero 后、首报前）', async () => {
    const { service } = createSetup()

    // staged 布局（npm 名 pi-subagent-workflow）+ dev 源码目录两种真实路径形态
    await service.initializeManagedSession(
      SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl',
      undefined, undefined, undefined, undefined, undefined,
      ['/apps/electron/resources/extensions/@zhushanwen/pi-subagent-workflow', '/repo/extensions/universal/subagent-workflow'],
    )

    // 同一注册汇聚点双写：presetZero（订阅体）置新 epoch + injected（registerSession
    // 体内）置 true——顺序无关，presetZero 不触碰 injected
    expect(inflightMirror.query(SID)).toEqual({ ...PRESET_ZERO, injected: true })
    // 已注入且本 epoch 从未上报 → errs 推迟形态（rolling-restart 的 absent-report 判别）
    expect(inflightMirror.errsShape(SID)).toBe('absent-report')
  })

  it('注入列表不含 subagent-workflow：injected=false → errsShape 保持 null（判「无在途」，非 errs）', async () => {
    const { service } = createSetup()

    await service.initializeManagedSession(
      SID, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl',
      undefined, undefined, undefined, undefined, undefined,
      ['/apps/electron/resources/extensions/@zhushanwen/pi-session-manager', '/repo/extensions/universal/plan'],
    )

    expect(inflightMirror.query(SID)).toEqual(PRESET_ZERO)
    expect(inflightMirror.errsShape(SID)).toBeNull()
  })
})
