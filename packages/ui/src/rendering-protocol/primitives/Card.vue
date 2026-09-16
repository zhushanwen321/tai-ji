<script setup lang="ts">
/**
 * 卡片容器组件（v6）——去 border，靠 bg 层级表达分组。
 * 圆角 8px（spec .gcard border-radius: 8px，rounded-md 标准 scale）；
 * variant 映射 bg 层级（default/danger/success→bg-surface，elevated→bg-surface-2）；
 * header 去 border-b 改 bg 浮起（default→bg-surface-2，elevated→bg-elevated）；
 * header dot 全 variant 显示（default/elevated=neutral-ico，danger/success=对应色），
 * badge 仅 danger/success 显示（失败/完成，靠 bg-soft+text 语义色表达，非 border）。
 * header 可以是 string 或 GuiComponent（后者递归调渲染器）；
 * body 通过 v-for + 渲染器递归渲染子组件。
 * 渲染器经 PRIMITIVE_RENDER_KEY 注入（renderer 的 GuiComponentRenderer provide 自身），
 * 未注入时回退内置 PrimitiveRouter。
 */
import { computed, inject } from 'vue'
import type { Component } from 'vue'
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import { PRIMITIVE_RENDER_KEY } from '../primitive-render-key'
import PrimitiveRouter from './PrimitiveRouter.vue'

/** 递归渲染器：注入优先（renderer 场景），独立使用回退内置路由 */
const renderer = inject<Component>(PRIMITIVE_RENDER_KEY, PrimitiveRouter)

const props = defineProps<{
  variant?: 'default' | 'elevated' | 'danger' | 'success'
  header?: GuiComponent | string
  body: GuiComponent[]
}>()

const isStringHeader = computed(() => typeof props.header === 'string')

/** header 为 GuiComponent 时收窄类型，避免模板内 as 断言 */
const headerComponent = computed<GuiComponent | null>(() =>
  isStringHeader.value || !props.header ? null : props.header as GuiComponent,
)

/** v6：variant → 根容器 bg 层级（default/danger/success→bg-surface，elevated→bg-surface-2） */
const cardBgClass = computed(() =>
  props.variant === 'elevated' ? 'bg-surface-2' : 'bg-surface',
)

/** v6：header bg 浮起（default/danger/success→bg-surface-2，elevated→bg-elevated） */
const headerBgClass = computed(() =>
  props.variant === 'elevated' ? 'bg-elevated' : 'bg-surface-2',
)

/** v6：header dot 色（default/elevated=neutral-ico，danger/success=对应色） */
const dotClass = computed(() => {
  if (props.variant === 'danger') return 'bg-danger'
  if (props.variant === 'success') return 'bg-success'
  return 'bg-neutral-ico'
})

/** v6：badge 仅 danger/success 显示（语义文案 + bg-soft/text 语义色） */
const badge = computed<{ text: string; cls: string } | null>(() => {
  if (props.variant === 'danger') return { text: '失败', cls: 'bg-danger-soft text-danger' }
  if (props.variant === 'success') return { text: '完成', cls: 'bg-success-soft text-success' }
  return null
})
</script>

<template>
  <div
    class="overflow-hidden rounded-md"
    :class="cardBgClass"
    data-testid="gui-card"
  >
    <div
      v-if="header"
      class="flex items-center gap-1.5 px-3 py-2 font-mono text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.04em] text-neutral-mid"
      :class="headerBgClass"
    >
      <span
        data-testid="gui-card-dot"
        class="size-[7px] shrink-0 rounded-full"
        :class="dotClass"
      />
      <span v-if="isStringHeader" class="flex-1">{{ header }}</span>
      <component
        :is="renderer"
        v-else-if="headerComponent"
        :component="headerComponent"
        class="flex-1"
      />
      <span
        v-if="badge"
        data-testid="gui-card-badge"
        class="rounded-full px-[7px] py-0.5 text-[length:var(--text-2xs)] font-semibold"
        :class="badge.cls"
      >{{ badge.text }}</span>
    </div>
    <div class="p-3">
      <component
        :is="renderer"
        v-for="(child, i) in body"
        :key="i"
        :component="child"
      />
    </div>
  </div>
</template>
