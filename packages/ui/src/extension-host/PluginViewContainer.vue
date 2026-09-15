<script setup lang="ts">
/**
 * PluginViewContainer（W4 · T3）——sidebar plugins tab 的 L2 二级路由容器。
 *
 * 数据流：inject VIEWS_SOURCE_KEY（壳 provide，ContributionRegistry sidebar.tab
 * 视图贡献）→ computed views → L2TabBar 渲染二级 tab + ViewHost 按 activeViewId
 * 渲染对应 view 的 GuiComponent 树（ViewHostStore 缓存）。
 *
 * 本地状态（design T3 约束，均不持久化）：
 * - activeViewId：切 tab 只改它；默认 = 第一个可见（未关闭）view
 * - closedViewIds：close 事件对 non-builtin 生效（本地 ref 移除，不持久化）
 * - pinnedViewIds：pin 事件切换本地 ref
 *
 * builtin 判定：view.pluginId ∈ BUILTIN_PLUGIN_IDS（core builtin-contributions.ts 的
 * tasks / base-tool-enhance 声明）→ 不可关闭（L2TabBar 不渲染 close 按钮，容器侧再守卫）。
 *
 * icon：view.icon 当前无图标源（壳透传 undefined），统一以 default icon 兜底（见 DEFAULT_ICON）。
 *
 * 原生视图路由（background-task-sidebar-view D4②）：NATIVE_VIEWS_KEY 注入契约
 * （viewId → 原生组件，壳 provide；ui 包不反向依赖 renderer，无法静态注册
 * BackgroundTaskListView）——activeView 命中键即渲染原生组件替代 ViewHost
 * （sessionId 透传，数据分区由组件内部按 session 处理），不命中走原 GuiComponent
 * 路径（对既有 view 零影响；未注入时全部 view 走原路径，回归安全）。
 *
 * L2 badge（D4④）：L2_TAB_BADGE_SOURCE_KEY 注入数据源（壳实现 = 运行中桶 > 0，
 * 与 renderer 分桶 SSOT 同源派生），容器只做 viewId → boolean → L2TabItem.badge
 * 流转；未注入时全部 tab 不亮（生产接线前回归安全）。
 *
 * 无注入 source / 无 views：静默空态不崩（对齐 ViewHost 的 inject null 语义）。
 */
import { computed, inject, ref } from 'vue'
import type { Component } from 'vue'
import { LayoutGrid } from '@lucide/vue'
import { builtinContributions } from '@taiji/core/extension-host'
import { VIEWS_SOURCE_KEY, type PluginViewSummary } from './views-source'
import L2TabBar from './L2TabBar.vue'
import { L2_TAB_BADGE_SOURCE_KEY, NATIVE_VIEWS_KEY, type L2TabItem } from './l2-tab-item'
import ViewHost from './ViewHost.vue'

const props = defineProps<{
  /** 透传给 ViewHost / 原生视图的 sessionId（view 按 session 分区） */
  sessionId: string
}>()

const source = inject(VIEWS_SOURCE_KEY, null)
/** 原生视图映射（壳 provide；null = 未接线 → 全部 view 走 ViewHost 原路径） */
const nativeViews = inject(NATIVE_VIEWS_KEY, null)
/** badge 数据源（壳 provide；null = 未接线 → 全部 tab 不亮） */
const badgeSource = inject(L2_TAB_BADGE_SOURCE_KEY, null)

/** builtin plugin（core builtin-contributions 声明单源派生，消双处字面量）——不可关闭。
 *  派生全集含 statusline（其无 sidebar.tab view 贡献，views 查询永不命中该 id），
 *  判定行为与原字面量 { tasks, base-tool-enhance } 等价。 */
const BUILTIN_PLUGIN_IDS = new Set(builtinContributions.map((c) => c.pluginId))

/** 通用 default icon（静态声明 view 未配 icon 时使用，统一 LayoutGrid） */
const DEFAULT_ICON: Component = LayoutGrid

/** 全部贡献 view（无 source 注入 → 空数组，静默空态） */
const views = computed<PluginViewSummary[]>(() => source?.getViews(props.sessionId) ?? [])

// ── 本地状态（close/pin 不持久化，design T2/T3 约束）──
const activeViewId = ref<string | null>(null)
const closedViewIds = ref<Set<string>>(new Set())
const pinnedViewIds = ref<Set<string>>(new Set())

/** 可见 views（排除本地 close 的） */
const visibleViews = computed<PluginViewSummary[]>(() =>
  views.value.filter((v) => !closedViewIds.value.has(v.viewId)),
)

/** L2 二级 tab 数据（icon 字典解析 + builtin/pinned/badge 标记） */
const tabs = computed<L2TabItem[]>(() => {
  // badge 源每次调用返回 viewId → boolean 映射（D4④）；在 computed 内调用，
  // 壳实现内部读取的响应式状态被追踪，状态变化自动失效重算
  const badges = badgeSource ? badgeSource(props.sessionId) : null
  return visibleViews.value.map((v) => ({
    viewId: v.viewId,
    title: v.title,
    icon: DEFAULT_ICON,
    pinned: pinnedViewIds.value.has(v.viewId),
    builtin: BUILTIN_PLUGIN_IDS.has(v.pluginId),
    badge: badges ? (badges[v.viewId] ?? false) : false,
  }))
})

/** 当前 active view（本地切换；缺省/失效回退第一个可见 view） */
const activeView = computed<string | null>(() => {
  if (activeViewId.value && visibleViews.value.some((v) => v.viewId === activeViewId.value)) {
    return activeViewId.value
  }
  return visibleViews.value[0]?.viewId ?? null
})

/**
 * active view 命中的原生组件（D4② 路由表）；未命中/未接线 → null 走 ViewHost。
 */
const activeNativeView = computed<Component | null>(() => {
  const id = activeView.value
  if (!id || !nativeViews) return null
  return nativeViews[id] ?? null
})

const activeTitle = computed<string | undefined>(() =>
  visibleViews.value.find((v) => v.viewId === activeView.value)?.title,
)

function onSelect(viewId: string): void {
  activeViewId.value = viewId
}

function onClose(viewId: string): void {
  const view = views.value.find((v) => v.viewId === viewId)
  // 守卫：builtin 不可关闭（L2TabBar 已不渲染其 close 按钮，双保险）
  if (!view || BUILTIN_PLUGIN_IDS.has(view.pluginId)) return
  closedViewIds.value.add(viewId)
  // 关闭当前 active 时回退由 activeView computed 自动落到下一个可见 view
  if (activeViewId.value === viewId) activeViewId.value = null
}

function onPin(viewId: string): void {
  const next = new Set(pinnedViewIds.value)
  if (next.has(viewId)) next.delete(viewId)
  else next.add(viewId)
  pinnedViewIds.value = next
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-1 p-1">
    <template v-if="tabs.length > 0">
      <L2TabBar
        :tabs="tabs"
        :model-value="activeView ?? ''"
        @update:model-value="onSelect"
        @close="onClose"
        @pin="onPin"
      />
      <!-- 原生视图路由（D4②）：NATIVE_VIEWS 命中 activeView → 原生组件替代 ViewHost -->
      <component
        :is="activeNativeView"
        v-if="activeNativeView"
        :session-id="props.sessionId"
      />
      <ViewHost
        v-else-if="activeView"
        :view-id="activeView"
        :session-id="props.sessionId"
        :title="activeTitle"
        empty="placeholder"
      />
    </template>
    <!-- 无 tabs（无 source 注入 / 无贡献 view）→ 空态提示，不崩（inject null 语义） -->
    <div
      v-else
      data-testid="plugin-view-empty"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
    >
      <LayoutGrid class="size-5 text-neutral-dim opacity-40" />
      <p class="text-[11px] text-neutral-dim opacity-55">暂无插件视图</p>
    </div>
  </div>
</template>
