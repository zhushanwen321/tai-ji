<!--
  WorkflowVizDag —— DAG 画布（自绘 SVG，无图库；workflow-visualization 设计 §3.2
  渲染选型 A：列式布局 + 状态点亮 + 缩放平移 + 点击上抛）。

  结构：phase 分区背景列（WorkflowDagPhase.order 升序）→ 边（顺序/数据流/条件谓词
  标注/循环回边）→ 节点卡片（per-node 包 WorkflowVizDagNodeGuard 节点级边界）。

  交互：
  - 视口（fit/free 二态状态机，2026-10-23 设计裁决）：fit 态 = 全图自适应
    （computeFitTransform 缩放到四周留 FIT_PAD_PX 空隙并居中，内容小于视口不放大
    k 封顶 1；容器尺寸变化经 ResizeObserver 重新 fit——含挂载时容器未布局的
    首次就绪补 fit）；用户接管即转 free 态——自动 fit 停用（容器变化、实例流式
    到达引起的节点增高不追打，不与用户手势竞争），右下角出「回到全景」入口
    （点击回 fit 态并 fit 一次，此后恢复自动 fit 直至下次接管）。接管判定：
    拖拽位移超 PAN_THRESHOLD_PX 的 pan 与 wheel 缩放算接管，pointerdown 未移动
    不算（纯点击）；程序化写视口（fitView 及其全部调用路径）结构性不触发接管
    ——转 free 只存在于两个手势处理器内；切 run 重置回 fit 态；
  - 点击上抛（[2026-10-19] agent 钻取语义删除，钻取入口 = 下方实例 trace 行）：
    pending/skipped 节点（零实例、无对话可看——skipped = run 终局后零实例）与
    phase 分区 → semantic 'phase'（设计 §3.1-2 点击行为边界）；其余节点/实例行
    no-op（纯展示）。

  运行实况：节点七态经 props.nodeStates 接收已派生映射（派生单处归 u5，D9 单点
  实现——本组件不自行判定 retrying/skipped）；执行实例经 props.instancesByNode
  接收已匹配映射（D2 产物，宿主单处派生），用于节点实例行渲染与增高节点的布局
  高度表；run 停止叠加（D9）消费 run 级原始输入（runStatus/runOutcome）归一为
  stopTone 传入节点卡片；当前 phase 分区高亮经 props.activePhase（已派生，由壳
  透传）。
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
      <!-- 边方向箭头（单一 marker + context-stroke 继承各边 kind 描边色——Chromium
           119+ 支持；markerUnits=userSpaceOnUse 随视口缩放同步，与线宽同比） -->
      <defs>
        <marker
          id="wfvz-dag-arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
          markerUnits="userSpaceOnUse"
          data-testid="wfvz-dag-arrow-def"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
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

        <!-- 边：kind 着色（sequence 灰 / dataflow 实线深 / conditional 虚线 warn / loop-back 虚线 accent 下绕弧）；
             marker-end 箭头标流向（tip 落在目标锚点 = 节点边中点） -->
        <path
          v-for="le in edges"
          :key="le.edge.id"
          class="fill-none"
          :class="EDGE_KIND_CLASS[le.edge.kind]"
          :d="le.d"
          marker-end="url(#wfvz-dag-arrow)"
          :data-testid="`wfvz-dag-edge-${le.edge.id}`"
        />
        <!-- 条件边谓词标注（原文截断，title 悬停全文） -->
        <text
          v-for="le in conditionalEdges"
          :key="`label-${le.edge.id}`"
          class="fill-warn text-[length:var(--text-3xs)] font-mono"
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
              :instances="instancesByNode?.get(ln.node.id)"
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

    <!-- free 态右下角「回到全景」（接管后自动 fit 停用的唯一恢复入口）；fit 态该
         位置为操作提示角标——两态互斥占位，零布局冲突 -->
    <Button
      v-if="viewMode === 'free'"
      variant="secondary"
      size="dense"
      class="absolute bottom-2 right-3 h-6 gap-1 rounded-sm px-2 text-[length:var(--text-2xs)]"
      data-testid="wfvz-dag-back-to-fit"
      @click="backToFit"
    >{{ t('panel.workflowViz.dagBackToFit') }}</Button>
    <span
      v-else
      class="pointer-events-none absolute bottom-2 right-3 text-[length:var(--text-3xs)] text-neutral-faint"
      data-testid="wfvz-dag-hint"
    >{{ t('panel.workflowViz.dagZoomHint') }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WorkflowAgentCall, WorkflowDag, WorkflowDagEdgeKind, WorkflowRunOutcome, WorkflowRunStatus } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { ZOOM_MIN, computeFitTransform, dagNodeHeight, layoutDag, layoutEdges } from './layout'
import WorkflowVizDagNode from './WorkflowVizDagNode.vue'
import WorkflowVizDagNodeGuard from './WorkflowVizDagNodeGuard.vue'
import type { WorkflowVizDagClickPayload, WorkflowVizDagNodeStatus, WorkflowVizDagStopTone } from './types'

const props = defineProps<{
  /** DAG 蓝图（session.getWorkflowDag 成功臂；null = 数据未就绪——空画布）。 */
  dag: WorkflowDag | null
  /**
   * 节点七态映射（nodeId → 状态）。已派生数据（D9 派生单处在 u5——retrying/skipped
   * 判定不在此实现）；缺失键按 'pending' 兜（run 运行中零实例节点一律 pending）。
   */
  nodeStates?: Record<string, WorkflowVizDagNodeStatus>
  /** run 级状态（D9 停止维度输入：非 running 时在途节点叠加停止着色）。 */
  runStatus?: WorkflowRunStatus
  /** run 终局形态（runStatus='done' 时叠加着色随 outcome；缺省保守中性）。 */
  runOutcome?: WorkflowRunOutcome
  /** 当前 phase 分区（已派生；命中分区 accent 描边高亮）。 */
  activePhase?: string | null
  /**
   * 执行实例挂接映射（D2 匹配单源 matchInstancesToNodes().byNode，宿主单处派生；
   * nodeId → 实例列表 taskIndex 升序）。画布消费两处：节点实例行渲染 + 增高节点
   * 的布局高度表。缺省（数据未就绪）= 全部节点零实例形态（模板名标题、基准高）。
   */
  instancesByNode?: Map<string, WorkflowAgentCall[]>
}>()

const emit = defineEmits<{
  /** 点击上抛：pending/skipped 节点（=phase 语义）/ phase 分区（agent 钻取语义已删）。 */
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
/** 条件谓词标注显示截断上限（px 布局友好宽度内的可读性上界；完整原文走 title 悬停）。
 *  40 字符容下常规布尔条件全文（如 `commitPlan.stagePaths.length === 0`），更长的
 *  仍截断省略。 */
const PREDICATE_MAX_CHARS = 40

/** wheel 缩放灵敏度（指数系数，原型同款）。 */
const ZOOM_WHEEL_FACTOR = 0.0012
/** wheel 缩放上限（下限 ZOOM_MIN 单处在 layout，fit 与手动缩放共用同值）。 */
const ZOOM_MAX = 2.6
/** 拖拽判定阈值（px 位移，超过 = pan 非 click）。 */
const PAN_THRESHOLD_PX = 5

const svgRef = ref<SVGSVGElement | null>(null)
/** 视口变换（tx/ty 平移 + k 缩放；初始与切换 run 重置时 tx 居中——见 centeredTx）。 */
const vp = reactive({ k: 1, tx: 0, ty: 0 })

/**
 * 视口模式状态机（2026-10-23 设计裁决「fit 不追打」）：'fit' = 全图自适应态
 * （挂载/切 run/回到全景时进入，容器尺寸变化自动重新 fit）；'free' = 用户接管态
 * （pan 位移超阈值或 wheel 缩放触发，自动 fit 停用，直至回到全景或切 run 重置）。
 * 转 'free' 只存在于两个用户手势处理器内（onPointerMove 的 moved 分支 / onWheel）
 * ——程序化写视口（fitView 及其调用路径：挂载、切 run、ResizeObserver 回调、
 * 回到全景按钮）结构性不可能触发接管。
 */
type ViewMode = 'fit' | 'free'
const viewMode = ref<ViewMode>('fit')

/** dag prop 未就绪（null）时布局用的空 DAG（layoutDag/layoutEdges 均纯函数不 mutate 输入）。 */
const EMPTY_DAG: WorkflowDag = { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] }

/**
 * 增高节点的布局高度表（≥2 实例的节点按 dagNodeHeight 增高；与节点卡片同一
 * 高度函数——布局几何与卡片渲染单源，不会出现卡片溢出分区矩形）。
 */
/** 触发节点增高的最少实例数（单实例并入标题不增高）。 */
const TALL_NODE_MIN_INSTANCES = 2
const nodeHeights = computed(() => {
  const heights = new Map<string, number>()
  const byNode = props.instancesByNode
  if (byNode === undefined) return heights
  for (const [id, calls] of byNode) {
    if (calls.length >= TALL_NODE_MIN_INSTANCES) heights.set(id, dagNodeHeight(calls.length))
  }
  return heights
})

const layout = computed(() => layoutDag(props.dag ?? EMPTY_DAG, nodeHeights.value))
const edges = computed(() => layoutEdges(props.dag ?? EMPTY_DAG, layout.value.nodes))
const conditionalEdges = computed(() => edges.value.filter((le) => le.edge.kind === 'conditional' && le.edge.predicate))
const isEmptyDag = computed(() => (props.dag?.nodes.length ?? 0) === 0)

function nodeState(nodeId: string): WorkflowVizDagNodeStatus {
  return props.nodeStates?.[nodeId] ?? 'pending'
}

/**
 * D9 停止叠加归一（叠加两档只属于「被停止的 run」，正常完成不是停止）：
 * run 运行中 = null（无叠加，在途节点正常蓝脉冲）；outcome='done' = null（正常
 * 完成的 run 七态自明——done 节点 success 绿与 skipped 虚线不被叠加吞掉，D9
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

// 切换 run（D11：开新 run 切内容）→ 视口重置为新蓝图的 fit（全图居中、四周
// FIT_PAD_PX 留白）+ 状态机回 fit 态：此前用户 pan/zoom 接管过也在重置中放弃，
// 此后恢复自动 fit 直至下次接管
watch(() => props.dag, () => {
  viewMode.value = 'fit'
  fitWhenContainerReady()
})

/**
 * fit-to-view（fit 态的视口写入单源）：内容缩放到四周各留 FIT_PAD_PX 空隙后居中；
 * 内容小于视口不放大（k 封顶 1，文字原生渲染）。容器尺寸无布局环境（jsdom
 * clientWidth 缺失）→ computeFitTransform 退化 k=1 平移 0，不破坏渲染。实例流式
 * 到达的节点增高不触发本函数（布局变化不改视口——free 态不与用户手势竞争，
 * fit 态下内容仍完整可达无需重 fit）。
 */
function fitView(): void {
  const fit = computeFitTransform(
    svgRef.value?.clientWidth ?? 0,
    svgRef.value?.clientHeight ?? 0,
    layout.value.width,
    layout.value.height,
  )
  vp.k = fit.k
  vp.tx = fit.tx
  vp.ty = fit.ty
}

/**
 * fit 前的容器尺寸就绪闸（挂载过渡态竞态）：overlay 刚挂载时容器可能尚未布局
 * （宽高均为 0 的过渡态）——此时 fit 只得 k=1 平移 0 的退化形态（内容宽于视口
 * 即裁切）。就绪 = 任一轴有布局（> 0），与 computeFitTransform 的单轴参与口径
 * 对齐（缺席轴不参与约束、该向偏移取 0）；未就绪时不 fit，由持续 ResizeObserver
 * 在 fit 态下首次非零尺寸回调补 fit。
 */
function containerSizeReady(): boolean {
  const el = svgRef.value
  return (el?.clientWidth ?? 0) > 0 || (el?.clientHeight ?? 0) > 0
}

function fitWhenContainerReady(): void {
  if (containerSizeReady()) fitView()
}

/**
 * 容器尺寸持续观察（fit 态自动重新 fit 的驱动源）：fit 态下容器变化（窗口拖宽、
 * overlay 布局就绪）→ 重新 fit；free 态 → 不动（用户接管后自动 fit 停用）。
 * 环境无 ResizeObserver（jsdom）时不观察，维持既有退化口径（挂载时一次性 fit）。
 */
let resizeObserver: ResizeObserver | null = null

// 打开 overlay 即挂载（壳 v-if dag !== null）→ 初始视口 = 全图 fit 居中
// （容器未布局时不 fit，观察器回调就绪后补 fit）
onMounted(() => {
  fitWhenContainerReady()
  const el = svgRef.value
  if (el === null || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(() => {
    if (viewMode.value !== 'fit' || !containerSizeReady()) return
    fitView()
  })
  resizeObserver.observe(el)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

/**
 * 「回到全景」入口（free 态右下角按钮）：回 fit 态并 fit 一次——此后恢复自动
 * fit 语义（容器变化重新 fit）直至下次用户接管。
 */
function backToFit(): void {
  viewMode.value = 'fit'
  fitWhenContainerReady()
}

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
    // pan 接管（位移超阈值的拖拽）→ free 态（自动 fit 停用；pointerdown 未移动
    // 不进此分支——纯点击不算接管）
    viewMode.value = 'free'
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

/** wheel 缩放：以指针位置为缩放中心（画布坐标系下保持指针下的内容点不动）。
 *  wheel 即用户接管 → free 态（自动 fit 停用）。 */
function onWheel(e: WheelEvent): void {
  const rect = svgRef.value?.getBoundingClientRect()
  if (!rect) return
  viewMode.value = 'free'
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  const k2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, vp.k * Math.exp(-e.deltaY * ZOOM_WHEEL_FACTOR)))
  // 保持指针下的画布坐标点不动：new_tx = px - (px - tx) * (k2/k)
  vp.tx = px - (px - vp.tx) * (k2 / vp.k)
  vp.ty = py - (py - vp.ty) * (k2 / vp.k)
  vp.k = k2
}

/**
 * 点击路由（[2026-10-19] agent 钻取语义删除——节点/实例行不再开 agent 详情，归宿 =
 * 下方实例 trace 行）：节点按渲染态分语义——pending（运行中零实例）与 skipped（run
 * 终局后零实例）同为「零实例、无对话可看」，点击开所属 phase tab（设计 §3.1-2 点击
 * 行为边界）；其余态节点与实例行 no-op（纯展示）；phase 分区点击开 phase tab。
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

