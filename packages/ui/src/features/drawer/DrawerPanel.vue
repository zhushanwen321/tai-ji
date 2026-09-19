<!--
  DrawerPanel —— 跨端共享 drawer 容器（W3 · p3-strangler-domains::drawer）。

  迁移自 renderer components/panel/SideDrawer.vue 的「跨端共享容器」部分（drawer 域归位
  第三步：W1 控制态/协同进 core、W3 容器组件进 ui 包）。
  桌面独占内容面板（GitPanel/TerminalView/BrowserPane/CommandDocPanel/DetailPane）
  留壳 slot 挂载（D5 硬编码占位，不走 contribution 路由）——本组件经默认 slot 接收，
  空态（activeTabMeta 驱动）作为 slot fallback（C2）。
  [P4 s5 drawer-widget-removal] 内置 widget 内容区（gui/lines/status footer）已删：
  旧 extension:widget/widgetGui/status 通道由 PluginViewContainer 承接。

  状态/数据契约（IF2 + clarify C1）：
  - props{isOpen, activeTab, docked, sessionId} 为控制态（父组件 PanelContainer 管理），
    本组件只接收 + emit close/set-tab/toggle-dock，不持有状态（§6.3 点5 架构解耦）
  - [P4 s5 w2] hasTasksData 条件 tab（tasks store 壳裁剪）已随 tasks 域删除移除

  不纳入（C3 clarify）：ESC 关闭（window keydown 桌面副作用）+ AC-13 unread badge
  （chatStore 壳层状态）——均为壳层职责，W4 shell-integration 在 PanelContainer 侧处理
  （经可选具名 slot header-extra 注入 badge，本组件零 chatStore 依赖）。
-->
<template>
  <Transition name="drawer-slide-right">
    <aside
      v-if="isOpen"
      class="relative flex h-full min-w-0 flex-col rounded-r bg-bg"
      :aria-label="t('panel.sideDrawer.title')"
      data-testid="drawer-panel"
    >
      <!-- L1 tab 栏：drawer 内部子区。2026-08-14 裁决遵循 v6-drawer-tabs-demo 层次语言
           （推翻 spec D2 一体化同色）：aside 深底 bg（比 main surface 深一档）+ 右圆角
           构成与 main 的色差分隔；L1 栏继承 aside 深底、无 border-b（demo .drawer-l1 无分隔线）。
           [2026-09-09] 曾有的弱投影（--shadow-drawer）已删：父级 drawer-area overflow-hidden
           会裁剪后代 box-shadow，该投影自布局收紧后从未实际可见（死样式）。 -->
      <div class="flex items-center gap-1 px-2 py-1.5">
        <div class="flex flex-1 gap-0.5">
          <Button
            v-for="tab in tabs"
            :key="tab.key"
            variant="ghost"
            class="size-[30px] shrink-0 justify-center rounded-sm p-0"
            :class="activeTab === tab.key ? 'bg-surface-hover text-neutral-fg' : 'text-neutral-mid'"
            :title="tab.label"
            :data-testid="`drawer-tab-${tab.key}`"
            @click="emit('set-tab', tab.key)"
          >
            <component :is="tab.icon" class="size-3.5" />
          </Button>
        </div>

        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0"
          :class="docked ? 'text-accent' : 'text-neutral-dim'"
          :title="docked ? t('panel.sideDrawer.unpin') : t('panel.sideDrawer.pin')"
          data-testid="drawer-pin"
          @click="emit('toggle-dock')"
        >
          <PinOff v-if="docked" class="size-3" />
          <Pin v-else class="size-3" />
        </Button>
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
          :title="t('panel.sideDrawer.close')"
          data-testid="drawer-close"
          @click="emit('close')"
        >
          <X class="size-3" />
        </Button>
        <!-- header-extra：壳层注入点（W4）——unread badge 等桌面形态壳状态经此挂载（C3：壳层职责）。
             可选具名 slot，无默认内容；ui 容器零 chatStore 感知（D3 纯净性）。 -->
        <slot name="header-extra" />
      </div>

      <!-- 内容区：壳按 tab 经默认 slot 注入桌面独占面板（Git/Terminal/Browser 等）；
           slot 无有效内容时（v-if chain 全 false / 跨端不传 slot）回退空态占位（activeTabMeta 驱动）。
           用 hasDesktopPanelContent() 而非 `<slot>` fallback：父组件提供 slot 函数但运行时为空时，
           Vue 的 slot fallback 不生效，需显式判断渲染结果。 -->
      <div class="min-h-0 flex-1 overflow-auto" data-testid="drawer-content">
        <!-- [HISTORICAL] 内容区曾用 <Transition mode="out-in">做 tab 切换淡入（4f8399cac），
             2026-08 移除：Vue 3.5.39 下 Transition out-in leave 完成后 enter 不触发（调度 bug），
             内容区永久空白死锁（dev app 实测 8/8 复现）。同构踩坑已 3 处
             （本处 / Sidebar workflow / SettingsModal）。vue_rules_checker.py 已加规则禁止该写法。
             tab 切换改瞬时 v-if/v-else（无动画），稳定性优先。
             [P4 s5 drawer-widget-removal] 原 gui→lines→空态三支已删（widget 通道移除），仅剩空态。 -->
        <slot v-if="hasDesktopPanelContent()" />
        <!-- active tab 无内容面板 → 空态占位 -->
        <div
          v-else
          class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
          data-testid="drawer-widget-empty"
        >
          <component :is="activeTabMeta.icon" class="size-6 text-neutral-dim opacity-40" />
          <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-70">{{ activeTabMeta.emptyText }}</p>
          <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-50">{{ activeTabMeta.emptyHint }}</p>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { Comment, computed, useSlots } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Bot, FileText, GitBranch, Globe, Pin, PinOff, SquareCheckBig, SquareTerminal, Terminal as TerminalIcon, Workflow, X } from '@lucide/vue'
import { Button } from '@taiji/ui'
import type { SideDrawerTab } from '@taiji/core/domain/drawer'

const slots = useSlots()

/**
 * 默认 slot 是否有有效内容（非注释节点）。
 * C2 契约：桌面壳按 tab 经默认 slot 注入独占面板（Git/Doc/Detail/Browser/Terminal），
 * 无匹配面板时（如 browser 无 url）不注入 → 应回退空态占位。但 Vue `<slot>` 的
 * fallback 只在「父组件未提供 slot 函数」时生效——PanelContainer 的 v-if chain 使 slot 函数
 * 始终存在（运行时渲染为空/注释节点），故需在此显式判断渲染结果，空则走空态。
 * 非 computed：slots.default() 返回的 VNode 无响应式依赖，computed 缓存不失效；
 * 模板表达式每次渲染求值才能反映 tab 切换后的 slot 内容。
 */
function hasDesktopPanelContent(): boolean {
  const children = slots.default?.() ?? []
  return children.some((v) => v && (v.type as unknown) !== Comment)
}

const props = withDefaults(
  defineProps<{
    isOpen: boolean
    activeTab: SideDrawerTab
    docked: boolean
    /** 订阅的 session 标识（壳层透传） */
    sessionId: string | null
  }>(),
  {},
)

const emit = defineEmits<{
  close: []
  'set-tab': [tab: SideDrawerTab]
  'toggle-dock': []
}>()

const { t } = useI18n()

interface TabMeta {
  key: SideDrawerTab
  label: string
  icon: Component
  emptyText: string
  emptyHint: string
}

/** tab 元信息（§6.3 点2：Terminal/Browser/Git/Doc/Detail）。
 *  Git tab 内容为 GitPanel（壳 slot 注入，inject 数据）。
 *  [P4 s5 w2] Tasks 条件 tab（T3 壳裁剪）已随 tasks 域删除移除。 */
const tabs = computed<TabMeta[]>(() => {
  const base: TabMeta[] = [
    {
      key: 'terminal',
      label: t('panel.sideDrawer.tabTerminal'),
      icon: TerminalIcon,
      emptyText: t('panel.sideDrawer.noTerminal'),
      emptyHint: t('panel.sideDrawer.terminalHint'),
    },
    {
      key: 'browser',
      label: t('panel.sideDrawer.tabBrowser'),
      icon: Globe,
      emptyText: t('panel.sideDrawer.noBrowser'),
      emptyHint: t('panel.sideDrawer.browserHint'),
    },
    {
      key: 'git',
      label: t('panel.sideDrawer.tabGit'),
      icon: GitBranch,
      emptyText: t('panel.sideDrawer.noGit'),
      emptyHint: t('panel.sideDrawer.gitHint'),
    },
    {
      key: 'doc',
      label: t('panel.sideDrawer.tabDoc'),
      icon: BookOpen,
      emptyText: t('panel.sideDrawer.noDoc'),
      emptyHint: t('panel.sideDrawer.docHint'),
    },
    {
      key: 'detail',
      label: t('panel.sideDrawer.tabDetail'),
      icon: FileText,
      emptyText: t('panel.sideDrawer.noFileSelected'),
      emptyHint: t('panel.sideDrawer.detailHint'),
    },
    // subagent/workflow 一级 tab（2026-08-14 subagent-workflow-drawer-tab U2）：
    // collapsed only chat 块点击 → openSubagent/openWorkflow 开对应 tab。
    // 内容由壳层（PanelContainer）经默认 slot v-if chain 注入 SubagentTab/WorkflowTab
    // （ui 库不 import renderer 组件，延续 D5 硬编码占位留壳 slot 挂载模式）。
    {
      key: 'subagent',
      label: t('panel.sideDrawer.tabSubagent'),
      icon: Bot,
      emptyText: t('panel.sideDrawer.noSubagent'),
      emptyHint: t('panel.sideDrawer.subagentHint'),
    },
    {
      key: 'workflow',
      label: t('panel.sideDrawer.tabWorkflow'),
      icon: Workflow,
      emptyText: t('panel.sideDrawer.noWorkflow'),
      emptyHint: t('panel.sideDrawer.workflowHint'),
    },
    // bashTask tab（2026-09 background-task-sidebar-view D5②）：后台命令详情。内容由壳层
    // （PanelContainer）经默认 slot v-if chain 注入 BackgroundTaskDetailPanel（未选中任务
    // 不注入 → 本组件空态 fallback），延续 ui 库不 import renderer 组件的留壳 slot 模式。
    {
      key: 'bashTask',
      label: t('panel.sideDrawer.tabBashTask'),
      icon: SquareTerminal,
      emptyText: t('panel.sideDrawer.noBashTask'),
      emptyHint: t('panel.sideDrawer.bashTaskHint'),
    },
    // plan tab（plan 模式重设计 u1-drawer-tab G2）：计划产物（agent 按 skill 流程产出的
    // 多文档审阅面）。内容由壳层（PanelContainer）经默认 slot v-if chain 注入空面板骨架
    // （PlanDocsPanel 归 u1-docs-panel），延续留壳 slot 模式；自动打开经 ADR-0053
    // per-session pendingOpen 语义（renderer 侧 usePlanDrawerSync 接线，本组件不感知）。
    // i18n key 落 plan 域文件（plan.drawer.*）——tab 语义属 plan 模式域，不并入 panel.sideDrawer。
    {
      key: 'plan',
      label: t('plan.drawer.tabPlan'),
      icon: SquareCheckBig,
      emptyText: t('plan.drawer.noPlan'),
      emptyHint: t('plan.drawer.planHint'),
    },
  ]
  return base
})

const activeTabMeta = computed<TabMeta>(() => tabs.value.find((tab) => tab.key === props.activeTab) ?? tabs.value[0])
</script>

<style scoped>
/* 抽屉从右缘滑入/滑回（panel/spec.md v2 + chat-flow-polish P1-1）。
   语义「从右缘来、回右缘去」（Spatial consistency）：opacity 淡入 + translateX(16px→0) 位移。
   transform 不触发布局（drawer 是 SplitterPanel，避免 width 动画引起 main reflow）。
   escape hatch：Vue Transition 类无法用 Tailwind 表达（需 enter-from/leave-to 同时设 transform）。 */
.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
.drawer-slide-right-enter-active,
.drawer-slide-right-leave-active {
  transition:
    opacity var(--duration-slow) var(--ease),
    transform var(--duration-slow) var(--ease);
}
</style>
