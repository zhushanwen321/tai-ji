/**
 * ProcessManager.getPiVersion 失败负缓存测试（缓存治理 1-7）。
 *
 * 被测缺口：探测失败值此前写死 piVersionCache 恒驻进程生命周期——pi 修好/装好后版本
 * 仍显示 unknown（故障态固化）。修复后失败值只负缓存 60s（对齐 GitStateService
 * notRepoCache 先例：瞬态失败不永久定罪，也避免 pi 缺失环境每调用吃 5s 探测超时），
 * 过期重新探测；成功值仍永久缓存。
 *
 * Mock 策略：mock find-pi-executable（固定路径，免真实扫盘）+ 合并式 mock
 * node:child_process（importActual 保留 spawn 等其余导出，只覆盖 execSync——依赖图内
 * relay-env import spawn，工厂整体替换会破坏模块图）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/process-manager-pi-version.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'

const execSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: execSyncMock }
})
vi.mock('../infra/pi/find-pi-executable.js', () => ({ findPiExecutable: vi.fn(() => '/fake-tools/pi') }))

import { ProcessManager } from '../infra/pi/process-manager.js'

describe('ProcessManager.getPiVersion 失败负缓存（缓存治理 1-7）', () => {
  let pm: ProcessManager

  beforeEach(() => {
    // 隔离：打包态 env 泄入测试进程会改道 findPackagedPi（同 process-manager-ephemeral R3）
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '')
    execSyncMock.mockReset()
    vi.useFakeTimers()
    pm = new ProcessManager(tmpdir())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('失败结果不缓存：60s 窗口内不重探，过期后重新探测且成功值生效（不永久定罪）', async () => {
    // 首次探测失败 → 'unknown'
    execSyncMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    await expect(pm.getPiVersion()).resolves.toBe('unknown')
    expect(execSyncMock).toHaveBeenCalledTimes(1)

    // 负缓存窗口内（<60s）：直接返 'unknown'，不再探测（pi 缺失环境不吃每调用 5s 超时）
    vi.advanceTimersByTime(59_000)
    await expect(pm.getPiVersion()).resolves.toBe('unknown')
    expect(execSyncMock).toHaveBeenCalledTimes(1)

    // 窗口过期（≥60s）：重新探测，且探测成功后新值生效
    vi.advanceTimersByTime(1_000)
    execSyncMock.mockReturnValue('1.2.3\n')
    await expect(pm.getPiVersion()).resolves.toBe('1.2.3')
    expect(execSyncMock).toHaveBeenCalledTimes(2)

    // 成功值永久缓存：再推进 61s 也不重探（成功语义与修复前一致）
    vi.advanceTimersByTime(61_000)
    await expect(pm.getPiVersion()).resolves.toBe('1.2.3')
    expect(execSyncMock).toHaveBeenCalledTimes(2)
  })

  it('持续失败：每个 60s 窗口至多探测一次，过期后才重试', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('pi missing')
    })
    await pm.getPiVersion()
    vi.advanceTimersByTime(60_000)
    await pm.getPiVersion()
    vi.advanceTimersByTime(60_000)
    await pm.getPiVersion()
    // 3 次调用横跨 3 个窗口 = 恰 3 次探测（修复前同为 3 次，但窗口内重复调用不重探是本修复语义）
    expect(execSyncMock).toHaveBeenCalledTimes(3)
    // 窗口内连续调用不放大探测次数
    await pm.getPiVersion()
    await pm.getPiVersion()
    expect(execSyncMock).toHaveBeenCalledTimes(3)
  })
})
