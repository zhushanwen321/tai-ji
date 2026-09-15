/**
 * composer input 模块 DOM 直连收敛层 —— packages/dom-core/src/composer/input/ 的 DOM 适配单一出口（W2）。
 *
 * 定位：slice design review TC1 落地——useContenteditableInput（873 行）+ useComposerChipCommands
 * 中所有 DOM 直连（document./window./Range/Selection/TreeWalker/getClientRects/caretRangeFromPoint）
 * 收敛到此文件的纯函数。其余 input composable（contenteditable/chip-commands/dragdrop）委托本文件，
 * 不再散布 DOM 直连。
 *
 * 来源：
 * - useContenteditableInput.ts 模块级函数：getSegmentsFromEl/getTextFromEl/detectHashTriggerFromEl/
 *   getCaretLineRect/getVisualLineRects/moveCaretVerticalOf/pickClipboardImageItem
 * - useComposerChipCommands.ts 模块级 DOM 辅助：findImageChipEl/findImageChipElById/isSpacerNode/
 *   placeCursorAfter/removeChipNode（重构为接收 onChanged 的纯函数）
 *
 * 零 renderer import：仅依赖 @taiji/shared（segmentsToText/Segment）+ 浏览器 DOM API。
 * core 运行在渲染进程，DOM 类型来自 TypeScript 默认 DOM lib（core tsconfig 未排除 DOM lib）。
 *
 * 测试环境：jsdom 支持 TreeWalker/Range/getClientRects（caretRangeFromPoint 除外，多行分支
 * 由 renderer 行为测试兜底，详见 design review boundaryConditionNote）。
 */
import { segmentsToText } from '@taiji/shared'
import type { Segment } from '@taiji/shared'
import type { VerticalMoveResult, HandleImagePasteResult } from './types'

/** ZWSP spacer 文本（image-chip / slash-chip 后跟的零宽空格，移除占位 badge 时一并清） */
export const CHIP_SPACER_ZWSP = '\u200B'

// ── 来自 useContenteditableInput：segments / 文本提取 ──

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
interface SegmentParseState {
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

// ── 来自 useContenteditableInput：触发检测 ──

/**
 * 符号触发检测共用前置：取光标（折叠选区）所在文本节点的光标前文本，用 pattern 匹配。
 * 四个检测函数（# / $ / @ / 行首 slash）共享同一前置（选区折叠 / 光标在 el 内 / 文本节点），
 * 差异只在 pattern——收敛一处避免四份漂移。
 * 返回 null 的两种含义由调用方语境区分：无光标（不可判定）与明确不命中。
 */
function matchTriggerBeforeCursor(
  el: HTMLDivElement | null,
  pattern: RegExp,
): { query: string } | null {
  if (!el) return null
  const sel = window.getSelection()
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null
  const node = sel.anchorNode
  if (!node || !el.contains(node)) return null
  const offset = sel.anchorOffset
  if (node.nodeType !== Node.TEXT_NODE) return null
  const beforeCursor = (node.textContent ?? '').slice(0, offset)
  const m = pattern.exec(beforeCursor)
  return m ? { query: m[1] } : null
}

/** # 触发检测（现行语义：文件引用，行为不变——符号语义切换由后续 wave 在 UI 层做绑定） */
export function detectHashTriggerFromEl(el: HTMLDivElement | null): { query: string } | null {
  // 行首或 \s（含全角空格）后跟 # 再到光标非空白——「任意位置」触发
  return matchTriggerBeforeCursor(el, /(?:^|\s)#(\S*)$/)
}

/**
 * $ 文件触发检测（四符号体系新符号，与 # 同正则形态）。
 * 已登记取舍（设计 D6）：非 bash 态下 ` $HOME` / ` ${var}` 等自然文本会触发——
 * `$` 在代码语境出现频率高是符号选择的固有噪声，由空候选不渲染浮层内建缓解。
 */
export function detectFileDollarTriggerFromEl(el: HTMLDivElement | null): { query: string } | null {
  return matchTriggerBeforeCursor(el, /(?:^|\s)\$(\S*)$/)
}

/** @ subagent 触发检测（与 # 同正则形态：行首或空格后跟 @） */
export function detectSubagentTriggerFromEl(el: HTMLDivElement | null): { query: string } | null {
  return matchTriggerBeforeCursor(el, /(?:^|\s)@(\S*)$/)
}

/**
 * 行首 slash 触发检测（D5 正则化，替代全文 startsWith 判定）。
 * 「行首」= 光标所在文本节点开头（跨节点换行由 <br>/块级边界产生，节点开头即行首）
 * 或节点内 \n 之后（防御：粘贴还原的罕见单节点含 \n 形态）。
 * 仅行首限定——空格后 `/` 不触发（「帮我看看 /usr/local/bin」高频路径文本，D5 否决项）。
 */
export function detectSlashTriggerFromEl(el: HTMLDivElement | null): { query: string } | null {
  return matchTriggerBeforeCursor(el, /(?:^|\n)\/(\S*)$/)
}

/**
 * skill 名合法 pattern（多 skill 注入设计 D1 误弹缓解）：小写字母/数字/连字符，0-64 字符
 * （0 = 刚敲完 `/` 无 query，合法——浮层列出全部 skill；64 对齐 pi MAX_NAME_LENGTH）。
 */
const SKILL_QUERY_PATTERN = /^[a-z0-9-]{0,64}$/

/**
 * skill 触发检测（多 skill 注入设计 D1）：行中空白（非换行）后 `/` 触发 skill-only 浮层。
 *
 * 正则 /[^\S\n]\/(\S*)$/：`[^\S\n]` = 空白但非换行（半角空格/tab/全角空格 U+3000/NBSP
 * 全覆盖，对齐 `#`/`$`/`@` 的 \s 空白语义仅排除 \n）——行首与换行后行首完整让位现有
 * 命令浮层（detectSlashTriggerFromEl），两正则触发域互斥无重叠（D1 仲裁：行首归命令，
 * 行中空白后归 skill），同一次输入至多一路命中。
 *
 * query 合法性过滤（D5 翻案后的误弹缓解）：query 一旦含 `/`、大写、下划线等 skill 名
 * 非法字符立即返回 null（关闭浮层）——「帮我看看 /usr」输到第二个 `/` 即关闭（场景 6①）。
 * 返回 null 的两种含义（无光标 / 不命中或 query 非法）由调用方语境区分（同四符号前置约定）。
 */
export function detectSkillTriggerFromEl(el: HTMLDivElement | null): { query: string } | null {
  const hit = matchTriggerBeforeCursor(el, /[^\S\n]\/(\S*)$/)
  if (!hit) return null
  return SKILL_QUERY_PATTERN.test(hit.query) ? hit : null
}

// ── 来自 useContenteditableInput：光标 / 视觉行 ──

/**
 * 视觉行 rect 过滤器：`<br>` 硬换行会产生零宽 line box（left === right），
 * 这些零宽 rect 会污染 lineRects 导致 currentLine/targetLine 偏移（spec 缺陷 5）。
 *
 * 两种零宽 rect：行尾 br（top 与有宽行相同，过滤）vs 空行 br（top 独立，保留）。
 */
function getVisualLineRects(range: Range): DOMRect[] {
  const all = Array.from(range.getClientRects())
  const wide = all.filter((r) => r.right > r.left)
  const TOP_TOLERANCE = 1
  const blankLines = all.filter(
    (r) => r.right <= r.left && !wide.some((w) => Math.abs(w.top - r.top) <= TOP_TOLERANCE),
  )
  return [...wide, ...blankLines].sort((a, b) => a.top - b.top)
}

/** contenteditable insertLineBreak 后 0 rect 兜底探测（scrollCursorIntoView 用） */
export function getCaretLineRect(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect()
  if (rect.top !== 0 || rect.bottom !== 0 || rect.height !== 0) return rect
  const probe = document.createTextNode('\u200B')
  try {
    range.insertNode(probe)
    const probeRange = document.createRange()
    probeRange.selectNode(probe)
    const probeRect = probeRange.getBoundingClientRect()
    if (probeRect.top === 0 && probeRect.bottom === 0) return null
    return probeRect
  } finally {
    const parent = probe.parentNode
    probe.remove()
    if (parent?.nodeType === Node.ELEMENT_NODE) {
      ;(parent as Element).normalize()
    }
  }
}

// ── moveCaretVerticalOf 的编排 helper（按光标移动流程阶段拆分，主函数只留守卫与分派）──

/**
 * 零 rect caret 解析结果：
 * - 'rect'：getBoundingClientRect 命中或 ZWSP 探测成功，rect 可用于行定位；
 * - 'modify'：零 rect 且探测失败——已就地执行 sel.modify 行移动（副作用），outcome 即
 *   最终返回值，调用方不得继续行定位流程。
 */
type CaretRectResolution =
  | { kind: 'rect'; rect: DOMRect }
  | { kind: 'modify'; outcome: VerticalMoveResult }

/**
 * 目标落点解析上下文（moveCaretToLinePoint 家族 helper 的显式传参载体，避免超长参数表）。
 * 全部为构建时的不可变快照，helper 不得改写。
 */
interface CaretTargetContext {
  readonly sel: Selection
  readonly el: HTMLElement
  /** 移动前的选区首 Range（同位判定/容器校验基准） */
  readonly before: Range
  readonly lineRects: DOMRect[]
  readonly currentLine: number
  readonly targetLine: number
  /** preferredX ?? caretRect.left（主函数已解析，moved 返回值用） */
  readonly activePreferredX: number
  /** 原始 preferredX（at-edge noop 返回值回传调用方原值，区别于 activePreferredX） */
  readonly preferredX: number | null
}

/** 取选区首 Range；无选区（sel 缺失/rangeCount 0）或光标不在 el 内返回 null（调用方统一 noop）。
 *  命中时回传已窄化的 sel——window.getSelection() 的 null 性靠此处收口，调用方不再重复判空。 */
function getInitialSelection(
  sel: Selection | null,
  el: HTMLElement,
): { sel: Selection; before: Range } | null {
  if (!sel || sel.rangeCount === 0) return null
  const before = sel.getRangeAt(0)
  if (!el.contains(before.startContainer)) return null
  return { sel, before }
}

/** 全 el 视觉行 rects（createRange + selectNodeContents + 零宽过滤；首测与滚动后重测共用） */
function getVisualLineRectsOfEl(el: HTMLElement): DOMRect[] {
  const fullRange = document.createRange()
  fullRange.selectNodeContents(el)
  return getVisualLineRects(fullRange)
}

/** caret 可视 rect 解析：正常 rect 直取；零 rect 走 ZWSP 探测，探测失败就地 sel.modify 行移动兜底 */
function resolveCaretRect(
  before: Range,
  sel: Selection,
  dir: 'up' | 'down',
  preferredX: number | null,
): CaretRectResolution {
  const caretRect = before.getBoundingClientRect()
  if (caretRect.top === 0 && caretRect.bottom === 0) {
    const probed = getCaretLineRect(before)
    if (probed) {
      return { kind: 'rect', rect: probed }
    }
    const bc = before.startContainer, bo = before.startOffset
    sel.modify('move', dir, 'line')
    const after = sel.getRangeAt(0)
    return {
      kind: 'modify',
      outcome: {
        result: (after.startContainer === bc && after.startOffset === bo) ? 'at-edge' : 'moved',
        preferredX,
      },
    }
  }
  return { kind: 'rect', rect: caretRect }
}

/** 定位 caretRect 所属视觉行：先按 top±1 命中，未命中退化取行中心点最近行 */
function resolveCurrentLineIndex(lineRects: DOMRect[], caretRect: DOMRect): number {
  for (let i = 0; i < lineRects.length; i++) {
    if (Math.abs(caretRect.top - lineRects[i].top) <= 1) return i
  }
  let closest = -1
  let minDist = Infinity
  for (let i = 0; i < lineRects.length; i++) {
    const MIDPOINT_DIVISOR = 2
    const center = (lineRects[i].top + lineRects[i].bottom) / MIDPOINT_DIVISOR
    const dist = Math.abs(caretRect.top - center)
    if (dist < minDist) { minDist = dist; closest = i }
  }
  return closest
}

/**
 * 首行再向上：把光标移到第一个文本节点起点。
 * 返回 null 表示不满足移动前置（无文本节点/已在文本起点），调用方返回 at-edge noop。
 */
function moveCaretToFirstTextStart(
  sel: Selection,
  before: Range,
  el: HTMLElement,
  activePreferredX: number,
): VerticalMoveResult | null {
  const firstText = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
  // 无文本节点（空输入框 <br><br> 等）无行可移：与「无文本内容无行可移」语义一致直接 noop，
  // 避免 setStart(null, 0) 抛 TypeError（空输入框首行再按 ↑ 可达：两 <br> 产生两个零宽行 rect）
  if (firstText == null) return null
  const isAtTextStart = before.startContainer === firstText && before.startOffset === 0
  if (isAtTextStart) return null
  const range = document.createRange()
  range.setStart(firstText, 0)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  return { result: 'moved', preferredX: activePreferredX }
}

/**
 * 目标行越出 el 可视区（上下 5px margin）时滚动 el 并按滚动后几何重取目标行 top；
 * 未滚动或重测后行数不足时维持原 top。elRect/cs 由调用方一次读取传入（与原时序一致）。
 */
function scrollTargetLineIntoView(
  el: HTMLElement,
  targetLine: number,
  targetLineTop: number,
  elRect: DOMRect,
  cs: CSSStyleDeclaration,
): number {
  const NEEDS_SCROLL_MARGIN = 5
  if (targetLineTop < elRect.top + NEEDS_SCROLL_MARGIN || targetLineTop > elRect.bottom - NEEDS_SCROLL_MARGIN) {
    el.scrollTop += targetLineTop - elRect.top - parseFloat(cs.paddingTop) - NEEDS_SCROLL_MARGIN
    const freshRects = getVisualLineRectsOfEl(el)
    if (targetLine < freshRects.length) return freshRects[targetLine].top
  }
  return targetLineTop
}

/** caretRangeFromPoint 落点校验（容器内/非同位/行归属）+ 应用选区；任一校验失败回 at-edge noop */
function validateAndApplyCaretTarget(ctx: CaretTargetContext, targetX: number, targetY: number): VerticalMoveResult {
  const { sel, el, before, lineRects, currentLine, targetLine, activePreferredX, preferredX } = ctx
  const target = document.caretRangeFromPoint(targetX, targetY)
  if (!target || !el.contains(target.startContainer)) return { result: 'at-edge', preferredX }

  if (target.startContainer === before.startContainer && target.startOffset === before.startOffset) {
    return { result: 'at-edge', preferredX }
  }

  const targetRect = target.getBoundingClientRect()
  if (targetRect.top !== 0 || targetRect.bottom !== 0) {
    const onTargetLine = Math.abs(targetRect.top - lineRects[targetLine].top) <= 1
    const onCurrentLine = Math.abs(targetRect.top - lineRects[currentLine].top) <= 1
    if (!onTargetLine && onCurrentLine) return { result: 'at-edge', preferredX }
  }

  sel.removeAllRanges()
  sel.addRange(target)
  return { result: 'moved', preferredX: activePreferredX }
}

/** 目标行落点解析：滚动校正 → targetY/targetX 合成 → caretRangeFromPoint 校验应用 */
function moveCaretToLinePoint(ctx: CaretTargetContext): VerticalMoveResult {
  const { el, lineRects, targetLine, activePreferredX } = ctx
  const elRect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const LINE_INTERIOR_OFFSET = 3
  const targetLineTop = scrollTargetLineIntoView(el, targetLine, lineRects[targetLine].top, elRect, cs)
  const targetY = targetLineTop + LINE_INTERIOR_OFFSET
  const BOUNDARY_QUIRK_OFFSET = 20
  const targetX = activePreferredX ?? (elRect.left + parseFloat(cs.paddingLeft) + BOUNDARY_QUIRK_OFFSET)
  return validateAndApplyCaretTarget(ctx, targetX, targetY)
}

/**
 * 视觉行上/下移动（模块级纯函数，preferred X 由调用方传入/写回）。
 *
 * ⚠️ 权威规则见 `.taiji-harness/2026-07-10-composer-history-navigation/spec.md` FR1 + FR5。
 * getClientRects + caretRangeFromPoint 坐标方案（sel.modify 对软换行 contenteditable 失效）。
 *
 * 注意：document.caretRangeFromPoint 在 jsdom 未实现，多行分支由 renderer 行为测试覆盖。
 */
export function moveCaretVerticalOf(
  el: HTMLElement,
  dir: 'up' | 'down',
  preferredX: number | null,
): VerticalMoveResult {
  const noop: VerticalMoveResult = { result: 'at-edge', preferredX }
  const initial = getInitialSelection(window.getSelection(), el)
  if (initial === null) return noop
  const { sel, before } = initial

  const lineRects = getVisualLineRectsOfEl(el)
  if (lineRects.length <= 1) return noop

  const caret = resolveCaretRect(before, sel, dir, preferredX)
  if (caret.kind === 'modify') return caret.outcome
  const caretRect = caret.rect

  const activePreferredX = preferredX ?? caretRect.left

  const currentLine = resolveCurrentLineIndex(lineRects, caretRect)
  if (currentLine === -1) return noop

  const targetLine = dir === 'up' ? currentLine - 1 : currentLine + 1
  if (targetLine >= lineRects.length) return noop
  if (targetLine < 0) {
    const movedToStart = moveCaretToFirstTextStart(sel, before, el, activePreferredX)
    if (movedToStart === null) return noop
    return movedToStart
  }

  return moveCaretToLinePoint({
    sel,
    el,
    before,
    lineRects,
    currentLine,
    targetLine,
    activePreferredX,
    preferredX,
  })
}

// ── 来自 useContenteditableInput：粘贴 ──

/** Cmd/Ctrl+V 富呈现通路：从剪贴板取出第一个 image item，无则返回 null。 */
export function pickClipboardImageItem(e: ClipboardEvent): DataTransferItem | null {
  const items = e.clipboardData?.items
  if (!items) return null
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file' && it.type.startsWith('image/')) return it
  }
  return null
}

// ── 来自 useComposerChipCommands：chip DOM 辅助 ──

/**
 * 在容器内按 chipPath 查找 image-chip 元素（dataset 遍历，路径含 CSS 特殊字符也安全）。
 *
 * [HISTORICAL] 曾用 el.querySelector(`.image-chip[data-chip-path="${path}"]`)，
 * 但 path 含 `"` / `]` 等 CSS 特殊字符时选择器解析失败。改为遍历比对 dataset.chipPath。
 */
export function findImageChipEl(el: HTMLElement, chipPath: string): HTMLElement | null {
  const chips = el.querySelectorAll<HTMLElement>('.image-chip')
  for (const chip of chips) {
    if (chip.dataset.chipPath === chipPath) return chip
  }
  return null
}

/**
 * 在容器内按 chipId 查找 image-chip 元素（C3：ContextChipsBar 删除回调用稳定唯一 id 定位）。
 */
export function findImageChipElById(el: HTMLElement, chipId: string): HTMLElement | null {
  const chips = el.querySelectorAll<HTMLElement>('.image-chip')
  for (const chip of chips) {
    if (chip.dataset.chipId === chipId) return chip
  }
  return null
}

/** 判断节点是否是纯空白 spacer（nbsp/零宽空格/空文本节点） */
export function isSpacerNode(node: Node | null): boolean {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false
  const t = node.textContent ?? ''
  return t === '\u00A0' || t === '\u200B' || t === ''
}

/** 把光标定位到指定节点之后 */
export function placeCursorAfter(node: Node): void {
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/**
 * 移除 chip + 相邻的 spacer（nbsp/零宽空格/空文本节点）。
 *
 * [W2 重构] 原为 useComposerChipCommands 闭包内函数（直接调 onChanged）。
 * 迁入 input-dom 改为接收 onChanged 参数的纯函数，chip-commands 调用时传入。
 */
export function removeChipNode(chip: Node, onChanged: () => void): void {
  const next = chip.nextSibling as Node | null
  if (isSpacerNode(next)) {
    next?.parentNode?.removeChild(next)
  }
  chip.parentNode?.removeChild(chip)
  onChanged()
}

/**
 * 图片持久化占位 badge 的异步回填/降级 —— paste 与 drop 共享编排。
 * result.kind='badge'：占位存在则回填 dataset + 更新 label，不存在则 fallback 重建 badge。
 * result.kind='text'：移除占位（含相邻 ZWSP spacer）+ insertText 降级。
 */
export function applyImagePersistResult(opts: {
  placeholderEl: HTMLElement | null
  result: HandleImagePasteResult
  insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
}): void {
  const { placeholderEl: placeholder, result, insertImageBadge } = opts
  if (result.kind === 'badge') {
    if (placeholder) {
      placeholder.dataset.chipPath = result.path
      placeholder.dataset.chipFileName = result.fileName
      placeholder.dataset.chipDisplayName = result.displayName
      placeholder.dataset.chipNeedsMigrate = result.needsMigrate ? 'true' : 'false'
      const label = placeholder.querySelector('.chip-label')
      if (label) label.textContent = result.displayName
    } else {
      insertImageBadge(result.path, result.fileName, result.displayName, result.needsMigrate)
    }
  } else if (result.kind === 'text') {
    if (placeholder) {
      const next = placeholder.nextSibling
      if (next && next.nodeType === Node.TEXT_NODE && next.textContent === CHIP_SPACER_ZWSP) {
        next.remove()
      }
      placeholder.remove()
    }
    document.execCommand('insertText', false, result.text)
  }
}
