<script setup lang="ts">
/**
 * L2TabBar（W4 · T2）——plugin view 二级 tab 栏（v6 l2-tabbar 视觉）。
 *
 * 与 rendering-protocol/primitives/TabBar.vue 非双轨：概念域不同（本组件 = 宿主交互
 * 组件，消费本地 L2TabItem + v-model，close/pin 事件上抛；TabBar = rendering-protocol
 * 协议推送原语，渲染 extension 推送的 GuiComponent），勿合并。
 *
 * 视觉权威：v6-spec-plugin-rendering.html .l2-tabbar CSS——
 * 容器 bg-bg-input + rounded-sm(6px) + p-[3px] + gap 2px（flex-wrap）；
 * tab 项 padding 3px 4px 3px 8px、font-size var(--text-xs)、neutral-dim →
 * hover neutral-fg + surface-hover、active bg-bg-elevated + neutral-fg；
 * l2-ico 11px 常显 neutral-ico / active accent；close/pin 14px 命中区
 * radius 3px、opacity 0 → hover 1（transition）、pinned 态 accent + opacity 1。
 *
 * 纯展示 + 事件上抛：activeViewId 经 v-model 双向绑定（update:modelValue），
 * close/pin 只 emit viewId——移除/置顶决策由父层 PluginViewContainer 本地维护
 * （不持久化，design T2 约束）。
 *
 * badge 小圆点（background-task-sidebar-view D4④）已随「后台命令」native 视图退役
 * （composer-task-tray D10：后台命令观察面归 Composer 托盘）——本组件不再有 badge 渲染面。
 */
import { Pin, X } from '@lucide/vue'
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
  pin: [viewId: string]
}>()
</script>

<template>
  <div
    data-testid="l2-tabbar"
    class="flex flex-wrap gap-[2px] rounded-[6px] bg-bg-input p-[3px]"
  >
    <Button
      v-for="tab in tabs"
      :key="tab.viewId"
      variant="ghost"
      :data-testid="`l2-tab-${tab.viewId}`"
      :data-active="tab.viewId === modelValue ? 'true' : 'false'"
      class="group h-auto gap-[5px] rounded-[6px] px-1 py-[3px] pl-2 text-[var(--text-xs)] font-normal text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[11px]"
      :class="tab.viewId === modelValue ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated' : ''"
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
      <!-- close（builtin 不渲染）；pin（pinned 态 accent + 常显）。spec：hover 显现 opacity 0→1 -->
      <span
        v-if="!tab.builtin"
        role="button"
        :data-testid="`l2-tab-close-${tab.viewId}`"
        class="flex size-3.5 items-center justify-center rounded-[3px] text-neutral-faint opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100 hover:bg-surface-2 hover:text-neutral-fg [&_svg]:size-[11px]"
        :class="tab.pinned ? 'text-accent opacity-100' : ''"
        @click.stop="emit('close', tab.viewId)"
      >
        <X />
      </span>
      <span
        role="button"
        :data-testid="`l2-tab-pin-${tab.viewId}`"
        :data-pinned="tab.pinned ? 'true' : 'false'"
        class="flex size-3.5 items-center justify-center rounded-[3px] text-neutral-faint opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100 hover:bg-surface-2 hover:text-neutral-fg [&_svg]:size-[11px]"
        :class="tab.pinned ? 'text-accent opacity-100' : ''"
        @click.stop="emit('pin', tab.viewId)"
      >
        <Pin />
      </span>
    </Button>
  </div>
</template>
