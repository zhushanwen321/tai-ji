/**
 * composer contenteditable 输入组合逻辑 —— packages/dom-core/src/composer/input/contenteditable.ts（W2）。
 *
 * 定位：迁自 renderer useContenteditableInput.ts（873 行）的 composable 部分。
 * 职责（单一变化轴「contenteditable 输入事件 + 文本/光标操作」）：
 * - getText/getSegments：TreeWalker 文本提取（委托 input-dom.ts）
 * - syncEmpty/detectHashTrigger：空态判定与 # 文件触发检测
 * - scrollCursorIntoView：Shift+Enter 后光标滚动进可见区
 * - saveSelection/restoreSelection：命令浮层夺焦前后保存/恢复光标
 * - clearSlashQueryText/clearHashQueryText/clearDollarFileQueryText/clearSubagentQueryText：清过滤文本
 * - clear/setText/insertTextAtCursor：程序化整框写入
 * - onInput/onKeydown/onCompositionEnd/onPaste：输入事件处理（IME/Shift+Enter/paste 富呈现）
 * - moveCaretVertical：视觉行上下移动（委托 input-dom）
 *
 * [W2 改造] handleImagePasteEvent 原直接 import handleImagePaste（走 IPC），现改经 callbacks.pasteImage
 * 注入（clarify C1 D1），core 不再 import useImageAttachment。paste 通路（占位 badge 插入 +
 * 异步回填/降级编排）保留，仅 IPC 调用上移壳层。
 *
 * 行为约定（byte-for-byte 与原 useContenteditableInput 一致，CRITICAL）：
 * - IME 组合中（composing.value / e.isComposing）不拦截 Enter
 * - Shift+Enter → insertLineBreak + onInput + scrollCursorIntoView
 * - Enter（无 shift）→ emit('keydown', e)
 */
import { ref, type Ref } from 'vue'
import type { Segment } from '@taiji/shared'
import {
  getSegmentsFromEl,
  getTextFromEl,
  detectHashTriggerFromEl,
  detectFileDollarTriggerFromEl,
  detectSubagentTriggerFromEl,
  detectSlashTriggerFromEl,
  detectSkillTriggerFromEl,
  getCaretLineRect,
  moveCaretVerticalOf,
  pickClipboardImageItem,
  findImageChipEl,
  applyImagePersistResult,
} from './input-dom'
import type { ContenteditableCallbacks, HandleImagePasteResult } from './types'
import { useSelectionRestore } from './selection-restore'

/**
 * Cmd/Ctrl+V 富呈现通路处理（原 useContenteditableInput 模块级私有，改接收 pasteImage）。
 *
 * 异步间隙（TO1）：先插占位 badge「粘贴中...」，await pasteImage 后回填真实 path/name；
 * 失败（IPC throw / 非 electron undefined / 读 blob 失败 → kind:'text'）移除占位 + insertText 降级。
 *
 * @param pasteImage 壳层注入的图片持久化回调（替代直接 import handleImagePaste）
 * @returns true 表示已接管（走 image 通路），false 表示无 image item（onPaste 回退纯文本通路）
 */
function handleImagePasteEvent(
  e: ClipboardEvent,
  deps: {
    getEl: () => HTMLDivElement | null
    insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
    onInput: () => void
    getSessionId: () => string | null
    pasteImage: (file: File, sessionId: string | null) => Promise<HandleImagePasteResult>
  },
): boolean {
  const imageItem = pickClipboardImageItem(e)
  const file = imageItem?.getAsFile()
  if (!file) return false
  const placeholderMark = `__paste_pending_${crypto.randomUUID()}__`
  deps.insertImageBadge(placeholderMark, placeholderMark, '粘贴中...', false)
  const sessionId = deps.getSessionId()
  void (async () => {
    const result = await deps.pasteImage(file, sessionId)
    const el = deps.getEl()
    const placeholder = el ? findImageChipEl(el, placeholderMark) : null
    applyImagePersistResult({
      placeholderEl: placeholder,
      result,
      insertImageBadge: deps.insertImageBadge,
    })
    deps.onInput()
  })()
  return true
}

/**
 * @param elRef contenteditable 根元素 ref
 * @param callbacks 触发事件 + Backspace-chip 删除委派 + pasteImage 注入
 */
export function useContenteditableInput(
  elRef: Ref<HTMLDivElement | null>,
  callbacks: ContenteditableCallbacks,
): {
  composing: Ref<boolean>
  isEmpty: Ref<boolean>
  onInput: () => void
  onKeydown: (e: KeyboardEvent) => void
  onCompositionEnd: () => void
  onPaste: (e: ClipboardEvent) => void
  syncEmpty: () => void
  getText: () => string
  getSegments: () => Segment[]
  saveSelection: () => void
  restoreSelection: () => void
  clearSlashQueryText: () => void
  clearHashQueryText: () => void
  clearDollarFileQueryText: () => void
  clearSubagentQueryText: () => void
  clearSkillQueryText: () => void
  clear: () => void
  setText: (text: string, caretPosition?: 'start' | 'end') => void
  insertTextAtCursor: (text: string) => void
  moveCaretVertical: (dir: 'up' | 'down') => 'moved' | 'at-edge'
} {
  const {
    onInput: emitInput,
    onSlashTrigger,
    onFileTrigger,
    onDollarFileTrigger,
    onSubagentTrigger,
    onSkillTrigger,
    shouldSuppressTriggers,
    onEnterKeydown,
    onKeydown: forwardKeydown,
    handleBackspaceOnChip,
    insertImageBadge,
    getSessionId,
    pasteImage,
  } = callbacks

  const composing = ref(false)
  const isEmpty = ref(true)
  // 选区保存/恢复（savedRange 闭包状态）提取到 selection-restore 工厂，实例级语义不变
  const selectionRestore = useSelectionRestore(getEl)
  let preferredCaretX: number | null = null

  function getEl(): HTMLDivElement | null {
    return elRef.value
  }

  function getText(): string {
    return getTextFromEl(getEl())
  }

  function getSegments(): Segment[] {
    return getSegmentsFromEl(getEl())
  }

  function syncEmpty(): void {
    isEmpty.value = getText().trim() === ''
  }

  function detectHashTrigger(): { query: string } | null {
    return detectHashTriggerFromEl(getEl())
  }

  /**
   * slash 触发检测编排（D5 正则化：光标所在行行首 / 才触发，替代全文 startsWith）。
   *
   * 双路设计的原因：真实用户输入路径必有光标（走 detectSlashTriggerFromEl 行首正则，
   * 多行任意行行首可触发——显式行为放宽，对齐 TUI）；程序化 input 事件（测试/辅助技术）
   * 无光标选区，回退旧 startsWith 判定（单行场景与旧行为等价，锁定既有回归）。
   * 「有光标但明确不命中」（如「帮我看看 /usr」空格后）不进兜底——否则第二行编辑时
   * 会被第一行行首 / 误触发。chip 存在时不触发（chip label 的 / 文本不构成新命令），
   * 沿用旧 hasChip 语义；slash-chip 后光标处的 / 天然不命中（光标前缀有 ZWSP spacer）。
   */
  function detectSlashTrigger(): { query: string } | null {
    const el = getEl()
    if (!el) return null
    const hasChip = !!el.querySelector('.slash-chip, .mention-chip')
    if (hasChip) return null
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      return detectSlashTriggerFromEl(el)
    }
    const text = getText()
    return text.startsWith('/') ? { query: text.slice(1) } : null
  }

  /**
   * skill 触发检测编排（多 skill 注入设计 D1/D2）。
   *
   * 与命令触发（detectSlashTrigger）互斥派发：两正则触发域不重叠（行首归命令、行中
   * 非换行空白后归 skill），同一次 onInput 至多一路非 null。无 hasChip 抑制——skill
   * 浮层解除「存在任何 chip 时 slash 不触发」限制（D2：多 skill chip 与正文混排是核心
   * 语义；slash-chip 后光标处的 / 天然不命中，前缀 ZWSP spacer 非 \s 空白）。
   * 无程序化兜底（对照 slash 的 startsWith 兜底）：skill 触发域是「行中空白后」，必须
   * 有光标才能定位「光标前文本」，程序化 input（无选区）返回 null（关闭浮层，安全侧）。
   */
  function detectSkillTrigger(): { query: string } | null {
    return detectSkillTriggerFromEl(getEl())
  }

  function onInput(): void {
    syncEmpty()
    const text = getText()
    emitInput(text)
    preferredCaretX = null
    // bash 豁免短路（设计 D6）：bash 态（!/!! 前缀）下符号全是命令语法成分，
    // 全部触发回调发 null（关闭浮层语义）且不做检测；draft 同步（emitInput）不受影响
    if (shouldSuppressTriggers?.()) {
      onSlashTrigger(null)
      onFileTrigger(null)
      onDollarFileTrigger?.(null)
      onSubagentTrigger?.(null)
      onSkillTrigger?.(null)
      return
    }
    onSlashTrigger(detectSlashTrigger())
    onFileTrigger(detectHashTrigger())
    onDollarFileTrigger?.(detectFileDollarTriggerFromEl(getEl()))
    onSubagentTrigger?.(detectSubagentTriggerFromEl(getEl()))
    onSkillTrigger?.(detectSkillTrigger())
  }

  function onCompositionEnd(): void {
    composing.value = false
    onInput()
  }

  function scrollCursorIntoView(): void {
    const el = getEl()
    if (!el) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return
    const range = sel.getRangeAt(0).cloneRange()
    const caretRect = getCaretLineRect(range)
    if (!caretRect) return
    const elRect = el.getBoundingClientRect()
    if (caretRect.bottom > elRect.bottom) {
      el.scrollTop += caretRect.bottom - elRect.bottom
    } else if (caretRect.top < elRect.top) {
      el.scrollTop -= elRect.top - caretRect.top
    }
  }

  function moveCaretVertical(dir: 'up' | 'down'): 'moved' | 'at-edge' {
    const el = getEl()
    if (!el) return 'at-edge'
    const { result, preferredX } = moveCaretVerticalOf(el, dir, preferredCaretX)
    preferredCaretX = preferredX
    return result
  }

  function onKeydown(e: KeyboardEvent): void {
    if (composing.value || e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        document.execCommand('insertLineBreak')
        onInput()
        scrollCursorIntoView()
        return
      }
      onEnterKeydown(e)
      return
    }
    if (e.key === 'Backspace' && handleBackspaceOnChip()) {
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      preferredCaretX = null
    }
    forwardKeydown(e)
  }

  function onPaste(e: ClipboardEvent): void {
    e.preventDefault()
    if (handleImagePasteEvent(e, { getEl, insertImageBadge, onInput, getSessionId, pasteImage })) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    document.execCommand('insertText', false, text)
    onInput()
  }

  /** 夺焦前保存选区（savedRange 归 selection-restore 工厂；preferredCaretX 属光标移动轴，此处清空） */
  function saveSelection(): void {
    selectionRestore.saveSelection()
    preferredCaretX = null
  }

  /** 夺焦后恢复选区（活选区优先 / savedRange 回退 / addRange 静默失败落末尾，语义见 selection-restore.ts） */
  const restoreSelection = selectionRestore.restoreSelection

  /**
   * 「符号+query 到光标」段删除的共用实现（boundaryLen 模式）。
   *
   * pattern 形如 /(?:^|\s)#(\S*)$/：m[0] 含边界（^ 空串 / \s 一字符）+ 符号 + query，
   * boundaryLen = m[0] 长度 - 1（符号）- query 长度 = 边界宽，删除起点 = m.index +
   * boundaryLen（符号处），终点 = 光标。绝不仿 slash 旧版的全清——多行草稿中段触发
   * 浮层后选中，全清会吞掉整框内容（旧 clearSlashQueryText 的已知 bug，D5 修正）。
   * 返回 true 表示删除了内容（调用方据此同步状态）；false = 无光标/不匹配，什么都不动。
   */
  function clearSymbolQueryBeforeCursor(el: HTMLDivElement | null, pattern: RegExp): boolean {
    if (!el) return false
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
    const node = sel.anchorNode
    if (!node || !el.contains(node)) return false
    if (node.nodeType !== Node.TEXT_NODE) return false
    const offset = sel.anchorOffset
    const text = node.textContent ?? ''
    const beforeCursor = text.slice(0, offset)
    const m = pattern.exec(beforeCursor)
    if (!m) return false
    const boundaryLen = m[0].length - 1 - m[1].length
    const symbolStart = (m.index ?? 0) + boundaryLen
    const range = document.createRange()
    range.setStart(node, symbolStart)
    range.setEnd(node, offset)
    range.deleteContents()
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  }

  /**
   * 清除行首 /query 段（D5 修正：从「清空整个输入框」改为 boundaryLen 模式只删
   * 「/ 到光标」段——中途触发浮层后选中不再吞掉整框草稿；无光标或不匹配时不动作）。
   * 选中浮层项的完整消费链（onCmdSelect: clearSlashQueryText → insertSlashChip）在
   * 真实用户流必有光标（contenteditable blur 时浏览器保留 range，refocus 后回到
   * query 处），与 clearHashQueryText 生产验证过的同一模式。
   */
  function clearSlashQueryText(): void {
    if (!clearSymbolQueryBeforeCursor(getEl(), /(?:^|\n)\/(\S*)$/)) return
    syncEmpty()
    emitInput(getText())
  }

  /** 清除 $query 段（$ 文件触发选中后清过滤文本，boundaryLen 模式，边界空格保留） */
  function clearDollarFileQueryText(): void {
    if (!clearSymbolQueryBeforeCursor(getEl(), /(?:^|\s)\$(\S*)$/)) return
    syncEmpty()
    emitInput(getText())
  }

  /** 清除 @query 段（@ subagent 触发选中后清过滤文本，boundaryLen 模式） */
  function clearSubagentQueryText(): void {
    if (!clearSymbolQueryBeforeCursor(getEl(), /(?:^|\s)@(\S*)$/)) return
    syncEmpty()
    emitInput(getText())
  }

  /** 清除 #query 段（# 文件触发选中后清过滤文本，行为与旧版一致——逻辑收敛进共用实现） */
  function clearHashQueryText(): void {
    if (!clearSymbolQueryBeforeCursor(getEl(), /(?:^|\s)#(\S*)$/)) return
    syncEmpty()
    emitInput(getText())
  }

  /**
   * 清除「空格 /query」段（skill 触发选中后清过滤文本，多 skill 注入 D2；boundaryLen
   * 模式与命令通道同款——边界空白保留不吞草稿。正则与 detectSkillTriggerFromEl 同源）。
   */
  function clearSkillQueryText(): void {
    if (!clearSymbolQueryBeforeCursor(getEl(), /[^\S\n]\/(\S*)$/)) return
    syncEmpty()
    emitInput(getText())
  }

  function clear(): void {
    const el = getEl()
    if (!el) return
    el.textContent = ''
    selectionRestore.reset()
    preferredCaretX = null
    syncEmpty()
    emitInput('')
  }

  function insertTextAtCursor(text: string): void {
    const el = getEl()
    if (!el) return
    restoreSelection()
    document.execCommand('insertText', false, text)
    onInput()
  }

  function setText(text: string, caretPosition: 'start' | 'end' = 'end'): void {
    const el = getEl()
    if (!el) return
    preferredCaretX = null
    el.replaceChildren()
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) el.appendChild(document.createElement('br'))
      if (parts[i]) el.appendChild(document.createTextNode(parts[i]))
    }
    selectionRestore.reset()
    el.focus()
    const range = document.createRange()
    if (caretPosition === 'start') {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const firstText = walker.nextNode()
      if (firstText) {
        range.setStart(firstText, 0)
        range.collapse(true)
      } else {
        range.selectNodeContents(el)
        range.collapse(true)
      }
    } else {
      let lastText: Text | null = null
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) lastText = walker.currentNode as Text
      if (lastText) {
        range.setStart(lastText, lastText.length)
        range.collapse(true)
      } else {
        range.selectNodeContents(el)
        range.collapse(false)
      }
    }
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    syncEmpty()
    emitInput(text)
  }

  return {
    composing,
    isEmpty,
    onInput,
    onKeydown,
    onCompositionEnd,
    onPaste,
    syncEmpty,
    getText,
    getSegments,
    saveSelection,
    restoreSelection,
    clearSlashQueryText,
    clearHashQueryText,
    clearDollarFileQueryText,
    clearSubagentQueryText,
    clearSkillQueryText,
    clear,
    setText,
    insertTextAtCursor,
    moveCaretVertical,
  }
}
