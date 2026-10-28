<script setup lang="ts">
/**
 * InlineNotice —— 行内反馈条（remote-use-mobile-v2 §6.9 / spec §6.8）。
 *
 * 规格：soft 底 + 语义图标 + 一句话（原因 + 下一步）。错误（danger）常驻可重试
 * （重试等动作用户行动经默认插槽由消费方放按钮，本原语不内置动作语义）；
 * 成功的停留时长由调用方决定；不做全局 toast。role：danger = alert（打断读屏），
 * 其余 = status（播报不打断）。
 *
 * demo 版的 closable 关闭钮不进本原语：spec §6.8 要素表无关闭钮（反馈条的
 * 退出 = 状态本身消失，不是用户手排），且内置按钮文案会引入壳层 locale 依赖。
 */
import { computed, type Component } from 'vue'
import { CircleCheck, Info, TriangleAlert, WifiOff } from '@lucide/vue'

export type InlineNoticeTone = 'neutral' | 'success' | 'warn' | 'danger' | 'offline'

const props = withDefaults(
  defineProps<{
    /** 语义档（配色 + 图标 + role 三联动） */
    tone?: InlineNoticeTone
    /** 一句话（原因 + 下一步） */
    text: string
  }>(),
  { tone: 'neutral' },
)

const icon = computed<Component>(() => {
  switch (props.tone) {
    case 'success':
      return CircleCheck
    case 'warn':
    case 'danger':
      return TriangleAlert
    case 'offline':
      return WifiOff
    default:
      return Info
  }
})

const toneClass = computed(() => {
  switch (props.tone) {
    case 'success':
      return 'bg-success-soft text-success'
    case 'warn':
      return 'bg-warn-soft text-warn'
    case 'danger':
      return 'bg-danger-soft text-[color:var(--danger-text)]'
    case 'offline':
      return 'bg-warn-soft text-warn'
    default:
      return 'bg-surface text-neutral-mid'
  }
})
</script>

<template>
  <div
    class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-[length:var(--m-text-sub)]"
    :class="toneClass"
    :role="tone === 'danger' ? 'alert' : 'status'"
    data-testid="inline-notice"
  >
    <component :is="icon" class="mt-0.5 size-4 shrink-0" :stroke-width="1.8" aria-hidden="true" />
    <p class="min-w-0 flex-1 text-pretty leading-[1.5]" data-testid="inline-notice-text">{{ text }}</p>
    <div v-if="$slots.default" class="flex shrink-0 items-center" data-testid="inline-notice-action">
      <slot />
    </div>
  </div>
</template>
