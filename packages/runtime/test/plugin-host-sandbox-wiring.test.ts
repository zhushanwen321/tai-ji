/**
 * PluginHost sandbox 分流接线测试（wave: host-process-wiring）—— in-process 注入桩版
 *
 * 覆盖：assignWorker/loadPlugin/terminateWorker/getWorkerHandle/shutdown 的
 * sandbox 转调（子进程宿主）+ crash 回调转发 + trusted 回归 + fork 边界 wiring。
 * - sandbox fork 子进程宿主经 PluginPoolOptions.bootstrapPathOverride 注入（fixtures/plugin-bootstrap-process.mock.cjs）
 * - trusted Worker 线程经 workerBootstrapOverride 注入（fixtures/mock-bootstrap.cjs）
 *
 * 2026-10-22 单测层整治（判据三档与处置通道见 docs/TEST-STRATEGY.md「新写测试判据」节）：
 * 原形态 spy 模式保留真实 fork/Worker（b+c+f 类）+ vi.waitFor 5s——进程启动与退出
 * 传播没有确定性完成信号。现经 vi.mock 把 node:child_process.fork 与
 * node:worker_threads.Worker 换成注入桩（test/helpers/plugin-host-inproc-stubs.ts，
 * 消息协议逐条对齐上述 fixtures）：
 * - 被测逻辑（sandbox→子进程宿主转调 / 字段映射 / 崩溃转发 / fork 边界断言）全部留在
 *   PluginHost 与 PluginHostProcess 实装内，fork/Worker 的调用实参经桩的 vi.fn 记录断言；
 * - 真实 fork 的进程级行为归集成轨（TAIJI_TEST_INTEGRATION 门控）覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as childProcess from 'node:child_process'
import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

vi.mock('node:child_process', async () =>
  (await import('./helpers/plugin-host-inproc-stubs')).childProcessModule(),
)
vi.mock('node:worker_threads', async () =>
  (await import('./helpers/plugin-host-inproc-stubs')).workerThreadsModule(),
)

const __dirname = dirname(fileURLToPath(import.meta.url))

const PROCESS_MOCK_SOURCE = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
const WORKER_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')
const FAKE_PLUGIN_PATH = '/fake/plugin.js'

describe('PluginHost sandbox wiring', () => {
  let host: PluginHost
  let rpcServer: PluginRpcServer

  beforeEach(() => {
    vi.mocked(childProcess.fork).mockClear()
    rpcServer = new PluginRpcServer()
    // MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约
    host = new PluginHost(rpcServer, {
      bootstrapPathOverride: PROCESS_MOCK_SOURCE,
      workerBootstrapOverride: WORKER_MOCK,
      execArgv: ['--import', NOOP_ESM_LOADER],
    })
  })

  afterEach(async () => {
    await host.shutdown()
  })

  it('TC1: sandbox assignWorker 不创建 Worker 线程', async () => {
    const workerId = await host.assignWorker('p1', 'sandbox')
    expect(workerId).toBe('sandbox-p1')
    expect(host.getWorkerInstance('sandbox-p1')).toBeUndefined()
    // fork 子进程已创建（桩记录调用）
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(1)
  })

  it('TC2: sandbox assignWorker 同插件复用子进程', async () => {
    await host.assignWorker('p1', 'sandbox')
    const again = await host.assignWorker('p1', 'sandbox')
    expect(again).toBe('sandbox-p1')
    // 复用：第二次 assign 不新建 fork（assignProcess 内部复用 active 进程）
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(1)
  })

  it('TC3: sandbox loadPlugin 经 mock 宿主成功加载', async () => {
    await host.assignWorker('p1', 'sandbox')
    await expect(
      host.loadPlugin('sandbox-p1', 'p1', FAKE_PLUGIN_PATH, 'sandbox'),
    ).resolves.toBeUndefined()
  })

  it('TC4: sandbox getWorkerHandle 契约字段映射', async () => {
    await host.assignWorker('p1', 'sandbox')
    const handle = host.getWorkerHandle('p1')
    expect(handle).toBeDefined()
    expect(handle?.workerId).toBe('sandbox-p1') // processId → workerId 映射（activator 消费 handle.workerId）
    expect(typeof handle?.postMessage).toBe('function')
  })

  it('TC5: sandbox terminateWorker 清理子进程', async () => {
    await host.assignWorker('p1', 'sandbox')
    await host.loadPlugin('sandbox-p1', 'p1', FAKE_PLUGIN_PATH, 'sandbox')
    await host.terminateWorker('sandbox-p1')
    expect(host.getWorkerHandle('p1')).toBeUndefined()
    // 已清理：再次 load 报 Process not found
    await expect(
      host.loadPlugin('sandbox-p1', 'p1', FAKE_PLUGIN_PATH, 'sandbox'),
    ).rejects.toThrow(/Process not found/)
  })

  it('TC6: sandbox 子进程崩溃转发 onCrash（不 rebuild）', async () => {
    const crashCb = vi.fn()
    host.setCrashCallback(crashCb)
    await host.assignWorker('p1', 'sandbox')
    const handle = host.getWorkerHandle('p1')
    expect(handle).toBeDefined()
    // 桩按 mock bootstrap 协议响应 crash → 自退 exit(1)：disconnect → exit 事件序
    // 同步 emit → handleProcessCrash → onCrash（await 返回即已完成，无需 waitFor 窗口）
    handle!.postMessage({ type: 'crash' })
    expect(crashCb).toHaveBeenCalledTimes(1)
    const [processId, pluginIds, error] = crashCb.mock.calls[0]
    expect(processId).toBe('sandbox-p1')
    expect(pluginIds).toContain('p1')
    expect(error).toBeTruthy()
    // crashed 进程不被复用：重新 assign 会创建新 fork（隔离语义），旧 crashed entry 被覆盖
    await host.assignWorker('p1', 'sandbox')
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(2)
  })

  it('TC7: trusted 路径不回归（仍走 Worker 线程）', async () => {
    const workerId = await host.assignWorker('p2', 'trusted')
    expect(workerId).toBe('trusted-1')
    const instance = host.getWorkerInstance('trusted-1')
    expect(instance).toBeDefined()
    // trusted 走 Worker 线程，不创建 fork 子进程
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(0)
  })

  it('TC8: sandbox fork env 注入 TAIJI_PLUGIN_SANDBOX_DIR = dirname(pluginPath)（目录形态，S1-W3）', async () => {
    await host.assignWorker('p1', 'sandbox', '/fake/plugins/p1/index.js')
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(1)
    const forkCall = vi.mocked(childProcess.fork).mock.calls[0]
    const opts = forkCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined
    // ESM loader initialize() 读此 env 做 sandbox 边界判定（startsWith(sandboxDir + sep)），
    // 必须是插件根目录形态——此前原样注入入口文件路径导致边界 0% 命中（S1-W3 回归锚）
    expect(opts?.env?.TAIJI_PLUGIN_SANDBOX_DIR).toBe('/fake/plugins/p1')
    // 打包约束（AGENTS.md #12）仍生效
    expect(opts?.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('TC9: sandbox 未传 pluginDir 时 fork env 不含 TAIJI_PLUGIN_SANDBOX_DIR（loader fail-closed 兑现）', async () => {
    await host.assignWorker('p1', 'sandbox')
    const forkCall = vi.mocked(childProcess.fork).mock.calls[0]
    const opts = forkCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined
    // env 缺失时 ESM loader initialize() throw（子进程启动即崩溃）——fail-closed 安全语义
    expect(opts?.env?.TAIJI_PLUGIN_SANDBOX_DIR).toBeUndefined()
  })

  // ── MF-4：ESM loader execArgv 注入 wiring 集成测试 ───────────
  it('TC10 (MF-4): sandbox fork 第 3 参 options.execArgv 含 --import <loader 绝对路径>', async () => {
    await host.assignWorker('p1', 'sandbox', '/fake/plugins/p1/index.js')
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(1)
    const forkCall = vi.mocked(childProcess.fork).mock.calls[0]
    const opts = forkCall?.[2] as { execArgv?: string[]; env?: NodeJS.ProcessEnv } | undefined
    // resolveEsmLoaderExecArgv → PluginHost({execArgv}) → PluginHostProcess.execArgv → fork options.execArgv
    // 这条安全命门在 fork 边界必须断言 execArgv === ['--import', <loader 绝对路径>]
    expect(opts?.execArgv).toEqual(['--import', NOOP_ESM_LOADER])
    // 同步校验 env 仍注入 dirname 目录形态（TC8 的回归保护，与 execArgv 共同构成 sandbox fork 完整 wiring）
    expect(opts?.env?.TAIJI_PLUGIN_SANDBOX_DIR).toBe('/fake/plugins/p1')
  })

  it('TC11 (MF-4+MF-1): loader 缺失（execArgv 无 --import）时 sandbox fork fail-closed', async () => {
    // 模拟 resolveEsmLoaderExecArgv 返回 undefined（loader 文件缺失）：构造时不传 execArgv
    const bareHost = new PluginHost(new PluginRpcServer(), {
      bootstrapPathOverride: PROCESS_MOCK_SOURCE,
    })
    // sandbox fork 边界断言拒绝创建无 ESM 防护的进程（MF-1 fail-closed）
    await expect(bareHost.assignWorker('p1', 'sandbox', '/fake/plugin-dir')).rejects.toThrow(/SANDBOX_LOADER_MISSING|--import/)
    // trusted 不受影响（走 Worker 线程，不需要 ESM loader）
    const trustedId = await bareHost.assignWorker('p2', 'trusted')
    expect(trustedId).toBe('trusted-1')
    await bareHost.shutdown()
  })
})
