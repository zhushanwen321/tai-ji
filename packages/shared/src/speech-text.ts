/**
 * 朗读文本清洗（TTS speak 前置，设计 .tmp/tech-design/ai-voice-tts.md D7）。
 *
 * 职责：把 markdown 文本清洗成「可朗读」的纯文本——代码块/表格/链接地址等「读不出来」
 * 的结构在送合成前去掉。调用点：renderer 发 tts.speak 前先行清洗（本地判空判长的依据），
 * runtime 收到后幂等重洗兜底（防御客户端绕过，纯函数跑两遍无副作用）。
 *
 * 规则集（D7 封闭清单）：围栏代码块、行内代码、GFM 表格、图片（保 alt）、
 * 链接（保显示文本去 URL）、HTML 标签（删标记保内容）、标题/列表/引用标记（删标记保内容）、
 * LaTeX 段、emoji、连续空白压缩。
 *
 * 幂等由链式收敛构造：各规则在同一遍内顺序链式执行，前序规则的产出继续交给后续规则清洗，
 * 输出落在全部规则的「无可删模式」不动点上（clean(x) === clean(clean(x))，单测锁定）。
 *
 * 纯函数无 node 依赖，shared barrel 安全。
 */

/** GFM 表格分隔行：`---` / `:---:` 形态的列定义（至少一列，列间 |）。 */
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** 行内是否含表格竖线（表头/数据行判定；与分隔行配对才构成表格，防孤立竖线误删）。 */
function hasTablePipe(line: string): boolean {
  return line.includes('|')
}

/** 围栏开栏标记（``` 或 ~~~，允许行首缩进；返回标记串用于闭栏同字符判定）。 */
function fenceOpener(line: string): string | null {
  const m = line.match(/^[ \t]*(`{3,}|~{3,})/)
  return m ? m[1] : null
}

/** 围栏闭栏行：同字符 ≥ 开栏长度、行内不得有其他内容（GFM 闭栏规则）。 */
function isFenceCloser(line: string, opener: string): boolean {
  const ch = opener[0]
  const re = ch === '`' ? /^[ \t]*`{3,}[ \t]*$/ : /^[ \t]*~{3,}[ \t]*$/
  return re.test(line)
}

/**
 * 阶段一：块级结构清理（逐行状态机）——围栏代码块整块丢弃（含未闭合时删至文末）、
 * GFM 表格块整块丢弃（表头含 | + 下一行是分隔行判定进块，脱离竖线行出块）。
 */
function stripBlockStructures(input: string): string {
  const lines = input.split('\n')
  const kept: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 围栏内：只找闭栏，其余行（含代码内容与开闭栏行）全部丢弃
    if (fence !== null) {
      if (isFenceCloser(line, fence)) fence = null
      continue
    }
    const opener = fenceOpener(line)
    if (opener) {
      fence = opener
      continue
    }
    // GFM 表格：本行含 | 且下一行是分隔行 → 整块丢弃，直到脱离竖线行
    if (hasTablePipe(line) && i + 1 < lines.length && TABLE_DELIMITER_RE.test(lines[i + 1])) {
      i++
      while (i + 1 < lines.length && hasTablePipe(lines[i + 1])) i++
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/** 残留的组合序列控制符：emoji 删除后遗留的变体选择符 / 零宽连接符（不可见噪音）。 */
const EMOJI_JOINER_RE = /[\uFE0F\u200D]/gu

/**
 * 阶段二行内清理规则表（D7 封闭清单的机器形态；顺序即收敛顺序，禁重排）：
 * 1. 行内代码整段删除（代码符号朗读无意义——图片/链接显式「保内容」，行内代码无此标注即整体
 *    去掉；先删防其内容干扰后续链接/图片的方括号匹配）
 * 2. 图片 → alt（`[![alt](img)](link)` 链接包图形态两步归一到 alt：图片先于链接）
 * 3. 链接 → 显示文本（去 URL）
 * 4. HTML 注释整段删；标签删标记保内容
 * 5. LaTeX 段（$$…$$ 含跨行 / \(…\) / \[…\]）整段删除（公式朗读无意义）。行内单 $ 定界
 *    （$x$）刻意不删：单个 $ 在日常文本（金额「$100」）远比行内公式常见，误删货币文本是更
 *    实际的损害；块级公式（主要朗读损害源）已被 $$ 规则覆盖
 * 6. 标题 / 列表 / 引用标记删标记保内容
 * 7. emoji（\p{Extended_Pictographic} 全集）+ 遗留组合序列控制符删除
 */
const INLINE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/`[^`\n]+`/g, ''],
  [/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1'],
  [/!\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1'],
  [/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1'],
  [/\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1'],
  [/<!--[\s\S]*?-->/g, ''],
  [/<\/?[A-Za-z][^>\n]*>/g, ''],
  [/\$\$[\s\S]*?\$\$/g, ''],
  [/\\\([\s\S]*?\\\)/g, ''],
  [/\\\[[\s\S]*?\\\]/g, ''],
  [/^[ \t]{0,3}#{1,6}[ \t]+/gm, ''],
  [/^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/gm, ''],
  [/^[ \t]{0,3}>+[ \t]?/gm, ''],
  [/\p{Extended_Pictographic}/gu, ''],
  [EMOJI_JOINER_RE, ''],
]

/** 阶段二：行内清理（规则表顺序链式执行；前序产出继续交后续规则清洗，幂等由链式收敛构造）。 */
function stripInlinePatterns(input: string): string {
  let s = input
  for (const [pattern, replacement] of INLINE_RULES) {
    s = s.replace(pattern, replacement)
  }
  return s
}

/**
 * 清洗 markdown 文本为可朗读纯文本。幂等：对输出再跑一遍结果不变（单测锁定）。
 *
 * @param input 原始 markdown 文本（assistant 最终消息 content）
 * @returns 清洗后的纯文本；整条无可朗读内容时返回空串（调用方据此报 tts_empty_text）
 */
export function cleanTextForSpeech(input: string): string {
  return stripInlinePatterns(stripBlockStructures(input))
    // 压缩连续空白（含换行/制表/全角空格，JS \s 全集）为单空格并去首尾——朗读语义里
    // 换行即停顿，连续空白无信息量
    .replace(/\s+/g, ' ')
    .trim()
}
