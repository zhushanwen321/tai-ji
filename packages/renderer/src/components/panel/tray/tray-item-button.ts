/**
 * 托盘条目按钮的共享视觉外壳（built-in 三件按钮与 widget 条目按钮共用）。
 *
 * 两处按钮的类串 / 呼吸点 / 计数角标逐字同款——调色 / 尺寸单点在此，避免两分支人工对齐
 * 漂移；差异面（icon fallback 链 / badge truncate / tone 档 / testid 字面量）仍留在各自组件。
 *
 * 形态权威 = demo composer 左簇 .cbtn（workbench.css）：30×30 方钮 / r-sm / dim 字 /
 * hover surface-hover 底 + fg 提亮；计数走 demo .cbtn .badge 角标形态（绝对定位按钮右上角，
 * -3px 外扩、min-w/h 14px、px 3px、胶囊、mono 10px、fw-mid——与 ComposerBtwButton 未读角标
 * 同一语言，demo「accent 底保留给未读/需关注态」口径由调用方按语义配色）。
 */
import { cn } from '@/lib/utils'

/** 条目按钮外壳类（active = pin 态或面板展开）：调一处两分支同步生效。
 *  relative = 计数角标的定位锚（角标绝对定位于按钮右上角）。 */
export function trayItemButtonClass(active: boolean): string {
  return cn(
    'relative size-[30px] shrink-0 justify-center gap-1 rounded-sm p-0',
    active
      ? 'bg-surface-hover text-neutral-fg'
      : 'text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg',
  )
}

/** running 呼吸点类（仅「有进行中」渲染；归零不虚亮由各自 v-if 判定） */
export const TRAY_PULSE_CLASS = 'size-1.5 shrink-0 animate-pulse rounded-full bg-accent'

/**
 * 计数角标形态（demo .cbtn .badge）：绝对定位于按钮右上角 -3px，min-w/h 14px、px 3px、
 * 胶囊、mono 10px、fw-mid、tabular-nums。语义色对（bg/字色）由调用方按状态追加：
 * built-in/聚合 = bg-accent + text-accent-fg（demo 未读角标语言），widget 走 status tone 文字色。
 */
export const TRAY_ITEM_COUNT_CLASS =
  'absolute -right-[3px] -top-[3px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] font-mono text-[length:var(--text-3xs)] tabular-nums [font-weight:var(--fw-mid)]'
