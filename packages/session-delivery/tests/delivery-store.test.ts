/**
 * v3 DeliveryStore 持久化存储端口契约（设计 unified-delivery §3.5.1 / §3.5.5）：
 * - persist 先于投递尝试（耐久承诺先于投递，与账本 record 先于 deliver 同律）
 * - 终局 delivered / cancelled 后 ack（含 drain 全量终局）
 * - persist 失败 = 承诺未落 → 拒收（send rejected / sendChecked throw），不投递
 * - forget 失败 discard（无终局语义的记录无痕移除）/ retain 失败记录保留
 * - loadUndelivered / loadTerminalIds（内存假实现的差集 / 终局视图）
 * - ack 异常降级：终局事实已发生，状态机不回滚，warn 留痕
 *
 * 内核零 fs 知识锚：store 由测试注入内存假实现（tests/helpers MemoryDeliveryStore），
 * 内核仅经端口方法交互。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage, DeliveryPort } from '../src/types.js'
import { MemoryDeliveryStore, customMsg, makeMockPort, textMsg } from './helpers.js'

function makeStoreWithPort(overrides?: Partial<DeliveryPort>) {
  const store = new MemoryDeliveryStore()
  const port = makeMockPort(overrides)
  return { store, port }
}

describe('DeliveryStore 契约：persist 先于投递尝试', () => {
  it('send 受理前 persist 已落——port.send 执行时 store 差集已含该条目', () => {
    const { store, port } = makeStoreWithPort()
    // port.send 执行时点检查：投递尝试发生前 persist 必须已落（耐久承诺先序）
    const persistedAtSend: string[] = []
    port.send = (msg) => {
      const id = (msg as DeliveryMessage & { __id?: string }).__id
      void id
      // 时序锚：send 调用时 store.persistOrder 已含全部已提交条目 id
      persistedAtSend.push(...store.persistOrder)
      return undefined
    }

    const handle = createDelivery(port, { store })
    try {
      const result = handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' })
      expect(result).toEqual({ kind: 'accepted', id: 'sid-1' })
      expect(persistedAtSend).toContain('sid-1') // persist 发生在 port.send 之前
      expect(store.undelivered.has('sid-1')).toBe(true)
      expect(store.calls.persist).toBe(1)
    } finally {
      handle.dispose()
    }
  })

  it('record 携带重建投递所需最小信息（id/lane/payload/intent/anchor）', () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      handle.send(customMsg('subagents:notify', 'n-1', { intent: 'after-run', meta: { notifyId: 'nid-1' } }), {
        id: 'sid-1',
        lane: 'queued',
        receiptAnchor: 'details-id',
      })
      const record = store.undelivered.get('sid-1')
      expect(record).toMatchObject({
        id: 'sid-1',
        lane: 'queued',
        receiptAnchor: 'details-id',
        intent: 'after-run',
      })
      expect(record!.payload).toEqual({ kind: 'custom', customType: 'subagents:notify', content: 'n-1', display: true })
      expect(record!.meta).toEqual({ notifyId: 'nid-1' })
    } finally {
      handle.dispose()
    }
  })

  it('sendChecked 同样受理前 persist（checked 路径同律）', async () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      await expect(handle.sendChecked(textMsg('hello'), { id: 'cid-1' })).resolves.toBeUndefined()
      expect(store.persistOrder).toEqual(['cid-1'])
    } finally {
      handle.dispose()
    }
  })
})

describe('DeliveryStore 契约：终局 ack', () => {
  it('confirmDelivered 终局 → ack：差集移除 + 终局集合登记', () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(store.undelivered.has('sid-1')).toBe(true)
      expect(handle.confirmDelivered('sid-1')).toBe(true)
      expect(store.undelivered.has('sid-1')).toBe(false)
      expect(store.terminals.has('sid-1')).toBe(true)
      expect(store.calls.ack).toBe(1)
    } finally {
      handle.dispose()
    }
  })

  it('cancel 终局 → ack：已撤销消息的防复活凭据 = 撤销时写持久终局', () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      port.idle = false // busy 起步：条目留守 queued（未出站，cancel 直接终局）
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      const result = handle.cancel('sid-1')
      expect(result.kind).toBe('cancelled')
      expect(store.undelivered.has('sid-1')).toBe(false)
      expect(store.terminals.has('sid-1')).toBe(true) // 持久终局（防复活）
      expect(store.loadTerminalIds()).toContain('sid-1')
    } finally {
      handle.dispose()
    }
  })

  it('drain 全量终局 → 全部 ack', () => {
    const { store, port } = makeStoreWithPort()
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      handle.send(textMsg('m-2'), { id: 'sid-2' })
      const drained = handle.drain()
      expect(drained).toHaveLength(2)
      expect(store.undelivered.size).toBe(0)
      expect(store.terminals).toEqual(new Set(['sid-1', 'sid-2']))
    } finally {
      handle.dispose()
    }
  })

  it('ack 抛错降级：终局事实已发生，状态机不回滚，warn 留痕', () => {
    const { store, port } = makeStoreWithPort()
    vi.spyOn(store, 'ack').mockImplementation(() => {
      throw new Error('disk full')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = vi.fn()
    const handle = createDelivery(port, { store, onSettled })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(handle.confirmDelivered('sid-1')).toBe(true) // 终局照常
      expect(onSettled).toHaveBeenCalledWith(expect.anything(), 'delivered')
      expect(handle.entriesFull().tombstones).toHaveLength(1) // 终局记录已登记
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('store.ack failed'), expect.any(Error))
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('DeliveryStore 契约：persist 失败拒收（承诺未落）', () => {
  it('send：persist 抛错 → rejected(persist-failed)，条目不入队、不投递', () => {
    const { store, port } = makeStoreWithPort()
    vi.spyOn(store, 'persist').mockImplementation(() => {
      throw new Error('disk full')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      const result = handle.send(textMsg('m-1'), { id: 'sid-1' })
      expect(result).toEqual({ kind: 'rejected', reason: 'persist-failed' })
      expect(handle.depth()).toBe(0) // 未入队
      expect(port.sendCalls).toHaveLength(0) // 未投递
      expect(handle.entriesFull().active).toHaveLength(0) // 条目已回滚
      expect(store.persistOrder).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('sendChecked：persist 抛错 → 同步 throw', async () => {
    const { store, port } = makeStoreWithPort()
    vi.spyOn(store, 'persist').mockImplementation(() => {
      throw new Error('disk full')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      await expect(handle.sendChecked(textMsg('m-1'), { id: 'cid-1' })).rejects.toThrow('store.persist failed')
      expect(port.sendCalls).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('DeliveryStore 契约：失败处置的存储面（discard / 保留）', () => {
  it('forget 条目首败 → store.discard（无终局语义，防重启复活）', () => {
    const { store, port } = makeStoreWithPort({
      send: () => ({ accepted: false, reason: 'transient' }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      handle.send(textMsg('m-1'), { id: 'sid-1' }) // text 缺省 forget
      expect(store.undelivered.has('sid-1')).toBe(false) // 记录已无痕移除
      expect(store.calls.discard).toBe(1)
      expect(store.terminals.has('sid-1')).toBe(false) // 不进终局（无判重语义）
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })

  it('retain 条目首败 → store 记录保留（重启经 loadUndelivered 重入队）', () => {
    const { store, port } = makeStoreWithPort({
      send: () => ({ accepted: false, reason: 'transient' }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { store })
    try {
      handle.send(customMsg('subagents:notify', 'n-1'), { id: 'sid-1' }) // custom 缺省 retain
      expect(store.undelivered.has('sid-1')).toBe(true) // 留账
      expect(store.calls.discard).toBe(0)
      expect(store.terminals.has('sid-1')).toBe(false)
      // 重启重入队读取源：loadUndelivered 返回该记录
      expect(store.loadUndelivered().map((r) => r.id)).toEqual(['sid-1'])
    } finally {
      warnSpy.mockRestore()
      handle.dispose()
    }
  })
})

describe('DeliveryStore 契约：loadUndelivered / loadTerminalIds（假实现视图）', () => {
  it('内存假实现差集语义：persist 进差集、ack 移入终局、discard 无痕移除', () => {
    const store = new MemoryDeliveryStore()
    store.persist({ id: 'a', lane: 'direct', payload: { kind: 'text', content: 'x' }, intent: 'interrupt-at-turn-boundary', recordedAt: 1 })
    store.persist({ id: 'b', lane: 'direct', payload: { kind: 'text', content: 'y' }, intent: 'interrupt-at-turn-boundary', recordedAt: 2 })
    expect(store.loadUndelivered().map((r) => r.id).sort()).toEqual(['a', 'b'])
    store.ack('a')
    expect(store.loadUndelivered().map((r) => r.id)).toEqual(['b'])
    expect(store.loadTerminalIds()).toEqual(['a'])
    store.discard('b')
    expect(store.loadUndelivered()).toEqual([])
    expect(store.loadTerminalIds()).toEqual(['a'])
  })
})
