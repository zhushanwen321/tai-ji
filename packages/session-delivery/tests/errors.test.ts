/**
 * D4-1 错误类（DeliveryReclaimError）验收（msg-pipeline-debloat U-B2，审计候选 16）。
 *
 * 覆盖：
 * - instanceof 判别契约：cancel / drain 的 sendChecked waiter reject 是错误类实例，
 *   dispose 的 reject 不是（句柄销毁 ≠ 用户回收，判别面必须排除）
 * - 结构化字段：kind（'cancelled' | 'drained'）+ entryId（原文案契约的语义信息转字段）
 * - message 形态锁：保持历史文案（`delivery cancelled: <id>` / `delivery drained`），
 *   日志与诊断输出字节级不变
 * - end-to-end 判别链：sendChecked 挂账 → cancel/drain reject → catch instanceof 命中
 *
 * 运行：cd packages/session-delivery && npx vitest run tests/errors.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDelivery, DeliveryReclaimError } from '../src/index.js'
import { makeMockPort } from './helpers.js'

/** port.send 永不 settle：sendChecked 挂账等待（受理口径 resolve 不触发），供 cancel/drain/dispose reject。 */
function makePendingPort(): ReturnType<typeof makeMockPort> {
  return makeMockPort({ send: () => new Promise(() => {}) })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('DeliveryReclaimError 结构化字段与文案形态', () => {
  it('cancelled：kind=cancelled + entryId + 历史文案形态', () => {
    const e = new DeliveryReclaimError('cancelled', 'm-abc-1')
    expect(e).toBeInstanceOf(DeliveryReclaimError)
    expect(e).toBeInstanceOf(Error)
    expect(e.kind).toBe('cancelled')
    expect(e.entryId).toBe('m-abc-1')
    expect(e.message).toBe('delivery cancelled: m-abc-1')
    expect(e.name).toBe('DeliveryReclaimError')
  })

  it('drained：kind=drained + entryId undefined + 历史文案形态', () => {
    const e = new DeliveryReclaimError('drained')
    expect(e.kind).toBe('drained')
    expect(e.entryId).toBeUndefined()
    expect(e.message).toBe('delivery drained')
  })
})

describe('waiter reject 的 instanceof 判别链（D4-1 消费契约）', () => {
  it('cancel 终结挂账条目 → sendChecked reject 为 DeliveryReclaimError（kind/entryId/message 三证）', async () => {
    const handle = createDelivery(makePendingPort())
    const p = handle.sendChecked({ payload: { kind: 'text', content: 'hello' } }, { id: 'm-1' })
    const caught = p.then(
      () => { throw new Error('should not resolve') },
      (e: unknown) => e,
    )
    const r = handle.cancel('m-1')
    expect(r.kind).toBe('cancelled')
    const e = await caught
    expect(e).toBeInstanceOf(DeliveryReclaimError)
    const reclaim = e as DeliveryReclaimError
    expect(reclaim.kind).toBe('cancelled')
    expect(reclaim.entryId).toBe('m-1')
    expect(reclaim.message).toBe('delivery cancelled: m-1')
    handle.dispose()
  })

  it('drain 全量回收 → 挂账 sendChecked reject 为 DeliveryReclaimError（drained / 无 entryId）', async () => {
    const handle = createDelivery(makePendingPort())
    const p = handle.sendChecked({ payload: { kind: 'text', content: 'hello' } }, { id: 'm-2' })
    const caught = p.then(
      () => { throw new Error('should not resolve') },
      (e: unknown) => e,
    )
    handle.drain()
    const e = await caught
    expect(e).toBeInstanceOf(DeliveryReclaimError)
    const reclaim = e as DeliveryReclaimError
    expect(reclaim.kind).toBe('drained')
    expect(reclaim.entryId).toBeUndefined()
    handle.dispose()
  })

  it('dispose 的 reject 不是 DeliveryReclaimError（句柄销毁 ≠ 用户回收，判别面排除）', async () => {
    const handle = createDelivery(makePendingPort())
    const p = handle.sendChecked({ payload: { kind: 'text', content: 'hello' } }, { id: 'm-3' })
    const caught = p.then(
      () => { throw new Error('should not resolve') },
      (e: unknown) => e,
    )
    handle.dispose()
    const e = await caught
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(DeliveryReclaimError)
    expect((e as Error).message).toBe('delivery handle disposed')
  })

  it('普通失败（port.send reject）不是 DeliveryReclaimError —— 双信号判据信号①不误放行', async () => {
    const port = makeMockPort({ send: () => Promise.reject(new Error('pi exploded')) })
    const handle = createDelivery(port)
    const caught = handle.sendChecked({ payload: { kind: 'text', content: 'hello' } }, { id: 'm-4' }).then(
      () => { throw new Error('should not resolve') },
      (e: unknown) => e,
    )
    const e = await caught
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(DeliveryReclaimError)
    handle.dispose()
  })
})
