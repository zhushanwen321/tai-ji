<template>
  <!--
    侧栏-main 卡缝分隔条（demo .split-handle 同语言，与 PanelContainer drawer-resize-handle
    同形态）：本体 = 4px 卡缝（w-1，取代原 AppShell 根 gap-1——缝由本元素承载，展开/折叠态
    缝宽语义归一），缝内 1px 视觉线居中（hover/键盘焦点显 border-strong，drag 染 accent）。
    拖动/键盘微调写 sidebar store 的 widthPx（clamp [200, 480]），AsideRegion flexBasis 与
    Sidebar 内容列同源消费；localStorage 持久化时点 = 拖动结束/键盘微调（对齐 drawer handle）。
    折叠态随 AsideRegion 一起 v-if 消失（AppShell 层），main 贴左无缝。
    aside 贴窗口左缘（app-shell 无左 padding，x=0），拖动换算 = clientX 即目标宽度，无需测 rect。
  -->
  <div
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-valuemin="SIDE_WIDTH_MIN_PX"
    :aria-valuemax="SIDE_WIDTH_MAX_PX"
    :aria-valuenow="sidebar.widthPx"
    :aria-label="t('shell.resizeSidebar')"
    class="group relative w-1 shrink-0 cursor-col-resize touch-none select-none [&:focus-visible>div]:bg-border-strong"
    :data-state="isDragging ? 'drag' : undefined"
    data-testid="sidebar-resize-handle"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKeydown"
  >
    <div
      class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] group-hover:bg-border-strong hover:bg-border-strong data-[state=drag]:bg-accent"
      :data-state="isDragging ? 'drag' : undefined"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 侧栏宽度分隔条（交互壳）：pointer capture 跟手（move/up 路由到 handle，拖出元素外仍跟手；
 * jsdom 无 Pointer Capture API，可选调用兼容），键盘 ArrowLeft 变窄 / ArrowRight 变宽。
 * pointerdown 不 preventDefault：保留后续 focus 行为（键盘可达性），选中防御靠 select-none。
 * 宽度状态与 clamp/持久化的 SSOT 在 sidebar store（ AsideRegion/Sidebar 双消费方，组件间共享
 * 归 store，不用 composable 局部 ref）。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSidebarStore, SIDE_WIDTH_MIN_PX, SIDE_WIDTH_MAX_PX } from '@/stores/sidebar'

/** 键盘微调步长（px，对齐 drawer handle 的键盘交互粒度百分比 × 侧栏窄幅换算） */
const KEYBOARD_STEP_PX = 16

const { t } = useI18n()
const sidebar = useSidebarStore()
const isDragging = ref(false)

function onPointerDown(e: PointerEvent): void {
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture?.(e.pointerId)
  isDragging.value = true
}

function onPointerMove(e: PointerEvent): void {
  if (!isDragging.value) return
  sidebar.setWidth(e.clientX)
}

function onPointerUp(e: PointerEvent): void {
  const target = e.currentTarget as HTMLElement
  if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId)
  if (!isDragging.value) return
  isDragging.value = false
  sidebar.persistWidth()
}

function onKeydown(e: KeyboardEvent): void {
  let delta = 0
  if (e.key === 'ArrowLeft') delta = -KEYBOARD_STEP_PX
  else if (e.key === 'ArrowRight') delta = KEYBOARD_STEP_PX
  else return
  e.preventDefault()
  sidebar.setWidth(sidebar.widthPx + delta)
  sidebar.persistWidth()
}
</script>
