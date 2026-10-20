import { IllegalTransitionError } from './illegal'
import type {
  ErrorPolicy,
  IllegalTransitionInfo,
  MachineEvent,
  StateMachineDefinition,
  TerminalOutcomeSpec,
  TransitionOk,
  TransitionResult,
} from './types'

/**
 * 纯函数转移内核（D2/D3）——无 IO、无时间源；副作用执行归编排外壳（runTransition，
 * 另一源文件）。机器实例的 `transition` 方法是本内核的薄包装，编排外壳与各消费域
 * 均经机器方法进入内核（无绕过机器方法直取本函数的生产调用方）；导出独立函数
 * 形态供 define 组装直取（包内组装消费；包外消费方暂无，导出面去留随收敛裁决）。
 */

/** 规范化表行：from 数组已展开、outputs 已归一（缺省空名单）。 */
export interface NormalizedRow<S extends string, E extends string, Ctx = undefined> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  from: S
  on: E
  to: S | null
  guard?: (ctx: Ctx | undefined, event: MachineEvent<E>) => boolean
  outputs: readonly string[]
  terminalOutcome?: TerminalOutcomeSpec
}

/** 内核视图：词表集合 + (from, on) 行索引 + 每态合法事件清单（错误消息用，
 * 从表派生不手工维护第二份——run 域先例）。 */
export interface MachineCore<S extends string, E extends string, Ctx = undefined> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  name: string
  definition: StateMachineDefinition<S, E, Ctx>
  stateSet: ReadonlySet<S>
  eventSet: ReadonlySet<E>
  rows: readonly NormalizedRow<S, E, Ctx>[]
  rowIndex: ReadonlyMap<string, readonly NormalizedRow<S, E, Ctx>[]>
  legalEvents: ReadonlyMap<S, readonly E[]>
}

function rowKey(from: string, on: string): string {
  return `${from}\u0000${on}`
}

/** 从声明构建内核视图（词表集合、行索引、合法事件清单）。声明自检在 define 侧
 * 先行（词表外/无 guard 垫底行已 throw），此处不再重复检查。 */
export function buildMachineCore<S extends string, E extends string, Ctx>(
  definition: StateMachineDefinition<S, E, Ctx>,
): MachineCore<S, E, Ctx> {
  const stateList = Object.keys(definition.states) as S[]
  const eventList = Object.keys(definition.events) as E[]
  const rows: NormalizedRow<S, E, Ctx>[] = []
  for (const row of definition.transitions) {
    const froms = Array.isArray(row.from) ? row.from : [row.from]
    for (const from of froms) {
      rows.push({
        from,
        on: row.on,
        to: row.to,
        guard: row.guard,
        outputs: row.outputs ?? [],
        terminalOutcome: row.terminalOutcome,
      })
    }
  }
  const rowIndex = new Map<string, NormalizedRow<S, E, Ctx>[]>()
  const legalEvents = new Map<S, E[]>()
  for (const state of stateList) legalEvents.set(state, [])
  for (const row of rows) {
    const key = rowKey(row.from, row.on)
    const bucket = rowIndex.get(key)
    if (bucket) bucket.push(row)
    else rowIndex.set(key, [row])
    const legal = legalEvents.get(row.from)
    if (legal && !legal.includes(row.on)) legal.push(row.on)
  }
  return {
    name: definition.name,
    definition,
    stateSet: new Set(stateList),
    eventSet: new Set(eventList),
    rows,
    rowIndex,
    legalEvents,
  }
}

function legalDetail<E extends string>(legal: readonly E[] | undefined): string {
  if (!legal || legal.length === 0) {
    return '该态无任何合法后续事件——终态吸收或实体已消亡，再投递任何事件均为编程错误（检查单写者是否在终局后仍向该实体追加事件）。'
  }
  return `该态合法事件：${legal.join(' / ')}。排查：事件投递是否乱序（重放 / 恢复对账）；若确需新增转移，先改设计转移表再补表行与穷举单测。`
}

/** 表外处置（errorPolicy 分派）：throw 机器抛默认/自定义错误，result 机器返回
 * `{ ok: false, reason }` 且不携带次态（plan「不炸 turn」契约）。 */
function reject<S extends string>(
  definition: { errorPolicy: ErrorPolicy; errorFactory?: (info: IllegalTransitionInfo) => Error },
  info: IllegalTransitionInfo,
): TransitionResult<S> {
  if (definition.errorPolicy === 'result') {
    return { ok: false, reason: 'illegal-transition' }
  }
  throw definition.errorFactory?.(info) ?? new IllegalTransitionError(info)
}

/** 行级终局载荷解析：字面量直取；`{ fromEvent }` 从事件载荷取字段值（缺字段或
 * 纯事件名触发 = 声明与调用形态不一致，fail-fast 指向修表/改传事件对象）。 */
function resolveTerminalOutcome<S extends string, E extends string>(
  machineName: string,
  from: S,
  on: string,
  spec: TerminalOutcomeSpec,
  event: MachineEvent<E>,
): string {
  if (typeof spec === 'string') return spec
  if (typeof event === 'string') {
    throw new Error(
      `转移表不变量破坏[${machineName}]：(from=${from}, on=${on}) 行声明 terminalOutcome.fromEvent='${spec.fromEvent}' 但触发事件是纯事件名（无载荷可取）——传入带载荷的事件对象，或改用字面量 terminalOutcome。`,
    )
  }
  const value = (event as Record<string, unknown>)[spec.fromEvent]
  if (value === undefined) {
    throw new Error(
      `转移表不变量破坏[${machineName}]：(from=${from}, on=${on}) 事件载荷缺失 terminalOutcome.fromEvent 指向的字段 '${spec.fromEvent}'——补齐事件载荷或修正行声明。`,
    )
  }
  return value as string
}

/**
 * 转移内核：`(state, event, ctx?) → TransitionResult`。
 *
 * 裁决语义（D3，run 域多行裁决直译）：
 * 1. 词表外 state / 表外 (state, event) → errorPolicy 拒绝（detail 含该态合法事件清单）
 * 2. 同 (from, on) 全部行的 guard 按行声明序求值 `(ctx, event)`；命中 0 行 = 表外；
 *    命中多于 1 行 = 转移表不变量破坏（guard 互斥性），恒 throw——不静默取首行
 * 3. 命中恰 1 行 → 返回次态与 planned（只计划不执行）；terminalOutcome 行解析载荷来源
 */
export function transitionOnCore<S extends string, E extends string, Ctx>(
  core: MachineCore<S, E, Ctx>,
  state: S,
  event: MachineEvent<E>,
  ctx?: Ctx,
): TransitionResult<S> {
  // 词表外事件值（null/undefined/数字/无 type 字段对象——磁盘读回坏值形态）归一为
  // undefined，靠 rowKey 未命中落入表外 reject（同表外处置，§5.2 失败路径表第 3 行）——
  // 不在事件名解析处裸 TypeError crash（无机器名、无恢复指引）。
  const on =
    typeof event === 'string'
      ? event
      : typeof event === 'object' && event !== null && typeof event.type === 'string'
        ? event.type
        : undefined
  if (!core.stateSet.has(state)) {
    return reject(core.definition, {
      machine: core.name,
      from: String(state),
      on: String(on),
      detail: 'state 不在状态词表内——磁盘读回字符串、跨版本坏值先经 coerceState 归化（null 走域内恢复路径）。',
    })
  }
  const candidates = core.rowIndex.get(rowKey(state, on ?? '')) ?? []
  const hits = candidates.filter((row) => row.guard === undefined || row.guard(ctx, event))
  if (hits.length === 0) {
    return reject(core.definition, {
      machine: core.name,
      from: state,
      on: String(on),
      detail: legalDetail(core.legalEvents.get(state)),
    })
  }
  if (hits.length > 1) {
    // guard 互斥性破坏 = 表 bug，与表外转移同为编程错误，但指向修表而非修调用方（run 先例）
    throw new Error(
      `转移表不变量破坏[${core.name}]：(from=${state}, on=${on}) 命中 ${hits.length} 条规则——检查转移表的 guard 互斥性。`,
    )
  }
  const row = hits[0]
  const result: TransitionOk<S> = { ok: true, state: row.to, planned: { outputs: row.outputs } }
  if (row.terminalOutcome !== undefined) {
    result.terminalOutcome = resolveTerminalOutcome(core.name, state, String(on), row.terminalOutcome, event)
  }
  return result
}
