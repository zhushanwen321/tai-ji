/**
 * focus-trap —— modal/浮层 Tab 焦点陷阱纯工具（非响应式，键盘事件处理器内直调）。
 *
 * 抽取自 SettingsModal 的逐字重复实现：Tab 循环三路语义——
 * 焦点在末个且非 shift → 回首个；在首个且 shift → 跳末个；其余 Tab（中间元素间
 * 移动）不拦截，交给浏览器原生顺序。各宿主的唯一真差异是焦点元素枚举的 DOM
 * 查询根，经 getFocusables 参数化注入，宿主各自决定枚举范围。
 */

/** 可聚焦元素选择器（modal 族通用口径：禁用态与 tabindex="-1" 排除） */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 元素可见性判定（demo settings spec §3.1 与 SettingsModal trapTab 同款判据）：
 * checkVisibility() 是 position:fixed 与 v-show display:none 的统一判据（offsetParent 对
 * fixed 元素恒 null 不可用）；环境不支持时降级 getClientRects。
 * 返回 null = 环境两种判据都不可用（调用方决定放行策略——focus-trap 取「放行」，
 * 环境缺失时行为与旧版全量枚举一致，测试环境确定性不受影响）。
 */
export function isElementVisible(el: HTMLElement): boolean | null {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility()
  if (typeof el.getClientRects === 'function') return el.getClientRects().length > 0
  return null
}

/** 枚举 root 内按 DOM 顺序排列的可聚焦元素（可见性可判定时剔除隐藏元素——v-show 常挂载
 *  的隐藏分区、折叠面板等不入 Tab 圈；判据不可用则全量枚举，同旧版行为）。 */
export function getFocusableElements(root: ParentNode): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  const visible = all.filter((el) => isElementVisible(el) !== false)
  // 兜底：可见性判据整体失效（过滤后为空但原列表非空）→ 退回全量，陷阱不失能
  return visible.length > 0 || all.length === 0 ? visible : all
}

/** Tab 焦点陷阱：末个非 shift → 首个；首个 shift → 末个；中间 Tab 交浏览器原生顺序。 */
export function cycleTabFocus(e: KeyboardEvent, getFocusables: () => HTMLElement[]): void {
  const list = getFocusables()
  if (list.length === 0) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (active === last && !e.shiftKey) {
    e.preventDefault()
    first.focus()
  } else if (active === first && e.shiftKey) {
    e.preventDefault()
    last.focus()
  }
}
