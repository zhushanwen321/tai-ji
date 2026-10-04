/**
 * RuntimeSupervisor start() 并发串行化回归测试（AM2：TOCTOU 双 spawn 根修）。
 *
 * 背景：start() 原实现幂等守卫后 `await this.stop()` 再 spawn——toggle 入口
 * （restartForConfigChange）与启动链/崩溃重启并发时双方都通过守卫 →
 * 双 spawn 抢端口。修复 = promise 链串行队列（join 会让 toggle 拿到旧配置的
 * 启动结果，故串行而非共享）。
 *
 * 第二组 describe 覆盖 restartForConfigChange 本体（toggle 重启编排收口进
 * supervisor）：广播时序（restarting 先于 stop）、队列并发不双 spawn、
 * 失败补 runtime-failed 终态广播后 reject 上抛，不进崩溃退避链。
 *
 * Mock 策略对齐 runtime-supervisor-crash-restart.test.ts：stub 全链
 * （spawn/stop/health/port/liveness/main-logger），spawnRuntimeProcess 返回恒活 fake child。
 *
 * 运行：cd apps/electron/main && npx vitest run test/runtime-supervisor-start-concurrency.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock 必须在 import 之前（vitest hoist）
// 返回类型放宽为 unknown[]（对齐 remote-access-handlers.test.ts 先例）：
// 广播窗口桩（makeEventWindow）作为广播目标注入，不满足完整 BrowserWindow 形状
const getAllWindowsMock = vi.hoisted(() => vi.fn((): unknown[] => []))

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: getAllWindowsMock }),
  app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test') },
}))

vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(async () => 43110),
  getPortOffset: vi.fn(() => 0),
}))

// spawnRuntimeProcess：返回恒活 fake child（exitCode 恒 null，幂等守卫判活）
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

// main-logger stub（真实现经 initMainLogger 落盘；本测试不触文件 IO）
vi.mock('../logs/main-logger.js', () => ({
  mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  readMainLogMaxBytes: vi.fn(() => 50 * 1024 * 1024),
  initMainLogger: vi.fn(),
  closeMainLogger: vi.fn(async () => undefined),
  startMemoryWatermarkTimer: vi.fn(() => () => {}),
}))

import { RuntimeSupervisor } from '../supervisor/runtime-supervisor.js'
import { spawnRuntimeProcess, stopRuntimeProcess } from '../supervisor/process-control.js'

const spawnMock = vi.mocked(spawnRuntimeProcess)

describe('RuntimeSupervisor start() 并发串行化（AM2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    // 广播窗口桩恢复空集（防跨用例泄漏——clearAllMocks 不清 mockReturnValue）
    getAllWindowsMock.mockReturnValue([])
  })

  it('两个 start() 同时发起：spawnRuntimeProcess 只被调一次，两端拿到同一端口', async () => {
    const sup = new RuntimeSupervisor()
    const [p1, p2] = await Promise.all([sup.start(), sup.start()])
    expect(p1).toBe(43110)
    expect(p2).toBe(43110)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('三个 start() 并发（toggle + 启动链 + 崩溃重启同窗口）仍只 spawn 一次', async () => {
    const sup = new RuntimeSupervisor()
    const ports = await Promise.all([sup.start(), sup.start(), sup.start()])
    expect(ports).toEqual([43110, 43110, 43110])
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('前序 start 失败不毒化队列：后序 start 独立执行并成功 spawn', async () => {
    const { waitForHealth } = await import('../supervisor/health-checker.js')
    vi.mocked(waitForHealth).mockRejectedValueOnce(new Error('health timeout'))
    const sup = new RuntimeSupervisor()
    const first = sup.start()
    const second = sup.start()
    await expect(first).rejects.toThrow('health timeout')
    await expect(second).resolves.toBe(43110)
    // 前序失败清理半活 child 后，后序 start 独立走完整时序（串行不跳过、失败不阻塞）
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('崩溃重启链（attemptRestart → start）经同一串行入口，不与手动 start 双 spawn', async () => {
    // fake timers：钉住崩溃重启的 1s 退避定时器（对齐 crash-restart 测试形态，防真实时钟晚触发）
    vi.useFakeTimers()
    const sup = new RuntimeSupervisor()
    await sup.start()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const onExit = spawnMock.mock.calls[0]?.[1]
    expect(onExit).toBeDefined()
    // 模拟 toggle 与崩溃同窗口：先排队手动 start，再触发 exit（清 child + 排程重启）
    const manual = sup.start()
    onExit!(137)
    await manual
    // 手动 start 串行执行：守卫见 child 已清 → 独立 spawn（exit 排程的重启在队列后续）
    expect(spawnMock).toHaveBeenCalledTimes(2)
    // 后续重启尝试经同一串行入口运行：child 已活 → 幂等短路，不叠加 spawn
    await vi.advanceTimersByTimeAsync(1_000)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})

describe('RuntimeSupervisor restartForConfigChange（toggle 重启编排收口）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    getAllWindowsMock.mockReturnValue([])
  })

  /** 窗口桩：send 与 stopRuntimeProcess 都记入同一事件序列，断言广播时序。 */
  function makeEventWindow(events: string[]): { isDestroyed: () => boolean; webContents: { send: (channel: string) => void } } {
    return {
      isDestroyed: () => false,
      webContents: { send: (channel: string) => { events.push(`send:${channel}`) } },
    }
  }

  it('广播顺序：runtime-restarting 先于 stop，runtime-port 在成功后（renderer 即时进重连等待态）', async () => {
    const events: string[] = []
    getAllWindowsMock.mockReturnValue([makeEventWindow(events)])
    vi.mocked(stopRuntimeProcess).mockImplementation(async () => { events.push('stop') })
    const sup = new RuntimeSupervisor()
    await sup.start()
    events.length = 0
    await sup.restartForConfigChange()
    // restarting 必须先于任何 stop（原 bridge 编排广播晚于动作，本用例锁定修复后的时序）
    expect(events[0]).toBe('send:runtime-restarting')
    expect(events.indexOf('send:runtime-restarting')).toBeLessThan(events.indexOf('stop'))
    expect(events.at(-1)).toBe('send:runtime-port')
    // 真重启语义：stop 杀旧后必然重新 spawn（第二次），而非幂等短路复用旧实例
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('与手动 start 同窗口并发：经同一串行队列各走完整时序，不双 spawn', async () => {
    const sup = new RuntimeSupervisor()
    // start 先排队（真 spawn #1）→ restartForConfigChange 排队后执行（stop 杀旧 + 真spawn #2）
    const [startPort, restartPort] = await Promise.all([sup.start(), sup.restartForConfigChange()])
    expect(startPort).toBe(43110)
    expect(restartPort).toBe(43110)
    // 每任务恰好一次 spawn；第三次 spawn = 队列失效交错的双 spawn 回归信号
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('失败：reject 上抛且补 runtime-failed 终态广播（不进崩溃退避链），队列不被毒化', async () => {
    const { waitForHealth } = await import('../supervisor/health-checker.js')
    vi.mocked(waitForHealth).mockRejectedValueOnce(new Error('health timeout'))
    const channels: string[] = []
    getAllWindowsMock.mockReturnValue([{
      isDestroyed: () => false,
      webContents: { send: (channel: string) => { channels.push(channel) } },
    }])
    const sup = new RuntimeSupervisor()
    await expect(sup.restartForConfigChange()).rejects.toThrow('health timeout')
    // 协议闭合：restarting 必有终态广播——失败落 runtime-failed（renderer 经既有
    // failed 态拿重试按钮），runtime-port 是成功专属；无第二次 restarting = 未进崩溃退避链
    expect(channels).toEqual(['runtime-restarting', 'runtime-failed'])
    // 前序失败不毒化队列：后续 start 独立执行成功
    await expect(sup.start()).resolves.toBe(43110)
  })
})
