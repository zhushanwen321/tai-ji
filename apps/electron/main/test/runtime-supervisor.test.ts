// runtime-supervisor.test.ts —— electron-main-test C02 簇合并产物（round5-G）。
// 共同被测业务模块：`supervisor/process-control.ts`、`supervisor/runtime-supervisor.ts`。mock 相容：单侧 mock ../logs/crash-journal.js、../logs/main-logger.js、../supervisor/health-checker.js、../supervisor/liveness-probe.js、../supervisor/port-discoverer.js、../supervisor/port-file.js——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - test/runtime-supervisor-crash-journal.test.ts（12 用例，skip 0）
//   - test/runtime-supervisor-crash-restart.test.ts（6 用例，skip 0）
//   - test/runtime-supervisor-start-error.test.ts（4 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RuntimeSupervisor, classifyRuntimeExit, PLANNED_EXIT_CODE } from '../supervisor/runtime-supervisor'
import { spawnRuntimeProcess } from '../supervisor/process-control'
import { type BrowserWindow } from 'electron'
import { waitForHealth } from '../supervisor/health-checker'

const mainLoggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
// 登记清单断言范围：捕获 append 调用（接线单测只断言「写了什么行」，不触文件系统）
const crashJournalAppend = vi.hoisted(() => vi.fn())
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
  crashJournal: { append: crashJournalAppend },
  initCrashJournal: vi.fn(),
  getCrashJournalDir: vi.fn(() => '/tmp/taiji-test/crashes'),
}))

// ======== 来源：runtime-supervisor-crash-journal.test.ts ========
describe("runtime-supervisor-crash-journal", () => {
  const spawnMock = vi.mocked(spawnRuntimeProcess)

  /** 取第 n 次 spawn 时传入的 onExit 回调（模拟子进程退出事件） */
  function onExitOf(callIndex: number): (code: number | null) => void {
    const call = spawnMock.mock.calls[callIndex]
    if (!call?.[1]) throw new Error(`spawn call ${callIndex} has no onExit callback`)
    return call[1]
  }

  /** 登记清单 append 的全部事件行（断言辅助） */
  function journalEvents(): Array<Record<string, unknown>> {
    return crashJournalAppend.mock.calls.map((c) => c[0] as Record<string, unknown>)
  }

  describe('classifyRuntimeExit 判别式真值表（D1：非 before-quit 且 ≠86 且 stopping=false 才 crash）', () => {
    it('exitCode=86 恒 planned-shutdown（专用退出码优先于 stopping/before-quit 上下文）', () => {
      expect(classifyRuntimeExit({ exitCode: PLANNED_EXIT_CODE, stopping: false, appQuitting: false })).toBe('planned-shutdown')
      expect(classifyRuntimeExit({ exitCode: PLANNED_EXIT_CODE, stopping: true, appQuitting: false })).toBe('planned-shutdown')
      expect(classifyRuntimeExit({ exitCode: PLANNED_EXIT_CODE, stopping: false, appQuitting: true })).toBe('planned-shutdown')
      expect(classifyRuntimeExit({ exitCode: PLANNED_EXIT_CODE, stopping: true, appQuitting: true })).toBe('planned-shutdown')
    })

    it('非 86 × before-quit 上下文：恒 suppressed（app 级退出不记 crash）', () => {
      expect(classifyRuntimeExit({ exitCode: 0, stopping: false, appQuitting: true })).toBe('suppressed')
      expect(classifyRuntimeExit({ exitCode: 0, stopping: true, appQuitting: true })).toBe('suppressed')
      expect(classifyRuntimeExit({ exitCode: 137, stopping: false, appQuitting: true })).toBe('suppressed')
      expect(classifyRuntimeExit({ exitCode: 137, stopping: true, appQuitting: true })).toBe('suppressed')
      expect(classifyRuntimeExit({ exitCode: null, stopping: true, appQuitting: true })).toBe('suppressed')
    })

    it('非 86 × 非 before-quit：stopping=true suppressed（主动 stop 与 liveness 强杀的 exit），stopping=false crash', () => {
      // 主动 stop（window-all-closed 非 darwin 先 stop）与 liveness 强杀的 exit 形态
      expect(classifyRuntimeExit({ exitCode: 0, stopping: true, appQuitting: false })).toBe('suppressed')
      expect(classifyRuntimeExit({ exitCode: 143, stopping: true, appQuitting: false })).toBe('suppressed')
      expect(classifyRuntimeExit({ exitCode: null, stopping: true, appQuitting: false })).toBe('suppressed')
      // 真崩溃：意外退出码与信号杀死（null）两形态
      expect(classifyRuntimeExit({ exitCode: 137, stopping: false, appQuitting: false })).toBe('crash')
      expect(classifyRuntimeExit({ exitCode: 1, stopping: false, appQuitting: false })).toBe('crash')
      expect(classifyRuntimeExit({ exitCode: null, stopping: false, appQuitting: false })).toBe('crash')
    })

    it('exit 0 且无任何上下文标记 → crash（反直觉形态钉住：退出码 0 不等于计划内——86 才是）', () => {
      expect(classifyRuntimeExit({ exitCode: 0, stopping: false, appQuitting: false })).toBe('crash')
    })
  })

  describe('onRuntimeExit 登记清单接线', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('真崩溃（exit 137）→ crash 行（layer/event/reason/exitCode）+ 重启链照旧', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()

      vi.useFakeTimers()
      onExitOf(0)(137)

      expect(journalEvents()).toEqual([
        { layer: 'runtime', event: 'crash', reason: 'process_exit', exitCode: 137 },
      ])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it('信号杀死（exit null，kill -9 / OOM kill）→ crash 行 exitCode=null（schema 可空语义）', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()

      vi.useFakeTimers()
      onExitOf(0)(null)

      expect(journalEvents()).toEqual([
        { layer: 'runtime', event: 'crash', reason: 'process_exit', exitCode: null },
      ])
    })

    it('planned 退出码 86 → shutdown/planned 行，不写 crash 行', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()

      vi.useFakeTimers()
      onExitOf(0)(PLANNED_EXIT_CODE)

      expect(journalEvents()).toEqual([
        { layer: 'runtime', event: 'shutdown', reason: 'planned', exitCode: PLANNED_EXIT_CODE },
      ])
    })

    it('主动 stop() 后 exit → 零写入（stopping 早退分支不写任何行，D1 原文）', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()
      const exit = onExitOf(0)
      await sup.stop()

      vi.useFakeTimers()
      exit(0)
      exit(137)

      expect(crashJournalAppend).not.toHaveBeenCalled()
    })

    it('before-quit 上下文（markAppQuitting，stop 尚未置位 stopping）内 exit → 零写入', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()
      sup.markAppQuitting()

      vi.useFakeTimers()
      onExitOf(0)(137)

      expect(crashJournalAppend).not.toHaveBeenCalled()
    })

    it('start() 复位 before-quit 标记（防御非常规编排，形态对齐 stopping 复位先例）', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()
      sup.markAppQuitting()
      expect((sup as unknown as { appQuitting: boolean }).appQuitting).toBe(true)
      await sup.start() // 非常规编排的防御复位（生产时序 start 先于 before-quit）
      expect((sup as unknown as { appQuitting: boolean }).appQuitting).toBe(false)
    })
  })

  describe('forceRestartForLiveness 第四挂点（unresponsive 与 kill decision 同点双写）', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('杀链发起处写 unresponsive/liveness-unhealthy；exit 落 stopping 窗口零 crash 行；退避重启照旧', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()

      vi.useFakeTimers()
      // 真实时序：forceRestartForLiveness 同步段（kill decision 日志 + 登记清单双写 +
      // markStopping）先执行，随后进入 await stop()——exit 事件在 stopping 置位期间到达
      const restarting = sup.forceRestartForLiveness()
      const killDecision = mainLoggerMocks.warn.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.action === 'supervisor_force_kill_halfalive',
      )
      expect(killDecision).toBeDefined()
      // 同点双写：登记清单行与 kill decision 日志同批产生（exit 之前）
      expect(journalEvents()).toEqual([
        { layer: 'runtime', event: 'unresponsive', reason: 'liveness-unhealthy' },
      ])
      // exit（SIGTERM/SIGKILL 杀链致死，exitCode 形态不限）落 stopping 早退分支
      onExitOf(0)(143)
      expect(journalEvents()).toHaveLength(1) // 无 crash 行追加

      await restarting
      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawnMock).toHaveBeenCalledTimes(2)
      expect(journalEvents()).toHaveLength(1) // 重启全程不再产生新行
    })
  })

  describe('isRunning 在场性（before-quit shutdown 行判据）', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('start 后 true；exit 清 child 后 false；未启动 false', async () => {
      const sup = new RuntimeSupervisor()
      expect(sup.isRunning).toBe(false)
      await sup.start()
      expect(sup.isRunning).toBe(true)
      onExitOf(0)(137)
      expect(sup.isRunning).toBe(false)
    })
  })
});

// ======== 来源：runtime-supervisor-crash-restart.test.ts ========
describe("runtime-supervisor-crash-restart", () => {
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

  describe('杀链决策日志（D6-⑥：谁触发/杀谁/为什么，u5b 同形态）', () => {
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
      // 构造约束：recordSuccess 不清零计数（ADR-0122 无时间窗），崩溃计数单调累计
      // ——按真实 delay 序列（1/2/4/8s）推进 4 轮把计数推到 4，第 5 轮让 start 失败
      // （waitForHealth reject → handleRestartFailure，不经 recordSuccess）使计数触顶
      // 5 → abandon 分支。
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
});

// ======== 来源：runtime-supervisor-start-error.test.ts ========
describe("runtime-supervisor-start-error", () => {
  /** 最小 fake 窗口：捕获 webContents.send（runtime-error / runtime-port 推送断言范围） */
  function fakeWin(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn()
    return { win: { webContents: { send } } as unknown as BrowserWindow, send }
  }

  describe('RuntimeSupervisor 启动失败真因记录（RD-3#2）', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      vi.mocked(waitForHealth).mockResolvedValue(undefined)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('startAndNotify 失败 → startError 记录 message + runtime-error 推送 + 返回 0', async () => {
      vi.mocked(waitForHealth).mockRejectedValueOnce(new Error('health check timeout'))
      const sup = new RuntimeSupervisor()
      const { win, send } = fakeWin()

      const port = await sup.startAndNotify(win)

      expect(port).toBe(0)
      expect(sup.startError).toBe('health check timeout')
      expect(send).toHaveBeenCalledWith('runtime-error', { message: 'health check timeout' })
    })

    it('失败后 start() 成功 → startError 清除（null = 当前无已知失败）', async () => {
      vi.mocked(waitForHealth).mockRejectedValueOnce(new Error('port occupied'))
      const sup = new RuntimeSupervisor()
      const first = fakeWin()
      await sup.startAndNotify(first.win)
      expect(sup.startError).toBe('port occupied')

      const port = await sup.start()
      expect(port).toBe(43110)
      expect(sup.startError).toBeNull()
    })

    it('start() 幂等复用（child 存活）→ startError 同步清除', async () => {
      vi.mocked(waitForHealth).mockRejectedValueOnce(new Error('stale failure'))
      const sup = new RuntimeSupervisor()
      await sup.startAndNotify(fakeWin().win)
      expect(sup.startError).toBe('stale failure')

      // child 存活（exitCode null）+ port 在场 → 幂等复用分支，失败记录不再是当前事实
      await sup.start()
      expect(sup.startError).toBeNull()
    })

    it('重启路径失败（attemptRestart catch）→ startError 刷新为最近一次原因', async () => {
      const sup = new RuntimeSupervisor()
      await sup.start()
      expect(sup.startError).toBeNull()

      // 运行期崩溃 → 1s 退避后 attemptRestart，waitForHealth 失败 → catch 记录新真因
      const { spawnRuntimeProcess } = await import('../supervisor/process-control.js')
      const onExit = vi.mocked(spawnRuntimeProcess).mock.calls[0]?.[1]
      if (!onExit) throw new Error('spawn call has no onExit callback')

      vi.useFakeTimers()
      vi.mocked(waitForHealth).mockRejectedValueOnce(new Error('respawn health failed'))
      onExit(137)
      await vi.advanceTimersByTimeAsync(1_000)

      expect(sup.startError).toBe('respawn health failed')
    })
  })
});
