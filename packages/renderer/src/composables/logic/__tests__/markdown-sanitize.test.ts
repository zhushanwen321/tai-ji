// @vitest-environment jsdom
// [P1 探针结论 2026-09-19] DOMPurify 3.4.11 需要 nodeName getter 在 Node.prototype 上
// （realm 安全缓存 getter lookupGetter(Node.prototype,'nodeName') 依赖它）；happy-dom 把
// nodeName 定义在各元素子类（Element/Comment/Document），不在 Node.prototype → DOMPurify
// 在 happy-dom 下把所有元素判为「不允许标签」（tag 名取空）——净化行为整体失真。
// 按 markdown-html-sanitize-render 设计 P1 的处置选项，本测试族钉 jsdom 跑。
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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import katex from 'katex'
import DOMPurify from 'dompurify'

// stub shiki（freshRender 每次重注册；顶层 vi.mock 供本文件默认 import 链路）
const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)
vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(() =>
    Promise.resolve({
      codeToHtml: fakeCodeToHtml,
      getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
    }),
  ),
}))

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
  const { renderMarkdown } = await import('@/composables/logic/markdown')
  return renderMarkdown(content, env)
}

/** 与 freshRender 同批的 markdown + markdown-incremental 双模块（切段/整串全等用） */
async function freshModules(): Promise<{
  markdown: typeof import('@/composables/logic/markdown')
  incremental: typeof import('@/composables/logic/markdown-incremental')
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
    markdown: await import('@/composables/logic/markdown'),
    incremental: await import('@/composables/logic/markdown-incremental'),
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

  it('tel: 存活（默认正则协议面，非剥除）', async () => {
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

  it('`../` 穿越按 POSIX resolve 出 base（真收口在 local-file 白名单 403 裂图——错误规格表）', async () => {
    const html = await freshRender('![](../outside.png)\n', { resourceBaseDir: BASE })
    expect(html).toContain(`src="local-file:///${encodeURIComponent('/home/demo/outside.png')}"`)
  })
})

describe('相对资源协议纯函数（D4：isRelativeResourcePath / resolveResourcePath / toLocalFileUrl）', () => {
  it('isRelativeResourcePath 判定矩阵（④路 href 与 img src 共用三条排除 + 空串）', async () => {
    const { isRelativeResourcePath } = await import('@/composables/logic/markdown-sanitize')
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
    const { resolveResourcePath } = await import('@/composables/logic/markdown-sanitize')
    expect(resolveResourcePath('/a/b', 'c.md')).toBe('/a/b/c.md')
    expect(resolveResourcePath('/a/b', '../c.md')).toBe('/a/c.md')
    expect(resolveResourcePath('/a/b', '../../c.md')).toBe('/c.md')
    expect(resolveResourcePath('/a/b', './c.md')).toBe('/a/b/c.md')
    expect(resolveResourcePath('/a/b', 'x//y/./z.md')).toBe('/a/b/x/y/z.md')
    expect(resolveResourcePath('/a/b', '/abs/c.md')).toBe('/abs/c.md')
  })

  it('toLocalFileUrl：与 DetailPane 现有拼法一致（encodeURIComponent 处理中文/空格）', async () => {
    const { toLocalFileUrl } = await import('@/composables/logic/markdown-sanitize')
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
    // filepath 链接闭合紧跟路径文本（单 token 摘出 → </a> 不吞并后续内容）
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
