/**
 * A1-migration: 搬迁 — dispose 短路 / dedupe 场景。
 *
 * [已不可达用例删除登记] 原「gate 拒绝→留守→边沿/外部触发重投」三用例（busy 留守 /
 * 持续 busy 不强发 / G4 等价 gate）、「合批窗口滑动重置」两用例、「flush 跳过合批窗口」
 * 用例随忙闲门禁与合批窗口（队列持有形态）删除而不可达，2026-10-23 投递域
 * 清理批次删除；flush 触发与 retain 重投由 delivery-on-failure / delivery-settled
 * 套件继续锁定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A1-migration 搬迁: dispose 短路', () => {
  it('dispose 后 send 不入队不发送', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.dispose()
    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.depth()).toBe(0)
  })

  it('dispose 后 flush 不再触发发送（调度面全部短路）', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('hello')) // 受理即出站：dispose 前的投递已发生
    expect(port.sendCalls).toHaveLength(1)
    handle.dispose()
    handle.flush() // disposed 短路

    vi.advanceTimersByTime(10_000)
    expect(port.sendCalls).toHaveLength(1) // 无二次投递

    vi.useRealTimers()
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
