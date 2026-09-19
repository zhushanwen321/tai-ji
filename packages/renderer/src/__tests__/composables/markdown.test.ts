// @vitest-environment jsdom
// [U1 sanitize] DOMPurify 需要 nodeName getter 在 Node.prototype 上（realm 安全缓存 getter
// 依赖它）；happy-dom 把 nodeName 定义在各元素子类，DOMPurify 3.4.11 在 happy-dom 下把
// 所有元素判为不允许标签（P1 探针实证）——markdown 管线测试族统一跑 jsdom。
/**
 * markdown.ts fence 规则覆盖单测（W3，对话流 markdown 渲染增强）。
 *
 * 覆盖代码块增强（语言标签 + 复制按钮 data-code）+ mermaid 占位。
 * mock 策略：vi.mock('shiki/core') stub createHighlighterCore 返回假 highlighter，
 * codeToHtml 返回固定 `<pre class="shiki">…</pre>`，使测试聚焦 fence 逻辑而非 shiki 真实渲染。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/markdown.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// stub shiki：避免真实语法加载，测试聚焦 fence 包装逻辑（fine-grained 后入口是 shiki/core）
const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)
vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(() =>
    Promise.resolve({
      codeToHtml: fakeCodeToHtml,
      getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
    }),
  ),
}))

// renderMarkdown 内部缓存了 markdown-it 实例（cachedMarkdown）+ highlighter 单例。
// 各用例需独立实例 → 动态 import 后重置模块，或在 beforeEach vi.resetModules + 重新 import。
// 采用 resetModules 方案：每个 it 拿到干净的 markdown 模块。
async function freshRender(content: string): Promise<string> {
  vi.resetModules()
  // 重新 mock（resetModules 会清掉 mock 注册）
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

/** 同 freshRender 但带 env（filePaths/localFiles），用于路径识别测试 */
async function freshRenderWithEnv(
  content: string,
  env?: { filePaths?: Set<string>; localFiles?: Set<string> },
): Promise<string> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const { renderMarkdown } = await import('@/composables/logic/markdown')
  return renderMarkdown(content, env)
}

/** 同 freshRender 但返回 segments（text/mermaid 拆分） */
async function freshRenderSegments(content: string): Promise<{ type: string; content: string }[]> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const { renderMarkdownSegments } = await import('@/composables/logic/markdown')
  return renderMarkdownSegments(content)
}

describe('markdown fence 规则覆盖（W3）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('U4: 普通代码块含语言标签 + 复制按钮 + shiki 高亮', async () => {
    const html = await freshRender('```ts\nconst x=1\n```\n')
    expect(html).toContain('class="md-codeblock"')
    expect(html).toContain('class="md-codeblock__lang"')
    expect(html).toContain('>ts<') // 语言标签文本
    expect(html).toContain('class="md-codeblock__copy"')
    expect(html).toContain('data-code="')
    expect(html).toContain('class="shiki"') // shiki 高亮产出
    expect(fakeCodeToHtml).toHaveBeenCalled()
  })

  it('U5: mermaid 块输出占位容器，不调 shiki', async () => {
    const html = await freshRender('```mermaid\ngraph TD;A-->B\n```\n')
    expect(html).toContain('class="md-mermaid"')
    expect(html).toContain('data-source="')
    expect(html).not.toContain('class="shiki"') // mermaid 不走 shiki
    expect(fakeCodeToHtml).not.toHaveBeenCalled()
  })

  it('U5b: mermaid data-source 是 base64 编码（可解码还原源码）', async () => {
    const html = await freshRender('```mermaid\ngraph TD;A-->B\n```\n')
    const m = html.match(/data-source="([^"]+)"/)
    expect(m).not.toBeNull()
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toBe('graph TD;A-->B\n')
  })

  it('U6: 无语言代码块不报错，标签降级为 text', async () => {
    const html = await freshRender('```\nplain code\n```\n')
    expect(html).toContain('class="md-codeblock__lang"')
    expect(html).toContain('>text<') // 无 lang 降级标签
    expect(html).not.toThrow
  })

  it('U7: 代码含 HTML 注入字符，data-code 为 base64（非原文注入）', async () => {
    const malicious = '"><img onerror=x>'
    const html = await freshRender('```ts\n' + malicious + '\n```\n')
    // data-code 不含原文的危险字符（base64 编码后只有 A-Za-z0-9+/=）
    const m = html.match(/data-code="([^"]+)"/)
    expect(m).not.toBeNull()
    expect(m![1]).not.toContain('<img')
    expect(m![1]).not.toContain('onerror')
    // base64 解码后才是原文
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toContain(malicious)
  })

  it('U8: 普通段落与代码块混合，仅代码块被包容器', async () => {
    const html = await freshRender('正文段落\n\n```ts\ncode\n```\n')
    // 段落正常渲染（<p>），代码块被包 .md-codeblock
    expect(html).toContain('<p>正文段落</p>')
    expect(html).toContain('class="md-codeblock"')
    // 段落文本不被包进 codeblock
    expect(html.indexOf('正文段落')).toBeLessThan(html.indexOf('md-codeblock'))
  })

  it('U9: 含/的文件路径识别为可点击 .md-filepath（需白名单命中）', async () => {
    // [语义变更 2026-07-20] 含/路径识别从「形似即链接」改为「白名单命中才链接」（详见
    // 设计文档已删除，git 可追溯）。
    const html = await freshRenderWithEnv('修改了 src/foo.ts 文件\n', { filePaths: new Set(['src/foo.ts']) })
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('data-path="')
    // 路径文本在链接内
    expect(html).toContain('>src/foo.ts<')
  })

  it('U10: 单独文件名(无/)不识别，避免误伤版本号/小数', async () => {
    const html = await freshRender('版本 v1.0.0 和 foo.ts\n')
    expect(html).not.toContain('md-filepath')
  })

  it('U10b: 纯数字扩展名不识别，挡掉模型名/版本号/小数（扩展名前瞻要求含字母）', async () => {
    // 三个典型误报形态：含 / 但扩展名是纯数字
    const html1 = await freshRender('model zhipu-coding-plan-router/glm-5.2 done\n')
    const html2 = await freshRender('升级 node/18.0 版本\n')
    const html3 = await freshRender('见 pi/3.14 数值\n')
    expect(html1).not.toContain('md-filepath')
    expect(html2).not.toContain('md-filepath')
    expect(html3).not.toContain('md-filepath')
  })

  it('U10c: 数字开头的真实扩展名仍识别（如 .7z，需白名单命中）', async () => {
    const html = await freshRenderWithEnv('下载 arch/a.7z\n', { filePaths: new Set(['arch/a.7z']) })
    expect(html).toContain('md-filepath')
    expect(html).toContain('>arch/a.7z<')
  })

  it('U10d: 裸文件名（.md/.io 等 ccTLD）不识别成 http 链接（linkify fuzzyLink:false）', async () => {
    // linkify-it 把 ccTLD（.md=马其顿、.io=英属印度洋领地）当 TLD，导致裸文件名
    // 被误识别成 http://design.md 链接，点击打开浏览器。fuzzyLink:false 关掉裸域名匹配。
    for (const text of ['更新了 design.md', '见 README.md。', '部署到 foo.io 上', '修改 app.vue']) {
      const html = await freshRender(text + '\n')
      expect(html).not.toContain('href="http://')
      expect(html).not.toContain('href="https://')
    }
  })

  it('U10e: 带 scheme 的 URL 仍识别成链接（fuzzyLink:false 不影响显式 scheme）', async () => {
    for (const url of ['https://example.com', 'http://github.com/x/y', 'https://a.com/path?q=1']) {
      const html = await freshRender(`见 ${url} 链接\n`)
      expect(html).toContain(`href="${url}"`)
    }
  })

  // ── 裸 basename 识别（env.localFiles：项目里真有该文件才识别为本地文件链接）──

  it('U10f: 裸 basename 在 localFiles 里 → 识别为 .md-filepath 链接', async () => {
    const localFiles = new Set(['design.md', 'README.md'])
    const html = await freshRenderWithEnv('更新了 design.md 文档\n', { localFiles })
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('>design.md<')
    // 不生成 http 链接（本地文件优先，不当 URL）
    expect(html).not.toContain('href="http://')
  })

  it('U10g: 裸 basename 不在 localFiles 里 → 维持纯文本（无 env.localFiles 命中）', async () => {
    const localFiles = new Set(['README.md'])
    const html = await freshRenderWithEnv('更新了 design.md 文档\n', { localFiles })
    // design.md 不在集合 → 不识别（纯文本），避免误判
    expect(html).not.toContain('md-filepath')
    expect(html).toContain('design.md') // 纯文本仍渲染
  })

  it('U10h: 无 env（localFiles 未传）→ 降级纯文本（与现状一致，无回归）', async () => {
    // 不传 env（fileSearch 未加载场景）
    vi.resetModules()
    vi.doMock('shiki/core', () => ({
      createHighlighterCore: () => Promise.resolve({ codeToHtml: fakeCodeToHtml, getLoadedLanguages: () => ['typescript'] }),
    }))
    const { renderMarkdown } = await import('@/composables/logic/markdown')
    const html = await renderMarkdown('更新了 design.md 文档\n')
    expect(html).not.toContain('md-filepath')
    expect(html).toContain('design.md')
  })

  it('U10i: 含/路径识别受 filePaths 白名单控制（语义变更：不再形似即链接）', async () => {
    // [语义变更 2026-07-20] 含/路径识别从「不受 localFiles 影响、形似即链接」改为
    // 「必须命中 env.filePaths 白名单」。白名单命中 → 链接；不含 → 纯文本。
    const htmlHit = await freshRenderWithEnv('修改了 src/foo.ts\n', { filePaths: new Set(['src/foo.ts']) })
    expect(htmlHit).toContain('md-filepath')
    expect(htmlHit).toContain('>src/foo.ts<')
    const htmlMiss = await freshRenderWithEnv('修改了 src/foo.ts\n', { filePaths: new Set(['other.ts']) })
    expect(htmlMiss).not.toContain('md-filepath')
  })

  it('U10j: 段首/多 basename 边界场景', async () => {
    const localFiles = new Set(['design.md', 'config.json'])
    // 段首
    let html = await freshRenderWithEnv('design.md 是入口\n', { localFiles })
    expect(html).toContain('>design.md<')
    // 半角括号内
    html = await freshRenderWithEnv('见 (design.md) 文档\n', { localFiles })
    expect(html).toContain('>design.md<')
    // 多 basename 同段
    html = await freshRenderWithEnv('design.md 和 config.json 都改了\n', { localFiles })
    expect(html).toContain('>design.md<')
    expect(html).toContain('>config.json<')
  })

  it('U10k: 反引号内裸 basename 也识别（code_inline renderer 拿 env）', async () => {
    const localFiles = new Set(['design.md'])
    const html = await freshRenderWithEnv('见 `design.md` 文档\n', { localFiles })
    // 反引号内 basename 包成 .md-filepath，外层保留 <code>
    expect(html).toContain('md-filepath')
    expect(html).toContain('<code>')
    expect(html).toContain('>design.md<')
  })

  it('U10l: data-path 存 basename（裸 basename 场景，非完整 path）', async () => {
    // 裸 basename 场景下 data-path 存 basename 本身（base64），由前端反查完整 path
    const localFiles = new Set(['design.md'])
    const html = await freshRenderWithEnv('design.md\n', { localFiles })
    const m = html.match(/data-path="([^"]+)"/)
    expect(m).not.toBeNull()
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)))
    expect(decoded).toBe('design.md')
  })

  it('U11: 文件路径 base64 编码（防 XSS 注入）', async () => {
    // [语义变更] 含/路径需白名单命中（不再形似即链接）
    const html = await freshRenderWithEnv('见 a/b.ts\n', { filePaths: new Set(['a/b.ts']) })
    const m = html.match(/data-path="([^"]+)"/)
    expect(m).not.toBeNull()
    // base64 解码后才是路径
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toBe('a/b.ts')
    // data-path 不含原始路径字符的注入风险（base64 只有 A-Za-z0-9+/=）
    expect(m![1]).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('U12: 反引号内的路径也链接化（code_inline 二次识别，需白名单）', async () => {
    const html = await freshRenderWithEnv('运行 `src/foo.ts` 命令\n', { filePaths: new Set(['src/foo.ts']) })
    // 反引号内路径包成 .md-filepath，外层保留 <code> 等宽样式
    expect(html).toContain('md-filepath')
    expect(html).toContain('<code>')
    expect(html).toContain('>src/foo.ts<')
    // <code> 内含 <a class="md-filepath">
    expect(html).toMatch(/<code><a class="md-filepath"/)
  })

  it('U12b: 反引号内路径 data-path base64 编码（与正文路径一致）', async () => {
    const html = await freshRenderWithEnv('见 `a/b.ts`\n', { filePaths: new Set(['a/b.ts']) })
    const m = html.match(/data-path="([^"]+)"/)
    expect(m).not.toBeNull()
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toBe('a/b.ts')
  })

  it('U12c: 反引号内多路径混合识别', async () => {
    const html = await freshRenderWithEnv('改了 `a/b.ts` 和 `x/y.vue`\n', {
      filePaths: new Set(['a/b.ts', 'x/y.vue']),
    })
    // 两个 code_inline 各含一个 md-filepath 链接
    const matches = html.match(/md-filepath/g)
    expect(matches?.length).toBe(2)
    expect(html).toContain('>a/b.ts<')
    expect(html).toContain('>x/y.vue<')
  })

  it('U12d: 反引号内非路径代码不误识别', async () => {
    const html = await freshRender('调用 `foo.bar.split("/")` 方法\n')
    // 无 / 的片段不识别；含 / 但无源码扩展名的（split）也不识别
    expect(html).not.toContain('md-filepath')
    expect(html).toContain('<code>')
  })

  // ── 绝对路径 / 家目录路径识别（需白名单命中，2026-07-20 重构后语义）──
  // [HISTORICAL] 旧实现（inline rule 抢跑）下，绝对路径需 FILEPATH_RE 前缀 (?:~/|/)?
  // 才能整段识别（否则 markdown-it 逐 pos 遍历时前缀匹配失败）。重构后（core rule + 白名单），
  // 绝对路径必须在 env.filePaths 里完整出现才识别。实际运行时 env.filePaths 只含相对 cwd 路径
  // （FileNode.path 规范），所以绝对路径/家目录路径默认不链接——这是设计取舍（详见 design.md §7）。
  // 这些用例通过显式注入白名单验证「白名单命中即链接」的语义。

  it('U13: 绝对路径在白名单 → 整段识别为链接', async () => {
    const absPath = '/var/folders/3p/d4mx1j_j5s7bn3_03x48kpkw0000gn/T/handoff-portfolio-service-dev.md'
    const html = await freshRenderWithEnv(absPath + '\n', { filePaths: new Set([absPath]) })
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain(`>${absPath}<`)
    const m = html.match(/data-path="([^"]+)"/)
    expect(m).not.toBeNull()
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)))
    expect(decoded).toBe(absPath)
  })

  it('U13b: 句中绝对路径在白名单 → 整段识别（前导空格边界）', async () => {
    const html = await freshRenderWithEnv('文件在 /absolute/path/to/file.ts 这里\n', {
      filePaths: new Set(['/absolute/path/to/file.ts']),
    })
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('>/absolute/path/to/file.ts<')
  })

  it('U13c: 家目录路径（~/...）在白名单 → 整段识别，~ 不截断', async () => {
    const html = await freshRenderWithEnv('编辑 ~/Code/project/src/main.ts 现在\n', {
      filePaths: new Set(['~/Code/project/src/main.ts']),
    })
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('>~/Code/project/src/main.ts<')
  })

  it('U13d: 无扩展名的绝对路径不识别（避免 /usr/bin、/var/log 误报）', async () => {
    for (const text of ['命令在 /usr/bin 下', '日志在 /var/log', '日期 2026/07/08']) {
      const html = await freshRender(text + '\n')
      expect(html).not.toContain('md-filepath')
    }
  })

  it('U13e: 反引号内绝对路径在白名单 → 链接化（code_inline 二次识别覆盖）', async () => {
    const html = await freshRenderWithEnv('见 `/abs/path/config.json`\n', {
      filePaths: new Set(['/abs/path/config.json']),
    })
    expect(html).toContain('md-filepath')
    expect(html).toContain('>/abs/path/config.json<')
  })
})

describe('renderMarkdownSegments（text/mermaid 拆分）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('S1: 纯文本 → 单个 text segment', async () => {
    const segs = await freshRenderSegments('普通段落\n')
    expect(segs.length).toBe(1)
    expect(segs[0].type).toBe('text')
    expect(segs[0].content).toContain('<p>普通段落</p>')
  })

  it('S2: mermaid 块 → text(前) + mermaid + text(后)', async () => {
    const segs = await freshRenderSegments('前文\n\n```mermaid\ngraph TD;A-->B\n```\n\n后文\n')
    // 3 段：前文 text、mermaid、后文 text
    expect(segs.length).toBe(3)
    expect(segs[0].type).toBe('text')
    expect(segs[0].content).toContain('前文')
    expect(segs[1].type).toBe('mermaid')
    expect(segs[1].content).toBe('graph TD;A-->B\n')
    expect(segs[2].type).toBe('text')
    expect(segs[2].content).toContain('后文')
  })

  it('S3: 多个 mermaid 块交替', async () => {
    const md = '```mermaid\ngraph TD;A-->B\n```\n中文字\n```mermaid\nsequenceDiagram\nA>>B\n```\n'
    const segs = await freshRenderSegments(md)
    // mermaid + text + mermaid
    expect(segs.filter((s) => s.type === 'mermaid').length).toBe(2)
    expect(segs.filter((s) => s.type === 'text').length).toBeGreaterThanOrEqual(1)
    expect(segs[0].type).toBe('mermaid')
  })
})

describe('table 滚动 CSS 化（U1：.md-table-wrap wrapper 已删）', () => {
  // [U1 行为变化] html:true + 表格滚动容器 CSS 化：table_open/close override 删除，
  // 裸 <table> 直挂（滚动能力由两宿主 CSS 的 GitHub 全套四条声明提供，设计 §3.5 声明类别）
  it('table 直出无 wrapper（默认 thead/tbody 保留）', async () => {
    const md = ['| 列1 | 列2 | 列3 |', '| --- | --- | --- |', '| a | b | c |'].join('\n')
    const html = await freshRender(md)
    // wrapper 已删：无 .md-table-wrap 产出
    expect(html).not.toContain('md-table-wrap')
    // 裸 <table> 直出（DOM 往返后无多余包裹层）
    expect(html).toMatch(/(^|>)<table>/)
    expect(html).toMatch(/<\/table>/)
    // 默认 render 链保留（thead/tbody/tr/th/td 完整）
    expect(html).toContain('<thead>')
    expect(html).toContain('<tbody>')
    expect(html).toContain('<td>')
  })
})
