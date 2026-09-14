/**
 * renderer lib/subagent-bucket.test.ts —— 分桶判据 SSOT 模块单测
 * （设计 subagent-sidebar-filter §3.4 / 永久会话模型 §3.2.8 默认可见性翻转，U8b 重写）。
 *
 * 三视角：
 * - 白盒：subagentBucket 意愿分桶（intent 缺省 active / archived 收起）、
 *   isRunningProjection 占用谓词（SUBAGENT_STATUS_ALL 全集 × done 投影矩阵）、
 *   isDoneProjection SSOT 直测（旧数据轮终形态）
 * - 黑盒：filterSubagents 三视图行为（active 全活跃 / running 只看在跑 / archived 已收起）、
 *   countSubagents 计数一致性
 * - 形态：导出符号齐全（DEFAULT_SUBAGENT_FILTER === 'active' 默认视图）
 *
 * [GUI 快修⑤ GUI 侧验收] idle record（U7 冷重启 hydrateReviveBaseline 恢复的
 * turns/tokens 形态）默认可见且计数信号非零的投影面由「idle 归 active 桶」矩阵
 * 承接；列表文本渲染断言见 SubagentList.spec.ts。
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/lib/subagent-bucket.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  SUBAGENT_STATUS_ALL,
  projectSubagentExecutionStatus,
  type SubagentRecord,
  type SubagentStatus,
} from '@xyz-agent/shared'
import {
  DEFAULT_SUBAGENT_FILTER,
  isDoneProjection,
  isRunningProjection,
  isWaiting,
  subagentBucket,
  filterSubagents,
  countSubagents,
  type SubagentFilterValue,
  type SubagentBucket,
} from '@/lib/subagent-bucket'
import { SESSION_01A09F83_GHOST_FIXTURE, type GhostFixtureSpec } from './subagent-ghost-fixture'

/**
 * [B3] 全集数据源 = shared 导出的 SUBAGENT_STATUS_ALL（不再本地硬拷贝）：shared 扩
 * SubagentStatus 枚举时同步该元组，下方全部形态矩阵即自动覆盖新值；漏同步则由
 * shared 侧编译锁（_subagentStatusCoversAll）与全集覆盖矩阵断言分别拦截。
 */
const ALL_STATUSES: readonly SubagentStatus[] = SUBAGENT_STATUS_ALL

/** 构造最小合法 SubagentRecord（仅必填字段 + 形态字段注入） */
function makeRecord(status: SubagentStatus, extra: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: `bg-test-${status}-${Math.random().toString(36).slice(2, 8)}`,
    sessionFile: null,
    agent: 'reviewer',
    slug: 'review-1',
    task: 'review the diff',
    status,
    ...extra,
  }
}

describe('subagentBucket 意愿分桶（白盒：intent 维度，status 不参与）', () => {
  it('intent 缺省（存量 record / 旧扩展投影）→ active（默认列表可见，S8 只读兼容）', () => {
    for (const status of ALL_STATUSES) {
      expect(subagentBucket(makeRecord(status)), `status=${status} 缺省 intent 应归 active`).toBe('active')
    }
  })

  it("intent='active' → active；intent='archived' → archived（与 status 正交——收起的 idle/running 都归已收起）", () => {
    for (const status of ALL_STATUSES) {
      expect(subagentBucket(makeRecord(status, { intent: 'active' }))).toBe('active')
      expect(subagentBucket(makeRecord(status, { intent: 'archived' }))).toBe('archived')
    }
  })
})

describe('isRunningProjection 占用谓词（白盒：G2「正在跑」严格口径，two-state-convergence D1；[U6] 判据终态化）', () => {
  it('仅 running 落 true（idle 不算在跑；[U6] 类型收窄后词表已两态）', () => {
    for (const status of ALL_STATUSES) {
      const expected = status === 'running'
      expect(isRunningProjection(makeRecord(status)), `status=${status} 占用投影应 ${expected}`).toBe(expected)
    }
  })

  it('[U6 终态判据] running + stopReason=∅（真在跑，含首轮与轮始清点后的第 2+ 轮）→ true', () => {
    expect(isRunningProjection(makeRecord('running'))).toBe(true)
  })

  it('[U6 终态判据] running + stopReason 在场（W4 新型 failed / A-lite 轮终 completed）→ false（stopReason 子句排除）', () => {
    expect(isRunningProjection(makeRecord('running', { stopReason: 'failed' }))).toBe(false)
    expect(isRunningProjection(makeRecord('running', { stopReason: 'completed' }))).toBe(false)
  })

  it('result 在场不再参与判定（[U6] result 子句退役——轮终排除由 status 子句（U4 翻边 idle）+ runtime 第五归一承接；result 是数据非状态）', () => {
    // running + result + 无 stopReason：U4 部署边界旧 entry 的理论形态（归一层
    // `running && resumable===true → idle` 承接存量桥接；无 resumable 的 W16 前
    // entry 无 result 字段）——renderer 层按占用判（在飞缺停因信号，保守计入）。
    expect(isRunningProjection(makeRecord('running', { result: 'round output' }))).toBe(true)
    // idle + result（U4 后轮终权威形态）→ status 子句排除
    expect(isRunningProjection(makeRecord('idle', { result: 'round output' }))).toBe(false)
  })

  it('chat 轮终幽灵形态（U4 翻边后 = idle + result + chatMode:true）→ false（status 子句排除——badge 幽灵根因修复，session 01a09f83 实测形态）', () => {
    expect(isRunningProjection(makeRecord('idle', { result: 'round output', chatMode: true }))).toBe(false)
  })

  it('legacy chatMode=∅ 轮终（U4 翻边后 = idle + result）→ false（status 子句排除——旧 entry 无 chatMode 字段的 one-shot 轮终不再永计入）', () => {
    expect(isRunningProjection(makeRecord('idle', { result: 'round output' }))).toBe(false)
  })

  it('真在跑形态（running 无 result，chatMode true/false/∅ 皆然）→ true（首轮在跑计入，与形态配置正交）', () => {
    expect(isRunningProjection(makeRecord('running'))).toBe(true)
    expect(isRunningProjection(makeRecord('running', { chatMode: true }))).toBe(true)
    expect(isRunningProjection(makeRecord('running', { chatMode: false }))).toBe(true)
  })
})

describe('isDoneProjection（白盒 SSOT 直测：idle + chatMode 显式 false——[two-state-convergence U4] 判据 idle 化）', () => {
  it('idle + chatMode:false → true（翻边后 one-shot 完成投影本体）', () => {
    expect(isDoneProjection(makeRecord('idle', { chatMode: false }))).toBe(true)
  })

  it('idle + chatMode:false + result 缺省 → true（判据不消费 result——形态字段独立于产出数据）', () => {
    expect(isDoneProjection(makeRecord('idle', { chatMode: false, result: undefined }))).toBe(true)
  })

  it('chatMode 缺省（legacy 存量 entry undefined）→ false（保守：无法确认不是 chat 不宣告完成）', () => {
    expect(isDoneProjection(makeRecord('idle', { result: 'round output' }))).toBe(false)
  })

  it('chatMode:true → false（chat 等续聊，waiting 非完成）', () => {
    expect(isDoneProjection(makeRecord('idle', { chatMode: true }))).toBe(false)
  })

  it('running（含桥接期轮终 running + result 形态）→ false（判据 idle 化后 running 恒 false——桥接存量展示过渡态，U6 归一恢复）', () => {
    expect(isDoneProjection(makeRecord('running', { result: 'round output', chatMode: false }))).toBe(false)
    expect(isDoneProjection(makeRecord('running', { result: 'x' }))).toBe(false)
  })

  it('legacy 终态字面值经 runtime 归一后不再出现（[U6] 类型收窄——归一映射形态断言见下方 P1 矩阵）', () => {
    // 归一后的 legacy 终态形态（idle + stopReason 合成）不计入占用
    expect(isDoneProjection(makeRecord('idle', { chatMode: false, stopReason: 'completed' }))).toBe(true)
  })
})

describe('isWaiting（白盒 SSOT 直测：idle + chatMode !== false——[two-state-convergence U4] 自 SubagentList 迁入）', () => {
  it('idle + chatMode:true → true（chat 轮终等续聊——翻边后 accent-60 半透明点的判据源）', () => {
    expect(isWaiting(makeRecord('idle', { chatMode: true }))).toBe(true)
  })

  it('idle + chatMode 缺省（legacy undefined）→ true（保守归 chat： !== false 恒真）', () => {
    expect(isWaiting(makeRecord('idle'))).toBe(true)
    expect(isWaiting(makeRecord('idle', { result: 'x' }))).toBe(true)
  })

  it('idle + chatMode:false → false（与 isDoneProjection 互补无交叠）', () => {
    expect(isWaiting(makeRecord('idle', { chatMode: false }))).toBe(false)
  })

  it('running 恒 false（判据 idle 化——真在跑不属 waiting 展示域）', () => {
    expect(isWaiting(makeRecord('running'))).toBe(false)
    expect(isWaiting(makeRecord('running', { chatMode: true, result: 'x' }))).toBe(false)
  })
})

describe('filterSubagents（黑盒：三视图行为）', () => {
  /** 混合 fixture：1 running-streaming + 1 idle(active) + 1 done 投影(active) + 1 archived idle */
  function makeMixedRecords(): SubagentRecord[] {
    return [
      makeRecord('running', { subagentId: 'r-stream' }), // streaming → active + running
      makeRecord('idle', { subagentId: 'r-idle', stopReason: 'completed', turns: 2 }), // active，非 running
      // [U6] done 投影 fixture 形态 = U4 翻边后轮终权威形态（idle + stopReason）
      makeRecord('idle', { subagentId: 'r-done-proj', result: 'round output', chatMode: false, stopReason: 'completed' }), // active，非 running
      makeRecord('idle', { subagentId: 'r-archived', intent: 'archived' }), // archived
    ]
  }

  it("'active'（默认视图）= 全部非收起：running + idle 全显（可见性翻转核心断言）", () => {
    const records = makeMixedRecords()
    const active = filterSubagents(records, 'active')
    expect(active.map((r) => r.subagentId)).toEqual(['r-stream', 'r-idle', 'r-done-proj'])
    expect(active.every((r) => subagentBucket(r) === 'active')).toBe(true)
  })

  it("'running'（只看正在跑）= 占用投影 running：真在跑计入，轮终 / idle 排除", () => {
    const records = makeMixedRecords()
    expect(filterSubagents(records, 'running').map((r) => r.subagentId)).toEqual(['r-stream'])
  })

  it("'archived'（已收起视图，场景 3 寻回入口）= intent archived", () => {
    const records = makeMixedRecords()
    expect(filterSubagents(records, 'archived').map((r) => r.subagentId)).toEqual(['r-archived'])
  })

  it('过滤返回新数组且不变更原数组（无副作用）', () => {
    const records = makeMixedRecords()
    const snapshot = [...records]
    const active = filterSubagents(records, 'active')
    expect(active).not.toBe(records)
    expect(records).toEqual(snapshot)
  })

  it('空数组 → 三视图均返回空', () => {
    const empty: SubagentRecord[] = []
    expect(filterSubagents(empty, 'active')).toEqual([])
    expect(filterSubagents(empty, 'running')).toEqual([])
    expect(filterSubagents(empty, 'archived')).toEqual([])
  })
})

describe('countSubagents（黑盒：计数一致性）', () => {
  it('三视图计数与 filterSubagents 各视图长度一致（FilterBar 计数预告口径）', () => {
    const records = [
      makeRecord('running'), // active + running
      makeRecord('running', { chatMode: true }), // active + running
      makeRecord('idle', { stopReason: 'completed' }), // active，非 running
      makeRecord('idle', { intent: 'archived' }), // archived
    ]
    const counts = countSubagents(records)
    expect(counts).toEqual({ active: 3, running: 2, archived: 1 })
    expect(counts.active).toBe(filterSubagents(records, 'active').length)
    expect(counts.running).toBe(filterSubagents(records, 'running').length)
    expect(counts.archived).toBe(filterSubagents(records, 'archived').length)
  })

  it('空数组 → 三视图全 0', () => {
    expect(countSubagents([])).toEqual({ active: 0, running: 0, archived: 0 })
  })

  it('边界：全收起 / 全在跑（[U6] W4 新型 running+failed 不计入——stopReason 子句）', () => {
    expect(countSubagents([
      makeRecord('idle', { intent: 'archived' }),
      makeRecord('idle', { stopReason: 'completed', intent: 'archived' }),
    ])).toEqual({ active: 0, running: 0, archived: 2 })
    expect(
      countSubagents([makeRecord('running'), makeRecord('running', { stopReason: 'failed' })]),
    ).toEqual({
      active: 2,
      running: 1, // W4 新型（running + stopReason=failed）经 [U6] stopReason 子句排除——badge 只计真在跑
      archived: 0,
    })
  })
})

describe('导出形态（观察者：SSOT 模块公共面齐全）', () => {
  it("DEFAULT_SUBAGENT_FILTER === 'active'（默认视图 = 全部活跃会话，可见性翻转后 idle 默认可见）", () => {
    expect(DEFAULT_SUBAGENT_FILTER).toBe('active')
  })

  it('四个判据函数均已导出且为函数', () => {
    expect(typeof isDoneProjection).toBe('function')
    expect(typeof isRunningProjection).toBe('function')
    expect(typeof subagentBucket).toBe('function')
    expect(typeof filterSubagents).toBe('function')
    expect(typeof countSubagents).toBe('function')
  })

  it('类型面：SubagentFilterValue 三值空间（active/running/archived）/ SubagentBucket 二值空间', () => {
    const filterValues: SubagentFilterValue[] = ['active', 'running', 'archived']
    const bucketValues: SubagentBucket[] = ['active', 'archived']
    expect(filterValues).toContain(DEFAULT_SUBAGENT_FILTER)
    expect(bucketValues).toContain(subagentBucket(makeRecord('running')))
  })
})

// ── [B3] 全集覆盖矩阵（adversarial-review-fixes §3.3 B3，U8b 重述）──────────────
//
// 护栏语义：Record<SubagentStatus, boolean> 断言表是显式的「枚举 → 占用归属」决策
// 记录——shared 扩枚举后此表缺新键时，循环取值为 undefined 与实际投影值不等，本矩阵
// 翻红；翻红处置 = 评估新值归属（「进行中类」值必须落 true，不得静默归 false 的
// idle 半边），补键后再绿。矩阵与 ALL_STATUSES（shared SUBAGENT_STATUS_ALL）双源互证。

describe('[B3] 全集覆盖矩阵（SUBAGENT_STATUS_ALL 每值都有显式占用归属断言）', () => {
  /** 枚举 → 占用归属的显式断言表（决策记录：扩枚举须先评估再补键，缺键即红）。
   *  [U6] 类型收窄后全集 = 两态。 */
  const RUNNING_MATRIX: Record<SubagentStatus, boolean> = {
    running: true, // 唯一「进行中类」值（W4 纳管态经 stopReason 子句排除，见 P1 矩阵）
    idle: false, // 两态收口：随时可续聊的空闲，不算在跑
  }

  it('每个枚举值的 streaming 形态（无附加形态字段）占用归属与断言表一致', () => {
    for (const status of ALL_STATUSES) {
      expect(
        isRunningProjection(makeRecord(status)),
        `status=${status} 的占用归属与 RUNNING_MATRIX 声明不符（扩枚举后未评估归属？）`,
      ).toBe(RUNNING_MATRIX[status])
    }
  })

  it('断言表键集 = SUBAGENT_STATUS_ALL 全集（矩阵缺键/多键即覆盖数失配）', () => {
    expect(Object.keys(RUNNING_MATRIX).length).toBe(SUBAGENT_STATUS_ALL.length)
    expect(Object.keys(RUNNING_MATRIX).sort()).toEqual([...SUBAGENT_STATUS_ALL].sort())
  })

  it('SUBAGENT_STATUS_ALL 无重复值且含 running（占用谓词的唯一真值基准）', () => {
    expect(new Set(SUBAGENT_STATUS_ALL).size).toBe(SUBAGENT_STATUS_ALL.length)
    expect(SUBAGENT_STATUS_ALL).toContain('running')
  })

  it('[GUI 快修⑤ 投影面] idle record（含 turns/tokens 复活形态）归默认视图（active 桶）——冷重启后统计信号不丢展示位', () => {
    const revived = makeRecord('idle', { stopReason: 'completed', turns: 4, totalTokens: 88000 })
    expect(subagentBucket(revived)).toBe('active')
    expect(filterSubagents([revived], 'active')).toHaveLength(1)
  })
})

// ── [P1 ⛔实施期门] 形态 × 判据矩阵全量（two-state-convergence D7，U6 全量 10 形态）──
//
// 门语义：10 现实形态 × SSOT 谓词本体（isRunningProjection），全矩阵钉住「同 record
// 同答案」。失败处置 = 判据矩阵有形态遗漏，补形态后重跑，禁止放宽断言（D7 门探针
// 降级路径）。形态视角 = renderer 收到的 record（legacy 值已经 runtime 归一层映射）。

describe('[P1 门] 形态 × 判据矩阵全量（10 现实形态，two-state-convergence D7/U6）', () => {
  /** 形态表：现实形态描述 + record 构造 + 占用期望（显式决策记录，缺行即遗漏） */
  const MATRIX: Array<{ name: string; rec: SubagentRecord; occupied: boolean }> = [
    {
      // 形态 1：§2.1 表「真在跑（观察时点）」
      name: '1 真在跑（首轮在飞：running + result=∅ + stopReason=∅）',
      rec: makeRecord('running'),
      occupied: true,
    },
    {
      // 形态 2：R4 MF-A 第 2+ 轮在飞型（轮始清点扩字段后的应有形态——markRoundStarted
      // 已清上轮 stopReason，record 与首轮在飞同形）。若清点失效（stale stopReason
      // 残留）本谓词将误排除——该失效由 core 轮始清点测试守卫（record-store-intent-api），
      // 本行钉住「扩字段后第 2+ 轮在飞不误排除」的renderer侧终态。
      name: '2 第 2+ 轮在飞（轮始清点后：running + result=∅ + stopReason 已清）',
      rec: makeRecord('running'),
      occupied: true,
    },
    {
      // 形态 3：R3 补 W4 新型（[U5/D4] adoptEngineDeath：running + error + failed + result=∅）
      name: "3 W4 死亡纳管新型（running + result=∅ + stopReason='failed'）",
      rec: makeRecord('running', { stopReason: 'failed', error: 'engine died' }),
      occupied: false,
    },
    {
      // 形态 4：U4 边界 A-lite 轮终残留（running + result + stopReason='completed'——
      // 归一层第五归一未触发时〔resumable 缺失〕仍被 stopReason 子句排除）
      name: "4 A-lite 轮终残留（running + result 在场 + stopReason='completed'）",
      rec: makeRecord('running', { result: '(redacted)', stopReason: 'completed' }),
      occupied: false,
    },
    {
      // 形态 5：§3.4 第 2 行 chat 轮终翻边
      name: '5 chat 轮终（idle + chatMode:true + result + completed）',
      rec: makeRecord('idle', { result: '(redacted)', chatMode: true, stopReason: 'completed' }),
      occupied: false,
    },
    {
      // 形态 6：§3.4 第 3 行 one-shot 轮终翻边
      name: '6 one-shot 轮终（idle + chatMode:false + result + completed）',
      rec: makeRecord('idle', { result: '(redacted)', chatMode: false, stopReason: 'completed' }),
      occupied: false,
    },
    {
      // 形态 7：§3.4 第 4 行 legacy chatMode=∅ 轮终（归一保守按 chat 展示，占用同排除）
      name: '7 legacy chatMode=∅ 轮终（idle + result + completed + chatMode 缺省）',
      rec: makeRecord('idle', { result: '(redacted)', stopReason: 'completed' }),
      occupied: false,
    },
    {
      // 形态 8：§3.4 第 5 行 重建孤儿（runtime 第五归一 → idle；result=∅ + stopReason=∅）
      name: '8 重建孤儿归一后（idle + result=∅ + stopReason=∅ + chatMode 缺省）',
      rec: makeRecord('idle'),
      occupied: false,
    },
    {
      // 形态 9：§3.4 第 7 行 中断收口（markSettled idle + interrupted 族）
      name: "9 中断收口（idle + stopReason='interrupted'）",
      rec: makeRecord('idle', { stopReason: 'interrupted' }),
      occupied: false,
    },
    {
      // 形态 10：W4 旧型经 runtime 第五归一（running+resumable=true → idle，无 stopReason）
      name: '10 W4 旧型经第五归一（idle + result=∅ + stopReason=∅——跨重启孤儿纠偏形态）',
      rec: makeRecord('idle'),
      occupied: false,
    },
  ]

  it('⛔门：全矩阵钉住「同 record 同答案」（10 形态 × isOccupied 判据本体）', () => {
    for (const { name, rec, occupied } of MATRIX) {
      expect(isRunningProjection(rec), name).toBe(occupied)
    }
  })

  it('形态表恰好 10 行（D7 全量清单——增删形态须同步设计文档矩阵）', () => {
    expect(MATRIX).toHaveLength(10)
  })

  it('「正在跑」过滤视图与谓词同源（filterSubagents running 视图 = 矩阵 occupied 子集）', () => {
    const occupied = MATRIX.filter((m) => m.occupied).map((m) => m.rec.subagentId)
    expect(filterSubagents(MATRIX.map((m) => m.rec), 'running').map((r) => r.subagentId)).toEqual(occupied)
  })
})

// ── [two-state-convergence U4] 翻边后形态断言（写面轮终落 idle 的展示/占用分工）──
describe('[two-state-convergence U4] 翻边后形态：waiting 计入展示、不计入占用', () => {
  it('翻边 chat 轮终（idle + chatMode:true + result）→ 不计入占用（badge 不计）+ 计入 waiting（accent-60 展示）', () => {
    const flipped = makeRecord('idle', { result: '(redacted)', chatMode: true, stopReason: 'completed' })
    expect(isRunningProjection(flipped)).toBe(false)
    expect(isWaiting(flipped)).toBe(true)
    expect(isDoneProjection(flipped)).toBe(false)
  })

  it('翻边 one-shot 轮终（idle + chatMode:false）→ 不计入占用 + done 展示（绿点）', () => {
    const flipped = makeRecord('idle', { chatMode: false, stopReason: 'completed' })
    expect(isRunningProjection(flipped)).toBe(false)
    expect(isDoneProjection(flipped)).toBe(true)
    expect(isWaiting(flipped)).toBe(false)
  })

  it('翻边轮终不影响「正在跑」过滤视图（filterSubagents running 视图零含）', () => {
    const records = [
      makeRecord('idle', { subagentId: 'flip-chat', chatMode: true, result: 'x' }),
      makeRecord('idle', { subagentId: 'flip-oneshot', chatMode: false }),
      makeRecord('running', { subagentId: 'real-running' }),
    ]
    expect(filterSubagents(records, 'running').map((r) => r.subagentId)).toEqual(['real-running'])
  })
})

// ── [P1 ⛔实施期门] session 01a09f83 形态 fixture 回放（two-state-convergence U1/D1/D7）──
//
// 门语义：39 条真实 record 形态按修复后严格口径回放 badge 计数 = 0（D1「幽灵 8→0」）。
// 失败处置 = 判据矩阵有形态遗漏，补形态后重跑，禁止放宽断言（D7 门探针降级路径）。
// 对照断言（旧组合判据 = 8）钉住 fixture 判别力：差值恰为 8 个 chat 轮终幽灵，
// 证明 fixture 编码的正是本次修复的 bug 现场（数据源与脱敏规则见 fixture 头注释）。

describe('[P1 门] 01a09f83 fixture 回放（严格口径 badge 计数 = 0）', () => {
  /** 脱敏形态规格 → 最小合法 SubagentRecord（只注形态字段，无任何正文内容） */
  function recordFromSpec(spec: GhostFixtureSpec): SubagentRecord {
    return makeRecord(spec.status, {
      subagentId: spec.aliasId,
      ...(spec.hasResult ? { result: '(redacted)' } : {}),
      ...(spec.chatMode !== undefined ? { chatMode: spec.chatMode } : {}),
      ...(spec.stopReason !== undefined ? { stopReason: spec.stopReason } : {}),
    })
  }

  const fixtureRecords: SubagentRecord[] = SESSION_01A09F83_GHOST_FIXTURE.map(recordFromSpec)

  it('fixture 完整性：39 个 record id（8 幽灵 + 29 one-shot 轮终 + 2 中断收口，与 §2.1 实测分布一致）', () => {
    expect(SESSION_01A09F83_GHOST_FIXTURE).toHaveLength(39)
    // [U4/D4] 翻边后幽灵形态 = idle + chatMode=true（轮终写 idle，U5 前 resumable 维度退役）
    const ghosts = SESSION_01A09F83_GHOST_FIXTURE.filter((s) => s.chatMode === true && s.status === 'idle')
    expect(ghosts).toHaveLength(8)
  })

  it('⛔门：修复后严格口径回放 badge 计数 = 0（幽灵 8→0；filterSubagents running 视图同步为空）', () => {
    expect(countSubagents(fixtureRecords).running).toBe(0)
    expect(filterSubagents(fixtureRecords, 'running')).toEqual([])
  })

  it('判别力对照：桥接期形态（幽灵 status 复刻为 running 残留）按旧组合判据回放 = 8——差值恰为 chat 轮终幽灵（内联复刻历史判据：isDoneProjection 已 idle 化，不再承载旧 running 形态判据）', () => {
    // 旧组合判据（U1 止血前）：投影 running 且非（running + result 在场 + chatMode=false）。
    // 内联复刻是刻意的——对照对象是「修复前的判据」，不随现行 SSOT 判据演进漂移。
    const legacyPredicate = (r: SubagentRecord): boolean =>
      projectSubagentExecutionStatus(r.status) === 'running' &&
      !(r.status === 'running' && r.result !== undefined && r.chatMode === false)
    // 桥接期形态复刻：U4 前 ghost/one-shot 轮终 entry 残留 running（resumable 桥接位，
    // [U5/D4] 字段退役后由 status=idle 直读承载——此处按历史形态内联构造作对照面）。
    const bridgedRecords = SESSION_01A09F83_GHOST_FIXTURE.map((spec) =>
      recordFromSpec(spec.status === 'idle' && spec.hasResult ? { ...spec, status: 'running' as const } : spec),
    )
    const legacyCount = bridgedRecords.filter(legacyPredicate).length
    expect(legacyCount).toBe(8)
  })
})
