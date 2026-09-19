// @vitest-environment jsdom
// [U1 sanitize] DOMPurify 需要 nodeName getter 在 Node.prototype 上（realm 安全缓存 getter
// 依赖它）；happy-dom 把 nodeName 定义在各元素子类，DOMPurify 3.4.11 在 happy-dom 下把
// 所有元素判为不允许标签（P1 探针实证）——markdown 管线测试族统一跑 jsdom。
/**
 * D-5 增量渲染单测（W22）：稳定边界判定 9 形态矩阵 + segments 增量协议。
 *
 * 覆盖：稳定边界判定矩阵与 W22 验收清单——
 * - findStableBoundary：边界位置精确 offset 断言（fence ``` 与 ~~~ 变体 / 列表续并 /
 *   表格中段 / blockquote / 缩进代码 / setext / 数学块奇偶 / 链接引用定义 / 超大单行降级）
 * - HTML 块感知（设计 markdown-html-sanitize-render D7，U2）：type 1-7 边界与 md.parse
 *   html_block token 边界全等（同源常量复刻的正确性判据）+ type 7 段落打断约束 +
 *   标签配平检查（配平设边界 / 不配平 poisoned 留 tail）+ `<details>` 空行反例
 * - 拼接等价判据（正确性的唯一定义）：分段渲染拼接与全文渲染 DOM 等价
 * - renderIncremental：前缀缓存引用恒等（零重渲染）/ 边界前进 / 边界回退降级 /
 *   segId 单调递增稳定 / 未闭合 fence 占位段 / finalize 转完整渲染 / env 签名失效
 * - shouldFinalizeStreamingFence：静默期/complete 触发条件
 *
 * mock 策略与 markdown.test.ts 一致：stub shiki，测试聚焦边界逻辑而非真实高亮。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/markdown-incremental.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import MarkdownIt from 'markdown-it'
import type {
  IncrementalRenderCache,
  IncrementalRenderResult,
} from '@/composables/logic/markdown-incremental'
import type { MarkdownSegment } from '@/composables/logic/markdown'

// ── U2（设计 D7）：HTML 块边界全等断言的对照基准 ──────────────────────────
// 真实 markdown-it 实例（静态 import，不经 freshModule 的 doMock 模块图）：md.parse 的
// html_block token 是块边界的权威源，block 层解析只依赖 html:true（fence/表格等其余
// 配置不影响 html_block 规则）；扫描器常量同源复刻的正确性 = 边界与它全等。
const mdHtml = new MarkdownIt({ html: true })

/** 行首 offset 表（与实现 enumerateLines 同语义的测试侧复刻） */
function lineStartsOf(src: string): number[] {
  const starts: number[] = []
  let s = 0
  for (const line of src.split('\n')) {
    starts.push(s)
    s += line.length + 1
  }
  return starts
}

/** md.parse 的 html_block token 行区间列表（[startLine, endLine)） */
function htmlBlockRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const t of mdHtml.parse(src, {})) {
    if (t.type === 'html_block' && t.map && t.map.length === 2) {
      ranges.push([t.map[0], t.map[1]])
    }
  }
  return ranges
}

/** 断言边界 = doc 第 lineIdx 行的行首 offset（行索引越界时夹具自证失败，输出 doc 定位） */
function expectBoundaryAtLine(
  find: (content: string) => number | null,
  doc: string,
  lineIdx: number,
): void {
  const expected = lineStartsOf(doc)[lineIdx]
  if (expected === undefined) {
    throw new Error(`test fixture: line ${lineIdx} out of range for ${JSON.stringify(doc)}`)
  }
  expect(find(doc), doc).toBe(expected)
}

// stub shiki：避免真实语法加载（fine-grained 后入口是 shiki/core）；codeToHtml 计数同时用作「前缀零重渲染」的可观测探针
const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)

/** 每用例拿到干净的 markdown 模块（renderMarkdown 内部缓存 markdown-it 实例 + highlighter 单例） */
async function freshModule(): Promise<typeof import('@/composables/logic/markdown-incremental')> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  return await import('@/composables/logic/markdown-incremental')
}

/** 段序列 → 可比较 HTML（mermaid/占位段映射为标记，与 renderMarkdownSegments 的拆分口径对齐） */
function segsToHtml(segs: MarkdownSegment[]): string {
  return segs
    .map((s) => {
      if (s.type === 'text') return s.content
      if (s.type === 'mermaid') return `<div class="md-mermaid" data-source="${s.content}"></div>`
      return `<div class="md-fence-placeholder" data-lang="${s.lang ?? ''}"></div>`
    })
    .join('')
}

/** DOM 级归一化：块级标签间空白折叠（<p>a</p>\n<p>b</p> 与分段产出的 <p>a</p><p>b</p> 渲染等价）；
 *  标签前换行折叠（x\n\n<p>after</p> 与段尾 trimEnd 后拼接的 x<p>after</p> 渲染等价——
 *  U2 HTML 块剥标签后产裸文本段，段边界空白差异在此归一） */
function normalizeHtml(html: string): string {
  return html
    .replace(/>\s+</g, '><')
    .replace(/\n+</g, '<')
    .trim()
}

/** 拼接等价断言：增量（前缀+tail）拼接 与 全量渲染 在归一化后一致 */
async function expectSpliceEquivalent(content: string): Promise<void> {
  const m = await freshModule()
  const r = await m.renderIncremental(content)
  const full = await m.renderMarkdownSegments(content)
  expect(normalizeHtml(segsToHtml([...r.prefixSegments, ...r.tailSegments]))).toBe(
    normalizeHtml(segsToHtml(full)),
  )
}

describe('findStableBoundary — 9 形态矩阵（精确 offset）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('M1 纯文本：已完成段落 + 进行中段落 → 进行中段落行首', async () => {
    const { findStableBoundary } = await freshModule()
    // "para one."(0-8) \n(9) \n(10) → 边界 11 = "para two streaming" 行首
    expect(findStableBoundary('para one.\n\npara two streaming')).toBe(11)
    // 单段落内换行（breaks:true 同一 <p>）不可切：边界 0（整段为 tail 的开放块）
    expect(findStableBoundary('hello\nworld')).toBe(0)
  })

  it('M2 已闭合 fence + 进行中文本 → 闭合 fence 行尾 \\n 之后', async () => {
    const { findStableBoundary } = await freshModule()
    // ```ts(0-4) \n(5) code(6-9) \n(10) ```(11-13) \n(14) → 边界 15
    expect(findStableBoundary('```ts\ncode\n```\ntail text')).toBe(15)
    // ~~~ 变体：~~~py(0-4) \n(5) print(1)(6-13) \n(14) ~~~(15-17) \n(18) → 边界 19
    expect(findStableBoundary('~~~py\nprint(1)\n~~~\ntail')).toBe(19)
  })

  it('M3 列表连续项 → 整个列表起始前（- b 后切分会拆成两个 <ul>）', async () => {
    const { findStableBoundary } = await freshModule()
    // "para"(0-3) \n \n(5) "- a"(6-8) → 边界 6 = 列表起始
    expect(findStableBoundary('para\n\n- a\n- b\n- streaming')).toBe(6)
    // 纯列表（文档即列表）：边界 0，整个开放列表作为 tail
    expect(findStableBoundary('- a\n- b\n- streaming')).toBe(0)
  })

  it('M4 表格中段（分隔行/行内续流）→ 表格起始前', async () => {
    const { findStableBoundary } = await freshModule()
    // 表头未闭合/行持续增长：表格行内无稳定边界 → 0
    expect(findStableBoundary('| a | b |\n|---|---|\n| 1 |')).toBe(0)
  })

  it('M5 blockquote：闭合后（空行分隔）可切；引用内段落开放时不可切', async () => {
    const { findStableBoundary } = await freshModule()
    // "> quote"(0-6) \n(7) \n(8) → 边界 9（blockquote 已闭合，tail 是独立正文段落）
    expect(findStableBoundary('> quote\n\nbody streaming')).toBe(9)
    // "> quote\n> streaming"：引用段落开放（lazy continuation 拼接不安全）→ 0
    expect(findStableBoundary('> quote\n> streaming')).toBe(0)
    // 嵌套引用：前缀闭合后 tail 以引用开行 ✓
    expect(findStableBoundary('para\n\n> outer\n> > nested streaming')).toBe(6)
  })

  it('M6 未闭合 fence（``` 与 ~~~ 与 mermaid）→ fence 开行之前（fence 整体进占位）', async () => {
    const { findStableBoundary } = await freshModule()
    expect(findStableBoundary('para\n\n```ts\nconst x = 1')).toBe(6)
    expect(findStableBoundary('para\n\n```mermaid\ngraph LR')).toBe(6)
    expect(findStableBoundary('para\n\n~~~py\nprint(1)')).toBe(6)
    // fence 内空行不闭合：边界仍是 fence 开行前
    expect(findStableBoundary('para\n\n```ts\ncode\n\nstill inside')).toBe(6)
    // 闭合 fence 之后紧跟未闭合 fence：边界落在第二个 fence 开行
    expect(findStableBoundary('```a\nx\n```\n\n```ts\ny')).toBe(12)
    // fence 开行前无空行（fence 打断段落）：段落开放 → 边界 0
    expect(findStableBoundary('para\n```ts\ncode')).toBe(0)
  })

  it('M7 缩进代码 / setext / 数学块 / 链接引用定义（续行形态拒绝）', async () => {
    const { findStableBoundary } = await freshModule()
    // 缩进代码闭合后（空行分隔）+ 顶格正文 → 可切："    code"(0-7) \n(8) \n(9) → 10
    expect(findStableBoundary('    code\n\nbody')).toBe(10)
    // tail 以缩进行开头（缩进代码/列表内容续行）→ 拒绝 → 0
    expect(findStableBoundary('para\n\n    code streaming')).toBe(0)
    // setext：Title(0-4) \n(5) ===(6-8) \n(9) → 边界 10（setext 标题闭合）
    expect(findStableBoundary('Title\n===\nbody')).toBe(10)
    // 数学块 $$ 未闭合（奇偶）→ 边界在 $$ 开行前；闭合后（偶数）→ 可切过
    expect(findStableBoundary('para\n\n$$\n\\int x')).toBe(6)
    expect(findStableBoundary('para\n\n$$\n1+1\n$$\n\nbody')).toBe(17)
  })

  it('M7b 链接引用定义（文档级拒绝）：fence 外任意位置含定义行 → null 走 fallback-full', async () => {
    const { findStableBoundary } = await freshModule()
    // markdown-it 引用解析是文档级的（定义全文收集、[label] 全文消费），实测分段渲染发散：
    // def-prefix/ref-tail：全量 '[a]: /url\n\nsee [a]' 里 [a] 链接化（<a href="/url">），
    // 边界 11 切段后 tail 'see [a]' 单独渲染丢定义 → 纯文本
    expect(findStableBoundary('[a]: /url\n\nsee [a]')).toBeNull()
    // ref-prefix/def-mid-tail：'see [a] now\n\nbar\n\n[a]: /url' 定义在 tail 中部，
    // 前缀 '[a]' 渲染时定义未到达 → 不链接化且前缀缓存引用恒等永不重渲染（持久发散）
    expect(findStableBoundary('see [a] now\n\nbar\n\n[a]: /url')).toBeNull()
    // 定义后跟引用（同上反向形态）：同样 null
    expect(findStableBoundary('para\n\n[a]: /url')).toBeNull()
    // fence 内的 def 形态行不是定义（fence 内容不参与块解析）：不触发 fallback，
    // 'para'(0-3) \n(4) \n(5) ```ts(6-10) \n(11) [a]: /url(12-20) \n(21) ```(22-24) \n(25) → 边界 26
    expect(findStableBoundary('para\n\n```ts\n[a]: /url\n```\ntail')).toBe(26)
  })

  it('M7c CRLF：闭合 fence 行尾 \\r 不阻断识别（边界推进过闭合 fence）', async () => {
    const { findStableBoundary } = await freshModule()
    // 'para\r'(0-4) \n(5) \r(6) \n(7) ```ts\r(8-13) \n(14) code\r(15-19) \n(20) ```\r(21-24) \n(25) → 边界 26
    // （\r 不容忍时闭合行匹配失败 → fence 开到 EOF → 边界退到 8）
    expect(findStableBoundary('para\r\n\r\n```ts\r\ncode\r\n```\r\ntail')).toBe(26)
  })

  it('M7d 反引号 fence 的 info 含反引号：按段落处理（不是 fence 开行）', async () => {
    const { findStableBoundary } = await freshModule()
    // CommonMark：反引号 fence 的 info 不允许含反引号 → '``` a `b`' 是段落文本。
    // 边界 6（其前的空行后仍是闭合点）；误判为 fence 时 'code' 会被吞进 fence 内容
    expect(findStableBoundary('para\n\n``` a `b`\ncode')).toBe(6)
    // 对照：波浪线 fence 的 info 允许含反引号 → 正常 fence（'code' 在 fence 内，无后续边界）
    expect(findStableBoundary('para\n\n~~~ a `b`\ncode')).toBe(6)
  })

  it('M8 超大单行 → null 降级；超长尾段（前缀已闭合）→ 边界在长行前', async () => {
    const { findStableBoundary } = await freshModule()
    // 几十 KB 无 \n 的单行：唯一候选 0 被拒（无行首锚点）→ null（fallback-full）
    expect(findStableBoundary('x'.repeat(60000))).toBeNull()
    // 前缀闭合 + 超长单行 tail：长行是增长中的开放段落 → 边界 6（增量路径，长度切点不在本 wave 定）
    expect(findStableBoundary('para\n\n' + 'y'.repeat(60000))).toBe(6)
  })

  it('M9 空文档 / 仅空白 → 0；单行文档（无 \\n）→ null', async () => {
    const { findStableBoundary } = await freshModule()
    expect(findStableBoundary('')).toBe(0)
    expect(findStableBoundary('   \n')).toBe(0)
    expect(findStableBoundary('hello')).toBeNull()
    expect(findStableBoundary('hello\n')).toBe(0)
  })

  // W7 复杂度重构分支锚定：scanMarkdownBlocks 状态转移 helper 拆分后的逐分支行为快照。
  // 各断言的预期值都以「重构前实现」实跑标定（特征锚定），守护转移条件不被提取改写。
  it('M10 主题分隔线自成块（--- 与 *** 变体；缩进形态仍闭合段落）', async () => {
    const { findStableBoundary } = await freshModule()
    // 'para'(0-3) \n(4) \n(5) '---'(6-8) \n(9) \n(10) 'streaming'(11) → --- 后闭合，边界 11
    expect(findStableBoundary('para\n\n---\n\nstreaming')).toBe(11)
    // *** 变体同形态
    expect(findStableBoundary('para\n\n***\n\nstreaming')).toBe(11)
    // 缩进 2 的 --- 仍匹配 THEMATIC（前导 ≤3 空格）→ 自成块，'streaming' 行首可切 → 7
    expect(findStableBoundary('  ---\n\nstreaming')).toBe(7)
  })

  it('M11 setext = 下划线无上方开放段落 → 按普通段落文本（不闭合、不产生边界）', async () => {
    const { findStableBoundary } = await freshModule()
    // '===' 前是空行（无开放段落）→ 走段落分支 paraOpen=true，'streaming' 是 lazy 续行
    // → 全文单一开放段，唯一合法边界 0（若误判 setext 闭合会得到 6）
    expect(findStableBoundary('para\n\n===\nstreaming')).toBe(0)
  })

  it('M12 缩进 4 的 fence 标记行是段落/缩进代码形态（不是 fence 开行）', async () => {
    const { findStableBoundary } = await freshModule()
    // '    ```ts' 缩进 4 > FENCE_MAX_INDENT → 不开 fence；tail 首行缩进 → 续行形态拒绝，
    // 'para' 段开放 → 边界 0（若误判 fence 开行会得到 6）
    expect(findStableBoundary('para\n\n    ```ts\nx')).toBe(0)
  })

  it('M13 引用行终止列表上下文：引用后的新列表标记行可作边界', async () => {
    const { findStableBoundary } = await freshModule()
    // '- a'(0-2) \n(3) ''(4) \n(5) '> q'(6-8) \n(9) ''(10) \n(11) '- b streaming'(12)
    // '> q' 顶格引用行终止列表（listOpen true→false）→ '- b streaming' 不与前缀列表续并 → 边界 10
    // （若引用不终止列表，'- b streaming' 被拒，边界退到 '> q' 行首 5）
    expect(findStableBoundary('- a\n\n> q\n\n- b streaming')).toBe(10)
  })

  it('纯函数属性：同输入同输出（重复调用结果恒等）', async () => {
    const { findStableBoundary } = await freshModule()
    const inputs = [
      'para one.\n\npara two streaming',
      '```ts\ncode\n```\ntail',
      'para\n\n- a\n- b\n- c',
      '| a | b |\n|---|---|\n| 1 |',
      'para\n\n```ts\nconst x',
      'x'.repeat(1000),
    ]
    for (const s of inputs) {
      expect(findStableBoundary(s)).toBe(findStableBoundary(s))
    }
  })
})

describe('findStableBoundary — HTML 块感知（D7：markdown-it 同源常量复刻 + 配平检查）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('H1 闭合 HTML 块（type 1-7 矩阵）：边界 = md.parse html_block token 结束后的 streaming 行首', async () => {
    const { findStableBoundary } = await freshModule()
    const blocks = [
      '<pre>\ncode\n</pre>', // type 1：闭合标签行闭合（闭合行属于块）
      '<pre>x</pre>', // type 1：开行自身含闭合序列 → 单行块
      '<!-- multi\nline -->', // type 2：--> 行内闭合
      '<!-- multi\n\nblank inside -->', // type 2 块内空行（空行是块内内容，非闭合——R2 被否语义锚点）
      '<?php\necho 1;\n?>', // type 3：?> 闭合
      '<!DOCTYPE\ntitle>', // type 4：> 闭合
      '<![CDATA[\ndata\n]]>', // type 5：]]> 闭合
      '<div>\nx\n</div>', // type 6：div 在 html_blocks 名单，空行闭合（</div> 是块内容）
      '<mytag>\nx\n</mytag>', // type 7：mytag 不在名单，完整标签行进入，空行闭合
    ]
    for (const block of blocks) {
      const doc = `para\n\n${block}\n\nstreaming`
      const ranges = htmlBlockRanges(doc)
      // md.parse 对照基准有效性：确有 html_block（防测试形态构造漂移）
      expect(ranges.length, doc).toBeGreaterThan(0)
      const [, endLine] = ranges[0]
      // 全部形态块内标签配平（注释/PI/声明/CDATA/开闭对计 0）→ 块后可切：最后合法边界
      // = 紧邻块后的 streaming 行首。若扫描器把块内空行当块闭合（type 1-5 语义弄反），
      // 边界会提前落进块内 → 与 token 边界全等失败。
      expectBoundaryAtLine(findStableBoundary, doc, endLine + 1)
    }
  })

  it('H2 未闭合 HTML 块（到 EOF）：块内无边界，边界退到块首行首（md.parse token 首行）', async () => {
    const { findStableBoundary } = await freshModule()
    const blocks = [
      '<pre>\ncode', // type 1 未闭合
      '<!-- multi', // type 2 未闭合（EOF）
      '<?php', // type 3 未闭合
      '<div>\nx', // type 6 未闭合（空行未到）
      '<table>\n<tr>', // type 6 名单标签多行
      '<mytag>\nx', // type 7 未闭合
    ]
    for (const block of blocks) {
      const doc = `para\n\n${block}`
      const ranges = htmlBlockRanges(doc)
      expect(ranges.length, doc).toBeGreaterThan(0)
      const [startLine] = ranges[0]
      // 块开着（EOF 未闭合）→ 块内行首全部不可切 → 最后合法边界 = 块首行首
      expectBoundaryAtLine(findStableBoundary, doc, startLine)
    }
  })

  it('H3 type 7 段落打断约束：完整标签行不可打断段落；type 1-6 可打断（实装第三列语义）', async () => {
    const { findStableBoundary } = await freshModule()
    // type 7 不打断段落：md.parse 无 html_block（三行是一个 paragraph 的 lazy 续行），
    // 扫描器同语义（paraOpen 持续）→ 边界 0
    const inPara = 'para\n<mytag>\nmore'
    expect(htmlBlockRanges(inPara)).toEqual([])
    expect(findStableBoundary(inPara)).toBe(0)
    // 对照 type 6 可打断段落：md.parse 侧 para 单行闭合 + html_block [1,3)；扫描器侧
    // 与 fence 打断段落形态（M6 末条）同保守语义——行 0 处理后段落开放，行 1 行首候选
    // 不可切 → 边界 0（少切不切不破坏等价，tail 含 div 块整段渲染）
    const interrupted = 'para\n<div>\nx'
    expect(htmlBlockRanges(interrupted)).toEqual([[1, 3]])
    expect(findStableBoundary(interrupted)).toBe(0)
    // type 7 在段落开始处（前无段落内容）可进入：文档首行完整标签 → html_block，正常设边界
    const atStart = '<mytag>\nx\n</mytag>\n\nafter'
    expect(htmlBlockRanges(atStart)).toEqual([[0, 3]])
    expectBoundaryAtLine(findStableBoundary, atStart, 4)
  })

  it('H4 配平检查：配平块设边界；不配平块（裸开标签/孤立闭标签）禁设边界，块及其后留 tail', async () => {
    const { findStableBoundary } = await freshModule()
    // 配平：div±0；img（void）/br/（自闭合）/注释对计数透明不计
    const balanced = '<div>\n<img src="x">\n<br/>\n<!-- c -->\n</div>\n\nstreaming'
    expect(htmlBlockRanges(balanced)).toEqual([[0, 5]])
    expectBoundaryAtLine(findStableBoundary, balanced, 6)
    // 裸开标签（README 居中形态，D2 锚点）：块按 type 6 空行闭合但标签不配平 → 块首起
    // 候选全部失效 → 边界回退。块前空行行首（5）的候选在段落行处理后评估（paraOpen=true，
    // 段落开放保守语义——同 M6 fence 打断形态）不可用 → 边界退到 0：para 与裸 div 及其
    // 后内容整体留 tail（比「块前切」更保守，等价方向不变）
    const bareOpen = 'para\n\n<div align=center>\n\n# Title\n\nintro'
    expect(htmlBlockRanges(bareOpen)).toEqual([[2, 3]])
    expect(findStableBoundary(bareOpen)).toBe(0)
    // 孤立闭标签：净计数 -1 不配平 → 同上
    const orphanClose = 'para\n\n</div>\n\nstreaming'
    expect(htmlBlockRanges(orphanClose)).toEqual([[2, 3]])
    expect(findStableBoundary(orphanClose)).toBe(0)
    // 不配平块后的内容整体不可切：裸 div 后的配平块也不设边界（poisoned 不恢复）
    const afterBare = 'para\n\n<div align=center>\n\n<div>\nx\n</div>\n\nstreaming'
    expect(findStableBoundary(afterBare)).toBe(0)
  })

  it('H5 `<details>` 展开形态：块内空行不切块（两块均不配平 → 文档级 fallback-full）', async () => {
    const { findStableBoundary } = await freshModule()
    // md.parse：两个 html_block（[0,2) 空行闭合块1 / [5,6)）夹段落——行 2 空行闭合块1
    // 是 type 6 语义（details 在名单）；两块各含裸 <details>(+1) / </details>(-1) 不配平
    // → poisonedFrom=0 → 无候选 → null（fallback-full：整文档单段渲染，性能换正确性——
    // 若无配平检查，空行处切块会把裸 <details> 补闭固化进前缀缓存，live ≠ reload 永久化）
    const unfolded = '<details>\n<summary>s</summary>\n\ncontent inside\n\n</details>\n\nafter'
    expect(htmlBlockRanges(unfolded)).toEqual([
      [0, 2],
      [5, 6],
    ])
    expect(findStableBoundary(unfolded)).toBeNull()
    // 对照：配平 details（单块内 <details>x</details> 净计数 0）正常设边界
    const balancedDetails = '<details>\nx\n</details>\n\nafter'
    expect(htmlBlockRanges(balancedDetails)).toEqual([[0, 3]])
    expectBoundaryAtLine(findStableBoundary, balancedDetails, 4)
  })
})

describe('renderIncremental — 拼接等价判据（闭合内容 DOM 等价）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('闭合内容：前缀+tail 拼接与全量渲染 DOM 等价（段落/fence/列表/引用/表格/标题/setext/缩进代码/mermaid）', async () => {
    await expectSpliceEquivalent('para one.\n\npara two.')
    await expectSpliceEquivalent('```ts\nconst x = 1\n```\n\nafter code.')
    await expectSpliceEquivalent('- a\n- b\n\nafter list.')
    await expectSpliceEquivalent('> quote\n\nafter quote.')
    await expectSpliceEquivalent('| a | b |\n|---|---|\n| 1 | 2 |\n\nafter table.')
    await expectSpliceEquivalent('# Title\n\nbody para.')
    await expectSpliceEquivalent('Title\n===\n\n    indented\n\nbody end.')
    await expectSpliceEquivalent('~~~py\nprint(1)\n~~~\nafter fence.')
    await expectSpliceEquivalent('intro\n\n```mermaid\ngraph TD;A-->B\n```\n\noutro.')
    await expectSpliceEquivalent('para\n\n$$\n1+1\n$$\n\nafter math.')
    // W22 review 回归：含链接引用定义的文档走 fallback-full → 与全量渲染等价
    // （全量渲染里 [a] 链接化；分段会丢定义发散，见 M7b）
    await expectSpliceEquivalent('[a]: /url\n\nsee [a]')
    await expectSpliceEquivalent('see [a] now\n\nbar\n\n[a]: /url')
    // W22 review 回归：CRLF 闭合 fence（markdown-it 解析前归一化 \r\n，分段两侧等价）
    await expectSpliceEquivalent('para\r\n\r\n```ts\r\ncode\r\n```\r\ntail')
    // W22 review 回归：反引号 fence info 含反引号按段落处理（误判 fence 会产占位段发散）
    await expectSpliceEquivalent('para\n\n``` a `b`\ncode')
  })

  // U2（设计 D2/D7）：HTML 块形态的切段/整串全等——裸开标签「吸进」语义下两态一致的
  // 构造性验证（不配平块留 tail → tail 整段渲染与整串同语义；配平块切段前后无裸结构）
  it('HTML 块形态（D2/D7）：切段渲染与全量渲染 DOM 等价', async () => {
    // README 居中裸 div（带前缀段落：poisoned → 边界退到 div 前空行，div 及其后留 tail）
    await expectSpliceEquivalent('para\n\n<div align=center>\n\n# 太极 TaiJi\n\nintro streaming')
    // README 居中裸 div（文档首：poisonedFrom=0 → 无候选 → fallback-full 整文档单段）
    await expectSpliceEquivalent('<div align=center>\n\n# Title\n\npara')
    // <details> 展开形态（两块不配平 → fallback-full；空行不切块）
    await expectSpliceEquivalent('<details>\n<summary>s</summary>\n\ncontent inside\n\n</details>\n\nafter')
    // 配平块：增量切段（前缀可含完整配平 HTML 块，段级 DOM 往返不补闭）
    await expectSpliceEquivalent('<div>\nx\n</div>\n\nafter')
    // type 2 块内空行（空行是块内内容，块整体闭合后才可切）
    await expectSpliceEquivalent('<!-- multi\n\nblank inside -->\n\nafter')
    // type 1 / type 7 代表形态
    await expectSpliceEquivalent('<pre>\ncode\n</pre>\n\nafter')
    await expectSpliceEquivalent('<mytag>\nx\n</mytag>\n\nafter')
  })
})

describe('renderIncremental — 缓存协议 / segId / 降级 / 占位', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('P1 前缀缓存命中：prefixSegments 引用恒等 + 前缀零重渲染（shiki 计数不变）', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const r1 = await m.renderIncremental('```ts\nconst a = 1\n```\nstreaming text', cache)
    expect(r1.mode).toBe('incremental')
    expect(r1.stableBoundary).toBe(22)
    expect(r1.prefixSegments.length).toBe(1)
    expect(r1.prefixSegments[0].type).toBe('text')
    expect(r1.prefixSegments[0].content).toContain('md-codeblock')
    const callsAfterFirst = fakeCodeToHtml.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // 同前缀第二帧（tail 增长、边界不变）：数组与段对象引用恒等，前缀代码块未重渲染
    const r2 = await m.renderIncremental('```ts\nconst a = 1\n```\nstreaming text more', cache)
    expect(r2.stableBoundary).toBe(22)
    expect(r2.prefixSegments).toBe(r1.prefixSegments)
    expect(r2.prefixSegments[0]).toBe(r1.prefixSegments[0])
    expect(fakeCodeToHtml.mock.calls.length).toBe(callsAfterFirst)
  })

  it('P2 边界前进：新增稳定区并入前缀缓存，历史段引用稳定', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const r1 = await m.renderIncremental('A\n\nB', cache)
    expect(r1.stableBoundary).toBe(3)
    expect(r1.prefixSegments.length).toBe(1)
    expect(r1.prefixSegments[0].content).toContain('<p>A</p>')

    const r2 = await m.renderIncremental('A\n\nB\n\nC', cache)
    expect(r2.stableBoundary).toBe(6)
    expect(r2.prefixSegments.length).toBe(2)
    expect(r2.prefixSegments[0]).toBe(r1.prefixSegments[0]) // 历史段引用恒等
    expect(r2.prefixSegments[1].content).toContain('<p>B</p>')
    expect(r2.tailSegments.map((s) => s.content)).toEqual([expect.stringContaining('<p>C</p>')])

    // 缓存状态与 content 对齐（供下一帧 append-only 校验）
    expect(cache.boundary).toBe(6)
    expect(cache.prefixText).toBe('A\n\nB\n\n')
  })

  it('P3 segId 单调递增稳定：帧内严格递增、跨帧不复用、前缀段 id 恒等', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const r1 = await m.renderIncremental('A\n\nB', cache)
    const r2 = await m.renderIncremental('A\n\nB\n\nC', cache)
    const r3 = await m.renderIncremental('A\n\nB\n\nC\n\nD', cache)

    const frame1 = [...r1.prefixSegments, ...r1.tailSegments].map((s) => s.segId)
    const frame3 = [...r3.prefixSegments, ...r3.tailSegments].map((s) => s.segId)
    // 帧内严格递增
    for (let i = 1; i < frame1.length; i++) expect(frame1[i]).toBeGreaterThan(frame1[i - 1])
    for (let i = 1; i < frame3.length; i++) expect(frame3[i]).toBeGreaterThan(frame3[i - 1])
    // 全局唯一：前缀段跨帧恒等复用（id 重复是设计——稳定 key），故唯一性对
    // 「最终前缀段 ∪ 各帧 tail 段」的并集断言（= 所有已分配 id 无重复）
    const allocated = [
      ...r3.prefixSegments,
      ...r1.tailSegments,
      ...r2.tailSegments,
      ...r3.tailSegments,
    ].map((s) => s.segId)
    expect(new Set(allocated).size).toBe(allocated.length)
    // 前缀段 id 跨帧恒等
    expect(r3.prefixSegments[0].segId).toBe(r1.prefixSegments[0].segId)
    expect(r3.prefixSegments[1].segId).toBe(r2.prefixSegments[1].segId)
  })

  it('P4 边界回退 → fallback-full：mode 降级、输出等同全量、缓存重置、下一帧可恢复', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const r1 = await m.renderIncremental('A\n\nB\n\nC', cache)
    expect(r1.stableBoundary).toBe(6)

    // 前缀收缩（内容被改写）：新边界 3 < 旧 6 → 降级
    const r2 = await m.renderIncremental('A\n\nB', cache)
    expect(r2.mode).toBe('fallback-full')
    expect(r2.stableBoundary).toBe(0)
    expect(r2.prefixSegments).toEqual([])
    const full = await m.renderMarkdownSegments('A\n\nB')
    expect(segsToHtml(r2.tailSegments)).toBe(segsToHtml(full))
    // 缓存重置（可恢复）
    expect(cache.boundary).toBe(0)
    expect(cache.prefixSegments).toEqual([])
    // 下一帧恢复增量
    const r3 = await m.renderIncremental('A\n\nB\n\nD', cache)
    expect(r3.mode).toBe('incremental')
    expect(r3.stableBoundary).toBe(6)
  })

  it('P4b 前缀被改写（同边界位置内容不同）→ fallback-full', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    await m.renderIncremental('A\n\nB\n\nC', cache) // boundary 6, prefix "A\n\nB\n\n"
    // 位置 6 之前的内容被改写（B→X）：append-only 校验失败 → 降级
    const r = await m.renderIncremental('A\n\nX\n\nC', cache)
    expect(r.mode).toBe('fallback-full')
  })

  it('P5 未闭合 fence 占位：语言名 + streaming 标记数据 + 已流式源码', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const r = await m.renderIncremental('para\n\n```ts\nconst x = 1', cache)
    expect(r.mode).toBe('incremental')
    expect(r.stableBoundary).toBe(6)
    expect(r.prefixSegments[0].content).toContain('<p>para</p>')
    expect(r.tailSegments.length).toBe(1)
    const ph = r.tailSegments[0]
    expect(ph.type).toBe('streaming-fence')
    expect(ph.lang).toBe('ts')
    expect(ph.mermaid).toBe(false)
    expect(ph.content).toBe('const x = 1')

    // mermaid fence：mermaid 标记为 true
    const rm = await m.renderIncremental('para\n\n```mermaid\ngraph LR', m.createIncrementalRenderCache())
    const mph = rm.tailSegments[rm.tailSegments.length - 1]
    expect(mph.type).toBe('streaming-fence')
    expect(mph.mermaid).toBe(true)
    expect(mph.lang).toBe('mermaid')

    // fence 开行后尚无内容（无 \n）：占位 content 为空串
    const re = await m.renderIncremental('para\n\n```ts', m.createIncrementalRenderCache())
    expect(re.tailSegments[re.tailSegments.length - 1].content).toBe('')

    // fence 前无空行（段落开放）：边界 0，tail = 段落 text 段 + 占位段
    const r0 = await m.renderIncremental('para\n```ts\ncode', m.createIncrementalRenderCache())
    expect(r0.stableBoundary).toBe(0)
    expect(r0.prefixSegments).toEqual([])
    expect(r0.tailSegments.length).toBe(2)
    expect(r0.tailSegments[0].type).toBe('text')
    expect(r0.tailSegments[1].type).toBe('streaming-fence')
    // W22 review（Major-2）：openFence 分支的 pre 段（占位前的文本段）也携带 segId、
    // 帧内单调递增（曾漏赋值 → text 段无 key，v-for 复用错位）
    expect(typeof r0.tailSegments[0].segId).toBe('number')
    expect(r0.tailSegments[0].segId).toBeLessThan(r0.tailSegments[1].segId as number)

    // W22 review（minor）：反引号 fence info 含反引号 → 不产占位段，整段按段落文本渲染
    const rbt = await m.renderIncremental('para\n\n``` a `b`\ncode', m.createIncrementalRenderCache())
    expect(rbt.mode).toBe('incremental')
    expect(rbt.tailSegments.every((s) => s.type === 'text')).toBe(true)

    // info string 首词为语言名
    const ri = await m.renderIncremental('para\n\n```ts title=x\nconst', m.createIncrementalRenderCache())
    expect(ri.tailSegments[ri.tailSegments.length - 1].lang).toBe('ts')
  })

  it('P6 finalizeOpenFence：complete/静默期命中后未闭合 fence 转完整渲染', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const r = await m.renderIncremental('para\n\n```ts\nconst x = 1', cache, undefined, {
      finalizeOpenFence: true,
    })
    expect(r.mode).toBe('incremental')
    expect(r.stableBoundary).toBe(6)
    expect(r.tailSegments.length).toBe(1)
    expect(r.tailSegments[0].type).toBe('text')
    // markdown-it 把文档尾未闭合 fence 渲染为含已到达内容的代码块（shiki 高亮）
    expect(r.tailSegments[0].content).toContain('md-codeblock')
    expect(fakeCodeToHtml).toHaveBeenCalled()
  })

  it('P6b finalize 等价：占位形态文档以 finalizeOpenFence:true 渲染，与全量渲染 segsToHtml 等价', async () => {
    // W22 review（minor）：finalize 分支缺等价测试——补「前缀 + finalize tail 拼接
    // = 全量渲染」判据（markdown-it 把文档尾未闭合 fence 渲染为含已到达内容的代码块）
    const m = await freshModule()
    const content = 'para.\n\n```ts\nconst x = 1'
    const r = await m.renderIncremental(content, m.createIncrementalRenderCache(), undefined, {
      finalizeOpenFence: true,
    })
    expect(r.mode).toBe('incremental')
    const full = await m.renderMarkdownSegments(content)
    expect(normalizeHtml(segsToHtml([...r.prefixSegments, ...r.tailSegments]))).toBe(
      normalizeHtml(segsToHtml(full)),
    )
  })

  it('P7 env 签名失效：filePaths 引用变化 → 前缀缓存重建（全量重渲染）', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const envA = { filePaths: new Set(['src/a.ts']) }
    const content = 'edit src/a.ts now\n\nstreaming tail'
    // "edit src/a.ts now"(0-16) \n(17) \n(18) → 边界 19
    const r1 = await m.renderIncremental(content, cache, envA)
    expect(r1.stableBoundary).toBe(19)
    expect(r1.prefixSegments[0].content).toContain('md-filepath')

    // 同 env 引用：缓存命中（引用恒等）
    const r2 = await m.renderIncremental(content, cache, envA)
    expect(r2.prefixSegments).toBe(r1.prefixSegments)

    // env 引用变化（内容相同）：缓存失效 → 前缀重建（新对象），链接化语义不丢
    const envB = { filePaths: new Set(['src/a.ts']) }
    const r3 = await m.renderIncremental(content, cache, envB)
    expect(r3.prefixSegments).not.toBe(r1.prefixSegments)
    expect(r3.prefixSegments[0]).not.toBe(r1.prefixSegments[0])
    expect(r3.prefixSegments[0].content).toContain('md-filepath')
    expect(r3.stableBoundary).toBe(19)
    // 重建后同 env 再渲染 → 新缓存命中
    const r4 = await m.renderIncremental(content, cache, envB)
    expect(r4.prefixSegments).toBe(r3.prefixSegments)
  })

  it('P7b env 签名失效：resourceBaseDir 值变化 → 前缀缓存重建（切 session cwd 防旧基准残留，设计 D4）', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    // resourceBaseDir 是 string：值比较（与 Set 的引用比较同语义层——「基准变了就重建」）
    const envA = { resourceBaseDir: '/home/project-a' }
    const content = 'plain para\n\nstreaming tail'
    const r1 = await m.renderIncremental(content, cache, envA)
    expect(r1.stableBoundary).toBeGreaterThan(0)

    // 同值：缓存命中（引用恒等）
    const r2 = await m.renderIncremental(content, cache, { resourceBaseDir: '/home/project-a' })
    expect(r2.prefixSegments).toBe(r1.prefixSegments)

    // 值变化（切 session cwd）：缓存失效 → 前缀重建（新对象）
    const r3 = await m.renderIncremental(content, cache, { resourceBaseDir: '/home/project-b' })
    expect(r3.prefixSegments).not.toBe(r1.prefixSegments)
    expect(r3.prefixSegments[0]).not.toBe(r1.prefixSegments[0])
    // 重建后同 env 再渲染 → 新缓存命中
    const r4 = await m.renderIncremental(content, cache, { resourceBaseDir: '/home/project-b' })
    expect(r4.prefixSegments).toBe(r3.prefixSegments)
  })

  it('P8 无 cache 调用：无状态拆分渲染（一次性消费），前缀+tail 覆盖全文', async () => {
    const m = await freshModule()
    const r: IncrementalRenderResult = await m.renderIncremental('A\n\nB\n\nC')
    expect(r.mode).toBe('incremental')
    expect(r.stableBoundary).toBe(6)
    const full = await m.renderMarkdownSegments('A\n\nB\n\nC')
    expect(normalizeHtml(segsToHtml([...r.prefixSegments, ...r.tailSegments]))).toBe(
      normalizeHtml(segsToHtml(full)),
    )
    // 段均携带 segId（帧内单调）
    const ids = [...r.prefixSegments, ...r.tailSegments].map((s) => s.segId)
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1])
  })

  it('P9 空内容：空段 + incremental + 缓存归零', async () => {
    const m = await freshModule()
    const cache: IncrementalRenderCache = m.createIncrementalRenderCache()
    await m.renderIncremental('A\n\nB', cache)
    const r = await m.renderIncremental('', cache)
    expect(r.mode).toBe('incremental')
    expect(r.prefixSegments).toEqual([])
    expect(r.tailSegments).toEqual([])
    expect(cache.boundary).toBe(0)
  })

  it('P10 超大单行 → fallback-full（mode + 全量输出 + 缓存重置）', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    await m.renderIncremental('A\n\nB', cache)
    const r = await m.renderIncremental('z'.repeat(60000), cache)
    expect(r.mode).toBe('fallback-full')
    expect(r.prefixSegments).toEqual([])
    expect(r.tailSegments.length).toBeGreaterThan(0)
    expect(cache.boundary).toBe(0)
  })

  // W7 复杂度重构分支锚定：renderIncremental 阶段 helper 拆分后的逐分支行为快照
  // （预期值以「重构前实现」实跑标定，守护提取不改写分支条件与执行顺序）。

  it('P11 边界前进且新增稳定区全空白：只推进边界不产新段（前缀数组引用恒等）', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const r1 = await m.renderIncremental('A\n\nB', cache)
    expect(r1.stableBoundary).toBe(3)
    expect(r1.prefixSegments.length).toBe(1)

    // 第二帧尾加空行：新边界 6，piece = 'B\n\n' 含非空白 → 'B' 段并入前缀（新建数组），tail 空
    const r2 = await m.renderIncremental('A\n\nB\n\n', cache)
    expect(r2.mode).toBe('incremental')
    expect(r2.stableBoundary).toBe(6)
    expect(r2.prefixSegments).not.toBe(r1.prefixSegments)
    expect(r2.prefixSegments.length).toBe(2)
    expect(r2.tailSegments).toEqual([])
    expect(cache.boundary).toBe(6)
    expect(cache.prefixText).toBe('A\n\nB\n\n')

    // 第三帧只加空行：piece = '\n\n' 全空白 → pieceSegs=[]，前缀数组原引用保留（零重渲染）
    const r3 = await m.renderIncremental('A\n\nB\n\n\n\n', cache)
    expect(r3.mode).toBe('incremental')
    expect(r3.stableBoundary).toBe(8)
    expect(r3.prefixSegments).toBe(r2.prefixSegments)
    expect(r3.prefixSegments.length).toBe(2)
    expect(r3.tailSegments).toEqual([])
  })

  it('P12 无 cache 且边界 0：前缀空白分支（不渲染前缀）+ tail 全文从 segId 0 起', async () => {
    const m = await freshModule()
    // 'hello\nworld' 单一开放段（breaks:true 同一 <p>）→ boundary 0，前缀空
    const r = await m.renderIncremental('hello\nworld')
    expect(r.mode).toBe('incremental')
    expect(r.stableBoundary).toBe(0)
    expect(r.prefixSegments).toEqual([])
    expect(r.tailSegments.length).toBe(1)
    expect(r.tailSegments[0].type).toBe('text')
    expect(r.tailSegments[0].content).toContain('<br')
    expect(r.tailSegments[0].segId).toBe(0)
  })

  it('P12b 无 cache 且 tail 全空白：tail 空白分支不渲染、不产段', async () => {
    const m = await freshModule()
    const r = await m.renderIncremental('A\n\nB\n\n')
    expect(r.mode).toBe('incremental')
    expect(r.stableBoundary).toBe(6)
    expect(r.prefixSegments.length).toBe(1)
    expect(r.tailSegments).toEqual([])
  })

  it('P13 空 info fence 占位：lang 归一 text、mermaid false', async () => {
    const m = await freshModule()
    const r = await m.renderIncremental('para\n\n```\ncode streaming', m.createIncrementalRenderCache())
    expect(r.mode).toBe('incremental')
    const ph = r.tailSegments[r.tailSegments.length - 1]
    expect(ph.type).toBe('streaming-fence')
    expect(ph.lang).toBe('text')
    expect(ph.mermaid).toBe(false)
    expect(ph.content).toBe('code streaming')
  })

  it('P14 env 签名失效且新边界不前进：重置走正常路径（非 fallback），env 引用同步', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    const envA = { filePaths: new Set(['src/a.ts']) }
    await m.renderIncremental('A\n\nB', cache, envA)
    expect(cache.boundary).toBe(3)

    // env 引用变化 + 新内容 boundary 0：reset 后 boundary 不前进 → 前缀缓存保持空、tail 全文
    const envB = { filePaths: new Set(['src/b.ts']) }
    const r = await m.renderIncremental('hello\nworld', cache, envB)
    expect(r.mode).toBe('incremental')
    expect(r.stableBoundary).toBe(0)
    expect(r.prefixSegments).toEqual([])
    expect(r.tailSegments.length).toBe(1)
    // env 引用签名已同步为新引用（下一帧同 env 命中缓存校验）
    expect(cache.envFilePaths).toBe(envB.filePaths)
    expect(cache.boundary).toBe(0)
  })

  // U2（设计 D7）：裸 div 流式帧序列——块未闭合时边界可推进到块前空行（6），空行到达
  // 触发配平检查 → 不配平 → poisoned → 边界要求回退（6 → 5）→ 既有「边界回退防御」
  // 接管（fallback-full 一帧 + 缓存重置），后续帧在裸 div 前稳定（块及其后整体留 tail，
  // 前缀永不固化被补闭的裸开标签——live ≡ reload 构造性成立）
  it('P15 裸 div 流式帧序列：不配平块闭合 → 边界回退防御 fallback-full → 恢复增量', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    // 帧1：块开着（EOF 未闭合）→ 边界 6（div 行首；div 是独立开放块起始）
    const f1 = await m.renderIncremental('para\n\n<div align=center>', cache)
    expect(f1.mode).toBe('incremental')
    expect(f1.stableBoundary).toBe(6)
    // 帧2：空行 + 后续标题到达 → type 6 空行闭合 + 配平检查不配平 → poisonedFrom=6 →
    // 合法边界回退（块前段落行尾候选不可用 → 0 < 缓存 6）→ 既有边界单调性防御触发
    // （fallback-full，输出等同全量）
    const f2 = await m.renderIncremental('para\n\n<div align=center>\n\n# T', cache)
    expect(f2.mode).toBe('fallback-full')
    expect(f2.stableBoundary).toBe(0)
    // 帧3：标题补全 → 边界稳定在 0（para 与裸 div 及其后整体留 tail——块前段落行尾
    // 候选因段落开放保守语义不可用），前缀永不固化被补闭的裸开标签
    const f3content = 'para\n\n<div align=center>\n\n# Title'
    const f3 = await m.renderIncremental(f3content, cache)
    expect(f3.mode).toBe('incremental')
    expect(f3.stableBoundary).toBe(0)
    // live ≡ reload：帧3 前缀 + tail 拼接与同帧全量渲染等价（tail 段整段渲染承载吸进语义）
    const full3 = await m.renderMarkdownSegments(f3content)
    expect(normalizeHtml(segsToHtml([...f3.prefixSegments, ...f3.tailSegments]))).toBe(
      normalizeHtml(segsToHtml(full3)),
    )
  })

  // U2（设计 D7）：配平 HTML 块流式——块闭合且配平后边界正常前进（前缀可含完整块）
  it('P16 配平 HTML 块流式：块闭合后边界推进过块（前缀含配平块，无回退）', async () => {
    const m = await freshModule()
    const cache = m.createIncrementalRenderCache()
    // 帧1：块开着 → 边界 6（块前）
    const f1 = await m.renderIncremental('para\n\n<div>\nx', cache)
    expect(f1.stableBoundary).toBe(6)
    // 帧2：空行到达块闭合（配平）+ after 段落 → 边界推进到 after 行首，模式保持增量
    const f2content = 'para\n\n<div>\nx\n</div>\n\nafter'
    const f2 = await m.renderIncremental(f2content, cache)
    expect(f2.mode).toBe('incremental')
    expect(f2.stableBoundary).toBe(lineStartsOf(f2content)[6])
    // 前缀含配平 div 块的渲染（段级 DOM 往返不补闭）
    expect(f2.prefixSegments.map((s) => s.content).join('')).toContain('<div>')
    expect(f2.prefixSegments.map((s) => s.content).join('')).toContain('</div>')
  })
})

describe('shouldFinalizeStreamingFence — 静默期/complete 触发条件', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('complete 或静默 ≥ 阈值（200ms 起点，dev 实测 tuning）时转完整渲染', async () => {
    const m = await freshModule()
    expect(m.STREAMING_FENCE_SILENCE_MS).toBe(200)
    expect(m.shouldFinalizeStreamingFence({ complete: true, silenceMs: 0 })).toBe(true)
    expect(m.shouldFinalizeStreamingFence({ complete: false, silenceMs: 0 })).toBe(false)
    expect(m.shouldFinalizeStreamingFence({ complete: false, silenceMs: 199 })).toBe(false)
    expect(m.shouldFinalizeStreamingFence({ complete: false, silenceMs: 200 })).toBe(true)
    expect(m.shouldFinalizeStreamingFence({ complete: false, silenceMs: 5000 })).toBe(true)
  })
})
