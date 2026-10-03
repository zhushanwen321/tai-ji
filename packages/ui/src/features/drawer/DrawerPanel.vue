<!--
  DrawerPanel —— 跨端共享 drawer 容器（W3 · p3-strangler-domains::drawer）。

  迁移自 renderer components/panel/SideDrawer.vue 的「跨端共享容器」部分（drawer 域归位
  第三步：W1 控制态/协同进 core、W3 容器组件进 ui 包）。
  桌面独占内容面板（GitPanel/CommandDocPanel/DetailPane/SubagentTab 等）
  留壳 slot 挂载（D5 硬编码占位，不走 contribution 路由）——本组件经默认 slot 接收，
  空态（activeTabMeta 驱动）作为 slot fallback（C2）。
  [display-containers §7.6 迁移终态] TerminalView 现挂 PanelContainer 底抽屉块、
  BrowserPane 现挂浮层壳（BrowserOverlay），均不再是本组件 slot 内容。
  [P4 s5 drawer-widget-removal] 内置 widget 内容区（gui/lines/status footer）已删：
  旧 extension:widget/widgetGui/status 通道由 PluginViewContainer 承接。

  状态/数据契约（IF2 + clarify C1）：
  - props{isOpen, activeTab, sessionId} 为控制态（父组件 PanelContainer 管理），
    本组件只接收 + emit close/set-tab，不持有状态（§6.3 点5 架构解耦）。
    [display-containers §7.6 W0] docked 死状态删除，pin 按钮一并移除（toggle-dock emit 删除）
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

      <!-- 内容区：壳按 tab 经默认 slot 注入桌面独占面板（Git/Doc/Detail 等）；
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
import { BookOpen, Bot, FileText, GitBranch, Globe, MessagesSquare, SquareCheckBig, SquareTerminal, Terminal as TerminalIcon, Workflow, X } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { RIGHT_DRAWER_REGISTRY } from '@taiji/core/domain/drawer'
import type { RightDrawerTab } from '@taiji/core/domain/drawer'

const slots = useSlots()

/**
 * 默认 slot 是否有有效内容（非注释节点）。
 * C2 契约：桌面壳按 tab 经默认 slot 注入独占面板（Git/Doc/Detail/Subagent 等），
 * 无匹配面板时（如未选中后台任务时 bashTask 不注入）不注入 → 应回退空态占位。但 Vue `<slot>` 的
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
    activeTab: RightDrawerTab
    /** 订阅的 session 标识（壳层透传） */
    sessionId: string | null
  }>(),
  {},
)

const emit = defineEmits<{
  close: []
  'set-tab': [tab: RightDrawerTab]
}>()

const { t } = useI18n()

interface TabMeta {
  key: RightDrawerTab
  label: string
  icon: Component
  emptyText: string
  emptyHint: string
}

/** tab 元信息（图标标识 → @lucide/vue 组件映射，display-containers §7.2：图标是 Vue 组件进不了
 *  core，ui 层建映射表解析渲染；标签/空态文案的 i18n key 由注册表条目携带）。 */
const ICON_BY_ID: Record<string, Component> = {
  terminal: TerminalIcon,
  globe: Globe,
  'git-branch': GitBranch,
  'book-open': BookOpen,
  'file-text': FileText,
  bot: Bot,
  'square-terminal': SquareTerminal,
  'square-check-big': SquareCheckBig,
  'messages-square': MessagesSquare,
  workflow: Workflow,
}

/** 注册表新增图标标识未入映射时的占位（file-text 同形中性图标；新条目评审/测试可见） */
const FALLBACK_ICON: Component = FileText

/** L1 tab 列表 = 右抽屉容器声明（单一权威 §7.7：禁止与注册表各自文字化；终态 8 条——
 *  u-w2-browser-mount 撤 browser 载入序列后直读容器声明）。各 tab 的桌面内容面板仍由壳层
 *  （PanelContainer）经默认 slot v-if chain 注入（C2），本组件不感知面板归属；空态/未读徽章不变。 */
const tabs = computed<TabMeta[]>(() =>
  RIGHT_DRAWER_REGISTRY.map((entry) => ({
    key: entry.content,
    label: t(entry.labelKey),
    icon: ICON_BY_ID[entry.icon] ?? FALLBACK_ICON,
    emptyText: t(entry.emptyTextKey),
    emptyHint: t(entry.emptyHintKey),
  })),
)

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
