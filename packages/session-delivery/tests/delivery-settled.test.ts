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
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

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
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    settledCb!()
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(1)

    handle.dispose()
  })

  it('hasPendingMessages=true 时 settled 复核不通过（G4 双条件 gate）', () => {
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => true,
      hasPendingMessages: () => true,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0) // idle 但 pi 队列未排空 → 不投

    settledCb!()
    expect(port.sendCalls).toHaveLength(0) // 边沿复核 hasPendingMessages 仍 true → 留队
    expect(handle.depth()).toBe(1)

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

describe('A3-settled watch-dog: settled 丢失场景下 30s 复核恢复', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('settled 事件丢失后 watch-dog 30s 复核 flush（断言只能由 watchdog 满足）', () => {
    // 反假测试声明：旧版测试 port isIdle 恒 false + backoff max 5，
    // advanceTimersByTime(600) 时退避 5 拍打满强发碰巧满足断言、watchdog 从未运行。
    // 本版：真实 subscribeSettled 装配但测试内从不触发回调 + 退避 max 足够大
    // （且 #7 下有订阅装配本就不启动退避强发）——投递只能由 watchdog 复核驱动。
    let idle = false
    const port = makeMockPort({
      isIdle: () => idle,
      subscribeSettled: (cb) => {
        void cb // 订阅成立、回调从不触发（模拟 RPC 断线丢 settled 事件）
        return () => {}
      },
    })
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      watchdogMs: 30_000,
      backoff: { ms: 100, max: 500 }, // 若退避仍错误启动，500 拍 = 50s 不会强发
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    // watchdog 第一拍（t=30s）之前不投：退避循环被抑制（#7），事件驱动无事件
    vi.advanceTimersByTime(29_999)
    expect(port.sendCalls).toHaveLength(0)

    idle = true // 目标 session 已 idle（settled 丢失，无人通知内核）
    vi.advanceTimersByTime(1) // watchdog 第一拍到达
    expect(port.sendCalls).toHaveLength(1) // watchdog 复核 → flush 送达
    expect(port.sendCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('watchdog 复核仍 busy → 不投，队列滞留等下一拍/边沿', () => {
    const port = makeMockPort({
      isIdle: () => false,
      subscribeSettled: (cb) => {
        void cb
        return () => {}
      },
    })
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      watchdogMs: 30_000,
      backoff: { ms: 100, max: 500 },
    })

    handle.send(textMsg('hello'))
    vi.advanceTimersByTime(90_000) // 三拍全 busy
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(1)

    handle.dispose()
  })

  it('无 subscribeSettled 装配时不用 watch-dog，纯退避轮询', () => {
    const port = makeMockPort({
      isIdle: () => false,
    })
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      backoff: { ms: 100, max: 5 },
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(10_000)

    expect(port.sendCalls).toHaveLength(1)

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
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      backoff: { ms: 100, max: 5 }, // 若退避仍启动，5s 内必强发
    })

    handle.send(textMsg('hello'))
    vi.advanceTimersByTime(10_000) // 远超退避上限窗口

    expect(port.sendCalls).toHaveLength(0) // 只依赖 settled 边沿 + watchdog，不退避强发
    expect(handle.depth()).toBe(1)

    handle.dispose()
  })
})
