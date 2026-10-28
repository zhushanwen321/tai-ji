// restart-policy.test.ts —— electron-main-test C01 簇合并产物（round5-G）。
// 共同被测业务模块：`supervisor/restart-policy.ts`。mock 相容：单侧 mock ../logs/crash-journal.js、../logs/main-logger.js、../supervisor/health-checker.js、../supervisor/liveness-probe.js、../supervisor/port-discoverer.js、../supervisor/port-file.js——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - test/restart-policy-liveness.test.ts（8 用例，skip 0）
//   - test/restart-policy-planned.test.ts（5 用例，skip 0）
//   - test/restart-policy.test.ts（12 用例，skip 0）
//   - test/runtime-supervisor-planned-restart.test.ts（4 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RestartPolicy, MAX_RESTARTS, RESTART_BASE_DELAY_MS, PLANNED_RESTART_DELAY_MS } from '../supervisor/restart-policy'
import { PLANNED_EXIT_CODE, RuntimeSupervisor } from '../supervisor/runtime-supervisor'
import { spawnRuntimeProcess } from '../supervisor/process-control'

const mainLoggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
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
    runtimeId: 'test-runtime-id',
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

// ======== 来源：restart-policy-liveness.test.ts ========
describe("restart-policy-liveness", () => {
  // 回归基线断言：常量值在 W5 后不得变动（存活探针复用同一套退避/上限）
  describe('W5 回归基线：restart-policy 常量不变', () => {
    it('MAX_RESTARTS=5（存活探针触发的重启也走同一上限）', () => {
      expect(MAX_RESTARTS).toBe(5)
    })

    it('RESTART_BASE_DELAY_MS=1s（退避基数不变）', () => {
      expect(RESTART_BASE_DELAY_MS).toBe(1_000)
    })
  })

  // 回归基线：退避序列 1/2/4/8/16s（W5 存活探针触发 forceRestart 复用此序列）
  describe('W5 回归基线：退避序列 1/2/4/8/16s 不变', () => {
    it('连续 5 次崩溃的退避序列为 [1000,2000,4000,8000,16000] ms', () => {
      const p = new RestartPolicy()
      const delays: number[] = []
      for (let i = 0; i < MAX_RESTARTS; i++) {
        delays.push(p.recordCrashAndGetDelay())
      }
      expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    })

    it('第 6 次崩溃抛错（exhausted，存活探针触发的重启也受此约束）', () => {
      const p = new RestartPolicy()
      for (let i = 0; i < MAX_RESTARTS; i++) p.recordCrashAndGetDelay()
      expect(() => p.recordCrashAndGetDelay()).toThrow(/exhausting/)
    })
  })

  // 回归基线：手动重试配额（W5 后 forceRestart 耗尽时用户仍可通过 clearForManualRestart 重试）
  describe('W5 回归基线：clearForManualRestart 清零后给新 5 次配额', () => {
    it('耗尽后 clearForManualRestart → 计数清零 + 新 5 次配额', () => {
      const p = new RestartPolicy()
      for (let i = 0; i < MAX_RESTARTS; i++) p.recordCrashAndGetDelay()
      expect(p.exhausted).toBe(true)
      expect(p.shouldRestart()).toBe(false)

      // 用户手动重试：清零，重新有 5 次配额
      p.clearForManualRestart()
      expect(p.count).toBe(0)
      expect(p.exhausted).toBe(false)
      expect(p.shouldRestart()).toBe(true)

      // 验证新配额确实是 5 次（退避序列重新从 1s 开始）
      const firstDelay = p.recordCrashAndGetDelay()
      expect(firstDelay).toBe(RESTART_BASE_DELAY_MS)
      expect(p.count).toBe(1)
    })

    it('clearForManualRestart 同时清除 stopping 标志（手动重试是新生命周期）', () => {
      const p = new RestartPolicy()
      // 先制造计数 + stopping 状态（模拟崩溃重启耗尽后用户主动 stop 再手动重试）
      p.recordCrashAndGetDelay()
      p.recordCrashAndGetDelay()
      p.markStopping()
      expect(p.stopping).toBe(true)
      expect(p.count).toBe(2)
      expect(p.shouldRestart()).toBe(false) // stopping 短路

      // 用户手动重试：清零计数 + 清 stopping，重新有 5 次配额
      p.clearForManualRestart()
      expect(p.count).toBe(0)
      expect(p.stopping).toBe(false)
      expect(p.shouldRestart()).toBe(true)

      // 新配额可用：第 1 次退避从 1s 开始
      const firstDelay = p.recordCrashAndGetDelay()
      expect(firstDelay).toBe(RESTART_BASE_DELAY_MS)
    })
  })

  // 回归基线：无时间窗清零（ADR-0122：recordSuccess 只记录事实，计数清零唯一入口 = 用户显式重试）
  describe('recordSuccess 无时间窗清零（ADR-0122）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('连续成功不清零（存活探针恢复也不清零）', () => {
      const p = new RestartPolicy()
      p.recordCrashAndGetDelay()
      p.recordCrashAndGetDelay()
      expect(p.count).toBe(2)

      p.recordSuccess()
      expect(p.count).toBe(2)

      vi.advanceTimersByTime(60_000)
      p.recordSuccess()
      expect(p.count).toBe(2)
    })

    it('计数持续累计直到 MAX 或 clearForManualRestart（用户显式重试是唯一清零入口）', () => {
      const p = new RestartPolicy()
      for (let i = 0; i < 3; i++) p.recordCrashAndGetDelay()
      expect(p.count).toBe(3)

      p.recordSuccess()
      vi.advanceTimersByTime(60_000)
      p.recordSuccess()
      expect(p.count).toBe(3)

      p.clearForManualRestart()
      expect(p.count).toBe(0)

      // 新故障簇：从 1 开始
      p.recordCrashAndGetDelay()
      expect(p.count).toBe(1)
      expect(p.exhausted).toBe(false)
    })
  })
});

// ======== 来源：restart-policy-planned.test.ts ========
describe("restart-policy-planned", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('recordPlanned：planned 边不进 counting 状态机（A4）', () => {
    it('返回 0 延迟且计数不增', () => {
      const policy = new RestartPolicy()
      expect(policy.count).toBe(0)

      expect(policy.recordPlanned()).toBe(PLANNED_RESTART_DELAY_MS)
      expect(PLANNED_RESTART_DELAY_MS).toBe(0)
      expect(policy.count).toBe(0)
      expect(policy.exhausted).toBe(false)
    })

    it('多次 planned 依旧零计数（滚动重启反复发生不消耗崩溃配额）', () => {
      const policy = new RestartPolicy()
      policy.recordPlanned()
      policy.recordPlanned()
      policy.recordPlanned()
      expect(policy.count).toBe(0)
    })

    it('exhausted 态下 planned 仍可用（planned 不受 shouldRestart 门约束）', () => {
      const policy = new RestartPolicy()
      for (let i = 0; i < MAX_RESTARTS; i++) {
        policy.recordCrashAndGetDelay()
      }
      expect(policy.exhausted).toBe(true)
      expect(policy.shouldRestart()).toBe(false)

      // 滚动重启（86）在崩溃配额耗尽下仍须照常重启（计划内路径与 crash 配额正交）
      expect(policy.recordPlanned()).toBe(0)
      expect(policy.count).toBe(MAX_RESTARTS)
    })

    it('planned 不污染 crash 退避序列：其后首次 crash 仍从 1s 基数起', () => {
      const policy = new RestartPolicy()
      policy.recordPlanned()
      expect(policy.recordCrashAndGetDelay()).toBe(RESTART_BASE_DELAY_MS)
      expect(policy.count).toBe(1)
    })

    it('既有 crash 计数下 planned 成功后计数不清零（无时间窗，ADR-0122）', async () => {
      vi.useFakeTimers()
      const policy = new RestartPolicy()
      policy.recordCrashAndGetDelay()
      policy.recordCrashAndGetDelay()
      expect(policy.count).toBe(2)

      policy.recordPlanned() // 滚动重启（不改变计数）
      policy.recordSuccess() // 重启成功（只记录事实，不清零）
      expect(policy.count).toBe(2)
    })
  })
});

// ======== 来源：restart-policy.test.ts ========
describe("restart-policy", () => {
  describe('RestartPolicy.shouldRestart', () => {
    it('初始态应重启（计数 0 < MAX）', () => {
      const p = new RestartPolicy()
      expect(p.shouldRestart()).toBe(true)
      expect(p.count).toBe(0)
      expect(p.exhausted).toBe(false)
    })

    it('stopping 标志短路：markStopping 后永不重启', () => {
      const p = new RestartPolicy()
      p.markStopping()
      expect(p.shouldRestart()).toBe(false)
    })

    it('达到 MAX_RESTARTS 后 exhausted，不再重启', () => {
      const p = new RestartPolicy()
      for (let i = 0; i < MAX_RESTARTS; i++) {
        expect(p.shouldRestart()).toBe(true)
        p.recordCrashAndGetDelay()
      }
      expect(p.exhausted).toBe(true)
      expect(p.shouldRestart()).toBe(false)
    })

    it('reset 清除 stopping 标志（手动重试入口）', () => {
      const p = new RestartPolicy()
      p.markStopping()
      expect(p.shouldRestart()).toBe(false)
      p.reset()
      expect(p.shouldRestart()).toBe(true)
    })
  })

  describe('RestartPolicy.recordCrashAndGetDelay（指数退避）', () => {
    it('退避序列：1s/2s/4s/8s/16s（2^(n-1) * BASE，clamp MAX）', () => {
      const p = new RestartPolicy()
      const delays: number[] = []
      for (let i = 0; i < MAX_RESTARTS; i++) {
        delays.push(p.recordCrashAndGetDelay())
      }
      // 第 1..5 次：1000/2000/4000/8000/16000
      expect(delays).toEqual([
        1 * RESTART_BASE_DELAY_MS,
        2 * RESTART_BASE_DELAY_MS,
        4 * RESTART_BASE_DELAY_MS,
        8 * RESTART_BASE_DELAY_MS,
        16 * RESTART_BASE_DELAY_MS,
      ])
    })

    it('计数耗尽后再调 recordCrashAndGetDelay 抛错（前置 shouldRestart 未检查）', () => {
      const p = new RestartPolicy()
      for (let i = 0; i < MAX_RESTARTS; i++) {
        p.recordCrashAndGetDelay()
      }
      expect(() => p.recordCrashAndGetDelay()).toThrow(/exhausting/)
    })

    it('每次 recordCrash 递增 count', () => {
      const p = new RestartPolicy()
      expect(p.count).toBe(0)
      p.recordCrashAndGetDelay()
      expect(p.count).toBe(1)
      p.recordCrashAndGetDelay()
      expect(p.count).toBe(2)
    })
  })

  describe('RestartPolicy.recordSuccess（无时间窗清零，ADR-0122）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('recordSuccess 不清零计数（无稳定窗，累计只在手动重试时归零）', () => {
      const p = new RestartPolicy()
      p.recordCrashAndGetDelay()
      p.recordCrashAndGetDelay()
      expect(p.count).toBe(2)

      // 无论间隔多久，recordSuccess 只记录事实，不清零
      p.recordSuccess()
      expect(p.count).toBe(2)

      vi.advanceTimersByTime(60_000)
      p.recordSuccess()
      expect(p.count).toBe(2)
    })

    it('崩溃计数持续累计直到 MAX 或用户显式重试（clearForManualRestart 清零）', () => {
      const p = new RestartPolicy()
      for (let i = 0; i < 3; i++) p.recordCrashAndGetDelay()
      expect(p.count).toBe(3)

      p.recordSuccess()
      vi.advanceTimersByTime(60_000)
      p.recordSuccess()
      expect(p.count).toBe(3)

      // 用户显式重试是唯一清零入口
      p.clearForManualRestart()
      expect(p.count).toBe(0)

      // 新故障簇：从 1 开始
      p.recordCrashAndGetDelay()
      expect(p.count).toBe(1)
      expect(p.exhausted).toBe(false)
    })
  })

  describe('RestartPolicy 主动停止生命周期', () => {
    it('markStopping → shouldRestart false → reset 恢复', () => {
      const p = new RestartPolicy()
      expect(p.stopping).toBe(false)

      p.markStopping()
      expect(p.stopping).toBe(true)
      expect(p.shouldRestart()).toBe(false)

      p.reset()
      expect(p.stopping).toBe(false)
      expect(p.shouldRestart()).toBe(true)
    })

    it('clearForManualRestart 给新配额：之前耗尽也能再重启', () => {
      const p = new RestartPolicy()
      for (let i = 0; i < MAX_RESTARTS; i++) p.recordCrashAndGetDelay()
      expect(p.exhausted).toBe(true)

      // 手动重试：clearForManualRestart 清计数，重新有 MAX 次配额
      p.clearForManualRestart()
      expect(p.shouldRestart()).toBe(true)
      expect(p.exhausted).toBe(false)
      expect(p.count).toBe(0)
    })

    it('reset（start 用）只清 stopping 不清计数，自动重启路径计数保持', () => {
      const p = new RestartPolicy()
      p.recordCrashAndGetDelay()
      p.recordCrashAndGetDelay()
      p.markStopping()
      expect(p.count).toBe(2)

      // start() 开头调 reset：清 stopping，但计数保留（崩溃自动重启路径需要累计）
      p.reset()
      expect(p.stopping).toBe(false)
      expect(p.count).toBe(2)
    })
  })
});

// ======== 来源：runtime-supervisor-planned-restart.test.ts ========
describe("runtime-supervisor-planned-restart", () => {
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
});
