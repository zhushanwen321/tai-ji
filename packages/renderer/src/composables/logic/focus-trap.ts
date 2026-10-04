/**
 * focus-trap —— modal/浮层 Tab 焦点陷阱纯工具（非响应式，键盘事件处理器内直调）。
 *
 * 抽取自 PluginModalHost / SettingsModal 的逐字重复实现：Tab 循环三路语义——
 * 焦点在末个且非 shift → 回首个；在首个且 shift → 跳末个；其余 Tab（中间元素间
 * 移动）不拦截，交给浏览器原生顺序。两宿主的唯一真差异是焦点元素枚举的 DOM
 * 查询根，经 getFocusables 参数化注入，宿主各自决定枚举范围。
 */

/** 可聚焦元素选择器（modal 族通用口径：禁用态与 tabindex="-1" 排除） */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 枚举 root 内按 DOM 顺序排列的可聚焦元素 */
export function getFocusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
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
