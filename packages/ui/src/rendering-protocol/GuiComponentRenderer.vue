<script setup lang="ts">
/**
 * GUI 组件路由器——按 GuiComponent.type 路由到对应 Vue 组件（spec §9.1）。
 *
 * 职责边界（§7.2）：type 路由 + AnsiText 降级 + props 适配全部下沉到 core 的
 * resolveComponent 纯函数（@taiji/core/rendering-protocol）。本组件只做最后一步——
 * 把 core 解析出的 type 字符串映射到 Vue Component（core headless，不持有 .vue）。
 *
 * core resolveComponent 的输出契约（ResolvedRender { type, props }）：
 *   - type：最终渲染键（未注册 custom / 未知 type / 脏数据均降级为 'ansi-text'）
 *   - props：已适配（ansi-text 已 join 成 content；降级时已 JSON 序列化）
 * 因此本组件的 BUILTIN_MAP 是纯查表，不含 `?? AnsiText` 降级决策——降级 SSOT 在 core。
 *
 * custom 组件注册表经 provide/inject（key 权威在 core）注入：core resolveComponent
 * 用它判注册态，本组件用它做 Component 映射（core 已保证命中）。
 *
 * 递归：Card/Columns 等容器原语渲染子组件时 inject PRIMITIVE_RENDER_KEY 取渲染器；
 * 本组件 provide 自身（markRaw 防响应式代理），保证递归行为与 re-home 前一致。
 */
import { computed, getCurrentInstance, inject, markRaw, provide } from 'vue'
import type { Component } from 'vue'
import type { GuiComponent, GuiComponentType } from '@taiji/extension-protocol'
import {
  AnsiText,
  ProgressBar,
  StatsLine,
  TabBar,
  Card,
  Columns,
  Group,
  ListTree,
} from './primitives'
import { PRIMITIVE_RENDER_KEY } from './primitive-render-key'
import { GUI_CUSTOM_REGISTRY_KEY } from '@taiji/core/rendering-protocol/custom-registry'
import { resolveComponent } from '@taiji/core/rendering-protocol'

/** 递归渲染注入：渲染 Card/Columns 等容器原语时，其内部子组件递归仍走本组件
 *（保留 custom 注册表 + ansi-text 降级逻辑，与 re-home 前行为一致）。
 * getCurrentInstance().type 即本组件定义（SFC 编译产物），markRaw 防响应式代理。 */
const self = getCurrentInstance()
if (self?.type) {
  provide(PRIMITIVE_RENDER_KEY, markRaw(self.type))
}

const props = defineProps<{ component: GuiComponent }>()

/** core resolveComponent 保证可渲染的 builtin type（ansi-text + 6 布局原语）。 */
type RenderableBuiltinType = Exclude<GuiComponentType, 'custom'>

/** builtin type → Vue 组件纯映射表（无降级分支，降级 SSOT 在 core resolveComponent）。
 * 键钉到 RenderableBuiltinType，新增 type 时编译期可见。 */
const BUILTIN_MAP: Record<RenderableBuiltinType, Component> = {
  'ansi-text': AnsiText,
  'progress-bar': ProgressBar,
  'stats-line': StatsLine,
  'tab-bar': TabBar,
  'card': Card,
  'columns': Columns,
  'group': Group,
  'list-tree': ListTree,
}

/** custom 组件注册表（内置 extension 编译期注册）。core resolveComponent 用它判注册态，
 * 本组件用它做最终 Component 映射。默认空表。 */
const CUSTOM_MAP = inject(GUI_CUSTOM_REGISTRY_KEY, {})

/** core 解析结果：{ type, props }。type 为最终渲染键，props 已适配
 * （降级已 JSON 序列化、ansi-text 已 join 成 content）。 */
const resolved = computed(() => resolveComponent(props.component, CUSTOM_MAP))

/** resolved.type → Vue Component 纯查表（降级决策在 core，此处不含 `?? AnsiText`）：
 * custom → CUSTOM_MAP 按 props.component 查（core 已保证已注册）；其余 → BUILTIN_MAP。 */
const renderComponent = computed<Component>(() => {
  const { type, props: resolvedProps } = resolved.value
  if (type === 'custom') {
    return CUSTOM_MAP[(resolvedProps as { component: string }).component]
  }
  return BUILTIN_MAP[type]
})
</script>

<template>
  <!-- 包一层 span 容器承担 data-testid。若直接放在 <component> 上，属性继承会把子组件
       根元素的同名 attr（如 AnsiText 的 data-testid="ansi-text"）覆盖掉，导致无法区分。
       容器隔离继承作用域，子组件保留自身 testid，本组件也有 testid 供上层断言。 -->
  <span data-testid="gui-component-renderer">
    <component :is="renderComponent" v-bind="resolved.props" />
  </span>
</template>
