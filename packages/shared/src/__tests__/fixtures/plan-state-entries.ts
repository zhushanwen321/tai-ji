/**
 * plan-state entry fixtures — 旧 entry → 新 View 派生归一契约（plan 状态机显式化 D2 读方②，
 * U1 冻结）+ 旧格式重放回归锚（plan-mode-audit-remediation V5：旧格式会话重放三侧逐字段一致）。
 *
 * 资产 = 「旧 entry 样本 → 期望新 View」等价对 + 穷举配对表——runtime plan-state-extractor
 * （读方②）与扩展 reconstructPlanState（读方①）两个归一点的实现必须与本契约逐对一致
 * （断言落各自的测试：fixture 定契约、断言在归一点）。映射规则（D2）：旧 entry 无 state 时
 * 映射 reviewState（awaiting→reviewing / revising→revising / 无→planning|idle 按 isActive）；
 * reviewStateSource:'resubmit' → resumeHint:'resubmit'；新 View **不透出旧字段**
 * （reviewState / reviewStateSource）。
 *
 * LEGACY_AWAITING_PLAN_STATE_ENTRY（样本 0）模拟「升级前落盘的含 awaiting reviewState 的
 * session JSONL plan-state entry」：data 字段集 = reviewStateSource 引入前 extension state.ts
 * persistPlanState 的完整写入面（含 templateProvidedPath / lastSubmitReviewDocsFingerprint
 * 两个 extension 域私有字段——runtime extractor 不透传它们，但升级前真实落盘形态含），
 * 且**无 reviewStateSource 键**（该字段升级前不存在）。entry 外层形态照 runtime 既有
 * plan-state-extractor.test.ts 的 planStateEntry helper（type/customType/id/parentId/
 * timestamp + data）。
 *
 * 消费面：
 *  - plan-protocol.test.ts：样本 0 保真断言（旧 entry 形态锁 = 旧格式重放回归锚）
 *  - renderer 混装格降级分支消费已随 plan-mode-audit-remediation 批次 3 条目 1 删除
 *    （renderer 不再消费旧字段——映射只存在于 entry 读取侧归一点）
 *
 * 编译期守卫：LegacyPlanStateData / 各 EXPECTED_VIEW 字面量若被追加新代字段（state /
 * resumeHint / selfReview），「旧 schema 快照不携带新字段」与「新派生 View 不透出旧字段」
 * 断言即红——fixture 漂移（旧 fixture 静默长出新字段，兼容断言退化为恒真）机器拦截。
 */
import type { PlanStateView } from '../../protocol'

/** JSONL custom entry 外层形态（pi SessionEntry custom entry 的磁盘反序列化形状）。 */
export interface PlanStateJsonlEntry<D extends object = LegacyPlanStateData> {
  type: 'custom'
  customType: string
  id: string
  parentId: string | null
  timestamp: string
  data: D
}

/**
 * 状态机显式化前的 entry data schema 快照（reviewState/reviewStateSource 已停写的历史字段，
 * 仅作旧 entry 映射输入）。本次新增字段（state / resumeHint / selfReview）键集封闭禁入
 * （下方编译期守卫拦截）。
 */
export interface LegacyPlanStateData {
  isActive: boolean
  planFilePath: string
  requirement: string
  templateName: string
  templateProvidedPath?: string
  skills?: string[]
  docs?: Array<{ fileName: string; absPath: string; sourceSkill: string; version: number }>
  reviewState?: 'awaiting' | 'revising'
  reviewStateSource?: 'resubmit'
  lastSubmitReviewDocsFingerprint?: string
}

type _Assert_LegacyData_no_state = AssertLacksKey<LegacyPlanStateData, 'state'>
type _Assert_LegacyData_no_resumeHint = AssertLacksKey<LegacyPlanStateData, 'resumeHint'>
type _Assert_LegacyData_no_selfReview = AssertLacksKey<LegacyPlanStateData, 'selfReview'>
const _enforceTrue = <T extends true>(_v?: T): true => true
const _legacyDataGuardsEnforced = [
  _enforceTrue<_Assert_LegacyData_no_state>(),
  _enforceTrue<_Assert_LegacyData_no_resumeHint>(),
  _enforceTrue<_Assert_LegacyData_no_selfReview>(),
]
void _legacyDataGuardsEnforced

// 样本 0：awaiting 审阅态 + 无 reviewStateSource（升级前真实落盘完整形态——旧格式重放回归锚）
export const LEGACY_AWAITING_PLAN_STATE_ENTRY: PlanStateJsonlEntry = {
  type: 'custom',
  customType: 'plan-state',
  id: 'e-legacy-awaiting-1',
  parentId: null,
  timestamp: '2026-09-20T00:00:00Z',
  data: {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    templateProvidedPath: '/templates/tech-design.md',
    skills: ['tech-design'],
    docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 2 }],
    reviewState: 'awaiting',
    lastSubmitReviewDocsFingerprint: 'plan.md:2',
  },
}

// 样本 ①：reviewState=revising（修订中，E3 恢复文案分叉依赖态）
export const LEGACY_REVISING_PLAN_STATE_ENTRY: PlanStateJsonlEntry = {
  type: 'custom',
  customType: 'plan-state',
  id: 'e-legacy-revising-1',
  parentId: null,
  timestamp: '2026-09-20T00:01:00Z',
  data: {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    skills: ['tech-design'],
    docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 3 }],
    reviewState: 'revising',
    lastSubmitReviewDocsFingerprint: 'plan.md:2',
  },
}

// 样本 ②：awaiting + reviewStateSource='resubmit'（会话重启待重提交降级态）
export const LEGACY_RESUBMIT_PLAN_STATE_ENTRY: PlanStateJsonlEntry = {
  type: 'custom',
  customType: 'plan-state',
  id: 'e-legacy-resubmit-1',
  parentId: null,
  timestamp: '2026-09-20T00:02:00Z',
  data: {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 2 }],
    reviewState: 'awaiting',
    reviewStateSource: 'resubmit',
  },
}

// 样本 ③：激活无审阅态（进行中）
export const LEGACY_ACTIVE_NO_REVIEW_PLAN_STATE_ENTRY: PlanStateJsonlEntry = {
  type: 'custom',
  customType: 'plan-state',
  id: 'e-legacy-active-1',
  parentId: null,
  timestamp: '2026-09-20T00:03:00Z',
  data: {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 1 }],
  },
}

// 样本 ④：非激活且无审阅态（idle 缺省）
export const LEGACY_INACTIVE_PLAN_STATE_ENTRY: PlanStateJsonlEntry = {
  type: 'custom',
  customType: 'plan-state',
  id: 'e-legacy-inactive-1',
  parentId: null,
  timestamp: '2026-09-20T00:04:00Z',
  data: {
    isActive: false,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
  },
}

// ── 期望新 View（D2 读方② 归一产物：恒携带 state、旧字段不透出、resumeHint 映射自 reviewStateSource）──

/** 编译期守卫：新派生 View 永不透出旧字段（fixture 漂移 = 兼容断言退化恒真，机器拦截）。 */
type AssertLacksKey<T, K extends string> = K extends keyof T
  ? ['ERROR: legacy fixture schema must not carry the new field', K]
  : true
type AssertLacksKeys<T, K extends string> = K extends keyof T
  ? ['ERROR: derived view must not carry the legacy field', K]
  : true

/** awaiting → reviewing（样本 0 的期望归一产物） */
export const LEGACY_AWAITING_PLAN_STATE_EXPECTED_VIEW = {
  isActive: true,
  planFilePath: '/tmp/taiji-plan/auth/plan.md',
  requirement: '重构 auth 模块',
  templateName: 'tech-design',
  skills: ['tech-design'],
  docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 2 }],
  state: 'reviewing',
} satisfies PlanStateView

/** revising → revising（样本 ①） */
export const LEGACY_REVISING_PLAN_STATE_EXPECTED_VIEW = {
  isActive: true,
  planFilePath: '/tmp/taiji-plan/auth/plan.md',
  requirement: '重构 auth 模块',
  templateName: 'tech-design',
  skills: ['tech-design'],
  docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 3 }],
  state: 'revising',
} satisfies PlanStateView

/** awaiting + resubmit → reviewing + resumeHint:'resubmit'（样本 ②） */
export const LEGACY_RESUBMIT_PLAN_STATE_EXPECTED_VIEW = {
  isActive: true,
  planFilePath: '/tmp/taiji-plan/auth/plan.md',
  requirement: '重构 auth 模块',
  templateName: 'tech-design',
  docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 2 }],
  state: 'reviewing',
  resumeHint: 'resubmit',
} satisfies PlanStateView

/** 无 reviewState 且激活 → planning（样本 ③） */
export const LEGACY_ACTIVE_NO_REVIEW_PLAN_STATE_EXPECTED_VIEW = {
  isActive: true,
  planFilePath: '/tmp/taiji-plan/auth/plan.md',
  requirement: '重构 auth 模块',
  templateName: 'tech-design',
  docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 1 }],
  state: 'planning',
} satisfies PlanStateView

/** 无 reviewState 且非激活 → idle（样本 ④） */
export const LEGACY_INACTIVE_PLAN_STATE_EXPECTED_VIEW = {
  isActive: false,
  planFilePath: '/tmp/taiji-plan/auth/plan.md',
  requirement: '重构 auth 模块',
  templateName: 'tech-design',
  state: 'idle',
} satisfies PlanStateView

// 新派生 View 恒不透出旧字段（reviewState / reviewStateSource）——字面量追加旧键即编译红
type _Assert_AwaitingDerived_no_legacy = AssertLacksKeys<typeof LEGACY_AWAITING_PLAN_STATE_EXPECTED_VIEW, 'reviewState' | 'reviewStateSource'>
type _Assert_RevisingDerived_no_legacy = AssertLacksKeys<typeof LEGACY_REVISING_PLAN_STATE_EXPECTED_VIEW, 'reviewState' | 'reviewStateSource'>
type _Assert_ResubmitDerived_no_legacy = AssertLacksKeys<typeof LEGACY_RESUBMIT_PLAN_STATE_EXPECTED_VIEW, 'reviewState' | 'reviewStateSource'>
type _Assert_ActiveDerived_no_legacy = AssertLacksKeys<typeof LEGACY_ACTIVE_NO_REVIEW_PLAN_STATE_EXPECTED_VIEW, 'reviewState' | 'reviewStateSource'>
type _Assert_InactiveDerived_no_legacy = AssertLacksKeys<typeof LEGACY_INACTIVE_PLAN_STATE_EXPECTED_VIEW, 'reviewState' | 'reviewStateSource'>
const _derivedViewGuardsEnforced = [
  _enforceTrue<_Assert_AwaitingDerived_no_legacy>(),
  _enforceTrue<_Assert_RevisingDerived_no_legacy>(),
  _enforceTrue<_Assert_ResubmitDerived_no_legacy>(),
  _enforceTrue<_Assert_ActiveDerived_no_legacy>(),
  _enforceTrue<_Assert_InactiveDerived_no_legacy>(),
]
void _derivedViewGuardsEnforced

/**
 * 等价对穷举表（归一点契约测试的单一驱动源）：逐对断言「旧 entry → 派生 ≡ expectedView」
 * ——runtime plan-state-extractor 测试（U3b）与扩展 reconstructPlanState 测试（U2）均按本表
 * 驱动，两归一点同构由同一契约表锁死。
 */
export const LEGACY_ENTRY_VIEW_EQUIVALENCE_PAIRS: Array<{
  entry: PlanStateJsonlEntry
  expectedView: PlanStateView
}> = [
  { entry: LEGACY_AWAITING_PLAN_STATE_ENTRY, expectedView: LEGACY_AWAITING_PLAN_STATE_EXPECTED_VIEW },
  { entry: LEGACY_REVISING_PLAN_STATE_ENTRY, expectedView: LEGACY_REVISING_PLAN_STATE_EXPECTED_VIEW },
  { entry: LEGACY_RESUBMIT_PLAN_STATE_ENTRY, expectedView: LEGACY_RESUBMIT_PLAN_STATE_EXPECTED_VIEW },
  { entry: LEGACY_ACTIVE_NO_REVIEW_PLAN_STATE_ENTRY, expectedView: LEGACY_ACTIVE_NO_REVIEW_PLAN_STATE_EXPECTED_VIEW },
  { entry: LEGACY_INACTIVE_PLAN_STATE_ENTRY, expectedView: LEGACY_INACTIVE_PLAN_STATE_EXPECTED_VIEW },
]
