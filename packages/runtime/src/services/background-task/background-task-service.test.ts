/**
 * BackgroundTaskService 单测（u-runtime-svc，设计 docs/architecture/background-task-sidebar-view.md
 * §3.3 D1/D2/D6/D8 + §3.4 P1/P5 探针的实施期门）。
 *
 * 覆盖：
 * - P1 探针：并发写（循环 rename 新文件）× 并发读 1000 次 parse 成功率 100%（corrupted=0）
 * - D2 变更检测单广播源：mtime 轮询 + 事件钩子（checkForChanges 手动触发）+ 自写自检
 *   三触发面共享同一 last-seen——同变化至多广播一次；mtime 未变不重播
 * - D8 watched 集合：markWatched 基线不广播 / 垃圾 sid ENOENT 静默空表（不告警刷屏）
 * - D1 corrupt 语义：解析失败 → 空表 + corrupted 标记 + .corrupt 隔离，不 throw
 * - D6 kill 五分支矩阵：
 *     ① 活跃+pid 活+身份过+属主活 → 锁内预写 killing（仅 state 无 reason）→ 信号 → killed
 *     ② 活跃+pid 活+身份过+属主死 → 信号 → 锁内写 orphaned → killed
 *     ③ 活跃+pid 死（任属主）→ 不发信号；属主活写 exited/natural/null 过渡终态、
 *        属主死写 orphaned；poller 竞争已终态时不覆盖；锁内判活重查拒绝死而复生
 *     ④ 身份探测不可得 → identity-unverifiable，无信号无写
 *     ⑤ 锁内写失败（①预写/②终态）→ registry-write-failed 中止语义（未发信号不杀）
 * - D6⑤ 补遗族（锁获取失败 catch ×2 + ③收尾写失败 catch ×2，全 catch 点闭合）：
 *     ⑤c ①路径锁获取失败（ELOCKED 预算耗尽）⑤d ③路径锁获取失败
 *     ⑤e ③锁内重查死收尾写失败 ⑤f finalizeDeadEntry 锁内收尾写失败
 * - D6 身份验证两档：pidStartTime 严格比对 / 缺省 startedAt 降级；mismatch = pid 复用 → ③
 * - D7 自写自检：kill 成功路径广播且轮询 tick 不重复
 *
 * Mock 边界：pid 探测/处置原语全依赖注入（对齐 reaper 测试惯例，零真实进程）；
 * registry 落真实 tmp 文件系统（mkdtempSync 自建自删，禁触真实数据目录）；node:fs
 * 部分 mock 仅注入 ⑤ 的 tmp 写失败分支（默认委托真实实现，primitives 惯例）；
 * utils/file-lock 同款部分 mock 仅注入 ⑤ 锁获取失败分支（默认委托真实实现）。
 * timer 用 fake timers。
 *
 * 运行：cd packages/runtime && env -u XYZ_AGENT_DATA_DIR npx vitest run src/services/background-task
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BackgroundTaskRegistryEntry } from '@xyz-agent/extension-protocol'
import { BackgroundTaskService, type BackgroundTaskServiceDeps } from './background-task-service.js'
import { readRegistryEntriesWithStatus } from '../session/background-task-reaper.js'

// ── node:fs 部分 mock：仅注入 ⑤ tmp 写失败分支（默认委托真实实现）──
const fsMock = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  actual: null as unknown as typeof import('node:fs'),
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsMock.actual = actual
  // 工厂内即设默认委托：被测模块图任何 fs 调用都先拿到真实行为
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync as never)
  return { ...actual, writeFileSync: fsMock.writeFileSync }
})

function delegateFsToReal(): void {
  fsMock.writeFileSync.mockImplementation(fsMock.actual.writeFileSync as never)
}

// ── utils/file-lock 部分 mock：仅注入 ⑤ 锁获取失败分支（默认委托真实实现）──
const fileLockMock = vi.hoisted(() => ({
  withFileLockSync: vi.fn(),
  actual: null as unknown as typeof import('../../utils/file-lock.js'),
}))
vi.mock('../../utils/file-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/file-lock.js')>()
  fileLockMock.actual = actual
  // 工厂内即设默认委托：被测模块图的锁调用默认走真实实现
  fileLockMock.withFileLockSync.mockImplementation(actual.withFileLockSync as never)
  return { ...actual, withFileLockSync: fileLockMock.withFileLockSync }
})

function delegateFileLockToReal(): void {
  fileLockMock.withFileLockSync.mockImplementation(fileLockMock.actual.withFileLockSync as never)
}

/**
 * 注入模拟 ELOCKED：锁获取即抛（⑤锁获取失败分支——withFileLockSync 预算耗尽 fail-fast
 * 同形态；afterEach 的 delegateFileLockToReal 自动恢复）。
 */
function failFileLock(): void {
  fileLockMock.withFileLockSync.mockImplementation(() => {
    throw Object.assign(new Error('[file-lock] simulated: ELOCKED retry budget exhausted'), { code: 'ELOCKED' })
  })
}

// ── fixtures ──────────────────────────────────────────────────────

const SID = 'sess-1'
const TASK_ID = 'bt-1789-test'
const TASK_PID = 53241
const OWNER_PID = 40001
const STARTED_AT = 1_700_000_000_000

function makeEntry(overrides: Partial<BackgroundTaskRegistryEntry> = {}): BackgroundTaskRegistryEntry {
  return {
    taskId: TASK_ID,
    pid: TASK_PID,
    command: 'pnpm test',
    outputFile: '/tmp/does-not-matter.log',
    startedAt: STARTED_AT,
    state: 'running',
    ownerPiPid: OWNER_PID,
    sessionId: SID,
    ...overrides,
  }
}

let agentDir: string

function registryPath(): string {
  return join(agentDir, 'base-tool-enhance', SID, 'registry.json')
}

/** 按契约形状写 registry（JSON indent 2 + 尾部换行；tmp 自建自删）。 */
function writeRegistry(entries: BackgroundTaskRegistryEntry[]): void {
  mkdirSync(join(agentDir, 'base-tool-enhance', SID), { recursive: true })
  writeFileSync(registryPath(), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}

function readRawEntries(): BackgroundTaskRegistryEntry[] {
  return readRegistryEntriesWithStatus(registryPath()).entries
}

/** deps 工厂：按 pid 路由的判活 mock + 探测/处置 spy（返回契约类型；vi.fn 产物可直接用于 expect 断言）。 */
function makeDeps(overrides: Partial<BackgroundTaskServiceDeps> = {}): BackgroundTaskServiceDeps {
  const isPidAlive = overrides.isPidAlive ?? vi.fn((pid: number) => pid === TASK_PID || pid === OWNER_PID)
  const killProcessTree = overrides.killProcessTree ?? vi.fn()
  const probeProcessStartTimeMs = overrides.probeProcessStartTimeMs ?? vi.fn(async () => STARTED_AT) // 缺省：进程启于登记前（降级档恒过）
  return { isPidAlive, killProcessTree, probeProcessStartTimeMs }
}

function makeService(deps: BackgroundTaskServiceDeps, onTasksChanged = vi.fn()): BackgroundTaskService {
  return new BackgroundTaskService({ onTasksChanged, piAgentDir: agentDir, deps })
}

/**
 * 注入模拟 EACCES：当前 registryPath 的原子写 tmp 文件写入即抛（⑤写失败分支；
 * afterEach 的 delegateFsToReal 自动恢复）。
 */
function failTmpWrites(): void {
  fsMock.writeFileSync.mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (String(p).startsWith(`${registryPath()}.tmp_`)) {
      throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' })
    }
    // writeFileSync 是重载函数：抹平重载签名后透传（仅本测试文件 mock 层）
    return (fsMock.actual.writeFileSync as (...a: unknown[]) => ReturnType<typeof fsMock.actual.writeFileSync>)(p, ...rest)
  }) as typeof fsMock.actual.writeFileSync)
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'bg-task-svc-'))
  delegateFsToReal()
  delegateFileLockToReal()
})

afterEach(() => {
  delegateFsToReal()
  delegateFileLockToReal()
  vi.useRealTimers()
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  vi.restoreAllMocks()
  // vitest 4 的 restoreAllMocks 只恢复 vi.spyOn，模块级 vi.fn() 的调用历史须显式清，
  // 否则调用次数断言跨用例累计（⑤c 曾因此把累计 10 次误当本次调用）
  fsMock.writeFileSync.mockClear()
  fileLockMock.withFileLockSync.mockClear()
})

// ── P1 探针：并发写×读 1000 次 ───────────────────────────────────

describe('P1: registry 并发写×读 1000 次 parse 成功率 100%', () => {
  it('循环 rename 新文件的写者与无锁读者交错，零 corrupted', async () => {
    mkdirSync(join(agentDir, 'base-tool-enhance', SID), { recursive: true })
    writeFileSync(registryPath(), `${JSON.stringify({ version: 1, entries: [makeEntry({ taskId: 'bt-init' })] }, null, 2)}\n`, 'utf8')
    let writes = 0
    const writer = setInterval(() => {
      // 模拟 extension/reaper 写侧：tmp + rename 原子写（循环 rename 新文件）
      const tmp = `${registryPath()}.tmp_writer_${process.pid}`
      writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: [makeEntry({ taskId: `bt-w${writes}` })] }, null, 2)}\n`, 'utf8')
      renameSync(tmp, registryPath())
      writes++
    }, 0)
    let reads = 0
    let corrupted = 0
    try {
      while (reads < 1000) {
        if (readRegistryEntriesWithStatus(registryPath()).corrupted) corrupted++
        reads++
        if (reads % 25 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } finally {
      clearInterval(writer)
    }
    expect(reads).toBe(1000)
    expect(corrupted).toBe(0)
    expect(writes).toBeGreaterThan(0)
  })
})

// ── D2 变更检测：单广播源 + D8 watched ───────────────────────────

describe('D2/D8: 变更检测共享 last-seen 单广播源 + watched 生命周期', () => {
  it('事件钩子先消费变化后，轮询 tick 不再广播（同一变化至多广播一次）', async () => {
    vi.useFakeTimers()
    const onTasksChanged = vi.fn()
    const service = makeService(makeDeps(), onTasksChanged)
    writeRegistry([makeEntry()])
    service.markWatched(SID)
    service.start()

    // 任务状态迁移：写新 registry 并显式推进 mtime（同 ms 写入 mtime 不变的精度规避）
    writeRegistry([makeEntry({ state: 'exited', exitCode: 0, reason: 'natural', endedAt: STARTED_AT + 9, durationMs: 9 })])
    utimesSync(registryPath(), 1000, 1000)

    // 事件钩子路径先到：消费掉该 mtime 变化
    service.checkForChanges()
    expect(onTasksChanged).toHaveBeenCalledTimes(1)

    // 轮询 tick 到：mtime 未再变 → 不重播（共享 last-seen，非第二广播源）
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onTasksChanged).toHaveBeenCalledTimes(1)

    // 新变化 → 下个轮询 tick 广播第 2 次
    writeRegistry([makeEntry({ state: 'killing' })])
    utimesSync(registryPath(), 2000, 2000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onTasksChanged).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('markWatched 建立基线不广播；mtime 未变时轮询静默', async () => {
    vi.useFakeTimers()
    const onTasksChanged = vi.fn()
    const service = makeService(makeDeps(), onTasksChanged)
    writeRegistry([makeEntry()])
    service.markWatched(SID)
    service.start()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(onTasksChanged).not.toHaveBeenCalled()
    service.dispose()
  })

  it('垃圾 sid：listTasks 静默空表，轮询不告警不广播', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onTasksChanged = vi.fn()
    const service = makeService(makeDeps(), onTasksChanged)
    const result = service.listTasks('garbage-sid-never-existed')
    expect(result).toEqual({ entries: [], corrupted: false })
    service.markWatched('garbage-sid-never-existed')
    service.start()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(onTasksChanged).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    service.dispose()
  })

  it('dispose 后轮询停止', async () => {
    vi.useFakeTimers()
    const onTasksChanged = vi.fn()
    const service = makeService(makeDeps(), onTasksChanged)
    writeRegistry([makeEntry()])
    service.markWatched(SID)
    service.start()
    service.dispose()
    writeRegistry([makeEntry({ state: 'exited', exitCode: 0 })])
    utimesSync(registryPath(), 3000, 3000)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(onTasksChanged).not.toHaveBeenCalled()
  })
})

// ── D1 corrupt 语义 ───────────────────────────────────────────────

describe('D1: registry 损坏 corrupt 语义', () => {
  it('解析失败 → 空表 + corrupted 标记 + .corrupt 隔离，不 throw', () => {
    mkdirSync(join(agentDir, 'base-tool-enhance', SID), { recursive: true })
    writeFileSync(registryPath(), '{ this is not json', 'utf8')
    const service = makeService(makeDeps())
    const result = service.listTasks(SID)
    expect(result.entries).toEqual([])
    expect(result.corrupted).toBe(true)
    expect(existsSync(`${registryPath()}.corrupt`)).toBe(true)
    expect(existsSync(registryPath())).toBe(false)
  })

  it('kill 在损坏空表上拒绝为 already-exited，不 throw', async () => {
    mkdirSync(join(agentDir, 'base-tool-enhance', SID), { recursive: true })
    writeFileSync(registryPath(), 'broken', 'utf8')
    const deps = makeDeps()
    const service = makeService(deps)
    const result = await service.killTask(SID, TASK_ID)
    expect(result).toEqual({ killed: false, reason: 'already-exited' })
    expect(deps.killProcessTree).not.toHaveBeenCalled()
  })
})

// ── D6 kill 五分支矩阵 ────────────────────────────────────────────

describe('D6: kill 分支矩阵', () => {
  it('① 活跃+pid 活+身份过+属主活：锁内预写 killing（仅 state 无 reason）→ 信号 → killed + 自写自检广播', async () => {
    writeRegistry([makeEntry()])
    const deps = makeDeps() // pid/owner 均活；probe 缺省恒过（降级档）
    const onTasksChanged = vi.fn()
    const service = makeService(deps, onTasksChanged)
    service.markWatched(SID)
    onTasksChanged.mockClear()

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: true, reason: 'killed' })
    const entry = readRawEntries()[0]
    expect(entry.state).toBe('killing')
    expect(Object.hasOwn(entry, 'reason')).toBe(false) // 契约：reason 仅 exited 语义
    expect(deps.killProcessTree).toHaveBeenCalledTimes(1)
    expect(deps.killProcessTree).toHaveBeenCalledWith(TASK_PID)
    expect(onTasksChanged).toHaveBeenCalledTimes(1) // service 自写自检即时广播
  })

  it('② 活跃+pid 活+身份过+属主死：信号 → 锁内写 orphaned（无 reason）→ killed', async () => {
    writeRegistry([makeEntry()])
    const deps = makeDeps({ isPidAlive: vi.fn((pid: number) => pid === TASK_PID) }) // owner 死
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: true, reason: 'killed' })
    const entry = readRawEntries()[0]
    expect(entry.state).toBe('orphaned')
    expect(entry.endedAt).toBeTypeOf('number')
    expect(entry.durationMs).toBeTypeOf('number')
    expect(Object.hasOwn(entry, 'reason')).toBe(false) // orphaned 不写 reason（枚举外成因）
    expect(deps.killProcessTree).toHaveBeenCalledTimes(1)
  })

  it('③a 活跃+pid 死+属主活：不发信号，写 exited/natural/exitCode null 过渡终态 → already-exited', async () => {
    writeRegistry([makeEntry()])
    const deps = makeDeps({ isPidAlive: vi.fn((pid: number) => pid === OWNER_PID) }) // 任务 pid 死、owner 活
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'already-exited' })
    expect(deps.killProcessTree).not.toHaveBeenCalled()
    expect(deps.probeProcessStartTimeMs).not.toHaveBeenCalled() // 判活先于身份验证
    const entry = readRawEntries()[0]
    expect(entry.state).toBe('exited')
    expect(entry.reason).toBe('natural')
    expect(entry.exitCode).toBeNull()
    expect(entry.durationMs).toBeTypeOf('number')
  })

  it('③b 活跃+pid 死+属主死：不发信号，写 orphaned（对齐 reaper 分支③）', async () => {
    writeRegistry([makeEntry()])
    const deps = makeDeps({ isPidAlive: vi.fn(() => false) })
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'already-exited' })
    const entry = readRawEntries()[0]
    expect(entry.state).toBe('orphaned')
    expect(Object.hasOwn(entry, 'reason')).toBe(false)
  })

  it('③ 锁内重读 poller 竞争已终态：不覆盖新鲜 exitCode（判活重查置于锁内重读之后）', async () => {
    writeRegistry([makeEntry()])
    // 锁外判活调用时同步模拟 poller 抢先写权威终态，再返回 pid 已死
    const deps = makeDeps({
      isPidAlive: vi.fn((pid: number) => {
        if (pid === TASK_PID) {
          writeRegistry([makeEntry({ state: 'exited', reason: 'natural', exitCode: 5, endedAt: STARTED_AT + 99, durationMs: 99, tailSummary: 'fresh' })])
          return false
        }
        return true
      }),
    })
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'already-exited' })
    const entry = readRawEntries()[0]
    expect(entry.state).toBe('exited')
    expect(entry.exitCode).toBe(5) // runtime 过渡写未发生，poller 权威值保留
    expect(entry.tailSummary).toBe('fresh')
  })

  it('③ 锁内判活重查死而复生：拒绝（identity-unverifiable）且条目未被改写', async () => {
    writeRegistry([makeEntry()])
    let taskPidProbe = 0
    const deps = makeDeps({
      isPidAlive: vi.fn((pid: number) => {
        if (pid !== TASK_PID) return true
        taskPidProbe++
        return taskPidProbe <= 1 ? false : true // 锁外判死、锁内重查复活
      }),
    })
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'identity-unverifiable' })
    expect(readRawEntries()[0].state).toBe('running') // 未写终态（宁不杀勿误杀）
  })

  it('④ 身份探测不可得：identity-unverifiable，无信号无写', async () => {
    writeRegistry([makeEntry()])
    const deps = makeDeps({ probeProcessStartTimeMs: vi.fn(async () => undefined) })
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'identity-unverifiable' })
    expect(deps.killProcessTree).not.toHaveBeenCalled()
    expect(readRawEntries()[0].state).toBe('running')
  })

  it('⑤a 分支① intent 预写失败：不发信号，registry-write-failed，条目停留 running', async () => {
    writeRegistry([makeEntry()])
    failTmpWrites()
    const deps = makeDeps()
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'registry-write-failed' })
    expect(deps.killProcessTree).not.toHaveBeenCalled() // 未发信号则不杀
    expect(readRawEntries()[0].state).toBe('running')
  })

  it('⑤b 分支② orphaned 终态写失败：信号已发，registry-write-failed，条目停留原状态（启动 reaper 兜底）', async () => {
    writeRegistry([makeEntry()])
    failTmpWrites()
    const deps = makeDeps({ isPidAlive: vi.fn((pid: number) => pid === TASK_PID) }) // owner 死
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'registry-write-failed' })
    expect(deps.killProcessTree).toHaveBeenCalledTimes(1) // 信号已发（②既有路径收尾）
    expect(readRawEntries()[0].state).toBe('running')
  })

  it('条目已终态 / taskId 不存在：already-exited 幂等，无信号', async () => {
    writeRegistry([makeEntry({ state: 'exited', reason: 'natural', exitCode: 0 })])
    const deps = makeDeps()
    const service = makeService(deps)
    expect(await service.killTask(SID, TASK_ID)).toEqual({ killed: false, reason: 'already-exited' })
    expect(await service.killTask(SID, 'bt-never-existed')).toEqual({ killed: false, reason: 'already-exited' })
    expect(deps.killProcessTree).not.toHaveBeenCalled()
    expect(deps.probeProcessStartTimeMs).not.toHaveBeenCalled()
  })
})

// ── D6⑤ 补遗族：锁获取失败 catch ×2 + ③收尾写失败 catch ×2 ────────
// 与 ⑤a/⑤b 合计覆盖 D6 全部四个写路径 catch 点（⑤a=①预写、⑤b=②终态、本组=锁×2+③×2）。

describe('D6⑤ 补遗：锁获取失败与 ③ 收尾写失败（registry-write-failed 中止语义）', () => {
  it('⑤c ①路径锁获取失败（ELOCKED 预算耗尽）：不发信号，条目停留 running', async () => {
    writeRegistry([makeEntry()])
    failFileLock()
    const deps = makeDeps() // pid/owner 均活 + 身份过 → 进入主路径取锁即抛
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'registry-write-failed' })
    expect(fileLockMock.withFileLockSync).toHaveBeenCalledTimes(1) // 抛点确在锁获取处
    expect(deps.killProcessTree).not.toHaveBeenCalled() // 未发信号则不杀
    expect(readRawEntries()[0].state).toBe('running')
  })

  it('⑤d ③路径锁获取失败（finalizeDeadEntry 外层 catch）：不发信号，条目停留 running', async () => {
    writeRegistry([makeEntry()])
    failFileLock()
    const deps = makeDeps({ isPidAlive: vi.fn(() => false) }) // 锁外判活即死 → 分支③收尾取锁即抛
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'registry-write-failed' })
    expect(deps.probeProcessStartTimeMs).not.toHaveBeenCalled() // 判活先于身份验证
    expect(deps.killProcessTree).not.toHaveBeenCalled()
    expect(readRawEntries()[0].state).toBe('running')
  })

  it('⑤e ③锁内重查死收尾写失败（pid 锁外活/锁内死 + 过渡终态写 EACCES）：不发信号，条目停留 running', async () => {
    writeRegistry([makeEntry()])
    failTmpWrites()
    let taskPidProbe = 0
    const deps = makeDeps({
      isPidAlive: vi.fn((pid: number) => {
        if (pid !== TASK_PID) return true // owner 活 → 锁内走过渡终态写
        taskPidProbe++
        return taskPidProbe <= 1 // 锁外初判活、锁内重查死 → 锁内③收尾
      }),
    })
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'registry-write-failed' })
    expect(deps.killProcessTree).not.toHaveBeenCalled()
    expect(readRawEntries()[0].state).toBe('running') // 写失败不覆盖原状态
  })

  it('⑤f finalizeDeadEntry 锁内终态写失败（③a pid 死属主活 + 过渡终态写 EACCES）：条目停留 running', async () => {
    writeRegistry([makeEntry()])
    failTmpWrites()
    const deps = makeDeps({ isPidAlive: vi.fn((pid: number) => pid === OWNER_PID) }) // 任务 pid 死、owner 活
    const service = makeService(deps)

    const result = await service.killTask(SID, TASK_ID)

    expect(result).toEqual({ killed: false, reason: 'registry-write-failed' })
    expect(deps.killProcessTree).not.toHaveBeenCalled()
    expect(readRawEntries()[0].state).toBe('running')
  })
})

// ── D6 身份验证两档 ───────────────────────────────────────────────

describe('D6: 身份验证两档', () => {
  it('档① pidStartTime 严格比对：匹配走 kill；不匹配 = pid 复用 → 不误杀（pid 上有活进程则拒绝，可重试）', async () => {
    writeRegistry([makeEntry({ pidStartTime: 1_700_000_000 })]) // epoch 秒
    const okDeps = makeDeps({ probeProcessStartTimeMs: vi.fn(async () => 1_700_000_000_400) }) // floor → 同秒
    const okService = makeService(okDeps)
    expect(await okService.killTask(SID, TASK_ID)).toEqual({ killed: true, reason: 'killed' })

    // 重置 running，探测到更晚 start time → mismatch = pid 复用：原任务进程已死，但 pid 上
    // 是无辜新进程（判活为真）→ 锁内判活重查拒绝（宁不杀勿误杀）→ 不发信号不写终态
    writeRegistry([makeEntry({ pidStartTime: 1_700_000_000 })])
    const mismatchDeps = makeDeps({ probeProcessStartTimeMs: vi.fn(async () => 1_700_000_500_000) })
    const mismatchService = makeService(mismatchDeps)
    expect(await mismatchService.killTask(SID, TASK_ID)).toEqual({ killed: false, reason: 'identity-unverifiable' })
    expect(mismatchDeps.killProcessTree).not.toHaveBeenCalled()
    expect(readRawEntries()[0].state).toBe('running')

    // 复用 pid 上的新进程也已死（判活为假）→ 原任务确已死 → ③ 收尾 already-exited
    writeRegistry([makeEntry({ pidStartTime: 1_700_000_000 })])
    const reusedDeadDeps = makeDeps({
      probeProcessStartTimeMs: vi.fn(async () => 1_700_000_500_000),
      isPidAlive: vi.fn(() => false),
    })
    expect(await makeService(reusedDeadDeps).killTask(SID, TASK_ID)).toEqual({ killed: false, reason: 'already-exited' })
    expect(reusedDeadDeps.killProcessTree).not.toHaveBeenCalled()
    expect(readRawEntries()[0].state).toBe('orphaned') // owner 也死 → 对齐 reaper 分支③
  })

  it('档② pidStartTime 缺省：startedAt 降级比对（探测 ≤ 登记时刻为真，晚于为复用且拒绝误杀）', async () => {
    writeRegistry([makeEntry()]) // 无 pidStartTime；probe 缺省返回 STARTED_AT → 恒过
    const okDeps = makeDeps({ probeProcessStartTimeMs: vi.fn(async () => STARTED_AT - 50) })
    expect(await makeService(okDeps).killTask(SID, TASK_ID)).toEqual({ killed: true, reason: 'killed' })

    writeRegistry([makeEntry()])
    const mismatchDeps = makeDeps({ probeProcessStartTimeMs: vi.fn(async () => STARTED_AT + 60_000) })
    const mismatchService = makeService(mismatchDeps)
    // mismatch + pid 上仍是活进程（缺省 mock pid/owner 均活）→ 锁内判活重查拒绝，不误杀
    expect(await mismatchService.killTask(SID, TASK_ID)).toEqual({ killed: false, reason: 'identity-unverifiable' })
    expect(mismatchDeps.killProcessTree).not.toHaveBeenCalled()
    expect(readRawEntries()[0].state).toBe('running')
  })
})

// ── D7 output tail ────────────────────────────────────────────────

describe('D7: getOutputTail', () => {
  it('按条目 outputFile 读尾部；条目/文件缺失 → undefined（lost 语义）', () => {
    const logPath = join(agentDir, 'bt.log')
    writeFileSync(logPath, 'hello tail', 'utf8')
    writeRegistry([makeEntry({ outputFile: logPath })])
    const service = makeService(makeDeps())
    expect(service.getOutputTail(SID, TASK_ID)).toEqual({ text: 'hello tail', truncated: false })
    expect(service.getOutputTail(SID, 'bt-missing')).toBeUndefined()
    expect(service.getOutputTail(SID, TASK_ID)).toBeDefined()
    // 文件被清理
    rmSync(logPath)
    expect(service.getOutputTail(SID, TASK_ID)).toBeUndefined()
  })
})
