<script setup lang="ts">
import type { CollapsibleTriggerProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CollapsibleTrigger as RekaCollapsibleTrigger, useForwardProps } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * CollapsibleTrigger —— 折叠触发器（reka-ui CollapsibleTrigger 封装）。
 * 默认 as-child 透传（配合 Button 等组件使用，不额外渲染 button 元素）。
 *
 * testId 透传到根元素 data-testid（同款测试锚点模式见 packages/ui/src/primitives/popover/PopoverListItem.vue）。
 */
const props = withDefaults(
  defineProps<
    CollapsibleTriggerProps & {
      class?: HTMLAttributes['class']
      /** 测试锚点（data-testid） */
      testId?: string
    }
  >(),
  {},
)
const delegatedProps = reactiveOmit(props, 'class', 'testId')
const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <RekaCollapsibleTrigger
    v-bind="forwarded"
    :data-testid="props.testId"
    as-child
    :class="cn('', props.class)"
  >
    <slot />
  </RekaCollapsibleTrigger>
</template>
