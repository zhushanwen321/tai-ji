<script setup lang="ts">
/**
 * 双列网格组件——替代 TUI 的 │ 列分隔。
 * flex 布局，ratios 默认等分，通过 style flex-grow 指定比例。
 * children 通过渲染器递归渲染（PRIMITIVE_RENDER_KEY 注入，未注入回退 PrimitiveRouter）。
 */
import { inject } from 'vue'
import type { Component } from 'vue'
import type { GuiComponent } from '@taiji/extension-protocol'
import { PRIMITIVE_RENDER_KEY } from '../primitive-render-key'
import PrimitiveRouter from './PrimitiveRouter.vue'

/** 递归渲染器：注入优先（renderer 场景），独立使用回退内置路由 */
const renderer = inject<Component>(PRIMITIVE_RENDER_KEY, PrimitiveRouter)

const props = defineProps<{
  children: GuiComponent[]
  ratios?: number[]
}>()

const flexGrow = (index: number): number => {
  if (!props.ratios || props.ratios.length === 0) return 1
  return props.ratios[index] ?? 1
}
</script>

<template>
  <div class="flex gap-3" data-testid="gui-columns">
    <div
      v-for="(child, i) in children"
      :key="i"
      class="columns__child min-w-0 flex-1"
      :style="{ flexGrow: flexGrow(i) }"
    >
      <component :is="renderer" :component="child" />
    </div>
  </div>
</template>
