/**
 * check-doc-symbol-drift.mjs 守卫逻辑单测（G5：源码注释内 docs 引用存在性检查面）。
 *
 * 误放行会让「注释引用已删除文档」继续悬空存活（panel-view-derivation 事故形态）；
 * 误报会拦死正常提交——两条都机器锁定：
 *   R1 JS/TS 注释区间提取（字符串/模板/正则字面量内的 docs/ 字样不进检查面）
 *   R2 .vue 注释区间（script 块 parser + 模板 HTML 注释，偏移平移正确）
 *   R3 引用形态提取（Form A docs/ 相对 + Form B 裸 .md 文件名，span 去重）
 *   R4 悬空判定与豁免（历史标注行 / Form B 语境门 / 换行续行碎片 / 豁免表）
 *   R5 合法名字集索引（真实仓库 tracked .md）
 * fixture 全部走 mkdtemp 自建自删；不依赖 staged 产物（同 scripts/__tests__ 既有惯例）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractJsCommentRanges,
  extractVueCommentRanges,
  extractDocRefsInComment,
  checkCommentDocRefs,
  buildDocsMdNameIndex,
} from '../check-doc-symbol-drift.mjs'

// ---------- R1 JS/TS 注释区间提取 ----------

describe('R1 extractJsCommentRanges', () => {
  it('行注释与块注释收集，字符串字面量内的引用字样不进区间', () => {
    const code = [
      "// see docs/gone-a.md for design",
      "const a = 'str docs/gone-b.md';",
      "/* block docs/gone-c.md */",
      "const b = 1;",
    ].join('\n')
    const ranges = extractJsCommentRanges(code)
    const texts = ranges.map(([s, e]) => code.slice(s, e))
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('gone-a')
    expect(texts[1]).toContain('gone-c')
    expect(texts.some((t) => t.includes('gone-b'))).toBe(false)
  })

  it('模板字面量内的引用字样不进区间', () => {
    const code = "const s = `x // docs/gone-d.md y`;\n// real docs/gone-e.md"
    const texts = extractJsCommentRanges(code).map(([s, e]) => code.slice(s, e))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('gone-e')
  })

  it('正则字面量内的 // 不伪注释化（parser 消歧），行尾真注释仍收集', () => {
    const code = "const re = /a\\/\\/b/; // real docs/gone-f.md"
    const texts = extractJsCommentRanges(code).map(([s, e]) => code.slice(s, e))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('gone-f')
  })

  it('JSDoc 跨行块注释整体收集', () => {
    const code = "/**\n * 设计权威源 docs/gone-g.md\n * 第二行\n */\nexport const x = 1"
    const texts = extractJsCommentRanges(code).map(([s, e]) => code.slice(s, e))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('gone-g')
  })
})

// ---------- R2 .vue 注释区间 ----------

describe('R2 extractVueCommentRanges', () => {
  it('script 块注释与模板 HTML 注释均收集，模板纯文本 // 不算', () => {
    const vue = [
      '<template>',
      '  <div class="a">// not comment</div>',
      '  <!-- template docs/gone-h.md -->',
      '</template>',
      '',
      '<script setup lang="ts">',
      '// script docs/gone-i.md',
      'const a = 1',
      '</script>',
    ].join('\n')
    const texts = extractVueCommentRanges(vue).map(([s, e]) => vue.slice(s, e))
    expect(texts).toHaveLength(2)
    expect(texts.some((t) => t.includes('gone-h'))).toBe(true)
    expect(texts.some((t) => t.includes('gone-i'))).toBe(true)
  })
})

// ---------- R3 引用形态提取 ----------

describe('R3 extractDocRefsInComment', () => {
  it('Form A：docs/ 相对引用提取，尾点与尾斜杠收敛', () => {
    const refs = extractDocRefsInComment('设计 docs/architecture/x.md。另见 docs/design/（目录）')
    const paths = refs.filter((r) => r.kind === 'docs-path').map((r) => r.target)
    expect(paths).toContain('docs/architecture/x.md')
    expect(paths).toContain('docs/design')
  })

  it('Form A：URL 中缀不误配（左边界断言）', () => {
    const refs = extractDocRefsInComment('see https://example.com/docs/not-a-ref.md for api')
    expect(refs).toHaveLength(0)
  })

  it('Form A span 内的 .md 后缀不重复报 Form B', () => {
    const refs = extractDocRefsInComment('docs/design/only-once.md here')
    expect(refs.filter((r) => r.kind === 'docs-path')).toHaveLength(1)
    expect(refs.filter((r) => r.kind === 'md-name')).toHaveLength(0)
  })

  it('Form B：裸文件名提取；带路径前缀的非 docs 引用不匹配', () => {
    const refs = extractDocRefsInComment('设计 panel-view.md §3；包内说明见 packages/x/README.md')
    const names = refs.filter((r) => r.kind === 'md-name').map((r) => r.target)
    expect(names).toEqual(['panel-view.md'])
  })
})

// ---------- R4 悬空判定与豁免 ----------

describe('R4 checkCommentDocRefs', () => {
  const tmpRoots = []
  const makeFixture = (rel, content) => {
    const dir = mkdtempSync(join(tmpdir(), 'g5-guard-test-'))
    tmpRoots.push(dir)
    const abs = join(dir, rel.replace(/^.*\//, ''))
    writeFileSync(abs, content)
    return { rel, abs }
  }
  afterEach(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    tmpRoots.length = 0
  })

  it('悬空 docs-path 报违规，行号与引文正确', () => {
    const f = makeFixture('a.ts', [
      "export const a = 1",
      "// 设计 docs/design/ghost-target.md §3.3 D1",
      "export const b = 2",
    ].join('\n'))
    const violations = checkCommentDocRefs([f], new Set())
    expect(violations).toHaveLength(1)
    expect(violations[0].file).toBe(f.rel)
    expect(violations[0].line).toBe(2)
    expect(violations[0].kind).toBe('docs-path')
    expect(violations[0].target).toBe('docs/design/ghost-target.md')
    expect(violations[0].snippet).toContain('§3.3 D1')
  })

  it('现行文档引用（仓库真实存在的 docs/DESIGN.md）绿', () => {
    const f = makeFixture('b.ts', '// 权威 docs/DESIGN.md §11 布局')
    expect(checkCommentDocRefs([f], new Set())).toHaveLength(0)
  })

  it('Form B：名字集命中绿 / miss 红', () => {
    const f = makeFixture('c.ts', '// 设计 named-ref.md §2 与 ghost-name.md §3')
    const violations = checkCommentDocRefs([f], new Set(['named-ref.md']))
    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe('md-name')
    expect(violations[0].target).toBe('ghost-name.md')
  })

  it('历史标注行豁免（同行「已删除，git 可追溯」）', () => {
    const f = makeFixture('d.ts', "// 设计 docs/design/historical-mention.md（已删除，git 可追溯）§3")
    expect(checkCommentDocRefs([f], new Set())).toHaveLength(0)
  })

  it('Form B 语境门：无语境词的运行时产物描述不检查', () => {
    const f = makeFixture('e.ts', "// zip 内置 summary.md（人读首屏：触发状态表）")
    expect(checkCommentDocRefs([f], new Set())).toHaveLength(0)
  })

  it('换行续行碎片不报（前行连字符断字，次行为尾部名）', () => {
    const f = makeFixture('f.ts', [
      " * 设计 subagent-sync-collect-and-",
      " * reaper-sink.md §3.2 D2 决策表）。",
    ].join('\n'))
    expect(checkCommentDocRefs([f], new Set())).toHaveLength(0)
  })

  it('豁免表生效：file::target 精确豁免，*::target 全文件豁免', () => {
    const f1 = makeFixture('g.ts', "// 设计 docs/design/exempt-me.md §1")
    const f2 = makeFixture('h.ts', "// 设计 docs/design/exempt-me.md §1")
    const exempt = new Map([
      [`${f1.rel}::docs/design/exempt-me.md`, '测试理由：文件级豁免'],
      ['*::docs/design/exempt-me.md', '测试理由：全文件豁免'],
    ])
    expect(checkCommentDocRefs([f1], new Set(), exempt)).toHaveLength(0)
    expect(checkCommentDocRefs([f2], new Set(), exempt)).toHaveLength(0)
  })
})

// ---------- R5 合法名字集索引 ----------

describe('R5 buildDocsMdNameIndex', () => {
  it('真实仓库 tracked .md 名字集：根 AGENTS.md 与 docs/DESIGN.md 均在集内', () => {
    const names = buildDocsMdNameIndex()
    expect(names.has('AGENTS.md')).toBe(true)
    expect(names.has('DESIGN.md')).toBe(true)
  })
})
