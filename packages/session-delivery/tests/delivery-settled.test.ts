/**
 * A3-settled: subscribeSettled 事件驱动路径 + watch-dog + 有订阅装配的退避抑制。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A3-settled subscribeSettled 事件驱动路径', () => {
  it('busy 入队 → settled 回调 → isIdle 复核 true → flush', () => {
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => false,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    port.isIdle = () => true
    settledCb!()
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('settled 回调 → isIdle 复核 false → 不 flush 留队', () => {
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => false,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    settledCb!()
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(1)

    handle.dispose()
  })

  it('内核存在 in-flight 条目时 settled 复核不通过（G4 双条件 gate；D2 拆除后在途判定内查 active 表）', () => {
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => true,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })
    const handle = createDelivery(port)

    // 制造内核在途：首条受理转 in-flight（缺省 marker 申报，等回执未确认）
    const first = handle.send(textMsg('在途一条'))
    const firstId = first.kind === 'accepted' ? first.id : undefined

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(1) // idle 但在途未终态 → 不投

    settledCb!()
    expect(port.sendCalls).toHaveLength(1) // 边沿复核在途未清 → 留队
    expect(handle.depth()).toBe(1)

    handle.confirmDelivered(firstId!) // 送达回执 → 在途清零 → 边沿复核通过
    settledCb!()
    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })

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

  // [已不可达用例删除登记] 原「settled 事件丢失后 watch-dog 30s 复核 flush」与
  // 「无 subscribeSettled 装配时纯退避轮询」两用例随 watchdog 定时复核腿与无订阅装配
  // 退避轮询分支退役（ADR-0122——时间平抑机制不建）而不可达，2026-10-05 投递域清理
  // 批次删除。事件丢失后的恢复形态由下列用例锁定：留守至外部触发，不自动强发。

  it('settled 事件丢失 + busy 翻转：留守不投，外部 flush 驱动投递', () => {
    let idle = false
    const port = makeMockPort({
      isIdle: () => idle,
      subscribeSettled: () => () => {}, // 订阅成立但回调从不触发（模拟 settled 事件丢失）
    })
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    idle = true
    vi.advanceTimersByTime(60_000) // 无任何定时复核兜底：不自动投
    expect(port.sendCalls).toHaveLength(0)

    handle.flush() // 外部触发（真实链 = 恢复后的边沿信号）
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('持续 busy：留守，队列滞留等边沿', () => {
    const port = makeMockPort({
      isIdle: () => false,
      subscribeSettled: () => () => {},
    })
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    vi.advanceTimersByTime(90_000)
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(1)

    handle.dispose()
  })

  it('[锁 #7] 有订阅装配 busy 不启动退避强发（不与事件驱动竞速）', () => {
    const port = makeMockPort({
      isIdle: () => false,
      subscribeSettled: (cb) => {
        void cb
        return () => {}
      },
    })
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    vi.advanceTimersByTime(10_000) // 远超原退避窗口

    expect(port.sendCalls).toHaveLength(0) // 只依赖 settled 边沿，不退避强发
    expect(handle.depth()).toBe(1)

    handle.dispose()
  })
})
