<!--
  TrayPanelSurface —— 托盘条目浮层的统一外壳（ComposerTray 的 built-in 分支与 widget 分支共用）。

  浮层形态契约（设计 §3.3 D8 + 固定高裁决 2026-09-16 + U3 热区修复）：
  - 锚定 icon 上方（side="top"）、宽 400px 由外壳给；
  - 内容区固定高 h-[340px]（小屏 max-h 60vh 兜底）：切内部 tab 容器不塌缩，hover 态指针不
    落空（面板收起的根因消除）；
  - 热区：内边距 p-1.5 放在**内容 div 自身**（不是浮层根）——内容 div 因此覆盖浮层全幅，
    指针落在 padding 带上同样触发 pointerenter 取消收起计时（U3：挂在浮层根做不到——本仓
    PopoverContent 包装组件的根是 PopoverPortal/Teleport，未声明为 props/emits 的原生监听在
    Teleport 根被 Vue 丢弃；reka PopoverContent 自身会经 PopperContent 的 `$attrs` 透传到浮层根）。
  - `data-testid="tray-panel"` 与 `data-panel-key` / `data-pinned` 是外壳状态机与 e2e 的接口，
    字符串形态不得改（e2e 依赖 `[data-testid="tray-panel"][data-panel-key=…]`）。

  交互（pointer 热区 / 层外拦截 / 打开不抢焦点）经 emit 上抛给 ComposerTray 状态机消费。
-->
<template>
  <PopoverContent
    side="top"
    align="start"
    :side-offset="6"
    class="w-[400px]"
    @interact-outside="emit('interactOutside', $event)"
    @open-auto-focus="emit('openAutoFocus', $event)"
  >
    <div
      data-testid="tray-panel"
      :data-panel-key="panelKey"
      :data-pinned="pinned ? 'true' : 'false'"
      class="flex h-[340px] max-h-[60vh] flex-col p-1.5"
      @pointerenter="emit('panelEnter')"
      @pointerleave="emit('panelLeave')"
    >
      <slot />
    </div>
  </PopoverContent>
</template>

<script setup lang="ts">
import { PopoverContent } from '@/components/ui/popover'

defineProps<{
  /** 面板键（外壳 single activeKey 的键空间，原样写入 data-panel-key） */
  panelKey: string
  /** pin 态（外壳持有，原样写入 data-pinned） */
  pinned: boolean
}>()

const emit = defineEmits<{
  /** 指针进入内容区（外壳取消待收起计时） */
  panelEnter: []
  /** 指针离开内容区（外壳按 hover 语义收起，除非 pin） */
  panelLeave: []
  /** reka 层外交互（外壳对托盘按钮行内目标 preventDefault） */
  interactOutside: [event: Event]
  /** reka 打开自动聚焦（外壳 preventDefault：hover 预览不抢 composer 焦点） */
  openAutoFocus: [event: Event]
}>()
</script>
