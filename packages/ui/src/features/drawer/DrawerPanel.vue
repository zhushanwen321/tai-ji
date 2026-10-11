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

  R3 抽屉域焦点收敛（ui-replica MF-1-51，demo drawers.css「元素级重置收窄到抽屉根」）：
  aside 根持容器级 focus-visible 覆盖——input 聚焦零框（光标即反馈，与 composer 同规）。
  MF-1-71 后全局 Input 聚焦走 outline 通道，抽屉域须双属性同压：shadow-none 压
  ring/box-shadow 通道 + outline-none 压 outline 通道（漏一即穿，MF-1-51×MF-1-71
  合流缺口教训）；[tabindex]
  键盘焦点 = inset 1px --border-strong + outline-none 双压（demo drawers.css .rd
  [tabindex]:focus-visible 同款双声明——只压 shadow 通道时 UA 默认 focus 环仍在，
  与 inset 框叠双框；[tabindex] 覆盖 DetailPane 等 role=tab 后代）。button 键盘焦点 =
  inset 1px --border-strong（压掉 ui Button 基类 ring-2 外环——ring-0 + ring-offset-0
  归零 ring 变量后由 inset shadow 承接）。作用域只罩本 aside 后代，不触全局
  Input.vue / button-variants.ts 基类。

  状态/数据契约（IF2 + clarify C1）：
  - props{isOpen, activeTab, sessionId} 为控制态（父组件 PanelContainer 管理），
    本组件只接收 + emit close/set-tab，不持有状态（§6.3 点5 架构解耦）。
    [display-containers §7.6 W0] docked 死状态删除，pin 按钮一并移除（toggle-dock emit 删除）
  - [P4 s5 w2] hasTasksData 条件 tab（tasks store 壳裁剪）已随 tasks 域删除移除

  不纳入（C3 clarify）：ESC 关闭 + AC-13 unread badge（chatStore 壳层状态）——均为壳层
  职责，在 PanelContainer 侧处理（经可选具名 slot header-extra 注入 badge，本组件零
  chatStore 依赖）。[终态同步更正] ESC 已随 display-containers §6.7 W1 并入 key-orchestrator
  栈序编排器（唯一属主），不再是壳层 window keydown 职责（W1 修正注记在 PanelContainer 内）。
-->
<template>
    <Transition name="drawer-slide-right">
    <aside
      v-if="isOpen"
      class="relative flex h-full min-w-0 flex-col rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-1)] [&_input:focus-visible]:shadow-none [&_input:focus-visible]:outline-none [&_button:focus-visible]:ring-0 [&_button:focus-visible]:ring-offset-0 [&_button:focus-visible]:shadow-[inset_0_0_0_1px_var(--border-strong)] [&_[tabindex]:focus-visible]:shadow-[inset_0_0_0_1px_var(--border-strong)] [&_[tabindex]:focus-visible]:outline-none"
      :aria-label="t('panel.sideDrawer.title')"
      data-testid="drawer-panel"
    >
      <!-- L1 tab 栏：drawer 内部子区。三卡化（2026-10-04）后 aside 与 main 同为 surface 卡片，
           「aside 深底 bg 色差分隔」的前提消失，L1 选中态回归 DESIGN §3.4 标准 tab 型
           （bg-elevated + neutral-fg）。ui-replica M5 对齐 demo（drawers.css .l1bar）：
           栏底补 hairline 分隔线（E1：顶部固定 chrome 与内容区有边界，与底抽屉实例条同构）；
           tab 列可横滚 + 12px 双侧渐隐 mask（G5：scrollbar 隐藏时裁切内容唯一的可视提示，
           窄抽屉下 8 个 tab 可滚动触达不丢失）。mask 颜色段仅取 alpha 语义
           （rgba(0,0,0,1)=不透明显示），非颜色令牌消费，不随主题变化，故用 rgba 形式。 -->
      <div class="flex items-center gap-1 border-b border-hairline px-2 py-1.5">
        <div
          class="flex flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(90deg,transparent,rgba(0,0,0,1)_12px,rgba(0,0,0,1)_calc(100%_-_12px),transparent)]"
        >
          <Button
            v-for="tab in tabs"
            :key="tab.key"
            variant="ghost"
            class="size-[30px] shrink-0 justify-center rounded-sm p-0"
            :class="activeTab === tab.key ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated' : 'text-neutral-mid hover:text-neutral-fg'"
            :title="tab.label"
            :data-testid="`drawer-tab-${tab.key}`"
            @click="emit('set-tab', tab.key)"
          >
            <component :is="tab.icon" class="!size-3.5" stroke-width="1.8" />
          </Button>
        </div>

        <!-- header-extra：壳层注入点（W4）——unread badge 等桌面形态壳状态经此挂载（C3：壳层职责）。
             可选具名 slot，无默认内容；ui 容器零 chatStore 感知（D3 纯净性）。 -->
        <slot name="header-extra" />
        <!-- 容器级关闭控件统一放右簇最右（2026-10-04 裁决：关闭语义控件恒在容器右缘最右，
             与底抽屉收起按钮、终端 tab 关闭叉同一侧性）。demo .dclose：28×28 + 12px 图标
             stroke 1.8；字色对齐 demo 运行时渲染口径（r5 探针实测 computed rgb(236,236,236)
             = --fg，静态 drawers.css 的 --neutral-mid 声明被后序规则覆盖，以渲染权威为准）。 -->
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-neutral-fg hover:text-neutral-fg"
          :title="t('panel.sideDrawer.close')"
          data-testid="drawer-close"
          @click="emit('close')"
        >
          <X class="!size-3" stroke-width="1.8" />
        </Button>
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
             tab 切换改瞬时 v-if/v-else，稳定性优先。
             [P4 s5 drawer-widget-removal] 原 gui→lines→空态三支已删（widget 通道移除），仅剩空态。
             面板方向滑入（demo drawers.css 裁决 10B / spec §3.3）：CSS animation 形态（非 Vue
             Transition，不触 out-in 调度 bug）——新面板按目标 tab 相对当前位置自左/右 10px 滑入 +
             淡入；wrapper :key=activeTab 使每次 tab 切换重放动画（v-if chain 换面板本就重建，
             key 仅保证动画类复挂时也重放）；slideDir 初始空 = 抽屉首次打开不叠面板动画（壳层
             已有开合入场，避免双层叠加，spec §3.3）。 -->
        <div
          v-if="hasDesktopPanelContent()"
          :key="activeTab"
          class="h-full min-h-0"
          :class="slideAnimClass"
          data-testid="drawer-panel-slot"
        >
          <slot />
        </div>
        <!-- active tab 无内容面板 → 空态占位（demo .empty：图标 24px dim 40% + e1 md 档 mid +
             e2 sm 档 dim，均无附加透明度） -->
        <div
          v-else
          class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
          data-testid="drawer-widget-empty"
        >
          <component :is="activeTabMeta.icon" class="size-6 text-neutral-dim opacity-40" stroke-width="1.6" />
          <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ activeTabMeta.emptyText }}</p>
          <p class="text-[length:var(--text-2xs)] text-neutral-dim">{{ activeTabMeta.emptyHint }}</p>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { Comment, computed, ref, useSlots, watch } from 'vue'
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

// ── 面板方向滑入（demo drawers.css 裁决 10B，spec §3.3）────────────────────
// 目标 tab 在当前 tab 右侧 → 新面板自右 10px 滑入（from-r），反之自左（from-l）。
// slideDir 初始空：抽屉首次打开不叠面板动画（壳层 wrapper width 过渡 + aside 显隐过渡
// 已是两层，面板再加一层 = 三层叠加，spec §3.3 明示排除）；仅在 tab 变化后才有值。
// 方向查表用注册表序（tabs computed，与 L1 栏渲染序同源，不另立 tab 序）。
type SlideDir = '' | 'from-r' | 'from-l'
const slideDir = ref<SlideDir>('')
watch(
  () => props.activeTab,
  (nv, ov) => {
    const ni = tabs.value.findIndex((tab) => tab.key === nv)
    const oi = tabs.value.findIndex((tab) => tab.key === ov)
    slideDir.value = ni < 0 || oi < 0 || ni === oi ? '' : ni > oi ? 'from-r' : 'from-l'
  },
)
const slideAnimClass = computed(() =>
  slideDir.value === 'from-r' ? 'drawer-panel-slide-r' : slideDir.value === 'from-l' ? 'drawer-panel-slide-l' : '',
)
</script>

<style scoped>

/* 抽屉从右缘滑入/滑回（panel/spec.md v2 + chat-flow-polish P1-1）。
   语义「从右缘来、回右缘去」（Spatial consistency）：opacity 淡入 + translateX(16px→0) 位移。
   transform 不触发布局（drawer 是 SplitterPanel，避免 width 动画引起 main reflow）。
   escape hatch：Vue Transition 类无法用 Tailwind 表达（需 enter-from/leave-to 同时设 transform）。
   E5 方向缓动（demo drawers.css .rd）：开 = ease-out（快起缓停，跟手）、关 = ease-in（缓起快走，
   利落）；时长 = demo --dur-base（显隐层专属档，与壳层 width 过渡 --duration-slow 分层
   各自独立——demo 两层时长本就不同），消费令牌层既有 --duration（值 200ms 与 demo
   --dur-base 同值，MF-2-17 收编，不新增 --duration-base 重复令牌）。 */
.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
.drawer-slide-right-enter-active {
  transition:
    opacity var(--duration) var(--ease-out),
    transform var(--duration) var(--ease-out);
}
.drawer-slide-right-leave-active {
  transition:
    opacity var(--duration) var(--ease-in),
    transform var(--duration) var(--ease-in);
}

/* 一级面板切换方向滑入（demo drawers.css 裁决 10B）：按目标 tab 相对位置自左/右 10px + 淡入。
   形态 = CSS animation（进场上映一次即止，非 Vue Transition——out-in 调度 bug 见上方模板
   HISTORICAL 注记）；时长消费 --duration-slow（面板形变档 320ms，demo 同场景 300ms 字面值
   归档到 real 三档制的慢档，差 20ms 不可感知）+ --ease-out-soft（demo 动效纪律「入场统一
   软缓出」，令牌注释已登记本场景为预期消费方）。no-preference 包裹 = reduce 环境动画整体
   不定义（比全局 reduce 兜底的「温和过渡」更彻底，同 demo drawers.css reduce 块约定）。 */
@media (prefers-reduced-motion: no-preference) {
  .drawer-panel-slide-r {
    animation: drawer-panel-slide-r var(--duration-slow) var(--ease-out-soft);
  }
  .drawer-panel-slide-l {
    animation: drawer-panel-slide-l var(--duration-slow) var(--ease-out-soft);
  }
}
@keyframes drawer-panel-slide-r {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
}
@keyframes drawer-panel-slide-l {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
}
</style>
