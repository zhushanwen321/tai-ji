import { describe, expect, it } from 'vitest'
import type {
  MachineEvent,
  StateMachine,
  TerminalOutcomeSpec,
  TransitionRow,
} from './types'

/**
 * 穷举单测生成器（D5）——「一行生成」全状态 × 全事件组合的测试组。
 *
 * 断言范围（表级组合，D5 保留口径——错误类型/错误码/降级行为等非纯表判定
 * 的行为级断言留域内，生成器不越界）：
 * - 合法行：断言次态与 planned（null 行断言 `state === null` 且 planned 只含
 *   行级 outputs；terminalOutcome 行断言载荷来源——字面量直取，fromEvent 注入
 *   哨兵载荷后断言取值命中）
 * - 表外：errorPolicy 对应行为（throw 断言抛出 / result 断言精确
 *   `{ ok: false, reason: 'illegal-transition' }`——toEqual 深比较同时守住
 *   「不携带次态」）
 * - 多命中：断言抛转移表不变量破坏（组合骨架暴露 guard 互斥性表 bug）
 * - terminal 态：全组合逻辑天然覆盖「有出边事件按表走、无出边事件全部被拒」
 *   （run 吸收与 plan 可重启终态两种形态都不需要特殊分支）
 *
 * 期望值由本文件独立评估表得出（不调 transition 算期望再喂 transition——
 * 同源循环论证不设防）；guard 行为组合骨架 = 对每 ctx 采样静态求值全部行。
 *
 * 与内核的 vitest 隔离：本模块 import vitest，走 `@zhushanwen/state-machine/testing`
 * 子出口——只有测试文件引它，运行时出口（'.'）不触及 vitest（peer optional）。
 */

/** fromEvent 行的载荷哨兵——断言「terminalOutcome 从事件载荷取值」的来源语义。 */
const SENTINEL = '__sm_table_test_sentinel__'

export interface GenerateTableTestsOptions<Ctx> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  /**
   * guard 行的 ctx 采样注入位（D5）——缺省 `[undefined]`（域内 fold 不传 ctx 的
   * 保形形态）；每个采样生成一组组合断言（互补 guard 在采样上单命中 / 全不
   * 命中 / 多命中暴露）。带 ctx 的行为级断言（run 二支取支等）由域内补充用例
   * 覆盖，生成器只负责组合骨架。
   */
  ctxSamples?: readonly Ctx[]
  /** describe 块名，缺省 `状态机表穷举：<name>`。 */
  describeName?: string
}

/** 生成的单条组合骨架（调用方可断言覆盖数与期望分布）。 */
export interface GeneratedCase<S extends string, E extends string> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  state: S
  event: E
  ctxIndex: number
  expectation: 'transition' | 'rejected' | 'invariant-broken'
}

/** 组合的事件对象形态：统一 `{ type: E }` 对象（guard 与 fromEvent 都有载荷位）；
 * 该 (state, event) 任一声明行带 fromEvent 终局载荷时额外注哨兵（type 恒后置赢
 * ——fromEvent 撞 'type' 的病态声明取回事件名本身，不做特殊分支）。同一对象
 * 既用于静态评估也用于实际触发，guard 对载荷的取支在两处一致。 */
function eventObjectOf<S extends string, E extends string>(
  transitions: readonly { from: S | readonly S[]; on: E; terminalOutcome?: TerminalOutcomeSpec }[],
  state: S,
  event: E,
): MachineEvent<E> {
  for (const row of transitions) {
    const froms = Array.isArray(row.from) ? row.from : [row.from]
    if (
      froms.includes(state) &&
      row.on === event &&
      row.terminalOutcome !== undefined &&
      typeof row.terminalOutcome !== 'string'
    ) {
      return { [row.terminalOutcome.fromEvent]: SENTINEL, type: event }
    }
  }
  return { type: event }
}

/** 静态评估：某 (state, event, ctx) 下声明的命中行（独立于内核实现）。 */
function evaluateHits<S extends string, E extends string, Ctx>(
  transitions: readonly TransitionRow<S, E, Ctx>[],
  state: S,
  event: E,
  eventObject: MachineEvent<E>,
  ctx: Ctx | undefined,
): readonly TransitionRow<S, E, Ctx>[] {
  const matching: TransitionRow<S, E, Ctx>[] = []
  for (const row of transitions) {
    const froms = Array.isArray(row.from) ? row.from : [row.from]
    if (froms.includes(state) && row.on === event) matching.push(row)
  }
  return matching.filter((row) => row.guard === undefined || row.guard(ctx, eventObject))
}

export function generateTableTests<S extends string, E extends string, Ctx = undefined>(
  machine: StateMachine<S, E, Ctx>,
  options: GenerateTableTestsOptions<Ctx> = {},
): GeneratedCase<S, E>[] {
  const ctxSamples = options.ctxSamples ?? [undefined]
  const cases: GeneratedCase<S, E>[] = []
  describe(options.describeName ?? `状态机表穷举：${machine.name}`, () => {
    for (const state of machine.states) {
      describe(`state=${state}`, () => {
        for (const event of machine.events) {
          for (const [ctxIndex, ctx] of ctxSamples.entries()) {
            const firedObject = eventObjectOf(machine.definition.transitions, state, event)
            const hits = evaluateHits(machine.definition.transitions, state, event, firedObject, ctx)
            const expectation: GeneratedCase<S, E>['expectation'] =
              hits.length === 0 ? 'rejected' : hits.length === 1 ? 'transition' : 'invariant-broken'
            cases.push({ state, event, ctxIndex, expectation })
            it(`${event}${ctxSamples.length > 1 ? ` [ctx#${ctxIndex}]` : ''}`, () => {
              if (hits.length === 0) {
                if (machine.definition.errorPolicy === 'result') {
                  expect(machine.transition(state, firedObject, ctx)).toEqual({
                    ok: false,
                    reason: 'illegal-transition',
                  })
                } else {
                  expect(() => machine.transition(state, firedObject, ctx)).toThrow()
                }
                return
              }
              if (hits.length > 1) {
                expect(() => machine.transition(state, firedObject, ctx)).toThrow(/不变量破坏/)
                return
              }
              const row = hits[0]
              const result = machine.transition(state, firedObject, ctx)
              if (result.ok !== true) {
                throw new Error(`期望合法转移 (from=${state}, on=${event})，得到拒绝：${JSON.stringify(result)}`)
              }
              expect(result.state).toBe(row.to)
              expect(result.planned.outputs).toEqual([...(row.outputs ?? [])])
              if (row.terminalOutcome === undefined) {
                expect(result.terminalOutcome).toBeUndefined()
              } else if (typeof row.terminalOutcome === 'string') {
                expect(result.terminalOutcome).toBe(row.terminalOutcome)
              } else {
                expect(result.terminalOutcome).toBe(SENTINEL)
              }
            })
          }
        }
      })
    }
  })
  return cases
}
