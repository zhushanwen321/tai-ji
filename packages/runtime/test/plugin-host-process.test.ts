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
 * - 真实 fork 的进程级行为归集成轨（TAIJI_TEST_INTEGRATION 门控）覆盖。
 *
 * 运行命令: pnpm --filter @taiji/runtime exec vitest run test/plugin-host-process.test.ts
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
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
    // 同步 emit，宿主 exit handler 当场完成崩溃分流（真实传播由集成轨覆盖）
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
