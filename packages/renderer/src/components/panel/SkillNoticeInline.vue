<template>
  <!--
    展示组件 · skill 注入提示行（composer-multi-skill-injection u5，场景 2③/2b②/3②）。
    渲染在锚点 turn 之后（消息内联，按 clientUuid 定位），单行轻量形态：
    - 降级类（variant=degrade，D6 标记模式注入）：中性色 Info 图标——信息性提示非告警
    - 失效类（variant=invalid，D8 透传+可见）：warn 色 AlertTriangle——需用户行动的信号
    宽度对齐对话流内容列（content-col 原语，ForkNotice/SystemNotice 同体系）；
    无卡片底色（轻量提示，区别于 ForkNotice 的 info-soft 反馈卡）。
    文案单一来源 useSkillNoticeStream.skillNoticeText（toast 与内联共用，i18n 禁硬编码）。
  -->
  <div
    class="content-col flex min-w-0 items-center gap-1.5 py-0.5"
    data-testid="skill-notice-inline"
    :data-variant="variant"
  >
    <component :is="icon" class="size-3 shrink-0" :class="iconClass" />
    <!-- truncate 截断后全文经原生 title 可达（C5 降级文案补恢复动作后变长） -->
    <span
      class="min-w-0 truncate text-[length:var(--text-xs)] leading-snug"
      :class="variant === 'invalid' ? 'text-warn' : 'text-neutral-mid'"
      :title="text"
    >
      {{ text }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DeepReadonly } from 'vue'
import { AlertTriangle, Info } from '@lucide/vue'
import {
  isDegradeReason,
  skillNoticeText,
  type SkillNoticeEntry,
} from '@/composables/panel/useSkillNoticeStream'

const props = defineProps<{
  /** 渲染层只读消费（分区内的 mutable 原型不经 props 外泄）。 */
  entry: DeepReadonly<SkillNoticeEntry>
}>()

/** 提示形态：降级（信息性，中性色）vs 失效（需行动，warn 色）——判定单一来源 isDegradeReason。 */
const variant = computed(() => (isDegradeReason(props.entry.reason) ? 'degrade' : 'invalid'))

const icon = computed(() => (variant.value === 'invalid' ? AlertTriangle : Info))

const iconClass = computed(() => (variant.value === 'invalid' ? 'text-warn' : 'text-neutral-mid'))

const text = computed(() => skillNoticeText(props.entry))
</script>
