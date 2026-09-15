/**
 * contenteditable 选区保存/恢复工厂 —— composer/input/selection-restore.ts。
 *
 * 从 contenteditable.ts useContenteditableInput 提取的内聚逻辑（单一变化轴
 * 「夺焦前后选区状态」）：saveSelection/restoreSelection/placeCaretAtEnd 与
 * savedRange 闭包状态。工厂每调用一次产生独立实例（savedRange 实例级语义，
 * 每个 useContenteditableInput 实例互不共享）。
 *
 * preferredCaretX（视觉行移动记忆列）属 contenteditable 的光标移动轴，留在原处，
 * 由调用方包装 saveSelection 时自行清空。
 */
export function useSelectionRestore(getEl: () => HTMLDivElement | null): {
  saveSelection: () => void
  restoreSelection: () => void
  /** 丢弃已保存选区（clear/setText 整框重写后旧选区失效） */
  reset: () => void
} {
  let savedRange: Range | null = null

  /**
   * 活选区两端点是否都在编辑器内（anchor + focus 双端，方向无关）。
   *
   * 只校验 anchorNode 会放过「锚点在编辑器内、焦点在编辑器外」的跨边界选区（鼠标从输入框
   * 拖到消息区）：下游 insertChipAtSelection 对该 range 直接 deleteContents() + insertNode()，
   * 会删到编辑器外 DOM。任一端点在编辑器外即判定不可用，fall-through 到 savedRange 回退。
   */
  function isSelectionInside(el: HTMLDivElement, sel: Selection): boolean {
    return el.contains(sel.anchorNode) && el.contains(sel.focusNode)
  }

  function saveSelection(): void {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && getEl()?.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange()
    }
  }

  /**
   * 恢复编辑器选区（插入位置权威源，设计 D1）：
   * - 编辑器内活选区优先（键盘路径焦点从未离开 / Chromium blur 后 selection 对象常保留）——
   *   不应用 savedRange，savedRange 回归「夺焦恢复」本职。判定必须在 el.focus() 之前：
   *   focus 对无存活选区的编辑器会在头部新建 caret，先 focus 再判定会读到假活选区。
   * - 活选区失效（无选区 / 端点被移出编辑器，含跨边界选区）→ 应用 savedRange（blur 时刷新）；
   *   应用前 collapse 防非折叠旧选区误删正文，应用后 contains 校验防 savedRange 指向
   *   已删节点（addRange 静默失败）→ caret 落末尾。savedRange 为空时仅回焦，并把回焦后
   *   仍在编辑器外的活选区显式清掉（同上越界风险，与分支①同一判定）。
   */
  function restoreSelection(): void {
    const el = getEl()
    if (!el) return
    // ① 先读活选区并完成判定（el.focus() 副作用之前）；双端校验见 isSelectionInside
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && isSelectionInside(el, sel)) {
      el.focus() // 键盘路径本有焦点 no-op；选区保留型 blur 路径回拉焦点不动选区
      return
    }
    // ② 活选区失效 → 应用 savedRange
    if (!sel) return
    if (!savedRange) {
      el.focus() // 对齐现状：savedRange 为空仍回焦，防 chip 插入未聚焦编辑器
      // 回焦后活选区若仍不在编辑器内（引擎未把跨边界选区归一化进编辑器），显式清掉——
      // 缺此步时下游 insertChipAtSelection 的 range.deleteContents() 会作用到编辑器外 DOM。
      // rangeCount === 0（本就无选区）不动作：focus 可能已新建编辑器内 caret（见分支①注释），
      // 不干扰既有「仅 focus」兜底语义。
      if (sel.rangeCount > 0 && !isSelectionInside(el, sel)) sel.removeAllRanges()
      return
    }
    el.focus()
    savedRange.collapse(true)
    sel.removeAllRanges()
    sel.addRange(savedRange)
    if (!(sel.rangeCount > 0 && el.contains(sel.anchorNode))) placeCaretAtEnd(el)
  }

  /** savedRange 指向已删节点（addRange 静默失败）时的兜底：caret 落编辑器末尾 */
  function placeCaretAtEnd(el: HTMLDivElement): void {
    const range = document.createRange()
    let lastText: Text | null = null
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) lastText = walker.currentNode as Text
    if (lastText) {
      range.setStart(lastText, lastText.length)
    } else {
      range.selectNodeContents(el)
    }
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  function reset(): void {
    savedRange = null
  }

  return { saveSelection, restoreSelection, reset }
}
