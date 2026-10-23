/**
 * A3-settled: subscribeSettled 边沿驱动路径。
 *
 * 受理即出站下边沿的语义 = retain 失败留守条目的重投触发（send/flush 即时出站，
 * 无忙闲复核）。本套件锁定：边沿订阅随 send 建立、dispose 兑现退订、留守条目
 * 无定时兜底（ADR-0122：时间平抑机制不建，重投只归边沿/外部触发）。
 *
 * [已不可达用例删除登记] 原「busy 入队 → settled 边沿 isIdle 复核通过 → flush」、
 * 「settled 回调 isIdle 复核 false 不 flush 留队」、「G4 双条件 gate（idle + 在途
 * 内查）」、「settled 事件丢失 busy 翻转留守」、「持续 busy 留守等边沿」、「有订阅
 * 装配 busy 不退避强发」六用例随忙闲门禁（busy park 排队语义）删除而不可达，
 * 2026-10-23 投递域清理批次删除；「无定时复核兜底」的锁定由下方 retain 留守
 * 形态用例继续承载。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { customMsg, makeMockPort, textMsg } from './helpers.js'

describe('A3-settled subscribeSettled 事件驱动路径', () => {
  it('dispose 退订 settled 订阅', () => {
    let unsubCalled = false
    const port = makeMockPort({
      subscribeSettled: (cb) => {
        void cb
        return () => { unsubCalled = true }
      },
    })
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    handle.dispose()

    expect(unsubCalled).toBe(true)
  })
})

describe('A3-settled 事件丢失形态（ADR-0122：无定时复核，留守归边沿/外部触发）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('retain 留守条目：无任何边沿/外部触发时不自动重投（无定时兜底），flush 驱动投递', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = makeMockPort({
      send: () => ({ accepted: false, reason: 'transient' }), // 首败 → retain 留守
      subscribeSettled: () => () => {}, // 订阅成立但回调从不触发（模拟 settled 事件丢失）
    })
    const handle = createDelivery(port)
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' })
      const callsAfterFailure = port.sendCalls.length
      expect(callsAfterFailure).toBeGreaterThan(0) // 受理即出站：首拍已发生（首败留守）

      vi.advanceTimersByTime(60_000) // 无任何定时复核兜底：不自动重投
      expect(port.sendCalls.length).toBe(callsAfterFailure)

      handle.flush() // 外部触发（真实链 = 恢复后的边沿信号）
      expect(port.sendCalls.length).toBeGreaterThan(callsAfterFailure)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})
