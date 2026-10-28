/**
 * useDrawerContentDispatch —— 右抽屉内容分派（容器扩展点统一 §6.1/U6）。
 *
 * 数据源 = 容器位注册表派生视图（core domain drawer content-slots，单一事实源）；生效 tab
 * 的 renderer.kind 分派：'host' → 内置组件表，'view' → ViewHost（插件推树）。自 PanelContainer
 * 抽出的原因：分派是独立变化原因（注册表词表/白名单扩员、组件绑定调整），与壳层布局
 * （宽度动画/手柄/底抽屉）无关；同时 PanelContainer script 回到 300 行红线内。
 *
 * 内置组件表：键 = 宿主组件白名单名（HOST_COMPONENT_WHITELIST，声明只能命中不能创造的
 * 同一词表——渲染端以本表为对账契约）。表项 = 该宿主组件在本容器的绑定：props（焦点会话
 * 透传；DetailPane 的 key = 懒加载重试重挂键，v-bind 对象内的 key 是 Vue 保留 prop 作
 * vnode key）+ inject（内容注入条件，false = 本帧不注入 → slot 空 → DrawerPanel 空态
 * fallback，bashTask/trace「未选中不注入」语义与旧 v-if chain 相同）。Partial：白名单含
 * 三类重可视化宿主组件（MessageStream/WorkflowVizDag/WorkflowVizGantt，§6.5——归宿主渲染器
 * 但其容器位是浮层族，不在抽屉），未入表项的 host 声明按无内容处理 → 空态，可观测不崩溃。
 */
import { computed, defineAsyncComponent } from 'vue'
import type { Component, ComputedRef } from 'vue'
import type { PluginViewScope } from '@taiji/shared'
import {
  useBashTaskSelection,
  findDrawerTabView,
  effectiveDrawerTab,
  type DrawerTabView,
  type RightDrawerTab,
} from '@taiji/core/domain/drawer'
import { HOST_COMPONENT_WHITELIST, type HostComponentName } from '@taiji/core'
import { useSessionTrace } from '@/composables/features/trace/useSessionTrace'
import AsyncErrorFallback from '@/components/ui/AsyncErrorFallback.vue'
import { createLazyChunkRetry } from '@/components/ui/lazy-chunk-retry'
import GitPanel from '@/components/panel/GitPanel.vue'
import CommandDocPanel from '@/components/panel/CommandDocPanel.vue'
import SubagentTab from '@/components/panel/SubagentTab.vue'
import BackgroundTaskDetailPanel from '@/components/extension/BackgroundTaskDetailPanel.vue'
import PlanDocsPanel from '@/components/panel/plan/PlanDocsPanel.vue'
import BtwPanel from '@/components/panel/BtwPanel.vue'
import TraceInspector from '@/components/panel/trace/TraceInspector.vue'

// DetailPane 懒加载（D-8 §3.3 边界判据：重依赖 DiffView 等专属依赖，首次激活才拉 chunk）。
// 错误兜底（§3.5 · D6 改版）：装载失败由内部有界自动重试承接（createLazyChunkRetry），
// 穷尽才呈现错误态；retryKey 重挂 = 自动重试的唯一驱动（lazy-chunk-retry.ts 头注）。
const detailRetryState = createLazyChunkRetry(() => import('@/components/panel/DetailPane.vue'))
const DetailPane = defineAsyncComponent({
  loader: detailRetryState.loader,
  loadingComponent: AsyncErrorFallback,
  errorComponent: AsyncErrorFallback,
  delay: 200,
  onError: detailRetryState.onError,
})

/** 生效 tab 的内置内容绑定（模板 `<component :is>` 消费 component/props；inject 只参与分派判定）。 */
export interface HostTabPanelBinding { // oe-exempt:20261025:framework:模板消费绑定数据契约（类型契约先行，非抽象接口单实现）
  component: Component
  props: Record<string, unknown>
  /** false = 本帧不注入内容（bashTask/trace 未选中）→ 分派归 null → DrawerPanel 空态 fallback */
  inject: boolean
}

/** 生效 tab 的插件推树分派（模板 `<ViewHost>` 消费）。 */
export interface PluginTabViewBinding { // oe-exempt:20261025:framework:模板消费绑定数据契约（类型契约先行，非抽象接口单实现）
  viewId: string
  scope: PluginViewScope
  title: string
}

/** 分派产物（PanelContainer 模板消费三件；null = 本帧无内容注入 → 空态 fallback）。 */
export interface DrawerContentDispatch { // oe-exempt:20261025:framework:分派产物数据契约（composable 单装配返回形状）
  /** 生效 tab 位：分区值失效（插件 tab 卸载/禁用）时回退内置默认项（§11.1-1 断言 3） */
  effectiveTab: ComputedRef<RightDrawerTab>
  activeHostPanel: ComputedRef<HostTabPanelBinding | null>
  activePluginView: ComputedRef<PluginTabViewBinding | null>
}

/**
 * 建立右抽屉内容分派（PanelContainer setup 调用一次；composable 形态对齐
 * useDrawerSplitWidth 既有惯例——deps 显式入参，注册表快照依赖在建 computed 内建立）。
 */
export function useDrawerContentDispatch(deps: {
  /** 分区 activeTab（core useDrawerControl） */
  drawerTab: ComputedRef<RightDrawerTab>
  /** panel 焦点会话（DrawerPanel prop 与 git 状态数据源同一来源） */
  panelSessionId: ComputedRef<string | null>
}): DrawerContentDispatch {
  const { drawerTab, panelSessionId } = deps

  /** bashTask tab 选中态（D5①：selectedBackgroundTaskId undefined = 未选中 → 不注入） */
  const { selectedBackgroundTaskId } = useBashTaskSelection()
  const bashTaskSelected = computed(() => selectedBackgroundTaskId.value !== undefined)
  /** trace 一级 tab 内容注入条件（A44：选中 trace 条目时注入，未选中走空态 fallback） */
  const { partition: tracePartition } = useSessionTrace()
  const traceSelected = computed(() => tracePartition.value.selectedKey !== null)

  const HOST_TAB_PANEL_TABLE: Partial<
    Record<HostComponentName, (sessionId: string | null) => HostTabPanelBinding>
  > = {
    GitPanel: () => ({ component: GitPanel, props: {}, inject: true }),
    CommandDocPanel: (sessionId) => ({ component: CommandDocPanel, props: { sessionId }, inject: true }),
    DetailPane: (sessionId) => ({
      component: DetailPane,
      props: { key: detailRetryState.retryKey.value, sessionId },
      inject: true,
    }),
    SubagentTab: () => ({ component: SubagentTab, props: {}, inject: true }),
    BackgroundTaskDetailPanel: () => ({
      component: BackgroundTaskDetailPanel,
      props: {},
      inject: bashTaskSelected.value,
    }),
    PlanDocsPanel: (sessionId) => ({ component: PlanDocsPanel, props: { sessionId }, inject: true }),
    BtwPanel: (sessionId) => ({ component: BtwPanel, props: { sessionId }, inject: true }),
    TraceInspector: (sessionId) => ({
      component: TraceInspector,
      props: { sessionId: sessionId ?? '' },
      inject: traceSelected.value,
    }),
  }

  // 生效 tab 位：分区值命中派生视图则原样，否则回退内置默认项（读侧派生不回写分区，见
  // core content-slots.ts）。传给 DrawerPanel 的 active-tab 与内容分派共用同一生效值——
  // 高亮、内容、空态文案一致回退，不残留已删 tab。
  const effectiveTab = computed<RightDrawerTab>(() => effectiveDrawerTab(drawerTab.value))

  /** 生效 tab 的派生视图条目（host/view 分派与插件元信息的唯一来源） */
  const activeTabView = computed<DrawerTabView | undefined>(() => findDrawerTabView(effectiveTab.value))

  // 白名单消费侧复核（§6.1 硬约束 3 的渲染端兜底：声明解析层已拦，此处是分派前最后一道），
  // 守卫后的收窄才允许按白名单词表键查表；inject=false（bashTask/trace 未选中）与 view 项、
  // 未登记组件同归 null → 空态 fallback 或 ViewHost 分支。
  const activeHostPanel = computed<HostTabPanelBinding | null>(() => {
    const view = activeTabView.value
    if (view === undefined || view.renderer.kind !== 'host') return null
    if (!(HOST_COMPONENT_WHITELIST as readonly string[]).includes(view.renderer.component)) return null
    const binding =
      HOST_TAB_PANEL_TABLE[view.renderer.component as HostComponentName]?.(panelSessionId.value) ?? null
    return binding !== null && binding.inject ? binding : null
  })

  // 插件推树分派：视图归属按声明 scope——会话域跟随 panel 焦点会话（无会话不渲染 → 空态
  // fallback，不给空串分区键造脏分区）；全局域按挂载位 + 插件维度分区（Provider 页全局域
  // 同款 scope 形状）。title = 声明 label（ViewHost 空态占位展示）。
  const activePluginView = computed<PluginTabViewBinding | null>(() => {
    const view = activeTabView.value
    if (view === undefined || view.renderer.kind !== 'view') return null
    const title = view.label ?? view.key
    if (view.scope === 'global') {
      return {
        viewId: view.renderer.viewId,
        scope: { kind: 'global', mountId: 'drawer.tab', pluginId: view.pluginId },
        title,
      }
    }
    const sessionId = panelSessionId.value
    if (sessionId === null) return null
    return { viewId: view.renderer.viewId, scope: { kind: 'session', sessionId }, title }
  })

  return { effectiveTab, activeHostPanel, activePluginView }
}
