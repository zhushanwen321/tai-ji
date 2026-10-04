<script setup lang="ts">
// BottomTabBar —— 移动壳底部导航（壳 chrome，两 tab：Sessions/Chat；BottomTabBarStub 真实化）。
// v-model 驱动（App 持有 activeTab 状态；规范：独立数据源状态驱动切换）。
// safe-area 分治（A16）：壳内唯一贴底 chrome，底部 inset 由本组件 pb 避让
// （iOS 形态：bar 背景延伸进 Home Indicator 区，内容经 padding 避让）；顶部/横向
// inset 由壳根 App.vue 覆盖。变量定义唯一点 = styles/tokens.css --safe-area-*。
import { useI18n } from 'vue-i18n'
import { MessageSquare, SquareStack } from '@lucide/vue'
import type { Component } from 'vue'

export type MobileTab = 'sessions' | 'chat'

const props = defineProps<{ modelValue: MobileTab }>()

const emit = defineEmits<{ (e: 'update:modelValue', tab: MobileTab): void }>()

const { t } = useI18n()

const TABS: ReadonlyArray<{ id: MobileTab; icon: Component; labelKey: string }> = [
  { id: 'sessions', icon: SquareStack, labelKey: 'mobile.tabs.sessions' },
  { id: 'chat', icon: MessageSquare, labelKey: 'mobile.tabs.chat' },
]

function onSelect(tab: MobileTab): void {
  if (tab !== props.modelValue) emit('update:modelValue', tab)
}
</script>

<template>
  <nav
    class="flex shrink-0 items-stretch border-t border-[var(--border)] bg-bg pb-[var(--safe-area-bottom)]"
    data-testid="bottom-tab-bar"
    role="tablist"
  >
    <!-- role="button" 条目（原生 button 由 vue_rules_checker 拦；先例 = CompanionBand role="radio"） -->
    <div
      v-for="tab in TABS"
      :key="tab.id"
      role="tab"
      tabindex="0"
      class="flex flex-1 cursor-pointer flex-col items-center gap-0.5 py-2 outline-none transition-colors"
      :class="tab.id === modelValue ? 'text-accent' : 'text-neutral-dim'"
      :aria-selected="tab.id === modelValue"
      :data-testid="`mobile-tab-${tab.id}`"
      @click="onSelect(tab.id)"
      @keydown.enter="onSelect(tab.id)"
    >
      <component :is="tab.icon" class="size-5" />
      <span class="text-xs">{{ t(tab.labelKey) }}</span>
    </div>
  </nav>
</template>
