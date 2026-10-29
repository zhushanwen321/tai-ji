// @vitest-environment jsdom
// [U1 sanitize] DOMPurify 需要 nodeName getter 在 Node.prototype 上（realm 安全缓存 getter
// 依赖它）；happy-dom 把 nodeName 定义在各元素子类，DOMPurify 3.4.11 在 happy-dom 下把
// 所有元素判为不允许标签（P1 探针实证）——markdown 管线测试族统一跑 jsdom。
/**
 * markdown 渲染管线合并产物（round5-g ui idx1）。
 *
 * 来源节（每来源文件包以基名命名的 describe）：
 *   markdown / markdown-base64 / markdown-filepath / markdown-katex /
 *   markdown-sanitize / markdown-renderer-incremental
 *
 * markdown-shiki-finegrained.test.ts 保持独立：其被测对象是真实 shiki 初始化
 * （SHIKI_LANGS 13 项注册清单 + alias 语义，不 mock shiki/core），与本文件的文件级
 * shiki/core mock 结构性不相容（hoist 后真实现节吃 mock，合并即挂）。
 *
 * 统一 mock 策略：vi.mock('shiki/core') stub createHighlighterCore 返回假 highlighter，
 * codeToHtml 返回固定 `<pre class="shiki">…</pre>`（renderer-incremental 节的
 * codeToHtml 调用计数兼作「占位期零高亮」探针）；各节 helper 以 resetModules + doMock
 * 每用例取干净 markdown 模块（cachedMarkdown/highlighter/codec 单例每用例重建）。
 *
 * 运行：cd packages/ui && TAIJI_TEST_DOMAIN=chat npx vitest run src/features/chat/__tests__/markdown.test.ts（本文件登记在 domain-map.json chat 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { MarkdownRenderer, ChatViewDepsKey } from '@taiji/ui'
import type { ChatViewDeps } from '@taiji/ui'
import { createMockDeps as createMockChatDeps } from './helpers'
// PATH_CANDIDATE_RE / BASENAME_CANDIDATE_RE 供 markdown-filepath 节做性能/静态结构断言
// （AC-1/7/9）；renderMarkdown 功能验收走各节 helper 的动态 import。
import { PATH_CANDIDATE_RE, BASENAME_CANDIDATE_RE } from '../markdown'

// stub shiki（产品级单份）：避免真实语法加载，测试聚焦各节管线逻辑
const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)
vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(() =>
    Promise.resolve({
      codeToHtml: fakeCodeToHtml,
      getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
    }),
  ),
}))

describe('markdown', () => {
// ── 来源：markdown.test.ts ──
/**
 * markdown.ts fence 规则覆盖单测（W3，对话流 markdown 渲染增强）。
 *
 * 覆盖代码块增强（语言标签 + 复制按钮 data-code）+ mermaid 占位。
 * mock 策略：vi.mock('shiki/core') stub createHighlighterCore 返回假 highlighter，
 * codeToHtml 返回固定 `<pre class="shiki">…</pre>`，使测试聚焦 fence 逻辑而非 shiki 真实渲染。
 *
 * [D10 渲染链下沉] 自 renderer src/__tests__/composables/markdown.test.ts 随渲染链迁入 ui
 * （import 改相对路径）；新增 copyLabel 注入族：宿主壳文案注入渲染产物等价断言。
 *
 * 运行：cd packages/ui && TAIJI_TEST_DOMAIN=chat npx vitest run src/features/chat/__tests__/markdown.test.ts（本文件登记在 domain-map.json chat 域，默认档被排除）
 */
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
  const { renderMarkdown } = await import('../markdown')
  return renderMarkdown(content)
}

/** 同 freshRender 但带 env（filePaths/localFiles/copyLabel），用于路径识别 / 文案注入测试 */
async function freshRenderWithEnv(
  content: string,
  env?: { filePaths?: Set<string>; localFiles?: Set<string>; copyLabel?: string },
): Promise<string> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const { renderMarkdown } = await import('../markdown')
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
  const { renderMarkdownSegments } = await import('../markdown')
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
    const { renderMarkdown } = await import('../markdown')
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

// ── copyLabel 注入（D10 i18n 解耦：宿主壳文案注入渲染产物等价断言）──
// 渲染模块不 import 壳层 i18n 单例；桌面壳 useChatViewDeps 传 t('composable.copyLabel')
// （zh-CN = '复制'）。本组用桌面同值注入，锁定渲染产物与迁移前逐字节等价。

describe('copyLabel 注入（宿主壳 i18n 文案注入）', () => {
  beforeEach(() => {
    fakeCodeToHtml.mockClear()
    vi.resetModules()
  })

  it('C1: 桌面 zh 文案注入（t(\'composable.copyLabel\') = 复制）→ title 属性逐字等价', async () => {
    // 桌面文案等价检查：renderer i18n zh-CN/composable.ts copyLabel = '复制'
    const html = await freshRenderWithEnv('```ts\nconst x=1\n```\n', { copyLabel: '复制' })
    expect(html).toContain('class="md-codeblock__copy"')
    expect(html).toContain('title="复制"')
  })

  it('C2: 桌面 en 文案注入（en-US copyLabel = Copy）→ title 等价', async () => {
    const html = await freshRenderWithEnv('```ts\nconst x=1\n```\n', { copyLabel: 'Copy' })
    expect(html).toContain('title="Copy"')
  })

  it('C3: 未注入 copyLabel → 省略 title 属性（渲染模块不养文案副本）', async () => {
    const html = await freshRender('```ts\nconst x=1\n```\n')
    expect(html).toContain('class="md-codeblock__copy"')
    expect(html).not.toContain('title=')
  })

  it('C4: 注入文案含 HTML 特殊字符 → escapeHtml 转义（title 属性 XSS 防线）', async () => {
    const html = await freshRenderWithEnv('```ts\nconst x=1\n```\n', { copyLabel: '"><script>x</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
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
})

describe('markdown-base64', () => {
// ── 来源：markdown-base64.test.ts ──
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
 * [D10 渲染链下沉] 自 renderer 随渲染链迁入 ui（import 改相对路径）。
 * 运行：cd packages/ui && TAIJI_TEST_DOMAIN=chat npx vitest run src/features/chat/__tests__/markdown.test.ts（本文件登记在 domain-map.json chat 域，默认档被排除）
 */
// stub shiki：避免真实语法加载，测试聚焦 fence 的 base64 链路（fine-grained 后入口是 shiki/core）
// （stub shiki 由产品级单份 const fakeCodeToHtml + vi.mock 提供，见文件头）

/** 每用例拿到干净的 markdown 模块（内部缓存 markdown-it 实例 + highlighter/codec 单例） */
async function freshModule(): Promise<typeof import('../markdown')> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  return await import('../markdown')
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

/** 分块边界压力文本：总字节 ≈175KB（多倍于 2×CHUNK(0x8000)），多字节字符（中文 3B /
 *  emoji 4B）大量分布，分块边界必然落在多字节 UTF-8 序列内部——字节级切分正确性由对拍
 *  锁定。数据量取「跨多分块 + 边界落多字节」的最小充分规模（逻辑等价缩量，判据见
 *  docs/TEST-STRATEGY.md「新写测试判据」节），不追求量。 */
const LARGE_TEXT =
  'a'.repeat(20000) + '中文注释'.repeat(10000) + '😀🎉'.repeat(2500) + 'const x = 1;\n'.repeat(1500)

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
})

describe('markdown-filepath', () => {
// ── 来源：markdown-filepath.test.ts ──
/**
 * markdown 路径识别测试（2026-07-20 core rule 架构重构后）。
 *
 * 架构变更：旧 filepathRule（inline rulechain，text 之前抢跑）→ 新 filepathCoreRule
 * （core rulechain，replacements 之后）。详见其设计文档（docs/page-design/markdown-filepath-redesign/design.md，已删除，git 可追溯）。
 *
 * 语义变更：含/路径识别从「无白名单、形似即链接」改为「白名单命中才链接」（与裸 basename 对称）。
 * 误识别防御从「正则前瞻/后顾 hack」改为「数据白名单」。pi/3.14/glm-5.2/necessity-sufficiency
 * 全部因不在白名单被否决，正则极简。
 *
 * 覆盖范围（功能断言去重后收缩：原 AC-3/4/5/8/11 与 markdown.test.ts 的
 * U9/U10/U12/U13 系列同语义两套表述，已删——那边是白名单语义主战场）：
 *  - AC-1:  PATH_CANDIDATE_RE 性能（病态输入不卡死，ReDoS 回归防护）
 *  - AC-7:  BASENAME_CANDIDATE_RE 性能（同构病态，同测）
 *  - AC-9:  静态结构断言（正则源码无嵌套量词，零抖动兜底）
 *  - AC-6:  取消空格路径支持（带空格路径 My Document.md 不再识别为整条；无他处覆盖）
 *  - AC-10: emphasis 不被路径识别破坏（P0 回归——重构核心动机，含原始 bug 场景）
 *  - AC-2:  真实渲染不卡顿
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect）。禁止 node:test。
 * [D10 渲染链下沉] 自 renderer 随渲染链迁入 ui（import 改相对路径）。
 * 运行：cd packages/ui && TAIJI_TEST_DOMAIN=chat npx vitest run src/features/chat/__tests__/markdown.test.ts（本文件登记在 domain-map.json chat 域，默认档被排除）
 */
// stub shiki：避免真实语法加载，测试聚焦路径识别逻辑（fine-grained 后入口是 shiki/core）
// （stub shiki 由产品级单份 const fakeCodeToHtml + vi.mock 提供，见文件头）

/** 同 freshRender 但重置模块拿到干净 markdown-it 实例 */
async function freshRender(content: string, env?: { filePaths?: Set<string>; localFiles?: Set<string> }): Promise<string> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const { renderMarkdown } = await import('../markdown')
  return renderMarkdown(content, env)
}

beforeEach(() => {
  fakeCodeToHtml.mockClear()
  vi.resetModules()
})

// ── AC-1 / AC-7：性能断言（ReDoS 回归防护）──────────────────────────────

describe('AC-1 PATH_CANDIDATE_RE 性能（无灾难性回溯）', () => {
  it('40 字符纯 word 序列 100 次总耗时 < 50ms', () => {
    const input = 'x'.repeat(40)
    PATH_CANDIDATE_RE.lastIndex = 0
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) {
      PATH_CANDIDATE_RE.lastIndex = 0
      // eslint-disable-next-line no-empty -- ReDoS 性能测试专用 drain 空循环，循环体必须为空
      while (PATH_CANDIDATE_RE.exec(input) !== null) { /* drain */ }
    }
    const elapsed = performance.now() - t0
    // 50ms 阈值：线性结构 100 次应在个位数 ms，留 5x+ 余量对冲 CI 抖动。
    expect(elapsed).toBeLessThan(50)
  })

  it('200 字符混合长输入（无 / 路径）单次 < 10ms', () => {
    const input = 'see foobarbazqux and someLongIdentifierName plus mixedABC123def ' + 'x'.repeat(130)
    PATH_CANDIDATE_RE.lastIndex = 0
    const t0 = performance.now()
    // eslint-disable-next-line no-empty -- ReDoS 性能测试专用 drain 空循环，循环体必须为空
    while (PATH_CANDIDATE_RE.exec(input) !== null) { /* drain */ }
    expect(performance.now() - t0).toBeLessThan(10)
  })
})

describe('AC-7 BASENAME_CANDIDATE_RE 性能（同构病态，同测）', () => {
  it('40 字符纯 word 序列 100 次总耗时 < 50ms', () => {
    const input = 'x'.repeat(40)
    BASENAME_CANDIDATE_RE.lastIndex = 0
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) {
      BASENAME_CANDIDATE_RE.lastIndex = 0
      // eslint-disable-next-line no-empty -- ReDoS 性能测试专用 drain 空循环，循环体必须为空
      while (BASENAME_CANDIDATE_RE.exec(input) !== null) { /* drain */ }
    }
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

// ── AC-9：静态结构断言（零抖动兜底）──────────────────────────────────────

describe('AC-9 静态结构断言（正则无嵌套量词）', () => {
  // 嵌套量词模式：一个量词（+ 或 *）紧跟在另一个带量词的组之后，
  // 如 )+)+、)*)+、)+)* —— 这是 O(2^n) 回溯的结构根因。
  const NESTED_QUANTIFIER_RE = /\)[+*][^?]*\)[+*]/

  it('PATH_CANDIDATE_RE 源码不含嵌套量词', () => {
    expect(NESTED_QUANTIFIER_RE.test(PATH_CANDIDATE_RE.source)).toBe(false)
  })

  it('BASENAME_CANDIDATE_RE 源码不含嵌套量词', () => {
    expect(NESTED_QUANTIFIER_RE.test(BASENAME_CANDIDATE_RE.source)).toBe(false)
  })
})

// ── AC-3 / AC-4：含/路径识别（注入 env.filePaths 白名单）──────────────────

describe('AC-6 取消空格路径支持', () => {
  it('docs/My Document.md 不再识别为整条路径', async () => {
    const html = await freshRender('see docs/My Document.md here', {
      filePaths: new Set(['docs/My Document.md', 'docs/My']),
    })
    // 整条「My Document.md」不应作为一个 md-filepath 链接出现（路径空格切断）
    expect(html).not.toContain('docs/My Document.md</a>')
  })
})

// ── AC-10：emphasis 不被路径识别破坏（P0 回归——重构核心动机）──────────────

describe('AC-10 emphasis 不被路径识别破坏（P0 回归）', () => {
  it('**bold** + 白名单路径 + 非白名单词组同段 → bold 正确渲染、路径链接、词组纯文本', async () => {
    const html = await freshRender(
      '**bold** and src/foo.ts and necessity/sufficiency/tradeoffs',
      { filePaths: new Set(['src/foo.ts']) },
    )
    // emphasis 正确配对（无字面 ** 残留）
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toMatch(/\*\*bold/)
    // 真实路径链接化
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('>src/foo.ts<')
    // 非白名单词组不链接（纯文本，无 a 标签包裹）
    expect(html).not.toContain('>necessity/sufficiency/tradeoffs</a>')
    expect(html).toContain('necessity/sufficiency/tradeoffs')
  })

  it('原始 P0 bug 场景：**折中** 在含 necessity/sufficiency 词组的段中正确加粗', async () => {
    // 这个输入是用户实际遇到的 bug 触发场景：同段 emphasis 全部失效
    const html = await freshRender(
      '**每层同一套**（necessity/sufficiency/tradeoffs/risks 四个维度）：实现简单。- **折中**：核心字段',
      { filePaths: new Set() },
    )
    // 三个加粗都应正确渲染（整段 emphasis 不被破坏）
    expect(html).toContain('<strong>每层同一套</strong>')
    expect(html).toContain('<strong>折中</strong>')
    // 无字面 ** 残留（emphasis 全部配对成功）
    expect(html).not.toMatch(/\*\*/)
  })

  it('emphasis 内部含路径不破坏 emphasis（白名单命中也不拆 emphasis 内部 text）', async () => {
    // **src/foo.ts** 这种写法：路径在 emphasis 内部，core rule 遍历到该 text token 时
    // 它的父级是 strong_open/close——core rule 不区分父级，会拆 text，但 emphasis 已配对，
    // 拆内部 text 不影响 strong 开闭。结果：路径链接在 <strong> 内部。
    const html = await freshRender('see **src/foo.ts** now', { filePaths: new Set(['src/foo.ts']) })
    // emphasis 仍正确
    expect(html).toContain('<strong>')
    expect(html).toContain('</strong>')
    // 路径仍链接（在 strong 内部）
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('>src/foo.ts<')
  })

  it('链接内部不嵌套路径链接（避免 <a> 嵌套 <a> 非法 HTML）', async () => {
    // 已有 markdown link [text](url) 内部若出现路径候选，不应被二次链接化
    const html = await freshRender('see [src/foo.ts inside](https://example.com)', {
      filePaths: new Set(['src/foo.ts']),
    })
    // link 内部文本不应被包成 md-filepath（inLink 标志跳过）
    expect(html).not.toContain('class="md-filepath"')
  })
})

// ── AC-11：白名单外路径不链接 ──────────────────────────────────────────────

describe('AC-2 真实渲染不卡顿', () => {
  it('750+ chars 中英混排+反引号+表格行 单次 render < 200ms 且不抛错', async () => {
    const triggerBlock = [
      '这是一段混排文本，包含长英文单词如 configurationmanagementstrategies 和 backwardcompatibilityguarantees，',
      '以及反引号路径 `packages/ui/src/features/chat/markdown.ts` 和 `~/Code/project/foo.ts`。',
      '还有表格行：',
      '| 字段 | 类型 | 说明 |',
      '|------|------|------|',
      '| PATH_CANDIDATE_RE | RegExp | 路径候选正则，线性无回溯 |',
      '更多连续字符序列：' + 'x'.repeat(60) + ' end.',
    ].join('\n')
    expect(triggerBlock.length).toBeGreaterThan(200)

    const t0 = performance.now()
    let html: string
    try {
      html = await freshRender(triggerBlock, {
        filePaths: new Set([
          'packages/ui/src/features/chat/markdown.ts',
        ]),
      })
    } catch (e) {
      expect.fail(`renderMarkdown threw: ${(e as Error).message}`)
    }
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(200)
    expect(html.length).toBeGreaterThan(0)
  })
})
})

describe('markdown-katex', () => {
// ── 来源：markdown-katex.test.ts ──
/**
 * markdown.ts KaTeX 公式渲染单测（B5 问题 13-①）。
 *
 * 覆盖行内 `$...$`（math_inline）+ 块级 `$$...$$`（math_block）→ katex.renderToString
 * 产出 span.katex / katex-display。mock 策略与 markdown.test.ts 一致：stub shiki，
 * katex 与 markdown-it-katex 用真实实现（纯 JS 渲染，无 WASM）。
 *
 * [D10 渲染链下沉] katex CSS（katex/dist/katex.min.css）已随渲染模块下沉（模块内 import，
 * 双壳构造性获得，renderer main.ts 全局引入行已移除）。K10 静态检查锁定该引入不被误删——
 * CSS import 在 vitest 中是空模块（不报错但也不生效），一旦被删，双壳公式节点将裸排破相
 * 且无运行时断言可抓（S2/S7 流程不含公式消息），故用源码结构断言兜底。
 *
 * 运行：cd packages/ui && TAIJI_TEST_DOMAIN=chat npx vitest run src/features/chat/__tests__/markdown.test.ts（本文件登记在 domain-map.json chat 域，默认档被排除）
 */
async function freshRender(content: string): Promise<string> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const { renderMarkdown } = await import('../markdown')
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

  it('K10: katex CSS 随渲染模块下沉（模块内 import，源码结构检查）', async () => {
    // CSS import 在 vitest 中是空模块，运行时断言抓不到「CSS 被删」——用源码结构断言
    // 锁定 `import 'katex/dist/katex.min.css'` 留在渲染模块内（AC-9 静态结构断言先例）。
    const source = readFileSync(resolve(__dirname, '../markdown.ts'), 'utf-8')
    expect(source).toContain("import 'katex/dist/katex.min.css'")
  })
})
})

describe('markdown-sanitize', () => {
// ── 来源：markdown-sanitize.test.ts ──
/**
 * markdown-sanitize.ts 净化层单测族（U1，设计 markdown-html-sanitize-render D1-D4）。
 *
 * 覆盖：攻击面矩阵（A2 单测化）/ 哨兵连带销毁回归（D3 接缝节四形态，钉设计白名单
 * 配置跑——template 在 DOMPurify 默认配置下行为相反）/ store 含哨兵形态不误降级（nonce
 * 锚定）/ URI 行为（默认 ALLOWED_URI_REGEXP，D1 R8/R9）/ a 补齐三态（R10 覆盖条件）/
 * 可信契约逐字节保留（P3）/ 混合串 / th/td 列对齐转写 / HTML 块基础 / 切段整串全等基础。
 *
 * mock 策略与 markdown.test.ts 相同：vi.doMock('shiki/core') stub 高亮器，fake 输出
 * 确定性字符串供逐字节断言；KaTeX 用真实实装（契约测试在测试内直接调 katex.renderToString
 * 计算期望串，与管线同参数 → 逐字节对比非自证）。
 */
// stub shiki（freshRender 每次重注册；顶层 vi.mock 供本文件默认 import 链路）
// （stub shiki 由产品级单份 const fakeCodeToHtml + vi.mock 提供，见文件头）

/** fresh 渲染：resetModules 后重 mock shiki，拿干净的 markdown 模块（cachedMarkdown 独立） */
async function freshRender(
  content: string,
  env?: { filePaths?: Set<string>; localFiles?: Set<string>; resourceBaseDir?: string },
): Promise<string> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const { renderMarkdown } = await import('../markdown')
  return renderMarkdown(content, env)
}

/** 与 freshRender 同批的 markdown + markdown-incremental 双模块（切段/整串全等用） */
async function freshModules(): Promise<{
  markdown: typeof import('../markdown')
  incremental: typeof import('../markdown-incremental')
}> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  return {
    markdown: await import('../markdown'),
    incremental: await import('../markdown-incremental'),
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

beforeEach(() => {
  fakeCodeToHtml.mockClear()
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('P1 探针：DOMPurify 在测试环境的可用性', () => {
  it('jsdom 下 isSupported 且基础 sanitize 正确', () => {
    // P1（设计待验证检查点）：happy-dom 下 DOMPurify 把全部元素判为不允许（nodeName
    // getter 不在 Node.prototype），本族已钉 jsdom——本用例固化该环境前提，环境回退
    // （误改回 happy-dom）时此处先红
    expect(DOMPurify.isSupported).toBe(true)
    expect(DOMPurify.sanitize('<b>x</b>')).toBe('<b>x</b>')
    expect(DOMPurify.sanitize('<script>a()</script><p>y</p>')).toBe('<p>y</p>')
  })
})

describe('攻击面矩阵（A2 单测化：两级白名单 + 交互借用剥除）', () => {
  it.each([
    {
      name: 'script 块整删（含内容）',
      input: '<script>alert(1)</script>\n',
      assert: (html: string) => {
        expect(html).not.toContain('<script')
        expect(html).not.toContain('alert(1)')
      },
    },
    {
      name: 'img onerror 事件属性剥除（src 相对路径存活）',
      input: '<img src=x onerror=alert(1)>\n',
      assert: (html: string) => {
        expect(html).toContain('<img src="x"')
        expect(html).not.toContain('onerror')
      },
    },
    {
      name: 'javascript: href 剥除',
      input: '<a href="javascript:alert(1)">x</a>\n',
      assert: (html: string) => {
        expect(html).not.toContain('javascript:')
        expect(html).toContain('<a') // 链接元素保留（属性级剥离，非整段拒绝）
        expect(html).toContain('x')
      },
    },
    {
      name: 'svg onload 整删（svg 不在标签白名单且属连删集）',
      input: '<svg onload=alert(1)></svg>\n',
      assert: (html: string) => {
        expect(html).not.toContain('<svg')
        expect(html).not.toContain('onload')
      },
    },
    {
      name: 'div style 剥除（定位覆盖无弹药）',
      input: '<div style="position:fixed;top:0;left:0;width:100%;height:100%">覆盖</div>\n',
      assert: (html: string) => {
        expect(html).toContain('<div>覆盖</div>')
        expect(html).not.toContain('style=')
      },
    },
    {
      name: '伪造 md-filepath（class/data-path 全剥，交互借用不命中）',
      input: '<span class="md-filepath" data-path="L2V0Yy9wYXNzd2Q=">伪造文件链接</span>\n',
      assert: (html: string) => {
        expect(html).toContain('伪造文件链接')
        expect(html).not.toContain('class=')
        expect(html).not.toContain('data-path')
        expect(html).not.toContain('md-filepath')
      },
    },
    {
      name: '伪造复制按钮（button 不在白名单整剥，文本按 KEEP_CONTENT 保留）',
      input: '<button class="md-codeblock__copy" data-code="WFhY">复制</button>\n',
      assert: (html: string) => {
        expect(html).not.toContain('<button')
        expect(html).not.toContain('md-codeblock__copy')
        expect(html).toContain('复制')
      },
    },
  ])('$name', async ({ input, assert }) => {
    const html = await freshRender(input)
    assert(html)
  })

  it('任一 on* 事件属性全族剥除（表驱动枚举）', async () => {
    const events = ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onanimationstart']
    for (const ev of events) {
      const html = await freshRender(`<div ${ev}="alert(1)">t</div>\n`)
      expect(html).not.toContain(ev)
      expect(html).toContain('<div>t</div>')
    }
  })
})

describe('哨兵连带销毁回归（D3 接缝节四形态，钉设计白名单配置）', () => {
  // 触发机制：xmp/template/noscript 均不在 markdown-it html_block 标签名单 → 走
  // paragraph + html_inline 产生 math token（哨兵在 <p> 包裹内）；三者均在 DOMPurify
  // 硬编码连删集 FORBID_CONTENTS 内——剥标签连内容删，哨兵销毁 → 回填完整性断言失败
  // → 降级纯文本（出声优于静默丢公式）。inline script 形态：math token 产生于 script
  // 开闭 html_inline 之间，script 连删同理。
  // ※ 必须钉设计白名单配置（经 renderMarkdown 全链路）跑：template 在 DOMPurify 默认
  //   配置（不限 ALLOWED_TAGS）下白名单内原样保留，行为相反——脱离设计配置的直测假阴性。
  it.each([
    { name: '独立行 <xmp>$x$</xmp>', input: '<xmp>$x$</xmp>\n' },
    { name: '独立行 <template>$x$</template>', input: '<template>$x$</template>\n' },
    { name: '独立行 <noscript>$x$</noscript>', input: '<noscript>$x$</noscript>\n' },
    { name: 'inline foo <script>$x$</script> bar', input: 'foo <script>$x$</script> bar\n' },
  ])('$name → 降级纯文本 + console.error 出声（公式不静默丢失）', async ({ input }) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const html = await freshRender(input)
    expect(html).toBe(escapeHtml(input).trimEnd()) // 转义全文（原文可读，公式源码可见）
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0]?.[0]).toContain('[markdown] sanitize failed')
  })

  it('反例 <marquee>：不在连删集，KEEP_CONTENT 剥标签留内容 → 哨兵存活正常回填', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const html = await freshRender('<marquee>$x$</marquee>\n')
    expect(html).toContain('class="katex"') // 公式正常渲染（非降级）
    expect(html).not.toContain('marquee')
    expect(errSpy).not.toHaveBeenCalled()
  })
})

describe('store 内容含哨兵形态文本（nonce 锚定，不误触发降级）', () => {
  it('代码块内容恰为哨兵「形态」字符串 → 正常回填不降级', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const html = await freshRender('```\nTJMDzzzzzz-0END\n```\n')
    // 未降级：可信容器完整回填
    expect(html).toContain('class="md-codeblock"')
    // 代码文本逐字保留（残留扫描锚定本次随机 nonce，不匹配历史/伪形态字符串）
    expect(html).toContain('TJMDzzzzzz-0END')
    expect(errSpy).not.toHaveBeenCalled()
  })
})

describe('URI 行为（默认 ALLOWED_URI_REGEXP，D1 R8/R9）', () => {
  it.each([
    { name: '大小写混淆', href: 'JaVaScRiPt:alert(1)' },
    { name: 'tab 分隔', href: 'jav\tascript:alert(1)' },
    { name: '换行分隔', href: 'jav\nascript:alert(1)' },
    { name: '前导空格', href: ' javascript:alert(1)' },
    { name: '控制符插入', href: 'jav\x01ascript:alert(1)' },
    { name: '实体十进制', href: '&#106;avascript:alert(1)' },
    { name: '实体十六进制', href: '&#x6A;avascript:alert(1)' },
    { name: 'vbscript', href: 'vbscript:msgbox(1)' },
  ])('javascript:/vbscript: 混淆形态「$name」剥除', async ({ href }) => {
    const html = await freshRender(`<a href="${href}">x</a>\n`)
    // 统一断言：剥控制字符 + /i + 实体解码三道前置规范化后，任何变形都识别为危险协议
    expect(html).not.toMatch(/avascript:alert/i)
    expect(html).not.toContain('vbscript:')
    expect(html).toContain('x')
  })

  it('相对 src 存活（markdown 语法与原生 HTML 两通道——U3 hook 消费的前提）', async () => {
    const md1 = await freshRender('![](docs/foo.png)\n')
    expect(md1).toContain('<img src="docs/foo.png"')
    const md2 = await freshRender('<img src="docs/foo.png" width="96">\n')
    expect(md2).toContain('<img src="docs/foo.png"')
    expect(md2).toContain('width="96"')
  })

  it('percent 编码 %6Aavascript: 存活（按相对 URL 走，不断言剥除——R9 边界）', async () => {
    const html = await freshRender('<a href="%6Aavascript:alert(1)">x</a>\n')
    expect(html).toContain('%6Aavascript:alert(1)')
  })

  it('tel: 存活（默认正则协议范围，非剥除）', async () => {
    const html = await freshRender('<a href="tel:+8613800000000">tel</a>\n')
    expect(html).toContain('href="tel:')
  })

  it('data: URI 仅 img 豁免：![](data:...) 存活、<a href="data:..."> 剥', async () => {
    const img = await freshRender('![x](data:image/png;base64,iVBORw0KGgo=)\n')
    expect(img).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    const a = await freshRender('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>\n')
    expect(a).not.toContain('data:text/html')
    expect(a).toContain('x')
  })
})

describe('a 补齐（afterSanitizeAttributes hook，R10 覆盖条件）', () => {
  it('原生 <a> 无 target → 补 _blank + noopener', async () => {
    const html = await freshRender('<a href="foo.md">本地</a>\n')
    expect(html).toContain('href="foo.md"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
  })

  it('markdown 语法链接不重复补（link_open 已注 target=_blank，rel 保持 noreferrer 不被覆盖）', async () => {
    const html = await freshRender('[站点](https://example.com)\n')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    // 只有一个 target 属性（未被 hook 二次写）
    expect(html.match(/target="/g)?.length).toBe(1)
  })

  it('用户显式 target=_self 被覆盖为 _blank（安全优先于排版意图）', async () => {
    const html = await freshRender('<a target="_self" href="foo.md">x</a>\n')
    expect(html).toContain('target="_blank"')
    expect(html).not.toContain('_self')
    expect(html).toContain('rel="noopener"')
  })
})

describe('img 相对 src 重写（afterSanitizeAttributes hook，D4 U3：resourceBaseDir 通道）', () => {
  const BASE = '/home/demo/project'

  it.each([
    { name: 'markdown 语法相对图片', content: '![](docs/foo.png)\n', src: 'docs/foo.png' },
    { name: '原生 HTML img 相对 src', content: '<img src="docs/foo.png">\n', src: 'docs/foo.png' },
    { name: '嵌套相对段', content: '![](a/b/c.png)\n', src: 'a/b/c.png' },
  ])('$name：带 base → local-file:///<encoded abs>（复用 DetailPane 拼法）', async ({ content, src }) => {
    const html = await freshRender(content, { resourceBaseDir: BASE })
    const abs = `${BASE}/${src}`
    expect(html).toContain(`src="local-file:///${encodeURIComponent(abs)}"`)
    expect(html).not.toContain(`src="${src}"`)
  })

  it.each([
    { name: '绝对路径', content: '![](/etc/passwd.png)\n', keep: '/etc/passwd.png' },
    { name: '根相对路径', content: '![](//cdn.example.com/a.png)\n', keep: '//cdn.example.com/a.png' },
    { name: 'https URL', content: '![](https://example.com/a.png)\n', keep: 'https://example.com/a.png' },
    { name: 'data URI', content: '![x](data:image/png;base64,iVBORw0KGgo=)\n', keep: 'data:image/png;base64,iVBORw0KGgo=' },
    { name: '# 锚点形态', content: '![](#anchor)\n', keep: '#anchor' },
  ])('$name：不重写（原样输出，D4「绝对/带协议/data URI 不动」）', async ({ content, keep }) => {
    const html = await freshRender(content, { resourceBaseDir: BASE })
    expect(html).toContain(`src="${keep}"`)
    expect(html).not.toContain('local-file://')
  })

  it('base 缺失（undefined）不重写——原样输出（现状等价，无回归）', async () => {
    const html = await freshRender('![](docs/foo.png)\n')
    expect(html).toContain('<img src="docs/foo.png"')
    expect(html).not.toContain('local-file://')
  })

  it('`../` 穿越按 POSIX resolve 出 base（真收尾在 local-file 白名单 403 裂图——错误规格表）', async () => {
    const html = await freshRender('![](../outside.png)\n', { resourceBaseDir: BASE })
    expect(html).toContain(`src="local-file:///${encodeURIComponent('/home/demo/outside.png')}"`)
  })
})

describe('相对资源协议纯函数（D4：isRelativeResourcePath / resolveResourcePath / toLocalFileUrl）', () => {
  it('isRelativeResourcePath 判定矩阵（④路 href 与 img src 共用三条排除 + 空串）', async () => {
    const { isRelativeResourcePath } = await import('../markdown-sanitize')
    expect(isRelativeResourcePath('docs/foo.md')).toBe(true)
    expect(isRelativeResourcePath('README.md')).toBe(true)
    expect(isRelativeResourcePath('')).toBe(false)
    expect(isRelativeResourcePath('#anchor')).toBe(false)
    expect(isRelativeResourcePath('//cdn.example.com/a.png')).toBe(false)
    expect(isRelativeResourcePath('https://example.com')).toBe(false)
    expect(isRelativeResourcePath('data:text/html,x')).toBe(false)
    expect(isRelativeResourcePath('mailto:a@b.c')).toBe(false)
  })

  it('resolveResourcePath：POSIX 语义（.. 穿越出 base / . 归一 / 多斜杠 / 根相对吃 base）', async () => {
    const { resolveResourcePath } = await import('../markdown-sanitize')
    expect(resolveResourcePath('/a/b', 'c.md')).toBe('/a/b/c.md')
    expect(resolveResourcePath('/a/b', '../c.md')).toBe('/a/c.md')
    expect(resolveResourcePath('/a/b', '../../c.md')).toBe('/c.md')
    expect(resolveResourcePath('/a/b', './c.md')).toBe('/a/b/c.md')
    expect(resolveResourcePath('/a/b', 'x//y/./z.md')).toBe('/a/b/x/y/z.md')
    expect(resolveResourcePath('/a/b', '/abs/c.md')).toBe('/abs/c.md')
  })

  it('toLocalFileUrl：与 DetailPane 现有拼法一致（encodeURIComponent 处理中文/空格）', async () => {
    const { toLocalFileUrl } = await import('../markdown-sanitize')
    expect(toLocalFileUrl('/a b/中文名.png')).toBe(`local-file:///${encodeURIComponent('/a b/中文名.png')}`)
  })
})

describe('可信契约逐字节保留（P3：摘出-回填后与 sanitize 前全等）', () => {
  it('五个摘出点的输出逐字节出现在最终 HTML（一断言覆盖全部契约）', async () => {
    const env = { filePaths: new Set(['src/foo.ts']) }
    const html = await freshRender(
      '`src/foo.ts` 正文 src/foo.ts 与 $x$ 公式\n\n$$\\sqrt{2}$$\n\n```ts\nconst a = 1\n```\n\n```mermaid\ngraph TD;A-->B\n```\n',
      env,
    )
    const b64 = (s: string): string => btoa(s)
    // md_trusted_inline：正文 filepath 链接整件（class/data-path/转义文本逐字节）
    const filepathAnchor = `<a class="md-filepath" data-path="${b64('src/foo.ts')}">src/foo.ts</a>`
    expect(html).toContain(filepathAnchor)
    // code_inline：反引号内 filepath（<code> 整段）
    expect(html).toContain(`<code>${filepathAnchor}</code>`)
    // math_inline / math_block：与管线同输入的 katex.renderToString 逐字节
    // （math_block 的 token.content 保留块尾换行——markdown-it-katex 块级定界符内容形态）
    expect(html).toContain(katex.renderToString('x', { displayMode: false, throwOnError: false }))
    expect(html).toContain(katex.renderToString('\\sqrt{2}\n', { displayMode: true, throwOnError: false }))
    // fence：容器骨架 + fake shiki 逐字节输出 + data-code base64
    expect(html).toContain('<div class="md-codeblock">')
    expect(html).toContain(`<pre class="shiki"><code>const a = 1\n</code></pre>`)
    expect(html).toContain(`data-code="${b64('const a = 1\n')}"`)
    // mermaid 占位 div 逐字节
    expect(html).toContain(`<div class="md-mermaid" data-source="${b64('graph TD;A-->B\n')}"></div>`)
  })
})

describe('混合串：可信契约与用户 HTML 交错（R4 摘出单位验证）', () => {
  it('同段落 filepath 链接 + 用户 <b> + 公式 + 后续表格交错渲染正确', async () => {
    const html = await freshRender(
      '见 src/foo.ts 说明 <b>注意</b> 公式 $x$ 后续\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
      { filePaths: new Set(['src/foo.ts']) },
    )
    // filepath 链接结束紧跟路径文本（单 token 摘出 → </a> 不吞并后续内容）
    expect(html).toMatch(/<a class="md-filepath"[^>]*>src\/foo\.ts<\/a>/)
    expect(html).toContain('<b>注意</b>')
    expect(html).toContain('class="katex"')
    expect(html).toContain('后续')
    // 用户表格走白名单完整渲染
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
  })
})

describe('th/td 列对齐转写（style:text-align → align）', () => {
  it(':--- / :---: / ---: 三列 → th/td 带 align 属性且无 style', async () => {
    const html = await freshRender('| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| a | b | c |\n')
    expect(html).toContain('<th align="left">')
    expect(html).toContain('<th align="center">')
    expect(html).toContain('<th align="right">')
    expect(html).toContain('<td align="left">')
    expect(html).toContain('<td align="center">')
    expect(html).toContain('<td align="right">')
    expect(html).not.toContain('text-align')
    expect(html).not.toContain('style=')
  })

  it('无对齐语法 → 无 align 属性（宿主 :not([align]) 兜底接管）', async () => {
    const html = await freshRender('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    expect(html).toContain('<th>')
    expect(html).not.toContain('align=')
  })
})

describe('HTML 块基础渲染', () => {
  it('<p align=center><img ...></p> 渲染为元素而非转义文本（README 居中形态）', async () => {
    const html = await freshRender('<p align=center><img src="docs/x.png"></p>\n')
    expect(html).toContain('<p align="center">')
    expect(html).toContain('<img src="docs/x.png">')
    expect(html).not.toContain('&lt;p')
  })

  it('HTML 注释不可见', async () => {
    // [P4 记录] DOMPurify 3.4.11 默认删除注释节点（实测行为）——注释不进输出
    const html = await freshRender('前文\n\n<!-- INSTALL:BEGIN -->\n\n后文\n')
    expect(html).toContain('<p>前文</p>')
    expect(html).toContain('<p>后文</p>')
    expect(html).not.toContain('INSTALL')
    expect(html).not.toContain('<!--')
  })
})

describe('切段/整串全等基础（README 居中形态一例；完整矩阵在 U2）', () => {
  it('html_block + 后续段落：切段渲染拼接与整串渲染等价', async () => {
    const md = '<p align="center">\n  <img src="docs/logo.png" width="96">\n</p>\n\n段落后文\n'
    const { markdown, incremental } = await freshModules()
    const full = await markdown.renderMarkdown(md)
    expect(full).toContain('<img src="docs/logo.png"') // 前提：HTML 块真实渲染
    const result = await incremental.renderIncremental(
      md,
      incremental.createIncrementalRenderCache(),
    )
    const joined = [...result.prefixSegments, ...result.tailSegments]
      .filter((s) => s.type === 'text')
      .map((s) => s.content)
      .join('')
    // DOM 等价判据：块间空白差异归一后全等
    expect(joined.replace(/\s+/g, '')).toBe(full.replace(/\s+/g, ''))
  })
})
})

describe('markdown-renderer-incremental', () => {
// ── 来源：markdown-renderer-incremental.test.ts ──
/**
 * MarkdownRenderer D-5 增量消费集成测试（W23，真实 W22 renderIncremental）。
 *
 * 与 ui 侧 MarkdownRenderer.test.ts（mock deps 组件行为层）互补：本文件用 ui 渲染链
 * markdown.ts 的 renderIncremental/createIncrementalRenderCache 走完「组件 watch → rAF 节流 →
 * 增量协议 → 渲染树」全链路，验收 plan.md W23 的四条：
 * ① 增量更新只重渲染尾段（前缀段 DOM 引用跨帧稳定 + 前缀段对象引用恒等）
 * ② streaming-fence 占位：语言名可见 + 无 shiki/mermaid 加载
 * ③ 静默期 finalize 后完整渲染（fence 内容以代码块呈现）
 * ④ complete 消息渲染与旧版（renderMarkdownSegments 全量）输出等价（回归基线）
 *
 * mock 策略与 markdown-incremental.test.ts 一致：stub shiki（codeToHtml 计数兼作
 * 「占位期零高亮」探针），markdown.ts 每用例 freshModule。rAF 用手动队列（异步语义）。
 *
 * [D10 渲染链下沉] 自 renderer 随渲染链迁入 ui（渲染模块 import 改相对路径；
 * createMockChatDeps 用 ui 侧 helpers.ts 的 createMockDeps 别名）。
 * 运行：cd packages/ui && TAIJI_TEST_DOMAIN=chat npx vitest run src/features/chat/__tests__/markdown.test.ts（本文件登记在 domain-map.json chat 域，默认档被排除）
 */
// stub shiki：避免真实语法加载；codeToHtml 计数用作「占位期零高亮」探针
// （fine-grained 后 markdown.ts 从 shiki/core import，mock 入口同步为 shiki/core）

/** 每用例拿到干净的 markdown 模块（renderMarkdown 内部缓存 markdown-it 实例 + highlighter 单例）。
 *  返回 markdown + markdown-incremental 合并命名空间：增量轴符号（renderIncremental 等）定义在
 *  markdown-incremental，renderMarkdownSegments 留守 markdown；两 import 同处 resetModules 后的
 *  同一 fresh 模块图（shiki stub 对整图生效），合并对象成员与增量轴内部引用同一实例。 */
async function freshModule(): Promise<
  typeof import('../markdown-incremental') & typeof import('../markdown')
> {
  vi.resetModules()
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.resolve({
        codeToHtml: fakeCodeToHtml,
        getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
      }),
  }))
  const [inc, md] = await Promise.all([
    import('../markdown-incremental'),
    import('../markdown'),
  ])
  return { ...inc, ...md }
}

// ── rAF 手动队列（异步语义：scheduleRender 的 rafId 赋值在同步回调下会残留 stale id 丢帧）──
const rafQueue: FrameRequestCallback[] = []
const originalRAF = globalThis.requestAnimationFrame
const originalCAF = globalThis.cancelAnimationFrame
// 真实 setTimeout（fake timers 下 flushRaf 仍需 macrotask 边界驱动 microtask 链落定）
const realSetTimeout: typeof setTimeout = globalThis.setTimeout.bind(globalThis)

/** 触发渲染链收敛：每轮执行已排队 rAF 回调 + 一轮 macrotask 排空其异步链，队列静默
 *  （无新 schedule）即收敛，上限防死循环。固定两轮在高负载下不够（首帧含 markdown-it/
 *  shiki 模块初始化，await 链深不定），轮询驱动使链深 > 2 轮也能排空，消除负载敏感 */
async function flushRaf(): Promise<void> {
  for (let i = 0; i < 20 && rafQueue.length > 0; i++) {
    const cbs = [...rafQueue]
    rafQueue.length = 0
    for (const cb of cbs) cb(0)
    await new Promise((r) => realSetTimeout(r, 0))
  }
  await new Promise((r) => realSetTimeout(r, 0))
  await nextTick()
}

/** 增量桥接（对齐壳层 useChatViewDeps 的 renderMarkdownIncremental 装配语义）+ 调用记录 */
async function createIncrementalDeps() {
  const m = await freshModule()
  const results: Awaited<ReturnType<typeof m.renderIncremental>>[] = []
  const renderMarkdownIncremental: ChatViewDeps['renderMarkdownIncremental'] = async (source, cache, _sid, opts) => {
    void _sid
    const c = cache ?? m.createIncrementalRenderCache()
    const result = await m.renderIncremental(source, c, undefined, opts)
    results.push(result)
    return { ...result, cache: c }
  }
  const deps = createMockChatDeps({
    renderMarkdownIncremental,
    streamingFenceSilenceMs: m.STREAMING_FENCE_SILENCE_MS,
  })
  return { m, deps, results }
}

function mountMd(props: Record<string, unknown>, deps: ChatViewDeps) {
  return mount(MarkdownRenderer, {
    props: props as never,
    global: {
      provide: { [ChatViewDepsKey as symbol]: deps },
      stubs: {
        MermaidRenderer: true,
        AmbiguousFilePopover: { name: 'AmbiguousFilePopover', render: () => null },
      },
    },
  })
}

/** 提取 .md-render 直接 div 子节点的 innerHTML 拼接（段级 DOM 内容，含 v-html 产物） */
function domContent(wrapper: VueWrapper): string {
  return wrapper
    .findAll('.md-render > div')
    .map((d) => d.element.innerHTML)
    .join('')
}

/** DOM 级归一化：块级标签间空白折叠（分段渲染与全文渲染的格式化 \n 差异） */
function normalizeHtml(html: string): string {
  return html.replace(/>\s+</g, '><').trim()
}

beforeEach(() => {
  fakeCodeToHtml.mockClear()
  rafQueue.length = 0
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF
  globalThis.cancelAnimationFrame = originalCAF
  vi.useRealTimers()
  vi.doUnmock('shiki/core')
})

describe('W23 ①: 增量更新只重渲染尾段（真实 renderIncremental）', () => {
  it('前缀段 DOM 节点引用恒等 + 前缀段对象引用恒等，尾段重建', async () => {
    const { deps, results } = await createIncrementalDeps()
    const wrapper = mountMd({ content: 'para one.\n\npara two.\n\nthree streaming', streaming: true }, deps)
    await flushRaf()
    const divsBefore = wrapper.findAll('.md-render > div')
    // 首帧：稳定边界 22（para two. 后空行）→ prefix（para one.+para two.）+ tail（three streaming）
    expect(divsBefore).toHaveLength(2)
    expect(results[0].prefixSegments).toHaveLength(1)
    const prefixEl = divsBefore[0].element

    await wrapper.setProps({ content: 'para one.\n\npara two.\n\nthree streaming more' } as never)
    await flushRaf()
    const divsAfter = wrapper.findAll('.md-render > div')
    expect(divsAfter).toHaveLength(2)
    // 前缀段 DOM 引用恒等（v-for :key=segId 命中 → v-html 子树不触碰）
    expect(divsAfter[0].element).toBe(prefixEl)
    expect(divsAfter[0].html()).toBe(divsBefore[0].html())
    // 协议层：第二帧 prefixSegments 与首帧前缀段对象引用恒等（缓存复用，零重渲染）
    expect(results[1].prefixSegments).toHaveLength(1)
    expect(results[1].prefixSegments[0]).toBe(results[0].prefixSegments[0])
    // 尾段内容更新为新增文本
    expect(divsAfter[1].text()).toContain('three streaming more')
  })
})

describe('W23 ②: streaming-fence 占位（语言名 + loader 行，不跑 shiki/mermaid）', () => {
  it('未结束代码 fence：占位可见（lang=ts），零 shiki 高亮', async () => {
    // 冻结静默时钟：silenceMs = performance.now() - lastContentAt 每帧重读（useMarkdownStreaming
    // runIncrementalRender），满载下 mount→首帧的 macrotask 边界可越过 200ms 阈值 → 首帧直接
    // finalize（占位转完整代码块）→ 占位断言假红。冻结后 silenceMs 恒 0、finalize 定时器不
    // advance 不触发，占位可见成为确定性行为。flushRaf 用模块级捕获的真实 setTimeout，不受影响。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { deps } = await createIncrementalDeps()
    const wrapper = mountMd({ content: 'intro paragraph\n\n```ts\nconst a = 1', streaming: true }, deps)
    await flushRaf()

    const placeholder = wrapper.find('[data-testid="md-streaming-fence"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.find('[data-testid="md-streaming-fence-lang"]').text()).toBe('ts')
    // 占位期不跑 shiki（fakeCodeToHtml 计数 = 0）、无代码块产物
    expect(fakeCodeToHtml).not.toHaveBeenCalled()
    expect(wrapper.find('.md-codeblock').exists()).toBe(false)
    expect(wrapper.find('pre.shiki').exists()).toBe(false)
    // 前缀正常渲染
    expect(wrapper.text()).toContain('intro paragraph')
  })

  it('未结束 mermaid fence：占位可见（lang=mermaid），不加载 mermaid', async () => {
    // 同上：冻结静默时钟，堵「满载首帧 silenceMs 越阈值 → 占位未现先 finalize」的假红窗口
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { deps } = await createIncrementalDeps()
    const renderMermaid = vi.fn(deps.renderMermaid)
    const wrapper = mountMd(
      { content: 'intro\n\n```mermaid\ngraph LR\nA-->B', streaming: true },
      { ...deps, renderMermaid },
    )
    await flushRaf()

    const placeholder = wrapper.find('[data-testid="md-streaming-fence"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.find('[data-testid="md-streaming-fence-lang"]').text()).toBe('mermaid')
    // finalize 前不挂 MermaidRenderer、不调 renderMermaid
    expect(wrapper.find('mermaid-renderer-stub').exists()).toBe(false)
    expect(renderMermaid).not.toHaveBeenCalled()
  })
})

describe('W23 ③: 静默期 finalize 后完整渲染', () => {
  it('token 静默 ≥200ms → 占位转完整代码块（fence 已到达内容呈现）', async () => {
    // performance.now 一并冻结：flushRaf 后的占位存在断言与 ② 同暴露面（真实时钟下满载
    // 首帧可提前 finalize）；advanceTimersByTimeAsync 命中的是 armFenceFinalizeTimer 挂的
    // 静默定时器（remaining = 阈值 - 冻结差值 = 200ms），finalize 语义不变
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { deps } = await createIncrementalDeps()
    const wrapper = mountMd({ content: 'intro paragraph\n\n```ts\nconst a = 1', streaming: true }, deps)
    await flushRaf()
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(250)
    await new Promise((r) => realSetTimeout(r, 0))
    await nextTick()
    // 占位消失，未结束 fence 以完整代码块呈现（header 语言标签 + shiki pre + 源码可见）
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)
    expect(wrapper.find('.md-codeblock__lang').text()).toContain('ts')
    expect(fakeCodeToHtml).toHaveBeenCalled()
    expect(wrapper.text()).toContain('const a = 1')
  })
})

describe('W23 ④: complete 消息渲染与旧版全量渲染等价（回归基线）', () => {
  /** 完整文档（标题/段落/结束 fence/列表/表格/行内代码，无 mermaid——mermaid 是组件态不走 v-html 等价口径） */
  const COMPLETE_DOC = [
    '# Title',
    '',
    'First paragraph with `inline code`.',
    '',
    '```ts',
    'const a = 1',
    'const b = 2',
    '```',
    '',
    '- item one',
    '- item two',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
  ].join('\n')

  async function mountBoth(content: string): Promise<{ inc: VueWrapper; legacy: VueWrapper }> {
    const { m, deps } = await createIncrementalDeps()
    // streaming 缺省 = complete → 直接完整渲染
    const inc = mountMd({ content }, deps)
    // legacy 对照：renderMarkdownSegments 全量管线一次性产段（D6 收敛后 ChatViewDeps 无
    // 「缺增量回退全量」路径，对照侧显式桥接单帧增量返回全量段）
    const legacy = mountMd(
      { content },
      createMockChatDeps({
        renderMarkdown: (source: string) => m.renderMarkdownSegments(source),
        renderMarkdownIncremental: async (source, cache) => ({
          prefixSegments: [],
          tailSegments: await m.renderMarkdownSegments(source),
          stableBoundary: 0,
          mode: 'incremental' as const,
          cache: cache ?? m.createIncrementalRenderCache(),
        }),
      }),
    )
    await flushRaf()
    return { inc, legacy }
  }

  it('尾行无换行（prefix/tail 分段路径）：段内容拼接与旧版全文渲染等价', async () => {
    const { inc, legacy } = await mountBoth(COMPLETE_DOC)
    expect(normalizeHtml(domContent(inc))).toBe(normalizeHtml(domContent(legacy)))
    // 结构等价（用户可见的块级结构计数）
    for (const sel of ['p', '.md-codeblock', 'li', 'table', 'code']) {
      expect(inc.findAll(sel).length, sel).toBe(legacy.findAll(sel).length)
    }
    expect(inc.text()).toContain('item one')
    expect(inc.text()).toContain('const b = 2')
  })

  it('尾行带换行（全前缀路径）：渲染树整体与旧版等价', async () => {
    const { inc, legacy } = await mountBoth(`${COMPLETE_DOC}\n`)
    expect(normalizeHtml(domContent(inc))).toBe(normalizeHtml(domContent(legacy)))
    expect(inc.findAll('.md-codeblock')).toHaveLength(1)
  })

  it('未结束 fence 的 complete 消息（streaming=false）：finalize 直出完整代码块，与旧版等价', async () => {
    const unclosed = 'para.\n\n```ts\nconst a = 1'
    const { inc, legacy } = await mountBoth(unclosed)
    // 无占位残留（complete → 立即 finalize）
    expect(inc.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(normalizeHtml(domContent(inc))).toBe(normalizeHtml(domContent(legacy)))
    expect(inc.text()).toContain('const a = 1')
  })
})

describe('chat-html-support ①: html-preview fence 识别与段切分（首词命中 / 尾随忽略 / 空与多行）', () => {
  it('info 首词 = html-preview → html-preview 段（载荷 = 路径）；尾随 token 忽略（与 mermaid 同构）', async () => {
    const { m } = await createIncrementalDeps()
    for (const info of ['html-preview', 'html-preview title=report', 'HTML-PREVIEW']) {
      const segs = await m.renderMarkdownSegments('```' + info + '\n/abs/report.html\n```\n')
      expect(segs, info).toHaveLength(1)
      expect(segs[0].type, info).toBe('html-preview')
      expect(segs[0].content.trim(), info).toBe('/abs/report.html')
    }
  })

  it('空内容 → 载荷 trim 后为空；多行内容 → 载荷含换行（消费侧判定「路径非法」的两类输入）', async () => {
    const { m } = await createIncrementalDeps()
    const empty = await m.renderMarkdownSegments('```html-preview\n```\n')
    expect(empty[0].type).toBe('html-preview')
    expect(empty[0].content.trim()).toBe('')

    const multi = await m.renderMarkdownSegments('```html-preview\n/a.html\n/b.html\n```\n')
    expect(multi[0].type).toBe('html-preview')
    expect(multi[0].content.trim()).toContain('\n')
  })

  it('mermaid fence 行为不变（回归）：首词命中 + 尾随忽略', async () => {
    const { m } = await createIncrementalDeps()
    const segs = await m.renderMarkdownSegments('```mermaid\ngraph LR\nA-->B\n```\n')
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('mermaid')
    expect(segs[0].content).toContain('graph LR')
  })

  it('未结束 fence：非 finalize → streaming-fence 占位（lang=html-preview）；finalize → 落成 html-preview 段', async () => {
    const { m } = await createIncrementalDeps()
    const open = '```html-preview\n/abs/report.html'
    const cache = m.createIncrementalRenderCache()

    const r1 = await m.renderIncremental(open, cache, undefined, { finalizeOpenFence: false })
    const all1 = [...r1.prefixSegments, ...r1.tailSegments]
    const fence = all1.find((s) => s.type === 'streaming-fence')
    expect(fence?.lang).toBe('html-preview')
    expect(all1.some((s) => s.type === 'html-preview')).toBe(false)

    const r2 = await m.renderIncremental(open, cache, undefined, { finalizeOpenFence: true })
    const all2 = [...r2.prefixSegments, ...r2.tailSegments]
    const card = all2.find((s) => s.type === 'html-preview')
    expect(card?.content.trim()).toBe('/abs/report.html')
    expect(all2.some((s) => s.type === 'streaming-fence')).toBe(false)
  })

  it('fallback-full 路径（含链接引用定义 → 无稳定边界）同样走 html-preview 占位分流', async () => {
    const { m } = await createIncrementalDeps()
    const content = '[ref]: https://example.com\n\n```html-preview\n/abs/report.html'
    const cache = m.createIncrementalRenderCache()

    const r1 = await m.renderIncremental(content, cache, undefined, { finalizeOpenFence: false })
    expect(r1.mode).toBe('fallback-full')
    const all1 = [...r1.prefixSegments, ...r1.tailSegments]
    expect(all1.some((s) => s.type === 'streaming-fence' && s.lang === 'html-preview')).toBe(true)
    expect(all1.some((s) => s.type === 'html-preview')).toBe(false)

    const r2 = await m.renderIncremental(content, cache, undefined, { finalizeOpenFence: true })
    const all2 = [...r2.prefixSegments, ...r2.tailSegments]
    expect(all2.some((s) => s.type === 'html-preview')).toBe(true)
    expect(all2.some((s) => s.type === 'streaming-fence')).toBe(false)
  })
})
})
