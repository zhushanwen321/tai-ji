/**
 * plugin.invoke 通道单测（provider-plugin-access D9 / P-invoke 验收①）：
 * invoke 与 executeCommand 共用 commands-executor 执行链（dispatchByMethodKey），
 * 仅语义分叉（错误文案 Method / 不广播 started）。覆盖：
 * - 往返：invokeMethod → notify 下发 → workerReplies 回传 → resolve 返回值（pending 登记断言）
 * - 超时：无回传时按注册级 timeoutMs 声明（或默认 30min）到期 reject（code -32000）
 * - 同键并发拒绝：同 method 二次调用立即失败（同 handlerId pending 冲突防御）
 * - 错误面：插件不存在 / 方法未注册（Method not found）
 * - 语义分叉：method 不广播 started（command 注入 broadcast 时才广播）
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-invoke-channel.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerMessageType } from '@taiji/shared'

import { executeCommand, invokeMethod, deliverInvokeResult, type CommandExecutorDeps } from '../src/services/plugin-service/api/commands-executor.js'
import type { CommandRegistration } from '../src/services/plugin-service/api/commands-api.js'
import { PendingTracker } from '../src/utils/async/pending-tracker.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

/** broadcast mock（泛型出口的具体签名实例化，CommandExecutorDeps['broadcast'] 兼容） */
function makeBroadcastMock() {
  return vi.fn((type: ServerMessageType, _id: string, _payload: unknown) => {})
}

function makeDeps(registration: Partial<CommandRegistration> = {}): CommandExecutorDeps & {
  notifications: Array<{ workerId: string; method: string; params: unknown }>
  broadcast: ReturnType<typeof makeBroadcastMock>
} {
  const notifications: Array<{ workerId: string; method: string; params: unknown }> = []
  const reg: CommandRegistration = {
    commandId: 'getStatus',
    pluginId: 'wool-workbuddy',
    handlerId: 'h1',
    workerId: 'w1',
    registeredAt: Date.now(),
    ...registration,
  }
  return {
    notifications,
    broadcast: makeBroadcastMock(),
    registry: { getDescriptor: () => ({ pluginId: 'wool-workbuddy', pluginPath: '/tmp/p1' }) as PluginDescriptor },
    host: { getWorkerHandle: () => ({ workerId: 'w1', postMessage: () => {} }) },
    rpcServer: {
      notify: (workerId: string, method: string, params: unknown) => {
        notifications.push({ workerId, method, params })
      },
    },
    commandRegistry: new Map([['wool-workbuddy:getStatus', reg]]),
    commandInvokes: new PendingTracker<string, unknown>(),
  }
}

/** 模拟 Worker 回传 invoke 结果（走真实 deliverInvokeResult 投递路径） */
function workerReplies(deps: CommandExecutorDeps, handlerId: string, payload: { result?: unknown; error?: unknown }): void {
  deliverInvokeResult(
    { commandRegistry: deps.commandRegistry, commandInvokes: deps.commandInvokes },
    handlerId,
    payload,
    'w1',
  )
}

describe('plugin.invoke 执行链复用（D9 / P-invoke）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('往返：invokeMethod 下发 notify → Worker 回传 → resolve 返回值；下发时 pending 已登记', async () => {
    const deps = makeDeps()
    const pending = invokeMethod(deps, 'wool-workbuddy', 'getStatus', { providerId: 'wool-workbuddy' })

    // notify 下发形态与命令通道同构（plugin.commands.invoke + handlerId + args）
    expect(deps.notifications).toEqual([
      { workerId: 'w1', method: 'plugin.commands.invoke', params: { handlerId: 'h1', args: { providerId: 'wool-workbuddy' } } },
    ])
    // pending 登记断言：invoke 在途时 handlerId 已在登记表（超时兜底与回传投递的锚点）
    expect(deps.commandInvokes.has('h1')).toBe(true)

    workerReplies(deps, 'h1', { result: { loggedIn: true } })
    await expect(pending).resolves.toEqual({ loggedIn: true })
    // 投递后登记清理
    expect(deps.commandInvokes.has('h1')).toBe(false)
  })

  it('超时：注册声明 timeoutMs 到期 reject（code -32000，文案 Method + 指引）', async () => {
    vi.useFakeTimers()
    const deps = makeDeps({ timeoutMs: 5_000 })
    const pending = invokeMethod(deps, 'wool-workbuddy', 'getStatus')

    vi.advanceTimersByTime(5_000)
    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining("Method 'wool-workbuddy:getStatus' timed out after 5s (declared;"),
      code: -32000,
    })
    // 超时路径登记清理（不残留悬挂 pending）
    expect(deps.commandInvokes.has('h1')).toBe(false)
  })

  it('同键并发拒绝：同 method 二次调用立即失败（同 handlerId pending 冲突），首次执行不受影响', async () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const first = invokeMethod(deps, 'wool-workbuddy', 'getStatus')

    await expect(invokeMethod(deps, 'wool-workbuddy', 'getStatus')).rejects.toThrow(
      "Method already executing: wool-workbuddy:getStatus (already running",
    )
    // 首次调用不受并发拒绝影响，回传后正常 resolve
    workerReplies(deps, 'h1', { result: 'ok' })
    await expect(first).resolves.toBe('ok')
  })

  it('错误面：插件不存在 → Plugin not found；方法未注册 → Method not found（区别于命令文案）', async () => {
    const deps = makeDeps()
    const missingPlugin = makeDeps()
    missingPlugin.registry = { getDescriptor: () => undefined }

    await expect(invokeMethod(missingPlugin, 'ghost', 'getStatus')).rejects.toThrow('Plugin not found: ghost')
    await expect(invokeMethod(deps, 'wool-workbuddy', 'noSuchMethod')).rejects.toThrow(
      'Method not found: wool-workbuddy:noSuchMethod',
    )
  })

  it('语义分叉：method 不广播 started；command 注入 broadcast 时广播（既有行为锚定）', async () => {
    vi.useFakeTimers()
    const invokeDeps = makeDeps()
    const invokePending = invokeMethod(invokeDeps, 'wool-workbuddy', 'getStatus')
    workerReplies(invokeDeps, 'h1', { result: 'ok' })
    await invokePending
    expect(invokeDeps.broadcast).not.toHaveBeenCalled()

    const commandDeps = makeDeps()
    const commandPending = executeCommand(commandDeps, 'wool-workbuddy', 'getStatus')
    workerReplies(commandDeps, 'h1', { result: 'ok' })
    await commandPending
    expect(commandDeps.broadcast).toHaveBeenCalledTimes(1)
    expect(commandDeps.broadcast.mock.calls[0]?.[0]).toBe('plugin:notification')
  })
})
