<template>
  <!--
    展示组件 · 透明布局槽。
    无 background，继承 app-shell 的 bg-bg，视觉上与窗口底色融合（spec §一）。
    traffic light 绝对定位在此组件顶部安全区（spec §六 z-index:10）；
    app-nav-controls 已提升至 AppShell 层避免折叠态 overflow:hidden 裁剪。
    Wave 3：在此挂载 Sidebar 容器（FG3），padding-top:44px(pt-11) 安全区让出 traffic light（红黄绿原生 y=8~20），并拉开 trafficlight 行（nav 按钮 bottom y27）与 LOGO 行视觉间距（约 12px）。
  -->
  <aside
    class="relative flex flex-col overflow-hidden pt-11"
    :style="{
      flexBasis: sidebar.collapsed ? '0px' : '300px',
      flexGrow: '0',
      flexShrink: '0',
      minWidth: '0px',
    }"
    data-testid="app-shell-aside"
  >
    <!-- 非 mac 顶部拖拽条带（跨平台窗口外壳设计 §6.3）：44px 高条带承载 win/linux 按住拖动窗口；
         mac 系统自带顶部拖拽，加 app-region 会重定义系统拖拽区，故 v-if 不渲染（A6 mac 回归按
         data-testid 断言不渲染）。双击条带 = 最大化/还原，是 -webkit-app-region:drag 的平台原生
         行为，无需代码（真机验收 S2 双击腿覆盖）。命中面：圆点组（TrafficLight z-10）与导航按钮
         （AppNavControls z-10，AppShell 层）均在本条带之上，且父链无 drag 声明，点击不受影响。
         折叠态分叉（已接受）：aside 折叠 = flexBasis:0 + overflow-hidden（本组件现状），条带随
         折叠被裁剪、win/linux 拖拽面缩回主面板 PanelHeader 的 22px 标题栏（不随折叠消失），与
         圆点组折叠态隐藏的既有行为一致；备选「条带提升 AppShell 层」（AppNavControls 先例）留档，
         S2 真机验收判定折叠态拖拽面不足用时随该项重开。 -->
    <div
      v-if="!isMac"
      data-testid="aside-drag-strip"
      class="absolute inset-x-0 top-0 h-11 [-webkit-app-region:drag]"
    />
    <TrafficLight />
    <Sidebar />
  </aside>
</template>

<script setup lang="ts">
// aside flex-basis 联动 sidebar.collapsed（spec §收起态：折叠 width→0，main 占满全宽；
// pt-11(44px) traffic light 安全区：AppShell py-1 使 aside 顶在窗口 y=4，红黄绿原生 y=8~20，安全区让出；
// position:relative 为 traffic-light 的 offset parent；
// app-nav-controls 已提升至 AppShell 层（避免折叠态 overflow:hidden 裁剪）。
// isMac：与 TrafficLight 同源（usePlatformChrome 的 detectPlatform），驱动非 mac 拖拽条带 v-if。
// flex-basis（非 width）：flex 子 width:0 被 min-content 撑开，必须显式 flex-basis:0 才能真正归零。
// 不挂 transition：CDP 测试环境（Electron 42/Chrome 148）下 flex 子的 flex-basis/max-width transition
// 锁死 declared value（动画不触发且阻止最终值生效），opacity transition 亦不触发——环境性问题，非代码缺陷。
// 320ms 时长配置已在 .sidebar scoped + app-nav-controls 中保留（未改），spec 时长约束未破；
// 真实环境若 transition 可用，可在此 class 补 transition-[flex-basis] duration-[var(--duration-slow)] ease-[var(--ease)]。
import Sidebar from '@/components/sidebar/Sidebar.vue'
import { useSidebarStore } from '@/stores/sidebar'
import { detectPlatform } from '@/composables/effects/usePlatformChrome'
import TrafficLight from './TrafficLight.vue'

const sidebar = useSidebarStore()
const isMac = detectPlatform() === 'mac'
</script>
