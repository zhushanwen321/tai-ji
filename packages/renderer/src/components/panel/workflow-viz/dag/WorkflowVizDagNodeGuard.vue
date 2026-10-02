<!--
  WorkflowVizDagNodeGuard —— DAG 画布的节点级渲染边界（workflow-visualization 设计
  §3.1 失败路径「DAG 画布对单节点 SVG 生成设节点级错误边界（单节点占位错误态，不挂
  整画布）」）。

  手法 = StreamItemBoundary 的 errorCaptured 边界（切容器变体）：捕获子树（slot 内容
  = WorkflowVizDagNode 卡片）的 render/setup 错误 → 记录（console.error +
  reportCapturedError，与全局 errorHandler 同一上报通道）→ return false 阻断向全局
  传播 → 切换为占位错误态。其余节点不受影响——故障隔离粒度从整画布收敛到单节点。

  与 StreamItemBoundary 的差异：无重试入口——节点渲染失败是数据/代码缺陷而非可修复
  瞬态，占位形态静态常驻（重试 = 重开 overlay，数据被修复时自然恢复）；不渲染
  failed 分支以外的响应式子树，边界自身 render 抛错面结构性为零。

  errorCaptured 只链式上报后代组件的错误——边界必须是节点卡片的父层，占位逻辑
  不与卡片同组件。
-->
<template>
  <g v-if="failed" class="wfvz-dag-node-error" data-testid="wfvz-dag-node-error">
    <rect class="fill-[var(--surface-hover)] stroke-[var(--warn)] [stroke-dasharray:4_3] [rx:var(--radius-sm)]" :width="DAG_NODE_W" :height="DAG_NODE_H" />
    <circle class="fill-[var(--warn)]" :cx="DOT_CX" :cy="DAG_NODE_H / 2" r="4" />
    <text class="text-[length:var(--text-3xs)] fill-[var(--neutral-mid)]" :x="LABEL_X" :y="26">{{ t('panel.workflowViz.nodeRenderFailed') }}</text>
  </g>
  <template v-else>
    <slot />
  </template>
</template>

<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DAG_NODE_H, DAG_NODE_W } from './layout'
import { reportCapturedError } from '@/boot/error-reporter'

const DOT_CX = 14
const LABEL_X = 26

const { t } = useI18n()

const failed = ref(false)

onErrorCaptured((err, _instance, info) => {
  if (failed.value) return false
  failed.value = true
  // 记录与全局 errorHandler 同通道（D2 单一上报出口）：console 留现场 + 落盘取证
  console.error(`[WorkflowVizDagNodeGuard] dag node render failed (${info}):`, err)
  reportCapturedError(err, `workflow-viz-dag-node:${info}`)
  // 阻断向全局 errorHandler 传播：单节点故障不升级为整画布故障，用户侧已有占位显形
  return false
})
</script>
