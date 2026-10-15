<!--
  WorkflowVizDagNode —— DAG 画布的单节点卡片内容（SVG 子组件）。

  只承担节点形态渲染：状态点 + 调用点名（截断）+ kind 标签 + 执行实例行；六态着色经
  dag/tone.ts 模块映射（nodeTone）整组切换 Tailwind 工具类（互斥防同名工具类的
  class 顺序胜负——pending 灰 / running accent 脉冲 / done 绿 / failed 红 / retrying
  warn 脉冲 / skipped 中性虚线淡化；映射单处在 tone.ts——workflow-overlay-refine D4：
  节点与图例共同消费的单一事实源），data-state 属性仅作测试观察锚点（非 CSS 选择器）。
  停止叠加（D9：run 停止时在途节点不显示蓝脉冲、着色随 run 级形态）同样经 nodeTone
  整组切换——run 级输入（status/outcome → stopTone）由画布归一后传入（映射定义见
  types.ts），本组件零派生。

  执行实例（2026-10 用户裁决「实际执行的 agent 画进图里」）：
  - 恰 1 实例：节点标题直接用该实例的 agent 名（固定 agent 名，不再露模板通配形）；
  - ≥2 实例：标题保持调用点模板名（调用点身份），主体下方每实例一行（状态点 +
    agent 名），行高 INSTANCE_ROW_H、节点高经 dagNodeHeight 增高（布局同表）；
  - 0 实例（pending/skipped——零实例无实例名可显）：标题保持模板名。
  实例行可点击（data-wfvz-instance 锚点）：画布 routeClick 优先路由实例行，
  上抛 callId 让宿主钻取该实例（多实例节点不再只能看第一个）。

  守卫：node prop 违约（缺失 / id 非法）时 fail-fast throw——本组件渲染抛错由外层
  WorkflowVizDagNodeGuard（errorCaptured 节点级边界）捕获并渲染占位错误态，不挂
  整画布（设计 §3.1 失败路径「单节点 SVG 生成失败 = 节点占位错误态不挂画布」）。
  errorCaptured 只捕获后代组件错误，边界必须是与本组件分离的父层组件。
-->
<template>
  <g
    :class="[
      node.kind === 'agent' ? 'cursor-pointer' : 'cursor-default',
      status === 'skipped' ? 'opacity-50' : '',
    ]"
    :data-state="status"
    :data-kind="node.kind"
    :data-stop-tone="stopTone ?? undefined"
  >
    <rect
      :class="['fill-[var(--surface)] [rx:var(--radius-sm)] transition-[stroke] duration-[var(--duration-fast)] ease-[var(--ease)]', tone.rect]"
      :width="DAG_NODE_W"
      :height="height"
    />
    <circle
      :class="['stroke-[var(--surface)] [stroke-width:1.5] transition-[fill] duration-[var(--duration-fast)] ease-[var(--ease)]', tone.dot]"
      :cx="DOT_CX"
      :cy="DOT_CY"
      r="4"
    />
    <text class="text-[length:var(--text-3xs)] font-semibold fill-[var(--neutral-fg)]" :x="LABEL_X" :y="TITLE_BASELINE_Y">
      <title>{{ titleFull }}</title>
      {{ truncatedTitle }}
    </text>
    <text class="text-[length:var(--text-3xs)] font-mono fill-[var(--neutral-dim)]" :x="LABEL_X" :y="META_BASELINE_Y">{{ kindLabel }} · L{{ node.line }}</text>
    <!-- 执行实例行（≥2 实例时；1 实例已并入标题，0 实例零渲染） -->
    <g
      v-for="(call, i) in extraInstances"
      :key="call.id"
      :data-testid="`wfvz-dag-instance-${call.id}`"
      :data-wfvz-instance="call.id"
      :data-state="call.status"
      class="cursor-pointer"
    >
      <circle
        :class="['transition-[fill] duration-[var(--duration-fast)] ease-[var(--ease)]', dotTone(call.status, stopTone)]"
        :cx="DOT_CX"
        :cy="instanceRowCenterY(i)"
        r="3"
      />
      <text
        class="text-[length:var(--text-3xs)] font-mono fill-[var(--neutral-mid)]"
        :x="INSTANCE_LABEL_X"
        :y="instanceRowBaselineY(i)"
      >
        <title>{{ call.agent }}</title>
        {{ truncate(call.agent, INSTANCE_NAME_MAX_CHARS) }}
      </text>
    </g>
  </g>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { WorkflowAgentCall, WorkflowDagNode } from '@taiji/shared'
import { DAG_NODE_H, DAG_NODE_W, INSTANCE_ROW_H, dagNodeHeight } from './layout'
import { dotTone, nodeTone } from './tone'
import type { WorkflowVizDagNodeStatus, WorkflowVizDagStopTone } from './types'

const props = defineProps<{
  node: WorkflowDagNode
  status: WorkflowVizDagNodeStatus
  stopTone?: WorkflowVizDagStopTone
  /** 挂接的执行实例（D2 匹配产物，taskIndex 升序；缺省 = 无实例数据）。 */
  instances?: WorkflowAgentCall[]
}>()

const DOT_CX = 14
/** 状态点纵向锚定标题行（单实例时 = 节点高一半，与原形态一致；增高节点不随行区漂移）。 */
const DOT_CY = 22
const LABEL_X = 26
const TITLE_BASELINE_Y = 20
const META_BASELINE_Y = 34
const INSTANCE_LABEL_X = 24
/** 标题最大字符数（超出截断 + 省略号；全名经 <title> 悬停可见）。 */
const NAME_MAX_CHARS = 18
/** 实例名最大字符数（行内 mono 小字，节点宽 156 内容纳）。 */
const INSTANCE_NAME_MAX_CHARS = 20
/** 标题基线到行中心的半行高（点与文字视觉对齐的固定修正量）。 */
const TEXT_CENTER_LIFT = 3
/** 取半除数（行中心 = 行顶 + 行高/2；具名以过 no-magic-numbers）。 */
const HALF = 2

// fail-fast 守卫：prop 违约即抛（布局产物正常不可达；防御脏数据以占位错误态显形
// 而非静默渲染空卡）。抛出点被父层 WorkflowVizDagNodeGuard 捕获。
if (!props.node || typeof props.node.id !== 'string' || props.node.id === '') {
  throw new Error('[WorkflowVizDagNode] node prop 违约：缺失或 id 非法')
}

/** 节点高度（与布局同表：dagNodeHeight 按实例数增高——节点卡片与布局几何单源）。 */
const height = computed(() => dagNodeHeight(props.instances?.length ?? 0))

/** 恰 1 实例 → 标题即实例 agent 名（固定 agent 名）；其余形态标题 = 调用点模板名。 */
const titleSource = computed(() => {
  const list = props.instances
  return list !== undefined && list.length === 1 ? list[0].agent : props.node.templateName
})

const truncatedTitle = computed(() => truncate(titleSource.value, NAME_MAX_CHARS))
const titleFull = computed(() => titleSource.value)

/** ≥2 实例才渲染实例行（1 实例已并入标题——同一信息不双轨）。 */
/** 实例行区起渲染的最少实例数（≥2 才渲染行区；1 实例并入标题不双轨）。 */
const MIN_EXTRA_ROWS = 2

const extraInstances = computed(() => {
  const list = props.instances
  return list !== undefined && list.length >= MIN_EXTRA_ROWS ? list : []
})

/** 第 i 行（0-based）的视觉中心 y 与文字基线 y（行区紧贴节点主体下方）。 */
function instanceRowCenterY(i: number): number {
  return DAG_NODE_H + INSTANCE_ROW_H / HALF + i * INSTANCE_ROW_H
}
function instanceRowBaselineY(i: number): number {
  return instanceRowCenterY(i) + TEXT_CENTER_LIFT
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** kind 标签（图内技术标签，原型同款 mono 英文小字；非用户文案）。 */
const kindLabel = computed(() => (props.node.kind === 'agent' ? 'agent' : 'script'))

/**
 * 六态着色（D9 渲染层派生态）+ 停止叠加（run 停止时不蓝脉冲、着色随 stop-tone）。
 * 映射单处在 dag/tone.ts（D4：节点与图例共同消费；互斥整组切换语义见模块注释）。
 * 实例行小点复用 dotTone 同源取色（与状态图例/节点 dot 同一颜色事实源）。
 */
const tone = computed<{ rect: string; dot: string }>(() => nodeTone(props.status, props.stopTone))
</script>
