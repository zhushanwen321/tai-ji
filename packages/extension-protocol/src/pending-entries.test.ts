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
  MAPPED_REASON_KEYS,
  SETTLEMENT_REASONS,
  SETTLEMENT_REASON_KEYS,
  resolveSettlementReason,
  type MappedPendingStatus,
  type ResolvedSettlementReason,
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

const unregReason = (id: string, reason: unknown) => ({
  customType: 'pending:unregister',
  data: { id, reason },
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

describe('unregisterSettlements（结清视图：注销 reason 事实经 resolveSettlementReason 解析，§3.3.6 权威通道）', () => {
  it('读 reason 事实解析结清值：五值同名直通 + 历史 reason 按解析表映射', () => {
    const cases: Array<[string, string, ResolvedSettlementReason]> = [
      ['bg-1', 'no_result', 'no_result'],
      ['bg-2', 'lost', 'lost'],
      ['bg-3', 'completed', 'completed'],
      ['bg-4', 'failed', 'failed'],
      ['bg-5', 'cancelled', 'cancelled'],
      ['bg-6', 'expired', 'no_result'],
      ['bg-7', 'time_limited', 'failed'],
      ['bg-8', 'aborted', 'cancelled'],
    ]
    const scan = scanPendingEntries(cases.flatMap(([id, reason]) => [reg(id), unregReason(id, reason)]))
    for (const [id, , expected] of cases) {
      expect(scan.unregisterSettlements.get(id)).toBe(expected)
    }
  })

  it('词表外 reason 解析 unknown 照常入视图（fail-visible 透传）；缺 reason 的注销条目不入视图（不虚构）', () => {
    const scan = scanPendingEntries([
      unregReason('bg-1', 'some-future-reason'),
      { customType: 'pending:unregister', data: { id: 'bg-2', status: 'completed' } },
      unreg('bg-3'),
    ])
    expect(scan.unregisterSettlements.get('bg-1')).toBe('unknown')
    expect(scan.unregisterSettlements.has('bg-2')).toBe(false)
    expect(scan.unregisterSettlements.has('bg-3')).toBe(false)
  })

  it('同 id 多条注销取末次 string reason；非 string reason 不抹除前值', () => {
    const scan = scanPendingEntries([
      unregReason('bg-1', 'completed'),
      unregReason('bg-1', 'failed'),
      unregReason('bg-2', 'lost'),
      unregReason('bg-2', 42),
    ])
    expect(scan.unregisterSettlements.get('bg-1')).toBe('failed')
    expect(scan.unregisterSettlements.get('bg-2')).toBe('lost')
  })

  it('空串 id 不入结清视图（与 status 视图同口径）', () => {
    const scan = scanPendingEntries([unregReason('', 'completed')])
    expect(scan.unregisterSettlements.size).toBe(0)
  })

  it('scanPendingFields 投影携带结清视图；legacy status 视图并行保留（双通道并存）', () => {
    const fields = scanPendingFields([
      reg('bg-1', { type: 'workflow' }),
      unregReason('bg-1', 'no_result'),
      reg('bg-2', { type: 'bash' }),
      unregStatus('bg-2', 'completed'),
    ])
    // 结清视图（reason 事实）：no_result 真值可达——status 旧通道下该形态恒 unknown
    expect(fields.unregisterSettlements.get('bg-1')).toBe('no_result')
    expect(fields.unregisterStatuses.has('bg-1')).toBe(false)
    // legacy 视图（status 副档）：unregReason 形态无 status 字段故缺席；status 形态照常
    expect(fields.unregisterStatuses.get('bg-2')).toBe('completed')
    expect(fields.unregisterSettlements.get('bg-2')).toBe('unknown') // reason='fixture' 词表外
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

  it('禁扩词表：MappedPendingStatus 值域封闭在既有 6 终态 + 解析缺省 unknown（Record 全键锁定，加词即编译错）', () => {
    // D3 明令四个新 reason 不扩 MappedPendingStatus/PendingStatus——本断言的类型范围
    // 是 Record<MappedPendingStatus, true> 全键字面量：值域长出第 8 个成员即 TS 编译失败。
    // [subagent-observability §3.3.11④] unknown 是解析缺省成员（fail-visible 废除
    // fail-open 的承载位），非新终态。
    const fullVocabulary: Record<MappedPendingStatus, true> = {
      completed: true,
      failed: true,
      cancelled: true,
      expired: true,
      time_limited: true,
      aborted: true,
      unknown: true,
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

  it('词表外 reason 回填 unknown（fail-visible——default=completed 的 fail-open 方向废除）', () => {
    // [subagent-observability 验收④] 未知 reason 不再落 completed（不产假成功）。
    expect(mapReasonToStatus('some-future-reason')).toBe('unknown')
    expect(mapReasonToStatus('')).toBe('unknown')
  })

  it('三组词表外字面量显式映射（§3.3.6：不再直落 default）', () => {
    // markRoundIdle 轮终注销字面量（历史口径显式化——新写入方退役该字面量）
    expect(mapReasonToStatus('running')).toBe('completed')
    // doFinalize 编排性收尾
    expect(mapReasonToStatus('closed')).toBe('cancelled')
    // reconcile-sweep 直通族（closedReason 直通）：宿主侧打断族 → aborted
    expect(mapReasonToStatus('parent-shutdown')).toBe('aborted')
    expect(mapReasonToStatus('parent-fork')).toBe('aborted')
    expect(mapReasonToStatus('parent-new')).toBe('aborted')
    expect(mapReasonToStatus('disconnected')).toBe('aborted')
    // 用户关闭族 → cancelled
    expect(mapReasonToStatus('user-close')).toBe('cancelled')
    // gc 通用终态无专属语义 → unknown（诚实缺省）
    expect(mapReasonToStatus('gc')).toBe('unknown')
  })
})

describe('SettlementReason 结清枚举（subagent-observability §3.3.6 新权威通道）', () => {
  it('封闭五值锁定（与 subagent-core run-vocabulary ALL_SETTLEMENT_REASONS 同源词表）', () => {
    expect([...SETTLEMENT_REASONS]).toEqual(['completed', 'failed', 'cancelled', 'lost', 'no_result'])
    expect(new Set(SETTLEMENT_REASONS).size).toBe(SETTLEMENT_REASONS.length)
    // 解析缺省不在五值内（fail-visible 的缺省独立位）
    const parsed: ResolvedSettlementReason = 'unknown'
    expect(parsed).toBe('unknown')
    expect(SETTLEMENT_REASONS).not.toContain('unknown')
  })

  it('解析规则逐项锁定：同名直通 + 设计指定映射（expired→no_result、time_limited→failed、aborted→cancelled）', () => {
    const cases: Array<[string, ResolvedSettlementReason]> = [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
      ['lost', 'lost'],
      ['no_result', 'no_result'],
      ['expired', 'no_result'],
      ['time_limited', 'failed'],
      ['budget_limited', 'failed'],
      ['aborted', 'cancelled'],
      ['interrupted', 'cancelled'],
      ['interrupted-by-restart', 'cancelled'],
      ['interrupted-by-parent', 'cancelled'],
      ['reopened', 'completed'],
      ['stopped', 'cancelled'],
      ['exited', 'cancelled'],
      ['deleted', 'cancelled'],
      ['orphaned', 'cancelled'],
    ]
    for (const [reason, expected] of cases) {
      expect(resolveSettlementReason(reason)).toBe(expected)
    }
  })

  it('三组词表外字面量的结清解析（§3.3.6 处置语义）', () => {
    // markRoundIdle "running"：轮终注销簿记不载成败事实 → no_result（无事实可依）
    expect(resolveSettlementReason('running')).toBe('no_result')
    // doFinalize "closed"：编排性收尾 → cancelled
    expect(resolveSettlementReason('closed')).toBe('cancelled')
    // reconcile-sweep 直通族：宿主打断/用户关闭 → cancelled；死因不可考/通用 → no_result
    expect(resolveSettlementReason('parent-shutdown')).toBe('cancelled')
    expect(resolveSettlementReason('parent-fork')).toBe('cancelled')
    expect(resolveSettlementReason('parent-new')).toBe('cancelled')
    expect(resolveSettlementReason('user-close')).toBe('cancelled')
    expect(resolveSettlementReason('disconnected')).toBe('no_result')
    expect(resolveSettlementReason('gc')).toBe('no_result')
  })

  it('词表外 reason 结清解析回填 unknown（fail-visible）', () => {
    expect(resolveSettlementReason('some-future-reason')).toBe('unknown')
    expect(resolveSettlementReason('')).toBe('unknown')
  })

  it('两通道键集对拍：结清解析表键集 = legacy reason 键集 ∪ 结清五值同名键（结构性防漏登记）', () => {
    // 键集漂移静态防线：任一登记表增删键而另一侧未同批跟随时本断言变红（缺登记键
    // 在消费侧解析为 unknown——fail-visible 可见但属漏登记缺陷信号）。键集常量派生
    // 自两张映射表本身（无第二份手工词表），对拍对象是登记表实况而非测试夹具。
    const expected = new Set<string>([...MAPPED_REASON_KEYS, ...SETTLEMENT_REASONS])
    expect(SETTLEMENT_REASON_KEYS).toEqual(expected)
    // 前提事实防恒真：两键集非空、且五值中 completed/failed/cancelled 与 legacy
    // 键同名直通——结清键集严格大于 legacy 键集（lost/no_result 为新增成员）。
    expect(MAPPED_REASON_KEYS.size).toBeGreaterThan(0)
    expect(SETTLEMENT_REASON_KEYS.size).toBe(MAPPED_REASON_KEYS.size + 2)
    for (const key of MAPPED_REASON_KEYS) {
      expect(SETTLEMENT_REASON_KEYS.has(key)).toBe(true)
    }
  })
})

describe('MAPPED_PENDING_STATUSES（值集单源导出，MF-1-5）', () => {
  it('Set 成员恰等于 MappedPendingStatus 联合（派生自 REASON_STATUS_MAP，无第二份词表）', () => {
    // Record 全键字面量：MappedPendingStatus 长出第 8 个成员即编译错（同上「禁扩词表」手法）
    const fullVocabulary: Record<MappedPendingStatus, true> = {
      completed: true,
      failed: true,
      cancelled: true,
      expired: true,
      time_limited: true,
      aborted: true,
      unknown: true,
    }
    expect(MAPPED_PENDING_STATUSES.size).toBe(Object.keys(fullVocabulary).length)
    for (const status of MAPPED_PENDING_STATUSES) {
      expect(fullVocabulary[status as MappedPendingStatus]).toBe(true)
    }
    // 词表外值不在集（消费方成员判定的拒收分支）
    expect(MAPPED_PENDING_STATUSES.has('active')).toBe(false)
    expect(MAPPED_PENDING_STATUSES.has('not-a-status')).toBe(false)
  })

  it('unknown 落盘 status 经字段视图放行（fail-visible：不可判读进入字段视图，不静默丢弃）', () => {
    // 词表外 status 原先被 scan 拒收（视图缺值）；unknown 作为词表成员进入视图
    const scan = scanPendingEntries([unregStatus('bt-1', 'unknown')])
    expect(scan.unregisterStatuses.get('bt-1')).toBe('unknown')
  })
})
