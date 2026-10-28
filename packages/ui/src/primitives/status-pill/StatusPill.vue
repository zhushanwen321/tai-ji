<script setup lang="ts">
/**
 * StatusPill —— 移动端「需要注意」状态胶囊（remote-use-mobile-v2 §6.9 / spec §6.5）。
 *
 * 规格：22px 高、12px 字（--m-text-cap），只出现六类（spec 字面）：待确认 / 待回答 /
 * 出错 / 重试中 / 后台 / 已退出。六类之外的常态（streaming / done / stopped 等）
 * 不渲染——常态交给状态点与页头状态行，pill 只承载「需要你注意」的异常与后台态。
 *
 * 文案经 label prop 由消费方传入（壳层 i18n 词条）——本原语不放死中文，双壳
 * 双语通用；六类白名单与语义配色是本原语的契约（映射表 type-anchored，防漏值静默）。
 */
import { computed } from 'vue'

/** 状态词表（与 StatusDot 同一全集；pill 只消费其中六类） */
export type StatusPillStatus =
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

interface PillMeta {
  /** 语义配色（soft 底 + 同族可读字色；出错用 --danger-text 提亮过 AA） */
  cls: string
}

const props = defineProps<{
  status: StatusPillStatus
  /** 胶囊文案（消费方 i18n 词条，如「待回答」）；status 命中六类但未传 label 时不渲染 */
  label?: string
}>()

/** 六类白名单 → 配色（spec §6.5；type 键穷尽对照，新增状态词先过本表防静默丢弃） */
const PILL_META: Partial<Record<StatusPillStatus, PillMeta>> = {
  pending: { cls: 'bg-warn-soft text-warn' },
  waiting: { cls: 'bg-warn-soft text-warn' },
  error: { cls: 'bg-danger-soft text-[color:var(--danger-text)]' },
  retrying: { cls: 'bg-warn-soft text-warn' },
  working: { cls: 'bg-accent-soft text-accent' },
  dead: { cls: 'bg-surface-2 text-neutral-mid' },
}

const meta = computed(() => (props.label ? PILL_META[props.status] : undefined))
</script>

<template>
  <span
    v-if="meta"
    class="inline-flex h-[22px] shrink-0 items-center rounded-full px-2 font-medium leading-none text-[length:var(--m-text-cap)]"
    :class="meta.cls"
  >{{ label }}</span>
</template>
