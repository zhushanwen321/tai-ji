/**
 * u1 双视图投影（D9②/D5③）+ onChange 订阅 + TextPayload.images 透传（D9④）+
 * onSettled 口径时点（D9⑤：sendChecked 受理即 resolve，送达确认不阻塞 checked 返回）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'
import type { DeliveryEntryState } from '../src/types.js'

describe('u1-view 双视图投影（D9②/D5③）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('全量视图：活跃条目完整字段 + 全部 tombstone；投影视图 = 活跃全量 + delivered 最近 N 条', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    // 3 条 delivered
    for (const id of ['u-1', 'u-2', 'u-3']) {
      handle.send(textMsg(id), { id })
      handle.confirmDelivered(id)
    }
    // 1 条 queued（busy 留队）
    ;(port as { idle: boolean }).idle = false
    handle.send(textMsg('pending'), { id: 'u-4' })

    // 全量视图（无参）
    const full = handle.entries()
    expect(full.active.map((e) => e.id)).toEqual(['u-4'])
    expect(full.active[0]).toMatchObject({
      id: 'u-4',
      state: 'queued',
      lane: 'direct',
      payload: { kind: 'text', content: 'pending' },
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      sendAttempts: 0,
    })
    expect(full.tombstones.map((t) => t.id)).toEqual(['u-1', 'u-2', 'u-3'])

    // 投影视图（带参）：活跃全量 + delivered 全部（3 < 默认窗口 50）
    const proj = handle.entries({})
    expect(proj.entries.map((e) => e.id)).toEqual(['u-4', 'u-1', 'u-2', 'u-3'])
    expect(proj.entries.map((e) => e.state)).toEqual<DeliveryEntryState[]>([
      'queued',
      'delivered',
      'delivered',
      'delivered',
    ])

    handle.dispose()
  })

  it('投影窗口恒 50：56 条 delivered 只投影最近 50 条完整条目', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    for (let i = 0; i < 56; i++) {
      handle.send(textMsg(`m${i}`), { id: `u-${i}` })
      handle.confirmDelivered(`u-${i}`)
    }

    const proj = handle.entries({})
    expect(proj.entries).toHaveLength(50) // 投影窗口恒 50（DEFAULT_DELIVERED_WINDOW）
    expect(proj.entries.map((e) => e.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `u-${i + 6}`), // 最近 50 条：u-6..u-55
    )
    // 全量视图 tombstone 不受窗口影响（判重正确性不依赖展示窗口）
    expect(handle.entries().tombstones).toHaveLength(56)

    handle.dispose()
  })

  it('cancelled 不投影（D5③）；tombstone 全量视图可见', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('kept'), { id: 'u-1' })
    handle.send(textMsg('revoked'), { id: 'u-2' })
    handle.cancel('u-2')

    const proj = handle.entries({})
    expect(proj.entries.map((e) => e.id)).toEqual(['u-1']) // cancelled 不进投影
    expect(handle.entries().tombstones.map((t) => t.id)).toEqual(['u-2']) // 判重表可见

    handle.dispose()
  })

  it('快照防御性：修改 entries() 返回对象不影响内核状态', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    const full = handle.entries()
    ;(full.active[0] as { state: string }).state = 'failed' // 越权改动快照
    expect(handle.entries().active[0]!.state).toBe('in-flight') // 内核不受影响（同步受理后的真实态）

    handle.dispose()
  })

  it('投影视图条目为完整条目（delivered 含 payload 全文，D5③「完整条目」）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('full body', { dedupeKey: 'k1' }), { id: 'u-1' })
    handle.confirmDelivered('u-1')

    const proj = handle.entries({})
    expect(proj.entries).toHaveLength(1)
    expect(proj.entries[0]).toMatchObject({
      id: 'u-1',
      state: 'delivered',
      payload: { kind: 'text', content: 'full body' },
    })

    handle.dispose()
  })
})

describe('u1-view onChange 订阅（state topic 装配）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('条目创建/受理/送达/撤销各触发一次变更，幂等吞不触发，退订后不再触发', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)
    const events: string[] = []
    const unsub = handle.onChange(() => events.push('change'))

    handle.send(textMsg('m1'), { id: 'u-1' }) // 创建 + 同步受理（两次状态变更）
    expect(events).toHaveLength(2)

    handle.send(textMsg('m1'), { id: 'u-1' }) // 幂等吞：不触发
    expect(events).toHaveLength(2)

    handle.confirmDelivered('u-1') // 送达
    expect(events).toHaveLength(3)

    handle.send(textMsg('m2'), { id: 'u-2' }) // 创建 + 受理（累计 5）
    handle.requeue(['u-2']) // 回收重排(#6) + idle 立即重投受理(#7)（累计 7）
    expect(events).toHaveLength(7)

    handle.cancel('u-2') // 撤销（累计 8）
    expect(events).toHaveLength(8)

    unsub()
    handle.send(textMsg('m3'), { id: 'u-3' })
    expect(events).toHaveLength(8) // 退订后不触发（累计保持）

    handle.dispose()
  })

  it('重试耗尽 failed 终态触发 onChange（创建 + 终态各一次）', () => {
    const port = makeMockPort({
      send: () => {
        throw new Error('pi stuck')
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { backoff: { ms: 1, max: 0 } })
    let changes = 0
    handle.onChange(() => changes++)

    // 同步链：创建(#1) → port.send 抛错 → 零重试上限即 failed 终态(#2)
    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(changes).toBe(2)
    vi.advanceTimersByTime(5) // 无后续变更
    expect(changes).toBe(2)

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('drain 清空触发一次；dispose 后订阅清空不触发', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)
    let changes = 0
    handle.onChange(() => changes++)

    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(changes).toBe(1)
    handle.drain()
    expect(changes).toBe(2)

    handle.dispose()
    // dispose 后 handle 不再产生变更（send 短路）
    handle.send(textMsg('m2'), { id: 'u-2' })
    expect(changes).toBe(2)
  })
})

describe('u1-view TextPayload.images 透传（D9④）', () => {
  const images = [
    { data: 'base64-a', mimeType: 'image/png' },
    { data: 'base64-b', mimeType: 'image/jpeg' },
  ]

  it('单条 send：images 原样透传到 port.send', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send({ payload: { kind: 'text', content: 'with image', images } }, { id: 'u-1' })
    expect(port.sendCalls[0]!.msg.payload).toEqual({
      kind: 'text',
      content: 'with image',
      images,
    })

    handle.dispose()
  })

  it('sendChecked：images 透传', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    await handle.sendChecked({ payload: { kind: 'text', content: 'checked img', images } })
    expect(port.sendCalls[0]!.msg.payload).toEqual({
      kind: 'text',
      content: 'checked img',
      images,
    })

    handle.dispose()
  })

  it('多条 text 合批：images 各条保序拼接（内核不剥离）', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    const handle = createDelivery(port, { mergeWindowMs: 5000, mergeHoldActive: () => true })

    handle.send({ payload: { kind: 'text', content: 'a', images: [images[0]!] } }, { id: 'u-1', merge: true })
    handle.send({ payload: { kind: 'text', content: 'b', images: [images[1]!] } }, { id: 'u-2', merge: true })
    vi.advanceTimersByTime(5000)

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload).toEqual({
      kind: 'text',
      content: 'a\n\n---\n\nb',
      images,
    })

    handle.dispose()
    vi.useRealTimers()
  })
})

describe('u1-view D9⑤ 口径时点：sendChecked 受理即 resolve（送达确认不阻塞）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('checked promise 在受理时点 resolve，无需等待 confirmDelivered', async () => {
    let resolved = false
    const port = makeMockPort()
    const handle = createDelivery(port)

    const promise = handle.sendChecked(textMsg('m1'), { id: 'u-1' }).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true) // 受理成功即 resolve
    // 条目仍 in-flight 等送达回执（送达口径的 onSettled 尚未发生）
    expect(handle.entries().active[0]!.state).toBe('in-flight')

    await promise
    handle.dispose()
  })

  it('checked 条目的 onSettled("delivered") 同样等 confirmDelivered（口径统一）', async () => {
    const onSettled = vi.fn()
    const port = makeMockPort()
    const handle = createDelivery(port, { onSettled })

    await handle.sendChecked(textMsg('m1'), { id: 'u-1' })
    expect(onSettled).not.toHaveBeenCalled() // 受理不回调（checked 例外只针对 promise resolve）

    handle.confirmDelivered('u-1')
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]![1]).toBe('delivered')

    handle.dispose()
  })

  it('送达回执长时间不到：checked 早已返回，条目稳定 in-flight（不误报）', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    await handle.sendChecked(textMsg('m1'), { id: 'u-1' })
    vi.advanceTimersByTime(70_000) // 远超任何窗口
    expect(handle.entries().active[0]!.state).toBe('in-flight') // 不自动升级 delivered

    handle.dispose()
  })
})

describe('u1-view v1 机制保持抽查（busy gate / watchdog / dispose）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('30s watchdog：settled 丢失时复核投递（条目 queued → 出站受理 in-flight）', () => {
    let idle = false
    const port = makeMockPort({
      isIdle: () => idle,
      subscribeSettled: () => () => {}, // 订阅成立但回调从不触发
    })
    const handle = createDelivery(port, { watchdogMs: 30_000, backoff: { ms: 100, max: 500 } })

    handle.send(textMsg('m1'), { id: 'u-1' })
    vi.advanceTimersByTime(29_999)
    expect(port.sendCalls).toHaveLength(0)

    idle = true
    vi.advanceTimersByTime(1) // watchdog 第一拍
    expect(port.sendCalls).toHaveLength(1)
    expect(handle.entries().active[0]!.state).toBe('in-flight')

    handle.dispose()
  })

  it('dispose 语义保持：清条目集（含 tombstone），不触发 onSettled，checked reject', async () => {
    const onSettled = vi.fn()
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('m1'), { id: 'u-1' }) // 在途
    handle.send(textMsg('m2'), { id: 'u-2' }) // 队列
    const pending = handle.sendChecked(textMsg('m3'), { id: 'u-3' })

    handle.dispose()
    expect(handle.entries().active).toHaveLength(0)
    expect(handle.entries().tombstones).toHaveLength(0) // 随 handle 释放（D5②）
    expect(onSettled).not.toHaveBeenCalled()
    await expect(pending).rejects.toThrow('delivery handle disposed')
    expect(handle.confirmDelivered('u-1')).toBe(false) // disposed 后 no-op
    expect(handle.drain()).toEqual([])

    sendResolve?.() // 迟到回执不炸
    await vi.advanceTimersByTimeAsync(0)
  })
})
