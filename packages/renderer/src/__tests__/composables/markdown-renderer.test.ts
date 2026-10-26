/**
 * chat 视图渲染与依赖装配合并文件（簇 3-5 子集，2 源合一，DOM 环境）：
 * - markdown-renderer.test.ts —— MarkdownRenderer segments 分发 + rAF trailing 节流（零模块 mock）
 * - use-chat-view-deps.test.ts —— useChatViewDeps 装配器（useChat/useToast/useFileSearch/useTtsPlayer mock）
 *
 * 两源消费图零交集：markdown-renderer 图 = ui 包 + 测试 helper（ui 包不可达 renderer @/ 别名
 * 路径），四个 mock 只作用于 useChatViewDeps 图。rAF 改写均在 markdown-renderer 节内
 * beforeAll/afterAll 与 beforeEach/afterEach 自恢复，节后真时钟还原。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, h, effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { IncrementalMarkdownCache, IncrementalMarkdownResult, MarkdownSegment } from '@taiji/ui'
import { MarkdownRenderer } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import type { Message } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'
import { useTtsSpeechEnabled } from '@/components/settings/tts/use-tts-enabled'

// ── use-chat-view-deps 节 mock ──
// useChat（装配器解构 abortBash/editAndResend/revokeMessage）
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ abortBash: vi.fn(), editAndResend: vi.fn(), revokeMessage: vi.fn(() => Promise.resolve()) }),
}))
// toast（错误 toast spy，onSpeak 总开关拦截 toast 用例消费）
const toastErrorMock = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, info: vi.fn(), warning: vi.fn() }),
}))
// [RD-1#8] 文件白名单加载（file.search）可控失败/成功
const loadFileCandidatesMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: loadFileCandidatesMock }),
}))
// ai-voice-tts §5.1（u5 装配）：useTtsPlayer 三方法 spy，锁定 onSpeak 动作分流
const ttsSpeakMock = vi.hoisted(() => vi.fn())
const ttsStopMock = vi.hoisted(() => vi.fn())
const ttsStateMock = vi.hoisted(() => vi.fn(() => 'idle' as const))
vi.mock('@/composables/features/chat/useTtsPlayer', () => ({
  useTtsPlayer: () => ({ speak: ttsSpeakMock, stop: ttsStopMock, speakStateOf: ttsStateMock }),
}))

// ═══ 来源节：markdown-renderer.test.ts —— MarkdownRenderer segments 分发 + rAF trailing 节流 ═══
describe('markdown-renderer', () => {
  // deps.renderMarkdown stub：每个测试设置返回值，聚焦 MarkdownRenderer 的 segment 分发。
  // [D6 收敛] renderMarkdownIncremental 必填后渲染走增量通道：mountMd 内桥接把 renderMarkdown
  // 的段作为单帧增量 tail 返回（调用计数/入参断言仍落在 mockRenderMarkdown 上，语义不变）。
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

  function encodeB64(text: string): string {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    bytes.forEach((b) => (binary += String.fromCharCode(b)))
    return btoa(binary)
  }

  function mountMd(props: Record<string, unknown> = {}) {
    const renderMarkdownIncremental = vi.fn(
      async (source: string, cache: IncrementalMarkdownCache | null, sid?: string): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => ({
        prefixSegments: [],
        tailSegments: await mockRenderMarkdown(source, sid),
        stableBoundary: 0,
        mode: 'incremental' as const,
        cache: cache ?? { boundary: 0, prefixText: '', prefixSegments: [], nextSegId: 0 },
      }),
    )
    return mount(MarkdownRenderer, {
      props: props as never,
      global: {
        provide: mockChatProvide({
          renderMarkdown: mockRenderMarkdown,
          renderMarkdownIncremental,
          openDrawer: mockOpenDrawer,
          onFileClick: mockOnFileClick,
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

    it('H2-5 (AC-5): renderSeq 序号检查保留——节流后连续渲染最终 DOM 为最新 content', async () => {
      mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>v1</p>' }])
      const wrapper = mountMd({ content: 'first' })
      await nextTick()
      flushRAF()
      // D6 收敛后渲染链经增量桥接，async 边界加深一跳——按 waitForDom 契约轮询期望呈现，
      // 不钉固定 tick 数（同函数上方注释：固定 tick 会确定性失败）
      await waitForDom(() => wrapper.html().includes('v1'))
      // 首渲染成功
      expect(wrapper.find('.md-render > div').html()).toContain('v1')

      // 第二次：mock 返回新 segment + content 变化
      mockRenderMarkdown.mockResolvedValue([{ type: 'text', content: '<p>v2-updated</p>' }])
      await wrapper.setProps({ content: 'second' })
      flushRAF()
      await waitForDom(() => wrapper.html().includes('v2-updated'))
      // 序号检查：新渲染覆盖旧，DOM 是 v2（非 v1）
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
})

// ═══ 来源节：use-chat-view-deps.test.ts —— useChatViewDeps 装配器（白名单降级 + onSpeak 分流） ═══
describe('use-chat-view-deps', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  /** useChatViewDeps 内含 watch（immediate，订阅 sessionId）——scope 内装配，用例末 stop 防泄漏 */
  function setupDeps(sid: string): { deps: ReturnType<typeof useChatViewDeps>; stop: () => void } {
    const scope = effectScope()
    let deps!: ReturnType<typeof useChatViewDeps>
    scope.run(() => { deps = useChatViewDeps(ref(sid)) })
    return { deps, stop: () => scope.stop() }
  }

  describe('[RD-1#8] 文件白名单加载失败留痕（降级可见，非静默吞噬）', () => {
    it('file.search 失败 → console.warn 留痕 + 不抛错（白名单降级为空集的行为不变）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      loadFileCandidatesMock.mockRejectedValueOnce(new Error('file.search down'))
      const sid = 's-file-whitelist-fail'

      const { stop } = setupDeps(sid)
      await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())

      const first = String(warnSpy.mock.calls[0]?.[0])
      expect(first).toContain('[useChatViewDeps] file whitelist load failed for session')
      expect(first).toContain(sid)
      // 留痕携带原始错误（排障可定位）
      expect(warnSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error)

      stop()
      warnSpy.mockRestore()
    })

    it('file.search 成功 → 零 warn（不污染正常流的观测信号）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      loadFileCandidatesMock.mockResolvedValueOnce([])

      const { stop } = setupDeps('s-file-whitelist-ok')
      await vi.waitFor(() => expect(loadFileCandidatesMock).toHaveBeenCalled())

      expect(warnSpy).not.toHaveBeenCalled()
      stop()
      warnSpy.mockRestore()
    })
  })

  // ── ai-voice-tts §5.1（u5 装配）：onSpeak 动作分流 + speakStateOf 直通 ──────────
  describe('onSpeak 朗读装配（ai-voice-tts §5.1）', () => {
    const { setEnabled } = useTtsSpeechEnabled()

    /** assistant 消息 fixture（assistant content 为纯 string，ADR-0043） */
    function makeAssistant(id: string, content: string): Message {
      return { id, role: 'assistant', content, status: 'complete', timestamp: 0 }
    }

    it('idle 态点击 → speak(sid, messageId, 消息正文)，清洗由 useTtsPlayer 内部承担', () => {
      const { deps, stop } = setupDeps('s-tts')
      const msg = makeAssistant('a1', '需要朗读的正文')
      ttsStateMock.mockReturnValue('idle')

      deps.onSpeak!('s-tts', msg)

      expect(ttsSpeakMock).toHaveBeenCalledTimes(1)
      expect(ttsSpeakMock).toHaveBeenCalledWith('s-tts', 'a1', '需要朗读的正文')
      expect(ttsStopMock).not.toHaveBeenCalled()
      stop()
    })

    it('loading/playing 态点击 = 取消/停止 → 调 useTtsPlayer.stop，不重入 speak', () => {
      const { deps, stop } = setupDeps('s-tts-stop')
      const msg = makeAssistant('a2', '正在朗读中')
      ttsStateMock.mockReturnValue('playing')

      deps.onSpeak!('s-tts-stop', msg)

      expect(ttsStopMock).toHaveBeenCalledTimes(1)
      expect(ttsSpeakMock).not.toHaveBeenCalled()
      stop()
    })

    it('speakStateOf 查询直通 useTtsPlayer（按 messageId 映射三态）', () => {
      const { deps, stop } = setupDeps('s-tts-state')
      ttsStateMock.mockReturnValue('loading')

      expect(deps.speakStateOf!('a1')).toBe('loading')
      expect(ttsStateMock).toHaveBeenCalledWith('a1')
      stop()
    })

    // ── 朗读总开关（ai-voice-tts §5.2 通用配置：关闭后朗读按钮报「语音服务未配置」）──
    // use-tts-enabled 真模块不 mock（装配器与设置页消费同一模块级单例，测真实接线），
    // 经唯一写点 setEnabled 驱动；用例末恢复默认开启，不留状态给后续用例。
    it('总开关关闭：idle 态点击不发合成请求（speak 未被调 = 不发 RPC），toast「语音服务未配置」', () => {
      setEnabled(false)
      const { deps, stop } = setupDeps('s-tts-disabled')
      const msg = makeAssistant('a3', '开关关闭时的正文')
      ttsStateMock.mockReturnValue('idle')

      deps.onSpeak!('s-tts-disabled', msg)

      expect(ttsSpeakMock).not.toHaveBeenCalled()
      expect(toastErrorMock).toHaveBeenCalledTimes(1)
      expect(String(toastErrorMock.mock.calls[0][0])).toContain('语音服务未配置')
      setEnabled(true)
      stop()
    })

    it('关闭态下非 idle（playing）点朗读 = 停止，不受开关拦截（stop 照常被调）', () => {
      setEnabled(false)
      const { deps, stop } = setupDeps('s-tts-disabled-stop')
      const msg = makeAssistant('a4', '关闭开关也应能停止在播内容')
      ttsStateMock.mockReturnValue('playing')

      deps.onSpeak!('s-tts-disabled-stop', msg)

      expect(ttsStopMock).toHaveBeenCalledTimes(1)
      expect(ttsSpeakMock).not.toHaveBeenCalled()
      setEnabled(true)
      stop()
    })
  })
})
