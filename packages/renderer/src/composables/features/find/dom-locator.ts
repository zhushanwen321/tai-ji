/**
 * dom-locator —— 表面内查找的 DOM 定位器（find-in-surface 第一期实现）。
 *
 * 契约：SurfaceSearchLocator (container, query) => Range[]（设计留档 §3）。
 * 第二期对话流将换数据层定位器（chat store 全量消息搜索），接口不变。
 *
 * 跨节点拼接命中：相邻文本节点（如 <b>he</b>llo 被 inline 标签切开）单节点扫描会漏。
 * 实现不逐节点匹配，而是把容器内全部文本节点按文档序拼接成一条大字符串 + 各节点的
 * 起始偏移表，在大字符串上找全部命中，再经偏移表映射回（节点, 偏移）对 → Range，
 * 天然覆盖跨节点拼接。
 */

/** 拼接文本流中的一段：node 从大字符串 start 偏移开始贡献自己的全部文本 */
type TextSegment = {
  node: Text
  start: number
}

export function locateInDom(container: HTMLElement, query: string): Range[] {
  if (query === '') return []
  const needle = query.toLowerCase()

  // 文本节点收集：跳过 script/style（内容非用户可见文本）、[data-find-skip] 子树
  // （终端 canvas 等第一期排除区）、不可见元素（display:none / visibility:hidden 里的
  // 文本不该命中——checkVisibility Chromium 105+；无该 API 的环境（happy-dom）视为可见，
  // 可见性判定缺位不影响定位正确性，只影响精度）。
  const segments: TextSegment[] = []
  let full = ''
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const text = node.nodeValue ?? ''
      if (text === '') return NodeFilter.FILTER_REJECT
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('script, style, [data-find-skip]')) return NodeFilter.FILTER_REJECT
      if (typeof parent.checkVisibility === 'function' && !parent.checkVisibility()) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let current = walker.nextNode()
  while (current) {
    segments.push({ node: current as Text, start: full.length })
    full += current.nodeValue ?? ''
    current = walker.nextNode()
  }
  if (segments.length === 0) return []

  const haystack = full.toLowerCase()
  const ranges: Range[] = []
  // 步进 needle.length：命中不重叠（浏览器 find bar 惯例——"aaa" 搜 "aa" 报 1 个而非 2 个）
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    const start = positionAt(segments, idx)
    const end = positionAt(segments, idx + needle.length)
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    ranges.push(range)
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return ranges
}

/** 大字符串偏移 → （文本节点, 节点内偏移）。pos 恰在节点边界时落在后一节点 offset 0
 *  （Range 的 setStart/setEnd 在节点边界处合法，无需回退到前一节点末尾）。 */
function positionAt(segments: TextSegment[], pos: number): { node: Text; offset: number } {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    if (seg.start <= pos) {
      return { node: seg.node, offset: pos - seg.start }
    }
  }
  // pos ≥ 0 且 segments 非空时必命中（segments[0].start === 0），此分支仅为类型收窄
  const first = segments[0]
  return { node: first.node, offset: 0 }
}
