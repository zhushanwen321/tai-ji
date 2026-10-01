<!--
  WorkflowVizOverlayGuard —— overlay 装载失败的回落边界（workflow-visualization 设计
  §3.3-D10）。外包 Guard 组件（errorCaptured，StreamItemBoundary 的边界手法、切容器
  变体）：overlay 组件树整棵作为 slot 挂在本组件下，树内任何 render/setup 错误由本
  边界捕获 → 上报（console.error + reportCapturedError，与全局 errorHandler 同通道）
  → emit('fallback') → return false 阻断向全局传播。

  捕获后的动作序列归接线方（U6）：fallback handler 内关闭 overlay（清瞬态、停订阅）
  并调 drawer 编排 openDrawerTab('workflow') + openWorkflowInDrawer(runId)——回落
  **不得**经改向后的 openWorkflow（会重入 overlay 入口形成循环，D1）。

  与 StreamItemBoundary 的差异：无占位行、无重试入口——装载失败的整体处置是切容器
  （回落 drawer WorkflowTab），不是树内恢复；failed 后 slot 卸载、本边界渲染空
  （overlay 已随 fallback 关闭，用户经 drawer 达成「打开 workflow」的意图）。无
  「连续失败计数后直落 drawer」机制（D10：每次点击入口均重试 overlay）。

  边界自身 render 不消费响应式子树（failed 分支为空），自身抛错面结构性为零。
-->
<template>
  <template v-if="!failed">
    <slot />
  </template>
</template>

<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import { reportCapturedError } from '@/boot/error-reporter'

const emit = defineEmits<{
  /** 装载失败：接线方在此关闭 overlay 并回落 drawer（D10 动作序列）。 */
  fallback: []
}>()

const failed = ref(false)

onErrorCaptured((err, _instance, info) => {
  if (failed.value) return false
  failed.value = true
  // 记录与全局 errorHandler 同通道（D2 单一上报出口）：console 留现场 + 落盘取证
  console.error(`[WorkflowVizOverlayGuard] overlay mount failed (${info}):`, err)
  reportCapturedError(err, `workflow-viz-overlay-guard:${info}`)
  emit('fallback')
  // 阻断向全局 errorHandler 传播：装载故障由回落容器处置，不升级为全局故障
  return false
})
</script>
