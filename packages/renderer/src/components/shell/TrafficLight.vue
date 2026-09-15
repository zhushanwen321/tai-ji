<template>
  <!--
    TrafficLight · 跨平台窗口控制（shell spec §五方案 X）
    - mac：空占位 div（保留 .traffic-light 定位 + opacity transition 语义，红黄绿由 OS 绘制）
    - win/linux：自绘 3 彩色圆点 mimic mac（mac 原生位置 {8,8}；aside 顶在窗口 y=4，故 left-0=窗口x8 / top-[4px]=窗口y8），hover 整组显 close/min/max 符号，点击 IPC 控窗口
    全屏态 isFullscreen=true 时 opacity→0 + pointer-events-none（响应式 :class 绑定，替代旧 [data-fullscreen] 祖先选择器），
    mac 系统 hover 浮层独立不参与。
    [review MF-1] pointer-events-none 必须与 opacity-0 成对：仅隐藏视觉时，隐形圆点组
    （absolute z-10）仍可被点击（折叠+全屏下悬浮在 PanelHeader chrome 之上），点击静默触发
    最小化/最大化。opacity 只管视觉，pointer-events 管命中。
  -->
  <div
    class="traffic-light absolute left-0 top-[4px] flex gap-2 z-10 transition-opacity duration-[var(--duration-slow)] ease-[var(--ease)] group"
    :class="{ 'opacity-0 pointer-events-none': isFullscreen }"
  >
    <template v-if="!isMac">
      <Button
        v-for="dot in dots"
        :key="dot.action"
        variant="ghost"
        :aria-label="dot.label"
        :title="dot.label"
        class="tl-dot h-3 w-3 grid place-items-center rounded-full p-0 hover:bg-transparent"
        :class="dot.bgClass"
        @click="onAction(dot.action)"
      >
        <component
          :is="dot.icon"
          :size="8"
          class="text-black/55 opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100"
        />
      </Button>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 纯展示 + 窗口控制副作用。
 * 平台判定：detectPlatform() 纯字符串匹配（模块加载时算一次，平台运行期不变）。
 * 全屏态：usePlatformChrome 单例 isFullscreen ref（onMounted 注册 IPC 监听）。
 * 窗口控制仅 win/linux 触发；mac 下模板不渲染按钮，事件不可达。
 */
import { type FunctionalComponent } from 'vue'
import { X, Minus, Plus } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { detectPlatform, usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { windowClose, windowMinimize, windowToggleMaximize } from '@/lib/ipc'

type WinAction = 'minimize' | 'toggleMaximize' | 'close'
interface DotDef {
  bgClass: string
  action: WinAction
  label: string
  icon: FunctionalComponent<{ size?: number }>
}

const { t } = useI18n()
const isMac = detectPlatform() === 'mac'
const { isFullscreen } = usePlatformChrome()

// 红=close / 黄=minimize / 绿=maximize（mac 红黄绿标准映射）
const dots: DotDef[] = [
  { bgClass: 'bg-[#ff5f57]', action: 'close', label: t('shell.close'), icon: X },
  { bgClass: 'bg-[#febc2e]', action: 'minimize', label: t('shell.minimize'), icon: Minus },
  { bgClass: 'bg-[#28c840]', action: 'toggleMaximize', label: t('shell.maximize'), icon: Plus },
]

function onAction(action: WinAction): void {
  if (action === 'minimize') void windowMinimize()
  else if (action === 'toggleMaximize') void windowToggleMaximize()
  else void windowClose()
}
</script>
