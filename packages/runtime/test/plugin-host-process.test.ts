/**
 * PluginHostProcess 单元测试（fork 版宿主侧）
 *
 * 使用 fixtures/plugin-bootstrap-process.mock.cjs 作为 fork 目标（bootstrapPathOverride 注入），
 * fork 真实子进程覆盖 IPC 往返 / 崩溃检测 / 超时清理。
 *
 * 运行命令: pnpm --filter @taiji/runtime test -- test/plugin-host-process.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHostProcess } from '../src/services/plugin-service/plugin-host-process.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK_BOOTSTRAP = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

const DEFAULT_LOAD_TIMEOUT_MS = 10_000

function createHost(options?: { loadTimeoutMs?: number }): {
  host: PluginHostProcess
  rpc: PluginRpcServer
} {
  const rpc = new PluginRpcServer()
  const host = new PluginHostProcess(rpc, {
    bootstrapPathOverride: MOCK_BOOTSTRAP,
    // MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约
    execArgv: ['--import', NOOP_ESM_LOADER],
    loadTimeoutMs: options?.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
  })
  return { host, rpc }
}

/** 轮询等待条件成立（上限 timeoutMs），避免固定 sleep 猜时序 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('PluginHostProcess', () => {
  const hosts: PluginHostProcess[] = []

  afterEach(async () => {
    // 兜底清理残留子进程（即使用例已 shutdown 也无害）
    await Promise.allSettled(hosts.map((h) => h.shutdown()))
    hosts.length = 0
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

  // ── TC3: loadPlugin IPC 往返（真实 fork）─────────────────────
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
    const result = await rpc.invoke(processId, 'test.method', {}, 2000)
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
    handle.postMessage({ type: 'crash' })

    await waitFor(() => crashes.length >= 1)
    expect(crashes[0].processId).toBe(processId)
    expect(crashes[0].pluginIds).toContain('crash-test')
    // R3: disconnect 先于 exit 触发 crash（IPC channel 先断），error 为两事件之一
    expect(crashes[0].error).toMatch(/exit|disconnect/)
    // RT-6#5：crash 收口即删 processes Map——崩溃进程不再作为幽灵条目滞留（对齐
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

    await waitFor(() => crashes.length >= 1)
    expect(crashes[0].error).toContain('mock fatal error')
    // RT-6#5：crash 收口即删 processes Map（幽灵条目不再滞留，见 TC5 同款注释）
    expect(host.getProcessHandleById(processId)).toBeUndefined()
  })

  // ── TC7: loadPlugin 超时清理 ─────────────────────────────────
  it('TC7: loadPlugin rejects on timeout and cleans up the child', async () => {
    const { host } = createHost({ loadTimeoutMs: 500 })
    track(host)

    const processId = await host.assignProcess('hang-test', 'sandbox')
    const handle = host.getProcessHandle('hang-test')!
    // 先让 mock 进入 hang 态（后续 load 不响应）
    handle.postMessage({ type: 'hang' })

    await expect(host.loadPlugin(processId, 'hang-test', '/fake/hang.js', 'sandbox')).rejects.toThrow(
      /timeout/i,
    )

    // E2: 宿主清理该子进程
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

    await host.terminateProcess(processId)

    expect(host.getProcessHandleById(processId)).toBeUndefined()
    // rpcServer 已 unregister：invoke 应报 Worker not found
    await expect(rpc.invoke(processId, 'test.method', {}, 100)).rejects.toThrow(/not found/i)

    // 等待事件传播，terminated 守卫应阻止 crash 回调
    await new Promise((resolve) => setTimeout(resolve, 150))
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

  // ── TC11: 崩溃回调幂等守卫 ───────────────────────────────────
  it('TC11: crash callback fires exactly once (idempotent guard)', async () => {
    const { host } = createHost()
    track(host)

    const crashes: Array<{ processId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((processId, pluginIds, error) => {
      crashes.push({ processId, pluginIds, error })
    })

    const processId = await host.assignProcess('idem-test', 'sandbox')
    const handle = host.getProcessHandle('idem-test')!
    handle.postMessage({ type: 'crash' })

    await waitFor(() => crashes.length >= 1)

    // 等足够时间让后续事件（如额外 exit/disconnect）传播，守卫应阻止重复回调
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(crashes.length).toBe(1)
  })

  // ── TC12: terminateProcess 对不存在进程是 no-op ──────────────
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

    // 1. 首启 + fatal_error（mock 发 fatal 后延迟 300ms 才退出，留出重建窗口）
    const processId = await host.assignProcess('rebuild-test', 'sandbox')
    const handle = host.getProcessHandle('rebuild-test')!
    handle.postMessage({ type: 'fatalThenExit' })

    await waitFor(() => crashes.length >= 1)
    // RT-6#5：crash 收口即删两处 Map（processes + processInstances）——旧 child 的监听
    // 已在崩溃路径摘除，迟到 exit 无法再触碰任何 handle（M6a-03 语义由 removeAllListeners
    // 承接，不再依赖 createProcess 的残留清理 lookup）。
    expect(host.getProcessHandleById(processId)).toBeUndefined()

    // 2. 崩溃后重激活（crash 路径是插件系统明确支持的路径）→ 走 createProcess 重建
    const processId2 = await host.assignProcess('rebuild-test', 'sandbox')
    expect(processId2).toBe(processId)
    const rebuilt = host.getProcessHandleById(processId)
    expect(rebuilt).toBeTruthy()
    expect(rebuilt!.status).toBe('active')
    expect(rebuilt!.pid).toBeGreaterThan(0)

    // 3. 等旧进程晚到的 exit 传播：修复前旧 child 监听残留，exit 会命中新 handle
    //    （健康进程被误标 crashed + crash 回调重复触发）；修复后 createProcess 已
    //    removeAllListeners 旧 child + handleProcessCrash kill 兜底，不应再有任何影响
    await new Promise((resolve) => setTimeout(resolve, 600))
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
