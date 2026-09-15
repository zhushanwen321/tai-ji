<script setup lang="ts">
/**
 * SettingRow —— v6 设置行原语（label + 12px neutral-mid desc + 右侧 control slot）。
 * 用于 SystemPage 等设置页内的「左标签 + 右控件」行范式。
 * 与 demo .tmp/v6/src/components/settings/SettingRow.vue 范式对齐。
 */
defineProps<{
  label: string
  desc?: string
}>()
</script>

<template>
  <!--
    行范式与 SystemShortcutSection 对齐（flex items-center gap-4 px-1.5 py-2.5 min-h-12）。
    行分隔：border-hairline（--hairline 0.05 弱分隔 token，等价原 color-mix 50% 弱化）；
    first:border-t-0 与旧 `.setting-row + .setting-row` 语义等价（消费方均为 SettingRow
    连续兄弟排列、首个 SettingRow 即容器 first child）。
  -->
  <div class="flex items-center gap-4 px-1.5 py-2.5 min-h-12 border-t border-hairline first:border-t-0">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span class="text-[length:var(--text-base)] font-medium text-neutral-fg">{{ label }}</span>
      </div>
      <p v-if="desc" class="mt-0.5 text-[length:var(--text-sm)] text-neutral-mid">{{ desc }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot />
    </div>
  </div>
</template>
