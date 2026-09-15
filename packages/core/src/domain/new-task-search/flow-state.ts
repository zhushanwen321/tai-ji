/**
 * flow-state —— 新建任务状态机（core 域迁移版，IF4/DM4）。
 *
 * [归位] 迁自 renderer composables/new-task/useNewTaskFlowState.ts（263 行），语义逐条等价。
 * 模块级单例保持（C-NT-6 Q2=A：全局流程状态非 per-session，不套 useSessionScopedState）。
 * renderer 旧文件（composables/new-task/useNewTaskFlowState.ts）已随消费方全部迁移（w5 完成）删除
 * （2026-09 code-simplify R7；strangler 逐域绞杀 §11.2 收口）。
 *
 * 职责（仅状态机，深模块 §5）：
 * - NewTaskFlowState 10 态枚举 + GitInfo 派生类型。
 * - ALLOWED 转换表 + OVERLAY_STATES/ACTIVE_STATES 集合常量。
 * - 模块级单实例 refs（state/currentSession/pendingCwd/pendingModel/createInFlight/branchCreateInFlight）。
 * - transition(target)：带守卫的**公开**状态转换（非法转换 → 回 idle + 抛错，AC-3.11）。
 * - useNewTaskFlowState()：只读状态视图（人人可取）；useNewTaskFlowController()：受控写入口
 *   controller（**仅父编排器独占**，setter 不再模块级 export，杜绝大多数场景绕过守卫的后门）。
 * - resetNewTaskFlow()：测试隔离 / 应用初始化重置单实例。
 *
 * 不含：动作编排（startFlow/submitFirstMessage/selectBranch/selectWorkspace/openDirDialog 等
 * 真调用 + 业务守卫，留 flow/branch/dir-select）。
 *
 * 依赖方向：vue reactivity（ref/readonly）+ @taiji/shared（SessionSummary）。core 零跨包 import。
 */
import { ref, readonly } from 'vue'
import type { Ref, DeepReadonly } from 'vue'
import type { SessionSummary } from '@taiji/shared'

/**
 * NewTaskFlow 态枚举（②§5）。worktree-modal 为 W2 wave 新增（创建 worktree modal）。
 * preset-popover 为 preset 互斥 wave 新增（landing 态 PresetSelectChip popover）——
 * 与 dir/branch popover 同属 overlay 互斥组，打开时关闭其他 popover。
 */
export type NewTaskFlowState =
  | 'idle'
  | 'landing'
  | 'dir-popover'
  | 'branch-popover'
  | 'preset-popover'
  | 'dir-dialog'
  | 'branch-modal'
  | 'worktree-modal'
  | 'completed'
  | 'cancelled'

/**
 * transitionUnchecked 唯一允许的目标态（类型层锁死，见 NewTaskFlowController）。
 * 语义：只有"回 idle"是绕过 ALLOWED 守卫的合法直置——终态重建（completed→idle）
 * 与守卫失败回 idle（throw 前清态）。其余状态变更必须走 transition()（带守卫）。
 */
export type TransitionUncheckedTarget = 'idle'

/** 当前 session 的 git 派生（UC-7 chip 可见性 + openBranchPopover 守卫 + isBareWorkspace 派生） */
export interface GitInfo {
  branch: string
  isRepo: boolean
  /** 是否在 bare repo + worktree 结构下（W2 wave：DirSelectPopover「新建 worktree…」动作项显隐） */
  isBare?: boolean
}

/** overlay 态集合（overlay 互斥 / cancelFlow 判定用） */
export const OVERLAY_STATES: ReadonlySet<NewTaskFlowState> = new Set([
  'dir-popover',
  'branch-popover',
  'preset-popover',
  'dir-dialog',
  'branch-modal',
  'worktree-modal',
])

/**
 * 活跃态集合（landing + 全部 overlay；排除 idle/completed/cancelled）。
 * Workspace 渲染守卫用：统一延迟 create 下，flow 活跃期间 activeId 恒 null，
 * 但 UI 须保持 Landing 挂载——否则用户点 chip 进 overlay 态（dir-popover/dir-dialog…）
 * 会瞬间卸载 Landing → 跳兜底空态页，系统目录选择器视觉上"没弹"。isOverlay ⊂ isActive。
 */
export const ACTIVE_STATES: ReadonlySet<NewTaskFlowState> = new Set([
  'landing',
  'dir-popover',
  'branch-popover',
  'preset-popover',
  'dir-dialog',
  'branch-modal',
  'worktree-modal',
])

/**
 * 合法转换表（§4.6 守卫表落地）。未列出的 from→to 组合 = 非法 → 抛错回 idle（AC-3.1/3.11）。
 * 终态：仅 completed（实例销毁）。cancelled 可重入（reenterFlow → landing）。
 */
const ALLOWED: Record<NewTaskFlowState, NewTaskFlowState[]> = {
  idle: ['landing'],
  landing: ['dir-popover', 'branch-popover', 'preset-popover', 'worktree-modal', 'completed', 'cancelled'],
  'dir-popover': ['landing', 'dir-dialog', 'cancelled'],
  'branch-popover': ['landing', 'branch-modal', 'worktree-modal', 'cancelled'],
  'preset-popover': ['landing', 'cancelled'],
  'dir-dialog': ['landing', 'dir-popover', 'cancelled'],
  'branch-modal': ['landing', 'cancelled'],
  'worktree-modal': ['landing', 'cancelled'],
  completed: [], // 终态，无出口（⌘N 再触发走 startFlow 内的销毁重建）
  cancelled: ['landing'], // reenterFlow 复活
}

// ── 模块级单实例状态（Q2=A 单实例：composable 模块单例）──
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：新任务流程状态机单例（core SSOT，Q2=A composable 模块单例，12 类未覆盖）
const state: Ref<NewTaskFlowState> = ref('idle')
/** 当前 flow 绑定的 session（统一延迟 create 后，landing 态恒为 null，首发提交 submitFirstMessage 才绑定） */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：flow 绑定 session 单例 ref（同上）
const currentSession: Ref<SessionSummary | null> = ref(null)
/** landing 态用户选定但尚未 create 的 cwd（选目录只记值不建 session；首发提交才用它 create）。null=空 chip 态 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：landing 态待定 cwd 单例 ref（同上）
const pendingCwd: Ref<string | null> = ref(null)
/**
 * landing 态用户选定但尚未透传的模型（"provider/modelId" 复合串，与 SessionSummary.modelId 同格式）。
 * landing 态 session 尚未 create，无需调 model.switch。记 pendingModel 供 Composer 显示，
 * 首发提交时经 resolveLaunchConfig 终值随 create payload 快照透传（D5，无 post-create apply）。
 * null=未选，Composer 侧经 resolveLaunchConfig 解析链兜底。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：landing 态待定 model 单例 ref（同上）
const pendingModel: Ref<string | null> = ref(null)
/** submitFirstMessage in-flight 标记（双击并发只建 1 session） */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：submitFirstMessage in-flight 标记（同上）
const createInFlight = ref(false)
/** submitCreateBranch in-flight 标记（AC-7.9 飞行中 disabled 防重复 + T6.6 composable 层守卫） */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：submitCreateBranch in-flight 标记（同上）
const branchCreateInFlight = ref(false)

/**
 * 重置 NewTaskFlow 单实例状态回 idle（测试隔离 / 应用初始化用）。
 * 单实例（Q2=A）的状态跨 useNewTaskFlow() 调用共享，测试需在 beforeEach 重置避免串扰。
 */
export function resetNewTaskFlow(): void {
  state.value = 'idle'
  currentSession.value = null
  pendingCwd.value = null
  pendingModel.value = null
  createInFlight.value = false
  branchCreateInFlight.value = false
}

/**
 * 状态转换（带守卫）。非法转换 → 回 idle + 抛错（Vue 错误边界兼底，AC-3.11）。
 * 这是状态机的公开写入口：任何子 composable / 组件都可调用，ALLOWED 表保证合法性。
 * NFR④#3：此处为 logger debug 接线点（每次转换 log from→to）。
 */
export function transition(target: NewTaskFlowState): void {
  const from = state.value
  if (!ALLOWED[from].includes(target)) {
    state.value = 'idle'
    throw new Error(`NewTaskFlow 非法状态转换: ${from} → ${target}`)
  }
  state.value = target
}

/**
 * openOverlay —— 统一的 overlay 互斥入口（landing 态打开任意 overlay）。
 *
 * 语义：当前已在任意 overlay 态（dir/branch/preset-popover 等）时，先归 landing（所有 overlay→landing
 * 在 ALLOWED 内合法），再 transition 到 target。当前在 landing 时直接 transition。
 *
 * 幂等早退（W6）：当前已在 target 态时直接返回，避免 landing→target 短暂闪烁（overlay 被卸载重建）。
 *
 * 前置条件（W7）：调用方必须处于 landing 或任意 overlay 态。从 idle 调用会 throw（ALLOWED['idle']
 * 只允许 'landing'）——这是有意的：overlay 入口（openDirPopover/openBranchPopover/openPresetPopover/
 * openWorktreeModal）只应在 flow 已启动（startFlow 后 state=landing）时调用，从 idle 调用说明上游漏了
 * startFlow，throw 暴露该 bug 而非静默走 transition('landing') 绕过 startFlow 的初始化副作用。
 *
 * 存在意义：消除 openDirPopover / openBranchPopover / openPresetPopover 各自手写"其他 overlay 态"
 * 互斥分支的重复与遗漏风险——曾经各处只列举当时的其他态，新增 overlay 态（如 preset-popover）时
 * 漏改某处就会撞非法转换（preset→dir 回归事故）。改用 OVERLAY_STATES 集合判断，新增 overlay 态只需
 * 加进集合（OVERLAY_STATES / ALLOWED），各 openXxx 自动生效。
 *
 * 注意：target 必须是 landing 可直达的 overlay 态（ALLOWED['landing'] 含之），否则 transition 抛错。
 * 调用方若需来源守卫（如 openBranchPopover 的 git 守卫），在调 openOverlay 前自行处理。
 */
export function openOverlay(target: NewTaskFlowState): void {
  if (state.value === target) return // 幂等：已在 target，早退防 landing→target 闪烁
  if (OVERLAY_STATES.has(state.value)) {
    transition('landing')
  }
  transition(target)
}

/**
 * 直接置 state（绕过 ALLOWED 守卫表）。**模块私有**，不导出——仅经 useNewTaskFlowController()
 * 暴露给父编排器独占，杜绝大多数场景误用绕过守卫的后门。
 *
 * @internal 仅供两类无法走 transition 的语义性直置：
 * - 终态重建（startFlow 中 completed→idle，ALLOWED['completed']=[] 不允许任何出口）
 * - 守卫失败回 idle（throw 前清态：openBranchPopover 非 git 目录 / openBranchModal 来源非法）
 * 其他一切状态变更必须走 transition()（带守卫）。
 */
function transitionUnchecked(target: NewTaskFlowState): void {
  state.value = target
}

// ── 受控写入口（模块私有，仅经下方 controller 暴露给父编排器）──
// 设计意图：flow 状态是单实例共享态，写入口若逐个模块级 export 会被任意子 composable / 组件
// 越权 import 调用（注释「仅父可写」零约束力）。改为不导出 + 经 useNewTaskFlowController()
// 收敛成单一 controller 对象，父编排器独占后按需把具体 setter 作为参数下发给子 composable——
// 既消除逐个 import 的滥用面，又让数据流在函数签名里显式可见。

/** 绑定/替换当前 flow 的 session（submitFirstMessage create 后绑定） */
function bindCurrentSession(s: SessionSummary | null): void {
  currentSession.value = s
}

/** 标记 submitFirstMessage 飞行中（true）/ 结束（false） */
function setCreateInFlight(v: boolean): void {
  createInFlight.value = v
}

/** 标记 submitCreateBranch 飞行中（true）/ 结束（false）（AC-7.9/T6.6） */
function setBranchCreateInFlight(v: boolean): void {
  branchCreateInFlight.value = v
}

/**
 * 受控写入口集合（controller）。**仅父编排器 useNewTaskFlow** 应调用本函数获取——
 * 子 composable 与组件无法从模块直接 import 这些 setter（已不再模块级 export），
 * 父编排器按需把具体 setter 作为参数传给子 composable（见 branch 签名）。
 */
export interface NewTaskFlowController {
  /**
   * 绕过 ALLOWED 表直置 state。target 类型锁定为 TransitionUncheckedTarget（= 'idle'），
   * 使父编排器也无法用它跳到 landing/completed 等态——编译期堵死后门滥用。
   * 仅供两类无法走 transition 的语义性直置（见 transitionUnchecked @internal）：
   * 终态重建（completed→idle）与守卫失败回 idle。
   */
  transitionUnchecked: (target: TransitionUncheckedTarget) => void
  /** 绑定/替换当前 flow 的 session（submitFirstMessage create 后绑定） */
  bindCurrentSession: (s: SessionSummary | null) => void
  /** 标记 submitFirstMessage 飞行中（true）/ 结束（false） */
  setCreateInFlight: (v: boolean) => void
  /** 标记 submitCreateBranch 飞行中（true）/ 结束（false）（AC-7.9/T6.6） */
  setBranchCreateInFlight: (v: boolean) => void
}

/**
 * 取得受控写入口 controller（**仅父编排器 useNewTaskFlow 调用**）。
 * 子 composable 不调用本函数——它需要的 setter 由父编排器作为参数注入。
 */
export function useNewTaskFlowController(): NewTaskFlowController {
  return {
    transitionUnchecked,
    bindCurrentSession,
    setCreateInFlight,
    setBranchCreateInFlight,
  }
}

/** 单实例状态视图（子 composable + 父编排器消费；state/currentSession/createInFlight 只读） */
export interface NewTaskFlowStateRefs {
  state: DeepReadonly<Ref<NewTaskFlowState>>
  currentSession: DeepReadonly<Ref<SessionSummary | null>>
  pendingCwd: Ref<string | null>
  pendingModel: Ref<string | null>
  createInFlight: DeepReadonly<Ref<boolean>>
  branchCreateInFlight: DeepReadonly<Ref<boolean>>
}

/**
 * 暴露单实例状态 refs（只读视图）供子 composable / 父编排器消费。
 * 本函数**只返回视图**（不含写入口）——写入口经 useNewTaskFlowController() 独占获取，
 * 从而读写分离：读视图人人可取，写入口仅父编排器独占。
 * pendingCwd/pendingModel 非只读——子 composable（dir-select）+ 父编排器需写它记 landing 选定值。
 */
export function useNewTaskFlowState(): NewTaskFlowStateRefs {
  return {
    state: readonly(state),
    currentSession: readonly(currentSession),
    pendingCwd,
    pendingModel,
    createInFlight: readonly(createInFlight),
    branchCreateInFlight: readonly(branchCreateInFlight),
  }
}
