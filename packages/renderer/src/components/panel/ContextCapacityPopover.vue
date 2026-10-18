<template>
  <!--
    §2a 上下文容量 popover + coding-plan 额度（draft-composer-states §2a + merged-card）。
    hover 触发，按钮文字始终显当前用量摘要（69K · 6.9%），浮层给完整容量。
    触发器两档着色（>70% warn，其余中性；缓存命中率显示在 GenStats 卡/触发器，不在本组件）。

    [HISTORICAL] `variant`（simplified/iconic）中间态已随 W3b 删除——聚合形态由
    ComposerMetricsAggregate（单图标聚合页）承担，本组件恒为 full 文本触发器；
    浮层内容拆为 ContextCapacityCard（原触发器与聚合页共挂，删重复渲染）。
    coding-plan 区逻辑在 useQuotaDisplay（卡内展示 + 本触发器 hover-enter 查询，
    store 全局共享同源收敛）。
  -->
  <HoverCard>
    <HoverCardTrigger as-child>
      <Button
        variant="ghost"
        :class="
          cn(
            'h-7 gap-1 rounded-[var(--radius-xs)] px-2 text-[length:var(--text-2xs)] transition-colors hover:bg-transparent',
            isHigh ? 'text-warn' : 'text-neutral-dim',
          )
        "
        :title="t('panel.context.capacity')"
        @mouseenter="onHoverEnter"
      >
        <span class="tabular-nums">{{ hasUsage ? usedDisplay : '—' }}</span>
        <!-- 只留百分比（绝对用量进 title 与浮层） -->
        <template v-if="hasPercent">
          <!-- 分隔点降档（demo .mchip .mdot opacity .7）：装饰位不吃正文着色档 -->
          <span aria-hidden="true" class="opacity-70">·</span>
          <span class="tabular-nums">{{ usage.percent }}%</span>
        </template>
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
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { useContextUsage } from '@/composables/features/model/useContextUsage'
import { useQuotaDisplay } from '@/composables/features/model/useQuotaDisplay'
import ContextCapacityCard from './ContextCapacityCard.vue'
import { formatTokens, USAGE_HIGH_THRESHOLD } from './context-usage-display'

const { t } = useI18n()

const props = defineProps<{
  /** session 分区键 + 恢复路径触发源（context-consistency D2：用量状态在 useContextUsage 分区，组件纯读） */
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

// ── 上下文用量（context-consistency D2 终态）：per-session 分区纯读 ──
// 订阅/恢复路径/0 帧哨兵全在 composable 内，组件只做 status → 显示映射（卡内同款实例读同一分区）。
const { current: usage } = useContextUsage(toRef(props, 'sessionId'))

// ── hover-enter 额度查询（展示逻辑在 ContextCapacityCard，查询触发留触发器）──
const { onHoverEnter } = useQuotaDisplay(toRef(props, 'modelId'))

const usedDisplay = computed(() => formatTokens(usage.value.used))

/** 有真值（分区 status='ok'）；no-value/unknown → 关键数字显「—」 */
const hasUsage = computed(() => usage.value.status === 'ok')
/** contextWindow 已知（provider 未配 contextWindow 时 total=0：只显用量不显百分比） */
const hasPercent = computed(() => usage.value.status === 'ok' && usage.value.total > 0)

/** 触发器两档着色（>70% warn，其余中性——原 full 形态语义不变） */
const isHigh = computed(() => usage.value.percent > USAGE_HIGH_THRESHOLD)
</script>
