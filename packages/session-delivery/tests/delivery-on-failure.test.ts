/**
 * v3 失败保留策略 onFailure: 'forget' | 'retain' | 'failed'（设计 unified-delivery §3.5.3 /
 * §3.4 缺省值表 + chat-flow-consistency 第 11 条）：
 * - 缺省按载荷类型：custom = retain（无人值守，失败留下一步边沿 / 重启重入队）/
 *   text = forget（交互在席，首败即停 + 显式上报，消费方可重发——runtime 现状）。
 * - retain：失败条目留守 queued，失败轮不主动重投（idle 下立即重投会形成「失败 →
 *   重投 → 失败」同步循环——首败即停红线的对偶面），等下一 settled 边沿 / 外部
 *   flush（事件驱动，无定时器）；不发 onSettled('rejected')（留守非终局）。
 * - forget：首败即停 + onSettled('rejected') 显式上报 + 从内核移除（v2 现状锚）。
 * - failed：受理失败转 failed 终态留守（queued → failed 迁移）——不自动重投、不
 *   discard，等用户 resync 重试 / cancel 撤销，与断连 failInFlight 的 failed 同态同
 *   出路；onSettled('rejected') 显式上报（send 通路）。
 * - sendChecked 挂起条目缺省/显式 retain 按 forget 处置（同步失败回执契约与 retain
 *   重投矛盾）+ 一次性 warn；显式 failed 放行（reject 是受理口径通知，failed 留守是
 *   条目状态，不自动重投故无矛盾观测）。
 * - retain 条目重投成功 → 正常 delivered 终局（onSettled('delivered')）。
 *
 * ADR-0122 不变量：三种策略下内核都无自动重试机制——retain 的重投由外部边沿触发，
 * failed 的重试由用户 resync 驱动，非内核定时器（时间平抑红线）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage } from '../src/types.js'
import { MemoryDeliveryStore, customMsg, makeMockPort, textMsg } from './helpers.js'

const transientReject = { accepted: false as const, reason: 'transient' }
/** 设计内等待拒（F1-13，MF-1-4 判别联合 deferred 字段）：port 合批提交窗 hold（entry 未注入，非失败）。 */
const holdReject = { accepted: false as const, deferred: 'merge-commit-hold' as const }

describe('onFailure 缺省按载荷类型', () => {
  it('custom 条目缺省 retain：首败留守 queued（非移除）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' })
      const [entry] = handle.entriesFull().active
      expect(entry).toMatchObject({ id: 'sid-1', state: 'queued' }) // 留守非移除
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('text 条目缺省 forget：首败移除（v2 现状锚）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(handle.entriesFull().active).toHaveLength(0)
      expect(handle.entriesFull().tombstones).toHaveLength(0) // 未受理无判重语义
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('retain：留守与下一边沿重投（事件驱动，无定时器）', () => {
  it('失败轮不主动重投：idle 下 port.send 调用数不增（防同步失败循环）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' })
      const callsAfterFirstFailure = port.sendCalls.length
      expect(callsAfterFirstFailure).toBeGreaterThan(0)
      // 失败已发生（留守），idle 恒真——若主动重投会同步无限循环；断言本轮收尾
      expect(port.sendCalls.length).toBe(callsAfterFirstFailure)
      expect(handle.depth()).toBe(1) // 留守条目回到待投队列
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('失败轮不发 onSettled(rejected)（留守非终局）；重投成功后发 delivered', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { onSettled })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' })
      expect(onSettled).not.toHaveBeenCalled() // 留守非终局——失败终局通知不发

      // 恢复投递后重投：受理成功（缺省 marker 锚 → in-flight 等回执），凭据确认后终局
      ;(port.send as ReturnType<typeof vi.fn>).mockImplementation(() => undefined)
      handle.flush()
      expect(onSettled).not.toHaveBeenCalled() // 受理 ≠ 送达（D9⑤ 送达口径）
      expect(handle.confirmDelivered('sid-1')).toBe(true)
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0]![1]).toBe('delivered')
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('下一 settled 边沿驱动重投（受理即出站首拍已发生，边沿触发 flush 重投留守条目）', () => {
    let settledCb: (() => void) | undefined
    const sendMock = vi.fn(() => transientReject)
    const port = makeMockPort({
      send: sendMock,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {
          settledCb = undefined
        }
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' })
      // 首拍投递失败（retain 留守；受理即出站，无忙闲门禁前置）
      const callsAfterFailure = sendMock.mock.calls.length
      expect(callsAfterFailure).toBeGreaterThan(0)

      // settled 边沿 → flush 重投留守条目（旁路忙闲门禁）
      settledCb!()
      expect(sendMock.mock.calls.length).toBeGreaterThan(callsAfterFailure)

      // 恢复可投 + 再次边沿 → 重投成功（缺省 marker 锚 → in-flight）→ 凭据确认终局
      sendMock.mockImplementation(() => undefined)
      settledCb!()
      expect(handle.confirmDelivered('sid-1')).toBe(true)
      expect(handle.entriesFull().active).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('onFailure 显式覆写', () => {
  it('text + onFailure: retain → 失败留守（覆写缺省 forget）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1', onFailure: 'retain' })
      expect(handle.entriesFull().active[0]).toMatchObject({ id: 'sid-1', state: 'queued' })
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('custom + onFailure: forget → 首败移除 + onSettled(rejected)（覆写缺省 retain）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { onSettled })
    try {
      const msg = customMsg('subagents:notify', 'n-1')
      handle.send(msg, { id: 'sid-1', onFailure: 'forget' })
      expect(handle.entriesFull().active).toHaveLength(0)
      expect(onSettled).toHaveBeenCalledWith(msg, 'rejected')
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('混合批：retain 条目留守、forget 条目移除（逐条策略分流）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      // busy 起步同队，翻转后整批出站（同批混合两策略）
      port.idle = false
      handle.send(textMsg('m-1'), { id: 'sid-f', onFailure: 'forget' })
      handle.send(textMsg('m-2'), { id: 'sid-r', onFailure: 'retain' })
      port.idle = true
      handle.flush()
      const active = handle.entriesFull().active
      expect(active).toHaveLength(1)
      expect(active[0]).toMatchObject({ id: 'sid-r', state: 'queued' })
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('sendChecked 挂起条目恒 forget（同步失败回执契约优先）', () => {
  it('checked 条目显式申报 retain → 按 forget 处置（reject + 移除）+ 一次性 warn', async () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      await expect(
        handle.sendChecked(textMsg('m-1'), { id: 'cid-1', onFailure: 'retain' }),
      ).rejects.toThrow('transient')
      expect(handle.entriesFull().active).toHaveLength(0) // 未留守
      expect(handle.entriesFull().tombstones).toHaveLength(0)
      const retainWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('onFailure=retain'))
      expect(retainWarns).toHaveLength(1) // 一次性

      // 第二条不再重复 warn
      await expect(handle.sendChecked(textMsg('m-2'), { onFailure: 'retain' })).rejects.toThrow()
      expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('onFailure=retain'))).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('checked 缺省（未申报）= forget：现状锚（失败 reject + 移除）', async () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      await expect(handle.sendChecked(textMsg('m-1'))).rejects.toThrow('transient')
      expect(handle.entriesFull().active).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('retain 留守条目的判重与重复提交', () => {
  it('留守条目 id 再次提交 → 幂等吞（在途一级判重）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' }) // 失败留守
      const result = handle.send(customMsg('subagents:notify', 'n-1 重复'), { id: 'sid-1' })
      expect(result).toEqual({ kind: 'swallowed', reason: 'already-seen' })
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('volatile 引用保持：留守条目重投回调收到原始消息引用（per-message 契约）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { onSettled })
    try {
      const msg: DeliveryMessage = customMsg('subagents:notify', 'n-1')
      handle.send(msg, { id: 'sid-1' }) // 失败留守
      ;(port.send as ReturnType<typeof vi.fn>).mockImplementation(() => undefined)
      handle.flush() // 重投成功 → in-flight（缺省 marker 锚）
      handle.confirmDelivered('sid-1')
      expect(onSettled.mock.calls[0]![0]).toBe(msg) // 原始消息引用（非 clone）
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('onFailure: failed 受理失败留守（chat-flow-consistency 第 11 条）', () => {
  it('text + onFailure: failed → 首败转 failed 终态留守（非移除）+ onSettled(rejected) + store 记录保留', () => {
    const port = makeMockPort({ send: () => transientReject })
    const store = new MemoryDeliveryStore()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { onSettled, store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1', onFailure: 'failed' })
      // queued → failed 迁移（留守活跃集，队列区一行可见）
      expect(handle.entriesFull().active).toHaveLength(1)
      expect(handle.entriesFull().active[0]).toMatchObject({ id: 'sid-1', state: 'failed' })
      // 失败显式上报（与断连 failInFlight 的 rejected 通知同构）
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ payload: { kind: 'text', content: 'm-1' } }), 'rejected')
      // store 记录保留（不 discard——重启经 loadUndelivered 重放，重放带 transcript 判重防线）
      expect(store.calls.discard).toBe(0)
      expect(store.undelivered.has('sid-1')).toBe(true)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('failed 留守条目 requeue 可重试：failed → queued → 受理 in-flight（用户处置出路）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1', onFailure: 'failed' })
      expect(handle.entriesFull().active[0]).toMatchObject({ state: 'failed' })
      // 用户重试：requeue 恢复 queued 并立即出站（port 已恢复 → 受理转 in-flight）
      ;(port.send as ReturnType<typeof vi.fn>).mockImplementation(() => undefined)
      expect(handle.requeue(['sid-1'])).toBe(1)
      expect(handle.entriesFull().active[0]).toMatchObject({ id: 'sid-1', state: 'in-flight' })
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('checked + onFailure: failed → waiter reject 照常（受理口径通知）+ 条目 failed 留守（状态正交）', async () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      // checked 通路显式申报 failed：不被「恒 forget」归一吞掉（归一只对 retain 生效）
      await expect(
        handle.sendChecked(textMsg('m-1'), { id: 'cid-1', onFailure: 'failed' }),
      ).rejects.toThrow('transient')
      // 条目留守 failed（非 forget 的移除）——调用方已收失败回执，条目同时可见可处置
      expect(handle.entriesFull().active).toHaveLength(1)
      expect(handle.entriesFull().active[0]).toMatchObject({ id: 'cid-1', state: 'failed' })
      // 归一 warn 未触发（failed 放行）
      expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('onFailure=retain'))).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('failed 留守条目 id 再次提交 → 幂等吞（一级判重：failed 在活跃集）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1', onFailure: 'failed' })
      const result = handle.send(textMsg('m-1 重报'), { id: 'sid-1' })
      expect(result).toEqual({ kind: 'swallowed', reason: 'already-seen' })
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('failed 留守条目收到迟到的送达回执 → delivered（事实优先终结失败猜测）', () => {
    const port = makeMockPort({ send: () => transientReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { onSettled })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1', onFailure: 'failed' })
      expect(handle.entriesFull().active[0]).toMatchObject({ state: 'failed' })
      // 受理失败歧义性：文本可能已进 transcript 未及回执——回执到达即确定性送达事实
      expect(handle.confirmDelivered('sid-1')).toBe(true)
      expect(handle.entriesFull().active).toHaveLength(0)
      expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'sid-1', state: 'delivered' })
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('设计内等待拒不计首败（F1-13，onSendDeferred）', () => {
  it('forget 条目被 hold 拒：不弃不除不上报，条目留守在册', () => {
    const port = makeMockPort({ send: () => holdReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { onSettled })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1', onFailure: 'forget' })
      // 设计内等待（注入未发生）：不计首败——不 discard / 不移除 / 不 onSettled('rejected')
      expect(handle.entriesFull().active).toHaveLength(1)
      expect(handle.entriesFull().active[0]).toMatchObject({ id: 'sid-1', state: 'queued' })
      expect(handle.entriesFull().tombstones).toHaveLength(0)
      expect(onSettled).not.toHaveBeenCalled()
      expect(port.sendCalls.length).toBe(1) // 等待轮不主动重投（防同步 hold 循环）
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('store 装配下 hold 拒不触发 discard（记录仍是未投递事实）', () => {
    const port = makeMockPort({ send: () => holdReject })
    const store = new MemoryDeliveryStore()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(store.calls.discard).toBe(0)
      expect(store.undelivered.has('sid-1')).toBe(true) // persist 记录保留（对照：真首败 forget 会 discard）
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('compaction-wait 拒同判据：forget 条目留守在册不弃不上报，边沿重提受理成功', () => {
    // port 第二道防线（提交同步链与 compaction 边沿交叠的残余窗口）返回的
    // compaction-wait 与 hold 同为设计内等待（deferred 判别字段承载，MF-1-4）：
    // 当首败处置即静默丢弃（从未注入），违背 P0 fail-fast 契约——deferred 词表
    // 成员资格由本用例锁定
    const port = makeMockPort({ send: () => ({ accepted: false as const, deferred: 'compaction-wait' as const }) })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { onSettled })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1', onFailure: 'forget' })
      expect(handle.entriesFull().active).toHaveLength(1)
      expect(handle.entriesFull().active[0]).toMatchObject({ id: 'sid-1', state: 'queued' })
      expect(handle.entriesFull().tombstones).toHaveLength(0)
      expect(onSettled).not.toHaveBeenCalled()
      expect(port.sendCalls.length).toBe(1) // 等待轮不主动重投（等 compaction 边沿唤醒）
      ;(port.send as ReturnType<typeof vi.fn>).mockImplementation(() => undefined)
      handle.flush() // compaction 边沿唤醒重提（port onCompactionEdge → kernel.flush 同型）
      expect(handle.entriesFull().active[0]).toMatchObject({ id: 'sid-1', state: 'in-flight' })
      expect(onSettled).not.toHaveBeenCalled() // 送达终局由 confirmDelivered 驱动，非失败上报
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('投递端下一边沿重提：受理成功转 in-flight，等待轮的失败策略不再影响后续投递', () => {
    const port = makeMockPort({ send: () => holdReject })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port)
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1', onFailure: 'forget' }) // hold 拒 → 留守
      ;(port.send as ReturnType<typeof vi.fn>).mockImplementation(() => undefined)
      handle.flush() // 投递端窗口结束重提（port commitAsBatch 的 kernel.flush 同型）
      const [entry] = handle.entriesFull().active
      expect(entry).toMatchObject({ id: 'sid-1', state: 'in-flight' }) // 受理成功（marker 锚等回执）
      expect((port.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})
