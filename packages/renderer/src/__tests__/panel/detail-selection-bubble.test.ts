/**
 * DetailPane 选区 bubble 测试（W4, U13）。
 *
 * 验证 FR-4 选区 bubble：
 * - U13: 选中文本后 mouseup → bubble 显出 → click 引用当前 → 注入 path+行范围（不含文本）
 * - U13b: bubble "新对话" 按钮走 target=new
 *
 * jsdom selection 限制：window.getSelection 在 jsdom 下功能有限，本测试直接设
 * selectionRange ref 驱动 bubble 显隐（绕过 selection API），验证注入逻辑正确性。
 * selection API 的真实行为留手动/E2E 验证。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// 可配置的 detail state（测试切换 viewMode/content）
const detailState = ref({
  path: 'src/foo.ts',
  content: 'line1\nline2\nline3\nline4',
  viewMode: 'preview',
  kind: 'code',
  status: 'success',
  hasGitChange: false,
})
vi.mock('@/composables/features/file-tree/useDetailPane', () => ({
  useDetailPane: () => ({
    state: detailState,
    toggleView: vi.fn(),
    sessionCwd: () => '/cwd',
  }),
}))
vi.mock('@/composables/panel/useCopy', () => ({
  useCopy: () => ({ copied: ref(null), copy: vi.fn() }),
}))
vi.mock('@/composables/logic/file-type', () => ({ extToLang: () => 'ts' }))
vi.mock('@/lib/path-utils', () => ({ resolvePreviewPath: () => ({ absolute: '/cwd/src/foo.ts' }) }))

// [w6 chat-ui-and-shell T7] DetailPane 壳 provide 真 deps（useChatViewDeps）→ mock 该装配器（原 vi.mock 旧组件路径失效，改模板按名 stub）
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
vi.mock('@/components/panel/detail-renderers/CodeBlock.vue', () => ({
  default: { template: '<div />' },
}))

import DetailPane from '@/components/panel/DetailPane.vue'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

beforeEach(() => {
  setActivePinia(createPinia())
})

const SIMPLE = { template: '<div />' }

function mountDetailPane() {
  return mount(DetailPane, {
    props: { sessionId: 's1' },
    global: {
      stubs: {
        HoverCard: SIMPLE, HoverCardContent: SIMPLE, HoverCardTrigger: SIMPLE,
        CodeBlock: SIMPLE, DiffView: SIMPLE, MarkdownRenderer: SIMPLE,
      },
    },
  })
}

describe('W4: DetailPane 选区 bubble（FR-4）', () => {
  it('U13: 无选区时 bubble 不存在', () => {
    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-selection-bubble"]').exists()).toBe(false)
  })

  it('U13b: bubble "引用当前" 按钮注入 path+行范围 target=current（不含 text）', async () => {
    const wrapper = mountDetailPane()
    const store = composerInjectionStore
    // mock window.getSelection 返回模拟选区（content 第 2-3 行）。
    // fakeRange 必须含 startContainer/endContainer —— onContentMouseup 直接访问这俩字段，
    // 缺失会让 findCodeLineIndex(node=undefined) 在 node.nodeType 抛 TypeError。
    // preview 模式下内容区无 .line 节点（CodeBlock stub 成空 div），
    // findCodeLineIndex 返回 null，自然落到文本回退分支。
    const contentEl = wrapper.find('[data-testid="detail-content"]').element
    const fakeRange = { commonAncestorContainer: contentEl, startContainer: contentEl, endContainer: contentEl }
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => fakeRange,
      toString: () => 'line2\nline3',
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    } as unknown as Selection)

    await wrapper.find('[data-testid="detail-content"]').trigger('mouseup')
    const bubble = wrapper.find('[data-testid="detail-selection-bubble"]')
    expect(bubble.exists()).toBe(true)

    await wrapper.find('[data-testid="bubble-inject-current"]').trigger('click')
    expect(store.pendingInjection.value).not.toBeNull()
    expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
    expect(store.pendingInjection.value?.lineStart).toBe(2)
    expect(store.pendingInjection.value?.lineEnd).toBe(3)
    expect(store.pendingInjection.value?.target).toBe('current')
    // FR-8: payload 不含 text
    expect((store.pendingInjection as Record<string, unknown>).text).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('U13c: bubble "新对话" 按钮走 target=new', async () => {
    const wrapper = mountDetailPane()
    const store = composerInjectionStore
    // fakeRange 需含 startContainer/endContainer（详见 U13b 注释）
    const contentEl = wrapper.find('[data-testid="detail-content"]').element
    const fakeRange = { commonAncestorContainer: contentEl, startContainer: contentEl, endContainer: contentEl }
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => fakeRange,
      toString: () => 'line1',
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    } as unknown as Selection)

    await wrapper.find('[data-testid="detail-content"]').trigger('mouseup')
    await wrapper.find('[data-testid="bubble-inject-new"]').trigger('click')
    expect(store.pendingInjection.value?.target).toBe('new')
    expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
    expect(store.pendingInjection.value?.sessionId).toBeNull()
    vi.restoreAllMocks()
  })

  it('U13d: diff 模式从选区行元素 data-line 精确反推行号（不再禁用 bubble）', async () => {
    // 切 diff 模式：content 是 patch，DiffView 真实渲染行（带 data-line=newNo）
    detailState.value = {
      path: 'src/foo.ts',
      content: '@@ -1,3 +1,4 @@\n context\n-old\n+new line\n+added\n',
      viewMode: 'diff',
      kind: 'code',
      status: 'success',
      hasGitChange: true,
    }
    const wrapper = mount(DetailPane, {
      props: { sessionId: 's1' },
      global: {
        stubs: {
          HoverCard: SIMPLE, HoverCardContent: SIMPLE, HoverCardTrigger: SIMPLE,
          CodeBlock: SIMPLE, MarkdownRenderer: SIMPLE,
          // DiffView 不 stub：真实渲染 patch 行（带 data-line）
        },
      },
    })
    await wrapper.vm.$nextTick()
    const store = composerInjectionStore

    // 找 DiffView 渲染的行 div（带 data-line）。patch 有 newNo 的行：context=1, new line=2, added=3
    const lineEls = wrapper.findAll('[data-line]').filter((w) => w.attributes('data-line') !== '')
    expect(lineEls.length).toBeGreaterThan(0)
    // mock selection：startContainer 指向第一行（data-line=1），endContainer 指向最后一行
    const firstLineEl = lineEls[0].element
    const lastLineEl = lineEls[lineEls.length - 1].element
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({
        commonAncestorContainer: wrapper.find('[data-testid="detail-content"]').element,
        startContainer: firstLineEl,
        endContainer: lastLineEl,
      }),
      toString: () => 'some selected text',
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    } as unknown as Selection)

    await wrapper.find('[data-testid="detail-content"]').trigger('mouseup')
    // bubble 应显出（diff 模式不再禁用）
    const bubble = wrapper.find('[data-testid="detail-selection-bubble"]')
    expect(bubble.exists()).toBe(true)

    await wrapper.find('[data-testid="bubble-inject-current"]').trigger('click')
    expect(store.pendingInjection.value).not.toBeNull()
    expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
    // 行号从 data-line 读取（首行 newNo 到末行 newNo）
    expect(store.pendingInjection.value?.lineStart).toBe(Number(firstLineEl.getAttribute('data-line')))
    expect(store.pendingInjection.value?.lineEnd).toBe(Number(lastLineEl.getAttribute('data-line')))
    vi.restoreAllMocks()
    // 恢复 preview 模式供后续测试
    detailState.value = {
      path: 'src/foo.ts',
      content: 'line1\nline2\nline3\nline4',
      viewMode: 'preview',
      kind: 'code',
      status: 'success',
      hasGitChange: false,
    }
  })
})
