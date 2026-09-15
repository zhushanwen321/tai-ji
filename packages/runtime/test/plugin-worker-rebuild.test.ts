/**
 * Worker crash 重建测试 (vitest)
 *
 * 测试 PluginHost 在 Worker crash 后的自动重建逻辑（trusted 语义）：
 * - trusted Worker crash 后自动重建
 * - sandbox 子进程 crash 不重建（不计数；rebuild 仅 trusted 语义）
 * - crashCounts per-plugin 递增
 * - 超过 3 次后放弃
 *
 * 时序策略（防 flaky）：
 * - 「确认发生」类（crash 传播、rebuild 完成）用 vi.waitFor 轮询断言，不依赖精确 sleep 时长——
 *   rebuild 异步链（postMessage → Worker exit → handleWorkerCrash → setTimeout(cooldown) → rebuild）
 *   在慢环境/并发下时序偏移，固定 sleep 窗口可能不够，waitFor 轮询到条件满足为止。
 * - 「确认不发生」类（超过 MAX_REBUILD_ATTEMPTS 后不 rebuild、sandbox 不 rebuild）保留固定 sleep，
 *   等待超过 cooldown + 余量后断言状态未变（"证明否定"需要等够久）。
 *
 * trusted Worker 线程加载 fixtures/mock-bootstrap.cjs（经 workerBootstrapOverride 注入，不再写 src 目录）；
 * sandbox fork 子进程加载 fixtures/plugin-bootstrap-process.mock.cjs（经 bootstrapPathOverride 注入）。
 *
 * 运行命令: npx vitest run test/plugin-worker-rebuild.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** trusted Worker 线程的 mock bootstrap（经 workerBootstrapOverride 注入） */
const WORKER_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')
/** sandbox fork 子进程的 mock bootstrap（经 bootstrapPathOverride 注入） */
const PROCESS_MOCK_SOURCE = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
/** MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约 */
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

/** rebuild cooldown（与 setRebuildCooldownMs 一致）；「确认不 rebuild」等待 = cooldown + 余量 */
const NO_REBUILD_WAIT_MS = 200

/** 当前 trusted 且 active 的 worker 列表 */
function getTrustedActive(host: PluginHost) {
  return host.getAllWorkers().filter(w => w.trustLevel === 'trusted' && w.status === 'active')
}

/** 等待指定 worker 的 crash 传播完成（instance 被清理） */
async function waitForCrashCleaned(host: PluginHost, workerId: string, timeout = 1500): Promise<void> {
  await vi.waitFor(() => {
    expect(host.getWorkerInstance(workerId)).toBeUndefined()
  }, { timeout, interval: 20 })
}

/** 等待 trusted active worker 恢复到指定数量（rebuild 完成） */
async function waitForTrustedActive(host: PluginHost, count: number, timeout = 2000): Promise<void> {
  await vi.waitFor(() => {
    expect(getTrustedActive(host)).toHaveLength(count)
  }, { timeout, interval: 20 })
}

/**
 * 触发 trusted Worker 崩溃：经 Worker 实例 postMessage({type:'crash'}) → mock exit(1)。
 * 仅 postMessage，不等待（调用方用 waitForCrashCleaned 等 crash 传播完成）。
 * 仅适用于 trusted（有 Worker 实例）；sandbox 走 fork 子进程，无 Worker 实例。
 */
function crashTrustedWorker(host: PluginHost, workerId: string): void {
  const instance = host.getWorkerInstance(workerId)
  expect(instance).toBeDefined()
  instance!.postMessage({ type: 'crash' })
}

describe('Worker Crash Rebuild', () => {
  it('should rebuild trusted worker after crash', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    host.setRebuildCooldownMs(50)

    const workerId = await host.assignWorker('trusted-plugin', 'trusted')
    expect(workerId.startsWith('trusted-')).toBe(true)
    expect(host.getAllWorkers()).toHaveLength(1)

    crashTrustedWorker(host, workerId)
    await waitForCrashCleaned(host, workerId)
    await waitForTrustedActive(host, 1)

    const trustedActive = getTrustedActive(host)
    expect(trustedActive[0].pluginIds).toContain('trusted-plugin')
    expect(host.getCrashCount('trusted-plugin')).toBe(1)

    await host.shutdown()
  })

  it('should NOT rebuild sandbox worker after crash', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })
    host.setRebuildCooldownMs(50)

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('sandbox-plugin', 'sandbox')
    expect(workerId.startsWith('sandbox-')).toBe(true)

    // sandbox 走 fork 子进程，无 Worker 实例 → 经 handle.postMessage 触发崩溃
    const handle = host.getWorkerHandle('sandbox-plugin')!
    expect(handle).toBeDefined()
    handle.postMessage({ type: 'crash' })

    // sandbox 崩溃被检测（onCrash 转发）
    await vi.waitFor(() => {
      expect(crashes.length).toBe(1)
    }, { timeout: 2000, interval: 20 })
    expect(crashes[0].pluginIds).toContain('sandbox-plugin')

    // 等超过 rebuild cooldown 确认 crashCount 不计（sandbox 不 rebuild 也不计数——证明否定需等够久）
    await new Promise(resolve => setTimeout(resolve, NO_REBUILD_WAIT_MS))
    expect(host.getCrashCount('sandbox-plugin')).toBe(0)

    await host.shutdown()
  })

  it('should give up after max rebuild attempts', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    host.setRebuildCooldownMs(50)

    await host.assignWorker('crashy-plugin', 'trusted')

    // Crash 3 次——每次都 rebuild（count ≤ MAX_REBUILD_ATTEMPTS=3 时仍重建）
    for (let i = 0; i < 3; i++) {
      const current = getTrustedActive(host)[0]
      expect(current).toBeDefined()
      crashTrustedWorker(host, current.workerId)
      await waitForCrashCleaned(host, current.workerId)
      await waitForTrustedActive(host, 1)
    }
    expect(host.getCrashCount('crashy-plugin')).toBe(3)

    // 第 4 次 crash——count=4 > MAX_REBUILD_ATTEMPTS=3，不再 rebuild
    const after3 = getTrustedActive(host)[0]
    expect(after3).toBeDefined()
    crashTrustedWorker(host, after3.workerId)
    await waitForCrashCleaned(host, after3.workerId)
    expect(host.getCrashCount('crashy-plugin')).toBe(4)

    // 等超过 cooldown 确认不再 rebuild（trusted active 保持 0——证明否定需等够久）
    await new Promise(resolve => setTimeout(resolve, NO_REBUILD_WAIT_MS))
    expect(getTrustedActive(host)).toHaveLength(0)

    await host.shutdown()
  })

  it('crash counts are per-PluginHost instance (non-persistent)', () => {
    const rpc1 = new PluginRpcServer()
    const host1 = new PluginHost(rpc1, { workerBootstrapOverride: WORKER_MOCK })
    expect(host1.getCrashCount('any-plugin')).toBe(0)

    const rpc2 = new PluginRpcServer()
    const host2 = new PluginHost(rpc2, { workerBootstrapOverride: WORKER_MOCK })
    expect(host2.getCrashCount('any-plugin')).toBe(0)

    host1.shutdown()
    host2.shutdown()
  })

  it('should rebuild trusted worker with multiple plugins', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    host.setRebuildCooldownMs(50)

    const workerId1 = await host.assignWorker('multi-1', 'trusted')
    const workerId2 = await host.assignWorker('multi-2', 'trusted')
    expect(workerId1).toBe(workerId2)

    crashTrustedWorker(host, workerId1)
    await waitForCrashCleaned(host, workerId1)
    await waitForTrustedActive(host, 1)

    expect(host.getCrashCount('multi-1')).toBe(1)
    expect(host.getCrashCount('multi-2')).toBe(1)

    const rebuilt = getTrustedActive(host)
    expect(rebuilt[0].pluginIds).toContain('multi-1')
    expect(rebuilt[0].pluginIds).toContain('multi-2')

    await host.shutdown()
  })
})
