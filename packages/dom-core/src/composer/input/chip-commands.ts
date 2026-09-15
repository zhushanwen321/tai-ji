/**
 * composer chip DOM 操作 —— packages/dom-core/src/composer/input/chip-commands.ts（W2）。
 *
 * 定位：迁自 renderer useComposerChipCommands.ts（341 行）。slash 命令 chip / @·# mention chip /
 * image badge 的 DOM 创建与删除。
 *
 * [W2 改造] 原 import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons' + i18n，
 * 现经 callbacks.renderIcon/t 注入（ADR-0058 边界修复：createVNode/render 收敛为注入 callback，
 * dom-core 零 vue render import）。
 * DOM 辅助（isSpacerNode/placeCursorAfter/removeChipNode）委托 input-dom.ts。
 *
 * 不含：contenteditable 事件处理（contenteditable.ts）、模板结构、props/emits 声明。
 */
import { type Ref } from 'vue'
import { removeChipNode, isSpacerNode, placeCursorAfter } from './input-dom'
import type { ChipCallbacks } from './types'

export function useComposerChipCommands(
  elRef: Ref<HTMLDivElement | null>,
  { onChanged, restoreSelection, renderIcon, t }: ChipCallbacks,
) {
  function getEl(): HTMLDivElement | null {
    return elRef.value
  }

  /** chip 的 × 删除按钮（slash/file/image chip 通用，§2e） */
  function makeXButton(chip: HTMLElement): HTMLElement {
    const x = document.createElement('span')
    x.className = 'chip-x'
    x.setAttribute('role', 'button')
    x.setAttribute('aria-label', t('composable.removeLabel'))
    x.textContent = '×'
    x.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      removeChipNode(chip, onChanged)
    })
    return x
  }

  /**
   * chip 落位共用段：无选区 appendChild 到末尾，有选区删选区内容后插到光标处，
   * chip 后补 ZWSP spacer（光标锚点 + 删除 chip 时一并清理）并把光标定位其后。
   * 各 chip 插入函数共用（slash/skill/file/image/mention/session/subagent 全类型内联 chip——
   * 结构惯例收敛，防多份漂移）。
   */
  function insertChipAtSelection(el: HTMLDivElement, chip: HTMLElement): void {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) {
      el.appendChild(chip)
    } else {
      const range = sel.getRangeAt(0)
      range.deleteContents()
      range.insertNode(chip)
    }
    const spacer = document.createTextNode('\u200B')
    chip.after(spacer)
    placeCursorAfter(spacer)
  }

  /**
   * 把 lucide 图标渲染进容器元素（contenteditable chip 走手动 DOM，无法用 <component>）。
   * 渲染经 callbacks.renderIcon 注入（壳层用 createVNode/render 实现），dom-core 只负责
   * DOM 编排：创建 host span → 调 renderIcon → 渲染成功才挂载。
   * getText 的 TreeWalker(SHOW_TEXT) 不会读到 svg（无文本子节点），故图标不影响发送文本。
   */
  function renderIconInto(container: HTMLElement, iconKey?: string): void {
    const host = document.createElement('span')
    host.className = 'chip-icon'
    host.setAttribute('aria-hidden', 'true')
    if (renderIcon(host, iconKey)) {
      container.appendChild(host)
    }
  }

  /**
   * 插入 slash 命令 chip（设计 D4-a：视觉就地 + 替换语义，只允许一个，整体可删，× 可点删）。
   *
   * 命令分支（非 '/skill:' 前缀）：仅移除已有命令 chip（dataset.chipType==='slash'，维持
   * 单命令不变量——pi 命令模型 = 消息级单命令）+ insertChipAtSelection 落在光标处，
   * skill chip（chipType='skill'）不再被误删；「必须在最前」的行首约束由序列化层
   * segmentsToText 归位承担（shared D4-c），DOM 位置层就地化。
   *
   * skill 分支（'/skill:' 前缀）：委托 insertSkillChip（skill 语义单点）——u4 起行首浮层 skill 项
   * 已直接路由到 insertSkillChip，本分支只承接带 '/skill:' 前缀的异常/历史输入。委托后形态与
   * 行首浮层通路一致（光标处 + 不删其他 chip），不再走旧的「删光全部 .slash-chip +
   * 强制插最前 + 丢 location」破坏性通路（该形态是失败模式 C 的破坏面）。
   */
  function insertSlashChip(command: string, icon?: string): void {
    const el = getEl()
    if (!el) return
    if (command.startsWith('/skill:')) {
      // 单次 restoreSelection 不变：委托路径由 insertSkillChip 内部调用一次（原分支在此直接调用，
      // 改成委托后不重复）；位置语义由「强制最前」改为「光标处」（与行首浮层 skill 项一致）。
      insertSkillChip(command.slice('/skill:'.length), undefined, icon)
      return
    }
    // restoreSelection 活选区优先（设计 D1）：键盘选中路径 chip 落呼出位置，blur 路径落 savedRange
    restoreSelection()
    el.focus()
    // 替换语义只针对命令 chip；skill chip 复用 .slash-chip class 但不在此删除范围（D4-a）
    el.querySelectorAll<HTMLElement>('.slash-chip').forEach((n) => {
      if (n.dataset.chipType === 'slash') removeChipNode(n, onChanged)
    })
    const chip = document.createElement('span')
    chip.className = 'slash-chip'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'slash'
    chip.dataset.chipName = command.startsWith('/') ? command.slice(1) : command
    renderIconInto(chip, icon)
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = command.startsWith('/') ? command : `/${command}`
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /**
   * 插入 skill 标记 chip（多 skill 注入设计 D2）：类比 insertFileChip 走 insertChipAtSelection
   * 通用机制——插在光标处、多个共存（与 insertSlashChip 的「唯一/替换语义」命令语义区分，
   * 不清除已存在 chip）、× 删除 / Backspace 整块删除（复用 .slash-chip 的既有删除通路）。
   *
   * DOM 形态复用 .slash-chip class + dataset.chipType='skill'：getSegmentsFromEl 的 skill
   * 分支（chipType==='skill' → skill segment，带 chipLocation 则带上）零改动即可解析
   * 任意位置多个 skill chip（D2 证据：数据模型层零改动），视觉复用 ComposerInput 的
   * .slash-chip 紫色 chip 样式。
   * location 可选（panel 态 sourceInfo.path / landing 态 SkillInfo.sourcePath，可得时带上）；
   * 缺失时 segment 不带 location，runtime 注入器以 name 经 get_commands 权威映射解析（D4）。
   */
  function insertSkillChip(name: string, location?: string, icon?: string): void {
    const el = getEl()
    if (!el) return
    // restoreSelection 内部保证活选区优先（设计 D1）：编辑器内活选区原样使用（键盘路径 chip 落
    // 呼出位置），仅活选区失效时才应用 savedRange（blur 回退）——调用方无需感知键盘/点击路径
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'slash-chip'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'skill'
    chip.dataset.chipName = name
    if (location) chip.dataset.chipLocation = location
    // C5 tooltip：告知发送时注入行为与体量上限（经 callbacks.t 注入，同 removeLabel 机制）
    chip.title = t('composable.skillChipTitle')
    renderIconInto(chip, icon)
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = name
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /** 插入 # 文件引用内联 chip（结构化 file segment，ADR-0040）。 */
  function insertFileChip(path: string, lineRange?: [number, number]): void {
    const el = getEl()
    if (!el) return
    // restoreSelection 内部保证活选区优先（设计 D1）：编辑器内活选区原样使用（键盘路径 chip 落
    // 呼出位置），仅活选区失效时才应用 savedRange（blur 回退）——调用方无需感知键盘/点击路径
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-file'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'file'
    chip.dataset.chipPath = path
    let labelText = path
    if (lineRange) {
      const [start, end] = lineRange
      chip.dataset.chipLineStart = String(start)
      chip.dataset.chipLineEnd = String(end)
      labelText += start === end ? `:L${start}` : `:L${start}-L${end}`
    }
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = labelText
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /** 插入图片 badge（Cmd/Ctrl+V 富呈现通路）。 */
  function insertImageBadge(path: string, fileName: string, displayName: string, needsMigrate: boolean = false): void {
    const el = getEl()
    if (!el) return
    // restoreSelection 内部保证活选区优先（设计 D1）：编辑器内活选区原样使用（键盘路径 chip 落
    // 呼出位置），仅活选区失效时才应用 savedRange（blur 回退）——调用方无需感知键盘/点击路径
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-file image-chip'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'image'
    chip.dataset.chipId = crypto.randomUUID()
    chip.dataset.chipPath = path
    chip.dataset.chipFileName = fileName
    chip.dataset.chipDisplayName = displayName
    chip.dataset.chipNeedsMigrate = needsMigrate ? 'true' : 'false'
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = displayName
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /** 插入 @ mention 内联 chip（§2d：蓝名）。# 入口委托 insertFileChip（向后兼容）。 */
  function insertMentionChip(type: '@' | '#', name: string): void {
    if (type === '#') {
      insertFileChip(name)
      return
    }
    const el = getEl()
    if (!el) return
    // restoreSelection 内部保证活选区优先（设计 D1）：编辑器内活选区原样使用（键盘路径 chip 落
    // 呼出位置），仅活选区失效时才应用 savedRange（blur 回退）——调用方无需感知键盘/点击路径
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-at'
    chip.contentEditable = 'false'
    chip.textContent = `@${name}`
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /**
   * 插入 session 引用 chip（四符号体系 # session 新语义）。
   * 结构照 insertFileChip 惯例（chip-label + × 按钮 + dataset + ZWSP spacer）：
   * label 用于展示（人可读标题），sessionId 存 dataset 供 getSegmentsFromEl 产出
   * session segment（序列化为 #<sessionId>，对齐 TUI session_read 协议）。
   */
  function insertSessionChip(sessionId: string, label: string): void {
    const el = getEl()
    if (!el) return
    // restoreSelection 内部保证活选区优先（设计 D1）：编辑器内活选区原样使用（键盘路径 chip 落
    // 呼出位置），仅活选区失效时才应用 savedRange（blur 回退）——调用方无需感知键盘/点击路径
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-session'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'session'
    chip.dataset.chipSessionId = sessionId
    chip.dataset.chipLabel = label
    const labelEl = document.createElement('span')
    labelEl.className = 'chip-label'
    labelEl.textContent = label
    chip.appendChild(labelEl)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /**
   * 插入 subagent 定向 chip（四符号体系 @ 新语义，修复 F3：现 mention-at 无 dataset）。
   * 复用 mention-at 蓝色样式（insertMentionChip 的视觉惯例），但结构升级：
   * dataset（chipType/chipSubagentId/chipSlug）+ chip-label + × 按钮——
   * 旧 insertMentionChip 产的无 dataset chip 保持不动（历史消息编辑兼容）。
   */
  function insertSubagentChip(subagentId: string, slug: string): void {
    const el = getEl()
    if (!el) return
    // restoreSelection 内部保证活选区优先（设计 D1）：编辑器内活选区原样使用（键盘路径 chip 落
    // 呼出位置），仅活选区失效时才应用 savedRange（blur 回退）——调用方无需感知键盘/点击路径
    restoreSelection()
    el.focus()
    const chip = document.createElement('span')
    chip.className = 'mention-chip mention-at'
    chip.contentEditable = 'false'
    chip.dataset.chipType = 'subagent'
    chip.dataset.chipSubagentId = subagentId
    chip.dataset.chipSlug = slug
    const labelEl = document.createElement('span')
    labelEl.className = 'chip-label'
    labelEl.textContent = `@${slug}`
    chip.appendChild(labelEl)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /**
   * Backspace 判定的删除目标：折叠选区下，TEXT_NODE 走 offset 0 / spacer 末尾两路，
   * element 容器取 childNodes[offset - 1]。选区锚点不在编辑器内返回 null（不处理）。
   */
  function findBackspaceTarget(el: HTMLDivElement, sel: Selection): Node | null {
    if (!el.contains(sel.anchorNode)) return null
    const range = sel.getRangeAt(0)
    const container = range.startContainer
    const offset = range.startOffset
    if (container.nodeType === Node.TEXT_NODE) {
      return prevNodeFromTextNode(container, offset)
    }
    return container.childNodes[offset - 1] ?? null
  }

  /**
   * TEXT_NODE 的前邻节点：offset 0（chip 后紧跟文本的开头）或 spacer 末尾
   * （ZWSP 光标锚点，insertChipAtSelection 落位产物）；其余位置无删除目标。
   */
  function prevNodeFromTextNode(container: Node, offset: number): Node | null {
    const text = container.textContent ?? ''
    if (offset === 0) {
      return container.previousSibling
    }
    if (isSpacerNode(container) && offset === text.length) {
      return container.previousSibling
    }
    return null
  }

  /** 前邻节点是否为可整删的 chip 元素（slash / mention / image 三类 class 命中其一）。 */
  function isDeletableChipNode(node: Node | null): node is HTMLElement {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false
    const ep = node as HTMLElement
    return (
      ep.classList.contains('slash-chip') ||
      ep.classList.contains('mention-chip') ||
      ep.classList.contains('image-chip')
    )
  }

  /** Backspace 紧跟 chip 时整体删 chip（§2e：backspace 一次删整块）。返回 true 表示已处理。 */
  function handleBackspaceOnChip(): boolean {
    const el = getEl()
    if (!el) return false
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
    const target = findBackspaceTarget(el, sel)
    if (!isDeletableChipNode(target)) return false
    removeChipNode(target, onChanged)
    return true
  }

  return {
    insertSlashChip,
    insertSkillChip,
    insertMentionChip,
    insertFileChip,
    insertImageBadge,
    insertSessionChip,
    insertSubagentChip,
    handleBackspaceOnChip,
  }
}
