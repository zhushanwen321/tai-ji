<!--
  ContextUsageRing —— 上下文容量环形进度图标（2026-10-19 用户裁决）。

  背景：指标聚合按钮原用 lucide Gauge（拱门形），用户误读为「被裁切的不完整圆」。
  改为环形进度：底环偏透明恒在（轨道语义，回答「这是个完整的环」），占用弧按
  usagePercent 从顶部顺时针填充，颜色三档语义色（<70 success 绿 / 70–90 warn 黄 /
  >90 danger 红，阈值与 usageBarClass 的 USAGE_HIGH_THRESHOLD/DANGER 分档一致）。

  数据：useContextUsage per-session 分区纯读（与 ContextCapacityCard 同源同模式，
  恢复路径 RPC 有模块级 in-flight 去重，不产生第二份请求）；无值/未知态只渲染
  中性底环（不误导为 0%），继承按钮文字色（hover 提亮仍生效）。
-->
<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    :class="toneClass"
    aria-hidden="true"
    data-testid="context-usage-ring"
  >
    <!-- 底环（轨道恒在，偏透明；stroke-opacity 属性而非颜色硬编码） -->
    <circle cx="12" cy="12" :r="RADIUS" stroke="currentColor" :stroke-width="STROKE_WIDTH" stroke-opacity="0.25" />
    <!-- 占用弧（从顶部顺时针；round 端帽；0% 不渲染——round cap 会画出假弧点） -->
    <circle
      v-if="arcLength > 0"
      cx="12"
      cy="12"
      :r="RADIUS"
      stroke="currentColor"
      :stroke-width="STROKE_WIDTH"
      stroke-linecap="round"
      :stroke-dasharray="`${arcLength} ${CIRCUMFERENCE}`"
      transform="rotate(-90 12 12)"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useContextUsage } from '@/composables/features/model/useContextUsage'
import { USAGE_DANGER_THRESHOLD, USAGE_HIGH_THRESHOLD } from './context-usage-display'

/** 环几何（24 viewBox 基准）：16px 显示下 stroke 3 → 约 2px 环粗 */
const RADIUS = 9
const STROKE_WIDTH = 3
// eslint-disable-next-line no-magic-numbers -- 圆周公式 2πr 的常数 2（数学常数，非领域数值）
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** 百分比刻度（usagePercent 0..100 → 弧长比例） */
const PERCENT_SCALE = 100

const props = defineProps<{
  /** session 分区键（useContextUsage 纯读；缺省 = 无数据中性环） */
  sessionId?: string
}>()

const { current: usage } = useContextUsage(toRef(props, 'sessionId'))

/** 与 ContextCapacityCard.hasPercent 同判据：有真值且 contextWindow 已知 */
const hasPercent = computed(() => usage.value.status === 'ok' && usage.value.total > 0)

const clampedPercent = computed(() => Math.min(Math.max(usage.value.percent, 0), PERCENT_SCALE))
const arcLength = computed(() =>
  hasPercent.value ? (clampedPercent.value / PERCENT_SCALE) * CIRCUMFERENCE : 0,
)

/** 三档语义色（分档阈值与 usageBarClass 同源单点）；无数据不加色 → 继承按钮文字色 */
const toneClass = computed(() => {
  if (!hasPercent.value) return undefined
  if (usage.value.percent > USAGE_DANGER_THRESHOLD) return 'text-danger'
  if (usage.value.percent > USAGE_HIGH_THRESHOLD) return 'text-warn'
  return 'text-success'
})
</script>
