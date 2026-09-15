<template>
  <!--
    变更集卡（ADR-0024 D6，flow-2 §状态机·变更集卡）。
    5 态状态机：accumulating / ready / partially-reviewed / resolved / superseded。
    runtime 推 accumulating/ready（事实态），前端用户交互驱动 partially-reviewed/resolved/superseded（审查态）。

    渲染：折叠卡（header 计数 + 状态指示 + 展开文件列表，A/M/D badge + 行数）。
    默认收起——用户点击 header 展开，展开后点击文件行在 SideDrawer detail tab 查看 diff。
  -->
  <div v-if="fileChanges.length > 0" class="change-set-card bg-surface rounded-card" data-testid="change-set-card">
    <!-- header：点击折叠/展开 -->
    <div
      class="flex cursor-pointer select-none items-center gap-2 px-3 py-2"
      data-testid="change-set-header"
      @click="toggleCollapsed"
    >
      <ChevronRight class="size-3 shrink-0 text-neutral-mid transition-transform" :class="collapsed ? '' : 'rotate-90'" />
      <FileEdit class="size-3.5 shrink-0 text-info" />
      <span class="text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ t('panel.changeset.title') }}</span>
      <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[length:var(--text-2xs)] text-neutral-dim">{{ fileChanges.length }}</span>
      <!-- 状态 badge -->
      <span class="rounded-sm px-1.5 py-0.5 text-[length:var(--text-2xs)]" :class="statusClass">{{ statusLabel }}</span>
      <!-- 行数汇总 -->
      <span v-if="totalAdd > 0 || totalDel > 0" class="ml-auto flex items-center gap-1.5 text-[length:var(--text-2xs)] tabular-nums">
        <span class="text-success">+{{ totalAdd }}</span>
        <span class="text-danger">-{{ totalDel }}</span>
      </span>
    </div>

    <!-- 展开详情：文件清单（点击行 → SideDrawer detail tab 查看 diff） -->
    <div v-if="!collapsed" class="border-t border-border">
      <div
        v-for="c in fileChanges"
        :key="c.filePath"
        class="group/cs-file flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[length:var(--text-sm)] transition-colors hover:bg-surface-hover"
        data-testid="change-set-file"
        :title="t('panel.changeset.viewDiff', { path: c.filePath })"
        @click="onClickFile(c.filePath)"
      >
        <span class="shrink-0 rounded-sm px-1 py-0.5 font-mono text-[length:var(--text-2xs)] font-semibold" :class="changeBadgeClass(c.status)">{{ changeLabel(c.status) }}</span>
        <span class="flex-1 truncate font-mono text-neutral-fg">{{ c.filePath }}</span>
        <ExternalLink class="size-3 shrink-0 text-neutral-dim opacity-0 transition-opacity group-hover/cs-file:opacity-100 group-focus-within/cs-file:opacity-100" />
        <span v-if="c.addLines !== undefined || c.delLines !== undefined" class="shrink-0 flex items-center gap-1 text-[length:var(--text-2xs)] tabular-nums">
          <span v-if="c.addLines !== undefined" class="text-success">+{{ c.addLines }}</span>
          <span v-if="c.delLines !== undefined" class="text-danger">-{{ c.delLines }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, ExternalLink, FileEdit } from '@lucide/vue'
import type { FileChange, ChangeSetStatus } from '@taiji/shared'
import { useChatViewDeps } from './chat-view-deps'

const { t } = useI18n()

const props = defineProps<{
  fileChanges: FileChange[]
  status?: ChangeSetStatus
  /** 当前 session id（点击文件行打开 drawer detail diff 用） */
  sessionId: string
}>()

/**
 * 默认收起。用 userToggled 跟踪用户是否手动操作过——
 * status prop 变化（accumulating→ready）时不干扰用户已设的折叠态。
 */
const collapsed = ref(true)
const userToggled = ref(false)

function toggleCollapsed(): void {
  userToggled.value = true
  collapsed.value = !collapsed.value
}

/** 状态 badge 文案（响应式：status 变化时重算） */
const statusLabel = computed(() => resolveStatusLabel(props.status))
const statusClass = computed(() => resolveStatusClass(props.status))

function resolveStatusLabel(status: ChangeSetStatus | undefined): string {
  switch (status) {
    case 'accumulating': return t('panel.changeset.generating')
    case 'ready': return t('panel.changeset.pendingReview')
    case 'partially-reviewed': return t('panel.changeset.partiallyReviewed')
    case 'resolved': return t('panel.changeset.resolved')
    case 'superseded': return t('panel.changeset.superseded')
    default: return t('panel.changeset.pendingReview')
  }
}
function resolveStatusClass(status: ChangeSetStatus | undefined): string {
  switch (status) {
    case 'accumulating': return 'bg-accent-soft text-accent'
    case 'ready': return 'bg-info-soft text-info'
    case 'partially-reviewed': return 'bg-warn-soft text-warn'
    case 'resolved': return 'bg-success-soft text-success'
    case 'superseded': return 'bg-surface text-neutral-dim'
    default: return 'bg-info-soft text-info'
  }
}

/** 行数汇总（所有文件的 addLines/delLines 之和） */
const totalAdd = computed(() =>
  props.fileChanges.reduce((sum, c) => sum + (c.addLines ?? 0), 0),
)
const totalDel = computed(() =>
  props.fileChanges.reduce((sum, c) => sum + (c.delLines ?? 0), 0),
)

/** 单文件变更状态 badge（A/M/D/U） */
function changeLabel(status: FileChange['status']): string {
  return { added: 'A', modified: 'M', deleted: 'D', unmerged: 'U' }[status]
}
function changeBadgeClass(status: FileChange['status']): string {
  return {
    added: 'bg-success-soft text-success',
    modified: 'bg-info-soft text-info',
    deleted: 'bg-danger-soft text-danger',
    unmerged: 'bg-danger/20 text-danger ring-1 ring-danger/40',
  }[status]
}

/** 点击文件行 → 打开 SideDrawer detail tab，强制 diff 模式展示该文件 */
const { openDrawer } = useChatViewDeps()
function onClickFile(filePath: string): void {
  openDrawer('detail', { filePath })
}
</script>
