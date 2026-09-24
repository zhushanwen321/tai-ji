/**
 * plan-state entry fixtures — 旧 entry 重放兼容（plan-mode-ux-refactor §3.4 / 验收场景 8）
 * + 旧 entry → 新 View 派生归一契约（plan 状态机显式化 D2 读方②，U1 冻结）。
 *
 * 两组资产：
 * 1. 旧 entry 重放兼容（上半）：升级前落盘形态的字面快照 + 旧 View 线上形态，供
 *    plan-protocol.test.ts（兼容契约）与 renderer 降级分支测试消费（导出形状稳定，禁改）。
 * 2. 派生归一契约（下半，U1/D2）：5 组「旧 entry 样本 → 期望新 View」等价对 + 穷举配对表
 *    ——runtime plan-state-extractor（读方②）与扩展 reconstructPlanState（读方①）两个归一点
 *    的实现必须与本契约逐对一致（断言落各自的测试：fixture 定契约、断言在归一点）。
 *    映射规则（D2）：旧 entry 无 state 时映射 reviewState（awaiting→reviewing /
 *    revising→revising / 无→planning|idle 按 isActive）；reviewStateSource:'resubmit' →
 *    resumeHint:'resubmit'；新 View **不透出旧字段**（reviewState / reviewStateSource）。
 *
 * LEGACY_AWAITING_PLAN_STATE_ENTRY 模拟「升级前落盘的含 awaiting reviewState 的 session
 * JSONL plan-state entry」：data 字段集 = reviewStateSource 引入前 extension state.ts
 * persistPlanState 的完整写入面（含 templateProvidedPath / lastSubmitReviewDocsFingerprint
 * 两个 extension 域私有字段——runtime extractor 不透传它们，但升级前真实落盘形态含），
 * 且**无 reviewStateSource 键**（该字段升级前不存在）。entry 外层形态照 runtime 既有
 * plan-state-extractor.test.ts 的 planStateEntry helper（type/customType/id/parentId/
 * timestamp + data）。
 *
 * 消费面：
 *  - plan-protocol.test.ts：旧 entry 无新字段兼容断言（View 消费方惰性）
 *  - renderer 降级三分支测试（plan-mode-ux-refactor U4b）：LEGACY_AWAITING_PLAN_STATE_VIEW
 *    为「通用降级文案」分支的输入形态（缺省 = 来源未知，渲染通用文案，不猜测来源）
 *
 * 编译期守卫：LegacyAwaitingPlanStateData / VIEW 字面量若被追加 reviewStateSource 键，
 * 「旧 schema 快照不携带新字段」断言即红——fixture 漂移（旧 fixture 静默长出新字段，
 * 兼容断言退化为恒真）机器拦截。
 */
import type { PlanStateView } from '../../protocol'

/** JSONL custom entry 外层形态（pi SessionEntry custom entry 的磁盘反序列化形状）。 */
export interface PlanStateJsonlEntry<D extends object = LegacyAwaitingPlanStateData> {
  type: 'custom'
  customType: string
  id: string
  parentId: string | null
  timestamp: string
  data: D
}

/**
 * 升级前 entry data schema 快照（persistPlanState 引入 reviewStateSource 前的写入面）。
 * 键集封闭：新增字段禁入本接口（会触发下方编译期守卫红）——本接口是「旧 schema」的
 * 字面快照，不是活契约。
 */
export interface LegacyAwaitingPlanStateData {
  isActive: boolean
  planFilePath: string
  requirement: string
  templateName: string
  templateProvidedPath?: string
  skills?: string[]
  docs?: Array<{ fileName: string; absPath: string; sourceSkill: string; version: number }>
  reviewState?: 'awaiting' | 'revising'
  lastSubmitReviewDocsFingerprint?: string
}

// ── 编译期守卫：旧 schema 快照永不携带新字段 ──

type AssertLacksKey<T, K extends string> = K extends keyof T
  ? ['ERROR: legacy fixture schema must not carry the new field', K]
  : true
type _Assert_LegacyData_no_reviewStateSource = AssertLacksKey<LegacyAwaitingPlanStateData, 'reviewStateSource'>
const _enforceTrue = <T extends true>(_v?: T): true => true
const _legacyFixtureGuardsEnforced = [_enforceTrue<_Assert_LegacyData_no_reviewStateSource>()]
void _legacyFixtureGuardsEnforced

/** 旧 entry 重放 fixture：awaiting 审阅态 + 无 reviewStateSource（升级前真实落盘形态）。 */
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

/**
 * 上 entry 经 runtime 守卫透传语义派生的 View 投影（renderer 消费面便捷形态）。
 * satisfies 保留字面量窄类型（无 reviewStateSource 键 =「旧 entry 派生出无新字段区」
 * 的字面语义，runtime extractor 对缺失 optional 不设键）。
 */
export const LEGACY_AWAITING_PLAN_STATE_VIEW = {
  isActive: true,
  planFilePath: '/tmp/taiji-plan/auth/plan.md',
  requirement: '重构 auth 模块',
  templateName: 'tech-design',
  skills: ['tech-design'],
  docs: [{ fileName: 'plan.md', absPath: '/tmp/taiji-plan/auth/plan.md', sourceSkill: 'tech-design', version: 2 }],
  reviewState: 'awaiting',
} satisfies PlanStateView

type _Assert_LegacyView_no_reviewStateSource = AssertLacksKey<typeof LEGACY_AWAITING_PLAN_STATE_VIEW, 'reviewStateSource'>
const _legacyViewGuardsEnforced = [_enforceTrue<_Assert_LegacyView_no_reviewStateSource>()]
void _legacyViewGuardsEnforced

// ── 派生归一契约（plan 状态机显式化 D2，U1 冻结）：旧 entry → 新 View 等价对 ──

/**
 * 状态机显式化前的 entry data schema 快照（含 reviewStateSource 世代，比上方快照多一代）。
 * 本次新增字段（state / resumeHint / selfReview）键集封闭禁入（下方编译期守卫拦截）。
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
const _legacyDataGuardsEnforced = [
  _enforceTrue<_Assert_LegacyData_no_state>(),
  _enforceTrue<_Assert_LegacyData_no_resumeHint>(),
  _enforceTrue<_Assert_LegacyData_no_selfReview>(),
]
void _legacyDataGuardsEnforced

// 样本 ①：reviewState=revising（修订中，E3 恢复文案分叉依赖态）
export const LEGACY_REVISING_PLAN_STATE_ENTRY: PlanStateJsonlEntry<LegacyPlanStateData> = {
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
export const LEGACY_RESUBMIT_PLAN_STATE_ENTRY: PlanStateJsonlEntry<LegacyPlanStateData> = {
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
export const LEGACY_ACTIVE_NO_REVIEW_PLAN_STATE_ENTRY: PlanStateJsonlEntry<LegacyPlanStateData> = {
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
export const LEGACY_INACTIVE_PLAN_STATE_ENTRY: PlanStateJsonlEntry<LegacyPlanStateData> = {
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
type AssertLacksKeys<T, K extends string> = K extends keyof T
  ? ['ERROR: derived view must not carry the legacy field', K]
  : true

/** awaiting → reviewing（样本 0，上半 LEGACY_AWAITING_PLAN_STATE_ENTRY 的期望归一产物） */
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
  entry: PlanStateJsonlEntry<LegacyPlanStateData>
  expectedView: PlanStateView
}> = [
  { entry: LEGACY_AWAITING_PLAN_STATE_ENTRY, expectedView: LEGACY_AWAITING_PLAN_STATE_EXPECTED_VIEW },
  { entry: LEGACY_REVISING_PLAN_STATE_ENTRY, expectedView: LEGACY_REVISING_PLAN_STATE_EXPECTED_VIEW },
  { entry: LEGACY_RESUBMIT_PLAN_STATE_ENTRY, expectedView: LEGACY_RESUBMIT_PLAN_STATE_EXPECTED_VIEW },
  { entry: LEGACY_ACTIVE_NO_REVIEW_PLAN_STATE_ENTRY, expectedView: LEGACY_ACTIVE_NO_REVIEW_PLAN_STATE_EXPECTED_VIEW },
  { entry: LEGACY_INACTIVE_PLAN_STATE_ENTRY, expectedView: LEGACY_INACTIVE_PLAN_STATE_EXPECTED_VIEW },
]
