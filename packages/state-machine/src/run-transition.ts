import type {
  ErrorPolicy,
  MachineEvent,
  StateMachine,
  TransitionRejected,
  TransitionResult,
} from './types'

/**
 * runTransition 事务性编排外壳（设计 §5.1 / §6 D2 / §8 U4）——纯函数内核的执行侧：
 * 转移判定合法后按 planned 顺序执行宿主注入的动作实现，全部成功次态才应用。
 *
 * 事务性语义（V8，单态 fail-fast）：
 * - 任一 planned 项失败 → 中止后续 planned 项、上抛第一个错误；
 *   「次态不应用、当前态不变」由不返回 ok:true 天然成立——外壳无状态槽，
 *   次态写回是宿主义务（成功后取 result.state 写回实体）
 * - errorPolicy: 'result' 机器的表外拒绝原样透传（不执行 planned、不抛）；
 *   'throw' 机器的表外错误由内核上抛（外壳不吞不包装）
 *
 * missing-action（V9，开发期 fail-fast）：声明行 outputs 引用的动作名未注入实现
 * → 立即抛 MissingActionError 且零 planned 执行（全量预检先于任何执行——两阶段
 * 顺序保证「转移不执行」，而非查到即抛的边查边执行）。
 *
 * 执行上下文 `c` 契约（D2）：成员固定 { machine, event, from, to }；`to` 是计划
 * 次态（动作执行时尚未应用，动作可读它派生载荷）；`c` 不透传 ctx/实体字段——宿主
 * 附加输入（实体路径、宿主对象等）经调用点闭包捕获（actions 对象在 runTransition
 * 调用点构造，ctx/实体均在该作用域内）。
 */

/** planned 项的执行上下文（动作唯一入参）。 */
export interface ActionContext<S extends string, E extends string> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  /** 机器名（声明 name）。 */
  machine: string
  /** 调用方原始事件值（含载荷对象形态）。 */
  event: MachineEvent<E>
  /** 转移源态。 */
  from: S
  /** 计划次态；null = 实体消亡。动作执行时尚未应用。 */
  to: S | null
}

/** 宿主动作实现：按名注入，键名与转移行 outputs 声明一致；返回值外壳不消费。
 * 同步契约——返回 Promise 会被外壳 fail-fast 拒绝（见 runTransition 内防护）。 */
export type ActionFn<S extends string, E extends string> = (c: ActionContext<S, E>) => unknown

/** runTransition 第四参。 */
export interface RunTransitionOptions<S extends string, E extends string, Ctx = undefined> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  /** guard 裁决上下文（透传 transition 第三参；不进动作上下文 c）。 */
  ctx?: Ctx
  /** 宿主动作表。无 outputs 的转移可整体缺省。 */
  actions?: Readonly<Record<string, ActionFn<S, E>>>
}

/** 成功结果：全部动作已执行、次态可应用（null = 实体消亡，离开本机器）。 */
export interface RunTransitionOk<S extends string> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  ok: true
  state: S | null
}

/** errorPolicy 窄化的 runTransition 返回类型（'result' 机器额外携带表外拒绝分支）。 */
export type RunTransitionReturn<S extends string, P extends ErrorPolicy> = P extends 'result'
  ? RunTransitionOk<S> | TransitionRejected
  : RunTransitionOk<S>

/** 声明引用的动作名未注入实现（V9 fail-fast——开发期暴露接线遗漏）。 */
export class MissingActionError extends Error {
  readonly machine: string
  readonly action: string
  /** 抛出时已注入的动作名快照（排查动作表接线）。 */
  readonly available: readonly string[]
  constructor(info: { machine: string; action: string; available: readonly string[] }) {
    super(
      `动作未注入[${info.machine}]：转移行 outputs 引用动作 '${info.action}'，但 actions 表中无该实现（已注入：${info.available.length > 0 ? info.available.join(', ') : '无'}）——在 runTransition 调用点按名补注入（键名与 outputs 声明一致）。`,
    )
    this.name = 'MissingActionError'
    this.machine = info.machine
    this.action = info.action
    this.available = info.available
  }
}

export function runTransition<S extends string, E extends string, Ctx = undefined>(
  machine: StateMachine<S, E, Ctx, 'throw'>,
  state: S,
  event: MachineEvent<E>,
  options?: RunTransitionOptions<S, E, Ctx>,
): RunTransitionOk<S>
export function runTransition<S extends string, E extends string, Ctx = undefined>(
  machine: StateMachine<S, E, Ctx, 'result'>,
  state: S,
  event: MachineEvent<E>,
  options?: RunTransitionOptions<S, E, Ctx>,
): RunTransitionOk<S> | TransitionRejected
export function runTransition<S extends string, E extends string, Ctx = undefined>(
  machine: StateMachine<S, E, Ctx, ErrorPolicy>,
  state: S,
  event: MachineEvent<E>,
  options: RunTransitionOptions<S, E, Ctx> = {},
): RunTransitionOk<S> | TransitionRejected {
  const decision: TransitionResult<S> = machine.transition(state, event, options.ctx)
  if (decision.ok !== true) {
    // result 机器表外拒绝透传：不执行 planned、不抛（D2——调用方降级走返回值分支）
    return decision
  }
  const planned = decision.planned.outputs
  const actions = options.actions ?? {}
  // missing-action 全量预检（V9）：全部名字核实已注入后才开始执行任何 planned 项
  for (const name of planned) {
    // hasOwnProperty 守原型链键（actions['toString'] 等继承成员不是注入）——与 coerceState 白名单同精神
    if (!Object.prototype.hasOwnProperty.call(actions, name) || typeof actions[name] !== 'function') {
      throw new MissingActionError({
        machine: machine.name,
        action: name,
        available: Object.keys(actions),
      })
    }
  }
  const c: ActionContext<S, E> = { machine: machine.name, event, from: state, to: decision.state }
  // 事务性执行（V8）：按 outputs 行声明序执行；任一失败上抛（中止后续项）、无 ok:true
  // 返回——宿主不写回，次态不应用、当前态不变（外壳单态 fail-fast，无「尽力执行全部」）
  for (const name of planned) {
    const returned = actions[name](c)
    if (returned instanceof Promise) {
      // 同步外壳契约：异步动作的 rejection 落在事务边界之外，静默当成功会破坏事务性——
      // fail-fast 指向改同步实现（异步外壳无消费方，未提供）
      throw new Error(
        `动作[${machine.name}.${name}]返回了 Promise——runTransition 是同步事务外壳，异步动作的失败无法在事务边界内中止次态应用。改用同步实现。`,
      )
    }
  }
  return { ok: true, state: decision.state }
}
