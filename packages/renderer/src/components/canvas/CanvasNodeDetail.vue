<!--
  CanvasNodeDetail —— 详情面板·节点详情 tab（problem-solve-canvas §3.1(3)）。

  全类型节点详情投影 + 用户操作入口（操作链：选定/否决/转移/评论/编辑/判据/派发——
  对话框由 CanvasPane 统一编排，本面板只上抛意图）。生命周期转移菜单按契约合法
  转移表枚举（runtime 仍是唯一校验权威——表外转移 fail-fast）。评论块展示锚定评论
  与 agent 响应留痕（响应义务在 agent 侧，GUI 只读）。
-->
<template>
  <div class="flex flex-col gap-3" data-testid="canvas-node-detail">
    <!-- 空态引导（demo empty-guide 形态：未选中节点的操作指引） -->
    <template v-if="!node">
      <p class="text-[length:var(--text-xs)] leading-relaxed text-neutral-mid" data-testid="canvas-detail-empty">
        {{ t('panel.canvas.detailEmpty') }}
      </p>
    </template>

    <template v-else>
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-neutral-dim/40 px-1.5 py-px font-mono text-[length:var(--text-3xs)] font-semibold text-neutral-mid">
          <b>{{ typeLetter }}</b>{{ typeLabel }}
        </span>
        <span class="font-mono text-[length:var(--text-3xs)] text-neutral-faint">{{ node.id }}</span>
        <span class="flex-1" />
        <span class="inline-flex items-center gap-1.5 font-mono text-[length:var(--text-3xs)] text-neutral-mid">
          <span class="size-2 rounded-full" :class="dotClass" />
          {{ t(LIFECYCLE_KEYS[node.lifecycle]) }}
        </span>
      </div>

      <h3 class="text-sm font-semibold leading-snug text-neutral-fg" data-testid="canvas-detail-title">{{ node.content }}</h3>
      <p v-if="parentTitle" class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('panel.canvas.parentLabel') }}{{ parentTitle }}</p>

      <!-- 根节点：三要素（判据确认归 converge-check，GUI 只读呈现） -->
      <template v-if="isRoot">
        <section class="flex flex-col gap-1.5 border-t border-hairline pt-2.5">
          <p class="font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.rootStatement') }}</p>
          <p class="text-[length:var(--text-xs)] leading-relaxed text-neutral-fg">{{ state.root.statement }}</p>
          <p class="mt-1 font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.rootCriterias') }}</p>
          <p
            v-for="c in state.root.criterias"
            :key="c"
            class="flex items-start gap-1.5 text-[length:var(--text-2xs)] leading-relaxed"
            :class="state.root.confirmed ? 'text-neutral-fg' : 'text-neutral-mid'"
            data-testid="canvas-root-criteria"
          >
            <span
              class="mt-1.5 size-2 flex-none rounded-full"
              :class="state.root.confirmed ? 'bg-success' : 'border border-neutral-faint'"
              :data-testid="`canvas-root-criteria-mark`"
            />
            {{ c }}
          </p>
          <p class="mt-1 font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.rootScope') }}</p>
          <p class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid">
            {{ state.root.scopeExclusions.length > 0 ? state.root.scopeExclusions.join('；') : t('panel.canvas.rootScopeEmpty') }}
          </p>
        </section>
      </template>

      <!-- 方案：选定状态与对比理由 / 执行叶子判据 -->
      <template v-if="node.type === 'option'">
        <section v-if="node.selected" class="flex flex-col gap-1 rounded-sm border border-accent bg-accent-soft px-2 py-1.5" data-testid="canvas-detail-selected">
          <p class="font-mono text-[length:var(--text-3xs)] font-semibold text-accent">{{ t('panel.canvas.selectedBadge') }}</p>
          <p v-if="node.selectionReason" class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-fg">{{ node.selectionReason }}</p>
        </section>
        <section v-if="node.dispatchable" class="flex flex-col gap-1.5 border-t border-hairline pt-2.5">
          <p class="font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.leafCriterias') }}</p>
          <p
            v-for="c in node.criterias ?? []"
            :key="c"
            class="flex items-start gap-1.5 text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid"
            data-testid="canvas-leaf-criteria"
          >
            <span class="mt-px flex-none text-neutral-faint">·</span>{{ c }}
          </p>
          <p v-if="(node.criterias ?? []).length === 0" class="text-[length:var(--text-2xs)] text-neutral-faint">{{ t('panel.canvas.leafCriteriasEmpty') }}</p>
        </section>
        <section v-if="node.dispatch" class="rounded-sm border border-hairline px-2 py-1.5" data-testid="canvas-detail-dispatched">
          <p class="font-mono text-[length:var(--text-3xs)] font-semibold text-accent">{{ t('panel.canvas.dispatchedBadge') }}</p>
          <p class="min-w-0 break-all font-mono text-[length:var(--text-3xs)] text-neutral-mid">{{ node.dispatch.pointer }}</p>
        </section>
      </template>

      <!-- 论据：极性 × 素材性 × 核实 + 锚定与互驳 -->
      <template v-if="node.type === 'argument'">
        <section class="flex flex-wrap items-center gap-1.5 border-t border-hairline pt-2.5" data-testid="canvas-detail-argument">
          <span class="rounded-full px-2 py-px font-mono text-[length:var(--text-3xs)] font-semibold" :class="node.polarity === 'object' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent'">
            {{ node.polarity === 'object' ? t('panel.canvas.polarityObject') : t('panel.canvas.polaritySupport') }}
          </span>
          <span class="rounded-full bg-neutral-dim/40 px-2 py-px font-mono text-[length:var(--text-3xs)] font-semibold text-neutral-mid">
            {{ node.materiality === 'fact' ? t('panel.canvas.materialityFact') : t('panel.canvas.materialityClaim') }}
          </span>
          <span
            v-if="node.materiality === 'fact'"
            class="rounded-full px-2 py-px font-mono text-[length:var(--text-3xs)] font-semibold"
            :class="node.factVerified ? 'bg-success-soft text-success' : 'bg-warn-soft text-warn'"
            data-testid="canvas-detail-fact-verified"
          >{{ node.factVerified ? t('panel.canvas.factVerified') : t('panel.canvas.factUnverified') }}</span>
        </section>
        <section class="flex flex-col gap-1 border-t border-hairline pt-2.5">
          <p class="font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.argAnchor') }}</p>
          <p class="text-[length:var(--text-xs)] text-neutral-fg">{{ argAnchorTitle }}</p>
          <template v-if="rebutters.length > 0">
            <p class="mt-1 font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.rebuttedBy') }}</p>
            <Button
              v-for="r in rebutters"
              :key="r.id"
              variant="ghost"
              size="sm"
              class="w-full justify-start px-1 text-left text-[length:var(--text-2xs)] text-neutral-fg"
              @click="emit('select', r.id)"
            >↳ {{ r.content }}</Button>
          </template>
        </section>
      </template>

      <!-- 生命周期转移菜单（契约合法转移表枚举；runtime 唯一权威） -->
      <section v-if="transitions.length > 0" class="flex flex-wrap gap-1.5 border-t border-hairline pt-2.5" data-testid="canvas-detail-transitions">
        <Button
          v-for="tr in transitions"
          :key="tr.to"
          :variant="tr.to === 'rejected' ? 'secondary' : 'ghost'"
          size="sm"
          class="h-7 text-[length:var(--text-2xs)]"
          :class="tr.to === 'rejected' ? 'border-danger text-danger hover:bg-danger-soft' : 'text-neutral-mid'"
          :data-testid="`canvas-transition-to-${tr.to}`"
          @click="emit('op', { kind: tr.to === 'rejected' ? 'reject' : 'transition', nodeId: node.id, transitionTo: tr.to })"
        >{{ t(tr.labelKey) }}</Button>
      </section>

      <!-- 用户操作链入口 -->
      <section class="flex flex-wrap gap-1.5" data-testid="canvas-detail-actions">
        <Button v-if="node.type === 'option' && !node.selected" variant="default" size="sm" class="h-7 text-[length:var(--text-2xs)]" data-testid="canvas-action-select" @click="emit('op', { kind: 'select', nodeId: node.id })">
          {{ t('panel.canvas.op.selectAction') }}
        </Button>
        <Button variant="ghost" size="sm" class="h-7 text-[length:var(--text-2xs)] text-neutral-mid" data-testid="canvas-action-edit" @click="emit('op', { kind: 'edit-content', nodeId: node.id })">
          {{ t('panel.canvas.op.editAction') }}
        </Button>
        <Button v-if="node.dispatchable" variant="ghost" size="sm" class="h-7 text-[length:var(--text-2xs)] text-neutral-mid" data-testid="canvas-action-criterias" @click="emit('op', { kind: 'edit-criterias', nodeId: node.id })">
          {{ t('panel.canvas.op.criteriasAction') }}
        </Button>
        <Button variant="ghost" size="sm" class="h-7 text-[length:var(--text-2xs)] text-neutral-mid" data-testid="canvas-action-comment" @click="emit('op', { kind: 'comment', nodeId: node.id })">
          {{ t('panel.canvas.op.commentAction') }}
        </Button>
        <Button v-if="canDispatch" variant="default" size="sm" class="h-7 text-[length:var(--text-2xs)]" data-testid="canvas-action-dispatch" @click="emit('op', { kind: 'dispatch', nodeId: node.id })">
          {{ t('panel.canvas.dispatchAction') }}
        </Button>
      </section>

      <!-- 评论块（锚定附件；agent 响应留痕只读） -->
      <section v-if="comments.length > 0" class="flex flex-col gap-2 border-t border-hairline pt-2.5" data-testid="canvas-detail-comments">
        <p class="font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.commentsSection', { n: comments.length }) }}</p>
        <div
          v-for="c in comments"
          :key="c.id"
          class="flex flex-col gap-1 rounded-sm border border-hairline px-2 py-1.5"
          :data-testid="`canvas-comment-${c.status}`"
        >
          <p class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-fg">{{ c.text }}</p>
          <p v-if="c.response" class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid">
            <span class="font-mono text-[length:var(--text-3xs)] font-semibold" :class="c.response.disposition === 'adopted' ? 'text-success' : 'text-neutral-mid'">
              {{ c.response.disposition === 'adopted' ? t('panel.canvas.responseAdopted') : t('panel.canvas.responseRebutted') }}
            </span>
            {{ c.response.note }}
          </p>
          <span v-else class="font-mono text-[length:var(--text-3xs)] text-warn">{{ t('panel.canvas.commentPending') }}</span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CanvasNode, CanvasState } from '@zhushanwen/extension-protocol'
import { Button } from '@/components/ui/button'
import {
  argTargetIdOf,
  commentsOfAnchor,
  nodeOf,
  rebuttersOf,
  trunkParentOf,
} from './canvas-display'
import type { CanvasOpKind } from './canvas-ops'

const props = defineProps<{
  state: CanvasState
  nodeId: string | null
}>()

const emit = defineEmits<{
  /** 操作意图上抛（CanvasPane 统一开对话框 + mutate）。 */
  op: [intent: { kind: CanvasOpKind; nodeId?: string; transitionTo?: string }]
  select: [nodeId: string]
}>()

const { t } = useI18n()

const node = computed<CanvasNode | null>(() => (props.nodeId ? nodeOf(props.state, props.nodeId) ?? null : null))
const isRoot = computed(() => node.value !== null && node.value.id === props.state.root.nodeId)

const LIFECYCLE_KEYS = {
  draft: 'panel.canvas.lifecycleDraft',
  'under-review': 'panel.canvas.lifecycleUnderReview',
  passed: 'panel.canvas.lifecyclePassed',
  rejected: 'panel.canvas.lifecycleRejected',
  shelved: 'panel.canvas.lifecycleShelved',
} as const

const TYPE_KEYS = {
  question: 'panel.canvas.typeQuestion',
  option: 'panel.canvas.typeOption',
  argument: 'panel.canvas.argumentTitle',
  constraint: 'panel.canvas.typeConstraint',
} as const

const typeLabel = computed(() => (node.value ? t(TYPE_KEYS[node.value.type]) : ''))
const typeLetter = computed(() => {
  switch (node.value?.type) {
    case 'question': return 'Q'
    case 'option': return 'O'
    case 'argument': return 'A'
    case 'constraint': return 'C'
    default: return ''
  }
})

const dotClass = computed(() => {
  switch (node.value?.lifecycle) {
    case 'under-review': return 'border-warn bg-warn'
    case 'passed': return 'border-success bg-success'
    case 'rejected': return 'border-neutral-dim bg-neutral-dim'
    case 'shelved': return 'border-dashed border-neutral-mid'
    default: return 'border-neutral-mid'
  }
})

const parentTitle = computed(() => {
  if (!node.value || isRoot.value) return ''
  const parentId = trunkParentOf(props.state, node.value.id)
  return parentId ? nodeOf(props.state, parentId)?.content ?? '' : ''
})

/** 生命周期转移菜单（契约合法转移表；根不可搁置/否决）。 */
const transitions = computed<Array<{ to: string; labelKey: string }>>(() => {
  const n = node.value
  if (!n || isRoot.value) return []
  switch (n.lifecycle) {
    case 'draft':
      return [
        { to: 'under-review', labelKey: 'panel.canvas.transitionSubmit' },
        { to: 'shelved', labelKey: 'panel.canvas.transitionShelve' },
      ]
    case 'under-review':
      return [
        { to: 'passed', labelKey: 'panel.canvas.transitionPass' },
        { to: 'rejected', labelKey: 'panel.canvas.op.rejectAction' },
        { to: 'shelved', labelKey: 'panel.canvas.transitionShelve' },
      ]
    case 'rejected':
    case 'shelved':
      return [{ to: 'draft', labelKey: 'panel.canvas.transitionRevive' }]
    default:
      return []
  }
})

/** 派发按钮可见（执行叶子 + passed + 未派发；不变量 7 UI 预判，runtime 权威）。 */
const canDispatch = computed(() => {
  const n = node.value
  return n !== null && n.dispatchable === true && n.lifecycle === 'passed' && !n.dispatch
})

const comments = computed(() => (node.value ? commentsOfAnchor(props.state, node.value.id) : []))

const rebutters = computed(() => (node.value ? rebuttersOf(props.state, node.value.id) : []))

/** 论据锚定目标标题（节点或主干边——边呈现两端内容连接）。 */
const argAnchorTitle = computed(() => {
  const n = node.value
  if (!n || n.type !== 'argument') return ''
  const targetId = argTargetIdOf(props.state, n.id)
  if (!targetId) return '—'
  const targetNode = nodeOf(props.state, targetId)
  if (targetNode) return targetNode.content
  const edge = props.state.edges.find((e) => e.id === targetId)
  if (!edge) return targetId
  const from = nodeOf(props.state, edge.from)?.content ?? edge.from
  const to = nodeOf(props.state, edge.to)?.content ?? edge.to
  return `${from} → ${to}`
})
</script>
