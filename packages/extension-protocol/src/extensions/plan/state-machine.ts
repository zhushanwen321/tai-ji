/**
 * plan 模式生命周期状态机（plan 模式状态机显式化 D1）——8 值状态集 + 9 事件
 * 边表的单一状态契约。表与判定迁移 @zhushanwen/state-machine 基建承载（M4）：
 * 矩阵改行式声明 + errorPolicy:'result'（表外 `{ ok: false }` 不炸 turn）+ 原型链
 * 白名单口径统一到机器 coerceState（域内枚举 includes 白名单先例被基建吸收，
 * V10）；对外 `transition` / `derivePhase` 签名与返回形态保形（消费方零改动，
 * 消费方清单 = consumers.md）。
 *
 * plan 模式的状态散落在 pi 扩展 entry / runtime 挂起注册表 / renderer 派生公式三处时，
 * 任意两者漂移即产「僵尸/谎言」UI（F1-F5）。本模块是全链路共享的单一状态契约：
 * 8 值状态集 + 9 事件边表 + `transition` 纯函数（检查集中一处）+ `derivePhase` 呈现映射。
 *
 * 语义要点（设计 D1 逐条锚定）：
 * - 非法转移返回 `{ ok: false }`（机器 errorPolicy:'result' 的表外分支转译——不携带
 *   next 键、不 throw），由调用方降级（**不 throw 炸 turn**）；副作用不进返回值
 *   （effects-as-data 无已登记消费方属投机间接层），各 action 在转移成功后内联执行自身副作用。
 * - `reviewing --dismiss--> planning`：用户「搁置」（协议级 dismiss 决策，D3）——落盘即
 *   planning，被搁置的审批不复活（F1/F2/F3 构造性消除）。
 * - `reviewing --review_aborted--> planning`：挂起期外部 turn abort / TUI 取消（D3 连带）。
 * - `dispatching --review_aborted--> approved`：批准事实保留——任一「无选择解散」出口
 *   （外部 turn abort 级联 / 表单取消 / 超时 / 交互通道故障折叠）统一落 approved，
 *   不把「已批准」打回规划期（F5 不复活）。
 * - `dispatching --later--> approved`：用户显式选「暂不执行」——是明确选择不是解散，
 *   不得进 review_aborted 文案桶（A9 反向）。
 * - `dispatching --exec_chosen--> completed`：选定执行方式并派发执行（终态）。
 * - `approved --approve--> dispatching`：批准后 agent 再调 `complete` 重新选择执行方式
 *   （D1「approved 上 agent 再调 complete → dispatching」）。事件命名裁决：9 事件表无
 *   `complete` 员，本边取「执行确认」语义族最近员 `approve`（用户点确认执行与批准后重选
 *   执行方式同为「确认执行、进入执行方式选择」的决策事件）——消费方接线见 consumers.md。
 * - `approved` 其余转移仅 `exit`；活跃族非终态 `--exit--> exited`；idle 从未进入，
 *   exit 非法（防从未进 plan 的会话落噪音 exited entry）；终态 `--enter--> planning`
 *   （新一轮）；`revising` 保留独立态（E3 恢复文案分叉依赖，前提 P-7）。
 * - `reviewing --submit--> reviewing`：审批重挂自环（E3 会话重启恢复 / D8「重新提交审批」
 *   按钮——重提交不推进生命周期，落盘回 reviewing 重挂即等价于旧调用方特判放行形态）。
 *
 * 发布位次登记（D7③）：本包（@zhushanwen/extension-protocol）自 M4 起依赖
 * @zhushanwen/state-machine（workspace 协议），npm 发布顺序必须基建包在先——
 * 位次断链时 npm 消费者会装到缺依赖的 extension-protocol（changeset 依赖图
 * 自然保证，发布 PR 人工核对本条）。
 */

import { defineStateMachine } from '@zhushanwen/state-machine'

// ── 状态集（8 值，D1）──

export type PlanLifecycleState =
  | 'idle'
  | 'planning'
  | 'reviewing'
  | 'revising'
  | 'approved'
  | 'dispatching'
  | 'completed'
  | 'exited'

/** 状态穷举表（运行时消费：E3 恢复查表 / 测试穷举基座）——顺序 = 生命周期自然序。 */
export const PLAN_LIFECYCLE_STATES = [
  'idle',
  'planning',
  'reviewing',
  'revising',
  'approved',
  'dispatching',
  'completed',
  'exited',
] as const satisfies readonly PlanLifecycleState[]

// ── 事件集（9 值 = 边的名字，D1）──

export type PlanLifecycleEvent =
  | 'enter'
  | 'submit'
  | 'revise'
  | 'dismiss'
  | 'review_aborted'
  | 'approve'
  | 'exec_chosen'
  | 'later'
  | 'exit'

/** 事件穷举表——顺序 = 设计 D1 枚举序。 */
export const PLAN_LIFECYCLE_EVENTS = [
  'enter',
  'submit',
  'revise',
  'dismiss',
  'review_aborted',
  'approve',
  'exec_chosen',
  'later',
  'exit',
] as const satisfies readonly PlanLifecycleEvent[]

// ── 机器声明（M4：矩阵迁行式，表 = 全状态 × 全事件的唯一权威）──

/**
 * 边表：全状态 × 全事件的唯一权威（合法 19 边，其余 53 格非法）。
 *
 * | state＼event | enter | submit | revise | dismiss | review_aborted | approve | exec_chosen | later | exit |
 * |--------------|-------|--------|--------|---------|----------------|---------|-------------|-------|------|
 * | idle         | planning | — | — | — | — | — | — | — | — |
 * | planning     | — | reviewing | — | — | — | — | — | — | exited |
 * | reviewing    | — | reviewing | revising | planning | planning | dispatching | — | — | exited |
 * | revising     | — | reviewing | — | — | — | — | — | — | exited |
 * | approved     | — | — | — | — | — | dispatching | — | — | exited |
 * | dispatching  | — | — | — | — | approved | — | completed | approved | exited |
 * | completed    | planning | — | — | — | — | — | — | — | — |
 * | exited       | planning | — | — | — | — | — | — | — | — |
 *
 * completed / exited 是「terminal 显式声明 + enter 重启出边并存」的合法形态（D3——
 * 终态可开新一轮，非 run 域的吸收态）。行级无 guard / outputs / terminalOutcome
 * （plan 边是无条件裸转移，planned 恒空——副作用由调用方在转移成功后内联执行）。
 */
export const PLAN_MACHINE = defineStateMachine({
  name: 'plan-lifecycle',
  states: {
    idle: {},
    planning: {},
    reviewing: {},
    revising: {},
    approved: {},
    dispatching: {},
    completed: { terminal: true },
    exited: { terminal: true },
  },
  initial: 'idle',
  events: {
    enter: {},
    submit: {},
    revise: {},
    dismiss: {},
    review_aborted: {},
    approve: {},
    exec_chosen: {},
    later: {},
    exit: {},
  },
  transitions: [
    { from: 'idle', on: 'enter', to: 'planning' },
    { from: 'planning', on: 'submit', to: 'reviewing' },
    { from: 'planning', on: 'exit', to: 'exited' },
    { from: 'reviewing', on: 'submit', to: 'reviewing' },
    { from: 'reviewing', on: 'revise', to: 'revising' },
    { from: 'reviewing', on: 'dismiss', to: 'planning' },
    { from: 'reviewing', on: 'review_aborted', to: 'planning' },
    { from: 'reviewing', on: 'approve', to: 'dispatching' },
    { from: 'reviewing', on: 'exit', to: 'exited' },
    { from: 'revising', on: 'submit', to: 'reviewing' },
    { from: 'revising', on: 'exit', to: 'exited' },
    { from: 'approved', on: 'approve', to: 'dispatching' },
    { from: 'approved', on: 'exit', to: 'exited' },
    { from: 'dispatching', on: 'review_aborted', to: 'approved' },
    { from: 'dispatching', on: 'exec_chosen', to: 'completed' },
    { from: 'dispatching', on: 'later', to: 'approved' },
    { from: 'dispatching', on: 'exit', to: 'exited' },
    { from: ['completed', 'exited'], on: 'enter', to: 'planning' },
  ],
  errorPolicy: 'result',
})

// ── 转移函数（检查集中一处，D1；机器判定的保形包装）──

export type PlanTransitionResult =
  | { ok: true; next: PlanLifecycleState }
  | { ok: false }

/**
 * 纯函数转移：`(state, event) → { ok: true, next } | { ok: false }`——机器
 * errorPolicy:'result' 判定的保形包装（签名与返回形态不变，消费方零改动）。
 *
 * 非法转移（含运行时垃圾 state/event 值——跨版本帧、坏反序列化）返回 `{ ok: false }`
 * 且**不携带 next 键**，由调用方降级（不 throw 炸 turn）。调用方义务：`ok:false` 时
 * 不落盘、不执行副作用（终态上 `ok:false` 不落盘即 D3 归属划分点的兜底保险）。
 *
 * 垃圾输入的分层判定（原型链白名单口径已统一到基建 coerceState 的同族机制）：
 * 词表外 state 由机器词表集合拒绝（Set 查询不走原型链）；词表外 event 字符串由
 * 机器 (from, on) 行索引拒绝（Map 复合键查询不走原型链）；非字符串 event 在机器
 * 的事件名解析处会 crash，「不炸 turn」契约覆盖全输入域，故先挡形态。plan 表无
 * to:null 消亡行（基建 null 语义 = 实体离开机器，plan 8 态全在机器内），state 为
 * null 的分支运行时不可达，收窄仅为类型完备。
 */
export function transition(state: PlanLifecycleState, event: PlanLifecycleEvent): PlanTransitionResult {
  if (typeof event !== 'string') return { ok: false }
  const result = PLAN_MACHINE.transition(state, event)
  if (!result.ok) return { ok: false }
  return result.state === null ? { ok: false } : { ok: true, next: result.state }
}

// ── 呈现映射（derivePhase，D1 用户视角四主态 + idle 缺省）──

/**
 * 用户视角呈现相位（四主态 + idle）：
 * - 'planning'（规划中）= planning | revising
 * - 'reviewing'（待审批）= reviewing
 * - 'approved'（已批准）= approved | dispatching（dispatching 呈「③审阅确认 · 已完成」，
 *   阶段不倒退——F5 修正；细化渲染由消费方查 state，不另造相位）
 * - 'terminal'（终态）= completed | exited（两值同映，区分只留存储/审计层）
 * - 'idle'（无 plan）= idle
 */
export type PlanPhase = 'idle' | 'planning' | 'reviewing' | 'approved' | 'terminal'

const PHASE_OF_STATE: Record<PlanLifecycleState, PlanPhase> = {
  idle: 'idle',
  planning: 'planning',
  reviewing: 'reviewing',
  revising: 'planning',
  approved: 'approved',
  dispatching: 'approved',
  completed: 'terminal',
  exited: 'terminal',
}

/**
 * 8 存储态 → 5 呈现相位的单点映射（renderer 阶段指示/状态带共用，禁止消费方各自 if 拼）。
 * 运行时垃圾 state（混装格坏帧）降级 'idle'（无 plan 缺省，fail-safe 不误示进行中）。
 *
 * 入口白名单检查 = 机器 coerceState（原型链白名单口径统一到基建，V10）：裸查表对
 * 继承键 'constructor' / 'toString' 会取出 Object 构造函数等并经 `?? 'idle'` 流出
 * （非 nullish 不落兜底）——垃圾 state 必须精确落 'idle'，函数/对象不得作为相位
 * 流入 renderer。
 */
export function derivePhase(state: PlanLifecycleState): PlanPhase {
  const coerced = PLAN_MACHINE.coerceState(state)
  if (coerced === null) return 'idle'
  return PHASE_OF_STATE[coerced]
}
