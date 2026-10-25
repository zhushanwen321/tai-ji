/**
 * per-message settled 契约（探针 P1，设计 D1/B1）。
 *
 * 锁死契约：条目受理后转 in-flight；送达回执（confirmDelivered 逐 id）落定后
 * onSettled 恰 N 次——每条消息各获一次终态回调，msg 为该条原始消息（非 composed
 * 合批消息），dedupeKey/outcome 各自正确。单消息批次行为与合批逐条同口径。
 *
 * [D9⑤ 口径升级] 'delivered' = 送达口径，仅 confirmDelivered 驱动回调；受理时点
 * 只转 in-flight 不回调（sendChecked promise 的受理 resolve 口径另锁于 inflight 套件）。
 *
 * 受理即出站下逐条即时出站（无合批窗口）；[已不可达用例删除登记] 原「busy park
 * 队列积累 + settled 边沿 flush 整队成批」的两合批形态用例随忙闲门禁删除而不可达，
 * 2026-10-23 投递域清理批次删除——per-message 契约改以逐条出站形态锁定
 * （内核 doSend 对积累队列的成批拼接由 receipt-anchor / command-lane 套件覆盖）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage } from '../src/types.js'
import { expectSettledMsg, makeMockPort, setupFakeTimersSilencedWarn, textMsg } from './helpers.js'

describe('per-message settled（P1）', () => {
  setupFakeTimersSilencedWarn()

  /** 断言第 index 条 settled 回调：原始消息引用 + dedupeKey + 终态 outcome。 */
  function expectSettledEntry(
    onSettled: ReturnType<typeof vi.fn>,
    index: number,
    msg: DeliveryMessage,
    outcome: 'delivered' | 'rejected',
    dedupeKey: string,
  ): void {
    expectSettledMsg(onSettled, index, msg)
    expect(onSettled.mock.calls[index]![0].dedupeKey).toBe(dedupeKey)
    expect(onSettled.mock.calls[index]![1]).toBe(outcome)
  }

  it('2 条逐条出站受理 → confirmDelivered 逐条 → onSettled 恰 2 次，各自原始消息/dedupeKey + delivered', () => {
    const onSettled = vi.fn()
    const port = makeMockPort()
    const handle = createDelivery(port, { onSettled })

    const msgA = textMsg('check CI', { dedupeKey: 'task-a' })
    const msgB = textMsg('poll build', { dedupeKey: 'task-b' })
    handle.send(msgA, { id: 'sid-a' }) // 受理即出站：逐条即时投递
    handle.send(msgB, { id: 'sid-b' })
    expect(port.sendCalls).toHaveLength(2)
    expect(onSettled).not.toHaveBeenCalled()

    // D9⑤：受理只转 in-flight，不触发 'delivered' 回调
    const active = handle.entriesFull().active
    expect(active.map((e) => e.state)).toEqual(['in-flight', 'in-flight'])

    // per-message 送达口径：confirmDelivered 逐 id 落定，每条各一次、msg 为原始消息
    // 引用（非 composed）
    handle.confirmDelivered('sid-a')
    handle.confirmDelivered('sid-b')

    expect(onSettled).toHaveBeenCalledTimes(2)
    expectSettledEntry(onSettled, 0, msgA, 'delivered', 'task-a')
    expectSettledEntry(onSettled, 1, msgB, 'delivered', 'task-b')
    expect(handle.depth()).toBe(0)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toHaveLength(2)

    handle.dispose()
  })

  it('2 条逐条出站 port.send 失败 → 首败即停，onSettled 每条恰一次 rejected（ADR-0122）', () => {
    const onSettled = vi.fn()
    const port = makeMockPort({
      send: () => {
        throw new Error('pi dead')
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { onSettled })
    try {
      const msgA = textMsg('check CI', { dedupeKey: 'task-a' })
      const msgB = textMsg('poll build', { dedupeKey: 'task-b' })
      handle.send(msgA, { id: 'sid-a' })
      handle.send(msgB, { id: 'sid-b' })

      expect(onSettled).toHaveBeenCalledTimes(2)
      expectSettledEntry(onSettled, 0, msgA, 'rejected', 'task-a')
      expectSettledEntry(onSettled, 1, msgB, 'rejected', 'task-b')
      expect(handle.depth()).toBe(0)
      expect(handle.entriesFull().active).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('单消息批次：受理 in-flight → confirmDelivered 后 onSettled 恰一次，msg 即原始消息引用', () => {
    const onSettled = vi.fn()
    const port = makeMockPort()
    const handle = createDelivery(port, { onSettled })

    const msg = textMsg('solo', { dedupeKey: 'task-solo' })
    handle.send(msg) // 受理即出站

    expect(port.sendCalls).toHaveLength(1)
    // D9⑤：受理不触发回调；条目 in-flight 等待送达回执
    expect(onSettled).not.toHaveBeenCalled()

    const id = handle.entriesFull().active[0]!.id
    handle.confirmDelivered(id)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]![0]).toBe(msg) // 引用恒等：单条时 msg 即原消息
    expect(onSettled.mock.calls[0]![0].payload.content).toBe('solo')
    expect(onSettled.mock.calls[0]![1]).toBe('delivered')

    handle.dispose()
  })
})
