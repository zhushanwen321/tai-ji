<template>
  <!--
    展示组件 · segmented 视图切换 tab（demo .vtab 形态）。
    文字 tab：3 tab 等宽均分（flex-1），label 直出；第 3 个 plugins 为挂载点占位
    （无 plugin 贡献时 ViewHost 空态自隐藏，见下方 tabs 定义）。
    容器 = 凹陷槽（bg-surface ← demo --card）+ hairline 描边 + rounded-sm(6px) + p-[2px]；
    按钮 h-6 / 12px 字 / dim / radius-xs；选中态 = demo Tier A 状态件选中范式
    （--sel-bg accent tint 底 + 中性亮字 + fw-mid + 1px --sel-edge 内描边）。
    inactive hover 只提亮文字（text-neutral-fg），不加底色——凹陷槽内加底色会显脏。
    [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab（Agents/Flows 退役，任务观察入口唯一化收口到
    composer 任务托盘）——subagent/workflow 计数不再经侧栏。
    [HISTORICAL] icon-only + count 数字形态随 demo .vtab 文字 tab 对齐退役（2026-10 M1 视觉复刻）：
    sessionCount/fileCount props 保留（Sidebar 传参契约不动），组件内不再渲染。
  -->
  <div class="mx-3 mt-1 mb-2 flex gap-[2px] rounded-sm border border-hairline bg-surface p-[2px]">
    <Button
      v-for="tab in tabs"
      :key="tab.value"
      variant="ghost"
      :title="tab.label"
      :class="cn(
        'h-6 flex-1 justify-center rounded-[var(--radius-xs)] px-1 text-[length:var(--text-xs)]',
        modelValue === tab.value
          ? 'bg-[var(--sel-bg)] text-neutral-fg [font-weight:var(--fw-mid)] shadow-[inset_0_0_0_1px_var(--sel-edge)] hover:bg-[var(--sel-bg)] hover:text-neutral-fg'
          : 'bg-transparent text-neutral-dim hover:bg-transparent hover:text-neutral-fg',
      )"
      @click="emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SidebarTab } from '@/stores/sidebar'

const { t } = useI18n()

// 计数 props 保留外部契约（Sidebar 传参不动）；文字 tab 形态下组件内不渲染（见模板头注释）。
defineProps<{
  modelValue: SidebarTab
  /** 全局会话计数（非归档口径，全局作用域，不随焦点 session 变化） */
  sessionCount: number
  /** 当前焦点 session 根层文件数（目录计入，不递归） */
  fileCount: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: SidebarTab]
}>()

interface TabDef {
  value: SidebarTab
  label: string
}

/**
 * tabs 静态定义：plugins 无 plugin 贡献时 ViewHost 空态自隐藏，tab 仅作挂载点占位。
 */
const tabs = computed<TabDef[]>(() => [
  { value: 'sessions', label: t('sidebar.segmentedTab.session') },
  { value: 'files', label: t('sidebar.segmentedTab.file') },
  // ExtensionHost sidebar view 宿主（MountPointRegistry sidebar.tab，W4 接线）。
  { value: 'plugins', label: t('sidebar.segmentedTab.plugin') },
])
</script>
