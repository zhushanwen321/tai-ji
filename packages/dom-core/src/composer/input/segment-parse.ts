/**
 * contenteditable → Segment[] 解析（W2 从 input-dom.ts 提取，行为不变）。
 *
 * 提取动机：input-dom.ts 达 max-lines 上限（503 > 500），本子模块聚集
 * getSegmentsFromEl 的整条 DOM 遍历链（BLOCK_LINE_TAGS / SegmentParseState /
 * visitNode 家族 helper / getTextFromEl），是内聚可独立的一层，提取后 input-dom
 * 只保留触发检测、光标视觉行、粘贴与 chip DOM 辅助。
 *
 * 零 renderer import：仅依赖 @taiji/shared（segmentsToText/Segment）+ 浏览器 DOM API。
 */
import { segmentsToText } from '@taiji/shared'
import type { Segment } from '@taiji/shared'


/**
 * contenteditable 块级分行元素（粘贴换行还原的 DOM 形态）。
 *
 * Chromium `execCommand('insertText')`（onPaste 通路）对含 \n 文本产出的不是 <br>，
 * 而是块级 div 分行（实测 innerHTML：`line1<div>line2</div><div>line3</div>`）。
 * 提取时必须把这些块级边界还原为 \n，否则粘贴的多行文本换行全部丢失
 * （输入框视觉有换行、发送内容与气泡渲染都无换行的静默不一致）。P 一并覆盖
 * （execCommand 部分场景的块级产出形态）。
 */
const BLOCK_LINE_TAGS = new Set(['DIV', 'P'])

/**
 * getSegmentsFromEl 遍历可变状态（visitNode 家族 helper 的显式传参载体）。
 * visitNode 从 getSegmentsFromEl 闭包提升为模块级函数后，共享可变量全部收进此对象
 * 按参数显式传递，不引入隐式闭包共享；字段只由各 helper 按原语义改写。
 */
type SegmentParseState = {
  segments: Segment[]
  pendingText: string | null
  /**
   * ── 块级分行还原状态 ──
   * 块级元素进入/离开都幂等置位（`</div><div>` 相邻边界合并成一个），
   * 下一个实际内容（text/br/chip）出现时才消费补 \n（懒补）——文档尾的块级收尾换行
   * 自然丢弃（粘贴 'a\nb' 产出 `a<div>b</div>`，还原 'a\nb' 无多余尾换行）。
   */
  pendingBlockBreak: boolean
  rejectChips: Set<Element>
}

function flushText(state: SegmentParseState): void {
  if (state.pendingText !== null && state.pendingText !== '') {
    state.segments.push({ type: 'text', text: state.pendingText })
  }
  state.pendingText = null
}

/** 消费挂起的块级分界：已有文本且未以换行结尾时补 \n（首块前/空行 br 后不重复补） */
function consumeBlockBreak(state: SegmentParseState): void {
  if (!state.pendingBlockBreak) return
  state.pendingBlockBreak = false
  if (state.pendingText && !state.pendingText.endsWith('\n')) {
    state.pendingText += '\n'
  }
}

// ── visitNode 的节点判定 helper（判定顺序保持原样：chip-x → rejectChips → 五类 chip）──

/** node 是否落在 .chip-x（× 删除按钮）子树：文本节点查父链（?. 防父为 document），元素节点查自身+祖先 */
function isInChipXSubtree(node: Node): boolean {
  return Boolean(node.parentElement?.closest('.chip-x') || (node as Element).closest?.('.chip-x'))
}

/** node 是否落在已消费 chip 的拒绝子树内（chip 子树内容不混入 segments 的防御闸） */
function isInsideRejectedChip(node: Node, rejectChips: Set<Element>): boolean {
  for (const chip of rejectChips) {
    if (chip.contains(node)) return true
  }
  return false
}

function isSlashChipNode(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).classList?.contains('slash-chip') === true
  )
}

function isImageChipNode(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as Element).classList?.contains('image-chip') === true ||
      (node as HTMLElement).dataset?.chipType === 'image')
  )
}

function isMentionFileChipNode(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).classList?.contains('mention-file') === true
  )
}

// session/subagent chip 用 dataset.chipType 判定而非 class：mention-at 是新旧共用 class
// （insertMentionChip 产的旧 @ chip 无 dataset，须继续走文本拍平保持历史兼容，设计 F3）
function isSessionChipNode(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset?.chipType === 'session'
}

function isSubagentChipNode(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset?.chipType === 'subagent'
  )
}

// ── visitNode 的 chip 处理 helper（每类保持原 consumeBlockBreak → flush/拼装 → rejectChips.add 时序）──

/** slash-chip：按 dataset.chipType 分流——skill 产 skill segment，命令产 slash segment（D4-b） */
function visitSlashChip(node: Node, state: SegmentParseState): void {
  consumeBlockBreak(state)
  const chip = node as HTMLElement
  const chipType = chip.dataset.chipType
  if (chipType === 'skill') {
    flushText(state)
    const name = chip.dataset.chipName ?? ''
    const location = chip.dataset.chipLocation
    state.segments.push(location ? { type: 'skill', name, location } : { type: 'skill', name })
  } else {
    // 命令 chip 不再拍平进文本：产结构化 slash 段（name 不含 '/' 前缀，insertSlashChip
    // 已如此存储），序列化层 segmentsToText 归位提为首段满足 pi 行首协议（设计 D4-b/D4-c）
    flushText(state)
    state.segments.push({ type: 'slash', name: chip.dataset.chipName ?? '' })
  }
  state.rejectChips.add(chip)
}

/** image-chip：粘贴/拖入 pending 占位只拒绝不进 segments（发送时静默丢弃），正式 chip 产 image segment */
function visitImageChip(node: Node, state: SegmentParseState): void {
  consumeBlockBreak(state)
  const chip = node as HTMLElement
  const chipPath = chip.dataset.chipPath ?? ''
  // 占位符（粘贴/拖入 pending）path 无效，留在 DOM 但不进 segments（发送时静默丢弃）
  if (/^__(?:paste|drag)_pending_[0-9a-f-]+__$/.test(chipPath)) {
    state.rejectChips.add(chip)
    return
  }
  flushText(state)
  state.segments.push({
    type: 'image',
    id: chip.dataset.chipId ?? '',
    path: chip.dataset.chipPath ?? '',
    fileName: chip.dataset.chipFileName ?? '',
    displayName: chip.dataset.chipDisplayName ?? '',
    needsMigrate: chip.dataset.chipNeedsMigrate === 'true',
  })
  state.rejectChips.add(chip)
}

/** mention-file chip：dataset 带 lineRange 产带 lineRange 的 file segment，否则只有 path */
function visitMentionFileChip(node: Node, state: SegmentParseState): void {
  consumeBlockBreak(state)
  const chip = node as HTMLElement
  flushText(state)
  const path = chip.dataset.chipPath ?? ''
  const ls = chip.dataset.chipLineStart
  const le = chip.dataset.chipLineEnd
  if (ls !== undefined && le !== undefined) {
    state.segments.push({ type: 'file', path, lineRange: [Number(ls), Number(le)] })
  } else {
    state.segments.push({ type: 'file', path })
  }
  state.rejectChips.add(chip)
}

function visitSessionChip(node: Node, state: SegmentParseState): void {
  consumeBlockBreak(state)
  const chip = node as HTMLElement
  flushText(state)
  state.segments.push({
    type: 'session',
    sessionId: chip.dataset.chipSessionId ?? '',
    label: chip.dataset.chipLabel ?? '',
  })
  state.rejectChips.add(chip)
}

function visitSubagentChip(node: Node, state: SegmentParseState): void {
  consumeBlockBreak(state)
  const chip = node as HTMLElement
  flushText(state)
  state.segments.push({
    type: 'subagent',
    subagentId: chip.dataset.chipSubagentId ?? '',
    slug: chip.dataset.chipSlug ?? '',
  })
  state.rejectChips.add(chip)
}

/** 依次尝试五类 chip 分支；命中任一即处理并返回 true（调用方终止本节点的后续分支） */
function tryVisitChipNode(node: Node, state: SegmentParseState): boolean {
  if (isSlashChipNode(node)) {
    visitSlashChip(node, state)
    return true
  }
  if (isImageChipNode(node)) {
    visitImageChip(node, state)
    return true
  }
  if (isMentionFileChipNode(node)) {
    visitMentionFileChip(node, state)
    return true
  }
  if (isSessionChipNode(node)) {
    visitSessionChip(node, state)
    return true
  }
  if (isSubagentChipNode(node)) {
    visitSubagentChip(node, state)
    return true
  }
  return false
}

function visitTextNode(node: Node, state: SegmentParseState): void {
  consumeBlockBreak(state)
  const raw = node.textContent ?? ''
  const filtered = raw.replace(/\u00A0/g, ' ').replace(/\u200B/g, '')
  state.pendingText = (state.pendingText ?? '') + filtered
}

function visitBrNode(state: SegmentParseState): void {
  consumeBlockBreak(state)
  state.pendingText = (state.pendingText ?? '') + '\n'
}

/** 非芯片元素节点下钻：块级元素进入/离开幂等挂起分界，其余仅递归子节点 */
function visitElementNode(node: Node, state: SegmentParseState): void {
  if (BLOCK_LINE_TAGS.has(node.nodeName)) {
    state.pendingBlockBreak = true
    for (const child of Array.from(node.childNodes)) visitNode(child, state)
    state.pendingBlockBreak = true
  } else {
    for (const child of Array.from(node.childNodes)) visitNode(child, state)
  }
}

/** DOM 遍历主干：判定/处理分派到各 helper，自身只留分支路由 */
function visitNode(node: Node, state: SegmentParseState): void {
  if (isInChipXSubtree(node)) return
  if (isInsideRejectedChip(node, state.rejectChips)) return
  if (tryVisitChipNode(node, state)) return
  if (node.nodeType === Node.TEXT_NODE) {
    visitTextNode(node, state)
    return
  }
  if (node.nodeName === 'BR') {
    visitBrNode(state)
    return
  }
  if (node.nodeType === Node.ELEMENT_NODE) visitElementNode(node, state)
}

/**
 * 把 contenteditable DOM 解析为 Segment[]（W2）。
 *
 * 递归遍历逻辑与原 getTextFromEl 的 TreeWalker 一致（TEXT_NODE + BR + 跳过 .chip-x），
 * 但产出结构化 segment 而非拍平字符串：
 * - .slash-chip 元素 → 读 dataset.chipType：'skill' 产出 skill segment（有 location 则带上），
 *   其余（命令 chip）产出 slash segment（读 dataset.chipName，不含 '/' 前缀，D4-b）。
 *   遇到 chip 元素后跳过其子树
 *   （icon/label/x 按钮不单独遍历）——用 rejectChipSubtree 集合在 visitNode 里直接拒绝。
 * - 文本节点：累加进当前 text segment（相邻文本节点合并，不每个产一个 segment），
 *   过滤 \u00A0→空格、\u200B→删除（与原 getTextFromEl 一致）。
 * - BR：在当前 text segment 里追加 \n。
 * - 块级元素（BLOCK_LINE_TAGS）：进入/离开幂等挂起分界，下一个实际内容出现时懒补 \n
 *   （`</div><div>` 相邻边界合并为一个换行；`<div><br></div>` 空块还原为空行）；
 *   文档尾未消费的分界自然丢弃（无多余尾换行）。
 */
export function getSegmentsFromEl(el: HTMLDivElement | null): Segment[] {
  if (!el) return []
  const state: SegmentParseState = {
    segments: [],
    pendingText: null,
    pendingBlockBreak: false,
    rejectChips: new Set<Element>(),
  }
  for (const child of Array.from(el.childNodes)) visitNode(child, state)
  flushText(state)
  return state.segments
}

/** 提取纯文本：getSegmentsFromEl + segmentsToText 的便捷封装 */
export function getTextFromEl(el: HTMLDivElement | null): string {
  return segmentsToText(getSegmentsFromEl(el))
}
