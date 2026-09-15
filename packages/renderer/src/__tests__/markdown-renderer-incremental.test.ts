/**
 * MarkdownRenderer D-5 增量消费集成测试（W23，真实 W22 renderIncremental）。
 *
 * 与 ui 侧 MarkdownRenderer.test.ts（mock deps 组件行为层）互补：本文件用 renderer 真实
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
 * 运行：cd packages/renderer && npx vitest run src/__tests__/markdown-renderer-incremental.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { MarkdownRenderer, ChatViewDepsKey } from '@xyz-agent/ui'
import type { ChatViewDeps } from '@xyz-agent/ui'
import type { VueWrapper } from '@vue/test-utils'
import { createMockChatDeps } from '@/__tests__/helpers/chat-view-deps'

// stub shiki：避免真实语法加载；codeToHtml 计数用作「占位期零高亮」探针
// （fine-grained 后 markdown.ts 从 shiki/core import，mock 入口同步为 shiki/core）
const fakeCodeToHtml = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`)

/** 每用例拿到干净的 markdown 模块（renderMarkdown 内部缓存 markdown-it 实例 + highlighter 单例）。
 *  返回 markdown + markdown-incremental 合并命名空间：增量轴符号（renderIncremental 等）定义在
 *  markdown-incremental，renderMarkdownSegments 留守 markdown；两 import 同处 resetModules 后的
 *  同一 fresh 模块图（shiki stub 对整图生效），合并对象成员与增量轴内部引用同一实例。 */
async function freshModule(): Promise<
  typeof import('@/composables/logic/markdown-incremental') & typeof import('@/composables/logic/markdown')
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
    import('@/composables/logic/markdown-incremental'),
    import('@/composables/logic/markdown'),
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
    shouldFinalizeStreamingFence: m.shouldFinalizeStreamingFence,
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
  it('未闭合代码 fence：占位可见（lang=ts），零 shiki 高亮', async () => {
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

  it('未闭合 mermaid fence：占位可见（lang=mermaid），不加载 mermaid', async () => {
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { deps } = await createIncrementalDeps()
    const wrapper = mountMd({ content: 'intro paragraph\n\n```ts\nconst a = 1', streaming: true }, deps)
    await flushRaf()
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(250)
    await new Promise((r) => realSetTimeout(r, 0))
    await nextTick()
    // 占位消失，未闭合 fence 以完整代码块呈现（header 语言标签 + shiki pre + 源码可见）
    expect(wrapper.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(wrapper.find('.md-codeblock').exists()).toBe(true)
    expect(wrapper.find('.md-codeblock__lang').text()).toContain('ts')
    expect(fakeCodeToHtml).toHaveBeenCalled()
    expect(wrapper.text()).toContain('const a = 1')
  })
})

describe('W23 ④: complete 消息渲染与旧版全量渲染等价（回归基线）', () => {
  /** 完整文档（标题/段落/闭合 fence/列表/表格/行内代码，无 mermaid——mermaid 是组件态不走 v-html 等价口径） */
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
    const legacy = mountMd(
      { content },
      createMockChatDeps({
        renderMarkdown: (source: string) => m.renderMarkdownSegments(source),
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

  it('未闭合 fence 的 complete 消息（streaming=false）：finalize 直出完整代码块，与旧版等价', async () => {
    const unclosed = 'para.\n\n```ts\nconst a = 1'
    const { inc, legacy } = await mountBoth(unclosed)
    // 无占位残留（complete → 立即 finalize）
    expect(inc.find('[data-testid="md-streaming-fence"]').exists()).toBe(false)
    expect(normalizeHtml(domContent(inc))).toBe(normalizeHtml(domContent(legacy)))
    expect(inc.text()).toContain('const a = 1')
  })
})
