/**
 * A1-migration: 搬迁 — notifier flush/退避/合批/dedupe 场景。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A1-migration 搬迁: gate 拒绝→留守→边沿/外部触发重投', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('主 agent busy 时留守不发送，idle 后经 flush 复核投递', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(10_000)
    expect(port.sendCalls).toHaveLength(0) // busy 留守：无退避轮询强发（ADR-0112）

    port.idle = true
    handle.flush() // 外部触发复核（真实链 = settled 边沿驱动）
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('主 agent 持续 busy 留守不发送（无订阅装配也不强发——ADR-0112 退避轮询退役）', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(10_000)

    expect(port.sendCalls).toHaveLength(0)

    handle.dispose()
  })

  it('#10 isIdle=true + 内核在途条目未终态 → 视为 busy 不立即投（G4 等价 gate；D2 拆除后 pending 判定内查 active 表）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    // 制造内核在途：首条受理转 in-flight（缺省 marker 申报，等回执未确认）
    const first = handle.send(textMsg('在途一条'))
    expect(port.sendCalls).toHaveLength(1)
    const firstId = first.kind === 'accepted' ? first.id : undefined

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(1) // idle 但在途未终态 → 留守

    handle.confirmDelivered(firstId!) // 送达回执 → 在途清零
    handle.flush() // 外部触发复核（真实链 = settled 边沿驱动）
    expect(port.sendCalls).toHaveLength(2)

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

  it('dispose 后 flush 不再触发发送（调度面全部短路；ADR-0112 退役后已无退避 timer）', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port)

    handle.send(textMsg('hello'))
    handle.dispose()
    handle.flush() // disposed 短路

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

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }), { receiptAnchor: 'acceptance' })
    handle.send(textMsg('msg2', { dedupeKey: 'key1' }), { receiptAnchor: 'acceptance' })

    expect(port.sendCalls).toHaveLength(1)
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('不同 dedupeKey 正常发送', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 100 } })

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }), { receiptAnchor: 'acceptance' })
    handle.send(textMsg('msg2', { dedupeKey: 'key2' }), { receiptAnchor: 'acceptance' })

    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })

  it('maxKeys LRU 挤出：超容量后旧 key 可重发', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 2 } })

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }), { receiptAnchor: 'acceptance' })
    handle.send(textMsg('msg2', { dedupeKey: 'key2' }), { receiptAnchor: 'acceptance' })
    handle.send(textMsg('msg3', { dedupeKey: 'key3' }), { receiptAnchor: 'acceptance' })

    expect(port.sendCalls).toHaveLength(3)

    handle.send(textMsg('msg4', { dedupeKey: 'key1' }), { receiptAnchor: 'acceptance' })
    expect(port.sendCalls).toHaveLength(4)

    handle.dispose()
  })

  it('无 dedupeKey 时不参与去重（#12：warn 一次性提示 + 照常投递）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = makeMockPort()
    const handle = createDelivery(port, { dedupe: { maxKeys: 100 } })

    handle.send(textMsg('msg1'), { receiptAnchor: 'acceptance' })
    handle.send(textMsg('msg1'), { receiptAnchor: 'acceptance' })

    expect(port.sendCalls).toHaveLength(2)
    // #12 缺 key 提示：一次性（handle 级），不刷屏、不 throw
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('dedupeKey')

    handle.send(textMsg('msg2'), { receiptAnchor: 'acceptance' })
    expect(port.sendCalls).toHaveLength(3)
    expect(warnSpy).toHaveBeenCalledTimes(1) // 后续缺 key 消息不再重复 warn

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('无 dedupe 配置时不去重', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('msg1', { dedupeKey: 'key1' }), { receiptAnchor: 'acceptance' })
    handle.send(textMsg('msg2', { dedupeKey: 'key1' }), { receiptAnchor: 'acceptance' })

    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })
})
