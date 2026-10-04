/**
 * plan 模式生命周期状态机（plan 模式状态机显式化 D1）——纯数据 + 纯函数，零依赖。
 *
 * plan 模式的状态散落在 pi 扩展 entry / runtime 挂起注册表 / renderer 派生公式三处时，
 * 任意两者漂移即产「僵尸/谎言」UI（F1-F5）。本模块是全链路共享的单一状态契约：
 * 8 值状态集 + 9 事件边表 + `transition` 纯函数（守卫集中一处）+ `derivePhase` 呈现映射。
 *
 * 语义要点（设计 D1 逐条锚定）：
 * - 非法转移返回 `{ ok: false }`，由调用方降级（**不 throw 炸 turn**）；副作用不进返回值
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
 *   执行方式同为「确认执行、进入执行方式选择」的决策事件）——消费面接线见 consumers.md。
 * - `approved` 其余转移仅 `exit`；活跃族非终态 `--exit--> exited`；idle 从未进入，
 *   exit 非法（防从未进 plan 的会话落噪音 exited entry）；终态 `--enter--> planning`
 *   （新一轮）；`revising` 保留独立态（E3 恢复文案分叉依赖，前提 P-7）。
 * - `reviewing --submit--> reviewing`：审批重挂自环（E3 会话重启恢复 / D8「重新提交审批」
 *   按钮——重提交不推进生命周期，落盘回 reviewing 重挂即等价于旧调用方特判放行形态）。
 *
 * 呈现映射（derivePhase）：用户视角四主态 + idle 缺省——四主态是呈现，不是存储
 * （用户口述模型 = 呈现层，reviewing/dispatching 两个挂起态是崩溃恢复的真实分叉点，
 * 存储层保留 8 值）。终态两值（completed = 批准并派发执行 / exited = 主动退出）共享
 * 全部终态规则，呈现层同映 'terminal'（诊断/审计语义保留存储区分）。
 */

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

// ── 转移函数（守卫集中一处，D1）──

export type PlanTransitionResult =
  | { ok: true; next: PlanLifecycleState }
  | { ok: false }

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
 */
const TRANSITION_TABLE: Record<PlanLifecycleState, Partial<Record<PlanLifecycleEvent, PlanLifecycleState>>> = {
  idle: { enter: 'planning' },
  planning: { submit: 'reviewing', exit: 'exited' },
  reviewing: {
    submit: 'reviewing',
    revise: 'revising',
    dismiss: 'planning',
    review_aborted: 'planning',
    approve: 'dispatching',
    exit: 'exited',
  },
  revising: { submit: 'reviewing', exit: 'exited' },
  approved: { approve: 'dispatching', exit: 'exited' },
  dispatching: {
    review_aborted: 'approved',
    exec_chosen: 'completed',
    later: 'approved',
    exit: 'exited',
  },
  completed: { enter: 'planning' },
  exited: { enter: 'planning' },
}

/**
 * 纯函数转移：`(state, event) → { ok: true, next } | { ok: false }`。
 *
 * 非法转移（含运行时垃圾 state/event 值——跨版本帧、坏反序列化）返回 `{ ok: false }`
 * 且**不携带 next 键**，由调用方降级（不 throw 炸 turn）。调用方义务：`ok:false` 时
 * 不落盘、不执行副作用（终态上 `ok:false` 不落盘即 D3 归口点的兜底保险）。
 *
 * 入口白名单守卫（与 derivePhase 同一机制）：普通对象字面量查表会沿原型链命中继承键——
 * `transition('reviewing', '__proto__')` 取出 Object.prototype、`('__proto__', 'valueOf')`
 * 取出函数，均被误判为合法 next（违背本契约）。故垃圾键必须先挡在查表前。
 * **选「枚举 includes 白名单」而非 null-prototype 表 / Object.hasOwn**：① transition 与
 * derivePhase 共用同一守卫形态（单一机制，不并存两种写法）；② PLAN_LIFECYCLE_STATES /
 * PLAN_LIFECYCLE_EVENTS 就是值域 SSOT（测试穷举同源），includes 判定与之同源，
 * 原型键天然不在白名单内。
 */
export function transition(state: PlanLifecycleState, event: PlanLifecycleEvent): PlanTransitionResult {
  if (!PLAN_LIFECYCLE_STATES.includes(state) || !PLAN_LIFECYCLE_EVENTS.includes(event)) {
    return { ok: false }
  }
  const next = TRANSITION_TABLE[state][event]
  return next === undefined ? { ok: false } : { ok: true, next }
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
 * 入口白名单守卫（理由同 transition，见彼处）：裸查表对继承键 'constructor' / 'toString'
 * 会取出 Object 构造函数等并经 `?? 'idle'` 流出（非 nullish 不落兜底）——垃圾 state
 * 必须精确落 'idle'，函数/对象不得作为相位流入 renderer。
 */
export function derivePhase(state: PlanLifecycleState): PlanPhase {
  if (!PLAN_LIFECYCLE_STATES.includes(state)) return 'idle'
  return PHASE_OF_STATE[state]
}
