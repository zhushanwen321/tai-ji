<template>
  <!--
    StatusBar 终端开关按钮（display-containers §5.1 规则 4 落点：鼠标路径入口，防纯键盘不可发现）。
    经 StatusBar trailing 原生动作通道注入（干净安装无插件无 statusline 项时仍可见）。
    点击 = toggleBottomDrawer()（core bottom-drawer 域协调函数，与 ⌃` 同一落点——本单元只接
    鼠标路径，快捷键接线归键盘编排单元）；aria-pressed 投影开合态（当前会话分区）。
  -->
  <Button
    variant="ghost"
    class="size-6 shrink-0 rounded-sm p-0"
    :class="isOpen ? 'bg-surface-hover text-neutral-fg' : 'text-neutral-mid'"
    :aria-pressed="isOpen"
    :title="t('panel.terminal.toggle')"
    data-testid="statusbar-terminal-toggle"
    @click="toggleBottomDrawer()"
  >
    <Terminal class="size-3.5" />
  </Button>
</template>

<script setup lang="ts">
import { Terminal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toggleBottomDrawer, useBottomDrawerControl } from '@taiji/core/domain/bottom-drawer'
import { Button } from '@/components/ui/button'

const { t } = useI18n()
const { isOpen } = useBottomDrawerControl()
</script>
