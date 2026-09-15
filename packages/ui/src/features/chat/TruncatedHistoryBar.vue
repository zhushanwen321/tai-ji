<template>
  <!--
    [u4d-truncated-ui] 历史预算截断顶部条（crash-resilience §3.3 D4 / 场景 T3）。
    显隐由壳层（MessageStream）v-if 控制：store 截断窗口状态 truncated=false 时本组件
    结构性不挂载（A6 回归：普通 session 无任何截断提示）。
    文案 N = loadedTurns（u4b session.history 窗口契约）；「加载更早」走 [u6] 游标翻页
    （壳层 @load → useLoadMoreHistory.handleLoadMore → useChat.loadMoreHistory，
    session.history 带 cursor——原 getFullHistory 全量通路已退役）。
  -->
  <div data-testid="truncated-history-bar" class="flex items-center gap-1">
    <span data-testid="truncated-history-info" class="text-[length:var(--text-sm)] leading-snug text-neutral-mid">
      {{ t('panel.message.loadedRecentTurns', { count: loadedTurns }) }}
    </span>
    <span aria-hidden="true" class="text-[length:var(--text-sm)] text-neutral-mid">·</span>
    <Button variant="ghost" size="sm" :disabled="loading" data-testid="load-more-history" @click="emit('load')">
      <Loader2 v-if="loading" class="mr-1 size-3 animate-spin" />
      <ChevronUp v-else class="mr-1 size-3" />
      {{ loading ? t('common.loading') : t('panel.message.loadEarlier') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronUp, Loader2 } from '@lucide/vue'
import { Button } from '../../primitives/button'

defineProps<{
  /** 已加载的最近 turn 数（u4b session.history loadedTurns，「已加载最近 N 轮」的 N） */
  loadedTurns: number
  /** 加载中（禁用按钮 + spinner，沿用原 load-more 按钮交互态） */
  loading?: boolean
}>()

const emit = defineEmits<{
  /** 点击「加载更早」——壳层接既有 load-more handler */
  load: []
}>()

const { t } = useI18n()
</script>
