/**
 * 命令执行超时取值链单测（timeout-plugin-service U6 / D4，验收 V6③ 单测化）：
 * - 默认 30min（DEFAULT_TOOL_EXECUTE_TIMEOUT_MS，复用 D1 常量）：45s handler 不再
 *   被旧 10s 墙钟以 -32000 误杀（V6③ 的单测形态）；
 * - 命令定义级 timeoutMs 声明取值链全分支（同 D1：合法正数 / <=0 与 Infinity
 *   opt-out / 非法回落默认 / clamp）；
 * - 超时错误消息诚实化（等了多久 / declared-or-default / 调整指引）；
 * - busy 并发守卫提示（含已等待时长与出路，错误规格表「命令执行中重复触发」行）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

import { executeCommand, deliverInvokeResult, type CommandExecutorDeps } from '../src/services/plugin-service/api/commands-executor.js'
import { registerCommandRpcHandlers, COMMAND_RPC_METHODS, type CommandService } from '../src/services/plugin-service/api/commands-api.js'
import type { CommandRegistration } from '../src/services/plugin-service/api/commands-api.js'
import type { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PendingTracker } from '../src/utils/async/pending-tracker.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

const DEFAULT_TOOL_EXECUTE_TIMEOUT_MS = 1_800_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

function makeDeps(registration: Partial<CommandRegistration> = {}): CommandExecutorDeps & {
  notifications: Array<{ workerId: string; method: string; params: unknown }>
} {
  const notifications: Array<{ workerId: string; method: string; params: unknown }> = []
  const reg: CommandRegistration = {
    commandId: 'cmd1',
    pluginId: 'p1',
    handlerId: 'h1',
    workerId: 'w1',
    registeredAt: Date.now(),
    ...registration,
  }
  return {
    notifications,
    registry: { getDescriptor: () => ({ pluginId: 'p1', pluginPath: '/tmp/p1' }) as PluginDescriptor },
    host: { getWorkerHandle: () => ({ workerId: 'w1', postMessage: () => {} }) },
    rpcServer: {
      notify: (workerId: string, method: string, params: unknown) => {
        notifications.push({ workerId, method, params })
      },
    },
    commandRegistry: new Map([['p1:cmd1', reg]]),
    commandInvokes: new PendingTracker<string, unknown>(),
  }
}

/** 模拟 Worker 回传 invoke 结果（走真实 deliverInvokeResult 投递路径） */
function workerReplies(deps: CommandExecutorDeps, payload: { result?: unknown; error?: unknown }): void {
  deliverInvokeResult(
    { commandRegistry: deps.commandRegistry, commandInvokes: deps.commandInvokes },
    'h1',
    payload,
    'w1',
  )
}

describe('命令执行超时取值链（D4，同 D1 链路）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('默认 30min：未声明命令在旧 10s 必杀点不超时（V6③：45s handler 不再 -32000）', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const pending = executeCommand(deps, 'p1', 'cmd1')

    // 旧墙钟 10s：新默认下必须仍挂起（不 reject、不发假错误）
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.commandInvokes.has('h1')).toBe(true)

    // V6③ 形态：45s handler 正常回传真实结果（非 -32000 超时错误）
    await vi.advanceTimersByTimeAsync(35_000)
    workerReplies(deps, { result: 'done-after-45s' })
    await expect(pending).resolves.toBe('done-after-45s')
  })

  it('默认 30min：无回传时恰在 30min 超时，错误诚实（等了多久/default/指引）且带 code -32000', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const pending = executeCommand(deps, 'p1', 'cmd1')

    // 到期点的推进用同步版（async 版会在 timer reject 与断言挂 catch 之间的
    // 微任务检查点产生 unhandled rejection）
    vi.advanceTimersByTime(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS - 1)
    expect(deps.commandInvokes.has('h1')).toBe(true)

    vi.advanceTimersByTime(1)
    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining("Command 'p1:cmd1' timed out after 30min (default;"),
      code: -32000,
    })
    await expect(pending).rejects.toThrow(/pass timeoutMs in the command definition/)
  })

  it('声明 timeoutMs: 10_000 → 10s 到期，消息标注 declared', async () => {
    vi.useFakeTimers()
    const deps = makeDeps({ timeoutMs: 10_000 })
    const pending = executeCommand(deps, 'p1', 'cmd1')

    vi.advanceTimersByTime(10_000)
    await expect(pending).rejects.toThrow("Command 'p1:cmd1' timed out after 10s (declared;")
  })

  it.each([
    ['timeoutMs: 0（opt-out）', 0],
    ['timeoutMs: -5（opt-out）', -5],
    ['timeoutMs: Infinity（opt-out）', Infinity],
  ])('声明 %s → 以 timer 域上界近似不限时（推进 30min 默认值后仍挂起）', async (_label, declared) => {
    vi.useFakeTimers()
    const deps = makeDeps({ timeoutMs: declared as number })
    const pending = executeCommand(deps, 'p1', 'cmd1')

    // opt-out 语义：推进整个默认窗口（甚至 clamp 前的常规量级）都不得判死
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
    expect(deps.commandInvokes.has('h1')).toBe(true)

    // 收尾：正常回传不悬挂
    workerReplies(deps, { result: 'finally' })
    await expect(pending).resolves.toBe('finally')
  })

  it('声明超大值 clamp：3e9（>2^31-1）在 MAX_TIMER_DELAY_MS 上界到期，不塌缩提前触发', async () => {
    vi.useFakeTimers()
    const deps = makeDeps({ timeoutMs: 3_000_000_000 })
    const pending = executeCommand(deps, 'p1', 'cmd1')

    // Node setTimeout 超域会塌缩 1ms 立即触发——clamp 后在推进中途（远未到声明值）
    // 必须仍挂起，证明未塌缩
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deps.commandInvokes.has('h1')).toBe(true)

    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS - 60_000)
    await expect(pending).rejects.toThrow(/timed out after/)
  })

  it.each([
    ['NaN', NaN],
    ['undefined（缺省）', undefined],
  ])('声明 %s → 回落默认 30min', async (_label, declared) => {
    vi.useFakeTimers()
    const deps = makeDeps({ timeoutMs: declared as number | undefined })
    const pending = executeCommand(deps, 'p1', 'cmd1')

    vi.advanceTimersByTime(DEFAULT_TOOL_EXECUTE_TIMEOUT_MS)
    await expect(pending).rejects.toThrow('timed out after 30min (default;')
  })

  it('timeoutMs 声明不改变发送段：notify 的 handlerId/args 契约不变', async () => {
    vi.useFakeTimers()
    const deps = makeDeps({ timeoutMs: 5_000 })
    const pending = executeCommand(deps, 'p1', 'cmd1', { x: 1 })

    expect(deps.notifications).toHaveLength(1)
    expect(deps.notifications[0]).toMatchObject({
      workerId: 'w1',
      method: 'plugin.commands.invoke',
      params: { handlerId: 'h1', args: { x: 1 } },
    })

    workerReplies(deps, { result: 'ok' })
    await expect(pending).resolves.toBe('ok')
  })
})

describe('busy 并发守卫提示（错误规格表「命令执行中重复触发」行）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('重复触发被拒：busy 提示含已等待时长与超时出路；首次执行不受影响', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const first = executeCommand(deps, 'p1', 'cmd1')

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(executeCommand(deps, 'p1', 'cmd1'))
      .rejects.toThrow('Command already executing: p1:cmd1 (already running for 5s;')
    await expect(executeCommand(deps, 'p1', 'cmd1'))
      .rejects.toThrow(/no cancel channel yet — wait for it to finish or time out after 30min/)

    // 首次执行仍正常完成；完成后重复触发放行（开始时间条目已清理）
    workerReplies(deps, { result: 'done' })
    await expect(first).resolves.toBe('done')
    const second = executeCommand(deps, 'p1', 'cmd1')
    workerReplies(deps, { result: 'done-2' })
    await expect(second).resolves.toBe('done-2')
  })

  it('首次执行刚发起（等待 500ms）：busy 提示以 ms 呈现已等待时长', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    void executeCommand(deps, 'p1', 'cmd1')

    await vi.advanceTimersByTimeAsync(500)
    await expect(executeCommand(deps, 'p1', 'cmd1'))
      .rejects.toThrow('already running for 500ms;')
  })
})

describe('命令注册入口 timeoutMs 窄校验与透传（D4 声明通道，对齐 tool-api INVALID_TIMEOUT_MS 形态）', () => {
  /** 捕获 registerMethod 注册的 handler，绕过真实 RPC 传输层直调（聚焦校验/透传逻辑） */
  function makeCommandService() {
    const handlers = new Map<string, (params: unknown, ctx: { workerId: string }) => Promise<unknown>>()
    const rpcServerMock = {
      registerMethod: (name: string, fn: (params: unknown, ctx: { workerId: string }) => Promise<unknown>) => {
        handlers.set(name, fn)
      },
    } as unknown as PluginRpcServer
    const service: CommandService = {
      registry: new Map<string, CommandRegistration>(),
      broadcastRegistered: () => {},
      deliverInvokeResult: () => {},
    }
    registerCommandRpcHandlers(rpcServerMock, service)
    return { service, register: handlers.get(COMMAND_RPC_METHODS.register)! }
  }

  it('合法声明（正数 / 0 / Infinity）原样透传存储到 registration', async () => {
    for (const timeoutMs of [5_000, 0, Infinity]) {
      const { service, register } = makeCommandService()
      await register({ pluginId: 'p1', command: { id: 'cmd1', timeoutMs }, handlerId: 'h9' }, { workerId: 'w1' })
      expect(service.registry.get('p1:cmd1')?.timeoutMs).toBe(timeoutMs)
    }
  })

  it('缺省声明：registration 不携带 timeoutMs 字段（回落默认由执行侧取值链负责）', async () => {
    const { service, register } = makeCommandService()
    await register({ pluginId: 'p1', command: { id: 'cmd1' }, handlerId: 'h9' }, { workerId: 'w1' })
    expect(service.registry.get('p1:cmd1')?.timeoutMs).toBeUndefined()
  })

  it('非法声明（字符串 / NaN）fail-fast 拒注册：抛 INVALID_TIMEOUT_MS，不建注册表条目', async () => {
    for (const bad of ['5000', NaN]) {
      const { service, register } = makeCommandService()
      await expect(
        register({ pluginId: 'p1', command: { id: 'cmd1', timeoutMs: bad }, handlerId: 'h9' }, { workerId: 'w1' }),
      ).rejects.toMatchObject({ code: 'INVALID_TIMEOUT_MS' })
      expect(service.registry.has('p1:cmd1')).toBe(false)
    }
  })
})
