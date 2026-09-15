/**
 * handoff-formatter 单测（TC1/TC2，wrapWithXmlTag 纯函数）。
 *
 * 覆盖：
 * - 基本包装：输出含 <handoff_document source="..." created="<ISO8601>"> 开头 + doc + 闭合 + action 后缀
 * - filePath undefined 时不出现 file 属性；非空时含 file="..."
 * - created 是有效 ISO8601（new Date(created).getTime() 不为 NaN）
 * - source 含特殊字符（" & < >）时被转义（escapeXmlAttr）
 * - action 后缀文案精确匹配
 *
 * 纯函数无副作用、无依赖，直接断言输出字符串。
 *
 * 运行：cd packages/runtime && npx vitest run test/handoff-formatter.test.ts
 */
import { describe, it, expect } from 'vitest'
import { wrapWithXmlTag } from '../src/services/handoff-formatter.js'

const ACTION_SUFFIX =
  'Immediately execute the next incomplete item in the document. If you encounter a blocker or blocked item, stop and ask me. After completing each step, proceed to the next one.'

describe('wrapWithXmlTag (TC1/TC2 纯函数)', () => {
  it('TC1 基本包装：含 handoff_document 开标签 + doc + 闭合标签 + action 后缀', () => {
    const doc = '# 交接文档\n\n- 任务A\n- 任务B'
    const out = wrapWithXmlTag(doc, 'src')

    // 开标签含 source + created 属性
    expect(out.startsWith('<handoff_document source="src" created="')).toBe(true)
    // doc 原样嵌入（标签行后紧跟 doc）
    expect(out).toContain(`>\n${doc}\n</handoff_document>`)
    // action 后缀在闭合标签之后（空行分隔）
    expect(out.endsWith(`</handoff_document>\n\n${ACTION_SUFFIX}`)).toBe(true)
  })

  it('TC1 filePath undefined 时不出现 file 属性', () => {
    const out = wrapWithXmlTag('doc', 'src')
    // 仅 source + created 两个属性，无 file
    expect(out).toMatch(/^<handoff_document source="src" created="[^"]+">/)
    expect(out).not.toContain(' file=')
  })

  it('TC1 filePath 非空时含 file="..."', () => {
    const out = wrapWithXmlTag('doc', 'src', '/path/to/doc.jsonl')
    // 开标签含 file 属性，位置在 created 之后
    expect(out).toMatch(
      /^<handoff_document source="src" created="[^"]+" file="\/path\/to\/doc\.jsonl">/,
    )
  })

  it('TC2 created 是有效 ISO8601（new Date 解析不为 NaN）', () => {
    const out = wrapWithXmlTag('doc', 'src')
    const match = out.match(/created="([^"]+)"/)
    expect(match).not.toBeNull()
    const created = match![1]
    expect(Number.isNaN(new Date(created).getTime())).toBe(false)
  })

  it('TC2 source 含特殊字符 " & < > 时被转义', () => {
    // escapeXmlAttr：& → &amp; (先)，" → &quot;，< → &lt;，> → &gt;
    const out = wrapWithXmlTag('doc', 'a"b&c<d>e')
    // source 属性整体应为 source="a&quot;b&amp;c&lt;d&gt;e"
    expect(out).toContain('source="a&quot;b&amp;c&lt;d&gt;e"')
    // 原始特殊字符不应在属性值里出现（& 已变成 &amp;，等）
    expect(out).not.toContain('source="a"b&c<d>e"')
  })

  it('TC2 filePath 含特殊字符时也被转义', () => {
    const out = wrapWithXmlTag('doc', 'src', 'pa&th"with<spec>ials')
    expect(out).toContain('file="pa&amp;th&quot;with&lt;spec&gt;ials"')
  })

  it('SUGGESTION 2：source 含换行 \\n \\r 时被转义为 &#10; &#13;（防破坏 xml 属性边界）', () => {
    // session label 含换行时，不转义会让属性值跨行（属性引号边界被切断），且 xml parser
    // 规范化属性 CR/CRLF/LF → LF 致 round-trip 不可逆。
    const out = wrapWithXmlTag('doc', 'multi\nline\rlabel')
    // source 属性应含 &#10;（\n）和 &#13;（\r），原换行不应在属性值里出现
    expect(out).toContain('source="multi&#10;line&#13;label"')
    // 原始换行不应出现在开标签里
    const openTag = out.slice(0, out.indexOf('>'))
    expect(openTag).not.toContain('\n')
    expect(openTag).not.toContain('\r')
  })

  it('SUGGESTION 2：filePath 含换行时也被转义', () => {
    const out = wrapWithXmlTag('doc', 'src', 'path/with\nnewline')
    expect(out).toContain('file="path/with&#10;newline"')
    const openTag = out.slice(0, out.indexOf('>'))
    expect(openTag).not.toContain('\n')
  })

  it('TC2 action 后缀文案精确匹配', () => {
    const out = wrapWithXmlTag('doc', 'src')
    expect(out.endsWith(ACTION_SUFFIX)).toBe(true)
    // 后缀完整文案逐字校验（防止后续改动静默漂移）
    expect(out).toContain(ACTION_SUFFIX)
  })
})
