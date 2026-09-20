/**
 * Plan store —— plan 模式重设计 u1-store：per-session 的 PlanStateView + 评论草稿状态源
 * （设计 .tmp/tech-design/plan-mode-redesign.md §3.3-D1⑥ 冷启动首拉 / D6 评论生命周期）。
 *
 * 职责：
 * - 分区：per-session Map 分区走 useSessionScopedState 工厂（ADR-0049 Map 分区派）。
 *   分区表建在本 pinia store 单例内——WS 帧写入（use-plan-sync）与组件视图（usePlanState）
 *   消费同一张表；工厂 setup 时自动 registerSessionCleanup → useSidebar.deleteSession
 *   清理链，免 ADR-0049 例外登记。切走不清、切回恢复；session 销毁精确释放。
 * - 评论草稿（D6）：提交前是本 store 草稿（内存态，刷新丢失可接受——与 composer 草稿同
 *   语义），提交时由 u1-banner 审批条打包进 respond payload 注入对话流持久。加/删/清空
 *   只作用于当前焦点 session 分区（scoped.update 读 focusedSid 实时值，null sid 工厂内建 no-op）。
 * - 三步阶段指示（D1，推导不落盘，ext-simplify-06「可推导信息不落盘」延续）：
 *   ① 需求探索 = isActive && !docs.length；② 文档撰写 = isActive && docs.length ≥ 1 &&
 *   无 reviewState；③ 审阅确认 = reviewState ∈ {awaiting, revising}。derivePlanStage
 *   纯函数承载，分区不存阶段字段。
 *
 * 与 WS/RPC 的接线边界：本 store 只持状态与操作（applyFrame / loadPlanState），订阅与
 * 首拉触发编排归 composables/use-plan-sync.ts（usePlanState）。
 *
 * stores 间依赖方向：无（不 import 其他 store）。焦点 sid 由 use-plan-sync 从 panel store
 * 读取后经 syncFocus 注入（跨 store 编排在 composable 层，useListSync 先例）。
 *
 * PlanReviewComment 本地同形说明：契约根在 extension-protocol core/types（u-foundation，
 * 字段 { quote: 划选引文, comment: 评语 }）；renderer 不依赖 extension-protocol（同
 * shared PlanDocMeta 的多端同形惯例——最底层共享包不反向依赖，形状漂移由双端契约测试守卫）。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ComputedRef } from 'vue'
import type { PlanStateView } from '@taiji/shared'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { toErrorMessage } from '@taiji/core'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

/** 用户对某文档划选段落的一条评论（与 extension-protocol core/types PlanReviewComment 同形，见文件头说明）。 */
export interface PlanReviewComment {
  /** 划选引文（agent 定位段落用） */
  quote: string
  /** 评语 */
  comment: string
}

/** 三步阶段指示值（D1 推导三元组；与设计编号 ①②③ 一一对应，i18n 文案归 u1-banner）。 */
export type PlanStage =
  | 'exploring' // ① 需求探索
  | 'writing' // ② 文档撰写
  | 'reviewing' // ③ 审阅确认

/**
 * 三步阶段推导（D1：推导不落盘）。
 * @param view session 分区内的 PlanStateView（null = 无 plan 状态）
 * @returns 阶段指示；isActive=false（退出/执行后）或无 view 时返回 null——横幅由 isActive
 *          驱动消失，阶段随横幅不外显。reviewState 优先于 docs 判定（③ 公式不含 docs 条件；
 *          isActive 门兜住 reset 终态矩阵之外的异常组合）。
 */
export function derivePlanStage(view: PlanStateView | null): PlanStage | null {
  if (!view?.isActive) return null
  if (view.reviewState === 'awaiting' || view.reviewState === 'revising') return 'reviewing'
  const docsCount = view.docs?.length ?? 0
  if (docsCount === 0) return 'exploring'
  return 'writing'
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
  /** 首拉失败错误（AGENTS.md 规则 5 错误通路：分区级落错误供 u1-banner 呈现，不覆盖现有 view） */
  loadError: string | null
}

export const usePlanStore = defineStore('plan', () => {
  // ── 分区（useSessionScopedState 工厂：分区表 + cleanup 链自动接入）──
  /**
   * 焦点 session id（分区 current 与草稿操作的绑定目标）。由 use-plan-sync 从 panel store
   * 的 focusedSessionId 注入（syncFocus）——store 自身不 import 其他 store（铁律）。
   */
  const focusedSid = ref<string | null>(null)
  const scoped = useSessionScopedState<PlanPartition>(focusedSid, () =>
    reactive<PlanPartition>({ view: null, drafts: [], loadError: null }),
  )

  // ── actions ──

  /** 焦点同步（use-plan-sync 在挂载/切换时点调用；草稿操作与新写入的 current 视图随之对齐）。 */
  function syncFocus(sid: string | null): void {
    focusedSid.value = sid
  }

  /**
   * WS 帧落地（session.planState 广播）：写「消息所属 sid」分区——内部 updateFor(capturedSid)，
   * 不读焦点实时值，切 session 的异步退订窗口内迟到帧只写旧 sid 分区（AGENTS.md 规则 8，
   * 结构性消除竞态）。帧是 live 权威数据，落地同时清首拉错误（链路已活，错误已过时）。
   */
  function applyFrame(sid: string, planState: PlanStateView): void {
    scoped.updateFor(sid, (p) => {
      p.view = planState
      p.loadError = null
    })
  }

  /**
   * 首拉（D1⑥：stateSnapshot 是 bus 内存态，冷启动/切换靠本 RPC 冷路径）。
   *
   * AGENTS.md 规则 5（sendCommand 后检查 reply success）：renderer 端 error envelope 由
   * core transport 层转为 command promise reject，本函数 catch 即「success=false」分支——
   * 错误落分区 loadError（u1-banner 消费呈现），不覆盖现有 view（失败兜底显示，下次切入
   * 重拉自愈，subagent loadSubagents M1 同款）。
   *
   * 响应空/无 planState = 无 plan 状态，分区 view 置空（协议 planState 必填，运行时仍防御
   * 旧 runtime / mock 缺省——unknown 形状经 `?? null` 守卫收敛）。
   */
  async function loadPlanState(sessionId: string): Promise<void> {
    if (!sessionId) return
    try {
      const reply = await command('session.getPlanState', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
      const planState = reply?.planState ?? null
      scoped.updateFor(sessionId, (p) => {
        p.view = planState
        p.loadError = null
      })
    } catch (e) {
      const msg = toErrorMessage(e)
      console.error('[plan-store] getPlanState failed:', e)
      scoped.updateFor(sessionId, (p) => {
        p.loadError = msg
      })
    }
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

  /** 清空焦点分区评论草稿（提交成功后由 u1-banner 审批条调用）。 */
  function clearDraftComments(): void {
    scoped.update((p) => {
      p.drafts.length = 0
    })
  }

  // ── 焦点只读视图（派生量不落盘：阶段由 derivePlanStage 推导，docs 与 skills 两字段原样透出供降级判定——D4）──

  /** 焦点 session 的 PlanStateView（null = 无 plan 状态）。 */
  const planView: ComputedRef<PlanStateView | null> = computed(() => scoped.current.value.view)

  /** 焦点 session 的三步阶段指示（D1 推导三元组，见 derivePlanStage）。 */
  const planStage: ComputedRef<PlanStage | null> = computed(() => derivePlanStage(scoped.current.value.view))

  /** 焦点 session 的评论草稿（只读视图，操作走 add/remove/clear 三个 action 收口）。 */
  const draftComments: ComputedRef<PlanReviewComment[]> = computed(() => scoped.current.value.drafts)

  /** 焦点 session 的首拉错误（null = 无错误；非空时 u1-banner 呈现错误态）。 */
  const planLoadError: ComputedRef<string | null> = computed(() => scoped.current.value.loadError)

  return {
    focusedSid,
    syncFocus,
    applyFrame,
    loadPlanState,
    addDraftComment,
    removeDraftComment,
    clearDraftComments,
    planView,
    planStage,
    draftComments,
    planLoadError,
  }
})
