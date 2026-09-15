<template>
  <!--
    展示组件 · segmented 视图切换 tab（v6-master-spec §5.3）。
    icon-only 模式：5 tab 等宽均分（flex-1），只显示 icon，label 收进 title；
    第 5 个 plugins 为挂载点占位（无 plugin 贡献时 ViewHost 空态自隐藏，见下方 tabs 定义）；
    图标右侧渲染 count 数字（count > 0 才渲染，0 不出数字；sidebar-tab-count-restore 设计 §3.1/决策 4）。
    外层凹陷容器 bg-bg-input + rounded-lg + p-[3px]；active = bg-bg-elevated 中性浮起（去蓝染）。
    inactive hover 只提亮文字（text-neutral-fg），不加底色——凹陷槽内加底色会显脏（demo SegmentedTab 同源）。
  -->
  <div class="mx-1 mb-1 flex gap-0.5 rounded-lg bg-bg-input p-[3px]">
    <Button
      v-for="tab in tabs"
      :key="tab.value"
      variant="ghost"
      :title="tab.label"
      :class="cn(
        'relative h-7 flex-1 justify-center gap-1 rounded-sm px-1',
        modelValue === tab.value
          ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated hover:text-neutral-fg'
          : 'text-neutral-mid hover:bg-transparent hover:text-neutral-fg',
      )"
      @click="emit('update:modelValue', tab.value)"
    >
      <component :is="tab.icon" class="size-[15px] shrink-0" />
      <span v-if="tab.count > 0" class="text-[length:var(--text-3xs)] text-neutral-mid">{{ tab.count }}</span>
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { MessageSquare, File, Bot, Workflow, Puzzle } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SidebarTab } from '@/stores/sidebar'

const { t } = useI18n()

const props = defineProps<{
  modelValue: SidebarTab
  /** 全局会话计数（非归档口径，全局作用域，不随焦点 session 变化） */
  sessionCount: number
  /** 当前焦点 session 根层文件数（目录计入，不递归） */
  fileCount: number
  /** 进行中 subagent 数（非结束口径，D8 active 桶同源） */
  subagentRunningCount: number
  /** 进行中 workflow 数（running/paused） */
  workflowRunningCount: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: SidebarTab]
}>()

interface TabDef {
  value: SidebarTab
  label: string
  icon: Component
  count: number
}

/**
 * tabs 静态定义：count 为 0 不渲染数字（决策 4，避免一排 0 的噪音）。
 * 计数 SSOT 在 useSidebarCounts（与 SubagentList/WorkflowList 列表同源，不穿帮）。
 */
const tabs = computed<TabDef[]>(() => [
  { value: 'sessions', label: t('sidebar.segmentedTab.session'), icon: MessageSquare, count: props.sessionCount },
  { value: 'files', label: t('sidebar.segmentedTab.file'), icon: File, count: props.fileCount },
  { value: 'subagents', label: t('sidebar.segmentedTab.subagent'), icon: Bot, count: props.subagentRunningCount },
  { value: 'workflows', label: t('sidebar.segmentedTab.workflow'), icon: Workflow, count: props.workflowRunningCount },
  // ExtensionHost sidebar view 宿主（MountPointRegistry sidebar.tab，W4 接线）。
  // 无 plugin 贡献时 ViewHost 空态自隐藏，tab 仅作挂载点占位（count 不适用，恒 0）。
  { value: 'plugins', label: t('sidebar.segmentedTab.plugin'), icon: Puzzle, count: 0 },
])
</script>
