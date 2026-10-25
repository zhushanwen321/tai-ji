<template>
  <!--
    展示组件 · segmented 视图切换 tab（demo .vtab 形态）。
    tablist 范式（spec §3.1）：容器 role=tablist + 钮 role=tab + aria-selected；上下左右
    方向键在 tab 序列间环形移动并立即激活（demo onVtabKey 同款）。
    文字 tab：等宽均分（flex-1），label 直出。数据源 = 容器位注册表派生（§6.1/U8：内置
    三项为注册表初始项，lib/content-slots.ts 登记；插件声明的 sidebar.tab 项并入标签条）。
    第 3 个内置 plugins 为挂载点占位（无 plugin 贡献时 ViewHost 空态自隐藏）。
    容器 = 凹陷槽（bg-surface ← demo --card）+ hairline 描边 + rounded-sm(6px) + p-[2px]；
    按钮 h-[24px] / 12px 字 / dim / radius-xs；选中态 = demo Tier A 状态件选中范式
    （--sel-bg accent tint 底 + 中性亮字 + fw-mid + 1px --sel-edge 内描边）。
    inactive hover 只提亮文字（text-neutral-fg），不加底色——凹陷槽内加底色会显脏。
    [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab（Agents/Flows 退役，任务观察入口唯一化收敛到
    composer 任务托盘）——subagent/workflow 计数不再经侧栏。
    [HISTORICAL] icon-only + count 数字形态随 demo .vtab 文字 tab 对齐退役（2026-10 M1 视觉复刻）：
    sessionCount/fileCount props 保留（Sidebar 传参契约不动），组件内不再渲染。
  -->
  <div
    class="mx-[12px] mt-[4px] mb-[8px] flex gap-[2px] rounded-sm border border-hairline bg-surface p-[2px]"
    role="tablist"
    :aria-label="t('sidebar.segmentedTab.viewLabel')"
    data-testid="sidebar-view-tablist"
    @keydown="onTablistKeydown"
  >
    <Button
      v-for="tab in tabs"
      :key="tab.value"
      variant="ghost"
      role="tab"
      :aria-selected="modelValue === tab.value"
      :title="tab.label"
      :class="cn(
        'h-[24px] flex-1 justify-center rounded-[var(--radius-xs)] px-1 text-[length:var(--text-xs)]',
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
import { slotDisplayLabel, useSidebarTabs } from '@/lib/content-slots'
import type { SidebarTab } from '@/stores/sidebar'

const { t } = useI18n()

// 计数 props 保留外部契约（Sidebar 传参不动）；文字 tab 形态下组件内不渲染（见模板头注释）。
const props = defineProps<{
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
 * tabs 从容器位注册表派生（§6.1 侧栏行）：内置三项（注册表初始项）∪ 插件声明项，
 * value = 注册表条目 id；文案谓词见 slotDisplayLabel（内置走 labelKey，插件走声明原文）。
 */
const sidebarTabs = useSidebarTabs()
const tabs = computed<TabDef[]>(() =>
  sidebarTabs.value.map((view) => ({ value: view.id, label: slotDisplayLabel(view, t) })),
)

/**
 * tablist 方向键环形切换（demo onVtabKey 同款，spec §3.1）：上下左右四键同义——
 * ↓/→ 下一个视图、↑/← 上一个视图，首尾环形；移动即激活（emit update:modelValue）。
 */
function onTablistKeydown(e: KeyboardEvent): void {
  const order = tabs.value.map((tab) => tab.value)
  const i = order.indexOf(props.modelValue)
  if (i < 0) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault()
    emit('update:modelValue', order[(i + 1) % order.length])
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault()
    emit('update:modelValue', order[(i - 1 + order.length) % order.length])
  }
}
</script>
