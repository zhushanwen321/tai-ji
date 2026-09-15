/**
 * trace kind badge 色板（trace-tab-demo.html .k-* 同源）。
 * 行组件与 inspector 共用（禁散落第二份）。
 */
import type { TraceContentBlock, TraceRowKind } from '@taiji/core/domain/session-trace'

/** kind badge 类映射：消息中性 / 系统信息蓝 / 压缩与 NOTICE 警黄 / lifecycle 与 DATA 弱描边 / 损坏行危险红。 */
export const KIND_BADGE_CLASS: Record<TraceRowKind, string> = {
  SESSION: 'bg-surface-2 text-neutral-mid',
  SYSTEM: 'bg-info-soft text-info',
  USER: 'bg-surface-hover text-neutral-fg',
  ASSISTANT: 'bg-surface-hover text-neutral-fg',
  TOOL: 'bg-surface-2 text-neutral-mid',
  BASH: 'bg-surface-2 text-neutral-mid',
  NOTICE: 'bg-warn-soft text-warn',
  COMPACTED: 'bg-warn-soft text-warn',
  BRANCH: 'bg-info-soft text-info',
  LIFECYCLE: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
  DATA: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
  BOUNDARY: 'bg-surface-2 text-neutral-mid',
  MALFORMED: 'bg-danger-soft text-danger',
}

/** content block badge 类映射（assistant 子 block 行与 inspector 清单共用）：
 * thinking 推理色（与 inspector thinking 正文 text-reasoning 同系）/ text 中性 /
 * toolCall 信息蓝 / image 与 unknown 弱描边。 */
export const BLOCK_BADGE_CLASS: Record<TraceContentBlock['kind'], string> = {
  thinking: 'bg-surface-2 text-reasoning',
  text: 'bg-surface-2 text-neutral-mid',
  toolCall: 'bg-info-soft text-info',
  image: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
  unknown: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
}

/** block badge 显示标签（unknown 显示原始 type，其余显示归一化 kind）。 */
export function blockBadgeLabel(block: TraceContentBlock): string {
  return block.kind === 'unknown' ? block.type : block.kind
}
