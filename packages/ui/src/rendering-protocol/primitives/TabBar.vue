<script setup lang="ts">
/**
 * 标签栏组件（v6）——TC6 连体 pill 范式。
 * 容器 bg-bg-input + rounded-lg + padding 3px（spec .gtabbar padding:3px）；
 * tab 项 rounded-sm，active 用 bg-elevated + neutral-fg 浮起（去 accent-soft 蓝染底）；
 * status=done 显 success 点，status=pending 显 neutral-dim 半透明点。
 */
import type { GuiComponentProps } from '@zhushanwen/extension-protocol'

defineProps<{
  tabs: GuiComponentProps['tab-bar']['tabs']
}>()

const dotClass = (status?: 'done' | 'pending') => {
  if (status === 'done') return 'bg-success'
  if (status === 'pending') return 'bg-neutral-dim opacity-50'
  return ''
}
</script>

<template>
  <div
    class="tab-bar flex gap-0.5 rounded-lg bg-bg-input p-[3px]"
    data-testid="gui-tab-bar"
  >
    <div
      v-for="(tab, i) in tabs"
      :key="i"
      class="tab-bar__tab flex items-center gap-1 rounded-sm px-2.5 py-1 font-mono text-[length:var(--text-xs)] text-neutral-dim transition-colors hover:text-neutral-fg"
      :class="{ 'bg-elevated text-neutral-fg': tab.active }"
    >
      <span
        v-if="tab.status"
        class="tab-bar__dot size-[7px] shrink-0 rounded-full"
        :class="dotClass(tab.status)"
      />
      <span class="tab-bar__label">{{ tab.label }}</span>
    </div>
  </div>
</template>
