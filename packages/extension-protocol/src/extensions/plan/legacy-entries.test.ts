/**
 * legacy-entries.test.ts — plan-state entry legacy 映射行为测试（D-B4-1 下沉后映射契约
 * 唯一断言面）。
 *
 * 承接原 shared fixture 等价表（LEGACY_ENTRY_VIEW_EQUIVALENCE_PAIRS，5 对等价契约，随下沉
 * 删除）的契约义务：读方①（扩展 reconstructPlanState）/ 读方②（runtime extractor）共用的
 * 映射规则在此逐分支锁定——
 * - 新字段直读（八值白名单穷举，合法值原样透传）；
 * - 旧字段映射（awaiting→reviewing / revising→revising / 无→planning|idle 按 isActive）；
 * - 垃圾值防御（非法 state / 非法 reviewState / 非法 resumeHint 不进映射结果）；
 * - PLAN_STATE_CUSTOM_TYPE 字面量冻结锚（磁盘形态，改即历史会话失联）。
 */
import { describe, it, expect } from 'vitest'
import { PLAN_LIFECYCLE_STATES } from './state-machine'
import { PLAN_STATE_CUSTOM_TYPE, readLifecycleState, readResumeHint } from './legacy-entries'

describe('PLAN_STATE_CUSTOM_TYPE 字面量冻结锚', () => {
  it("恒为 'plan-state'（扩展写侧落盘与 runtime 投影链共用判别键，改即历史会话失联）", () => {
    expect(PLAN_STATE_CUSTOM_TYPE).toBe('plan-state')
  })
})

describe('readLifecycleState：新字段直读', () => {
  it('八值白名单逐值原样透传（合法 state 不走映射）', () => {
    for (const state of PLAN_LIFECYCLE_STATES) {
      expect(readLifecycleState({ state }, true)).toBe(state)
      expect(readLifecycleState({ state }, false)).toBe(state)
    }
  })
})

describe('readLifecycleState：旧 entry 映射（原 5 对等价契约的映射分支）', () => {
  it("reviewState 'awaiting' → reviewing（等价对样本 0/② 的映射腿）", () => {
    expect(readLifecycleState({ reviewState: 'awaiting' }, true)).toBe('reviewing')
    expect(readLifecycleState({ reviewState: 'awaiting' }, false)).toBe('reviewing')
  })

  it("reviewState 'revising' → revising（等价对样本 ① 的映射腿）", () => {
    expect(readLifecycleState({ reviewState: 'revising' }, true)).toBe('revising')
  })

  it('无 state 无 reviewState：isActive 兜底 planning | idle（等价对样本 ③/④）', () => {
    expect(readLifecycleState({}, true)).toBe('planning')
    expect(readLifecycleState({}, false)).toBe('idle')
  })

  it("reviewState 词表外的存量值（'approved'）不走映射，落 isActive 兜底", () => {
    expect(readLifecycleState({ reviewState: 'approved' }, true)).toBe('planning')
    expect(readLifecycleState({ reviewState: 'approved' }, false)).toBe('idle')
  })
})

describe('readLifecycleState：垃圾 state 防御（不信任外部写入）', () => {
  it('白名单外 state 值按缺失处理，走 reviewState 映射 / isActive 兜底', () => {
    expect(readLifecycleState({ state: 'bogus', reviewState: 'revising' }, true)).toBe('revising')
    expect(readLifecycleState({ state: 42 }, true)).toBe('planning')
    expect(readLifecycleState({ state: null }, false)).toBe('idle')
  })
})

describe('readResumeHint', () => {
  it("新字段直读：'resubmit' 原样返回", () => {
    expect(readResumeHint({ resumeHint: 'resubmit' })).toBe('resubmit')
  })

  it("旧字段同义映射：reviewStateSource 'resubmit' → 'resubmit'", () => {
    expect(readResumeHint({ reviewStateSource: 'resubmit' })).toBe('resubmit')
  })

  it("'explain' 等存量值归无值（explain 交互已删）", () => {
    expect(readResumeHint({ reviewStateSource: 'explain' })).toBeUndefined()
  })

  it('两键全缺 / 双垃圾归 undefined', () => {
    expect(readResumeHint({})).toBeUndefined()
    expect(readResumeHint({ resumeHint: 'bogus', reviewStateSource: 'bogus' })).toBeUndefined()
  })

  it("resumeHint 垃圾值不挡 reviewStateSource 映射（与原两份拷贝逐字同构的次序锁定）", () => {
    expect(readResumeHint({ resumeHint: 'bogus', reviewStateSource: 'resubmit' })).toBe('resubmit')
  })
})
