<!--
  CanvasBindingBadge —— 画布头部的 agent 绑定状态徽标（problem-solve-canvas §3.1(3)）。

  数据源 = 活跃绑定集合（绑定记录 ∩ 存活 session，定义见设计 §3.1(1) 回推节）。
  两态：空集合明示「当前无 agent 在响应」（重启后重绑入口的感知锚——设计 §3.1(1)
  内存态代价②的恢复路径呈现）；非空显示在响应的会话数。

  count=null = 通道未提供（契约缺口：CanvasState 无绑定派生字段，deviations 已申报）——
  不渲染徽标（事实驱动⑨：未知不呈现，不猜「无 agent」误导用户）。
-->
<template>
  <span
    v-if="count !== null"
    class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[length:var(--text-3xs)] font-semibold"
    :class="count > 0
      ? 'border-success bg-success-soft text-success'
      : 'border-warn bg-warn-soft text-warn'"
    :title="title"
    data-testid="canvas-binding-badge"
    :data-binding="count > 0 ? 'active' : 'none'"
  >
    <span class="size-1.5 rounded-full" :class="count > 0 ? 'bg-success' : 'bg-warn'" />
    {{ label }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** 活跃绑定数；null = 绑定通道未接入（不渲染）。 */
  count: number | null
}>()

const { t } = useI18n()

const label = computed(() =>
  props.count !== null && props.count > 0
    ? t('panel.canvas.bindingActive', { n: props.count })
    : t('panel.canvas.bindingNone'),
)

const title = computed(() =>
  props.count !== null && props.count > 0
    ? t('panel.canvas.bindingActiveTitle', { n: props.count })
    : t('panel.canvas.bindingNoneTitle'),
)
</script>
