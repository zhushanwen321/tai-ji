<template>
  <!--
    容器组件 · 右列布局容器（2026-10-04 三卡化裁决）。
    原「唯一 float-panel 壳」样式（border/radius/bg/shadow）已下沉到三块内容区
    （对话流 / 右抽屉 / 底抽屉，见 PanelContainer），本组件只做 flex 布局容器——
    分区视觉由各卡片自持，卡间 8px 缝由 PanelContainer 根 gap 承载。
    aside（AppNavControls 侧）仍是透明融合画布，不卡片化。
    view 路由：chat → Workspace（FG4）。
    settings/search 浮层为全局 Dialog（FG6 骨架），不走 view 路由（hide 入口，spec §9）。
  -->
  <main class="relative flex min-w-0 flex-1 flex-col overflow-hidden" data-testid="app-shell-main">
    <Workspace v-if="navigation.current.view === 'chat'" />
    <!-- Toast 兜底挂载（settings view）：chat view 的锚点在 PanelContainer
         main-area，不在此重复挂载（双实例双渲染）。relative 供 absolute toast 锚定
         （chat 态 toast 的 nearest positioned ancestor 也是本 main）。 -->
    <ToastContainer v-if="navigation.current.view !== 'chat'" />
  </main>
</template>

<script setup lang="ts">
import { useNavigationStore } from '@/stores/navigation'
import Workspace from '@/components/workspace/Workspace.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'

const navigation = useNavigationStore()
</script>
