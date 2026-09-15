<template>
  <!--
    展示组件 · workflow 详情（Flows tab 视图 2）。
    按 phase 分组渲染 agent call 列表。
    点击 agent call → emit('select-agent-call', sessionId)，由父组件切 Panel。
    点击 ← 返回 → emit('back')，回视图 1。
  -->
  <div class="flex h-full min-h-0 flex-col" data-testid="workflow-detail">
    <!-- header：返回按钮 + scriptName + slug -->
    <div class="flex items-center gap-2 px-2 py-2">
      <Button
        variant="ghost"
        size="icon"
        class="size-5 shrink-0 text-neutral-dim hover:text-neutral-fg"
        :title="t('sidebar.workflowDetail.backToList')"
        data-testid="workflow-detail-back"
        @click="emit('back')"
      >
        <ChevronLeft class="size-4" />
      </Button>
      <span class="min-w-0 flex-1 truncate text-[length:var(--text-xs)] font-medium text-neutral-fg">
        {{ workflow.scriptName }}
      </span>
      <span v-if="workflow.slug" class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-mid">
        {{ workflow.slug }}
      </span>
      <!-- 操作按钮：running 态 Pause+Abort，paused 态 Resume+Abort。
           pause/resume 单次点击；abort 两段式确认。 -->
      <div v-if="workflow.status === 'running' || workflow.status === 'paused'" class="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          class="size-5 text-neutral-dim hover:text-neutral-fg"
          :title="workflow.status === 'running' ? t('sidebar.workflowDetail.pause') : t('sidebar.workflowDetail.resume')"
          @click="emit('action', { action: workflow.status === 'running' ? 'pause' : 'resume', runId: workflow.runId })"
        >
          <Pause v-if="workflow.status === 'running'" class="size-3" />
          <Play v-else class="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          :data-testid="aborting ? 'workflow-detail-abort-confirm' : 'workflow-detail-abort'"
          :class="aborting
            ? 'size-5 border border-danger bg-danger text-neutral-fg'
            : 'size-5 text-neutral-dim hover:text-danger'"
          :title="aborting ? t('sidebar.workflowDetail.terminateConfirm') : t('sidebar.workflowDetail.terminate')"
          @click="onAbortClick"
        >
          <Check v-if="aborting" class="size-3" />
          <Square v-else class="size-3" />
        </Button>
      </div>
    </div>

    <div class="mx-2 mb-1 h-px bg-border" />

    <!-- agent call 列表（按 phase 分组） -->
    <ScrollArea class="min-h-0 flex-1">
      <div class="flex flex-col px-1.5 pb-2">
        <div
          v-for="group in phaseGroups"
          :key="group.phase"
          class="mb-2"
        >
          <!-- phase header：仅当存在显式 phase（非全部归到 Other）时渲染。
               线性脚本（无 phase）不显示分组 header，agent call 直接平铺。 -->
          <div
            v-if="hasExplicitPhases"
            class="flex items-center gap-1.5 rounded-sm px-1 py-1"
            :class="group.phaseStatus === 'running' ? 'bg-accent/10' : ''"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="phaseDotClass(group.phaseStatus)"
            />
            <span class="text-[length:var(--text-3xs)] font-medium text-neutral-dim">
              {{ group.phase }}
            </span>
            <span class="text-[length:var(--text-3xs)] text-neutral-dim opacity-60">
              {{ t('sidebar.workflowDetail.agentsLabel', { count: group.calls.length }) }}
            </span>
          </div>

          <!-- agent call 卡片 -->
          <div
            v-for="call in group.calls"
            :key="call.id"
            class="group relative cursor-pointer rounded-md px-2 py-[6px] transition-colors hover:bg-surface-hover"
            :class="{ 'opacity-40': call.status === 'pending' }"
            :title="call.status === 'pending' ? t('sidebar.workflowDetail.pendingHint') : undefined"
            data-testid="workflow-agent-call"
            @click="call.status !== 'pending' && emit('select-agent-call', call.sessionId)"
          >
          <div class="flex items-center gap-2">
            <Loader2
              v-if="call.status === 'running'"
              class="size-[11px] shrink-0 animate-spin text-accent"
            />
            <span
              v-else
              class="size-1.5 shrink-0 rounded-full"
              :class="callDotClass(call.status)"
            />
            <span class="min-w-0 flex-1 truncate text-[length:var(--text-2xs)] font-medium leading-[1.3] text-neutral-fg">
              {{ call.agent }}
            </span>
          </div>

          <!-- 摘要 -->
          <div class="mt-0.5 flex items-center gap-1.5 pl-[19px] font-mono text-[length:var(--text-3xs)] text-neutral-dim">
            <span v-if="call.model">{{ call.model === 'default' ? t('sidebar.workflowDetail.modelDefault') : call.model }}</span>
            <span v-if="call.inputTokens !== undefined">· {{ formatTokens(call.inputTokens, t('sidebar.workflowDetail.tokenInUnit')) }}</span>
            <span v-if="call.outputTokens !== undefined">· {{ formatTokens(call.outputTokens, t('sidebar.workflowDetail.tokenOutUnit')) }}</span>
            <span v-if="call.turns !== undefined">· {{ call.turns }} {{ t('sidebar.workflowDetail.turnsUnit') }}</span>
            <span v-if="call.durationMs !== undefined">· {{ formatDuration(call.durationMs) }}</span>
          </div>
        </div>
      </div>
      </div>
    </ScrollArea>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronLeft, Loader2, Pause, Play, Square, Check } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import type { WorkflowRunRecord, WorkflowAgentCall } from '@taiji/shared'

/** token 数超过此阈值显示 k 单位 */
const TOKEN_K_THRESHOLD = 1000
/** 毫秒 → 秒 */
const MS_PER_SECOND = 1000
/** 秒 → 分 */
const SECONDS_PER_MINUTE = 60

const { t } = useI18n()

const props = defineProps<{
  workflow: WorkflowRunRecord
}>()

const emit = defineEmits<{
  back: []
  'select-agent-call': [sessionId: string | undefined]
  action: [payload: { action: 'pause' | 'resume' | 'abort'; runId: string }]
}>()

/** abort 两段式确认态（header 单卡片，单个 boolean 即可） */
const aborting = ref(false)

/** abort 两段式：首次点击进入确认态，二次点击 emit abort */
function onAbortClick(): void {
  if (aborting.value) {
    emit('action', { action: 'abort', runId: props.workflow.runId })
    aborting.value = false
  } else {
    aborting.value = true
  }
}

/** phase 分组 + 组内状态聚合 */
interface PhaseGroup {
  phase: string
  calls: WorkflowAgentCall[]
  phaseStatus: 'completed' | 'running' | 'pending'
}

/** 按 agentCall.phase 分组，无 phase 的归到 'Other' */
const phaseGroups = computed<PhaseGroup[]>(() => {
  const map = new Map<string, WorkflowAgentCall[]>()
  for (const call of props.workflow.agentCalls) {
    const phase = call.phase ?? 'Other'
    const list = map.get(phase) ?? []
    list.push(call)
    map.set(phase, list)
  }
  return Array.from(map.entries()).map(([phase, calls]) => ({
    phase,
    calls,
    phaseStatus: aggregatePhaseStatus(calls),
  }))
})

/** 是否存在显式 phase（至少一个 agent call 有 phase 字段）。
 *  线性脚本（全部无 phase）不渲染分组 header，避免空洞的 'OTHER' 噪音。 */
const hasExplicitPhases = computed(() =>
  props.workflow.agentCalls.some((c) => c.phase !== undefined),
)

/** 聚合 phase 状态：有 running → running，全 completed/failed → completed，否则 pending */
function aggregatePhaseStatus(calls: WorkflowAgentCall[]): 'completed' | 'running' | 'pending' {
  if (calls.some((c) => c.status === 'running')) return 'running'
  if (calls.every((c) => c.status === 'completed' || c.status === 'failed')) return 'completed'
  return 'pending'
}

function phaseDotClass(status: 'completed' | 'running' | 'pending'): string {
  switch (status) {
    case 'completed': return 'bg-success'
    case 'running': return 'bg-accent'
    default: return 'bg-neutral-dim opacity-40'
  }
}

function callDotClass(status: WorkflowAgentCall['status']): string {
  switch (status) {
    case 'completed': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'running': return 'bg-accent'
    default: return 'bg-neutral-dim opacity-40'
  }
}

function formatTokens(tokens: number, unit: string): string {
  if (tokens >= TOKEN_K_THRESHOLD) return `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k ${unit}`
  return `${tokens} ${unit}`
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / MS_PER_SECOND)
  if (seconds >= SECONDS_PER_MINUTE) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${seconds % SECONDS_PER_MINUTE}s`
  return `${seconds}s`
}
</script>
