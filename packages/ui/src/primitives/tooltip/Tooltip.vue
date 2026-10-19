<script setup lang="ts">
import type { TooltipRootEmits, TooltipRootProps } from 'reka-ui'
import { TooltipProvider, TooltipRoot, useForwardPropsEmits } from 'reka-ui'

/**
 * Tooltip —— 悬停文本提示原语（Provider + Root 组合，对齐 hover-card 族封装形态）。
 *
 * 消费定位：替换 composer 左簇等入口按钮的**原生 title 提示**——原生 title 由系统绘制
 * （白底黑字、系统字体节奏），与太极纯灰主题脱节且纯文本不可控；本原语浮层走主题 token
 * （TooltipContent）。Provider 内联在组合里（reka Provider 是纯 context 无 DOM），
 * skipDelayDuration 取 reka 默认（连续扫过多个入口时后续免延迟）。
 *
 * delayDuration 缺省 300ms：比托盘/scheduler 快捷面板的 hover 开启延迟（160ms）长——
 * 有内容面板的入口面板先开，tooltip 不与之双显。
 */
const props = withDefaults(defineProps<TooltipRootProps>(), { delayDuration: 300 })
const emits = defineEmits<TooltipRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <TooltipRoot v-bind="forwarded">
      <slot />
    </TooltipRoot>
  </TooltipProvider>
</template>
