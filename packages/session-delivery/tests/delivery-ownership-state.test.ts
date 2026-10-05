/**
 * u1 状态机全迁移路径（D9①，设计 delivery-ownership-kernel.md §3）。
 *
 * 合法迁移逐条锁定：queued→in-flight（受理）/ in-flight→delivered（confirmDelivered）/
 * in-flight→queued（requeue 对账回收）/ queued→cancelled（cancel 本地移除）/
 * in-flight→cancelled（两段式收回确认）/ in-flight→failed（重试耗尽）/ failed→queued
 * （requeue 重试）/ failed→cancelled（× 移除）/ queued→delivered（实施扩展①：rebuild
 * 直确认 / 出站中回执先到）。
 * 非法迁移拒绝：终态不可 requeue（防复活）、failed 不可直 confirmDelivered、
 * 未知 id no-op。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'
import type { DeliveryLane } from '../src/types.js'

describe('u1-state 合法迁移路径', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('创建即 queued，lane 记录（显式 lane 保留，缺省 direct）', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1', lane: 'queued' })
    handle.send(textMsg('m2'), { id: 'u-2' })

    const active = handle.entriesFull().active
    expect(active.map((e) => e.state)).toEqual(['queued', 'queued'])
    expect(active.map((e) => e.lane)).toEqual<DeliveryLane[]>(['queued', 'direct'])
    expect(active[0]!.id).toBe('u-1')
    expect(active[0]!.sendAttempts).toBe(0)

    handle.dispose()
  })

  it('queued → in-flight：出站投递被受理（两阶段回执第一阶段）', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    // 出站批次在途（port.send 未返回）：条目仍 queued
    expect(handle.entriesFull().active[0]!.state).toBe('queued')

    sendResolve!()
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')

    handle.dispose()
  })

  it('in-flight → delivered：confirmDelivered 落终态 + tombstone', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight') // 同步受理

    expect(handle.confirmDelivered('u-1')).toBe(true)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toEqual([
      { id: 'u-1', state: 'delivered', lane: 'direct', settledAt: expect.any(Number) },
    ])

    handle.dispose()
  })

  it('in-flight → queued：requeue 对账回收重投（idle 下经 gate 立即第二次投递）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
    expect(port.sendCalls).toHaveLength(1)

    expect(handle.requeue(['u-1'])).toBe(1)
    // 回收重投：requeue 置回 queued 至队首 → idle gate 复核通过 → 立即重投受理
    expect(port.sendCalls).toHaveLength(2) // 第二次投递 = 回收重投发生
    expect(port.sendCalls[1]!.msg.payload.content).toBe('m1')
    const entry = handle.entriesFull().active[0]!
    expect(entry.state).toBe('in-flight') // 重投已受理
    expect(entry.sendAttempts).toBe(0) // 回收重置
    expect(handle.entriesFull().tombstones).toHaveLength(0) // 中间态不产 tombstone

    handle.dispose()
  })

  it('queued → cancelled：cancel 本地移除 + tombstone（未投递即撤）', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('queued text'), { id: 'u-1' })
    expect(port.sendCalls).toHaveLength(0) // busy 未投

    const result = handle.cancel('u-1')
    expect(result.kind).toBe('cancelled')
    expect(result).toMatchObject({
      kind: 'cancelled',
      entry: { id: 'u-1', state: 'cancelled', payload: { kind: 'text', content: 'queued text' } },
    })
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'cancelled' })

    handle.dispose()
  })

  it('in-flight → cancelled：两段式（首调标记待收回留守 in-flight，二调收回确认终结）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')

    // 首调：标记待收回，条目留守 in-flight（适配器驱动 clear_queue 收回）
    const first = handle.cancel('u-1')
    expect(first.kind).toBe('reclaim-requested')
    expect(first).toMatchObject({ entry: { id: 'u-1', state: 'in-flight' } })
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
    expect(handle.entriesFull().tombstones).toHaveLength(0)

    // 二调：收回确认 → 终结
    const second = handle.cancel('u-1')
    expect(second.kind).toBe('cancelled')
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'cancelled' })

    handle.dispose()
  })

  it('in-flight → failed：failInFlight 断连终局（ADR-0122），条目留守 failed 至处置', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    // 造 in-flight：受理成功（port.send 默认同步受理）→ 断连终局
    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
    expect(handle.failInFlight('pi connection lost')).toBe(1)

    const entry = handle.entriesFull().active[0]!
    expect(entry.state).toBe('failed')
    expect(entry.sendAttempts).toBe(1)
    expect(entry.settledAt).toBeTypeOf('number')
    expect(handle.entriesFull().tombstones).toHaveLength(0) // failed 是活跃态，不产 tombstone

    handle.dispose()
  })

  it('failed → queued：requeue 用户重试（resync 单条重报），settledAt 清除后重投', () => {
    const port = makeMockPort()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)

    // 造 failed（断连终局）：受理成功 → failInFlight
    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.failInFlight('pi connection lost')
    expect(handle.entriesFull().active[0]!.state).toBe('failed')
    expect(port.sendCalls).toHaveLength(1)

    expect(handle.requeue(['u-1'])).toBe(1)
    expect(port.sendCalls).toHaveLength(2) // 重投发生
    const entry = handle.entriesFull().active[0]!
    expect(entry.state).toBe('in-flight') // 重投已受理
    expect(entry.sendAttempts).toBe(0)
    expect(entry.settledAt).toBeUndefined()

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('failed → cancelled：cancel × 移除 failed 条目', () => {
    const port = makeMockPort()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.failInFlight('pi connection lost')
    expect(handle.entriesFull().active[0]!.state).toBe('failed')

    const result = handle.cancel('u-1')
    expect(result.kind).toBe('cancelled')
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'cancelled' })

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('queued → delivered（实施扩展①）：rebuild 直确认重建——busy 留队的条目直接确认送达', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(handle.entriesFull().active[0]!.state).toBe('queued') // busy 留队（rebuild 重建形态）

    // reattach 场景：适配器扫描 transcript 判已 delivered → send 重建 + 直确认
    expect(handle.confirmDelivered('u-1')).toBe(true)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'delivered' })
    expect(port.sendCalls).toHaveLength(0) // 不重投

    handle.dispose()
  })

  it('queued → delivered（实施扩展①）：出站中送达回执先于受理回执到达（事实优先）', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(handle.entriesFull().active[0]!.state).toBe('queued') // 出站批次在途

    // message_end 先于 RPC resolve 到达
    expect(handle.confirmDelivered('u-1')).toBe(true)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'delivered' })

    // 迟到的受理回执：条目已终态，无二次转移、无炸
    sendResolve!()
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toHaveLength(1)

    handle.dispose()
  })
})

describe('u1-state 非法迁移拒绝', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('requeue(delivered) 拒绝：终态条目不复活（tombstone 保持，无重投）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.confirmDelivered('u-1')

    expect(handle.requeue(['u-1'])).toBe(0)
    expect(port.sendCalls).toHaveLength(1) // 无第二次投递
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'delivered' })

    handle.dispose()
  })

  it('requeue(cancelled) 拒绝：cancelled tombstone 防「复活」（D5②）', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.cancel('u-1')

    expect(handle.requeue(['u-1'])).toBe(0)
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'cancelled' })

    handle.dispose()
  })

  it('confirmDelivered(failed) 拒绝：failed 未投递成功，不构成送达事实', () => {
    const port = makeMockPort()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.failInFlight('pi connection lost')
    expect(handle.entriesFull().active[0]!.state).toBe('failed')

    expect(handle.confirmDelivered('u-1')).toBe(false)
    expect(handle.entriesFull().active[0]!.state).toBe('failed') // 状态不变
    expect(handle.entriesFull().tombstones).toHaveLength(0)

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('confirmDelivered(未知 id) no-op 返回 false', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    expect(handle.confirmDelivered('no-such-id')).toBe(false)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toHaveLength(0)

    handle.dispose()
  })

  it('cancel(已终态) 幂等：already-final 携带既有 tombstone，不二次写', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.cancel('u-1')
    const before = handle.entriesFull().tombstones

    const result = handle.cancel('u-1')
    expect(result.kind).toBe('already-final')
    expect(result).toMatchObject({ tombstone: { id: 'u-1', state: 'cancelled' } })
    expect(handle.entriesFull().tombstones).toEqual(before)

    handle.dispose()
  })

  it('cancel(未知 id) 返回 not-found', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    expect(handle.cancel('no-such-id')).toEqual({ kind: 'not-found' })

    handle.dispose()
  })
})
