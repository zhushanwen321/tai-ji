/**
 * state-machine.test.ts — plan 生命周期状态机全边表契约测试（D1；M4 迁移后形态）。
 *
 * 覆盖义务（U1 验收② + V5）：
 * - 机器表级组合穷举：generateTableTests 一行承载 8 状态 × 9 事件 = 72 格断言
 *   （合法 19 边次态 / 非法 53 格表外拒绝——机器层 `errorPolicy:'result'` 形态）。
 * - 对外 `transition` 的行为级断言（D5 保留口径——生成器只覆盖表级组合，非纯表
 *   判定留域内）：D1 关键边命名锚定逐边硬编码期望（19 边全部有设计意图级快照，
 *   与生成器的「实现 ≡ 声明」对账互补成「声明 ≡ 设计意图」）。
 * - derivePhase 8 存储态 → 5 呈现相位全映射 + 混装格垃圾值降级。
 * - 边界：垃圾键全输入域不 throw、不产出伪转移（「不 throw 炸 turn」契约）——含原型链
 *   继承键双轴用例（event 轴 __proto__/valueOf/toString/constructor × state 轴
 *   __proto__/constructor/toString），裸查表会沿原型链产出 Object.prototype/函数伪 next。
 */
import { describe, it, expect } from 'vitest'
import { generateTableTests } from '@zhushanwen/state-machine/testing'
import {
  PLAN_LIFECYCLE_STATES,
  PLAN_LIFECYCLE_EVENTS,
  PLAN_MACHINE,
  transition,
  derivePhase,
} from './state-machine'
import type { PlanLifecycleEvent, PlanLifecycleState, PlanPhase } from './state-machine'

// 机器表级组合穷举（D5 生成器，顶层调用注册 describe/it）
const tableCases = generateTableTests(PLAN_MACHINE)

describe('M4 机器声明与穷举骨架（72 格生成器 + 词表对账）', () => {
  it('穷举基座自检：状态 8 值 / 事件 9 值，展开 72 格，合法 19 边（活跃族五态 exit + reviewing submit 自环）/ 非法 53 格', () => {
    expect(PLAN_LIFECYCLE_STATES).toHaveLength(8)
    expect(PLAN_LIFECYCLE_EVENTS).toHaveLength(9)
    expect(new Set(PLAN_LIFECYCLE_STATES).size).toBe(8)
    expect(new Set(PLAN_LIFECYCLE_EVENTS).size).toBe(9)
    expect(tableCases).toHaveLength(72)
    expect(tableCases.filter((c) => c.expectation === 'transition')).toHaveLength(19)
    expect(tableCases.filter((c) => c.expectation === 'rejected')).toHaveLength(53)
  })

  it('机器词表与导出词表对账（states/events/terminal 集——双词表漂移即红）', () => {
    expect([...PLAN_MACHINE.states].sort()).toEqual([...PLAN_LIFECYCLE_STATES].sort())
    expect([...PLAN_MACHINE.events].sort()).toEqual([...PLAN_LIFECYCLE_EVENTS].sort())
    expect(PLAN_MACHINE.terminalStates).toEqual(['completed', 'exited'])
    expect(PLAN_MACHINE.definition.errorPolicy).toBe('result')
  })
})

describe('D1 关键边命名锚定（设计原文语义，19 边设计意图级快照）', () => {
  it('idle --enter--> planning / planning --submit--> reviewing / reviewing --revise--> revising：进入与主链前三边', () => {
    expect(transition('idle', 'enter')).toEqual({ ok: true, next: 'planning' })
    expect(transition('planning', 'submit')).toEqual({ ok: true, next: 'reviewing' })
    expect(transition('reviewing', 'revise')).toEqual({ ok: true, next: 'revising' })
  })

  it('reviewing --dismiss--> planning：搁置是非破坏决策边，落盘即 planning（F1/F2/F3 构造性消除）', () => {
    expect(transition('reviewing', 'dismiss')).toEqual({ ok: true, next: 'planning' })
  })

  it('reviewing --approve--> dispatching：确认执行进执行方式选择（D5，不再提前清状态）', () => {
    expect(transition('reviewing', 'approve')).toEqual({ ok: true, next: 'dispatching' })
  })

  it('reviewing --review_aborted--> planning：挂起期外部解散走显式边（D3 连带）', () => {
    expect(transition('reviewing', 'review_aborted')).toEqual({ ok: true, next: 'planning' })
  })

  it('dispatching --review_aborted--> approved：无选择解散统一落 approved，批准事实保留（F5 不复活）', () => {
    expect(transition('dispatching', 'review_aborted')).toEqual({ ok: true, next: 'approved' })
  })

  it('dispatching --later--> approved 与 --exec_chosen--> completed：显式选择与派发两出口分离（A9 反向）', () => {
    expect(transition('dispatching', 'later')).toEqual({ ok: true, next: 'approved' })
    expect(transition('dispatching', 'exec_chosen')).toEqual({ ok: true, next: 'completed' })
  })

  it('approved --approve--> dispatching：批准后重调 complete 重新选择执行方式（事件命名裁决见模块头）', () => {
    expect(transition('approved', 'approve')).toEqual({ ok: true, next: 'dispatching' })
  })

  it('活跃族非终态 --exit--> exited，idle/终态上 exit 非法、终态 --enter--> planning 开新一轮', () => {
    const nonTerminal: PlanLifecycleState[] = ['planning', 'reviewing', 'revising', 'approved', 'dispatching']
    for (const state of nonTerminal) {
      expect(transition(state, 'exit')).toEqual({ ok: true, next: 'exited' })
    }
    // idle 从未进入 plan，exit 非法（D-B1-8 删边：防从未进 plan 的会话落噪音 exited entry）
    expect(transition('idle', 'exit')).toEqual({ ok: false })
    for (const terminal of ['completed', 'exited'] as const) {
      expect(transition(terminal, 'exit')).toEqual({ ok: false })
      expect(transition(terminal, 'enter')).toEqual({ ok: true, next: 'planning' })
    }
  })

  it('reviewing --submit--> reviewing：审批重挂自环，不推进生命周期（E3 恢复 / D8 重提交）', () => {
    expect(transition('reviewing', 'submit')).toEqual({ ok: true, next: 'reviewing' })
  })

  it('revising 保留独立态：--submit--> reviewing 重挂循环，review_aborted/dismiss 不适用（P-7）', () => {
    expect(transition('revising', 'submit')).toEqual({ ok: true, next: 'reviewing' })
    expect(transition('revising', 'review_aborted')).toEqual({ ok: false })
    expect(transition('revising', 'dismiss')).toEqual({ ok: false })
  })
})

describe('derivePhase 呈现映射（8 存储态 → 5 呈现相位）', () => {
  const cases: Array<[PlanLifecycleState, PlanPhase]> = [
    ['idle', 'idle'],
    ['planning', 'planning'],
    ['reviewing', 'reviewing'],
    ['revising', 'planning'],
    ['approved', 'approved'],
    ['dispatching', 'approved'],
    ['completed', 'terminal'],
    ['exited', 'terminal'],
  ]

  it.each(cases)('%s → %s', (state, phase) => {
    expect(derivePhase(state)).toBe(phase)
  })

  it('终态两值同映 terminal（completed/exited 呈现层不新造消费方，D1）', () => {
    expect(derivePhase('completed')).toBe(derivePhase('exited'))
  })

  it('混装格垃圾 state 降级 idle（无 plan 缺省，不误示进行中）——含原型链继承键', () => {
    // constructor/toString/valueOf 曾穿透裸查表返回 Object 构造函数等（非 nullish 绕过 ?? 兜底）——
    // 机器 coerceState 归化后垃圾 state 全输入域精确落 'idle'，函数/对象不得作为相位流出
    for (const state of ['bogus', '__proto__', 'constructor', 'toString', 'valueOf'] as const) {
      expect(derivePhase(state as unknown as PlanLifecycleState)).toBe('idle')
    }
    expect(derivePhase(undefined as unknown as PlanLifecycleState)).toBe('idle')
    expect(derivePhase(null as unknown as PlanLifecycleState)).toBe('idle')
  })
})

describe('边界：垃圾键全输入域不 throw、不产出伪转移（不炸 turn 契约 + 原型链防御）', () => {
  it('垃圾 state（非继承键形态）→ { ok: false }', () => {
    expect(transition('bogus' as unknown as PlanLifecycleState, 'dismiss')).toEqual({ ok: false })
    expect(transition(undefined as unknown as PlanLifecycleState, 'dismiss')).toEqual({ ok: false })
    expect(transition(null as unknown as PlanLifecycleState, 'exit')).toEqual({ ok: false })
  })

  it('垃圾 event（非继承键形态）→ { ok: false }', () => {
    expect(transition('reviewing', 'bogus' as unknown as PlanLifecycleEvent)).toEqual({ ok: false })
  })

  it('event 轴原型链继承键（__proto__/valueOf/toString/constructor）→ { ok: false }——裸查表曾产出 Object.prototype/函数伪 next', () => {
    // 宣称域修正：旧用例只跑了 '__proto__'+enter / 'constructor'+enter（继承键撞不上 enter
    // 才碰巧 ok:false），并未验证 event 轴继承键——本组把 event 轴原型成员名全列断言
    for (const event of ['__proto__', 'valueOf', 'toString', 'constructor'] as const) {
      expect(transition('reviewing', event as unknown as PlanLifecycleEvent)).toEqual({ ok: false })
    }
  })

  it('state 轴原型链继承键（__proto__/constructor/toString）× 含继承成员名事件 → 全部 { ok: false }', () => {
    for (const state of ['__proto__', 'constructor', 'toString'] as const) {
      for (const event of ['enter', 'valueOf', 'constructor', '__proto__'] as const) {
        expect(transition(state as unknown as PlanLifecycleState, event as unknown as PlanLifecycleEvent)).toEqual({
          ok: false,
        })
      }
    }
  })

  it('双垃圾轴（含 __proto__ × valueOf——曾返回 { ok: true, next: 函数 }）→ { ok: false }', () => {
    expect(
      transition('__proto__' as unknown as PlanLifecycleState, 'valueOf' as unknown as PlanLifecycleEvent),
    ).toEqual({ ok: false })
    expect(
      transition(undefined as unknown as PlanLifecycleState, undefined as unknown as PlanLifecycleEvent),
    ).toEqual({ ok: false })
  })

  it('ok:false 结果不携带 next 键（调用方降级、不落盘——形态结构保证）', () => {
    const rejected = transition('idle', 'exit')
    expect(rejected).toEqual({ ok: false })
    expect('next' in rejected).toBe(false)
  })
})
