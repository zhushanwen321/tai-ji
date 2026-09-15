<script setup lang="ts">
/**
 * 进度条组件（v6）——fill 柔化 + 推断 done 中性化。
 * 显式 severity（ok/warn/danger）→ 对应色 color-mix(55%) 柔化；
 * 推断 severity（未传）→ ratio≥0.8 推断为 done，用 neutral-dim（已完成弱化视觉权重），
 * ratio≥0.5 warn 柔化，<0.5 danger 柔化。
 * track/fill 圆角 rounded-sm（6px，对齐 v6 --radius-sm），高度 6px。
 *
 * fill 背景色含 color-mix 表达式，通过 CSS 变量 --progress-fill 传递
 * （自定义属性值原样存储，绕过 DOM 环境 CSS 解析对 color-mix 的过滤；
 * 实际渲染由 [background:var(--progress-fill)] class 应用）。
 */
import { computed } from 'vue'

const props = defineProps<{
  label?: string
  current: number
  total: number
  unit?: string
  severity?: 'ok' | 'warn' | 'danger'
}>()

/** severity 自动推断阈值（ratio = current/total） */
const SEVERITY_THRESHOLD_OK = 0.8
const SEVERITY_THRESHOLD_WARN = 0.5
const PERCENT_MULTIPLIER = 100
/** fill 柔化比例（对齐 v6 --bar-fill-soft token） */
const BAR_FILL_SOFT = 'var(--bar-fill-soft)'

const ratio = computed(() => (props.total > 0 ? props.current / props.total : 0))
const percent = computed(() => `${(ratio.value * PERCENT_MULTIPLIER).toFixed(1)}%`)

/** v6：fill 背景色。显式 severity→color-mix 柔化；推断 ok(ratio≥0.8)→neutral-dim(done 语义) */
const fillBackground = computed(() => {
  if (props.severity === 'ok') return `color-mix(in oklch, var(--success) ${BAR_FILL_SOFT}, transparent)`
  if (props.severity === 'warn') return `color-mix(in oklch, var(--warn) ${BAR_FILL_SOFT}, transparent)`
  if (props.severity === 'danger') return `color-mix(in oklch, var(--danger) ${BAR_FILL_SOFT}, transparent)`
  // 推断
  if (ratio.value >= SEVERITY_THRESHOLD_OK) return 'var(--neutral-dim)'
  if (ratio.value >= SEVERITY_THRESHOLD_WARN) return `color-mix(in oklch, var(--warn) ${BAR_FILL_SOFT}, transparent)`
  return `color-mix(in oklch, var(--danger) ${BAR_FILL_SOFT}, transparent)`
})

const fillStyle = computed(() => ({
  width: percent.value,
  '--progress-fill': fillBackground.value,
}))
</script>

<template>
  <div class="progress-bar flex flex-col gap-1.5 font-mono text-[length:var(--text-sm)]" data-testid="gui-progress-bar">
    <div class="flex items-center justify-between">
      <span v-if="label" class="text-neutral-mid">{{ label }}</span>
      <span class="font-medium tabular-nums text-neutral-fg">
        {{ current }}<span class="text-neutral-dim"> / {{ total }}{{ unit ? ` ${unit}` : '' }}</span>
      </span>
    </div>
    <div class="progress-bar__track h-1.5 overflow-hidden rounded-sm bg-bg-input">
      <div
        class="progress-bar__fill h-full rounded-sm transition-[width] duration-300 [background:var(--progress-fill)]"
        :style="fillStyle"
      />
    </div>
  </div>
</template>
