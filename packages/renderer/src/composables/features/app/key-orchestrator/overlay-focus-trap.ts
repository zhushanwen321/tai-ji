/**
 * 浮层 Tab 焦点陷阱（display-containers §7.3/§7.5「Tab 焦点陷阱与 IME 守卫随迁编排器浮层
 * 分支整体保位」）。
 *
 * 实现自 WorkflowVizOverlay.onWindowKeydown/trapTab 原样迁入（a11y 不回退）：焦点在浮层
 * 面板内可聚焦元素首末循环，防 Tab 逃逸到被遮罩挡住的背景 UI（role=dialog + aria-modal 的
 * a11y 语义一致性）。
 *
 * 面板 ref 经 overlay 宿主注入（registerOverlayFocusTrapPanel）：W1 编排器浮层分支持
 * 陷阱行为，W2 OverlayShell 壳抽取时随壳归位（注册点随壳迁移，本模块逻辑不变）。
 */

/** 浮层面板元素（open 时由 overlay 宿主注册、关闭/卸载时注销 null） */
let trapPanel: HTMLElement | null = null

/** 注册/注销浮层面板（编排器 Tab 分支的陷阱目标） */
export function registerOverlayFocusTrapPanel(el: HTMLElement | null): void {
  trapPanel = el
}

/** 当前注册的浮层面板（测试与宿主对账读点；null = 未注册/已注销） */
export function getOverlayFocusTrapPanel(): HTMLElement | null {
  return trapPanel
}

/** Tab 可聚焦元素查询（焦点陷阱的候选集）。 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Tab 焦点陷阱（DESIGN §5.12 焦点管理三要素之三）：焦点在面板内可聚焦元素首末循环。
 * 无注册面板时零动作（浮层未开——Tab 保持浏览器默认行为）。
 */
export function trapTabIntoOverlayPanel(e: KeyboardEvent): void {
  const panel = trapPanel
  if (!panel) return
  const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  if (focusables.length === 0) {
    e.preventDefault()
    panel.focus()
    return
  }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement
  const inside = active instanceof Node && panel.contains(active)
  if (e.shiftKey) {
    if (!inside || active === first) {
      e.preventDefault()
      last.focus()
    }
  } else if (!inside || active === last) {
    e.preventDefault()
    first.focus()
  }
}
