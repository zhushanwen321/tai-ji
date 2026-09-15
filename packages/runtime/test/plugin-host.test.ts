/**
 * PluginHost 单元测试
 *
 * 对齐 fork 架构契约（sandbox → fork 子进程 PluginHostProcess，trusted → Worker 线程）：
 * - trusted Worker 线程加载 fixtures/mock-bootstrap.cjs（经 workerBootstrapOverride 注入，不再写 src 目录）
 * - sandbox fork 子进程加载 fixtures/plugin-bootstrap-process.mock.cjs（经 bootstrapPathOverride 注入）
 *
 * 运行命令: npx vitest run test/plugin-host.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'
import type { IMessageBroker } from '../src/interfaces.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** trusted Worker 线程的 mock bootstrap（经 workerBootstrapOverride 注入） */
const WORKER_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')
/** sandbox fork 子进程的 mock bootstrap（经 bootstrapPathOverride 注入） */
const PROCESS_MOCK_SOURCE = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
/** 常驻版 trusted Worker mock（事件循环保持存活，复现运行中被 terminate → exit code=1） */
const WORKER_MOCK_ALIVE = resolve(__dirname, 'fixtures/mock-bootstrap-alive.cjs')
/** MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约 */
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

// [HISTORICAL] 2026-08-20 PR #185：真实 fork 子进程 / Worker 线程用例显式超时——
// assignWorker/loadPlugin/shutdown 走真实子进程与线程生命周期（含 2s SHUTDOWN_KILL
// 宽限），整包满并行 + 系统余载下超 vitest 默认 5s testTimeout（对齐 equivalence
// 真实 pi 用例显式超时口径）。
describe('PluginHost', { timeout: 30_000 }, () => {
  // ── TC-2-01: sandbox 分配独立 fork 子进程 ─────────────────────
  it('TC-2-01: assignWorker for sandbox creates unique fork process per plugin', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    const workerId1 = await host.assignWorker('plugin-a', 'sandbox')
    const workerId2 = await host.assignWorker('plugin-b', 'sandbox')

    // sandbox 插件各自独占 fork 子进程
    expect(workerId1).not.toBe(workerId2)
    expect(workerId1.startsWith('sandbox-')).toBeTruthy()
    expect(workerId2.startsWith('sandbox-')).toBeTruthy()

    // sandbox 走 fork 子进程，不创建 Worker 线程 → getWorkerInstance 为 undefined
    expect(host.getWorkerInstance(workerId1)).toBeUndefined()
    expect(host.getWorkerInstance(workerId2)).toBeUndefined()

    // 通过 pluginId 可拿到 handle（activator 消费 handle.workerId）
    const handle1 = host.getWorkerHandle('plugin-a')
    const handle2 = host.getWorkerHandle('plugin-b')
    expect(handle1).toBeDefined()
    expect(handle2).toBeDefined()
    expect(handle1!.workerId).toBe(workerId1)
    expect(handle2!.workerId).toBe(workerId2)

    await host.shutdown()
  })

  // ── TC-2-02: trusted 共享 Worker 线程 ─────────────────────────
  it('TC-2-02: assignWorker for trusted shares worker (≤10 plugins)', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    const workerId1 = await host.assignWorker('tp-1', 'trusted')
    const workerId2 = await host.assignWorker('tp-2', 'trusted')
    const workerId3 = await host.assignWorker('tp-3', 'trusted')

    // trusted 插件应共享同一个 Worker（≤10 个插件时）
    expect(workerId1).toBe(workerId2)
    expect(workerId2).toBe(workerId3)

    const handle = host.getWorkerHandleById(workerId1)!
    expect(handle).toBeTruthy()
    expect(handle.trustLevel).toBe('trusted')
    expect(handle.pluginIds.length).toBe(3)

    await host.shutdown()
  })

  // ── TC-2-03: terminateWorker 清理 sandbox 子进程 ──────────────
  it('TC-2-03: terminateWorker removes worker', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    const workerId = await host.assignWorker('term-test', 'sandbox')

    expect(host.getWorkerHandle('term-test')).toBeDefined()

    await host.terminateWorker(workerId)

    const afterTerminate = host.getWorkerHandle('term-test')
    expect(afterTerminate).toBe(undefined)

    await host.shutdown()
  })

  // ── 补充：getAllWorkers 初始为空 ─────────────────────────────
  it('getAllWorkers returns empty initially', () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    expect(host.getAllWorkers()).toEqual([])

    host.shutdown()
  })

  // ── 补充：terminateWorker 对不存在的 worker 是 no-op ─────────
  it('terminateWorker is no-op for non-existent worker', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    // 不应抛异常
    await host.terminateWorker('nonexistent-worker')

    await host.shutdown()
  })

  // ── 补充：shutdown 清理所有 sandbox 子进程 ────────────────────
  it('shutdown terminates all workers', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    await host.assignWorker('s-1', 'sandbox')
    await host.assignWorker('s-2', 'sandbox')
    expect(host.getWorkerHandle('s-1')).toBeDefined()
    expect(host.getWorkerHandle('s-2')).toBeDefined()

    await host.shutdown()
    expect(host.getWorkerHandle('s-1')).toBeUndefined()
    expect(host.getWorkerHandle('s-2')).toBeUndefined()
  })

  // ── 补充：sandbox 子进程崩溃转发 crash callback ────────────────
  it('crash callback is invoked when worker errors', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('crash-test', 'sandbox')
    const handle = host.getWorkerHandle('crash-test')!
    expect(handle).toBeDefined()

    // mock bootstrap 收到 crash → process.exit(1) → 子进程 exit(1) → onCrash 转发
    handle.postMessage({ type: 'crash' })

    // 事件驱动等待子进程退出事件传播（固定 sleep 在 38 包并行负载下会超窗假红）
    await vi.waitFor(() => expect(crashes.length).toBe(1), { timeout: 10_000 })

    expect(crashes.length).toBe(1)
    expect(crashes[0].workerId).toBe(workerId)
    expect(crashes[0].pluginIds).toContain('crash-test')

    await host.shutdown()
  })

  // ── 回归：预期终止不误报崩溃（退出 toast「插件 statusline 崩溃」事故）──
  // 运行中的 Worker 被 terminate() 时 exit code=1（Node 语义），若不先置
  // handle.status='terminated'，exit handler 会误判崩溃 → 假 toast + 无意义 rebuild
  it('terminateWorker does not report crash for expected termination (exit code 1)', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK_ALIVE })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('term-trusted', 'trusted')
    // 先 loadPlugin 等 loaded 回执：保证脚本已求值、常驻句柄已挂，
    // 此时 terminate 才是「运行中被终止 → exit code=1」（否则脚本未求值，自然退出 code=0）
    await host.loadPlugin(workerId, 'term-trusted', '/virtual/plugin', 'trusted')
    const handle = host.getWorkerHandleById(workerId)!

    // 自挂 exit 监听证明场景确为 exit code=1（运行中被 terminate），
    // 排除「Worker 已自然退出 code=0 才没误报」的假通过
    const exitCodes: number[] = []
    host.getWorkerInstance(workerId)!.on('exit', (code) => exitCodes.push(code))

    await host.terminateWorker(workerId)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(exitCodes).toEqual([1])
    expect(handle.status).toBe('terminated')
    expect(crashes).toEqual([])
    expect(host.getCrashCount('term-trusted')).toBe(0)

    await host.shutdown()
  })

  it('shutdown does not report crash for expected termination of live workers', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK_ALIVE })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('shutdown-trusted', 'trusted')
    await host.loadPlugin(workerId, 'shutdown-trusted', '/virtual/plugin', 'trusted')
    const handle = host.getWorkerHandleById(workerId)!

    const exitCodes: number[] = []
    host.getWorkerInstance(workerId)!.on('exit', (code) => exitCodes.push(code))

    await host.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(exitCodes).toEqual([1])
    expect(handle.status).toBe('terminated')
    expect(crashes).toEqual([])
    expect(host.getCrashCount('shutdown-trusted')).toBe(0)
  })

  // ── 回归：process 版 shutdown 同样不误报（sandbox 子进程正常关停）──
  // PluginHostProcess.shutdown() 曾漏掉 pre-mark，SIGTERM 触发的 exit(code=null)
  // 经 `code !== 0` 判定误入 handleProcessCrash → sandbox 插件退出弹假崩溃 toast
  it('shutdown does not report crash for expected termination of sandbox processes', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('shutdown-sandbox', 'sandbox')
    // 等 loaded 回执：保证子进程已启动且消息回路通畅，kill 时是「存活中被终止」
    await host.loadPlugin(workerId, 'shutdown-sandbox', '/virtual/plugin', 'sandbox')

    await host.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(crashes).toEqual([])
  })

  // ── U7/D5: loadPlugin 超时 → handleWorkerCrash 回收链（P-10 检查点）──
  // fake timers 同步 advance 手法：loadPlugin 内 postMessage 后、无事件循环让渡时
  // 同步 advanceTimersByTime，超时回调确定性先于 Worker 线程的 loaded 回包被主线程
  // 消费（跨线程消息需经真实事件循环派发，fake timer 同步触发）——无需「不回复的
  // bootstrap」即可确定性复现 load 超时。
  it('loadPlugin timeout triggers crash chain: terminate + rebuild scheduling (D5)', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('load-timeout', 'trusted')

    // P-10 检查点实测：load 超时入口 handle.status === 'active'（createWorker 刚创建，
    // 未涉 crash/terminate）——满足 handleWorkerCrash 幂等守卫前置，无需直接 terminate 兜底
    expect(host.getWorkerHandleById(workerId)!.status).toBe('active')

    const worker = host.getWorkerInstance(workerId)!
    const termSpy = vi.spyOn(worker, 'terminate')

    vi.useFakeTimers()
    try {
      const pending = host.loadPlugin(workerId, 'load-timeout', '/virtual/plugin', 'trusted')

      // 默认 LOAD_PLUGIN_TIMEOUT_MS = 10s 精确边界：9_999ms 未超时
      vi.advanceTimersByTime(9_999)
      expect(host.getCrashCount('load-timeout')).toBe(0)
      expect(host.getPendingRebuildTimer(workerId)).toBeUndefined()

      vi.advanceTimersByTime(1)
      await expect(pending).rejects.toThrow(/loadPlugin timeout for worker/)

      // crash 链完整执行：terminate 被调 + handle/索引清理 + crash 计数 + rebuild 排期
      expect(termSpy).toHaveBeenCalledTimes(1)
      expect(host.getWorkerHandleById(workerId)).toBeUndefined()
      expect(host.getCrashCount('load-timeout')).toBe(1)
      expect(host.getPendingRebuildTimer(workerId)).toBeDefined()
      expect(crashes.length).toBe(1)
      expect(crashes[0].error).toContain('loadPlugin timeout')
      expect(crashes[0].pluginIds).toEqual(['load-timeout'])
    } finally {
      vi.useRealTimers()
    }

    // 幂等守卫：本 terminate 触发的 exit(code=1) 不二次 crash（等事件真实传播）
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(crashes.length).toBe(1)
    expect(host.getCrashCount('load-timeout')).toBe(1)

    await host.shutdown()
  })

  // ── U7/D5: loadTimeoutMs 覆盖参数（对齐 fork 版 PluginPoolOptions 先例）──
  it('loadTimeoutMs option overrides the 10s default (fork parity)', async () => {
    const rpc = new PluginRpcServer()
    // 覆盖 2s：2s-1ms 未超时、2s 整触发——证明取的是覆盖值而非默认 10s
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK, loadTimeoutMs: 2_000 })

    const workerId = await host.assignWorker('load-timeout-opt', 'trusted')

    vi.useFakeTimers()
    try {
      const pending = host.loadPlugin(workerId, 'load-timeout-opt', '/virtual/plugin', 'trusted')

      vi.advanceTimersByTime(1_999)
      expect(host.getCrashCount('load-timeout-opt')).toBe(0)
      expect(host.getPendingRebuildTimer(workerId)).toBeUndefined()

      vi.advanceTimersByTime(1)
      expect(host.getCrashCount('load-timeout-opt')).toBe(1)
      expect(host.getPendingRebuildTimer(workerId)).toBeDefined()
      await expect(pending).rejects.toThrow(/after 2000ms/)
    } finally {
      vi.useRealTimers()
    }

    await host.shutdown()
  })

  // ── V6②: load 超时 crash 连坐——同宿主已激活插件 rebuild 后自动重载 ──
  // 设计 §6.5/§9 V6②：load 超时 ≈ Worker event loop 卡死，terminate + rebuild
  // （连带同宿主其他插件重载）与 crash 路径处理完全一致。全链（真实 PluginService
  // 装配 + mock Worker 线程）验证：同宿主 ACTIVE 插件随 crash 链置 CRASHED（而非
  // 被激活失败终态覆盖为 UNLOADED）→ 冷却后 rebuild（trusted-2）→ 按既有
  // CRASHED-only 重载编排恢复 ACTIVE（工具可用）。UNLOADED 跳过语义（用户
  // disable/uninstall 不复活）由 lifecycle-races LC-U1 在 PluginService 层覆盖。
  it('V6②: loadPlugin timeout collateral — active same-host plugin ends CRASHED and is reloaded after rebuild', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'v62-host-root-'))
    const tmpConfig = await mkdtemp(join(tmpdir(), 'v62-host-config-'))
    const broadcasts: unknown[] = []
    const broker: IMessageBroker = {
      send: () => {},
      broadcast: (msg) => { broadcasts.push(msg) },
      sendError: () => {},
    }
    const service = new PluginService(new PluginRegistry(tmpRoot, tmpConfig), broker, { configDir: tmpConfig })
    // initialize 前换装 mock-bootstrap 宿主：registerWorkerCallbacks（crash/rebuilt/reply）
    // 会接线到该实例——生产装配路径零复制（crash callback → markCrashed、rebuilt → 重载编排均走真实代码）
    service.host = new PluginHost(service.rpcServer, { workerBootstrapOverride: WORKER_MOCK })
    await service.initialize()

    const makeTrustedDescriptor = (pluginId: string): PluginDescriptor => ({
      pluginId,
      version: '1.0.0',
      displayName: pluginId,
      description: '',
      main: 'index.js',
      activationEvents: ['onStartupFinished'],
      trustLevel: 'trusted',
      status: 'UNLOADED',
      contributes: {},
      permissions: [],
      engines: { 'taiji': '*' },
      pluginPath: `/tmp/${pluginId}/index.js`,
      source: 'built-in',
      extensionDependencies: [],
    })
    const normalDesc = makeTrustedDescriptor('gateb-normal')
    const hangDesc = makeTrustedDescriptor('gateb-hang-load')
    service.registry.cacheDescriptors([normalDesc, hangDesc])
    service.activator.registerDescriptors([normalDesc, hangDesc])

    // 同宿主正常插件先激活成功（Gate B 前置形态）
    await service.activator.activatePlugin('gateb-normal', { type: 'onStartupFinished' }, service.host)
    expect(service.activator.getState('gateb-normal')).toBe('ACTIVE')
    const trusted1WorkerId = service.host.getWorkerHandle('gateb-normal')!.workerId

    // U7 同款 fake timers 同步 advance 手法：gateb-hang 经 assignWorker 复用 trusted-1
    // （登记进 handle.pluginIds，同宿主共享），load 挂起后同步烧完 10s load 超时
    // （确定性先于 mock 的 loaded 回包），触发 crash 链
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await service.host.assignWorker('gateb-hang-load', 'trusted', hangDesc.pluginPath)
      const hangLoad = service.host.loadPlugin(trusted1WorkerId, 'gateb-hang-load', hangDesc.pluginPath, 'trusted')
      vi.advanceTimersByTime(10_000)
      await expect(hangLoad).rejects.toThrow(/loadPlugin timeout for worker/)

      // 连坐：同宿主 ACTIVE 插件随 crash 链置 CRASHED（而非 UNLOADED）
      expect(service.activator.getState('gateb-normal')).toBe('CRASHED')
      expect(service.activator.getState('gateb-hang-load')).toBe('CRASHED')
      expect(service.host.getPendingRebuildTimer(trusted1WorkerId)).toBeDefined()

      // 冷却（5s）到期 → rebuild trusted-2 → 既有 CRASHED-only 重载编排接手；
      // 重载链（loadPlugin / activate 回包）是真实线程 I/O，切回真实 timer 轮询等收敛
      await vi.advanceTimersByTimeAsync(5_000)
    } finally {
      vi.useRealTimers()
    }

    const deadline = Date.now() + 10_000
    while (service.activator.getState('gateb-normal') !== 'ACTIVE' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }

    // rebuild 后同宿主插件恢复 ACTIVE（V6②：工具可用），且落在重建后的新宿主上
    expect(service.activator.getState('gateb-normal')).toBe('ACTIVE')
    expect(service.activator.getState('gateb-hang-load')).toBe('ACTIVE')
    expect(service.host.getWorkerHandle('gateb-normal')!.workerId).not.toBe(trusted1WorkerId)

    await service.shutdown()
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await rm(tmpConfig, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
})
