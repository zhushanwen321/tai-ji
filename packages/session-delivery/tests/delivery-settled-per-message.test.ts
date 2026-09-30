/**
 * 合批 per-message settled 契约（探针 P1，设计 D1/B1）。
 *
 * 锁死契约：批次受理后条目转 in-flight；送达回执（confirmDelivered 逐 id）落定后
 * onSettled 恰 N 次——每条消息各获一次终态回调，msg 为该条原始消息（非 composed
 * 合批消息），dedupeKey/outcome 各自正确。单消息批次行为与合批逐条同口径。
 *
 * [D9⑤ 口径升级] 'delivered' = 送达口径，仅 confirmDelivered 驱动回调；受理时点
 * 只转 in-flight 不回调（sendChecked promise 的受理 resolve 口径另锁于 inflight 套件）。
 *
 * 合批形态对齐 scheduler 真实装配（§4 物理数据流）：不配 mergeWindowMs，合批来自
 * busy park 队列积累 + settled 边沿 flush 整队出站（queued 全量成批）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage } from '../src/types.js'
import { expectSettledMsg, makeBusyParkPort, makeMockPort, setupFakeTimersSilencedWarn, textMsg } from './helpers.js'

describe('合批 per-message settled（P1）', () => {
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

  it('合批 2 条受理 → confirmDelivered 逐条 → onSettled 恰 2 次，各自原始消息/dedupeKey + delivered（按入队序）', () => {
    let idle = false
    let settledCb: (() => void) | undefined
    const onSettled = vi.fn()
    const { port, setIdle, fireSettled } = makeBusyParkPort()
    const handle = createDelivery(port, { onSettled })

    const msgA = textMsg('check CI', { dedupeKey: 'task-a' })
    const msgB = textMsg('poll build', { dedupeKey: 'task-b' })
    handle.send(msgA) // busy：park 入队（scheduler 投递形态，非 merge 窗口）
    handle.send(msgB)
    expect(port.sendCalls).toHaveLength(0)
    expect(onSettled).not.toHaveBeenCalled()

    setIdle(true)
    fireSettled() // settled 边沿 → busy 复核通过 → flush 合批投出

    // 投递形态不变：仍是一次 port.send、composed content join
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('check CI\n\n---\n\npoll build')

    // D9⑤：受理只转 in-flight，不触发 'delivered' 回调
    expect(onSettled).not.toHaveBeenCalled()
    const active = handle.entriesFull().active
    expect(active.map((e) => e.state)).toEqual(['in-flight', 'in-flight'])

    // per-message 送达口径：confirmDelivered 逐 id 落定，每条各一次、msg 为原始消息
    // 引用（非 composed）
    const ids = handle.entriesFull().active.map((e) => e.id)
    handle.confirmDelivered(ids[0]!)
    handle.confirmDelivered(ids[1]!)

    expect(onSettled).toHaveBeenCalledTimes(2)
    expectSettledEntry(onSettled, 0, msgA, 'delivered', 'task-a')
    expectSettledEntry(onSettled, 1, msgB, 'delivered', 'task-b')
    expect(handle.depth()).toBe(0)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toHaveLength(2)

    handle.dispose()
  })

  it('合批 2 条 port.send 持续失败达重试上限 → onSettled 每条一次 rejected', () => {
    let idle = false
    let settledCb: (() => void) | undefined
    const onSettled = vi.fn()
    const port = makeMockPort({
      isIdle: () => idle,
      send: () => {
        throw new Error('pi dead')
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {}
      },
    })
    const handle = createDelivery(port, { onSettled, backoff: { ms: 1, max: 1 } })

    const msgA = textMsg('check CI', { dedupeKey: 'task-a' })
    const msgB = textMsg('poll build', { dedupeKey: 'task-b' })
    handle.send(msgA)
    handle.send(msgB)

    idle = true
    settledCb!() // flush 合批投出 → 首败进重试（非终态）
    expect(onSettled).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1) // 重试再败 → attempts=2 > max=1 → 终态
    expect(onSettled).toHaveBeenCalledTimes(2)
    expectSettledEntry(onSettled, 0, msgA, 'rejected', 'task-a')
    expectSettledEntry(onSettled, 1, msgB, 'rejected', 'task-b')
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('单消息批次：受理 in-flight → confirmDelivered 后 onSettled 恰一次，msg 即原始消息引用', () => {
    const onSettled = vi.fn()
    const port = makeMockPort()
    const handle = createDelivery(port, { onSettled })

    const msg = textMsg('solo', { dedupeKey: 'task-solo' })
    handle.send(msg) // 空闲立即投（无合批）

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
