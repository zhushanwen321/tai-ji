<!--
  CanvasGraph —— 画布图渲染视口（problem-solve-canvas §3.1(3)，demo v3 画布段内核平移）。

  三层结构（demo 同构）：transform 视口（平移缩放，wheel 缩放 / 拖拽平移 / 空白单击
  取消选中）> SVG 边层（decompose/resolve 主干边 + 支撑度缺口/不成立线上标记）+
  节点卡组件树（CanvasNodeCard，question/option 占画布位）。约束节点不进主干流，
  底部约束带横条呈现；否决折叠（collapsedRej）整支让位重排。

  高度实测重排：ResizeObserver 读节点卡 offsetHeight 回填 realH，布局随之重算
  （demo measureNodes/observeNodes 同款；观察器缺失（测试环境）回落估高，布局仍确定）。
  fitView 包围盒适配 + 缩放档位 [0.28, 1.6]；transform-origin 0 0。
  纯渲染编排：状态全部来自 props（state + selectedId），交互上抛 select/dispatch。
-->
<template>
  <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-canvas">
    <div
      ref="viewportRef"
      class="absolute inset-0 cursor-grab touch-none"
      :class="{ 'cursor-grabbing': dragging }"
      data-testid="canvas-viewport"
      @wheel.prevent="onWheel"
      @mousedown="onDown"
      @mousemove="onMove"
      @mouseup="onUp"
      @mouseleave="onUp"
    >
      <div
        class="absolute left-0 top-0 origin-top-left"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${k})` }"
        data-testid="canvas-plane"
      >
        <div
          class="pointer-events-none absolute left-0 top-0"
          :style="{ width: `${layout.bbox.x2 + 900}px`, height: `${layout.bbox.y2 + 900}px` }"
        />
        <svg
          :width="layout.bbox.x2 + 600"
          :height="layout.bbox.y2 + 600"
          class="absolute left-0 top-0 overflow-visible"
          data-testid="canvas-edges-svg"
        >
          <defs>
            <marker id="canvas-arrow-resolve" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="currentColor" class="text-neutral-mid" />
            </marker>
          </defs>
          <g v-for="e in visEdges" :key="e.id">
            <path
              class="pointer-events-auto fill-none stroke-transparent! stroke-[14px]"
              :d="pathOf(e)"
              style="cursor: pointer"
              @click.stop="emit('select', e.to)"
            />
            <path
              class="pointer-events-none fill-none stroke-neutral-mid"
              :class="edgeClass(e)"
              :style="e.type === 'resolve' ? { markerEnd: 'url(#canvas-arrow-resolve)' } : undefined"
              :d="pathOf(e)"
              :data-testid="`canvas-edge-${e.type}`"
              :data-edge-id="e.id"
            />
            <!-- 支撑度缺口 / 不成立：线上标记徽标（demo emark 平移；审查轮次溯源入口） -->
            <g
              v-if="e.support?.rating === 'gap' || e.support?.rating === 'invalid'"
              class="cursor-pointer"
              @click.stop="emit('select', e.to)"
            >
              <rect
                :x="midX(e) - 30"
                :y="midY(e) - 10"
                width="60"
                height="20"
                rx="10"
                class="fill-surface"
                :class="e.support.rating === 'gap' ? 'stroke-warn' : 'stroke-danger'"
                stroke-width="1"
              />
              <text
                :x="midX(e)"
                :y="midY(e) + 3.5"
                text-anchor="middle"
                class="fill-current font-mono text-[10px] font-bold"
                :class="e.support.rating === 'gap' ? 'text-warn' : 'text-danger'"
              >{{ e.support.rating === 'gap' ? t('panel.canvas.edgeGap') : t('panel.canvas.edgeInvalid') }}</text>
            </g>
          </g>
        </svg>

        <!-- 主干节点卡（question/option；argument 收宿主卡内、constraint 进底部带） -->
        <template v-for="[id, node] of trunkNodes" :key="id">
          <CanvasNodeCard
            v-if="layout.pos.get(id) && !hiddenOf(id)"
            :node="node"
            :pos="layout.pos.get(id)!"
            :args="argsOfHost(state, id)"
            :can-dispatch="canDispatchIds.has(id)"
            :dirty="isDirtyPath(state, id)"
            :comment-count="commentsOfAnchor(state, id).length"
            :pending-comments="pendingCommentCountOf(state, id)"
            :focused="selectedId === id"
            :rebutted-ids="rebuttedIds"
            :rejected-kids="rejectedKidsCountOf(state, id)"
            :collapsed="collapsedRej"
            :selected-arg-id="selectedId && isArgumentId(selectedId) ? selectedId : null"
            :muted="focusSet !== null && !focusSet.has(id)"
            @select="(nid) => emit('select', nid)"
            @dispatch="(nid) => emit('dispatch', nid)"
            @toggle-collapse="collapsedRej = !collapsedRej"
          />
        </template>
      </div>
    </div>

    <!-- 底部约束带（约束节点不进主干流——布局法则 3；constrain 作用边第二版） -->
    <div
      v-if="constraintNodes.length > 0"
      class="absolute bottom-3 left-1/2 z-10 flex max-w-[58%] -translate-x-1/2 items-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-hairline bg-surface px-3 py-1.5"
      data-testid="canvas-constraint-band"
    >
      <span class="flex-none font-mono text-[length:var(--text-3xs)] font-semibold text-neutral-dim">{{ t('panel.canvas.constraintBand') }}</span>
      <Button
        v-for="c in constraintNodes"
        :key="c.id"
        variant="ghost"
        size="sm"
        class="min-w-0 truncate px-1 py-0.5 text-[length:var(--text-2xs)] text-neutral-fg"
        @click.stop="emit('select', c.id)"
      >{{ c.content }}</Button>
    </div>

    <!-- 缩放控制（右下竖排：放大 / 缩小 / 适应视图） -->
    <div class="absolute bottom-3 right-3 z-10 flex flex-col gap-1.5" data-testid="canvas-zoom-controls">
      <Button variant="secondary" size="sm" class="size-8 p-0 font-mono" data-testid="canvas-zoom-in" @click="zoomCenter(ZOOM_STEP)">＋</Button>
      <Button variant="secondary" size="sm" class="size-8 p-0 font-mono" data-testid="canvas-zoom-out" @click="zoomCenter(1 / ZOOM_STEP)">－</Button>
      <Button variant="secondary" size="sm" class="size-8 p-0 font-mono" :title="t('panel.canvas.fitView')" data-testid="canvas-fit-view" @click="fitViewManual">⤢</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CanvasEdge, CanvasNode, CanvasState } from '@zhushanwen/extension-protocol'
import { Button } from '@/components/ui/button'
import {
  argsOfHost,
  commentsOfAnchor,
  computeCanvasLayout,
  dispatchableLeavesOf,
  edgePathOf,
  isDirtyPath,
  pendingCommentCountOf,
  rejectedKidsCountOf,
  trunkEdgesOf,
  type CanvasLayout,
} from './canvas-display'
import { useCanvasViewport } from './use-canvas-viewport'
import CanvasNodeCard from './CanvasNodeCard.vue'

const props = defineProps<{
  state: CanvasState
  selectedId: string | null
}>()

const emit = defineEmits<{
  /** 选中上抛（节点 / 论据 / 边目标 / null=取消）。 */
  select: [nodeId: string | null]
  /** 派发意图（执行叶子卡按钮 → CanvasPane 开派发对话框）。 */
  dispatch: [nodeId: string]
}>()

const { t } = useI18n()

// ── 布局输入（否决折叠 + 高度实测；数值档位常量单点，demo v3 同值平移）───────

// 首帧估高档位（demo estH 简化口径：标题行 + 论据条占位；实测回填后即被覆盖）
const EST_TITLE_CHAR_PER_LINE = 20
const EST_TITLE_MAX_LINES = 3
const EST_BASE_HEIGHT = 58
const EST_TITLE_LINE_HEIGHT = 20
const EST_STRIP_BASE = 24
const EST_STRIP_ROW = 22
const EST_STRIP_MAX_ROWS = 4
const EST_REJECTED_CHIP = 28
const EST_HEIGHT_FACTOR = 1.08
/** 节点缺失时的估高兜底（与 canvas-display MIN_BBOX_HEIGHT 同档占位）。 */
const MIN_BBOX_FALLBACK_HEIGHT = 96
// 主干边渲染档位（demo edgeCls：decompose 粗实线 / resolve 实线箭头）
const EDGE_STROKE_DECOMPOSE = 'stroke-[2px]'
const EDGE_STROKE_RESOLVE = 'stroke-[1.5px]'
const EDGE_STROKE_MARKED = 'stroke-[1.8px]'
// 中点除数（no-magic-numbers 命名收敛）
const MIDPOINT_DIVISOR = 2

const collapsedRej = ref(true)

/** 否决折叠判据：selected 方案的 rejected 分支整支让位（rejected 折叠不消失——chip 可展开）。 */
function hiddenOf(id: string): boolean {
  const n = nodeById(id)
  return n?.type === 'option' && n.lifecycle === 'rejected' && collapsedRej.value && !n.selected
}

function nodeById(id: string): CanvasNode | undefined {
  return props.state.nodes.find((n) => n.id === id)
}

/** 主干节点（question/option）。 */
const trunkNodes = computed<Array<[string, CanvasNode]>>(() =>
  props.state.nodes
    .filter((n) => n.type === 'question' || n.type === 'option')
    .map((n) => [n.id, n]),
)

/** 主干边（隐藏目标边不渲染——折叠子树的边随节点让位）。 */
const visEdges = computed<CanvasEdge[]>(() =>
  trunkEdgesOf(props.state).filter((e) => !hiddenOf(e.from) && !hiddenOf(e.to)),
)

/** 约束节点（底部带呈现）。 */
const constraintNodes = computed<CanvasNode[]>(() =>
  props.state.nodes.filter((n) => n.type === 'constraint'),
)

// 高度实测（demo realH 同款）：DOM offsetHeight 回填，布局随之重算；观察器缺失回落估高。
const realH = ref(new Map<string, number>())
let resizeObserver: ResizeObserver | null = null

function heightOf(id: string): number {
  return realH.value.get(id) ?? estHeightOf(id)
}

/** 首帧估高（demo estH 简化：标题行数 + 论据条占位；仅首帧占位，实测后即被覆盖）。 */
function estHeightOf(id: string): number {
  const n = nodeById(id)
  if (!n) return MIN_BBOX_FALLBACK_HEIGHT
  const lines = Math.min(EST_TITLE_MAX_LINES, Math.ceil(n.content.length / EST_TITLE_CHAR_PER_LINE))
  let h = EST_BASE_HEIGHT + lines * EST_TITLE_LINE_HEIGHT
  const args = argsOfHost(props.state, id)
  h += stripH(args.support) + stripH(args.object)
  if (rejectedKidsCountOf(props.state, id) > 0) h += EST_REJECTED_CHIP
  return Math.ceil(h * EST_HEIGHT_FACTOR)
}

function stripH(list: CanvasNode[]): number {
  return list.length > 0 ? EST_STRIP_BASE + Math.min(list.length, EST_STRIP_MAX_ROWS) * EST_STRIP_ROW : 0
}

const layout = computed<CanvasLayout>(() =>
  computeCanvasLayout(props.state, { heightOf, hidden: hiddenOf }),
)

function observeNodeHeights(): void {
  if (resizeObserver === null) return
  const rootEl = viewportRef.value
  if (!rootEl) return
  rootEl.querySelectorAll<HTMLElement>('[data-node-id]').forEach((el) => {
    const id = el.dataset['nodeId']
    const h = el.offsetHeight
    if (id && h > 0 && realH.value.get(id) !== h) realH.value.set(id, h)
    resizeObserver?.observe(el)
  })
}

onMounted(() => {
  observeNodeHeights()
  // 首帧适配（DOM 就绪后；此后布局 bbox 每次变化由下方 watch 继续跟随）
  if (!isViewportAdjusted()) fitView()
})

watch(
  () => [props.state.updatedAt, collapsedRej.value],
  async () => {
    await nextTick()
    observeNodeHeights()
  },
)

/**
 * 首帧自适应全景：用户未接管视口前，布局 bbox 每次变化（数据装载 / 高度实测
 * 回填 / 折叠重排）都重新适配全景——fit 不再只依赖挂载单帧。接管后（拖拽 /
 * 缩放 / 手动 fit）自动适配停止，用户调整优先。
 */
watch(
  () => layout.value.bbox,
  () => {
    if (!isViewportAdjusted()) fitView()
  },
)

/** 手动 fit（右下按钮）：视口自此归用户接管，后续布局变化不再自动重置。 */
function fitViewManual(): void {
  markViewportAdjusted()
  fitView()
}

// ── 派发 / 互驳 / 焦点派生 ──────────────────────────────────────────────────

/** 派发按钮可见集：执行叶子 + passed + 未派发（不变量 7 的 UI 预判；runtime 仍权威）。 */
const canDispatchIds = computed<Set<string>>(() => {
  const out = new Set<string>()
  for (const leaf of dispatchableLeavesOf(props.state)) {
    if (leaf.lifecycle === 'passed' && !leaf.dispatch) out.add(leaf.id)
  }
  return out
})

/** 被反驳论据 id 集（互驳徽标）。 */
const rebuttedIds = computed<Set<string>>(() => {
  const out = new Set<string>()
  for (const e of props.state.edges) {
    if (e.type === 'rebut') out.add(e.to)
  }
  return out
})

function isArgumentId(id: string): boolean {
  return nodeById(id)?.type === 'argument'
}

/** 焦点路径（根 → 选中节点上溯链高亮；论据选中亮宿主链，其余子树降透明）。 */
const focusSet = computed<Set<string> | null>(() => {
  if (!props.selectedId) return null
  let p = props.selectedId
  if (isArgumentId(p)) {
    const arg = props.state.edges.find((e) => e.type === 'argue' && e.from === p)
    if (!arg) return null
    p = arg.to
  }
  // to → from 反查上溯（trunk 边 from=parent）
  const parentOf = new Map<string, string>()
  for (const e of trunkEdgesOf(props.state)) {
    if (!parentOf.has(e.to)) parentOf.set(e.to, e.from)
  }
  const set = new Set<string>()
  while (p) {
    set.add(p)
    if (p === props.state.root.nodeId) break
    p = parentOf.get(p) ?? ''
  }
  return set
})

// ── 边渲染 ──────────────────────────────────────────────────────────────────

function pathOf(e: CanvasEdge): string {
  const a = layout.value.pos.get(e.from)
  const b = layout.value.pos.get(e.to)
  if (!a || !b) return ''
  return edgePathOf(a, b, e.type)
}

function edgeClass(e: CanvasEdge): string[] {
  const cls = [e.type === 'decompose' ? EDGE_STROKE_DECOMPOSE : EDGE_STROKE_RESOLVE]
  if (e.support?.rating === 'gap') cls.push('stroke-warn', EDGE_STROKE_MARKED, 'stroke-dashed')
  if (e.support?.rating === 'invalid') cls.push('stroke-danger', EDGE_STROKE_MARKED, 'stroke-dashed')
  const toNode = nodeById(e.to)
  if (toNode?.lifecycle === 'rejected') cls.push('opacity-40')
  if (props.state.dirtyPaths.includes(e.from) && props.state.dirtyPaths.includes(e.to)) cls.push('stroke-dashed')
  return cls
}

function midX(e: CanvasEdge): number {
  const a = layout.value.pos.get(e.from)
  const b = layout.value.pos.get(e.to)
  if (!a || !b) return 0
  return (a.x + a.w / MIDPOINT_DIVISOR + b.x + b.w / MIDPOINT_DIVISOR) / MIDPOINT_DIVISOR
}

function midY(e: CanvasEdge): number {
  const a = layout.value.pos.get(e.from)
  const b = layout.value.pos.get(e.to)
  if (!a || !b) return 0
  return (a.y + a.h + b.y) / MIDPOINT_DIVISOR
}

// ── 视口变换（useCanvasViewport 单处实现；空白单击判据在组件层）──────────────

const {
  viewportRef,
  k,
  tx,
  ty,
  dragging,
  zoomCenter,
  onWheel,
  onDown,
  onMove,
  onUp: viewportUp,
  fitView,
  isViewportAdjusted,
  markViewportAdjusted,
  ZOOM_STEP,
} = useCanvasViewport(computed(() => layout.value.bbox))

function onUp(e: MouseEvent): void {
  // 空白单击（非拖拽、非节点/SVG 边/控件）取消选中——详情面板回到空态引导
  const { blankClick } = viewportUp()
  if (!blankClick) return
  const el = e.target as HTMLElement | null
  const onBlank =
    el !== null
    && el.closest('[data-node-id]') === null
    && el.closest('button') === null
    && el.tagName !== 'svg'
    && el.tagName !== 'path'
  if (onBlank) emit('select', null)
}
</script>
