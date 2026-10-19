/**
 * v3 判重统一三级链（设计 unified-delivery §3.5.5 / §3.3 词条「已完结 id 索引」）：
 * 判重顺序 = 在途条目（一级，activeIndex）→ 内存已完结 id 索引（二级，terminalIndex：
 * store.loadTerminalIds 启动播种 + 终局即时登记）→ 持久记录（三级，store.hasTerminal）。
 * v2 的 tombstone 独立判重机制退役；已撤销消息的防复活凭据 = 撤销时写持久终局。
 *
 * 顺序断言用 MemoryDeliveryStore 调用计数：一级/二级命中时三级查询（hasTerminal）
 * 不被调用（短路）；三级查询仅在索引 miss 时发生。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryPort } from '../src/types.js'
import { MemoryDeliveryStore, makeMockPort, textMsg } from './helpers.js'

function seedStore(opts?: { terminals?: string[]; undelivered?: string[] }): MemoryDeliveryStore {
  const store = new MemoryDeliveryStore()
  for (const id of opts?.terminals ?? []) store.terminals.add(id)
  return store
}

describe('判重一级：在途条目（活跃集命中短路）', () => {
  it('活跃条目 id 重复提交 → swallowed(already-seen)，三级查询未被调', () => {
    const store = seedStore()
    const port = makeMockPort({ isIdle: () => false }) // busy：条目留守活跃集
    const handle = createDelivery(port, { store })
    try {
      expect(handle.send(textMsg('m-1'), { id: 'sid-1' })).toEqual({ kind: 'accepted', id: 'sid-1' })
      const hasTerminalBefore = store.calls.hasTerminal
      const result = handle.send(textMsg('m-1 重报'), { id: 'sid-1' })
      expect(result).toEqual({ kind: 'swallowed', reason: 'already-seen' })
      expect(store.calls.hasTerminal).toBe(hasTerminalBefore) // 一级短路：未询持久
    } finally {
      handle.dispose()
    }
  })
})

describe('判重二级：内存已完结 id 索引（loadTerminalIds 播种）', () => {
  it('播种的已完结 id → swallowed(already-seen)，三级查询未被调（索引短路）', () => {
    const store = seedStore({ terminals: ['t-1', 't-2'] })
    const port = makeMockPort()
    // 构造期播种：loadTerminalIds 被调用一次
    const loadSpy = vi.spyOn(store, 'loadTerminalIds')
    const handle = createDelivery(port, { store })
    try {
      expect(loadSpy).toHaveBeenCalledTimes(1) // 启动播种
      const hasTerminalBefore = store.calls.hasTerminal
      expect(handle.send(textMsg('m-1'), { id: 't-1' })).toEqual({ kind: 'swallowed', reason: 'already-seen' })
      expect(store.calls.hasTerminal).toBe(hasTerminalBefore) // 二级短路
    } finally {
      handle.dispose()
    }
  })

  it('本生命周期内终局即时登记索引：delivered / cancelled 后同 id 均吞', () => {
    const store = seedStore()
    const port = makeMockPort()
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-d' })
      handle.confirmDelivered('sid-d')
      expect(handle.send(textMsg('m-1 重报'), { id: 'sid-d' })).toEqual({
        kind: 'swallowed',
        reason: 'already-seen',
      })

      port.idle = false
      handle.send(textMsg('m-2'), { id: 'sid-c' })
      handle.cancel('sid-c')
      expect(handle.send(textMsg('m-2 重报'), { id: 'sid-c' })).toEqual({
        kind: 'swallowed',
        reason: 'already-seen',
      })
      expect(store.terminals).toEqual(new Set(['sid-d', 'sid-c'])) // 持久终局同步落
    } finally {
      handle.dispose()
    }
  })
})

describe('判重三级：持久记录（store.hasTerminal 索引 miss 兜底）', () => {
  it('绕过内核直写 store 终局（模拟外部恢复形态）→ 三级命中吞', () => {
    const store = seedStore()
    const port = makeMockPort()
    const handle = createDelivery(port, { store }) // 构造期播种时持久尚无该 id
    try {
      // 内核装配后，装配方直写持久终局（索引未同步——「索引落后于持久」窗口）
      store.persist({ id: 'ext-1', lane: 'direct', payload: { kind: 'text', content: 'x' }, intent: 'interrupt-at-turn-boundary', recordedAt: 1 })
      store.ack('ext-1')
      const hasTerminalBefore = store.calls.hasTerminal
      const result = handle.send(textMsg('m-1'), { id: 'ext-1' })
      expect(result).toEqual({ kind: 'swallowed', reason: 'already-seen' })
      expect(store.calls.hasTerminal).toBe(hasTerminalBefore + 1) // 三级被询并命中
    } finally {
      handle.dispose()
    }
  })

  it('全新 id（三级全 miss）→ accepted，hasTerminal 恰好一次', () => {
    const store = seedStore()
    const port = makeMockPort()
    const handle = createDelivery(port, { store })
    try {
      const hasTerminalBefore = store.calls.hasTerminal
      expect(handle.send(textMsg('m-1'), { id: 'fresh-1' })).toEqual({ kind: 'accepted', id: 'fresh-1' })
      expect(store.calls.hasTerminal).toBe(hasTerminalBefore + 1) // 穿透三级后受理
    } finally {
      handle.dispose()
    }
  })

  it('未显式传 id 的消息不参与判重（v1 语义保持）', () => {
    const store = seedStore()
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'))
      expect(handle.send(textMsg('m-1')).kind).toBe('accepted') // 内部生成 id，不去重
      expect(store.calls.hasTerminal).toBe(0) // 无 id 不询判重链
    } finally {
      handle.dispose()
    }
  })
})

describe('防复活凭据：撤销写持久终局 + 重启（新 handle 同 store）不复活', () => {
  it('cancel → 持久终局 → 重启播种后同 id 重报被吞', () => {
    const store = seedStore()
    const port = makeMockPort()
    // 第一生命周期：busy 入队 → cancel 撤销（持久终局落盘）
    const handle1 = createDelivery(port, { store })
    port.idle = false
    handle1.send(textMsg('m-1'), { id: 'sid-1' })
    expect(handle1.cancel('sid-1').kind).toBe('cancelled')
    handle1.dispose()

    // 第二生命周期（重启）：loadTerminalIds 播种 → resync 重报同 id 被吞
    const handle2 = createDelivery(port, { store })
    try {
      expect(handle2.send(textMsg('m-1'), { id: 'sid-1' })).toEqual({
        kind: 'swallowed',
        reason: 'already-seen',
      })
    } finally {
      handle2.dispose()
    }
  })

  it('drain → 全部持久终局 → 重启后同 id 重报被吞', () => {
    const store = seedStore()
    const port = makeMockPort()
    const handle1 = createDelivery(port, { store })
    port.idle = false
    handle1.send(textMsg('m-1'), { id: 'sid-1' })
    handle1.send(textMsg('m-2'), { id: 'sid-2' })
    handle1.drain()
    handle1.dispose()

    const handle2 = createDelivery(port, { store })
    try {
      expect(handle2.send(textMsg('m-1'), { id: 'sid-1' })).toEqual({ kind: 'swallowed', reason: 'already-seen' })
      expect(handle2.send(textMsg('m-2'), { id: 'sid-2' })).toEqual({ kind: 'swallowed', reason: 'already-seen' })
    } finally {
      handle2.dispose()
    }
  })

  it('v2 零行为变化锚：无 store 装配时判重行为不变（活跃集 + 生命周期终局）', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port) // 不传 store
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(handle.send(textMsg('m-1'), { id: 'sid-1' })).toEqual({ kind: 'swallowed', reason: 'already-seen' })
      handle.cancel('sid-1')
      expect(handle.send(textMsg('m-1'), { id: 'sid-1' })).toEqual({ kind: 'swallowed', reason: 'already-seen' })
    } finally {
      handle.dispose()
    }
  })
})

// 类型范围引用保持（DeliveryPort 形态契约）：假 port 供上述用例构造
const _portTypeAnchor: DeliveryPort | undefined = undefined
void _portTypeAnchor
