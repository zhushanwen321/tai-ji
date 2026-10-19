<script setup lang="ts">
import type { SelectValueProps } from 'reka-ui'
import { SelectValue } from 'reka-ui'

/**
 * SelectValue —— 展示当前选中值；placeholder 在无选中时显示。
 *
 * min-w-0 + truncate（与 SelectItem 文案区同款）：本 span 是 SelectTrigger flex 行的
 * 子项，flex 子项默认 min-width:auto 拒绝收缩，长选中值（如模型显示名）会画出触发器
 * 右边界；放开收缩许可后由 truncate 以省略号收尾，chevron（shrink-0）恒右侧占位。
 *
 * title 反射：截断收尾后触发器上已看不到全名，把展示文本同步到 title 作 hover 补偿
 * （机制做在原语层，全部使用点自动覆盖）。文本经默认 slot 接 reka 的 selectedLabel
 * slot prop 渲染（reka 自动文本的同一来源，含 placeholder fallback 语义），title 绑
 * 同一表达式——值/locale/options 异步注册变化自动跟随，无需 DOM 读回写（封装层对
 * reka 内部选中态无响应式依赖，onUpdated 反射钩子收不到子组件的文本更新）。
 * 内层 span 是 title 的 DOM 载体（组件标签上的 title 属性消费不到 slot 作用域）。
 */
const props = defineProps<SelectValueProps>()

const displayText = (selectedLabel: string[]): string =>
  selectedLabel.length ? selectedLabel.join(', ') : (props.placeholder ?? '')
</script>

<template>
  <SelectValue v-bind="props" class="min-w-0 truncate">
    <template #default="{ selectedLabel }">
      <span :title="displayText(selectedLabel) || undefined">{{ displayText(selectedLabel) }}</span>
    </template>
  </SelectValue>
</template>
