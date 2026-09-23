<template>
  <!--
    容器组件 · Workspace（workspace/spec.md 双 Panel 主从容器）。
    承载 PanelContainer（单/双 panel 主从状态机）。
    FG4 骨架：仅 chat view 内容（main 区 view 路由唯一分支）。
    无 session 时空态引导（spec §8.5 基础空态：欢迎语）。
  -->
  <div class="flex h-full w-full flex-col overflow-hidden">
    <!-- CompanionBand（全局单例 dialog 带，监听 focusedSession 的 ui-request 简单 dialog 请求；
         form 类（含 legacy askUser / scheduleCreate 原始帧）与 planReview 审批请求被 C4 分流
         排除，各归 FormOverlay / PlanReviewBar 消费；inject 缺失时静默空态，provide 由
         useExtensionHostBridge dialog 适配接线） -->
    <CompanionBand :session-id="focusedSessionId" />
    <!-- hasSession 守卫放行整个 new-task flow 活跃态（landing + 各 overlay）：
         统一延迟 create 下 flow 活跃期间 activeId 恒 null，但 UI 须保持 Landing 挂载，
         否则用户点 chip 进 overlay 态会瞬间卸载 Landing 跳兜底页、系统目录选择器视觉丢失。
         Sparkles 空态仅作异常兜底（initApp 失败且 flow 未离开 idle 时）。 -->
    <PanelContainer v-if="hasSession || flow.isActive" />
    <div
      v-else
      class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <Sparkles class="size-8 text-accent opacity-70" />
      <div>
        <p class="text-[15px] font-medium text-neutral-fg">{{ t('workspace.emptyTitle') }}</p>
        <p class="mt-1 text-[12px] text-neutral-mid">
          {{ t('workspace.shortcutHint') }}
          <kbd class="ml-1 rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-neutral-dim">{{ formatKbd('n') }}</kbd>
          {{ t('workspace.shortcutKey') }}
        </p>
      </div>
      <Button variant="default" size="sm" class="gap-1.5" @click="onNewSession">
        <Plus class="size-[14px]" />
        {{ t('workspace.newTask') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useBrowserFocusSync } from '@/composables/features/browser/useBrowserFocusSync'
import { useCloseShortcut } from '@/composables/features/app/useCloseShortcut'
import { usePlatformShortcut } from '@/composables/usePlatformShortcut'
import PanelContainer from './PanelContainer.vue'
import { CompanionBand } from '@taiji/ui/extension-host'

const { t } = useI18n()
const { newSession, focusedSessionId } = useSidebar()
const { formatKbd } = usePlatformShortcut()
const flow = useNewTaskFlow()
// Browser drawer view swap：切 session 时通知主进程切换可见 WebContentsView（Wave 4 per-session 隔离）
useBrowserFocusSync()
// Cmd/Ctrl+W：drawer 打开时优先关 drawer，drawer 关时关窗口（before-input-event 拦截转发）
useCloseShortcut()

/** 是否有焦点 session（决定渲染 panel 还是空态，跟随 panel focus） */
const hasSession = computed(() => focusedSessionId.value !== null)

async function onNewSession(): Promise<void> {
  await newSession()
}
</script>
