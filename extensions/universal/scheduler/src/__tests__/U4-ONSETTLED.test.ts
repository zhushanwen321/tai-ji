/**
 * U4_ONSETTLED：onSettled 失败记账验收
 *
 * 三条子用例：
 * (1) delivery send 抛错 → task.lastStatus='failed' + history 追加 + pending=false
 * (2) once 任务 send 抛错 → task 不从 tasks Map 删除、不 append delete op（at-least-once）
 * (3) recurring 任务 send 成功 → task.lastStatus='success' + nextRunAt 推进 + append advance op
 *
 * 断言 backend.appendedOps 含预期 op 类型。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import type { DeliveryMessage } from '@xyz-agent/session-delivery'

import { SchedulerRuntime } from '../runtime.js'

/** 构造 delivery onSettled 回调入参消息（dispatchViaDelivery 挂 dedupeKey=task.id）。 */
function settledMsg(content: string, taskId: string): DeliveryMessage {
  return {
    payload: {
      kind: 'custom',
      customType: 'pi-scheduler:dispatched',
      content,
      display: true,
    },
    intent: 'after-run',
    dedupeKey: taskId,
  }
}

describe('U4_ONSETTLED: onSettled 失败记账', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('(1) delivery onSettled rejected → task.lastStatus=failed + history + pending=false', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const task = await runtime.addTask('rejected-test', { mode: 'interval', intervalMs: 60_000 })

    // 模拟 delivery onSettled rejected 回调（dedupeKey=task.id 反查）
    runtime.handleSettled(settledMsg('rejected-test', task.id), 'rejected')

    expect(task.lastStatus).toBe('failed')
    expect(task.history[task.history.length - 1]!.status).toBe('failed')
    // pending 在 addTask 时未设置（undefined），dispatchViaDelivery 中显式清除为 false
    // rejected 回调不修改 pending，保持 dispatchViaDelivery 后的 false 状态
    expect(task.pending).toBeFalsy()
  })

  it('(2) once 任务 rejected → task 不删（at-least-once 语义）', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const task = await runtime.addTask(
      'once-rejected',
      { mode: 'interval', intervalMs: 60_000 },
      { kind: 'once' },
    )
    const taskId = task.id

    // 模拟 delivery onSettled rejected
    runtime.handleSettled(settledMsg('once-rejected', taskId), 'rejected')

    // once 任务失败不删——任务仍在 Map 中
    expect(runtime.getTask(taskId)).toBeDefined()
    expect(task.lastStatus).toBe('failed')
    // 不应 append delete op（失败不删持久化）
    const deleteOps = backend.appendedOps.filter(
      op => op.op === 'delete' && 'taskId' in op && op.taskId === taskId,
    )
    expect(deleteOps).toHaveLength(0)
  })

  it('(2b) 通过 handleSettled rejected 触发时，任务不删除且保留失败历史', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const task = await runtime.addTask(
      'once-rejected-via-handler',
      { mode: 'interval', intervalMs: 60_000 },
      { kind: 'once' },
    )

    runtime.handleSettled(settledMsg('once-rejected-via-handler', task.id), 'rejected')

    expect(task.lastStatus).toBe('failed')
    expect(task.history[task.history.length - 1]!.status).toBe('failed')
    expect(runtime.getTask(task.id)).toBeDefined()
  })

  it('(3) recurring 任务 delivered → lastStatus=success + nextRunAt 推进 + append advance', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const task = await runtime.addTask('delivered-test', { mode: 'interval', intervalMs: 60_000 })
    const oldNextRunAt = task.nextRunAt
    // 时间前进：让 onDispatchSuccess 的 computeNextRunAt 基于更晚的时间计算
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))

    // 模拟 delivery onSettled delivered
    runtime.handleSettled(settledMsg('delivered-test', task.id), 'delivered')

    // onDispatchSuccess 是 async，等一个 microtask
    await vi.waitFor(() => {
      expect(task.lastStatus).toBe('success')
    })

    expect(task.runCount).toBe(1)
    expect(task.lastError).toBeUndefined()
    // nextRunAt 推进到未来
    expect(task.nextRunAt).toBeGreaterThan(oldNextRunAt)
    // append advance op
    const advanceOps = backend.appendedOps.filter(op => op.op === 'advance')
    expect(advanceOps.length).toBeGreaterThanOrEqual(1)
  })
})
