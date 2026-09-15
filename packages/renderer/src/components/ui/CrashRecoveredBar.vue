<template>
  <!--
    [crash-resilience §3.1 T2 / §4 A3] renderer 崩溃恢复一次性提示条。
    窗口级通知（非对话流内容）：状态源 = URL query 恢复标志（main 侧
    window-factory.ts reloadWindowAfterCrash 注入），useCrashRecoveryNotice 首次
    消费即剥离标志——手动刷新不再重现（一次性语义）。挂载点 App.vue（ToastContainer
    同层），fixed 顶部居中：零布局侵入（AppShell h-screen 拓扑不动）、避开左上
    traffic light 区（x 8~60）。
    与 T4 pi-respawn 提示条（RespawnNoticeBar，对话流内 ephemeral system 消息）
    是两条独立状态链。
  -->
  <Transition name="crash-bar">
    <div
      v-if="visible"
      data-testid="crash-recovered-bar"
      class="fixed left-1/2 top-3 z-[9999] flex max-w-[min(520px,calc(100vw-6rem))] -translate-x-1/2 items-center gap-2 rounded-[var(--radius)] border border-border bg-surface py-2 pl-3 pr-2 shadow-lg"
    >
      <CheckCircle2 class="size-3.5 shrink-0 text-info" aria-hidden="true" />
      <p data-testid="crash-recovered-text" class="select-text break-words text-[12.5px] leading-snug text-neutral-fg">
        {{ text }}
      </p>
      <Button
        variant="ghost"
        class="ml-1 size-6 shrink-0 rounded-sm p-0 opacity-60 hover:opacity-100"
        data-testid="crash-recovered-dismiss"
        :aria-label="t('app.crashDismiss')"
        @click="dismiss()"
      >
        <X class="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useCrashRecoveryNotice } from '@/composables/useCrashRecoveryNotice'

const { t } = useI18n()
const { visible, reason, dismiss } = useCrashRecoveryNotice()

// reason → 用户可读文案：设计 T2 只定义了 oom 措辞（「内存不足」），其余 render-process-gone
// reason 值（killed/crashed/…）统一 fallback「未知原因」——不向用户暴露英文技术值
const reasonText = computed(() =>
  reason.value === 'oom' ? t('app.crashReasonOom') : t('app.crashReasonUnknown'),
)
const text = computed(() => t('app.crashRecovered', { reason: reasonText.value }))
</script>

<style scoped>
.crash-bar-enter-active { transition: opacity var(--duration) var(--ease), transform var(--duration) var(--ease); }
.crash-bar-leave-active { transition: opacity var(--duration-fast) var(--ease), transform var(--duration-fast) var(--ease); }
.crash-bar-enter-from { opacity: 0; transform: translate(-50%, -8px); }
.crash-bar-leave-to { opacity: 0; transform: translate(-50%, -8px); }
</style>
