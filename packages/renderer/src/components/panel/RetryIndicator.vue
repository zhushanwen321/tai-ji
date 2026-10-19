<!--
  展示组件 · auto_retry 指示位（spec C10 / FR-3）。
  Composer 上方独立轻行：RefreshCw 旋转（warn）+ 「重试中」chip（warn-soft 小胶囊）+
  尝试次数 mono + 可选 errorMessage 缩略尾——形态对齐 QueueBubble 瞬态行（轻行 + 小 chip，
  语义色只上图标与 chip），不带横幅底色/边框（瞬态过程指示不抢视觉权重，六主题中性灰调通用）。

  纯展示型：props.state 由 Composer 从 chatStore.getRetryState(sessionId) 计算传入。
  生命周期绑定 store：重试后的新 assistant 流开始（message.message_start）或 auto_retry_end
  到达 → store retryStates.delete → state=undefined → 本组件 v-if 失败自动消失，
  无需自管取消逻辑（spec §4.7b 时序图）。

  色相：warn 只点缀图标与「重试中」chip——重试是警告态，非错误（danger 留给发送失败
  banner/系统 error 行）。
-->
<template>
  <div
    v-if="state"
    class="mb-1 flex items-center gap-1.5 px-3.5 py-0.5 text-[length:var(--text-xs)]"
    :title="state.errorMessage ? t('panel.retryIndicator.lastFailed', { error: state.errorMessage }) : t('panel.retryIndicator.autoRetrying')"
  >
    <RefreshCw class="size-3 shrink-0 animate-spin text-warn" />
    <span class="shrink-0 rounded-[var(--radius-sm)] bg-warn-soft px-1 py-px text-[length:var(--text-2xs)] font-medium leading-[1.4] text-warn">
      {{ t('panel.retryIndicator.retrying') }}
    </span>
    <span v-if="state.attempt !== undefined" class="font-mono text-[length:var(--text-2xs)] tabular-nums text-neutral-dim">
      {{ state.attempt }}<template v-if="state.maxAttempts">/{{ state.maxAttempts }}</template>
    </span>
    <span v-if="state.errorMessage" class="min-w-0 truncate text-[length:var(--text-2xs)] text-neutral-dim">
      {{ state.errorMessage }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RefreshCw } from '@lucide/vue'
import type { RetryState } from '@/stores/chat'

const { t } = useI18n()

defineProps<{
  state: RetryState | undefined
}>()
</script>
