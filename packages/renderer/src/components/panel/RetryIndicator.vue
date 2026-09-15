<!--
  展示组件 · auto_retry 指示位（spec C10 / FR-3，issues.md #13，code-architecture §4.7b）。
  Composer 上方独立行：RefreshCw 旋转 + 「重试中 N/M」+ 可选 errorMessage 缩略尾。

  纯展示型：props.state 由 Composer 从 chatStore.getRetryState(sessionId) 计算传入。
  生命周期绑定 store：auto_retry_end 到达 → store retryStates.delete → state=undefined
  → 本组件 v-if 失效自动消失，无需自管取消逻辑（spec §4.7b 时序图）。

  色相：warning（橙）—— 重试是警告态，非错误（danger 留给发送失败 banner/系统 error 行）。
-->
<template>
  <div
    v-if="state"
    class="mb-1.5 flex items-center gap-2 rounded-md border border-warn/35 bg-warn-soft px-3 py-1.5 text-[length:var(--text-xs)] text-neutral-fg"
    :title="state.errorMessage ? t('panel.retryIndicator.lastFailed', { error: state.errorMessage }) : t('panel.retryIndicator.autoRetrying')"
  >
    <RefreshCw class="size-3 shrink-0 animate-spin text-warn" />
    <span class="font-semibold">{{ t('panel.retryIndicator.retrying') }}</span>
    <span v-if="state.attempt !== undefined" class="font-mono text-[length:var(--text-2xs)] tabular-nums text-neutral-mid">
      {{ state.attempt }}<template v-if="state.maxAttempts">/{{ state.maxAttempts }}</template>
    </span>
    <span v-if="state.errorMessage" class="ml-1 min-w-0 truncate text-[length:var(--text-2xs)] text-neutral-dim">
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
