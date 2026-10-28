<script setup lang="ts">
/**
 * EmptyState —— 空态三要素容器（remote-use-mobile-v2 §6.9 / spec §6.7）。
 *
 * 规格：图标（20px 线性）+ 一句说明 + 一个主行动，三要素缺一不可——icon/title
 * 必填，主行动经默认插槽由消费方放 Button（本原语不内置文案、不内置行动语义）。
 * 禁止纯「暂无数据」式空态（DESIGN.md §5.13 同律）。
 */
import type { Component } from 'vue'

defineProps<{
  /** 空态图标（@lucide/vue 组件，20px 渲染） */
  icon: Component
  /** 一句说明（主文案） */
  title: string
  /** 补充说明（可选次行） */
  description?: string
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 px-8 py-14 text-center" data-testid="empty-state">
    <span class="flex size-12 items-center justify-center rounded-full bg-surface text-neutral-mid" aria-hidden="true">
      <component :is="icon" class="size-5" :stroke-width="1.7" />
    </span>
    <div class="flex flex-col gap-1">
      <p class="font-semibold text-[length:var(--m-text-callout)] leading-[var(--m-leading-ui)] text-neutral-fg" data-testid="empty-state-title">{{ title }}</p>
      <p v-if="description" class="text-pretty text-[length:var(--m-text-sub)] leading-[var(--m-leading-ui)] text-neutral-mid" data-testid="empty-state-description">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="pt-1" data-testid="empty-state-action">
      <slot />
    </div>
  </div>
</template>
