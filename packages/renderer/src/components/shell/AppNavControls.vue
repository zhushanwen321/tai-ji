<template>
  <!--
    AppNavControls · demo Workbench.vue .win-chrome 形态（ui-replica M2）。
    收起侧栏 / ← 后退 / → 前进，浮在 traffic-light 右侧同一行。
    top-[9px]：按钮高 32，中线 y = 9 + 16 = 25，与 40px 卡头几何中心共线
    （main-panel 顶 y4 + chat 卡 1px 上边框 = 卡头顶 y5，40/2 → 中线 y25；demo --hb-chrome-top:9px 同源推导）。
    left-[8px]：基准定位固定在全屏位（红黄绿 OS 隐藏时的位置 x=8），常态/全屏态都不动 left，避免 layout 重排。
    transform 方案：常态叠 translate-x-[58px]（红黄绿右缘 x=60 + demo .lights margin-right 4 + 行 gap 2 =
    折叠钮左缘 x66，减基准 8 = 平移 58），全屏态无 translate 类即归零（按钮占红黄绿位 x=8）。
    用 transform 替代 left 动画：left 是 layout 属性，动画时触发整个窗口重排；transform 走 GPU 合成，零重排。
    条件类单向覆盖（常态显式平移 / 全屏态无类归零），无特异性冲突，不需 !important。
    320ms 平移与 traffic-light opacity 同步。
    折叠态 header pl-[88px] 让位红黄绿（右缘 60），chrome 按钮起 x≈88。

    渲染条件（demo .app.folded .win-chrome .tbtn { display:none } 同语义——折叠态导航能力迁入卡头 chrome 槽位）：
    - 非折叠态：浮此浮层，全屏态占红黄绿位 x=8。
    - 折叠态：隐藏此浮层 → chrome 已迁入 PanelHeader（卡头槽位），避免重复渲染两套 chrome。
    钮尺寸 32×32 = demo --hb-chrome-btn（行定高：折叠/settings 态钮隐藏后灯中线恒 y25 不塌缩）；
    图标 15px + stroke 折叠 1.6 / 导航 1.8 = demo .sicon 与 .tbtn 路径字重。
  -->
  <div
    v-if="!sidebar.collapsed"
    class="app-nav-controls absolute top-[9px] left-[8px] z-10 flex gap-0.5 transition-transform duration-[var(--duration-slow)] ease-[var(--ease)]"
    :class="{ 'translate-x-[58px]': !isFullscreen }"
  >
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-8 w-8 rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
      :title="sidebar.collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')"
      :aria-label="t('shell.toggleSidebar')"
      data-testid="sidebar-collapse-toggle"
      @click="sidebar.toggleCollapsed()"
    >
      <PanelLeftOpen v-if="sidebar.collapsed" class="!size-[15px]" stroke-width="1.6" />
      <PanelLeftClose v-else class="!size-[15px]" stroke-width="1.6" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-8 w-8 rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-dim [-webkit-app-region:no-drag]"
      :disabled="!navigation.canBack"
      :title="t('shell.goBack')"
      :aria-label="t('shell.goBack')"
      @click="navigation.back()"
    >
      <ArrowLeft class="!size-[15px]" stroke-width="1.8" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-8 w-8 rounded-sm text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-dim [-webkit-app-region:no-drag]"
      :disabled="!navigation.canForward"
      :title="t('shell.goForward')"
      :aria-label="t('shell.goForward')"
      @click="navigation.forward()"
    >
      <ArrowRight class="!size-[15px]" stroke-width="1.8" />
    </Button>
  </div>
</template>

<script setup lang="ts">
/**
 * 容器组件：注入 navigation + sidebar store。
 * ←/→ 绑定导航历史栈 back/forward（与 Flow 4 分支回退解耦）。
 * 收起按钮 toggle sidebar.collapsed；折叠态 chrome 视觉在 PanelHeader（卡头槽位），此处只切状态。
 * 形态数值（32×32 钮 / top 9 / 平移 58）= demo .win-chrome 权威值，几何推导见 template 头注释。
 */
import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { useNavigationStore } from '@/stores/navigation'
import { useSidebarStore } from '@/stores/sidebar'

const { t } = useI18n()
const navigation = useNavigationStore()
const sidebar = useSidebarStore()
const { isFullscreen } = usePlatformChrome()
</script>
