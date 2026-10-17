<!--
  CanvasPane —— 问题解决画布 tab 内容根组件（problem-solve-canvas §3.1(3) U7 工作量主体）。

  形态（demo v3 内核平移 + taiji 组件化）：头部工具条（画布名 + 阶段徽标 + 绑定状态徽标
  + 方向裁决 + 发起审查 / 确认收敛）+ 主区（CanvasGraph 视口画布 + CanvasDetailPanel
  详情三面板）。生长由会话内 agent 驱动（GUI 不放「生长」按钮——设计明文）；GUI 侧
  用户操作链 = mutate(actor:'user') → runtime 校验落盘广播 → 广播回返触发 store 刷新
  （无乐观回显：成功才呈现，失败 toast + 原因）。

  数据链：useCanvasSync(sidRef)（模块级单条订阅 + per-session 分流）→ canvas store
  本会话分区；本组件挂载/换画布即 loadCanvas（canvas.get 带归属 sessionId）。
  绑定徽标数据源 = canvas.get reply 的 activeBindings（owner 即回推对象，存活 =
  现成 client 存活的查询侧派生）；缺字段按未知处理（不渲染，事实驱动⑨）。
  组件异步导入：WorkflowVizOverlay canvas body 分支（defineAsyncComponent）。
-->
<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="canvas-pane">
    <!-- 头部工具条 -->
    <header class="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2" data-testid="canvas-pane-header">
      <h2 class="min-w-0 truncate text-[length:var(--text-sm)] font-semibold text-neutral-fg" data-testid="canvas-pane-title">{{ title }}</h2>
      <span
        class="inline-flex flex-none items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[length:var(--text-3xs)] font-semibold"
        :class="phaseClass"
        data-testid="canvas-phase-badge"
        :data-phase="phase"
      >
        <span class="size-1.5 rounded-full" :class="phaseDotClass" />
        {{ t(PHASE_KEYS[phase]) }}
      </span>
      <CanvasBindingBadge :count="activeBindingCount" />
      <span
        v-if="state?.direction"
        class="inline-flex flex-none items-center rounded-full bg-neutral-dim/40 px-2 py-px font-mono text-[length:var(--text-3xs)] font-semibold text-neutral-mid"
        :title="state.direction.reason"
        data-testid="canvas-direction-badge"
      >{{ t(state.direction.direction === 'top-down' ? 'panel.canvas.directionTopDown' : 'panel.canvas.directionBottomUp') }}</span>
      <span class="flex-1" />
      <Button variant="ghost" size="sm" class="h-7 text-[length:var(--text-2xs)] text-neutral-mid" data-testid="canvas-direction-action" @click="openOp('decide-direction')">
        {{ t('panel.canvas.op.directionAction') }}
      </Button>
      <Button variant="secondary" size="sm" class="h-7 text-[length:var(--text-2xs)]" :disabled="mutating" data-testid="canvas-review-action" @click="requestReview">
        {{ t('panel.canvas.reviewRequest') }}
      </Button>
      <Button
        variant="default"
        size="sm"
        class="h-7 text-[length:var(--text-2xs)]"
        :disabled="mutating || state?.converged === true"
        data-testid="canvas-converge-action"
        @click="converge"
      >
        {{ state?.converged ? t('panel.canvas.convergedLabel') : t('panel.canvas.convergeConfirm') }}
      </Button>
    </header>

    <!-- 主区：图视口 + 详情三面板 -->
    <div v-if="state" class="flex min-h-0 flex-1">
      <CanvasGraph :state="state" :selected-id="selectedId" @select="onSelect" @dispatch="(id) => openOp('dispatch', id)" />
      <CanvasDetailPanel
        :state="state"
        :selected-node-id="selectedId"
        :rejection="rejection"
        @op="onOpIntent"
        @export="runExport"
        @select="onSelect"
        @request-review="requestReview"
      />
    </div>
    <div v-else-if="loadError" class="flex flex-1 flex-col items-center justify-center gap-2" data-testid="canvas-pane-error">
      <p class="text-[length:var(--text-xs)] text-danger">{{ t('panel.canvas.loadFailed') }}</p>
      <p class="max-w-md break-all text-center font-mono text-[length:var(--text-3xs)] text-neutral-dim">{{ loadError }}</p>
      <Button variant="secondary" size="sm" data-testid="canvas-pane-retry" @click="reload">{{ t('panel.canvas.retry') }}</Button>
    </div>
    <div v-else class="flex flex-1 items-center justify-center" data-testid="canvas-pane-loading">
      <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.canvas.loading') }}</p>
    </div>

    <!-- 用户操作对话框（九类操作单实例编排；submit → mutate actor:user） -->
    <CanvasOpDialog
      :open="opSpec !== null"
      :spec="opSpec ?? EMPTY_SPEC"
      :busy="mutating"
      :replaced-label="replacedLabel"
      @submit="onOpSubmit"
      @cancel="closeOp"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CanvasExportTarget, CanvasMutateRequest } from '@zhushanwen/extension-protocol'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { Button } from '@/components/ui/button'
import { useToast } from '@/composables/useToast'
import { useCanvasSync } from '@/composables/use-canvas-sync'
import { canvasPhaseOf, nodeOf, type CanvasPhase } from './canvas-display'
import { buildMutateRequest, opSpecOf, type CanvasOpKind, type CanvasOpSpec, type CanvasOpValues } from './canvas-ops'
import CanvasBindingBadge from './CanvasBindingBadge.vue'
import CanvasGraph from './CanvasGraph.vue'
import CanvasDetailPanel from './CanvasDetailPanel.vue'
import CanvasOpDialog from './CanvasOpDialog.vue'

const props = defineProps<{
  canvasId: string
  /** 画布归属会话 id（overlay 载荷透传，D4 会话隔离：RPC 带归属 + per-session 分区读）。 */
  sessionId: string
}>()

const { t } = useI18n()
const toast = useToast()

const sidRef = computed(() => props.sessionId)
const store = useCanvasSync(sidRef)

const state = computed(() => store.canvasOf(props.canvasId))
const loadError = computed(() => store.loadErrorOf(props.canvasId))

const selectedId = ref<string | null>(null)
const mutating = ref(false)
/** 最近一次未收敛拒绝（converge-check / export 失败臂——导出门禁区呈现）。 */
const rejection = ref<{ code: string; recover: string } | null>(null)

watch(
  () => props.canvasId,
  (id) => {
    if (!id) return
    selectedId.value = null
    rejection.value = null
    void store.loadCanvas(id)
  },
  { immediate: true },
)

function reload(): void {
  void store.loadCanvas(props.canvasId)
  void store.listCanvases()
}

// ── 头部投影 ────────────────────────────────────────────────────────────────

const title = computed(() => state.value?.name ?? '')

const PHASE_KEYS: Record<CanvasPhase, string> = {
  growing: 'panel.canvas.phaseGrowing',
  reviewing: 'panel.canvas.phaseReviewing',
  converged: 'panel.canvas.phaseConverged',
}

const phase = computed<CanvasPhase>(() => (state.value ? canvasPhaseOf(state.value) : 'growing'))

const phaseClass = computed(() => {
  switch (phase.value) {
    case 'converged': return 'border-success bg-success-soft text-success'
    case 'reviewing': return 'border-warn bg-warn-soft text-warn'
    default: return 'border-hairline text-neutral-mid'
  }
})

const phaseDotClass = computed(() => {
  switch (phase.value) {
    case 'converged': return 'bg-success'
    case 'reviewing': return 'bg-warn'
    default: return 'bg-neutral-dim'
  }
})

/**
 * 绑定徽标数据源：活跃绑定集合（绑定记录 ∩ 存活 session）随 canvas.get reply 的
 * activeBindings 字段到达（transport 查询侧派生，CanvasState 契约注释）；广播失效
 * 重拉链路天然刷新。reply 缺字段（marker 通道形态 / 旧 runtime）按未知处理——
 * 徽标不渲染（事实驱动⑨未知不呈现）。
 */
const activeBindingCount = computed<number | null>(() => state.value?.activeBindings ?? null)

// ── mutate 执行（无乐观回显：成功等广播刷新，失败 toast + 原因）──────────────

async function runMutate(request: CanvasMutateRequest): Promise<boolean> {
  mutating.value = true
  try {
    // sessionId 必填（D4 破坏性协议）：归属写面——runtime 按 payload.sessionId 校验归属。
    const reply = await command('canvas.mutate', { actor: 'user', sessionId: props.sessionId, ...request }, RPC_BACKSTOP_TIMEOUT_MS)
    if (reply.ok) {
      toast.info(reply.summary)
      return true
    }
    toast.error(`${reply.error.message} ${reply.error.recover}`)
    if (request.action === 'converge-check' || request.action === 'export') {
      rejection.value = { code: reply.error.code, recover: reply.error.recover }
    }
    return false
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
    return false
  } finally {
    mutating.value = false
  }
}

async function requestReview(): Promise<void> {
  await runMutate({ action: 'review-request', params: { canvasId: props.canvasId } })
}

async function converge(): Promise<void> {
  await runMutate({ action: 'converge-check', params: { canvasId: props.canvasId } })
}

async function runExport(target: CanvasExportTarget): Promise<void> {
  await runMutate({ action: 'export', params: { canvasId: props.canvasId, target } })
}

// ── 操作对话框编排（九类操作单实例）────────────────────────────────────────

const EMPTY_SPEC: CanvasOpSpec = { kind: 'comment', titleKey: '', submitKey: '', fields: [] }

const opSpec = ref<CanvasOpSpec | null>(null)

const replacedLabel = computed(() => {
  const spec = opSpec.value
  if (!spec?.replacedOptionId || !state.value) return ''
  return nodeOf(state.value, spec.replacedOptionId)?.content ?? spec.replacedOptionId
})

function openOp(kind: CanvasOpKind, nodeId?: string): void {
  if (!state.value) return
  opSpec.value = opSpecOf(kind, { state: state.value, nodeId })
}

/** 详情面板/图上抛的操作意图（含审查报告处置的 entryId 与转移目标）。 */
function onOpIntent(intent: { kind: CanvasOpKind; nodeId?: string; entryId?: string; transitionTo?: string }): void {
  if (!state.value) return
  opSpec.value = opSpecOf(intent.kind, {
    state: state.value,
    nodeId: intent.nodeId,
    entryId: intent.entryId,
    transitionTo: intent.transitionTo,
  })
}

async function onOpSubmit(values: CanvasOpValues): Promise<void> {
  const spec = opSpec.value
  if (!spec) return
  const request = buildMutateRequest(props.canvasId, spec, values)
  const ok = await runMutate(request)
  if (ok) closeOp()
}

function closeOp(): void {
  opSpec.value = null
}

function onSelect(nodeId: string | null): void {
  selectedId.value = nodeId
}
</script>
