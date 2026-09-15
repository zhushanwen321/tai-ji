/**
 * markdown.ts base64 编解码行为不变测试（perf：TextEncoder/TextDecoder 单例化 +
 * encodeBase64 逐字节 forEach 改分块 fromCharCode，本文件锁定输出逐字节不变）。
 *
 * 对拍参照 referenceB64：encodeURIComponent 把非 ASCII 转成 %XX（UTF-8 字节的 percent
 * 编码），逐 %XX 还原为单字节字符后 btoa——即经典 btoa(unescape(encodeURIComponent(s)))
 * 的显式解析版（不依赖 Annex B 的 unescape），与 TextEncoder 产出的 UTF-8 字节序列
 * 逐字节等价。另附硬编码期望值双保险。
 *
 * mock 策略与 markdown.test.ts 一致：stub shiki（聚焦 base64 链路），markdown.ts 每用例
 * freshModule（highlighter/markdown-it/codec 单例每用例重建）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/markdown-base64.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// stub shiki：避免真实语法加载，测试聚焦 fence 的 base64 链路（fine-grained 后入口是 shiki/core）
const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)
vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(() =>
    Promise.resolve({
      codeToHtml: fakeCodeToHtml,
      getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
    }),
  ),
}))

/** 每用例拿到干净的 markdown 模块（内部缓存 markdown-it 实例 + highlighter/codec 单例） */
async function freshModule(): Promise<typeof import('@/composables/logic/markdown')> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  return await import('@/composables/logic/markdown')
}

/**
 * 对拍参照：UTF-8 → binary 字符串 → btoa。
 * encodeURIComponent 不转义的字符（A-Za-z0-9-_.!~*'()）charCode 均 < 128，即字节值本身；
 * %XX 三元组还原出对应字节。产出与 TextEncoder().encode(text) 的 UTF-8 字节序列等价。
 */
function referenceB64(text: string): string {
  const escaped = encodeURIComponent(text)
  const parts: string[] = []
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i]
    if (ch === '%') {
      parts.push(String.fromCharCode(parseInt(escaped.slice(i + 1, i + 3), 16)))
      i += 2
    } else {
      parts.push(ch)
    }
  }
  return btoa(parts.join(''))
}

/** 从渲染 HTML 提取 data-code 属性值（fence 规则产出） */
function extractDataCode(html: string): string {
  const m = html.match(/data-code="([^"]*)"/)
  expect(m).not.toBeNull()
  return m![1]
}

/** 分块边界压力文本：总字节远超 2×CHUNK(0x8000)，多字节字符（中文 3B / emoji 4B）大量分布，
 *  分块边界必然落在多字节 UTF-8 序列内部——字节级切分正确性由对拍锁定 */
const LARGE_TEXT =
  'a'.repeat(40000) + '中文注释'.repeat(20000) + '😀🎉'.repeat(5000) + 'const x = 1;\n'.repeat(3000)

describe('encodeBase64 输出逐字节不变（fence data-code 对拍）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('ASCII 代码块：data-code 与参照实现一致', async () => {
    const { renderMarkdown } = await freshModule()
    const code = 'const x = 1;\nconsole.log(x);\n'
    const html = await renderMarkdown('```ts\n' + code + '```\n')
    expect(extractDataCode(html)).toBe(referenceB64(code))
  })

  it('中文 + emoji 多字节：data-code 与参照实现一致（UTF-8 安全）', async () => {
    const { renderMarkdown } = await freshModule()
    const code = 'const s = "你好，世界 🌍"; // 注释\n'
    const html = await renderMarkdown('```ts\n' + code + '```\n')
    expect(extractDataCode(html)).toBe(referenceB64(code))
  })

  it('硬编码期望值：已知输入的 base64 不漂移', async () => {
    const { renderMarkdown, decodeBase64 } = await freshModule()
    // 'hello' → 'aGVsbG8='；'中文' → '5Lit5paH'；'😀' → '8J+YgA=='
    expect(decodeBase64('aGVsbG8=')).toBe('hello')
    expect(decodeBase64('5Lit5paH')).toBe('中文')
    expect(decodeBase64('8J+YgA==')).toBe('😀')
    // fence content 含尾随换行（markdown-it fence 语义，既有 U5b 期望同口径）：'hello\n' → 'aGVsbG8K'
    const html = await renderMarkdown('```\nhello\n```\n')
    expect(extractDataCode(html)).toBe('aGVsbG8K')
  })

  it('空代码块：data-code 为空串（btoa("")），不报错', async () => {
    const { renderMarkdown } = await freshModule()
    const html = await renderMarkdown('```\n```\n')
    expect(extractDataCode(html)).toBe('')
  })

  it('大文本跨多个分块（> 2×0x8000 字节，边界落在多字节序列内）：与参照实现一致', async () => {
    const { renderMarkdown, decodeBase64 } = await freshModule()
    const html = await renderMarkdown('```ts\n' + LARGE_TEXT + '\n```\n')
    const b64 = extractDataCode(html)
    // 分块实现与参照（未分块逐字节）逐字节一致
    expect(b64).toBe(referenceB64(LARGE_TEXT + '\n'))
    // 解码往返无损
    expect(decodeBase64(b64)).toBe(LARGE_TEXT + '\n')
  })

  it('同一模块实例（codec 单例复用）连续多次编码：无状态残留，各次均正确', async () => {
    const { renderMarkdown, decodeBase64 } = await freshModule()
    // fence content 含尾随换行（markdown-it fence 语义）
    const inputs = ['first 你好', 'second 🌍', 'third 中文 + emoji 😀 混合']
    for (const text of inputs) {
      const html = await renderMarkdown('```ts\n' + text + '\n```\n')
      expect(decodeBase64(extractDataCode(html))).toBe(text + '\n')
    }
  })
})

describe('mermaid data-source 编解码往返', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('中文 mermaid 源码：data-source 解码还原原文（encode → 渲染属性 → decode 对称）', async () => {
    const { renderMarkdownSegments } = await freshModule()
    const source = 'graph TD;\nA[开始] --> B{判断 🤔};\n'
    const segs = await renderMarkdownSegments('```mermaid\n' + source + '```\n')
    const mermaidSeg = segs.find((s) => s.type === 'mermaid')
    expect(mermaidSeg).toBeDefined()
    expect(mermaidSeg!.content).toBe(source)
  })
})

describe('decodeBase64（导出函数直测）', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('与 encodeBase64 对称：参照编码后解码还原（空串/ASCII/中文/emoji）', async () => {
    const { decodeBase64 } = await freshModule()
    for (const text of ['', 'plain ascii', '中文', '😀🎉', 'mix 中文 and 😀 and\nnewline\ttab']) {
      expect(decodeBase64(referenceB64(text))).toBe(text)
    }
  })
})
