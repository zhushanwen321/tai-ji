<!--
  WorkflowVizDagNode —— DAG 画布的单节点卡片内容（SVG 子组件）。

  只承担节点形态渲染：状态点 + 调用点名（截断）+ kind 标签；六态着色经 dag/tone.ts
  模块映射（nodeTone）整组切换 Tailwind 工具类（互斥防同名工具类胜负取决发射序——
  pending 灰 / running accent 脉冲 / done 绿 / failed 红 / retrying warn 脉冲 /
  skipped 中性虚线淡化；映射单处在 tone.ts——workflow-overlay-refine D4：节点与
  图例共同消费的单一事实源），data-state 属性仅作测试观察锚点（非 CSS 选择器）。
  停止叠加（D9：run 停止时在途节点不显示蓝脉冲、着色随 run 级形态）同样经 nodeTone
  整组切换——run 级输入（status/outcome → stopTone）由画布归一后传入（映射定义见
  types.ts），本组件零派生。

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
      :height="DAG_NODE_H"
    />
    <circle
      :class="['stroke-[var(--surface)] [stroke-width:1.5] transition-[fill] duration-[var(--duration-fast)] ease-[var(--ease)]', tone.dot]"
      :cx="DOT_CX"
      :cy="DAG_NODE_H / 2"
      r="4"
    />
    <text class="text-[length:var(--text-3xs)] font-semibold fill-[var(--neutral-fg)]" :x="LABEL_X" :y="20">{{ truncatedName }}</text>
    <text class="text-[length:var(--text-3xs)] font-mono fill-[var(--neutral-dim)]" :x="LABEL_X" :y="34">{{ kindLabel }} · L{{ node.line }}</text>
  </g>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { WorkflowDagNode } from '@taiji/shared'
import { DAG_NODE_H, DAG_NODE_W } from './layout'
import { nodeTone } from './tone'
import type { WorkflowVizDagNodeStatus, WorkflowVizDagStopTone } from './types'

const props = defineProps<{
  node: WorkflowDagNode
  status: WorkflowVizDagNodeStatus
  stopTone?: WorkflowVizDagStopTone
}>()

const DOT_CX = 14
const LABEL_X = 26
/** 调用点名最大字符数（超出截断 + 省略号；全名经 <title> 悬停可见）。 */
const NAME_MAX_CHARS = 18

// fail-fast 守卫：prop 违约即抛（布局产物正常不可达；防御脏数据以占位错误态显形
// 而非静默渲染空卡）。抛出点被父层 WorkflowVizDagNodeGuard 捕获。
if (!props.node || typeof props.node.id !== 'string' || props.node.id === '') {
  throw new Error('[WorkflowVizDagNode] node prop 违约：缺失或 id 非法')
}

const truncatedName = computed(() => {
  const name = props.node.templateName
  return name.length > NAME_MAX_CHARS ? `${name.slice(0, NAME_MAX_CHARS)}…` : name
})

/** kind 标签（图内技术标签，原型同款 mono 英文小字；非用户文案）。 */
const kindLabel = computed(() => (props.node.kind === 'agent' ? 'agent' : 'script'))

/**
 * 六态着色（D9 渲染层派生态）+ 停止叠加（run 停止时不蓝脉冲、着色随 stop-tone）。
 * 映射单处在 dag/tone.ts（D4：节点与图例共同消费；互斥整组切换语义见模块注释）。
 */
const tone = computed<{ rect: string; dot: string }>(() => nodeTone(props.status, props.stopTone))
</script>
