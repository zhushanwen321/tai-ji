<template>
  <!--
    容器组件 · PanelContainer（workspace/spec.md Panel 挂载点）。
    v2：移除 split 后恒单 Panel（撑满），不再有单/双 panel 状态机。
    active panel 的 sessionId 跟随 session store.activeId（sidebar 选 session → 载入 panel）。

    共享 header（D2 一体化）：PanelHeader 提升到 SplitterGroup 之上，横跨 main + drawer 全宽。
    main 与 drawer 共处 MainPanel 的统一 surface 外壳（border/radius/shadow 只在最外层 MainPanel），
    drawer 从 main 右缘生长挤占 main 宽度，不再各有独立 header（对齐 demo ShellView 单外壳 + 单 header）。
    SplitterGroup 仍用于 main/drawer 宽度调整，视觉上一体化（Panel section 与 DrawerPanel 均无自身 border/radius）。

    Drawer 协调（W4 drawer-shell-integration）：drawer 固定挂本容器（单实例），恒作 flex 子项与
    Panel 各占一半并排（mode='split'），贴右展开（direction='right'）。单 panel 下不再有 overlay
    浮层模式。[U7] subagent/agent call 详情走 drawer tab（SubagentTab/WorkflowTab），PanelHeader
    不再承载 overlay 返回/标题/JSONL 路径（那套展示层已随 overlay 移除）。本容器渲染跨端共享容器
    DrawerPanel（@taiji/ui/features/drawer，W3 迁移自旧
    SideDrawer.vue），并按 C2 contract 经默认 slot 注入桌面独占内容面板（GitPanel/SubagentTab
    等，v-if chain 对齐注册表终态 8 员；TerminalView 现挂本文件 bottom-drawer 块——
    display-containers §7.6）。git 状态唯一数据源在此层 provide
    （按 panel 的 session），GitPanel 注入共享。

    壳层职责（W3 C3 裁决，旧 SideDrawer 逻辑迁移至此）：AC-13 unread badge（chatStore
    消息数感知，经 DrawerPanel header-extra slot 挂载）。ESC 关闭不在本壳（终态同步更正）：
    已随 display-containers §6.7 W1 并入 key-orchestrator 栈序编排器（唯一属主，见本文件
    script 内 W1 注记；本组件无 window keydown 监听）。[P4 s5 drawer-widget-removal] widget 订阅编排（extension:widget/
    widgetGui/status → core createDrawerBuffers）已删：旧 widget 通道由 PluginViewContainer 承接。
    控制态（isOpen/
    activeTab）读 core drawer 域（useDrawerControl + coordination 公开 API），分区键经
    useSideDrawer 兼容层模块顶层 bindDrawerSessionId 维持（C1：兼容层本 wave 保留）。
    [display-containers §6.6 W0] 选中态五字段迁出（各内容域 selection 分区）；docked 死状态删除。
  -->
  <div class="panel-container flex h-full w-full flex-col overflow-hidden">
    <PanelHeader
      :session-label="sessionLabelOf(leaf)"
      :session-dir="sessionDirOf(leaf)"
      :session-id="leaf.sessionId ?? undefined"
      :session-file="sessionFileOf(leaf)"
      :git-branch="gitBranchOf(leaf)"
      :git-indicator="gitIndicatorOf(leaf)"
      :status="statusOf(leaf)"
      @open-git="openDrawerTab('git')"
      @toggle-drawer="onDrawerToggle()"
    />
    <!-- plan 模式状态带（PlanModeBar）与审批条已随 plan-mode-ux-refactor u-plan-bar 收敛到
         Panel 内 composer 下方一行（设计 §3.3 D1），本容器不再挂载。 -->
    <!-- 对话流 + drawer 动态宽度区（feat-chat-flow-width，手写 flex 替换 reka-ui Splitter）。
         替换原因：① Splitter 单 panel 时强制 flexGrow:1（computePanelFlexBoxStyle），无法实现
         「无 drawer 对话流限宽 3/4」；② SplitterPanel 挂载/卸载瞬时完成 layout 重算，无法做
         开合宽度动画。手写布局三点能力：无 drawer 时 main 占 75% 且 margin-inline calc 居中
         （对话流整体在工作区视觉居中，两侧各 12.5% 留白），main 层 --content-max-w:100% 解除
         720px 封顶（内容列占满 75% 区域）；drawer 打开时 main/drawer 双侧 width + margin-inline
         transition 动画到拆分比例；handle 拖动（pointer capture 跟手，拖动期间 transition:none）
         + 键盘微调 + localStorage 持久化。
         drawer wrapper 常驻（width 0 ↔ drawerPct%）承载 width 动画；DrawerPanel 内部 aside
         Transition（淡入右移）与 wrapper width 动画同时长（--duration-slow），叠加和谐。
         [HISTORICAL] taiji:splitter-layout 派发已随消费方退役（终态同步 2026-10-03）：
         原「拖动/键盘直发 + 开合动画 rAF 逐帧派发（BrowserPane 侧 33ms 节流）」的消费方
         useBrowserRectSync 已随 BrowserPane 迁浮层视口删除监听（§7.3：不造无人读的事件），
         派发侧一并拆除，仅保留宽度模型。 -->
    <div ref="poolEl" data-testid="vertical-pool" class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div ref="splitAreaEl" data-testid="split-area" class="relative flex min-h-0 flex-1 overflow-hidden">
      <div
        data-fs-scope="chat"
        class="relative h-full min-w-0 overflow-hidden"
        :class="splitTransitionClass"
        :style="mainAreaStyle"
        data-testid="main-area"
      >
        <Panel
          :panel-id="leaf.id"
          :session-id="leaf.sessionId"
          :session-dir="sessionDirOf(leaf)"
          :git-branch="gitBranchOf(leaf)"
        />
        <!-- Toast 通知锚点（右上角）：锚在 main-area 内——drawer 打开时本区收窄，toast 随宽左移，
             恒不遮 drawer；bottom 区域留给 composer。 -->
        <ToastContainer />
      </div>

      <!-- Drawer：workspace-body 级辅助视图容器。单实例，跟随 panel。
         handle 拖动调整 drawer 宽度（drawerPct 持久化 localStorage）；键盘 ArrowLeft/Right
         微调（separator 角色，对齐原 Splitter 键盘交互）。drawer wrapper 常驻承载 width 动画，
         内容显隐由 DrawerPanel 内部 aside v-if（Transition）承接。git 数据由本容器 provide，
         GitPanel inject。内容区按 activeTab 经默认 slot 注入桌面独占面板（C2 contract：该 tab
         无桌面面板时不注入 → DrawerPanel 空态 fallback 渲染）。 -->
      <div
        v-if="drawerOpen"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        class="workspace-resize-handle relative w-px shrink-0 cursor-col-resize touch-none select-none bg-transparent transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:bg-border-strong data-[state=drag]:bg-accent"
        :data-state="isDragging ? 'drag' : undefined"
        data-testid="drawer-resize-handle"
        @pointerdown="onHandlePointerDown"
        @pointermove="onHandlePointerMove"
        @pointerup="onHandlePointerUp"
        @pointercancel="onHandlePointerUp"
        @keydown="onHandleKeydown"
      />
      <div
        data-fs-scope="drawer"
        class="h-full min-w-0 overflow-hidden"
        :class="splitTransitionClass"
        :style="{ width: drawerOpen ? `${drawerPct}%` : '0%' }"
        data-testid="drawer-area"
      >
        <DrawerPanel
          :is-open="drawerOpen"
          :active-tab="drawerTab"
          :session-id="panelSessionId"
          @close="onDrawerClose"
          @set-tab="onDrawerSetTab"
        >
          <!-- 桌面独占内容面板（C2 v-if chain；分支与 RIGHT_DRAWER_REGISTRY 终态 8 员一一对应）：
               Git tab → GitPanel（inject GIT_STATUS_KEY，非 git 仓库组件内自隐藏走空态）
               Doc tab → CommandDocPanel（selectedCommandName 由 core 瞬时参数指定）
               Detail tab → DetailPane（W3 多文件 tab：selectFile 同步注入 detail 分区，store 响应式自动加载）
               browser/terminal 已迁出本链（display-containers §7.6）——terminal 归底抽屉（本文件
               bottom-drawer 块 TerminalView 挂载点），browser tab 已删除、能力在浮层壳复活 -->
          <!-- session-trace inspector（D5b 临时上下文页）：选中 trace 行时切入 default slot
               最前（v-if chain 首项——优先于 activeTab 面板，点击即明确意图）；「← 返回」清
               selectedKey 后回到 activeTab 内容（复原前 tab，RightDrawerTab 体系不变）。
               未选中不注入（C2 v-if chain 语义保持，slot 空时走 DrawerPanel 空态 fallback）。 -->
          <TraceInspector v-if="traceSelected" :session-id="panelSessionId ?? ''" />
          <GitPanel v-else-if="drawerTab === 'git'" />
          <CommandDocPanel v-else-if="drawerTab === 'doc'" :session-id="panelSessionId" />
          <DetailPane
            v-else-if="drawerTab === 'detail'"
            :key="detailRetryKey"
            :session-id="panelSessionId"
          />
          <!-- subagent/workflow tab（2026-08-14 subagent-workflow-drawer-tab U2/U3/U4）：内容由
               SubagentTab/WorkflowTab 自治（读 core selection/ 各内容域选中态 + 各自 store），
               不依赖 panelSessionId，延续默认 slot 注入模式。WorkflowTab 为懒加载挂载点
               （display-containers §5.3 第 2 行：浮层回落目标，chunk 同样可能失败 →
               AsyncErrorFallback 占位 + 重试链，见下方懒加载块） -->
          <SubagentTab v-else-if="drawerTab === 'subagent'" />
          <WorkflowTab v-else-if="drawerTab === 'workflow'" :key="workflowRetryKey" />
          <!-- bashTask tab（2026-09 background-task-sidebar-view D5③）：后台命令详情。未选中
               任务（selectedBackgroundTaskId undefined，bashTask 内容域选中态）不注入 →
               DrawerPanel 空态 fallback（C2 v-if chain 语义与 browser 无 URL 同款） -->
          <BackgroundTaskDetailPanel
            v-else-if="drawerTab === 'bashTask' && bashTaskSelected"
          />
          <!-- plan tab（plan 模式重设计 u1-drawer-tab + u1-docs-panel）：无条件注入（tab 激活
               即渲染，不经空态 fallback——与 bashTask 的「未选中不注入」相反）。u1-docs-panel
               起由 PlanDocsPanel 承载（L2 文档 tab + file.read 正文 + 划选评论），面板内部
               docs 空时自渲染空态（D10），替代 u1-drawer-tab 的过渡空骨架。 -->
          <PlanDocsPanel v-else-if="drawerTab === 'plan'" :session-id="panelSessionId" />
          <!-- btw tab（btw-question D7，M3-a）：旁路线面板。无条件注入（与 plan 同款——
               tab 激活即渲染，面板自渲染线列表空态；D7② 焦点绑定经 :session-id=panelSessionId
               透传当前焦点主会话，线列表按 mainSid 拉取） -->
          <BtwPanel v-else-if="drawerTab === 'btw'" :session-id="panelSessionId" />
          <!-- header-extra：AC-13 unread badge 壳侧挂载点（W4；chatStore 消息数感知，C3 壳层职责） -->
          <template #header-extra>
            <div
              v-if="unreadCount > 0"
              class="flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-0.5"
              data-testid="drawer-unread-badge"
              :title="t('panel.sideDrawer.unreadMessages', { count: unreadCount })"
            >
              <span class="size-1.5 animate-pulse rounded-full bg-accent-fg" />
              <span class="font-mono text-[10px] text-accent-fg">{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
            </div>
          </template>
        </DrawerPanel>
      </div>
    </div>
    <!-- 底抽屉（display-containers §6.2/§7.3）：插在 split 行之下、StatusBar 之上，横跨全宽
         （右抽屉开着时同样全宽、右抽屉变矮）；唯一内容 = terminal（TerminalView 挂载点，保留
         defineAsyncComponent + 内部自动重试接线（D6：原 LAZY_RETRY_KEY 占位重试链已删——
         chunk 装载失败由 createLazyChunkRetry 自动重试，见下方懒加载块）。
         高度 = pool 百分比（heightPct 默认 35%，开合 0% ↔ displayPct% 纵轴动画）；上沿手柄
         拖拽/键盘调高度（clamp 15%–70% 写侧归 core；显示期 clamp 不写回，S2）。纵轴不派发
         taiji:splitter-layout（§7.3：无消费方，不造无人读的事件）。收合动画期内容保挂载
         （U6 修复：Transition leave 语义，见下方包装层与 style 注释）。 -->
    <div
      data-testid="bottom-drawer"
      class="relative shrink-0 overflow-hidden"
      :class="bottomTransitionClass"
      :style="{ height: bottomHeightStyle }"
    >
      <div
        v-if="bottomOpen"
        role="separator"
        aria-orientation="horizontal"
        tabindex="0"
        class="absolute inset-x-0 top-0 z-10 h-px cursor-row-resize touch-none select-none bg-transparent transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:bg-border-strong data-[state=drag]:bg-accent"
        :data-state="isBottomDragging ? 'drag' : undefined"
        data-testid="bottom-drawer-resize-handle"
        @pointerdown="onBottomHandlePointerDown"
        @pointermove="onBottomHandlePointerMove"
        @pointerup="onBottomHandlePointerUp"
        @pointercancel="onBottomHandlePointerUp"
        @keydown="onBottomHandleKeydown"
      />
      <!-- 收合过渡期内容保挂载（U6 修复，§6.2 S1「开合动画平顺」）：壳 height 过渡逐帧收拢
           期间终端不同帧卸载（旧形态动画期空抽屉），卸载时机 = leave 过渡结束（Vue Transition
           事件顺序语义，无定时兜底）。Transition 直接子项用无 key 包装层：retry 的 :key 重挂
           留在内层，chunk 重试换件不经 leave/enter 过渡（chunk 失败占位链断言面不变）。 -->
      <Transition name="bottom-drawer-content">
        <div v-if="bottomOpen" class="h-full">
          <TerminalView
            :key="terminalRetryKey"
            :session-id="panelSessionId"
          />
        </div>
      </Transition>
    </div>
    </div>
    <!-- ExtensionHost 状态栏（audit §12.1）：数据经 app.provide STATUS_BAR_SOURCE_KEY 注入（useExtensionHostBridge），
         无数据时自隐藏；sessionId 绑定当前 leaf（per-session 项）。
         trailing 原生动作通道（display-containers §5.1 规则 4）：终端开关按钮常驻
         （干净安装无插件无 statusline 项时仍可见——防纯键盘不可发现）。 -->
    <StatusBar :session-id="leaf.sessionId ?? null">
      <template #trailing>
        <StatusBarTerminalToggle />
      </template>
    </StatusBar>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PanelLeaf } from '@taiji/shared'
import {
  bindDrawerSessionId,
  useDrawerControl,
  openDrawerTab,
  closeDrawer,
  toggleDrawer,
  setDrawerTab,
  useBashTaskSelection,
} from '@taiji/core/domain/drawer'
import {
  bindBottomDrawerSessionId,
  useBottomDrawerControl,
} from '@taiji/core/domain/bottom-drawer'
import { DrawerPanel } from '@taiji/ui/features/drawer'
import { StatusBar } from '@taiji/ui/extension-host'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import { provideGitStatus } from '@/composables/features/file-tree/useGitStatus'
import type { GitIndicator } from '@/composables/features/file-tree/useGitStatus'
import { useDrawerSplitWidth, useBottomDrawerHeight } from '@/composables/features/drawer/useDrawerSplitWidth'
import { focusComposer } from '@/composables/features/app/key-orchestrator'
import { usePlanDrawerSync } from '@/composables/use-plan-drawer-sync'
import { useChatStore } from '@/stores/chat'
import { useSessionTrace, clearTraceSelection } from '@/composables/features/trace/useSessionTrace'
import TraceInspector from '@/components/panel/trace/TraceInspector.vue'
import PlanDocsPanel from '@/components/panel/plan/PlanDocsPanel.vue'
import BtwPanel from '@/components/panel/BtwPanel.vue'
import Panel from '@/components/panel/Panel.vue'
import PanelHeader from '@/components/panel/PanelHeader.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import GitPanel from '@/components/panel/GitPanel.vue'
import CommandDocPanel from '@/components/panel/CommandDocPanel.vue'
import SubagentTab from '@/components/panel/SubagentTab.vue'
import BackgroundTaskDetailPanel from '@/components/extension/BackgroundTaskDetailPanel.vue'
import AsyncErrorFallback from '@/components/ui/AsyncErrorFallback.vue'
import { createLazyChunkRetry } from '@/components/ui/lazy-chunk-retry'
import StatusBarTerminalToggle from '@/components/statusbar/StatusBarTerminalToggle.vue'

// D-8 懒加载（§3.3 边界判据：首屏不渲染 + 重依赖）：DetailPane（DiffView 等专属依赖）在抽屉
// detail tab、TerminalView（xterm + 4 addon）在底抽屉，各自激活才挂载 → 首次激活才拉 chunk
// （xterm 移出首屏初始请求集合）；WorkflowTab（抽屉 workflow 回落内容）同为懒加载挂载点
// ——它同时是浮层装载失败的回落目标（display-containers §5.3），回落目标自身的 chunk 也
// 可能失败（file:// chunk 404），必须挂同一 AsyncErrorFallback 占位链才有「回落目标失败 →
// 占位」的呈现面。其余条件挂载面板（GitPanel/CommandDocPanel/SubagentTab）不拆：
// 均无重第三方依赖（重依赖判据不满足），拆分只引入 async 边界无字节收益。
// 错误兜底（§3.5 · D6 2026-10-03 用户裁决改版）：界面无重试按钮——装载失败由内部有界自动
// 重试承接（createLazyChunkRetry：3 次 × 300ms 递增退避，失败 URL 提取 + ?t=N cache-busting
// 绕过浏览器 module map 对失败模块的记忆化——同 URL 重试零网络请求、busting 才有真自愈，
// 探针证据见 runlog d6-fix-internal-retry）；穷尽才呈现错误态（文案给「重开恢复」指引），
// 重开抽屉/浮层即重置计数获得新一轮自动重试。
// [HISTORICAL W31 major-2] 旧「重试作用域 = scopedRetryFallback provide LAZY_RETRY_KEY 按挂载点
// 隔离」随按钮删除一并退役：重试不再由用户点击路由，各挂载点状态机天然独立，串线形态
// 结构性消失；retryKey 重挂保留为自动重试的唯一驱动（Vue 实装语义见 lazy-chunk-retry.ts
// 头注「重试驱动形态」）。
const detailRetryState = createLazyChunkRetry(() => import('@/components/panel/DetailPane.vue'))
const { retryKey: detailRetryKey } = detailRetryState
const DetailPane = defineAsyncComponent({
  loader: detailRetryState.loader,
  loadingComponent: AsyncErrorFallback,
  errorComponent: AsyncErrorFallback,
  delay: 200,
  onError: detailRetryState.onError,
})
const terminalRetryState = createLazyChunkRetry(() => import('@/components/panel/TerminalView.vue'))
const { retryKey: terminalRetryKey } = terminalRetryState
const TerminalView = defineAsyncComponent({
  loader: terminalRetryState.loader,
  loadingComponent: AsyncErrorFallback,
  errorComponent: AsyncErrorFallback,
  delay: 200,
  onError: terminalRetryState.onError,
})
const workflowRetryState = createLazyChunkRetry(() => import('@/components/panel/WorkflowTab.vue'))
const { retryKey: workflowRetryKey } = workflowRetryState
const WorkflowTab = defineAsyncComponent({
  loader: workflowRetryState.loader,
  loadingComponent: AsyncErrorFallback,
  errorComponent: AsyncErrorFallback,
  delay: 200,
  onError: workflowRetryState.onError,
})

const { t } = useI18n()

const panel = usePanelStore()
const session = useSessionStore()
const chatStore = useChatStore()
const { derivedStatus } = useSessionDerivations()

// sidebar 选 session → panel 载入的编排在 useSidebar.selectSession（代理 core use-session，主路径）
// 与 AppShell watch(navigation.pointer)（⌘[/⌘] 同步），不在此组件 watch：
// 避免空态不渲染→watch 不注册→loadSession 不触发的初始化时序死锁。

/** 唯一 panel leaf（v2：恒单 panel，currentLeaf 即整个 layout） */
const leaf = computed<PanelLeaf>(() => panel.currentLeaf)

function sessionLabelOf(l: PanelLeaf): string {
  return l.sessionId ? session.list.find((s) => s.id === l.sessionId)?.label ?? '' : ''
}
function sessionDirOf(l: PanelLeaf): string {
  return l.sessionId ? session.list.find((s) => s.id === l.sessionId)?.cwd ?? '' : ''
}
function sessionFileOf(l: PanelLeaf): string | undefined {
  return l.sessionId ? session.list.find((s) => s.id === l.sessionId)?.sessionFile : undefined
}
function gitBranchOf(l: PanelLeaf): string | undefined {
  return l.sessionId ? session.list.find((s) => s.id === l.sessionId)?.gitBranch : undefined
}
function statusOf(l: PanelLeaf) {
  return l.sessionId ? derivedStatus(l.sessionId).value : 'done'
}

// [U7] overlay 展示层（subagentLabel / isViewingSubagent / overlaySessionFile /
// onSubagentBack / agentCallOverlayFile watch）已随 overlay 移除。subagent/agent call 详情
// 走 drawer SubagentTab/WorkflowTab，PanelHeader 不再承载 overlay 标题/返回/JSONL 路径。
/** Drawer 控制态（§6.3 点5 架构解耦）：workspace-body 单实例。
 *  读 core drawer 域当前分区（isOpen/activeTab）。分区键显式绑定 panel store 的
 *  focusedSessionId（惰性 computed，首次求值 pinia 已 active）——本容器自持绑定，不依赖
 *  useSideDrawer 兼容层的模块顶层 bind 副作用（C1：兼容层保留仅服务残留消费方，新代码直连 core）。
 *  方法委托 core coordination 公开 API（openDrawerTab 等）。
 *  bindDrawerSessionId 幂等：同语义 computed 重复绑定不报错（useSideDrawer 兼容层若已绑则覆盖，
 *  值等价）。 */
bindDrawerSessionId(computed<string | null>(() => usePanelStore().focusedSessionId))
const { isOpen: drawerOpen, activeTab: drawerTab } = useDrawerControl()
// 底抽屉（display-containers §7.1）：开合 = per-session 分区（ADR-0049 范式，本容器自持绑定，
// bindDrawerSessionId 同款时机）；高度全局值归 core bottom-drawer 域，纵轴模型在本文件末。
bindBottomDrawerSessionId(computed<string | null>(() => usePanelStore().focusedSessionId))
const { isOpen: bottomOpen } = useBottomDrawerControl()

// drawer「计划产物」tab 自动打开接线（plan 模式重设计 u1-drawer-tab）：plan 激活/首份产物
// 边界经 ADR-0053 pendingOpen 语义打开 drawer（消费源 = planStore 焦点分区；focusedSid
// 的注入方自 u-plan-bar 起为 Panel 内 PlanModeBar 的 setup——本容器与 PlanModeBar 共享
// 同一 pinia store 单例，接线读焦点分区不依赖注入宿主同层）。
usePlanDrawerSync()

/** bashTask tab 选中态（D5①：selectedBackgroundTaskId undefined=未选中 → 不注入本面板，
 *  DrawerPanel 空态 fallback 承载；bashTask 内容域选中态（selection/bash-task.ts）直读，
 *  写入方 = 列表 item 点击 D5④） */
const { selectedBackgroundTaskId: selectedBashTaskId } = useBashTaskSelection()
const bashTaskSelected = computed(() => selectedBashTaskId.value !== undefined)

/** panel 的 session（git 状态数据源） */
const panelSessionId = computed<string | null>(() => leaf.value?.sessionId ?? null)

/** session-trace（A44）：选中 trace 行时 drawer default slot 最前注入 inspector 临时页（D5b）。 */
const { partition: tracePartition } = useSessionTrace()
const traceSelected = computed(() => tracePartition.value.selectedKey !== null)

/**
 * drawer set-tab 壳层包装（D5b 对称语义）：inspector 临时页期间用户点其它一级 tab =
 * 明确离开 inspector → 清 trace 选中（activeTab 链接管内容）。「单向 main→drawer」保持：
 * 这里只清 main 发起的选中态，drawer 不反向写 main 的过滤/视图状态。
 */
function onDrawerSetTab(tab: Parameters<typeof setDrawerTab>[0]): void {
  const sid = panelSessionId.value
  if (sid && tracePartition.value.selectedKey !== null) clearTraceSelection(sid)
  setDrawerTab(tab)
}

/**
 * 鼠标路径关闭/开关的焦点契约包装（§6.7「任一容器关闭后焦点回 composer」，display-containers
 * 终态同步补齐右抽屉鼠标通道——键盘路径已由编排器 stack-order 承接，StatusBarTerminalToggle
 * 是底抽屉同款先例）：关闭分支关后 focusComposer（焦点原落在随即卸载的按钮上，不接续会
 * 流失到 body）；开关的打开分支不抢焦点（内容自取，镜像 StatusBarTerminalToggle.onToggle
 * 的 wasOpen 判定）。
 */
function onDrawerClose(): void {
  closeDrawer()
  focusComposer()
}

function onDrawerToggle(): void {
  const wasOpen = drawerOpen.value
  toggleDrawer()
  if (wasOpen) focusComposer()
}

/** git 状态唯一数据源（panel/spec.md：git 移入抽屉后）。
 *  在 PanelContainer 层按 panel 的 session 持有实例 → GIT_STATUS_KEY provide →
 *  GitPanel（抽屉内）注入。单实例避免双实例 stale（抽屉内 stage 后同步更新）。getter 随 panel 响应。 */
const git = provideGitStatus(() => panelSessionId.value)

/**
 * 各 Panel 透传给 PanelHeader 的 git 脏状态指示。
 * git 状态由本容器 provideGitStatus 持有（不依赖具体 leaf），参数仅为与其他 xxxOf(leaf) 保持调用一致。
 */
function gitIndicatorOf(_l: PanelLeaf): GitIndicator | undefined {
  return git.indicator.value
}

// ── AC-13：drawer 打开期间 agent 新消息感知（壳层职责，C3；旧 SideDrawer 逻辑迁移）──
// drawer 打开时对话流被遮挡，agent 新消息需非侵入式感知（spec §4.5）。
// 机制：drawer isOpen 时 watch 当前 session 消息数增长，累加 unreadCount；
// 用户关 drawer（回对话流）或切 session 时清零。经 DrawerPanel header-extra slot 注入 badge。
const unreadCount = ref(0)
let prevSid = panelSessionId.value
watch(
  () => [drawerOpen.value, panelSessionId.value] as const,
  ([open, sid], [wasOpen]) => {
    // drawer 关闭时清零（用户回到对话流，角标无意义）
    if (wasOpen && !open) {
      unreadCount.value = 0
    }
    // 切 session 时清零（per-session 计数，不跨 session 累加）
    if (sid !== prevSid) {
      unreadCount.value = 0
      prevSid = sid
    }
  },
)
// 消息数增长时（drawer 打开期间 agent 新消息到达）→ 累加计数
watch(
  () => (panelSessionId.value ? chatStore.getMessages(panelSessionId.value).length : 0),
  (newLen, oldLen) => {
    if (drawerOpen.value && panelSessionId.value && newLen > oldLen) {
      unreadCount.value += newLen - oldLen
    }
  },
)

/**
 * [display-containers §6.7 W1] ESC 关抽屉已并入键盘栈序编排器（key-orchestrator 唯一属主）：
 * 旧壳层 window keydown 监听已拆除——双监听双触发（一次 Esc 连剥两层），且 Esc 需按焦点
 * 所有权分派 + 固定层级序 + 模态/局部消费方让位守卫，非本壳单点可判。用户可感知行为由
 * 编排器承接（含终端聚焦态让位）。
 */

// ── 动态宽度（feat-chat-flow-width）：drawer 开合动画 + 可拖动宽度 ──
// 宽度模型/拖动/键盘/持久化/BrowserPane rect 同步均在 useDrawerSplitWidth（含替换
// reka-ui Splitter 的原因）；模板绑定 splitAreaEl + mainAreaStyle（width + margin-inline
// 居中 + --content-max-w 封顶解除）+ drawer 侧 width style + handle 事件。
const splitAreaEl = ref<HTMLElement | null>(null)
const {
  drawerPct,
  isDragging,
  splitTransitionClass,
  mainAreaStyle,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onHandleKeydown,
} = useDrawerSplitWidth(splitAreaEl, drawerOpen)

// ── 纵轴：底抽屉高度（§7.3）——pool = split 行 + 底抽屉共享容器（拖拽数学与显示期 clamp 基准）──
const poolEl = ref<HTMLElement | null>(null)
const {
  bottomHeightStyle,
  isBottomDragging,
  bottomTransitionClass,
  onBottomHandlePointerDown,
  onBottomHandlePointerMove,
  onBottomHandlePointerUp,
  onBottomHandleKeydown,
} = useBottomDrawerHeight(poolEl, bottomOpen)
</script>

<style scoped>
/*
 * 底抽屉收合过渡期内容保挂载（display-containers §6.2 S1「开合动画平顺」，U6 修复）：
 * 壳 height 过渡（--duration-slow）收拢期间内容不同帧消失——leave 期保持挂载并随壳淡出，
 * 卸载时机 = leave 过渡结束（Vue Transition 事件顺序语义，无定时兜底）。leave-active 加
 * absolute inset-0：收拢中的离场内容不占文档流（leave 未完即重开时新旧内容不叠流）。
 * 淡出走 opacity 且与壳 height 过渡同参数同时长（收拢与淡出同步收束）；reduced-motion
 * 全局兜底保留 opacity 过渡（style.css「更少更温和」非零裁决）。
 */
.bottom-drawer-content-leave-active {
  position: absolute;
  inset: 0;
  transition: opacity var(--duration-slow) var(--ease);
}

.bottom-drawer-content-leave-from {
  opacity: 1;
}

.bottom-drawer-content-leave-to {
  opacity: 0;
}
</style>
