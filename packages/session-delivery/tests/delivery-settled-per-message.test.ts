/**
 * 合批 per-message settled 契约（探针 P1，设计 D1/B1）。
 *
 * 锁死契约：合批 N 条投出后 onSettled 恰 N 次——每条消息各获一次终态回调，msg 为
 * 该条原始消息（非 composed 合批消息），dedupeKey/outcome 各自正确；单消息批次
 * 行为与旧口径逐字节等价（msg 引用恒等，回归锚）。
 *
 * 合批形态对齐 scheduler 真实装配（§4 物理数据流）：不配 mergeWindowMs，合批来自
 * busy park 队列积累 + settled 边沿 flush 整队出队（queue.splice(0)）。
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

  it('合批 2 条 → onSettled 恰 2 次，各自原始消息/dedupeKey + delivered（按入队序）', () => {
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

    // per-message 终态：每条各一次、msg 为原始消息引用（非 composed）
    expect(onSettled).toHaveBeenCalledTimes(2)
    expectSettledEntry(onSettled, 0, msgA, 'delivered', 'task-a')
    expectSettledEntry(onSettled, 1, msgB, 'delivered', 'task-b')
    expect(handle.depth()).toBe(0)

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

  it('单消息批次：onSettled 恰一次，msg 即原始消息引用（与旧口径逐字节等价）', () => {
    const onSettled = vi.fn()
    const port = makeMockPort()
    const handle = createDelivery(port, { onSettled })

    const msg = textMsg('solo', { dedupeKey: 'task-solo' })
    handle.send(msg) // 空闲立即投（无合批）

    expect(port.sendCalls).toHaveLength(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]![0]).toBe(msg) // 引用恒等：单条时 msg 即原消息
    expect(onSettled.mock.calls[0]![0].payload.content).toBe('solo')
    expect(onSettled.mock.calls[0]![1]).toBe('delivered')

    handle.dispose()
  })
})
