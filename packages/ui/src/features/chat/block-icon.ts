import type { Component } from 'vue'
import {
  Brain,
  BookOpen,
  SquareTerminal,
  Pencil,
  SquareFunction,
  Users,
  ListChecks,
  AlertTriangle,
  ArrowRight,
} from '@lucide/vue'
import type { ToolCallStatus } from '@taiji/shared'

/**
 * block-icon.ts —— trace 块图标映射（Demo H 最终视觉 SSOT）。
 *
 * 10 类 BlockIconKind 对应 trace 流里所有块的图标语义。getBlockIcon 按「状态 > 类型」的
 * 固定优先级决策（running 覆盖一切 → failed → subagent → workflow → toolName 映射）。
 *
 * BLOCK_ICON_LUCIDE 是 H 最终图标（brain/book-open/square-terminal/pencil/users/list-checks/
 * alert-triangle/arrow-right），统一规格 14×14 / stroke-width 1.7 / currentColor。
 * running 态不走该映射，消费方改用 RUNNING_LOADER_SVG（双环 loader，1.4s 旋转 + accent 蓝）。
 *
 * 归属：本文件是图标决策的 SSOT（IF1/IF2 契约）。消费方拿 BlockIconKind 后，running 用
 * RUNNING_LOADER_SVG，其余用 BLOCK_ICON_LUCIDE[kind]。
 */
export type BlockIconKind =
  | 'thinking' | 'tool-read' | 'tool-bash' | 'tool-edit' | 'tool-other'
  | 'subagent' | 'workflow' | 'running' | 'failed' | 'text'

/** toolName → tool 细分类映射（未命中的 toolName 走 'tool-other'） */
const TOOL_ICON_MAP: Record<string, BlockIconKind> = {
  read: 'tool-read',
  bash: 'tool-bash',
  edit: 'tool-edit',
  write: 'tool-edit',
}

/**
 * 决策块图标种类。优先级（覆盖关系）：
 *   status==='running' → running（运行中态覆盖一切，用 loader 动画）
 *   status==='error'   → failed
 *   isSubagent         → subagent
 *   isWorkflow         → workflow
 *   否则               → TOOL_ICON_MAP[toolName] ?? 'tool-other'
 */
export function getBlockIcon(
  toolName: string,
  status: ToolCallStatus,
  isSubagent: boolean,
  isWorkflow: boolean,
): BlockIconKind {
  if (status === 'running') return 'running'
  if (status === 'error') return 'failed'
  if (isSubagent) return 'subagent'
  if (isWorkflow) return 'workflow'
  return TOOL_ICON_MAP[toolName] ?? 'tool-other'
}

/**
 * BlockIconKind → lucide 组件映射（不含 running——running 用 RUNNING_LOADER_SVG）。
 * Demo H 最终值：thinking=brain / tool-read=book-open / tool-bash=square-terminal /
 * tool-edit=pencil / tool-other=square-function / subagent=users / workflow=list-checks /
 * failed=alert-triangle / text=arrow-right。
 */
export const BLOCK_ICON_LUCIDE: Record<Exclude<BlockIconKind, 'running'>, Component> = {
  thinking: Brain,
  'tool-read': BookOpen,
  'tool-bash': SquareTerminal,
  'tool-edit': Pencil,
  'tool-other': SquareFunction,
  subagent: Users,
  workflow: ListChecks,
  failed: AlertTriangle,
  text: ArrowRight,
}

/**
 * running 态双环 loader SVG（Demo H）。
 * 外环 circle r=10 opacity 0.35 + 内实心 circle r=3，viewBox 0 0 24 24，
 * stroke currentColor stroke-width 1.7 / linecap round / linejoin round。
 * 消费方渲染时套 class animate-loader-spin（1.4s 线性旋转）+ text-accent。
 * prefers-reduced-motion 由 style.css 全局 @media reduce 兜底（animation-duration:0.01ms）。
 *
 * 外环用 .ld-outer class 标记 opacity（消费方 scoped 可覆盖，但默认用 inline opacity 保证 v-html 可用）。
 */
export const RUNNING_LOADER_SVG: string =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle class="ld-outer" cx="12" cy="12" r="10" opacity="0.35"/>' +
  '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>' +
  '</svg>'
