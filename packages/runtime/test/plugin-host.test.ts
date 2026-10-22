/**
 * PluginHost 单元测试（in-process 注入桩版）
 *
 * 对齐 fork 架构契约（sandbox → fork 子进程 PluginHostProcess，trusted → Worker 线程）：
 * - trusted Worker 线程加载 fixtures/mock-bootstrap.cjs（经 workerBootstrapOverride 注入，不再写 src 目录）
 * - sandbox fork 子进程加载 fixtures/plugin-bootstrap-process.mock.cjs（经 bootstrapPathOverride 注入）
 *
 * 2026-10-22 单测层整治（判据三档与处置通道见 docs/TEST-STRATEGY.md「新写测试判据」节）：
 * 原形态 fork 真子进程 + 起真 Worker 线程（b+f 类），describe 30s 预算 + vi.waitFor 2s×2
 * ——进程/线程启动与退出事件传播没有确定性完成信号，CPU 满载下无稳定上界。现把进程/线程
 * 边界换成注入桩（test/helpers/plugin-host-inproc-stubs.ts，消息协议逐条对齐上述
 * fixtures）：被测逻辑（trusted 共享分配 / sandbox 转调 / 预期终止不误报崩溃的
 * pre-mark + 幂等检查）全部留在 PluginHost 实装内；真实进程/线程生命周期行为
 * （terminate → exit code=1、SIGKILL → exit code=null）属「代码 + OS 组合行为」，
 * 归集成轨（TAIJI_TEST_INTEGRATION 门控）覆盖，不在单测层断言。
 *
 * 运行命令: pnpm --filter @taiji/runtime exec vitest run test/plugin-host.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

vi.mock('node:child_process', async () =>
  (await import('./helpers/plugin-host-inproc-stubs')).childProcessModule(),
)
vi.mock('node:worker_threads', async () =>
  (await import('./helpers/plugin-host-inproc-stubs')).workerThreadsModule(),
)

const __dirname = dirname(fileURLToPath(import.meta.url))

/** trusted Worker 线程的 mock bootstrap（经 workerBootstrapOverride 注入） */
const WORKER_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')
/** sandbox fork 子进程的 mock bootstrap（经 bootstrapPathOverride 注入） */
const PROCESS_MOCK_SOURCE = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
/** 常驻版 trusted Worker mock（对齐「运行中被 terminate → exit code=1」的桩语义） */
const WORKER_MOCK_ALIVE = resolve(__dirname, 'fixtures/mock-bootstrap-alive.cjs')
/** MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约 */
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

describe('PluginHost', () => {
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

  // ── 回归：预期终止不误报崩溃（退出 toast 误报插件崩溃的事故形态）──
  // 运行中的 Worker 被 terminate() 时 exit code=1（Node 语义，桩按常驻句柄形态复现），
  // 若不先置 handle.status='terminated'，exit handler 会误判崩溃 → 假 toast + 无意义 rebuild
  it('terminateWorker does not report crash for expected termination (exit code 1)', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK_ALIVE })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('term-trusted', 'trusted')
    // 先 loadPlugin 等 loaded 回执：保证脚本已求值、常驻句柄已挂，
    // 此时 terminate 才是「运行中被终止 → exit code=1」
    await host.loadPlugin(workerId, 'term-trusted', '/virtual/plugin', 'trusted')
    const handle = host.getWorkerHandleById(workerId)!

    // 自挂 exit 监听证明场景确为 exit code=1（运行中被 terminate），
    // 排除「Worker 已自然退出 code=0 才没误报」的假通过
    const exitCodes: number[] = []
    host.getWorkerInstance(workerId)!.on('exit', (code) => exitCodes.push(code))

    await host.terminateWorker(workerId)
    // 桩的 terminate() 同步 emit exit（真实线程退出传播由集成轨覆盖）：
    // await 返回即事件已处理，无需 waitFor 窗口
    expect(exitCodes).toEqual([1])

    expect(handle.status).toBe('terminated')
    expect(crashes).toEqual([])

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
    expect(exitCodes).toEqual([1])

    expect(handle.status).toBe('terminated')
    expect(crashes).toEqual([])
  })

  // ── 回归：process 版 shutdown 同样不误报（sandbox 子进程正常关停）──
  // PluginHostProcess.shutdown() 曾漏掉 pre-mark，SIGTERM 触发的 exit(code=null)
  // 经 `code !== 0` 判定误入 handleProcessCrash → sandbox 插件退出弹假崩溃 toast。
  // 桩的 kill() 按 L-5 实测事件序同步 emit disconnect → exit(null, signal)：
  // shutdown 返回即 exit 已被幂等检查拦截，负向断言无需采样窗口。
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
    expect(crashes).toEqual([])
  })
})
