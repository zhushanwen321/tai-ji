<template>
  <!--
    终端开关按钮（三卡化 2026-10-04 起挂 PanelHeader 右簇、右侧抽屉开关左边——原 StatusBar
    底栏落点随底抽屉卡片化退役，鼠标路径入口迁顶栏与其它容器开关同区）。
    点击 = toggleBottomDrawer()（core bottom-drawer 域协调函数，与 ⌃` 同一落点——本单元只接
    鼠标路径，快捷键接线归键盘编排单元）；aria-pressed 投影开合态（当前会话分区）。
    关闭分支焦点回 composer（§6.7 焦点契约与键盘通道同款——stack-order.closeTopContainer
    关闭后均 focusComposer；打开分支不抢焦点，内容自取）。
  -->
  <Button
    variant="ghost"
    class="size-[22px] shrink-0 rounded-md p-0"
    :class="isOpen ? 'bg-surface-hover text-neutral-fg' : 'text-neutral-mid'"
    :aria-pressed="isOpen"
    :title="t('panel.terminal.toggle')"
    data-testid="terminal-toggle-button"
    @click="onToggle"
  >
    <Terminal class="size-[15px]" />
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
