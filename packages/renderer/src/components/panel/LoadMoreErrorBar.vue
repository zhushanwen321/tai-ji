<!--
  [RD-1#4] 「加载更早」失败重试行（loadMoreError 的渲染位）。

  背景（审计 RD-1#4，审查 E 事实修正）：useChat.loadMoreHistory 失败时 truncated 窗口不变
  （与「已到头」在状态上不可区分），旧实现只 console.warn + finally 复位 loading——按钮恢复
  原样，用户侧症状 = 「点了没反应、无失败提示」，误以为历史已加载完。本行补上失败显形：
  截断顶部条下方多一行「加载失败 + 重试」，重试 = 再走一次 handleLoadMore（窗口状态未被
  失败破坏，重试安全）。

  形态：复用 InboundFrameDroppedNotice / 对话流 broken 行的「图标 + warn 色文案」降级行范式
  （不新建第三套提示形态）；显隐由壳层（MessageStream）v-if="loadMoreError" 控制，本组件
  不持有状态（状态源 = useLoadMoreHistory.loadMoreError，单一真相源）。

  文案走既有 i18n key（common.loadFailed / common.retry）——本行不新增 locale key。
-->
<template>
  <div data-testid="load-more-error-bar" class="flex h-8 w-full items-center justify-center gap-1.5">
    <TriangleAlert class="size-3 shrink-0 text-warn" aria-hidden="true" />
    <span data-testid="load-more-error-text" class="text-[length:var(--text-xs)] leading-none text-warn">
      {{ t('common.loadFailed') }}
    </span>
    <Button
      variant="ghost"
      size="dense"
      :disabled="loading"
      data-testid="load-more-retry"
      @click="emit('retry')"
    >
      <Loader2 v-if="loading" class="mr-1 size-3 animate-spin" />
      <RotateCw v-else class="mr-1 size-3" />
      {{ t('common.retry') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2, RotateCw, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{
  /** 加载中（重试按钮禁用 + spinner，与顶部条「加载更早」按钮态一致） */
  loading?: boolean
}>()

const emit = defineEmits<{
  /** 点击「重试」——壳层接既有 load-more handler（useLoadMoreHistory.handleLoadMore） */
  retry: []
}>()

const { t } = useI18n()
</script>
