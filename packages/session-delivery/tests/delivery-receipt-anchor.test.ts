/**
 * D1 申报制（receiptAnchor）内核级验收（msg-pipeline-debloat U-C1）。
 *
 * 覆盖设计 §3.3 D1 的判定语义与边界形态：
 * - 单条 acceptance：受理即 delivered + onSettled 送达口径回调（confirmDelivered 驱动）
 * - 全 marker：受理后维持 in-flight 等回执（现状保守语义不变）
 * - 混合提交（per-entry 粒度关键锁）：acceptance 直落 delivered，marker 维持
 *   in-flight——envelope 挂载形态（取首条值）会丢此粒度，本用例即否决形态的回归锁
 * - 全 acceptance（死锁反例重演）：≥2 条无标记受理后全部落地，在途清零
 *   （§2.3 七环第 5 环构造性消失）
 * - 首败语义锁（P0-20）：port.send 失败首败即停逐条 rejected（ADR-0122）
 * - 空批：无条目 flush no-op
 *
 * [已不可达用例删除登记] 原用例的「busy park 同批出站」构造（idle 翻转 + flush 成批）
 * 随忙闲门禁删除而不可达，2026-10-23 投递域清理批次删除——per-entry 粒度改以
 * 逐条出站形态锁定（内核 doSend 成批路径由 command-lane 套件覆盖）。
 *
 * 运行：cd packages/session-delivery && npx vitest run tests/delivery-receipt-anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDelivery } from '../src/index.js'
import type { DeliveryPort } from '../src/types.js'
import { customMsg, makeMockPort, textMsg } from './helpers.js'

function makePort(): ReturnType<typeof makeMockPort> {
  return makeMockPort()
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('D1 申报制：单条 acceptance', () => {
  it('send 单条申报 acceptance → 受理即 delivered，onSettled 送达口径回调触发', () => {
    const port = makePort()
    const settled: Array<{ content: string; outcome: string }> = []
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settled.push({ content: msg.payload.content, outcome }),
    })

    const r = handle.send(customMsg('subagents:notify', 'notify: done'), { receiptAnchor: 'acceptance' })
    expect(r.kind).toBe('accepted')
    expect(port.sendCalls).toHaveLength(1)

    // 受理即终态：active 清零（无 in-flight 滞留）+ tombstone delivered
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toMatchObject([{ state: 'delivered' }])
    // D9⑤ 送达口径：'delivered' 由受理即落地的 confirmDelivered 驱动
    expect(settled).toEqual([{ content: 'notify: done', outcome: 'delivered' }])

    handle.dispose()
  })

  it('sendChecked 申报 acceptance：promise 仍按受理口径 resolve（D9⑤ 显式例外），条目随后落 delivered', async () => {
    const port = makePort()
    const handle = createDelivery(port)

    const p = handle.sendChecked(customMsg('subagents:notify', 'notify: done'), { receiptAnchor: 'acceptance' })
    await expect(p).resolves.toBeUndefined() // 同步 settle（受理时点，不阻塞调用方）
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toMatchObject([{ state: 'delivered' }])

    handle.dispose()
  })

  it('缺省（不申报）维持 marker 语义：受理后 in-flight 等回执，确认才终态', () => {
    const port = makePort()
    const handle = createDelivery(port)

    const r = handle.send(textMsg('用户消息'))
    expect(r.kind).toBe('accepted')
    expect(handle.entriesFull().active[0]).toMatchObject({ state: 'in-flight' }) // 等回执
    expect(handle.entriesFull().tombstones).toHaveLength(0)

    handle.confirmDelivered(r.kind === 'accepted' ? r.id : '')
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toMatchObject([{ state: 'delivered' }])

    handle.dispose()
  })
})

describe('D1 申报制：per-entry 申报粒度', () => {
  it('混合提交：acceptance 条目受理即 delivered，marker 条目维持 in-flight（粒度保留锁）', () => {
    const port = makePort()
    const handle = createDelivery(port)

    // 受理即出站下逐条出站；per-entry 粒度 = 各条按各自申报落地
    const rAccept = handle.send(customMsg('subagents:notify', 'notify: done'), { receiptAnchor: 'acceptance' })
    const rMarker = handle.send(textMsg('用户消息')) // 缺省 marker

    expect(port.sendCalls).toHaveLength(2)
    // acceptance 落地，marker 留 in-flight
    expect(handle.entriesFull().active.map((e) => e.id)).toEqual([rMarker.kind === 'accepted' ? rMarker.id : ''])
    expect(handle.entriesFull().tombstones).toMatchObject([{ id: rAccept.kind === 'accepted' ? rAccept.id : '', state: 'delivered' }])

    // marker 条目回执到达后正常终态
    handle.confirmDelivered(rMarker.kind === 'accepted' ? rMarker.id : '')
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones.map((t) => t.state)).toEqual(['delivered', 'delivered'])

    handle.dispose()
  })

  it('全 marker：受理后维持 in-flight 等回执（现状语义不变）', () => {
    const port = makePort()
    const handle = createDelivery(port)

    const r1 = handle.send(textMsg('第一条'), { id: 'u-1' })
    const r2 = handle.send(textMsg('第二条'), { id: 'u-2' })

    expect(port.sendCalls).toHaveLength(2) // 逐条出站
    expect(handle.entriesFull().active.map((e) => e.state)).toEqual(['in-flight', 'in-flight'])
    expect(handle.entriesFull().tombstones).toHaveLength(0)

    handle.confirmDelivered(r1.kind === 'accepted' ? r1.id : '')
    handle.confirmDelivered(r2.kind === 'accepted' ? r2.id : '')
    expect(handle.entriesFull().active).toHaveLength(0)

    handle.dispose()
  })

  it('全 acceptance（死锁反例重演）：≥2 条无标记受理后全部落地，在途清零', () => {
    const port = makePort()
    const handle = createDelivery(port)

    handle.send(customMsg('subagents:notify', 'notify: A done'), { receiptAnchor: 'acceptance' })
    handle.send(customMsg('subagents:notify', 'notify: B done'), { receiptAnchor: 'acceptance' })

    expect(port.sendCalls).toHaveLength(2) // 逐条出站
    expect(handle.entriesFull().active).toHaveLength(0) // 在途集合归零（构造性前提）
    expect(handle.entriesFull().tombstones.map((t) => t.state)).toEqual(['delivered', 'delivered'])

    // 后续消息立即投出（不死锁）
    handle.send(customMsg('subagents:notify', 'notify: C done'), { receiptAnchor: 'acceptance' })
    expect(port.sendCalls).toHaveLength(3)

    handle.dispose()
  })
})

describe('D1 申报制：首败即停语义（P0-20 锁，ADR-0122）', () => {
  it('首拍受理失败首败即停：条目 rejected 逐条回调（acceptance 与 marker 对齐），无重试', () => {
    const port = makePort()
    // 覆写 send：恒显式拒绝（accepted:false）
    vi.mocked(port.send).mockImplementation((msg, intent) => {
      void msg
      void intent
      return { accepted: false, reason: 'transient' }
    })
    const settled: Array<{ content: string; outcome: string }> = []
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => {
        settled.push({ content: msg.payload.content, outcome })
      },
    })

    // 受理即出站：逐条出站各自首败。v3 缺省按载荷：custom = retain（失败留守，不发
    // 失败终局通知）——本用例锁定的是 forget 语义的首败即停（P0-20 / ADR-0122 锁：
    // 首败即停 + 显式上报 + 无内核重试窗口），显式申报 onFailure:'forget'。
    handle.send(customMsg('subagents:notify', 'notify: A done'), {
      receiptAnchor: 'acceptance',
      onFailure: 'forget',
    })
    handle.send(customMsg('subagents:notify', 'notify: B done'), {
      receiptAnchor: 'acceptance',
      onFailure: 'forget',
    })

    // 首败即停：条目 rejected 逐条回调（per-message 契约保持），无重试窗口
    expect(settled).toEqual([
      { content: 'notify: A done', outcome: 'rejected' },
      { content: 'notify: B done', outcome: 'rejected' },
    ])
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toHaveLength(0) // 未受理无判重语义

    handle.dispose()
  })
})

describe('D1 申报制：空批边界', () => {
  it('无条目 flush：no-op 不投递、不异常', () => {
    const port = makePort()
    const handle = createDelivery(port)

    expect(() => handle.flush()).not.toThrow()
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.entriesFull().active).toHaveLength(0)

    handle.dispose()
  })
})
