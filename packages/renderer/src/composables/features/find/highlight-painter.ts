/**
 * highlight-painter —— 表面内查找命中高亮的唯一注册点（find-in-surface）。
 *
 * 实现 = CSS Custom Highlight API（Electron 42 / Chromium 142 已支持）：往 CSS.highlights
 * 注册 'find-hits' / 'find-active' 两个 Highlight，着色规则在 style.css 的 ::highlight()
 * 伪元素。不碰 DOM 结构 → 流式重渲染、markdown 净化管线零干扰（设计留档 §3）。
 *
 * 失效防御：paintHits 是一次性快照，绘制后表面 DOM 可能变化（流式输出 / tab 切换 /
 * session 切换）使 Range 指向的文本节点离开文档。绘制前逐 range 检查 startContainer
 * 的 isConnected，失效的跳过——Highlight 注册失效 range 会被 Chromium 忽略，但显式
 * 过滤保证「画上去的一定还在文档里」的语义可测。
 *
 * API 缺席守卫：Highlight / CSS.highlights 类型由 lib.dom 提供，但运行时环境不保证
 * 存在（happy-dom 测试环境均无）——绘制前 typeof/存在性检查，缺席静默 no-op。
 */

/** CSS.highlights 注册表（lib.dom HighlightRegistry 的运行时最小形状） */
type HighlightsRegistryLike = {
  set(key: string, value: Highlight): void
  delete(key: string): void
}

function highlightApi(): { registry: HighlightsRegistryLike } | null {
  if (typeof globalThis.Highlight === 'undefined') return null
  const registry = (globalThis as { CSS?: { highlights?: HighlightsRegistryLike } }).CSS?.highlights
  if (!registry) return null
  return { registry }
}

function isLive(range: Range): boolean {
  // 文本节点被移出文档（重渲染替换）后 Range 不报错但不再对应任何可见文本——画了也白画
  return range.startContainer.isConnected
}

/**
 * 绘制命中：非 active 命中进 'find-hits'，activeIndex 指向的命中（若有效）单独进
 * 'find-active'（style.css 里两者配色不同——活动命中深色区分）。activeIndex 无效或
 * 指向已失效 range 时不注册 'find-active'（并 delete 残留，防上一次导航的旧活动高亮滞留）。
 */
export function paintHits(ranges: Range[], activeIndex: number): void {
  const api = highlightApi()
  if (!api) return
  const { registry } = api

  const active = activeIndex >= 0 && activeIndex < ranges.length ? ranges[activeIndex] : null
  const activeLive = active !== null && isLive(active)
  const rest: Range[] = []
  for (const range of ranges) {
    if (!isLive(range)) continue
    if (range === active) continue
    rest.push(range)
  }
  // Highlight 一次构造收全部 range（Range 数组 → 单实例；不逐个包 Highlight 再嵌套）
  registry.set('find-hits', new Highlight(...rest))
  if (activeLive && active) {
    registry.set('find-active', new Highlight(active))
  } else {
    registry.delete('find-active')
  }
}

/** 清除全部命中高亮（关闭查找 / 换表面时调用）。 */
export function clearHits(): void {
  const api = highlightApi()
  if (!api) return
  api.registry.delete('find-hits')
  api.registry.delete('find-active')
}
