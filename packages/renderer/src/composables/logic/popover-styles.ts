/**
 * Panel popover 共享样式常量（架构审查 D4）。
 *
 * ModelSelectPopover / ThinkingLevelPopover / AddMenuPopover 三者 trigger 与列表选中态
 * 类名各自重复，在此统一抽出，避免一字不差地抄写三遍。
 */

/**
 * 文本型 trigger 基础类（ModelSelect / ThinkingLevel 共用）。
 * 几何与字色对齐 demo `.modelsel`（workbench.css composer 段，M4c）：高 28px / 水平内边距
 * 8px / 圆角 --radius-xs（4px，demo --r-xs）/ 字号 --text-xs（12px，demo fs-md，随字体档
 * 缩放）/ 正文档色 + 600 字重（font-semibold 与 --fw-mid 同值；用具名工具类而非
 * [font-weight:…] 任意属性——须确定性压过 Button 基类的 font-medium，任意属性与具名类
 * 的级联顺序不可靠）。悬停反馈由 ghost 基类的底色 hover 承担，不做字色变化（提亮后
 * 字色加深会倒挂）。AddMenu 是图标型 trigger，不复用此类。
 */
export const TRIGGER_TEXT_CLASS =
  'h-7 rounded-[var(--radius-xs)] px-2 text-[length:var(--text-xs)] text-neutral-fg font-semibold transition-colors'

/**
 * 图标型 trigger 基础类（AddMenu 用）。
 * 对齐 demo `.cbtn`（workbench.css composer 段，M4b 同款口径）：30×30 方钮 / r-sm 圆角 /
 * 常态 --dim 字色，hover 提到 --fg（底色 hover 由 ghost 基类承担）。
 */
export const TRIGGER_ICON_CLASS =
  'size-[30px] shrink-0 rounded-sm p-0 text-neutral-dim transition-colors hover:text-neutral-fg'

/**
 * 列表项「选中态」类名（ModelSelect / ThinkingLevel 列表项共用）。
 * 对齐 demo 选中态单一范式（workbench.css 文件尾 `.composer .pop-item.on`）：浮层同色
 * elevated 底 + 行首 2px accent 内嵌标 + 提字，并锁死 hover 不回退，避免选中项悬停闪色。
 */
export const SELECTED_ITEM_CLASS =
  'bg-bg-elevated text-neutral-fg shadow-[inset_2px_0_0_var(--accent)] hover:bg-bg-elevated hover:text-neutral-fg'

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
