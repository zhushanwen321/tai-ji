/**
 * 状态机基建公共类型（设计 state-machine-infrastructure §5.1 / §6 D1-D5）。
 *
 * 核心概念：
 * - 词表（states / events）是 SSOT：类型层经泛型 `S extends string` / `E extends string`
 *   约束 from / to / on 字面量在词表内；运行时自检兜底（`as` 断言可绕过类型层）。
 * - 转移表是行式数组：一行 = `{ from, on, to, guard?, outputs?, terminalOutcome? }`，
 *   表达力对齐仓内最强形态（run 域 RUN_TRANSITIONS 直译）。
 */

/** 状态声明值形态。`terminal: true` 是终态声明的 SSOT——不由出边派生（D3：
 * plan 的 completed/exited 是「终态 + enter 重启出边」形态，无出边派生判不出；
 * run 的 terminal 吸收态又是「无表行 + 任意事件拒绝」——显式声明才统一）。 */
export interface StateSpec { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  terminal?: boolean
}

/** 事件声明值形态——v1 无字段（词表即全部语义），保留对象位供未来扩展。 */
export type EventSpec = Record<string, unknown>

/**
 * 触发事件（`machine.transition` 第二参）：事件名，或带载荷的事件对象。
 *
 * 载荷消费方：`terminalOutcome: { fromEvent }` 行从载荷字段取终局值（run 域
 * run-settled 行从 `event.outcome` 取的直译）；guard 第二参收到原始 event 值。
 */
export type MachineEvent<E extends string> = E | ({ type: E } & Record<string, unknown>)

/** 行级终局载荷声明：固定字面量（cancel → cancelled），或 `{ fromEvent }` 指向
 * 触发事件载荷的字段名（缺省形态 = 从事件载荷取，D3）。 */
export type TerminalOutcomeSpec = string | { fromEvent: string }

/** 单条转移规则（表行）。 */
export interface TransitionRow<S extends string, E extends string, Ctx = undefined> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  /** 源态；数组形态消重复行（定义期展开为逐态规范行）。 */
  from: S | readonly S[]
  /** 触发事件名。 */
  on: E
  /** 次态；`null` = 实体消亡、离开本机器（D3——与 terminal 吸收态是两个概念：
   * 吸收 = 留在机器内拒绝一切；消亡 = 后续事件不再属于本实体）。 */
  to: S | null
  /**
   * 条件行判别函数：按行声明序求值 `(ctx, event)`，返回 true = 该行命中。
   * 同 (from, on) 多行时全部行必须带 guard（无 guard 行恒命中、与 guard 行并存
   * 运行时必然多命中——定义期自检拒绝）；「其余情况落到此行」的兜底语义由互补
   * guard 表达。guard 对 undefined ctx 的取支由函数自行决定（域内 fold 不传 ctx
   * 的行为保形，`ctx?.x !== true` 直译）。
   */
  guard?: (ctx: Ctx | undefined, event: MachineEvent<E>) => boolean
  /** 该转移应发生的动作名单（声明性引用，执行归编排侧——planned 只计划不执行，D2）。 */
  outputs?: readonly string[]
  terminalOutcome?: TerminalOutcomeSpec
}

/** 表外转移处置策略（每实体声明，D4）：
 * - `'throw'`：抛 IllegalTransitionError（或 errorFactory 自定义类型），消息含
 *   当前态、事件、合法事件清单（对齐 run 语义）
 * - `'result'`：返回 `{ ok: false, reason: 'illegal-transition' }`，不抛且不携带
 *   次态（对齐 plan「不炸 turn」契约——调用方义务：不落盘、不执行副作用） */
export type ErrorPolicy = 'throw' | 'result'

/** 表外转移的错误构造信息（errorFactory 入参）——错误消息文本由基建统一组装，
 * errorFactory 只负责错误类型保形（既有类的 instanceof 分类分支仍命中，D4）。 */
export interface IllegalTransitionInfo { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  machine: string
  from: string
  on: string
  detail: string
}

/** 状态机声明（defineStateMachine 入参）。 */
export interface StateMachineDefinition<S extends string, E extends string, Ctx = undefined> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  /** 机器名（错误消息与测试组命名引用）。 */
  name: string
  /** 状态词表（键集 = 词表；terminal 位在值上声明）。 */
  states: Readonly<Record<S, StateSpec>>
  /** 初始态。 */
  initial: S
  /** 事件词表（键集 = 词表）。 */
  events: Readonly<Record<E, EventSpec>>
  /** 行式转移表。 */
  transitions: readonly TransitionRow<S, E, Ctx>[]
  errorPolicy: ErrorPolicy
  /** 可选：自定义错误类型（缺省 IllegalTransitionError）。 */
  errorFactory?: (info: IllegalTransitionInfo) => Error
}

/** 计划动作（转移结果的声明性输出——只计划不执行，D2）。 */
export interface PlannedActions { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  /** 行级 outputs 名单（行声明序）。 */
  outputs: readonly string[]
}

/** 合法转移结果。 */
export interface TransitionOk<S extends string> { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  ok: true
  /** 次态；`null` = 实体消亡（该行 to: null）。 */
  state: S | null
  planned: PlannedActions
  /** 终局载荷解析结果（仅声明 terminalOutcome 的行出现）。 */
  terminalOutcome?: string
}

/** 表外转移拒绝结果（errorPolicy: 'result' 机器的返回分支——不携带次态，plan 契约）。 */
export interface TransitionRejected { // oe-exempt:20261020:framework:SDK 契约接口——对外发布包公共 API，接口先立、单实现常态
  ok: false
  reason: 'illegal-transition'
}

export type TransitionResult<S extends string> = TransitionOk<S> | TransitionRejected

/**
 * 机器实例：词表、terminal 集、原始声明与 `transition` / `coerceState` 入口。
 *
 * `transition` 返回类型按 errorPolicy 窄化：`'throw'` 机器恒返回 TransitionOk
 * （表外即抛，ok:false 分支运行时不可达）；`'result'` 机器返回完整判别联合。
 */
export interface StateMachine<
  S extends string,
  E extends string,
  Ctx = undefined,
  P extends ErrorPolicy = ErrorPolicy,
> {
  readonly name: string
  readonly states: readonly S[]
  readonly events: readonly E[]
  readonly terminalStates: readonly S[]
  readonly definition: StateMachineDefinition<S, E, Ctx>
  /** 纯函数转移（唯一判定入口）：词表外 state 与表外事件按 errorPolicy 拒绝；
   * 同 (from, on) 多行命中 = 转移表不变量破坏，恒 throw（非 errorPolicy 可配）。 */
  transition(state: S, event: MachineEvent<E>, ctx?: Ctx): TransitionReturn<S, P>
  /** 词表外运行时输入的统一映射入口：词表内字符串原样返回，坏值与原型链键
   * 一律 null（枚举 includes 白名单判定，非裸对象查表——吸收 plan 先例，D3）。 */
  coerceState(raw: unknown): S | null
}

/** errorPolicy 窄化的 transition 返回类型。 */
export type TransitionReturn<S extends string, P extends ErrorPolicy> = P extends 'result'
  ? TransitionResult<S>
  : TransitionOk<S>
