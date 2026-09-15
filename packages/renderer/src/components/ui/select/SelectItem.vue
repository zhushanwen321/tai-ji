<script setup lang="ts">
import type { SelectItemEmits, SelectItemProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SelectItem, SelectItemIndicator, SelectItemText, useForwardPropsEmits } from 'reka-ui'
import { Check } from '@lucide/vue'
import { cn } from '@/lib/utils'

/**
 * SelectItem —— 下拉项。选中态显示 check，配色与项目其他 popover 列表项一致。
 * 文字用 text-neutral-fg（非 text-neutral-mid）：下拉项需保证可读对比度，muted 在暗底偏淡。
 */
const props = defineProps<SelectItemProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<SelectItemEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SelectItem
    v-bind="forwarded"
    :class="
      cn(
        'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pl-2.5 pr-8 text-[13px] text-neutral-fg outline-none transition-colors data-[highlighted]:bg-surface-hover data-[highlighted]:text-neutral-fg data-[state=checked]:text-accent',
        props.class,
      )
    "
  >
    <span class="flex-1 truncate">
      <!-- 选项文案必须落在 SelectItemText 的默认 slot 内：
           SelectValue 靠它读 textContent 来渲染触发器已选值，
           SelectItemText 自己不带内容（reka 设计）→ 直接转发外层 slot。 -->
      <SelectItemText>
        <slot />
      </SelectItemText>
    </span>
    <!-- 可选 #action slot：选项右侧 append 区（Check 指示器左旁）。
         仅当调用方传 #action 时渲染，原有仅传文案的调用零影响。
         用法场景：SystemPage 提示音选择，每个声音项右侧带试听按钮。

         [HISTORICAL] absolute 定位 + pointerdown/up/click 三重 stop：
         原实现用 flex 内联 span + opacity 0→1 hover 显隐，有三个问题：
         1. #action span 在文档流内占据宽度，影响 flex-1 文案区宽度分配，
            不同项（传/不传 #action）宽度不一致 → 下拉宽度抖动 → popper 重定位。
         2. opacity transition 期间重排可能触发 reka popper 位置重算 → 位移。
         3. reka SelectItem 用 onPointerup 触发选中（见 reka SelectItem.js 源码），
            只 stop click/pointerdown 不够——pointerup 仍冒泡到 SelectItem →
            选中该项 + 关闭下拉。改 absolute 脱离文档流解决 1/2，
            pointerdown + pointerup + click 三重 stop 解决 3。 -->
    <span
      v-if="$slots.action"
      class="absolute right-6 flex items-center justify-center"
      @click.stop
      @pointerdown.stop
      @pointerup.stop
    >
      <slot name="action" />
    </span>
    <span class="absolute right-2 flex size-4 items-center justify-center">
      <SelectItemIndicator>
        <Check class="size-3.5 text-accent" />
      </SelectItemIndicator>
    </span>
  </SelectItem>
</template>
