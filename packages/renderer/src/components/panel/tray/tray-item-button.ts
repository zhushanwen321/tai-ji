/**
 * 托盘条目按钮的共享视觉外壳（built-in 三件按钮与 widget 条目按钮共用）。
 *
 * 两处按钮的类串 / 呼吸点 / 计数前缀逐字同款（设计 §3.1 场景 A「icon + mono 计数 + 呼吸点」
 * 同视觉语言）——调色 / 尺寸单点在此，避免两分支人工对齐漂移；差异面（icon fallback 链 /
 * badge truncate / tone 档 / testid 字面量）仍留在各自组件。
 */
import { cn } from '@/lib/utils'

/** 条目按钮外壳类（active = pin 态或面板展开）：调一处两分支同步生效 */
export function trayItemButtonClass(active: boolean): string {
  return cn(
    'h-7 shrink-0 gap-1 rounded-sm px-1.5',
    active
      ? 'bg-surface-hover text-neutral-mid'
      : 'text-neutral-dim hover:bg-surface-hover hover:text-neutral-mid',
  )
}

/** running 呼吸点类（仅「有进行中」渲染；归零不虚亮由各自 v-if 判定） */
export const TRAY_PULSE_CLASS = 'size-1.5 shrink-0 animate-pulse rounded-full bg-accent'

/** 计数字面前缀（tone 色由调用方追加：built-in 恒 text-accent，widget 走 status tone） */
export const TRAY_ITEM_COUNT_CLASS = 'font-mono text-[length:var(--text-3xs)] tabular-nums'
