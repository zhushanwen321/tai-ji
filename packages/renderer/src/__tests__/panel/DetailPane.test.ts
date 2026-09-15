/**
 * DetailPane 组件单测：header 文件路径查看与复制。
 *
 * 覆盖：
 * - header 显示文件名 + 复制绝对路径按钮
 * - hover 文件名时 tooltip 展示绝对路径 + 复制文件名按钮
 * - 点击复制按钮写入剪贴板
 *
 * mock 策略：vi.mock('@/composables/features/file-tree/useDetailPane') 控制 state 与 sessionCwd，
 * HoverCard 相关子组件 stub 掉以便断言 tooltip 内容。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/DetailPane.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DetailPane from '@/components/panel/DetailPane.vue'

const mockToggleView = vi.fn()

vi.mock('@/composables/features/file-tree/useDetailPane', () => ({
  useDetailPane: () => ({
    state: ref({
      path: 'src/index.ts',
      status: 'content',
      content: '',
      truncated: false,
      binary: false,
      error: '',
      viewMode: 'preview',
      hasGitChange: false,
      kind: 'text',
    }),
    toggleView: mockToggleView,
    sessionCwd: (sid: string | null) => (sid ? '/Users/demo/project' : null),
  }),
}))

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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  })
})

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
    const { default: zh } = await import('@/i18n/locales/zh-CN/panel')
    const { default: en } = await import('@/i18n/locales/en-US/panel')
    expect(zh.detail.copyFilePath).toBe('复制路径')
    expect(zh.detail.copyFileName).toBe('复制文件名')
    expect(en.detail.copyFilePath).toBe('Copy path')
    expect(en.detail.copyFileName).toBe('Copy file name')
  })
})
