/**
 * shiki fine-grained（core + 静态 grammar import）真实初始化回归测试。
 *
 * 背景（release 附件体积优化批三 §3.2.1）：markdown.ts 从 shiki full bundle（模块图含
 * 全量 200+ 语言 → 289 个死语言 chunk 8.1MB）改为 shiki/core + 12 个静态 grammar import
 * + 2 主题 import。本文件用**真实初始化**（不 mock shiki/core）锁定四条行为：
 *
 * 1. SHIKI_LANGS 13 项逐个 codeToHtml 产出非空且含 <span 样式节点（注册面完整）
 * 2. bash/sh/shell/zsh alias 均按 shellscript grammar 高亮——alias 桥接依赖 grammar
 *    自带 aliases（无显式 langAlias 配置），断言 alias 高亮 HTML 与 shellscript 逐字节
 *    一致，防 shiki 升级丢 grammar aliases 的静默回归（r1 审查要求）
 * 3. 未注册语言（如 abap）回落 typescript（现有 fallback 行为不变，不降级纯文本）
 * 4. 双主题输出：defaultColor:false 时颜色走 --shiki-dark/--shiki-light CSS 变量
 *
 * 与 mock 系测试（markdown.test.ts 等）互补：那边锁定 fence 包装逻辑，这边锁定
 * 真实 shiki 注册面与 alias 语义。JS 正则引擎（createJavaScriptRegexEngine）纯 JS
 * 实现，node/vitest 环境可直接真实初始化，无 WASM 依赖。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/markdown-shiki-finegrained.test.ts
 */
import { describe, it, expect } from 'vitest'
import { getHighlighter, highlightCode, renderMarkdown, SHIKI_LANGS } from '@/composables/logic/markdown'

/** 各语言代表性样本（含语法结构，确保产出带样式 token 的 span） */
const SAMPLES: Record<string, string> = {
  typescript: 'const x: number = 1',
  javascript: 'const x = await fetch(url)',
  vue: '<template><div>{{ msg }}</div></template>',
  json: '{"key": "value", "n": 1}',
  bash: 'echo "hello" | grep world',
  shell: 'ls -la /tmp && echo done',
  markdown: '# Title\n\n**bold** text',
  css: '.cls { color: red; }',
  html: '<div class="a">text</div>',
  yaml: 'key: value\nlist:\n  - item',
  python: 'def main():\n    print("hi")',
  go: 'func main() { fmt.Println("hi") }',
  rust: 'fn main() { let x = 1; }',
}

describe('shiki fine-grained 真实初始化（core + 12 静态 grammar）', () => {
  it('SHIKI_LANGS 覆盖 getLoadedLanguages 全部 13 项（bash/shell 以 alias 键在列）', async () => {
    const hl = await getHighlighter()
    const loaded = hl.getLoadedLanguages()
    for (const lang of SHIKI_LANGS) {
      expect(loaded, `SHIKI_LANGS 项 ${lang} 应在 getLoadedLanguages 中`).toContain(lang)
    }
    expect(SHIKI_LANGS).toHaveLength(13)
  })

  it.each(SHIKI_LANGS)('语言 %s 真实高亮产出非空且含 <span 样式节点', async (lang) => {
    const html = await highlightCode(SAMPLES[lang] ?? 'plain text', lang)
    expect(html.length).toBeGreaterThan(0)
    expect(html).toContain('<span')
    // shiki 容器（class 多值：shiki shiki-themes min-dark min-light，取前缀匹配）
    expect(html).toMatch(/<pre class="shiki[ "]/)
  })

  it('bash/sh/shell/zsh 四 alias 均按 shellscript grammar 高亮（HTML 逐字节一致）', async () => {
    const hl = await getHighlighter()
    const sample = 'echo "hello" | grep world'
    const opts = {
      themes: { dark: 'min-dark', light: 'min-light' },
      defaultColor: false,
    } as const
    const shellscriptHtml = hl.codeToHtml(sample, { lang: 'shellscript', ...opts })
    for (const alias of ['bash', 'sh', 'shell', 'zsh']) {
      // alias 不在 alias 表时 codeToHtml 会抛（grammar 未注册）——先断言 alias 已注册
      expect(hl.getLoadedLanguages()).toContain(alias)
      const aliasHtml = hl.codeToHtml(sample, { lang: alias, ...opts })
      expect(aliasHtml, `alias ${alias} 高亮应与 shellscript 逐字节一致（grammar aliases 回归防护）`).toBe(shellscriptHtml)
    }
  })

  it('未注册语言（abap）回落 typescript：输出与显式 typescript 逐字节一致', async () => {
    const hl = await getHighlighter()
    expect(hl.getLoadedLanguages()).not.toContain('abap')
    const code = 'WRITE \'hello\'. " abap 语法，未注册应回落 ts 高亮'
    const fallbackHtml = await highlightCode(code, 'abap')
    const tsHtml = await highlightCode(code, 'typescript')
    expect(fallbackHtml).toBe(tsHtml)
    // 回落产物仍是 shiki 高亮（非纯文本降级）
    expect(fallbackHtml).toContain('<span')
  })

  it('未注册语言的 markdown fence 仍产高亮代码块（不降级纯文本）', async () => {
    const html = await renderMarkdown('```abap\nWRITE \'hi\'.\n```\n')
    expect(html).toContain('class="md-codeblock"')
    expect(html).toContain('>abap<') // 语言标签保留原始 lang 名
    expect(html).toContain('<span') // fallback typescript 高亮在位
  })

  it('双主题输出：颜色走 --shiki-dark/--shiki-light CSS 变量（defaultColor:false）', async () => {
    const html = await highlightCode('const x: number = 1', 'typescript')
    expect(html).toContain('--shiki-dark:')
    expect(html).toContain('--shiki-light:')
    // defaultColor:false：无默认 color（主题切换全靠 CSS 变量，MarkdownRenderer 样式层切换）
    expect(html).not.toMatch(/\scolor:#/)
  })
})
