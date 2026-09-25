/**
 * Plan store —— plan 模式状态机显式化（plan-mode-state-machine 设计 D1/D2/D4）：
 * per-session 的 PlanStateView + 评论草稿 + 审批条窗口状态（已应答抑制窗 / degraded 稳定窗）状态源。
 *
 * 职责：
 * - 分区：per-session Map 分区走 useSessionScopedState 工厂（ADR-0049 Map 分区派）。
 *   分区表建在本 pinia store 单例内——WS 帧写入（use-plan-sync）与组件视图（usePlanState）
 *   消费同一张表；工厂 setup 时自动 registerSessionCleanup → useSidebar.deleteSession
 *   清理链，免 ADR-0049 例外登记。切走不清、切回恢复；session 销毁精确释放。
 * - 评论草稿（D6）：提交前是本 store 草稿（内存态，刷新丢失可接受——与 composer 草稿同
 *   语义），提交时由 PlanReviewBar 审批条打包进 respond payload 注入对话流持久。加/删/清空
 *   只作用于当前焦点 session 分区（scoped.update 读 focusedSid 实时值，null sid 工厂内建 no-op）。
 * - 三步阶段指示（D1）+ 已批准档（D5 阶段不倒退）：derivePlanStage 纯函数承载（derivePhase
 *   单点接线，禁止消费方各自 if 拼——consumers.md §三 C），分区不存阶段字段。
 * - 审批条窗口状态（D4）：「已应答抑制窗」标记（respond 成功 / requestsInvalidated 摘除
 *   planReview 挂起即置标记，预期后态帧（state ≠ reviewing）/ 新 planReview pending 到达 /
 *   10s 双源冷拉真值三路解除）+「degraded 稳定窗」（state=reviewing ∧ 无挂起 ∧ 无标记的
 *   组合持续 ≥2s 才放行渲染；冷拉真值豁免稳定窗直通）。per-session 定时器 arm/cancel，
 *   epoch 世代比较防陈旧定时器误触发；2s + 10s 共 ≤2 个 per-session 定时器（上界量化），
 *   清理挂分区 cleanup 链（frameRevs 同款）。
 *
 * 与 WS/RPC 的接线边界：本 store 只持状态与操作（applyFrame / loadPlanState / 审批窗口
 * actions），订阅与首拉触发编排归 composables/use-plan-sync.ts（usePlanState）；planReview
 * 挂起的入店/出店漏斗归 useExtensionUI（其漏斗点回调本 store 的 setPlanReviewPending /
 * markPlanReviewAnswered——store 禁 import store（铁律），挂起镜像由该漏斗单写）。
 * 首拉回填带陈旧守卫（per-sid 帧版本号）：live 帧在请求在途窗口内到达时，更早启动的冷读
 * reply 整体丢弃（冷回填不倒拨热状态，F-R2-1；见 frameRevs 注释）。
 *
 * stores 间依赖方向：无（不 import 其他 store）。焦点 sid 由 use-plan-sync 从 panel store
 * 读取后经 syncFocus 注入（跨 store 编排在 composable 层，useListSync 先例）。
 *
 * 契约引用（D2/D3④ regime：renderer 直接 import @zhushanwen/extension-protocol，renderer
 * 早已依赖它——旧「本地同形」惯例已随状态机契约冻结退役）：PlanLifecycleState /
 * derivePhase（state-machine）与 PlanReviewComment（core/types）均直接引用契约根，
 * 本地同形副本已删除迁移（consumers.md 一④）。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ComputedRef } from 'vue'
import type { PlanStateView } from '@taiji/shared'
import {
  derivePhase,
  PLAN_LIFECYCLE_STATES,
  type PlanLifecycleState,
  type PlanReviewComment,
} from '@zhushanwen/extension-protocol'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import {
  getPendingRequests,
  type ExtensionUIRequest,
} from '@taiji/core/transport/api/domains/extension'
import { toErrorMessage } from '@taiji/core'
import {
  useSessionScopedState,
  registerSessionCleanup,
} from '@/composables/useSessionScopedState'

export type { PlanReviewComment }

/** 三步阶段指示值（D1 推导 + D5 已批准档；与设计 ①②③ 一一对应，i18n 文案归 PlanModeBar 状态带）。 */
export type PlanStage =
  | 'exploring' // ① 需求探索
  | 'writing' // ② 文档撰写
  | 'reviewing' // ③ 审阅确认（进行中）
  | 'approved' // ③ 审阅确认 · 已完成（✓）——approved/dispatching，阶段不倒退（F5）

/** 审批条分支模式（D4 分支公式输出；null = 不渲染）。 */
export type PlanReviewBarMode = 'ready' | 'revising' | 'degraded'

// ── D2 读方③ renderer 读侧兜底映射（混装格：state ?? reviewState 映射 ?? 按 isActive 推断）──

/**
 * PlanStateView → PlanLifecycleState 兜底解析（与读方① reconstructPlanState 同构）。
 * 新派生恒携带 `state`（D2 读方② 义务）；`state` 缺失 = 旧 runtime extractor 错配格
 * （旧 View 白名单剥未知字段且新 entry 已停写 reviewState），按 reviewState 映射
 * （awaiting→reviewing / revising→revising），仍无则按 isActive 推断（有 plan → planning，
 * 无 → idle）——行为退化为现状而非双盲（R2③）。运行时垃圾 state 值同样落兜底（不信任外部格式）。
 */
export function resolvePlanLifecycleState(view: PlanStateView | null): PlanLifecycleState {
  if (!view) return 'idle'
  const state = view.state
  if (state !== undefined && (PLAN_LIFECYCLE_STATES as readonly string[]).includes(state)) {
    return state
  }
  if (view.reviewState === 'awaiting') return 'reviewing'
  if (view.reviewState === 'revising') return 'revising'
  return view.isActive ? 'planning' : 'idle'
}

/**
 * resumeHint 解析（D2）：新字段直读；缺失时读旧字段 reviewStateSource（deprecated 只读
 * 兼容位）——`'resubmit'` 同义映射，其余/缺省 = 来源未知（不猜测来源）。
 */
export function resolveResumeHint(view: PlanStateView | null): 'resubmit' | undefined {
  if (!view) return undefined
  if (view.resumeHint === 'resubmit') return 'resubmit'
  if (view.reviewStateSource === 'resubmit') return 'resubmit'
  return undefined
}

/**
 * 三步阶段推导（D1：推导不落盘）——derivePhase 单点接线（consumers.md §三 C）。
 * @param view session 分区内的 PlanStateView（null = 无 plan 状态）
 * @returns 阶段指示；isActive=false / phase idle·terminal 时返回 null（PlanModeBar 由 isActive
 *          驱动消失，阶段随 PlanModeBar 不外显）。phase 'planning'（planning|revising）按
 *          docs 有无分 ①/②；phase 'reviewing' → ③ 进行中；phase 'approved'
 *          （approved|dispatching）→ ③ 已完成（✓）——执行方式表单挂起期间不打回 ②（F5）。
 */
export function derivePlanStage(view: PlanStateView | null): PlanStage | null {
  if (!view?.isActive) return null
  const phase = derivePhase(resolvePlanLifecycleState(view))
  if (phase === 'reviewing') return 'reviewing'
  if (phase === 'approved') return 'approved'
  if (phase === 'planning') return (view.docs?.length ?? 0) === 0 ? 'exploring' : 'writing'
  return null
}

/**
 * 审批条分支公式（D4 单源——禁止消费方各自拼并集，F1「两个事实源的并集祈祷一致」的反面）：
 * - `ready ⇔ 挂起 planReview 请求存在`（runtime 注册表投影，唯一交互权威；**presence 语义
 *   ——ready 恒优先渲染**，多挂起存量形态不被抑制窗压制）
 * - 抑制窗（ackMarked）压制一切 state 判定分支（degraded / revising）
 * - `revising ⇔ state=revising`（无挂起、无压制）
 * - `degraded ⇔ state=reviewing ∧ 无挂起 ∧ 稳定窗放行`（稳定窗 = 组合持续 ≥2s 或冷拉真值豁免）
 * - state=dispatching/approved 不进审批条（执行方式表单是其唯一交互面）；其余不渲染
 */
export interface PlanReviewBarModeInput {
  isActive: boolean
  hasPending: boolean
  state: PlanLifecycleState
  ackMarked: boolean
  degradedGate: boolean
}

export function derivePlanReviewBarMode(input: PlanReviewBarModeInput): PlanReviewBarMode | null {
  if (!input.isActive) return null
  if (input.hasPending) return 'ready'
  if (input.ackMarked) return null
  if (input.state === 'revising') return 'revising'
  if (input.state === 'reviewing' && input.degradedGate) return 'degraded'
  return null
}

// ── 审批窗口时序常量（D4）──

/** degraded 稳定窗：`state=reviewing ∧ 无挂起` 组合持续该时长后放行渲染（S15 五断言口径）。 */
export const PLAN_REVIEW_DEGRADED_STABLE_MS = 2_000
/** 已应答抑制窗兜底：标记置起后该时长未见预期后态帧 → 转双源冷拉对账（10s = 投影链路时延的量级冗余）。 */
export const PLAN_REVIEW_ACK_FALLBACK_MS = 10_000

/**
 * 活动补拉冷却（新 session 首拉窗口的丢帧补偿，2026-09-25 真机缺陷）：同一 session 的
 * assistant 消息活动触发 reconcileOnAssistantMessage 补拉的最小间隔。量级对齐
 * PLAN_REVIEW_ACK_FALLBACK_MS（投影链路时延冗余）取半——补拉是「状态可能已刷新」的
 * 对账而非异常恢复，频率上限取「每 turn 至多一次」的近似（turn 内多条 assistant 消息
 * 合并），避免长对话 session 每条消息一拉。
 */
export const PLAN_ACTIVITY_RECONCILE_COOLDOWN_MS = 5_000

/**
 * 冷拉对账「pending 在场」真值的再入店缝（store 禁 import store 铁律的合规绕行——
 * extension-ui registry 的唯一写入方 useExtensionUI 注册 sink；本 store 只广播事实，
 * registry 呈现 ready 由 sink 落店，respond 的 requestId 定位随之可用）。
 */
export type PlanReviewColdSink = (sessionId: string, records: ExtensionUIRequest[]) => void
let planReviewColdSink: PlanReviewColdSink | null = null

/** 注册冷拉 pending 再入店 sink（useExtensionUI 模块级一次；重复注册覆盖（后注册者持有当前 pinia 的惰性取店闭包））。 */
export function registerPlanReviewColdSink(sink: PlanReviewColdSink): void {
  planReviewColdSink = sink
}

/** 测试钩子：清 sink（模块级跨用例残留防护，对齐 __resetExtensionBusSubscriptionForTesting）。 */
export function __resetPlanReviewColdSinkForTesting(): void {
  planReviewColdSink = null
}

/** 分区容器（useSessionScopedState 响应式契约要求 reactive 容器：mutate 才触发下游 computed 失效）。 */
// @data-owner #36 —— #36 plan 审阅态的 renderer 消费分区（WS 帧 + 首拉 reply 双路喂入；
// 权威源/唯一写入口/空值语义见登记表主表 #36 行，非第二写方）。阶段指示 = derivePlanStage
// 纯推导（renderer 展示派生 SSOT），分区不落阶段字段。
interface PlanPartition {
  /** 最后一条 plan-state entry 的派生投影（D1）；null = 无 plan 状态（首拉空响应/无值） */
  view: PlanStateView | null
  /** 评论草稿（D6：GUI 草稿，提交时打包进 respond payload；per-session 隔离） */
  drafts: PlanReviewComment[]
  /** 首拉/冷拉失败错误（AGENTS.md 规则 5 错误通路：分区级落错误供 PlanModeBar / PlanDocsPanel 呈现，不覆盖现有 view） */
  loadError: string | null
  /**
   * 草稿回看请求（§3.5）：审批条评论计数可点 → requestDraftsReveal 递增序号并置
   * consumed=false；PlanDocsPanel 消费（滚动到草稿列表）后 markDraftsRevealConsumed。
   * 请求先于消费方挂载到达的窗口（drawer 关闭时 PlanDocsPanel 未挂载）由 consumed
   * 标记跨挂载保留——「未消费的回看请求」持久到消费为止，重复挂载不重滚。
   */
  draftsRevealSeq: number
  draftsRevealConsumed: boolean
  /**
   * 「已应答待帧」标记（D4 抑制窗①）：planReview 挂起被摘除（respond 成功 /
   * requestsInvalidated）即置起，压制 degraded/revising 的 state 判定分支到「预期后态帧」
   * （帧内 state ≠ reviewing 的值判定——迟到旧帧值仍是 reviewing 不解除）/ 新 planReview
   * pending 登记到达 / 10s 冷拉真值三路之一为止。presence 语义不受其压制（ready 恒优先）。
   */
  reviewAckMarked: boolean
  /** ack 标记/兜底定时器世代（epoch 世代比较：cancel·重置后陈旧定时器回调按世代失配 no-op）。 */
  reviewAckEpoch: number
  /**
   * planReview 挂起镜像（D4 稳定窗输入面；唯一写入口 = useExtensionUI 挂起漏斗 + 冷拉对账
   * ——registry 的同步投影，渲染公式仍以 registry presence 为唯一交互权威，本镜像只驱动
   * 定时器 arm/cancel 的组合判定）。
   */
  reviewPendingKnown: boolean
  /**
   * D8「agent 未响应」检测窗（per-session，分区派而非实例级 ref——turn 事件 handler 经
   * action 写「消息所属 sid」分区，切 session 无丢值/串台，ADR-0049）：nudge 发送成功即
   * 开窗，重挂到达（setPlanReviewPending(true) 内含收口）/ turn 结束判未响应后关窗。
   */
  reviewNudgeWatching: boolean
  /** D8 重新提交错误行（发送失败 / agent 未响应双分支的就近呈现；分区级，随焦点切换保留）。 */
  reviewNudgeError: string | null
  /** degraded 稳定窗放行（组合持续 ≥2s；变假 cancel·重置）。 */
  reviewDegradedStable: boolean
  /** 冷拉真值豁免稳定窗（对账结果即事实，直接放行；随组合变假同批重置）。 */
  reviewColdExempt: boolean
  /** 稳定窗定时器世代（同 reviewAckEpoch 纪律）。 */
  reviewStableEpoch: number
}

/**
 * enter 翻转清兜底（§3.5）：sid 分区内 isActive 旧值 false→有 的翻转（新一轮 plan 进入）
 * 清该 sid 残留草稿——新审阅轮 = 干净草稿区。覆盖 agent 自退 / 崩溃等绕过 GUI 确认的
 * 路径（C-U2 退出路径变体：不兜底则同 session 再进 plan 时审批条显旧计数、误注入旧评论）。
 *
 * 设计禁令（§3.5 落点定死）：本兜底只允许挂在本 store 的分区写入共同出口（applyFrame 与
 * loadPlanState 双路 updateFor 内、写 view 前对比旧值），**禁止改挂「组件 watch 焦点视图」
 * 落点**——从非 plan session 切到审阅中的 plan session 时焦点视图 isActive 呈假「无→有」
 * 翻转，会误清该 session 正在审阅的草稿。本函数按 sid 分区对比新旧 view，不读焦点实时值，
 * WS 帧 / 首拉两条写路径天然同覆。
 */
function clearDraftsOnPlanEnter(p: PlanPartition, next: PlanStateView | null): void {
  const wasActive = p.view?.isActive === true
  const nowActive = next?.isActive === true
  if (!wasActive && nowActive) p.drafts.length = 0
}

export const usePlanStore = defineStore('plan', () => {
  // ── 分区（useSessionScopedState 工厂：分区表 + cleanup 链自动接入）──
  /**
   * 焦点 session id（分区 current 与草稿操作的绑定目标）。由 use-plan-sync 从 panel store
   * 的 focusedSessionId 注入（syncFocus）——store 自身不 import 其他 store（铁律）。
   */
  const focusedSid = ref<string | null>(null)
  const scoped = useSessionScopedState<PlanPartition>(focusedSid, () =>
    reactive<PlanPartition>({
      view: null,
      drafts: [],
      loadError: null,
      draftsRevealSeq: 0,
      draftsRevealConsumed: true,
      reviewAckMarked: false,
      reviewAckEpoch: 0,
      reviewPendingKnown: false,
      reviewDegradedStable: false,
      reviewColdExempt: false,
      reviewStableEpoch: 0,
      reviewNudgeWatching: false,
      reviewNudgeError: null,
    }),
  )

  // ── 陈旧首拉守卫（F-R2-1，per-sid 帧版本号）──
  /**
   * 每次 applyFrame 递增的 per-sid 版本号。loadPlanState 发请求前记录基准，reply 到达时
   * 版本已变 = 「请求在途窗口内该 session 收到过 live 帧」——reply 是更早启动的冷读
   * （runtime 冷腿 = scanSessions(force) 全目录重扫 + 直读 JSONL，秒级抖动常见），而帧是
   * live 权威（state topic last-value）；放行陈旧 reply 会把帧已写入的 view 倒拨回空
   * （真机复现：新会话首条消息 /plan 毫秒级落盘 entry，首拉空 reply 晚于 live 帧到达，
   * view 被抹回 null 后无再拉触发点 → bar 90s 不显形）。守卫语义 = 冷回填不得倒拨热状态，
   * 不改变「切会话/冷启动主动拉取优先于依赖 broadcast」的架构语义（首拉仍是唯一冷路径，
   * 只对「已确认更老」的 reply 丢弃）；无轮询、无重试、无定时器，比较是有界的等值判定。
   * 失败分支同守卫：失效请求的 error envelope 同样不代表当前链路（帧已活，错误已过时）。
   * 清理挂 sessionCleanup 链（useSidebar.deleteSession 统一编排，与分区同生命周期）。
   */
  const frameRevs = new Map<string, number>()

  /**
   * 活动补拉冷却表（per-sid 上次活动补拉时间戳；新 session 首拉窗口丢帧补偿）。
   * 语义见 reconcileOnAssistantMessage。清理挂 sessionCleanup 链（与 frameRevs 同批）。
   */
  const activityReconcileAt = new Map<string, number>()

  /**
   * 消息边沿观察的帧基准表（per-sid：上一条消息边沿时的 frameRev，活跃冻结检测的进展基准，
   * 语义见 reconcileOnAssistantMessage）。清理挂 sessionCleanup 链。
   */
  const edgeFrameRevs = new Map<string, number>()

  // ── 审批窗口 per-session 定时器（D4：2s 稳定窗 + 10s 兜底共 ≤2 个，single-flight 重置不叠加）──
  // 定时器 handle 不进响应式分区（副作用句柄非状态）；epoch 世代在分区内（回调比较防陈旧触发）。
  // 清理与 frameRevs 同挂 sessionCleanup 链（防 session 销毁后定时器空转写幽灵分区）。
  const stableTimers = new Map<string, { epoch: number; handle: ReturnType<typeof setTimeout> }>()
  const ackTimers = new Map<string, { epoch: number; handle: ReturnType<typeof setTimeout> }>()

  registerSessionCleanup((sid) => {
    frameRevs.delete(sid)
    activityReconcileAt.delete(sid)
    edgeFrameRevs.delete(sid)
    const stable = stableTimers.get(sid)
    if (stable) {
      clearTimeout(stable.handle)
      stableTimers.delete(sid)
    }
    const ack = ackTimers.get(sid)
    if (ack) {
      clearTimeout(ack.handle)
      ackTimers.delete(sid)
    }
  })

  /** 当前帧版本号（无帧历史 = 0）。 */
  function frameRevOf(sid: string): number {
    return frameRevs.get(sid) ?? 0
  }

  // ── 审批窗口内部机件（D4）──

  /** 变假 cancel·重置：清稳定窗放行位 + 杀在途 2s 定时器（epoch 递增使陈旧回调 no-op）。 */
  function cancelStableWindow(sid: string, p: PlanPartition): void {
    p.reviewDegradedStable = false
    p.reviewColdExempt = false
    p.reviewStableEpoch += 1
    const t = stableTimers.get(sid)
    if (t) {
      clearTimeout(t.handle)
      stableTimers.delete(sid)
    }
  }

  /** 解除已应答标记（三解除路径共用）：清标记 + 杀 10s 兜底定时器。 */
  function clearAckMark(sid: string, p: PlanPartition): void {
    p.reviewAckMarked = false
    p.reviewAckEpoch += 1
    const t = ackTimers.get(sid)
    if (t) {
      clearTimeout(t.handle)
      ackTimers.delete(sid)
    }
  }

  /**
   * 稳定窗组合判定 + 定时器 arm/cancel（每次窗口输入变化后调用）：
   * 组合 = `view 活跃 ∧ state=reviewing ∧ 无挂起镜像 ∧ 无已应答标记`。
   * 组合转真 → arm 2s（已在计时则不动——「组合持续 ≥2s」语义，重复触发不重启时钟）；
   * 组合变假 → cancel·重置；组合真且已放行（稳定/冷拉豁免）→ 保持。
   */
  function evalReviewWindow(sid: string, p: PlanPartition): void {
    const candidate =
      p.view?.isActive === true &&
      resolvePlanLifecycleState(p.view) === 'reviewing' &&
      !p.reviewPendingKnown &&
      !p.reviewAckMarked
    if (!candidate) {
      cancelStableWindow(sid, p)
      return
    }
    if (p.reviewDegradedStable || p.reviewColdExempt) return
    if (stableTimers.has(sid)) return
    p.reviewStableEpoch += 1
    const epoch = p.reviewStableEpoch
    const handle = setTimeout(() => {
      stableTimers.delete(sid)
      scoped.updateFor(sid, (q) => {
        // epoch 世代比较：组合中途变假已 cancel·重置，本回调是陈旧残留（微任务/定时器序竞态）→ no-op
        if (q.reviewStableEpoch !== epoch) return
        q.reviewDegradedStable = true
      })
    }, PLAN_REVIEW_DEGRADED_STABLE_MS)
    stableTimers.set(sid, { epoch, handle })
  }

  /** view 写入共同后置（帧 / 首拉 / 冷拉三路同覆）：预期后态值解除已应答标记 + 稳定窗重估。 */
  function afterViewWrite(sid: string, p: PlanPartition): void {
    // 解除②的值判定半边：收到的 state 值 ≠ reviewing = 预期后态帧（dismiss / review_aborted→
    // planning、approve→dispatching、revise→revising、exit→exited 全命中）；迟到旧帧值仍是
    // reviewing 不解除（D4②）。
    if (resolvePlanLifecycleState(p.view) !== 'reviewing') clearAckMark(sid, p)
    evalReviewWindow(sid, p)
  }

  // ── actions ──

  /** 焦点同步（use-plan-sync 在挂载/切换时点调用；草稿操作与新写入的 current 视图随之对齐）。 */
  function syncFocus(sid: string | null): void {
    focusedSid.value = sid
  }

  /**
   * WS 帧落地（session.planState 广播）：写「消息所属 sid」分区——内部 updateFor(capturedSid)，
   * 不读焦点实时值，切 session 的异步退订窗口内迟到帧只写旧 sid 分区（AGENTS.md 规则 8，
   * 结构性消除竞态）。帧是 live 权威数据，落地同时清首拉错误（链路已活，错误已过时）；
   * 落地同时递增该 sid 帧版本号（陈旧首拉守卫的写侧，见 frameRevs 注释）。
   */
  function applyFrame(sid: string, planState: PlanStateView): void {
    frameRevs.set(sid, frameRevOf(sid) + 1)
    scoped.updateFor(sid, (p) => {
      clearDraftsOnPlanEnter(p, planState)
      p.view = planState
      p.loadError = null
      afterViewWrite(sid, p)
    })
  }

  /**
   * 首拉（D1⑥：stateSnapshot 是 bus 内存态，冷启动/切换靠本 RPC 冷路径）。
   *
   * AGENTS.md 规则 5（sendCommand 后检查 reply success）：renderer 端 error envelope 由
   * core transport 层转为 command promise reject，本函数 catch 即「success=false」分支——
   * 错误落分区 loadError（PlanModeBar / PlanDocsPanel 消费呈现），不覆盖现有 view（失败兜底显示，下次切入
   * 重拉自愈，subagent loadSubagents M1 同款）。
   *
   * 响应空/无 planState = 无 plan 状态，分区 view 置空（协议 planState 必填，运行时仍防御
   * 旧 runtime / mock 缺省——unknown 形状经 `?? null` 守卫收敛）。
   *
   * 陈旧 reply 丢弃（F-R2-1 守卫，读侧）：请求发出时记录该 sid 帧版本基准，reply 到达时
   * 版本已变 = 在途窗口内收到过 live 帧 → 本 reply 是更早的冷读，整体丢弃（成功与失败
   * 分支同守卫）。请求在途时新发起的 loadPlanState 以其发出时刻的版本为基准，不受本轮
   * 丢弃影响（切回重拉场景：越晚发出的请求基准越新，reply 正常回填）。
   */
  async function loadPlanState(sessionId: string): Promise<void> {
    if (!sessionId) return
    const baseRev = frameRevOf(sessionId)
    try {
      const reply = await command('session.getPlanState', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
      if (frameRevOf(sessionId) !== baseRev) return
      const planState = reply?.planState ?? null
      scoped.updateFor(sessionId, (p) => {
        clearDraftsOnPlanEnter(p, planState)
        p.view = planState
        p.loadError = null
        afterViewWrite(sessionId, p)
      })
    } catch (e) {
      if (frameRevOf(sessionId) !== baseRev) return
      const msg = toErrorMessage(e)
      console.error('[plan-store] getPlanState failed:', e)
      scoped.updateFor(sessionId, (p) => {
        p.loadError = msg
      })
    }
  }

  /**
   * 活动信号补拉（2026-09-25 真机缺陷「新 session 发 /plan 状态带不渲染」的丢帧补偿，
   * 同日 F-W3-2「崩溃恢复后阶段指示冻结」扩展为双支路）。
   *
   * 补偿锚点 = assistant 消息活动（use-plan-sync 订阅 message.message_start /
   * message.complete 转发）：/plan 处理写 plan entry 是 turn 的前置动作，必然早于
   * assistant 消息开始，故活动信号到达时磁盘必已就绪，冷拉直读磁盘（runtime
   * getPlanState 纯磁盘读语义）必得真值。范式对齐 useCommandSync 补拉闭环（消费侧
   * 动作边沿触发主动拉取，不依赖 broadcast 可靠性）。
   *
   * 双支路（共享冷却门）：非活跃支路（fix-C 原语义）= 分区 view 未激活（首拉早于
   * entry 落盘 / 从未进 plan）→ 补拉。活跃冻结支路（F-W3-2）= view 活跃但 frameRev
   * 自上一条消息边沿以来无增长 → planState 帧链在该 session 上疑死（真机 6c3 实证：
   * 消息帧正常到达而 planState 帧全程未达，view 冻结无再拉触发点），冷拉对账磁盘真值；
   * 帧链恢复（任一 planState 帧到达 → frameRev 增长）后自动静默；首条边沿只立帧基准
   * 不拉（健康链路上 plan 状态稳定的常态 turn 不产生补拉）。双门限频（无定时器无轮询）：
   * 冷却门 = PLAN_ACTIVITY_RECONCILE_COOLDOWN_MS 内同 sid 不重复补（长对话每条消息
   * 都触发的频率上限）；帧进展门 = 活跃支路要求「边沿间 frameRev 零增长」。
   */
  function reconcileOnAssistantMessage(sessionId: string): void {
    if (!sessionId) return
    const revNow = frameRevOf(sessionId)
    const prevRev = edgeFrameRevs.get(sessionId)
    edgeFrameRevs.set(sessionId, revNow)
    let inactive = false
    scoped.updateFor(sessionId, (p) => {
      inactive = p.view?.isActive !== true
    })
    // 帧进展门：活跃支路要求「边沿间 frameRev 零增长」；非活跃时 frameRev 常为 0，「无进展」无判别力，不适用
    if (!inactive && (prevRev === undefined || prevRev !== revNow)) return
    // 冷却门（两支路共用）
    const last = activityReconcileAt.get(sessionId) ?? 0
    if (Date.now() - last < PLAN_ACTIVITY_RECONCILE_COOLDOWN_MS) return
    activityReconcileAt.set(sessionId, Date.now())
    void loadPlanState(sessionId)
  }

  // ── 审批窗口 actions（D4；写入口 = useExtensionUI 挂起漏斗 + 10s 兜底冷拉）──

  /**
   * planReview 挂起镜像同步（D4 抑制窗②的「新 pending 登记到达解除标记」半边）：
   * has=true（新挂起入店）→ 解除已应答标记（挂起 = 唯一交互权威、ready 优先于抑制——
   * 提前清压制，防 revising 帧丢失时压制拖到兜底超时）；has=false → 只更新镜像。
   * 幂等（重复漏斗点调用无副作用）。
   */
  function setPlanReviewPending(sessionId: string, has: boolean): void {
    if (!sessionId) return
    scoped.updateFor(sessionId, (p) => {
      p.reviewPendingKnown = has
      if (has) {
        clearAckMark(sessionId, p)
        // D8 成功收口（内含于挂起到达）：预期重挂发生 → 关检测窗 + 清旧错误（含重试后成功）
        p.reviewNudgeWatching = false
        p.reviewNudgeError = null
      }
      evalReviewWindow(sessionId, p)
    })
  }

  /**
   * 已应答标记置起（D4 抑制窗①触发：planReview 挂起被 respond 成功 / requestsInvalidated
   * 摘除的任何路径）：压制 degraded/revising 到预期后态帧 / 新 pending / 冷拉真值三路之一；
   * 同时 arm 10s 双源冷拉兜底（single-flight：重复触发重置不叠加）。
   */
  function markPlanReviewAnswered(sessionId: string): void {
    if (!sessionId) return
    scoped.updateFor(sessionId, (p) => {
      p.reviewAckMarked = true
      // 镜像真值不由本函数覆写：reviewPendingKnown 由 useExtensionUI 挂起漏斗按 registry
      // 现值收口（syncPlanReviewWindow）/冷拉对账真值置位——无条件置 false 会在多挂起异常
      // 形态（一条应答消费、registry 仍有挂起）把镜像打假（违反漏斗自述不变量）
      p.reviewAckEpoch += 1
      const epoch = p.reviewAckEpoch
      const prev = ackTimers.get(sessionId)
      if (prev) clearTimeout(prev.handle)
      const handle = setTimeout(() => {
        ackTimers.delete(sessionId)
        // epoch 世代比较：标记已被解除路径处理/重置（epoch 已递增）→ 陈旧兜底 no-op
        let stale = false
        scoped.updateFor(sessionId, (q) => {
          if (q.reviewAckEpoch !== epoch) stale = true
        })
        if (stale) return
        void coldReconcilePlanReview(sessionId)
      }, PLAN_REVIEW_ACK_FALLBACK_MS)
      ackTimers.set(sessionId, { epoch, handle })
      evalReviewWindow(sessionId, p)
    })
  }

  /**
   * 10s 兜底的双源冷拉对账（D4 抑制窗③）：`session.getPlanState` + `getPendingRequests`
   * 双查询——「事实上无挂起」必须查询而非断言。
   * - 成功：冷拉落地即以真值解除标记（不无条件亮 degraded）；pending 在场 → 经 sink 再入店
   *   registry 呈 ready（权威优先），不在场 + 真值 reviewing → 冷拉真值豁免稳定窗直通
   *   degraded；planState 真值按 F-R2-1 帧版本守卫回填（冷回填不倒拨热状态）。
   * - 失败（WS 断连——恰是帧丢失主因，两通道同源失败相关性高）：标记悬挂（审批条保持
   *   不渲染，fail-safe 不误导）+ loadError 既有错误通路呈现（R7 失败分支）；重连后经
   *   stateSnapshot 重派发 / 再次触发自然解除。
   */
  async function coldReconcilePlanReview(sessionId: string): Promise<void> {
    const baseRev = frameRevOf(sessionId)
    const [planRes, pendingRes] = await Promise.allSettled([
      command('session.getPlanState', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS),
      getPendingRequests(sessionId),
    ])
    if (planRes.status === 'rejected' || pendingRes.status === 'rejected') {
      const err =
        planRes.status === 'rejected' ? planRes.reason : (pendingRes as PromiseRejectedResult).reason
      console.error('[plan-store] plan review cold reconcile failed:', err)
      scoped.updateFor(sessionId, (p) => {
        p.loadError = toErrorMessage(err)
      })
      return
    }
    const planState = planRes.value?.planState ?? null
    const planReviewRecords = pendingRes.value.filter(isPlanReviewFrameRecord)
    // pending 在场真值 → 再入店 registry（呈 ready 需可枚举 requestId；sink = useExtensionUI
    // 注册的 registry 写入缝，幂等 dedup）
    if (planReviewRecords.length > 0) planReviewColdSink?.(sessionId, planReviewRecords)
    scoped.updateFor(sessionId, (p) => {
      p.loadError = null
      clearAckMark(sessionId, p) // 冷拉落地即以真值解除标记（③解除路径）
      p.reviewPendingKnown = planReviewRecords.length > 0
      p.reviewColdExempt = true // 冷拉真值豁免稳定窗（对账结果即事实，直接放行）
      if (frameRevOf(sessionId) === baseRev) {
        clearDraftsOnPlanEnter(p, planState)
        p.view = planState
      }
      afterViewWrite(sessionId, p)
    })
  }

  // ── D8 重新提交审批的检测窗/错误行（分区级，action 收口供事件 handler 经 capturedSid 写入）──

  /** nudge 发送成功：开「agent 未响应」检测窗（清旧错误）。 */
  function beginPlanReviewNudge(sessionId: string): void {
    if (!sessionId) return
    scoped.updateFor(sessionId, (p) => {
      p.reviewNudgeWatching = true
      p.reviewNudgeError = null
    })
  }

  /**
   * nudge 错误行写入/清除（发送失败分支落文案；null = 清除）。无检测窗语义，直接落分区。
   */
  function setPlanReviewNudgeError(sessionId: string, message: string | null): void {
    if (!sessionId) return
    scoped.updateFor(sessionId, (p) => {
      p.reviewNudgeWatching = false
      p.reviewNudgeError = message
    })
  }

  /**
   * turn 生命周期信号收口（D8 失败契约②「agent 未响应」）：检测窗开着才判——重挂已到达
   * 的同轮收尾（窗口已被 setPlanReviewPending(true) 关闭）/ 未点重提（未开窗）均 no-op。
   */
  function endPlanReviewNudge(sessionId: string, message: string): void {
    if (!sessionId) return
    scoped.updateFor(sessionId, (p) => {
      if (!p.reviewNudgeWatching) return
      p.reviewNudgeWatching = false
      p.reviewNudgeError = message
    })
  }

  // ── 评论草稿操作（D6：只作用当前焦点 session 分区；scoped.update 读 focusedSid 实时值）──

  /** 加一条评论草稿（拷贝入列，防调用方持有外部引用后续 mutate 串进分区）。 */
  function addDraftComment(comment: PlanReviewComment): void {
    scoped.update((p) => {
      p.drafts.push({ quote: comment.quote, comment: comment.comment })
    })
  }

  /** 按序号删一条评论草稿（越界 no-op——u1-docs-panel 的浮条删除按草稿数组序号定位）。 */
  function removeDraftComment(index: number): void {
    scoped.update((p) => {
      if (index >= 0 && index < p.drafts.length) p.drafts.splice(index, 1)
    })
  }

  /** 清空焦点分区评论草稿（提交成功后由 PlanReviewBar 审批条调用；dismiss=暂存待办不清）。 */
  function clearDraftComments(): void {
    scoped.update((p) => {
      p.drafts.length = 0
    })
  }

  // ── 草稿回看请求（§3.5：审批条评论计数可点 → drawer 计划产物 tab 滚动到草稿列表）──

  /** 发一次回看请求（焦点分区：seq 递增 + consumed 复位；消费方 = PlanDocsPanel）。 */
  function requestDraftsReveal(): void {
    scoped.update((p) => {
      p.draftsRevealSeq += 1
      p.draftsRevealConsumed = false
    })
  }

  /** 标记回看请求已消费（滚动完成或无可滚目标；防 drawer 重开/重挂载重复滚动）。 */
  function markDraftsRevealConsumed(): void {
    scoped.update((p) => {
      p.draftsRevealConsumed = true
    })
  }

  // ── 焦点只读视图（派生量不落盘：阶段由 derivePlanStage 推导，docs 与 skills 两字段原样透出供降级判定——D4）──

  /** 焦点 session 的 PlanStateView（null = 无 plan 状态）。 */
  const planView: ComputedRef<PlanStateView | null> = computed(() => scoped.current.value.view)

  /** 焦点 session 的三步阶段指示（D1 推导 + D5 已批准档，见 derivePlanStage）。 */
  const planStage: ComputedRef<PlanStage | null> = computed(() => derivePlanStage(scoped.current.value.view))

  /** 焦点 session 的评论草稿（只读视图，操作走 add/remove/clear 三个 action 收口）。 */
  const draftComments: ComputedRef<PlanReviewComment[]> = computed(() => scoped.current.value.drafts)

  /** 焦点 session 的首拉/冷拉错误（null = 无错误；非空时由 PlanModeBar / PlanDocsPanel 呈现错误态）。 */
  const planLoadError: ComputedRef<string | null> = computed(() => scoped.current.value.loadError)

  /** 焦点分区回看请求序号（watch 源：递增即新请求）。 */
  const draftsRevealSeq: ComputedRef<number> = computed(() => scoped.current.value.draftsRevealSeq)

  /** 焦点分区是否存在未消费的回看请求（PlanDocsPanel 消费门）。 */
  const draftsRevealPending: ComputedRef<boolean> = computed(
    () => scoped.current.value.draftsRevealSeq > 0 && !scoped.current.value.draftsRevealConsumed,
  )

  /** 焦点分区「已应答抑制窗」标记（PlanReviewBar 分支公式的压制输入）。 */
  const planReviewAckMarked: ComputedRef<boolean> = computed(() => scoped.current.value.reviewAckMarked)

  /**
   * 焦点分区 planReview 挂起镜像（D4 稳定窗输入面的只读透出；**非渲染权威**——审批条
   * presence 判定以 registry（useExtensionUI currentPlanReviewRequests）为唯一交互权威，
   * 本视图供漏斗一致性断言/诊断读取，多挂起异常形态下必须与 registry 同真）。
   */
  const planReviewPendingKnown: ComputedRef<boolean> = computed(
    () => scoped.current.value.reviewPendingKnown,
  )

  /** 焦点分区「agent 未响应」检测窗（D8；PlanReviewBar/测试读取）。 */
  const planReviewNudgeWatching: ComputedRef<boolean> = computed(
    () => scoped.current.value.reviewNudgeWatching,
  )

  /** 焦点分区重新提交错误行文案（null = 无错误；PlanReviewBar 就近呈现）。 */
  const planReviewNudgeError: ComputedRef<string | null> = computed(
    () => scoped.current.value.reviewNudgeError,
  )

  /** 焦点分区 degraded 稳定窗放行位（稳定窗通过 ∨ 冷拉真值豁免）。 */
  const planReviewDegradedGate: ComputedRef<boolean> = computed(
    () => scoped.current.value.reviewDegradedStable || scoped.current.value.reviewColdExempt,
  )

  return {
    focusedSid,
    syncFocus,
    applyFrame,
    loadPlanState,
    reconcileOnAssistantMessage,
    coldReconcilePlanReview,
    setPlanReviewPending,
    markPlanReviewAnswered,
    beginPlanReviewNudge,
    setPlanReviewNudgeError,
    endPlanReviewNudge,
    addDraftComment,
    removeDraftComment,
    clearDraftComments,
    requestDraftsReveal,
    markDraftsRevealConsumed,
    planView,
    planStage,
    draftComments,
    planLoadError,
    draftsRevealSeq,
    draftsRevealPending,
    planReviewAckMarked,
    planReviewDegradedGate,
    planReviewPendingKnown,
    planReviewNudgeWatching,
    planReviewNudgeError,
  }
})

/** planReview 帧记录判定（runtime pending 快照的 payload 解包形态，planReview 标记在顶层）。 */
function isPlanReviewFrameRecord(req: ExtensionUIRequest): boolean {
  return (req as { planReview?: unknown }).planReview === true
}
