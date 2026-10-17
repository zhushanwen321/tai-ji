/**
 * v3 失败保留策略 onFailure: 'forget' | 'retain'（设计 unified-delivery §3.5.3 /
 * §3.4 缺省值表）：
 * - 缺省按载荷类型：custom = retain（无人值守，失败留账下一边沿 / 重启重入队）/
 *   text = forget（交互在席，首败即停 + 显式上报，消费方可重发——runtime 现状）。
 * - retain：失败条目留守 queued，失败轮不主动重投（idle 下立即重投会形成「失败 →
 *   重投 → 失败」同步循环——首败即停红线的对偶面），等下一 settled 边沿 / 外部
 *   flush（事件驱动，无定时器）；不发 onSettled('rejected')（留守非终局）。
 * - forget：首败即停 + onSettled('rejected') 显式上报 + 从内核移除（v2 现状锚）。
 * - sendChecked 挂账条目恒 forget（同步失败回执契约与 retain 重投矛盾），显式申报
 *   retain 按 forget 处置 + 一次性 warn。
 * - retain 条目重投成功 → 正常 delivered 终局（onSettled('delivered')）。
 *
 * ADR-0122 不变量：两种策略下内核都无自动重试机制——retain 的重投由外部边沿触发，
 * 非内核定时器（时间平抑红线）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage } from '../src/types.js'
import { MemoryDeliveryStore, customMsg, makeBusyParkPort, makeMockPort, textMsg } from './helpers.js'

const transientReject = { accepted: false as const, reason: 'transient' }
/** 设计内等待拒（F1-13）：port 合批提交窗 hold（entry 未注入，非失败）。 */
const holdReject = { accepted: false as const, reason: 'merge-commit-hold' }

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
      // 失败已发生（留守），idle 恒真——若主动重投会同步无限循环；断言本轮收口
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

  it('下一 settled 边沿驱动重投（busy park 脚手架：边沿触发 busy 复核后出站）', () => {
    const bp = makeBusyParkPort()
    const sendMock = vi.fn(() => transientReject)
    bp.port.send = sendMock as unknown as typeof bp.port.send
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(bp.port)
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' })
      // 首次边沿：busy 解除 → 首拍投递失败（retain 留守）
      bp.setIdle(true)
      bp.fireSettled()
      const callsAfterFailure = sendMock.mock.calls.length
      expect(callsAfterFailure).toBeGreaterThan(0)

      // 恢复可投 + 第二次边沿 → 重投成功（缺省 marker 锚 → in-flight）→ 凭据确认终局
      sendMock.mockImplementation(() => undefined)
      bp.fireSettled()
      expect(sendMock.mock.calls.length).toBeGreaterThan(callsAfterFailure)
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

describe('sendChecked 挂账条目恒 forget（同步失败回执契约优先）', () => {
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
    // compaction-wait 与 hold 同为设计内等待：当首败处置即静默丢弃（从未注入），
    // 违背 P0 fail-fast 契约——白名单成员资格由本用例锁定
    const port = makeMockPort({ send: () => ({ accepted: false as const, reason: 'compaction-wait' }) })
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
