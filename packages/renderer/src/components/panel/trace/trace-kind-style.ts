/**
 * trace kind badge 色板（demo 权威：Open Design workbench.css `.t-kind` 职能分色——
 * 中性灰阶 + 语义色：user=fg 10% / 默认（assistant）=mid 12% / tool（含 bash）=info 14% /
 * thinking=reasoning 14%，color-mix 透明底随行底色透出）。
 * 行组件与 inspector 共用（禁散落第二份）。
 */
import type { TraceContentBlock, TraceRowKind } from '@taiji/core/domain/session-trace'

/** kind badge 类映射：demo 四类职能分色 + real 独有 kind 沿用语义 soft 档
 * （info/warn/danger soft = 12-14% color-mix，与 demo 同族口径）/ lifecycle 与 DATA 弱描边 / 损坏行危险红。 */
export const KIND_BADGE_CLASS: Record<TraceRowKind, string> = {
  SESSION: 'bg-surface-2 text-neutral-mid',
  SYSTEM: 'bg-info-soft text-info',
  USER: 'bg-[color-mix(in_oklch,var(--neutral-fg)_10%,transparent)] text-neutral-fg',
  ASSISTANT: 'bg-[color-mix(in_oklch,var(--neutral-mid)_12%,transparent)] text-neutral-mid',
  TOOL: 'bg-[color-mix(in_oklch,var(--info)_14%,transparent)] text-info',
  BASH: 'bg-[color-mix(in_oklch,var(--info)_14%,transparent)] text-info',
  NOTICE: 'bg-warn-soft text-warn',
  COMPACTED: 'bg-warn-soft text-warn',
  BRANCH: 'bg-info-soft text-info',
  LIFECYCLE: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
  DATA: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
  BOUNDARY: 'bg-surface-2 text-neutral-mid',
  MALFORMED: 'bg-danger-soft text-danger',
}

/** content block badge 类映射（assistant 子 block 行与 inspector 清单共用）：
 * demo .t-kind.thinking 推理色 14% / text 走默认 mid 档 / toolCall 同 demo tool 信息蓝 14% /
 * image 与 unknown 弱描边（real 独有形态）。 */
export const BLOCK_BADGE_CLASS: Record<TraceContentBlock['kind'], string> = {
  thinking: 'bg-[color-mix(in_oklch,var(--reasoning)_14%,transparent)] text-reasoning',
  text: 'bg-[color-mix(in_oklch,var(--neutral-mid)_12%,transparent)] text-neutral-mid',
  toolCall: 'bg-[color-mix(in_oklch,var(--info)_14%,transparent)] text-info',
  image: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
  unknown: 'text-neutral-dim shadow-[inset_0_0_0_1px_var(--hairline)]',
}

/** block badge 显示标签（unknown 显示原始 type，其余显示归一化 kind）。 */
export function blockBadgeLabel(block: TraceContentBlock): string {
  return block.kind === 'unknown' ? block.type : block.kind
}
