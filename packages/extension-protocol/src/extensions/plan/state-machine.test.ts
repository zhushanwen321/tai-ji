/**
 * state-machine.test.ts — plan 生命周期状态机全边表契约测试（D1）。
 *
 * 覆盖义务（U1 验收②）：
 * - transition 全边表穷举：8 状态 × 9 事件 = 72 格逐格断言（合法 19 边 / 非法 53 格），
 *   无效转移返回 `{ ok: false }` 且不携带 next 键（调用方降级语义的结构保证）。
 * - D1 关键边命名锚定（dismiss / review_aborted 双出口 / later / exec_chosen / 终态规则）。
 * - derivePhase 8 存储态 → 5 呈现相位全映射 + 混装格垃圾值降级。
 * - 边界：垃圾键全输入域不 throw、不产出伪转移（「不 throw 炸 turn」契约）——含原型链
 *   继承键双轴用例（event 轴 __proto__/valueOf/toString/constructor × state 轴
 *   __proto__/constructor/toString），旧版裸查表会沿原型链产出 Object.prototype/函数伪 next。
 */
import { describe, it, expect } from 'vitest'
import {
  PLAN_LIFECYCLE_STATES,
  PLAN_LIFECYCLE_EVENTS,
  transition,
  derivePhase,
} from './state-machine'
import type { PlanLifecycleEvent, PlanLifecycleState, PlanPhase } from './state-machine'

/**
 * 全边表期望值（与 state-machine.ts TRANSITION_TABLE 双立的独立快照——测试不 import 被测
 * 内部表，改表必须同步改这里，漂移即红）。null = 非法转移。
 */
const EXPECTED_EDGES: Record<PlanLifecycleState, Record<PlanLifecycleEvent, PlanLifecycleState | null>> = {
  idle: {
    enter: 'planning',
    submit: null,
    revise: null,
    dismiss: null,
    review_aborted: null,
    approve: null,
    exec_chosen: null,
    later: null,
    exit: 'exited',
  },
  planning: {
    enter: null,
    submit: 'reviewing',
    revise: null,
    dismiss: null,
    review_aborted: null,
    approve: null,
    exec_chosen: null,
    later: null,
    exit: 'exited',
  },
  reviewing: {
    enter: null,
    submit: null,
    revise: 'revising',
    dismiss: 'planning',
    review_aborted: 'planning',
    approve: 'dispatching',
    exec_chosen: null,
    later: null,
    exit: 'exited',
  },
  revising: {
    enter: null,
    submit: 'reviewing',
    revise: null,
    dismiss: null,
    review_aborted: null,
    approve: null,
    exec_chosen: null,
    later: null,
    exit: 'exited',
  },
  approved: {
    enter: null,
    submit: null,
    revise: null,
    dismiss: null,
    review_aborted: null,
    approve: 'dispatching',
    exec_chosen: null,
    later: null,
    exit: 'exited',
  },
  dispatching: {
    enter: null,
    submit: null,
    revise: null,
    dismiss: null,
    review_aborted: 'approved',
    approve: null,
    exec_chosen: 'completed',
    later: 'approved',
    exit: 'exited',
  },
  completed: {
    enter: 'planning',
    submit: null,
    revise: null,
    dismiss: null,
    review_aborted: null,
    approve: null,
    exec_chosen: null,
    later: null,
    exit: null,
  },
  exited: {
    enter: 'planning',
    submit: null,
    revise: null,
    dismiss: null,
    review_aborted: null,
    approve: null,
    exec_chosen: null,
    later: null,
    exit: null,
  },
}

// 72 格展开（it.each 逐格命名，穷举可视）
const ALL_CELLS: Array<[PlanLifecycleState, PlanLifecycleEvent, PlanLifecycleState | null]> = []
for (const state of PLAN_LIFECYCLE_STATES) {
  for (const event of PLAN_LIFECYCLE_EVENTS) {
    ALL_CELLS.push([state, event, EXPECTED_EDGES[state][event]])
  }
}

describe('D1 状态机边表穷举（8 状态 × 9 事件 = 72 格）', () => {
  it('穷举基座自检：状态 8 值 / 事件 9 值，展开 72 格，合法 19 边 / 非法 53 格', () => {
    expect(PLAN_LIFECYCLE_STATES).toHaveLength(8)
    expect(PLAN_LIFECYCLE_EVENTS).toHaveLength(9)
    expect(new Set(PLAN_LIFECYCLE_STATES).size).toBe(8)
    expect(new Set(PLAN_LIFECYCLE_EVENTS).size).toBe(9)
    expect(ALL_CELLS).toHaveLength(72)
    const legal = ALL_CELLS.filter(([, , next]) => next !== null)
    expect(legal).toHaveLength(19)
    expect(ALL_CELLS.length - legal.length).toBe(53)
  })

  it.each(ALL_CELLS.map(([s, e, n]) => [`${s} --${e}--> ${n ?? '（非法）'}`, s, e, n] as const))(
    '%s',
    (_label, state, event, expected) => {
      const result = transition(state, event)
      if (expected === null) {
        // 无效转移：精确 { ok: false }，不携带 next（调用方降级、不落盘）
        expect(result).toEqual({ ok: false })
        expect('next' in result).toBe(false)
      } else {
        expect(result).toEqual({ ok: true, next: expected })
      }
    },
  )
})

describe('D1 关键边命名锚定（设计原文语义）', () => {
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

  it('任何非终态 --exit--> exited，终态上 exit 非法、--enter--> planning 开新一轮', () => {
    const nonTerminal: PlanLifecycleState[] = ['idle', 'planning', 'reviewing', 'revising', 'approved', 'dispatching']
    for (const state of nonTerminal) {
      expect(transition(state, 'exit')).toEqual({ ok: true, next: 'exited' })
    }
    for (const terminal of ['completed', 'exited'] as const) {
      expect(transition(terminal, 'exit')).toEqual({ ok: false })
      expect(transition(terminal, 'enter')).toEqual({ ok: true, next: 'planning' })
    }
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

  it('终态两值同映 terminal（completed/exited 呈现层不新造消费面，D1）', () => {
    expect(derivePhase('completed')).toBe(derivePhase('exited'))
  })

  it('混装格垃圾 state 降级 idle（无 plan 缺省，不误示进行中）——含原型链继承键', () => {
    // constructor/toString/valueOf 曾穿透裸查表返回 Object 构造函数等（非 nullish 绕过 ?? 兜底）——
    // 白名单守卫后垃圾 state 全输入域精确落 'idle'，函数/对象不得作为相位流出
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
})
