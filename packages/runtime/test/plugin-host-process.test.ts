/**
 * plugin-host-process：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - plugin-host-process.test.ts
 *   - plugin-host-process-exit.test.ts
 *   - plugin-host-sandbox-wiring.test.ts
 *   - plugin-host.test.ts
 *   - plugin-tool-execution.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run test/plugin-host-process.test.ts
 */

import * as childProcess from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginHostProcess } from '../src/services/plugin-service/plugin-host-process.js'
import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import { DEFAULT_TOOL_EXECUTE_TIMEOUT_MS, resolveToolTimeoutMs } from '../src/services/plugin-service/tool-timeout.js'
import { fakePluginChildren, resetPluginHostStubs } from './helpers/plugin-host-inproc-stubs.js'

// 进程边界注入桩（各来源节工厂同文本，合并为一份文件级 mock；vitest 本就将
// vi.mock 提升到文件顶部，放顶层消除 describe 内声明将来转错的告警）
vi.mock('node:child_process', async () =>
  (await import('./helpers/plugin-host-inproc-stubs')).childProcessModule(),
)
vi.mock('node:worker_threads', async () =>
  (await import('./helpers/plugin-host-inproc-stubs')).workerThreadsModule(),
)


// ════════════════ 来源: plugin-host-process.test.ts ════════════════
describe('plugin-host-process', () => {
  /**
   * PluginHostProcess 单元测试（fork 版宿主侧）—— in-process 注入桩版
   *
   * 2026-10-22 单测层整治（判据三档与处置通道见 docs/TEST-STRATEGY.md「新写测试判据」节）：
   * 原形态每个用例 fork 真实子进程（b+f 类）——子进程启动 / 退出事件传播 / disconnect
   * grace 窗口没有确定性完成信号，CPU 满载下无稳定上界。现经 vi.mock 把
   * node:child_process.fork 换成注入桩（test/helpers/plugin-host-inproc-stubs.ts，
   * 消息协议逐条对齐 fixtures/plugin-bootstrap-process.mock.cjs 与
   * fixtures/mock-bootstrap-exit0.cjs）：
   * - 被测逻辑（分配/复用/IPC 往返/崩溃检测与分流/清理/幂等/重建竞态防护）全部留在
   *   PluginHostProcess 实装内，桩只替代进程边界；
   * - 原「等真实事件传播」的 waitFor 轮询与 sleep 观察窗，换成 fake timers 对
   *   disconnect grace 定时器的确定性推进（advanceTimersByTimeAsync）与测试显式驱动的
   *   迟到 exit（M6a-03 竞态窗口）；
   * - 真实 fork 的进程级行为归集成组（TAIJI_TEST_INTEGRATION 门控）覆盖。
   *
   * 运行命令: pnpm --filter @taiji/runtime exec vitest run test/plugin-host-process.test.ts
   */



  const __dirname = dirname(fileURLToPath(import.meta.url))
  /** fork 目标（bootstrapPathOverride 注入；fork 已桩化，路径仅作构造入参记录）。 */
  const MOCK_BOOTSTRAP = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
  /** MF-1：sandbox fork 边界断言 execArgv 含 --import（生产 fail-closed 检查，必须满足）。 */
  const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

  /** disconnect 宽限注入值（生产默认 250ms 不变；配套检查窗口经 fake timers 推进）。 */
  const TEST_DISCONNECT_GRACE_MS = 50
  /** grace 定时器推进余量（> 注入宽限即保证到期）。 */
  const GRACE_ADVANCE_MS = TEST_DISCONNECT_GRACE_MS + 10

  function createHost(): {
    host: PluginHostProcess
    rpc: PluginRpcServer
  } {
    const rpc = new PluginRpcServer()
    const host = new PluginHostProcess(rpc, {
      bootstrapPathOverride: MOCK_BOOTSTRAP,
      // MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约
      execArgv: ['--import', NOOP_ESM_LOADER],
      disconnectGraceMs: TEST_DISCONNECT_GRACE_MS,
    })
    return { host, rpc }
  }

  describe('PluginHostProcess', () => {
    const hosts: PluginHostProcess[] = []

    beforeEach(() => {
      // fake timers：disconnect grace 定时器（宿主分流逻辑的组成部分）由测试确定性推进，
      // 不依赖真实挂钟——桩的进程事件同步 emit，无需等待传播。
      vi.useFakeTimers()
      // 每测试清零 fork 记录：fakePluginChildren() 下标按本测试创建顺序对齐
      resetPluginHostStubs()
    })

    afterEach(async () => {
      // 兜底清理残留子进程（即使用例已 shutdown 也无害；桩的 kill 同步 emit exit）
      await Promise.allSettled(hosts.map((h) => h.shutdown()))
      hosts.length = 0
      vi.useRealTimers()
    })

    function track(host: PluginHostProcess): PluginHostProcess {
      hosts.push(host)
      return host
    }

    // ── TC1: sandbox 每插件独占子进程 ─────────────────────────────
    it('TC1: assignProcess for sandbox creates unique process per plugin', async () => {
      const { host, rpc } = createHost()
      track(host)

      const processId1 = await host.assignProcess('plugin-a', 'sandbox')
      const processId2 = await host.assignProcess('plugin-b', 'sandbox')

      expect(processId1).not.toBe(processId2)
      expect(processId1.startsWith('sandbox-')).toBeTruthy()
      expect(processId2.startsWith('sandbox-')).toBeTruthy()

      const handle1 = host.getProcessHandleById(processId1)
      const handle2 = host.getProcessHandleById(processId2)
      expect(handle1).toBeTruthy()
      expect(handle2).toBeTruthy()
      expect(handle1!.trustLevel).toBe('sandbox')
      expect(handle2!.trustLevel).toBe('sandbox')
      expect(handle1!.status).toBe('active')
      expect(handle2!.status).toBe('active')
      // pid 来自 child.pid（桩给出确定性非零 pid；`?? -1` 兜底分支不命中）
      expect(handle1!.pid).toBeGreaterThan(0)
      expect(rpc).toBeTruthy()
    })

    // ── TC2: trusted 复用子进程 ──────────────────────────────────
    it('TC2: assignProcess for trusted shares process (≤10 plugins)', async () => {
      const { host } = createHost()
      track(host)

      const processId1 = await host.assignProcess('tp-1', 'trusted')
      const processId2 = await host.assignProcess('tp-2', 'trusted')
      const processId3 = await host.assignProcess('tp-3', 'trusted')

      expect(processId1).toBe(processId2)
      expect(processId2).toBe(processId3)

      const handle = host.getProcessHandleById(processId1)!
      expect(handle.trustLevel).toBe('trusted')
      expect(handle.pluginIds.length).toBe(3)
    })

    // ── TC3: loadPlugin IPC 往返（桩回路）────────────────────────
    it('TC3: loadPlugin resolves on loaded from mock child process', async () => {
      const { host } = createHost()
      track(host)

      const processId = await host.assignProcess('load-test', 'sandbox')
      await expect(
        host.loadPlugin(processId, 'load-test', '/fake/plugin.js', 'sandbox'),
      ).resolves.toBeUndefined()
    })

    // ── TC4: rpcServer 接入（invoke 往返经 child.send）────────────
    it('TC4: rpcServer invoke round-trips through child IPC', async () => {
      const { host, rpc } = createHost()
      track(host)

      const processId = await host.assignProcess('rpc-test', 'sandbox')
      const result = await rpc.invoke(processId, 'test.method', {})
      expect(result).toBeNull()
    })

    // ── TC5: 崩溃检测（exit 非 0）────────────────────────────────
    it('TC5: crash callback invoked when child exits non-zero', async () => {
      const { host } = createHost()
      track(host)

      const crashes: Array<{ processId: string; pluginIds: string[]; error: string }> = []
      host.setCrashCallback((processId, pluginIds, error) => {
        crashes.push({ processId, pluginIds, error })
      })

      const processId = await host.assignProcess('crash-test', 'sandbox')
      const handle = host.getProcessHandle('crash-test')!
      // 桩按 mock bootstrap 协议响应 crash → 自退 exit(1)：disconnect → exit 事件序
      // 同步 emit，宿主 exit handler 当场完成崩溃分流（真实传播由集成组覆盖）
      handle.postMessage({ type: 'crash' })

      expect(crashes.length).toBe(1)
      expect(crashes[0].processId).toBe(processId)
      expect(crashes[0].pluginIds).toContain('crash-test')
      // R3: disconnect 先于 exit 触发 crash（IPC channel 先断），error 为两事件之一
      expect(crashes[0].error).toMatch(/exit|disconnect/)
      // RT-6#5：crash 收尾即删 processes Map——崩溃进程不再作为幽灵条目滞留（对齐
      // handleProcessCleanExit 的清理口径），只读反查路径不再命中已崩进程。
      expect(host.getProcessHandleById(processId)).toBeUndefined()
    })

    // ── TC6: 崩溃检测（fatal_error 消息）─────────────────────────
    it('TC6: crash callback invoked on fatal_error message', async () => {
      const { host } = createHost()
      track(host)

      const crashes: Array<{ processId: string; pluginIds: string[]; error: string }> = []
      host.setCrashCallback((processId, pluginIds, error) => {
        crashes.push({ processId, pluginIds, error })
      })

      const processId = await host.assignProcess('fatal-test', 'sandbox')
      const handle = host.getProcessHandle('fatal-test')!
      handle.postMessage({ type: 'fatal' })

      expect(crashes.length).toBe(1)
      expect(crashes[0].error).toContain('mock fatal error')
      // RT-6#5：crash 收尾即删 processes Map（幽灵条目不再滞留，见 TC5 同款注释）
      expect(host.getProcessHandleById(processId)).toBeUndefined()
    })

    // ── TC8: terminateProcess 清理 ───────────────────────────────
    it('TC8: terminateProcess removes handle and does not trigger crash callback', async () => {
      const { host, rpc } = createHost()
      track(host)

      const crashes: Array<{ processId: string; pluginIds: string[]; error: string }> = []
      host.setCrashCallback((processId, pluginIds, error) => {
        crashes.push({ processId, pluginIds, error })
      })

      const processId = await host.assignProcess('term-test', 'sandbox')
      expect(host.getProcessHandleById(processId)).toBeTruthy()

      // 观测 disconnect 确已到达（kill → 通道关闭的真实事件序）：它是 grace 定时器存在
      // 的前提——没有它，下方「到期不报」会是空过
      let disconnected = false
      fakePluginChildren()[0].on('disconnect', () => { disconnected = true })

      await host.terminateProcess(processId)
      expect(disconnected).toBe(true)

      expect(host.getProcessHandleById(processId)).toBeUndefined()
      // rpcServer 已 unregister：invoke 应报 Worker not found
      await expect(rpc.invoke(processId, 'test.method', {})).rejects.toThrow(/not found/i)

      // kill 触发的 exit/disconnect 已同步传播；再确定性推进过 grace 定时器到期：
      // pre-mark 的 terminated 检查与 disconnect 幂等检查都必须拦住回调
      await vi.advanceTimersByTimeAsync(GRACE_ADVANCE_MS)
      expect(crashes.length).toBe(0)
    })

    // ── TC9: getProcessHandle 按 pluginId 查找 ───────────────────
    it('TC9: getProcessHandle returns handle with postMessage', async () => {
      const { host } = createHost()
      track(host)

      const processId = await host.assignProcess('find-test', 'sandbox')
      const handle = host.getProcessHandle('find-test')
      expect(handle).toBeTruthy()
      expect(handle!.processId).toBe(processId)
      expect(typeof handle!.postMessage).toBe('function')

      // 未分配插件返回 undefined
      expect(host.getProcessHandle('unknown-plugin')).toBeUndefined()
    })

    // ── TC10: shutdown 清理全部 ──────────────────────────────────
    it('TC10: shutdown terminates all child processes', async () => {
      const { host } = createHost()
      track(host)

      await host.assignProcess('s-1', 'sandbox')
      await host.assignProcess('s-2', 'sandbox')
      await host.assignProcess('s-3', 'trusted')

      const allHandles = [host.getProcessHandleById('sandbox-s-1'), host.getProcessHandleById('sandbox-s-2')]
      expect(allHandles.length).toBe(2)

      await host.shutdown()

      // shutdown 后所有 handle 已清空
      expect(host.getProcessHandleById('sandbox-s-1')).toBeUndefined()
      expect(host.getProcessHandleById('sandbox-s-2')).toBeUndefined()
      expect(host.getProcessHandleById('trusted-1')).toBeUndefined()
    })

    // ── TC11: 崩溃回调幂等检查 ───────────────────────────────────
    it('TC11: crash callback fires exactly once (idempotent guard)', async () => {
      const { host } = createHost()
      track(host)

      const crashes: Array<{ processId: string; pluginIds: string[]; error: string }> = []
      host.setCrashCallback((processId, pluginIds, error) => {
        crashes.push({ processId, pluginIds, error })
      })

      const processId = await host.assignProcess('idem-test', 'sandbox')
      const handle = host.getProcessHandle('idem-test')!
      // 观测 disconnect 确已到达（自退 exit(1) 前通道先断的真实事件序）：保证下方
      // grace 定时器真实存在并被推进，避免「到期不重复报」空过
      let disconnected = false
      fakePluginChildren()[0].on('disconnect', () => { disconnected = true })
      handle.postMessage({ type: 'crash' })

      expect(disconnected).toBe(true)
      expect(crashes.length).toBe(1)

      // 确定性推进过 grace 定时器到期：到期后幂等检查必须拦住第二次回调
      await vi.advanceTimersByTimeAsync(GRACE_ADVANCE_MS)
      expect(crashes.length).toBe(1)
    })

    // ── TC12: terminateProcess 对不存在进程是 no-op ───────────────
    it('TC12: terminateProcess is no-op for non-existent process', async () => {
      const { host } = createHost()
      track(host)

      await expect(host.terminateProcess('nonexistent-process')).resolves.toBeUndefined()
    })

    // ── TC13: 崩溃→重建竞态（M6a-03）────────────────────────────
    it('TC13: rebuild after crash — stale child late exit must not crash new handle', async () => {
      const { host } = createHost()
      track(host)

      const crashes: Array<{ processId: string; pluginIds: string[]; error: string }> = []
      host.setCrashCallback((processId, pluginIds, error) => {
        crashes.push({ processId, pluginIds, error })
      })

      // 1. 首启 + fatal_error（mock 发 fatal 后旧 child 被宿主 SIGKILL 兜底终结）
      const processId = await host.assignProcess('rebuild-test', 'sandbox')
      const handle = host.getProcessHandle('rebuild-test')!
      handle.postMessage({ type: 'fatal' })

      expect(crashes.length).toBe(1)
      // RT-6#5：crash 收尾即删两处 Map（processes + processInstances）——旧 child 的监听
      // 已在崩溃路径摘除（removeAllListeners），迟到 exit 无法再触碰任何 handle
      // （M6a-03 语义由 removeAllListeners 承接，不再依赖 createProcess 的残留清理 lookup）。
      expect(host.getProcessHandleById(processId)).toBeUndefined()

      // 2. 崩溃后重激活（crash 路径是插件系统明确支持的路径）→ 走 createProcess 重建
      const processId2 = await host.assignProcess('rebuild-test', 'sandbox')
      expect(processId2).toBe(processId)
      const rebuilt = host.getProcessHandleById(processId)
      expect(rebuilt).toBeTruthy()
      expect(rebuilt!.status).toBe('active')
      expect(rebuilt!.pid).toBeGreaterThan(0)

      // 3. 旧 child 晚到的 exit：原 fixture 的 300ms setTimeout 退出会被崩溃路径的 SIGKILL
      //    抢占（从未真正到达），原 600ms 采样窗只是「等一个大概率不来的事件」。改为测试
      //    显式驱动迟到 exit——修复前旧 child 监听残留，exit 会命中新 handle（健康进程被
      //    误标 crashed + crash 回调重复触发）。
      const staleChild = fakePluginChildren()[0]
      staleChild.emitLateExit(1)
      expect(host.getProcessHandleById(processId)!.status).toBe('active')
      expect(crashes.length).toBe(1)
    })

    // ── TC14: sandbox 复用分支 pluginIds 去重（M6a-06）───────────
    it('TC14: sandbox reassign of same plugin does not duplicate pluginIds', async () => {
      const { host } = createHost()
      track(host)

      const processId = await host.assignProcess('dup-test', 'sandbox')
      // 复用 active 进程分支：第二次 assign 同一插件（deactivate 不 terminate 进程的
      // 真实路径）不应重复 push pluginIds
      const again = await host.assignProcess('dup-test', 'sandbox')
      expect(again).toBe(processId)

      const handle = host.getProcessHandleById(processId)!
      expect(handle.pluginIds).toEqual(['dup-test'])
    })
  })
});

// ════════════════ 来源: plugin-host-process-exit.test.ts ════════════════
describe('plugin-host-process-exit', () => {
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
   * - 真实子进程退出的事件传播时序归集成组（TAIJI_TEST_INTEGRATION 门控）覆盖。
   *
   * 运行命令: pnpm --filter @taiji/runtime exec vitest run test/plugin-host-process-exit.test.ts
   */




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
});

// ════════════════ 来源: plugin-host-sandbox-wiring.test.ts ════════════════
describe('plugin-host-sandbox-wiring', () => {
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
   * - 真实 fork 的进程级行为归集成组（TAIJI_TEST_INTEGRATION 门控）覆盖。
   */


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
});

// ════════════════ 来源: plugin-host.test.ts ════════════════
describe('plugin-host', () => {
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
   * 归集成组（TAIJI_TEST_INTEGRATION 门控）覆盖，不在单测层断言。
   *
   * 运行命令: pnpm --filter @taiji/runtime exec vitest run test/plugin-host.test.ts
   */




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
      // 桩的 terminate() 同步 emit exit（真实线程退出传播由集成组覆盖）：
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
});

// ════════════════ 来源: plugin-tool-execution.test.ts ════════════════
describe('plugin-tool-execution', () => {
  /**
   * Tool Execution via RPC — TDD tests for BG1 Task 1（pi1-disposition-chat-flow D7 收窄）
   *
   * [pi1-disposition-chat-flow D7①] PluginService.handleBridgeToolExecute 链路段与工具执行
   * 诚实超时文案段随 plugin-bridge 整体退役删除（断言对象已无生产载体）。
   * 保留：PluginRpcServer.invoke 直测、resolveToolTimeoutMs 分支表（函数迁驻 tool-timeout，
   * commands-executor 命令超时取值链消费）、P-9 迟到回包丢弃路径（改经 rpcServer.invoke 直调
   * 驱动，PendingTracker 行为不变）。
   */


  // ══════════════════════════════════════════════════════════════════
  // PluginRpcServer.invoke
  // ══════════════════════════════════════════════════════════════════

  describe('PluginRpcServer.invoke', () => {
    let rpcServer: PluginRpcServer

    beforeEach(() => {
      rpcServer = new PluginRpcServer()
    })

    it('sends RPC request and resolves on response', async () => {
      // Mock a worker port that captures messages
      const sentMessages: unknown[] = []
      const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
      rpcServer.registerWorker('worker-1', mockPort)

      // Invoke in background
      const invokePromise = rpcServer.invoke('worker-1', 'plugin.tool.execute', { toolName: 'hello' })

      // Should have sent a request message
      expect(sentMessages).toHaveLength(1)
      const sent = sentMessages[0] as { type: string; request: Record<string, unknown> }
      expect(sent.type).toBe('rpc')
      expect(sent.request.method).toBe('plugin.tool.execute')
      expect(sent.request.params).toEqual({ toolName: 'hello' })
      expect(typeof sent.request.id).toBe('number')

      // Simulate response from worker
      const requestId = sent.request.id as number
      rpcServer.handleResponse({ jsonrpc: '2.0', id: requestId, result: { content: 'Hello!', isError: false } })

      const result = await invokePromise
      expect(result).toEqual({ content: 'Hello!', isError: false })
    })

    it('rejects with error response from worker', async () => {
      const sentMessages: unknown[] = []
      const mockPort = { postMessage: (msg: unknown) => { sentMessages.push(msg) } }
      rpcServer.registerWorker('worker-1', mockPort)

      const invokePromise = rpcServer.invoke('worker-1', 'test.method', {})

      const sent = sentMessages[0] as { request: Record<string, unknown> }
      const requestId = sent.request.id as number

      // Simulate error response
      rpcServer.handleResponse({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32603, message: 'Internal error' },
      })

      await expect(invokePromise).rejects.toThrow('Internal error')
    })

    it('throws for unknown worker', async () => {
      await expect(
        rpcServer.invoke('unknown-worker', 'test.method', {}),
      ).rejects.toThrow('Worker not found')
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // resolveToolTimeoutMs — D1 取值链全分支
  // ══════════════════════════════════════════════════════════════════

  /** Node setTimeout 域上界 2^31-1（tool-timeout 内 MAX_TIMER_DELAY_MS 的值；
   * 该常量未导出，测试以字面锚定规格，漂移即红）。 */
  const TIMER_DOMAIN_MAX_MS = 2_147_483_647

  describe('resolveToolTimeoutMs', () => {
    it('uses a valid positive declaration as-is (clamp no-op below the limit)', () => {
      expect(resolveToolTimeoutMs(1)).toBe(1)
      expect(resolveToolTimeoutMs(10_000)).toBe(10_000)
      expect(resolveToolTimeoutMs(600_000)).toBe(600_000)
    })

    it('clamps oversized declarations to the Node timer domain limit', () => {
      expect(resolveToolTimeoutMs(TIMER_DOMAIN_MAX_MS)).toBe(TIMER_DOMAIN_MAX_MS)
      expect(resolveToolTimeoutMs(TIMER_DOMAIN_MAX_MS + 1)).toBe(TIMER_DOMAIN_MAX_MS)
      expect(resolveToolTimeoutMs(5_000_000_000)).toBe(TIMER_DOMAIN_MAX_MS)
      expect(resolveToolTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(TIMER_DOMAIN_MAX_MS)
    })

    it('treats <=0 and ±Infinity as explicit opt-out (clamped upper bound ≈ no limit)', () => {
      expect(resolveToolTimeoutMs(0)).toBe(TIMER_DOMAIN_MAX_MS)
      expect(resolveToolTimeoutMs(-1)).toBe(TIMER_DOMAIN_MAX_MS)
      expect(resolveToolTimeoutMs(-60_000)).toBe(TIMER_DOMAIN_MAX_MS)
      expect(resolveToolTimeoutMs(Number.POSITIVE_INFINITY)).toBe(TIMER_DOMAIN_MAX_MS)
      expect(resolveToolTimeoutMs(Number.NEGATIVE_INFINITY)).toBe(TIMER_DOMAIN_MAX_MS)
    })

    it('falls back to the default for NaN / undefined (dirty values never disarm the watchdog)', () => {
      expect(resolveToolTimeoutMs(Number.NaN)).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
      expect(resolveToolTimeoutMs(undefined)).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
      expect(resolveToolTimeoutMs()).toBe(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // P-9：迟到回包 miss 不炸（fake timers 驱动真实 invoke 链）
  // ══════════════════════════════════════════════════════════════════
});
