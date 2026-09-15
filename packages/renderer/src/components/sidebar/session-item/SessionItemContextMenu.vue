<template>
  <!--
    SessionItem 右键菜单子块：整棵 reka ContextMenu 树 + 强制退出两段确认状态机。
    Trigger as-child 合并到 slot（主组件的 .session-item 根 div），不引入额外包裹层破坏既有 flex/绝对定位。
    状态机在此内聚的理由：confirmingQuit 只被菜单 item 消费，其重置通道（update:open）也挂在
    ContextMenuRoot 上——与条目展示零耦合，拆出去反而要跨组件同步菜单开关状态。
  -->
  <!-- 右键菜单用 reka ContextMenu 原语（光标定位原语级支持，PanelContainer 同为直接引 reka-ui 先例）。 -->
  <ContextMenuRoot @update:open="onMenuOpenChange">
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <!-- 右键菜单：agent-spawned 且带父 id → 「查看父 session」；非 dead session → 「强制退出」（两段确认）。
         条件渲染整块 Portal——两者皆无时右键无任何菜单项，不吞 native menu 之外的语义。
         跳转/退出逻辑由上层接线，本组件只保证事件链 emit navigateParent / forceQuit。 -->
    <ContextMenuPortal v-if="hasAgentParent || canForceQuit">
      <ContextMenuContent
        data-testid="session-context-menu"
        class="z-[1100] min-w-[160px] rounded-md border border-border-strong bg-bg-elevated p-1 text-neutral-fg shadow-2 outline-none"
      >
        <ContextMenuItem
          v-if="hasAgentParent"
          data-testid="session-view-parent-item"
          class="flex h-auto w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[length:var(--text-xs)] text-neutral-mid outline-none hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[13px]"
          @select="onViewParent"
        >
          <CornerLeftUp />
          <span>{{ t('sidebar.sessionItem.viewParent') }}</span>
        </ContextMenuItem>
        <!-- 强制退出（两段式确认）：首击 preventDefault 保持菜单打开并进入确认态（danger 底），
             再击才 emit。reka ContextMenuItem 的 select event cancelable，preventDefault 可阻止自动关闭。 -->
        <ContextMenuItem
          v-if="canForceQuit"
          data-testid="session-force-quit-item"
          class="flex h-auto w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] outline-none [&_svg]:size-[13px]"
          :class="confirmingQuit
            ? 'bg-danger text-neutral-fg'
            : 'text-danger/90 hover:bg-danger-soft hover:text-danger'"
          @select="onForceQuitSelect"
        >
          <Power />
          <span>{{ confirmingQuit ? t('sidebar.sessionItem.forceQuitConfirm') : t('sidebar.sessionItem.forceQuit') }}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CornerLeftUp, Power } from '@lucide/vue'
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuItem,
} from 'reka-ui'

const props = defineProps<{
  sessionId: string
  /** 父 agent session id（U8）：「查看父 session」的跳转目标 payload */
  parentAgentSessionId?: string
  /** agent-spawned 且带父 id（badge 只标来源；右键菜单还需父 id 才有可导航目标） */
  hasAgentParent: boolean
  /** 非 dead session 可强制退出（dead 进程已退出，无需强杀；点击走 restore 重开） */
  canForceQuit: boolean
}>()

const emit = defineEmits<{
  /** 查看父 session（U8）：payload 单字符串 = parentAgentSessionId（与 select 同形）。
   *  跳转本身由上层（Sidebar/store）接线，本组件只发事件。 */
  navigateParent: [parentAgentSessionId: string]
  /** 强制退出（两段确认后 emit）：杀 pi 进程 + stopped 收敛，上层接 RPC。 */
  forceQuit: [sessionId: string]
}>()

const { t } = useI18n()

/** 强制退出两段式确认态（同删除 confirming 模式；菜单内完成，靠 select preventDefault 保持菜单打开）。 */
const confirmingQuit = ref(false)
/** 菜单关闭重置确认态，避免下次打开残留确认样式。 */
function onMenuOpenChange(open: boolean): void {
  if (!open) confirmingQuit.value = false
}
/** 首击进入确认态并阻止菜单关闭（reka select event cancelable）；再击 emit 并复位。 */
function onForceQuitSelect(e: Event): void {
  if (!confirmingQuit.value) {
    e.preventDefault()
    confirmingQuit.value = true
    return
  }
  confirmingQuit.value = false
  emit('forceQuit', props.sessionId)
}
/** 菜单项点击：向上 emit 父 session id。守卫除防御外还承担 TS 窄化
 *  （props 字段 string|undefined → emit 要求 string），不可删。 */
function onViewParent(): void {
  const parent = props.parentAgentSessionId
  if (!parent) return
  emit('navigateParent', parent)
}
</script>
