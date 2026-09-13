<script setup lang="ts">
/**
 * SubagentFilterBar —— Agents tab 二级筛选槽（全部活跃 / 只看正在跑 / 已收起）。
 *
 * 设计来源：docs/design/subagent-sidebar-filter.md §3.4（方案 A 迷你分段槽，T2）；
 * 永久会话模型 §3.2.8 默认可见性翻转（U8b）：默认视图 = 全部活跃会话
 * （running + idle），「已收起」视图承载归档寻回（场景 3）。
 *
 * 纯展示组件：三视图计数与选中值全部来自 props，点击只上抛 update:modelValue——
 * 分桶 / 过滤业务逻辑归调用方（SubagentList，经 subagent-bucket SSOT 模块派生），
 * 本组件不持有任何状态、不做任何 SubagentRecord 判定。
 *
 * 视觉照搬凹陷槽范式（实体先例 SegmentedTab / packages/ui L2TabBar）：外槽
 * bg-bg-input 凹陷底 + active bg-bg-elevated 中性浮起；inactive hover 只提亮
 * 文字不加底色（hover:bg-transparent 覆盖 ghost 变体的 hover:bg-surface-hover，
 * 凹陷槽内加底色会显脏——SegmentedTab 同源注释）。
 */
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SubagentFilterValue } from '@/lib/subagent-bucket'

defineProps<{
  /** 三视图计数（调用方经 subagent-bucket 的 countSubagents 派生传入） */
  counts: { active: number; running: number; archived: number }
  /** 当前选中视图（v-model） */
  modelValue: SubagentFilterValue
}>()

const emit = defineEmits<{
  'update:modelValue': [value: SubagentFilterValue]
}>()

const { t } = useI18n()

/** 三视图元数据：id 驱动 testid / i18n key / 计数取值，顺序 = 渲染顺序 */
const FILTER_ITEMS: ReadonlyArray<{ id: SubagentFilterValue }> = [
  { id: 'active' },
  { id: 'running' },
  { id: 'archived' },
]
</script>

<template>
  <div
    data-testid="subagent-filter-bar"
    class="mx-1.5 my-1 flex gap-[2px] rounded-[6px] bg-bg-input p-[2px]"
  >
    <Button
      v-for="item in FILTER_ITEMS"
      :key="item.id"
      variant="ghost"
      :data-testid="`subagent-filter-${item.id}`"
      :data-active="modelValue === item.id ? 'true' : 'false'"
      :class="cn(
        'h-6 flex-1 justify-center gap-[3px] rounded-[4px] px-1 text-xs font-normal',
        modelValue === item.id
          ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated hover:text-neutral-fg'
          : 'text-neutral-dim hover:bg-transparent hover:text-neutral-fg',
      )"
      @click="emit('update:modelValue', item.id)"
    >
      <span class="leading-none">{{ t(`sidebar.subagentFilter.${item.id}`) }}</span>
      <span
        :data-testid="`subagent-filter-count-${item.id}`"
        :class="cn(
          'font-mono text-[length:var(--text-3xs)] leading-none',
          modelValue === item.id ? 'text-neutral-mid' : 'text-neutral-dim',
        )"
      >{{ counts[item.id] }}</span>
    </Button>
  </div>
</template>
