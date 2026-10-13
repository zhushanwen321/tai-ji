/**
 * ToolDetailRenderer 单测（tool-detail-rich：read 代码块 / write 懒加载 git diff / edit patch）。
 *
 * mock 面：'@/api' git.getDiff（write 懒加载通路）+ highlightCode（shiki，区别化标记）；
 * parseDiff / extToLang 走真实纯函数。跟随 DiffView.seq-guard.test 的 mock 模式。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { ToolCall } from '@taiji/shared'
import ToolDetailRenderer from '@/components/panel/detail-renderers/ToolDetailRenderer.vue'

const mockGetDiff = vi.hoisted(() => vi.fn())
const mockHighlight = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  git: { getDiff: mockGetDiff },
}))
vi.mock('@taiji/ui/features/chat/markdown', () => ({
  highlightCode: mockHighlight,
}))

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'read',
    input: { path: '/tmp/foo.ts' },
    status: 'completed',
    startTime: 1000,
    endTime: 5000,
    ...over,
  }
}

function mountRenderer(tool: ToolCall, sessionId: string | null = 'sess-1') {
  return mount(ToolDetailRenderer, { props: { tool, sessionId } })
}

afterEach(() => {
  vi.restoreAllMocks()
  mockGetDiff.mockReset()
  mockHighlight.mockReset()
  mockHighlight.mockImplementation(async (code: string) => `<b>${code}</b>`)
})

describe('ToolDetailRenderer — edit 分支', () => {
  it('details.diff 存在 → 直接渲染 DiffView（hunk 内容可见）', async () => {
    const patch = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,2 @@\n const a = 1\n+const b = 2\n'
    const wrapper = mountRenderer(makeTool({ toolName: 'edit', input: { path: 'foo.ts' }, details: { patch } }))
    await flushPromises()
    expect(wrapper.find('[data-testid="tool-detail-edit"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('const b = 2')
    wrapper.unmount()
  })

  it('details.diff 缺失（历史会话）→ 不渲染富分支（ui 侧谓词兜底，组件自身也不产出空壳）', () => {
    const wrapper = mountRenderer(makeTool({ toolName: 'edit', input: { path: 'foo.ts' } }))
    expect(wrapper.find('[data-testid="tool-detail-edit"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('details 只有展示格式 diff（无 unified patch）→ 不渲染（展示格式不可喂 parseDiff，回退纯文本）', () => {
    const wrapper = mountRenderer(makeTool({ toolName: 'edit', input: { path: 'foo.ts' }, details: { diff: '+2 appended line' } }))
    expect(wrapper.find('[data-testid="tool-detail-edit"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ToolDetailRenderer — write 分支（懒加载 git diff）', () => {
  const content = 'line-one\nline-two'

  it('getDiff 非空 patch（已跟踪文件改写）→ DiffView 原样渲染 git patch', async () => {
    const gitPatch = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,2 @@\n-old\n+line-one\n'
    mockGetDiff.mockResolvedValue({ binary: false, patch: gitPatch })
    const wrapper = mountRenderer(makeTool({ toolName: 'write', input: { path: 'foo.ts', content } }))
    await flushPromises()
    expect(wrapper.find('[data-testid="tool-detail-write-label"]').exists()).toBe(true)
    // git patch 原样渲染（label 相对 git HEAD；DiffView del 符号 = U+2212，内容 'old' 可见），
    // 合成内容的 line-two 不出现
    expect(wrapper.text()).toContain('相对 git HEAD')
    expect(wrapper.text()).toContain('old')
    expect(wrapper.text()).not.toContain('line-two')
    wrapper.unmount()
  })

  it('getDiff 空 patch（untracked）→ 合成全增 diff + 新文件标注（input.content 全行可见）', async () => {
    mockGetDiff.mockResolvedValue({ binary: false, patch: '' })
    const wrapper = mountRenderer(makeTool({ toolName: 'write', input: { path: 'foo.ts', content } }))
    await flushPromises()
    expect(wrapper.find('[data-testid="tool-detail-write-label"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('+line-one')
    expect(wrapper.text()).toContain('+line-two')
    wrapper.unmount()
  })

  it('getDiff reject（api 失败）→ 内容照常全增展示，不标来源（不误标新文件/重写）', async () => {
    mockGetDiff.mockRejectedValue(new Error('git down'))
    const wrapper = mountRenderer(makeTool({ toolName: 'write', input: { path: 'foo.ts', content } }))
    await flushPromises()
    expect(wrapper.find('[data-testid="tool-detail-write-label"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tool-detail-write-loading"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('+line-one')
    wrapper.unmount()
  })

  it('无 sessionId → 不打 git api，直接合成全增展示', async () => {
    const wrapper = mountRenderer(makeTool({ toolName: 'write', input: { path: 'foo.ts', content } }), null)
    await flushPromises()
    expect(mockGetDiff).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('+line-two')
    wrapper.unmount()
  })
})

describe('ToolDetailRenderer — read 分支（行号代码块 + 截断脚注剥离）', () => {
  it('output 剥掉 [Showing lines ...] 脚注 → 脚注入 footer 行，代码区只剩内容', async () => {
    const output = 'const a = 1\nconst b = 2\n\n[Showing lines 1-2 of 100. Use offset=3 to continue.]'
    const wrapper = mountRenderer(makeTool({ toolName: 'read', input: { path: '/tmp/foo.ts' }, output }))
    await flushPromises()
    expect(wrapper.find('[data-testid="tool-detail-read"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="read-code-footer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="read-code-footer"]').text()).toContain('Use offset=3')
    expect(wrapper.text()).toContain('const a = 1')
    // 脚注文本不进代码区（只出现在 footer 行）
    expect(wrapper.html()).not.toContain('of 100. Use offset=3 to continue.]</b>')
    wrapper.unmount()
  })

  it('input.offset 分段读 → 起始行号透传（counterReset 内联样式）', async () => {
    const wrapper = mountRenderer(
      makeTool({ toolName: 'read', input: { path: '/tmp/foo.ts', offset: 21 }, output: 'const x = 21' }),
    )
    await flushPromises()
    const body = wrapper.find('.read-code-body')
    expect(body.attributes('style')).toContain('rbi-line 20')
    wrapper.unmount()
  })

  it('无脚注的普通读取 → footer 行不渲染', async () => {
    const wrapper = mountRenderer(makeTool({ toolName: 'read', input: { path: '/tmp/foo.ts' }, output: 'const a = 1' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="read-code-footer"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
