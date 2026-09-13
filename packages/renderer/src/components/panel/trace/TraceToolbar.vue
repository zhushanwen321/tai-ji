<template>
  <!--
    展示组件 · trace-toolbar（session-trace §3.1 样例 3：chips + 搜索 + 仅当前 context + 状态行）。
    - 状态行：entries 总数 / 当前 context 内数量 / 压缩次数 / system prompt 当前版本
      （§3.1 终态图；计数从 rows 派生，tabular-nums 对齐）。
    - kind chips：分组映射 SSOT = core TRACE_KIND_GROUPS（禁散落第二份）。「全部」= 无
      chips 激活（白名单语义，MALFORMED 仅全部态可见）。
    - 搜索：文本过滤（demo 行为：不匹配隐藏）。Input（xyz-ui）+ v-model 转发。
    - context toggle：xyz-ui Switch（禁原生 HTML 表单元素）。
  -->
  <!-- pl-4 对齐轨道线后的 seq 列起点（线在 8px + 边框 1px + 行 px-2 8px ≈ 17px） -->
  <div class="flex flex-shrink-0 flex-col gap-1.5 pl-4 pr-2 pb-2 pt-1">
    <!-- 状态行 -->
    <div
      class="flex flex-wrap items-center gap-2 font-mono text-[length:var(--text-2xs)] tabular-nums text-neutral-dim"
      data-testid="trace-stats"
    >
      <span>{{ t('panel.trace.entriesCount', { count: stats.total }) }}</span>
      <span aria-hidden="true" class="text-neutral-faint">·</span>
      <span>{{ t('panel.trace.inContextCount', { count: stats.inContext }) }}</span>
      <span aria-hidden="true" class="text-neutral-faint">·</span>
      <span>{{ t('panel.trace.compactionCount', { count: stats.compactions }) }}</span>
      <span aria-hidden="true" class="text-neutral-faint">·</span>
      <span
        data-testid="trace-stats-prompt"
        :title="stats.promptVersion === null ? t('panel.trace.systemNoTraceHint') : undefined"
      >{{ stats.promptVersion === null ? t('panel.trace.promptNoTrace') : t('panel.trace.promptVersion', { version: stats.promptVersion }) }}</span>
      <!-- SYSTEM 无留痕降级（§3.1）：现取按钮 + 「当前值，非历史」标注。现取通道在常驻
           文件扩展（不随可禁留痕包）；RPC session.fetchCurrentSystemPrompt（仅活跃
           session，错误 code 映射文案）。成功后摘要行内展示（全文由 runtime 广播的
           xyz:current-system-prompt DATA 行承载，点行 inspector 可看）。 -->
      <template v-if="stats.promptVersion === null">
        <Button
          variant="ghost"
          size="sm"
          :disabled="fetching"
          class="h-4 gap-0.5 px-1 text-[length:var(--text-3xs)]"
          data-testid="trace-fetch-current"
          @click="emit('fetch-current')"
        >
          <RefreshCw class="size-2.5" :class="fetching ? 'animate-spin' : ''" />
          {{ t('panel.trace.systemFetchCurrent') }}
        </Button>
        <span
          v-if="fetchErrorMessage !== null"
          class="text-[length:var(--text-3xs)] text-danger"
          data-testid="trace-fetch-current-error"
        >{{ fetchErrorMessage }}</span>
        <template v-else>
          <span
            v-if="currentPrompt !== null"
            class="text-[length:var(--text-3xs)] text-neutral-dim"
            data-testid="trace-fetch-current-result"
          >{{ t('panel.trace.systemFetchedSummary', { count: currentPrompt.charCount, time: fetchedTime }) }}</span>
          <span class="text-[length:var(--text-3xs)] text-neutral-faint" data-testid="trace-fetch-current-note">{{ t('panel.trace.systemCurrentNotHistory') }}</span>
        </template>
      </template>
    </div>
    <!-- 控制行：chips + 搜索 + context toggle -->
    <div class="flex flex-wrap items-center gap-1.5">
      <Button
        v-for="chip in chips"
        :key="chip.key"
        variant="ghost"
        size="sm"
        class="h-5 rounded-full px-2.5 text-[length:var(--text-2xs)]"
        :class="chip.active ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated' : 'text-neutral-dim hover:text-neutral-fg'"
        :data-testid="`trace-chip-${chip.key}`"
        @click="emit('toggle-group', chip.key)"
      >
        {{ chip.label }}<span class="ml-1 font-mono text-[length:var(--text-3xs)] text-neutral-faint">{{ chip.count }}</span>
      </Button>
      <div class="ml-1 flex min-w-[110px] flex-1 items-center gap-1.5 rounded-sm border border-transparent bg-bg-input px-2 py-1 focus-within:border-accent-ring">
        <Search class="size-3 shrink-0 text-neutral-dim" />
        <Input
          v-model="searchModel"
          class="h-4 w-full border-0 bg-transparent px-0 py-0 font-sans text-[length:var(--text-xs)] focus-visible:ring-0"
          type="text"
          :placeholder="t('panel.trace.searchPlaceholder')"
          data-testid="trace-search"
        />
      </div>
      <div
        class="flex cursor-pointer select-none items-center gap-1.5 rounded-sm px-1 py-0.5 text-[length:var(--text-2xs)]"
        :class="contextOnly ? 'text-neutral-fg' : 'text-neutral-dim hover:text-neutral-fg'"
        :title="t('panel.trace.contextOnlyHint')"
        data-testid="trace-context-toggle"
        @click="emit('toggle-context')"
      >
        <!-- 禁用 h-*/w-* 覆盖轨道尺寸（rem 类与 thumb 绝对 px 几何失配 → 圆点溢出轨道），
             缩小视觉尺寸只能等比 scale（taste/no-switch-size-override 护栏）。 -->
        <Switch :model-value="contextOnly" class="scale-90" />
        {{ t('panel.trace.contextOnly') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 工具条。chips 分组 = core TRACE_KIND_GROUPS + 「全部」白名单语义（activeGroups 空 = 全部态）。
 * 计数经 rows 派生（全量口径——demo .tr-chip .n 语义：该组行数，不受当前过滤影响）。
 * 交互事件上抛（toggle-group / toggle-context / update:searchText），写 store 归 TraceView。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, Search } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { TRACE_KIND_GROUPS } from '@xyz-agent/core/domain/session-trace'
import type { TraceKindGroup, TraceRow } from '@xyz-agent/core/domain/session-trace'
import type { TraceCurrentPromptSummary } from '@/composables/features/trace/useSessionTrace'

type ChipKey = 'all' | TraceKindGroup

const props = defineProps<{
  /** 全量 rows（chips/状态行计数口径）。 */
  rows: readonly TraceRow[]
  contextOnly: boolean
  activeGroups: readonly TraceKindGroup[]
  searchText: string
  /** 现取结果摘要（null = 未现取过）。 */
  currentPrompt: TraceCurrentPromptSummary | null
  fetching: boolean
  /** 现取失败 code（null = 无错误）；文案映射见 FETCH_ERROR_KEY。 */
  fetchErrorCode: string | null
}>()

const emit = defineEmits<{
  'toggle-group': [group: ChipKey]
  'toggle-context': []
  'update:searchText': [value: string]
  'fetch-current': []
}>()

const { t } = useI18n()

/** 状态行统计（§3.1：总数 / 当前 context 数 / 压缩数 / prompt 版本）。 */
const stats = computed(() => {
  let inContext = 0
  let compactions = 0
  let promptVersion: number | null = null
  for (const row of props.rows) {
    if (row.inContext) inContext++
    if (row.kind === 'COMPACTED') compactions++
    // system prompt 当前版本 = 最后一条 SYSTEM 留痕（多次留痕后者生效）
    if (row.kind === 'SYSTEM' && typeof row.meta.version === 'number') promptVersion = row.meta.version
  }
  return { total: props.rows.length, inContext, compactions, promptVersion }
})

/** 搜索框 v-model 转发（TraceView 写 store 分区）。 */
const searchModel = computed({
  get: () => props.searchText,
  set: (value: string) => emit('update:searchText', value),
})

/** 现取失败 code → 文案键（runtime 错误 code 三类 + 传输层兜底；session 不活跃是最常见
 *  的用户可见错误——非活跃 session 无 pi 进程，现取无源）。 */
const FETCH_ERROR_KEY: Record<string, string> = {
  session_not_active: 'panel.trace.fetchNotActive',
  session_busy: 'panel.trace.fetchBusy',
  fetch_current_prompt_timeout: 'panel.trace.fetchTimeout',
  timeout: 'panel.trace.fetchTimeout',
  disconnected: 'panel.trace.fetchFailed',
}

/** toTimeString() 前 8 字符 = 'HH:MM:SS'。 */
const HH_MM_SS_END = 8

const fetchErrorMessage = computed<string | null>(() =>
  props.fetchErrorCode === null ? null : t(FETCH_ERROR_KEY[props.fetchErrorCode] ?? 'panel.trace.fetchFailed'),
)

/** fetchedAt（ISO）→ 本地 HH:MM:SS（状态行紧凑展示；解析失败原样展示）。 */
const fetchedTime = computed<string>(() => {
  const iso = props.currentPrompt?.fetchedAt ?? ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // toTimeString() 形如 'HH:MM:SS GMT+0800...'：截前 8 字符即时刻
  return d.toTimeString().slice(0, HH_MM_SS_END)
})

/** chip label 的 i18n 键（分组 SSOT 的 UI 侧标签，键内容收口 trace-i18n）。 */
const CHIP_LABEL_KEY: Record<TraceKindGroup, string> = {
  messages: 'panel.trace.chipMessages',
  tools: 'panel.trace.chipTools',
  system: 'panel.trace.chipSystem',
  lifecycle: 'panel.trace.chipLifecycle',
  boundaries: 'panel.trace.chipBoundaries',
}

/** chips 定义（全部 + 5 分组；计数按 kind 归组行数）。 */
const chips = computed(() => {
  const counts = new Map<TraceKindGroup, number>()
  for (const group of Object.keys(TRACE_KIND_GROUPS) as TraceKindGroup[]) {
    const kinds = new Set<string>(TRACE_KIND_GROUPS[group])
    counts.set(group, props.rows.filter((r) => kinds.has(r.kind)).length)
  }
  return [
    { key: 'all' as const, label: t('panel.trace.chipAll'), count: props.rows.length, active: props.activeGroups.length === 0 },
    ...(Object.keys(TRACE_KIND_GROUPS) as TraceKindGroup[]).map((group) => ({
      key: group,
      label: t(CHIP_LABEL_KEY[group]),
      count: counts.get(group) ?? 0,
      active: props.activeGroups.includes(group),
    })),
  ]
})
</script>
