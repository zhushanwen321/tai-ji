/**
 * unified diff 解析纯函数（R2 logic 层）。
 *
 * 输入 git.getDiff 返回的 patch 字符串（标准 unified diff，`git diff` stdout），
 * 输出结构化的 hunks/lines，供 DiffView.vue 做行级着色渲染。
 *
 * 为何自写而非引入 diff2html：
 * - unified diff 文本规则极简（hunk 头 `@@ -a,b +c,d @@` + 行首 +/-/空 分类），纯函数约 80 行。
 * - diff2html 自带 HTML/CSS 与项目 design-tokens + 双主题体系冲突，引入后需大量样式覆盖，更重。
 * - 纯函数便于 vitest 单测，输出结构可走 design-tokens 变量（--success/--danger）着色。
 *
 * XSS：本函数只产出数据结构，不生成 HTML。代码内容的语法高亮由 CodeBlock 经 shiki codeToHtml
 * 处理（转义所有非 token 文本），渲染层 DiffView 用文本插值 + 受控 v-html（shiki span），沿用
 * MarkdownRenderer 的 XSS 论证。
 *
 * 规则参考：https://www.gnu.org/software/diffutils/manual/html_node/Detailed-Unified.html
 */

/** diff 行类型 */
export type DiffLineType = 'context' | 'add' | 'del' | 'hunk' | 'meta'

/** 字符级 diff 片段：配对的 del/add 行拆分出的连续文本段 */
export interface DiffSegment {
  text: string
  kind: 'normal' | 'add' | 'del'
}

export interface DiffLine {
  type: DiffLineType
  /** 旧文件行号（context/del 有，add 无，meta/hunk 无） */
  oldNo?: number
  /** 新文件行号（context/add 有，del 无，meta/hunk 无） */
  newNo?: number
  /** 行内容（不含行首 +/-/空 分类字符，meta 行保留原始文本） */
  content: string
  /** 字符级 diff 片段（仅 del+add 配对成功的行有，其余为 undefined） */
  segments?: DiffSegment[]
}

export interface DiffHunk {
  /** hunk 头解析出的旧文件起始行号 */
  oldStart: number
  /** hunk 头解析出的新文件起始行号 */
  newStart: number
  /** 该 hunk 的所有行（含 hunk 头行本身 type='hunk' + 后续 context/add/del 行） */
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: DiffHunk[]
}

/** hunk 头正则：@@ -oldStart,oldCount +newStart,newCount @@ 后跟可选上下文 */
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

/**
 * 解析 unified diff patch 为结构化 hunks。
 *
 * 行分类（首字符）：
 * - '@@ ' → hunk 头：解析 oldStart/newStart，重置行号计数器
 * - ' '   → context：oldNo + newNo 双计数推进
 * - '+'   → add：仅 newNo 推进（oldNo 无）
 * - '-'   → del：仅 oldNo 推进（newNo 无）
 * - '--- '/'+++ '/'diff --git '/'index ' 等 → meta：文件头信息行，type='meta'
 * - 空行：unified diff 里空 context 行实际是「单空格被 trim」的特殊情况，
 *   视作 context（git 有时输出裸空行表示"空 context 行"，content 补空串）
 *
 * 鲁棒性：无法识别的行降级为 meta 原样保留，不中断解析。
 * 空/非 diff 输入（无任何 hunk）→ 返回 { hunks: [] }，DiffView 渲染空态。
 */
export function parseDiff(patch: string): ParsedDiff {
  if (!patch) return { hunks: [] }
  const lines = patch.split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const raw of lines) {
    const hunkMatch = raw.match(HUNK_HEADER)
    if (hunkMatch) {
      // hunk 头：收尾上一个 hunk，开启新 hunk
      oldNo = Number(hunkMatch[1])
      newNo = Number(hunkMatch[3])
      current = { oldStart: oldNo, newStart: newNo, lines: [] }
      hunks.push(current)
      current.lines.push({ type: 'hunk', content: raw })
      continue
    }

    // 还未进入任何 hunk（前面的 diff --git/index/---/+++ 文件头行）
    if (!current) {
      // 文件头行归为 meta（仅当非空，避免前置空行污染）
      if (raw.trim()) {
        // 累积 meta 到一个隐式 hunk？不——meta 行不属任何 hunk，直接跳过文件头。
        // DiffView 只渲染 hunk 内容，文件路径由 DetailPane header 已展示，无需重复。
      }
      continue
    }

    // hunk 内行分类
    const first = raw[0]
    if (first === '+') {
      current.lines.push({ type: 'add', newNo: newNo++, content: raw.slice(1) })
    } else if (first === '-') {
      current.lines.push({ type: 'del', oldNo: oldNo++, content: raw.slice(1) })
    } else if (first === ' ') {
      current.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, content: raw.slice(1) })
    } else if (raw === '') {
      // 空行：unified diff 中可能是被 trim 尾空格的 context 行，视作 context 推进双计数
      current.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, content: '' })
    } else {
      // 其它（如 '\ No newline at end of file'）：归为 meta 原样保留，不推进计数
      current.lines.push({ type: 'meta', content: raw })
    }
  }

  // 对每个 hunk 计算字符级 diff（配对 del+add 行写回 segments）
  for (const hunk of hunks) {
    computeInlineDiff(hunk)
  }

  return { hunks }
}

/**
 * 字符级 diff：基于 LCS 比较两段文本，产出连续 segment。
 *
 * 算法：标准 LCS DP 表 + 回溯。把 a/b 按 Unicode code point 拆成字符数组，
 * 求 LCS 后回溯出 equal/del/add 三类片段，合并相邻同类为单个 segment。
 *
 * 为何不用单词级（whitespace 分词）：字符级对单字符改动更精确（用户需求是"单字符变更也能高亮"），
 * 且 LCS 实现不因粒度变细而显著变慢（典型 diff 行 < 200 字符）。
 *
 * 性能保护：LCS DP 表是 O(m×n)。minified JS 或打包产物的长行（几千字符）会导致
 * DP 表达百万级 cell，主线程同步计算卡顿。设 MAX_DIFF_CHARS 阈值，超出时退化为
 * 整行级 segment（a 全 del + b 全 add），放弃字符级高亮但不阻塞渲染。
 */
const MAX_DIFF_CHARS = 1000

export function diffCharsLCS(a: string, b: string): DiffSegment[] {
  if (a === b) return [{ text: a, kind: 'normal' }]
  if (!a) return [{ text: b, kind: 'add' }]
  if (!b) return [{ text: a, kind: 'del' }]
  // 长行保护：合计超阈值退化为整行级，避免 O(m×n) DP 表卡顿
  if (a.length + b.length > MAX_DIFF_CHARS) {
    return [
      { text: a, kind: 'del' },
      { text: b, kind: 'add' },
    ]
  }

  const aa = Array.from(a)
  const bb = Array.from(b)
  const m = aa.length
  const n = bb.length

  // DP 表：dp[i][j] = aa[i:] 与 bb[j:] 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aa[i] === bb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // 回溯：i/j 指针推进，匹配 → normal，a 有 b 无 → del，b 有 a 无 → add
  const segments: DiffSegment[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (aa[i] === bb[j]) {
      pushSegment(segments, aa[i], 'normal')
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSegment(segments, aa[i], 'del')
      i++
    } else {
      pushSegment(segments, bb[j], 'add')
      j++
    }
  }
  while (i < m) pushSegment(segments, aa[i++], 'del')
  while (j < n) pushSegment(segments, bb[j++], 'add')

  return segments
}

/** 合并相邻同类 segment，避免碎片化 */
function pushSegment(segments: DiffSegment[], text: string, kind: DiffSegment['kind']): void {
  const last = segments[segments.length - 1]
  if (last && last.kind === kind) last.text += text
  else segments.push({ text, kind })
}

/**
 * 对 hunk 内 del+add 行配对，计算字符级 diff 写回 segments。
 *
 * 配对规则（git diff 标准行为）：扫描连续的 del 块后紧跟 add 块，1:1 逐行配对，
 * 取两者行数的较小值，多余的行不配对（无 segments）。
 *
 * - del 行的 segments：normal + del 片段（显示「删了什么」）
 * - add 行的 segments：normal + add 片段（显示「加了什么」）
 */
export function computeInlineDiff(hunk: DiffHunk): void {
  const lines = hunk.lines
  let i = 0
  while (i < lines.length) {
    // 收集连续 del 块
    const delStart = i
    while (i < lines.length && lines[i].type === 'del') i++
    const delCount = i - delStart
    if (delCount === 0) {
      i++
      continue
    }
    // 收集紧随的 add 块
    const addStart = i
    while (i < lines.length && lines[i].type === 'add') i++
    const addCount = i - addStart
    if (addCount === 0) continue // del 块后无 add 块，纯删除，不配对

    // 1:1 配对，取较小行数
    const pairCount = Math.min(delCount, addCount)
    for (let k = 0; k < pairCount; k++) {
      const delLine = lines[delStart + k]
      const addLine = lines[addStart + k]
      const segments = diffCharsLCS(delLine.content, addLine.content)
      // del 行视角：add 片段不可见，只保留 normal + del
      delLine.segments = segments.filter((s) => s.kind !== 'add')
      // add 行视角：del 片段不可见，只保留 normal + add
      addLine.segments = segments.filter((s) => s.kind !== 'del')
    }
  }
}
