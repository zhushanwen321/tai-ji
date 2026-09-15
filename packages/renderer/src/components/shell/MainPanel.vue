<template>
  <!--
    容器组件 · float-panel（spec §一：唯一带 bg/border/radius 的面板）。
    靠 background+border 视觉分区，不靠 z-index。2026-09-09 去投影：浮层投影
    （旧 --shadow-2，24px 渐变光晕）在侧边贴合场景产生明显渐变阴影（截图干扰），移除后
    分隔完全由 border + 色差 + 圆角承载。
    圆角 rounded-[10px] 与 AppShell 窗口圆角一致：收起侧边栏时 main-panel 占满，四角与窗口圆角共线对齐（展开态 main 浮起卡片，10px 圆角同样协调）。
    view 路由：chat → Workspace（FG4），overview → Overview（FG6 ADR-0023 覆盖 main 区）。
    settings/search 浮层为全局 Dialog（FG6 骨架），不走 view 路由（hide 入口，spec §9）。
  -->
  <main class="main-panel relative flex flex-1 min-w-0 flex-col overflow-hidden rounded-[10px] border border-border bg-surface" data-testid="app-shell-main">
    <Workspace v-if="navigation.current.view === 'chat'" />
    <Overview v-else-if="navigation.current.view === 'overview'" />
    <!-- Toast 兜底挂载（overview/settings view）：chat view 的锚点在 PanelContainer
         main-area，不在此重复挂载（双实例双渲染）。relative 供 absolute toast 锚定
         （chat 态 toast 的 nearest positioned ancestor 也是本 main）。 -->
    <ToastContainer v-if="navigation.current.view !== 'chat'" />
  </main>
</template>

<script setup lang="ts">
import { useNavigationStore } from '@/stores/navigation'
import Workspace from '@/components/workspace/Workspace.vue'
import Overview from '@/components/overview/Overview.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'

const navigation = useNavigationStore()
</script>

<style scoped>
/* float-panel 边缘压深：--shadow-1 是 1px 无模糊 spread 环（锐利线条，非渐变晕），
 * 叠在 border 外侧加深边缘轮廓。Tailwind 单 box-shadow 属性无法直接引用变量，走 escape hatch。 */
.main-panel {
  box-shadow: var(--shadow-1);
}
</style>
