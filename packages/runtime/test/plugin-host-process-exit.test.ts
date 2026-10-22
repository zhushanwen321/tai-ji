/**
 * PluginHostProcess 子进程退出分流回归测试（L-5）—— in-process 注入桩版
 *
 * 设计基线：exit code 0 是「正常退出」不是崩溃——不触发 onCrash（即无假崩溃
 * toast / CRASHED 标记 / crashCounts 累积），但 handle 必须清理；disconnect 先于
 * exit 到达（实测事件序 disconnect → exit，exit 晚约一个事件循环圈），权威分流
 * 在 exit handler，disconnect 只做 grace 兜底：仅存活进程断开 IPC 才报 crash。
 *
 * 2026-10-22 单测层整治（判据三档与处置通道见 docs/TEST-STRATEGY.md「新写测试判据」节）：
 * 原形态 fork 真实子进程（b+c 类）+ vi.waitFor 3s + sleep 观察窗——事件传播与 grace
 * 窗口没有确定性完成信号。现经 vi.mock 把 fork 换成注入桩
 * （test/helpers/plugin-host-inproc-stubs.ts，exit0 / ipc-disconnect 分支逐条对齐
 * fixtures/mock-bootstrap-exit0.cjs），事件序由桩同步 emit（disconnect → exit，
 * 对齐 L-5 实测序），grace 定时器经 fake timers 确定性推进：
 * - 被测逻辑（exit 0 分流 / disconnect grace 兜底 / pre-mark 幂等）全部留在
 *   PluginHostProcess 实装内；
 * - 真实子进程退出的事件传播时序归集成轨（TAIJI_TEST_INTEGRATION 门控）覆盖。
 *
 * 运行命令: pnpm --filter @taiji/runtime exec vitest run test/plugin-host-process-exit.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHostProcess } from '../src/services/plugin-service/plugin-host-process.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import { fakePluginChildren, resetPluginHostStubs } from './helpers/plugin-host-inproc-stubs.js'

vi.mock('node:child_process', async () =>
  (await import('./helpers/plugin-host-inproc-stubs')).childProcessModule(),
)

const __dirname = dirname(fileURLToPath(import.meta.url))
/** fork 目标（bootstrapPathOverride 注入；fork 已桩化，路径仅作构造入参记录）。 */
const EXIT_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap-exit0.cjs')
/** MF-1：sandbox fork 边界断言 execArgv 含 --import（生产 fail-closed 检查，必须满足）。 */
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

// 测试注入的 disconnect 宽限（构造 disconnectGraceMs 传入宿主）。生产默认 250ms 不变；
// grace 定时器经 fake timers 推进到期，断言「到期后也不报 / 到期即报」
const TEST_DISCONNECT_GRACE_MS = 50
/** grace 定时器推进余量（> 注入宽限即保证到期）。 */
const GRACE_ADVANCE_MS = TEST_DISCONNECT_GRACE_MS + 10

describe('PluginHostProcess exit 分流（L-5）', () => {
  let host: PluginHostProcess
  let rpc: PluginRpcServer
  // 泛型显式对齐 CrashCallback 签名（裸 vi.fn 推导不出参数形态，tsc 不过）
  let onCrash: ReturnType<typeof vi.fn<(processId: string, pluginIds: string[], error: string) => void>>

  beforeEach(() => {
    // fake timers：disconnect grace 定时器（宿主分流逻辑的组成部分）由测试确定性推进
    vi.useFakeTimers()
    // 每测试清零 fork 记录：fakePluginChildren() 下标按本测试创建顺序对齐
    resetPluginHostStubs()
    rpc = new PluginRpcServer()
    host = new PluginHostProcess(rpc, {
      bootstrapPathOverride: EXIT_MOCK,
      // MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约
      execArgv: ['--import', NOOP_ESM_LOADER],
      disconnectGraceMs: TEST_DISCONNECT_GRACE_MS,
    })
    onCrash = vi.fn<(processId: string, pluginIds: string[], error: string) => void>()
    host.setCrashCallback(onCrash)
  })

  afterEach(async () => {
    await host.shutdown()
    vi.useRealTimers()
  })

  it('a) 子进程 exit(0)：onCrash 不触发、handle 清理、无 crashed 残留', async () => {
    const processId = await host.assignProcess('clean-exit', 'sandbox')
    await host.loadPlugin(processId, 'clean-exit', '/fake/plugin.js', 'sandbox')

    host.getProcessHandle('clean-exit')!.postMessage({ type: 'exit0' })

    // 桩按实测事件序同步 emit disconnect → exit(0)：exit handler 走 clean exit 分流，
    // handle 从宿主清除（await 返回即已完成，无需 waitFor 窗口）
    expect(host.getProcessHandleById(processId)).toBeUndefined()

    // 再确定性推进过 disconnect grace 窗口：兜底定时器到期后也不得补报 crash
    // （区分「不会报」与「还没到报的时机」）
    await vi.advanceTimersByTimeAsync(GRACE_ADVANCE_MS)
    expect(onCrash).not.toHaveBeenCalled()
    // 反向索引同步清理：getProcessHandle 不再指向死进程（否则新分配会 child.send 落空）
    expect(host.getProcessHandle('clean-exit')).toBeUndefined()
    expect(host.getAllProcesses().find((h) => h.processId === processId)).toBeUndefined()
  })

  it('b) 存活进程主动断 IPC：grace 后 onCrash 触发（真异常不被吞）', async () => {
    const processId = await host.assignProcess('live-disconnect', 'sandbox')
    await host.loadPlugin(processId, 'live-disconnect', '/fake/plugin.js', 'sandbox')

    // 桩按 mock 协议响应 ipc-disconnect：只 emit disconnect、进程保持存活（无 exit 跟随）
    host.getProcessHandle('live-disconnect')!.postMessage({ type: 'ipc-disconnect' })

    // grace 窗口内 exit 未到（进程仍存活）→ IPC 单方面断开的真异常 → 报 crash：
    // 定时器到期即触发，确定性推进代替 waitFor 轮询
    await vi.advanceTimersByTimeAsync(GRACE_ADVANCE_MS)
    expect(onCrash).toHaveBeenCalledTimes(1)
    const [reportedId, pluginIds, error] = onCrash.mock.calls[0]
    expect(reportedId).toBe(processId)
    expect(pluginIds).toContain('live-disconnect')
    expect(String(error)).toMatch(/disconnect/i)
    // RT-6#5：crash 收尾即删 processes Map（幽灵条目不再滞留，与 clean-exit 清理对称）
    expect(host.getProcessHandleById(processId)).toBeUndefined()
  })

  it('c) terminate 路径（pre-mark terminated 后 kill）：onCrash 仍不触发', async () => {
    const processId = await host.assignProcess('term-guard', 'sandbox')
    await host.loadPlugin(processId, 'term-guard', '/fake/plugin.js', 'sandbox')

    // 观测 disconnect 确已到达（kill → 通道关闭的真实事件序）：它是 grace 定时器存在
    // 的前提——没有它，下方「过期不报」会是空过
    let disconnected = false
    fakePluginChildren()[0].on('disconnect', () => { disconnected = true })

    await host.terminateProcess(processId)
    expect(disconnected).toBe(true)
    expect(host.getProcessHandleById(processId)).toBeUndefined()

    // kill 触发的 disconnect/exit 已同步传播；再确定性推进过 grace 窗口过期：
    // pre-mark 的 terminated 检查与 disconnect 幂等检查都不应误报 crash
    await vi.advanceTimersByTimeAsync(GRACE_ADVANCE_MS)
    expect(onCrash).not.toHaveBeenCalled()
  })
})
