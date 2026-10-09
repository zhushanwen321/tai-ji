<script setup lang="ts">
/**
 * SettingRow —— v6 设置行原语（label + 12px neutral-mid desc + 右侧 control slot）。
 * 用于 SystemPage 等设置页内的「左标签 + 右控件」行范式。
 */
defineProps<{
  label: string
  desc?: string
}>()
</script>

<template>
  <!--
    行范式 = demo .srow（pages.css）：flex center / gap-4(16px) / px-1.5(6px) / py-2.5(10px) /
    min-h-[44px]；行分隔 border-hairline（--hairline 0.05 弱分隔 token）。
    first:border-t-0 与 demo `.tight .srow:first-child` 语义等价（消费方均为 SettingRow
    连续兄弟排列、首个 SettingRow 即容器 first child）。
    label 字重 600（demo --fw-mid）；desc 默认 neutral-mid，进 GroupCard 后由 SettingsModal
    共享样式块（.group-card .setting-row-desc）切 neutral-fg-2（demo .gcard .srow-desc 档）。
  -->
  <div class="flex min-h-[44px] items-center gap-4 px-1.5 py-2.5 border-t border-hairline first:border-t-0">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span class="text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ label }}</span>
      </div>
      <p v-if="desc" class="setting-row-desc mt-0.5 text-[length:var(--text-sm)] text-neutral-mid">{{ desc }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot />
    </div>
  </div>
</template>
