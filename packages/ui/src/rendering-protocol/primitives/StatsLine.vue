<script setup lang="ts">
/**
 * 统计行组件（v6）——severity 收窄。
 * 水平排列键值对，item 间用 border-l 分隔（首项无分隔线，hairline 保留）。
 * value severity 收窄：danger 保留 text-danger，ok/warn 降 text-neutral-fg（弱化非危险态的颜色噪音）。
 * label 可选。
 */
import type { StatItem } from '@zhushanwen/extension-protocol'

defineProps<{
  items: StatItem[]
}>()

/** v6：severity 收窄——danger 保留，ok/warn/无 → neutral-fg */
const valueClass = (severity?: StatItem['severity']) => {
  if (severity === 'danger') return 'text-danger'
  return 'text-neutral-fg'
}
</script>

<template>
  <div class="stats-line flex flex-wrap items-center gap-0 font-mono text-[length:var(--text-sm)]" data-testid="gui-stats-line">
    <div
      v-for="(item, i) in items"
      :key="i"
      class="stats-line__item flex items-center gap-1 px-3 first:pl-0"
      :class="{ 'border-l border-border': i > 0 }"
    >
      <span v-if="item.label" class="stats-line__label text-neutral-dim">{{ item.label }}</span>
      <span class="stats-line__value font-medium tabular-nums" :class="valueClass(item.severity)">
        {{ item.value }}
      </span>
    </div>
  </div>
</template>
