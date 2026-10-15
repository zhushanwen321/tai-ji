<template>
  <!--
    [u4d-truncated-ui] 历史预算截断顶部条（D4 / 场景 T3）。
    显隐由壳层（MessageStream）v-if 控制：store 截断窗口状态 truncated=false 时本组件
    结构性不挂载（A6 回归：普通 session 无任何截断提示）。
    文案 N = loadedTurns（u4b session.history 窗口契约）；「加载更早」走 [u6] 游标翻页
    （壳层 @load → useLoadMoreHistory.handleLoadMore → useChat.loadMoreHistory，
    session.history 带 cursor——原 getFullHistory 全量通路已退役）。
    [2026-09-19 触顶自动续载] 滚到顶即自动走同一加载通路（useLoadMoreHistory.onScrollOffset，
    «keep 触发条件 = 已脱离锚定 + offset 触顶），本按钮降级为兜底/进度位：loading 期间显示
    spinner（「正在续载」），触顶信号不可达（如窗口内容短于视口）时仍可手点。

    [2026-10-15 pill 化] 形态重做（demo：.tmp/truncated-history-bar-redesign.html 方案 A）：
    旧形态 = 裸文字 + 「·」+ ghost Button sm：无视觉载体，滚近顶缘时与内容一起被渐焦带
    糊化；且按钮 size="sm" 实高 h-9(36px) + 壳层 py-2(16px) = 52px 与预留常量 44 漂移
    （断言告警；30px spacer 兜底未致真重叠，条下净空仅 22px）。新形态 = 悬浮 pill：
    - 载体：h-8 胶囊 + 发丝边 + bg-elevated 实色底 + shadow-2（与「回到最新」胶囊
      （MessageStream jump pill）同一浮层语言，主题经 token 自适应）——渐焦带糊化的是
      内容，条自己是清楚的一颗；
    - 信息层级：History 图标 + 次级灰信息文字，accent 只给可点的「加载更早」
      （refactoring-ui：de-emphasize by reducing contrast，语义色不让给次要动作）；
    - 「·」文字分隔 → h-3 w-px 发丝竖线（不发灰字噪音）；
    - 按钮 size="sm"(h-9) → dense + h-6 覆盖，圆角与 pill 对齐（999px）；
    - 高度：pt-3 12px + h-8 32px = 自然高 44，与 LOAD_MORE_RESERVED_HEIGHT 恒等
      （旧 52px 漂移消除）；条下净空 = spacer 30 + 44 − 44 = 30px（旧 22px）。
  -->
  <div
    data-testid="truncated-history-bar"
    class="flex h-8 items-center gap-2 rounded-full border border-border-strong bg-[var(--bg-elevated)] pl-3 pr-1 shadow-[var(--shadow-2)]"
  >
    <Loader2 v-if="loading" class="size-3.5 shrink-0 animate-spin text-neutral-ico" aria-hidden="true" />
    <History v-else class="size-3.5 shrink-0 text-neutral-ico" aria-hidden="true" />
    <span data-testid="truncated-history-info" class="text-[length:var(--text-sm)] leading-none text-neutral-mid">
      {{ t('panel.message.loadedRecentTurns', { count: loadedTurns }) }}
    </span>
    <span aria-hidden="true" class="h-3 w-px shrink-0 bg-border-strong"></span>
    <Button
      variant="ghost"
      size="dense"
      :disabled="loading"
      data-testid="load-more-history"
      class="h-6 rounded-full px-2 text-accent hover:bg-accent-soft hover:text-accent-hover"
      @click="emit('load')"
    >
      <Loader2 v-if="loading" class="size-3 animate-spin" />
      <ChevronUp v-else class="size-3" />
      {{ loading ? t('panel.message.loadingMore') : t('panel.message.loadEarlier') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronUp, History, Loader2 } from '@lucide/vue'
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
