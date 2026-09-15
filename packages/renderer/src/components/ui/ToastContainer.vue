<template>
  <!--
    定位契约：absolute 右上角锚定最近 positioned 祖先（非视口 fixed）——右上角避开 composer，
    锚在 chat 主区（main-area）内时 drawer 打开随主区收窄左移，恒不遮 drawer。
    挂载点两分支（互斥）：PanelContainer main-area（chat 主区）/ MainPanel
    （overview/settings view 兜底）。
  -->
  <TransitionGroup
    tag="div"
    name="toast"
    class="absolute inset-x-4 top-4 z-[9999] flex flex-col items-end gap-2.5 pointer-events-none"
  >
    <div
      v-for="t in toasts"
      :key="t.id"
      class="pointer-events-auto flex w-fit max-w-[min(360px,100%)] items-start gap-2.5 rounded-lg border border-border bg-surface py-2.5 pl-3 pr-2 shadow-lg"
      :class="toastClass(t.type)"
      @mouseenter="pause(t.id)"
      @mouseleave="resume(t.id)"
    >
      <!-- type icon（对齐 body 首行）：error lucide alert-circle -->
      <svg
        v-if="t.type === 'error'"
        class="mt-0.5 h-4 w-4 shrink-0 text-danger"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
      <!-- warning icon: lucide alert-triangle -->
      <svg
        v-else-if="t.type === 'warning'"
        class="mt-0.5 h-4 w-4 shrink-0 text-warn"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
      <!-- info icon: lucide info -->
      <svg
        v-else
        class="mt-0.5 h-4 w-4 shrink-0 text-info"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>

      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <!-- session 定位行：点击跳转该 session（后台通知的行动闭环） -->
        <button
          v-if="t.sessionLabel && t.sessionId"
          :data-testid="`toast-session-${t.id}`"
          class="flex max-w-full items-center gap-1 self-start rounded-sm text-left text-[11px] leading-4 text-neutral-dim transition-colors hover:text-neutral-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          @click.stop="onJump(t.sessionId, t.id)"
        >
          <span class="truncate">{{ t.sessionLabel }}</span>
          <!-- lucide arrow-up-right：可跳转的暗示 -->
          <svg
            class="h-3 w-3 shrink-0 opacity-70"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>
        </button>
        <!-- 消息体：pre-line 渲染 \n，最多 5 行 -->
        <p
          :data-testid="`toast-message-${t.id}`"
          class="whitespace-pre-line break-words text-[12.5px] leading-[1.55] line-clamp-5 select-text"
          :class="textClass(t.type)"
        >{{ t.message }}</p>
      </div>

      <Button
        variant="ghost"
        class="ml-1 size-6 shrink-0 rounded-sm p-0 opacity-60 hover:opacity-100"
        @click="remove(t.id)"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </Button>
    </div>
  </TransitionGroup>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { useToast } from '@/composables/useToast'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'

const { toasts, remove, pause, resume } = useToast()
const { selectSession } = useSidebar()

/** toast 类型 → 边框强调色（背景统一 bg-surface，克制：色彩只落在 icon 与正文） */
function toastClass(type: 'error' | 'info' | 'warning'): string {
  if (type === 'error') return 'border-danger/40'
  if (type === 'warning') return 'border-warn/40'
  return 'border-border'
}

/** toast 类型 → 正文颜色（error/warning 语义着色，info 中性） */
function textClass(type: 'error' | 'info' | 'warning'): string {
  if (type === 'error') return 'text-danger'
  if (type === 'warning') return 'text-warn'
  return 'text-neutral-fg'
}

/** 定位行点击 → 跳转来源 session 并关掉 toast（通知 → 行动闭环） */
async function onJump(sessionId: string, toastId: number): Promise<void> {
  remove(toastId)
  await selectSession(sessionId)
}
</script>

<style scoped>
.toast-enter-active { transition: opacity var(--duration) var(--ease), transform var(--duration) var(--ease); }
.toast-leave-active { transition: opacity var(--duration-fast) var(--ease), transform var(--duration-fast) var(--ease); }
.toast-enter-from { opacity: 0; transform: translateX(20px); }
.toast-leave-to { opacity: 0; transform: translateX(20px); }
</style>
