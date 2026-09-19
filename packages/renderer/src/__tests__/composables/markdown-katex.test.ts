// @vitest-environment jsdom
// [U1 sanitize] DOMPurify 需要 nodeName getter 在 Node.prototype 上（realm 安全缓存 getter
// 依赖它）；happy-dom 把 nodeName 定义在各元素子类，DOMPurify 3.4.11 在 happy-dom 下把
// 所有元素判为不允许标签（P1 探针实证）——markdown 管线测试族统一跑 jsdom。
/**
 * markdown.ts KaTeX 公式渲染单测（B5 问题 13-①）。
 *
 * 覆盖行内 `$...$`（math_inline）+ 块级 `$$...$$`（math_block）→ katex.renderToString
 * 产出 span.katex / katex-display。mock 策略与 markdown.test.ts 一致：stub shiki，
 * katex 与 markdown-it-katex 用真实实现（纯 JS 渲染，无 WASM）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/markdown-katex.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)
vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(() =>
    Promise.resolve({
      codeToHtml: fakeCodeToHtml,
      getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
    }),
  ),
}))

async function freshRender(content: string): Promise<string> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const { renderMarkdown } = await import('@/composables/logic/markdown')
  return renderMarkdown(content)
}

describe('markdown KaTeX 公式渲染（13-①）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('K1: 行内公式 $E=mc^2$ 渲染出 span.katex', async () => {
    const html = await freshRender('能量公式 $E=mc^2$ 描述质能等价\n')
    expect(html).toContain('class="katex"')
    // 公式内容被 katex 解析（产出 MathML/HTML span），不再是裸 $...$
    expect(html).not.toContain('$E=mc^2$')
  })

  it('K2: 块级公式 $$\\int_0^1 x dx$$ 渲染出 katex-display', async () => {
    const html = await freshRender('定积分:\n\n$$\\int_0^1 x\\,dx$$\n')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('$$')
  })

  it('K3: 段首行内公式（无前导空格）渲染', async () => {
    const html = await freshRender('$a^2 + b^2 = c^2$ 勾股定理\n')
    expect(html).toContain('class="katex"')
  })

  it('K4: 多个行内公式同段都渲染', async () => {
    const html = await freshRender('由 $a$ 和 $b$ 推导 $c$\n')
    // 至少 3 个 katex span（a / b / c）
    const matches = html.match(/class="katex"/g)
    expect(matches?.length).toBeGreaterThanOrEqual(3)
  })

  it('K5: 普通美元符号不误识别为公式（价格 $5 and $6）', async () => {
    const html = await freshRender('价格 $5 和 $6 之间\n')
    // 不产出 katex（被 isValidDelim 的「后跟数字」规则挡掉）
    expect(html).not.toContain('class="katex"')
    expect(html).toContain('$5')
    expect(html).toContain('$6')
  })

  it('K6: 转义 \\$ 不触发公式（字面美元）', async () => {
    const html = await freshRender('花费 \\$100 美元\n')
    expect(html).not.toContain('class="katex"')
  })

  it('K7: 公式 + 代码块混合，互不干扰', async () => {
    const html = await freshRender('公式 $x^2$ 后接代码:\n\n```ts\nconst x=1\n```\n')
    expect(html).toContain('class="katex"')
    expect(html).toContain('class="md-codeblock"')
  })

  it('K8: mermaid 渲染不受 katex 影响（不回归）', async () => {
    const html = await freshRender('```mermaid\ngraph TD;A-->B\n```\n')
    expect(html).toContain('class="md-mermaid"')
    expect(html).toContain('data-source="')
  })

  it('K9: 块级公式 + 普通段落结构正确', async () => {
    const html = await freshRender('前文\n\n$$x = y$$\n\n后文\n')
    expect(html).toContain('katex-display')
    expect(html).toContain('前文')
    expect(html).toContain('后文')
  })
})
