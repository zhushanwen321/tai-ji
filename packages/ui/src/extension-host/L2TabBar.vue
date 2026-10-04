<script setup lang="ts">
/**
 * L2TabBar（W4 · T2）——plugin view 二级 tab 栏（v6 l2-tabbar 视觉）。
 *
 * 与 rendering-protocol/primitives/TabBar.vue 非双轨：概念域不同（本组件 = 宿主交互
 * 组件，消费本地 L2TabItem + v-model，close 事件上抛；TabBar = rendering-protocol
 * 协议推送原语，渲染 extension 推送的 GuiComponent），勿合并。
 *
 * 视觉范式：实例 tab 条统一范式（三卡化 2026-10-04，DESIGN §3.4 tab 型）——
 * 容器无底（tab 自持底色，原 bg-input 容器条随双层底冗余移除）；
 * tab 非激活 border-border + bg-input + neutral-dim → hover surface-2 + neutral-fg，
 * active border-strong + bg-elevated + neutral-fg；
 * l2-ico 11px 常显 neutral-ico / active accent；close 常驻 14px 命中区（hover 染 danger）。
 *
 * 纯展示 + 事件上抛：activeViewId 经 v-model 双向绑定（update:modelValue），
 * close 只 emit viewId——移除决策由父层 PluginViewContainer 本地维护
 * （不持久化，design T2 约束）。
 *
 * badge 小圆点（background-task-sidebar-view D4④）已随「后台命令」native 视图退役
 * （composer-task-tray D10：后台命令观察面归 Composer 托盘）——本组件不再有 badge 渲染面。
 */
import { X } from '@lucide/vue'
import { Button } from '../primitives/button'
import type { L2TabItem } from './l2-tab-item'

defineProps<{
  tabs: L2TabItem[]
  /** active viewId（v-model） */
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [viewId: string]
  close: [viewId: string]
}>()
</script>

<template>
  <div data-testid="l2-tabbar" class="flex flex-wrap items-center gap-1">
    <Button
      v-for="tab in tabs"
      :key="tab.viewId"
      variant="ghost"
      :data-testid="`l2-tab-${tab.viewId}`"
      :data-active="tab.viewId === modelValue ? 'true' : 'false'"
      class="group h-auto gap-[5px] rounded-sm border px-1 py-[3px] pl-2 text-[var(--text-xs)] font-normal transition-colors [&_svg]:size-[11px]"
      :class="
        tab.viewId === modelValue
          ? 'border-border-strong bg-bg-elevated text-neutral-fg hover:bg-bg-elevated'
          : 'border-border bg-bg-input text-neutral-dim hover:bg-surface-2 hover:text-neutral-fg'
      "
      @click="emit('update:modelValue', tab.viewId)"
    >
      <span
        v-if="tab.icon"
        class="flex size-[11px] shrink-0 items-center justify-center text-neutral-ico"
        :class="tab.viewId === modelValue ? 'text-accent' : ''"
      >
        <component :is="tab.icon" />
      </span>
      <span class="leading-none">{{ tab.title }}</span>
      <!-- close（builtin 不渲染）。常驻（三卡化 2026-10-04 实例 tab 条范式：关闭叉不隐藏） -->
      <span
        v-if="!tab.builtin"
        role="button"
        :data-testid="`l2-tab-close-${tab.viewId}`"
        class="flex size-3.5 items-center justify-center rounded-[3px] text-neutral-faint transition-colors duration-[var(--duration-fast)] hover:bg-danger-soft hover:text-danger [&_svg]:size-[11px]"
        @click.stop="emit('close', tab.viewId)"
      >
        <X />
      </span>
    </Button>
  </div>
</template>
