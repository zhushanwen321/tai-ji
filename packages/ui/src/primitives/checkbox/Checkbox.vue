<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CheckboxRoot, CheckboxIndicator, useForwardPropsEmits } from 'reka-ui'
import { Check } from '@lucide/vue'
import { cn } from '../../lib/utils'

/**
 * Checkbox —— 勾选原语（reka-ui CheckboxRoot 封装）。
 * 替代 SkillPage/AgentPage 加载路径的裸 <input type=checkbox>。
 * 样式：size-4 / 未选态 border neutral-mid。
 * 三层 !important 绕过 renderer 全局 unlayered `*` 规则（CSS Cascade Layers：unlayered
 * 压过 Tailwind 的 @layer base/utilities）：
 *   - !border（width 1px）：否则 `*{border-width:0}` 把宽度塌成 0
 *   - !border-solid（style solid）：否则 `border-style` 默认 none——CSS 规则 none 时
 *     border-width 被强制 computed 为 0（不论设多少），这才是未选态隐形的真根因
 *   - border-neutral-mid：未选态亮色（border-strong 太弱）
 * 选中 bg-accent + border-accent。Check icon 白色。
 */
const props = withDefaults(
  defineProps<CheckboxRootProps & { class?: HTMLAttributes['class'] }>(),
  {},
)
const emits = defineEmits<CheckboxRootEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <CheckboxRoot
    v-bind="forwarded"
    :class="
      cn(
        'peer size-4 shrink-0 rounded-sm !border !border-solid border-neutral-mid bg-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:border-neutral-mid data-[state=unchecked]:bg-transparent',
        props.class,
      )
    "
  >
    <CheckboxIndicator class="flex items-center justify-center text-current">
      <Check class="size-3 text-white" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
