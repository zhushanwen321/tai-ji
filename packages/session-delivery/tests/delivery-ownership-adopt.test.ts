/**
 * u1 探针 P-adopt 单元级两变体（设计 delivery-ownership-kernel.md §3.5 P-adopt）：
 * 外来无标记文本（notifyDone 形态）经适配器收养（以新 id 走 handle.send）后正常
 * 投递且无重复。
 *
 * - 变体 1「内核有在途共存」：自有条目已受理滞留（in-flight），对账回收经
 *   requeue 至队首先行重投；收养条目随后入站投递——自有先行、相对序保持（D3 own）。
 * - 变体 2「无内核在途的纯外来滞留」：内核空闲无在途时收养条目直接成为唯一
 *   在途并正常投递（「空闲 + 槽位非空」两条件触发口径的 Reconciler 侧判定归
 *   u2 registry；本文件锁内核侧收养通道与幂等面）。
 *
 * [已不可达用例删除登记] 原「busy 内核：收养条目经 gate 排队等边沿」用例随忙闲门禁
 * 删除而不可达（受理即出站下收养条目受理即出站，无排队语义），2026-10-23
 * 投递域清理批次删除。
 *
 * 形态：真实 createDelivery + fake port 重放收养序列（e2e 层暂无收养回归——待补）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('u1-adopt P-adopt 变体 1：内核有在途共存（自有回收条目优先于收养）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('自有条目 requeue 回队首 + 收养条目入队 → 重投序 = 自有在前、收养在后，均送达且不重复', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    // ── 重放步骤 1：自有条目 steer 入槽受理（滞留形态：run 结束无人 drain）──
    handle.send(textMsg('own user msg'), { id: 'u-own-1', lane: 'steer' })
    expect(handle.entriesFull().active[0]).toMatchObject({ id: 'u-own-1', state: 'in-flight' })
    expect(port.sendCalls).toHaveLength(1)

    // ── 重放步骤 2：settled 边沿对账 → clear_queue 收回 → 三分处置 own ──
    // （clear_queue 返回文本含裸标记 → Reconciler 识别 own → requeue 至队首）
    expect(handle.requeue(['u-own-1'])).toBe(1)
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight') // idle 下已重投受理
    expect(port.sendCalls).toHaveLength(2) // 回收重投发生
    expect(port.sendCalls[1]!.msg.payload.content).toBe('own user msg')

    // ── 重放步骤 3：外来无标记文本收养（subagent notifyDone 形态，新 clientUuid）──
    // 受理即出站：收养条目 send 即出站（在途防重是内核自身并发保护，非忙闲门禁）
    handle.send(textMsg('notify: subagent task done'), { id: 'u-adopt-1', lane: 'direct' })
    expect(handle.entriesFull().active.some((e) => e.id === 'u-adopt-1')).toBe(true)
    expect(port.sendCalls).toHaveLength(3) // 收养条目已出站受理
    expect(port.sendCalls[2]!.msg.payload.content).toBe('notify: subagent task done')

    // ── 重放步骤 4：两侧送达回执先后到达（message_end 标记命中）──
    expect(handle.confirmDelivered('u-own-1')).toBe(true)
    expect(handle.confirmDelivered('u-adopt-1')).toBe(true)

    // 终态：全部 delivered，tombstone 可判重
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones.map((t) => t.id)).toEqual(['u-own-1', 'u-adopt-1'])
    expect(handle.depth()).toBe(0)

    // ── 重放步骤 5：无重复——同 id 收养重放（对账器下轮再看到同文本）被吞 ──
    handle.send(textMsg('notify: subagent task done'), { id: 'u-adopt-1' })
    handle.send(textMsg('own user msg'), { id: 'u-own-1' })
    expect(port.sendCalls).toHaveLength(3) // 零新增投递
    expect(handle.entriesFull().active).toHaveLength(0)

    handle.dispose()
  })
})

describe('u1-adopt P-adopt 变体 2：无内核在途的纯外来收养', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('空闲无在途内核：收养条目直接投递送达；同 id 重放幂等（无重复）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    // ── 前置断言：「空闲 + 无在途」起点（两条件触发口径的内核侧对应面）──
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toHaveLength(0)
    expect(handle.depth()).toBe(0)

    // ── 重放步骤 1：对账器收回纯外来滞留文本（无标记 → 收养，新 id）──
    handle.send(textMsg('notify: subagent task done'), { id: 'u-adopt-1' })

    // 收养条目正常投递（idle gate 通过、缺省 intent）
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('notify: subagent task done')
    expect(port.sendCalls[0]!.intent).toBe('interrupt-at-turn-boundary')
    expect(handle.entriesFull().active[0]).toMatchObject({ id: 'u-adopt-1', state: 'in-flight' })

    // ── 重放步骤 2：送达回执落定 ──
    expect(handle.confirmDelivered('u-adopt-1')).toBe(true)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-adopt-1', state: 'delivered' })

    // ── 重放步骤 3：同 id 收养重放被 tombstone 吞（不重复投递）──
    handle.send(textMsg('notify: subagent task done'), { id: 'u-adopt-1' })
    expect(port.sendCalls).toHaveLength(1)
    expect(handle.entriesFull().active).toHaveLength(0)

    handle.dispose()
  })
})
