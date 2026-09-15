/**
 * Panel popover 共享样式常量（架构审查 D4）。
 *
 * ModelSelectPopover / ThinkingLevelPopover / AddMenuPopover 三者 trigger 与列表选中态
 * 类名各自重复，在此统一抽出，避免一字不差地抄写三遍。
 */

/**
 * 文本型 trigger 基础类（ModelSelect / ThinkingLevel 共用）。
 * 紧凑高度 + 小圆角 + 弱化字色 + 悬停加深。AddMenu 是图标型 trigger，不复用此类。
 */
export const TRIGGER_TEXT_CLASS =
  'h-7 rounded-sm px-2 text-[11.5px] text-neutral-dim transition-colors hover:text-neutral-mid'

/**
 * 图标型 trigger 基础类（AddMenu 用）。
 * 固定尺寸 + 小圆角 + 弱化字色 + 悬停底色。
 */
export const TRIGGER_ICON_CLASS =
  'size-[28px] shrink-0 rounded-sm text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-mid'

/**
 * 列表项「选中态」类名（ModelSelect / ThinkingLevel 列表项共用）。
 * 选中后走 accent 配色，并锁死 hover 不回退，避免选中项悬停闪色。
 */
export const SELECTED_ITEM_CLASS =
  'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'

/**
 * 选择类 popover（DirSelect / BranchSelect）列表项与动作项基础类（架构审查 F5）。
 * 贴合全宽 + 左对齐 + 紧凑高度 + hover 底色 + svg 等比 16px。
 * DirSelect 的 workspace 列表项与 BranchSelect 的 branch 列表项、两者尾部的动作项共用此类。
 */
export const POPOVER_LIST_ITEM_CLASS =
  'h-auto w-full justify-start gap-2 rounded-none px-2.5 py-1.5 text-[13px] text-neutral-fg hover:bg-surface-hover [&_svg]:size-4'

/**
 * 列表项「已选」高亮类（当前 cwd / 当前分支）：surface-2 底 + accent inset ring。
 */
export const POPOVER_LIST_ITEM_ACTIVE_CLASS =
  'bg-surface-2 ring-1 ring-inset ring-accent-ring'
