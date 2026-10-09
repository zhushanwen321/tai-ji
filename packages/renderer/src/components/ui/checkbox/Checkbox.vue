<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CheckboxRoot, CheckboxIndicator, useForwardPropsEmits } from 'reka-ui'
import { Check } from '@lucide/vue'
import { cn } from '@/lib/utils'

/**
 * Checkbox —— 勾选原语（reka-ui CheckboxRoot 封装）。
 * 替代 SkillPage/AgentPage 加载路径的裸 <input type=checkbox>。
 * 形态对齐 demo pages.css .pg-set .chk：16×16（绝对 px，免疫字号档缩放）/ 圆角
 * --radius-xs(4px) / 未选态边框 --border-strong + 底 --bg-input / 选中 bg-accent +
 * border-accent + Check --accent-fg（六主题跟随，白字退役）。
 * 三层 !important 绕过 unlayered `button { border:none }`（style.css:339，CSS Cascade
 * Layers：unlayered 压过 Tailwind 的 @layer utilities）——与 ui primitives Checkbox 的
 * 4a053601d/49e4d9518 修复同源（迁移分叉时只修了 ui 副本，此副本漏改）：
 *   - !border（width 1px）：否则 border-width 被压成 0
 *   - !border-solid（style solid）：border-style 为 none 时 border-width computed 恒 0，
 *     这才是未选态隐形的真根因
 * 焦点 = 全局焦点语言 outline 2px --accent 内缩 1px（demo workbench.css A2 通道）。
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
        'peer size-[16px] shrink-0 rounded-[4px] !border !border-solid border-border-strong bg-bg-input outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:border-border-strong data-[state=unchecked]:bg-bg-input',
        props.class,
      )
    "
  >
    <CheckboxIndicator class="flex items-center justify-center text-current">
      <Check class="size-3 text-accent-fg" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
