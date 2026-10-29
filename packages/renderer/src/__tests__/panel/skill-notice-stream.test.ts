/**
 * skill 注入提示呈现测试（composer-multi-skill-injection u5，场景 2③/2b②/3② + u5 验收条款）。
 *
 * 覆盖五组验收：
 * ① 降级两文案可区分渲染：budget_exceeded（「预算超限」）vs context_window_unavailable
 *    （「窗口信息获取失败」），同锚点 turn 各出一条内联行，文案互斥（场景 2③/2b②）。
 * ② 失效 toast + 内联提示：skill_missing → toast 含失效 skill 名 + 内联行含名字（场景 3②）；
 *    marker_malformed（skills 可空）→ 通用失效文案。
 * ③ 纯文本消息无提示（负面）：无 notice 时对话流不渲染任何 skill-notice-inline。
 * ④ 无 clientUuid 的 notice（steer/followUp）：不内联、不静默——降级类与失效类都降级为仅 toast。
 * ⑤ 多 session 隔离：session A 的提示不出现在 session B（Map 分区）；切回 A 仍在（ADR-0049 分区保留）。
 *
 * 挂载模式对齐 MessageStream-kind.test.ts：mock virtua（happy-dom 无布局）为全量渲染
 * scoped slot 的 stub，让模板 v-if 链对每项真实执行；chat deps mock 壳装配。
 * notice 触发走生产同一路径：api/events.dispatchSession（session 通道）——MessageStream 内
 * useSkillNoticeStream → useSessionEvents(events.on) 的真实订阅分发链路。
 *
 * 单文件多源合并（2 源同装载簇）：skill-notice-stream（本节，最大源）+ DetailPane.test
 * ——vitest 按测试文件隔离模块图，合并让全部用例共享一份组件树装载。DetailPane 节的
 * useChatViewDeps 由本文件壳 mock 提供（chatDepsMock = ChatViewDeps 全字段必填默认面，
 * DetailPane 断言不依赖 deps 真实行为，与原真实装配器等价）；未并入同簇的
 * composer-smoke.test.ts：其 useToast mock（无 toasts 字段）与本文件真实 useToast 断言
 * 构成同模块实质冲突，保持独立。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=panel pnpm vitest run src/__tests__/panel/skill-notice-stream.test.ts（本文件登记在 domain-map.json panel 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
// 必须置于 MessageStream import 之前：壳 deps 三连（useChatViewDeps / useChat / useSidebar）
// 经 message-stream-shell-mount 顶层注册，MessageStream 导入链触发注册时 helper 必须已初始化。
import '@/__tests__/helpers/message-stream-shell-mount'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import MessageStream from '@/components/panel/MessageStream.vue'
import DetailPane from '@/components/panel/DetailPane.vue'
import { useToast } from '@/composables/useToast'
import { dispatchSession } from '@taiji/core/transport/api'
import type { ServerMessage } from '@taiji/shared'
import type { SkillNoticeEntry } from '@/composables/panel/useSkillNoticeStream'
import { interleaveSkillNoticeItems } from '@/composables/panel/useSkillNoticeStream'

// ── virtua mock：全量渲染 scoped slot 的 stub（同 MessageStream-kind.test.ts）──────────
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        keepMounted: { type: Array, default: () => [] },
      },
      setup() {
        return {
          scrollSize: 600,
          scrollOffset: 0,
          viewportSize: 400,
          cache: {},
          scrollToIndex: vitest.fn(),
          getItemOffset: vitest.fn(() => 0),
          getItemSize: vitest.fn(() => 200),
          findItemIndex: vitest.fn(() => 0),
          scrollTo: vitest.fn(),
          scrollBy: vitest.fn(),
        }
      },
      render(ctx) {
        const data = ctx.data as unknown[]
        const indexes = new Set<number>((ctx.keepMounted as number[]) ?? [])
        for (let i = 0; i < data.length; i += 1) indexes.add(i)
        return h(
          'div',
          { class: 'mock-virtualizer' },
          [...indexes].flatMap((idx) => ctx.$slots.default?.({ item: data[idx], index: idx }) ?? []),
        )
      },
    }),
  }
})

// 壳 deps mock 经 message-stream-shell-mount import 顶层注册（本测聚焦 notice 呈现）

// ── DetailPane 节的 mock（useDetailPane 可控 fixture，__fixture 通道暴露给测试修改）──
const mockToggleView = vi.fn()
const mockActivateTab = vi.fn()
const mockCloseTab = vi.fn()
const mockSaveScroll = vi.fn()

// 可变 fixture：resourceBaseDir 传值矩阵用例在 mount 前改 path/cwd/kind。
// state 必须是真 ref（<script setup> 模板对 ref 绑定自动解包、普通对象不解包——
// 手写 { value } 形态会让 state.path 读成 undefined 误走 detail-empty 分支），
// 故在 mock 工厂内创建，经 __fixture 通道暴露给测试修改。
vi.mock('@/composables/features/file-tree/useDetailPane', async () => {
  const { ref } = await import('vue')
  const state = ref({
    path: 'src/index.ts',
    status: 'content',
    content: '',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'text',
  })
  const cwdHolder = { value: '/Users/demo/project' as string | null }
  // tab 条 fixture（S4 用例在 mount 前改 tabs/activePath；默认空 = 不渲染 tab 条）
  const tabs = ref<unknown[]>([])
  const activePath = ref<string | null>(null)
  return {
    useDetailPane: () => ({
      state,
      tabs,
      activePath,
      toggleView: mockToggleView,
      activateTab: mockActivateTab,
      closeTab: mockCloseTab,
      saveScroll: mockSaveScroll,
      sessionCwd: () => cwdHolder.value,
    }),
    __fixture: { state, cwdHolder, tabs, activePath },
  }
})

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const globalStubs = {
  Turn: {
    name: 'Turn',
    props: { turn: { type: Object, required: true }, canEdit: { type: Boolean, default: false } },
    template: `<div :data-testid="'turn-stub-' + turn.user?.id"><slot name="user" /></div>`,
  },
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div data-testid="bash-output-stub" />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

function userMsg(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    status: 'complete' as const,
    timestamp: Date.now(),
  }
}

/** 构造生产 wire 形态的 session.skillNotice 帧（payload 契约见 shared protocol.ts）。 */
function skillNoticeMsg(payload: {
  sessionId: string
  clientUuid?: string
  reason: SkillNoticeEntry['reason']
  skills: string[]
}): ServerMessage<'session.skillNotice'> {
  return { type: 'session.skillNotice', seq: 1, payload }
}

/** 经生产分发路径注入一条 notice（session 通道 dispatchSession → events.on 订阅者）。 */
function injectNotice(payload: Parameters<typeof skillNoticeMsg>[0]): void {
  dispatchSession(payload.sessionId, skillNoticeMsg(payload))
}

describe('skill 注入提示呈现（u5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    // toast 是模块级单例：用例间清空，防跨用例串扰（自动移除 timer 为 4s/8s，测试同步断言无竞争）
    useToast().toasts.value = []
  })

  it('① 降级两文案可区分：预算超限 vs 窗口信息获取失败（场景 2③/2b②）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-degrade', [userMsg('u-aaaa', '帮我 review 这段代码')])
    const wrapper = mountStream('sess-degrade')
    await wrapper.vm.$nextTick()

    injectNotice({ sessionId: 'sess-degrade', clientUuid: 'u-aaaa', reason: 'budget_exceeded', skills: ['a'] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    const degradeLine = wrapper.find('[data-testid="skill-notice-inline"][data-variant="degrade"]')
    expect(degradeLine.exists()).toBe(true)
    expect(degradeLine.text()).toContain('预算超限')
    expect(degradeLine.text()).toContain('标记模式')
    // 此处不得出现另一降级原因的文案（可区分性正断言）
    expect(degradeLine.text()).not.toContain('窗口信息获取失败')

    // 另一 session 的消息：窗口信息获取失败（fail-safe 降级，场景 2b）——两文案互斥可区分
    chat.hydrate('sess-degrade-2', [userMsg('u-bbbb', '第二条消息')])
    const wrapper2 = mountStream('sess-degrade-2')
    await wrapper2.vm.$nextTick()
    injectNotice({
      sessionId: 'sess-degrade-2',
      clientUuid: 'u-bbbb',
      reason: 'context_window_unavailable',
      skills: ['a'],
    })
    await wrapper2.vm.$nextTick()
    await wrapper2.vm.$nextTick()
    const windowLine = wrapper2.find('[data-testid="skill-notice-inline"][data-variant="degrade"]')
    expect(windowLine.exists()).toBe(true)
    expect(windowLine.text()).toContain('窗口信息获取失败')
    expect(windowLine.text()).not.toContain('预算超限')

    wrapper.unmount()
    wrapper2.unmount()
  })

  it('② 失效 toast + 消息内联提示，文案含失效 skill 名（场景 3②）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-invalid', [userMsg('u-cccc', '带 chip 的消息')])
    const wrapper = mountStream('sess-invalid')
    await wrapper.vm.$nextTick()

    injectNotice({
      sessionId: 'sess-invalid',
      clientUuid: 'u-cccc',
      reason: 'skill_missing',
      skills: ['ghost-skill'],
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 内联行：invalid 形态 + 含失效 skill 名
    const inline = wrapper.find('[data-testid="skill-notice-inline"][data-variant="invalid"]')
    expect(inline.exists()).toBe(true)
    expect(inline.text()).toContain('ghost-skill')
    expect(inline.text()).toContain('不存在')

    // toast 同步可见（D8 禁静默），文案含失效 skill 名
    const toasts = useToast().toasts.value
    expect(toasts.some((t) => t.type === 'warning' && t.message.includes('ghost-skill'))).toBe(true)

    wrapper.unmount()
  })

  it('②b marker_malformed（skills 可空）→ 通用失效文案 + toast', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-malformed', [userMsg('u-dddd', '被 hook 破坏的消息')])
    const wrapper = mountStream('sess-malformed')
    await wrapper.vm.$nextTick()

    injectNotice({ sessionId: 'sess-malformed', clientUuid: 'u-dddd', reason: 'marker_malformed', skills: [] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    const inline = wrapper.find('[data-testid="skill-notice-inline"][data-variant="invalid"]')
    expect(inline.exists()).toBe(true)
    expect(inline.text()).toContain('标记已损坏')
    expect(useToast().toasts.value.length).toBeGreaterThan(0)

    wrapper.unmount()
  })

  it('③ 纯文本消息无提示（负面）：无 notice 时对话流不渲染提示行', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-plain', [userMsg('u-eeee', '纯文本消息，无 skill chip')])
    const wrapper = mountStream('sess-plain')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 消息本身正常渲染
    expect(wrapper.find('[data-testid="turn-stub-u-eeee"]').exists()).toBe(true)
    // 无任何提示行
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('④ 无 clientUuid 的 notice（steer/followUp）：不内联、仅 toast，不报错不静默', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-anon', [userMsg('u-ffff', 'busy 中 steer 的消息')])
    const wrapper = mountStream('sess-anon')
    await wrapper.vm.$nextTick()

    // 失效类无锚点：toast 呈现（不静默），无内联
    injectNotice({ sessionId: 'sess-anon', reason: 'skill_missing', skills: ['steer-skill'] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(false)
    expect(useToast().toasts.value.some((t) => t.message.includes('steer-skill'))).toBe(true)

    // 降级类无锚点：同样降级为 toast（有锚点时降级类仅内联不 toast——两种路径都不断言互扰）
    injectNotice({ sessionId: 'sess-anon', reason: 'budget_exceeded', skills: ['steer-skill'] })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(false)
    expect(useToast().toasts.value.some((t) => t.message.includes('预算超限'))).toBe(true)

    wrapper.unmount()
  })

  it('⑤ 多 session 隔离：session A 的提示不出现在 session B，切回 A 仍在（Map 分区）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-iso-a', [userMsg('u-gggg', 'A 的消息')])
    chat.hydrate('sess-iso-b', [userMsg('u-hhhh', 'B 的消息')])

    const wrapper = mountStream('sess-iso-a')
    await wrapper.vm.$nextTick()

    injectNotice({ sessionId: 'sess-iso-a', clientUuid: 'u-gggg', reason: 'skill_missing', skills: ['a-skill'] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(true)

    // 切到 B（同一 wrapper 复用，props.sessionId 变化 → 订阅重订 + 分区切换）
    await wrapper.setProps({ sessionId: 'sess-iso-b' })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-stub-u-hhhh"]').exists()).toBe(true)

    // 切回 A：提示仍在（useSessionScopedState Map 分区保留，不随切换丢失）
    await wrapper.setProps({ sessionId: 'sess-iso-a' })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="skill-notice-inline"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('a-skill')

    wrapper.unmount()
  })

  it('幂等去重：同签名 notice 重复到达（reconcile 回放）不重复入流、不重复 toast', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-dedup', [userMsg('u-iiii', '去重消息')])
    const wrapper = mountStream('sess-dedup')
    await wrapper.vm.$nextTick()

    const payload = { sessionId: 'sess-dedup', clientUuid: 'u-iiii', reason: 'skill_missing' as const, skills: ['dup'] }
    injectNotice(payload)
    injectNotice(payload)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-testid="skill-notice-inline"]')).toHaveLength(1)
    expect(useToast().toasts.value.filter((t) => t.message.includes('dup'))).toHaveLength(1)

    wrapper.unmount()
  })
})

describe('interleaveSkillNoticeItems 纯函数', () => {
  it('无 notice 时原样返回同一引用（增量派生路径零开销）', () => {
    const items: never[] = []
    expect(interleaveSkillNoticeItems(items, [])).toBe(items)
  })

  it('锚点命中插 turn 之后；无锚点/宿主缺失不产出渲染项', () => {
    const turn = {
      index: 0,
      user: { id: 'u-1', role: 'user', content: [], status: 'complete', timestamp: 0 },
      assistants: [],
      isStreaming: false,
      hasFoldable: false,
    }
    const items = [{ kind: 'turn' as const, turn }]
    const notices: SkillNoticeEntry[] = [
      { id: 'n-1', clientUuid: 'u-1', reason: 'skill_missing', skills: ['x'] },
      { id: 'n-2', reason: 'skill_missing', skills: ['y'] },
      { id: 'n-3', clientUuid: 'u-404', reason: 'budget_exceeded', skills: ['z'] },
    ]
    const out = interleaveSkillNoticeItems(items, notices)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(items[0])
    expect(out[1]).toEqual({ kind: 'skillNotice', entry: notices[0] })
  })
})

// ══════════ 来源：DetailPane.test.ts ══════════
{
  function mountDetailPane() {
    return mount(DetailPane, {
      props: { sessionId: 's1' },
      global: {
        stubs: {
          // resourceBaseDir prop 透传到 DOM data-base，供传值矩阵断言（markdown 预览分支）
          MarkdownRenderer: {
            props: { content: String, sessionId: String, resourceBaseDir: String },
            template: '<div data-testid="markdown-stub" :data-base="resourceBaseDir" />',
          },
          CodeBlock: { template: '<div data-testid="codeblock-stub" />' },
          DiffView: { template: '<div data-testid="diffview-stub" />' },
          HoverCard: { template: '<div class="hover-card-stub"><slot /></div>' },
          HoverCardTrigger: { template: '<div class="hover-card-trigger-stub"><slot /></div>' },
          HoverCardContent: { template: '<div class="hover-card-content-stub"><slot /></div>' },
        },
      },
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    })
  })

  /** 重置 tab 条 fixture（用例隔离：默认空 tab 不渲染 tab 条、空态显示） */
  async function resetTabFixture(): Promise<void> {
    const mod = (await import('@/composables/features/file-tree/useDetailPane')) as unknown as {
      __fixture: {
        state: { value: Record<string, unknown> }
        tabs: { value: unknown[] }
        activePath: { value: string | null }
      }
    }
    mod.__fixture.tabs.value = []
    mod.__fixture.activePath.value = null
    mod.__fixture.state.value = { ...mod.__fixture.state.value, path: '', status: 'idle' }
  }

  describe('DetailPane header 文件路径查看与复制', () => {
    it('U1: 显示文件名和复制绝对路径按钮', () => {
      const wrapper = mountDetailPane()
      expect(wrapper.text()).toContain('index.ts')
      const btn = wrapper.find('[data-testid="detail-copy-path"]')
      expect(btn.exists()).toBe(true)
      expect(btn.attributes('title')).toBe('复制路径')
    })

    it('U2: hover 文件名时 tooltip 内展示绝对路径和复制文件名按钮', async () => {
      const wrapper = mountDetailPane()
      const filename = wrapper.find('[data-testid="detail-filename"]')
      expect(filename.exists()).toBe(true)
      await filename.trigger('mouseenter')
      const tooltip = wrapper.find('[data-testid="detail-path-tooltip"]')
      expect(tooltip.exists()).toBe(true)
      expect(tooltip.text()).toContain('/Users/demo/project/src/index.ts')
      expect(tooltip.find('[data-testid="detail-copy-filename"]').attributes('title')).toBe('复制文件名')
    })

    it('U3: 点击复制绝对路径按钮写入剪贴板', async () => {
      const wrapper = mountDetailPane()
      const btn = wrapper.find('[data-testid="detail-copy-path"]')
      expect(btn.exists()).toBe(true)
      await btn.trigger('click')
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/Users/demo/project/src/index.ts')
    })

    it('U4: 点击 tooltip 内复制文件名按钮写入剪贴板', async () => {
      const wrapper = mountDetailPane()
      const filename = wrapper.find('[data-testid="detail-filename"]')
      await filename.trigger('mouseenter')
      const btn = wrapper.find('[data-testid="detail-copy-filename"]')
      expect(btn.exists()).toBe(true)
      await btn.trigger('click')
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('index.ts')
    })
  })

  describe('DetailPane i18n 契约', () => {
    it('E1: 中英文 locale 均包含复制相关文案', async () => {
      const { default: zh } = await import('@taiji/ui/locale/zh-CN/panel')
      const { default: en } = await import('@taiji/ui/locale/en-US/panel')
      expect(zh.detail.copyFilePath).toBe('复制路径')
      expect(zh.detail.copyFileName).toBe('复制文件名')
      expect(en.detail.copyFilePath).toBe('Copy path')
      expect(en.detail.copyFileName).toBe('Copy file name')
    })
  })

  describe('DetailPane resourceBaseDir 传值矩阵（drawer 文件目录，设计 markdown-html-sanitize-render D4）', () => {
    /** 取 mock 工厂暴露的可变 fixture（state ref + cwd 容器） */
    async function getFixture(): Promise<{
      state: { value: { path: string; status: string; content: string; truncated: boolean; binary: boolean; error: string; viewMode: string; hasGitChange: boolean; kind: string } }
      cwdHolder: { value: string | null }
    }> {
      const mod = (await import('@/composables/features/file-tree/useDetailPane')) as {
        __fixture: { state: never; cwdHolder: never }
      }
      return mod.__fixture as never
    }

    /** 组装 markdown 预览态（默认 cwd=/Users/demo/project） */
    async function useMarkdownPreview(path: string): Promise<void> {
      const fx = await getFixture()
      fx.state.value = {
        path,
        status: 'content',
        content: '# doc',
        truncated: false,
        binary: false,
        error: '',
        viewMode: 'preview',
        hasGitChange: false,
        kind: 'markdown',
      }
      fx.cwdHolder.value = '/Users/demo/project'
    }

    it('markdown 预览：传打开文件所在目录（absolutePath 的 dirname）', async () => {
      await useMarkdownPreview('docs/README.md')
      const wrapper = mountDetailPane()
      const stub = wrapper.find('[data-testid="detail-markdown"]')
      expect(stub.exists()).toBe(true)
      // /Users/demo/project/docs/README.md 的目录
      expect(stub.attributes('data-base')).toBe('/Users/demo/project/docs')
    })

    it('cwd 缺失（无 session）→ resourceBaseDir undefined（该文档不做相对资源解析）', async () => {
      await useMarkdownPreview('docs/README.md')
      const fx = await getFixture()
      fx.cwdHolder.value = null
      const wrapper = mountDetailPane()
      const val = wrapper.find('[data-testid="detail-markdown"]').attributes('data-base')
      expect(val === undefined || val === '').toBe(true)
    })

    it('无选中文件（path 空）→ detail-empty 态，MarkdownRenderer 不挂载（无 resourceBaseDir 传递面）', async () => {
      await useMarkdownPreview('')
      const wrapper = mountDetailPane()
      // !state.path 命中 detail-empty 分支——markdown 预览分支 v-if 不成立，无传值面
      expect(wrapper.find('[data-testid="detail-empty"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="detail-markdown"]').exists()).toBe(false)
    })

    it('根级文件（dirname 为根 /）不传无效目录——slash 落在首位时按无目录降级 undefined', async () => {
      await useMarkdownPreview('/README.md')
      const wrapper = mountDetailPane()
      const val = wrapper.find('[data-testid="detail-markdown"]').attributes('data-base')
      // absolutePath = /README.md（已是绝对路径），lastIndexOf('/') === 0 → undefined（防 base 变成空串）
      expect(val === undefined || val === '').toBe(true)
    })
  })

  describe('DetailPane 实例层 tab 条（display-containers W3 §6.3，S4）', () => {
    /** 组装 tab 条 fixture（两个文件 tab，a 激活） */
    async function useTwoTabs(): Promise<void> {
      const mod = (await import('@/composables/features/file-tree/useDetailPane')) as unknown as {
        __fixture: {
          state: { value: Record<string, unknown> }
          tabs: { value: unknown[] }
          activePath: { value: string | null }
        }
      }
      mod.__fixture.tabs.value = [
        { path: 'src/a.ts', status: 'content', viewMode: 'preview', scrollTop: 120 },
        { path: 'docs/b.md', status: 'content', viewMode: 'diff', scrollTop: 0 },
      ]
      mod.__fixture.activePath.value = 'src/a.ts'
      mod.__fixture.state.value = {
        ...mod.__fixture.state.value,
        path: 'src/a.ts',
        status: 'content',
      }
    }

    it('U5: 多 tab 渲染（文件名 + 激活标记），单内容视图只有激活实例', async () => {
      await useTwoTabs()
      const wrapper = mountDetailPane()
      const tabs = wrapper.findAll('[data-testid="detail-tab"]')
      expect(tabs.length).toBe(2)
      expect(tabs[0].text()).toContain('a.ts')
      expect(tabs[1].text()).toContain('b.md')
      expect(tabs[0].attributes('data-active')).toBe('true')
      expect(tabs[1].attributes('data-active')).toBe('false')
    })

    it('U6: 点击非激活 tab → 调 activateTab（keep-alive 切换，内容/模式态由实例保持）', async () => {
      await useTwoTabs()
      const wrapper = mountDetailPane()
      const tabs = wrapper.findAll('[data-testid="detail-tab"]')
      await tabs[1].trigger('click')
      expect(mockActivateTab).toHaveBeenCalledWith('docs/b.md')
    })

    it('U7: 点击 tab 的 × → 调 closeTab 且不误触切换（stop）', async () => {
      await useTwoTabs()
      const wrapper = mountDetailPane()
      const closeBtns = wrapper.findAll('[data-testid="detail-tab-close"]')
      expect(closeBtns.length).toBe(2)
      await closeBtns[0].trigger('click')
      expect(mockCloseTab).toHaveBeenCalledWith('src/a.ts')
      expect(mockActivateTab).not.toHaveBeenCalled()
    })

    it('U8: 无打开 tab → tab 条不渲染（空态不受影响）', async () => {
      await resetTabFixture()
      const wrapper = mountDetailPane()
      expect(wrapper.find('[data-testid="detail-tab-strip"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="detail-empty"]').exists()).toBe(true)
    })
  })
}
