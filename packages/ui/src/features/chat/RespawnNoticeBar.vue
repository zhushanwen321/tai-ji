<template>
  <!--
    [u8-pi-respawn] pi 崩溃恢复提示条（crash-resilience §3.3 D7 / 场景 T4）。
    渲染分支由 SystemNotice 按 PI_RESPAWN_NOTICE_CUSTOM_TYPE customType 派发（subagent
    定向气泡同款分支先例），数据源 = 对话流内的 ephemeral system 消息（core chat store
    appendRespawnNotice 写入，liveOnly——重开 session 不出现，一次性通知语义）。

    两种形态（variant）：
    - restored：恢复成功。T4 文案——在途回合未保留；崩溃时进行中的后台任务与子代理已
      终止、不会自动恢复；可继续发消息（被否方案④「盲复活」的诚实降级，D7）。
    - restoreFailed：自动恢复连续 2 次失败熔断（D7）。失败文案 + 重试按钮——emit('retry')
      由壳层（MessageStream）接手动恢复（session.restore RPC），不触发自动恢复链路。
  -->
  <div
    data-testid="respawn-notice-bar"
    :data-variant="variant"
    class="content-col flex min-w-0 flex-col gap-1 rounded-[var(--radius)] border border-border bg-surface px-3 py-2"
  >
    <div class="flex min-w-0 items-start gap-2">
      <component :is="icon" class="mt-0.5 size-3.5 shrink-0 text-neutral-mid" aria-hidden="true" />
      <p class="min-w-0 break-words text-[length:var(--text-xs)] leading-snug text-neutral-mid">
        <span data-testid="respawn-notice-text">{{ text }}</span>
      </p>
    </div>
    <div v-if="variant === 'restoreFailed'" class="flex items-center gap-1 pl-5">
      <Button variant="ghost" size="sm" data-testid="respawn-notice-retry" @click="emit('retry')">
        <RefreshCw class="mr-1 size-3" aria-hidden="true" />
        {{ t('panel.message.respawnRetry') }}
      </Button>
      <span class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('panel.message.respawnFailedHint') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, RefreshCw, TriangleAlert } from '@lucide/vue'
import type { Component } from 'vue'
import { Button } from '../../primitives/button'

const props = defineProps<{
  /** 提示形态：restored = 恢复成功（T4 文案）；restoreFailed = 熔断失败（含重试按钮） */
  variant: 'restored' | 'restoreFailed'
}>()

const emit = defineEmits<{
  /** 点击重试——壳层接手动恢复（session.restore RPC + revive），自动链路已熔断不再续排 */
  retry: []
}>()

const { t } = useI18n()

/** 按形态选图标 + 文案（纯派生，props 不变则结果不变） */
const icon = computed<Component>(() => (props.variant === 'restored' ? CheckCircle2 : TriangleAlert))
const text = computed(() =>
  props.variant === 'restored' ? t('panel.message.respawnRestored') : t('panel.message.respawnFailed'),
)
</script>
