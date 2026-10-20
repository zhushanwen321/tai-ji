<!--
  ArchiveSummaryView —— 归档摘要视图（session-archive 设计 D11，主区 B2）。

  挂载方（归档列表视图，u-renderer-entry）点击归档行后以本组件呈现：props 收
  config.archives 元素（ArchiveSummary DTO，staging/archived 两态）+ projectName
  （按 projectId 解析的原项目名）；[恢复完整会话] 钮只 emit restore，恢复编排
  （RPC 调用 / 侧栏切回 / 主区回 chat / 列表刷新）在挂载方。

  结构（D11）：
  - banner：[已归档] pill + 会话名 + 原项目/压缩信息 meta + 双 tab + accent 恢复钮
  - 摘要流（用户摘要 tab）：右浮用户气泡 + 左侧 agent 文本块，720px 居中
    （content-col 原语，同对话流规范）。气泡/正文为静态纯文本渲染（摘要数据无
    segments/消息 id，不复用 live 会话的 UserBubble/MarkdownRenderer——两者硬耦合
    ChatViewDeps 注入与编辑/撤回机器，只读归档视图语义不适用；视觉类族同款复刻）。
  - agent 引用视图 tab：mono 呈现 session_read 返回形态（formatArchiveAgentReference，
    用户预检 agent 将看到什么）。
  - 占位规则：turn 无 agent 文本 / 纯图片 user 空串 / staging 全区「摘要生成中」。
-->
<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="archive-summary-view">
    <!-- banner：pill + 名称 + 原项目/压缩信息 + 双 tab（staging 隐藏——无内容可切）+ 恢复钮 -->
    <header class="shrink-0 border-b border-hairline bg-surface" data-testid="archive-summary-banner">
      <div class="content-col flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3">
        <span
          class="shrink-0 rounded-sm border border-hairline px-1.5 py-0.5 font-mono text-[length:var(--text-2xs)] leading-none text-neutral-dim"
          data-testid="archive-archived-pill"
        >{{ t('archive.summary.archivedPill') }}</span>
        <h2
          class="min-w-0 shrink truncate text-[length:var(--text-base)] [font-weight:var(--fw-mid)] text-neutral-fg"
          data-testid="archive-summary-name"
        >{{ displayName }}</h2>
        <span
          class="min-w-0 shrink truncate font-mono text-[length:var(--text-xs)] text-neutral-dim"
          data-testid="archive-summary-meta"
        >{{ bannerMeta }}</span>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <div
            v-if="isArchived"
            class="flex gap-[2px] rounded-sm border border-hairline bg-bg-input p-[2px]"
            role="tablist"
            :aria-label="t('archive.summary.tablistLabel')"
            data-testid="archive-summary-tablist"
          >
            <Button
              v-for="tab in tabs"
              :key="tab.value"
              variant="ghost"
              role="tab"
              :aria-selected="activeTab === tab.value"
              :title="tab.label"
              :class="cn(
                'h-[24px] justify-center rounded-[var(--radius-xs)] px-2 text-[length:var(--text-xs)]',
                activeTab === tab.value
                  ? 'bg-[var(--sel-bg)] text-neutral-fg [font-weight:var(--fw-mid)] shadow-[inset_0_0_0_1px_var(--sel-edge)] hover:bg-[var(--sel-bg)] hover:text-neutral-fg'
                  : 'bg-transparent text-neutral-dim hover:bg-transparent hover:text-neutral-fg',
              )"
              :data-testid="`archive-summary-tab-${tab.value}`"
              @click="activeTab = tab.value"
            >
              {{ tab.label }}
            </Button>
          </div>
          <Button
            size="sm"
            class="h-8 gap-1.5"
            data-testid="archive-restore-button"
            @click="emit('restore')"
          >
            <RotateCcw class="size-3.5" />
            {{ t('archive.summary.restore') }}
          </Button>
        </div>
      </div>
    </header>

    <!-- 内容区：staging 全区占位 / 双 tab 内容（720px content-col 居中） -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <!-- staging：全区「摘要生成中」占位（后台压缩完成事件由挂载方刷新数据驱动重渲染） -->
      <div
        v-if="!isArchived"
        class="flex h-full flex-col items-center justify-center gap-1.5"
        data-testid="archive-summary-staging"
      >
        <span class="text-[length:var(--text-md)] text-neutral-mid">{{ t('archive.summary.generating') }}</span>
        <span class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('archive.summary.generatingHint') }}</span>
      </div>

      <template v-else>
        <!-- 用户摘要 tab：右浮用户气泡 + 左侧 agent 文本块（逐 turn；轮节奏同对话流 gap-[12px] + 轮边界 20px） -->
        <div
          v-if="activeTab === 'user'"
          class="content-col flex flex-col px-5 py-6"
          data-testid="archive-summary-flow"
        >
          <div
            v-for="(turn, i) in turns"
            :key="i"
            class="flex flex-col gap-[12px]"
            :class="i === turns.length - 1 ? '' : 'pb-5'"
            :data-testid="`archive-summary-turn-${i}`"
          >
            <!-- 用户气泡（右浮；纯图片/附件消息空串 → 占位文案） -->
            <div class="flex justify-end" :data-testid="`archive-summary-turn-${i}-user`">
              <div
                class="max-w-[min(72%,64ch)] min-w-0 rounded-lg border border-hairline bg-[var(--bubble-bg)] px-[15px] py-[10px] text-[length:var(--text-md)] leading-[1.7] text-neutral-fg [overflow-wrap:anywhere] whitespace-pre-wrap"
              >{{ turn.user.length > 0 ? turn.user : t('archive.summary.userAttachment') }}</div>
            </div>
            <!-- agent 文本块（左侧；turn 以工具调用结束无文本 → 占位文案） -->
            <div class="flex min-w-0 flex-col gap-1" :data-testid="`archive-summary-turn-${i}-agent`">
              <span class="font-mono text-[length:var(--text-2xs)] text-neutral-dim">{{ t('archive.summary.agentLabel') }}</span>
              <div
                v-if="turn.agent !== null"
                class="min-w-0 text-[length:var(--text-md)] leading-[1.8] text-neutral-fg [overflow-wrap:anywhere] whitespace-pre-wrap"
                :data-testid="`archive-summary-turn-${i}-agent-text`"
              >{{ turn.agent }}</div>
              <div
                v-else
                class="min-w-0 text-[length:var(--text-sm)] leading-[1.8] text-neutral-dim [overflow-wrap:anywhere]"
                :data-testid="`archive-summary-turn-${i}-agent-placeholder`"
              >{{ t('archive.summary.turnNoAgentText') }}</div>
            </div>
          </div>
          <!-- 空摘要（turns 为空数组的合法簿记形态） -->
          <div v-if="turns.length === 0" class="py-6 text-center text-[length:var(--text-sm)] text-neutral-dim" data-testid="archive-summary-empty">
            {{ t('archive.summary.empty') }}
          </div>
        </div>

        <!-- agent 引用视图 tab：mono 呈现 session_read 返回形态（预检 agent 将看到什么） -->
        <pre
          v-else
          class="content-col min-w-0 px-5 py-6 font-mono text-[length:var(--text-sm)] leading-[1.8] text-neutral-fg [overflow-wrap:anywhere] whitespace-pre-wrap"
          data-testid="archive-agent-reference"
        >{{ agentReference }}</pre>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw } from '@lucide/vue'
import type { ArchiveSummary } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatArchiveAgentReference } from './agent-reference-format'

const props = defineProps<{
  /** 归档条目（config.archives 元素；status 判别 staging/archived 两态） */
  archive: ArchiveSummary
  /**
   * 原项目显示名：挂载方按 archive.projectId 经 project store 解析后传入
   * （未解析 / 无归属 / 未命名默认项目传 undefined——banner 省略该段）。
   */
  projectName?: string
}>()

const emit = defineEmits<{
  /** [恢复完整会话] accent 钮点击（staging 态恢复合法——统一冲突检测含 staging，设计 V6） */
  restore: []
}>()

const { t } = useI18n()

/** banner 双 tab 定义（D11：用户摘要 / agent 引用视图）。 */
type SummaryTab = 'user' | 'agent'
const tabs = computed<{ value: SummaryTab; label: string }[]>(() => [
  { value: 'user', label: t('archive.summary.tabUserSummary') },
  { value: 'agent', label: t('archive.summary.tabAgentReference') },
])

const activeTab = ref<SummaryTab>('user')

const isArchived = computed(() => props.archive.status === 'archived')
const turns = computed(() => (props.archive.status === 'archived' ? props.archive.summary.turns : []))

/** 会话名（name 空串 = 提取失败的合法簿记形态 → 未命名占位）。 */
const displayName = computed(() =>
  props.archive.name.length > 0 ? props.archive.name : t('archive.summary.unnamed'),
)

/**
 * agent 引用视图正文（session_read 返回形态，纯函数预检）：staging 态内容区由全区
 * 占位接替（模板 v-if），此处不求值——空串仅为类型完整性兜底，不会渲染。
 */
const agentReference = computed(() =>
  props.archive.status === 'archived' ? formatArchiveAgentReference(props.archive) : '',
)

/** banner 原项目/压缩信息 meta（archived：`原项目：X · 12.4 MB → 2.5 MB · -80%`；staging：`… · 压缩中`）。 */
const bannerMeta = computed(() => {
  const parts: string[] = []
  if (props.projectName && props.projectName.length > 0) {
    parts.push(t('archive.summary.originalProject', { name: props.projectName }))
  }
  parts.push(
    props.archive.status === 'archived'
      ? formatCompression(props.archive)
      : t('archive.summary.compressing'),
  )
  return parts.join(' · ')
})

/** 文件大小人类可读（B/KB/MB 一位小数——ImportSessionDialog.formatSize 同款口径，组件域内复制）。 */
const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB

function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}

/** 百分比换算基数（no-magic-numbers：命名常量承载） */
const PCT_SCALE = 100

/** 压缩信息（D10 行结构同款格式 `12.4 MB → 2.5 MB · -80%`；rawBytes 0 防除零省略百分比段）。 */
function formatCompression(archive: Extract<ArchiveSummary, { status: 'archived' }>): string {
  const base = `${formatSize(archive.rawBytes)} → ${formatSize(archive.compressedBytes)}`
  if (archive.rawBytes <= 0) return base
  const pct = Math.round((1 - archive.compressedBytes / archive.rawBytes) * PCT_SCALE)
  if (pct <= 0) return base
  return `${base} · -${pct}%`
}
</script>
