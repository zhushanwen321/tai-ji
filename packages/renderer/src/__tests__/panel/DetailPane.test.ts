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
import { createPinia, setActivePinia } from 'pinia'
import DetailPane from '@/components/panel/DetailPane.vue'

const mockToggleView = vi.fn()

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
  return {
    useDetailPane: () => ({
      state,
      toggleView: mockToggleView,
      sessionCwd: () => cwdHolder.value,
    }),
    __fixture: { state, cwdHolder },
  }
})

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
