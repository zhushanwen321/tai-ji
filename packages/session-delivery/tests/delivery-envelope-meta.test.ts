/**
 * envelope additive meta 透传（notify-once 设计 D2：notifyId 穿 envelope）。
 *
 * 锁死契约（delivered 口径 = 送达回执驱动，D9⑤：受理只转 in-flight 不回调；本套件
 * 经 receiptAnchor 申报 / confirmDelivered 送达回执两形态驱动 delivered 终态）：
 * - sendChecked 申报 receiptAnchor:'acceptance'（agent 通路真实形态，见 runtime
 *   session-manager-handler notify send）→ 受理即 delivered，onSettled 收到**同一消息
 *   对象引用**，meta 原样完好（runtime 债权桥接据此锚定 armed→injected 受理回执）。
 * - deferred 积累两条（各自 notifyId，marker 锚）→ 窗口结束 flush 整队出站成批 →
 *   逐条 confirmDelivered → onSettled 恰 2 次，各自原始消息、各自 meta（per-message
 *   透传不串键——合批不得把首条 meta 抹到全批）。
 * - 首败 rejected 终态 → meta 同样随原消息到达（失败路径也要能定位债权）。
 * - 无 meta 消息 → meta undefined（additive 字段零回归：不带 meta 的存量消息形态不变）。
 *
 * [已不可达用例删除登记] 原「busy park 合批两条」用例的 busy park 前提随忙闲门禁
 * 删除而不可达，2026-10-23 投递域清理批次删除；积累队列成批改以 deferred
 * 设计内等待形态构造（内核 doSend 成批路径不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDelivery } from '../src/delivery.js'
import type { DeliveryPort, SendReceipt } from '../src/types.js'
import { makeMockPort, expectSettledMsg, textMsg } from './helpers.js'

function makePort(overrides?: Partial<DeliveryPort>): ReturnType<typeof makeMockPort> {
  return makeMockPort(overrides)
}

describe('envelope additive meta（notifyId 穿 envelope）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sendChecked 带 meta.notifyId 申报 acceptance → 受理即 delivered，同一对象引用，meta 完好', async () => {
    const onSettled = vi.fn()
    const port = makePort()
    const handle = createDelivery(port, { onSettled })

    const msg = textMsg('run tests', { meta: { notifyId: 'sm-nid-1' } })
    await handle.sendChecked(msg, { receiptAnchor: 'acceptance' })

    expect(onSettled).toHaveBeenCalledTimes(1)
    const settledMsg = onSettled.mock.calls[0]![0]
    expect(settledMsg).toBe(msg) // 同一原始消息引用（非 clone、非 composed）
    expect(settledMsg.meta?.notifyId).toBe('sm-nid-1')
    expect(onSettled.mock.calls[0]![1]).toBe('delivered')
    handle.dispose()
  })

  it('deferred 积累 2 条（各自 notifyId）→ 整队成批出站 → 逐条 confirmDelivered，per-message 回调各自 meta 不串键', () => {
    const onSettled = vi.fn()
    const sendMock = vi.fn((): SendReceipt | void => ({ accepted: false, deferred: 'merge-commit-hold' }))
    const port = makePort({ send: sendMock })
    const handle = createDelivery(port, { onSettled })

    const msgA = textMsg('claim A', { meta: { notifyId: 'sm-a' } })
    const msgB = textMsg('claim B', { meta: { notifyId: 'sm-b' } })
    handle.send(msgA, { id: 'a' }) // hold 拒（设计内等待）→ 条目留守 queued
    handle.send(msgB, { id: 'b' }) // 同上，队列积累为 2 条
    expect(onSettled).not.toHaveBeenCalled()

    // 投递端窗口结束 → flush 整队出站：积累队列成批，物理合批仍是一次 port.send
    sendMock.mockImplementation(() => undefined)
    handle.flush()

    const lastCall = port.sendCalls[port.sendCalls.length - 1]!
    expect(lastCall.msg.payload.content).toBe('claim A\n\n---\n\nclaim B')
    expect(onSettled).not.toHaveBeenCalled() // 受理只转 in-flight（D9⑤ 送达口径）
    // 送达回执逐条驱动（marker 锚正规路径 = 外部 confirmDelivered）
    handle.confirmDelivered('a')
    handle.confirmDelivered('b')
    expect(onSettled).toHaveBeenCalledTimes(2)
    expectSettledMsg(onSettled, 0, msgA)
    expect(onSettled.mock.calls[0]![0].meta?.notifyId).toBe('sm-a')
    expectSettledMsg(onSettled, 1, msgB)
    expect(onSettled.mock.calls[1]![0].meta?.notifyId).toBe('sm-b')
    handle.dispose()
  })

  it('首败即停 rejected → meta 随原消息到达回调（失败路径可定位债权，ADR-0122）', () => {
    const onSettled = vi.fn()
    const port = makePort({ send: () => ({ accepted: false as const, reason: 'closed' }) })
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('doomed claim', { meta: { notifyId: 'sm-fail' } }))
    vi.advanceTimersByTime(5) // 首败即停：rejected 终态

    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]![1]).toBe('rejected')
    expect(onSettled.mock.calls[0]![0].meta?.notifyId).toBe('sm-fail')
    handle.dispose()
  })

  it('additive 零回归：不带 meta 的存量消息 → meta undefined，行为不变', async () => {
    const onSettled = vi.fn()
    const port = makePort()
    const handle = createDelivery(port, { onSettled })

    const plain = textMsg('legacy message')
    expect(plain.meta).toBeUndefined()
    await handle.sendChecked(plain, { id: 'legacy-1' })
    handle.confirmDelivered('legacy-1') // marker 锚正规送达路径

    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]![0].meta).toBeUndefined()
    handle.dispose()
  })
})
