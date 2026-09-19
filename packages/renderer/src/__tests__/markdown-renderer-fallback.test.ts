// @vitest-environment jsdom
// [U1 sanitize] DOMPurify 需要 nodeName getter 在 Node.prototype 上（realm 安全缓存 getter
// 依赖它）；happy-dom 把 nodeName 定义在各元素子类，DOMPurify 3.4.11 在 happy-dom 下把
// 所有元素判为不允许标签（P1 探针实证）——markdown 管线测试族统一跑 jsdom。
/**
 * MarkdownRenderer 渲染失败降级回归测试（W1）。
 *
 * 锁定 W1 改动：当 renderMarkdown 抛错（shiki 加载失败 / markdown-it 解析异常 /
 * mermaid 占位解码失败等）时，MarkdownRenderer 不能把消息气泡渲染成空白——
 * 必须降级为纯文本 segment（[{type:'text', content: escapeHtml(原文)}]），
 * 保证消息内容对用户可读（用户能看到原始文字，而不是一个空气泡）。
 *
 * [w6 chat-ui-and-shell T7] ui 包 MarkdownRenderer 经 deps.renderMarkdown inject 消费
 * （原 vi.mock('@/composables/logic/markdown') 失效），降级逻辑在 ui doRender catch 分支，
 * 测试改为 provide mock deps + 按组件名 stub MermaidRenderer/AmbiguousFilePopover。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/markdown-renderer-fallback.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { MarkdownRenderer } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

// deps.renderMarkdown stub：reject 模拟渲染失败（shiki/markdown-it 异常）
const mockRenderMarkdown = vi.fn()

function mountMd(props: Record<string, unknown>) {
  return mount(MarkdownRenderer, {
    props: props as never,
    global: {
      provide: mockChatProvide({ renderMarkdown: mockRenderMarkdown }),
      // AmbiguousFilePopover stub 返回注释 vnode（不占 .md-render 直接子节点，避免空内容计数断言受影响）
      stubs: {
        MermaidRenderer: true,
        AmbiguousFilePopover: { name: 'AmbiguousFilePopover', render: () => null },
      },
    },
  })
}

// H2 后 MarkdownRenderer watch 改用 rAF 调度渲染。此降级用例不验证节流时序，
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

describe('MarkdownRenderer 渲染失败降级为纯文本（W1）', () => {
  beforeEach(() => {
    mockRenderMarkdown.mockReset()
  })

  it('renderMarkdown reject 时 → 降级为纯文本 segment，内容可见', async () => {
    // 模拟渲染失败（shiki 加载异常等）
    mockRenderMarkdown.mockRejectedValue(new Error('shiki load failed'))
    const content = '这是一条普通消息内容'

    const wrapper = mountMd({ content })
    // watch 是 async（await renderMarkdown），多 tick 等 reject 落定
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言：降级后消息内容应在 DOM 中可见（当前 reject 后 segments=[]，DOM 空白，红灯）
    expect(wrapper.text()).toContain('这是一条普通消息内容')
  })

  it('降级 segment 是 text 类型（非 mermaid），走 v-html 安全渲染', async () => {
    mockRenderMarkdown.mockRejectedValue(new Error('parse error'))
    const content = 'hello world'

    const wrapper = mountMd({ content })
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言：降级应产出 text segment（非 mermaid），无 MermaidRenderer 渲染节点
    expect(wrapper.find('.stub-mermaid').exists()).toBe(false)
    // 内容可见（当前空白，红灯）
    expect(wrapper.text()).toContain('hello world')
  })

  it('降级时 HTML 特殊字符被转义（XSS 安全 + 可读）', async () => {
    mockRenderMarkdown.mockRejectedValue(new Error('boom'))
    // 内容含 HTML 特殊字符（模拟恶意 / 含代码尖括号的内容）
    const content = '<script>alert(1)</script> & <b>bold</b>'

    const wrapper = mountMd({ content })
    await nextTick()
    await nextTick()
    await nextTick()

    // 关键断言 1：原文文本可见（转义后仍是这些字符，只是不再被当 HTML 执行）
    expect(wrapper.text()).toContain('<script>alert(1)</script>')
    expect(wrapper.text()).toContain('<b>bold</b>')
    // 关键断言 2：降级 segment 走 v-html 但内容已转义，不会真的注入 <script> 元素
    // （若未转义，DOM 里会有一个真的 <script> 节点）
    expect(wrapper.find('script').exists()).toBe(false)
  })

  it('空内容不触发降级（空内容 segments=[] 是正常行为，非渲染失败）', async () => {
    // 空内容走早期 return（segments=[]），不应进入 catch 降级
    mockRenderMarkdown.mockRejectedValue(new Error('should not reach'))
    const wrapper = mountMd({ content: '' })
    await nextTick()
    await nextTick()

    // 空内容 → segments 空，DOM 无内容（正常行为，非降级路径，应通过）
    expect(wrapper.findAll('.md-render > *')).toHaveLength(0)
  })
})
