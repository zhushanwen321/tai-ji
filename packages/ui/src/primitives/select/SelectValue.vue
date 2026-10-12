<script setup lang="ts">
import type { SelectValueProps } from 'reka-ui'
import { SelectValue } from 'reka-ui'

/**
 * SelectValue —— 展示当前选中值；placeholder 在无选中时显示。
 *
 * min-w-0 + truncate（与 SelectItem 文案区同款）：本 span 是 SelectTrigger flex 行的
 * 子项，flex 子项默认 min-width:auto 拒绝收缩，长选中值（如模型显示名）会画出触发器
 * 右边界；放开收缩许可后由 truncate 以省略号收口，chevron（shrink-0）恒右侧占位。
 */
const props = defineProps<SelectValueProps>()
</script>

<template>
  <SelectValue v-bind="props" class="min-w-0 truncate">
    <slot />
  </SelectValue>
</template>
