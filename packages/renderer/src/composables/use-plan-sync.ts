/**
 * usePlanState —— plan 模式状态的组件消费接口（u1-store：分区状态源在 plan-store，
 * 本 composable 负责「焦点同步 + 首拉触发 + WS 订阅 + 活动补拉转发」的编排）。
 *
 * 四条链路（范式对齐 useGenStats 五件套与 useListSync 首拉形态）：
 * 1. 焦点同步 + 首拉（同一个 watch immediate 承载——挂载与切换合一时点，useListSync 先例）：
 *    sessionIdRef → planStore.syncFocus（分区 current 与草稿操作对齐焦点）→
 *    planStore.loadPlanState（session.getPlanState RPC 冷路径，D1⑥；reply success 检查
 *    失败走分区 loadError 错误通路——AGENTS.md 规则 5；响应空/无 planState 置空分区）。
 * 2. WS 订阅：session.planState 帧 handler 捕获订阅时 sid（useSessionEvents 第二参数），
 *    经 store.applyFrame 写「消息所属 sid」分区——updateFor(capturedSid) 在 store 内完成，
 *    本层不持裸分区写入口（AGENTS.md 规则 8：WS handler 禁裸 update，切 sid 竞态结构性消除）。
 * 3. 视图透出：view / stage / drafts / loadError 经 storeToRefs 透出（保响应性），草稿操作
 *    转发 store action（只作用焦点分区）。
 * 4. 活动补拉转发（2026-09-25 真机缺陷修复）：message.complete（assistant 消息完成）→
 *    store.reconcileOnAssistantMessage——新 session 首拉窗口「首拉早于 entry 落盘 + 帧
 *    不可靠」双断后的再拉触发点，限频门内聚在 store。
 *
 * 必须在组件 setup 同步调用（内部 useSessionEvents 有 getCurrentInstance 守卫）。
 * 消费方（plan-mode-ux-refactor u-plan-bar 起：PlanModeBar 常驻宿主 + 其右区 PlanReviewBar、
 * u1-docs-panel 的 PlanDocsPanel）：传 panel store 的 focusedSessionId（plan 面只服务焦点
 * session 的显示语义，D1）。focusedSid 注入义务原在横幅/审批条（已删/改挂），现由
 * PlanModeBar setup 承接（新宿主 Panel.vue）。
 */
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { ComputedRef, Ref } from 'vue'
import type { PlanStateView } from '@taiji/shared'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { usePlanStore } from '@/stores/plan-store'
import type { PlanReviewComment, PlanStage } from '@/stores/plan-store'

export interface UsePlanStateReturn {
  /** 焦点 session 的 PlanStateView（null = 无 plan 状态） */
  view: ComputedRef<PlanStateView | null>
  /** 三步阶段指示（D1 推导三元组：① exploring / ② writing / ③ reviewing；非激活为 null） */
  stage: ComputedRef<PlanStage | null>
  /** 焦点 session 的评论草稿（per-session 隔离；操作走 addDraft/removeDraft/clearDrafts） */
  drafts: ComputedRef<PlanReviewComment[]>
  /** 首拉失败错误（null = 无错误；非空时组件呈现错误态） */
  loadError: ComputedRef<string | null>
  /** 加一条评论草稿（焦点分区） */
  addDraft: (comment: PlanReviewComment) => void
  /** 按序号删一条评论草稿（焦点分区；越界 no-op） */
  removeDraft: (index: number) => void
  /** 清空焦点分区评论草稿（提交成功后调用） */
  clearDrafts: () => void
}

export function usePlanState(sessionIdRef: Ref<string | null | undefined>): UsePlanStateReturn {
  const store = usePlanStore()
  // null 归一：useSessionScopedState 契约要求 Ref<string|null>（null=无活跃 session）
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  /**
   * 焦点同步 + 首拉触发（immediate：挂载与切换合一时点；null sid 只同步焦点不拉——
   * 首拉 RPC 的 sessionId 白名单由 store.loadPlanState 内守卫兜底）。
   */
  watch(
    normalizedSid,
    (sid) => {
      store.syncFocus(sid)
      if (sid) void store.loadPlanState(sid)
    },
    { immediate: true },
  )

  // WS 订阅：handler 第二参数 = 订阅时捕获的 sid（useSessionEvents 契约），帧写入「消息
  // 所属 sid」分区，不读焦点实时值——异步退订窗口内的旧 sid 迟到帧不污染新 sid 分区。
  const onMessage = useSessionEvents(sessionIdRef)
  onMessage('session.planState', (msg, sid) => {
    store.applyFrame(sid, msg.payload.planState)
  })
  // 链路 4（活动信号补拉，2026-09-25 真机缺陷「新 session 发 /plan 状态带不渲染」）：
  // assistant 消息活动（message_start = turn 内最早稳定信号，message.complete 兜底长
  // turn 多消息场景）= 该 session 有 agent 活动、plan 状态可能已刷新的边沿——转发
  // store.reconcileOnAssistantMessage（非活跃门 + 冷却门内聚在 store，见其头注释）。
  // 补的是「首拉早于 plan-state entry 落盘 + session.planState 帧在创建窗口不可靠
  // （早于订阅送达 / 未发布）」两条腿全断后的再拉触发点（范式对齐 useCommandSync
  // 补拉闭环：消费侧动作边沿主动拉取，不依赖 broadcast）。plan entry 落盘（/plan 处
  // 理前置动作）必然早于 assistant 消息开始，故活动信号到达时磁盘必已就绪。
  onMessage(['message.message_start', 'message.complete'], (_msg, sid) => {
    store.reconcileOnAssistantMessage(sid)
  })

  // 经 storeToRefs 透出（store 实例属性访问会解包 computed 丢 ref 形态，必须走 storeToRefs）
  const { planView, planStage, draftComments, planLoadError } = storeToRefs(store)

  return {
    view: planView,
    stage: planStage,
    drafts: draftComments,
    loadError: planLoadError,
    addDraft: store.addDraftComment,
    removeDraft: store.removeDraftComment,
    clearDrafts: store.clearDraftComments,
  }
}
