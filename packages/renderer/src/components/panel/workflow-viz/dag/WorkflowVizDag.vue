<!--
  WorkflowVizDag —— DAG 画布（自绘 SVG，无图库；workflow-visualization 设计 §3.2
  渲染选型 A：列式布局 + 状态点亮 + 缩放平移 + 点击上抛）。

  结构：phase 分区背景列（WorkflowDagPhase.order 升序）→ 边（顺序/数据流/条件谓词
  标注/循环回边）→ 节点卡片（per-node 包 WorkflowVizDagNodeGuard 节点级边界）。

  交互（原型 04-final-overlay.html 实测形态对齐）：
  - 缩放：wheel 指数缩放（0.35~2.6），以指针为缩放中心；
  - 平移：按住拖拽（位移 > 5px 判定 pan，抑制点击误触）；
  - 点击上抛：agent 节点 → semantic 'agent'；pending/skipped 节点（零实例、无对话
    可看——skipped = run 终局后零实例）与 phase 分区 → semantic 'phase'
    （设计 §3.1-2 点击行为边界）。

  运行实况：节点六态经 props.nodeStates 接收已派生映射（派生单处归 u5，D9 单点
  实现——本组件不自行判定 retrying/skipped）；run 停止叠加（D9）消费 run 级原始输入
  （runStatus/runOutcome）归一为 stopTone 传入节点卡片；当前 phase 分区高亮经
  props.activePhase（已派生，由壳透传）。
-->
<template>
  <div
    class="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-surface-2 active:cursor-grabbing"
    data-testid="wfvz-dag-root"
  >
    <!-- select-none 替代原 :deep(svg/g) user-select——none 经 auto 传播覆盖全部后代 -->
    <svg
      ref="svgRef"
      class="block h-full w-full select-none"
      role="img"
      :aria-label="t('panel.workflowViz.dagCanvasLabel')"
      data-testid="wfvz-dag-svg"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @wheel.prevent="onWheel"
    >
      <g :transform="`translate(${vp.tx},${vp.ty}) scale(${vp.k})`" data-testid="wfvz-dag-viewport">
        <!-- phase 分区背景列（当前 phase 高亮：accent 描边）。分区虚线描边 border-strong
             级弱化「面板感」、强化「分组感」（workflow-overlay-refine D3）；分区标签
             2xs/font-medium 与节点名 3xs 拉开半档（D3 标签档位，V1-wf③ 分层断言口径） -->
        <g
          v-for="c in layout.clusters"
          :key="c.phase"
          :data-wfvz-cluster="c.phase"
          :data-active="c.phase === activePhase ? 'true' : undefined"
          :data-testid="`wfvz-dag-cluster-${c.phase}`"
        >
          <rect
            class="fill-surface stroke-border-strong [rx:var(--radius-sm)] [stroke-dasharray:5_4]"
            :class="c.phase === activePhase ? 'stroke-accent [stroke-width:1.5]' : ''"
            :x="c.x"
            :y="c.y"
            :width="c.width"
            :height="c.height"
          />
          <text
            class="fill-neutral-mid text-[length:var(--text-2xs)] font-medium tracking-[0.03em]"
            :x="c.x + CLUSTER_TITLE_INSET"
            :y="c.y + CLUSTER_TITLE_H_BASE"
          >{{ c.phase }}</text>
        </g>

        <!-- 边：kind 着色（sequence 灰 / dataflow 实线深 / conditional 虚线 warn / loop-back 虚线 accent 下绕弧） -->
        <path
          v-for="le in edges"
          :key="le.edge.id"
          class="fill-none"
          :class="EDGE_KIND_CLASS[le.edge.kind]"
          :d="le.d"
          :data-testid="`wfvz-dag-edge-${le.edge.id}`"
        />
        <!-- 条件边谓词标注（原文截断，title 悬停全文） -->
        <text
          v-for="le in conditionalEdges"
          :key="`label-${le.edge.id}`"
          class="fill-warn text-[10px] font-mono"
          :x="le.labelX"
          :y="le.labelY"
        >
          <title>{{ le.edge.predicate }}</title>
          {{ truncate(le.edge.predicate ?? '', PREDICATE_MAX_CHARS) }}
        </text>

        <!-- 节点卡片（per-node 边界：单节点渲染失败 = 占位错误态，不挂整画布）；
             data-stop-tone 同值绑外层与节点卡片根（测试观察锚点，非 CSS 选择器——
             着色由节点卡片 tone computed 整组切换 Tailwind 类） -->
        <g
          v-for="ln in layout.nodes"
          :key="ln.node.id"
          :transform="`translate(${ln.x},${ln.y})`"
          :data-wfvz-node="ln.node.id"
          :data-wfvz-phase="ln.node.phase"
          :data-state="nodeState(ln.node.id)"
          :data-stop-tone="stopTone ?? undefined"
          :data-testid="`wfvz-dag-node-${ln.node.id}`"
        >
          <WorkflowVizDagNodeGuard>
            <WorkflowVizDagNode
              :node="ln.node"
              :status="nodeState(ln.node.id)"
              :stop-tone="stopTone"
            />
          </WorkflowVizDagNodeGuard>
        </g>
      </g>
    </svg>

    <!-- 零节点 run（纯门禁脚本无 agent()）：空画布 + 居中摘要提示（设计 §3.1-3） -->
    <div
      v-if="isEmptyDag"
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1"
      data-testid="wfvz-dag-empty"
    >
      <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('panel.workflowViz.noAgentCalls') }}</p>
      <p class="text-[length:var(--text-3xs)] text-neutral-dim">{{ t('panel.workflowViz.noAgentCallsHint') }}</p>
    </div>

    <!-- 操作提示角标 -->
    <span
      class="pointer-events-none absolute bottom-2 right-3 text-[length:var(--text-3xs)] text-neutral-faint"
      data-testid="wfvz-dag-hint"
    >{{ t('panel.workflowViz.dagZoomHint') }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WorkflowDag, WorkflowDagEdgeKind, WorkflowRunOutcome, WorkflowRunStatus } from '@taiji/shared'
import { layoutDag, layoutEdges } from './layout'
import WorkflowVizDagNode from './WorkflowVizDagNode.vue'
import WorkflowVizDagNodeGuard from './WorkflowVizDagNodeGuard.vue'
import type { WorkflowVizDagClickPayload, WorkflowVizDagNodeStatus, WorkflowVizDagStopTone } from './types'

const props = defineProps<{
  /** DAG 蓝图（session.getWorkflowDag 成功臂；null = 数据未就绪——空画布）。 */
  dag: WorkflowDag | null
  /**
   * 节点六态映射（nodeId → 状态）。已派生数据（D9 派生单处在 u5——retrying/skipped
   * 判定不在此实现）；缺失键按 'pending' 兜（run 运行中零实例节点一律 pending）。
   */
  nodeStates?: Record<string, WorkflowVizDagNodeStatus>
  /** run 级状态（D9 停止维度输入：非 running 时在途节点叠加停止着色）。 */
  runStatus?: WorkflowRunStatus
  /** run 终局形态（runStatus='done' 时叠加着色随 outcome；缺省保守中性）。 */
  runOutcome?: WorkflowRunOutcome
  /** 当前 phase 分区（已派生；命中分区 accent 描边高亮）。 */
  activePhase?: string | null
}>()

const emit = defineEmits<{
  /** 点击上抛：agent 节点 / pending 节点（=phase 语义）/ phase 分区三类。 */
  select: [payload: WorkflowVizDagClickPayload]
}>()

const { t } = useI18n()

/**
 * 边 kind → Tailwind 着色类（每分支给全 stroke 色 + 宽度/虚线，不做「基类 +
 * kind 覆盖」——同名 stroke-* 工具类并存时胜负取决于调色板发射序而非 class 顺序）。
 */
const EDGE_KIND_CLASS: Record<WorkflowDagEdgeKind, string> = {
  sequence: 'stroke-neutral-faint [stroke-width:1.2]',
  dataflow: 'stroke-neutral-ico [stroke-width:1.3]',
  conditional: 'stroke-warn [stroke-width:1.2] [stroke-dasharray:5_4]',
  'loop-back': 'stroke-accent [stroke-width:1.2] [stroke-dasharray:6_4]',
}

const CLUSTER_TITLE_INSET = 12
const CLUSTER_TITLE_H_BASE = 20
const PREDICATE_MAX_CHARS = 16

/** 缩放界限（原型实测手感：0.35 全局概览 ~ 2.6 单节点细节）。 */
const ZOOM_MIN = 0.35
const ZOOM_MAX = 2.6
/** wheel 缩放灵敏度（指数系数，原型同款）。 */
const ZOOM_WHEEL_FACTOR = 0.0012
/** 拖拽判定阈值（px 位移，超过 = pan 非 click）。 */
const PAN_THRESHOLD_PX = 5

const svgRef = ref<SVGSVGElement | null>(null)
/** 视口变换（tx/ty 平移 + k 缩放；初始与切换 run 重置时 tx 居中——见 centeredTx）。 */
const vp = reactive({ k: 1, tx: 0, ty: 0 })

/** dag prop 未就绪（null）时布局用的空 DAG（layoutDag/layoutEdges 均纯函数不 mutate 输入）。 */
const EMPTY_DAG: WorkflowDag = { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] }

const layout = computed(() => layoutDag(props.dag ?? EMPTY_DAG))
const edges = computed(() => layoutEdges(props.dag ?? EMPTY_DAG, layout.value.nodes))
const conditionalEdges = computed(() => edges.value.filter((le) => le.edge.kind === 'conditional' && le.edge.predicate))
const isEmptyDag = computed(() => (props.dag?.nodes.length ?? 0) === 0)

function nodeState(nodeId: string): WorkflowVizDagNodeStatus {
  return props.nodeStates?.[nodeId] ?? 'pending'
}

/**
 * D9 停止叠加归一（叠加两档只属于「被停止的 run」，正常完成不是停止）：
 * run 运行中 = null（无叠加，在途节点正常蓝脉冲）；outcome='done' = null（正常
 * 完成的 run 六态自明——done 节点 success 绿与 skipped 虚线不被叠加吞掉，D9
 * 「DAG done = success 供扫读」）；interrupted（暂停）与 cancelled（用户主动终局）
 * 落中性暗（tray-tone「同语义同色」先例）；failed / time_limited 落失败色系
 * （D9 着色映射全枚举）；done + outcome 缺省（v1 存量数据缺口）保守中性暗，
 * 不作成败断言。
 */
const stopTone = computed<WorkflowVizDagStopTone>(() => {
  if (props.runStatus === undefined || props.runStatus === 'running') return null
  if (props.runStatus === 'interrupted') return 'neutral'
  if (props.runOutcome === 'failed' || props.runOutcome === 'time_limited') return 'failed'
  if (props.runOutcome === 'done') return null
  return 'neutral'
})

// 切换 run（D11：开新 run 切内容）→ 画布视口重置（新蓝图从全局概览起步）
watch(() => props.dag, () => {
  vp.k = 1
  vp.tx = centeredTx()
  vp.ty = 0
})

/**
 * 初始视口水平居中（workflow-overlay-refine D1 / 走查 edge#12：上区内容水平对中，
 * 全宽上区不留画布贴左的大段右空白）。mock `.dag-stage` 的 justify-content:center
 * 在自绘 SVG 语境的等价实现：内容位置由 viewport transform 决定，居中 = tx 取容器
 * 与画布的半余宽；画布更宽时贴 0（k 恒 1，C1 已关闭——不引入 fit）。容器尺寸无布局
 * 环境（jsdom clientWidth 缺失）→ 0，退化为贴左不破坏渲染。窗口 resize 不追居中：
 * pan 可达且属用户主动交互，不属本机制。
 */
// 中点除数（余宽的一半 = 水平居中偏移）；具名以过 no-magic-numbers
const HALF = 2

function centeredTx(): number {
  const containerW = svgRef.value?.clientWidth ?? 0
  return Math.max(0, (containerW - layout.value.width) / HALF)
}

// 打开 overlay 即挂载（壳 v-if dag !== null）→ 初始视口按容器宽居中
onMounted(() => {
  vp.tx = centeredTx()
})

// ── 缩放平移（原型 04-final-overlay.html 手法：client 坐标差换算，规避
// getScreenCTM 在测试环境缺失；pan 位移按 1/k 修正保持视觉等速）。
// 指针事件经 setPointerCapture 锁定到 svg（指针移出画布释放/移动仍可达——W3C
// 指针捕获语义，比 window 级监听干净且无泄漏；环境不支持 capture 时退化为
// 画布内交互，拖出释放的边缘场景丢失可接受） ──

interface PanState {
  sx: number
  sy: number
  tx0: number
  ty0: number
  moved: boolean
  target: EventTarget | null
}
let pan: PanState | null = null

function onPointerDown(e: PointerEvent): void {
  pan = { sx: e.clientX, sy: e.clientY, tx0: vp.tx, ty0: vp.ty, moved: false, target: e.target }
  const svg = svgRef.value
  if (svg && typeof svg.setPointerCapture === 'function') {
    try {
      svg.setPointerCapture(e.pointerId)
    } catch (err) {
      // 捕获失败（指针已释放等竞态）：退化画布内交互（拖出释放的边缘场景丢失），不阻断
      console.warn('[WorkflowVizDag] setPointerCapture failed, fallback to in-canvas pan', err)
    }
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!pan) return
  if (Math.abs(e.clientX - pan.sx) + Math.abs(e.clientY - pan.sy) > PAN_THRESHOLD_PX) pan.moved = true
  if (pan.moved) {
    vp.tx = pan.tx0 + (e.clientX - pan.sx) / vp.k
    vp.ty = pan.ty0 + (e.clientY - pan.sy) / vp.k
  }
}

function onPointerUp(): void {
  const wasClick = pan !== null && !pan.moved
  const target = pan?.target ?? null
  pan = null
  if (!wasClick) return
  routeClick(target)
}

/** wheel 缩放：以指针位置为缩放中心（画布坐标系下保持指针下的内容点不动）。 */
function onWheel(e: WheelEvent): void {
  const rect = svgRef.value?.getBoundingClientRect()
  if (!rect) return
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  const k2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, vp.k * Math.exp(-e.deltaY * ZOOM_WHEEL_FACTOR)))
  // 保持指针下的画布坐标点不动：new_tx = px - (px - tx) * (k2/k)
  vp.tx = px - (px - vp.tx) * (k2 / vp.k)
  vp.ty = py - (py - vp.ty) * (k2 / vp.k)
  vp.k = k2
}

/**
 * 点击路由：节点优先，其次 phase 分区。节点按渲染态分语义——pending（运行中零实例）
 * 与 skipped（run 终局后零实例）同为「零实例、无对话可看」，点击均开所属 phase tab
 * 而非落 agent 语义（Host 侧 byNode 空导致静默 no-op，设计 §3.1-2 点击行为边界）。
 */
function routeClick(target: EventTarget | null): void {
  const el = target as Element | null
  if (!el || typeof (el as Element).closest !== 'function') return
  const nodeEl = (el as Element).closest('[data-wfvz-node]')
  if (nodeEl) {
    const id = nodeEl.getAttribute('data-wfvz-node') ?? ''
    const node = props.dag?.nodes.find((n) => n.id === id)
    if (!node) return
    const state = nodeState(id)
    if (state === 'pending' || state === 'skipped') {
      emit('select', { semantic: 'phase', phase: node.phase })
    } else {
      emit('select', { semantic: 'agent', nodeId: id, templateName: node.templateName, phase: node.phase })
    }
    return
  }
  const clusterEl = (el as Element).closest('[data-wfvz-cluster]')
  if (clusterEl) {
    emit('select', { semantic: 'phase', phase: clusterEl.getAttribute('data-wfvz-cluster') ?? '' })
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
</script>

