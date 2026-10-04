/**
 * DetailPane HTML 渲染态 DOM 单测（chat-html-support §6.4 D4）。
 *
 * 观察者视角（用户可见 DOM）：切换存在且默认预览 / 预检 pending 中性加载 /
 * 不可服务占位带原因 + 重试 / sandbox iframe 挂载 / 占位态不并存「刷新」按钮 /
 * 源码态回既有 shiki 高亮。
 *
 * mock 策略：vi.mock('@/composables/features/file-tree/useDetailPane') 控制状态机
 * （可预览态由 html-preview 状态机单测覆盖）；子渲染器 stub 掉。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/file-tree/__tests__/DetailPane-html-preview.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DetailPane from '@/components/panel/DetailPane.vue'

vi.mock('@/composables/features/file-tree/useDetailPane', async () => {
  const { ref } = await import('vue')
  const state = ref({
    path: 'report.html',
    status: 'content',
    content: '',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'html',
  })
  const htmlView = ref<'rendered' | 'source'>('rendered')
  const htmlPreviewStatus = ref<'idle' | 'pending' | 'ready' | 'unavailable'>('pending')
  const htmlPreviewReasonKey = ref<string | null>(null)
  const htmlSrc = ref<string | null>(null)
  const setHtmlView = vi.fn()
  const reloadHtmlPreview = vi.fn()
  return {
    useDetailPane: () => ({
      state,
      toggleView: vi.fn(),
      sessionCwd: () => '/Users/demo',
      htmlView,
      htmlPreviewStatus,
      htmlPreviewReasonKey,
      htmlSrc,
      setHtmlView,
      reloadHtmlPreview,
    }),
    __fixture: { state, htmlView, htmlPreviewStatus, htmlPreviewReasonKey, htmlSrc, setHtmlView, reloadHtmlPreview },
  }
})

type Fixture = {
  state: { value: Record<string, unknown> }
  htmlView: { value: 'rendered' | 'source' }
  htmlPreviewStatus: { value: 'idle' | 'pending' | 'ready' | 'unavailable' }
  htmlPreviewReasonKey: { value: string | null }
  htmlSrc: { value: string | null }
  setHtmlView: ReturnType<typeof vi.fn>
  reloadHtmlPreview: ReturnType<typeof vi.fn>
}

async function fixture(): Promise<Fixture> {
  const mod = (await import('@/composables/features/file-tree/useDetailPane')) as unknown as { __fixture: Fixture }
  return mod.__fixture
}

function mountDetailPane() {
  return mount(DetailPane, {
    props: { sessionId: 's1' },
    global: {
      stubs: {
        MarkdownRenderer: { template: '<div data-testid="markdown-stub" />' },
        CodeBlock: { template: '<div data-testid="codeblock-stub" />' },
        DiffView: { template: '<div data-testid="diffview-stub" />' },
        HoverCard: { template: '<div class="hover-card-stub"><slot /></div>' },
        HoverCardTrigger: { template: '<div class="hover-card-trigger-stub"><slot /></div>' },
        HoverCardContent: { template: '<div class="hover-card-content-stub"><slot /></div>' },
      },
    },
  })
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const fx = await fixture()
  fx.state.value = {
    path: 'report.html',
    status: 'content',
    content: '',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'html',
  }
  fx.htmlView.value = 'rendered'
  fx.htmlPreviewStatus.value = 'pending'
  fx.htmlPreviewReasonKey.value = null
  fx.htmlSrc.value = null
})

describe('DetailPane HTML 渲染态 · 切换与加载态', () => {
  it('「预览 | 源码」切换存在且预览为默认；pending 显中性加载态（不开 iframe、无刷新按钮）', async () => {
    const wrapper = mountDetailPane()
    const toggle = wrapper.find('[data-testid="detail-html-view-toggle"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.text()).toContain('预览')
    expect(toggle.text()).toContain('源码')
    expect(wrapper.find('[data-testid="detail-html-pending"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-html-frame"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-html-refresh"]').exists()).toBe(false)
  })

  it('点「源码」→ 调 setHtmlView("source")', async () => {
    const wrapper = mountDetailPane()
    const fx = await fixture()
    const buttons = wrapper.find('[data-testid="detail-html-view-toggle"]').findAll('button')
    await buttons[1].trigger('click')
    expect(fx.setHtmlView).toHaveBeenCalledWith('source')
  })
})

describe('DetailPane HTML 渲染态 · 降级占位', () => {
  it('不可服务（out_of_whitelist）→ 占位带原因 + 重试；占位态不并存「刷新」', async () => {
    const fx = await fixture()
    fx.htmlPreviewStatus.value = 'unavailable'
    fx.htmlPreviewReasonKey.value = 'panel.detail.htmlReasonOutOfWhitelist'
    fx.htmlSrc.value = null

    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-html-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-html-unavailable-reason"]').text()).toBe('不在预览白名单')
    expect(wrapper.find('[data-testid="detail-html-retry"]').exists()).toBe(true)
    // 按钮语义归一：占位态只显「重试」，不并存「刷新」
    expect(wrapper.find('[data-testid="detail-html-refresh"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-html-frame"]').exists()).toBe(false)
  })

  it('点「重试」→ 重走整个挂载序列（reloadHtmlPreview）', async () => {
    const fx = await fixture()
    fx.htmlPreviewStatus.value = 'unavailable'
    fx.htmlPreviewReasonKey.value = 'panel.detail.htmlReasonNotFound'

    const wrapper = mountDetailPane()
    await wrapper.find('[data-testid="detail-html-retry"]').trigger('click')
    expect(fx.reloadHtmlPreview).toHaveBeenCalledTimes(1)
  })
})

describe('DetailPane HTML 渲染态 · 独占内容区', () => {
  it('渲染态 → 不并存 detail-content / detail-code（内容区不照常渲染空 CodeBlock）', async () => {
    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-html-preview"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-content"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-code"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-error"]').exists()).toBe(false)
  })

  it('源码态加载失败后再切回渲染态（status 仍为 error）→ 错误占位不与 iframe 并列', async () => {
    const fx = await fixture()
    fx.state.value = { ...fx.state.value, status: 'error', error: 'out_of_cwd' }

    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-html-preview"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-content"]').exists()).toBe(false)
  })
})

describe('DetailPane HTML 渲染态 · iframe 与源码态', () => {
  it('ready → sandbox iframe 挂载（只给 allow-scripts）+ 刷新按钮出现', async () => {
    const fx = await fixture()
    fx.htmlPreviewStatus.value = 'ready'
    fx.htmlSrc.value = 'local-file:///Users/demo/report.html?r=1'

    const wrapper = mountDetailPane()
    const frame = wrapper.find('[data-testid="detail-html-frame"]')
    expect(frame.exists()).toBe(true)
    expect(frame.attributes('sandbox')).toBe('allow-scripts')
    expect(frame.attributes('src')).toBe('local-file:///Users/demo/report.html?r=1')
    expect(wrapper.find('[data-testid="detail-html-refresh"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-html-unavailable"]').exists()).toBe(false)
  })

  it('点「刷新」→ reloadHtmlPreview（同一挂载函数重入）', async () => {
    const fx = await fixture()
    fx.htmlPreviewStatus.value = 'ready'
    fx.htmlSrc.value = 'local-file:///Users/demo/report.html?r=1'

    const wrapper = mountDetailPane()
    await wrapper.find('[data-testid="detail-html-refresh"]').trigger('click')
    expect(fx.reloadHtmlPreview).toHaveBeenCalledTimes(1)
  })

  it('源码态 → iframe 不挂载，回既有 shiki 高亮（CodeBlock），切换仍可见', async () => {
    const fx = await fixture()
    fx.htmlView.value = 'source'
    fx.state.value = { ...fx.state.value, content: '<html><body>hi</body></html>' }

    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-html-frame"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="codeblock-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-html-view-toggle"]').exists()).toBe(true)
  })
})
