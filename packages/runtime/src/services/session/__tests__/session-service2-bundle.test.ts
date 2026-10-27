import { logger } from '../../../infra/logger.js';
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js';
import { PiSessionStore } from '../../../infra/pi/session-store.js';
import { type IExtensionService, IEventAdapter } from '../../../interfaces.js';
import type { IProcessManager } from '../../../services/ports/pi-engine.js';
import { SessionDataStore, isSessionDataCleared } from '../../plugin-service/session-data-store.js';
import type { IConfigStore } from '../../ports/config.js';
import type {IPiEngine, IProcessManager as IProcessManager_z2} from '../../ports/pi-engine.js';
import type { ISessionStore } from '../../ports/session.js';
import type { WorkspaceService } from '../../workspace/workspace-service.js';
import { inflightMirror } from '../inflight-mirror.js';
import { MessageDispatcher } from '../message-dispatcher.js';
import { normalizeInactiveSessionFileIfNeeded, streamNormalizeSessionFile, stripSessionEndEntries, applyHeaderCwdFallback, type StreamingNormalizer } from '../restore-seeding.js';
import { RuntimeCheckpointStore, WRITE_FAILURE_LEDGER_THRESHOLD, WRITE_FAILURE_WARN_INTERVAL_MS, getRuntimeCheckpointStore, initRuntimeCheckpointStore } from '../runtime-checkpoint.js';
import { type IDispatcherSessionOps, ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js';
import { SessionLifecycle } from '../session-lifecycle.js';
import { SessionService } from '../session-service.js';
import type { ScannedSession } from '../types.js';
import {createSetup as createSetup_z2} from './helpers/session-service-setup.js';
import { CrashJournalWriter, READ_PRECHECK_MAX_BYTES, type CrashJournalEvent, type SessionSummary } from '@taiji/shared';
import { RUN_CHECKPOINT_FAILED_PREFIX as CHECKPOINT_FAILED_PREFIX, RUN_CHECKPOINT_FAILED_RETENTION as DEFAULT_FAILED_SNAPSHOT_RETENTION, RUN_CHECKPOINT_FILENAME as CHECKPOINT_FILENAME, getDataDir, getSessionPluginDataPath } from '@taiji/shared/paths';
import type { SubagentInFlightReport } from '@zhushanwen/extension-protocol';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/session/__tests__/session-service-abort-plan.test.ts
// ======================================================================

const SID = 'sess-abort-plan'


// ── SessionService 最小装置（仿 session-service-background-task.test.ts）────────

function createService(): SessionService {
  return new SessionService(
    // pm：构造期只注册 onSessionExit 回调（ensureActive 经 spy 桩掉，其余不触达）
    { onSessionExit: vi.fn(), getClient: vi.fn(), hasClient: vi.fn(() => false), destroyAll: vi.fn() } as unknown as IProcessManager,
    // broker
    { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() },
    // adapterFactory：桩（本域不附着 session）
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    // dataDir：os.tmpdir()（构造期零 IO，同 session-service-background-task.test.ts 装置）
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    // configStore / sessionStore：真实实例（构造期零 IO，同既有 session-service 测试范式）
    new PiConfigStore(),
    new PiSessionStore(),
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-abort-plan', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
// ── abortPlan 编排 ───────────────────────────────────────────────

describe('SessionService.abortPlan（MF-1-7 下沉编排）', () => {
  it('ensureActive（自动恢复，join 语义）先于 prompt("/plan abort") 直发；成功后失效回调上抛', async () => {
    const service = createService()
    const prompt = vi.fn(async () => {
      // 顺序断言：恢复完成后才直发（pi 未活窗口 restoreSession spawn pi 先行）
      expect(ensureActiveSpy).toHaveBeenCalledTimes(1)
    })
    const ensureActiveSpy = vi.spyOn(service, 'ensureActive').mockResolvedValue({ prompt } as never)
    const onPlanAborted = vi.fn()
    service.setOnPlanAborted(onPlanAborted)

    await service.abortPlan(SID)

    expect(ensureActiveSpy).toHaveBeenCalledWith(SID)
    // 直发参数断言：extension command 字面量（pi 对 / 前缀 prompt 先行执行，不经 LLM）
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('/plan abort')
    expect(onPlanAborted).toHaveBeenCalledTimes(1)
    expect(onPlanAborted).toHaveBeenCalledWith(SID)
  })

  it('prompt throw（直发失败）→ 异常上抛 + 失效回调不上抛', async () => {
    const service = createService()
    vi.spyOn(service, 'ensureActive').mockResolvedValue({
      prompt: vi.fn(async () => {
        throw new Error('client gone')
      }),
    } as never)
    const onPlanAborted = vi.fn()
    service.setOnPlanAborted(onPlanAborted)

    await expect(service.abortPlan(SID)).rejects.toThrow('client gone')
    expect(onPlanAborted).not.toHaveBeenCalled()
  })

  it('ensureActive throw（恢复失败，E9）→ 异常上抛 + 失效回调不上抛', async () => {
    const service = createService()
    vi.spyOn(service, 'ensureActive').mockRejectedValue(new Error('Session file corrupted'))
    const onPlanAborted = vi.fn()
    service.setOnPlanAborted(onPlanAborted)

    await expect(service.abortPlan(SID)).rejects.toThrow('Session file corrupted')
    expect(onPlanAborted).not.toHaveBeenCalled()
  })

  it('回调未注入（仅测试最小构造形态）→ abortPlan 正常完成不抛', async () => {
    const service = createService()
    const prompt = vi.fn(async () => ({}))
    vi.spyOn(service, 'ensureActive').mockResolvedValue({ prompt } as never)

    await expect(service.abortPlan(SID)).resolves.toBeUndefined()
    expect(prompt).toHaveBeenCalledWith('/plan abort')
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-service-checkpoint.test.ts
// ======================================================================

const SID_m2_m2_m2_m2_z2 = 'sid-checkpoint'

/** client 空闲信号（u1a）——checkpoint 的 lastActivityAt 权威源。 */
const CLIENT_ACTIVITY_AT = 1_700_000_500_000


let runDir: string


/** 读 checkpoint 主文件条目（不存在返回空数组）。 */
function readEntries(): Array<Record<string, unknown>> {
  const p = join(runDir, 'runtime-checkpoint.json')
  if (!existsSync(p)) return []
  return (JSON.parse(readFileSync(p, 'utf8')) as { sessions: Array<Record<string, unknown>> }).sessions
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-checkpoint', () => {
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
describe('SessionService × runtime checkpoint（D3 attach/detach/reclaim 挂点）', () => {
  it('attach：onSessionRegistered 汇聚点写入条目（filePath / client lastActivityAt / viewedAt）', async () => {
    const { service } = createSetup()
    service.markSessionViewed(SID_m2_m2_m2_m2_z2) // 先于 attach 的查看记录（真实序列：switch 处理器写表）

    await service.initializeManagedSession(SID_m2_m2_m2_m2_z2, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    const entries = readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      piSessionId: SID_m2_m2_m2_m2_z2,
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
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z2, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    service.removeSessionEntry(SID_m2_m2_m2_m2_z2)

    expect(getRuntimeCheckpointStore().hasSession(SID_m2_m2_m2_m2_z2)).toBe(false)
    expect(readEntries()).toEqual([])
    // 契约 1：runtime 侧任何路径都不删文件（删除属主 = main 退出链 / u5 reattach 编排）
    expect(existsSync(join(runDir, 'runtime-checkpoint.json'))).toBe(true)
  })

  it('respawn 成功：重新附着（同一 registerSession 汇聚点）把条目加回清单', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z2, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    service.removeSessionEntry(SID_m2_m2_m2_m2_z2) // pi 崩死 → 条目摘除（respawn pending 不进 checkpoint）
    expect(readEntries()).toEqual([])

    // respawn 成功的真实形态 = restoreSession → lifecycle.restoreSession → registerSession
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z2, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    expect(readEntries().map((e) => e.piSessionId)).toEqual([SID_m2_m2_m2_m2_z2])
  })

  it('不在每次 touch 刷盘（时效性裁决）：markSessionViewed 不写 checkpoint', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z2, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    const before = readFileSync(join(runDir, 'runtime-checkpoint.json'), 'utf8')

    service.markSessionViewed(SID_m2_m2_m2_m2_z2)
    service.markSessionViewed(SID_m2_m2_m2_m2_z2)

    expect(readFileSync(join(runDir, 'runtime-checkpoint.json'), 'utf8')).toBe(before)
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-service-mirror-preset.test.ts
// ======================================================================

const SID_m2_m2_m2_m2_z3 = 'sid-mirror'

const FORK_SID = 'sid-mirror-fork'

/** 模块级单例逐 sid 隔离清单（对齐 checkpoint store reset 形态）。 */
const MIRROR_SIDS = [SID_m2_m2_m2_m2_z3, FORK_SID]


let runDir_m2_m2_m2_z2: string


/** 预置 0 条目的完整形态（新 reporting epoch：inFlight=0 + 未上报 + 未注入）。 */
const PRESET_ZERO = { injected: false, hasEverReported: false, inFlight: 0 }


/** 合法在途帧（SubagentInFlightReport 最小构造，emittedAt 固定值便于断言）。 */
function report(inFlight: number): SubagentInFlightReport {
  return { inFlight, emittedAt: 1_700_000_000_000 }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-mirror-preset', () => {
beforeAll(() => {
  runDir_m2_m2_m2_z2 = mkdtempSync(join(tmpdir(), 'session-service-mirror-preset-'))
  initRuntimeCheckpointStore({ dir: runDir_m2_m2_m2_z2 })
})
beforeEach(() => {
  for (const sid of MIRROR_SIDS) inflightMirror.dropSession(sid)
  getRuntimeCheckpointStore().reset()
  rmSync(join(runDir_m2_m2_m2_z2, 'runtime-checkpoint.json'), { force: true })
})
afterAll(() => {
  for (const sid of MIRROR_SIDS) inflightMirror.dropSession(sid)
  rmSync(runDir_m2_m2_m2_z2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('SessionService × in-flight mirror（D5 预置 0 / detach / reclaim 生命周期接线）', () => {
  it('attach：onSessionRegistered 汇聚点预置 0（新 epoch 形态 + errsShape=null 口径）', async () => {
    const { service } = createSetup()

    await service.initializeManagedSession(SID_m2_m2_m2_m2_z3, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // 预置形态：inFlight=0 / 未上报 / 未注入（presetZero 不触碰 injected，新条目恒 false）
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toEqual(PRESET_ZERO)
    // errsShape 口径（u7b 语义核实）：未注入 → 判「无在途」（null），不是 'absent-report'
    expect(inflightMirror.errsShape(SID_m2_m2_m2_m2_z3)).toBeNull()
  })

  it('absent-report 语义：注入后未收首报 → absent-report；首报到达 → 按 inFlight 判', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z3, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // spawn 执行者（u4/u5）按实际注入列表声明注入态（与预置顺序无关，injected 不被抹掉）
    inflightMirror.setInjected(SID_m2_m2_m2_m2_z3, true)
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toEqual({ ...PRESET_ZERO, injected: true })
    // 已注入且本 epoch 从未上报 → errs 推迟形态（直到首报到达）
    expect(inflightMirror.errsShape(SID_m2_m2_m2_m2_z3)).toBe('absent-report')

    // 首报（含初始帧）到达 → hasEverReported 置位 → errs 推迟解除，按绝对计数判
    inflightMirror.applyReport(SID_m2_m2_m2_m2_z3, report(2))
    expect(inflightMirror.errsShape(SID_m2_m2_m2_m2_z3)).toBeNull()
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toMatchObject({ inFlight: 2, hasEverReported: true })
  })

  it('detach（removeSessionEntry 汇聚点）：条目摘除（query 回 undefined）', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z3, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toEqual(PRESET_ZERO)

    service.removeSessionEntry(SID_m2_m2_m2_m2_z3)

    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toBeUndefined()
    expect(inflightMirror.errsShape(SID_m2_m2_m2_m2_z3)).toBeNull()
  })

  it('respawn 重注册：条目重建为新 reporting epoch（曾上报态不继承）', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z3, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')
    inflightMirror.applyReport(SID_m2_m2_m2_m2_z3, report(3))
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toMatchObject({ inFlight: 3, hasEverReported: true })

    // pi 崩死 → detach 摘除 → respawn 成功重注册（同一 registerSession 汇聚点）
    service.removeSessionEntry(SID_m2_m2_m2_m2_z3)
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toBeUndefined()
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z3, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // 新 epoch：旧「曾上报」不可继承（inFlight 归零 + hasEverReported 清空）
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toEqual(PRESET_ZERO)
  })

  it('fork：新 sessionId 带血缘参数经同一汇聚点预置，源 session 条目不受影响', async () => {
    const { service } = createSetup()
    await service.initializeManagedSession(SID_m2_m2_m2_m2_z3, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl')

    // fork 产物 = 新 sessionId 走 registerSession（parentSession/forkEntryId 血缘形态，
    // session-lifecycle-register.test.ts 同款基建——fork 全形态经该汇聚点收敛）
    await service.initializeManagedSession(
      FORK_SID, {} as unknown as IPiEngine, '/project', 'forked', '/project/f.jsonl',
      undefined, SID_m2_m2_m2_m2_z3, 'entry-1',
    )

    expect(inflightMirror.query(FORK_SID)).toEqual(PRESET_ZERO)
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toEqual(PRESET_ZERO)
  })
})
describe('injected 接线（D5 ①：registerSession 汇聚点按 spawn 注入列表判定）', () => {
  it('注入列表含 subagent-workflow：注册即 injected=true → errsShape=absent-report（presetZero 后、首报前）', async () => {
    const { service } = createSetup()

    // staged 布局（npm 名 pi-subagent-workflow）+ dev 源码目录两种真实路径形态
    await service.initializeManagedSession(
      SID_m2_m2_m2_m2_z3, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl',
      undefined, undefined, undefined, undefined,
      ['/apps/electron/resources/extensions/@zhushanwen/pi-subagent-workflow', '/repo/extensions/universal/subagent-workflow'],
    )

    // 同一注册汇聚点双写：presetZero（订阅体）置新 epoch + injected（registerSession
    // 体内）置 true——顺序无关，presetZero 不触碰 injected
    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toEqual({ ...PRESET_ZERO, injected: true })
    // 已注入且本 epoch 从未上报 → errs 推迟形态（rolling-restart 的 absent-report 判别）
    expect(inflightMirror.errsShape(SID_m2_m2_m2_m2_z3)).toBe('absent-report')
  })

  it('注入列表不含 subagent-workflow：injected=false → errsShape 保持 null（判「无在途」，非 errs）', async () => {
    const { service } = createSetup()

    await service.initializeManagedSession(
      SID_m2_m2_m2_m2_z3, {} as unknown as IPiEngine, '/project', 'label', '/project/s.jsonl',
      undefined, undefined, undefined, undefined,
      ['/apps/electron/resources/extensions/@zhushanwen/pi-session-manager', '/repo/extensions/universal/plan'],
    )

    expect(inflightMirror.query(SID_m2_m2_m2_m2_z3)).toEqual(PRESET_ZERO)
    expect(inflightMirror.errsShape(SID_m2_m2_m2_m2_z3)).toBeNull()
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/session-service-plugin-data-clear.test.ts
// ======================================================================

// trash port 注入式 mock（B5 port 化：SessionDataStore 构造参数注入，非模块 mock）；
// 同步移除文件模拟 trash 语义
const trashState = { calls: [] as string[] }

const mockTrashFile = async (filePath: string): Promise<void> => {
  trashState.calls.push(filePath)
  rmSync(filePath, { force: true })
}

// getPiAgentDir → tmp（removeSessionEntry 的 reapSessionBackgroundTasks fire-and-forget 路径
// 读该目录，session-service-background-task.test.ts 同款隔离）
const paths = vi.hoisted(() => ({ agentDir: '' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => paths.agentDir }
})
const CLIENT_ACTIVITY_AT_m2 = 1_700_000_500_000


let runDir_m2_m2_m2_z3: string

let store: SessionDataStore


/** plugin sessionData 持久化文件路径（session 存储树域 4，SessionDataStore 内部推导同源）。 */
const dataFile = (sid: string): string => getSessionPluginDataPath(sid, runDir_m2_m2_m2_z3)


interface Setup {  // oe-exempt:20261027:test:
  service: SessionService
  /** pi 崩溃入口：构造器注册的 pm.onSessionExit 回调（真实 exit 收敛链）。 */
  triggerExit: (sessionId: string, code: number | null, stderr?: string) => void
}


/** 真 SessionService 最小装置（session-service-checkpoint.test.ts 同款，构造期零 fs 触点）。 */
function createSetup(): Setup {
  const client = { lastActivityAt: CLIENT_ACTIVITY_AT_m2, exited: false } as unknown as IPiEngine
  // 捕获构造器注册的 exit 回调（反例①的驱动入口）
  let exitCb: ((sessionId: string, code: number | null, stderr?: string) => void) | undefined
  const pm = {
    onSessionExit: vi.fn((cb: NonNullable<typeof exitCb>) => { exitCb = cb }),
    getClient: vi.fn(() => client),
    hasClient: vi.fn(() => false),
    destroySession: vi.fn(async () => undefined),
    destroyAll: vi.fn(async () => undefined),
  }
  // 真删除链尾的 refreshAll（pi provider 盘上重扫）与 trash（真实废纸篓）不属本域断言范围：
  // spy 掉——refreshAll/invalidateScanCache no-op 化，trash 落 tmp 内 rm（mockTrashFile 同款
  // 语义，保 existsSync 断言可判）。
  const sessionStore = new PiSessionStore()
  vi.spyOn(sessionStore, 'refreshAll').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'invalidateScanCache').mockImplementation(() => {})
  vi.spyOn(sessionStore, 'trash').mockImplementation(mockTrashFile)
  const service = new SessionService(
    pm as unknown as IProcessManager_z2,
    { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() },
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    new PiConfigStore(),
    sessionStore,
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
  return { service, triggerExit: (sid, code, stderr) => exitCb?.(sid, code, stderr) }
}


/** 反例②装置：真 MessageDispatcher，removeSessionEntry 等收殓面桥接真 SessionService。 */
function createDispatcher(service: SessionService): MessageDispatcher {
  const ops: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => undefined),
    detachSession: (sid) => service.detachSession(sid),
    persistSessionOutcome: (sid, outcome, reason) => service.persistSessionOutcome(sid, outcome, reason),
    clearSessionOutcome: (sid) => service.clearSessionOutcome(sid),
    getSession: (sid) => service.getSession(sid),
    removeSessionEntry: (sid) => service.removeSessionEntry(sid),
    ensureActive: vi.fn(async () => { throw new Error('forceQuit path must not call ensureActive') }),
  }
  const pm = {
    // forceQuit 入口检查：getClient 非 null 才走强杀编排（null 会早退不触发收殓链）
    getClient: vi.fn(() => ({ lastActivityAt: CLIENT_ACTIVITY_AT_m2, exited: false } as unknown as IPiEngine)),
    destroySession: vi.fn(async () => undefined),
  }
  return new MessageDispatcher(
    ops,
    pm as unknown as IProcessManager_z2,
    { record: vi.fn() } as unknown as WorkspaceService,
    undefined,
  )
}


/**
 * 反例③装置：真 SessionLifecycle（kill-path-logging.test.ts K3 harness 同款），唯独
 * removeSessionEntry 桥接真 SessionService——restore 清场→removeSessionEntry 正是被测的
 * 生产接线边（其余 svc 面 mock，证明 harness 同款已green的 K3）。
 */
function createRestoreLifecycle(service: SessionService, sid: string, bodyFile: string): {
  lifecycle: SessionLifecycle
  notifyCreated: ReturnType<typeof vi.fn>
  removeEntryOnService: ReturnType<typeof vi.spyOn>
  pm: { createSession: ReturnType<typeof vi.fn>; destroySession: ReturnType<typeof vi.fn>; getClient: ReturnType<typeof vi.fn> }
} {
  const restoreClient = {
    exited: false,
    lastActivityAt: CLIENT_ACTIVITY_AT_m2,
    getState: vi.fn(async () => ({ sessionId: sid })),
    switchSession: vi.fn(async (_path: string) => {}),
    setSessionName: vi.fn(async () => undefined),
  }
  const pm = {
    createSession: vi.fn(async () => restoreClient),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检：undefined = 无 client → 不短路 → 二次 restore 走清场分支
    getClient: vi.fn(() => undefined),
  }
  const notifyCreated = vi.fn()
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s): SessionSummary => ({
      id: s.id, label: s.label, cwd: s.cwd, status: 'active',
      lastActiveAt: 1,
    })),
    findScannedSession: vi.fn((id: string): ScannedSession | undefined =>
      id === sid
        ? { id, filePath: bodyFile, cwd: runDir_m2_m2_m2_z3, name: 'target', lastModified: Date.now(), timestamp: '2026-09-15T00:00:00.000Z', size: 0 } as ScannedSession
        : undefined),
    // 被测接线边：清场收殓走真 SessionService.removeSessionEntry（生产中 lifecycle.svc 即它）
    removeSessionEntry: (id: string) => service.removeSessionEntry(id),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    notifySessionCreated: notifyCreated,
    getActiveSummaries: vi.fn(() => []),
  }
  const configStore = { getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })) } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    trash: vi.fn(async () => undefined),
    invalidateMetaCache: vi.fn(),
  } as unknown as ISessionStore
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }
  const removeEntryOnService = vi.spyOn(service, 'removeSessionEntry')
  const lifecycle = new SessionLifecycle(
    svc,
    pm as unknown as IProcessManager_z2,
    configStore,
    sessionStore,
    { record: vi.fn() } as unknown as WorkspaceService,
    registerDeps,
  )
  return { lifecycle, notifyCreated, removeEntryOnService, pm }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-service-plugin-data-clear', () => {
beforeAll(() => {
  runDir_m2_m2_m2_z3 = mkdtempSync(join(tmpdir(), 'session-service-plugin-data-clear-'))
  initRuntimeCheckpointStore({ dir: runDir_m2_m2_m2_z3 })
  paths.agentDir = mkdtempSync(join(tmpdir(), 'session-service-plugin-data-clear-agent-'))
})
beforeEach(() => {
  // 每 case 独立 store（tombstone/分发表模块级共享态，sid 也唯一化由各 case 自带）
  store = new SessionDataStore(runDir_m2_m2_m2_z3, undefined, undefined, mockTrashFile)
  trashState.calls.length = 0
})
afterEach(() => {
  store.dispose()
})
afterAll(() => {
  rmSync(runDir_m2_m2_m2_z3, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  rmSync(paths.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('B5 触发点收窄：真删除才清 plugin sessionData（§3.1 trash 绑定用户删除）', () => {
  it('真删除（lifecycle.delete active 分支）：tombstone + 文件进 trash + 迟到 set 被丢弃', async () => {
    const sid = 'sid-delete-active'
    const { service } = createSetup()
    await service.initializeManagedSession(sid, {} as unknown as IPiEngine, '/project', 'label')

    // session 存续期的插件数据（模拟 plugin worker 已写入）
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)
    expect(existsSync(dataFile(sid))).toBe(true)

    // 用户删除（session-message-handler session.delete RPC 同链：facade.delete → lifecycle.delete）
    await service.delete(sid)

    // 清理是 void…catch 分发（异步路径），trash 到达是微任务
    await vi.waitFor(() => expect(trashState.calls).toContain(dataFile(sid)), { interval: 1 })
    expect(isSessionDataCleared(sid)).toBe(true)
    expect(existsSync(dataFile(sid))).toBe(false)
    expect(service.getSummary(sid)).toBeUndefined() // 真销毁完成（内存条目已收殓）

    // didDestroy fire-and-forget 后插件 worker 迟到的 set：被写检查丢弃，不复活文件
    store.set(sid, 'k2', 'late-write')
    store.flushAll()
    expect(existsSync(dataFile(sid))).toBe(false)
    expect(store.keys(sid)).toEqual([])
  })

  it('真删除（lifecycle.delete scanned 分支——非活跃 session）：插件数据同样随本体进 trash', async () => {
    const sid = 'sid-delete-scanned'
    const { service } = createSetup()
    // scanned 分支：session 不在 Map，findScannedSession 命中盘上文件（spy 定向，绕开
    // 全量扫描装置——分支语义只依赖 target 存在 + 主文件 existsSync）
    const bodyFile = join(runDir_m2_m2_m2_z3, `${sid}.jsonl`)
    writeFileSync(bodyFile, JSON.stringify({ type: 'session', version: 3, id: sid }) + '\n', 'utf-8')
    vi.spyOn(service, 'findScannedSession').mockReturnValue(
      { id: sid, filePath: bodyFile, cwd: runDir_m2_m2_m2_z3, name: 'scanned', lastModified: Date.now(), timestamp: '2026-09-15T00:00:00.000Z', size: 0 } as ScannedSession,
    )
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)

    await service.delete(sid)

    await vi.waitFor(() => expect(trashState.calls).toContain(dataFile(sid)), { interval: 1 })
    expect(trashState.calls).toContain(bodyFile) // session 本体同trash（§3.1 一同进废纸篓）
    expect(isSessionDataCleared(sid)).toBe(true)
    expect(existsSync(dataFile(sid))).toBe(false)
  })

  it('未注册任何 store（无插件系统场景）时真删除不抛（分发空集 no-op）', async () => {
    store.dispose() // 摘除唯一注册实例
    const sid = 'sid-no-store'
    const { service } = createSetup()
    await service.initializeManagedSession(sid, {} as unknown as IPiEngine, '/project', 'label')
    await expect(service.delete(sid)).resolves.toBeUndefined()
    expect(trashState.calls).toHaveLength(0)
  })

  it('反例①pi 崩溃（onSessionExit 收殓链）：插件数据存活——respawn 后继续写（不打 tombstone）', async () => {
    const sid = 'sid-crash-exit'
    const { service, triggerExit } = createSetup()
    await service.initializeManagedSession(sid, {} as unknown as IPiEngine, '/project', 'label')
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)

    // pi 崩溃：真实 exit 收敛链（detach → session.exited publish → removeSessionEntry →
    // respawn.schedule）。respawn timer unref，不悬挂测试进程。
    triggerExit(sid, 1, 'boom')

    expect(service.getSummary(sid)).toBeUndefined() // 内存收殓链真实走到 removeSessionEntry
    // 三不：不 trash、不摘数据、不打 tombstone
    expect(trashState.calls).toHaveLength(0)
    expect(isSessionDataCleared(sid)).toBe(false)
    expect(existsSync(dataFile(sid))).toBe(true)
    // respawn 后插件的「新写」照常（k1 保留、k2 追加——tombstone 未打，写通道畅通）
    store.set(sid, 'k2', 'v2')
    store.flushSession(sid)
    expect(store.keys(sid)).toEqual(['k1', 'k2'])
  })

  it('反例②forceQuit（dispatcher 强杀收敛）：插件数据存活——restore 复活后可续读写', async () => {
    const sid = 'sid-force-quit'
    const { service } = createSetup()
    await service.initializeManagedSession(sid, {} as unknown as IPiEngine, '/project', 'label')
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)

    await createDispatcher(service).forceQuit(sid)

    expect(service.getSummary(sid)).toBeUndefined() // 强杀收敛链真实走到 removeSessionEntry
    expect(trashState.calls).toHaveLength(0)
    expect(isSessionDataCleared(sid)).toBe(false)
    expect(store.get(sid, 'k1')).toBe('v1')
    expect(existsSync(dataFile(sid))).toBe(true)
    // 用户随后 restore 重开（dead session 点击）：插件写不受阻
    store.set(sid, 'k2', 'v2')
    expect(store.keys(sid)).toEqual(['k1', 'k2'])
  })

  it('反例③restore 清场（clearExistingSessionForRestore）：同链 notifySessionCreated 摘碑复活，插件数据完好', async () => {
    const sid = 'sid-restore-clear'
    const { service } = createSetup()
    // 真 session 文件（attachRestoreFile 的 assertPiSessionFile 校验目标，kill-path 同款格式）
    const bodyFile = join(runDir_m2_m2_m2_z3, `${sid}.jsonl`)
    writeFileSync(
      bodyFile,
      [
        JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-09-15T00:00:00.000Z', cwd: runDir_m2_m2_m2_z3 }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-15T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const { lifecycle, notifyCreated, removeEntryOnService, pm } = createRestoreLifecycle(service, sid, bodyFile)

    // #1：注册进 Map（真实 registerSession 链）
    await lifecycle.restoreSession(sid)
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)
    expect(existsSync(dataFile(sid))).toBe(true)
    removeEntryOnService.mockClear()

    // #2：命中 existing → 清场重开（detach → safeDestroy → 真 removeSessionEntry → respawn+switch）
    await lifecycle.restoreSession(sid)

    // 清场链真实走到：旧 pi 销毁 + 真 removeSessionEntry + 同链复活收敛点（生产中此处
    // 链式摘碑——修复后 tombstone 从未打，摘碑为幂等 no-op，插件数据全程完好）
    expect(pm.destroySession).toHaveBeenCalledWith(sid)
    expect(removeEntryOnService).toHaveBeenCalledWith(sid)
    expect(notifyCreated).toHaveBeenCalled()
    expect(trashState.calls).toHaveLength(0)
    expect(isSessionDataCleared(sid)).toBe(false)
    expect(store.get(sid, 'k1')).toBe('v1')
    expect(existsSync(dataFile(sid))).toBe(true)
    store.set(sid, 'k2', 'v2')
    expect(store.keys(sid)).toEqual(['k1', 'k2'])
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/restore-seeding-precheck.test.ts
// ======================================================================

const { reverseReads } = vi.hoisted(() => ({ reverseReads: [] as { totalBytesRead: number }[] }))


// 包装逆序分块读工具（行为不变）+ 记录读取量：判定路径「不触全量」的机械断言锚点
vi.mock('../../../utils/history-reverse-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/history-reverse-read.js')>()
  return {
    ...actual,
    forEachReversedLineChunk: (
      filePath: string,
      options: Parameters<typeof actual.forEachReversedLineChunk>[1],
      visit: Parameters<typeof actual.forEachReversedLineChunk>[2],
    ) => {
      const summary = actual.forEachReversedLineChunk(filePath, options, visit)
      reverseReads.push({ totalBytesRead: summary.totalBytesRead })
      return summary
    },
  }
})
// 流式归一化 IO 依赖：真 infra 实现（PiSessionStore 经 ISessionStore port 注入——与生产
// session-lifecycle 传 this.sessionStore 同通道；port 分层接线后 transformLine 是纯回调，
// IO 在 infra 实现内，测试对「注入实现」走真实代码路径）
const streamingImpl = new PiSessionStore()

const streaming: StreamingNormalizer = {
  normalizeSessionFileStreaming: (filePath, transformLine, chunkBytes) => streamingImpl.normalizeSessionFileStreaming(filePath, transformLine, chunkBytes),
}


let tmpDir: string


function write(name: string, content: string): string {
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, Buffer.from(content, 'utf-8'))
  return filePath
}


function headerLine(cwd = '/tmp/alive-worktree'): string {
  return JSON.stringify({ type: 'session', version: 2, id: 's-fix', timestamp: '2026-09-09T00:00:00.000Z', cwd })
}


function assistantLine(id: string, parentId: string | null, content = 'hello'): string {
  return JSON.stringify({ type: 'assistant', id, parentId, message: { role: 'assistant', content } })
}


function sessionEndLine(outcome = 'done'): string {
  return JSON.stringify({ type: 'session_end', outcome })
}


/** ~1MB 合法 assistant entry（padding：撑体积，带 id/parentId 保持链形态真实）。 */
function bigEntryLine(id: string, parentId: string): string {
  return JSON.stringify({ type: 'assistant', id, parentId, message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) } })
}


/** 超阈值大文件：header + 33 条 1MB entry（parentId 链完整）+ 尾部正常 turn + 尾行。
 *  变体差异经 includeTailSessionEnd / deadCwd 开关组合（A11 构造声明的两个变体）。 */
function writeBigSessionFile(name: string, opts: { includeTailSessionEnd: boolean; deadCwd: boolean }): { filePath: string; oldTailId: string } {
  const lines = [headerLine(opts.deadCwd ? join(tmpdir(), 'deleted-worktree-taiji') : '/tmp/alive-worktree')]
  let prev = 's-fix'
  for (let i = 0; i < 33; i++) {
    const id = `big-${i}`
    lines.push(bigEntryLine(id, prev))
    prev = id
  }
  // 尾部正常 turn（文件尾旧 entry = 分支一断言的回溯终点）
  lines.push(assistantLine('tail-user', prev, 'question'))
  lines.push(assistantLine('tail-assistant', 'tail-user', 'answer'))
  if (opts.includeTailSessionEnd) lines.push(sessionEndLine('done'))
  const filePath = write(name, lines.join('\n') + '\n')
  expect(statSync(filePath).size).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)
  return { filePath, oldTailId: 'tail-assistant' }
}


/**
 * pi _buildIndex + appendMessage 断链语义的测试模拟器（零模型）。
 *
 * 语义锚 = pi 0.84.4 dist/core/session-manager.js：_buildIndex（:673-694）对所有非
 * session entry 无差别 `byId.set(entry.id); leafId = entry.id`（entry 无 id 时
 * leafId=undefined）；appendMessage（:768+）产物 `parentId: this.leafId`。分支一主断言 =
 * 模拟附着后追加 entry（parentId=leafId），其 parentId 链（byId.get 逐级上溯）能连通到
 * 文件尾旧 entry——旧历史进入 LLM 上下文的机械等价条件。
 */
function simulateAppendAndTrace(jsonl: string, oldTailId: string): { leafId: unknown; connected: boolean } {
  const byId = new Map<unknown, { parentId?: string }>()
  let leafId: unknown = undefined // 无差别赋值：entry 无 id → leafId=undefined（断链根源）
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = JSON.parse(trimmed) as { type?: string; id?: string; parentId?: string }
    if (entry.type === 'session') continue
    byId.set(entry.id, entry)
    leafId = entry.id // 无差别（含 undefined）——与实装逐行对照
  }
  // appendMessage 语义：新增 entry 的 parentId = this.leafId
  let cur: unknown = leafId
  let hop = 0
  while (cur !== undefined && cur !== null && hop < 10_000) {
    if (cur === oldTailId) return { leafId, connected: true }
    cur = byId.get(cur)?.parentId
    hop++
  }
  return { leafId, connected: false }
}


/** pi dist 定位（cwd/测试文件位置上溯，pi-semantics-agent-session 同款范式）+ CJS 行为加载。 */
async function loadPiSessionCwd(): Promise<{ assertSessionCwdExists: unknown } | null> {
  const { createRequire } = await import('node:module')
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'session-cwd.js')
    if (existsSync(candidate)) {
      const require = createRequire(import.meta.url)
      return require(candidate) as { assertSessionCwdExists: unknown }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('restore-seeding-precheck', () => {
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'restore-seeding-precheck-'))
  reverseReads.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('P-restore-skip 分支一（失忆半边）：尾 session_end 变体 + cwd 存活', () => {
  it('超阈值 + 尾部 session_end → 最小规范化剔除 session_end，parentId 链回溯连通到文件尾旧 entry', () => {
    const { filePath, oldTailId } = writeBigSessionFile('tail-end.jsonl', { includeTailSessionEnd: true, deadCwd: false })

    // 反例先行：未 normalize 的原文件按 pi 语义 = leafId undefined（session_end 无 id）→ 断链
    const before = readFileSync(filePath, 'utf-8')
    const beforeResult = simulateAppendAndTrace(before, oldTailId)
    expect(beforeResult.leafId).toBeUndefined()
    expect(beforeResult.connected).toBe(false)

    normalizeInactiveSessionFileIfNeeded(filePath, false, streaming)

    const after = readFileSync(filePath, 'utf-8')
    expect(after).not.toContain('"session_end"')
    // 其余内容完整保留（header + 33 padding + 尾 turn，仅 session_end 被剔除）
    expect(after).toContain(headerLine())
    expect(after).toContain(assistantLine('tail-assistant', 'tail-user', 'answer'))
    // 主断言（P-restore-skip 分支一·两步式机械形态）：附着后新增 entry（parentId=leafId）
    // 的 parentId 链回溯连通到文件尾旧 entry
    const afterResult = simulateAppendAndTrace(after, oldTailId)
    expect(afterResult.leafId).toBe(oldTailId)
    expect(afterResult.connected).toBe(true)
    // 判定路径不触全量：尾扫命中即止，读取量 ~首块量级
    expect(reverseReads).toHaveLength(1)
    expect(reverseReads[0].totalBytesRead).toBeLessThan(2 * 1024 * 1024)
    // 预检 warn（含大小与原因）
    expect(vi.mocked(console.warn).mock.calls.some((args) => String(args[0]).includes('read-precheck cap') && String(args[0]).includes('streaming minimal normalization'))).toBe(true)
  })

  it('超阈值 + 无 session_end + cwd 存活 → 零变换直附着（文件字节不变，无 tmp 残留）', () => {
    const { filePath } = writeBigSessionFile('clean-big.jsonl', { includeTailSessionEnd: false, deadCwd: false })
    const before = readFileSync(filePath, 'utf-8')

    normalizeInactiveSessionFileIfNeeded(filePath, false, streaming)

    expect(readFileSync(filePath, 'utf-8')).toBe(before)
    const residue = readdirSync(tmpDir).filter((n) => n.includes('.tmp-migrate-'))
    expect(residue).toEqual([])
  })
})
describe('P-restore-skip 分支二（cwd 半边）：cwd 死路径', () => {
  it('超阈值 + cwd 死路径 → 首行 header cwd 被修复为 homedir（真 pi assertSessionCwdExists 对修复后 header 不抛）', async () => {
    const { filePath } = writeBigSessionFile('dead-cwd.jsonl', { includeTailSessionEnd: false, deadCwd: true })
    const deadCwd = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0] ?? '{}') as { cwd: string }
    expect(existsSync(deadCwd.cwd)).toBe(false)

    normalizeInactiveSessionFileIfNeeded(filePath, true, streaming)

    // header cwd 已修复（最小规范化的 cwd 半边安全——附着不再硬拒绝）
    const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0] ?? '{}') as { cwd: string }
    expect(header.cwd).toBe(homedir())
    // 真 pi 实装行为断言（node_modules dist 行为加载）：修复后 header 的 cwd 存在 →
    // assertSessionCwdExists 不抛（pi switchSession 硬拒绝被附着前修复消解）
    const piCwd = await loadPiSessionCwd()
    if (!piCwd) {
      console.warn('[restore-seeding-precheck] pi dist 不可达，跳过 assertSessionCwdExists 行为断言')
      return
    }
    const assertSessionCwdExists = piCwd.assertSessionCwdExists as (m: unknown, cwd: string) => void
    const stubManager = { getSessionFile: () => filePath, getCwd: () => header.cwd }
    expect(() => assertSessionCwdExists(stubManager, homedir())).not.toThrow()
    // 反例：未修复的死 cwd → 同一实装抛 MissingSessionCwdError（断言器有效）
    const stubDead = { getSessionFile: () => filePath, getCwd: () => deadCwd.cwd }
    let threwName = ''
    try {
      assertSessionCwdExists(stubDead, homedir())
    } catch (e) {
      threwName = (e as Error).name
    }
    expect(threwName).toBe('MissingSessionCwdError')
  })

  it('小文件 + cwd 死路径 → 行为不变（首行 header cwd 同样修复为 homedir）', () => {
    const filePath = write('small-dead-cwd.jsonl', [headerLine(join(tmpdir(), 'gone-dir')), assistantLine('e1', null)].join('\n') + '\n')

    normalizeInactiveSessionFileIfNeeded(filePath, true, streaming)

    const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0] ?? '{}') as { cwd: string }
    expect(header.cwd).toBe(homedir())
  })
})
describe('正常大小路径行为逐字节不变', () => {
  it('小文件含 session_end → 落盘产物 === 生产纯函数变换（stripSessionEndEntries）', () => {
    const lines = [headerLine(), assistantLine('e1', null), sessionEndLine('stopped'), assistantLine('e2', 'e1')]
    const filePath = write('small-strip.jsonl', lines.join('\n') + '\n')
    const raw = readFileSync(filePath, 'utf-8')

    normalizeInactiveSessionFileIfNeeded(filePath, false, streaming)

    expect(readFileSync(filePath, 'utf-8')).toBe(stripSessionEndEntries(raw))
  })

  it('小文件无 session_end 且 cwd 活 → 文件字节不变（零变换直附着）', () => {
    const filePath = write('small-clean.jsonl', [headerLine(), assistantLine('e1', null)].join('\n') + '\n')
    const before = readFileSync(filePath, 'utf-8')

    normalizeInactiveSessionFileIfNeeded(filePath, false, streaming)

    expect(readFileSync(filePath, 'utf-8')).toBe(before)
    expect(vi.mocked(console.warn).mock.calls.some((args) => String(args[0]).includes('read-precheck cap'))).toBe(false)
  })

  it('小文件 cwd 死 + session_end → 产物 === stripSessionEndEntries + applyHeaderCwdFallback 纯函数链', () => {
    const lines = [headerLine(join(tmpdir(), 'gone-dir-2')), assistantLine('e1', null), sessionEndLine('done')]
    const filePath = write('small-dead-strip.jsonl', lines.join('\n') + '\n')
    const raw = readFileSync(filePath, 'utf-8')

    normalizeInactiveSessionFileIfNeeded(filePath, true, streaming)

    expect(readFileSync(filePath, 'utf-8')).toBe(applyHeaderCwdFallback(stripSessionEndEntries(raw), homedir()))
  })
})
describe('流式变换与全量路径等价（跨块行拼接 + UTF-8 块边界）', () => {
  it('小 chunkBytes 注入下 streamWrite 产物 === 纯函数产物（含中文多字节跨块与 EOF 无尾换行）', () => {
    // 中文（3 字节/字）密集行 + 无尾换行：小 chunk（97 字节）必然切断多字节序列与行
    const lines = [
      headerLine(),
      assistantLine('e1', null, '这是一段中文内容用于制造多字节块边界'),
      sessionEndLine('done'),
      assistantLine('e2', 'e1', '另一段中文响应，含标点：、。！'),
    ]
    const src = write('stream-equiv-src.jsonl', lines.join('\n')) // 无尾 \n（EOF 终止行分支）
    const raw = readFileSync(src, 'utf-8')

    // streamNormalizeSessionFile 是原地 rename-over（附着路径无独立产物文件）——对源跑完读源即产物
    streamNormalizeSessionFile(src, false, streaming, 97)

    expect(readFileSync(src, 'utf-8')).toBe(stripSessionEndEntries(raw))
  })

  it('cwdFellBack 时流式产物首行 === 全量路径纯函数链产物首行', () => {
    const lines = [headerLine(join(tmpdir(), 'gone-dir-3')), assistantLine('e1', null, '中文内容中文内容中文内容'), sessionEndLine('done')]
    const src = write('stream-cwd-src.jsonl', lines.join('\n') + '\n')
    const raw = readFileSync(src, 'utf-8')

    streamNormalizeSessionFile(src, true, streaming, 53)

    expect(readFileSync(src, 'utf-8')).toBe(applyHeaderCwdFallback(stripSessionEndEntries(raw), homedir()))
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/runtime-checkpoint.test.ts
// ======================================================================

// root 下 chmod 权限位不生效（写/rename 照常成功）——权限类用例在 root 环境跳过
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0


const createdDirs: string[] = []

let runDir_m2: string


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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('runtime-checkpoint', () => {
beforeEach(() => {
  runDir_m2 = mkdtempSync(join(tmpdir(), 'runtime-checkpoint-'))
  createdDirs.push(runDir_m2)
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
describe('runtime checkpoint 原子写与完整性降级（D3 契约 3）', () => {
  it('upsert 原子落盘：主文件可解析、无 .tmp 残留', () => {
    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's1', filePath: '/repo/s1.jsonl', activityAt: T0, viewedAt: T0 - 1000 })

    const parsed = readMainFile(runDir_m2)
    expect(parsed?.version).toBe(1)
    expect(parsed?.updatedAt).toBe(new Date(T0).toISOString())
    expect(readSessions(runDir_m2)).toHaveLength(1)
    expect(readSessions(runDir_m2)[0]).toMatchObject({
      piSessionId: 's1',
      filePath: '/repo/s1.jsonl',
      lastActivityAt: T0,
      lastViewedAt: T0 - 1000,
      occupancy: 'idle',
      backgroundTasks: false,
      relayChildren: false,
    })
    // 原子写完成态：tmp 已被 rename 消费
    expect(existsSync(join(runDir_m2, `${CHECKPOINT_FILENAME}.tmp`))).toBe(false)
  })

  it('中途崩溃读旧版：残留 .tmp（写后未 rename 即崩）不影响 read，且被下次写入覆盖', () => {
    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's-old', activityAt: T0 })
    const before = readFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'utf8')
    // 模拟上一进程在 writeFileSync(tmp) 之后、rename 之前死亡：tmp 半截 JSON
    writeFileSync(join(runDir_m2, `${CHECKPOINT_FILENAME}.tmp`), '{"version":1,"sessions":[', 'utf8')

    // 主文件仍是完整旧版（消费方读不到半截 JSON）
    expect(h.store.read()?.sessions.map((s) => s.piSessionId)).toEqual(['s-old'])
    expect(readFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'utf8')).toBe(before)

    // 下次写入接管 tmp 名并落定新版本
    h.store.upsertSession({ sessionId: 's-new', activityAt: T0 + 1 })
    expect(existsSync(join(runDir_m2, `${CHECKPOINT_FILENAME}.tmp`))).toBe(false)
    expect(h.store.read()?.sessions.map((s) => s.piSessionId)).toEqual(['s-old', 's-new'])
  })

  it.skipIf(isRoot)('写失败（只读目录）保留上一版完整内容 + 不留 tmp + 不抛', () => {
    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0 })
    const before = readFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'utf8')

    chmodSync(runDir_m2, 0o500) // 目录不可写：writeFileSync(tmp) EACCES
    expect(() => h.store.upsertSession({ sessionId: 's2', activityAt: T0 + 1 })).not.toThrow()
    chmodSync(runDir_m2, 0o700)

    expect(readFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'utf8')).toBe(before)
    expect(existsSync(join(runDir_m2, `${CHECKPOINT_FILENAME}.tmp`))).toBe(false)
    // 内存态与磁盘态分叉是容忍的（best-effort 旁路设施）；下次成功写入整体覆盖
    h.store.upsertSession({ sessionId: 's3', activityAt: T0 + 2 })
    expect(readSessions(runDir_m2).map((s) => s.piSessionId).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('read 文件不存在 → undefined（不是空清单：staleness guard 的第 0 步语义）', () => {
    const h = makeHarness(runDir_m2)
    expect(h.store.read()).toBeUndefined()
  })
})
describe('runtime checkpoint 解析失败降级 + 失败现场（D3 契约 3/4）', () => {
  it('损坏文件：read 返回 undefined（不抛）+ 一条 checkpoint-corrupt + 隔离进失败现场', () => {
    const h = makeHarness(runDir_m2)
    writeFileSync(join(runDir_m2, CHECKPOINT_FILENAME), '{ this is not json', 'utf8')

    expect(() => h.store.read()).not.toThrow()
    expect(h.store.read()).toBeUndefined()

    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ layer: 'runtime', event: 'checkpoint-corrupt', reason: 'parse-failed' })
    expect(h.events[0]!.detailPath).toBe(join(runDir_m2, CHECKPOINT_FILENAME))
    // 失败现场：主位已腾空（消灭「陈旧清单 × 后续真 unclean」误配对窗口）
    expect(existsSync(join(runDir_m2, CHECKPOINT_FILENAME))).toBe(false)
    expect(listFailedSnapshots(runDir_m2)).toHaveLength(1)
  })

  it('形状不合法（sessions 非数组 / 条目无 piSessionId）同样降级', () => {
    const h = makeHarness(runDir_m2)
    writeFileSync(join(runDir_m2, CHECKPOINT_FILENAME), JSON.stringify({ version: 1, sessions: {} }), 'utf8')
    expect(h.store.read()).toBeUndefined()
    expect(h.events).toHaveLength(1)

    writeFileSync(join(runDir_m2, CHECKPOINT_FILENAME), JSON.stringify({ sessions: [{ filePath: '/x' }] }), 'utf8')
    const h2 = makeHarness(runDir_m2)
    expect(h2.store.read()).toBeUndefined()
    expect(h2.events[0]).toMatchObject({ event: 'checkpoint-corrupt' })
  })

  it('失败现场保留最近 3 份（新失败覆盖最旧）', () => {
    const h = makeHarness(runDir_m2)
    for (let i = 0; i < DEFAULT_FAILED_SNAPSHOT_RETENTION + 1; i++) {
      h.setNow(T0 + i * 1000)
      writeFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'garbage', 'utf8')
      expect(h.store.read()).toBeUndefined()
    }
    const snapshots = listFailedSnapshots(runDir_m2)
    expect(snapshots).toHaveLength(DEFAULT_FAILED_SNAPSHOT_RETENTION)
    // 最旧（T0）被最晚（T0+3000）覆盖，保留 T0+1000..T0+3000
    expect(snapshots[0]).toContain('2023-11-14T22-13-21-000Z')
    expect(snapshots.at(-1)).toContain('2023-11-14T22-13-23-000Z')
  })

  it('保留份数可注入（构造参数）', () => {
    const events: CrashJournalEvent[] = []
    let nowMs = T0
    const store = new RuntimeCheckpointStore({
      dir: runDir_m2,
      now: () => nowMs,
      journal: { append: (e) => { events.push(e) } },
      failedSnapshotRetention: 1,
    })
    for (let i = 0; i < 3; i++) {
      nowMs = T0 + i * 1000
      writeFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'garbage', 'utf8')
      expect(store.read()).toBeUndefined()
    }
    expect(listFailedSnapshots(runDir_m2)).toHaveLength(1)
  })
})
describe('runtime checkpoint rename 同域失败幂等（D3 降级声明）', () => {
  it('ENOENT：源不存在 → already-absent（视为已隔离，非失败）', () => {
    const h = makeHarness(runDir_m2)
    expect(h.store.isolateResidual()).toBe('already-absent')
    expect(h.events).toEqual([])
  })

  it.skipIf(isRoot)('EACCES：rename 与 unlink 同域失败 → 原地残留静默（不抛、主位文件仍在）', () => {
    const h = makeHarness(runDir_m2)
    writeFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'garbage', 'utf8')
    chmodSync(runDir_m2, 0o500)
    try {
      expect(h.store.isolateResidual()).toBe('residual')
      expect(listFailedSnapshots(runDir_m2)).toEqual([])
      // 反复失败幂等：仍是 residual，且不产生任何事件（静默）
      expect(h.store.isolateResidual()).toBe('residual')
      expect(h.events).toEqual([])
    } finally {
      chmodSync(runDir_m2, 0o700)
    }
    // 权限恢复后重试隔离成功（收敛通道①：下次启动重试）——unlink 同域失败同款
    expect(h.store.isolateResidual()).toBe('isolated')
    expect(listFailedSnapshots(runDir_m2)).toHaveLength(1)
  })

  it.skipIf(isRoot)('重复失败不重复记事件：损坏 + EACCES 原地残留形态 read 两次只记一次', () => {
    const h = makeHarness(runDir_m2)
    writeFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'garbage', 'utf8')
    chmodSync(runDir_m2, 0o500)
    try {
      expect(h.store.read()).toBeUndefined() // 记 checkpoint-corrupt + 隔离失败（residual）
      expect(h.store.read()).toBeUndefined() // 重复失败：不重复记事件
      expect(h.events).toHaveLength(1)
      expect(existsSync(join(runDir_m2, CHECKPOINT_FILENAME))).toBe(true) // 原地残留（未静默删除）
    } finally {
      chmodSync(runDir_m2, 0o700)
    }
  })
})
describe('runtime checkpoint 持续维护（D3 生命周期事件挂点的写入语义）', () => {
  it('upsert 覆盖式写入（attach / respawn 成功整条刷新）', () => {
    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's1', filePath: '/a.jsonl', activityAt: T0, viewedAt: T0 })
    h.setNow(T0 + 5000)
    h.store.upsertSession({ sessionId: 's1', filePath: '/a.jsonl', activityAt: T0 + 5000, occupancy: 'occupied' })

    const sessions = readSessions(runDir_m2)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ lastActivityAt: T0 + 5000, occupancy: 'occupied', lastViewedAt: null })
  })

  it('removeSession：摘除条目并落盘；未知 session 不落盘（防误删/空写）', () => {
    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0 })
    h.store.upsertSession({ sessionId: 's2', activityAt: T0 })
    h.store.removeSession('s1')
    expect(readSessions(runDir_m2).map((s) => s.piSessionId)).toEqual(['s2'])

    const before = readFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'utf8')
    h.store.removeSession('s-unknown')
    expect(readFileSync(join(runDir_m2, CHECKPOINT_FILENAME), 'utf8')).toBe(before)
  })

  it('refreshSessions：只更新已存在条目（不新增——未附着候选不入清单）', () => {
    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0, viewedAt: T0 })
    h.setNow(T0 + 300_000)
    h.store.refreshSessions([
      { sessionId: 's1', activityAt: T0 + 299_000, viewedAt: T0 + 298_000, occupancy: 'occupied', backgroundTasks: true, relayChildren: false },
      { sessionId: 's-ghost', activityAt: T0 + 299_000 },
    ])

    expect(h.store.hasSession('s-ghost')).toBe(false)
    const sessions = readSessions(runDir_m2)
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
    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0, viewedAt: T0 - 10, occupancy: 'occupied', backgroundTasks: true })
    h.store.refreshSessions([{ sessionId: 's1', activityAt: T0 + 1000 }])

    expect(readSessions(runDir_m2)[0]).toMatchObject({
      lastActivityAt: T0 + 1000,
      lastViewedAt: T0 - 10,
      occupancy: 'occupied',
      backgroundTasks: true,
    })
  })

  it('refreshSessions：无匹配条目 → 不落盘（checkpoint 文件不因空 tick 被创建）', () => {
    const h = makeHarness(runDir_m2)
    mkdirSync(runDir_m2, { recursive: true })
    h.store.refreshSessions([{ sessionId: 's-ghost', activityAt: T0 }])
    expect(existsSync(join(runDir_m2, CHECKPOINT_FILENAME))).toBe(false)
  })

  it('reset：清内存清单且不动磁盘文件（删除属主在 main / u5，不在本模块）', () => {
    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's1', activityAt: T0 })
    h.store.reset()
    expect(h.store.listEntries()).toEqual([])
    expect(existsSync(join(runDir_m2, CHECKPOINT_FILENAME))).toBe(true)
  })

  it('覆盖式写入不 seed 磁盘旧文件（残留清单不被当成本进程活跃集复活）', () => {
    // 预置一份「上次遗留」文件（含用户已删的 session）
    writeFileSync(join(runDir_m2, CHECKPOINT_FILENAME), JSON.stringify({
      version: 1,
      updatedAt: new Date(T0).toISOString(),
      sessions: [{ piSessionId: 's-stale', lastActivityAt: T0, occupancy: 'idle', backgroundTasks: false, relayChildren: false }],
    }), 'utf8')

    const h = makeHarness(runDir_m2)
    h.store.upsertSession({ sessionId: 's-live', activityAt: T0 + 1 })
    expect(readSessions(runDir_m2).map((s) => s.piSessionId)).toEqual(['s-live'])
  })
})
describe('runtime checkpoint 写失败可见性（code-harden RT-4#6）', () => {
  it.skipIf(isRoot)('首次写失败立即 warn（限流窗内不刷屏）；窗口过后再失败再 warn（携带连续次数与 last-success 时刻）', () => {
    const h = makeHarness(runDir_m2)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      // 成功写盘：last-success 时刻更新、非 stale
      h.store.upsertSession({ sessionId: 's1', activityAt: T0 })
      expect(h.store.getLastSuccessfulWriteAt()).toBe(T0)
      expect(h.store.isCheckpointStale()).toBe(false)

      // 失败 1：立即 warn；失败 2（同窗口，now 未推进）：不新增 warn，但 stale 置位
      chmodSync(runDir_m2, 0o500)
      h.store.upsertSession({ sessionId: 's2', activityAt: T0 + 1 })
      h.store.upsertSession({ sessionId: 's3', activityAt: T0 + 2 })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(h.store.isCheckpointStale()).toBe(true)
      const firstWarn = String(warnSpy.mock.calls[0]?.[0])
      expect(firstWarn).toContain('consecutive=1')
      expect(firstWarn).toContain(new Date(T0).toISOString()) // lastSuccessfulWriteAt 如实携带

      // 窗口（5min）过后再失败：再 warn 一条
      h.setNow(T0 + WRITE_FAILURE_WARN_INTERVAL_MS + 1)
      h.store.upsertSession({ sessionId: 's4', activityAt: T0 + 3 })
      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(String(warnSpy.mock.calls[1]?.[0])).toContain('consecutive=3')
    } finally {
      chmodSync(runDir_m2, 0o700)
      warnSpy.mockRestore()
    }
  })

  it.skipIf(isRoot)('连续失败达阈值落 journal 事件（每轮连续失败期一次）；成功写盘复位后新一轮再落', () => {
    const h = makeHarness(runDir_m2)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      h.store.upsertSession({ sessionId: 's0', activityAt: T0 }) // 成功基线
      chmodSync(runDir_m2, 0o500)
      for (let i = 0; i < WRITE_FAILURE_LEDGER_THRESHOLD; i++) {
        h.store.upsertSession({ sessionId: `s${i}`, activityAt: T0 + i })
      }
      const ledgerAt = (reason: string) => h.events.filter((e) => e.reason === reason)
      expect(ledgerAt('checkpoint-write-failed')).toHaveLength(1)
      expect(ledgerAt('checkpoint-write-failed')[0]).toMatchObject({
        layer: 'runtime',
        event: 'crash',
        reason: 'checkpoint-write-failed',
        detailPath: join(runDir_m2, CHECKPOINT_FILENAME),
      })

      // 同一轮连续失败期内继续失败：不重复 journal
      h.store.upsertSession({ sessionId: 's-extra', activityAt: T0 })
      expect(ledgerAt('checkpoint-write-failed')).toHaveLength(1)

      // 成功写盘：清 stale、复位计数（新一轮失败可再落 journal）
      chmodSync(runDir_m2, 0o700)
      h.setNow(T0 + 10)
      h.store.upsertSession({ sessionId: 's-ok', activityAt: T0 + 10 })
      expect(h.store.isCheckpointStale()).toBe(false)
      expect(h.store.getLastSuccessfulWriteAt()).toBe(T0 + 10)

      chmodSync(runDir_m2, 0o500)
      for (let i = 0; i < WRITE_FAILURE_LEDGER_THRESHOLD; i++) {
        h.store.upsertSession({ sessionId: `t${i}`, activityAt: T0 + i })
      }
      expect(ledgerAt('checkpoint-write-failed')).toHaveLength(2)
    } finally {
      chmodSync(runDir_m2, 0o700)
      warnSpy.mockRestore()
    }
  })

  it('成功写盘更新 last-success 时刻；从未写过时为 null（诊断导出范围初始语义）', () => {
    const h = makeHarness(runDir_m2)
    expect(h.store.getLastSuccessfulWriteAt()).toBeNull()
    h.store.upsertSession({ sessionId: 's1', activityAt: T0 })
    h.setNow(T0 + 7_777)
    h.store.removeSession('s1')
    expect(h.store.getLastSuccessfulWriteAt()).toBe(T0 + 7_777)
  })
})
describe('runtime checkpoint 时效性（lag 方向 = 偏漏恢复，D3 显式口径）', () => {
  it('lastActivityAt 只在 tick 刷新：checkpoint 值 ≤ 真实值 → 消费侧算出的 idle ≥ 真实 idle', () => {
    const h = makeHarness(runDir_m2)
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
  // 本节验证生产懒初始化语义，但同文件前序节（session-service-checkpoint 等）已用
  // initRuntimeCheckpointStore 固化单例（幂等首个生效），静态绑定拿不到未初始化状态——
  // resetModules 后动态 import 取新模块实例，本节自包含、不影响其他节的静态绑定。
  it('getRuntimeCheckpointStore 懒初始化走 <dataDir>/run/runtime-checkpoint.json', async () => {
    vi.resetModules()
    const mod = await import('../runtime-checkpoint.js')
    const store = mod.getRuntimeCheckpointStore()
    expect(store.runDir).toBe(join(getDataDir(), 'run'))
    expect(store.checkpointPath).toBe(join(getDataDir(), 'run', CHECKPOINT_FILENAME))
  })

  it('initRuntimeCheckpointStore 幂等（重复 init 返回同一实例）', async () => {
    const mod = await import('../runtime-checkpoint.js')
    const first = mod.initRuntimeCheckpointStore({ dir: runDir_m2 })
    const second = mod.initRuntimeCheckpointStore({ dir: join(runDir_m2, 'other') })
    expect(second).toBe(first)
    expect(second.runDir).toBe(first.runDir)
  })
})
});
