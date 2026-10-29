<script setup lang="ts">
// BottomNav —— 移动壳底部导航（remote-use-mobile-v2 §7.1：三目的域布局——会话/进行中/设置；
// 聊天是详情页不占目的域，chat 态本导航整体隐藏，返回经聊天页顶部返回按钮 → popstate 回源）。
//
// v-model 驱动（状态驱动切换，项目约定不用 vue-router；route.ts 状态机是唯一权威）。
// safe-area 分治（remote-use A16）：壳内贴底 chrome，底部 inset 由本组件 pb 避让（iOS 形态：bar 背景
// 延伸进 Home Indicator 区，内容经 padding 避让）——变量唯一点 = styles/tokens.css。
//
// 计数角标段（u-activity 落位）：进行中目的域的待办计数（§6.18 聚合半）。数据源 =
// companion-bridge usePendingTodoSummary——与 ActivityScreen「需要你处理」区消费同一
// computed（单数据源），「导航计数与聚合区计数一致」由构造性保证；total 为 0 不渲染
// 角标（无待办无角标，不占位）。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, Settings, SquareStack } from '@lucide/vue'
import type { Component } from 'vue'
import type { ChatSourceDomain } from '../shell/route'
import { usePendingTodoSummary } from '../shell/companion-bridge'

const props = defineProps<{ modelValue: ChatSourceDomain }>()

const emit = defineEmits<{ (e: 'update:modelValue', tab: ChatSourceDomain): void }>()

const { t } = useI18n()

const pendingTotal = usePendingTodoSummary()

const activityBadgeCount = computed(() => pendingTotal.value.total)

const NAV_ITEMS: ReadonlyArray<{ id: ChatSourceDomain; icon: Component; labelKey: string }> = [
  { id: 'sessions', icon: SquareStack, labelKey: 'mobile.tabs.sessions' },
  { id: 'activity', icon: Activity, labelKey: 'mobile.tabs.activity' },
  { id: 'settings', icon: Settings, labelKey: 'mobile.tabs.settings' },
]

function onSelect(tab: ChatSourceDomain): void {
  if (tab !== props.modelValue) emit('update:modelValue', tab)
}
</script>

<template>
  <nav
    class="flex shrink-0 items-stretch border-t border-[var(--border)] bg-bg pb-[var(--safe-area-bottom)]"
    data-testid="bottom-nav"
    role="tablist"
  >
    <!-- role="tab" 条目（tablist 导航 ARIA 形态，aria-selected 标当前；非原生条目先例 =
         v1 BottomTabBar / CompanionBand role="radio"）；--m-tap 触控热区（u-foundation 尺度层）。
         计数角标：图标右上角数字徽标（aria-hidden——数字经 nav 元素外的聚合区可感知，
         徽标重复播报冗余），total 为 0 不渲染。 -->
    <div
      v-for="item in NAV_ITEMS"
      :key="item.id"
      role="tab"
      tabindex="0"
      class="flex min-h-[var(--m-tap)] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 py-2 outline-none transition-colors"
      :class="item.id === modelValue ? 'text-accent' : 'text-neutral-mid'"
      :aria-selected="item.id === modelValue"
      :data-testid="`mobile-nav-${item.id}`"
      @click="onSelect(item.id)"
      @keydown.enter="onSelect(item.id)"
    >
      <span class="relative inline-flex">
        <component :is="item.icon" class="size-5" />
        <span
          v-if="item.id === 'activity' && activityBadgeCount > 0"
          class="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-medium leading-none text-white"
          data-testid="nav-badge-activity"
          aria-hidden="true"
        >{{ activityBadgeCount > 99 ? '99+' : activityBadgeCount }}</span>
      </span>
      <span class="text-xs">{{ t(item.labelKey) }}</span>
    </div>
  </nav>
</template>
