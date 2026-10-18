<!--
  ComposerCapacityBar —— composer 顶缘容量细条（ui-optimize 决策 6 / N7）。

  形态：贴 composer-box 顶缘的 2px 全宽横条（父容器须 relative——composer-box 已带），
  rounded-t-lg 跟随容器顶部圆角；内层填充条宽度 = 已用百分比（demo .capbar > i 结构）。
  仅告警显示（spec R2.3 / demo ComposerBar v-else-if contextPct>80）：≤80% 不渲染
  （常态无细条——accent 常驻稀释告警语义，违背 accent 稀缺原则），>80% bg-warn、
  >95% bg-danger 才出现（分档纯函数 capacityBarClass，阈值刻意后移于浮层卡内 bar）。

  信息纪律：细条只给「余量将尽」的色阶预警，不显数字——精确读数（used / percent）唯一
  入口 = 指标聚合按钮 hover 聚合页（ContextCapacityCard），决策 6「数字仍在 hover 聚合」。

  契约：props = { sessionId?: string }，无 emits。数据纯读（useContextUsage 分区，
  订阅/恢复路径/0 帧哨兵全在 composable）；contextWindow 未知（total=0）、无真值或 ≤80%
  不渲染（无百分比可分档或未达告警档——常态渲染细条反而像「永远有事」的假信号）。

  为什么独立成组件：① Composer.vue script 已贴 300 行硬门禁；② 细条带 useContextUsage
  恢复路径（getContext RPC）——独立组件让 Composer mount 族测试可经 composerChildStubs
  stub 掉，不把 RPC 依赖泄进所有 Composer 级用例（panel 子组件 stub 的既有范式）。
-->
<template>
  <!-- 结构对齐 demo .capbar（workbench.css composer 段）：外层全宽轨道（overflow-hidden +
       上缘圆角）+ 内层填充条（width = percent%，height 100%）——细条同时给「余量将尽」
       色阶与已用比例，数字仍在 hover 指标聚合页。仅告警态渲染（>80%，与
       capacityBarClass 的 warn 阈值同源常量）。 -->
  <div
    v-if="hasPercent && usage.percent > CAPACITY_BAR_WARN_THRESHOLD"
    data-testid="composer-capacity-bar"
    role="img"
    class="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] overflow-hidden rounded-t-lg"
    :aria-label="t('panel.context.capacityBarHint', { percent: usage.percent })"
  >
    <span
      class="block h-full transition-[background-color]"
      :class="capacityBarClass(usage.percent)"
      :style="{ width: usage.percent + '%' }"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useContextUsage } from '@/composables/features/model/useContextUsage'
import { capacityBarClass, CAPACITY_BAR_WARN_THRESHOLD } from './context-usage-display'

const props = defineProps<{
  /** session 分区键 + 恢复路径触发源（useContextUsage 分区范式，组件纯读） */
  sessionId?: string
}>()

const { t } = useI18n()

const { current: usage } = useContextUsage(toRef(props, 'sessionId'))

/** contextWindow 已知（provider 未配 contextWindow 时 total=0：无百分比不分档，不渲染） */
const hasPercent = computed(() => usage.value.status === 'ok' && usage.value.total > 0)
</script>
