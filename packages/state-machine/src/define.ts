import { buildMachineCore, transitionOnCore } from './transition'
import type { ErrorPolicy, StateMachine, StateMachineDefinition, TransitionRow } from './types'

/**
 * 声明式状态机工厂（设计 §5.1）。
 *
 * 定义期自检（V2，fail-fast——开发期暴露声明错误）：
 * 1. from / to / on 不在词表内 → throw（类型层字面量约束的第一道防线被 `as` 绕过
 *    或词表经变量间接传入时的兜底）
 * 2. 同 (from, on) 多行且任一行无 guard → throw（无 guard 行恒命中，与 guard 行并存
 *    运行时必然多命中——静态可判；「其余情况落到此行」的兜底语义由互补 guard 表达）
 *
 * 不设自检的限制（V2 钦点，非遗漏）：
 * - terminal 态带出边不限制——「终态 + enter 重启出边」是 plan 的 completed/exited
 *   合法形态（D3），表行为由 generateTableTests 断言覆盖
 * - 「多行全带 guard 但互斥性不成立」不是定义期错误——guard 是函数，互补性运行时
 *   才可判；运行时多命中按转移表不变量破坏 throw
 */

/** (from, on) 分组进入「无 guard 垫底行」检查的行数阈值。 */
const GUARD_REQUIRED_ROW_COUNT = 2

function selfCheck<S extends string, E extends string, Ctx>(
  definition: StateMachineDefinition<S, E, Ctx>,
  stateSet: ReadonlySet<S>,
  eventSet: ReadonlySet<E>,
): void {
  const { name, transitions } = definition
  transitions.forEach((row, i) => {
    const froms = Array.isArray(row.from) ? row.from : [row.from]
    for (const from of froms) {
      if (!stateSet.has(from)) {
        throw new Error(
          `状态机[${name}]定义期自检失败：第 ${i} 行 from '${String(from)}' 不在状态词表 [${[...stateSet].join(', ')}] 内——修声明。`,
        )
      }
    }
    if (row.to !== null && !stateSet.has(row.to)) {
      throw new Error(
        `状态机[${name}]定义期自检失败：第 ${i} 行 to '${String(row.to)}' 不在状态词表 [${[...stateSet].join(', ')}] 内——修声明。`,
      )
    }
    if (!eventSet.has(row.on)) {
      throw new Error(
        `状态机[${name}]定义期自检失败：第 ${i} 行 on '${String(row.on)}' 不在事件词表 [${[...eventSet].join(', ')}] 内——修声明。`,
      )
    }
  })
  // (from, on) 分组：组内多行时禁止无 guard 垫底行（数组 from 已按单态展开对齐）
  const groups = new Map<string, { row: TransitionRow<S, E, Ctx>; index: number }[]>()
  transitions.forEach((row, i) => {
    const froms = Array.isArray(row.from) ? row.from : [row.from]
    for (const from of froms) {
      const key = `${String(from)}\u0000${String(row.on)}`
      const bucket = groups.get(key)
      if (bucket) bucket.push({ row, index: i })
      else groups.set(key, [{ row, index: i }])
    }
  })
  for (const [key, group] of groups) {
    if (group.length < GUARD_REQUIRED_ROW_COUNT) continue
    const [from, on] = key.split('\u0000')
    const unguarded = group.find((g) => g.row.guard === undefined)
    if (unguarded !== undefined) {
      throw new Error(
        `状态机[${name}]定义期自检失败：(from=${from}, on=${on}) 存在 ${group.length} 行，其中第 ${unguarded.index} 行无 guard——无 guard 行恒命中，与 guard 行并存运行时必然多命中；「其余情况落到此行」的兜底语义改用互补 guard 表达。`,
      )
    }
  }
}

function buildMachine<S extends string, E extends string, Ctx>(
  definition: StateMachineDefinition<S, E, Ctx>,
): StateMachine<S, E, Ctx, ErrorPolicy> {
  const stateList = Object.keys(definition.states) as S[]
  const eventList = Object.keys(definition.events) as E[]
  selfCheck(definition, new Set(stateList), new Set(eventList))
  const core = buildMachineCore(definition)
  const terminalStates = stateList.filter((s) => definition.states[s]?.terminal === true)
  return {
    name: definition.name,
    states: stateList,
    events: eventList,
    terminalStates,
    definition,
    transition: (state, event, ctx) => transitionOnCore(core, state, event, ctx),
    coerceState: (raw) => (typeof raw === 'string' && core.stateSet.has(raw as S) ? (raw as S) : null),
  }
}

/**
 * 声明一台状态机：词表 + 行式转移表 + guard + 动作引用 + 错误策略（§5.1）。
 *
 * 类型层：S / E 从 states / events 对象字面量键推断为字面量联合，from / to / on
 * 的词表内约束随之成立；带 guard 裁决上下文的机器显式传第三泛型 Ctx。
 * errorPolicy 按字面量重载窄化 transition 返回类型：'throw' 机器恒 TransitionOk
 * （表外即抛，ok:false 分支运行时不可达）；'result' 机器返回完整判别联合。
 */
export function defineStateMachine<S extends string, E extends string, Ctx = undefined>(
  definition: StateMachineDefinition<S, E, Ctx> & { errorPolicy: 'throw' },
): StateMachine<S, E, Ctx, 'throw'>
export function defineStateMachine<S extends string, E extends string, Ctx = undefined>(
  definition: StateMachineDefinition<S, E, Ctx> & { errorPolicy: 'result' },
): StateMachine<S, E, Ctx, 'result'>
export function defineStateMachine<S extends string, E extends string, Ctx = undefined>(
  definition: StateMachineDefinition<S, E, Ctx>,
): StateMachine<S, E, Ctx, ErrorPolicy> {
  return buildMachine(definition)
}
