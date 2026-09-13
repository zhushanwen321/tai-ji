/**
 * 后台任务收殓器测试（u-runtime-reaper，设计 docs/architecture/file-lock-unification-
 * and-reaper-sink.md §2.3/§3.2/§3.3 + §4 S4a/S4b 触发面语义）。
 *
 * 覆盖：
 * - 三分支判定（①属主活跳过 / ③属主死+任务死转终态 / ②属主死+任务活 kill+orphaned）
 * - pid 复用防御（start time 不匹配不 kill / 取不到保守跳过 / 旧条目 startedAt 降级）
 * - registry 损坏 .corrupt 隔离 + 空表重建语义 / 版本不匹配 / 单条脏数据不报废全表
 * - 单条目处置异常 warn 跳过（幂等）
 * - 终态 LRU 裁剪（写侧 writeRegistryEntry RMW 语义对齐）
 * - 触发面 A：入口 setImmediate 延后（fire-and-forget 不占当前拍）+ session-service
 *   removeSessionEntry 挂接（真 SessionService 实例：不 await 销毁链、异常 catch warn）
 * - 触发面 B：startup-background-init 硬序（孤儿 pi 收殓完成后才扫描）+ pi 收殓
 *   失败仍扫描 + 不阻塞启动序列本身
 * - stale reaper.lock 残留清理（stale 移除 / fresh 保留）
 *
 * Mock 边界：pid 探测/处置原语全依赖注入（对齐 test/reap-orphan-pi.test.ts 惯例，
 * 零真实进程）；registry 落真实 tmp 文件系统（统一锁/原子写/corrupt 隔离走真实实现）；
 * 触发面 A/B 的挂接测试用 vi.fn 包装真实入口（默认实现透传真实行为，可按需覆写）。
 *
 * 运行：cd packages/runtime && npx vitest run test/background-task-reaper.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { BackgroundTaskRegistryEntry } from '@xyz-agent/extension-protocol'
import {
  reapSessionBackgroundTasks,
  reapAllSessionsBackgroundTasks,
  type BackgroundTaskReapDeps,
  type BackgroundTaskReapResult,
} from '../src/services/session/background-task-reaper.js'
import { SessionService } from '../src/services/session/session-service.js'
import { runStartupBackgroundInit } from '../src/services/startup-background-init.js'
import { getPiAgentDir } from '../src/infra/pi/pi-paths.js'
import { reapOrphanPiProcesses } from '../src/services/reap-orphan-pi.js'
import type { StartupBackgroundDeps } from '../src/services/startup-background-init.js'

// ── 触发面 A/B 挂接观测：包装真实入口为 vi.fn（默认实现 = 真实行为透传；挂接方
// （session-service / startup-background-init）与本测试拿到的是同一 mock 实例）──
vi.mock('../src/services/session/background-task-reaper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session/background-task-reaper.js')>()
  return {
    ...actual,
    reapSessionBackgroundTasks: vi.fn(actual.reapSessionBackgroundTasks),
    reapAllSessionsBackgroundTasks: vi.fn(actual.reapAllSessionsBackgroundTasks),
  }
})

// ── startup-background-init 挂接测试的 mock 组（对齐 src/services/startup-background-init.test.ts）──
vi.mock('../src/services/migration/legacy-provider-migration.js', () => ({
  migrateProviderConfig: vi.fn(async () => ({
    catalog: { migrated: [], kept: [], skipped: [], failed: [], errors: [] },
    enabled: { migratedEnabled: false, fullDisabledWarn: false },
  })),
}))
vi.mock('../src/services/worktree-config-helper.js', () => ({ ensureAutoRenameDefault: vi.fn() }))
vi.mock('../src/services/extension-startup-config.js', () => ({
  ensureDeclaredStartupConfigs: vi.fn(() => ({ ensured: 0, skipped: 0, failed: 0 })),
}))
vi.mock('../src/services/reap-orphan-pi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/reap-orphan-pi.js')>()
  return {
    ...actual,
    // 挂载方从该模块 import 常量与函数，mock 需两者都供给（值与真实实现一致）
    ORPHAN_REAP_DELAY_MS: 5_000,
    reapOrphanPiProcesses: vi.fn(actual.reapOrphanPiProcesses),
  }
})

/** 本次测试创建的 tmp 目录（afterEach 统一清理）。 */
const tmpAgentDirs: string[] = []
/** 触发面 A 集成用例在真实 pi agentDir 下创建的 session 目录（用后即清，防污染）。 */
const realAgentDirSessionDirs: string[] = []

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-task-reaper-'))
  tmpAgentDirs.push(dir)
  return dir
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const dir of tmpAgentDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  for (const dir of realAgentDirSessionDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── fixture helper ─────────────────────────────────────────────

/** 全依赖注入的 pid 探测/处置替身：零真实进程，行为由 alivePids/startTimes 集合驱动。 */
interface DepsFixture {
  alivePids: Set<number>
  startTimes: Map<number, number>
  killCalls: number[]
  startSecReads: number[]
  deps: BackgroundTaskReapDeps
}

function makeDeps(): DepsFixture {
  const alivePids = new Set<number>()
  const startTimes = new Map<number, number>()
  const killCalls: number[] = []
  const startSecReads: number[] = []
  return {
    alivePids,
    startTimes,
    killCalls,
    startSecReads,
    deps: {
      isPidAlive: (pid) => alivePids.has(pid),
      killProcessTree: (pid) => { killCalls.push(pid) },
      getProcessStartTimeSec: (pid) => { startSecReads.push(pid); return startTimes.get(pid) },
    },
  }
}

/** 契约形状的活跃条目（缺省 running / 死属主可任意编排）。 */
function makeEntry(overrides: Partial<BackgroundTaskRegistryEntry> = {}): BackgroundTaskRegistryEntry {
  return {
    taskId: 'bt-1',
    pid: 1111,
    command: 'sleep 300',
    outputFile: '/tmp/bt-out.log',
    startedAt: 1_700_000_000_000,
    state: 'running',
    ownerPiPid: 2222,
    sessionId: 's1',
    ...overrides,
  }
}

function registryPathOf(agentDir: string, sessionId: string): string {
  return join(agentDir, 'base-tool-enhance', sessionId, 'registry.json')
}

function writeRegistryFile(agentDir: string, sessionId: string, entries: unknown[], version = 1): string {
  const p = registryPathOf(agentDir, sessionId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify({ version, entries }, null, 2)}\n`)
  return p
}

function readRegistryEntries(agentDir: string, sessionId: string): BackgroundTaskRegistryEntry[] | undefined {
  const p = registryPathOf(agentDir, sessionId)
  if (!existsSync(p)) return undefined
  return (JSON.parse(readFileSync(p, 'utf8')) as { entries: BackgroundTaskRegistryEntry[] }).entries
}

function findEntry(agentDir: string, sessionId: string, taskId: string): BackgroundTaskRegistryEntry | undefined {
  return readRegistryEntries(agentDir, sessionId)?.find((e) => e.taskId === taskId)
}

function zeroResult(): BackgroundTaskReapResult {
  return { scannedDirs: 0, ownerAliveSkipped: 0, killedOrphans: 0, finalizedOrphans: 0, conservativelySkipped: 0, staleLocksRemoved: 0 }
}

/** 取一个确定已死亡的 pid（短命子进程退出即死；测试内即刻使用，pid 复用窗口趋零）。 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''])
  if (typeof r.pid !== 'number') throw new Error('cannot acquire dead pid for fixture')
  return r.pid
}

// ── 三分支判定 ─────────────────────────────────────────────

describe('三分支判定（移植 reaper.ts §3.5）', () => {
  it('①属主活跳过：running 与 killing 条目均跳过，registry 原样、不 kill', async () => {
    const agentDir = makeAgentDir()
    const { alivePids, killCalls, deps } = makeDeps()
    alivePids.add(2222)
    writeRegistryFile(agentDir, 's1', [makeEntry(), makeEntry({ taskId: 'bt-2', state: 'killing', pid: 1112 })])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, ownerAliveSkipped: 2 })
    expect(killCalls).toEqual([])
    expect(findEntry(agentDir, 's1', 'bt-1')?.state).toBe('running')
    expect(findEntry(agentDir, 's1', 'bt-2')?.state).toBe('killing')
  })

  it('③属主死 + 任务 pid 死 → 不补杀，仅转 orphaned 终态', async () => {
    const agentDir = makeAgentDir()
    const { killCalls, deps } = makeDeps()
    writeRegistryFile(agentDir, 's1', [makeEntry()])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, finalizedOrphans: 1 })
    expect(killCalls).toEqual([])
    const entry = findEntry(agentDir, 's1', 'bt-1')
    expect(entry?.state).toBe('orphaned')
    expect(entry?.endedAt).toBeTypeOf('number')
    expect(entry?.durationMs).toBe(entry!.endedAt! - 1_700_000_000_000)
    // orphaned 不写 reason（成因不在 exited reason 枚举内）
    expect(entry?.reason).toBeUndefined()
    // 其余字段原样保留
    expect(entry?.pid).toBe(1111)
    expect(entry?.command).toBe('sleep 300')
  })

  it('②属主死 + 任务 pid 活 + start time 匹配 → kill 进程树 + 写 orphaned', async () => {
    const agentDir = makeAgentDir()
    const { alivePids, startTimes, killCalls, deps } = makeDeps()
    alivePids.add(1111)
    startTimes.set(1111, 123_456)
    writeRegistryFile(agentDir, 's1', [makeEntry({ pidStartTime: 123_456 })])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, killedOrphans: 1 })
    expect(killCalls).toEqual([1111])
    expect(findEntry(agentDir, 's1', 'bt-1')?.state).toBe('orphaned')
  })

  it('终态条目（exited/orphaned）跳过——二次扫描幂等 no-op', async () => {
    const agentDir = makeAgentDir()
    const { killCalls, deps } = makeDeps()
    writeRegistryFile(agentDir, 's1', [
      makeEntry({ taskId: 'bt-done', state: 'exited', reason: 'natural', endedAt: 1, durationMs: 1 }),
      makeEntry({ taskId: 'bt-orph', state: 'orphaned', endedAt: 2, durationMs: 2 }),
    ])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
    expect(killCalls).toEqual([])
    expect(readRegistryEntries(agentDir, 's1')).toHaveLength(2)
  })
})

// ── pid 复用防御 ─────────────────────────────────────────────

describe('pid 复用防御（§3.6 宁不杀勿误杀）', () => {
  it('start time 与登记值不匹配（pid 被复用）→ 不 kill、不转终态，条目停留 running', async () => {
    const agentDir = makeAgentDir()
    const { alivePids, startTimes, killCalls, deps } = makeDeps()
    alivePids.add(1111)
    startTimes.set(1111, 999_999) // 复用后的新进程 start time
    writeRegistryFile(agentDir, 's1', [makeEntry({ pidStartTime: 123_456 })])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, conservativelySkipped: 1 })
    expect(killCalls).toEqual([])
    expect(findEntry(agentDir, 's1', 'bt-1')?.state).toBe('running')
  })

  it('取不到 start time（ps 不可用/失败）→ 保守跳过整个处置', async () => {
    const agentDir = makeAgentDir()
    const { alivePids, killCalls, deps } = makeDeps()
    alivePids.add(1111) // 任务 pid 活
    writeRegistryFile(agentDir, 's1', [makeEntry({ pidStartTime: 123_456 })])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, conservativelySkipped: 1 })
    expect(killCalls).toEqual([])
    expect(findEntry(agentDir, 's1', 'bt-1')?.state).toBe('running')
  })

  it('旧条目缺 pidStartTime → startedAt 秒级降级判据：actual ≤ floor(startedAt/1000) 可 kill', async () => {
    const agentDir = makeAgentDir()
    const { alivePids, startTimes, killCalls, deps } = makeDeps()
    alivePids.add(1111)
    startTimes.set(1111, 1_700_000_000) // = floor(1_700_000_000_000/1000)，登记秒内启动的原进程
    writeRegistryFile(agentDir, 's1', [makeEntry()]) // 无 pidStartTime

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result.killedOrphans).toBe(1)
    expect(killCalls).toEqual([1111])
  })

  it('旧条目缺 pidStartTime → 降级判据不满足（晚于登记秒）同样保守跳过', async () => {
    const agentDir = makeAgentDir()
    const { alivePids, startTimes, killCalls, deps } = makeDeps()
    alivePids.add(1111)
    startTimes.set(1111, 1_700_000_005)
    writeRegistryFile(agentDir, 's1', [makeEntry()])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, conservativelySkipped: 1 })
    expect(killCalls).toEqual([])
  })
})

// ── registry 损坏防御 ─────────────────────────────────────────────

describe('registry 损坏防御（.corrupt 隔离 + 空表重建）', () => {
  it('解析失败 → 重命名 .corrupt 保留现场 + 按空表继续，不抛', async () => {
    const agentDir = makeAgentDir()
    const { deps } = makeDeps()
    const p = writeRegistryFile(agentDir, 's1', [])
    writeFileSync(p, '{not valid json')

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
    expect(existsSync(p)).toBe(false)
    const corrupt = `${p}.corrupt`
    expect(existsSync(corrupt)).toBe(true)
    expect(readFileSync(corrupt, 'utf8')).toBe('{not valid json')
  })

  it('version 不匹配 → 同走 corrupt 隔离路径', async () => {
    const agentDir = makeAgentDir()
    const { deps } = makeDeps()
    writeRegistryFile(agentDir, 's1', [makeEntry()], 99)

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1 })
    expect(existsSync(`${registryPathOf(agentDir, 's1')}.corrupt`)).toBe(true)
  })

  it('单条脏数据丢弃、不报废全表：合法条目照常处置', async () => {
    const agentDir = makeAgentDir()
    const { deps } = makeDeps()
    writeRegistryFile(agentDir, 's1', [
      { taskId: 42, pid: 'x', state: 'running' }, // 8 必填字段类型非法 → 整条丢弃
      makeEntry({ taskId: 'bt-ok' }), // 属主死 + 任务死 → ③ 收尾
    ])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, finalizedOrphans: 1 })
    expect(findEntry(agentDir, 's1', 'bt-ok')?.state).toBe('orphaned')
  })
})

// ── 错误容忍 ─────────────────────────────────────────────

describe('错误容忍', () => {
  it('单条目处置异常（kill 抛错）→ warn 后跳过该条，不中断其余条目（幂等，下个事件重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const agentDir = makeAgentDir()
      const fixture = makeDeps()
      fixture.alivePids.add(1111)
      fixture.alivePids.add(1112) // 两条活任务
      fixture.startTimes.set(1111, 123_456)
      fixture.startTimes.set(1112, 123_456)
      const killCalls = fixture.killCalls
      const deps: BackgroundTaskReapDeps = {
        ...fixture.deps,
        killProcessTree: (pid) => {
          if (pid === 1111) throw new Error('kill boom')
          killCalls.push(pid)
        },
      }
      writeRegistryFile(agentDir, 's1', [
        makeEntry({ pidStartTime: 123_456 }),
        makeEntry({ taskId: 'bt-2', pid: 1112, pidStartTime: 123_456 }),
      ])

      const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

      expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, killedOrphans: 1, conservativelySkipped: 1 })
      expect(killCalls).toEqual([1112])
      expect(findEntry(agentDir, 's1', 'bt-1')?.state).toBe('running') // 异常条目停留原状，交下个事件
      expect(findEntry(agentDir, 's1', 'bt-2')?.state).toBe('orphaned')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('taskId=bt-1'), 'kill boom')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('触发面 A：session 目录不存在（从未跑过后台任务）→ 静默 no-op 不抛', async () => {
    const agentDir = makeAgentDir()
    const { deps } = makeDeps()
    const result = await reapSessionBackgroundTasks(agentDir, 'never-existed', deps)
    expect(result).toEqual(zeroResult())
  })
})

// ── 触发面 A 入口语义（fire-and-forget 安全性） ─────────────────────────────────────────────

describe('触发面 A 入口：setImmediate 延后同步核心', () => {
  it('调用后当前拍不执行（void 返回不 await 安全），延后一拍才处置', async () => {
    const agentDir = makeAgentDir()
    const { alivePids, startTimes, startSecReads, deps } = makeDeps()
    alivePids.add(1111)
    startTimes.set(1111, 123_456)
    writeRegistryFile(agentDir, 's1', [makeEntry({ pidStartTime: 123_456 })])

    const pending = reapSessionBackgroundTasks(agentDir, 's1', deps)
    // 同步核心未跑：未读 start time、registry 未变（销毁链所在拍不被 spawnSync 占用）
    expect(startSecReads).toEqual([])
    expect(findEntry(agentDir, 's1', 'bt-1')?.state).toBe('running')

    const result = await pending
    expect(result.killedOrphans).toBe(1)
    expect(startSecReads).toEqual([1111])
    expect(findEntry(agentDir, 's1', 'bt-1')?.state).toBe('orphaned')
  })
})

// ── 触发面 B 全量扫描 + stale reaper.lock ─────────────────────────────────────────────

describe('触发面 B：reapAllSessionsBackgroundTasks 全量扫描', () => {
  it('扫全部 session 目录并聚合结果；无 registry 的目录计入 scannedDirs', async () => {
    const agentDir = makeAgentDir()
    const { alivePids, startTimes, killCalls, deps } = makeDeps()
    alivePids.add(1111)
    startTimes.set(1111, 123_456)
    writeRegistryFile(agentDir, 's1', [makeEntry({ pidStartTime: 123_456 })]) // ② kill
    writeRegistryFile(agentDir, 's2', [makeEntry({ taskId: 'bt-alive-owner', ownerPiPid: 3333 })]) // ① 跳过
    mkdirSync(join(agentDir, 'base-tool-enhance', 's3')) // 空 session 目录（无 registry）
    alivePids.add(3333)

    const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 3, killedOrphans: 1, ownerAliveSkipped: 1 })
    expect(killCalls).toEqual([1111])
  })

  it('baseDir 不存在（从未有过后台任务）→ 全零结果不抛', async () => {
    const agentDir = makeAgentDir()
    const { deps } = makeDeps()
    const result = await reapAllSessionsBackgroundTasks(agentDir, deps)
    expect(result).toEqual(zeroResult())
  })

  it('stale 的 reaper.lock 残留目录（mtime 超 30s）被 rmdir，且不计入扫描', async () => {
    const agentDir = makeAgentDir()
    const { deps } = makeDeps()
    const baseDir = join(agentDir, 'base-tool-enhance')
    const lockDir = join(baseDir, 'reaper.lock')
    mkdirSync(lockDir, { recursive: true })
    const stale = new Date(Date.now() - 60_000)
    utimesSync(lockDir, stale, stale)
    writeRegistryFile(agentDir, 's1', [makeEntry()])

    const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

    expect(result).toEqual({ ...zeroResult(), scannedDirs: 1, finalizedOrphans: 1, staleLocksRemoved: 1 })
    expect(existsSync(lockDir)).toBe(false)
  })

  it('fresh 的 reaper.lock（≤30s，可能是共存旧包在途临界区）保留不动', async () => {
    const agentDir = makeAgentDir()
    const { deps } = makeDeps()
    const lockDir = join(agentDir, 'base-tool-enhance', 'reaper.lock')
    mkdirSync(lockDir, { recursive: true })

    const result = await reapAllSessionsBackgroundTasks(agentDir, deps)

    expect(result.staleLocksRemoved).toBe(0)
    expect(existsSync(lockDir)).toBe(true)
  })
})

// ── 终态 LRU 裁剪（写侧 writeRegistryEntry RMW 语义对齐） ─────────────────────────────────────────────

describe('终态 LRU 裁剪（MAX_TERMINAL_REGISTRY_ENTRIES）', () => {
  it('收尾写入使终态超上限 → 按 endedAt 淘汰最老终态，总条目回到 50', async () => {
    const agentDir = makeAgentDir()
    const { deps } = makeDeps()
    const terminal = Array.from({ length: 50 }, (_, i) =>
      makeEntry({ taskId: `bt-old-${i}`, state: 'exited', reason: 'natural', endedAt: 1_000 + i, durationMs: 1 }),
    )
    writeRegistryFile(agentDir, 's1', [...terminal, makeEntry({ taskId: 'bt-active' })])

    const result = await reapSessionBackgroundTasks(agentDir, 's1', deps)

    expect(result.finalizedOrphans).toBe(1)
    const entries = readRegistryEntries(agentDir, 's1')
    expect(entries).toHaveLength(50)
    expect(findEntry(agentDir, 's1', 'bt-old-0')).toBeUndefined() // 最老终态被淘汰
    expect(findEntry(agentDir, 's1', 'bt-old-1')).toBeDefined()
    expect(findEntry(agentDir, 's1', 'bt-active')?.state).toBe('orphaned')
  })
})

// ── 触发面 A 挂接：session-service removeSessionEntry 汇聚点 ─────────────────────────────────────────────

/** 最小依赖构造 SessionService：仅 removeSessionEntry 路径（构造器只存引用 + 注册 onSessionExit）。 */
function makeSessionService(): SessionService {
  type Ctor = typeof SessionService
  return new SessionService(
    { onSessionExit: vi.fn() } as unknown as ConstructorParameters<Ctor>[0],
    {} as unknown as ConstructorParameters<Ctor>[1],
    (() => ({})) as unknown as ConstructorParameters<Ctor>[2],
    '/tmp',
    {} as unknown as ConstructorParameters<Ctor>[4],
    {} as unknown as ConstructorParameters<Ctor>[5],
    {} as unknown as ConstructorParameters<Ctor>[6],
    {} as unknown as ConstructorParameters<Ctor>[7],
    {} as unknown as ConstructorParameters<Ctor>[8],
  )
}

describe('触发面 A 挂接（session-service.removeSessionDestroyed 汇聚点）', () => {
  it('removeSessionEntry 触发收殓：参数 (getPiAgentDir(), sessionId)，且不 await 销毁链（延后拍完成处置）', async () => {
    const service = makeSessionService()
    // 真实 registry + 真实 pid 探测：owner/task 均为确定已死 pid → 走③终态收尾
    const sid = `trigger-a-${process.pid}`
    const sessionDir = join(getPiAgentDir(), 'base-tool-enhance', sid)
    realAgentDirSessionDirs.push(sessionDir)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'registry.json'),
      `${JSON.stringify({ version: 1, entries: [makeEntry({ taskId: `bt-${sid}`, pid: deadPid(), ownerPiPid: deadPid(), sessionId: sid })] }, null, 2)}\n`,
    )

    service.removeSessionEntry(sid) // 同步返回（void）

    // 挂接参数：agentDir 为 pi agent 目录（registry 目录布局契约的 agentDir 同源）
    expect(reapSessionBackgroundTasks).toHaveBeenCalledWith(getPiAgentDir(), sid)
    // fire-and-forget：销毁链同步返回时收殓尚未执行（延后拍）
    expect(findEntry(getPiAgentDir(), sid, `bt-${sid}`)?.state).toBe('running')

    await new Promise((resolve) => setImmediate(resolve))
    expect(findEntry(getPiAgentDir(), sid, `bt-${sid}`)?.state).toBe('orphaned')
  })

  it('收殓 reject 不外抛：removeSessionEntry 不 throw，catch 落 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(reapSessionBackgroundTasks).mockRejectedValueOnce(new Error('reap boom'))
      const service = makeSessionService()
      expect(() => service.removeSessionEntry('sid-reject')).not.toThrow()
      // flush 微任务：.catch 分支执行
      await new Promise((resolve) => setImmediate(resolve))
      expect(warnSpy).toHaveBeenCalledWith('[session-service] background task reap failed (sessionId=sid-reject):', expect.any(Error))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── 触发面 B 挂接：startup-background-init 硬序 ─────────────────────────────────────────────

function makeStartupDeps(): StartupBackgroundDeps {
  return {
    configStore: {} as StartupBackgroundDeps['configStore'],
    authStorage: {} as StartupBackgroundDeps['authStorage'],
    credentialWriter: { saveCredential: vi.fn() },
    extensionService: {
      migrateBuiltinExtensions: vi.fn(async () => undefined),
      checkAndAutoUpgrade: vi.fn(async () => []),
      getExtensionPaths: vi.fn(async () => []),
    } as unknown as StartupBackgroundDeps['extensionService'],
    pm: { getPiVersion: vi.fn(async () => '9.9.9') } as unknown as StartupBackgroundDeps['pm'],
    appInfo: { appVersion: '1.2.3', piVersion: 'unknown' },
    broadcastAppInfo: vi.fn(),
    skillRegistry: { initGlobal: vi.fn(async () => undefined), getGlobalSkills: vi.fn(() => []) } as unknown as StartupBackgroundDeps['skillRegistry'],
    pluginService: { initialize: vi.fn(async () => undefined) } as unknown as StartupBackgroundDeps['pluginService'],
    // u17：spawn 清单读取 port（reap 全 mock 场景下值不被消费，形态保真）
    readSpawnMarkers: () => [],
  }
}

describe('触发面 B 挂接（startup-background-init 硬序）', () => {
  it('B 扫描链式 await 孤儿 pi 收殓完成：pi 收殓未完成前扫描不得先行', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      let resolvePiReap!: () => void
      vi.mocked(reapOrphanPiProcesses).mockImplementationOnce(
        () => new Promise((resolve) => {
          events.push('pi-reap:start')
          resolvePiReap = () => { events.push('pi-reap:end'); resolve({ scanned: 0, reaped: [], failed: [], unsupported: false }) }
        }),
      )
      vi.mocked(reapAllSessionsBackgroundTasks).mockImplementationOnce(async () => {
        events.push('scan')
        return zeroResult()
      })

      await runStartupBackgroundInit(makeStartupDeps())
      // 启动序列本身不被 fire-and-forget 定时器阻塞：序列已完整返回，5s 定时器尚未到点
      expect(reapOrphanPiProcesses).not.toHaveBeenCalled()
      expect(events).toEqual([])

      await vi.advanceTimersByTimeAsync(5_000)
      // 5s 到点：孤儿 pi 收殓已开始但未完成 → 硬序要求扫描仍未执行
      expect(events).toEqual(['pi-reap:start'])
      expect(reapAllSessionsBackgroundTasks).not.toHaveBeenCalled()

      resolvePiReap()
      await vi.advanceTimersByTimeAsync(0) // flush 微任务链
      // pi 收殓完成后扫描才执行；agentDir 为 pi agent 目录
      expect(events).toEqual(['pi-reap:start', 'pi-reap:end', 'scan'])
      expect(reapAllSessionsBackgroundTasks).toHaveBeenCalledWith(getPiAgentDir())
    } finally {
      vi.useRealTimers()
    }
  })

  it('孤儿 pi 收殓失败（reject 兜底后）仍执行 B 扫描——硬序只约束先后，不传递成败', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(reapOrphanPiProcesses).mockRejectedValueOnce(new Error('pi reap boom'))
      vi.mocked(reapAllSessionsBackgroundTasks).mockResolvedValueOnce(zeroResult())

      await runStartupBackgroundInit(makeStartupDeps())
      await vi.advanceTimersByTimeAsync(5_000)

      expect(reapAllSessionsBackgroundTasks).toHaveBeenCalledTimes(1)
      expect(reapAllSessionsBackgroundTasks).toHaveBeenCalledWith(getPiAgentDir())
    } finally {
      vi.useRealTimers()
    }
  })

  it('B 扫描自身失败（reject）→ 链尾 catch 兜底 warn，不外抛、不影响启动序列', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(reapOrphanPiProcesses).mockResolvedValueOnce({ scanned: 0, reaped: [], failed: [], unsupported: false })
      vi.mocked(reapAllSessionsBackgroundTasks).mockRejectedValueOnce(new Error('scan boom'))

      await runStartupBackgroundInit(makeStartupDeps())
      await vi.advanceTimersByTimeAsync(5_000)

      expect(warnSpy).toHaveBeenCalledWith('[runtime] background task reap-all failed unexpectedly:', expect.any(Error))
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
