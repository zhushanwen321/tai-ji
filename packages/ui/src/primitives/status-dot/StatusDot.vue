<script setup lang="ts">
/**
 * StatusDot —— 移动端运行时状态色点（remote-use-mobile-v2 §6.9 / spec §6.5）。
 *
 * 规格：8px 圆点，状态 → 语义色映射（spec §6.5 字面）：
 * 进行族（streaming/pending/compacting/working）= accent + 脉冲；
 * 等待族（waiting/retrying）= warn；error = danger；done = success；
 * stopped = dim；dead = faint。
 *
 * 颜色之外必须配文案（列表行尾 pill 或页头状态行），纯点消费时经 label prop
 * 提供 aria-label（spec §6.5「无文字的纯点必须带 aria-label」——颜色单通道
 * 不承载语义，读屏走 label）。
 *
 * 脉冲动效用 scoped keyframes 自包含（不依赖壳层 tailwind animation 注册——
 * 原语被双壳 tailwind content 扫描，animation 简写类只在使用方 config 定义了
 * keyframes 时才生成规则；scoped 内声明则任何宿主都完整生效）。
 * reduced-motion 停帧（恒 accent 静态点，语义不丢失）。
 */
import { cn } from '../../lib/utils'

/** 状态词表（spec §6.5 全集）：壳层按自身状态派生（9 态 / SubagentStatus 两态）映射到本词表 */
export type StatusDotStatus =
  | 'streaming'
  | 'pending'
  | 'compacting'
  | 'working'
  | 'waiting'
  | 'retrying'
  | 'error'
  | 'done'
  | 'stopped'
  | 'dead'

withDefaults(
  defineProps<{
    status: StatusDotStatus
    /** 无文字纯点消费时的读屏文案（aria-label；配文案使用时仍建议传） */
    label?: string
    /** sm = 6px（次级行），缺省 8px（spec 主行档） */
    size?: 'sm' | 'md'
  }>(),
  { label: undefined, size: 'md' },
)

/** 状态 → 语义色映射表（spec §6.5 字面；Record 全键对照，新增状态词先过本表防静默漏值）：
 * 进行族（streaming/pending/compacting/working）= accent + 脉冲类；等待族 = warn；
 * error = danger；done = success；stopped = dim；dead = faint */
const STATUS_TONE_CLASS: Record<StatusDotStatus, string> = {
  streaming: 'bg-accent status-dot--pulse',
  pending: 'bg-accent status-dot--pulse',
  compacting: 'bg-accent status-dot--pulse',
  working: 'bg-accent status-dot--pulse',
  waiting: 'bg-warn',
  retrying: 'bg-warn',
  error: 'bg-danger',
  done: 'bg-success',
  stopped: 'bg-neutral-dim',
  dead: 'bg-neutral-faint',
}
</script>

<template>
  <span
    class="inline-block shrink-0 rounded-full"
    :class="cn(STATUS_TONE_CLASS[status], size === 'sm' ? 'size-1.5' : 'size-2')"
    :aria-label="label"
    :role="label ? 'img' : undefined"
  />
</template>

<style scoped>
/* accent 进行族脉冲（呼吸缩放，2s 循环）：与桌面 pulse-dot 同节奏的 scoped 自包含副本。
   escape hatch：keyframes + reduced-motion 降级，Tailwind 无法表达停帧条件。 */
.status-dot--pulse {
  animation: status-dot-pulse 2s ease-in-out infinite;
}
@keyframes status-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .status-dot--pulse {
    animation: none;
  }
}
</style>
