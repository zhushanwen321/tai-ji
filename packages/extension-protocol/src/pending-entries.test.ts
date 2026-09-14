import { describe, it, expect } from 'vitest'
import {
  PENDING_REGISTER_ENTRY_TYPE,
  PENDING_UNREGISTER_ENTRY_TYPE,
  scanPendingEntries,
  applyPendingDiff,
  collectActivePendingIds,
  mapReasonToStatus,
} from './pending-entries'

const reg = (id: string, extra: Record<string, unknown> = {}) => ({
  customType: 'pending:register',
  data: { id, ...extra },
})

const unreg = (id: string) => ({
  customType: 'pending:unregister',
  data: { id },
})

describe('PENDING_*_ENTRY_TYPE 常量（落盘契约字符串锁定）', () => {
  it('register/unregister 的 customType 与 pending-notifications 落盘形态逐字一致', () => {
    expect(PENDING_REGISTER_ENTRY_TYPE).toBe('pending:register')
    expect(PENDING_UNREGISTER_ENTRY_TYPE).toBe('pending:unregister')
  })
})

describe('scanPendingEntries（单趟分流 + S-10 容错）', () => {
  it('按 customType 分流 register 流水与注销 id 集，其余 customType 忽略', () => {
    const scan = scanPendingEntries([
      reg('bt-1'),
      { customType: 'other:event', data: { id: 'x' } },
      unreg('bt-1'),
      unreg('bt-2'),
      reg('bg-1'),
    ])
    expect(scan.registerEntries.map((e) => e.data.id)).toEqual(['bt-1', 'bg-1'])
    expect(scan.unregisteredIds).toEqual(new Set(['bt-1', 'bt-2']))
  })

  it('null/undefined/非对象元素跳过（先守卫再访问字段）', () => {
    const scan = scanPendingEntries([null, undefined, 42, 'str', reg('bt-1')])
    expect(scan.registerEntries).toHaveLength(1)
    expect(scan.unregisteredIds.size).toBe(0)
  })

  it('register data 缺失归一为空对象；unregister 仅收 string id', () => {
    const scan = scanPendingEntries([
      { customType: 'pending:register' },
      { customType: 'pending:unregister', data: { id: 42 } },
      { customType: 'pending:unregister' },
    ])
    expect(scan.registerEntries).toEqual([{ data: {} }])
    expect(scan.unregisteredIds.size).toBe(0)
  })
})

describe('applyPendingDiff（差集本体：去重 + 全局抵消 + id 非法跳过）', () => {
  it('register 首见去重：同 id 重复只保留首见 data', () => {
    const scan = scanPendingEntries([reg('bt-1', { v: 1 }), reg('bt-1', { v: 2 }), reg('bt-1')])
    const active = applyPendingDiff(scan)
    expect(active).toHaveLength(1)
    expect(active[0].data).toEqual({ id: 'bt-1', v: 1 })
  })

  it('unregister 全局抵消：注销 entry 在 register 之前也抵消', () => {
    const scan = scanPendingEntries([unreg('bt-1'), reg('bt-1')])
    expect(applyPendingDiff(scan)).toEqual([])
  })

  it('register→unregister→register 同 id 复用：id 仍视为已注销（全局抵消语义锁定）', () => {
    const scan = scanPendingEntries([reg('bt-1'), unreg('bt-1'), reg('bt-1')])
    expect(applyPendingDiff(scan)).toEqual([])
  })

  it('id 非法的 register 跳过；未注销的其它 id 正常保留', () => {
    const scan = scanPendingEntries([{ customType: 'pending:register', data: { id: 42 } }, reg('bt-2')])
    const active = applyPendingDiff(scan)
    expect(active.map((e) => e.data.id)).toEqual(['bt-2'])
  })

  it('不同 id 互不影响', () => {
    const scan = scanPendingEntries([reg('bt-1'), reg('bt-2'), unreg('bt-2'), reg('bt-3')])
    expect(applyPendingDiff(scan).map((e) => e.data.id)).toEqual(['bt-1', 'bt-3'])
  })
})

describe('collectActivePendingIds（scan + diff + 可选前缀过滤）', () => {
  it('idPrefix 过滤只保留该前缀的活跃 id', () => {
    const entries = [reg('bt-1'), reg('bg-1'), reg('bt-2'), unreg('bt-2'), reg('run-1')]
    expect(collectActivePendingIds(entries, { idPrefix: 'bt-' })).toEqual(new Set(['bt-1']))
  })

  it('无 opts 不过滤，返回全部活跃 id', () => {
    const entries = [reg('bt-1'), reg('bg-1'), unreg('bt-1')]
    expect(collectActivePendingIds(entries)).toEqual(new Set(['bg-1']))
  })

  it('前缀过滤是差集之后的独立层：不复活被去重/抵消的 id（seen 先于过滤语义）', () => {
    // 同 id 两次 register（data 不同）：diff 首见固定后，任何前缀下都只有这一个 id
    const entries = [reg('bt-1', { v: 1 }), reg('bt-1', { v: 2 })]
    expect(applyPendingDiff(scanPendingEntries(entries))).toHaveLength(1)
    expect(collectActivePendingIds(entries, { idPrefix: 'bt-' })).toEqual(new Set(['bt-1']))
    // 同 id 未注销时前缀命中一次；注销后任何前缀都拿不到（不因过滤复活）
    const withUnreg = [...entries, unreg('bt-1')]
    expect(collectActivePendingIds(withUnreg, { idPrefix: 'bt-' })).toEqual(new Set())
  })

  it('空 entries / 全脏 entries → 空 id 集', () => {
    expect(collectActivePendingIds([])).toEqual(new Set())
    expect(collectActivePendingIds([null, 1, 'x', {}])).toEqual(new Set())
  })
})

describe('mapReasonToStatus（reason→status 落盘契约权威单点，D10）', () => {
  // 词表全表逐项锁定——pending-notifications U7b 表驱动（listener 落盘路径）与本表
  // 同源；此处锁定 protocol 单点本体，任何一侧改词表都被双侧用例抓到
  it('全词表映射逐项一致（含 U5 新词表）', () => {
    const cases: Array<[string, string]> = [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
      ['expired', 'expired'],
      ['time_limited', 'time_limited'],
      ['budget_limited', 'failed'],
      ['aborted', 'aborted'],
      ['interrupted', 'aborted'],
      ['interrupted-by-restart', 'aborted'],
      ['interrupted-by-parent', 'aborted'],
      ['reopened', 'completed'],
    ]
    for (const [reason, expected] of cases) {
      expect(mapReasonToStatus(reason)).toBe(expected)
    }
  })

  it('非 identity reason 显式存在——identity 假设（status 恒等于 reason）在词表内不成立', () => {
    expect(mapReasonToStatus('budget_limited')).not.toBe('budget_limited')
    expect(mapReasonToStatus('interrupted-by-restart')).not.toBe('interrupted-by-restart')
    expect(mapReasonToStatus('reopened')).not.toBe('reopened')
  })

  it('未知 reason 落 default 兜底 completed（未来新词不再静默误标口径的登记处）', () => {
    expect(mapReasonToStatus('some-future-reason')).toBe('completed')
    expect(mapReasonToStatus('')).toBe('completed')
  })
})
