import { describe, it, expect } from 'vitest'
import {
  PENDING_REGISTER_ENTRY_TYPE,
  PENDING_UNREGISTER_ENTRY_TYPE,
  scanPendingEntries,
  scanPendingFields,
  applyPendingDiff,
  collectActivePendingIds,
  mapReasonToStatus,
  MAPPED_PENDING_STATUSES,
  type MappedPendingStatus,
} from './pending-entries'

const reg = (id: string, extra: Record<string, unknown> = {}) => ({
  customType: 'pending:register',
  data: { id, ...extra },
})

const unreg = (id: string) => ({
  customType: 'pending:unregister',
  data: { id },
})

const unregStatus = (id: string, status: unknown) => ({
  customType: 'pending:unregister',
  data: { id, reason: 'fixture', status },
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

  it('null/undefined/非对象元素跳过（先检查再访问字段）', () => {
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

describe('字段映射视图（MF-2-1 单点：register 首见 type + 注销 status，collect 链路统一规则）', () => {
  it('registerTypes 首条胜出：同 id 重复不覆盖（后条带不同 type 亦然）', () => {
    const scan = scanPendingEntries([reg('bt-1', { type: 'bash' }), reg('bt-1', { type: 'workflow' })])
    expect(scan.registerTypes.get('bt-1')).toBe('bash')
  })

  it('首条无 type 则该 id 恒无映射——不被后续重复条目补位（首见语义单点，旧工具版补位行为废除）', () => {
    const scan = scanPendingEntries([reg('bt-1'), reg('bt-1', { type: 'bash' })])
    expect(scan.registerTypes.has('bt-1')).toBe(false)
  })

  it('registerTypes id 非法（非 string / 空串）不入字段视图；type 非 string 不收', () => {
    const scan = scanPendingEntries([
      reg('', { type: 'bash' }),
      { customType: 'pending:register', data: { id: 42, type: 'bash' } },
      reg('ok-1', { type: 7 }),
    ])
    expect(scan.registerTypes.size).toBe(0)
  })

  it('unregisterStatuses 仅收 MAPPED_PENDING_STATUSES 成员；同 id 末次合法值胜出，后条非法不抹除前条', () => {
    const scan = scanPendingEntries([
      unregStatus('bt-1', 'completed'),
      unregStatus('bt-1', 'not-a-status'),
      unregStatus('bt-2', 42),
      unregStatus('bt-3', 'active'),
      unreg('bt-4'),
    ])
    expect(scan.unregisterStatuses.get('bt-1')).toBe('completed')
    expect(scan.unregisterStatuses.has('bt-2')).toBe(false)
    expect(scan.unregisterStatuses.has('bt-3')).toBe(false) // 'active' 是初始态不在终态词表
    expect(scan.unregisterStatuses.has('bt-4')).toBe(false)
    expect(scan.unregisterStatuses.size).toBe(1)
  })

  it('unregisterStatuses 空串 id 不入字段视图（diff 层 unregisteredIds 语义不动）', () => {
    const scan = scanPendingEntries([unregStatus('', 'completed')])
    expect(scan.unregisterStatuses.size).toBe(0)
    expect(scan.unregisteredIds.has('')).toBe(true)
  })

  it('register/unregister 分流互不串扰：其余 customType 与 null 元素不进字段视图', () => {
    const scan = scanPendingEntries([
      { customType: 'other:event', data: { id: 'x', type: 'bash', status: 'failed' } },
      null,
      reg('bt-1', { type: 'workflow' }),
      unregStatus('bt-1', 'failed'),
    ])
    expect(scan.registerTypes.get('bt-1')).toBe('workflow')
    expect(scan.unregisterStatuses.get('bt-1')).toBe('failed')
    expect(scan.registerTypes.has('x')).toBe(false)
    expect(scan.unregisterStatuses.has('x')).toBe(false)
  })

  it('scanPendingFields = 字段映射投影（终局回填消费面：查表补 type/outcome）', () => {
    const fields = scanPendingFields([
      reg('done-1', { type: 'workflow' }),
      unregStatus('done-1', 'completed'),
      reg('active-1', { type: 'subagent' }),
      unregStatus('bad-1', 'not-a-status'),
      unregStatus('bad-2', undefined),
      { customType: 'pending:unregister', data: { status: 'completed' } },
    ])
    expect(fields.registerTypes.get('done-1')).toBe('workflow')
    expect(fields.registerTypes.get('active-1')).toBe('subagent')
    expect(fields.unregisterStatuses.get('done-1')).toBe('completed')
    expect(fields.unregisterStatuses.has('bad-1')).toBe(false)
    expect(fields.unregisterStatuses.has('bad-2')).toBe(false)
    expect(fields.unregisterStatuses.size).toBe(1)
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
      // notify-once D3 族映射 4 case（stopped→aborted、exited/deleted/orphaned→cancelled）
      ['stopped', 'aborted'],
      ['exited', 'cancelled'],
      ['deleted', 'cancelled'],
      ['orphaned', 'cancelled'],
    ]
    for (const [reason, expected] of cases) {
      expect(mapReasonToStatus(reason)).toBe(expected)
    }
  })

  it('非 identity reason 显式存在——identity 假设（status 恒等于 reason）在词表内不成立', () => {
    expect(mapReasonToStatus('budget_limited')).not.toBe('budget_limited')
    expect(mapReasonToStatus('interrupted-by-restart')).not.toBe('interrupted-by-restart')
    expect(mapReasonToStatus('reopened')).not.toBe('reopened')
    // notify-once 4 新 case 同样全部非 identity（否则即词表扩张）
    expect(mapReasonToStatus('stopped')).not.toBe('stopped')
    expect(mapReasonToStatus('exited')).not.toBe('exited')
    expect(mapReasonToStatus('deleted')).not.toBe('deleted')
    expect(mapReasonToStatus('orphaned')).not.toBe('orphaned')
  })

  it('禁扩词表：MappedPendingStatus 值域封闭在既有 6 终态（Record 全键锁定，加词即编译错）', () => {
    // D3 明令四个新 reason 不扩 MappedPendingStatus/PendingStatus——本断言的类型范围
    // 是 Record<MappedPendingStatus, true> 全键字面量：值域长出第 7 个成员即 TS 编译失败
    const fullVocabulary: Record<MappedPendingStatus, true> = {
      completed: true,
      failed: true,
      cancelled: true,
      expired: true,
      time_limited: true,
      aborted: true,
    }
    const mapped = [
      mapReasonToStatus('stopped'),
      mapReasonToStatus('exited'),
      mapReasonToStatus('deleted'),
      mapReasonToStatus('orphaned'),
    ]
    for (const status of mapped) {
      expect(fullVocabulary[status]).toBe(true)
    }
  })

  it('未知 reason 落 default 兜底 completed（未来新词不再静默误标口径的登记处）', () => {
    expect(mapReasonToStatus('some-future-reason')).toBe('completed')
    expect(mapReasonToStatus('')).toBe('completed')
  })
})

describe('MAPPED_PENDING_STATUSES（值集单源导出，MF-1-5）', () => {
  it('Set 成员恰等于 MappedPendingStatus 联合（派生自 REASON_STATUS_MAP，无第二份词表）', () => {
    // Record 全键字面量：MappedPendingStatus 长出第 7 个成员即编译错（同上「禁扩词表」手法）
    const fullVocabulary: Record<MappedPendingStatus, true> = {
      completed: true,
      failed: true,
      cancelled: true,
      expired: true,
      time_limited: true,
      aborted: true,
    }
    expect(MAPPED_PENDING_STATUSES.size).toBe(Object.keys(fullVocabulary).length)
    for (const status of MAPPED_PENDING_STATUSES) {
      expect(fullVocabulary[status as MappedPendingStatus]).toBe(true)
    }
    // 词表外值不在集（消费方成员判定的拒收分支）
    expect(MAPPED_PENDING_STATUSES.has('active')).toBe(false)
    expect(MAPPED_PENDING_STATUSES.has('not-a-status')).toBe(false)
  })
})
