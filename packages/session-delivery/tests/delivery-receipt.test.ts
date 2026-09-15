/**
 * port.send 受理回执接线（U2 回执口径扩展位）。
 *
 * types.ts 的 DeliveryPort.send 返回值从 void 扩为 `SendReceipt | void`：
 *   - 显式 `{ accepted: false }` → 内核按发送失败处理（错误重试 / onSettled rejected）
 *   - `{ accepted: true }` / void / 其他形态 → 受理成功（旧 port 实现零改动兼容）
 *
 * 本套件锁死内核对 receipt 三形态的分流行为——SendReceipt 是 B-ledger 销账链的
 * 底层口径（扩展侧 courier 的受理事实），内核不得把 accepted:false 当成功吞掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDelivery } from '../src/delivery.js'
import type { DeliveryPort, SendReceipt } from '../src/types.js'

function makePort(overrides?: Partial<DeliveryPort>): DeliveryPort {
  return {
    supportedPayloads: ['text'],
    isIdle: () => true,
    hasPendingMessages: () => false,
    send: () => {},
    ...overrides,
  }
}

function textMsg(content: string) {
  return { payload: { kind: 'text' as const, content } }
}

describe('port.send receipt（U2 回执口径）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepted:false（同步返回）→ 错误重试耗尽后 onSettled rejected（不吞受理失败）', () => {
    const onSettled = vi.fn()
    const port = makePort({
      send: (): SendReceipt => ({ accepted: false, reason: 'channel closed' }),
    })
    // 退避 1ms × 上限 1：失败 → 1 次重试 → 再失败 → rejected 终态
    const handle = createDelivery(port, { onSettled, backoff: { ms: 1, max: 1 } })

    handle.send(textMsg('m1'))
    expect(onSettled).not.toHaveBeenCalled() // 首次失败进入重试，非终态
    vi.advanceTimersByTime(2)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]?.[1]).toBe('rejected')

    handle.dispose()
  })

  it('accepted:false（Promise 返回）→ 同步形态等价：重试耗尽后 rejected 终态', async () => {
    const onSettled = vi.fn()
    const port = makePort({
      send: (): Promise<SendReceipt> =>
        Promise.resolve({ accepted: false, reason: 'queue full' }),
    })
    const handle = createDelivery(port, { onSettled, backoff: { ms: 1, max: 1 } })

    handle.send(textMsg('m2'))
    // Promise resolve（微任务）+ 退避 timer（宏任务）结算
    await vi.advanceTimersByTimeAsync(2)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]?.[1]).toBe('rejected')

    handle.dispose()
  })

  it('accepted:true → delivered（显式成功回执）', () => {
    const onSettled = vi.fn()
    const port = makePort({
      send: (): SendReceipt => ({ accepted: true }),
    })
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('m3'))
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]?.[1]).toBe('delivered')

    handle.dispose()
  })

  it('void 返回（旧 port 实现）→ 兼容按成功处理（delivered）', () => {
    const onSettled = vi.fn()
    const port = makePort({ send: (): void => {} })
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('m4'))
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]?.[1]).toBe('delivered')

    handle.dispose()
  })

  it('sendChecked：accepted:false → reject（受理失败入口即拦）', async () => {
    vi.useRealTimers() // sendChecked 走真实微任务链
    const port = makePort({
      send: (): SendReceipt => ({ accepted: false, reason: 'denied' }),
    })
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('m5'))).rejects.toThrow('denied')

    handle.dispose()
  })
})
