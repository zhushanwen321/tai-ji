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

describe('isRunningProjection 占用谓词（白盒：G2「正在跑」严格口径，two-state-convergence D1）', () => {
  it('仅 running 落 true（idle 与 legacy 终态全部投影 idle 不算在跑）', () => {
    for (const status of ALL_STATUSES) {
      const expected = status === 'running'
      expect(isRunningProjection(makeRecord(status)), `status=${status} 占用投影应 ${expected}`).toBe(expected)
    }
  })

  it('done 投影形态（running + result + chatMode 显式 false，v4~U7 轮终）→ false（已收口不算在跑）', () => {
    expect(isRunningProjection(makeRecord('running', { result: 'round output', chatMode: false }))).toBe(false)
  })

  it('chat 轮终幽灵形态（running + result + resumable:true + chatMode:true）→ false（result 子句排除——badge 幽灵根因修复，session 01a09f83 实测形态）', () => {
    expect(isRunningProjection(makeRecord('running', { result: 'round output', resumable: true, chatMode: true }))).toBe(false)
  })

  it('legacy chatMode=∅ 轮终（running + result + resumable=∅）→ false（result === undefined 子句兜住——旧 entry 无 chatMode 字段的 one-shot 轮终不再永计入）', () => {
    expect(isRunningProjection(makeRecord('running', { result: 'round output' }))).toBe(false)
  })

  it('residual running（running + resumable:true 无 result）→ false（resumable !== true 子句排除——孤儿兜底/轮终无活进程驱动，对齐 hasRunning 既有口径）', () => {
    expect(isRunningProjection(makeRecord('running', { resumable: true }))).toBe(false)
  })

  it('真在跑形态（running 无 result 无 resumable，chatMode true/false/∅ 皆然）→ true（首轮在跑计入，与形态配置正交）', () => {
    expect(isRunningProjection(makeRecord('running'))).toBe(true)
    expect(isRunningProjection(makeRecord('running', { chatMode: true }))).toBe(true)
    expect(isRunningProjection(makeRecord('running', { chatMode: false }))).toBe(true)
  })
})

describe('isDoneProjection（白盒 SSOT 直测：仅 running + result 在场 + chatMode 显式 false）', () => {
  it('running + result + chatMode:false → true（done 投影本体）', () => {
    expect(isDoneProjection(makeRecord('running', { result: 'round output', chatMode: false }))).toBe(true)
  })

  it('running + result 空串 + chatMode:false → true（「result 在场」= !== undefined，非真值判定）', () => {
    expect(isDoneProjection(makeRecord('running', { result: '', chatMode: false }))).toBe(true)
  })

  it('chatMode 缺省（v1 前存量 entry undefined）→ false（保守：无法确认不是 chat 不宣告完成）', () => {
    expect(isDoneProjection(makeRecord('running', { result: 'round output' }))).toBe(false)
  })

  it('result 缺省 → false（首轮未完成，真在跑）', () => {
    expect(isDoneProjection(makeRecord('running', { chatMode: false }))).toBe(false)
  })

  it('chatMode:true → false（chat 轮终等续聊，waiting 非完成）', () => {
    expect(isDoneProjection(makeRecord('running', { result: 'round output', chatMode: true }))).toBe(false)
  })

  it('idle / 非 running（含显式 done）→ false（本函数只描述 running 形态投影，其余由占用投影承接）', () => {
    for (const status of ALL_STATUSES.filter((s) => s !== 'running')) {
      expect(isDoneProjection(makeRecord(status, { result: 'x', chatMode: false })), `status=${status}`).toBe(false)
    }
  })
})

describe('filterSubagents（黑盒：三视图行为）', () => {
  /** 混合 fixture：1 running-streaming + 1 idle(active) + 1 done 投影(active) + 1 legacy done(active) + 1 archived idle */
  function makeMixedRecords(): SubagentRecord[] {
    return [
      makeRecord('running', { subagentId: 'r-stream' }), // streaming → active + running
      makeRecord('idle', { subagentId: 'r-idle', stopReason: 'completed', turns: 2 }), // active，非 running
      makeRecord('running', { subagentId: 'r-done-proj', result: 'round output', chatMode: false }), // active，非 running
      makeRecord('done', { subagentId: 'r-legacy-done' }), // active（legacy 投影 idle），非 running
      makeRecord('idle', { subagentId: 'r-archived', intent: 'archived' }), // archived
    ]
  }

  it("'active'（默认视图）= 全部非收起：running + idle + legacy 终态全显（可见性翻转核心断言）", () => {
    const records = makeMixedRecords()
    const active = filterSubagents(records, 'active')
    expect(active.map((r) => r.subagentId)).toEqual(['r-stream', 'r-idle', 'r-done-proj', 'r-legacy-done'])
    expect(active.every((r) => subagentBucket(r) === 'active')).toBe(true)
  })

  it("'running'（只看正在跑）= 占用投影 running：waiting 计入，done 投影 / idle / legacy 终态排除", () => {
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
      makeRecord('running', { chatMode: true }), // active + running（waiting）
      makeRecord('idle', { stopReason: 'completed' }), // active，非 running
      makeRecord('done'), // active（legacy），非 running
      makeRecord('idle', { intent: 'archived' }), // archived
    ]
    const counts = countSubagents(records)
    expect(counts).toEqual({ active: 4, running: 2, archived: 1 })
    expect(counts.active).toBe(filterSubagents(records, 'active').length)
    expect(counts.running).toBe(filterSubagents(records, 'running').length)
    expect(counts.archived).toBe(filterSubagents(records, 'archived').length)
  })

  it('空数组 → 三视图全 0', () => {
    expect(countSubagents([])).toEqual({ active: 0, running: 0, archived: 0 })
  })

  it('边界：全收起 / 全在跑（含 resumable 残留不计入——严格口径）', () => {
    expect(countSubagents([
      makeRecord('idle', { intent: 'archived' }),
      makeRecord('done', { intent: 'archived' }),
    ])).toEqual({ active: 0, running: 0, archived: 2 })
    expect(
      countSubagents([makeRecord('running'), makeRecord('running', { resumable: true })]),
    ).toEqual({
      active: 2,
      running: 1, // resumable=true = residual running（无活进程驱动），严格口径排除
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
  /** 枚举 → 占用归属的显式断言表（决策记录：扩枚举须先评估再补键，缺键即红） */
  const RUNNING_MATRIX: Record<SubagentStatus, boolean> = {
    running: true, // 唯一「进行中类」值（waiting / done 投影细分见上方形态矩阵）
    idle: false, // U8 两态收口：随时可续聊的空闲，不算在跑
    done: false,
    failed: false,
    cancelled: false,
    crashed: false,
    closed: false,
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
      ...(spec.resumable !== undefined ? { resumable: spec.resumable } : {}),
      ...(spec.chatMode !== undefined ? { chatMode: spec.chatMode } : {}),
      ...(spec.stopReason !== undefined ? { stopReason: spec.stopReason } : {}),
    })
  }

  const fixtureRecords: SubagentRecord[] = SESSION_01A09F83_GHOST_FIXTURE.map(recordFromSpec)

  it('fixture 完整性：39 个 record id（8 幽灵 + 29 one-shot 轮终 + 2 中断收口，与 §2.1 实测分布一致）', () => {
    expect(SESSION_01A09F83_GHOST_FIXTURE).toHaveLength(39)
    const ghosts = SESSION_01A09F83_GHOST_FIXTURE.filter((s) => s.chatMode === true && s.status === 'running')
    expect(ghosts).toHaveLength(8)
  })

  it('⛔门：修复后严格口径回放 badge 计数 = 0（幽灵 8→0；filterSubagents running 视图同步为空）', () => {
    expect(countSubagents(fixtureRecords).running).toBe(0)
    expect(filterSubagents(fixtureRecords, 'running')).toEqual([])
  })

  it('判别力对照：旧组合判据（投影 running 且非 done 投影）回放 = 8——差值恰为 chat 轮终幽灵', () => {
    const legacyCount = fixtureRecords.filter(
      (r) => projectSubagentExecutionStatus(r.status) === 'running' && !isDoneProjection(r),
    ).length
    expect(legacyCount).toBe(8)
  })
})
