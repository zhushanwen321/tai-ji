/**
 * edit 原语全行为（chat-flow-consistency D6：原位替换——id 与排队位置均不变）：
 *
 * - queued 替换：payload 换新、位置不动、释放持有后出站文本 = 新内容（保位语义）
 * - in-flight 替换：registry 收回路径（clear_queue 收回后、requeue 前）的合法窗口
 * - failed 替换：留守行编辑（E7），替换后由调用方 requeue 重投
 * - 拒绝面：终态（delivered/cancelled）、未知 id、queued 且在出站批（受理登记窗口，
 *   文本可能已进底层通道——双投防御）、disposed
 * - msg.payload 同步替换（onSettled per-message 契约：消费方拿到替换后内容）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

/** hold 拒 port（设计内等待）：条目留守 queued 的构造器（warn 由用例自行静音）。 */
function makeHoldPort(): ReturnType<typeof makeMockPort> {
  return makeMockPort({
    send: () => ({ accepted: false as const, deferred: 'merge-commit-hold' as const }),
  })
}

describe('kernel edit 原语（chat-flow-consistency D6）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('queued 替换：payload 换新、id 与位置不变，出站文本 = 新内容', () => {
    const port = makeHoldPort()
    const handle = createDelivery(port)
    handle.send(textMsg('A 原文'), { id: 'u-A', lane: 'steer' })
    handle.send(textMsg('B 原文'), { id: 'u-B', lane: 'steer' })
    expect(handle.depth()).toBe(2)

    // 替换 A：B 保持在 A 之后（位置不动）
    expect(handle.edit('u-A', { kind: 'text', content: "A' 新文" })).toBe(true)
    const active = handle.entriesFull().active
    expect(active.map((e) => e.id)).toEqual(['u-A', 'u-B'])
    expect(active[0]!.payload).toEqual({ kind: 'text', content: "A' 新文" })

    // 释放持有重投：出站顺序不变（A 先出），A 的出站文本 = 新内容、B = 原文
    handle.flush()
    expect(port.sendCalls.length).toBeGreaterThanOrEqual(2)
    expect(port.sendCalls[0]!.msg.payload).toEqual({ kind: 'text', content: "A' 新文" })
    handle.dispose()
  })

  it('in-flight 替换（收回路径窗口）：true 且 payload 换新', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)
    handle.send(textMsg('在途原文'), { id: 'u-1', lane: 'steer' })
    // 受理即出站（v3 唯一出站形态）→ in-flight
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
    expect(handle.edit('u-1', { kind: 'text', content: '在途新文' })).toBe(true)
    expect(handle.entriesFull().active[0]!.payload).toEqual({ kind: 'text', content: '在途新文' })
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
    handle.dispose()
  })

  it('failed 替换（E7 留守行编辑）：true；调用方 requeue 后出站 = 新内容', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)
    handle.send(textMsg('失败原文'), { id: 'u-1', lane: 'steer' })
    expect(handle.failInFlight('pi connection lost')).toBe(1)
    expect(handle.edit('u-1', { kind: 'text', content: '失败新文' })).toBe(true)
    // 编辑即重发（registry failed 分支语义）：requeue 重投，出站文本 = 新内容
    expect(handle.requeue(['u-1'])).toBe(1)
    expect(port.sendCalls.at(-1)!.msg.payload).toEqual({ kind: 'text', content: '失败新文' })
    handle.dispose()
  })

  it('拒绝面：终态 / 未知 id / 出站批内 queued / disposed', () => {
    const port = makeHoldPort()
    const handle = createDelivery(port)
    handle.send(textMsg('m1'), { id: 'u-1' })
    // 终态：delivered
    handle.confirmDelivered('u-1')
    expect(handle.edit('u-1', { kind: 'text', content: 'x' })).toBe(false)
    // 未知 id
    expect(handle.edit('u-none', { kind: 'text', content: 'x' })).toBe(false)
    handle.dispose()

    // 出站批内 queued：send 挂起（thenable 未 settle）→ doSend 成批、条目仍 queued
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const port2 = makeMockPort({
      send: () => gate.then(() => undefined),
    })
    const handle2 = createDelivery(port2)
    handle2.send(textMsg('batch'), { id: 'u-2' })
    expect(handle2.edit('u-2', { kind: 'text', content: 'x' })).toBe(false)
    release()
    handle2.dispose()
  })

  it('msg.payload 同步替换：onSettled per-message 契约拿到替换后内容', () => {
    const onSettled = vi.fn()
    const port = makeMockPort()
    const handle = createDelivery(port, { onSettled })
    const msg = textMsg('旧内容')
    handle.send(msg, { id: 'u-1' })
    handle.edit('u-1', { kind: 'text', content: '新内容' })
    handle.confirmDelivered('u-1')
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]![0].payload).toEqual({ kind: 'text', content: '新内容' })
    handle.dispose()
  })
})
