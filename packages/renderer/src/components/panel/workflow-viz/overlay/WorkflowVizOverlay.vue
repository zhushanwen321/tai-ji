<!--
  WorkflowVizOverlay —— workflow 实况 overlay 壳（workflow-visualization 设计 §3.1-1/2，
  U4 单元）。SearchModal 范式参照新写（D8：它是搜索功能组件、无 slot，不做组件级
  复用——只参照其「fixed 遮罩 + ESC keydown + autofocus」inline 形态与 close 后不再
  调度查询的资源清理手法）；视觉遵守 DESIGN.md（浮层 radius-lg 12px、z-modal 1000、
  状态色降噪色阶、焦点管理三要素：打开即 focus 面板 / 关闭归还触发元素 / Tab 首末
  循环焦点陷阱防逃逸到遮罩后背景 UI）。

  结构：header（单行六元素：图标 + workflow 名 + slug + 状态 pill + errorCode
  + 已用时长，关闭钮不计入元素数；v5 终裁参数信息不进 header——workflow-overlay-refine D2）+
  body 纵向两段（workflow-overlay-refine D1，份额 1.6:1）：上区 DAG（WorkflowVizDag
  画布 / DAG 不可得降级列表 / 解析中 / 未匹配实例分组 + 左下角 D4 状态图例（仅画布
  就绪时在场，dot 类与节点同源 dag/tone.ts、pointer-events-none 不拦截画布交互），
  全宽）+ 下区 dock（slot——U5 多级 tab 面板填充位，全宽）。

  关闭三通道统一走同一 close()（设计 §3.1-2）：ESC（window keydown，open 时挂、
  close 时卸 + IME 守卫）、右上关闭按钮、点遮罩（面板外区域 @click.self）。

  单例语义：壳自身无实例状态残留——「开新 run 切内容」由挂载方保持单实例并切换
  props（run/dag），切换 run 时 DAG 视口重置在画布组件内处理（D11③）。

  D10 回落：本壳**不内置** Guard——Guard（WorkflowVizOverlayGuard）由挂载方包在
  壳外（errorCaptured 只捕获后代错误，壳自身 render 帧的错误只有父层能捕）；
  壳经 emits 暴露回落链所需语义（close / select / retry-dag），回落 drawer 的
  openDrawerTab + openWorkflowInDrawer 接线归 U6。

  数据边界（u4 与 u5 的派生单处分工）：节点六态映射（nodeStates）与已用时长
  （elapsedMs，含 D9 中断停走口径）为已派生输入——单点实现在 renderer 侧
  gantt-segments 派生（deriveNodeStatus）与 workflowStore（deriveWorkflowRunElapsedMs），
  由容器 Host 统一派生后经 props 透传（单 header 终态 D2：时长仅壳 header 呈现，
  面板层不再重复），
  本壳纯展示不自行判定；DAG 不可得的降级形态（原因码 + parse_failed 重试入口 +
  按 phase 分组只读列表）在本壳实现（上区行为，数据 = run.agentCalls）。

  纵向份额（D1 常量口径）：上区 flex-[1.6] / 下区 flex-1 = 61.5% / 38.5%（分母 =
  面板内容高）；下 dock 低于最小可用高度时 dock 内部滚动（overflow-y-auto 既有链），
  不压缩 DAG 区份额。未匹配实例分组 max-h-[35%] 的分母随容器变为上区高度（D1
  E4 口径变更点，类值不变）。
-->
<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/80 backdrop-blur-[2px]"
    data-testid="wfvz-overlay"
    @click.self="close"
  >
    <section
      ref="panelRef"
      class="flex h-[88%] w-[92%] flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-2 outline-none"
      role="dialog"
      aria-modal="true"
      :aria-label="t('panel.workflowViz.overlayTitle')"
      tabindex="-1"
      data-testid="wfvz-overlay-panel"
      @click.stop
    >
      <!-- header：单行六元素（图标 + workflow 名 + slug + 状态 pill + errorCode + 时长，关闭钮不计入；D2 v5 终裁不展示 args） -->
      <header
        class="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2"
        data-testid="wfvz-overlay-header"
      >
        <Workflow class="size-[15px] shrink-0 text-neutral-dim" aria-hidden="true" />
        <span class="min-w-0 shrink-0 font-mono text-[length:var(--text-xs)] font-semibold text-neutral-fg">{{ run?.scriptName ?? '' }}</span>
        <span
          v-if="run?.slug"
          class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
          data-testid="wfvz-overlay-slug"
        >{{ run.slug }}</span>
        <span
          v-if="run"
          class="inline-flex shrink-0 items-center gap-[5px] rounded-full border py-px px-2 font-mono text-[length:var(--text-3xs)] font-semibold"
          :class="pillClass"
          data-testid="wfvz-overlay-run-pill"
          :data-status="run.status"
        >
          <span class="size-1.5 rounded-full" :class="pillDotClass" />
          {{ pillLabel }}
        </span>
        <span
          v-if="run?.status === 'done' && run.errorCode"
          class="max-w-[200px] shrink-0 truncate font-mono text-[length:var(--text-3xs)] text-danger"
          data-testid="wfvz-overlay-error-code"
          :title="run.errorCode"
        >{{ run.errorCode }}</span>
        <span
          v-if="elapsedMs !== undefined"
          class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-mid"
          data-testid="wfvz-overlay-elapsed"
        >{{ formatDuration(elapsedMs) }}</span>
        <span class="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          class="size-[22px] shrink-0 text-neutral-dim"
          :aria-label="t('panel.workflowViz.overlayClose')"
          data-testid="wfvz-overlay-close"
          @click="close"
        >
          <X class="size-3.5" aria-hidden="true" />
        </Button>
      </header>

      <!-- body：上区 DAG（纵向主视图，全宽）+ 下区实况面板 dock（slot），份额 1.6:1 -->
      <div class="flex min-h-0 flex-1 flex-col">
        <aside
          class="relative flex min-h-0 flex-[1.6] flex-col"
          data-testid="wfvz-overlay-dag-pane"
        >
          <!-- DAG 就绪：画布 + 未匹配分组同链（v-else-if/v-else 降级与解析中接续本链——三态互斥） -->
          <template v-if="dag !== null">
          <WorkflowVizDag
            :dag="dag"
            :node-states="nodeStates"
            :run-status="run?.status"
            :run-outcome="run?.outcome"
            :active-phase="activePhase"
            @select="(payload) => emit('select', payload)"
          />
          <!-- D4 状态图例（workflow-overlay-refine）：六态 dot + 词，dot 类从 dag/tone.ts
               同源取（「图例 = DAG 的图例」）；停止叠加两档说明由容器 title 承载；绝对
               定位层不占画布布局流，pointer-events-none 不拦截节点点击与缩放手势（V3-wf⑤） -->
          <div
            class="pointer-events-none absolute bottom-2 left-3 flex items-center gap-3 rounded-sm border border-hairline bg-surface px-2.5 py-1.5"
            :title="t('panel.workflowViz.legendStopTitle')"
            data-testid="wfvz-dag-legend"
          >
            <span
              v-for="entry in legendEntries"
              :key="entry.status"
              class="inline-flex items-center gap-1.5 text-[length:var(--text-2xs)] text-neutral-mid"
            >
              <svg class="size-2 shrink-0" viewBox="0 0 8 8" aria-hidden="true">
                <!-- dot fill 全量取 dotTone（含 pending 的中性灰）——禁另挂基础 fill 类：
                     Tailwind 同属性任意值类按值字母序发射，双类并存时 neutral-dim 后发
                     覆盖 tone 色（tone.ts 模块注释载机制与根因） -->
                <circle
                  :class="dotTone(entry.status)"
                  cx="4"
                  cy="4"
                  r="4"
                  :data-testid="`wfvz-dag-legend-dot-${entry.status}`"
                />
              </svg>
              {{ entry.label }}
            </span>
          </div>
          <!-- 未匹配实例分组（D2⑥：零命中/歧义实例不静默丢弃——画布下方按 phase
               分组的指定展示面；正常 run 无未匹配实例时零渲染，画布不受影响） -->
          <div
            v-if="unmatchedGroups.length > 0"
            class="flex max-h-[35%] flex-none flex-col gap-1 overflow-y-auto border-t border-hairline px-3 py-2"
            data-testid="wfvz-overlay-unmatched"
          >
            <p class="text-[length:var(--text-3xs)] font-semibold text-neutral-dim">{{ t('panel.workflowViz.unmatchedGroupTitle') }}</p>
            <div
              v-for="group in unmatchedGroups"
              :key="group.phase"
              class="flex flex-col gap-0.5"
              :data-testid="`wfvz-overlay-unmatched-group-${group.phase || 'unknown'}`"
            >
              <p class="text-[length:var(--text-3xs)] text-neutral-faint">{{ group.phase || t('panel.workflowViz.unmatchedPhaseUnknown') }}</p>
              <div
                v-for="item in group.items"
                :key="item.call.id"
                class="flex items-center gap-2 rounded-sm px-1 py-[3px]"
                :data-ambiguous="item.ambiguous ? 'true' : 'false'"
                :data-hit-count="item.hitCount"
                data-testid="wfvz-overlay-unmatched-item"
              >
                <span class="size-1.5 shrink-0 rounded-full" :class="callDotClass(item.call.status)" />
                <span class="min-w-0 truncate font-mono text-[length:var(--text-2xs)] text-neutral-fg">{{ item.call.agent }}</span>
                <span
                  class="ml-auto shrink-0 font-mono text-[length:var(--text-3xs)]"
                  :class="item.ambiguous ? 'text-warn' : 'text-neutral-dim'"
                >{{ unmatchedNote(item) }}</span>
              </div>
            </div>
          </div>
          </template>
          <!-- DAG 不可得：降级列表 + 原因码（parse_failed 附重试解析入口） -->
          <div
            v-else-if="dagError"
            class="flex flex-col gap-2 overflow-y-auto p-3"
            data-testid="wfvz-overlay-dag-fallback"
          >
            <p class="text-[length:var(--text-xs)] text-neutral-fg" data-testid="wfvz-overlay-dag-error">
              {{ dagErrorLabel }}
            </p>
            <div
              class="font-mono text-[length:var(--text-3xs)] text-neutral-dim"
              data-testid="wfvz-overlay-dag-error-code"
            >
              {{ dagError.code }}
            </div>
            <Button
              v-if="dagError.code === 'parse_failed'"
              variant="ghost"
              size="sm"
              data-testid="wfvz-overlay-dag-retry"
              @click="emit('retry-dag')"
            >
              {{ t('panel.workflowViz.dagRetryParse') }}
            </Button>
            <!-- 降级列表：按 phase 分组的调用点只读形态（等价 WorkflowTab 内容的最小面） -->
            <div
              v-for="group in fallbackGroups"
              :key="group.phase"
              class="flex flex-col gap-0.5"
              :data-testid="`wfvz-overlay-dag-fallback-group-${group.phase}`"
            >
              <p v-if="hasExplicitPhases" class="text-[length:var(--text-3xs)] font-semibold text-neutral-dim">{{ group.phase }}</p>
              <div
                v-for="call in group.calls"
                :key="call.id"
                class="flex items-center gap-2 rounded-sm px-1 py-[3px]"
                :data-state="call.status"
                data-testid="wfvz-overlay-dag-fallback-call"
              >
                <span class="size-1.5 shrink-0 rounded-full" :class="callDotClass(call.status)" />
                <span class="truncate font-mono text-[length:var(--text-2xs)] text-neutral-fg">{{ call.agent }}</span>
              </div>
            </div>
          </div>
          <!-- 解析中 -->
          <div
            v-else
            class="flex items-center justify-center py-8 text-[length:var(--text-xs)] text-neutral-dim"
            data-testid="wfvz-overlay-dag-loading"
          >
            {{ t('panel.workflowViz.dagLoading') }}
          </div>
        </aside>

        <section class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="wfvz-overlay-live-pane">
          <slot />
        </section>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Workflow } from '@lucide/vue'
import { WORKFLOW_RUN_OUTCOME_LABELS, type WorkflowAgentCall, type WorkflowDag, type WorkflowRunRecord } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { formatCompactDuration, MS_PER_SECOND } from '@/lib/duration-format'
import WorkflowVizDag from '../dag/WorkflowVizDag.vue'
import { dotTone } from '../dag/tone'
import type { WorkflowUnmatchedInstance } from '../blueprint-match'
import type { WorkflowVizDagClickPayload, WorkflowVizDagNodeStatus } from '../dag/types'
import type { WorkflowVizDagLoadError } from './types'

const props = defineProps<{
  open: boolean
  /** 当前 run 记录（getWorkflows 通道；null = 数据未就绪，header 出空骨架）。 */
  run: WorkflowRunRecord | null
  /** DAG 蓝图（getWorkflowDag 成功臂；null + dagError=null = 解析中）。 */
  dag: WorkflowDag | null
  /** DAG 不可得归一错误（null = 通道正常）。 */
  dagError: WorkflowVizDagLoadError | null
  /** 节点六态映射（已派生输入，透传画布；派生单处在 u5）。 */
  nodeStates?: Record<string, WorkflowVizDagNodeStatus>
  /** 当前 phase 分区（已派生输入，透传画布）。 */
  activePhase?: string | null
  /**
   * 未匹配实例（已派生输入——匹配单处在容器 Host，D2⑥ 零命中/歧义不静默丢弃；
   * 壳按 phase 分组渲染画布下方的指定分组，命中数/歧义标注随行）。
   */
  unmatched?: WorkflowUnmatchedInstance[]
  /**
   * 已用时长 ms（已派生输入——D9「中断停走」口径由上层单处派生函数产出；
   * 缺省不渲染时长槽，本壳不做计时派生）。
   */
  elapsedMs?: number
}>()

const emit = defineEmits<{
  /** 三通道关闭统一出口（ESC / 关闭按钮 / 点遮罩都走 close）。 */
  close: []
  /** DAG 点击上抛转发（agent 节点 / pending 节点=phase 语义 / phase 分区）。 */
  select: [payload: WorkflowVizDagClickPayload]
  /** DAG 解析重试（parse_failed 专属入口——失败不缓存故可重试）。 */
  'retry-dag': []
}>()

const { t } = useI18n()

// ── D4 状态图例（六态 + 停止叠加说明；挂 DAG 区左下，绝对定位不占布局流）──

/**
 * 图例 dot 类消费 dag/tone.ts 的 dotTone（与节点 dot 同源的单一事实源，模板内
 * `dotTone(entry.status)` 逐条取类）；词用既有状态词族现值（与 RunTraceTable
 * statusLabel 同映射），skipped 为 workflow-overlay-refine D4 新增词条。
 * 停止叠加两档不进常驻图例，由图例容器 title 承载说明（i18n legendStopTitle）。
 */
const LEGEND_STATUS_LABEL_KEYS = {
  pending: 'panel.sideDrawer.workflowPending',
  running: 'panel.sideDrawer.workflowRunning',
  done: 'panel.workflowViz.statusDone',
  failed: 'panel.workflowViz.statusFailed',
  retrying: 'panel.workflowViz.statusRetrying',
  skipped: 'panel.workflowViz.statusSkipped',
} as const satisfies Record<WorkflowVizDagNodeStatus, string>

/** 图例条目（序 = 六态词表序：pending / running / done / failed / retrying / skipped）。 */
const legendEntries = computed(() =>
  (Object.keys(LEGEND_STATUS_LABEL_KEYS) as WorkflowVizDagNodeStatus[]).map((status) => ({
    status,
    label: t(LEGEND_STATUS_LABEL_KEYS[status]),
  })),
)

const panelRef = ref<HTMLElement | null>(null)
/** 焦点归还锚（DESIGN §5.12：打开前聚焦元素，关闭时归还）。 */
let lastFocused: Element | null = null

// ── 关闭三通道（统一 close）──

function close(): void {
  emit('close')
}

/** ESC 关闭 + Tab 焦点陷阱（window keydown，open 时挂载；IME 组合态不拦截——SearchModal 同守卫）。 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'Tab') trapTab(e)
}

/** Tab 可聚焦元素查询（焦点陷阱的候选集）。 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Tab 焦点陷阱（DESIGN §5.12 焦点管理三要素之三）：焦点在面板内可聚焦元素首末循环，
 * 防 Tab 逃逸到被遮罩挡住的背景 UI（role=dialog + aria-modal 的 a11y 语义一致性）。
 */
function trapTab(e: KeyboardEvent): void {
  const panel = panelRef.value
  if (!panel) return
  const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  if (focusables.length === 0) {
    e.preventDefault()
    panel.focus()
    return
  }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement
  const inside = active instanceof Node && panel.contains(active)
  if (e.shiftKey) {
    if (!inside || active === first) {
      e.preventDefault()
      last.focus()
    }
  } else if (!inside || active === last) {
    e.preventDefault()
    first.focus()
  }
}

/**
 * open 切换（SearchModal watch(immediate) 同型）：打开 → 记录焦点锚 + nextTick
 * focus 面板（安全默认焦点）；关闭 → 焦点归还 + 瞬态清理（本壳无定时器/在途查询
 * ——数据生命周期归 store，D11①在途丢弃在消费层）。
 */
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    lastFocused = document.activeElement
    void nextTick(() => panelRef.value?.focus())
    window.addEventListener('keydown', onWindowKeydown)
  } else {
    window.removeEventListener('keydown', onWindowKeydown)
    if (lastFocused instanceof HTMLElement && typeof lastFocused.focus === 'function') {
      lastFocused.focus()
    }
    lastFocused = null
  }
}, { immediate: true })

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
})

// ── header 状态 pill（文案单源：outcome 四值 = shared LABELS；interrupted 复用
// tray「已中断（可续跑）」词源；running/done 缺省为本域文案）──

const pillLabel = computed(() => {
  const run = props.run
  if (!run) return ''
  if (run.status === 'running') return t('panel.workflowViz.runStatusRunning')
  if (run.status === 'interrupted') return t('panel.tray.workflowInterrupted')
  return run.outcome ? WORKFLOW_RUN_OUTCOME_LABELS[run.outcome] : t('panel.workflowViz.runStatusDone')
})

const pillDotClass = computed(() => {
  const run = props.run
  if (!run) return ''
  if (run.status === 'running') return 'bg-accent'
  if (run.status === 'interrupted') return 'bg-neutral-dim opacity-50'
  if (run.outcome === 'done') return 'bg-success'
  if (run.outcome === 'failed' || run.outcome === 'time_limited') return 'bg-danger'
  return 'bg-neutral-dim opacity-50'
})

/**
 * 状态 pill 着色（Tailwind 类组：文字/边框/底色三元一致由同一分支给出——
 * border-hairline 是 extend 键、发射序在调色板色之后，与 border-accent 并存会
 * 反杀状态色，故不做「基类 + 状态覆盖」而整组条件切换）。
 */
const pillClass = computed(() => {
  const run = props.run
  if (!run) return ''
  if (run.status === 'running') return 'border-accent bg-accent-soft text-accent'
  if (run.status === 'interrupted') return 'border-hairline text-neutral-mid'
  if (run.outcome === 'done') return 'border-success bg-success-soft text-success'
  if (run.outcome === 'failed' || run.outcome === 'time_limited') return 'border-danger bg-danger-soft text-danger'
  return 'border-hairline text-neutral-mid'
})

// ── DAG 不可得降级列表（按 phase 分组只读形态）──

interface FallbackGroup {
  phase: string
  calls: WorkflowAgentCall[]
}

const fallbackGroups = computed<FallbackGroup[]>(() => {
  const run = props.run
  if (!run) return []
  const groups = new Map<string, WorkflowAgentCall[]>()
  for (const call of run.agentCalls) {
    const phase = call.phase ?? ''
    const list = groups.get(phase) ?? []
    list.push(call)
    groups.set(phase, list)
  }
  return [...groups.entries()].map(([phase, calls]) => ({ phase, calls }))
})

/** 存在显式 phase 才显示分组 header（WorkflowTab 同款判据：线性脚本无 phase 不分组）。 */
const hasExplicitPhases = computed(() =>
  fallbackGroups.value.some((g) => g.phase !== ''),
)

// ── 未匹配实例分组（D2⑥ 展示面：零命中/歧义实例按 phase 分组，不静默丢弃）──

interface UnmatchedGroup {
  phase: string
  items: WorkflowUnmatchedInstance[]
}

/** 按 phase 分组（插入序 = 事件流序，与降级列表同型；phase 缺失归空串组）。 */
const unmatchedGroups = computed<UnmatchedGroup[]>(() => {
  const groups = new Map<string, WorkflowUnmatchedInstance[]>()
  for (const item of props.unmatched ?? []) {
    const phase = item.call.phase ?? ''
    const list = groups.get(phase) ?? []
    list.push(item)
    groups.set(phase, list)
  }
  return [...groups.entries()].map(([phase, items]) => ({ phase, items }))
})

/** 随行标注（D2③ 原文口径：歧义 =「歧义（命中 N 个调用点）」，零命中给短标注）。 */
function unmatchedNote(item: WorkflowUnmatchedInstance): string {
  return item.ambiguous
    ? t('panel.workflowViz.unmatchedAmbiguous', { n: item.hitCount })
    : t('panel.workflowViz.unmatchedZeroHit')
}

const dagErrorLabel = computed(() => {
  const err = props.dagError
  if (!err) return ''
  switch (err.code) {
    case 'parse_failed': return t('panel.workflowViz.dagErrorParseFailed')
    case 'no_script_source': return t('panel.workflowViz.dagErrorNoScriptSource')
    case 'record_not_found': return t('panel.workflowViz.dagErrorRecordNotFound')
    case 'path_rejected': return t('panel.workflowViz.dagErrorPathRejected')
    case 'channel': return t('panel.workflowViz.dagErrorChannel')
    default: return err.message
  }
})

// ── 展示工具 ──

/** ms → 耗时（WorkflowTab 口径：无小时档；换算单点在 lib/duration-format）。 */
function formatDuration(ms: number): string {
  return formatCompactDuration(Math.floor(ms / MS_PER_SECOND), { hours: false })
}

function callDotClass(status: WorkflowAgentCall['status']): string {
  switch (status) {
    case 'done': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'running': return 'bg-accent'
    case 'pending': return 'bg-neutral-dim opacity-40'
    default: return ''
  }
}
</script>

