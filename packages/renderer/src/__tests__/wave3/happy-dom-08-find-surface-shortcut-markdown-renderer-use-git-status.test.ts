import { bindTestSession, containerStates, keyEvent, openBottom, openRight, openWorkflowOverlay, resetOrchestratorFixtures, startOrchestrator } from '@/__tests__/composables/key-orchestrator/helpers';
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps';
import { useTtsSpeechEnabled } from '@/components/settings/tts/use-tts-enabled';
import { handleCmdWShortcut } from '@/composables/features/app/key-orchestrator';
import { registerModalSurface, resetModalSurfaceRegistry } from '@/composables/features/app/modal-surface-registry';
import { useGitStatus } from '@/composables/features/file-tree/useGitStatus';
import { useFindInSurface } from '@/composables/features/find/useFindInSurface';
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps';
import { triggerSessionCleanups, __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState';
import { useChatStore } from '@/stores/chat';
import type { Message, GitStatusResult } from '@taiji/shared';
import { type IncrementalMarkdownCache, type IncrementalMarkdownResult, type MarkdownSegment, MarkdownRenderer } from '@taiji/ui';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { nextTick, h, effectScope, ref, defineComponent } from 'vue';

// wave3 簇 [renderer/happy-dom] 3 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/composables/key-orchestrator/find-surface-shortcut.test.ts
 * - __tests__/composables/markdown-renderer.test.ts
 * - __tests__/composables/use-git-status.test.ts
 */

// ======================================================================
// ← __tests__/composables/key-orchestrator/find-surface-shortcut.test.ts
// ======================================================================

// ── cmdw-shortcut 节 mock：windowClose IPC spy（onShortcut 占位）──
const windowClose = vi.fn(() => Promise.resolve())
vi.mock('@/lib/ipc', () => ({
  onShortcut: () => () => {},
  windowClose: () => windowClose(),
}))

// ═══ 来源节：find-surface-shortcut.test.ts —— Ctrl+F 表面内查找 + Esc 先关查找框 ═══
describe('find-surface-shortcut', () => {
  beforeEach(() => {
    resetOrchestratorFixtures()
    bindTestSession()
  })

  afterEach(() => {
    resetOrchestratorFixtures()
    useFindInSurface().close()
    document.body.innerHTML = ''
  })


  /** 「触发查找快捷键 → 消费 + 开面 + 表面类型」断言单源（返回事件与 find 句柄供补断言）。 */
  function expectFindShortcutTriggered(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }, kind: string) {
    const e = keyEvent(init.key, init)
    window.dispatchEvent(e)
    const find = useFindInSurface()
    expect(e.defaultPrevented).toBe(true)
    expect(find.isOpen.value).toBe(true)
    expect(find.surfaceKind.value).toBe(kind)
    return find
  }

  /** 可搜表面桩（OverlayShell/PanelContainer 同款属性值；归属判定读该标记） */
  function appendSurface(kind: string): void {
    const el = document.createElement('div')
    el.setAttribute('data-find-surface', kind)
    document.body.appendChild(el)
  }

  function pressEsc(): KeyboardEvent {
    const e = keyEvent('Escape')
    window.dispatchEvent(e)
    return e
  }

  describe('Ctrl+F 表面内查找（find-in-surface 接线）', () => {
    it('Cmd+F：悬停缺省走回退栈序开最上层可搜表面（overlay）+ 消费事件 + 送达聚焦意图', () => {
      openWorkflowOverlay()
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      const find = expectFindShortcutTriggered({ key: 'f', metaKey: true }, 'overlay')
      expect(find.focusTick.value, 'focusTick 自增 = FindBar 聚焦意图已送达').toBe(1)
      stop()
    })

    it('Ctrl+F：同款触发（双平台同触，metaKey||ctrlKey 无平台分支）', () => {
      appendSurface('bottom-drawer')
      const { stop } = startOrchestrator()

      expectFindShortcutTriggered({ key: 'f', ctrlKey: true }, 'bottom-drawer')
      stop()
    })

    // 大写 'F' 回归：Shift 按下时 e.key 为大写，键名判定须大小写不敏感（漏判即快捷键失灵）
    it('Shift+Cmd+F（大写 F）：触发查找', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      expectFindShortcutTriggered({ key: 'F', metaKey: true, shiftKey: true }, 'overlay')
      stop()
    })

    it('Ctrl+Shift+F（大写 F）：同款触发', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      expectFindShortcutTriggered({ key: 'F', ctrlKey: true, shiftKey: true }, 'overlay')
      stop()
    })

    it('先行档已消费（defaultPrevented）→ 不动作（不重复开查找）', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      const e = keyEvent('f', { metaKey: true })
      e.preventDefault()
      window.dispatchEvent(e)

      const find = useFindInSurface()
      expect(find.isOpen.value).toBe(false)
      stop()
    })

    it('无修饰键的 f：纯文本输入键不触发查找、不吞事件', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      const e = keyEvent('f')
      window.dispatchEvent(e)

      expect(e.defaultPrevented).toBe(false)
      expect(useFindInSurface().isOpen.value).toBe(false)
      stop()
    })

    it('IME 组合态：检查统一前置，Ctrl+F 不动作', () => {
      appendSurface('overlay')
      const { stop } = startOrchestrator()

      window.dispatchEvent(keyEvent('f', { metaKey: true, isComposing: true }))

      expect(useFindInSurface().isOpen.value).toBe(false)
      stop()
    })
  })

  describe('Esc：查找框是临时覆盖层，先于容器剥层', () => {
    it('查找框开着：Esc 先关查找框（消费事件），容器层不被穿透关闭；再按 Esc 才剥层', () => {
      openBottom()
      const find = useFindInSurface()
      find.open('bottom-drawer')
      const { stop } = startOrchestrator()

      const e1 = pressEsc()
      expect(e1.defaultPrevented).toBe(true)
      expect(find.isOpen.value, 'Esc 先关查找框').toBe(false)
      expect(find.surfaceKind.value).toBe('')
      expect(containerStates().bottom, '容器层不随第一次 Esc 关闭').toBe(true)

      pressEsc()
      expect(containerStates().bottom, '查找框已关，第二次 Esc 正常剥容器层').toBe(false)
      stop()
    })

    it('查找框关态基线：Esc 照常剥层（不吞无查找现场的事件）', () => {
      openBottom()
      const { stop } = startOrchestrator()

      const e = pressEsc()
      expect(e.defaultPrevented).toBe(true)
      expect(containerStates().bottom).toBe(false)
      stop()
    })
  })
})

// ═══ 来源节：cmdw-shortcut.test.ts —— ⌘W 双键让位 + 层级序 + 全关后关窗 ═══
describe('cmdw-shortcut', () => {
  beforeEach(() => {
    resetOrchestratorFixtures()
    bindTestSession()
    windowClose.mockClear()
  })

  afterEach(() => {
    resetOrchestratorFixtures()
    resetModalSurfaceRegistry()
  })

  describe('⌘W：yields⌘W 让位 + 层级序逐层关 + 全关后关窗', () => {
    it('全关后 ⌘W 才关窗（不多关不早关）', () => {
      openRight()
      handleCmdWShortcut()
      expect(windowClose, '容器开着时 ⌘W 关容器不关窗').not.toHaveBeenCalled()
      expect(containerStates().right).toBe(false)

      handleCmdWShortcut()
      expect(windowClose, '全关后再 ⌘W 才关窗').toHaveBeenCalledTimes(1)
    })

    it('三容器全开：⌘W 沿同一层级序逐层关（浮层 → 底抽屉 → 右抽屉），全关后关窗', () => {
      openBottom()
      openRight()
      openWorkflowOverlay()

      handleCmdWShortcut()
      expect(containerStates()).toEqual({ overlay: false, bottom: true, right: true })
      handleCmdWShortcut()
      expect(containerStates()).toEqual({ overlay: false, bottom: false, right: true })
      handleCmdWShortcut()
      expect(containerStates()).toEqual({ overlay: false, bottom: false, right: false })
      expect(windowClose).not.toHaveBeenCalled()

      handleCmdWShortcut()
      expect(windowClose).toHaveBeenCalledTimes(1)
    })

    it('设置页（yieldsCmdW ✓）开着：⌘W 无动作——窗口不关、容器不动、模态不动（S7 让位检查）', () => {
      const dispose = registerModalSurface({
        surface: 'settings-modal',
        key: 'cmdw-settings',
        isOpen: () => true,
      })
      openBottom()
      openRight()

      handleCmdWShortcut()
      expect(windowClose).not.toHaveBeenCalled()
      expect(containerStates(), '两个容器原样保持').toEqual({ overlay: false, bottom: true, right: true })
      dispose()
    })

    it('Select 下拉（弹出层族 yieldsCmdW ✗）开着：⌘W 照常按层级序关最外层容器（非死键，R4 双键拆分）', () => {
      const dispose = registerModalSurface({
        surface: 'select-content',
        key: 'cmdw-select',
        isOpen: () => true,
      })
      openBottom()

      handleCmdWShortcut()
      expect(containerStates().bottom, '弹层族不让 ⌘W——照常关底抽屉').toBe(false)
      expect(windowClose).not.toHaveBeenCalled()
      dispose()
    })

    it('双键拆分对照（§6.7 R4）：同一弹出层族开着 Esc 让位而 ⌘W 动作', () => {
      const dispose = registerModalSurface({
        surface: 'popover-content',
        key: 'cmdw-popover',
        isOpen: () => true,
      })
      openBottom()
      const { stop } = startOrchestrator()

      window.dispatchEvent(keyEvent('Escape'))
      expect(containerStates().bottom, 'Esc 让位（弹层是视觉最外层，Esc 先关弹层）').toBe(true)

      handleCmdWShortcut()
      expect(containerStates().bottom, '⌘W 不让位（防弹层开态 ⌘W 死键）').toBe(false)
      stop()
      dispose()
    })
  })
})

// ======================================================================
// ← __tests__/composables/markdown-renderer.test.ts
// ======================================================================

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
      await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled(), { interval: 1 })

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
      await vi.waitFor(() => expect(loadFileCandidatesMock).toHaveBeenCalled(), { interval: 1 })

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

// ======================================================================
// ← __tests__/composables/use-git-status.test.ts
// ======================================================================

// ── mock gitApi ──
const statusMock = vi.hoisted(() => vi.fn())
const stageMock = vi.hoisted(() => vi.fn())
const unstageMock = vi.hoisted(() => vi.fn())
const commitMock = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  git: {
    status: statusMock,
    stage: stageMock,
    unstage: unstageMock,
    commit: commitMock,
  },
}))

// ── mock useSessionEvents：返回 onMessage 注册器，handler 收集到 Map 供测试手动触发 ──
const handlers = vi.hoisted(() => new Map<string, () => void>())
vi.mock('@/composables/features/chat/useSessionEvents', () => ({
  useSessionEvents: () => (event: string, fn: () => void) => {
    handlers.set(event, fn)
  },
}))

// ── 共享测试基建 ──

const SID_A = 'session-a'
const SID_B = 'session-b'

function makeGitResult(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    branch: 'main',
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    hasConflict: false,
    ahead: 0,
    behind: 0,
    ...overrides,
  } as GitStatusResult
}

const mountedWrappers: VueWrapper[] = []

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
  git: ReturnType<typeof import('@/composables/features/file-tree/useGitStatus').useGitStatus>
}

function mountHost(initialSid: string | null): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  const wrapper = mount(
    defineComponent({
      setup() {
        const git = useGitStatus(sidRef)
        return { git }
      },
      render: () => h('div'),
    }),
  )
  mountedWrappers.push(wrapper)
  const candidate = (wrapper.vm as { git?: unknown }).git
  if (!candidate || typeof candidate !== 'object' || !('result' in candidate)) {
    throw new Error('host 组件未暴露 git')
  }
  return { sidRef, git: candidate as HostHandle['git'] }
}

/** 排空在途异步链 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

beforeEach(() => {
  handlers.clear()
  statusMock.mockReset()
  stageMock.mockReset()
  unstageMock.mockReset()
  commitMock.mockReset()
  // 默认 status 返回空仓库结果
  statusMock.mockResolvedValue(makeGitResult())
  __clearSessionCleanupRegistryForTest()
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
})

// ── 测试用例 ──

describe('useGitStatus per-session 隔离（ADR-0049 迁移回归）', () => {
  it('同实例切换 sessionId 后，A 的 result 不泄漏到 B', async () => {
    const resultA = makeGitResult({ stagedCount: 3, branch: 'feat-a' })
    statusMock.mockImplementation((sid: string) => {
      if (sid === SID_A) return Promise.resolve(resultA)
      return Promise.resolve(makeGitResult())
    })

    const host = mountHost(SID_A)
    await settle() // immediate watch → refresh() → status(SID_A)

    expect(host.git.result.value).toEqual(resultA)

    // 切到 B：B 分区应为 init 默认值（result=null），不被 A 污染
    host.sidRef.value = SID_B
    await settle() // watch → refresh() → status(SID_B)

    // B 的 result 是 status(SID_B) 返回值，不是 A 的数据
    expect(host.git.result.value).toEqual(makeGitResult())
    expect(host.git.result.value?.branch).not.toBe('feat-a')
  })

  it('同实例切换 sessionId 后，A 的 commitMsg 不泄漏到 B', async () => {
    const host = mountHost(SID_A)
    await settle()

    // A 设置 commitMsg
    host.git.commitMsg.value = 'feat: add feature A'
    expect(host.git.commitMsg.value).toBe('feat: add feature A')

    // 切到 B：B 的 commitMsg 应为空（init 默认值）
    host.sidRef.value = SID_B
    await settle()
    expect(host.git.commitMsg.value).toBe('')

    // 切回 A：A 的 commitMsg 应保留
    host.sidRef.value = SID_A
    await settle()
    expect(host.git.commitMsg.value).toBe('feat: add feature A')
  })

  it('同实例切换 sessionId 后，A 的 error 不泄漏到 B', async () => {
    statusMock.mockImplementation((sid: string) => {
      if (sid === SID_A) return Promise.reject(new Error('git fatal: not a repo'))
      return Promise.resolve(makeGitResult())
    })

    const host = mountHost(SID_A)
    await settle() // immediate watch → refresh() → 失败 → error 写入 A 分区

    expect(host.git.error.value).toBe('git fatal: not a repo')

    // 切到 B：B 的 error 应为空（init 默认值）
    host.sidRef.value = SID_B
    await settle()
    expect(host.git.error.value).toBe('')

    // 切回 A：A 的 error 应保留（分区不丢数据）
    host.sidRef.value = SID_A
    await settle()
    // refresh 会再次调用 status(SID_A)，仍失败，error 重写
    expect(host.git.error.value).toBe('git fatal: not a repo')
  })

  it('commit 操作后 commitMsg 清空只影响当前 session 分区', async () => {
    statusMock.mockResolvedValue(makeGitResult({ stagedCount: 1 }))
    stageMock.mockResolvedValue(undefined)
    commitMock.mockResolvedValue(undefined)

    const host = mountHost(SID_A)
    await settle()

    // A 设置 commitMsg 并提交
    host.git.commitMsg.value = 'feat: test commit'
    await host.git.commit()
    await settle()

    expect(host.git.commitMsg.value).toBe('') // commit 后清空

    // 设置 B 的 commitMsg
    host.sidRef.value = SID_B
    await settle()
    host.git.commitMsg.value = 'fix: B 的修复'
    expect(host.git.commitMsg.value).toBe('fix: B 的修复')

    // 切回 A：A 的 commitMsg 应为空（commit 后已清空，不受 B 影响）
    host.sidRef.value = SID_A
    await settle()
    expect(host.git.commitMsg.value).toBe('')
  })

  it('stageAll/unstageAll 操作写入当前 session 分区', async () => {
    const resultAfterStage = makeGitResult({ stagedCount: 5, unstagedCount: 0 })
    statusMock.mockResolvedValue(makeGitResult({ stagedCount: 0, unstagedCount: 5 }))
    stageMock.mockResolvedValue(undefined)

    // 第二次 status 调用返回 stage 后结果
    let statusCallCount = 0
    statusMock.mockImplementation(() => {
      statusCallCount++
      if (statusCallCount <= 1) return Promise.resolve(makeGitResult({ stagedCount: 0, unstagedCount: 5 }))
      return Promise.resolve(resultAfterStage)
    })

    const host = mountHost(SID_A)
    await settle()

    await host.git.stageAll()
    await settle()

    expect(host.git.result.value).toEqual(resultAfterStage)
  })

  it('triggerSessionCleanups 后分区重置为 init 默认值', async () => {
    const resultA = makeGitResult({ stagedCount: 3 })
    statusMock.mockResolvedValue(resultA)

    const host = mountHost(SID_A)
    await settle()

    expect(host.git.result.value).toEqual(resultA)
    host.git.commitMsg.value = 'test'
    expect(host.git.commitMsg.value).toBe('test')

    // 清理 session A
    triggerSessionCleanups(SID_A)

    // 分区被清理，current 回到 init 默认值
    expect(host.git.result.value).toBeNull()
    expect(host.git.commitMsg.value).toBe('')
    expect(host.git.error.value).toBe('')
  })

  it('canCommit 依赖 commitMsg 和 pending 和 hasConflict（per-session 语义）', async () => {
    statusMock.mockResolvedValue(makeGitResult({ hasConflict: false, stagedCount: 1 }))

    const host = mountHost(SID_A)
    await settle()

    // 空 commitMsg → 不能提交
    expect(host.git.canCommit.value).toBe(false)

    // 有 commitMsg → 可提交
    host.git.commitMsg.value = 'test'
    expect(host.git.canCommit.value).toBe(true)

    // 切到 B（B 的 commitMsg 为空）→ 不能提交
    host.sidRef.value = SID_B
    await settle()
    expect(host.git.canCommit.value).toBe(false)

    // 切回 A（A 的 commitMsg 仍在）→ 可提交
    host.sidRef.value = SID_A
    await settle()
    expect(host.git.canCommit.value).toBe(true)
  })

  it('state/indicator 四态派生依赖 result 分区（per-session）', async () => {
    // A 有 conflict
    statusMock.mockImplementation((sid: string) => {
      if (sid === SID_A) return Promise.resolve(makeGitResult({ hasConflict: true }))
      return Promise.resolve(makeGitResult({ unstagedCount: 2 }))
    })

    const host = mountHost(SID_A)
    await settle()

    expect(host.git.state.value).toBe('conflict')
    expect(host.git.indicator.value.conflict).toBe(true)

    // 切到 B：B 是 dirty
    host.sidRef.value = SID_B
    await settle()

    expect(host.git.state.value).toBe('dirty')
    expect(host.git.indicator.value.dirty).toBe(true)
    expect(host.git.indicator.value.conflict).toBe(false)
  })

  it('message.complete 事件触发 refresh（幂等刷新，保持现状）', async () => {
    statusMock.mockResolvedValue(makeGitResult({ stagedCount: 1 }))

    const host = mountHost(SID_A)
    await settle()

    // 模拟 message.complete 事件
    const handler = handlers.get('message.complete')
    expect(handler).toBeDefined()
    handler!()
    await settle()

    // refresh 被调用（status 至少 2 次：immediate + message.complete）
    expect(statusMock).toHaveBeenCalledTimes(2)
  })
})
