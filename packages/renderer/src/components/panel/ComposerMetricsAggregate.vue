<!--
  ComposerMetricsAggregate —— composer 底栏「指标」聚合入口（三步聚合序：指标 → 左簇 → 模型+思考，
  累计退化；容量 + TTFT + 速度 + 缓存 四项指标收为单图标按钮）。

  形态硬约束（S1–S7）：
  - 聚合按钮**单一图标**（ContextUsageRing 上下文容量环形进度，2026-10-19 用户裁决——
    原 Gauge 拱形图标被误读为「被裁切的不完整圆」），禁多 icon 重叠；几何对齐 demo .cbtn
    （30×30 / r-sm / dim → hover surface-hover 底 + fg 提字，workbench.css composer 段）；
  - 指标聚合 = **hover** 弹指标聚合页（HoverCard）——与模型聚合的 click 语义区分；
    容器对齐 demo .stats-pop（右下锚 10px 间距 / r-lg / border-strong / shadow-2）；
  - 内容 = 四张纯内容卡纵向拼装（ContextCapacityCard + GenStatsTtftCard + GenStatsSpeedCard
    + GenStatsCacheCard），卡间发丝分隔（对齐 demo .ag-seg 相邻边框 hairline 档：
    h-px bg-[color:var(--hairline)] 局部定义，不 import 接线层常量）；四卡共享
    useGenStats / useContextUsage 分区，数据同源。

  契约：props = { sessionId: string; modelId?: string }，无 emits。
  quota 的 hover-enter 查询挂在 HoverCardTrigger 上——查询触发属「hover 指标入口」这一
  交互侧；store 全局共享，与卡内展示实例同源。
-->
<template>
  <HoverCard>
    <HoverCardTrigger as-child>
      <!-- 钮形态对齐 demo .cbtn（workbench.css composer 段）：30×30 / r-sm / dim，hover
           surface-hover 底 + fg 提字；Gauge 16px stroke 1.6 同 demo 图标规格 -->
      <Button
        variant="ghost"
        data-testid="composer-metrics-aggregate"
        class="size-[30px] rounded-sm p-0 text-neutral-dim transition-colors hover:text-neutral-fg"
        :title="t('panel.context.metricsAggregateTitle')"
        @mouseenter="quota.onHoverEnter"
      >
        <!-- 图标 = 上下文容量环形进度（2026-10-19 用户裁决：Gauge 拱形易误读为裁切圆；
             环形即容量即时可视化，hover 聚合页行为不变） -->
        <ContextUsageRing :session-id="props.sessionId" class="size-[16px] shrink-0" />
      </Button>
    </HoverCardTrigger>
    <!-- 容器对齐 demo .stats-pop：右下锚 + 10px 间距 + r-lg 圆角；宽 340 承载速度/TTFT
         两卡的 5 统计量分布矩阵（2026-10-24：矩阵 5 列 + 行头共 6 列，300px 下每格
         40px 会把「1.2s」挤成换行；demo 240 是四行 sr 形态的宽，登记差异） -->
    <HoverCardContent side="top" align="end" :side-offset="10" class="w-[340px] rounded-lg p-0">
      <ContextCapacityCard :session-id="props.sessionId" :model-id="props.modelId" />
      <span class="block h-px bg-[color:var(--hairline)]" aria-hidden="true" />
      <GenStatsTtftCard :session-id="props.sessionId" :model-id="props.modelId" />
      <span class="block h-px bg-[color:var(--hairline)]" aria-hidden="true" />
      <GenStatsSpeedCard :session-id="props.sessionId" :model-id="props.modelId" />
      <span class="block h-px bg-[color:var(--hairline)]" aria-hidden="true" />
      <GenStatsCacheCard :session-id="props.sessionId" :model-id="props.modelId" />
    </HoverCardContent>
  </HoverCard>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useQuotaDisplay } from '@/composables/features/model/useQuotaDisplay'
import ContextUsageRing from './ContextUsageRing.vue'
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
