/**
 * dev 慢启动健康检查分档回归测试（fix-dev-slowstart-healthcheck）。
 *
 * 背景：dev 实例 runtime 走 tsx 两段式启动，冷编译高负载实测 60-90s；而
 * waitForHealth 默认 30 次 × 200ms ≈ 6s 硬上限 → main 侧把慢启动误判为超时，
 * stop() 清理半活 child（exit 143）。修复 = supervisor doStart 调用点：
 * - aliveCheck：进程退出检测（退出即失败，错误信息区分超时与崩溃）
 * - dev 形态（!app.isPackaged）：retryCount = DEV_HEALTH_RETRY_COUNT（1500 × 200ms = 300s）
 * - prod 形态：不传 retryCount（默认 6s——prod 起不来是故障，快失败是特性）
 *
 * 构造方式：与 runtime-supervisor-start-error.test.ts 同款 stub 全链
 * （spawn/stop/health/port/liveness），断言实际传给 waitForHealth 的 opts 形态。
 *
 * 运行：cd apps/electron/main && npx vitest run test/runtime-supervisor-dev-health-ceiling.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

vi.mock('electron', () => {
  const getAllWindows = vi.fn(() => [])
  return {
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows }),
    app: { getPath: vi.fn(() => '/tmp'), getName: vi.fn(() => 'test'), isPackaged: false },
  }
})

vi.mock('../supervisor/port-discoverer.js', () => ({
  findAvailablePort: vi.fn(async () => 43110),
  getPortOffset: vi.fn(() => 0),
}))

vi.mock('../supervisor/process-control.js', () => ({
  spawnRuntimeProcess: vi.fn(() => ({
    child: { exitCode: null, killed: false, pid: 12345, on: vi.fn(), kill: vi.fn() },
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

import { app } from 'electron'
import { RuntimeSupervisor, DEV_HEALTH_RETRY_COUNT } from '../supervisor/runtime-supervisor.js'
import { waitForHealth } from '../supervisor/health-checker.js'
import type { WaitForHealthOptions } from '../supervisor/health-checker.js'

/** 取 doStart 实际传给 waitForHealth 的 opts（单次 start 后调用记录 [0][1]） */
function healthOptsOfLastStart(): WaitForHealthOptions {
  const opts = vi.mocked(waitForHealth).mock.calls[0]?.[1]
  if (!opts) throw new Error('waitForHealth not called (or called without opts)')
  return opts
}

describe('dev 慢启动健康检查分档（doStart → waitForHealth opts 形态）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(waitForHealth).mockResolvedValue(undefined)
    ;(app as { isPackaged?: boolean }).isPackaged = false
  })

  it('dev 形态（!isPackaged）→ 传 aliveCheck + retryCount=DEV_HEALTH_RETRY_COUNT', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()

    expect(waitForHealth).toHaveBeenCalledTimes(1)
    const opts = healthOptsOfLastStart()
    expect(opts.retryCount).toBe(DEV_HEALTH_RETRY_COUNT)
    expect(opts.retryCount).toBe(1500)
    expect(typeof opts.aliveCheck).toBe('function')
    // child 存活（exitCode null 且未被 kill）→ aliveCheck 为 true
    expect(opts.aliveCheck?.()).toBe(true)

    await sup.stop()
  })

  it('prod 形态（isPackaged）→ 传 aliveCheck 但不传 retryCount（保持默认 6s 上限）', async () => {
    ;(app as { isPackaged?: boolean }).isPackaged = true
    const sup = new RuntimeSupervisor()
    await sup.start()

    expect(waitForHealth).toHaveBeenCalledTimes(1)
    const opts = healthOptsOfLastStart()
    expect('retryCount' in opts).toBe(false)
    expect(typeof opts.aliveCheck).toBe('function')
    expect(opts.aliveCheck?.()).toBe(true)

    await sup.stop()
  })

  it('runtime 退出（onRuntimeExit 清 child）→ aliveCheck 翻转为 false', async () => {
    const sup = new RuntimeSupervisor()
    await sup.start()
    const aliveCheck = healthOptsOfLastStart().aliveCheck
    if (!aliveCheck) throw new Error('aliveCheck not passed')
    expect(aliveCheck()).toBe(true)

    // 模拟 runtime 崩溃：spawn 时注册的 onExit 回调 → supervisor 清 child
    const { spawnRuntimeProcess } = await import('../supervisor/process-control.js')
    const onExit = vi.mocked(spawnRuntimeProcess).mock.calls[0]?.[1]
    if (!onExit) throw new Error('spawn call has no onExit callback')
    onExit(143)

    expect(aliveCheck()).toBe(false)

    // 清理：取消崩溃链的退避重启定时器
    await sup.stop()
  })
})
