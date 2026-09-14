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
 *  - AC-6:  取消空格路径支持（docs/My Document.md 不再识别为整条；无他处覆盖）
 *  - AC-10: emphasis 不被路径识别破坏（P0 回归——重构核心动机，含原始 bug 场景）
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
