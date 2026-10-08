<!--
  ComposerCapacityBar —— composer 顶缘容量细条（ui-optimize 决策 6 / N7）。

  形态：贴 composer-box 顶缘的 2px 全宽横条（父容器须 relative——composer-box 已带），
  rounded-t-lg 跟随容器顶部圆角；常态 accent 半透明（bg-accent-soft）、>80% bg-warn、
  >95% bg-danger（分档纯函数 capacityBarClass，阈值刻意后移于浮层卡内 bar，见该函数注释）。

  信息纪律：细条只给「余量将尽」的色阶预警，不显数字——精确读数（used / percent）唯一
  入口 = 指标聚合按钮 hover 聚合页（ContextCapacityCard），决策 6「数字仍在 hover 聚合」。

  契约：props = { sessionId?: string }，无 emits。数据纯读（useContextUsage 分区，
  订阅/恢复腿/0 帧哨兵全在 composable）；contextWindow 未知（total=0）或无真值时不渲染
  （无百分比可分档，渲染无意义的 accent 空条反而像「永远安全」的假信号）。

  为什么独立成组件：① Composer.vue script 已贴 300 行硬门禁；② 细条带 useContextUsage
  恢复腿（getContext RPC）——独立组件让 Composer mount 族测试可经 composerChildStubs
  stub 掉，不把 RPC 依赖泄进所有 Composer 级用例（panel 子组件 stub 的既有范式）。
-->
<template>
  <div
    v-if="hasPercent"
    data-testid="composer-capacity-bar"
    role="img"
    class="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] rounded-t-lg transition-[background-color]"
    :class="capacityBarClass(usage.percent)"
    :aria-label="t('panel.context.capacityBarHint', { percent: usage.percent })"
  />
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useContextUsage } from '@/composables/features/model/useContextUsage'
import { capacityBarClass } from './context-usage-display'

const props = defineProps<{
  /** session 分区键 + 恢复腿触发源（useContextUsage 分区范式，组件纯读） */
  sessionId?: string
}>()

const { t } = useI18n()

const { current: usage } = useContextUsage(toRef(props, 'sessionId'))

/** contextWindow 已知（provider 未配 contextWindow 时 total=0：无百分比不分档，不渲染） */
const hasPercent = computed(() => usage.value.status === 'ok' && usage.value.total > 0)
</script>
