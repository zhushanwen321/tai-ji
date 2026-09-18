/**
 * usePlanDrawerSync —— drawer「计划产物」tab 自动打开接线（plan 模式重设计 u1-drawer-tab，
 * 设计 §3.1 步骤②：drawer 自动打开「计划产物」tab）。
 *
 * ADR-0053 per-session pendingOpen 语义（事件驱动的打开 ≠ 直开）在本接线的落地形态：
 * - 触发边界（仅同 session 内的状态翻转）：isActive false→true（进入计划模式）或
 *   docs 0→1（首份产物就绪）。docs 1→n 不触发——tab 已在，L2 文档清单由 u1-docs-panel
 *   响应式驱动，无需重开 drawer。
 * - 切走不打开：sid 变化的求值只更新基线（回调首行 sid 比对 return）——后台 session 的
 *   plan 激活绝不抢焦点（D1：plan 面只服务焦点 session 的显示语义）。
 * - 切回不重复打开：切回时无新翻转（同上 sid 比对 return），只有再次跨越触发边界才提示；
 *   挂载即激活（重开 session 恢复 isActive=true）同理不打开——watch 非 immediate，挂载态
 *   是基线，用户主动重开 session 是有意图动作。
 * - 已开不重发：drawer 打开中不动用户当前 tab（用户在看其他 tab 时被拽回是打断）。
 *   drawer 关闭后的再次翻转（如 docs 0→1）仍会提示——「手动关闭」尊重的是当次提示，
 *   新事件（首份产物就绪）是新提示。
 *
 * pendingOpen 残留面说明：core 的 pendingOpen 标记机制已随 tasks 域移除
 * （coordination.ts [P4 s5]），本接线以「同 sid 翻转边界 + 焦点比对」达到同一行为契约
 * （非焦点不直开 / 切回不重发），不需要跨切换的显式标记——标记的「未看过待提示」语义
 * 由触发边界的瞬时性承载（错过即不补，下一次跨越边界再提示）。
 *
 * 触发源 = planStore 焦点分区视图（usePlanSync 的 WS 帧 applyFrame / 首拉 loadPlanState
 * 写入），本 composable 只读不写 store；drawer 控制态经 core 公开 API（openDrawerTab），
 * 与 useSessionTrace 的 drawer 联动同形态。
 *
 * 前置依赖：planStore.focusedSid 的注入方 = 同宿主的 PlanModeBanner / PlanReviewBar
 * （setup 内 usePlanState 的 watch immediate → syncFocus）。本接线自身不注入焦点——
 * 因此必须与横幅/审批条同宿主挂载（PanelContainer），单独挂载时 sid 恒 null、永不触发。
 *
 * 必须在组件 setup 同步调用（消费方 = PanelContainer，与横幅/审批条同宿主）。
 */
import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useDrawerControl, openDrawerTab } from '@taiji/core/domain/drawer'
import { usePlanStore } from '@/stores/plan-store'

/** watch 源快照（字段级比较用；docsCount 归一为数字，避免数组引用比较永不等） */
interface PlanDrawerSnapshot {
  sid: string | null
  isActive: boolean
  docsCount: number
}

export function usePlanDrawerSync(): void {
  const planStore = usePlanStore()
  // storeToRefs 保响应性（store 实例属性访问会解包 computed 丢 ref 形态）
  const { focusedSid, planView } = storeToRefs(planStore)
  const { isOpen } = useDrawerControl()

  watch(
    (): PlanDrawerSnapshot => ({
      sid: focusedSid.value,
      isActive: planView.value?.isActive ?? false,
      docsCount: planView.value?.docs?.length ?? 0,
    }),
    (cur, prev) => {
      // 切 session（含切走/切回）：只更新基线不打开（pendingOpen 语义：非焦点不直开、
      // 切回无新翻转不重发）
      if (!cur.sid || cur.sid !== prev.sid) return
      const activated = !prev.isActive && cur.isActive
      const firstDoc = prev.docsCount === 0 && cur.docsCount === 1
      if (!activated && !firstDoc) return
      // 已开不重发：drawer 打开中不动用户当前 tab
      if (isOpen.value) return
      openDrawerTab('plan')
    },
  )
}
