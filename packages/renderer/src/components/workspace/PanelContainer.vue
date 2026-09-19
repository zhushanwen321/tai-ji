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
    SideDrawer.vue），并按 C2 contract 经默认 slot 注入桌面独占内容面板（GitPanel/TerminalView/
    SubagentTab 等，v-if chain 对齐旧 SideDrawer 内容区结构）。git 状态唯一数据源在此层 provide
    （按 panel 的 session），GitPanel 注入共享。

    壳层职责（W3 C3 裁决，旧 SideDrawer 逻辑迁移至此）：ESC 关闭
    （window keydown 桌面副作用）+ AC-13 unread badge（chatStore 消息数感知，经 DrawerPanel
    header-extra slot 挂载）。[P4 s5 drawer-widget-removal] widget 订阅编排（extension:widget/
    widgetGui/status → core createDrawerBuffers）已删：旧 widget 通道由 PluginViewContainer 承接。
    控制态（isOpen/
    activeTab/docked）读 core drawer 域（useDrawerControl + coordination 公开 API），分区键经
    useSideDrawer 兼容层模块顶层 bindDrawerSessionId 维持（C1：兼容层本 wave 保留）。
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
      @toggle-drawer="toggleDrawer()"
    />
    <!-- M1 计划模式横幅（plan 模式重设计 u1-banner）：header 下、对话流之上的独立 flex 行，
         覆盖位互斥定则（impl-plan §0 待验证检查点）——表单 overlay/Composer 都在 Panel 内部，
         本行在 split-area 之外，天然不重叠。isActive=false 时组件内部 v-if 不渲染。 -->
    <PlanModeBanner :session-id="panelSessionId" />
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
         BrowserPane rect 同步：原 Splitter @layout 事件改为 notifyLayout()（拖动/键盘时直发 +
         开合动画期间 rAF 循环逐帧派发 taiji:splitter-layout）。 -->
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
          :docked="drawerDocked"
          :session-id="panelSessionId"
          @close="closeDrawer"
          @set-tab="onDrawerSetTab"
          @toggle-dock="toggleDrawerDock"
        >
          <!-- 桌面独占内容面板（C2 v-if chain，对齐旧 SideDrawer 内容区结构）：
               Git tab → GitPanel（inject GIT_STATUS_KEY，非 git 仓库组件内自隐藏走空态）
               Doc tab → CommandDocPanel（selectedCommandName 由 core 瞬时参数指定）
               Detail tab → DetailPane（useDetailPane watch selectedPath 自动加载）
               Browser tab → 无 URL 注入链（browserUrl 死链已删）→ DrawerPanel 空态 fallback
               Terminal tab → TerminalView（PTY 优先，交互式终端） -->
          <!-- session-trace inspector（D5b 临时上下文页）：选中 trace 行时切入 default slot
               最前（v-if chain 首项——优先于 activeTab 面板，点击即明确意图）；「← 返回」清
               selectedKey 后回到 activeTab 内容（复原前 tab，SideDrawerTab 体系不变）。
               未选中不注入（C2 v-if chain 语义保持，slot 空时走 DrawerPanel 空态 fallback）。 -->
          <TraceInspector v-if="traceSelected" :session-id="panelSessionId ?? ''" />
          <GitPanel v-else-if="drawerTab === 'git'" />
          <CommandDocPanel v-else-if="drawerTab === 'doc'" :session-id="panelSessionId" />
          <DetailPane
            v-else-if="drawerTab === 'detail'"
            :key="detailRetryKey"
            :session-id="panelSessionId"
          />
          <TerminalView
            v-else-if="drawerTab === 'terminal'"
            :key="terminalRetryKey"
            :session-id="panelSessionId"
          />
          <!-- subagent/workflow tab（2026-08-14 subagent-workflow-drawer-tab U2/U3/U4）：内容由
               SubagentTab/WorkflowTab 自治（读 useDrawerControl 的 selectedSubagentId/
               selectedWorkflowName + 各自 store），不依赖 panelSessionId，延续默认 slot 注入模式 -->
          <SubagentTab v-else-if="drawerTab === 'subagent'" />
          <WorkflowTab v-else-if="drawerTab === 'workflow'" />
          <!-- bashTask tab（2026-09 background-task-sidebar-view D5③）：后台命令详情。未选中
               任务（selectedBackgroundTaskId undefined）不注入 → DrawerPanel 空态 fallback
               （C2 v-if chain 语义与 browser 无 URL 同款） -->
          <BackgroundTaskDetailPanel
            v-else-if="drawerTab === 'bashTask' && bashTaskSelected"
          />
          <!-- plan tab（plan 模式重设计 u1-drawer-tab + u1-docs-panel）：无条件注入（tab 激活
               即渲染，不经空态 fallback——与 bashTask 的「未选中不注入」相反）。u1-docs-panel
               起由 PlanDocsPanel 承载（L2 文档 tab + file.read 正文 + 划选评论），面板内部
               docs 空时自渲染空态（D10），替代 u1-drawer-tab 的过渡空骨架。 -->
          <PlanDocsPanel v-else-if="drawerTab === 'plan'" :session-id="panelSessionId" />
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
    <!-- 审批条（plan 模式重设计 u1-banner）：主面板底部独立行 = 终态位置（drawer 关闭时
         审批操作仍可达，不随 drawer 显隐）。显示驱动公式在组件内（D5 四分支，isActive=false
         不渲染 DOM）。 -->
    <PlanReviewBar :session-id="panelSessionId" />
    <!-- ExtensionHost 状态栏（audit §12.1）：数据经 app.provide STATUS_BAR_SOURCE_KEY 注入（useExtensionHostBridge），
         无数据时自隐藏；sessionId 绑定当前 leaf（per-session 项） -->
    <StatusBar :session-id="leaf.sessionId ?? null" />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PanelLeaf } from '@taiji/shared'
import {
  bindDrawerSessionId,
  useDrawerControl,
  openDrawerTab,
  closeDrawer,
  toggleDrawer,
  setDrawerTab,
  toggleDrawerDock,
  getDrawerControlState,
} from '@taiji/core/domain/drawer'
import { DrawerPanel } from '@taiji/ui/features/drawer'
import { StatusBar } from '@taiji/ui/extension-host'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import { provideGitStatus } from '@/composables/features/file-tree/useGitStatus'
import type { GitIndicator } from '@/composables/features/file-tree/useGitStatus'
import { useDrawerSplitWidth } from '@/composables/features/drawer/useDrawerSplitWidth'
import { usePlanDrawerSync } from '@/composables/use-plan-drawer-sync'
import { useChatStore } from '@/stores/chat'
import { useSessionTrace, clearTraceSelection } from '@/composables/features/trace/useSessionTrace'
import TraceInspector from '@/components/panel/trace/TraceInspector.vue'
import PlanModeBanner from '@/components/panel/plan/PlanModeBanner.vue'
import PlanReviewBar from '@/components/panel/plan/PlanReviewBar.vue'
import PlanDocsPanel from '@/components/panel/plan/PlanDocsPanel.vue'
import Panel from '@/components/panel/Panel.vue'
import PanelHeader from '@/components/panel/PanelHeader.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'
import GitPanel from '@/components/panel/GitPanel.vue'
import CommandDocPanel from '@/components/panel/CommandDocPanel.vue'
import SubagentTab from '@/components/panel/SubagentTab.vue'
import WorkflowTab from '@/components/panel/WorkflowTab.vue'
import BackgroundTaskDetailPanel from '@/components/extension/BackgroundTaskDetailPanel.vue'
import AsyncErrorFallback, { LAZY_RETRY_KEY } from '@/components/ui/AsyncErrorFallback.vue'

// D-8 抽屉面板懒加载（§3.3 边界判据：首屏不渲染 + 重依赖）：
// DetailPane（DiffView 等专属依赖）/ TerminalView（xterm + 4 addon）是 drawerTab 的 v-else-if
// 互斥分支，切到该 tab 才挂载 → 首次切 tab 才拉取对应 chunk（xterm 移出首屏初始请求集合）。
// 其余条件挂载面板（GitPanel/CommandDocPanel/SubagentTab/WorkflowTab）不拆：
// 均无重第三方依赖（重依赖判据不满足），拆分只引入 async 边界无字节收益（边界评估结论写 W31 汇报）。
// 错误兜底（§3.5）：file:// 下 chunk 404 是配置性错误，不自动重试，错误占位 + 重试按钮经
// LAZY_RETRY_KEY 注入触发 loader 重跑（重试 = userRetry 重跑 loader + key 重挂 wrapper，两者缺一
// 不可，机制见 AppShell.vue 同款注释）。
let detailRetryFn: (() => void) | null = null
const detailRetryKey = ref(0)
const DetailPane = defineAsyncComponent({
  loader: () => import('@/components/panel/DetailPane.vue'),
  loadingComponent: AsyncErrorFallback,
  errorComponent: AsyncErrorFallback,
  delay: 200,
  onError: (_err, retry, fail) => {
    detailRetryFn = retry
    fail()
  },
})
let terminalRetryFn: (() => void) | null = null
const terminalRetryKey = ref(0)
const TerminalView = defineAsyncComponent({
  loader: () => import('@/components/panel/TerminalView.vue'),
  loadingComponent: AsyncErrorFallback,
  errorComponent: AsyncErrorFallback,
  delay: 200,
  onError: (_err, retry, fail) => {
    terminalRetryFn = retry
    fail()
  },
})
// [W31 review major-2] retry 按当前激活 tab 路由（drawerTab 经下方 useDrawerControl 解构，回调
// 点击时才求值，晚于声明无碍）。依据：DetailPane/TerminalView 是 drawerTab 的 v-else-if 互斥
// 分支，AsyncErrorFallback 错误占位只渲染在对应分支内——用户能点到的重试按钮必然属于当前 tab
// 的面板，按 tab 路由即「按失败方路由」。旧实现 `if (detailRetryFn) else if (terminalRetryFn)`
// 在 detail 失败后（detailRetryFn 恒非 null、无重置路径）terminal 再失败时，terminal 占位的
// 重试实际执行 detail 的 userRetry + detailRetryKey++，terminal 永久卡 error——file:// chunk 404
// 恰会同时打断两个 chunk，属设计内真实路径。不走「独立 InjectionKey」方案：需给
// AsyncErrorFallback 开自定义 key 的接口表面积，而 tab 路由零新增接口且语义直接。
provide(LAZY_RETRY_KEY, () => {
  const isTerminal = drawerTab.value === 'terminal'
  const retryFn = isTerminal ? terminalRetryFn : detailRetryFn
  if (!retryFn) return
  retryFn()
  if (isTerminal) terminalRetryKey.value++
  else detailRetryKey.value++
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
 *  读 core drawer 域当前分区（isOpen/activeTab/docked）。分区键显式绑定 panel store 的
 *  focusedSessionId（惰性 computed，首次求值 pinia 已 active）——本容器自持绑定，不依赖
 *  useSideDrawer 兼容层的模块顶层 bind 副作用（C1：兼容层保留仅服务残留消费方，新代码直连 core）。
 *  方法委托 core coordination 公开 API（openDrawerTab 等）。
 *  bindDrawerSessionId 幂等：同语义 computed 重复绑定不报错（useSideDrawer 兼容层若已绑则覆盖，
 *  值等价）。 */
bindDrawerSessionId(computed<string | null>(() => usePanelStore().focusedSessionId))
const { isOpen: drawerOpen, activeTab: drawerTab, docked: drawerDocked } = useDrawerControl()

// drawer「计划产物」tab 自动打开接线（plan 模式重设计 u1-drawer-tab）：plan 激活/首份产物
// 边界经 ADR-0053 pendingOpen 语义打开 drawer（同宿主横幅/审批条的消费源 = planStore 焦点
// 分区，本容器是三者的共同 setup 宿主）。
usePlanDrawerSync()

/** bashTask tab 选中态（D5①：selectedBackgroundTaskId undefined=未选中 → 不注入本面板，
 *  DrawerPanel 空态 fallback 承载；core per-session 分区直读，写入方 = 列表 item 点击 D5④） */
const bashTaskSelected = computed(
  () => getDrawerControlState().selectedBackgroundTaskId !== undefined,
)

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
 * ESC 关闭抽屉（panel/spec.md：抽屉是浮层，ESC 收起）。壳层职责（W3 C3；旧 SideDrawer onKeyDown
 * 迁移）。仅在 drawer 打开时挂监听，避免抽屉关闭后仍抢全局 keydown（如 composer 输入态）。
 * 单实例安全：drawer 由 PanelContainer 单实例挂载（本组件注释「drawer 固定挂本容器，单实例」），
 * watch(drawerOpen) 挂/卸全局 keydown 不会重复注册（规则 2）。
 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeDrawer()
  }
}
watch(
  () => drawerOpen.value,
  (open) => {
    if (open) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})

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
</script>
