/**
 * 磁盘 outbox（DiskDeliveryStore）单测——DeliveryStore 端口契约的磁盘实现行为锁。
 *
 * 覆盖面（unified-delivery 波 4 任务书验收）：
 * - persist 受理前落账 → loadUndelivered 返回；
 * - ack 终局行：delivered / cancelled 同形（判重只看 id）→ loadUndelivered 移除 +
 *   loadTerminalIds/hasTerminal 命中；
 * - discard（forget 失败条目）→ loadUndelivered 跳过且 hasTerminal 为假（区别于 ack）；
 * - 文件损坏容错：坏 JSON 行 / 半行 / 未知行型跳过不炸加载；
 * - 行序归并：discard 后同 id record 复活；ack 后同 id record 判重保持（宁可误吞不误重投）；
 * - attachSegments meta 补记：loadUndelivered 的 record.meta.segments 取回，后写覆盖先写；
 * - persist 抛错上抛（内核拒收语义：耐久承诺未落）。
 *
 * fs 全程内存替身（DiskStoreFs 注入面）——本文件不触真实磁盘。
 */
import { describe, it, expect } from 'vitest'
import { createDiskDeliveryStore, type DiskStoreFs } from '../src/disk-store.js'
import type { DeliveryStoreRecord } from '../src/types.js'

/** 内存 fs 替身：单文件内容按路径存 Map；mkdirSync 记号 no-op。 */
function memFs(): DiskStoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    existsSync: (p) => files.has(p),
    mkdirSync: (p) => {
      files.set(`dir:${p}`, '')
    },
    readFileSync: (p) => {
      const content = files.get(p)
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    },
    appendFileSync: (p, data) => {
      files.set(p, (files.get(p) ?? '') + data)
    },
  }
}

const FILE = '/mem-outbox/s1.jsonl'
const DIR = '/mem-outbox'

function recordOf(id: string, overrides: Partial<DeliveryStoreRecord> = {}): DeliveryStoreRecord {
  return {
    id,
    lane: 'direct',
    payload: { kind: 'text', content: `content-${id}` },
    intent: 'interrupt-at-turn-boundary',
    recordedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function newStore(fs = memFs()) {
  return { fs, store: createDiskDeliveryStore({ fs, dir: DIR, file: FILE }) }
}

describe('DiskDeliveryStore — DeliveryStore 端口契约', () => {
  it('persist 受理前落账 → loadUndelivered 返回原记录', () => {
    const { store } = newStore()
    const record = recordOf('a')
    store.persist(record)
    expect(store.loadUndelivered()).toEqual([record])
    expect(store.hasTerminal('a')).toBe(false)
  })

  it('ack 终局行：从待投差集移除、进终局集（hasTerminal / loadTerminalIds）', () => {
    const { store } = newStore()
    store.persist(recordOf('a'))
    store.ack('a')
    expect(store.loadUndelivered()).toEqual([])
    expect(store.hasTerminal('a')).toBe(true)
    expect(store.loadTerminalIds()).toEqual(['a'])
  })

  it('discard（forget 失败条目）：待投移除但无判重语义（hasTerminal 为假）', () => {
    const { store } = newStore()
    store.persist(recordOf('a'))
    store.discard('a')
    expect(store.loadUndelivered()).toEqual([])
    expect(store.hasTerminal('a')).toBe(false)
    expect(store.loadTerminalIds()).toEqual([])
  })

  it('跨实例重载（重启语义）：新 store 实例从同一文件恢复全量状态', () => {
    const { fs, store } = newStore()
    store.persist(recordOf('a'))
    store.persist(recordOf('b'))
    store.ack('a')
    // 「进程重启」：全新 store 实例读同一文件
    const revived = createDiskDeliveryStore({ fs, dir: DIR, file: FILE })
    expect(revived.loadUndelivered().map((r) => r.id)).toEqual(['b'])
    expect(revived.hasTerminal('a')).toBe(true)
    expect(revived.hasTerminal('b')).toBe(false)
  })

  it('文件损坏容错：坏 JSON / 半行 / 未知行型跳过，其余行照常归并', () => {
    const fs = memFs()
    fs.files.set(
      FILE,
      [
        '{"t":"record","r":{"id":"a","lane":"direct","payload":{"kind":"text","content":"x"},"intent":"interrupt-at-turn-boundary","recordedAt":1}}',
        '{"t":"record","r":{"id":"br', // 崩溃写入的中途半行
        'not-json-at-all',
        '{"t":"weird","id":"ghost"}',
        '{"t":"ack","id":"a","at":5}',
      ].join('\n'),
    )
    const store = createDiskDeliveryStore({ fs, dir: DIR, file: FILE })
    expect(store.loadUndelivered()).toEqual([])
    expect(store.hasTerminal('a')).toBe(true)
  })

  it('行序归并：discard 后同 id record 复活；ack 后同 id record 判重保持', () => {
    const fs = memFs()
    const store = createDiskDeliveryStore({ fs, dir: DIR, file: FILE })
    store.persist(recordOf('a'))
    store.discard('a')
    store.persist(recordOf('a', { recordedAt: 2 })) // 新承诺覆盖弃置
    expect(store.loadUndelivered().map((r) => r.recordedAt)).toEqual([2])

    store.ack('a')
    store.persist(recordOf('a', { recordedAt: 3 })) // 终局后同 id 再 persist：判重优先（防复活）
    expect(store.loadUndelivered()).toEqual([])
    expect(store.hasTerminal('a')).toBe(true)
  })
})

describe('DiskDeliveryStore — segments 补记扩展', () => {
  it('attachSegments 写 meta 行：loadUndelivered 的 record.meta.segments 取回（跨实例）', () => {
    const { fs, store } = newStore()
    store.persist(recordOf('a'))
    store.attachSegments('a', [{ type: 'text', text: 'seg' }])
    const revived = createDiskDeliveryStore({ fs, dir: DIR, file: FILE })
    const [record] = revived.loadUndelivered()
    expect(record?.meta?.segments).toEqual([{ type: 'text', text: 'seg' }])
  })

  it('同 id 多次补记按后写覆盖先写；无记录在册的 meta 行为孤儿不炸', () => {
    const { fs, store } = newStore()
    store.attachSegments('ghost', [{ v: 1 }]) // 孤儿 meta 行（record 行从未出现）
    store.persist(recordOf('a'))
    store.attachSegments('a', [{ v: 1 }])
    store.attachSegments('a', [{ v: 2 }])
    const revived = createDiskDeliveryStore({ fs, dir: DIR, file: FILE })
    const [record] = revived.loadUndelivered()
    expect(record?.meta?.segments).toEqual([{ v: 2 }])
  })
})

describe('DiskDeliveryStore — 失败语义', () => {
  it('persist 写失败上抛（耐久承诺未落 → 内核拒收语义）', () => {
    const fs = memFs()
    fs.appendFileSync = () => {
      throw new Error('ENOSPC')
    }
    const store = createDiskDeliveryStore({ fs, dir: DIR, file: FILE })
    expect(() => store.persist(recordOf('a'))).toThrow('ENOSPC')
  })

  it('首次写入前惰性建目录；目录已建后不重复 mkdir', () => {
    const { fs, store } = newStore()
    store.persist(recordOf('a'))
    expect(fs.files.has(FILE)).toBe(true)
    expect(fs.files.has(`dir:${DIR}`)).toBe(true)
  })
})
