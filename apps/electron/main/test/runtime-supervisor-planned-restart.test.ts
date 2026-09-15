/**
 * RuntimeSupervisor planned（86）立即重启分支回归测试（u7c，crash-forensics-and-watchdog
 * §3.3 D5 ④）。
 *
 * 覆盖（A4 验收：86 退出 → restart-policy 记 planned、退避计数不增、立即重启）：
 * - 滚动重启专用退出码 86 → 零退避立即重启（advance 0ms 即触发 start）、crash 计数不增、
 *   决策日志 trigger=planned_rolling_restart / delayMs=0；
 * - 崩溃配额耗尽（exhausted）态下 86 仍照常重启（planned 边不受 shouldRestart 门约束）；
 * - stopping 上下文的 86（app 退出与滚动重启退出的竞态防御）不触发重启（既有 stopping
 *   短路优先，app 退出链不回拉进程）。
 *
 * stub 全链同 runtime-supervisor-crash-restart.test.ts（spawn/stop/health/port/liveness）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/runtime-supervisor-planned-restart.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PLANNED_EXIT_CODE } from '../supervisor/runtime-supervisor.js'
import { MAX_RESTARTS } from '../supervisor/restart-policy.js'

vi.mock('electron', () => {
  const getAllWindows = vi.fn(() => [])
  return {
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows }),
    app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
  }
})

vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(async () => 43111),
  getPortOffset: vi.fn(() => 0),
}))

vi.mock('../supervisor/process-control.js', () => ({
  spawnRuntimeProcess: vi.fn(() => ({
    child: { exitCode: null, pid: 12345, on: vi.fn(), kill: vi.fn() },
    token: 'test-token',
  })),
  stopRuntimeProcess: vi.fn(async () => undefined),
}))

vi.mock('../supervisor/health-checker.js', () => ({
  waitForHealth: vi.fn(async () => undefined),
}))

vi.mock('../supervisor/port-file.js', () => ({
  writePortFile: vi.fn(),
}))

vi.mock('../supervisor/liveness-probe.js', () => ({
  LIVENESS_FAIL_THRESHOLD: 3,
  LivenessMonitor: class {
    start(): void {}
    stop(): void {}
  },
}))

const mainLoggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('../logs/main-logger.js', () => ({
  mainLogger: mainLoggerMocks,
  readMainLogMaxBytes: vi.fn(() => 50 * 1024 * 1024),
  initMainLogger: vi.fn(),
  closeMainLogger: vi.fn(async () => undefined),
  startMemoryWatermarkTimer: vi.fn(() => () => {}),
}))

vi.mock('../logs/crash-journal.js', () => ({
  crashJournal: { append: vi.fn(), init: vi.fn(), close: vi.fn(async () => undefined) },
}))

import { RuntimeSupervisor } from '../supervisor/runtime-supervisor.js'
import { spawnRuntimeProcess } from '../supervisor/process-control.js'

const spawnMock = vi.mocked(spawnRuntimeProcess)

function onExitOf(callIndex: number): (code: number | null) => void {
  const call = spawnMock.mock.calls[callIndex]
  if (!call?.[1]) throw new Error(`spawn call ${callIndex} has no onExit callback`)
  return call[1]
}

function restartDecisionMeta(): Record<string, unknown> {
  const hit = mainLoggerMocks.info.mock.calls.find((c) => (c[1] as Record<string, unknown>)?.action === 'supervisor_restart')
  if (!hit) throw new Error(`no supervisor_restart decision log; logged: ${JSON.stringify(mainLoggerMocks.info.mock.calls)}`)
  return hit[1] as Record<string, unknown>
}

function setRestartCount(sup: RuntimeSupervisor, count: number): void {
  ;(sup as unknown as { policy: { restartCount: number } }).policy.restartCount = count
}

describe('RuntimeSupervisor planned（86）立即重启零退避零计数（A4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('86 退出 → 零退避立即重启，crash 计数不增，决策行 trigger=planned_rolling_restart', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    onExitOf(0)(PLANNED_EXIT_CODE)

    // 零退避：advance 0ms（不推进任何退避窗口）即完成重启
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnMock).toHaveBeenCalledTimes(2)

    const meta = restartDecisionMeta()
    expect(meta.trigger).toBe('planned_rolling_restart')
    expect(meta.delayMs).toBe(0)
    expect(meta.attempt).toBe(0)
    expect(meta.exitCode).toBe(PLANNED_EXIT_CODE)
    expect(String(meta.reason)).toContain('planned rolling-restart')
  })

  it('86 退出不做指数退避等待（对照：crash 路径 1s 起步）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()

    vi.useFakeTimers()
    onExitOf(0)(PLANNED_EXIT_CODE)
    // 未推进任何时间：重启尚未发生（timer 尚未 flush 是 fake timers 语义——advance 0 即触发）
    const before = spawnMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnMock.mock.calls.length).toBe(before + 1)
  })

  it('崩溃配额耗尽（exhausted）后 86 仍照常重启（planned 不受 shouldRestart 门约束）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    setRestartCount(sup, MAX_RESTARTS)

    vi.useFakeTimers()
    onExitOf(0)(PLANNED_EXIT_CODE)
    await vi.advanceTimersByTimeAsync(0)

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect((sup as unknown as { policy: { restartCount: number } }).policy.restartCount).toBe(MAX_RESTARTS)
  })

  it('stopping 上下文的 86 不触发重启（app 退出链优先，不回拉进程）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    const exit = onExitOf(0)
    await sup.stop()

    vi.useFakeTimers()
    exit(PLANNED_EXIT_CODE)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})
