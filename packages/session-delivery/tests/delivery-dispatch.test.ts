/**
 * 受理即出站出站行为（v3 唯一出站形态，设计 unified-delivery §3.5.6）：
 * - 忙闲门禁旁路：busy 下受理后立即 port.send（承重前提 = 底层唯一队列忙时不拒），
 *   无排队语义（busy park / 合批窗口 / settled 边沿忙闲复核均不存在）。
 * - in-flight 防重保留（内核自身并发保护，非忙闲门禁）：在途 promise 未 settle 时
 *   后续 send 挂起，settle 后 pump 投出。
 * - retain 失败留守条目仍经 settled 边沿 / 外部 flush 重投（旁路忙闲门禁）。
 *
 * [已不可达用例删除登记] 原「缺省 = v2 队列持有行为不变」busy 留守锚、
 * 「on-accept：合批窗口不用」两用例（config.mergeWindowMs>0 一次性 warn / 提交方
 * merge:true 忽略）随队列持有形态与出站模式参数 / 合批窗口配置删除而不可达，
 * 2026-10-23 投递域清理批次删除。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { customMsg, makeMockPort, textMsg } from './helpers.js'

describe('受理即出站：忙闲门禁旁路（受理即出站）', () => {
  it('busy 下 send 立即出站（不经门禁、不入队等待）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)
    try {
      port.idle = false // busy——底层唯一队列忙时不拒（承重前提）
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
    const handle = createDelivery(port)
    try {
      port.idle = false
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      handle.send(textMsg('m-2'), { id: 'sid-2' })
      expect(port.sendCalls).toHaveLength(2) // 逐条立即出站
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
    const handle = createDelivery(port)
    try {
      port.idle = false
      handle.send(textMsg('m-1'), { id: 'sid-1' }) // 在途（promise 未 settle）
      expect(port.sendCalls).toHaveLength(1)
      handle.send(textMsg('m-2'), { id: 'sid-2' }) // 防重：不并发第二次 port.send
      expect(port.sendCalls).toHaveLength(1)

      resolveSend!() // 第一条受理 settle → pump → 第二条立即出站（旁路忙闲门禁）
      await Promise.resolve()
      await Promise.resolve()
      expect(port.sendCalls).toHaveLength(2)
    } finally {
      handle.dispose()
    }
  })
})

describe('retain 失败留守条目的边沿重投（旁路忙闲门禁）', () => {
  it('失败留守后 busy 仍恒真时，settled 边沿触发即重投（无门禁阻塞）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let settledCb: (() => void) | undefined
    const portWithSettled = makeMockPort({
      isIdle: () => false, // busy 恒真（若忙闲门禁仍在，条目将永留守）
      send: () => ({ accepted: false, reason: 'transient' }),
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {
          settledCb = undefined
        }
      },
    })
    const handle = createDelivery(portWithSettled)
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' }) // 首败留守（retain 缺省）
      const callsAfterFailure = portWithSettled.sendCalls.length

      // settled 边沿即 flush（无忙闲复核）→ 重投发生
      //（仍失败也无妨——本断言只锁「边沿触发重投无门禁阻塞」）
      settledCb!()
      expect(portWithSettled.sendCalls.length).toBeGreaterThan(callsAfterFailure)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})
