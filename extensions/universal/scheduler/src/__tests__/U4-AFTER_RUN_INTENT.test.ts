/**
 * U4_AFTER_RUN_INTENT：after-run intent 映射验收
 *
 * 两个子用例：
 * (1) 装配层 createDelivery config.intent='after-run'，dispatchTask 后 port.send 收到 intent='after-run'
 * (2) 现有 sendMessage 调用参数验证——force 路径 backend.sendMessage 参数为 {deliverAs:'followUp', triggerTurn:true}
 */
import { describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'

describe('U4_AFTER_RUN_INTENT: intent 映射', () => {
  it('(1) dispatchTask 通过 delivery → port.send 收到 intent=after-run', async () => {
    // 内核级 mock：记录 port.send 的 intent 参数
    const sentIntents: string[] = []
    const mockDelivery = {
      send: vi.fn((msg: any) => {
        // delivery handle 的 send 不直接暴露 intent（intent 在 createDelivery config 中）
        // 但我们可以验证 send 被调用（入队），intent 由内核传递给 port.send
        sentIntents.push(msg.intent ?? 'config-default')
      }),
      sendChecked: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn(() => 0),
      dispose: vi.fn(),
    }
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend, mockDelivery as any)

    const task = await runtime.addTask('intent-test', { mode: 'interval', intervalMs: 60_000 })
    await runtime.dispatchTask(task)

    // delivery.send 被调用
    expect(mockDelivery.send).toHaveBeenCalledTimes(1)
    // send 调用的 payload 包含正确的 content
    expect(mockDelivery.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'custom',
          customType: 'pi-scheduler:dispatched',
          content: 'intent-test',
          display: true,
        }),
        intent: 'after-run',
      }),
    )
    // 不直调 backend.sendMessage
    expect(backend.sentMessages).toHaveLength(0)
  })

  it('(2) force 路径直调 sendMessage 参数等价（deliverAs:followUp + triggerTurn:true）', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const task = await runtime.addTask(
      'force-intent',
      { mode: 'interval', intervalMs: 60_000 },
      { force: true },
    )
    await runtime.dispatchTask(task)

    // force 直投走 backend.sendMessage
    expect(backend.sentMessages).toHaveLength(1)
    expect(backend.sentMessages[0]!.msg).toEqual(
      expect.objectContaining({
        content: 'force-intent',
        customType: 'pi-scheduler:dispatched',
        display: true,
      }),
    )
    // 迁移后参数与迁移前一致
    expect(backend.sentMessages[0]!.opts).toEqual({
      deliverAs: 'followUp',
      triggerTurn: true,
    })
  })

  it('(3) 有 delivery handle 时非 force 任务不直投 backend.sendMessage', async () => {
    const mockDelivery = {
      send: vi.fn(),
      sendChecked: vi.fn(),
      flush: vi.fn(),
      depth: vi.fn(() => 0),
      dispose: vi.fn(),
    }
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend, mockDelivery as any)

    const task = await runtime.addTask('delivery-only-test', { mode: 'interval', intervalMs: 60_000 })
    const dispatched = await runtime.dispatchTask(task)

    expect(dispatched).toBe(true)
    expect(mockDelivery.send).toHaveBeenCalledTimes(1)
    expect(backend.sentMessages).toHaveLength(0)
  })
})
