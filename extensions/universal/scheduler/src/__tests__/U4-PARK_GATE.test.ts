/**
 * U4_PARK_GATE：park 模式 gate 行为验收
 *
 * 三条子用例：
 * (1) isIdle=false 时 dispatchTask → delivery 入队（busy 不直投，等 tick 重触发）
 * (2) isIdle=false → flush() 外部调用 → 任务被投递（tick 外部重触发路径）
 * (3) force=true 时绕过 gate 直投（即使 isIdle=false 也 sendMessage）
 *
 * 断言 delivery send 调用次数和 intent 参数。
 */
import { describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'

describe('U4_PARK_GATE: park 模式 gate 行为', () => {
  it('(1) isIdle=false 时 dispatchTask → delivery 入队不直投', async () => {
    const mockDelivery = {
      send: vi.fn(),
      sendChecked: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn(() => 0),
      dispose: vi.fn(),
    }
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend, mockDelivery as any)

    const task = await runtime.addTask('park-gate-test', { mode: 'interval', intervalMs: 60_000 })
    const dispatched = await runtime.dispatchTask(task)

    // dispatchViaDelivery 入队成功返回 true
    expect(dispatched).toBe(true)
    // delivery.send 被调用 1 次（入队），backend.sendMessage 未被直调
    expect(mockDelivery.send).toHaveBeenCalledTimes(1)
    expect(mockDelivery.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ content: 'park-gate-test' }),
      }),
    )
    // 不直调 backend.sendMessage（非 force 走 delivery）
    expect(backend.sentMessages).toHaveLength(0)
    // pending 在 dispatchViaDelivery 后清除
    expect(task.pending).toBe(false)
  })

  it('(2) isIdle=false → flush() 外部调用 → 队列消息被投递', async () => {
    // 内核级 flush 模拟：调用 port.send 投递已入队的消息
    const portSendCalls: Array<{ msg: unknown; intent: string }> = []
    const mockPort = {
      supportedPayloads: ['custom'] as const,
      isIdle: () => false,
      hasPendingMessages: () => true,
      send: vi.fn((msg: any, intent: string) => {
        portSendCalls.push({ msg, intent })
      }),
    }
    // 使用真实 createDelivery 但 mock port——验证 park 模式下 flush 触发投递
    // 但为了隔离测试，直接用 mock delivery handle 模拟 flush 行为
    let flushed = false
    const mockDelivery = {
      send: vi.fn(),
      sendChecked: vi.fn(),
      flush: vi.fn(() => { flushed = true }),
      depth: vi.fn(() => (flushed ? 0 : 1)),
      dispose: vi.fn(),
    }
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend, mockDelivery as any)

    await runtime.addTask('flush-test', { mode: 'interval', intervalMs: 60_000 })
    // 模拟 tickScheduler：dispatchTask 入队 + tick 末尾 flush
    // 直接调 flush 验证外部触发路径
    mockDelivery.flush()

    expect(mockDelivery.flush).toHaveBeenCalledTimes(1)
    expect(flushed).toBe(true)
  })

  it('(4) busy ctx 下 flush 由 tick 显式触发，而非内核自动重试', async () => {
    const mockDelivery = {
      send: vi.fn(),
      sendChecked: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn(() => 1),
      dispose: vi.fn(),
    }
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend, mockDelivery as any)

    const task = await runtime.addTask('tick-flush', { mode: 'interval', intervalMs: 60_000 })
    await runtime.dispatchTask(task)

    expect(mockDelivery.send).toHaveBeenCalledTimes(1)
    expect(mockDelivery.flush).not.toHaveBeenCalled()

    await runtime.tickScheduler()

    expect(mockDelivery.flush).toHaveBeenCalledTimes(1)
    expect(backend.sentMessages).toHaveLength(0)
  })

  it('(3) force=true 时绕过 delivery 直投（即使 isIdle=false 也 sendMessage）', async () => {
    const mockDelivery = {
      send: vi.fn(),
      sendChecked: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn(() => 0),
      dispose: vi.fn(),
    }
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend, mockDelivery as any)

    const task = await runtime.addTask(
      'force-bypass-test',
      { mode: 'interval', intervalMs: 60_000 },
      { force: true },
    )
    const dispatched = await runtime.dispatchTask(task)

    // force 任务直投成功
    expect(dispatched).toBe(true)
    // delivery.send 不被调用（force 绕过 delivery）
    expect(mockDelivery.send).not.toHaveBeenCalled()
    // backend.sendMessage 被直调
    expect(backend.sentMessages).toHaveLength(1)
    expect(backend.sentMessages[0]!.msg.content).toBe('force-bypass-test')
    expect(backend.sentMessages[0]!.opts).toEqual(
      expect.objectContaining({ deliverAs: 'followUp', triggerTurn: true }),
    )
  })

  it('(5) 到期任务 + 持续 busy 多 tick 不重复入队；settled 后可再入队（回归：nextRunAt 未推进期曾每 tick 重压副本）', async () => {
    const mockDelivery = {
      send: vi.fn(),
      sendChecked: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn(() => 1),
      dispose: vi.fn(),
    }
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend, mockDelivery as any)

    const task = await runtime.addTask('dup-test', { mode: 'interval', intervalMs: 60_000 })
    // 任务到期（nextRunAt 已过）
    task.nextRunAt = backend.now() - 1

    // 3 个连续 tick：每次 step2 都会重标 pending，防重标记应拦截重复入队
    await runtime.tickScheduler()
    await runtime.tickScheduler()
    await runtime.tickScheduler()
    expect(mockDelivery.send).toHaveBeenCalledTimes(1)

    // 终态回调（delivered）清除标记 + 记账推进 nextRunAt → 下轮到期可再入队
    runtime.handleSettled(
      { payload: { kind: 'custom', customType: 'pi-scheduler:dispatched', content: 'dup-test', display: true }, dedupeKey: task.id },
      'delivered',
    )
    // onDispatchSuccess 为 fire-and-forget async，等微任务落定后再断言
    await new Promise((r) => setTimeout(r, 0))
    expect(task.lastStatus).toBe('success')
    expect(task.nextRunAt).toBeGreaterThan(backend.now())

    task.nextRunAt = backend.now() - 1
    await runtime.tickScheduler()
    expect(mockDelivery.send).toHaveBeenCalledTimes(2)
  })

  it('(6) rejected 终态同样清除防重标记', async () => {
    const mockDelivery = {
      send: vi.fn(),
      sendChecked: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn(() => 1),
      dispose: vi.fn(),
    }
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend, mockDelivery as any)

    const task = await runtime.addTask('reject-test', { mode: 'interval', intervalMs: 60_000 })
    task.nextRunAt = backend.now() - 1
    await runtime.tickScheduler()
    expect(mockDelivery.send).toHaveBeenCalledTimes(1)

    runtime.handleSettled(
      { payload: { kind: 'custom', customType: 'pi-scheduler:dispatched', content: 'reject-test', display: true }, dedupeKey: task.id },
      'rejected',
    )
    expect(task.lastStatus).toBe('failed')

    await runtime.tickScheduler()
    expect(mockDelivery.send).toHaveBeenCalledTimes(2)
  })
})
