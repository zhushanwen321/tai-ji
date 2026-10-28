import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount';
import DetailPane from '@/components/panel/DetailPane.vue';
import GitPanel from '@/components/panel/GitPanel.vue';
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue';
import DiffView from '@/components/panel/detail-renderers/DiffView.vue';
import ToolDetailRenderer from '@/components/panel/detail-renderers/ToolDetailRenderer.vue';
import { Button } from '@/components/ui/button';
import { PopoverTrigger } from '@/components/ui/popover';
import { composerInjectionStore } from '@/composables/panel/composer-injection-store';
import { getSettingsStore } from '@taiji/core';
import type { ToolCall } from '@taiji/shared';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ref, h } from 'vue';

// wave3 簇 [renderer/happy-dom] 3 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/panel/drawer-injection-entries.test.ts
 * - components/panel/__tests__/ModelSelectPopover.spec.ts
 * - components/panel/detail-renderers/__tests__/ToolDetailRenderer.test.ts
 */

// ======================================================================
// ← __tests__/panel/drawer-injection-entries.test.ts
// ======================================================================

// ── stub 重依赖 ──
vi.mock('@/composables/features/file-tree/useDetailPane', () => ({
  useDetailPane: () => ({
    state: ref({ path: 'src/foo.ts', content: '', viewMode: 'preview', kind: 'code', status: 'success', hasGitChange: false }),
    tabs: ref([]),
    activePath: ref(null),
    toggleView: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    saveScroll: vi.fn(),
    sessionCwd: () => '/cwd',
  }),
}))
vi.mock('@/composables/panel/useCopy', () => ({
  useCopy: () => ({ copied: ref(null), copy: vi.fn() }),
}))
vi.mock('@/composables/logic/file-type', () => ({ extToLang: () => 'ts' }))
vi.mock('@/lib/path-utils', () => ({ resolvePreviewPath: () => ({ absolute: '/cwd/src/foo.ts' }) }))
vi.mock('@/components/panel/detail-renderers/CodeBlock.vue', () => ({
  default: { template: '<div />' },
}))

// [w6 chat-ui-and-shell T7] DetailPane 壳 provide 真 deps（useChatViewDeps）→ mock 该装配器，
// 容器内 ui MarkdownRenderer 等经 deps inject 消费 mock（原 vi.mock 旧组件路径失效，改模板按名 stub）。
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())

// GitPanel 重依赖
vi.mock('@/composables/features/file-tree/useGitStatus', () => ({
  useGitStatusOrFail: () => ({
    result: ref({
      isRepo: true,
      hasConflict: false,
      branch: 'main',
      files: [{ path: 'src/foo.ts', status: 'M' }],
      stats: { add: 1, del: 0 },
      staged: new Set(),
      stagedCount: 0,
      unstagedCount: 1,
      ahead: 0,
      behind: 0,
    }),
    state: ref('dirty'),
    pending: ref(false),
    error: ref(null),
    commitMsg: ref(''),
    refresh: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    commit: vi.fn(),
  }),
}))
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ selectFile: vi.fn() }),
}))
vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: { id: 's1', cwd: '/cwd' } }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
})

const SIMPLE = { template: '<div />' }

describe('W3: drawer 写入入口', () => {
  it('U10: DetailPane header 按钮注入 path（无行范围 target=current）', async () => {
    const wrapper = mount(DetailPane, {
      props: { sessionId: 's1' },
      global: {
        stubs: {
          HoverCard: SIMPLE, HoverCardContent: SIMPLE, HoverCardTrigger: SIMPLE,
          CodeBlock: SIMPLE, DiffView: SIMPLE, MarkdownRenderer: SIMPLE,
        },
      },
    })
    const store = composerInjectionStore
    const btn = wrapper.find('[data-testid="detail-inject-file"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')

    expect(store.pendingInjection.value).not.toBeNull()
    expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
    expect(store.pendingInjection.value?.target).toBe('current')
    expect(store.pendingInjection.value?.sessionId).toBe('s1')
    expect(store.pendingInjection.value?.lineStart).toBeUndefined()
  })

  it('U11: DiffView 行号点击 emit line-inject（path + lineNo）', async () => {
    // 简单 patch：一个 hunk 含带 newNo 的行
    const patch = '@@ -1,3 +1,4 @@\n context\n-old\n+new line\n+added\n'
    const wrapper = mount(DiffView, { props: { patch, path: 'src/foo.ts' } })
    const store = composerInjectionStore

    // 找所有有 newNo 的行号 span（cursor-pointer 的）
    const newNoSpans = wrapper.findAll('span.cursor-pointer')
    expect(newNoSpans.length).toBeGreaterThan(0)
    await newNoSpans[0].trigger('click')

    const emitted = wrapper.emitted('lineInject')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toMatchObject({ path: 'src/foo.ts' })
    expect((emitted![0][0] as { lineNo: number }).lineNo).toBeTypeOf('number')
  })

  it('U12: GitPanel 文件名注入按钮注入 path-only（target=current）', async () => {
    const wrapper = mount(GitPanel, { global: { stubs: { Input: SIMPLE } } })
    const store = composerInjectionStore
    const btn = wrapper.find('[data-testid="git-inject-file"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')

    expect(store.pendingInjection.value).not.toBeNull()
    expect(store.pendingInjection.value?.path).toBe('src/foo.ts')
    expect(store.pendingInjection.value?.target).toBe('current')
    expect(store.pendingInjection.value?.lineStart).toBeUndefined()
  })
})

// ======================================================================
// ← components/panel/__tests__/ModelSelectPopover.spec.ts
// ======================================================================

let wrapper: ReturnType<typeof mount> | null = null

const OPENAI_MODELS = [
  { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai', providerName: 'OpenAI', enabled: true },
  { id: 'gpt-5', name: 'GPT-5', providerId: 'openai', providerName: 'OpenAI', enabled: true },
]

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** 打开 popover（点击默认 trigger），返回 body 中 popover 内容文本 */
async function openPopover(): Promise<string> {
  const trigger = wrapper!.find('button')
  await trigger.trigger('click')
  await flushPromises()
  return document.body.textContent ?? ''
}

describe('ModelSelectPopover 空态区分（P2）', () => {
  it('模型池为空 → 引导空态（无匹配搜索文案不出现）', async () => {
    getSettingsStore().models.value = []
    wrapper = mount(ModelSelectPopover, { props: { selected: '' } })
    await flushPromises()

    const bodyText = await openPopover()
    expect(bodyText).toContain('暂无可用模型，请先在设置中导入凭据或配置供应商')
    expect(bodyText).not.toContain('无匹配模型')
  })

  it('有模型但搜索无结果 → 「无匹配模型」空态', async () => {
    getSettingsStore().models.value = OPENAI_MODELS
    wrapper = mount(ModelSelectPopover, { props: { selected: 'openai/gpt-4o' } })
    await flushPromises()

    await openPopover()
    // 输入不存在的模型名
    const input = document.body.querySelector('input') as HTMLInputElement
    input.value = 'no-such-model'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('无匹配模型')
    expect(bodyText).not.toContain('暂无可用模型')
  })

  it('有模型且搜索命中 → 列表渲染，无空态', async () => {
    getSettingsStore().models.value = OPENAI_MODELS
    wrapper = mount(ModelSelectPopover, { props: { selected: 'openai/gpt-4o' } })
    await flushPromises()

    const bodyText = await openPopover()
    expect(bodyText).toContain('GPT-5')
    expect(bodyText).not.toContain('无匹配模型')
  })

  it('ModelPickerPanel 抽取回归：搜索框 + provider 分组标题 + 列表项 testid（用户可见 DOM）', async () => {
    getSettingsStore().models.value = OPENAI_MODELS
    wrapper = mount(ModelSelectPopover, { props: { selected: 'openai/gpt-4o' } })
    await flushPromises()

    await openPopover()
    expect(document.body.querySelector('[data-testid="model-picker-panel"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="model-picker-search"]')).not.toBeNull()
    // provider 分组标题（providerName）
    expect(document.body.textContent).toContain('OpenAI')
    // 列表项 testid（默认前缀 model-picker-item）
    expect(document.body.querySelector('[data-testid="model-picker-item-gpt-5"]')).not.toBeNull()
  })

  it('providerFilter 限定分组：只展示指定 provider 的模型', async () => {
    getSettingsStore().models.value = [
      ...OPENAI_MODELS,
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerId: 'anthropic', providerName: 'Anthropic', enabled: true },
    ]
    wrapper = mount(ModelSelectPopover, {
      props: { selected: 'openai/gpt-4o', providerFilter: ['openai'] },
    })
    await flushPromises()

    const bodyText = await openPopover()
    expect(bodyText).toContain('GPT-5')
    expect(bodyText).not.toContain('Claude Sonnet 4')
  })

  it('providerFilter 限定 provider 无模型 → 引导空态（区分「搜索无结果」）', async () => {
    getSettingsStore().models.value = [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerId: 'anthropic', providerName: 'Anthropic', enabled: true },
    ]
    wrapper = mount(ModelSelectPopover, {
      props: { selected: 'openai/gpt-4o', providerFilter: ['openai'] },
    })
    await flushPromises()

    const bodyText = await openPopover()
    expect(bodyText).toContain('暂无可用模型，请先在设置中导入凭据或配置供应商')
    expect(bodyText).not.toContain('无匹配模型')
  })

  it('trigger slot：自定义触发器可打开 popover 并选中模型', async () => {
    getSettingsStore().models.value = OPENAI_MODELS
    wrapper = mount(ModelSelectPopover, {
      props: { selected: 'openai/gpt-4o' },
      slots: {
        trigger: () => h(PopoverTrigger, { 'as-child': true }, {
          default: () => h(Button, { 'data-testid': 'custom-trigger', variant: 'ghost' }, () => '默认供应商'),
        }),
      },
    })
    await flushPromises()

    // 自定义 trigger 渲染（默认 PopoverTriggerButton 不渲染）
    expect(wrapper.find('[data-testid="custom-trigger"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('默认供应商')

    await wrapper.find('[data-testid="custom-trigger"]').trigger('click')
    await flushPromises()

    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('GPT-5')
  })
})

// ======================================================================
// ← components/panel/detail-renderers/__tests__/ToolDetailRenderer.test.ts
// ======================================================================

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

  it('字节上限变体脚注 [Showing lines ... (50.0KB limit). ...] 同样剥离（pi read.js:134，of N 后带括号注记）', async () => {
    const output = 'const a = 1\nconst b = 2\n\n[Showing lines 1-2 of 200 (50.0KB limit). Use offset=3 to continue.]'
    const wrapper = mountRenderer(makeTool({ toolName: 'read', input: { path: '/tmp/foo.ts' }, output }))
    await flushPromises()
    // 修复前正则 of \d+\. 对「of 200 (50.0KB limit).」不匹配 → 脚注滞留代码区
    expect(wrapper.find('[data-testid="read-code-footer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="read-code-footer"]').text()).toContain('50.0KB limit')
    expect(wrapper.find('[data-testid="read-code-footer"]').text()).toContain('Use offset=3')
    expect(wrapper.text()).toContain('const a = 1')
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
