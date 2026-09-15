/**
 * RuntimeSupervisor 崩溃台账接线单测（crash-forensics-and-watchdog §3.3 D1，实施计划 u1f）。
 *
 * 覆盖（验收：判别式真值表 + liveness 双写 + planned 86 + stopping 早退零写入）：
 * - classifyRuntimeExit 纯函数真值表：before-quit 上下文 × stopping × 退出码 8 组合，
 *   正常退出 / liveness 强杀 / planned 86 / 真崩溃四形态不误记
 * - onRuntimeExit 接线：crash 行（exitCode/reason）· exit 86 → shutdown/planned 且无
 *   crash 行 · stop() 后 exit 零写入 · markAppQuitting 后 exit 零写入
 * - forceRestartForLiveness：unresponsive/liveness-unhealthy 与 kill decision 同点双写，
 *   其 exit（stopping 期间到达）不产生 crash 行
 *
 * mock 全链形态复刻 test/runtime-supervisor-crash-restart.test.ts；crash-journal mock
 * 捕获 append 调用（真实现 fs 面由 logs/__tests__/crash-journal.test.ts 覆盖）。纯逻辑
 * 零 fs 写。
 * 运行：cd apps/electron/main && npx vitest run test/runtime-supervisor-crash-journal.test.ts
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

// 台账断言面：捕获 append 调用（接线单测只断言「写了什么行」，不触文件系统）
const crashJournalAppend = vi.hoisted(() => vi.fn())
vi.mock('../logs/crash-journal.js', () => ({
  crashJournal: { append: crashJournalAppend },
  initCrashJournal: vi.fn(),
  getCrashJournalDir: vi.fn(() => '/tmp/taiji-test/crashes'),
}))

import { RuntimeSupervisor, classifyRuntimeExit, PLANNED_EXIT_CODE } from '../supervisor/runtime-supervisor.js'
import { spawnRuntimeProcess } from '../supervisor/process-control.js'

const spawnMock = vi.mocked(spawnRuntimeProcess)

/** 取第 n 次 spawn 时传入的 onExit 回调（模拟子进程退出事件） */
function onExitOf(callIndex: number): (code: number | null) => void {
  const call = spawnMock.mock.calls[callIndex]
  if (!call?.[1]) throw new Error(`spawn call ${callIndex} has no onExit callback`)
  return call[1]
}

/** 台账 append 的全部事件行（断言辅助） */
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

describe('onRuntimeExit 台账接线', () => {
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
    // 真实时序：forceRestartForLiveness 同步段（kill decision 日志 + 台账双写 +
    // markStopping）先执行，随后进入 await stop()——exit 事件在 stopping 置位期间到达
    const restarting = sup.forceRestartForLiveness()
    const killDecision = mainLoggerMocks.warn.mock.calls.find(
      (c) => (c[1] as Record<string, unknown>)?.action === 'supervisor_force_kill_halfalive',
    )
    expect(killDecision).toBeDefined()
    // 同点双写：台账行与 kill decision 日志同批产生（exit 之前）
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
