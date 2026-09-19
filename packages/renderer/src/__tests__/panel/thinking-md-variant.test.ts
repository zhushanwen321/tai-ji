// @vitest-environment jsdom
// [U1 sanitize] DOMPurify 需要 nodeName getter 在 Node.prototype 上（realm 安全缓存 getter
// 依赖它）；happy-dom 把 nodeName 定义在各元素子类，DOMPurify 3.4.11 在 happy-dom 下把
// 所有元素判为不允许标签（P1 探针实证）——markdown 管线测试族统一跑 jsdom。
/**
 * W1 + W2 红灯测试 - MarkdownRenderer thinking variant + thinking 块走 markdown。
 *
 * 防的 bug：
 * - thinking 块内容用纯文本插值，bold/列表/标题等 md 语法不渲染（W2）
 * - MarkdownRenderer 无 variant 机制，thinking 内的 md 元素颜色/字号与正文撞色（W1）
 *
 * 三视角：
 * - 观察者（形态）：thinking variant root 有 .md-render--thinking class；标题颜色是 reasoning 而非 fg
 * - 使用者（黑盒）：thinking 内容里的 bold 被渲染为 strong，列表被渲染为 ul/ol
 * - 构建者（白盒）：variant prop 默认 undefined 时不加 thinking class（向后兼容）
 *
 * [w6 chat-ui-and-shell T7] ui 包组件经 ChatViewDeps inject 消费 renderMarkdown
 * （原 mock '@/composables/logic/markdown' + 旧组件路径 vi.mock 失效），改为 provide mock deps；
 * MermaidRenderer/AmbiguousFilePopover 按组件名 stub（ui 包内部相对 import 无法 vi.mock 路径命中）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/thinking-md-variant.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, h } from 'vue'
import { Block, MarkdownRenderer } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

// renderMarkdown 经 deps 注入：同步返回 markdown 结构段（绕过 shiki 异步加载）
const mockRenderMarkdown = vi.fn()

// H2 后 MarkdownRenderer watch 改用 rAF 调度渲染。这些用例不验证节流时序，
// 只需 rAF 回调同步执行（mount 后 nextTick 即渲染完成）。
const _originalRAF = globalThis.requestAnimationFrame
const _originalCAF = globalThis.cancelAnimationFrame
beforeAll(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterAll(() => {
  globalThis.requestAnimationFrame = _originalRAF
  globalThis.cancelAnimationFrame = _originalCAF
})

/** MermaidRenderer stub（ui 包内部相对 import，按组件名 stub） */
const MermaidStub = {
  name: 'MermaidRenderer',
  props: ['source'],
  setup(props: { source: string }) {
    return () => h('div', { class: 'stub-mermaid' }, props.source)
  },
}

/** AmbiguousFilePopover stub（返回注释 vnode，不占 .md-render 直接子节点） */
const AmbiguousPopoverStub = { name: 'AmbiguousFilePopover', render: () => null }

/** 让 mockRenderMarkdown 返回 markdown 结构段（模拟 markdown-it 解析结果） */
function mockMarkdownSegments(html: string): void {
  mockRenderMarkdown.mockReturnValue([{ type: 'text', content: html }])
}

/** mount 公共 deps（renderMarkdown mock + 子组件 stub） */
function mountWithDeps(comp: unknown, props: Record<string, unknown>) {
  return mount(comp as never, {
    props,
    global: {
      provide: mockChatProvide({ renderMarkdown: mockRenderMarkdown }),
      stubs: { MermaidRenderer: MermaidStub, AmbiguousFilePopover: AmbiguousPopoverStub },
    },
  })
}

describe('W1: MarkdownRenderer variant="thinking" 降级样式', () => {
  it('variant="thinking" → root div 含 .md-render--thinking class', async () => {
    mockMarkdownSegments('<p>test</p>')
    const wrapper = mountWithDeps(MarkdownRenderer, { content: 'test', variant: 'thinking' })
    await nextTick()
    await nextTick()
    // 关键断言：thinking 变体在 root 加 class（当前无 variant prop，红灯）
    expect(wrapper.find('.md-render--thinking').exists()).toBe(true)
  })

  it('默认（无 variant）→ root 不含 .md-render--thinking class（向后兼容）', async () => {
    mockMarkdownSegments('<p>test</p>')
    const wrapper = mountWithDeps(MarkdownRenderer, { content: 'test' })
    await nextTick()
    await nextTick()
    // 无 variant 时不应加 thinking class（现有 7 处调用零影响）
    expect(wrapper.find('.md-render--thinking').exists()).toBe(false)
  })
})

describe('W2: Block thinking 块走 MarkdownRenderer（不再纯文本插值）', () => {
  it('thinking 内容 **粗体** → 渲染为 <strong> 元素（非字面星号）', async () => {
    mockMarkdownSegments('<p>这是<strong>粗体</strong>内容</p>')
    // working=false + collapsed=false 才会渲染 .trace-think-body（MarkdownRenderer）
    // working=true 时内容在 header 行内联显示（plain text），不走 MarkdownRenderer
    const wrapper = mountWithDeps(Block, {
      type: 'thinking',
      content: '这是**粗体**内容',
      working: false,
      collapsed: false,
    })
    await nextTick()
    await nextTick()
    // 关键断言：thinking 内容走 markdown 渲染后，<strong> 元素存在于 DOM
    expect(wrapper.find('strong').exists()).toBe(true)
    expect(wrapper.text()).toContain('粗体')
    // 展开后预览文本用 invisible 隐藏（占位不显示），原始 ** 仍在 DOM 但不可见
    // 检查 preview span 有 invisible class（而非断言 ** 不在文本中）
    const previewSpan = wrapper.find('.text-neutral-dim.invisible')
    expect(previewSpan.exists()).toBe(true)
  })

  it('thinking 内容无全局 italic（md 结构 + italic 可读性差）', async () => {
    mockMarkdownSegments('<p>test</p>')
    // working=false + collapsed=false 才渲染 .trace-think-body
    const wrapper = mountWithDeps(Block, {
      type: 'thinking',
      content: 'test',
      working: false,
      collapsed: false,
    })
    await nextTick()
    await nextTick()
    // 当前实现有 italic class（红灯——改后应移除）
    const italicEls = wrapper.findAll('.italic')
    expect(italicEls.length).toBe(0)
  })
})
