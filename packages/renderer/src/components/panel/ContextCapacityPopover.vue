<template>
  <!--
    §2a 上下文容量 popover + coding-plan 额度（draft-composer-states §2a + merged-card）。
    hover 触发，触发器 = 上下文容量环形进度图标（ContextUsageRing，2026-10-19 用户裁决：
    展开态与聚合态统一形态——原「69K · 6.9%」文本摘要位由环形可视化承接，百分比进环形
    三档语义色，绝对用量进浮层容量卡）。

    [HISTORICAL] `variant`（simplified/iconic）中间态已随 W3b 删除——聚合形态由
    ComposerMetricsAggregate（单图标聚合页）承担；浮层内容拆为 ContextCapacityCard
    （原触发器与聚合页共挂，删重复渲染）。
    coding-plan 区逻辑在 useQuotaDisplay（卡内展示 + 本触发器 hover-enter 查询，
    store 全局共享同源收敛）。
  -->
  <HoverCard>
    <HoverCardTrigger as-child>
      <Button
        variant="ghost"
        class="h-7 w-7 rounded-[var(--radius-xs)] p-0 text-neutral-dim transition-colors hover:bg-transparent hover:text-neutral-fg"
        :title="t('panel.context.capacity')"
        @mouseenter="onHoverEnter"
      >
        <ContextUsageRing :session-id="props.sessionId" class="size-[16px]" />
      </Button>
    </HoverCardTrigger>
    <!-- 右下锚（demo .stats-pop：right:0 + bottom:calc(100%+10px)）——align="end" 右对齐
         触发钮、side-offset 10px 锚距（reka 默认 center/6px 与 demo 不符） -->
    <HoverCardContent
      side="top"
      align="end"
      :side-offset="10"
      class="w-[248px] p-0"
    >
      <ContextCapacityCard :session-id="props.sessionId" :model-id="props.modelId" />
    </HoverCardContent>
  </HoverCard>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useQuotaDisplay } from '@/composables/features/model/useQuotaDisplay'
import ContextCapacityCard from './ContextCapacityCard.vue'
import ContextUsageRing from './ContextUsageRing.vue'

const { t } = useI18n()

const props = defineProps<{
  /** session 分区键（ContextUsageRing 分区纯读；恢复路径 RPC 有模块级 in-flight 去重） */
  sessionId?: string
  /**
   * 当前复合 modelId（"provider/modelId"），受控 prop，由 Composer 下发。
   * landing 态由 Composer 经 useComposerModelThinking 兜底链（currentModel > lastUsedModel）fallback 到 defaultModel。
   * 用于推导 provider（split('/')[0]）查 quota——不在子组件内自查 sessionStore，
   * 对齐 ModelSelectPopover/ThinkingLevelPopover 的受控范式。
   */
  modelId?: string
}>()
// [HISTORICAL] `variant` prop 已删（W3b）：对外 props 恒为 sessionId / modelId。

// ── hover-enter 额度查询（展示逻辑在 ContextCapacityCard，查询触发留触发器）──
const { onHoverEnter } = useQuotaDisplay(toRef(props, 'modelId'))
</script>
