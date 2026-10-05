// @vitest-environment node

/**
 * file-type 分发回归单测（chat-html-support §6.4 D4，v16 抽屉渲染态退役）。
 *
 * 打在纯函数 interface 上：`.html`/`.htm` 恢复实施前行为 = 'code'（shiki 源码高亮——
 * 预览面收敛到消息流内联容器 HtmlPreviewInline，抽屉不再有渲染态）；`.xml` 维持 'code'。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/logic/__tests__/file-type.test.ts
 */
import { describe, it, expect } from 'vitest'
import { detectFileKind, extToLang } from '@/composables/logic/file-type'

describe('detectFileKind · HTML 恢复 code 类（渲染态退役回归）', () => {
  it('.html / .htm → code（shiki 源码高亮，与实施前行为一致）', () => {
    expect(detectFileKind('report.html')).toBe('code')
    expect(detectFileKind('index.htm')).toBe('code')
  })

  it('大小写不敏感（.HTML / .HTM）', () => {
    expect(detectFileKind('Report.HTML')).toBe('code')
    expect(detectFileKind('Index.HTM')).toBe('code')
  })

  it('含目录前缀 / 绝对路径均按扩展名判定', () => {
    expect(detectFileKind('docs/report.html')).toBe('code')
    expect(detectFileKind('/Users/demo/.taiji/artifacts/sid/report.html')).toBe('code')
  })

  it('.xml 维持 code', () => {
    expect(detectFileKind('feed.xml')).toBe('code')
  })

  it('既有类别不受扩展影响（回归锚点）', () => {
    expect(detectFileKind('README.md')).toBe('markdown')
    expect(detectFileKind('logo.png')).toBe('image')
    expect(detectFileKind('app.ts')).toBe('code')
    expect(detectFileKind('notes.unknownext')).toBe('text')
  })
})

describe('extToLang · html 源码高亮语言', () => {
  it('html / htm → html（抽屉源码态 = 既有 shiki html 高亮）', () => {
    expect(extToLang('report.html')).toBe('html')
    expect(extToLang('index.htm')).toBe('html')
  })
})
