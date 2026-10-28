// @vitest-environment node

/**
 * renderer lib/subagent-bucket.test.ts —— 判据 SSOT 模块单测
 * （[modeless 波4] chatMode 比对维度随字段消亡删除，done 展示判据 idle+result 化）。
 *
 * [两视图裁决 2026-09-16 托盘两态化] 原分桶面（subagentBucket / filterSubagents /
 * countSubagents / DEFAULT_SUBAGENT_FILTER 及其类型）随托盘「已收起」桶退役删除，
 * 其用例一并退役——已结束桶判据 = !isRunningProjection（「已收起」机制现已全链路删除，
 * intent 字段不复存在），口径断言现承载于 `__tests__/panel/tray/useTrayCounts.test.ts`。
 * 本文件保留判据与展示 helper 本体的完整断言体系（判据本体已下沉
 * @zhushanwen/extension-protocol subagent-projection/predicates.ts——[dmg-r1-4]，本
 * 测试经 @/lib/subagent-bucket 的 re-export 锚定同一实现，插件侧托盘 widget 同源
 * import，扩值评估两侧同批）：
 * [容器扩展点统一 §6.6/U9] 原「失败红点判据四形态 / subagentDotClass 兜底」两段随
 * 托盘 subagent 件迁移退役（宿主托盘行删，状态点规则表删除）——四形态 fixture 迁插件
 * 侧 interface/gui/tray-widget.ts 单测承载。
 *
 * 三视角：
 * - 白盒：isRunningProjection 占用谓词（SUBAGENT_STATUS_ALL 全集 × 占用矩阵 + P1 形态矩阵）
 * - 使用者（黑盒）：01a09f83 真实形态 fixture 回放（严格口径下在跑计数 = 0）
 * - 形态：谓词已导出且为函数
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/lib/subagent-bucket.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  SUBAGENT_STATUS_ALL,
  type FailureCause,
  type SubagentLastRound,
  type SubagentRecord,
  type SubagentStatus,
} from '@taiji/shared'
import { isRunningProjection, failureCauseLabel, failureCauseToneClass } from '@/lib/subagent-bucket'
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

describe('isRunningProjection 占用谓词（白盒：G2「正在跑」严格口径，two-state-convergence D1；[U6] 判据终态化）', () => {
  it('仅 running 落 true（idle 不算在跑；[U6] 类型收窄后词表已两态）', () => {
    for (const status of ALL_STATUSES) {
      const expected = status === 'running'
      expect(isRunningProjection(makeRecord(status)), `status=${status} 占用派生视图应 ${expected}`).toBe(expected)
    }
  })

  it('[U6 终态判据] running + stopReason=∅（真在跑，含首轮与轮始清点后的第 2+ 轮）→ true', () => {
    expect(isRunningProjection(makeRecord('running'))).toBe(true)
  })

  it('[U6 终态判据] running + stopReason 在场（轮收条已写：legacy failed 值 / A-lite 轮终 completed）→ false（stopReason 子句排除）', () => {
    expect(isRunningProjection(makeRecord('running', { stopReason: 'failed' }))).toBe(false)
    expect(isRunningProjection(makeRecord('running', { stopReason: 'completed' }))).toBe(false)
  })

  it('result 在场不再参与判定（[U6] result 子句退役——轮终排除由 status 子句（U4 翻边 idle）+ runtime 第五归一承接；result 是数据非状态）', () => {
    // running + result + 无 stopReason：U4 部署边界旧 entry 的理论形态（归一层
    // `running && resumable===true → idle` 承接存量桥接；无 resumable 的 W16 前
    // entry 无 result 字段）——renderer 层按占用判（在途缺停因信号，保守计入）。
    expect(isRunningProjection(makeRecord('running', { result: 'round output' }))).toBe(true)
    // idle + result（U4 后轮终权威形态）→ status 子句排除
    expect(isRunningProjection(makeRecord('idle', { result: 'round output' }))).toBe(false)
  })

  it('轮终幽灵形态（U4 翻边后 = idle + result）→ false（status 子句排除——badge 幽灵根因修复，session 01a09f83 实测形态）', () => {
    expect(isRunningProjection(makeRecord('idle', { result: 'round output' }))).toBe(false)
  })

  it('真在跑形态（running 无 result）→ true（首轮在跑计入，与产出数据正交）', () => {
    expect(isRunningProjection(makeRecord('running'))).toBe(true)
    expect(isRunningProjection(makeRecord('running', { result: 'x' }))).toBe(true)
  })

  it('idle 记录不参与占用判定（[两视图裁决 2026-09-16] 已结束桶判据 = !isRunningProjection；「已收起」机制已全链路删除，无第三桶维度）', () => {
    expect(isRunningProjection(makeRecord('idle'))).toBe(false)
  })
})

describe('导出形态（观察者：SSOT 模块公共范围齐全）', () => {
  it('谓词函数已导出且为函数（分桶面已随托盘两态化退役，[两视图裁决 2026-09-16]）', () => {
    expect(typeof isRunningProjection).toBe('function')
  })
})

// ── [B3] 全集覆盖矩阵（adversarial-review-fixes §3.3 B3）──────────────
//
// 护栏语义：Record<SubagentStatus, boolean> 断言表是显式的「枚举 → 占用归属」决策
// 记录——shared 扩枚举后此表缺新键时，循环取值为 undefined 与实际派生视图值不等，本矩阵
// 翻红；翻红处置 = 评估新值归属（「进行中类」值必须落 true，不得静默归 false 的
// idle 半边），补键后再绿。矩阵与 ALL_STATUSES（shared SUBAGENT_STATUS_ALL）双源互证。

describe('[B3] 全集覆盖矩阵（SUBAGENT_STATUS_ALL 每值都有显式占用归属断言）', () => {
  /** 枚举 → 占用归属的显式断言表（决策记录：扩枚举须先评估再补键，缺键即红）。
   *  [U6] 类型收窄后全集 = 两态。 */
  const RUNNING_MATRIX: Record<SubagentStatus, boolean> = {
    running: true, // 唯一「进行中类」值（带停因 running 经 stopReason 子句自然排除，见 P1 矩阵；原「W4 纳管态」措辞随 adoptEngineDeath 写点退役删除，登记见 subagent-bucket.ts isRunningProjection 注释）
    idle: false, // 两态收尾：随时可续聊的空闲，不算在跑
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

  it('[GUI 快修⑤ 派生视图范围] idle record（含 turns/tokens 复活形态）落已结束桶（非 running）——冷重启后统计信号不丢展示位', () => {
    const revived = makeRecord('idle', { stopReason: 'completed', turns: 4, totalTokens: 88000 })
    expect(isRunningProjection(revived)).toBe(false)
  })
})

// ── [P1 ⛔实施期门] 形态 × 判据矩阵全量（two-state-convergence D7，[modeless 波4] 收敛 8 形态）──
//
// 门语义：8 现实形态 × SSOT 谓词本体（isRunningProjection），全矩阵钉住「同 record
// 同答案」。失败处置 = 判据矩阵有形态遗漏，补形态后重跑，禁止放宽断言（D7 门探针
// 降级路径）。形态视角 = renderer 收到的 record（legacy 值已经 runtime 归一层映射）。
// [modeless 波4] 旧 5/6/7 三行按 chatMode 区分的轮终形态（chat / one-shot / legacy
// 缺省）合并退化为单一「轮终完成」形态——字段消亡后三者在 renderer 侧不可区分（亦无需区分）。

describe('[P1 门] 形态 × 判据矩阵全量（8 现实形态，two-state-convergence D7/U6）', () => {
  /** 形态表：现实形态描述 + record 构造 + 占用期望（显式决策记录，缺行即遗漏） */
  const MATRIX: Array<{ name: string; rec: SubagentRecord; occupied: boolean }> = [
    {
      // 形态 1：§2.1 表「真在跑（观察时点）」
      name: '1 真在跑（首轮在途：running + result=∅ + stopReason=∅）',
      rec: makeRecord('running'),
      occupied: true,
    },
    {
      // 形态 2：R4 MF-A 第 2+ 轮在途型（轮始清点扩字段后的应有形态——markRoundStarted
      // 已清上轮 stopReason，record 与首轮在途同形）。若清点失效（stale stopReason
      // 残留）本谓词将误排除——该失效由 subagent-core 轮始清点测试检查，
      // 本行钉住「扩字段后第 2+ 轮在途不误排除」的renderer侧终态。
      name: '2 第 2+ 轮在途（轮始清点后：running + result=∅ + stopReason 已清）',
      rec: makeRecord('running'),
      occupied: true,
    },
    {
      // 形态 3：轮收条已写在途残留（running + error + stopReason='failed' + result=∅）。
      // 「failed」为 legacy 停因值：引擎死亡走正常轮终 error 停因 + 失败事实入账，
      // 无独立死亡纳管写点；stopReason 子句按「轮收条已写 = 本轮不在途」排除。
      name: "3 轮收条已写残留（running + result=∅ + stopReason='failed'）",
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
      // 形态 5：轮终完成（U4 翻边后轮终权威形态；[modeless 波4] 旧 chat/one-shot/
      // legacy 缺省三行随 chatMode 字段消亡合并归一）
      name: '5 轮终完成（idle + result + completed）',
      rec: makeRecord('idle', { result: '(redacted)', stopReason: 'completed' }),
      occupied: false,
    },
    {
      // 形态 6：§3.4 第 5 行 重建孤儿（runtime 第五归一 → idle；result=∅ + stopReason=∅）
      name: '6 重建孤儿归一后（idle + result=∅ + stopReason=∅）',
      rec: makeRecord('idle'),
      occupied: false,
    },
    {
      // 形态 7：§3.4 第 7 行 中断收尾（markSettled idle + interrupted 族）
      name: "7 中断收尾（idle + stopReason='interrupted'）",
      rec: makeRecord('idle', { stopReason: 'interrupted' }),
      occupied: false,
    },
    {
      // 形态 8：W4 旧型经 runtime 第五归一（running+resumable=true → idle，无 stopReason）
      name: '8 W4 旧型经第五归一（idle + result=∅ + stopReason=∅——跨重启孤儿纠偏形态）',
      rec: makeRecord('idle'),
      occupied: false,
    },
  ]

  it('⛔门：全矩阵钉住「同 record 同答案」（8 形态 × isOccupied 判据本体）', () => {
    for (const { name, rec, occupied } of MATRIX) {
      expect(isRunningProjection(rec), name).toBe(occupied)
    }
  })

  it('形态表恰好 8 行（D7 全量清单——[modeless 波4] 10 行随 chatMode 维度合并退化）', () => {
    expect(MATRIX).toHaveLength(8)
  })
})

// ── [P1 ⛔实施期门] session 01a09f83 形态 fixture 回放（two-state-convergence U1/D1/D7）──
//
// 门语义：39 条真实 record 形态按修复后严格口径回放 badge 计数 = 0（D1「幽灵 8→0」）。
// 失败处置 = 判据矩阵有形态遗漏，补形态后重跑，禁止放宽断言（D7 门探针降级路径）。
// [modeless 波4] 历史判据对照断言（旧组合判据回放 = 8）随 chatMode 比对维度消亡删除
// ——旧判据含 `chatMode === false` 子句已不可复刻；幽灵根因面（running + result 桥接
// 形态误计入）已被第五归一 + status 子句结构性消灭，对照使命终止。

describe('[P1 门] 01a09f83 fixture 回放（严格口径 badge 计数 = 0）', () => {
  /** 脱敏形态规格 → 最小合法 SubagentRecord（只注形态字段，无任何正文内容） */
  function recordFromSpec(spec: GhostFixtureSpec): SubagentRecord {
    return makeRecord(spec.status, {
      subagentId: spec.aliasId,
      ...(spec.hasResult ? { result: '(redacted)' } : {}),
      ...(spec.stopReason !== undefined ? { stopReason: spec.stopReason } : {}),
    })
  }

  const fixtureRecords: SubagentRecord[] = SESSION_01A09F83_GHOST_FIXTURE.map(recordFromSpec)

  it('fixture 完整性：39 个 record id（8 幽灵 + 29 one-shot 轮终 + 2 中断收尾，与 §2.1 实测分布一致；[modeless 波4] 幽灵/one-shot 区分退化为 aliasId 前缀）', () => {
    expect(SESSION_01A09F83_GHOST_FIXTURE).toHaveLength(39)
    // 37 条轮终（idle + result 在场）+ 2 条中断收尾（无 result）
    expect(SESSION_01A09F83_GHOST_FIXTURE.filter((s) => s.hasResult)).toHaveLength(37)
    expect(SESSION_01A09F83_GHOST_FIXTURE.filter((s) => s.aliasId.startsWith('ghost-chat-'))).toHaveLength(8)
    expect(SESSION_01A09F83_GHOST_FIXTURE.filter((s) => s.aliasId.startsWith('oneshot-done-'))).toHaveLength(29)
    expect(SESSION_01A09F83_GHOST_FIXTURE.filter((s) => s.aliasId.startsWith('idle-interrupted-'))).toHaveLength(2)
  })

  it('⛔门：修复后严格口径回放「真在跑」集合为空（幽灵 8→0；[两视图裁决 2026-09-16] 后计数口径 = isRunningProjection 过滤）', () => {
    expect(fixtureRecords.filter(isRunningProjection)).toEqual([])
  })
})

// ── [subagent-observability u8] wire 契约字段存在性 + 失败红点判据四形态 ──────────
//
// 门语义（§3.3.3⑤）：红点判据消费的 lastRound 必须在 shared SubagentRecord 契约上——
// 缺登记则判据运行恒 undefined、红点恒绿（「失败显示成功绿」自警示形态）。编译期探针
// 挡 shared 侧删字段/改形状；运行时断言是探针的消费点。红点判据测试的数据全部自 shared
// 类型构造（makeRecord 的 Partial<SubagentRecord> 上下文 + 判别联合检查）——mock 自造
// 字段（拼错键名/词表外 kind）= 编译红，结构性排除「mock 假绿」。

/** 编译期探针①：lastRound 字段在 shared 契约上且形状 ≡ SubagentLastRound（含 undefined 缺省） */
type LastRoundWireProbe = SubagentRecord['lastRound'] extends SubagentLastRound | undefined ? true : false
/** 编译期探针②：failure 字段形状 ≡ FailureCause（sdk 权威、shared type-only re-export） */
type LastRoundFailureWireProbe = NonNullable<SubagentRecord['lastRound']>['failure'] extends FailureCause | undefined ? true : false
/** 探针消费点（导出以通过 noUnusedLocals；值恒 true 无运行期语义——类型才承重） */
const LAST_ROUND_WIRE_CONTRACT: LastRoundWireProbe & LastRoundFailureWireProbe = true

describe('[subagent-observability u8] wire 契约字段存在性（§3.3.3⑤）', () => {
  it('SubagentRecord.lastRound（及 lastRound.failure）在 shared 契约上——探针消费点恒 true', () => {
    expect(LAST_ROUND_WIRE_CONTRACT).toBe(true)
  })
})

describe('failureCauseLabel / failureCauseToneClass（展示判据 SSOT）', () => {
  it('label = class.kind 点拼（与 run 终局 failedMembers[].cause 序列化同形）', () => {
    expect(failureCauseLabel({ class: 'provider', kind: 'rate_limited', retryable: 'conditional', raw: 'x' })).toBe('provider.rate_limited')
    expect(failureCauseLabel({ class: 'engine', kind: 'engine_crash', retryable: false, raw: 'x' })).toBe('engine.engine_crash')
  })

  it('tone：user.cancelled 中性 dim，其余 danger（红点判据同源二分）', () => {
    expect(failureCauseToneClass({ class: 'user', kind: 'cancelled', retryable: false, raw: 'x' })).toBe('text-neutral-dim opacity-70')
    expect(failureCauseToneClass({ class: 'harness', kind: 'turn_budget_exhausted', retryable: false, raw: 'x' })).toBe('text-danger')
    expect(failureCauseToneClass({ class: 'engine', kind: 'engine_crash', retryable: false, raw: 'x' })).toBe('text-danger')
  })
})
