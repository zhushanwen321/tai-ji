<script setup lang="ts">
/**
 * 垂直组合容器——无视觉样式的透明分组（v6）。
 *
 * 定位：widget 宿主壳层（托盘 widget 面板等）承担卡壳/head/折叠后，widget 内容需要多组件
 * 组合时的组合根（如 goal = stats-line + list-tree）。此前唯一选择是「无头 card」，但
 * card 自带 bg/padding/圆角，套在宿主卡壳内形成双层卡——group 显式表达
 * 「只组合、不加视觉」，与 card（自带卡片视觉）语义分离。
 *
 * 渲染器经 PRIMITIVE_RENDER_KEY 注入（与 Card 同款递归模式）。
 */
import { inject } from 'vue'
import type { Component } from 'vue'
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import { PRIMITIVE_RENDER_KEY } from '../primitive-render-key'
import PrimitiveRouter from './PrimitiveRouter.vue'

/** 递归渲染器：注入优先（renderer 场景），独立使用回退内置路由 */
const renderer = inject<Component>(PRIMITIVE_RENDER_KEY, PrimitiveRouter)

defineProps<{
  children: GuiComponent[]
}>()
</script>

<template>
  <div class="group flex flex-col gap-2" data-testid="gui-group">
    <component
      :is="renderer"
      v-for="(child, i) in children"
      :key="i"
      :component="child"
    />
  </div>
</template>
