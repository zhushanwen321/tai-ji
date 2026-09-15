/**
 * YAML frontmatter 解析 helpers（D1 收口）。
 *
 * 3 处（config-service.parseAgentMd / agent-scanner.parseAgentMd / skill-scanner.parseSkillMd）
 * 历史上各自重复「按 `---` 分割 frontmatter」的骨架。本模块抽出通用分割逻辑；
 * 各调用方仍负责自己特有的字段提取（name / tools / triggers / argumentHint 不同，不强行合并）。
 *
 * 这里只做「行级分割 + 单字段提取」，不引入完整 YAML 解析器——pi 的 agent/skill
 * frontmatter 是受限子集（键值对 + 多行 `>-`/`|`），完整 YAML 库过重。
 */

/** frontmatter 分割结果：frontmatter 文本 + 正文 + 正文起始行号。 */
export interface FrontmatterParts {
  /** frontmatter 原始文本（不含首尾 `---`）。 */
  frontmatter: string
  /** 正文（`---` 闭合之后的部分）。 */
  body: string
  /** 正文起始行号（0-based，即闭合 `---` 的下一行）。无 frontmatter 时为 0。 */
  bodyStartLine: number
}

/**
 * 按 YAML frontmatter 边界（首尾 `---`）分割 markdown 内容。
 *
 * 行为约定：
 * - 首行（去除空白后）必须是 `---` 才视为有 frontmatter；否则整体当正文。
 * - 第二个 `---`（任意缩进的纯 `---` 行）闭合 frontmatter。
 * - 无闭合 `---` 时，首个 `---` 之后的内容都算 frontmatter（容错，与原实现一致）。
 */
export function extractFrontmatter(content: string): FrontmatterParts {
  const lines = content.split('\n')
  const frontmatterLines: string[] = []
  let inFrontmatter = false
  let frontmatterEnd = 0

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      } else {
        frontmatterEnd = i + 1
        break
      }
    }
    if (inFrontmatter) frontmatterLines.push(lines[i])
  }

  return {
    frontmatter: frontmatterLines.join('\n'),
    body: lines.slice(frontmatterEnd).join('\n'),
    bodyStartLine: frontmatterEnd,
  }
}

/**
 * 从 frontmatter 文本提取 `description` 字段，支持 YAML 多行 `>-`/`|-`/`>|` 折叠/字面块（含 chomping indicator）。
 *
 * - 多行块（`description: >-`）：取后续缩进行，trim 后空格连接。
 * - 单行（`description: 文本` 或 `description: > 文本`）：取 `>-`/`|` 之后的同行内容。
 *
 * 与原 config-service / agent-scanner 的多行解析逻辑一致。
 */
export function extractDescription(fmText: string): string {
  const fmDescMatch = fmText.match(/^description:\s*[>\|][-+]?\s*$/m)
  if (fmDescMatch) {
    // 多行 description（> 或 | 格式，含 chomping indicator -/+）：取后续缩进行
    const startIdx = fmText.indexOf(fmDescMatch[0]) + fmDescMatch[0].length
    const remaining = fmText.slice(startIdx)
    const multilineParts: string[] = []
    for (const line of remaining.split('\n')) {
      // 遇到非缩进行（回到顶层键）即结束块
      if (line && !line.startsWith(' ') && !line.startsWith('\t')) break
      multilineParts.push(line.trim())
    }
    return multilineParts.join(' ').trim()
  }
  // 单行：用 [>\|]? 容忍 `description: > 文本`，并避免 `description: >-` 的 `-` 被当内容
  const singleLine = fmText.match(/^description:\s*[>\|]?(.+?)\s*$/m)?.[1]?.trim()
  return singleLine ?? ''
}
