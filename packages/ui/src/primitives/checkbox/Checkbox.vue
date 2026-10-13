<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { CheckboxRoot, CheckboxIndicator, useForwardPropsEmits } from 'reka-ui'
import { Check } from '@lucide/vue'
import { cn } from '../../lib/utils'

/**
 * Checkbox —— 勾选原语（reka-ui CheckboxRoot 封装）。
 * 替代各加载路径的裸 <input type=checkbox>。
 * 形态对齐 demo pages.css .chk：16×16（size-[16px] 绝对 px，html 14px 基准下 size-4
 * 只渲染 14px，免疫字号档缩放）/ 圆角 --radius-xs（4px，demo r-xs）/ 未选态
 * border-border-strong + bg-bg-input 凹陷档底 / 选中 bg-accent + border-accent +
 * Check --accent-fg（六主题跟随，白字在浅 accent 主题上勾色反转）。
 * 焦点 = 全局焦点语言 outline 2px var(--focus-ring)（焦点指示唯一令牌，= accent 别名）
 * 内缩 1px（demo workbench.css A2 通道），外扩 ring 会让 16px 微件在密集列表里碰撞邻行。
 * 热区 = ::after inset -4px 外扩点击区（demo .chk 同机制），父级 relative 承载。
 * 三层 !important 绕过宿主全局 unlayered 规则（CSS Cascade Layers：unlayered
 * 压过 Tailwind 的 @layer base/utilities）：
 *   - !border（width 1px）：否则 `*{border-width:0}` 把宽度塌成 0
 *   - !border-solid（style solid）：否则 `border-style` 默认 none——CSS 规则 none 时
 *     border-width 被强制 computed 为 0（不论设多少），这才是未选态隐形的真根因
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
  <!-- 热区类走静态 class（after:content-[''] 的引号在 :class 的 JS 表达式语境无法落字，
       Switch.vue 同款先例）；与 :class 由 Vue 标准合并 -->
  <CheckboxRoot
    v-bind="forwarded"
    class="after:absolute after:-inset-[4px] after:content-['']"
    :class="
      cn(
        'peer relative size-[16px] shrink-0 rounded-[4px] !border !border-solid border-border-strong bg-bg-input outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:-outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:border-border-strong data-[state=unchecked]:bg-bg-input',
        props.class,
      )
    "
  >
    <CheckboxIndicator class="flex items-center justify-center text-current">
      <Check class="size-3 text-accent-fg" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
