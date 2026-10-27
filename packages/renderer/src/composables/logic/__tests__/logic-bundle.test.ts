/**
 * composables/logic 纯逻辑域合并产物（round 6 renderer 测试压缩）：三文件同产物，
 * 环境统一默认（happy-dom）。file-type / summarizeTurn 两文件原为 node 环境注释，
 * 纯函数无 node 特有 API（KeyboardEvent/document 由 focus-trap 节需要），迁移实证兼容。
 *
 * 并入来源（基名）：
 *  - logic/file-type（detectFileKind/extToLang 分发回归，6 例，原 node）
 *  - logic/focus-trap（Tab 焦点陷阱三路循环，6 例）
 *  - logic/summarizeTurn（rail 摘要纯函数 IF5 契约，10 例，原 node）
 *
 * 三节均零 vi.mock（纯函数直测），无 mock 互斥。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/composables/logic/__tests__/logic-bundle.test.ts
 */
import { describe, it, expect } from 'vitest'
import { detectFileKind, extToLang } from '@/composables/logic/file-type'
import { cycleTabFocus, getFocusableElements, FOCUSABLE_SELECTOR } from '../focus-trap'
import { summarizeTurnForRail, summarizeAssistantForRail } from '../summarizeTurn'
import type { MessageTurn } from '../messageTurns'
import type { Message } from '@taiji/shared'

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：logic/file-type（原 node 环境文件）
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：logic/focus-trap
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 keydown 事件（cancelable 必须 true，否则 preventDefault 无效果可断言） */
function tabEvent(shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true })
}

function mountFocusables(): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = `
      <button id="first">first</button>
      <input id="mid" />
      <button id="last">last</button>
      <button id="disabled" disabled>disabled</button>
      <span id="neg" tabindex="-1">neg</span>
    `
    document.body.appendChild(host)
    return host
}

describe('cycleTabFocus', () => {
  it('末个非 shift Tab：preventDefault + 回首个', () => {
    const host = mountFocusables()
    const first = host.querySelector('#first') as HTMLElement
    const last = host.querySelector('#last') as HTMLElement
    const e = tabEvent(false)
    last.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    host.remove()
  })

  it('首个 shift Tab：preventDefault + 跳末个', () => {
    const host = mountFocusables()
    const first = host.querySelector('#first') as HTMLElement
    const last = host.querySelector('#last') as HTMLElement
    const e = tabEvent(true)
    first.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    host.remove()
  })

  it('中间元素 Tab：不拦截（交浏览器原生顺序），焦点不变', () => {
    const host = mountFocusables()
    const mid = host.querySelector('#mid') as HTMLElement
    const e = tabEvent(false)
    mid.focus()
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(mid)
    host.remove()
  })

  it('无可聚焦元素：放行', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const e = tabEvent(false)
    cycleTabFocus(e, () => getFocusableElements(host))
    expect(e.defaultPrevented).toBe(false)
    host.remove()
  })
})

describe('getFocusableElements', () => {
  it('按 DOM 序枚举可聚焦元素，排除 disabled 与 tabindex="-1"', () => {
    const host = mountFocusables()
    const ids = getFocusableElements(host).map((el) => el.id)
    expect(ids).toEqual(['first', 'mid', 'last'])
    host.remove()
  })

  it('FOCUSABLE_SELECTOR 覆盖 href / select / textarea / tabindex 形态', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <a id="link" href="#a">link</a>
      <select id="sel"><option>o</option></select>
      <textarea id="ta"></textarea>
      <div id="tn" tabindex="0">tn</div>
    `
    document.body.appendChild(host)
    const ids = getFocusableElements(host).map((el) => el.id)
    expect(ids).toEqual(['link', 'sel', 'ta', 'tn'])
    expect(FOCUSABLE_SELECTOR).toContain('[href]')
    host.remove()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：logic/summarizeTurn（原 node 环境文件）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造最小可用的 MessageTurn（用 as 断言绕开完整 Message 字段需求）。 */
function makeTurn(userContent: string | null): MessageTurn {
  return {
    index: 1,
    user:
      userContent === null
        ? null
        : ({ id: 'u1', role: 'user', content: userContent, status: 'done' } as MessageTurn['user']),
    assistants: [],
    isStreaming: false,
    hasFoldable: false,
  } as MessageTurn
}

describe('summarizeTurnForRail (IF5)', () => {
  it('TC-w3-9: 剥离 markdown 标记后取前 20 字纯文本', () => {
    // 标题 + 加粗 + 链接 + 行内代码混合
    const turn = makeTurn('# 修复 **trace** 渲染 [bug](https://x.com) `code`')
    const summary = summarizeTurnForRail(turn)
    // 预期：# / ** / [bug](url) / ` 全部剥离，纯文本 = "修复 trace 渲染 bug code"
    expect(summary).toBe('修复 trace 渲染 bug code')
    // 长度上限校验：短文本不加省略号
    expect(summary.length).toBeLessThanOrEqual(20)
  })

  it('TC-w3-9b: 超长文本截断到 20 字 + 省略号', () => {
    const longText = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
    // 30 字符的中文串，应截到 19 字 + '…' = 20 字符
    const summary = summarizeTurnForRail(makeTurn(longText))
    expect(summary.length).toBe(20)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.startsWith('一二三四五六七八九十一二三四五六七八九')).toBe(true)
  })

  it('TC-w3-10: user 为 null 时返回空串', () => {
    expect(summarizeTurnForRail(makeTurn(null))).toBe('')
  })
})

/** 构造带 assistant 的 MessageTurn（agent 摘要测试用）。 */
function makeTurnWithAssistant(opts: {
  assistantContents?: string[]   // 多 assistant 的 content 数组（默认 [''] 空 content）
  thinkingCount?: number
  toolCount?: number
}): MessageTurn {
  const contents = opts.assistantContents ?? ['']
  const thinking = opts.thinkingCount
    ? Array.from({ length: opts.thinkingCount }, (_, i) => ({
        id: `th${i}`, content: `thinking ${i}`, collapsed: true,
      }))
    : undefined
  const toolCalls = opts.toolCount
    ? Array.from({ length: opts.toolCount }, (_, i) => ({
        id: `tc${i}`, toolName: 'read', input: { path: `f${i}.ts` },
        status: 'done' as const, startTime: 0,
      }))
    : undefined
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: '用户输入', status: 'done' } as Message,
    assistants: contents.map((c, i) => ({
      id: `a${i}`,
      role: 'assistant',
      content: c,
      status: 'done',
      thinking: i === 0 ? thinking : undefined,
      toolCalls: i === 0 ? toolCalls : undefined,
    } as Message)),
    isStreaming: false,
    hasFoldable: false,
  } as MessageTurn
}

describe('summarizeAssistantForRail', () => {
  it('TC-A1: content 非空 → 返回 content 截断（stripMarkdown 后）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: ['修复了 **Block.vue** 的折叠状态'] })
    expect(summarizeAssistantForRail(turn)).toBe('修复了 Block.vue 的折叠状态')
  })

  it('TC-A2: content 空 + 有 thinking/tools → fallback 计数 N thoughts · M tools', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], thinkingCount: 2, toolCount: 3 })
    expect(summarizeAssistantForRail(turn)).toBe('2 thoughts · 3 tools')
  })

  it('TC-A3: content 空 + 仅 thinking → 只显 N thoughts', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], thinkingCount: 5 })
    expect(summarizeAssistantForRail(turn)).toBe('5 thoughts')
  })

  it('TC-A4: content 空 + 仅 tools → 只显 M tools', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''], toolCount: 4 })
    expect(summarizeAssistantForRail(turn)).toBe('4 tools')
  })

  it('TC-A5: content 空 + 无 thinking/tools → 返回空串（调用方显占位）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: [''] })
    expect(summarizeAssistantForRail(turn)).toBe('')
  })

  it('TC-A6: 多 assistant → 取首个非空 content（不 concat）', () => {
    const turn = makeTurnWithAssistant({ assistantContents: ['', '', '最终回复'] })
    // 前两条空，取第三条非空 content
    expect(summarizeAssistantForRail(turn)).toBe('最终回复')
  })

  it('TC-A7: assistants 为空数组 → 返回空串', () => {
    const turn = { index: 1, user: null, assistants: [], isStreaming: false, hasFoldable: false } as MessageTurn
    expect(summarizeAssistantForRail(turn)).toBe('')
  })
})
