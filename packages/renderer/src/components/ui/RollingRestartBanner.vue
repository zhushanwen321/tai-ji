<template>
  <!--
    [crash-forensics-and-watchdog §3.3 D5 / D3，u7d + 偏差 #27] 滚动重启四态横幅 +
    reattach 高压延迟轻态。视觉骨架复用 CrashRecoveredBar（fixed 顶部居中，零布局侵入），
    但不复用其一次性语义——推迟等待是持续态：状态源 useRollingRestartStatus（广播加速
    显示 + rollingRestart.status 只读 RPC 拉取恢复，重连/刷新不丢）。
    挂载点 AppShell（连接后主界面；restarting 全屏过渡态由 App.vue 承接，横幅无需在场）。
    **窗口级互斥（D5「同一时刻只有一条横幅」，滚动重启优先）**：本条 z-index 高于
    CrashRecoveredBar（9999）一档——两者同位叠加时本条完整覆盖后者（不透明 bg-surface），
    视觉上恒只有一条；红牌消除后 CrashRecoveredBar 恢复可达。跨条互斥需要双向感知
    （改 useCrashRecoveryNotice/CrashRecoveredBar，领地外），采用覆盖式单向互斥并登记。
  -->
  <Transition name="rolling-restart-banner">
    <div
      v-if="visible"
      data-testid="rolling-restart-banner"
      :data-phase="phase.kind"
      role="alert"
      class="fixed left-1/2 top-3 z-[10000] flex max-w-[min(560px,calc(100vw-6rem))] -translate-x-1/2 items-start gap-2 rounded-[var(--radius)] border border-border bg-surface py-2 pl-3 pr-2 shadow-lg"
    >
      <component :is="toneIcon" data-testid="rolling-restart-icon" class="mt-0.5 size-3.5 shrink-0" :class="toneClass" aria-hidden="true" />
      <p data-testid="rolling-restart-text" class="select-text break-words text-[12.5px] leading-snug text-neutral-fg">
        {{ text }}
      </p>
      <Button
        variant="ghost"
        class="ml-1 size-6 shrink-0 rounded-sm p-0 opacity-60 hover:opacity-100"
        data-testid="rolling-restart-dismiss"
        :aria-label="t('rollingRestart.dismiss')"
        @click="dismiss()"
      >
        <X class="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, CheckCircle2, Hourglass, TriangleAlert, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useRollingRestartStatus } from '@/composables/useRollingRestartStatus'

const { t } = useI18n()
const { phase, dismiss } = useRollingRestartStatus()

const visible = computed(() => phase.value.kind !== 'idle')

/** 分档色调：推迟/预告 = warn、红牌 = danger、已恢复 = info（token 色，不硬编码）。 */
const toneClass = computed(() => {
  switch (phase.value.kind) {
    case 'rolling': return 'text-danger'
    case 'recovered': return 'text-info'
    default: return 'text-warn'
  }
})

const toneIcon = computed<Component>(() => {
  switch (phase.value.kind) {
    case 'rolling': return AlertCircle
    case 'recovered': return CheckCircle2
    case 'reattach-deferred': return Hourglass
    default: return TriangleAlert
  }
})

/** ms → s 换算基数（文案秒数取整）。 */
const MS_PER_SEC = 1000

/** 四态 + 轻态文案（i18n rollingRestart 命名空间；秒数取整秒且不为负）。 */
const text = computed(() => {
  const p = phase.value
  switch (p.kind) {
    case 'deferred':
      return p.reason === 'absent-report'
        ? t('rollingRestart.deferredUnknown')
        : t('rollingRestart.deferred', { count: p.inflight ?? 0 })
    case 'countdown': {
      if (p.executesAt <= 0) return t('rollingRestart.countdownSoon')
      return t('rollingRestart.countdown', { seconds: Math.max(0, Math.round((p.executesAt - Date.now()) / MS_PER_SEC)) })
    }
    case 'rolling':
      return t('rollingRestart.rolling')
    case 'recovered':
      return t('rollingRestart.recovered')
    case 'reattach-deferred':
      return t('rollingRestart.reattachDeferred', { pollSec: Math.max(1, Math.round(p.pollMs / MS_PER_SEC)) })
    default:
      return ''
  }
})
</script>

<style scoped>
.rolling-restart-banner-enter-active { transition: opacity var(--duration) var(--ease), transform var(--duration) var(--ease); }
.rolling-restart-banner-leave-active { transition: opacity var(--duration-fast) var(--ease), transform var(--duration-fast) var(--ease); }
.rolling-restart-banner-enter-from { opacity: 0; transform: translate(-50%, -8px); }
.rolling-restart-banner-leave-to { opacity: 0; transform: translate(-50%, -8px); }
</style>
