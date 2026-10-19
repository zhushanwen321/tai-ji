/**
 * v3 受理即出站运行模式（设计 unified-delivery §3.5.6，波 1 只实现不接线）：
 * - 缺省 'queue-hold' = v2 队列持有行为逐字节不变（busy gate 排队 + settled 边沿
 *   驱动 flush + 合批窗口）——不传 dispatchMode 的既有装配零行为变化锚。
 * - 'on-accept' = 受理即出站：忙闲门禁旁路（受理后立即 port.send；承重前提 = 底层
 *   唯一队列忙时不拒）；合批窗口不用（config.mergeWindowMs>0 一次性 warn + 提交方
 *   merge:true 忽略）；in-flight 防重保留（内核自身并发保护，非忙闲门禁）；
 *   retain 失败留守条目仍经 settled 边沿 / 外部 flush 重投（旁路 busy gate）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { customMsg, makeMockPort, textMsg } from './helpers.js'

describe("缺省 queue-hold = v2 队列持有行为不变（零行为变化锚）", () => {
  it('不传 dispatchMode：busy 入队留守 → settled 边沿 busy 复核后出站（现状路径）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port) // 不传 dispatchMode
    try {
      port.idle = false
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(port.sendCalls).toHaveLength(0) // busy gate：留守
      expect(handle.depth()).toBe(1)

      port.idle = true
      handle.flush() // settled 边沿语义的外部触发
      expect(port.sendCalls).toHaveLength(1)
      expect(handle.depth()).toBe(0)
    } finally {
      handle.dispose()
    }
  })
})

describe("on-accept：忙闲门禁旁路（受理即出站）", () => {
  it('busy 下 send 立即出站（不经 gate、不入队等待）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dispatchMode: 'on-accept' })
    try {
      port.idle = false // busy——on-accept 下底层唯一队列忙时不拒（承重前提）
      const result = handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(result).toEqual({ kind: 'accepted', id: 'sid-1' })
      expect(port.sendCalls).toHaveLength(1) // 立即出站
      expect(handle.depth()).toBe(0) // 无排队语义
      expect(handle.entriesFull().active[0]!.state).toBe('in-flight') // 受理转在途
    } finally {
      handle.dispose()
    }
  })

  it('多连发：逐条立即出站（无合批窗口、无队列积累）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, { dispatchMode: 'on-accept' })
    try {
      port.idle = false
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      handle.send(textMsg('m-2'), { id: 'sid-2' })
      expect(port.sendCalls).toHaveLength(2) // 逐条（v2 队列模式下第二条等边沿）
    } finally {
      handle.dispose()
    }
  })

  it('in-flight 防重保留：在途 promise 未 settle 时后续 send 挂起，settle 后 pump 投出', async () => {
    let resolveSend: (() => void) | undefined
    const port = makeMockPort({
      send: () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        }),
    })
    const handle = createDelivery(port, { dispatchMode: 'on-accept' })
    try {
      port.idle = false
      handle.send(textMsg('m-1'), { id: 'sid-1' }) // 在途（promise 未 settle）
      expect(port.sendCalls).toHaveLength(1)
      handle.send(textMsg('m-2'), { id: 'sid-2' }) // 防重：不并发第二次 port.send
      expect(port.sendCalls).toHaveLength(1)

      resolveSend!() // 第一条受理 settle → pump → 第二条立即出站（旁路 busy gate）
      await Promise.resolve()
      await Promise.resolve()
      expect(port.sendCalls).toHaveLength(2)
    } finally {
      handle.dispose()
    }
  })
})

describe("on-accept：合批窗口不用（合批归 port 提交侧承载）", () => {
  it('config.mergeWindowMs>0：一次性 warn + 逐条立即出站（不进窗口等待）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = makeMockPort()
    const handle = createDelivery(port, { dispatchMode: 'on-accept', mergeWindowMs: 60_000 })
    try {
      port.idle = false
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      handle.send(textMsg('m-2'), { id: 'sid-2' })
      expect(port.sendCalls).toHaveLength(2) // 无窗口合批（合批归提交侧）
      expect(handle.entriesFull().active.every((e) => e.state === 'in-flight')).toBe(true)
      const mergeWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('mergeWindowMs'))
      expect(mergeWarns).toHaveLength(1) // 配置层一次性
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('提交方 merge:true：on-accept 下忽略（立即出站，不等窗口）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = makeMockPort()
    const handle = createDelivery(port, { dispatchMode: 'on-accept' })
    try {
      port.idle = false
      const result = handle.send(textMsg('m-1'), { id: 'sid-1', merge: true })
      expect(result).toEqual({ kind: 'accepted', id: 'sid-1' })
      expect(port.sendCalls).toHaveLength(1) // 立即出站
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('on-accept：retain 失败留守条目的边沿重投（旁路 busy gate）', () => {
  it('失败留守后 busy 仍恒真时，settled 边沿触发即重投（无 gate 阻塞）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let settledCb: (() => void) | undefined
    const portWithSettled = makeMockPort({
      isIdle: () => false, // busy 恒真（queue-hold 下条目将永留守）
      send: () => ({ accepted: false, reason: 'transient' }),
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {
          settledCb = undefined
        }
      },
    })
    const handle = createDelivery(portWithSettled, { dispatchMode: 'on-accept' })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' }) // 首败留守（retain 缺省）
      const callsAfterFailure = portWithSettled.sendCalls.length

      // settled 边沿（on-accept 下边沿 flush 旁路 busy gate）→ 重投发生
      //（仍失败也无妨——本断言只锁「边沿触发重投无 gate 阻塞」）
      settledCb!()
      expect(portWithSettled.sendCalls.length).toBeGreaterThan(callsAfterFailure)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})
