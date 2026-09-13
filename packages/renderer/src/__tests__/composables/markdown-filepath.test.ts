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
 * 覆盖范围：
 *  - AC-1:  PATH_CANDIDATE_RE 性能（病态输入不卡死）
 *  - AC-7:  BASENAME_CANDIDATE_RE 性能（同构病态，同测）
 *  - AC-9:  静态结构断言（正则源码无嵌套量词，兜底 CI 计时 flaky）
 *  - AC-3:  含/路径识别（注入 env.filePaths 白名单）
 *  - AC-4:  无扩展名路径识别（src/Makefile，注入白名单）
 *  - AC-8:  code_inline 渲染路径（反引号内路径，注入白名单）
 *  - AC-5:  误识别防御（白名单不含即不链接，正则无需 hack）
 *  - AC-6:  取消空格路径支持（docs/My Document.md 不再识别为整条）
 *  - AC-10: emphasis 不被路径识别破坏（P0 回归——重构核心动机）
 *  - AC-11: 白名单外路径不链接
 *  - AC-2:  真实渲染不卡顿
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect）。禁止 node:test。
 * 运行：cd packages/renderer && npx vitest run markdown-filepath
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
// PATH_CANDIDATE_RE / BASENAME_CANDIDATE_RE 导出做性能断言 + 静态结构断言（AC-1/7/9）。
// renderMarkdown 用于功能验收（AC-3/4/5/6/8/10/11，间接走 filepathCoreRule + code_inline renderer）。
import { renderMarkdown, PATH_CANDIDATE_RE, BASENAME_CANDIDATE_RE } from '@/composables/logic/markdown'

// stub shiki：避免真实语法加载，测试聚焦路径识别逻辑（fine-grained 后入口是 shiki/core）
const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)
vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(() =>
    Promise.resolve({
      codeToHtml: fakeCodeToHtml,
      getLoadedLanguages: () => ['typescript', 'javascript', 'vue'],
    }),
  ),
}))

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
  const { renderMarkdown } = await import('@/composables/logic/markdown')
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
      // eslint-disable-next-line no-empty
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
    // eslint-disable-next-line no-empty
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
      // eslint-disable-next-line no-empty
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

describe('AC-3/AC-4 含/路径识别（filepathCoreRule）', () => {
  it('AC-3: 相对路径 src/foo.ts 在白名单 → 识别为 md-filepath 链接', async () => {
    const html = await freshRender('edit src/foo.ts please', { filePaths: new Set(['src/foo.ts']) })
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('>src/foo.ts<')
  })

  it('AC-3: 路径出现在剩余串中部（前有其他文本）仍由边界符触发命中', async () => {
    const html = await freshRender('请修改 packages/renderer/src/index.ts 的导出', {
      filePaths: new Set(['packages/renderer/src/index.ts']),
    })
    expect(html).toContain('>packages/renderer/src/index.ts<')
    expect(html).toContain('class="md-filepath"')
  })

  it('AC-3: 同段多个路径都识别', async () => {
    const html = await freshRender('改了 a/b.ts 和 x/y.vue', {
      filePaths: new Set(['a/b.ts', 'x/y.vue']),
    })
    expect(html).toContain('>a/b.ts<')
    expect(html).toContain('>x/y.vue<')
    expect(html.match(/md-filepath/g)?.length).toBe(2)
  })

  it('AC-4: 无扩展名路径 src/Makefile 在白名单 → 识别', async () => {
    const html = await freshRender('run src/Makefile target', { filePaths: new Set(['src/Makefile']) })
    expect(html).toContain('>src/Makefile<')
    expect(html).toContain('class="md-filepath"')
  })
})

// ── AC-8：code_inline 渲染路径（反引号内路径，注入白名单）──────────────────

describe('AC-8 code_inline 路径识别（反引号内路径）', () => {
  it('反引号包裹的路径在白名单 → 识别为 md-filepath 链接', async () => {
    const html = await freshRender('edit `src/foo.ts` now', { filePaths: new Set(['src/foo.ts']) })
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('>src/foo.ts<')
    // 外层保留 <code>
    expect(html).toContain('<code>')
  })

  it('反引号内绝对路径在白名单 → 识别', async () => {
    // 注：绝对路径必须完整出现在白名单里（FileNode.path 实际是相对 cwd，这里测白名单命中语义）
    const html = await freshRender('config in `/etc/nginx/nginx.conf`', {
      filePaths: new Set(['/etc/nginx/nginx.conf']),
    })
    expect(html).toContain('>/etc/nginx/nginx.conf<')
  })
})

// ── AC-5：误识别防御（白名单不含即不链接）─────────────────────────────────

describe('AC-5 误识别防御（白名单不含即不链接）', () => {
  it('版本号 glm-5.2 不识别（白名单不含）', async () => {
    const html = await freshRender('model glm-5.2 is fast', { filePaths: new Set() })
    expect(html).not.toContain('class="md-filepath"')
  })

  it('版本号 node/18.0 不识别（白名单不含）', async () => {
    const html = await freshRender('requires node/18.0 or above', { filePaths: new Set() })
    expect(html).not.toContain('class="md-filepath"')
  })

  it('小数 pi/3.14 不识别（白名单不含）', async () => {
    const html = await freshRender('value is pi/3.14 approx', { filePaths: new Set() })
    expect(html).not.toContain('class="md-filepath"')
  })

  it('英文词组 necessity/sufficiency/tradeoffs 不识别（白名单不含，P0 bug 原始触发场景）', async () => {
    const html = await freshRender('**bold** necessity/sufficiency/tradeoffs **end**', { filePaths: new Set() })
    // 词组本身不链接
    expect(html).not.toContain('md-filepath')
  })
})

// ── AC-6：取消空格路径支持（设计取舍）──────────────────────────────────────

describe('AC-6 取消空格路径支持', () => {
  it('docs/My Document.md 不再识别为整条路径', async () => {
    const html = await freshRender('see docs/My Document.md here', {
      filePaths: new Set(['docs/My Document.md', 'docs/My']),
    })
    // 整条「docs/My Document.md」不应作为一个 md-filepath 链接出现（空格切断）
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

describe('AC-11 白名单外路径不链接', () => {
  it('无 env（fileSearch 未加载）→ 所有路径降级纯文本', async () => {
    const html = await freshRender('see src/foo.ts and a/b.ts')
    expect(html).not.toContain('class="md-filepath"')
    expect(html).toContain('src/foo.ts')
  })

  it('env.filePaths 为空集 → 路径不链接', async () => {
    const html = await freshRender('see src/foo.ts', { filePaths: new Set() })
    expect(html).not.toContain('class="md-filepath"')
    expect(html).toContain('src/foo.ts')
  })

  it('路径在白名单外的相似路径不误链接', async () => {
    // src/foo.ts 在白名单，但 src/foot.ts 不在 → 后者不链接
    const html = await freshRender('edit src/foo.ts and src/foot.ts', {
      filePaths: new Set(['src/foo.ts']),
    })
    expect(html).toContain('>src/foo.ts<')
    // src/foot.ts 应为纯文本（不在 a 标签内）
    expect(html).not.toContain('>src/foot.ts<')
  })
})

// ── AC-2 真实渲染不卡顿（real layer 集成场景）──────────────────────────────

describe('AC-2 真实渲染不卡顿', () => {
  it('750+ chars 中英混排+反引号+表格行 单次 render < 200ms 且不抛错', async () => {
    const triggerBlock = [
      '这是一段混排文本，包含长英文单词如 configurationmanagementstrategies 和 backwardcompatibilityguarantees，',
      '以及反引号路径 `packages/renderer/src/composables/logic/markdown.ts` 和 `~/Code/project/foo.ts`。',
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
          'packages/renderer/src/composables/logic/markdown.ts',
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
