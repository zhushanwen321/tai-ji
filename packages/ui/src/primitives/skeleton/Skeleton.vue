<script setup lang="ts">
/**
 * Skeleton —— 加载占位胶囊条（remote-use-mobile-v2 §6.9 / spec §6.9）。
 *
 * 规格：胶囊条形（rounded-full）+ 1.4s 扫光；仅 >300ms 的等待使用（消费方纪律，
 * 本原语不计时）。尺寸经 class 由消费方给定（首屏列表 = 4 行胶囊条的行高/宽度
 * 属屏级布局，不是原语契约）。
 */
import { cn } from '../../lib/utils'

const props = withDefaults(defineProps<{ class?: string }>(), { class: '' })
</script>

<template>
  <span
    :class="cn('relative block overflow-hidden rounded-full bg-surface-2', props.class)"
    aria-hidden="true"
    data-testid="skeleton"
  >
    <span class="skeleton-sweep absolute inset-0" />
  </span>
</template>

<style scoped>
/* 扫光：透明 → fg 8% 弱亮 → 透明，translateX 掠过。escape hatch：keyframes +
   background-clip 渐变组合，Tailwind 无法表达。reduced-motion 停帧（静止弱亮块）。 */
.skeleton-sweep {
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in oklch, var(--neutral-fg) 8%, transparent),
    transparent
  );
  transform: translateX(-100%);
  animation: skeleton-shimmer 1.4s var(--ease) infinite;
}

@keyframes skeleton-shimmer {
  100% {
    transform: translateX(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-sweep {
    animation: none;
    transform: none;
  }
}
</style>
