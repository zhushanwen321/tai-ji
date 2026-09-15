/**
 * A1-migration: 搬迁 — notifier flush/退避/合批/dedupe 场景。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A1-migration 搬迁: gate 拒绝→退避重试→达上限强发', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('主 agent busy 时 flush 退避，idle 后才发送', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(100)
    expect(port.sendCalls).toHaveLength(0)

    port.idle = true
    vi.advanceTimersByTime(100)

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('主 agent 持续 busy 达退避上限后强制发送', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      backoff: { ms: 100, max: 50 },
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(10_000)

    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })

  it('#10 isIdle=true + hasPendingMessages=true → 视为 busy 不立即投（G4 等价 gate）', () => {
    const port = makeMockPort()
    port.pendingMessages = true
    const handle = createDelivery(port, {
      busyPolicy: 'retry-force',
      backoff: { ms: 100, max: 5 },
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0) // idle 但 pi 队列未排空 → 等边沿/退避

    port.pendingMessages = false
    vi.advanceTimersByTime(100) // 无订阅装配退避一拍，复核通过后投
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

describe('A1-migration 搬迁: 合批窗口滑动重置', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('窗口内新消息重置 timer，窗口到期后合并发送', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(3000)
    handle.send(textMsg('msg2'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(5000)
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('msg1\n\n---\n\nmsg2')

    handle.dispose()
  })

  it('无后台任务时立即发送（mergeHoldActive=false）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 60_000,
      mergeHoldActive: () => false,
    })

    handle.send(textMsg('msg1'))
    vi.advanceTimersByTime(0)
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

describe('A1-migration 搬迁: dispose 短路', () => {
  it('dispose 后 send 不入队不发送', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.dispose()
    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(0)
  })

  it('dispose 后退避 timer 不再触发发送', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('hello'))
    handle.dispose()

    vi.advanceTimersByTime(10_000)
    expect(port.sendCalls).toHaveLength(0)

    vi.useRealTimers()
  })
})

describe('A1-migration 搬迁: flush 强制投递', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('flush 跳过合批窗口直接投递', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 60_000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0)

    handle.flush()
    vi.advanceTimersByTime(0)
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

describe('A1-migration dedupe', () => {
  it('同 dedupeKey 二次 send 被吞', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 100 } })

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }))
    handle.send(textMsg('msg2', { dedupeKey: 'key1' }))

    expect(port.sendCalls).toHaveLength(1)
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('不同 dedupeKey 正常发送', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 100 } })

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }))
    handle.send(textMsg('msg2', { dedupeKey: 'key2' }))

    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })

  it('maxKeys LRU 挤出：超容量后旧 key 可重发', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 2 } })

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }))
    handle.send(textMsg('msg2', { dedupeKey: 'key2' }))
    handle.send(textMsg('msg3', { dedupeKey: 'key3' }))

    expect(port.sendCalls).toHaveLength(3)

    handle.send(textMsg('msg4', { dedupeKey: 'key1' }))
    expect(port.sendCalls).toHaveLength(4)

    handle.dispose()
  })

  it('无 dedupeKey 时不参与去重（#12：warn 一次性提示 + 照常投递）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 100 } })

    handle.send(textMsg('msg1'))
    handle.send(textMsg('msg1'))

    expect(port.sendCalls).toHaveLength(2)
    // #12 缺 key 提示：一次性（handle 级），不刷屏、不 throw
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('dedupeKey')

    handle.send(textMsg('msg2'))
    expect(port.sendCalls).toHaveLength(3)
    expect(warnSpy).toHaveBeenCalledTimes(1) // 后续缺 key 消息不再重复 warn

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('无 dedupe 配置时不去重', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }))
    handle.send(textMsg('msg2', { dedupeKey: 'key1' }))

    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })
})
