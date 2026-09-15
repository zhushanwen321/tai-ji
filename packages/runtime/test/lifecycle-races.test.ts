/**
 * 生命周期竞态回归（spec §3.3 D6 / S2-W1..W4）
 *
 * 覆盖缺陷组：
 * 1. LC-C1（并发开关错配，W2）：
 *    - pendingReplies 复合键 `${pluginId}:${op}`——activate/deactivate 并发在飞时
 *      activated/deactivated 回复精确匹配各自 op 的 entry，不张冠李戴
 *    - deactivatePlugin 对 ACTIVATING 态的取消标志（激活完成 → finally 反卷停用）
 *    - loadPlugin 回复按 pluginId 匹配——同宿主并发加载 N 插件不互相消费回复
 * 2. LC-C3（回调异常）：宿主消息回调内 handler 抛错被 safe-dispatch 捕获记日志，
 *    不冒泡为 uncaughtException，后续正常消息仍处理（W1，宿主层）；
 *    W4 补 rpcClient 层——Worker 内 notification 分发到各插件 handler 逐个兜底
 * 3. LC-U1-ENTRY（入口防御，W1）：null / 非对象 / 超大非对象消息不炸宿主
 * 4. LC-U1（rebuild/fatal/exit-0 约束，W3+W4）：
 *    - fatal_error 路径 terminate 存活线程（崩溃处理对称化）
 *    - exit code 0 清理 handle 不留僵尸（区分正常退出与崩溃）
 *    - rebuild 冷却 timer 保存引用 + unref + 受 shutdown 清理（关停后不复活）
 *    - crashCounts rebuild 成功 60s 无新崩溃清零（fake timers）
 *    - onRebuilt 只复活 CRASHED 态插件（用户已 disable/uninstall 跳过）
 *
 * 测试层级说明：按任务边界用「真实 PluginHost + PluginActivator + mock worker 通道」
 * （workerBootstrapOverride / bootstrapPathOverride 注入现有 fixtures）。renderer
 * 广播层（plugin:statusChange）挂在 PluginService 之上，本层无该链路——广播效果的
 * 等价物是状态终态断言。fork 宿主侧的畸形消息用例需要子进程真实发送 null/大字符串，
 * 现有 fixtures 不提供该分支，故在 tmpdir 运行时生成一次性 mock 子进程脚本
 * （不触碰仓库文件）。
 *
 * 运行命令: cd packages/runtime && npx vitest run test/lifecycle-races.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { PluginHost, safeDispatchHostMessage } from '../src/services/plugin-service/plugin-host.js'
import { PluginHostProcess } from '../src/services/plugin-service/plugin-host-process.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginDescriptor, WorkerToHostMessage } from '../src/services/plugin-service/plugin-types.js'
import { handleMessage, setPostMessage, workerRpcClient } from '../src/services/plugin-service/plugin-bootstrap.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { IMessageBroker } from '../src/interfaces.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** trusted Worker 线程 mock（真实 Worker + 即时回复，回复带 pluginId） */
const WORKER_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')

/** 一次性 mock 子进程脚本：真实 IPC 上发畸形消息 + 按 pluginId 回 load 结果（lc-fail 报错） */
const MALFORMED_CHILD_SCRIPT = `'use strict'
process.on('message', (msg) => {
  const m = msg || {}
  if (m.type === 'load') {
    if (m.pluginId === 'lc-fail') process.send({ type: 'error', pluginId: m.pluginId, error: 'load failed (lc-fail)' })
    else process.send({ type: 'loaded', pluginId: m.pluginId })
  } else if (m.type === 'send-null') {
    process.send(null)
  } else if (m.type === 'send-big') {
    process.send('x'.repeat(2 * 1024 * 1024))
  }
})
`

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'race-plugin',
    version: '1.0.0',
    displayName: 'Race Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'trusted',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/race-plugin/index.js',
    source: 'built-in',
    extensionDependencies: [],
    ...overrides,
  }
}

/** 轮询等待条件成立（上限 timeoutMs），避免固定 sleep 猜时序 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('生命周期竞态（lifecycle races）', () => {
  let warnCalls: string[][] = []
  let errorCalls: unknown[][] = []

  beforeEach(() => {
    warnCalls = []
    errorCalls = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnCalls.push(args.map(String))
    })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorCalls.push(args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ── LC-C1: 真实链路 20 轮并发竞态 ──────────────────────────────
  it('LC-C1: 同一 pluginId 并发 activate/deactivate/toggle 20 轮毫秒间隔——终态与操作序列一致、无假超时、无回复错配', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    const activator = new PluginActivator()
    // 生产同构 wiring（plugin-service.ts 的 setReplyCallback → handleWorkerReply）
    const replies: Array<Record<string, unknown>> = []
    host.setReplyCallback((msg) => {
      const m = msg as Record<string, unknown>
      if (m.type === 'activated' || m.type === 'deactivated') replies.push(m)
      activator.handleWorkerReply(msg as WorkerToHostMessage)
    })

    const pid = 'race-plugin'
    activator.registerDescriptors([makeDescriptor({ pluginId: pid })])

    // 记录发往 Worker 的生命周期消息：mock 对每条 activate/deactivate 恰回一次成功
    // 回复且 Worker 按消息序（IPC FIFO）处理——末次消息类型 = Worker 内真实激活态
    const sentLifecycle: string[] = []
    const origGetWorkerHandle = host.getWorkerHandle.bind(host)
    host.getWorkerHandle = (pluginId: string) => {
      const h = origGetWorkerHandle(pluginId)
      if (!h) return h
      return {
        workerId: h.workerId,
        postMessage: (message: unknown) => {
          const t = (message as { type?: unknown }).type
          if (t === 'activate' || t === 'deactivate') sentLifecycle.push(t)
          h.postMessage(message)
        },
      }
    }

    const t0 = Date.now()
    const ops: Array<Promise<void>> = []
    try {
      for (let round = 0; round < 20; round++) {
        const phase = round % 3
        if (phase === 0) {
          ops.push(activator.activatePlugin(pid, { type: 'onStartupFinished' }, host))
        } else if (phase === 1) {
          ops.push(activator.deactivatePlugin(pid, host))
        } else {
          // toggle 语义（对齐 plugin-service.togglePlugin：按当前状态反相驱动）
          if (activator.getState(pid) !== 'ACTIVE') {
            ops.push(activator.activatePlugin(pid, { type: 'onStartupFinished' }, host))
          } else {
            ops.push(activator.deactivatePlugin(pid, host))
          }
        }
        await new Promise((r) => setTimeout(r, 1)) // 毫秒间隔制造真实交错
      }
      await Promise.allSettled(ops)

      const elapsed = Date.now() - t0

      // 1) 终态为稳定态（不卡在 ACTIVATING/DEACTIVATING）
      const finalState = activator.getState(pid)
      expect(['ACTIVE', 'UNLOADED']).toContain(finalState)

      // 2) 无幽灵态：宿主终态 = Worker 真实激活态（末次生命周期消息决定）
      expect(sentLifecycle.length).toBeGreaterThan(0)
      const lastMsg = sentLifecycle[sentLifecycle.length - 1]!
      expect(finalState).toBe(lastMsg === 'activate' ? 'ACTIVE' : 'UNLOADED')
      expect(activator.getActivePlugins()).toEqual(finalState === 'ACTIVE' ? [pid] : [])

      // 3) 无回复错配/丢失：每条发出的消息恰收到一次对应回复
      expect(replies.filter(m => m.type === 'activated')).toHaveLength(sentLifecycle.filter(t => t === 'activate').length)
      expect(replies.filter(m => m.type === 'deactivated')).toHaveLength(sentLifecycle.filter(t => t === 'deactivate').length)

      // 4) 无假超时：全部经真实回复完成（旧单键实现的假超时会让 deactivate 挂满
      //    DEACTIVATE_TIMEOUT_MS=5s / activate 挂满 ACTIVATE_TIMEOUT_MS=30s）
      expect(elapsed).toBeLessThan(5_000)

      // 5) 竞态后状态机仍可正常驱动（无卡死 pending、无残留中间态）
      await activator.activatePlugin(pid, { type: 'onStartupFinished' }, host)
      expect(activator.getState(pid)).toBe('ACTIVE')
      await activator.deactivatePlugin(pid, host)
      expect(activator.getState(pid)).toBe('UNLOADED')
    } finally {
      await host.shutdown()
    }
  })

  // ── LC-C1: 复合键确定性场景（fake timers 推进验证无假超时）───────
  it('LC-C1: pendingReplies 复合键——deactivate 与 re-activate 并发在飞时 deactivated/activated 回复各归各（fake timers 推进 30s 无假超时副作用）', async () => {
    vi.useFakeTimers()
    const flush = () => vi.advanceTimersByTimeAsync(0)

    const activator = new PluginActivator()
    activator.registerDescriptors([makeDescriptor({ pluginId: 'p' })])

    const sent: Array<{ type: string; pluginId: string }> = []
    const scriptedHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('worker-1')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'worker-1',
        postMessage: (m: unknown) => { sent.push(m as { type: string; pluginId: string }) },
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    // 1) 先激活到 ACTIVE（测试显式投递回复，不依赖通道时序）
    const act1 = activator.activatePlugin('p', { type: 'onStartupFinished' }, scriptedHost)
    await flush()
    activator.handleWorkerReply({ type: 'activated', pluginId: 'p' })
    await act1
    expect(activator.getState('p')).toBe('ACTIVE')

    // 2) 并发窗口：deactivate 在飞（DEACTIVATING）+ 立即重入 activate——
    //    旧实现两 entry 以 pluginId 单键互相覆盖，是回复错配的触发场景
    let deactDone = false
    const deact = activator.deactivatePlugin('p', scriptedHost).then(() => { deactDone = true })
    let reactDone = false
    const react = activator.activatePlugin('p', { type: 'onStartupFinished' }, scriptedHost).then(() => { reactDone = true })
    await flush()
    expect(sent.filter(m => m.type === 'deactivate')).toHaveLength(1)
    expect(sent.filter(m => m.type === 'activate')).toHaveLength(2) // 初始 1 + 重入 1

    // 3) deactivated 回复先到（IPC FIFO）：必须立即 resolve deactivate 的等待——
    //    旧实现该回复被后注册的 activate entry 抢走，deactivate 只能挂到 5s 假超时
    activator.handleWorkerReply({ type: 'deactivated', pluginId: 'p' })
    await flush()
    expect(deactDone).toBe(true)
    expect(activator.getState('p')).toBe('UNLOADED')

    // 4) activated 回复后到：resolve activate 的等待
    activator.handleWorkerReply({ type: 'activated', pluginId: 'p' })
    await flush()
    expect(reactDone).toBe(true)
    expect(activator.getState('p')).toBe('ACTIVE')

    // 5) 无假超时/无陈旧 timer 副作用：推进 ACTIVATE_TIMEOUT_MS(30s)-ε，状态不翻转
    //   （若存在被错配遗弃的 pending timer，此处会把 ACTIVE 翻回 UNLOADED）
    vi.advanceTimersByTime(30_000 - 1)
    expect(activator.getState('p')).toBe('ACTIVE')

    await Promise.allSettled([deact, react])
  })

  // ── LC-C1: loadPlugin 回复按 pluginId 匹配（Worker 宿主）─────────
  it('LC-C1: 并发 loadPlugin 两个插件到同一 trusted Worker——loaded/error 回复按 pluginId 匹配，不张冠李戴', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    try {
      const workerId = await host.assignWorker('lc-load-a', 'trusted')
      const worker = host.getWorkerInstance(workerId)!
      expect(worker).toBeDefined()

      const aP = host.loadPlugin(workerId, 'lc-load-a', '/tmp/lc-load-a')
      const bP = host.loadPlugin(workerId, 'lc-load-b', '/tmp/lc-load-b')

      // 真实 mock Worker 的回复走异步事件循环；同步 emit 保证注入先于真实回复到达。
      // B 的 loaded 先到 + A 的 error 后到：旧实现只匹配 m.type，第一条回复同时
      // 命中两个 listener（B 被 A 的 error 错误 reject / A 被 B 的 loaded 错误 resolve）
      worker.emit('message', { type: 'loaded', pluginId: 'lc-load-b' })
      worker.emit('message', { type: 'error', pluginId: 'lc-load-a', error: 'load failed (lc-load-a)' })

      await expect(bP).resolves.toBeUndefined()
      await expect(aP).rejects.toThrow('load failed (lc-load-a)')
    } finally {
      await host.shutdown()
    }
  })

  // ── LC-C3: 宿主消息回调注入抛异常的 handler ──────────────────────
  it('LC-C3: 回调内抛异常不冒泡不炸宿主——记日志后，后续正常消息仍处理', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    try {
      const workerId = await host.assignWorker('lc-cb-throw', 'trusted')
      const worker = host.getWorkerInstance(workerId)!

      const replies: string[] = []
      host.setReplyCallback((msg) => {
        const m = msg as Record<string, unknown>
        if (m.pluginId === 'boom') throw new Error('reply handler exploded')
        replies.push(String(m.type))
      })

      // 生命周期回复触发抛错的回调：EventEmitter 回调抛错会升级为
      // uncaughtException → 进程退出；safe-dispatch 必须吞掉并记日志
      expect(() => worker.emit('message', { type: 'activated', pluginId: 'boom' })).not.toThrow()
      expect(errorCalls.some(c => String(c[0]).includes('error handling message'))).toBe(true)

      // 后续正常消息仍处理（宿主未进入坏状态）
      expect(() => worker.emit('message', { type: 'deactivated', pluginId: 'ok' })).not.toThrow()
      expect(replies).toEqual(['deactivated'])

      // 正常功能链路恢复：loadPlugin 完整往返
      await expect(host.loadPlugin(workerId, 'lc-cb-throw', '/tmp/lc-cb-throw')).resolves.toBeUndefined()
    } finally {
      await host.shutdown()
    }
  })

  // ── LC-C3: safe-dispatch 纯函数——rpc/crash/reply 三分支抛错全覆盖 ──
  it('LC-C3: safeDispatchHostMessage——rpc/crash/reply 分支回调抛错均被捕获记日志，畸形消息落 warning 丢弃', () => {
    const handlers = {
      rpc: () => { throw new Error('rpc boom') },
      crash: () => { throw new Error('crash boom') },
      reply: () => { throw new Error('reply boom') },
    }
    expect(() => safeDispatchHostMessage('plugin-host', 'w-unit', { type: 'rpc', method: 'x' }, handlers)).not.toThrow()
    expect(() => safeDispatchHostMessage('plugin-host', 'w-unit', { type: 'fatal_error', error: 'e' }, handlers)).not.toThrow()
    expect(() => safeDispatchHostMessage('plugin-host', 'w-unit', { type: 'activated', pluginId: 'p' }, handlers)).not.toThrow()

    const logged = errorCalls.map(c => c.map(String).join(' ')).join('\n')
    expect(logged).toContain('error handling message from w-unit')
    expect(logged).toContain('rpc boom')
    expect(logged).toContain('crash boom')
    expect(logged).toContain('reply boom')

    // 畸形消息（null）落 warning 丢弃，不触发任何 handler
    safeDispatchHostMessage('plugin-host', 'w-unit', null, handlers)
    expect(warnCalls.some(c => c[0]!.includes('discarding malformed message'))).toBe(true)
  })

  // ── LC-U1-ENTRY: Worker 宿主入口防御 ────────────────────────────
  it('LC-U1-ENTRY: null 与超大非对象消息不炸 Worker 宿主（warning 丢弃 + 截断描述），宿主继续工作', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    try {
      const workerId = await host.assignWorker('lc-entry-worker', 'trusted')
      const worker = host.getWorkerInstance(workerId)!

      // null / number / 2MB 字符串：旧实现 m.type 对 null 抛 TypeError →
      // uncaughtException → 进程退出
      expect(() => worker.emit('message', null)).not.toThrow()
      expect(() => worker.emit('message', 12345)).not.toThrow()
      expect(() => worker.emit('message', 'x'.repeat(2 * 1024 * 1024))).not.toThrow()

      // 畸形消息被丢弃且记 warning（截断描述，非整段 2MB 进日志）
      const warns = warnCalls.map(c => String(c[0]))
      expect(warns.some(w => w.includes('discarding malformed message from'))).toBe(true)
      const big = warns.find(w => w.includes('chars)'))
      expect(big).toBeDefined()
      expect(big!.length).toBeLessThan(1000)

      // 宿主继续正常工作：loadPlugin 完整往返
      await expect(host.loadPlugin(workerId, 'lc-entry-worker', '/tmp/lc-entry-worker')).resolves.toBeUndefined()
    } finally {
      await host.shutdown()
    }
  })

  // ── LC-U1: fatal_error 路径 terminate 存活线程（W4 崩溃处理对称化）──
  it('LC-U1: fatal_error 路径 terminate 存活线程——handle/索引清理、crash 回调恰一次、冷却 rebuild timer 已排程', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    try {
      const workerId = await host.assignWorker('lc-fatal', 'trusted')
      await host.loadPlugin(workerId, 'lc-fatal', '/tmp/lc-fatal')
      const worker = host.getWorkerInstance(workerId)!
      const terminateSpy = vi.spyOn(worker, 'terminate')
      const crashes: Array<[string, string[]]> = []
      host.setCrashCallback((wid, pluginIds) => { crashes.push([wid, [...pluginIds]]) })

      // fatal_error 消息路径：线程实际存活（mock bootstrap 发完消息不退出）——
      // 旧实现不 terminate = 线程泄漏（对齐 process 版 kill 兜底）
      expect(() => worker.emit('message', { type: 'fatal_error', error: 'boom' })).not.toThrow()

      expect(terminateSpy).toHaveBeenCalledTimes(1)
      expect(crashes).toHaveLength(1)
      expect(crashes[0]!).toEqual([workerId, ['lc-fatal']])
      // handle / 反向索引 / 注册表清理
      expect(host.getWorkerHandleById(workerId)).toBeUndefined()
      expect(host.getWorkerHandle('lc-fatal')).toBeUndefined()
      expect(host.getCrashCount('lc-fatal')).toBe(1)
      // 冷却 rebuild timer 已排程（保存引用）
      expect(host.getPendingRebuildTimer(workerId)).toBeDefined()

      // 幂等：terminate 触发的 exit(code=1) / 重复 fatal_error 不再触发 crash 回调
      await new Promise((r) => setTimeout(r, 50))
      expect(crashes).toHaveLength(1)
      expect(host.getCrashCount('lc-fatal')).toBe(1)
    } finally {
      await host.shutdown()
    }
  })

  // ── LC-U1: exit code 0 的正常退出清理（W4）───────────────────────
  it('LC-U1: exit code 0 的 Worker 退出——handle/索引清理但不报 crash（区分正常退出与崩溃）', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    let staleWorker: ReturnType<PluginHost['getWorkerInstance']> | undefined
    try {
      const workerId = await host.assignWorker('lc-exit0', 'trusted')
      await host.loadPlugin(workerId, 'lc-exit0', '/tmp/lc-exit0')
      const worker = host.getWorkerInstance(workerId)!
      staleWorker = worker
      const crashes: string[] = []
      host.setCrashCallback((wid) => { crashes.push(wid) })

      // 正常退出（code 0）：旧实现完全不清理——僵尸 handle 残留会被 assignWorker
      // 复用，把新插件分配到已死 Worker
      worker.emit('exit', 0)

      expect(crashes).toHaveLength(0)
      expect(host.getCrashCount('lc-exit0')).toBe(0)
      expect(host.getPendingRebuildTimer(workerId)).toBeUndefined()
      expect(host.getWorkerHandleById(workerId)).toBeUndefined()
      expect(host.getWorkerHandle('lc-exit0')).toBeUndefined()

      // 清理后同一 pluginId 可重新分配新 Worker（无僵尸占位），链路完好
      const reWorkerId = await host.assignWorker('lc-exit0', 'trusted')
      await expect(host.loadPlugin(reWorkerId, 'lc-exit0', '/tmp/lc-exit0')).resolves.toBeUndefined()
    } finally {
      // fake exit 的原线程仍真实存活且已从宿主 map 移除——手动 terminate 防泄漏
      await staleWorker?.terminate().catch(() => undefined)
      await host.shutdown()
    }
  })

  // ── LC-U1: rebuild 冷却 timer 约束（W3）─────────────────────────
  it('LC-U1: rebuild 冷却 timer 保存引用 + unref + 受 shutdown 清理——关停后冷却到期不复活', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    host.setRebuildCooldownMs(200)
    try {
      const workerId = await host.assignWorker('lc-timer', 'trusted')
      await host.loadPlugin(workerId, 'lc-timer', '/tmp/lc-timer')
      // 真实线程崩溃（mock bootstrap 对 crash 消息 process.exit(1) → exit code 1）
      host.getWorkerHandle('lc-timer')!.postMessage({ type: 'crash' })
      await waitFor(() => host.getPendingRebuildTimer(workerId) !== undefined)

      const timer = host.getPendingRebuildTimer(workerId)!
      expect(timer).toBeDefined()
      // unref 证明：真实 Node Timeout 在 unref 后 hasRef() === false——冷却 timer
      // 不得阻止进程退出（旧实现裸 setTimeout 且不保存引用，shutdown 无从清理）
      const nodeTimer = timer as NodeJS.Timeout & { hasRef?: () => boolean }
      expect(typeof nodeTimer.unref).toBe('function')
      if (typeof nodeTimer.hasRef === 'function') {
        expect(nodeTimer.hasRef()).toBe(false)
      }

      // 冷却窗口内 shutdown：timer 被清理，冷却到期后不 rebuild、无新 Worker
      await host.shutdown()
      expect(host.getPendingRebuildTimer(workerId)).toBeUndefined()
      await new Promise((r) => setTimeout(r, 400))
      expect(host.getAllWorkers()).toHaveLength(0)
    } finally {
      await host.shutdown()
    }
  })

  // ── LC-U1: crashCounts 衰减（W3，fake timers）────────────────────
  it('LC-U1: crashCounts 衰减——rebuild 成功后 60s 无新崩溃清零（「连续 3 次」按时间窗收敛）', async () => {
    // 只 fake setTimeout/clearTimeout：worker exit 是真实 I/O 事件，setImmediate 保持真实
    // 供 flushIO 轮询推进
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flushIO = () => new Promise<void>((r) => setImmediate(r))
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    try {
      const workerId = await host.assignWorker('lc-decay', 'trusted')
      await host.loadPlugin(workerId, 'lc-decay', '/tmp/lc-decay')

      host.getWorkerHandle('lc-decay')!.postMessage({ type: 'crash' })
      // 等真实 exit 事件（I/O 驱动，非 timer 驱动）。固定轮数 setImmediate 在 CI 慢环境
      // 下可能跑完仍等不到线程退出（曾以 200 轮上限在 CI 必挂）——按真实墙钟兜底：
      // Date 未被 fake 可作 deadline，setTimeout 已被 fake 不能用于 waitFor 轮询
      const exitDeadline = Date.now() + 5_000
      while (host.getPendingRebuildTimer(workerId) === undefined && Date.now() < exitDeadline) {
        await flushIO()
      }
      expect(host.getPendingRebuildTimer(workerId)).toBeDefined()
      expect(host.getCrashCount('lc-decay')).toBe(1)

      // 冷却到期（默认 5s）→ rebuild 成功：新 Worker 建立，计数暂不清零
      await vi.advanceTimersByTimeAsync(5_000)
      expect(host.getAllWorkers()).toHaveLength(1)
      expect(host.getCrashCount('lc-decay')).toBe(1)

      // 60s 稳定窗口内（差 1ms）不清零；窗口到期（无新崩溃）清零
      await vi.advanceTimersByTimeAsync(59_999)
      expect(host.getCrashCount('lc-decay')).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(host.getCrashCount('lc-decay')).toBe(0)
    } finally {
      vi.useRealTimers()
      await host.shutdown()
    }
  })

  // ── LC-U1: onRebuilt 只复活 CRASHED 态插件（W3，PluginService 层）──
  it('LC-U1: onRebuilt 只复活 CRASHED 态插件——UNLOADED（用户已 disable）与已卸载（无状态）跳过', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'lc-svc-root-'))
    const tmpConfig = await mkdtemp(join(tmpdir(), 'lc-svc-config-'))
    const broadcasts: unknown[] = []
    const broker: IMessageBroker = {
      send: () => {},
      broadcast: (msg) => { broadcasts.push(msg) },
      sendError: () => {},
    }
    const service = new PluginService(new PluginRegistry(tmpRoot, tmpConfig), broker, { configDir: tmpConfig })
    await service.initialize()
    try {
      const crashed = makeDescriptor({ pluginId: 'p-crashed', pluginPath: '/tmp/p-crashed/index.js' })
      const disabled = makeDescriptor({ pluginId: 'p-disabled', pluginPath: '/tmp/p-disabled/index.js' })
      service.registry.cacheDescriptors([crashed, disabled])
      service.activator.registerDescriptors([crashed, disabled])
      // p-crashed：崩溃态（rebuild 应复活）；p-disabled：UNLOADED（用户 disable 终态）；
      // p-removed：未注册状态（uninstall 后）
      service.activator.markCrashed('p-crashed')

      const loadSpy = vi.spyOn(service.host, 'loadPlugin')
      service.handleWorkerRebuilt('trusted-99', ['p-crashed', 'p-disabled', 'p-removed'])

      // 只重载 CRASHED 态；UNLOADED / 已卸载跳过（旧实现无条件重激活 = 复活用户关闭的插件）
      expect(loadSpy).toHaveBeenCalledTimes(1)
      expect(loadSpy).toHaveBeenCalledWith('trusted-99', 'p-crashed', crashed.pluginPath, 'trusted')
      expect(service.activator.getState('p-disabled')).toBe('UNLOADED')
    } finally {
      await service.shutdown()
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      await rm(tmpConfig, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  // ── LC-C3: rpcClient 层 notification handler 兜底（W4，Worker 内）──
  it('LC-C3: rpcClient.handleNotification——注入抛异常 handler 被捕获记日志（含 method/pluginId），不冒泡 fatal_error，同通知其余 handler 照常收到', async () => {
    // 真实 bootstrap 分发路径：handleMessage 的 rpc.notification 分支 →
    // rpcClient.handleNotification（与 plugin-bootstrap.ts:178 同一入口）
    const posted: Array<Record<string, unknown>> = []
    setPostMessage((m) => { posted.push(m as Record<string, unknown>) })
    const received: unknown[] = []
    const unBoom = workerRpcClient.onNotification('plugin.event.lc3', () => {
      throw new Error('lc3-boom')
    })
    const unOk = workerRpcClient.onNotification('plugin.event.lc3', (p) => { received.push(p) })
    try {
      await expect(handleMessage({
        type: 'rpc',
        notification: { jsonrpc: '2.0', method: 'plugin.event.lc3', params: { pluginId: 'lc3-p1' } },
      })).resolves.toBeUndefined()

      // 1) 不冒泡 fatal_error：bootstrap 的 handleMessage catch 收到抛错才会 post
      //    fatal_error → 宿主按整 Worker 崩溃处理（连坐同 Worker 全部插件 + crashCounts）
      expect(posted.filter((m) => m.type === 'fatal_error')).toHaveLength(0)
      // 2) 同 Worker 其他插件的 handler 照常收到通知（分发不中断）
      expect(received).toHaveLength(1)
      // 3) 异常被捕获记日志：含 method 与归属 pluginId（可排查）
      const logged = errorCalls.map((c) => c.map(String).join(' ')).join('\n')
      expect(logged).toContain('notification handler error')
      expect(logged).toContain('plugin.event.lc3')
      expect(logged).toContain('lc3-p1')
      expect(logged).toContain('lc3-boom')
    } finally {
      unBoom()
      unOk()
    }
  })

  // ── fork 宿主（PluginHostProcess）：真实 IPC 上的入口防御与 loadPlugin 过滤 ──
  // [HISTORICAL] 2026-08-20 PR #185：真实 fork 子进程用例显式超时（满并行 + 系统余载
  // 下子进程 spawn/IPC 往返超 vitest 默认 5s testTimeout，对齐 plugin-host.test.ts 口径）。
  describe('PluginHostProcess（真实 fork IPC）', { timeout: 30_000 }, () => {
    let tmpDir: string
    let scriptPath: string
    const procs: PluginHostProcess[] = []

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'lc-races-'))
      scriptPath = join(tmpDir, 'malformed-child.cjs')
      await writeFile(scriptPath, MALFORMED_CHILD_SCRIPT)
    })

    afterEach(async () => {
      await Promise.allSettled(procs.map(h => h.shutdown()))
      procs.length = 0
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('LC-U1-ENTRY: 真实 IPC 上的 null 与超大字符串消息不炸 fork 宿主（warning 丢弃 + 截断），宿主继续工作', async () => {
      const rpc = new PluginRpcServer()
      const host = new PluginHostProcess(rpc, { bootstrapPathOverride: scriptPath })
      procs.push(host)
      const processId = await host.assignProcess('lc-entry', 'trusted')
      const handle = host.getProcessHandle('lc-entry')!
      expect(handle).toBeDefined()

      // 触发子进程在真实 IPC 通道上回 null / 2MB 字符串
      handle.postMessage({ type: 'send-null' })
      handle.postMessage({ type: 'send-big' })

      await waitFor(() => warnCalls.length >= 2)

      const warns = warnCalls.map(c => String(c[0]))
      expect(warns.some(w => w.includes('discarding malformed message from'))).toBe(true)
      const big = warns.find(w => w.includes('chars)'))
      expect(big).toBeDefined()
      expect(big!.length).toBeLessThan(1000)

      // 宿主继续正常工作：loadPlugin 完整往返
      await expect(host.loadPlugin(processId, 'lc-entry', '/tmp/lc-entry')).resolves.toBeUndefined()
    })

    it('LC-C1: 并发 loadPlugin 两个插件到同一 trusted 子进程——error/loaded 回复按 pluginId 匹配（真实 IPC FIFO）', async () => {
      const rpc = new PluginRpcServer()
      const host = new PluginHostProcess(rpc, { bootstrapPathOverride: scriptPath })
      procs.push(host)
      const processId = await host.assignProcess('lc-fail', 'trusted')
      const reusedId = await host.assignProcess('lc-ok', 'trusted')
      expect(reusedId).toBe(processId)

      // IPC FIFO：先发的 lc-fail 的 error 回复先到。旧实现只匹配 m.type，
      // 第一条 error 同时命中两个 listener，lc-ok 被错误 reject
      const failP = host.loadPlugin(processId, 'lc-fail', '/tmp/lc-fail')
      const okP = host.loadPlugin(processId, 'lc-ok', '/tmp/lc-ok')

      await expect(failP).rejects.toThrow('load failed (lc-fail)')
      await expect(okP).resolves.toBeUndefined()
    })
  })
})
