<script setup lang="ts">
import { TooltipTrigger } from 'reka-ui'

/**
 * TooltipTrigger —— 提示触发器（as-child 转发给调用方元素）。
 * 无样式注入：触发元素保留调用方全部类与事件。
 */
</script>

<template>
  <TooltipTrigger as-child>
    <slot />
  </TooltipTrigger>
</template>
