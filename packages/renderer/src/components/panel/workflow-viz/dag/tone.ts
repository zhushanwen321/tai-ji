/**
 * workflow-viz DAG 六态着色的单一事实源（workflow-overlay-refine D4）。
 *
 * 节点卡片（WorkflowVizDagNode）与状态图例（WorkflowVizOverlay 壳内图例段）共同
 * 消费本模块——「图例 = DAG 的图例」的同源性由类名同源构造性保证：图例 dot 直接取
 * dotTone 的返回类，节点完整形态（rect 描边 + dot 脉冲）由 nodeTone 组装，不平行
 * 手写第二份色值。
 *
 * 脉冲是节点态、不是图例态（D4）：running / retrying 的 wfvz-node-pulse 类只进
 * nodeTone，图例 dot 恒静态色——脉冲是运行反馈，不是解码信息。
 */

import type { WorkflowVizDagNodeStatus, WorkflowVizDagStopTone } from './types'

/** 脉冲动画类（引用全局 keyframes SSOT 的 wfvz-node-pulse，keyframes 定义在 style.css）。 */
const PULSE_CLASS = 'animate-[wfvz-node-pulse_1.5s_ease-in-out_infinite]'

/**
 * dot 静态色类（无脉冲）——图例六态与节点 dot 的共同颜色事实源。
 * 每个状态恰好返回一个 fill 类（pending 显式返回中性灰，消费方不得再挂基础 fill
 * 类）：Tailwind 同属性任意值工具类按值字母序发射（accent < danger < neutral-dim
 * < success < warn），「基础类 + tone 类」并存时 neutral-dim 后发覆盖 tone 色——
 * 单 fill 类消竞争（D3 剧本实锤的 running/failed dot 渲染中性灰根因）。
 * 停止叠加（stopTone）优先于六态：run 停止时在途节点不脉冲、着色随 run 级形态。
 */
export function dotTone(status: WorkflowVizDagNodeStatus, stopTone?: WorkflowVizDagStopTone): string {
  if (stopTone === 'neutral') return 'fill-[var(--neutral-dim)]'
  if (stopTone === 'failed') return 'fill-[var(--danger)]'
  switch (status) {
    case 'running':
      return 'fill-[var(--accent)]'
    case 'done':
      return 'fill-[var(--success)]'
    case 'failed':
      return 'fill-[var(--danger)]'
    case 'retrying':
      return 'fill-[var(--warn)]'
    case 'pending':
    case 'skipped':
    default:
      return 'fill-[var(--neutral-dim)]'
  }
}

/**
 * 节点完整 tone（六态着色 + 停止叠加，映射语义与色值同 WorkflowVizDagNode 既有
 * 实现逐一保持）：同一时刻只发射一组状态类（Tailwind 发射序不保证同名工具类的
 * class 顺序胜负——见 Gantt 迁移同款裁决）；running / retrying 叠脉冲。
 */
export function nodeTone(status: WorkflowVizDagNodeStatus, stopTone?: WorkflowVizDagStopTone): { rect: string; dot: string } {
  const dot = dotTone(status, stopTone)
  if (stopTone === 'neutral') return { rect: 'stroke-[var(--neutral-dim)]', dot }
  if (stopTone === 'failed') return { rect: 'stroke-[var(--danger)]', dot }
  switch (status) {
    case 'running':
      return { rect: `stroke-[var(--accent)] [stroke-width:1.6] ${PULSE_CLASS}`, dot: `${dot} ${PULSE_CLASS}` }
    case 'done':
      return { rect: 'stroke-[var(--success)]', dot }
    case 'failed':
      return { rect: 'stroke-[var(--danger)] [stroke-width:1.6]', dot }
    case 'retrying':
      return { rect: `stroke-[var(--warn)] [stroke-width:1.6] ${PULSE_CLASS}`, dot: `${dot} ${PULSE_CLASS}` }
    case 'skipped':
      return { rect: 'stroke-[var(--neutral-dim)] [stroke-dasharray:4_3] fill-[var(--surface-hover)]', dot }
    default:
      return { rect: '', dot }
  }
}
