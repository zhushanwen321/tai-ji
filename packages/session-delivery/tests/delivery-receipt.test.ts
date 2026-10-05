/**
 * port.send 受理回执接线（U2 回执口径扩展位）。
 *
 * types.ts 的 DeliveryPort.send 返回值从 void 扩为 `SendReceipt | void`：
 *   - 显式 `{ accepted: false }` → 内核按发送失败处理（错误重试 / onSettled rejected）
 *   - `{ accepted: true }` / void / 其他形态 → 受理成功（旧 port 实现零改动兼容）
 *
 * 本套件锁死内核对 receipt 三形态的分流行为——SendReceipt 是 B-ledger 销账链的
 * 底层口径（扩展侧 courier 的受理事实），内核不得把 accepted:false 当成功吞掉。
 *
 * [D9⑤ 口径升级] 受理成功只把条目转 in-flight（两阶段回执第一阶段），onSettled
 * 'delivered' 回调由 confirmDelivered（送达回执）驱动——受理 ≠ 送达的机制化落地。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDelivery } from '../src/delivery.js'
import type { DeliveryPort, SendReceipt } from '../src/types.js'

function makePort(overrides?: Partial<DeliveryPort>): DeliveryPort {
  return {
    supportedPayloads: ['text'],
    isIdle: () => true,
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

  it('accepted:false（同步返回）→ 首败即停 onSettled rejected（不吞受理失败，ADR-0112）', () => {
    const onSettled = vi.fn()
    const port = makePort({
      send: (): SendReceipt => ({ accepted: false, reason: 'channel closed' }),
    })
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('m1'))
    // 首败即停：无重试窗口，rejected 通知同步收口
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]?.[1]).toBe('rejected')
    expect(handle.entriesFull().active).toHaveLength(0)

    handle.dispose()
  })

  it('accepted:false（Promise 返回）→ 同步形态等价：首败即停 rejected 终态', async () => {
    const onSettled = vi.fn()
    const port = makePort({
      send: (): Promise<SendReceipt> =>
        Promise.resolve({ accepted: false, reason: 'queue full' }),
    })
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('m2'))
    await vi.advanceTimersByTimeAsync(2)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]?.[1]).toBe('rejected')
    expect(handle.entriesFull().active).toHaveLength(0)

    handle.dispose()
  })

  it('accepted:true → 受理成功（条目 in-flight）；confirmDelivered 后 delivered（D9⑤ 送达口径）', () => {
    const onSettled = vi.fn()
    const port = makePort({
      send: (): SendReceipt => ({ accepted: true }),
    })
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('m3'))
    // 受理 ≠ 送达：受理成功只转 in-flight，不触发 'delivered' 回调
    expect(onSettled).not.toHaveBeenCalled()
    expect(handle.entriesFull().active[0]?.state).toBe('in-flight')

    // 送达回执（适配器 confirmDelivered）驱动终态回调
    expect(handle.confirmDelivered(handle.entriesFull().active[0]!.id)).toBe(true)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]?.[1]).toBe('delivered')

    handle.dispose()
  })

  it('void 返回（旧 port 实现）→ 兼容按受理成功处理（in-flight，D9⑤ 下不误报送达）', () => {
    const onSettled = vi.fn()
    const port = makePort({ send: (): void => {} })
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('m4'))
    expect(onSettled).not.toHaveBeenCalled()
    expect(handle.entriesFull().active[0]?.state).toBe('in-flight')

    handle.confirmDelivered(handle.entriesFull().active[0]!.id)
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
