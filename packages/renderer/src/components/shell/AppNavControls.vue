<template>
  <!--
    AppNavControls · 三平台统一应用导航按钮（shell spec §二）。
    收起侧栏 / ← 后退 / → 前进，浮在 traffic-light 右侧。
    top-[5px]：按钮高 22，中线 y=5+11=16，对齐红黄绿实测中线（macOS 渲染 trafficLightPosition{8,8} 实际圆点中线 ≈y15.75，比理论 y14 低 ~2pt；实测 nav 原中 13.8 +2 = 15.8 ≈ 红黄绿）。
    left-[8px]：基准定位固定在全屏位（红黄绿 OS 隐藏时的位置 x=8），常态/全屏态都不动 left，避免 layout 重排。
    transform 方案：常态叠 translate-x-[64px]（红黄绿右缘 x=60 + 12px 呼吸 = 72，减去基准 8 = 平移 64），
    全屏态无 translate 类即归零（translate-x-0），按钮占红黄绿位 x=8。
    用 transform 替代 left 动画：left 是 layout 属性，动画时触发整个窗口重排；transform 走 GPU 合成，零重排。
    条件类单向覆盖（常态显式平移 / 全屏态无类归零），无特异性冲突，不需 !important。
    320ms 平移与 traffic-light opacity 同步。
    折叠态 header pl-[88px] 让位红黄绿（右缘 60），chrome 按钮起 x≈88。

    渲染条件（draft-collapsed-state.html 卡 A/B/C）：
    - 非折叠态（① 展开+非全屏 / ② 展开+全屏）：浮此浮层。展开=chrome 跟随 traffic-light 在 AppShell 层，
      全屏态 left:8px 占红黄绿位（红黄绿 OS 隐藏）。
    - 折叠态（③ 折叠+非全屏 / ④ 折叠+全屏）：隐藏此浮层 → chrome 已迁入 P1 PanelHeader（卡 A/B/C）。
      折叠一律由 header 承接，避免与浮层重复渲染两套 chrome。
  -->
  <div
    v-if="!sidebar.collapsed"
    class="app-nav-controls absolute top-[5px] left-[8px] z-10 flex gap-0.5 transition-transform duration-[var(--duration-slow)] ease-[var(--ease)]"
    :class="{ 'translate-x-[64px]': !isFullscreen }"
  >
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
      :title="sidebar.collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')"
      :aria-label="t('shell.toggleSidebar')"
      data-testid="sidebar-collapse-toggle"
      @click="sidebar.toggleCollapsed()"
    >
      <PanelLeftOpen v-if="sidebar.collapsed" class="size-[14px]" />
      <PanelLeftClose v-else class="size-[14px]" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-dim [-webkit-app-region:no-drag]"
      :disabled="!navigation.canBack"
      :title="t('shell.goBack')"
      :aria-label="t('shell.goBack')"
      @click="navigation.back()"
    >
      <ArrowLeft class="size-[14px]" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-dim [-webkit-app-region:no-drag]"
      :disabled="!navigation.canForward"
      :title="t('shell.goForward')"
      :aria-label="t('shell.goForward')"
      @click="navigation.forward()"
    >
      <ArrowRight class="size-[14px]" />
    </Button>
  </div>
</template>

<script setup lang="ts">
/**
 * 容器组件：注入 navigation + sidebar store。
 * ←/→ 绑定导航历史栈 back/forward（与 Flow 4 分支回退解耦）。
 * 收起按钮 toggle sidebar.collapsed；折叠态宽度视觉属 L2（W09），此处只切状态。
 * 按钮尺寸 26×22 = draft-overlay-states.html nav-btn 精确值（非 token 化，设计稿像素级要求）。
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
