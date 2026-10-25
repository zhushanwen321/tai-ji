/**
 * v3 送达凭据三档（ADR-0074 词条扩展，设计 unified-delivery §3.5.2 / §3.3 词条
 * 「送达凭据（deliveryProof）」）：
 * - 'details-id'：通知条目送达判定 = 对话记录中出现 details 携带本条目 id 的通知
 *   条目；判定逻辑以可注入凭据检查函数（config.proofCheck）承载在内核，调用点 =
 *   handle.confirmDeliveredByProof(id)；条目受理后维持 in-flight 等回执（同 marker）。
 * - 凭据档位分派：非 details-id 条目（marker / acceptance）经 confirmDeliveredByProof
 *   一律拒绝（误确认结构上不可达）。
 * - 降级面：未注入 proofCheck / proofCheck 抛错 → 视为未送达留守 + warn 留痕
 *   （保守放行型降级）。
 *
 * 三档并列的现状锚（marker 回执命中 / acceptance 受理即终态）由既有
 * delivery-receipt-anchor / delivery-settled 套件锁定，本文件补 details-id 档与
 * 分派边界。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { customMsg, makeMockPort } from './helpers.js'

describe("送达凭据 'details-id'：受理维持 in-flight 等回执", () => {
  it('details-id 条目受理后不即终态（与 acceptance 分野），留守 in-flight', () => {
    const port = makeMockPort()
    const proofCheck = vi.fn(() => false)
    const handle = createDelivery(port, { proofCheck })
    try {
      const result = handle.send(customMsg('subagents:notify', 'n-1'), {
        id: 'sid-1',
        receiptAnchor: 'details-id',
      })
      expect(result).toEqual({ kind: 'accepted', id: 'sid-1' })
      const [entry] = handle.entriesFull().active
      expect(entry!.state).toBe('in-flight') // 受理转 in-flight（两阶段第一阶段）
      expect(proofCheck).not.toHaveBeenCalled() // 受理不触发凭据检查（等回执证据）
      expect(handle.entriesFull().tombstones).toHaveLength(0)
    } finally {
      handle.dispose()
    }
  })
})

describe("送达凭据 'details-id'：confirmDeliveredByProof 判定通路", () => {
  it('proofCheck true → delivered 终局 + onSettled(delivered) + 终局记录', () => {
    const port = makeMockPort()
    const proofCheck = vi.fn(() => true)
    const onSettled = vi.fn()
    const handle = createDelivery(port, { proofCheck, onSettled })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1', receiptAnchor: 'details-id' })
      expect(handle.confirmDeliveredByProof('sid-1')).toBe(true)
      expect(proofCheck).toHaveBeenCalledWith('sid-1') // 检查函数收到条目 id
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0]![1]).toBe('delivered')
      expect(handle.entriesFull().active).toHaveLength(0)
      expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'sid-1', state: 'delivered' })
    } finally {
      handle.dispose()
    }
  })

  it('proofCheck false → 留守 in-flight（无终局、无回调）', () => {
    const port = makeMockPort()
    const proofCheck = vi.fn(() => false)
    const onSettled = vi.fn()
    const handle = createDelivery(port, { proofCheck, onSettled })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1', receiptAnchor: 'details-id' })
      expect(handle.confirmDeliveredByProof('sid-1')).toBe(false)
      expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
      expect(onSettled).not.toHaveBeenCalled()
    } finally {
      handle.dispose()
    }
  })

  it('queued 态 details-id 条目（回执先到竞态）同样可经凭据确认（扩展① 形态）', () => {
    // hold 拒（设计内等待）：条目受理未发生，留守 queued
    const port = makeMockPort({
      send: () => ({ accepted: false as const, deferred: 'merge-commit-hold' as const }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const proofCheck = vi.fn(() => true)
    const handle = createDelivery(port, { proofCheck })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1', receiptAnchor: 'details-id' })
      expect(handle.entriesFull().active[0]!.state).toBe('queued')
      expect(handle.confirmDeliveredByProof('sid-1')).toBe(true) // 事实优先（delivered 事实 > 时序）
      expect(handle.entriesFull().active).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('confirmDeliveredByProof 凭据档位分派（误确认结构上不可达）', () => {
  it('marker 条目：不走凭据检查（回执命中通路），恒返回 false', () => {
    // hold 拒（设计内等待）：条目留守 queued，凭据确认对 marker 档恒拒
    const port = makeMockPort({
      send: () => ({ accepted: false as const, deferred: 'merge-commit-hold' as const }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const proofCheck = vi.fn(() => true)
    const handle = createDelivery(port, { proofCheck })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-m', receiptAnchor: 'marker' })
      expect(handle.confirmDeliveredByProof('sid-m')).toBe(false)
      expect(proofCheck).not.toHaveBeenCalled()
      expect(handle.entriesFull().active[0]!.state).toBe('queued')
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('acceptance 条目：不走凭据检查（受理即终态通路），恒返回 false', () => {
    const port = makeMockPort()
    const proofCheck = vi.fn(() => true)
    const handle = createDelivery(port, { proofCheck })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-a', receiptAnchor: 'acceptance' })
      // acceptance 受理即 delivered（既有通路）——confirmDeliveredByProof 对已终态幂等 false
      expect(handle.entriesFull().active).toHaveLength(0)
      expect(handle.confirmDeliveredByProof('sid-a')).toBe(false)
      expect(proofCheck).not.toHaveBeenCalled()
    } finally {
      handle.dispose()
    }
  })

  it('未知 id / 已终态：幂等 no-op 返回 false', () => {
    const port = makeMockPort()
    const proofCheck = vi.fn(() => true)
    const handle = createDelivery(port, { proofCheck })
    try {
      expect(handle.confirmDeliveredByProof('no-such-id')).toBe(false)
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1', receiptAnchor: 'details-id' })
      handle.confirmDeliveredByProof('sid-1') // 终局
      expect(handle.confirmDeliveredByProof('sid-1')).toBe(false) // 已终态
      expect(proofCheck).toHaveBeenCalledTimes(1) // 已终态不再询检查函数
    } finally {
      handle.dispose()
    }
  })
})

describe('confirmDeliveredByProof 降级面（可见留守，不静默）', () => {
  it('未注入 proofCheck：留守 + warn 留痕', () => {
    const port = makeMockPort()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port) // 无 proofCheck
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1', receiptAnchor: 'details-id' })
      expect(handle.confirmDeliveredByProof('sid-1')).toBe(false)
      expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no proofCheck'), '')
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('proofCheck 抛错：视为未送达 + warn 留痕（降级不破坏状态机）', () => {
    const port = makeMockPort()
    const proofCheck = vi.fn(() => {
      throw new Error('probe failed')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { proofCheck })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1', receiptAnchor: 'details-id' })
      expect(handle.confirmDeliveredByProof('sid-1')).toBe(false)
      expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('proofCheck threw'), expect.any(Error))
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})
