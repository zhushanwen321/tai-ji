<!--
  ComposerMetricsAggregate —— composer 底栏「指标」聚合入口（W3a 三步聚合：左簇 → 指标 → 模型+思考，
  累计退化；指标档把 容量 + TTFT + 速度 + 缓存 四个数值触发器收为单图标按钮）。

  形态硬约束（S1–S7）：
  - 聚合按钮**单一图标**（Gauge），禁多 icon 重叠；
  - 指标聚合 = **hover** 弹指标聚合页（HoverCard）——与模型聚合的 click 语义区分；
  - 内容 = 四张纯内容卡纵向拼装（ContextCapacityCard + GenStatsTtftCard + GenStatsSpeedCard
    + GenStatsCacheCard），卡间发丝分隔（token 工具类 h-px bg-border-strong 局部定义，不
    import 接线层常量）；四卡共享 useGenStats / useContextUsage 分区，与原触发器同源收敛。

  契约：props = { sessionId: string; modelId?: string }，无 emits。
  quota 的 hover-enter 查询挂在本触发器上（与原容量触发器同语义——查询触发属「hover 指标 chip」
  这一交互面；store 全局共享，与卡内展示实例同源收敛）。
-->
<template>
  <HoverCard>
    <HoverCardTrigger as-child>
      <Button
        variant="ghost"
        data-testid="composer-metrics-aggregate"
        class="h-7 gap-1 rounded-sm px-1.5 text-neutral-dim transition-colors hover:text-neutral-mid"
        :title="t('panel.context.metricsAggregateTitle')"
        @mouseenter="quota.onHoverEnter"
      >
        <Gauge class="size-4 shrink-0" />
      </Button>
    </HoverCardTrigger>
    <HoverCardContent side="top" class="w-[300px] p-0">
      <ContextCapacityCard :session-id="props.sessionId" :model-id="props.modelId" />
      <span class="block h-px bg-border-strong" aria-hidden="true" />
      <GenStatsTtftCard :session-id="props.sessionId" :model-id="props.modelId" />
      <span class="block h-px bg-border-strong" aria-hidden="true" />
      <GenStatsSpeedCard :session-id="props.sessionId" :model-id="props.modelId" />
      <span class="block h-px bg-border-strong" aria-hidden="true" />
      <GenStatsCacheCard :session-id="props.sessionId" :model-id="props.modelId" />
    </HoverCardContent>
  </HoverCard>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Gauge } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useQuotaDisplay } from '@/composables/features/model/useQuotaDisplay'
import ContextCapacityCard from './ContextCapacityCard.vue'
import GenStatsTtftCard from './GenStatsTtftCard.vue'
import GenStatsSpeedCard from './GenStatsSpeedCard.vue'
import GenStatsCacheCard from './GenStatsCacheCard.vue'

const props = defineProps<{
  /** 焦点 session id（四卡的分区键；接线方以 v-if 保证非空） */
  sessionId: string
  /** 当前复合 modelId（"provider/modelId"）：容量卡 quota 推导 + genstats 帧校验兜底 */
  modelId?: string
}>()

const { t } = useI18n()

// hover-enter 额度查询（只取 onHoverEnter；展示数据在卡内实例读同一 store）
const quota = useQuotaDisplay(toRef(props, 'modelId'))
</script>
