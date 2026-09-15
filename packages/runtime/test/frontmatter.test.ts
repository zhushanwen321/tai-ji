/**
 * frontmatter helpers 单测 — 覆盖 extractFrontmatter / extractDescription 注释列出的边界。
 *
 * 被 agent-scanner + skill-scanner + config-service 共用，回归影响面大。
 * 边界来自 frontmatter.ts 顶部注释：无 frontmatter、无闭合 `---`、多行 `>-`/`|`、
 * chomping indicator（`-`/`+`）、单行 `description: > 文本`。
 *
 * 运行：pnpm --filter @taiji/runtime run test -- test/frontmatter.test.ts
 */
import { describe, it, expect } from 'vitest'
import { extractFrontmatter, extractDescription } from '../src/utils/frontmatter.js'

describe('extractFrontmatter', () => {
  it('标准首尾 --- 分割 frontmatter 与正文', () => {
    const content = ['---', 'name: x', '---', 'body line'].join('\n')
    expect(extractFrontmatter(content)).toEqual({
      frontmatter: 'name: x',
      body: 'body line',
      bodyStartLine: 3,
    })
  })

  it('首行非 --- 时整体当正文（无 frontmatter）', () => {
    const content = 'just a title\n# heading'
    const parts = extractFrontmatter(content)
    expect(parts.frontmatter).toBe('')
    expect(parts.body).toBe(content)
    expect(parts.bodyStartLine).toBe(0)
  })

  it('只有开头 --- 无闭合时，首个 --- 之后内容都算 frontmatter（容错；body 退化为全文）', () => {
    const content = ['---', 'name: x', 'description: y'].join('\n')
    const parts = extractFrontmatter(content)
    expect(parts.frontmatter).toBe('name: x\ndescription: y')
    // 无闭合时 frontmatterEnd 保持 0，body = slice(0) = 全文（含开头 ---）
    expect(parts.body).toBe(content)
    expect(parts.bodyStartLine).toBe(0)
  })

  it('frontmatter 含空行（空行被收集进 frontmatter）', () => {
    const content = ['---', 'name: x', '', 'tools: a', '---', 'body'].join('\n')
    const parts = extractFrontmatter(content)
    expect(parts.frontmatter).toBe('name: x\n\ntools: a')
    expect(parts.body).toBe('body')
    expect(parts.bodyStartLine).toBe(5)
  })
})

describe('extractDescription', () => {
  it('单行裸值', () => {
    expect(extractDescription('description: 一个 agent')).toBe('一个 agent')
  })

  it('多行 >- 折叠块：trim 后空格连接', () => {
    const fm = ['description: >-', '  第一行', '  第二行', 'name: x'].join('\n')
    expect(extractDescription(fm)).toBe('第一行 第二行')
  })

  it('多行 |- 字面块：同样 trim 后空格连接（与 > 一致，不保留换行）', () => {
    const fm = ['description: |-', '  literal', '  text'].join('\n')
    expect(extractDescription(fm)).toBe('literal text')
  })

  it('chomping indicator +（保留尾部换行）仍按 trim 空格连接', () => {
    const fm = ['description: >+', '  a', '  b'].join('\n')
    expect(extractDescription(fm)).toBe('a b')
  })

  it('单行 description: > 文本（同行内容）', () => {
    expect(extractDescription('description: > 同行文本')).toBe('同行文本')
  })

  it('无 description 字段返回空串', () => {
    expect(extractDescription('name: x\ntools: a')).toBe('')
  })

  it('块结束后回到顶层键即截断（不吞下一个键值）', () => {
    const fm = ['description: >-', '  block line', 'name: keep-me'].join('\n')
    expect(extractDescription(fm)).toBe('block line')
  })
})
