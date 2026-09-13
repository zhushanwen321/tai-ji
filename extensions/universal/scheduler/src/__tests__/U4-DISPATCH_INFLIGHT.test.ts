/**
 * U4_DISPATCH_INFLIGHT：调用方 in-flight 守卫验收
 *
 * 两个子用例：
 * (1) 同一 taskId 的 dispatchTask 并发调用 → 第二次立即返回 false + logger.warn
 * (2) 第一次 dispatchTask 完成后（finally 清除）→ 第二次正常执行
 *
 * 断言 delivery send 调用总次数为 1（拦截场景）或 2（串行场景）。
 */
import { describe, expect, it, vi } from 'vitest'

import { getLogger } from '@zhushanwen/pi-extension-logger'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'

describe('U4_DISPATCH_INFLIGHT: 调用方 in-flight 守卫', () => {
  it('(1) 同一 taskId 并发 dispatch → 第二次被拦截（send 只调 1 次 + warn）', async () => {
    const warnSpy = vi.spyOn(getLogger('scheduler'), 'warn').mockImplementation(() => {})

    // 可控延迟的 sendMessage：让第一次 dispatch 挂起
    let resolveSend: (() => void) | undefined
    const sendPromise = new Promise<void>(resolve => {
      resolveSend = resolve
    })
    const backend = new MockSchedulerBackend()
    backend.sendMessage = vi.fn(() => sendPromise)
    const runtime = new SchedulerRuntime(backend)

    const task = await runtime.addTask(
      'inflight-test',
      { mode: 'interval', intervalMs: 60_000 },
      { force: true },
    )

    // 第一次 dispatch（挂起）
    const first = runtime.dispatchTask(task)
    // sendMessage 被调 1 次
    expect(backend.sendMessage).toHaveBeenCalledTimes(1)

    // 第二次 dispatch（同一 taskId，在途被拦截）
    const second = await runtime.dispatchTask(task)
    expect(second).toBe(false)

    // warn 包含 in-flight 提示
    const warnText = warnSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(warnText).toContain('already in flight')

    // sendMessage 仍只有 1 次（拦截有效）
    expect(backend.sendMessage).toHaveBeenCalledTimes(1)

    // 放行第一次 dispatch
    resolveSend!()
    await first

    warnSpy.mockRestore()
  })

  it('(2) 第一次完成后 → 第二次 dispatchTask 正常执行（send 调 2 次）', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const task = await runtime.addTask(
      'serial-inflight',
      { mode: 'interval', intervalMs: 60_000 },
      { force: true },
    )

    // 第一次 dispatch（串行等待完成）
    const first = await runtime.dispatchTask(task)
    expect(first).toBe(true)
    expect(backend.sentMessages).toHaveLength(1)

    // 第二次 dispatch（in-flight 已清除，正常执行）
    // 需要重置 nextRunAt 让任务再次到期
    task.nextRunAt = 0
    const second = await runtime.dispatchTask(task)
    expect(second).toBe(true)

    // send 被调 2 次（串行完成）
    expect(backend.sentMessages).toHaveLength(2)
  })

  it('(3) 非 force + 有 delivery handle 时，in-flight 守卫同样拦截并发 dispatch', async () => {
    const warnSpy = vi.spyOn(getLogger('scheduler'), 'warn').mockImplementation(() => {})
    const backend = new MockSchedulerBackend()
    const mockDelivery = {
      send: vi.fn(),
      sendChecked: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn(() => 0),
      dispose: vi.fn(),
    } as any
    const runtime = new SchedulerRuntime(backend, mockDelivery)

    const task = await runtime.addTask('delivery-inflight', { mode: 'interval', intervalMs: 60_000 })

    const first = runtime.dispatchTask(task)
    const second = await runtime.dispatchTask(task)

    expect(await first).toBe(true)
    expect(second).toBe(false)
    expect(mockDelivery.send).toHaveBeenCalledTimes(1)

    const warnText = warnSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(warnText).toContain('already in flight')
    warnSpy.mockRestore()
  })
})
