/**
 * usePlanState —— plan 模式状态的组件消费接口（u1-store：分区状态源在 plan-store，
 * 本 composable 负责「焦点同步 + 首拉触发 + WS 订阅」的编排）。
 *
 * 三条链路（范式对齐 useGenStats 五件套与 useListSync 首拉形态）：
 * 1. 焦点同步 + 首拉（同一个 watch immediate 承载——挂载与切换合一时点，useListSync 先例）：
 *    sessionIdRef → planStore.syncFocus（分区 current 与草稿操作对齐焦点）→
 *    planStore.loadPlanState（session.getPlanState RPC 冷路径，D1⑥；reply success 检查
 *    失败走分区 loadError 错误通路——AGENTS.md 规则 5；响应空/无 planState 置空分区）。
 * 2. WS 订阅：session.planState 帧 handler 捕获订阅时 sid（useSessionEvents 第二参数），
 *    经 store.applyFrame 写「消息所属 sid」分区——updateFor(capturedSid) 在 store 内完成，
 *    本层不持裸分区写入口（AGENTS.md 规则 8：WS handler 禁裸 update，切 sid 竞态结构性消除）。
 * 3. 视图透出：view / stage / drafts / loadError 经 storeToRefs 透出（保响应性），草稿操作
 *    转发 store action（只作用焦点分区）。
 *
 * 必须在组件 setup 同步调用（内部 useSessionEvents 有 getCurrentInstance 守卫）。
 * 消费方（u1-banner 横幅/审批条、u1-docs-panel）：传 panel store 的 focusedSessionId
 * （横幅/审批条只服务焦点 session 的显示语义，D1）。
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
