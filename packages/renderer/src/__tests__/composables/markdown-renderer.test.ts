/**
 * MarkdownRenderer 组件单测（segments 模式）。
 *
 * 测试设计（修正 W4 的 mock 失败：不再 mock 掉 mermaid 核心假装通过）：
 *  - mock deps.renderMarkdown：返回可控 segments（text/mermaid 交替），验证 MarkdownRenderer
 *    正确分发——text 段渲染为 v-html 内容，mermaid 段渲染为 <MermaidRenderer> 组件。
 *  - MermaidRenderer stub：合理（测的是 MarkdownRenderer 的 segment 分发，不是 mermaid 渲染本身；
 *    mermaid 真实渲染在 happy-dom 必返回空，无法单测——见 mermaid-real 测试已证）。
 *  - 事件委托（复制/外链/文件路径）覆盖。
 *
 * [w6 chat-ui-and-shell T7] ui 包 MarkdownRenderer 经 ChatViewDeps inject 消费依赖：
 *  - renderMarkdown 注入替代 vi.mock('@/composables/logic/markdown')（renderMarkdownSegments 迁 renderer 壳）
 *  - MermaidRenderer/AmbiguousFilePopover 按组件名 stub（ui 包内部相对 import，vi.mock 旧路径无法命中）
 *  - 行为差异（迁移遗留，已报告）：① 外链 http(s) 点击不再走 drawer browser tab（ui onClick 简化版
 *    默认冒泡，不拦截）；② 含 / 路径点击不再做 fileApi.read 预检查 + searchModal fallback
 *    （该逻辑原在 renderer useMarkdownInteractions，已于 2026-09-11 随死代码删除）。U13/U14 断言按新行为改写。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/markdown-renderer.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, h } from 'vue'
import type { MarkdownSegment } from '@taiji/ui'
import { MarkdownRenderer } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

// deps.renderMarkdown stub：每个测试设置返回值，聚焦 MarkdownRenderer 的 segment 分发。
const mockRenderMarkdown = vi.fn()

/** MermaidRenderer stub：捕获 source prop（验证 mermaid segment 传递 source） */
const mockMermaidSource = vi.fn()
const MermaidStub = {
  name: 'MermaidRenderer',
  props: ['source'],
  setup(props: { source: string }) {
    mockMermaidSource(props.source)
    // 用 render 函数（Vue 3 需 h()），渲染带标识的 div 验证挂载
    return () => h('div', { class: 'stub-mermaid' }, props.source)
  },
}

/** AmbiguousFilePopover stub（歧义浮层，测 segment 分发时不渲染真实浮层）。
 *  返回注释 vnode（不占 .md-render 直接子节点，避免影响 U11 的子节点计数断言） */
const AmbiguousPopoverStub = { name: 'AmbiguousFilePopover', render: () => null }

// 事件委托回调断言（ui 组件经 deps 桥接）
const mockOpenDrawer = vi.fn()
const mockOnFileClick = vi.fn()
const mockOnAmbiguousSelect = vi.fn()

function encodeB64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary)
}

function mountMd(props: Record<string, unknown> = {}) {
  return mount(MarkdownRenderer, {
    props: props as never,
    global: {
      provide: mockChatProvide({
        renderMarkdown: mockRenderMarkdown,
        openDrawer: mockOpenDrawer,
        onFileClick: mockOnFileClick,
        onAmbiguousSelect: mockOnAmbiguousSelect,
      }),
      stubs: { MermaidRenderer: MermaidStub, AmbiguousFilePopover: AmbiguousPopoverStub },
    },
  })
}

describe('MarkdownRenderer（segments 模式）', () => {
  // H2 后 watch 改用 rAF 调度渲染。这些既有用例不验证节流时序，只需 rAF 回调同步执行
  // （mount 后 nextTick 即渲染完成）。H2 节流用例在下方独立 describe 用手动控制 rAF。
  let originalRAF: typeof requestAnimationFrame
  let originalCAF: typeof cancelAnimationFrame
  beforeAll(() => {
    originalRAF = globalThis.requestAnimationFrame
    originalCAF = globalThis.cancelAnimationFrame
    // 同步执行 rAF 回调（非节流场景：mount 后立即渲染，nextTick 后 DOM 就绪）
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
  })
  afterAll(() => {
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
  })

  beforeEach(() => {
    mockRenderMarkdown.mockReset()
    mockMermaidSource.mockReset()
    mockOpenDrawer.mockReset()
    mockOnFileClick.mockReset()
    mockOnAmbiguousSelect.mockReset()
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  })

  it('U9: text segment 渲染为 v-html（代码块语言标签+复制按钮可见，DoD 渲染 gate）', async () => {
    const code = 'const x = 1'
    const textSeg: MarkdownSegment = {
      type: 'text',
      content: `<div class="md-codeblock"><div class="md-codeblock__header"><span class="md-codeblock__lang">typescript</span><button class="md-codeblock__copy" data-code="${encodeB64(code)}" type="button"></button></div><pre class="shiki"><code>${code}</code></pre></div>`,
    }
    mockRenderMarkdown.mockResolvedValue([textSeg])
    const wrapper = mountMd({ content: 'x' })
    await nextTick()
    await nextTick()
    expect(wrapper.find('.md-codeblock__lang').exists()).toBe(true)
    expect(wrapper.find('.md-codeblock__lang').text()).toBe('typescript')
    expect(wrapper.find('.md-codeblock__copy').exists()).toBe(true)
  })

  it('U10: mermaid segment 渲染为 MermaidRenderer 组件（source 传递）', async () => {
    const mermaidSrc = 'graph TD;A-->B'
    mockRenderMarkdown.mockResolvedValue([{ type: 'mermaid', content: mermaidSrc }])
    const wrapper = mountMd({ content: 'x' })
    await nextTick()
    await nextTick()
    expect(mockMermaidSource).toHaveBeenCalledWith(mermaidSrc)
    expect(wrapper.find('.stub-mermaid').exists()).toBe(true)
  })

  it('U11: text + mermaid + text 段交替，顺序保留', async () => {
    mockRenderMarkdown.mockResolvedValue([
      { type: 'text', content: '<p>前文</p>' },
      { type: 'mermaid', content: 'graph TD;A-->B' },
      { type: 'text', content: '<p>后文</p>' },
    ] as MarkdownSegment[])
    const wrapper = mountMd({ content: 'x' })
    await nextTick()
    await nextTick()
    const allBlocks = wrapper.findAll('.md-render > *')
    // text(div v-html) + stub-mermaid + text(div v-html) = 3 个直接子节点
    expect(allBlocks.length).toBe(3)
    expect(mockMermaidSource).toHaveBeenCalledWith('graph TD;A-->B')
  })

  it('U12: 点代码块复制按钮 → clipboard 写入解码内容 + is-copied 反馈', async () => {
    const code = 'hello world'
    mockRenderMarkdown.mockResolvedValue([
      { type: 'text', content: `<button class="md-codeblock__copy" data-code="${encodeB64(code)}" type="button"></button>` },
    ] as MarkdownSegment[])
    const wrapper = mountMd({ content: 'x' })
    await nextTick()
    await nextTick()
    const btn = wrapper.find('.md-codeblock__copy')
    await btn.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code)
    expect(btn.classes()).toContain('is-copied')
  })

  it('U13: 点外链 → 不拦截（ui onClick 简化版默认冒泡；旧 drawer browser 行为迁遗留，见文件头注释）', async () => {
    mockRenderMarkdown.mockResolvedValue([
      { type: 'text', content: '<a href="https://example.com">link</a>' },
    ] as MarkdownSegment[])
    const wrapper = mountMd({ content: 'x' })
    await nextTick()
    await nextTick()
    await wrapper.find('a[href="https://example.com"]').trigger('click')
    // 新行为：ui MarkdownRenderer onClick 只处理 copy/filepath/ambiguous，外链默认冒泡
    expect(mockOpenDrawer).not.toHaveBeenCalled()
    expect(mockOnFileClick).not.toHaveBeenCalled()
  })

  it('U14: 点文件路径 → deps.onFileClick + openDrawer(detail, {filePath})', async () => {
    const path = 'src/foo.ts'
    mockRenderMarkdown.mockResolvedValue([
      { type: 'text', content: `<a class="md-filepath" data-path="${encodeB64(path)}">src/foo.ts</a>` },
    ] as MarkdownSegment[])
    const wrapper = mountMd({ content: 'x', sessionId: 's1' })
    await nextTick()
    await nextTick()
    await wrapper.find('.md-filepath').trigger('click')
    // ui 组件 onClick ②：直接 onFileClick + openDrawer（无 file.read 预检查，见文件头注释）
    expect(mockOnFileClick).toHaveBeenCalledWith(path)
    expect(mockOpenDrawer).toHaveBeenCalledWith('detail', { filePath: path })
  })

  it('U15: 空内容 → segments 空，不渲染不挂载', async () => {
    mockRenderMarkdown.mockResolvedValue([])
    const wrapper = mountMd({ content: '' })
    await nextTick()
    expect(wrapper.find('.md-codeblock').exists()).toBe(false)
    expect(wrapper.find('.stub-mermaid').exists()).toBe(false)
    expect(mockMermaidSource).not.toHaveBeenCalled()
  })
})

/**
 * H2：MarkdownRenderer watch rAF trailing 节流（perf-streaming-md-throttle）。
 *
 * 背景：流式 text_delta/thinking_delta 每个 token 触发 watch → deps.renderMarkdown
 * 全量重解析。改造后 watch 内包 rAF trailing，一帧内多次 content 变化合并为单次渲染。
 *
 * 复用 M4 rAF mock 模式（use-chat-scroll.test.ts）：手动控制 rAF 调度，
 * 测试显式 flushRAF 触发回调，验证节流/trailing/卸载安全/异常恢复/同帧快照。
 *
 * 不变量（INVAR-H2）：
 * - INVAR-H2-1: 一帧内多次 content 变化 → renderMarkdown 调用 1 次（AC-1）
 * - INVAR-H2-2: rAF 执行时读最新 content（延迟求值，非调度时快照）（AC-2）
 * - INVAR-H2-3: 渲染异常 rafId 须复位，后续变更仍能调度（AC-6）
 * - INVAR-H2-4: 卸载 cancelAnimationFrame，flushRAF 后不触发已卸载组件渲染（AC-4）
 * - INVAR-H2-5: content+sessionId 透传（AC-7 同帧快照，localFiles 白名单已迁 renderer 壳 useChatViewDeps）
 */
describe('MarkdownRenderer · H2 rAF trailing 节流', () => {
  let rafCallbacks: FrameRequestCallback[]
  let originalRAF: typeof requestAnimationFrame
  let originalCAF: typeof cancelAnimationFrame

  beforeEach(() => {
    mockRenderMarkdown.mockReset()
    // 手动控制 rAF：收集回调，不自动执行（测试显式 flush）
    rafCallbacks = []
    originalRAF = globalThis.requestAnimationFrame
    originalCAF = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const handle = rafCallbacks.length
      rafCallbacks.push(cb)
      return handle
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((handle: number) => {
      if (rafCallbacks[handle] !== undefined) rafCallbacks[handle] = undefined as unknown as FrameRequestCallback
    }) as typeof cancelAnimationFrame
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
  })

  /** flush 所有 pending rAF 回调（跳过已被 cancel 的）。 */
  function flushRAF(): void {
    const pending = rafCallbacks.splice(0).filter((cb): cb is FrameRequestCallback => cb !== undefined)
    pending.forEach((cb) => cb(0))
  }

  /**
   * 等待 DOM 满足条件（nextTick 轮询，上限 20 轮）。
   *
   * 渲染赋值到达 DOM 的微任务跳数是实现细节（deps.renderMarkdown 是 async mock，赋值链
   * runRender → runFullRender → mock 每层 async 边界加一跳；U26 phase extraction 增加了跳数，
   * 曾使「固定 2 次 nextTick 后断言」确定性失败——触发已发生、update flush 落在断言之后）。
   * 测试契约是「flush 后 DOM 最终呈现期望内容」，不是固定 tick 数；最终断言保持原强度不变。
   */
  async function waitForDom(check: () => boolean): Promise<void> {
    for (let i = 0; i < 20 && !check(); i++) await nextTick()
  }

  it('H2-1 (AC-1): 一帧内 100 次 content 变化 → renderMarkdown 调用远小于 100（节流合并）', async () => {
    mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>x</p>' }])
    const wrapper = mountMd({ content: '' })
    // 首渲染（immediate watch）
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    // 重置计数，只统计流式阶段
    mockRenderMarkdown.mockClear()

    // 模拟流式：一帧内连续 100 次 content 变化（不 flush rAF）
    for (let i = 0; i < 100; i++) {
      await wrapper.setProps({ content: `token ${i}` })
    }
    flushRAF()
    await nextTick()
    await nextTick()

    // 关键断言（AC-1）：100 次变化，renderMarkdown 调用次数远小于 100。
    // 无节流时：每次 setProps → watch 立即调 → ≈100 次（红灯 fail）。
    // 节流后：合并到 ≤2 次（首帧 + trailing）。
    const totalCalls = mockRenderMarkdown.mock.calls.length
    expect(totalCalls).toBeLessThan(50)
    // 末次渲染用的是最新 content（INVAR-H2-2 延迟求值）
    const lastCallContent = mockRenderMarkdown.mock.calls.at(-1)?.[0]
    expect(lastCallContent).toBe('token 99')
  })

  it('H2-2 (AC-2): 末次 flush 后最终 content 完整渲染（trailing）', async () => {
    mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>final</p>' }])
    const wrapper = mountMd({ content: '' })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    mockRenderMarkdown.mockClear()

    await wrapper.setProps({ content: 'partial' })
    await wrapper.setProps({ content: 'final content' })
    flushRAF()
    await nextTick()
    await nextTick()

    // trailing 保证：最终渲染入参是末次 content（非 partial）
    const lastContent = mockRenderMarkdown.mock.calls.at(-1)?.[0]
    expect(lastContent).toBe('final content')
  })

  it('H2-3 (AC-3): 静态首渲染立即调度（rAF 排队，flush 后渲染）', async () => {
    mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>static</p>' }])
    const wrapper = mountMd({ content: 'static doc' })
    await nextTick()
    // immediate watch 触发 rAF 调度（rAF 不应为空——当前无节流实现时为空，红灯）
    expect(rafCallbacks.length).toBeGreaterThan(0)
    flushRAF()
    await nextTick()
    await nextTick()
    // 静态 content 渲染成功（sessionId 未传 → deps.renderMarkdown 第二参 undefined）
    expect(mockRenderMarkdown).toHaveBeenCalledWith('static doc', undefined)
  })

  it('H2-4 (AC-4): 卸载时 cancelAnimationFrame，flushRAF 后不触发已卸载组件渲染', async () => {
    mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>x</p>' }])
    const wrapper = mountMd({ content: 'a' })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    // 清掉首渲染的调用记录，便于断言卸载后净增
    mockRenderMarkdown.mockClear()

    // 触发新 content 变化 → 节流下排队 rAF
    await wrapper.setProps({ content: 'b' })

    // 卸载组件（应 cancelAnimationFrame）
    wrapper.unmount()
    // flush 残留 rAF（模拟 rAF 到点）——因已 cancel，回调已被置 undefined
    flushRAF()
    await nextTick()

    // 关键断言（AC-4）：卸载后 renderMarkdown 不被调用。
    // 无节流时：setProps 后 watch 立即调（同步），unmount 前已调用 → calls > 0 但 flushRAF 无影响。
    // 节流后：setProps 排队 rAF，unmount cancel，flushRAF 不触发 → calls === 0。
    expect(mockRenderMarkdown).not.toHaveBeenCalled()
  })

  it('H2-5 (AC-5): renderSeq 序号守卫保留——节流后连续渲染最终 DOM 为最新 content', async () => {
    mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>v1</p>' }])
    const wrapper = mountMd({ content: 'first' })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    // 首渲染成功
    expect(wrapper.find('.md-render > div').html()).toContain('v1')

    // 第二次：mock 返回新 segment + content 变化
    mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>v2-updated</p>' }])
    await wrapper.setProps({ content: 'second' })
    flushRAF()
    await nextTick()
    await nextTick()
    // 序号守卫：新渲染覆盖旧，DOM 是 v2（非 v1）
    expect(wrapper.find('.md-render > div').html()).toContain('v2-updated')
  })

  it('H2-6 (AC-6): renderMarkdown 抛错 → rafId 复位，后续变更仍能调度', async () => {
    // 首次抛错
    mockRenderMarkdown.mockRejectedValueOnce(new Error('shiki boom'))
    const wrapper = mountMd({ content: 'bad' })
    await nextTick()
    flushRAF()
    await waitForDom(() => wrapper.html().includes('bad'))
    // 降级：纯文本 segment 可见（escapeHtmlForFallback）
    expect(wrapper.find('.md-render > div').html()).toContain('bad')

    // 关键：抛错后 rafId 已复位 → 新 content 变化能重新调度 rAF
    mockRenderMarkdown.mockResolvedValueOnce([{ type: 'text', content: '<p>recovered</p>' }])
    await wrapper.setProps({ content: 'recovered' })
    flushRAF()
    await waitForDom(() => wrapper.html().includes('<p>recovered</p>'))
    // 后续渲染正常，显示新内容（非降级纯文本）
    expect(wrapper.find('.md-render > div').html()).toContain('<p>recovered</p>')
  })

  it('H2-7 (AC-7): sessionId 透传——同帧渲染入参带 sessionId（localFiles 白名单已迁 renderer 壳）', async () => {
    mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>x</p>' }])
    const wrapper = mountMd({ content: 'init', sessionId: 's1' })
    await nextTick()
    flushRAF()
    await nextTick()
    await nextTick()
    mockRenderMarkdown.mockClear()

    // content 变化（节流下排队 rAF，不立即渲染）
    await wrapper.setProps({ content: 'with link' })
    flushRAF()
    await nextTick()
    await nextTick()

    // deps.renderMarkdown 被调用时第二参是 sessionId（组件层透传；白名单快照由壳 useChatViewDeps 维护）
    expect(mockRenderMarkdown).toHaveBeenCalled()
    expect(mockRenderMarkdown.mock.calls.at(-1)?.[1]).toBe('s1')
  })
})
