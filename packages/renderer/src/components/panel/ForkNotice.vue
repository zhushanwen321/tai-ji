<template>
  <!--
    展示组件 · Fork 反馈行（FR-12，spec §3）。
    fork 成功后在主线对话流插一条 transient 反馈行（非 banner，遵循架构约定 #3）。

    规范（2026-08-19 收敛到 v6 卡片语言，通知族二分裁决见 v6-master-spec.md §6.1）：
    - 容器：info-soft 单手段分隔（无 border，v6「Card 去 border 走 bg 层级」）+ radius + px-3 py-1.5
    - 宽度：mx-auto max-w content-max-w，与对话流内容列对齐（Turn/SystemNotice 同体系）
    - 图标：GitFork（info 色）
    - 文案：「已 fork 到后台 · [分支名]」或「已在新分支提问 · [预览]」（label 单行 truncate）
    - 查看链接：accent 色 + hover 下划线（无 hover 底色，避免卡片内嵌卡片）
    - 关闭 ×：24px 命中区，subtle 色 + hover fg
    - 动效：notice-in 200ms（从 -4px translateY 淡入），motion-reduce 关闭

    降级：sessionDeleted=true 时分支已删，「查看」降级为纯文本不可点（spec §4 Key States）。
    用 xyz-ui Button 组件，禁止原生 HTML 表单元素（关闭/查看均走 Button）。
  -->
  <div class="fork-notice content-col flex items-center gap-2 rounded-[var(--radius)] bg-info-soft px-3 py-1.5 animate-notice-in motion-reduce:animate-none">
    <GitFork class="size-3.5 shrink-0 text-info" />
    <span class="min-w-0 flex-1 truncate text-[length:var(--text-sm)] leading-snug text-neutral-fg">
      {{ prefix }}<span v-if="label" class="font-[550]">{{ label }}</span>
    </span>
    <!-- 查看链接：sessionDeleted 时降级为纯文本 span（不可点，无交互语义） -->
    <!-- [P4] 文案区分：有 preview（fork-ask）→ viewBranch（"查看分支"）；纯 fork → view（"查看"）。 -->
    <Button
      v-if="!sessionDeleted"
      variant="ghost"
      size="sm"
      class="h-auto shrink-0 p-0 text-[length:var(--text-sm)] text-accent underline-offset-2 hover:bg-transparent hover:text-accent-hover hover:underline"
      data-testid="fork-notice-view"
      @click="emit('view')"
    >
      {{ t(viewLabelKey) }}
    </Button>
    <span
      v-else
      class="shrink-0 text-[length:var(--text-sm)] text-neutral-dim"
      data-testid="fork-notice-view"
    >
      {{ t(viewLabelKey) }}
    </span>
    <!-- 关闭 × -->
    <Button
      variant="ghost"
      size="icon"
      class="size-6 shrink-0 text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
      :title="t('panel.forkNotice.dismiss')"
      @click="emit('dismiss')"
    >
      <X class="size-3" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitFork, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { BranchChangeKind } from '@/composables/features/fork-handoff/useForkBranchNotify'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    /** 分支名（纯后台 fork）或提问预览（fork-ask）。无则只显示前缀文案。 */
    branchName?: string
    /** fork-ask 的提问预览（优先于 branchName 展示）。 */
    preview?: string
    /** 后台分支状态变化语义（RV2）：done/error/stopped 时前缀展示分支状态文案。 */
    kind?: BranchChangeKind
    /** 源分支是否已删除——true 时「查看」降级为纯文本不可点（spec §4）。 */
    sessionDeleted?: boolean
  }>(),
  { sessionDeleted: false },
)

const emit = defineEmits<{
  /** 点击「查看」：跳转到分支 session（仅 sessionDeleted=false 时触发）。 */
  view: []
  /** 点击关闭 ×：移除反馈行。 */
  dismiss: []
}>()

/** 前缀文案：kind 优先（分支状态变化）→ preview（fork-ask）→ fork 后台文案。 */
const prefix = computed(() => {
  switch (props.kind) {
    case 'done':
      return t('panel.forkNotice.branchDone')
    case 'error':
      return t('panel.forkNotice.branchError')
    case 'stopped':
      return t('panel.forkNotice.branchStopped')
    default:
      return props.preview
        ? t('panel.forkNotice.askedPrefix')
        : t('panel.forkNotice.forkedPrefix')
  }
})

/** 加粗展示的分支名 / 提问预览。 */
const label = computed(() => props.preview || props.branchName || '')

/**
 * 查看链接文案 i18n key（P4）。
 * 有 preview（fork-ask）→ viewBranch（"查看分支"）；纯 fork（无 preview）→ view（"查看"）。
 */
const viewLabelKey = computed(() =>
  props.preview ? 'panel.forkNotice.viewBranch' : 'panel.forkNotice.view',
)
</script>
