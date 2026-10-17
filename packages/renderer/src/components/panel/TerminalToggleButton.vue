<template>
  <!--
    终端开关按钮（三卡化 2026-10-04 起挂 PanelHeader 右簇、右侧抽屉开关左边——
    底栏落点随底抽屉卡片化退役，鼠标路径入口迁顶栏与其它容器开关同区）。
    形态 = demo 卡头钮 40px 档（--hb-btn 30×30 / --hb-icon 17 / 色 --dim / stroke 1.6）；
    开态无选中视觉（demo 选中态范式不含卡头开关钮），开关反馈由底抽屉面板本身承担，
    aria-pressed 语义态保留（可达性不随视觉简化降级）。
    点击 = toggleBottomDrawer()（core bottom-drawer 域协调函数，与 ⌃` 同一落点——本单元只接
    鼠标路径，快捷键接线归键盘编排单元）。
    关闭分支焦点回 composer（§6.7 焦点契约与键盘通道同款）；打开分支不抢焦点，内容自取。
  -->
  <Button
    variant="ghost"
    class="size-[30px] shrink-0 rounded-sm p-0 text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
    :aria-pressed="isOpen"
    :title="t('panel.terminal.toggle')"
    data-testid="terminal-toggle-button"
    @click="onToggle"
  >
    <Terminal class="size-[17px]" stroke-width="1.6" />
  </Button>
</template>

<script setup lang="ts">
import { Terminal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toggleBottomDrawer, useBottomDrawerControl } from '@taiji/core/domain/bottom-drawer'
import { focusComposer } from '@/composables/features/app/key-orchestrator'
import { Button } from '@/components/ui/button'

const { t } = useI18n()
const { isOpen } = useBottomDrawerControl()

/** 开关 + 焦点契约（§6.7，display-containers D5 sync 裁决落码臂）：任一容器关闭后焦点回
 *  composer——鼠标路径与键盘路径（stack-order）同款；打开分支不调 focusComposer
 *  （不抢内容焦点）。 */
function onToggle(): void {
  const wasOpen = isOpen.value
  toggleBottomDrawer()
  if (wasOpen) focusComposer()
}
</script>
