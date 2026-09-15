/**
 * RuntimeSupervisor 崩溃自动重启回归测试（Gate B 观测②修复）。
 *
 * 背景（2026-08 Gate B AC-3b 实测）：kill -9 runtime 后 respawn 耗时 68-91s。
 * 日志时间线定位根因：exit 137 后紧跟 "during graceful stop — no restart"——
 * start() 内部 `await this.stop()`（清旧进程）markStopping 后，成功路径从不复位，
 * stopping 恒为 true → 运行期崩溃的 exit 全被 onRuntimeExit 误判「主动停止」短路
 * 自动重启，只能等 liveness 探针 30s×3（60-90s）兜底。
 *
 * 修复：start() 成功落定处（recordSuccess 后）复位 stopping。
 * 本测试用 stub 全链（spawn/stop/health/port/liveness）钉住该编排行为。
 *
 * 运行：cd apps/electron/main && npx vitest run test/runtime-supervisor-crash-restart.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock 必须在 import 之前（vitest hoist）
vi.mock('electron', () => {
  const getAllWindows = vi.fn(() => [])
  return {
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows }),
    app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
  }
})

vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(async () => 43110),
  getPortOffset: vi.fn(() => 0),
}))

// spawnRuntimeProcess：返回恒活 fake child；onExit 回调经 mock.calls 捕获供测试触发
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

// LivenessMonitor stub：真实类会 setInterval(30s)，fake timers 推进时会误触探针路径。
// LIVENESS_FAIL_THRESHOLD 是决策日志 reason 引用的真实常量，需随 mock 导出。
vi.mock('../supervisor/liveness-probe.js', () => ({
  LIVENESS_FAIL_THRESHOLD: 3,
  LivenessMonitor: class {
    start(): void {}
    stop(): void {}
  },
}))

import { RuntimeSupervisor } from '../supervisor/runtime-supervisor.js'
import { spawnRuntimeProcess } from '../supervisor/process-control.js'

// 杀链决策日志断言面（crash-resilience D6-⑥ 第三处「supervisor 重启决策」）：
// mock main-logger 捕获 supervisor 写出的结构化决策行（真实现经 initMainLogger 落盘
// main-<date>.log；本测试只断言字段化决策行为，不触文件 IO）。
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

const spawnMock = vi.mocked(spawnRuntimeProcess)

/** 取最近一条指定 action 的决策日志 meta（无则抛错，附已记录的全部行便于定位）。 */
function decisionMeta(action: string): Record<string, unknown> {
  const all = [...mainLoggerMocks.info.mock.calls, ...mainLoggerMocks.warn.mock.calls]
  const hit = all.find((c) => (c[1] as Record<string, unknown>)?.action === action)
  if (!hit) {
    throw new Error(`no decision log for action=${action}; logged: ${JSON.stringify(all)}`)
  }
  return hit[1] as Record<string, unknown>
}

/** 取第 n 次 spawn 时传入的 onExit 回调（模拟子进程退出事件） */
function onExitOf(callIndex: number): (code: number | null) => void {
  const call = spawnMock.mock.calls[callIndex]
  if (!call?.[1]) throw new Error(`spawn call ${callIndex} has no onExit callback`)
  return call[1]
}

describe('RuntimeSupervisor 崩溃自动重启（stopping 残留修复）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() 成功后 stopping 复位为 false（此前残留 true 致崩溃重启被短路）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    // 修复前：start() 内部 stop() 的 markStopping 残留 → stopping=true
    expect((sup as unknown as { policy: { stopping: boolean } }).policy.stopping).toBe(false)
  })

  it('运行期崩溃（kill -9 → exit 137）→ 退避 1s 后自动重启（不依赖 liveness 兜底）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    // 模拟 kill -9：子进程退出码 137
    onExitOf(0)(137)

    // 修复前：stopping=true 短路 → 无 restartTimer，60s 后仍只有 1 次 spawn（liveness
    // 被本测试 stub，兜底路径不可达）——本断言即回归钉
    await vi.advanceTimersByTimeAsync(1_000)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('主动 stop() 后 exit 不触发自动重启（既有语义不回归）', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    const exit = onExitOf(0)
    await sup.stop()

    vi.useFakeTimers()
    exit(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})

describe('杀链决策日志（crash-resilience D6-⑥：谁触发/杀谁/为什么，u5b 同形态）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('process_exit：重启决策行含 action/trigger/attempt/delayMs/target.pid/exitCode/reason', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()

    vi.useFakeTimers()
    onExitOf(0)(137)
    const meta = decisionMeta('supervisor_restart')
    expect(meta.action).toBe('supervisor_restart')
    expect(meta.trigger).toBe('process_exit')
    expect(meta.attempt).toBe(1)
    expect(meta.delayMs).toBe(1_000)
    expect(meta.target).toEqual({ pid: 12345 })
    expect(meta.exitCode).toBe(137)
    expect(String(meta.reason)).toContain('backoff')
  })

  it('liveness 判死：kill decision（force_kill_halfalive）+ restart decision（liveness trigger）双行', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()

    vi.useFakeTimers()
    await sup.forceRestartForLiveness()
    await vi.advanceTimersByTimeAsync(1_000)

    const kill = decisionMeta('supervisor_force_kill_halfalive')
    expect(kill.trigger).toBe('liveness_unhealthy')
    expect(kill.target).toEqual({ pid: 12345 })
    expect(String(kill.reason)).toContain('liveness')
    const restart = decisionMeta('supervisor_restart')
    expect(restart.trigger).toBe('liveness_unhealthy')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('重启用尽：abandon 决策行（attempts=MAX_RESTARTS，reason 指向手动重试）', async () => {
    // 构造约束（策略语义决定，不能固定 16s/轮）：每轮重启成功即 recordSuccess，
    // 成功间隔 >STABLE_MS(10s) 会清零计数（16s 退避本身超过稳定窗口）——按真实
    // delay 序列（1/2/4/8s，累计 <10s 不清零）推进 4 轮把计数推到 4，第 5 轮
    // 让 start 失败（waitForHealth reject → handleRestartFailure，不经 recordSuccess）
    // 使计数触顶 5 → abandon 分支。
    const { waitForHealth } = await import('../supervisor/health-checker.js')
    // 精确让 attempt5 的 waitForHealth 失败：计数含初始 start（第 1 次）+ attempt1..4
    // （第 2-5 次），第 6 次调用 = attempt5。计数基准从 start 前开始（Once 队列会被
    // attempt1 消费，无法精确定位第 6 次）。
    let healthCalls = 0
    vi.mocked(waitForHealth).mockImplementation(async () => {
      healthCalls++
      if (healthCalls === 6) throw new Error('health timeout')
    })
    const sup = new RuntimeSupervisor()
    await sup.start()

    vi.useFakeTimers()
    const roundDelays = [1_000, 2_000, 4_000, 8_000]
    for (let i = 0; i < roundDelays.length; i++) {
      onExitOf(i)(137)
      await vi.advanceTimersByTimeAsync(roundDelays[i])
    }
    // 第 5 次 exit：attempt5 delay 16s → start 失败 → restart_failure 递归 → 耗尽 abandon
    onExitOf(4)(137)
    await vi.advanceTimersByTimeAsync(16_000)
    const abandon = decisionMeta('supervisor_restart_abandon')
    expect(abandon.trigger).toBe('restart_failure')
    expect(abandon.attempts).toBe(5)
    expect(String(abandon.reason)).toContain('manual retry')
  })
})
