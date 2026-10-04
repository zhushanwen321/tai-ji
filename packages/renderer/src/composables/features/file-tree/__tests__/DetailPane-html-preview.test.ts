/**
 * DetailPane .html 源码高亮回归测试（chat-html-support §6.4 D4，v16 抽屉渲染态退役）。
 *
 * 观察者视角（用户可见 DOM）：.html 在抽屉走 code 类 shiki 源码高亮（与实施前行为一致）；
 * 渲染态的 DOM 足迹全部消失——「预览 | 源码」切换、sandbox iframe、刷新按钮、渲染态
 * 内容区容器均不存在（预览面收敛到消息流内联容器 HtmlPreviewInline，§6.3 D3）。
 *
 * mock 策略：vi.mock('@/composables/features/file-tree/useDetailPane') 控制 state
 * （.html 命中 code 类后 useDetailPane 与普通文件无差别）；子渲染器 stub 掉。
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
    content: '<html><body>hi</body></html>',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'code',
  })
  return {
    useDetailPane: () => ({
      state,
      toggleView: vi.fn(),
      sessionCwd: () => '/Users/demo',
    }),
    __fixture: { state },
  }
})

type Fixture = {
  state: { value: Record<string, unknown> }
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
    content: '<html><body>hi</body></html>',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'code',
  }
})

describe('DetailPane · .html 恢复源码高亮（渲染态退役回归）', () => {
  it('.html（kind=code）→ CodeBlock 源码高亮，渲染态 DOM 足迹全部消失', () => {
    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-code"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="codeblock-stub"]').exists()).toBe(true)
    // 渲染态足迹：切换 / iframe / 刷新 / 渲染态内容区容器均不存在
    expect(wrapper.find('[data-testid="detail-html-view-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-html-frame"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-html-refresh"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-html-preview"]').exists()).toBe(false)
  })

  it('渲染态退役后无「预览 | 源码」html 切换按钮（源码态是唯一形态）', () => {
    const wrapper = mountDetailPane()
    const header = wrapper.find('[data-testid="detail-pane"]')
    expect(header.exists()).toBe(true)
    // 既有 diff/preview toggle（git 改动语境）保留由其他用例覆盖；此处断言 html 专属切换不存在
    expect(wrapper.text()).not.toContain('panel.detail.htmlTabSource')
  })

  it('加载态 / 错误态不被 html 特殊分支拦截（互斥链回归）', async () => {
    const fx = await fixture()
    fx.state.value = { ...fx.state.value, status: 'loading' }
    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-loading"]').exists()).toBe(true)

    fx.state.value = { ...fx.state.value, status: 'error', error: 'boom' }
    const wrapper2 = mountDetailPane()
    expect(wrapper2.find('[data-testid="detail-error"]').exists()).toBe(true)
    expect(wrapper2.find('[data-testid="detail-html-preview"]').exists()).toBe(false)
  })
})
