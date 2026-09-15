<script setup lang="ts">
import type { CollapsibleRootEmits, CollapsibleRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CollapsibleRoot, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * Collapsible —— 折叠/展开原语（reka-ui CollapsibleRoot 封装）。
 * 用于 PiPresetsPage 预设卡片：默认折叠显摘要，点击头部展开完整编辑区。
 * 每个卡片独立折叠（非手风琴互斥），符合"配置项对比/扫视"场景。
 * reka-ui 提供无障碍 toggle 语义（aria-expanded）、动画状态（data-state=open/closed）。
 */
const props = withDefaults(
  defineProps<CollapsibleRootProps & { class?: HTMLAttributes['class'] }>(),
  {},
)
const emits = defineEmits<CollapsibleRootEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <CollapsibleRoot v-bind="forwarded" :class="cn('', props.class)">
    <slot />
  </CollapsibleRoot>
</template>
