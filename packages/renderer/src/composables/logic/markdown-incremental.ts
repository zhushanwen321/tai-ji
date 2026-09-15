/**
 * Markdown 增量流式渲染（D-5 增量渲染，W22/W23）：稳定边界判定 + segments 数组增量协议。
 *
 * 自 markdown.ts 拆出（test-infra-source-simplify R4，2026-09）：渲染管线（markdown-it +
 * shiki 装配、fence/公式/路径识别规则）留在 markdown.ts，本模块只承载增量流式轴——
 * findStableBoundary 行级块扫描 / renderIncremental 前缀缓存协议 / shouldFinalizeStreamingFence
 * 占位 finalize 判定。权威安全网：markdown-incremental.test.ts（9 形态矩阵 + 拼接等价）。
 *
 * 对 markdown.ts 的依赖面只有其公开导出（MarkdownSegment / MarkdownEnv 类型 +
 * renderMarkdownSegments），不触碰其内部私有；依赖严格单向（incremental → markdown，无循环）。
 * 曾由 markdown.ts 反向 re-export 本模块符号维持旧导入路径，因构成 ESM 循环依赖
 * （markdown ⇄ markdown-incremental，metrics-gate 拦截）已拆除，消费方直接从本模块导入。
 *
 * 测试 mock 说明：shiki stub 经 vi.doMock('shiki/core') 对整模块图生效（本模块 →
 * markdown.ts → shiki/core），freshModule 动态 import 范式与拆分前等价。
 *
 * 设计依据 .xyz-harness/2026-08-15-perf/08-render-layer.md §3.3 D-5 + plan.md R-19/R-20：
 * - 协议是 MarkdownSegment[]（前缀段引用恒等缓存 + tail 段每帧重建），不是 HTML 字符串对
 *   ——字符串协议会把 mermaid 组件降级成 v-html，推翻现有渲染结构。
 * - 边界判定用行级扫描实现（不手写完整 CommonMark 解析器），未知/无法判定形态一律
 *   fallback-full 降级（唯一兜底出口）。
 * - 正确性判据是「拼接等价」：renderMarkdownSegments(prefix+tail) 与分段渲染在 DOM 层等价
 *   （08 §3.3.3 条件 4），本实现的所有保守拒绝都是为了该判据。
 */
import type { MarkdownEnv, MarkdownSegment } from './markdown'
import { renderMarkdownSegments } from './markdown'

/** 渲染管线公开 API 透传：renderIncremental 的全量对照路径与消费方（freshModule 单模块面）经本模块可达，本体留在 markdown.ts */
export { renderMarkdownSegments }

/** fence 开行：≤3 空格缩进 + 3 个以上 ` 或 ~（捕获 info string）。
 *  info 用 [^\n]* 而非 .*：JS 的 . 不匹配 \r，CRLF 行（按 \n 切行后尾随 \r）会让
 *  (.*)$ 整体失配 → fence 开行识别失败（W22 review CRLF 用例实测发现） */
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/
/** 闭行候选：纯 fence 标记（同字符、长度 ≥ 开行、行尾仅空白）——字符与长度在调用点校验。
 *  行尾空白含 \r：CRLF 文档按 \n 切行后闭行尾随 \r（markdown-it 解析前归一化 \r\n，
 *  本扫描不整体归一化 content——会破坏 offset，只在字符类容忍 \r） */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/
/** ATX 标题（自成块，行尾即闭合；可打断段落） */
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/
/** 主题分隔线（--- 、*** 、___ 形态，含 - - - 变体；自成块） */
const THEMATIC_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
/** setext `=` 下划线（仅附着于上方开放段落；独立出现时是普通段落文本） */
const SETEXT_EQ_RE = /^ {0,3}=+[ \t]*$/
/** 列表标记（无序列线 -/+/* 或有序 1./1)） */
const LIST_MARKER_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
/** 引用行前缀 */
const BLOCKQUOTE_RE = /^ {0,3}>/
/** 链接引用定义行形态（fence 外任意位置命中即整体 fallback：markdown-it 的引用解析是文档级
 *  的——定义在任何段落开头收集、全文 [label] 消费，任何前缀/尾段切分都会让一侧丢另一侧的定义，
 *  拼接必然发散；见 scanMarkdownBlocks 的 hasLinkRefDef） */
const LINK_REF_DEF_RE = /^ {0,3}\[[^\]]*\]:[ \t]*\S/

/** tab 折算宽度（CommonMark 习惯按 4 列；行首 tab 保守归为缩进代码/嵌套续行形态） */
const TAB_WIDTH = 4
/** fence 开行允许的最大行首缩进（CommonMark：≥4 空格是缩进代码块不是 fence） */
const FENCE_MAX_INDENT = 3
/** `$$` 数学块定界符长度（奇偶计数步进用） */
const MATH_DELIM_LEN = 2

/** 行首缩进宽度（tab 按 TAB_WIDTH 计，保守归为缩进代码/嵌套续行形态） */
function leadingIndent(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n += 1
    else if (ch === '\t') return TAB_WIDTH
    else break
  }
  return n
}

/** 块级行扫描的内部结果（findStableBoundary / renderIncremental 共用一次扫描） */
interface BlockScan {
  /** 最新稳定边界 offset；null = 无法判定（调用方 fallback-full） */
  boundary: number | null
  /** 文档末尾未闭合 fence 的开行 offset 与语言；无则 null（未闭合 fence 吞掉其后一切，至多一个） */
  openFence: { offset: number; lang: string } | null
}

/** 候选边界（行首记录：前缀是否全闭合 + 列表上下文是否存活） */
interface BoundaryCandidate {
  offset: number
  closed: boolean
  listOpen: boolean
}

/** 未闭合 fence 的行间状态（开行字符/长度/开行 offset/info string） */
interface OpenFenceState {
  char: string
  len: number
  start: number
  info: string
}

/**
 * 行间扫描状态（原 scanMarkdownBlocks 内一组 let 局部变量的聚合载体）：
 * 由 scanMarkdownBlocks 局部创建，按行显式传参给转移 helper 就地推进，不跨调用共享。
 */
interface ScanLineState {
  /** 当前未闭合 fence（null = 无；fence 内容行状态冻结） */
  fence: OpenFenceState | null
  /** fence 外 "$$" 出现次数奇偶（markdown-it-katex 的 $$ 块未闭合时渲染到 EOF，拼接不安全） */
  mathOdd: boolean
  /** 段落级结构未闭合（段落/表格行/引用内容/列表项文本等可被续行附着的形态） */
  paraOpen: boolean
  /** 列表上下文存活（跨空行——"- a\n\n- b" 仍是一个松散列表，尾部列表标记可续并） */
  listOpen: boolean
  /** 文档级链接引用定义存在标记：markdown-it 的引用解析是文档级的（定义全文收集、[label] 全文
   * 消费），任何切分都发散——def 在尾段则前缀 [label] 不链接化且**前缀缓存永不重渲染**（引用恒等），
   * def 在前缀则尾段 [label] 丢定义（前缀段独立渲染，定义不随行）。含定义文档无合法边界。 */
  hasLinkRefDef: boolean
}

/** 行枚举：{start, text}（text 不含行尾 \n） */
function enumerateLines(content: string): { start: number; text: string }[] {
  const lines: { start: number; text: string }[] = []
  let s = 0
  while (s < content.length) {
    const nl = content.indexOf('\n', s)
    if (nl === -1) {
      lines.push({ start: s, text: content.slice(s) })
      break
    }
    lines.push({ start: s, text: content.slice(s, nl) })
    s = nl + 1
  }
  return lines
}

/** fence 开行识别：返回 null = 不是 fence 开行（无标记 / 缩进 >3 / 反引号 fence info 含反引号） */
function matchFenceOpen(text: string, indent: number): Omit<OpenFenceState, 'start'> | null {
  const open = text.match(FENCE_OPEN_RE)
  if (!open) return null
  if (indent > FENCE_MAX_INDENT) return null
  // CommonMark：反引号 fence 的 info string 不允许含反引号——"``` a `b`" 是普通段落文本，
  // 不视为 fence 开行（误判会把后续段落行吞进 fence 内容，占位/边界形态发散）
  if (open[2][0] === '`' && (open[3] ?? '').includes('`')) return null
  return { char: open[2][0], len: open[2].length, info: open[3] ?? '' }
}

/** fence 闭行判定：同字符、长度 ≥ 开行（行尾空白容忍由 FENCE_CLOSE_RE 处理） */
function closesFence(text: string, fence: OpenFenceState): boolean {
  const close = text.match(FENCE_CLOSE_RE)
  return close !== null && close[1][0] === fence.char && close[1].length >= fence.len
}

/** 顶格闭合性块行（fence 开行/主题线/标题）终止列表上下文；缩进嵌套形态保持存活 */
function listClosedIfTopLevel(indent: number, listOpen: boolean): boolean {
  return indent === 0 ? false : listOpen
}

/** 行内 `$$` 出现次数逐个翻转奇偶（只在 fence 外累计） */
function toggleMathParity(text: string, mathOdd: boolean): boolean {
  let odd = mathOdd
  for (let idx = text.indexOf('$$'); idx !== -1; idx = text.indexOf('$$', idx + MATH_DELIM_LEN)) {
    odd = !odd
  }
  return odd
}

/** 段落行转移（setext 下划线 / 列表标记 / 引用行 / lazy 续行的段落与列表上下文推进） */
function advanceParagraphLine(
  text: string,
  indent: number,
  st: ScanLineState,
  wasParaOpen: boolean,
): void {
  if (SETEXT_EQ_RE.test(text) && wasParaOpen) {
    st.paraOpen = false // setext h1：= 下划线把上方开放段落转为标题（闭合）
    return
  }
  st.paraOpen = true
  const isQuote = BLOCKQUOTE_RE.test(text)
  if (LIST_MARKER_RE.test(text)) {
    st.listOpen = true
  } else if (indent === 0 && (!wasParaOpen || isQuote)) {
    // 空行后的顶格非标记行：列表终止（lazy continuation 不能跨空行）；
    // 引用行可打断段落 → 也终止列表。其余顶格行是 lazy 续行 → 列表存活（保守）。
    st.listOpen = false
  }
}

/** fence 外非空行转移：链接引用定义标记 + fence 开行/主题线/标题/段落行分支推进 */
function advanceNonFenceLine(text: string, start: number, st: ScanLineState): void {
  const indent = leadingIndent(text)
  const wasParaOpen = st.paraOpen
  // 链接引用定义检测（fence 外）：形态命中即标记，段落位置的精确性不做——过度 fallback 安全
  if (LINK_REF_DEF_RE.test(text)) st.hasLinkRefDef = true
  const open = matchFenceOpen(text, indent)
  if (open) {
    st.fence = { ...open, start }
    st.paraOpen = true // fence 开行 = 开放结构（同时打断了上方段落）
    st.listOpen = listClosedIfTopLevel(indent, st.listOpen)
  } else if (THEMATIC_RE.test(text)) {
    st.paraOpen = false
    st.listOpen = listClosedIfTopLevel(indent, st.listOpen)
  } else if (HEADING_RE.test(text)) {
    st.paraOpen = false
    st.listOpen = listClosedIfTopLevel(indent, st.listOpen)
  } else {
    advanceParagraphLine(text, indent, st, wasParaOpen)
    // $$ 奇偶只在 fence 外累计（每出现一次翻转一次）
    st.mathOdd = toggleMathParity(text, st.mathOdd)
  }
}

/** 单行状态转移（st 就地推进；fence 开着时非闭行不改变状态） */
function advanceLine(text: string, start: number, st: ScanLineState): void {
  if (st.fence) {
    if (closesFence(text, st.fence)) {
      st.fence = null
      st.paraOpen = false // 闭合 fence 行 = 闭合块后缘
    }
    // 其余行是 fence 内容，状态不变（fence 开着 → 候选恒不闭合）
    return
  }
  if (text.trim() === '') {
    st.paraOpen = false // 空行闭合段落（也终止表格/引用）
    return
  }
  advanceNonFenceLine(text, start, st)
}

/** 候选闭合判定：fence 配对完整 + $$ 偶数次 + 段落闭合 */
function isClosedAt(st: ScanLineState): boolean {
  return st.fence === null && !st.mathOdd && !st.paraOpen
}

/** 文档尾未闭合 fence → openFence 结果（语言名取 info 首词） */
function toOpenFence(fence: OpenFenceState | null): BlockScan['openFence'] {
  if (fence === null) return null
  return {
    offset: fence.start,
    lang: fence.info.trim().split(/\s+/)[0] ?? '',
  }
}

/** 反向取最新合法边界（最大化前缀缓存）；无合法边界返回 null */
function pickLatestBoundary(content: string, candidates: BoundaryCandidate[]): number | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]
    // 单行文档（无 \n）：候选 0 不作为稳定边界 → null 降级（矩阵 row8「超大单行」；
    // 空前缀也无缓存价值）。空/纯空白已在函数入口返回 0。
    if (c.offset === 0 && !content.includes('\n')) continue
    if (!c.closed) continue
    if (!tailStartsIndependentBlock(content, c.offset, c.listOpen)) continue
    return c.offset
  }
  return null
}

/**
 * 行级块结构扫描：单次正向遍历维护 fence 配对 / `$$` 数学块奇偶 / 段落开闭 / 列表上下文，
 * 在每个行首记录「前缀是否全闭合」，再从末尾反向取第一个同时满足三条件的位置。
 *
 * 三条件（08 §3.3.3）：① 行首锚点；② 前段全闭合（含段落闭合：空行或自成块行后缘；
 * fence/数学块配对完整）；③ tail 是单一独立开放块（拒绝缩进续行 / 前缀列表续并 /
 * setext 下划线等「续行」形态）。
 *
 * 文档级拒绝（优先于三条件）：文档 fence 外任意位置含链接引用定义行（hasLinkRefDef）
 * → boundary=null 走 fallback-full。引用解析是文档级的，任何切分都会让 [label] 链接化
 * 与全量渲染发散（定义侧与引用侧无论谁进前缀/尾段都丢另一半），且前缀缓存引用恒等
 * 使发散**持久化**（永不自愈）。
 *
 * 纯函数：同输入同输出、零副作用、不触碰 markdown-it。
 */
function scanMarkdownBlocks(content: string): BlockScan {
  if (content.trim() === '') return { boundary: 0, openFence: null }

  const lines = enumerateLines(content)

  // 候选边界 = 各行行首（+ 末尾 \n 后的文档尾行首）。candidate 0 = 空前缀（恒闭合）。
  const candidates: BoundaryCandidate[] = [{ offset: 0, closed: true, listOpen: false }]
  const st: ScanLineState = { fence: null, mathOdd: false, paraOpen: false, listOpen: false, hasLinkRefDef: false }

  for (let i = 0; i < lines.length; i++) {
    const { start, text } = lines[i]
    advanceLine(text, start, st)

    // 本行结束后的状态 → 下一行行首的候选（末行的“下一行首”仅在文档以 \n 结尾时存在）
    const isLast = i === lines.length - 1
    if (!isLast) {
      candidates.push({
        offset: lines[i + 1].start,
        closed: isClosedAt(st),
        listOpen: st.listOpen,
      })
    } else if (content.endsWith('\n')) {
      candidates.push({
        offset: content.length,
        closed: isClosedAt(st),
        listOpen: st.listOpen,
      })
    }
  }

  const openFence = toOpenFence(st.fence)

  // 含链接引用定义的文档无合法边界（见 ScanLineState.hasLinkRefDef 注释）——唯一保守出口 fallback-full
  if (st.hasLinkRefDef) return { boundary: null, openFence }

  return { boundary: pickLatestBoundary(content, candidates), openFence }
}

/**
 * 条件 ③：tail 是否是「单一独立开放块」的起始（offset 起、到首个非空行判定）。
 *
 * 允许：新段落 / fence 开行 / 标题 / 引用 / 表格头 / 主题线 / 数学块开行等干净块级起始，
 * 以及 tail 内部含一个持续增长的未闭合结构。拒绝的「续行」形态：
 * - 行首有缩进（缩进代码 / 列表项内容 / 嵌套列表——独立渲染会拆散所属结构）
 * - setext `=` 下划线（附着上方段落）
 * - 列表标记且前缀列表上下文存活（会与前缀合并成一个列表 / 松散列表）
 *
 * （链接引用定义形态曾在此按 tail 起始拒绝，W22 review 后升级为 scanMarkdownBlocks 的
 * 文档级检测——tail 起始拒绝漏掉定义在 tail 中部/前缀中部的形态。）
 *
 * 只取 offset 起的首个非空行，不从 offset 拷贝整个 tail——反向候选循环逐候选调用，
 * slice 整段是 O(候选×文档长度) 拷贝（大文档 + 多候选时的无谓开销）。
 */
function tailStartsIndependentBlock(content: string, offset: number, prefixListOpen: boolean): boolean {
  let s = offset
  while (s < content.length) {
    const nl = content.indexOf('\n', s)
    const line = nl === -1 ? content.slice(s) : content.slice(s, nl)
    if (line.trim() !== '') {
      if (leadingIndent(line) > 0) return false
      if (SETEXT_EQ_RE.test(line)) return false
      if (prefixListOpen && LIST_MARKER_RE.test(line)) return false
      return true
    }
    if (nl === -1) break
    s = nl + 1
  }
  return true // tail 空/全空白：边界即文档尾，前缀全覆盖
}

/**
 * 稳定结构边界判定（纯函数）：返回「最后一个稳定边界」的字符 offset，无合法边界返回 null。
 *
 * 边界语义：prefix = content.slice(0, boundary) 的块级结构全闭合（含段落闭合），
 * 可安全缓存复用；tail = content.slice(boundary) 每帧独立渲染，拼接结果与全文渲染
 * DOM 等价（拼接等价判据见测试矩阵）。
 */
export function findStableBoundary(content: string): number | null {
  return scanMarkdownBlocks(content).boundary
}

/** 前缀缓存（调用方持有——W23 经 per-session 分区管理；renderIncremental 原地更新） */
export interface IncrementalRenderCache {
  /** 上次稳定边界 offset（0 = 无前缀缓存） */
  boundary: number
  /** 上次前缀文本快照（append-only 校验：新 content 的同位置前缀被改写 → 降级） */
  prefixText: string
  /** 前缀段（段对象不可变、引用恒等跨帧复用；数组在边界前进时整体替换） */
  prefixSegments: MarkdownSegment[]
  /** segId 分配器（单调递增；降级/重建时保留不回退，防 key 复用） */
  nextSegId: number
  /** env 引用签名（filePaths/localFiles 引用恒等；变化 → 前缀缓存失效全量重建） */
  envFilePaths?: Set<string>
  envLocalFiles?: Set<string>
}

/** 创建空的前缀缓存 */
export function createIncrementalRenderCache(): IncrementalRenderCache {
  return { boundary: 0, prefixText: '', prefixSegments: [], nextSegId: 0 }
}

/** 增量渲染结果（segments 数组协议，R-19） */
export interface IncrementalRenderResult {
  /** 稳定边界之前的段（引用恒等——与 cache.prefixSegments 同引用，零重渲染） */
  prefixSegments: MarkdownSegment[]
  /** 稳定边界之后的段（每帧重建；未闭合 fence 以 streaming-fence 占位段呈现） */
  tailSegments: MarkdownSegment[]
  /** 稳定边界 offset（诊断用） */
  stableBoundary: number
  /** incremental = 前缀走缓存；fallback-full = 本帧全量渲染且前缀缓存已重置 */
  mode: 'incremental' | 'fallback-full'
}

/**
 * fence/mermaid 占位转完整渲染的静默阈值（ms）。
 * 08 §5.4 待验证项：无真实用户数据，200 是实施期 A/B 起点（候选 200/300），
 * dev 实测 tuning 后可调——不是结论值。
 */
export const STREAMING_FENCE_SILENCE_MS = 200

/** 占位转完整渲染的判定输入（W23 组装：消息 complete 态 + 距末 token 静默时长） */
export interface FenceFinalizeState {
  /** 消息是否已完成（status 非 streaming） */
  complete: boolean
  /** 距上一个 token 到达的静默时长（ms） */
  silenceMs: number
}

/**
 * 未闭合 fence 占位是否应转完整渲染：message complete 或 token 静默 ≥ 阈值（08 §3.3.2）。
 * W23 在 rAF 调度层调用；命中后以 finalizeOpenFence:true 调 renderIncremental。
 */
export function shouldFinalizeStreamingFence(state: FenceFinalizeState): boolean {
  return state.complete || state.silenceMs >= STREAMING_FENCE_SILENCE_MS
}

/** 重置前缀缓存（boundary 归零、前缀段清空；nextSegId 故意保留——segId 跨重建单调不减） */
function resetIncrementalCache(cache: IncrementalRenderCache, env?: MarkdownEnv): void {
  cache.boundary = 0
  cache.prefixText = ''
  cache.prefixSegments = []
  cache.envFilePaths = env?.filePaths
  cache.envLocalFiles = env?.localFiles
}

/** 降级全量渲染：整段 content 作为 tailSegments，前缀缓存重置（可恢复——下一帧重走增量） */
async function renderFallbackFull(
  content: string,
  cache: IncrementalRenderCache | null,
  env?: MarkdownEnv,
): Promise<IncrementalRenderResult> {
  const tailSegments = await renderMarkdownSegments(content, env)
  if (cache) resetIncrementalCache(cache, env)
  let localId = 0
  for (const s of tailSegments) s.segId = cache ? cache.nextSegId++ : localId++
  return { prefixSegments: [], tailSegments, stableBoundary: 0, mode: 'fallback-full' }
}

/** segId 分配载体：有缓存走 cache.nextSegId（跨帧单调不复用）；无缓存用本地计数器 */
interface SegIdSource {
  cache: IncrementalRenderCache | null
  localId: number
}

/** 分配下一个 segId（帧内单调；载体显式传参，无隐式共享） */
function allocSegId(src: SegIdSource): number {
  return src.cache ? src.cache.nextSegId++ : src.localId++
}

/**
 * 缓存一致性校验（env 签名 / append-only / 边界单调）。
 * 返回 false = 需 fallback-full（前缀被改写或边界回退）；env 签名变化时就地重置缓存
 * （本帧走正常路径全量重建前缀）并返回 true。无缓存（首次帧）恒 stable。
 */
function isCacheStable(
  c: IncrementalRenderCache,
  content: string,
  boundary: number,
  env?: MarkdownEnv,
): boolean {
  const hasCache = c.boundary > 0 || c.prefixSegments.length > 0
  if (!hasCache) return true
  if (c.envFilePaths !== env?.filePaths || c.envLocalFiles !== env?.localFiles) {
    // env 签名变化：重置缓存走正常路径（本帧全量重渲染 prefix+tail 并重建前缀缓存）
    resetIncrementalCache(c, env)
  } else if (c.boundary > content.length || content.slice(0, c.boundary) !== c.prefixText) {
    return false // 前缀被改写（非 append-only）
  } else if (boundary < c.boundary) {
    return false // 边界回退（单调性防御）
  }
  return true
}

/** 边界前进：新增稳定区独立渲染并入前缀缓存（空白区只推进边界不产段）；并同步 env 引用签名 */
async function advancePrefixCache(
  content: string,
  boundary: number,
  c: IncrementalRenderCache,
  env?: MarkdownEnv,
): Promise<void> {
  if (boundary > c.boundary) {
    // 新增稳定区独立渲染并入前缀缓存（该区起止都是合法边界，拼接等价由边界判定保证）
    const piece = content.slice(c.boundary, boundary)
    const pieceSegs = piece.trim() === '' ? [] : await renderMarkdownSegments(piece, env)
    for (const s of pieceSegs) s.segId = c.nextSegId++
    if (pieceSegs.length > 0) c.prefixSegments = [...c.prefixSegments, ...pieceSegs]
    c.boundary = boundary
    c.prefixText = content.slice(0, boundary)
  }
  c.envFilePaths = env?.filePaths
  c.envLocalFiles = env?.localFiles
}

/** 前缀段获取：缓存命中返回引用恒等的前缀段；无缓存时独立渲染前缀区（segId 从 0 分配） */
async function resolvePrefixSegments(
  content: string,
  boundary: number,
  ids: SegIdSource,
  env?: MarkdownEnv,
): Promise<MarkdownSegment[]> {
  if (ids.cache) return ids.cache.prefixSegments
  const prefixText = content.slice(0, boundary)
  const segs = prefixText.trim() === '' ? [] : await renderMarkdownSegments(prefixText, env)
  for (const s of segs) s.segId = allocSegId(ids)
  return segs
}

/**
 * tail 段构建：未闭合 fence（非 finalize 态）以 streaming-fence 占位段呈现
 * （fence 前已到达的闭区先正常渲染），finalize 或无 fence 时正常增量渲染。
 */
async function buildTailSegments(
  content: string,
  boundary: number,
  scan: BlockScan,
  finalize: boolean,
  env: MarkdownEnv | undefined,
  ids: SegIdSource,
): Promise<MarkdownSegment[]> {
  let tailSegments: MarkdownSegment[] = []
  const tailText = content.slice(boundary)
  if (scan.openFence && !finalize) {
    const pre = content.slice(boundary, scan.openFence.offset)
    if (pre.trim() !== '') {
      tailSegments = await renderMarkdownSegments(pre, env)
      // pre 段与正常 tail 段一样携带 segId（W22 review：此分支曾漏赋值，
      // 占位前文本段无 key → v-for 复用错位）
      for (const s of tailSegments) s.segId = allocSegId(ids)
    }
    const bodyStart = content.indexOf('\n', scan.openFence.offset)
    const body = bodyStart === -1 ? '' : content.slice(bodyStart + 1)
    tailSegments.push({
      type: 'streaming-fence',
      content: body,
      lang: scan.openFence.lang === '' ? 'text' : scan.openFence.lang,
      mermaid: scan.openFence.lang.toLowerCase() === 'mermaid',
      segId: allocSegId(ids),
    })
  } else if (tailText.trim() !== '') {
    tailSegments = await renderMarkdownSegments(tailText, env)
    for (const s of tailSegments) s.segId = allocSegId(ids)
  }
  return tailSegments
}

/**
 * 增量渲染（D-5 核心，W22）：前缀 segments 缓存 + tail segments 增量。
 *
 * **硬约束（并发，W22 review）**：同一 cache 必须串行调用——上一帧 Promise 落定后才能发起
 * 下一帧，按发起顺序应用结果、丢弃乱序帧。本函数在 await 点交错原地更新 cache（边界前进
 * 并入 / fallback 重置互相踩踏，坏状态不可被 append-only 校验自愈），**不自带串行化**
 * （cache 内嵌串行链需扩展 ui 侧镜像协议面，长期方案另议），并发消费方须自带串行化——
 * 如 MarkdownRenderer 的 latest-wins 帧门（W23 已实现）。
 *
 * - 前缀缓存命中（边界不变且前缀未变）：prefixSegments 与 cache.prefixSegments 同引用，
 *   前缀零重渲染；W23 以 v-for :key="seg.segId" 复用 DOM（text 段 v-html 子树不触碰、
 *   mermaid 段组件实例跨帧保活）。
 * - 边界前进：新增稳定区（slice(oldBoundary, newBoundary)）独立渲染并入前缀缓存。
 * - 单调性防御：边界回退（新 < 旧）或前缀被改写（非 append-only）→ fallback-full + 缓存重置。
 * - env 签名变化（filePaths/localFiles 引用变）→ 前缀缓存失效，本帧全量重渲染并重建。
 * - 未闭合 fence（非 finalize 态）：fence 之前的 tail 闭区正常渲染，fence 整体以
 *   streaming-fence 占位段呈现（语言名 + streaming 标记数据；UI 呈现归 W23）。
 * - cache 省略：无状态调用（边界拆分照常，前缀每帧重建，供一次性消费）。
 *
 * @param opts.finalizeOpenFence true 时未闭合 fence 走完整渲染（complete/静默期命中后；
 *   markdown-it 把文档尾未闭合 fence 渲染为含已到达内容的代码块）
 */
export async function renderIncremental(
  content: string,
  cache?: IncrementalRenderCache | null,
  env?: MarkdownEnv,
  opts?: { finalizeOpenFence?: boolean },
): Promise<IncrementalRenderResult> {
  const c = cache ?? null
  if (content.trim() === '') {
    if (c) resetIncrementalCache(c, env)
    return { prefixSegments: [], tailSegments: [], stableBoundary: 0, mode: 'incremental' }
  }

  const scan = scanMarkdownBlocks(content)
  if (scan.boundary === null) return renderFallbackFull(content, c, env)
  const boundary = scan.boundary

  if (c && !isCacheStable(c, content, boundary, env)) {
    return renderFallbackFull(content, c, env) // 前缀被改写 / 边界回退（单调性防御）
  }
  if (c) await advancePrefixCache(content, boundary, c, env)

  const ids: SegIdSource = { cache: c, localId: 0 }
  const prefixSegments = await resolvePrefixSegments(content, boundary, ids, env)
  const finalize = opts?.finalizeOpenFence === true
  const tailSegments = await buildTailSegments(content, boundary, scan, finalize, env, ids)
  return { prefixSegments, tailSegments, stableBoundary: boundary, mode: 'incremental' }
}
