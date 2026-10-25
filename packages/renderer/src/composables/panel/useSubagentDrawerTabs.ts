/**
 * useSubagentDrawerTabs —— drawer SubagentTab 二级 tab 编排（subagent-detail-tabs
 * 2026-10-15；自 SubagentTab.vue 下沉——组件 script 行数上限合规 + 编排可测）。
 *
 * 状态活在 subagent store per-session 分区（组件随 drawer 类型 tab 切换卸载，状态必须
 * 组件外；deleteSession 经 store clearSession 释放）；选中态入口（sidebar / chat 块）
 * 经 selectedSubagentId 变化开 tab，tab 条点击/关闭在本编排内走 store。
 * 内容数据在 chatStore 按虚拟 id 分区——切 tab 不丢详情。
 */
import { computed, watch, type ComputedRef, type Ref } from 'vue'
import { clearSubagentSelection, closeDrawerIfTabsEmpty, openSubagent } from '@taiji/core/domain/drawer'
import { useSubagentStore } from '@/stores/subagent'
import { usePanelStore } from '@/stores/panel'

export interface SubagentDrawerTabsDeps { // oe-exempt:20261015:framework:tab 编排 DI 契约,单实现常态（调用方 = SubagentTab 单消费）
  /** core drawer 选中态（per-session 分区；选中变化 = 开 tab 入口）。 */
  selectedSubagentId: ComputedRef<string | null> | Ref<string | null>
  /** tab 文案（agent · slug；组件侧派生视图注入）。 */
  labelOf: (vid: string) => string
  /** 停流回调（切 tab 停旧订阅；关闭至空态停流——空态时编排同时清 core 选中态）。 */
  stopStream: () => void
}

export function useSubagentDrawerTabs(deps: SubagentDrawerTabsDeps): {
  openTabs: ComputedRef<string[]>
  activeTab: ComputedRef<string | null>
  activate: (vid: string) => void
  close: (vid: string) => void
} {
  const panelStore = usePanelStore()
  const subagentStore = useSubagentStore()

  /** tab 分区键 = focusedSessionId（与 drawer 选中态分区同 sid——真实 app 由
   *  useSideDrawer 绑定；测试经 panel store loadSession 对齐）。 */
  const focusedSid = computed(() => panelStore.focusedSessionId ?? '')
  const openTabs = computed(() => subagentStore.drawerTabsOf(focusedSid.value).tabs)
  const activeTab = computed(() => subagentStore.drawerTabsOf(focusedSid.value).active)

  // 选中态入口 → 开 tab（幂等：已打开仅激活）。immediate：重开 drawer 时恢复既有 tab 集。
  watch(
    deps.selectedSubagentId,
    (vid) => {
      if (vid && focusedSid.value) subagentStore.openDrawerTab(focusedSid.value, vid)
    },
    { immediate: true },
  )

  /** tab 点击 = 切激活 + 同步 core 选中态（sidebar 高亮/LRU 豁免谓词同源一致）。 */
  function activate(vid: string): void {
    // 无聚焦 session 早退（与 watch 入口同款真值检查）：store 分区按 sid 惰性创建，
    // '' 键是 clearSession（按真实 sid 释放）永不回收的退化分区。
    if (!focusedSid.value) return
    subagentStore.activateDrawerTab(focusedSid.value, vid)
    openSubagent({ virtualId: vid })
  }

  /** tab 关闭；激活者关闭时 store 编排激活右邻/左邻，选中态同步（无剩余 = 停流 + 抽屉关空收敛）。 */
  function close(vid: string): void {
    // 同 activate：空串 sid 早退，不触 store 分区与关空收敛编排。
    if (!focusedSid.value) return
    const next = subagentStore.closeDrawerTab(focusedSid.value, vid)
    if (next === null) {
      // 空态同步清 core 选中态（定向传 focusedSid——与 tab 分区同键，不依赖
      // 「绑定 current == focused」隐式不变量）：残留 vid 会在组件重挂载时经 watch
      // immediate 复活已关闭 tab 并拉流，且同值重选不触发 watch（无变化边沿）。
      clearSubagentSelection(focusedSid.value)
      deps.stopStream()
    } else {
      openSubagent({ virtualId: next })
    }
    // 关空收敛：最后一个二级 tab 关闭即关整个抽屉（规则单一落点见 core closeDrawerIfTabsEmpty）
    closeDrawerIfTabsEmpty(next === null)
  }

  return { openTabs, activeTab, activate, close }
}
