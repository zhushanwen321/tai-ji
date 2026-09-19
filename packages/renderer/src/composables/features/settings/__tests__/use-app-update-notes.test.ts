/**
 * extractLocalizedNotes 单测（release notes 双语解析器，review round1 MF1）。
 *
 * 被测函数是 GitHub Release body 的双语契约前端解析器（AGENTS.md [MANDATORY] 双语
 * release notes）：`<!-- LANG:xx -->` 标记分段 → 按当前 locale 提取 → zh/en 缺失时
 * en 回退 → 首段兜底 → 原文兜底。解析回归 = 用户看到中英混排且现有测试全绿
 * （update-page 族测试只 mock releaseNotesHtml，解析零承接），故逐分支锁定。
 *
 * i18n 用 hoisted 可变量控制 locale（zh-CN / en-US 两档，覆盖 split-'-'[0] 归一）；
 * markdown 渲染链（markdown-it + shiki WASM）与本解析器无关，mock 掉避免重型加载。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/settings/__tests__/use-app-update-notes.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const i18nMock = vi.hoisted(() => ({ locale: 'zh-CN' }))

vi.mock('@/i18n', () => ({
  getLocale: vi.fn(() => i18nMock.locale),
}))

vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: vi.fn(async (md: string) => `<p>${md}</p>`),
}))

import { extractLocalizedNotes } from '../use-app-update-notes'

const BILINGUAL_BODY = '<!-- LANG:en -->\n- Fix bug X\n\n<!-- LANG:zh -->\n- 修复 bug X\n'

describe('extractLocalizedNotes', () => {
  beforeEach(() => {
    i18nMock.locale = 'zh-CN'
  })

  it('带标记：zh locale 提取 zh 段（en 段在标记序中靠前不干扰）', () => {
    expect(extractLocalizedNotes(BILINGUAL_BODY)).toBe('- 修复 bug X')
  })

  it('带标记：en locale 提取 en 段', () => {
    i18nMock.locale = 'en-US'
    expect(extractLocalizedNotes(BILINGUAL_BODY)).toBe('- Fix bug X')
  })

  it('无标记：原文透传（向后兼容旧 release）', () => {
    const plain = '- Fix bug X\n- 修复 bug X\n'
    expect(extractLocalizedNotes(plain)).toBe(plain)
  })

  it('非 LANG 的 HTML 注释不触发解析模式，原文透传', () => {
    const body = '- notes\n<!-- generated-by-ci -->\n- more notes\n'
    expect(extractLocalizedNotes(body)).toBe(body)
  })

  it('目标语言缺失：回退英文段', () => {
    i18nMock.locale = 'zh-CN'
    const body = '<!-- LANG:fr -->Bonjour\n\n<!-- LANG:en -->Hello'
    expect(extractLocalizedNotes(body)).toBe('Hello')
  })

  it('目标语言与英文均缺失：回退第一段', () => {
    i18nMock.locale = 'zh-CN'
    const body = '<!-- LANG:fr -->Bonjour\n\n<!-- LANG:de -->Hallo'
    expect(extractLocalizedNotes(body)).toBe('Bonjour')
  })

  it('标记存在但解析不出任何段落（标记位于末尾无内容）：兜底返回原文', () => {
    i18nMock.locale = 'zh-CN'
    const body = '<!-- LANG:en -->'
    expect(extractLocalizedNotes(body)).toBe(body)
  })

  it('标记值大小写与多余空格归一：LANG:ZH + 尾随空格命中 zh 段', () => {
    const body = '<!-- LANG:ZH  -->中文内容\n\n<!-- LANG:en -->English'
    expect(extractLocalizedNotes(body)).toBe('中文内容')
  })

  it('段内容经 trim（标记后的空白行与首尾空白不进结果）', () => {
    const body = '<!-- LANG:zh -->\n\n  内容  \n\n<!-- LANG:en -->x'
    expect(extractLocalizedNotes(body)).toBe('内容')
  })

  it('首个标记之前的前导内容不归入任何段（标记即分段起点）', () => {
    i18nMock.locale = 'en-US'
    const body = '前言说明（不属任何语言段）\n<!-- LANG:en -->Hello'
    expect(extractLocalizedNotes(body)).toBe('Hello')
  })
})

describe('renderReleaseNotes — 传值矩阵「更新日志」行（设计 markdown-html-sanitize-render D4）', () => {
  beforeEach(() => {
    i18nMock.locale = 'zh-CN'
  })

  it('renderMarkdown 不携带 env（resourceBaseDir 恒 undefined——release notes 无相对资源语义，不回归）', async () => {
    const markdown = await import('@/composables/logic/markdown')
    const { renderReleaseNotes } = await import('../use-app-update-notes')
    renderReleaseNotes(BILINGUAL_BODY)
    // 既有行为回归断言：UpdateButton 渲染面调 renderMarkdown 只传内容不传 env（env 缺省 →
    // 净化 hook 的 resourceBaseDir undefined → 相对 src 不重写、④路 preventDefault 无动作）
    expect(markdown.renderMarkdown).toHaveBeenCalledOnce()
    const [notes, env] = vi.mocked(markdown.renderMarkdown).mock.calls[0] ?? []
    expect(notes).toBe('- 修复 bug X')
    expect(env).toBeUndefined()
  })
})
