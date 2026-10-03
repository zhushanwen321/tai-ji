// @vitest-environment node

/**
 * file-type 分发扩展单测（chat-html-support §6.4 D4「类型分发扩展」）。
 *
 * 打在纯函数 interface 上：`.html`/`.htm` → 'html'（可预览渲染态，DetailPane 出现
 * 「预览 | 源码」切换、默认预览）；`.xml` 维持 'code'（不纳入渲染态，设计明示）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/logic/__tests__/file-type.test.ts
 */
import { describe, it, expect } from 'vitest'
import { detectFileKind, extToLang } from '@/composables/logic/file-type'

describe('detectFileKind · HTML 渲染态分发', () => {
  it('.html / .htm → html（可预览渲染态，默认预览）', () => {
    expect(detectFileKind('report.html')).toBe('html')
    expect(detectFileKind('index.htm')).toBe('html')
  })

  it('大小写不敏感（.HTML / .HTM）', () => {
    expect(detectFileKind('Report.HTML')).toBe('html')
    expect(detectFileKind('Index.HTM')).toBe('html')
  })

  it('含目录前缀 / 绝对路径均按扩展名判定', () => {
    expect(detectFileKind('docs/report.html')).toBe('html')
    expect(detectFileKind('/Users/demo/.taiji/artifacts/sid/report.html')).toBe('html')
  })

  it('.xml 维持 code（不纳入渲染态——设计 §6.4 明示）', () => {
    expect(detectFileKind('feed.xml')).toBe('code')
  })

  it('既有类别不受扩展影响（回归锚点）', () => {
    expect(detectFileKind('README.md')).toBe('markdown')
    expect(detectFileKind('logo.png')).toBe('image')
    expect(detectFileKind('app.ts')).toBe('code')
    expect(detectFileKind('notes.unknownext')).toBe('text')
  })
})

describe('extToLang · html 源码态仍走 shiki html 语言', () => {
  it('html / htm → html（「源码」态 = 既有 shiki 高亮）', () => {
    expect(extToLang('report.html')).toBe('html')
    expect(extToLang('index.htm')).toBe('html')
  })
})
