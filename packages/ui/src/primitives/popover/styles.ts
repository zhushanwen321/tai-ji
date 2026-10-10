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
 * 选择类 popover（DirSelect / BranchSelect）列表项与动作项基础类（架构审查 F5）。
 * 贴合全宽 + 左对齐 + 紧凑高度 + hover 底色 + svg 等比 16px。
 * DirSelect 的 workspace 列表项与 BranchSelect 的 branch 列表项、两者尾部的动作项共用此类。
 */
export const POPOVER_LIST_ITEM_CLASS =
  'h-auto w-full justify-start gap-2 rounded-none px-2.5 py-1.5 text-[13px] text-neutral-fg hover:bg-surface-hover [&_svg]:size-4'

/**
 * 列表项「已选」高亮类（当前 cwd / 当前分支）：凹陷档底 + 中性内嵌描边。
 * 对齐 demo `.pop-item.current`（pages.css：background var(--surface-2) +
 * box-shadow inset 0 0 0 1px var(--border-strong)）——「当前项」是中性定位态，
 * 不消费 accent（accent 留给 Tier A 状态件/焦点/告警）。
 * 底色引 --bg-input 凹陷档：demo --surface-2 = var(--card-inset) 凹陷档（浮层上呈
 * 明显深一档的槽），real --surface-2 浮起档（U1 在册）同名分叉，复刻消费点按 demo
 * 渲染方向引凹陷档（与 ExtensionInstallFlow .u-seg 槽底同批先例同款写法）。
 */
export const POPOVER_LIST_ITEM_ACTIVE_CLASS =
  'bg-bg-input shadow-[inset_0_0_0_1px_var(--border-strong)]'
