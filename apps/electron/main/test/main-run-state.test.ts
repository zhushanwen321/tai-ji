/**
 * main 侧 run 目录运行态测试（crash-forensics-and-watchdog D1 marker 行 / D3 checkpoint
 * 五契约，实施单元 u4）。
 *
 * 覆盖（验收条款逐条对照）：
 * - **marker 生命周期**：启动写（单实例锁判定后、旧残留消费之后）/ normal 清（will-quit）
 *   / 下次启动发现残留 → 补记 `layer=main, event=crash, reason=unclean-exit` + 清除残留
 *   （一次性消费）；marker 清除与 checkpoint 删除**解耦**（killed 短路形态 marker 仍须清，
 *   否则下次启动误判 unclean 违反 A3b）。
 * - **删除属主时序**：before-quit 专属 await 链成功段删除（stop() resolve 且 child 在场）；
 *   killed 短路（非 darwin window-all-closed 先发起 stop → 第二次 stop 立即 resolve）跳过；
 *   stop() reject 跳过——两者残留交下次启动「clean exit 但残留」分支隔离兜底。
 * - **可信度判定真值表**：unclean → 可信（留给新 runtime 的 reattach 编排）；clean exit +
 *   残留 → 忽略 + 隔离（rename 进失败现场家族，保留 3 份）+ 记 reattach-skipped（进程内
 *   一次）；无残留 → no-checkpoint。
 *
 * 装置说明：main.ts 顶层副作用重（import electron + 子系统初始化 + 单实例锁），本测试
 * 以最小 mock 集（electron / 重启动子系统 / 运行态依赖）import 真实 main.ts——**被测的是
 * main.ts 的真源**（导出函数 + 真注册的 before-quit/will-quit 处理器），不是重写的副本。
 * 每个用例前 `vi.resetModules()` 重导入（before-quit 的 isQuitting 是一次性模块级 flag，
 * 重导入让每条退出链各自独立）。写删目标全部 = main 池 globalSetup 注入的 tmp 数据目录下
 * 的 run/（fs 白名单内，禁触真实数据目录）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/main-run-state.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'

// ── electron mock（app 事件处理器捕获：before-quit / will-quit / window-all-closed 直调）──
const appMock = vi.hoisted(() => {
  const handlers = new Map<string, (event?: unknown) => void>()
  return {
    handlers,
    isPackaged: true,
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn((event: string, handler: (event?: unknown) => void) => {
      handlers.set(event, handler)
    }),
    whenReady: vi.fn(() => new Promise(() => { /* whenReady 永挂起：聚焦模块级启动序列 */ })),
    getAppPath: vi.fn(() => tmpdir()),
    getPath: vi.fn(() => tmpdir()),
    setPath: vi.fn(),
    dock: { setIcon: vi.fn(), setBadge: vi.fn() },
  }
})

vi.mock('electron', () => ({
  app: appMock,
  protocol: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []) }),
}))

/** runtime supervisor 可控桩：isRunning / stop 行为逐用例注入。 */
const runtimeMock = vi.hoisted(() => ({
  isRunning: true,
  stopImpl: undefined as undefined | (() => Promise<void>),
  stopCalls: 0,
  markAppQuittingCalls: 0,
}))

vi.mock('../supervisor/runtime-supervisor.js', () => ({
  RuntimeSupervisor: class {
    get isRunning(): boolean { return runtimeMock.isRunning }
    markAppQuitting(): void { runtimeMock.markAppQuittingCalls++ }
    stop(): Promise<void> {
      runtimeMock.stopCalls++
      return runtimeMock.stopImpl ? runtimeMock.stopImpl() : Promise.resolve()
    }
    startAndNotify(): Promise<number> { return Promise.resolve(0) }
  },
}))

/** 台账 writer 桩：捕获 append 调用（真 writer 的落盘行为由 logs/__tests__ 覆盖）。 */
const journalMock = vi.hoisted(() => ({ events: [] as CrashJournalEvent[] }))
vi.mock('../logs/crash-journal.js', () => ({
  initCrashJournal: vi.fn(),
  crashJournal: { append: (e: CrashJournalEvent) => { journalMock.events.push(e) } },
  CrashJournalFileWriter: class {},
}))

// 数据目录恒等桩：electron mock 的 isPackaged=true 会让 main.ts 打包分支执行
// resolvePackagedDataDir 并把 TAIJI_AGENT_DATA_DIR 钉回 ~/.taiji——globalSetup 钉的
// tmp 目录被改写后，run-state 产物全部落进真实 prod 数据目录。本文件被测对象是
// run-state marker/checkpoint 设施，数据目录钉死契约由 packaged-data-dir.test.ts
// （行为矩阵）与 main-dev-datadir-pin.test.ts（接线钉）守护，此处恒等透传 env 值。
vi.mock('../utils/packaged-data-dir.js', () => ({
  resolvePackagedDataDir: (env: NodeJS.ProcessEnv) => env.TAIJI_AGENT_DATA_DIR ?? '',
}))

vi.mock('../logs/main-logger.js', () => ({
  initMainLogger: vi.fn(),
  closeMainLogger: vi.fn(async () => undefined),
  mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  readMainLogMaxBytes: vi.fn(() => 0),
}))

const shortcutsMock = vi.hoisted(() => ({ unregisterAll: vi.fn() }))
vi.mock('../shortcuts/shortcut-registry.js', () => ({
  ShortcutRegistry: class { unregisterAll = shortcutsMock.unregisterAll },
}))

vi.mock('../supervisor/shell-env.js', () => ({ fixPathEnv: vi.fn() }))
vi.mock('../supervisor/process-control.js', () => ({
  flushStderrSink: vi.fn(async () => undefined),
  spawnRuntimeProcess: vi.fn(),
  stopRuntimeProcess: vi.fn(async () => undefined),
}))
vi.mock('../gateway/ipc-handlers.js', () => ({ registerIpcHandlers: vi.fn() }))
vi.mock('../diagnostics/trigger-patrol.js', () => ({ startTriggerPatrol: vi.fn() }))

// ── tmp 运行目录（main 池 globalSetup 已把 TAIJI_AGENT_DATA_DIR 指向 tmp）──────────

const runDir = join(getDataDir(), 'run')
const markerPath = join(runDir, 'main-running.marker')
const checkpointPath = join(runDir, 'runtime-checkpoint.json')
const FAILED_PREFIX = 'runtime-checkpoint-failed-'

/** 本文件 import 真 main.ts 的最后一个模块实例（导出函数消费面）。 */
type MainModule = typeof import('../main.js')

async function importMain(): Promise<MainModule> {
  appMock.handlers.clear()
  vi.resetModules()
  return await import('../main.js')
}

/** 清 run 目录全部产物（用例隔离；写删目标 = tmp 数据目录内的 run/）。 */
function resetRunDir(): void {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

function listFailedSnapshots(): string[] {
  if (!existsSync(runDir)) return []
  return readdirSync(runDir).filter((n) => n.startsWith(FAILED_PREFIX)).sort()
}

/** 在 run 目录预置文件（模拟上次运行的残留产物；目录不存在时按需建）。 */
function seedFile(file: string, content: string): void {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(file, content, 'utf8')
}

/**
 * 每次 `vi.resetModules()` 重导入都会重跑 main.ts 的进程级兜底注册
 * （unhandledRejection / uncaughtException / stdout·stderr EPIPE）——生产只导入一次，
 * 测试内会累积到 MaxListeners 噪音。此处记录基线计数并逐用例收敛回基线。
 */
interface ProcessListenerBaseline {
  rejection: number
  exception: number
  stdoutError: number
  stderrError: number
}

let baseline: ProcessListenerBaseline = { rejection: 0, exception: 0, stdoutError: 0, stderrError: 0 }

function snapshotListenerBaseline(): ProcessListenerBaseline {
  return {
    rejection: process.listenerCount('unhandledRejection'),
    exception: process.listenerCount('uncaughtException'),
    stdoutError: process.stdout.listenerCount('error'),
    stderrError: process.stderr.listenerCount('error'),
  }
}

/** 摘掉超出基线的监听器（从尾部摘，保留 vitest 自身的）。 */
function restoreListenerBaseline(): void {
  const trim = (emitter: NodeJS.EventEmitter, event: string, keep: number): void => {
    while (emitter.listenerCount(event) > keep) {
      const last = emitter.listeners(event).at(-1)
      if (!last) break
      emitter.removeListener(event, last as never)
    }
  }
  trim(process, 'unhandledRejection', baseline.rejection)
  trim(process, 'uncaughtException', baseline.exception)
  trim(process.stdout, 'error', baseline.stdoutError)
  trim(process.stderr, 'error', baseline.stderrError)
}

beforeEach(() => {
  journalMock.events.length = 0
  runtimeMock.isRunning = true
  runtimeMock.stopImpl = undefined
  runtimeMock.stopCalls = 0
  runtimeMock.markAppQuittingCalls = 0
  appMock.quit.mockClear()
  appMock.requestSingleInstanceLock.mockReturnValue(true)
  baseline = snapshotListenerBaseline()
  resetRunDir()
})

afterEach(() => {
  resetRunDir()
  restoreListenerBaseline()
})

afterAll(() => {
  // 释放 last import 的模块实例持有的 run 目录（无长驻句柄，仅清理卫生）
  resetRunDir()
})

// ── marker 生命周期 ──────────────────────────────────────────────

describe('marker 生命周期（D1 main 自身 crash 行）', () => {
  it('启动写：模块加载后 marker 在场且记录本实例 pid（旧残留消费之后写）', async () => {
    const main = await importMain()
    const paths = main.resolveRunStatePaths()

    expect(existsSync(paths.markerPath)).toBe(true)
    expect(readFileSync(paths.markerPath, 'utf8').split('\n')[0]).toBe(String(process.pid))
    expect(journalMock.events).toEqual([]) // 首启无残留：零台账行
  })

  it('正常清（will-quit）：marker 删除', async () => {
    const main = await importMain()
    expect(existsSync(markerPath)).toBe(true)

    appMock.handlers.get('will-quit')?.()

    expect(existsSync(markerPath)).toBe(false)
    expect(main.resolveRunStatePaths().markerPath).toBe(markerPath)
  })

  it('残留消费：下次启动补记 crash/unclean-exit + 清除残留（一次性）', async () => {
    seedFile(markerPath, '999999\n2026-01-01T00:00:00.000Z\n')

    const main = await importMain()

    expect(journalMock.events).toHaveLength(1)
    expect(journalMock.events[0]).toMatchObject({ layer: 'main', event: 'crash', reason: 'unclean-exit' })
    // 残留被消费并改写为本实例（不是删除后不写：下次崩溃仍要能判 unclean）
    expect(readFileSync(markerPath, 'utf8').split('\n')[0]).toBe(String(process.pid))
    expect(main.resolveRunStatePaths().markerPath).toBe(markerPath)
  })

  it('unclean 时 checkpoint 判可信：不隔离、不记 reattach-skipped（留给新 runtime reattach）', async () => {
    seedFile(markerPath, '999999\n')
    seedFile(checkpointPath, JSON.stringify({ version: 1, sessions: [{ piSessionId: 's1' }] }))

    await importMain()

    expect(existsSync(checkpointPath)).toBe(true)
    expect(listFailedSnapshots()).toEqual([])
    expect(journalMock.events.map((e) => e.event)).toEqual(['crash'])
  })
})

// ── 可信度判定真值表 + 残留隔离 ───────────────────────────────────

describe('checkpoint 冷启动可信度 + 残留隔离（D3）', () => {
  it('真值表：无残留 → no-checkpoint；unclean → trusted-unclean；clean+残留 → stale-residual', async () => {
    const main = await importMain()
    const { resolveColdStartTrust } = main

    expect(resolveColdStartTrust({ unclean: false, checkpointExists: false })).toBe('no-checkpoint')
    expect(resolveColdStartTrust({ unclean: true, checkpointExists: false })).toBe('no-checkpoint')
    expect(resolveColdStartTrust({ unclean: true, checkpointExists: true })).toBe('trusted-unclean')
    expect(resolveColdStartTrust({ unclean: false, checkpointExists: true })).toBe('stale-residual')
  })

  it('clean exit + 残留：启动即隔离（rename 进失败现场家族）+ 记 reattach-skipped', async () => {
    seedFile(checkpointPath, '{"version":1,"sessions":[]}')

    await importMain()

    expect(existsSync(checkpointPath)).toBe(false)
    expect(listFailedSnapshots()).toHaveLength(1)
    const rows = journalMock.events.filter((e) => e.event === 'reattach-skipped')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ layer: 'main', reason: 'stale-checkpoint-after-clean-exit' })
  })

  it('隔离失败现场保留最近 3 份（新失败覆盖最旧）', async () => {
    const main = await importMain()
    const paths = main.resolveRunStatePaths()
    const journal = { append: (e: CrashJournalEvent) => { journalMock.events.push(e) } }

    for (let i = 0; i < 4; i++) {
      seedFile(checkpointPath, 'stale')
      expect(main.isolateStaleCheckpoint(paths, journal, 1_700_000_000_000 + i * 1000)).toBe('isolated')
    }

    const snapshots = listFailedSnapshots()
    expect(snapshots).toHaveLength(3)
    expect(snapshots[0]).toContain('2023-11-14T22-13-21-000Z') // 最旧（T0）已覆盖
    expect(snapshots.at(-1)).toContain('2023-11-14T22-13-23-000Z')
  })

  it('隔离 rename 幂等：ENOENT = already-absent（视为已隔离，不抛）', async () => {
    const main = await importMain()
    const paths = main.resolveRunStatePaths()
    const journal = { append: (e: CrashJournalEvent) => { journalMock.events.push(e) } }

    expect(main.isolateStaleCheckpoint(paths, journal)).toBe('already-absent')
    expect(listFailedSnapshots()).toEqual([])
  })

  it('删除属主入口：removeRuntimeCheckpoint 删除成功返回 true，不存在返回 false', async () => {
    const main = await importMain()
    const paths = main.resolveRunStatePaths()

    writeFileSync(checkpointPath, '{}', 'utf8')
    expect(main.removeRuntimeCheckpoint(paths)).toBe(true)
    expect(existsSync(checkpointPath)).toBe(false)
    expect(main.removeRuntimeCheckpoint(paths)).toBe(false)
  })
})

// ── 删除属主时序（before-quit 成功段 / killed 短路）─────────────────

describe('checkpoint 删除属主时序（D3 删除实现语义钉死）', () => {
  it('成功段：stop() resolve 且 child 在场 → 删除 checkpoint', async () => {
    await importMain()
    writeFileSync(checkpointPath, '{}', 'utf8')
    const event = { preventDefault: vi.fn() }

    appMock.handlers.get('before-quit')?.(event)

    await vi.waitFor(() => expect(existsSync(checkpointPath)).toBe(false))
    expect(event.preventDefault).toHaveBeenCalled() // 二段式：先拦住 quit，异步清理后再 quit
    expect(runtimeMock.stopCalls).toBe(1)
    expect(runtimeMock.markAppQuittingCalls).toBe(1)
    expect(appMock.quit).toHaveBeenCalled()
  })

  it('killed 短路：非 darwin window-all-closed 已发起 stop → 跳过删除（残留交下次启动隔离）', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      await importMain()
      writeFileSync(checkpointPath, '{}', 'utf8')

      appMock.handlers.get('window-all-closed')?.()
      appMock.handlers.get('before-quit')?.({ preventDefault: vi.fn() })

      // stop() 被调两次（window-all-closed + before-quit），但删除属主已放弃
      await vi.waitFor(() => expect(runtimeMock.stopCalls).toBe(2))
      expect(existsSync(checkpointPath)).toBe(true)
      // marker 清除与删除解耦：删除跳过但 marker 仍清（否则下次误判 unclean 走 eager，违反 A3b）
      appMock.handlers.get('will-quit')?.()
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('stop() reject：跳过删除（残留由下次启动 clean+残留分支隔离）+ 退出链仍走完', async () => {
    await importMain()
    writeFileSync(checkpointPath, '{}', 'utf8')
    runtimeMock.stopImpl = () => Promise.reject(new Error('stop failed (injected)'))
    // main.ts 的进程级 unhandledRejection 处理器会 console.error 该 reject（既有行为，
    // 「失败要出声」不静默）——测试内静音避免污染输出，断言不受影响
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      appMock.handlers.get('before-quit')?.({ preventDefault: vi.fn() })

      await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalled())
      expect(existsSync(checkpointPath)).toBe(true)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('runtime 不在场（mock 模式 / 已崩死）：不删 checkpoint、不写 shutdown 行', async () => {
    await importMain()
    writeFileSync(checkpointPath, '{}', 'utf8')
    runtimeMock.isRunning = false

    appMock.handlers.get('before-quit')?.({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalled())

    expect(existsSync(checkpointPath)).toBe(true)
    expect(journalMock.events.filter((e) => e.event === 'shutdown')).toEqual([])
  })
})
