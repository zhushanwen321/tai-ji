/**
 * RuntimeSupervisor 启动失败真因记录（RD-3#2）回归测试。
 *
 * 背景：startAndNotify 失败（binary 缺失/端口占用等）发 runtime-error 推送后，renderer
 * 侧存在 boot 竞态（推送早于订阅安装即丢）——拉取兜底通道 get-runtime-start-error 依赖
 * supervisor 记录最近一次启动失败原因。本测试钉住记录语义：
 * - startAndNotify 失败 → startError 记录 message + runtime-error 推送发出 + 返回 0；
 * - 失败后 start() 成功 → startError 清除（null = 当前无已知失败）；
 * - 幂等复用（child 存活）→ startError 同步清除；
 * - 重启路径失败（attemptRestart catch）→ startError 刷新为最近一次原因。
 *
 * 构造方式：与 runtime-supervisor-crash-restart.test.ts 同款 stub 全链（spawn/stop/
 * health/port/liveness），不触真实进程。
 *
 * 运行：cd apps/electron/main && npx vitest run test/runtime-supervisor-start-error.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BrowserWindow } from 'electron'

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

import { RuntimeSupervisor } from '../supervisor/runtime-supervisor.js'
import { waitForHealth } from '../supervisor/health-checker.js'

/** 最小 fake 窗口：捕获 webContents.send（runtime-error / runtime-port 推送断言面） */
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
