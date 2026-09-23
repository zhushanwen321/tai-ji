/**
 * plan-state entry fixtures — 旧 entry 重放兼容（plan-mode-ux-refactor §3.4 / 验收场景 8）
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
export interface PlanStateJsonlEntry {
  type: 'custom'
  customType: string
  id: string
  parentId: string | null
  timestamp: string
  data: LegacyAwaitingPlanStateData
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
