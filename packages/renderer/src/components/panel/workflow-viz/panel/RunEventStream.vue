<template>
  <!--
  RunEventStream —— workflow tab 事件流子页（设计 §3.1-2：record 事件原文，类型着色，
  大字段按 D4 截断规则显示 + truncatedFields 标注；错误二分 = record_not_found 静态指引
  无重试 vs 暂时错误重试按钮；oversize 降级 = record 文件超 32MB 读取上限、events 恒空
  + oversize 标志的第三态，RT-4#8「不可用 ≠ 无数据」同款分形）。数据源 = workflowStore
  事件流缓存（与 Gantt 子页共享同一份拉取，§3.1-2）；刷新链 = workflowUpdate 信号
  （store 内聚合 force 重拉），本组件零订阅。
  -->
  <div class="flex min-w-0 flex-1 flex-col overflow-hidden" data-testid="wf-viz-event-stream">
    <!-- 加载态 -->
    <div v-if="entry?.status === 'loading'" class="flex flex-1 items-center justify-center" data-testid="wf-viz-events-loading">
      <Loader2 class="size-5 animate-spin text-neutral-dim opacity-60" />
    </div>
    <!-- 错误二分（§3.1-2 降级路径）：record_not_found = 静态指引无重试；通道错误 = 重试按钮 -->
    <div v-else-if="entry?.status === 'error'" class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="wf-viz-events-error">
      <AlertCircle class="size-6 text-danger opacity-60" />
      <p class="text-[length:var(--text-xs)] text-neutral-fg">
        {{ entry.errorCode === 'record_not_found' ? t('panel.workflowViz.eventsNotFound') : t('panel.workflowViz.eventsLoadFailed') }}
      </p>
      <p class="max-w-[420px] text-[length:var(--text-2xs)] leading-relaxed text-neutral-dim">
        {{ entry.errorCode === 'record_not_found' ? t('panel.workflowViz.eventsNotFoundHint') : entry.errorMessage }}
      </p>
      <!-- 重试按钮仅在通道错误形态出现（record_not_found 重试结果恒同——对齐托盘
           「不可重试给指引」分形语言）；点击后 status 翻 loading → 分支切走按钮消失
           （构造性防重复点击），store 层在途合并双保险 -->
      <Button
        v-if="entry.errorCode !== 'record_not_found'"
        variant="ghost"
        size="sm"
        data-testid="wf-viz-events-retry"
        @click="onRetry"
      >
        <RotateCcw class="mr-1 size-3" />
        {{ t('panel.workflowViz.retry') }}
      </Button>
    </div>
    <!-- oversize 降级（RT-4#8 同款分形：record 文件超 32MB 读取上限——「不可用」非
         「无数据」，无重试（重拉结果恒同）） -->
    <div v-else-if="entry?.oversize" class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="wf-viz-events-oversize">
      <AlertCircle class="size-6 text-neutral-dim opacity-60" />
      <p class="text-[length:var(--text-xs)] text-neutral-fg">{{ t('panel.workflowViz.eventsOversize') }}</p>
      <p class="max-w-[420px] text-[length:var(--text-2xs)] leading-relaxed text-neutral-dim">{{ t('panel.workflowViz.eventsOversizeHint') }}</p>
    </div>
    <!-- 空事件流（ready + 零行：record 未落首帧窗口） -->
    <div v-else-if="!entry || !entry.events || entry.events.length === 0" class="flex flex-1 items-center justify-center" data-testid="wf-viz-events-empty">
      <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.workflowViz.eventsEmpty') }}</p>
    </div>
    <!-- 事件行列表 -->
    <div v-else class="flex min-h-0 flex-1 flex-col overflow-y-auto py-1" data-testid="wf-viz-events-list">
      <div
        v-for="row of rows"
        :key="row.key"
        class="border-b border-hairline px-3 py-1.5 text-[length:var(--text-2xs)] last:border-b-0"
        :data-testid="`wf-viz-event-${row.entry.type}`"
      >
        <div class="flex items-center gap-2">
          <span class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-faint">{{ row.timeText }}</span>
          <span class="shrink-0 rounded-sm border border-hairline px-1 font-mono text-[length:var(--text-3xs)]" :class="row.typeClass">
            {{ row.entry.type }}
          </span>
          <span class="min-w-0 flex-1 truncate font-mono text-neutral-mid" :title="row.summary">{{ row.summary }}</span>
          <!-- truncatedFields 标注（D4）：被截断大字段逐个列出（Scissors 图标 + title 防误用
               边界说明） -->
          <span
            v-if="row.truncatedKeys.length > 0"
            class="flex shrink-0 items-center gap-0.5 rounded-sm bg-surface-2 px-1 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
            :title="t('panel.workflowViz.truncatedHint', { fields: row.truncatedKeys.join(', ') })"
            data-testid="wf-viz-event-truncated"
          >
            <Scissors class="size-2.5 shrink-0" aria-hidden="true" />
            {{ row.truncatedKeys.join(', ') }}
          </span>
        </div>
        <!-- 大字段截断文本（展示原样前缀；禁 parse 消费——展示面语义） -->
        <p
          v-if="row.detail"
          class="mt-0.5 break-all pl-1 font-mono text-[length:var(--text-3xs)] leading-relaxed text-neutral-faint"
        >{{ row.detail }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Loader2, RotateCcw, Scissors } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowRunEventEntry } from '@taiji/shared'

const props = defineProps<{
  sessionId: string
  runId: string
}>()

const { t } = useI18n()
const store = useWorkflowStore()

/** 事件流缓存读（响应式——与 Gantt 子页共享同一份拉取/缓存分区）。 */
const entry = computed(() => store.runEventsOf(props.runId))

/** 重试 = force 重新拉取（store loading 在途合并 + 按钮 disabled 双保险防重复点击）。 */
function onRetry(): void {
  void store.loadWorkflowRunEvents(props.sessionId, props.runId, { force: true })
}

interface EventRowView {
  key: string
  entry: WorkflowRunEventEntry
  timeText: string
  typeClass: string
  summary: string
  /** 大字段截断文本（input/result/scriptSource/args 的展示值——截断形态原样前缀）。 */
  detail?: string
  truncatedKeys: string[]
}

/** 类型着色：转移帧 accent / agent 帧 neutral / 故障与重试 danger / 诊断 log faint。 */
function typeClassOf(type: WorkflowRunEventEntry['type']): string {
  switch (type) {
    case 'run-created':
    case 'phase-started':
    case 'phase-settled':
    case 'run-resumed':
    case 'run-settled':
      return 'text-accent'
    case 'agent-started':
    case 'agent-settled':
      return 'text-neutral-mid'
    case 'agent-retrying':
    case 'run-interrupted':
      return 'text-danger'
    case 'worker-log':
      return 'text-neutral-faint'
    default: {
      const exhaustive: never = type
      throw new Error(`unreachable event type: ${String(exhaustive)}`)
    }
  }
}

function timeTextOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 摘要可选后缀拼接：缺省/空串不追加，非空加「 · 」前缀。 */
function suffixOf(part: string | undefined): string {
  return part ? ` · ${part}` : ''
}

/** 单行摘要文案（骨架字段拼接；大字段不进摘要行——detail 区承载）。 */
function summaryOf(e: WorkflowRunEventEntry): string {
  switch (e.type) {
    case 'run-created':
      // argsSummary 经 suffixOf 空值省略：存量 run-created 行缺该字段时（读侧回退
      // 空串）不渲染悬空「 · 」或字面 undefined——与 agent-started 分支同款拼接。
      return `${e.workflowName}${suffixOf(e.argsSummary)}`
    case 'phase-started':
    case 'phase-settled':
      return e.phase
    case 'agent-started':
      return `#${e.taskIndex} ${e.agentName} · ${t('panel.workflowViz.attemptLabel')} ${e.attempt}${suffixOf(e.phase)}`
    case 'agent-retrying':
      return `#${e.taskIndex} ${t('panel.workflowViz.attemptLabel')} ${e.attempt} · +${e.backoffMs}ms · ${e.reason}`
    case 'agent-settled':
      return `#${e.taskIndex} ${e.outcome} · ${e.durationMs}ms${suffixOf(e.errorCode)}`
    case 'run-interrupted':
      return `${e.errorCode ?? ''}${suffixOf(e.reason)}`
    case 'run-resumed':
      return e.reason ?? ''
    case 'run-settled':
      return `${e.outcome}${suffixOf(e.reason)}`
    case 'worker-log':
      return e.entry.message
    default: {
      const exhaustive: never = e
      throw new Error(`unreachable event entry: ${String(exhaustive)}`)
    }
  }
}

/** 大字段截断文本提取（D4 截断白名单四字段的展示值——判别联合逐 type 显式读取，无断言）。 */
function detailOf(e: WorkflowRunEventEntry): string | undefined {
  switch (e.type) {
    case 'agent-started':
      return e.input
    case 'agent-settled':
      return e.result
    case 'run-created':
      return e.scriptSource ?? e.args
    default:
      return undefined
  }
}

const rows = computed<EventRowView[]>(() =>
  (entry.value?.events ?? []).map((e, i) => ({
    key: `${e.seq ?? i}-${e.type}`,
    entry: e,
    timeText: timeTextOf(e.ts),
    typeClass: typeClassOf(e.type),
    summary: summaryOf(e),
    detail: detailOf(e),
    truncatedKeys: e.truncatedFields ?? [],
  })),
)
</script>
