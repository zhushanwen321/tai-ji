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
import { randomUuid } from '@taiji/core'
import { localFileUrl } from '@taiji/shared'
import { removeChipNode, isSpacerNode, placeCursorAfter } from './input-dom'
import type { ChipCallbacks } from './types'

/** 落位反馈淡染时长（demo 方案 C「插入瞬间」权威定值 800ms，样式侧 --sel-bg/--sel-edge 染色） */
const JUST_INSERTED_FLASH_MS = 800

/**
 * image badge 的 lead 缩略图构造（模块级纯 DOM 工厂，无闭包状态；demo chipHtml image 分支
 * `<img class="thumb">`，workbench.css .ichip .thumb 四值由壳层 ComposerInput 样式承载：
 * 16px / r-3.5px / object-fit cover / flex none）。
 * src 经 localFileUrl（shared 单点构造）走 local-file:// 协议（main protocol.handle 白名单：
 * attachments / tmpdir 两落点均放行）；加载失败（403 白名单 / 文件损坏）回退 ImageIcon
 * 占位 svg（12px，与 .chip-icon 规格一致，包 span.chip-icon 复用既有样式），不留破图。
 */
function makeImageThumb(path: string, displayName: string): HTMLElement {
  const img = document.createElement('img')
  img.className = 'chip-thumb'
  img.src = localFileUrl(path)
  img.alt = displayName
  img.addEventListener(
    'error',
    () => {
      // 回退占位：span.chip-icon（既有 12px 容器样式）+ lucide image 内联 svg。
      // lucide path 权威 = @lucide/vue Image iconNode（rect+circle+path 三段）；手动 DOM
      // 无法经 renderIcon 注入（SLASH_ICON_COMPONENTS 查表无 image key），内联手写同款。
      const host = document.createElement('span')
      host.className = 'chip-icon chip-thumb-fallback'
      host.setAttribute('aria-hidden', 'true')
      const SVG_NS = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '2')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('width', '12')
      svg.setAttribute('height', '12')
      const rect = document.createElementNS(SVG_NS, 'rect')
      for (const [k, v] of [['width', '18'], ['height', '18'], ['x', '3'], ['y', '3'], ['rx', '2'], ['ry', '2']] as const) {
        rect.setAttribute(k, v)
      }
      const circle = document.createElementNS(SVG_NS, 'circle')
      circle.setAttribute('cx', '9')
      circle.setAttribute('cy', '9')
      circle.setAttribute('r', '2')
      const pathEl = document.createElementNS(SVG_NS, 'path')
      pathEl.setAttribute('d', 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21')
      svg.append(rect, circle, pathEl)
      host.appendChild(svg)
      img.replaceWith(host)
    },
    { once: true },
  )
  return img
}

export function useComposerChipCommands(
  elRef: Ref<HTMLDivElement | null>,
  { onChanged, restoreSelection, renderIcon, t }: ChipCallbacks,
) {
  function getEl(): HTMLDivElement | null {
    return elRef.value
  }

  /**
   * chip 的 × 删除按钮（slash/file/image chip 通用，§2e）。内联 svg X（规格源
   * composer-input-refine.html 全部 chip × 实例显式 10px / stroke-width 2.2 + round cap，
   * ichip/ctxchip 两档一致；12px 属 banner ×，D1 裁决）。原生 <button type="button">（demo chipHtml
   * 同款）自带按钮语义与键盘可达（Tab 聚焦 + Enter/Space 触发 click），不另设 role；
   * aria-label 保留——按钮文本恒空，segment-parse 的 isInChipXSubtree 拒绝逻辑不受影响
   * （按 .chip-x class 判定，与 tagName 无关）。button 的 UA 默认样式由壳层 .chip-x 规则
   * 清零（ComposerInput.vue：background/border/padding/font）。
   */
  function makeXButton(chip: HTMLElement): HTMLElement {
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'chip-x'
    x.setAttribute('aria-label', t('composable.removeLabel'))
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2.2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('width', '10')
    svg.setAttribute('height', '10')
    for (const d of ['M18 6 6 18', 'm6 6 12 12']) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    }
    x.appendChild(svg)
    x.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      removeChipNode(chip, onChanged)
    })
    return x
  }

  /**
   * 前缀符号标记（$ @ #，demo .pre 元数据层）：mono 小字弱化为类型标记，辨型交给图标
   * 与前缀，不挪用语义色。aria-hidden——序列化层拍平 mention-at 时前缀由 label 语义
   * 承载（无 dataset 旧通路 textContent 拍平仍含 @，见 insertMentionChip 注释）。
   */
  function makePreMark(pre: string): HTMLElement {
    const preEl = document.createElement('span')
    preEl.className = 'chip-pre'
    preEl.textContent = pre
    preEl.setAttribute('aria-hidden', 'true')
    return preEl
  }

  /**
   * chip 落位共用段：无选区 appendChild 到末尾，有选区删选区内容后插到光标处，
   * chip 后补 ZWSP spacer（光标锚点 + 删除 chip 时一并清理）并把光标定位其后。
   * 各 chip 插入函数共用（slash/skill/file/image/mention/session/subagent 全类型内联 chip——
   * 结构惯例收敛，防多份漂移）。
   *
   * 落位反馈（demo 方案 C「插入瞬间」）：just-inserted 淡染 800ms 后摘除。timer 是本
   * composable 闭包级单例（对齐 demo flashTimer 组件级单例语义；不放大更外层模块级——
   * split 双 Composer 实例并发插入会跨实例互 clear，前一枚 chip 淡染将永不摘除）。
   * 连续插入时旧 timer 被 clearTimeout 顺延（demo 同款）；旧 timer 闭包持有的 chip 若
   * 已被删除（slash 替换语义），回调对已分离节点摘 class，无害。
   */
  let justInsertedTimer: ReturnType<typeof setTimeout> | null = null
  function flashJustInserted(chip: HTMLElement): void {
    chip.classList.add('just-inserted')
    if (justInsertedTimer !== null) clearTimeout(justInsertedTimer)
    justInsertedTimer = setTimeout(() => {
      chip.classList.remove('just-inserted')
      justInsertedTimer = null
    }, JUST_INSERTED_FLASH_MS)
  }

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
    flashJustInserted(chip)
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
    // title 全名（spec §2「title 给全名」）：label 同文，悬停兜底长名截断
    const commandLabel = command.startsWith('/') ? command : `/${command}`
    chip.title = commandLabel
    renderIconInto(chip, icon)
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = commandLabel
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
    // title 全名（spec §2）：含行号段的完整引用文本，悬停兜底长路径截断
    chip.title = labelText
    chip.appendChild(makePreMark('$'))
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = labelText
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /** 插入图片 badge（Cmd/Ctrl+V 富呈现通路）。
   *  lead = 16px 真图缩略（demo .ichip .thumb；demo 对齐），见 makeImageThumb。 */
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
    // randomUuid 而非 crypto.randomUUID：非安全上下文（LAN http）下为 undefined，见 contenteditable 同款注释
    chip.dataset.chipId = randomUuid()
    chip.dataset.chipPath = path
    chip.dataset.chipFileName = fileName
    chip.dataset.chipDisplayName = displayName
    chip.dataset.chipNeedsMigrate = needsMigrate ? 'true' : 'false'
    // title 全名（spec §2）：其余 chip 类均有 title，本类曾是唯一漏项（S-A3），悬停兜底长名截断
    chip.title = displayName
    chip.appendChild(makeImageThumb(path, displayName))
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = displayName
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
    insertChipAtSelection(el, chip)
    onChanged()
  }

  /**
   * 插入 @ mention 内联 chip（§2d）。# 入口委托 insertFileChip（向后兼容）。
   *
   * @ 分支（旧通路）：结构化 pre(@) + label(name) + × 按钮，与实体 chip 形态对齐，但
   * 刻意不加 dataset（保持旧通路无 dataset 现状）——segment-parse 对无 dataset mention-at
   * 走文本拍平（设计 F3 历史兼容），拍平结果 pre 文本 + label 文本 = `@{name}`，与旧
   * 纯 textContent 形态逐字节一致，序列化契约零改动；× 子树经 isInChipXSubtree 拒绝、
   * svg 无文本，均不进 segments。
   */
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
    chip.title = name // title 全名（spec §2）：被 @ 的名字，悬停兜底截断
    chip.appendChild(makePreMark('@'))
    const label = document.createElement('span')
    label.className = 'chip-label'
    label.textContent = name
    chip.appendChild(label)
    chip.appendChild(makeXButton(chip))
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
    chip.title = label // title 全名（spec §2）：人可读标题，悬停兜底截断
    chip.appendChild(makePreMark('#'))
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
    chip.title = `@${slug}` // title 全名（spec §2）：带前缀的完整定向文本
    chip.appendChild(makePreMark('@'))
    const labelEl = document.createElement('span')
    labelEl.className = 'chip-label'
    labelEl.textContent = slug
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
