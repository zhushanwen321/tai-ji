<!--
  CanvasReviewPanel —— 详情面板·审查报告 tab（problem-solve-canvas §3.1(3)）。

  报告聚合投影：状态头（终态族 + 停回说明/恢复动作——非 converged 终态必附）、
  条目按轮次倒序分组（R1 全面审 → R2+ 处置表复审）、severity 徽标（must-fix 清零
  是门禁③半边）、处置状态（first-writer-wins：已处置显示归属与处置说明，不可覆盖）、
  未处置条目的处置按钮（user 直接处置 = review-resolve actor:user，对话框由
  CanvasPane 编排）。条目 targetId 可点击定位图元素。
-->
<template>
  <div class="flex flex-col gap-3" data-testid="canvas-review-panel">
    <template v-if="state.review === null">
      <p class="text-[length:var(--text-xs)] leading-relaxed text-neutral-mid" data-testid="canvas-review-empty">
        {{ t('panel.canvas.reviewEmpty') }}
      </p>
      <Button variant="default" size="sm" class="self-start" data-testid="canvas-review-request" @click="emit('request-review')">
        {{ t('panel.canvas.reviewRequest') }}
      </Button>
    </template>

    <template v-else>
      <div class="flex items-center gap-2">
        <span
          class="rounded-full px-2 py-px font-mono text-[length:var(--text-3xs)] font-semibold"
          :class="statusClass"
          data-testid="canvas-review-status"
        >{{ t(REVIEW_STATUS_KEYS[state.review.status]) }}</span>
        <span class="font-mono text-[length:var(--text-3xs)] text-neutral-dim">
          {{ t('panel.canvas.reviewRound', { round: state.review.round, max: state.review.maxRounds }) }}
        </span>
      </div>
      <p v-if="state.review.stopNote" class="rounded-sm border border-warn bg-warn-soft px-2 py-1.5 text-[length:var(--text-2xs)] leading-relaxed text-warn" data-testid="canvas-review-stop-note">
        {{ state.review.stopNote }}
      </p>
      <p v-if="state.review.recoverHint" class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid" data-testid="canvas-review-recover-hint">
        {{ state.review.recoverHint }}
      </p>
      <Button variant="default" size="sm" class="self-start" data-testid="canvas-review-request" @click="emit('request-review')">
        {{ t('panel.canvas.reviewRequestAgain', { round: state.review.round + 1 }) }}
      </Button>

      <section
        v-for="group in entryGroups"
        :key="group.round"
        class="flex flex-col gap-1.5 border-t border-hairline pt-2.5"
        :data-testid="`canvas-review-round-${group.round}`"
      >
        <p class="font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">
          {{ t('panel.canvas.reviewRoundTitle', { round: group.round }) }}
        </p>
        <div
          v-for="entry in group.entries"
          :key="entry.id"
          class="flex flex-col gap-1 rounded-sm border border-hairline px-2 py-1.5"
          :data-testid="`canvas-review-entry`"
          :data-severity="entry.severity"
        >
          <div class="flex items-center gap-1.5">
            <span
              class="rounded-full px-1.5 py-px font-mono text-[length:var(--text-3xs)] font-semibold"
              :class="entry.severity === 'must-fix' ? 'bg-danger-soft text-danger' : 'bg-neutral-dim/40 text-neutral-mid'"
            >{{ entry.severity === 'must-fix' ? t('panel.canvas.severityMustFix') : t('panel.canvas.severitySuggestion') }}</span>
            <span class="font-mono text-[length:var(--text-3xs)] text-neutral-faint">{{ t(DIMENSION_KEYS[entry.dimension]) }}</span>
            <span class="flex-1" />
            <span
              v-if="entry.resolution"
              class="rounded-full bg-success-soft px-1.5 py-px font-mono text-[length:var(--text-3xs)] font-semibold text-success"
              :title="`${t('panel.canvas.resolvedBy')} ${resolutionLabel(entry)}`"
              data-testid="canvas-review-entry-resolved"
            >{{ t('panel.canvas.resolvedBadge') }}</span>
            <Button
              v-else
              variant="ghost"
              size="sm"
              class="h-6 px-2 text-[length:var(--text-2xs)] text-neutral-mid"
              :data-testid="`canvas-review-resolve-${entry.id}`"
              @click="emit('op', { kind: 'resolve', entryId: entry.id })"
            >{{ t('panel.canvas.op.resolveAction') }}</Button>
          </div>
          <Button variant="ghost" size="sm" class="w-full justify-start px-0 text-left text-[length:var(--text-2xs)] leading-relaxed text-neutral-fg" @click="emit('select', entry.targetId)">
            <span class="min-w-0 whitespace-normal text-left">{{ entry.note }}</span>
          </Button>
          <p v-if="entry.resolution" class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid">
            <span class="font-mono text-[length:var(--text-3xs)] font-semibold">{{ resolutionLabel(entry) }}</span>
            {{ entry.resolution.note }}
          </p>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CanvasState, ReviewEntry, ReviewReportStatus } from '@zhushanwen/extension-protocol'
import { Button } from '@/components/ui/button'
import type { CanvasOpKind } from './canvas-ops'

const props = defineProps<{
  state: CanvasState
}>()

const emit = defineEmits<{
  op: [intent: { kind: CanvasOpKind; entryId?: string }]
  select: [nodeId: string]
  'request-review': []
}>()

const { t } = useI18n()

const REVIEW_STATUS_KEYS: Record<ReviewReportStatus, string> = {
  'in-progress': 'panel.canvas.reviewStatusInProgress',
  converged: 'panel.canvas.reviewStatusConverged',
  'max-rounds': 'panel.canvas.reviewStatusMaxRounds',
  escalated: 'panel.canvas.reviewStatusEscalated',
  stuck: 'panel.canvas.reviewStatusStuck',
}

const DIMENSION_KEYS: Record<ReviewEntry['dimension'], string> = {
  completeness: 'panel.canvas.dimCompleteness',
  necessity: 'panel.canvas.dimNecessity',
  support: 'panel.canvas.dimSupport',
  authenticity: 'panel.canvas.dimAuthenticity',
  conflict: 'panel.canvas.dimConflict',
  depth: 'panel.canvas.dimDepth',
}

const statusClass = computed(() => {
  const status = props.state.review?.status
  if (status === 'converged') return 'bg-success-soft text-success'
  if (status === 'in-progress') return 'bg-warn-soft text-warn'
  return 'bg-neutral-dim/40 text-neutral-mid'
})

/** 条目按轮次倒序分组（R1 在下——最新轮次顶置）。 */
const entryGroups = computed<Array<{ round: number; entries: ReviewEntry[] }>>(() => {
  const entries = props.state.review?.entries ?? []
  const byRound = new Map<number, ReviewEntry[]>()
  for (const e of entries) {
    const list = byRound.get(e.round) ?? []
    list.push(e)
    byRound.set(e.round, list)
  }
  return [...byRound.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([round, list]) => ({ round, entries: list }))
})

function resolutionLabel(entry: ReviewEntry): string {
  const disposition = entry.resolution?.disposition
  const by = entry.resolution?.by
  if (!disposition || !by) return ''
  const keys: Record<string, string> = {
    accepted: 'panel.canvas.op.resolveAccepted',
    deferred: 'panel.canvas.op.resolveDeferred',
    rejected: 'panel.canvas.op.resolveRejected',
  }
  return `${t(keys[disposition] ?? disposition)} · ${by === 'user' ? t('panel.canvas.resolvedByUser') : t('panel.canvas.resolvedByAgent')}`
}
</script>
