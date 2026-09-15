/**
 * PluginHostProcess 子进程退出分流回归测试（L-5）
 *
 * 设计基线：exit code 0 是「正常退出」不是崩溃——不触发 onCrash（即无假崩溃
 * toast / CRASHED 标记 / crashCounts 累积），但 handle 必须清理；disconnect 先于
 * exit 到达（实测事件序 disconnect → exit，exit 晚约一个事件循环圈），权威分流
 * 在 exit handler，disconnect 只做 grace 兜底：仅存活进程断开 IPC 才报 crash。
 * 真实 fork 子进程（fixtures/mock-bootstrap-exit0.cjs 受控退出/受控断开）。
 *
 * 运行命令: cd packages/runtime && npx vitest run test/plugin-host-process-exit.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHostProcess } from '../src/services/plugin-service/plugin-host-process.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXIT_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap-exit0.cjs')
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

// 与 src/services/plugin-service/plugin-host-process.ts 的 DISCONNECT_GRACE_MS 保持一致。
// 「不误报」断言的等待必须大于此窗口：否则区分不了「不会报」与「还没到报的时机」
const DISCONNECT_GRACE_MS = 250

describe('PluginHostProcess exit 分流（L-5）', () => {
  let host: PluginHostProcess
  let rpc: PluginRpcServer
  // 泛型显式对齐 CrashCallback 签名（裸 vi.fn 推导不出参数形态，tsc 不过）
  let onCrash: ReturnType<typeof vi.fn<(processId: string, pluginIds: string[], error: string) => void>>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    host = new PluginHostProcess(rpc, {
      bootstrapPathOverride: EXIT_MOCK,
      // MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约
      execArgv: ['--import', NOOP_ESM_LOADER],
    })
    onCrash = vi.fn<(processId: string, pluginIds: string[], error: string) => void>()
    host.setCrashCallback(onCrash)
  })

  afterEach(async () => {
    await host.shutdown()
  })

  it('a) 子进程 exit(0)：onCrash 不触发、handle 清理、无 crashed 残留', async () => {
    const processId = await host.assignProcess('clean-exit', 'sandbox')
    await host.loadPlugin(processId, 'clean-exit', '/fake/plugin.js', 'sandbox')

    host.getProcessHandle('clean-exit')!.postMessage({ type: 'exit0' })

    // exit(0) → exit handler 走 clean exit 分流：handle 从宿主清除
    await vi.waitFor(() => {
      expect(host.getProcessHandleById(processId)).toBeUndefined()
    }, { timeout: 3000 })

    // 再等超过 disconnect grace 窗口：兜底定时器到期后也不得补报 crash
    // （区分「不会报」与「还没到报的时机」）
    await new Promise((r) => setTimeout(r, DISCONNECT_GRACE_MS + 200))
    expect(onCrash).not.toHaveBeenCalled()
    // 反向索引同步清理：getProcessHandle 不再指向死进程（否则新分配会 child.send 落空）
    expect(host.getProcessHandle('clean-exit')).toBeUndefined()
    expect(host.getAllProcesses().find((h) => h.processId === processId)).toBeUndefined()
  }, 10_000)

  it('b) 存活进程主动断 IPC：grace 后 onCrash 触发（真异常不被吞）', async () => {
    const processId = await host.assignProcess('live-disconnect', 'sandbox')
    await host.loadPlugin(processId, 'live-disconnect', '/fake/plugin.js', 'sandbox')

    // fixture 收到后 process.disconnect() 且进程保持存活（无 exit 事件跟随）
    host.getProcessHandle('live-disconnect')!.postMessage({ type: 'ipc-disconnect' })

    // grace 窗口（250ms）+ 轮询余量内应触发 onCrash——延迟分流没把真异常吞掉
    await vi.waitFor(() => expect(onCrash).toHaveBeenCalledTimes(1), { timeout: 3000 })
    const [reportedId, pluginIds, error] = onCrash.mock.calls[0]
    expect(reportedId).toBe(processId)
    expect(pluginIds).toContain('live-disconnect')
    expect(String(error)).toMatch(/disconnect/i)
    expect(host.getProcessHandleById(processId)!.status).toBe('crashed')
  }, 10_000)

  it('c) terminate 路径（pre-mark terminated 后 kill）：onCrash 仍不触发', async () => {
    const processId = await host.assignProcess('term-guard', 'sandbox')
    await host.loadPlugin(processId, 'term-guard', '/fake/plugin.js', 'sandbox')

    await host.terminateProcess(processId)
    expect(host.getProcessHandleById(processId)).toBeUndefined()

    // 等待 kill 触发的 exit/disconnect 事件传播 + grace 窗口过期：pre-mark 的
    // terminated 守卫与 disconnect 幂等检查都不应误报 crash
    await new Promise((r) => setTimeout(r, DISCONNECT_GRACE_MS + 300))
    expect(onCrash).not.toHaveBeenCalled()
  }, 10_000)
})
