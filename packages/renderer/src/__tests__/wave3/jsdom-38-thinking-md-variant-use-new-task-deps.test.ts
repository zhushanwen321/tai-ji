// @vitest-environment jsdom
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps';
import { workspace } from '@/api';
import { useNewTaskDeps } from '@/composables/features/new-task/useNewTaskDeps';
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project';
import { useWorkspaceStore } from '@/stores/workspace';
import type { RecentWorkspaceRecord } from '@taiji/shared';
import { Block, MarkdownRenderer, type IncrementalMarkdownCache, type IncrementalMarkdownResult } from '@taiji/ui';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { nextTick, h } from 'vue';

// wave3 簇 [renderer/jsdom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/new-task/use-new-task-deps.test.ts
 * - __tests__/panel/thinking-md-variant.test.ts
 */

// ======================================================================
// ← __tests__/new-task/use-new-task-deps.test.ts
// ======================================================================

vi.mock('@/api', () => ({
  project: {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
  },
  workspace: {
    listRecent: vi.fn().mockResolvedValue([]),
    record: vi.fn(),
    detect: vi.fn(),
    defaultSessionDir: vi.fn().mockResolvedValue(''),
    setPinned: vi.fn(),
  },
}))
vi.mock('@/composables/features/settings/usePiPresets', () => ({
  usePiPresets: () => ({ loadPresets: vi.fn(), setDefault: vi.fn() }),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@taiji/core/transport/api/domains/worktree', () => ({
  worktreeApi: { listBranches: vi.fn(), create: vi.fn() },
}))
vi.mock('@/lib/ipc', () => ({ pickDirectory: vi.fn() }))
// flow 壳只透传引用（Landing provide 后 ui 组件消费），真实 core 状态机不在本测范围
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ state: { value: 'idle' as string } }),
  resetNewTaskFlow: vi.fn(),
}))

const mockSetPinnedApi = workspace.setPinned as unknown as ReturnType<typeof vi.fn>

function mkRecord(cwd: string, lastUsedAt: number): RecentWorkspaceRecord {
  return { cwd, lastUsedAt, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockSetPinnedApi.mockReset()
})

describe('useNewTaskDeps 组装（store ref 同源透传）', () => {
  it('recentWorkspaces 与 workspaceStore.records 同源：store 更新 → deps ref 同步变化', () => {
    const ws = useWorkspaceStore()
    const deps = useNewTaskDeps()
    expect(deps.recentWorkspaces.value).toEqual([])
    ws.records = [mkRecord('/repo-a', 300)]
    expect(deps.recentWorkspaces.value).toHaveLength(1)
    expect(deps.recentWorkspaces.value[0]!.cwd).toBe('/repo-a')
  })

  it('defaultSessionDir 透传 workspaceStore ref：store 拉取后 deps 侧可见', async () => {
    const ws = useWorkspaceStore()
    const deps = useNewTaskDeps()
    expect(deps.defaultSessionDir.value).toBe('')
    ws.defaultSessionDir = '/data/defaultSession'
    expect(deps.defaultSessionDir.value).toBe('/data/defaultSession')
  })

  it('projects/activeProjectId 透传 projectStore（orderedProjects 渲染序 + 默认 project 锚定）', async () => {
    const proj = useProjectStore()
    const deps = useNewTaskDeps()
    // 初始兜底态：默认 project 恒在（UI 永不空态），activeProjectId = 默认锚定
    expect(deps.activeProjectId.value).toBe(DEFAULT_PROJECT_ID)
    expect(deps.projects.value.some((p) => p.id === DEFAULT_PROJECT_ID)).toBe(true)
    // 同源验证：projectStore.projects 变化 → deps.projects（orderedProjects 派生）同步
    proj.projects = [
      { id: 'proj-a', name: 'Alpha', lastUsedAt: 100 },
      { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
    ]
    expect(deps.projects.value.map((p) => p.id)).toContain('proj-a')
    proj.activeProjectId = 'proj-a'
    expect(deps.activeProjectId.value).toBe('proj-a')
  })

  it('setPinned 委托 workspaceStore.setPinned（透传参数与返回值）', async () => {
    mockSetPinnedApi.mockResolvedValue({ records: [mkRecord('/x', 1)], degraded: false })
    const deps = useNewTaskDeps()
    const ok = await deps.setPinned('/x', true)
    expect(mockSetPinnedApi).toHaveBeenCalledWith('/x', true)
    expect(ok).toBe(true)
  })

  it('api 域字段透传：listBranches/createWorktree/detectWorkspace/pickDirectory/presets 等在场', () => {
    const deps = useNewTaskDeps()
    expect(typeof deps.listBranches).toBe('function')
    expect(typeof deps.createWorktree).toBe('function')
    expect(typeof deps.detectWorkspace).toBe('function')
    expect(typeof deps.pickDirectory).toBe('function')
    expect(typeof deps.loadPresets).toBe('function')
    expect(typeof deps.setDefaultPreset).toBe('function')
    expect(deps.presets.value).toEqual([])
    expect(deps.defaultPresetId.value).toBe('')
    expect(typeof deps.toast.error).toBe('function')
  })
})

// ======================================================================
// ← __tests__/panel/thinking-md-variant.test.ts
// ======================================================================

// renderMarkdown 经 deps 注入：同步返回 markdown 结构段（绕过 shiki 异步加载）
const mockRenderMarkdown = vi.fn()

// H2 后 MarkdownRenderer watch 改用 rAF 调度渲染。这些用例不验证节流时序，
// 只需 rAF 回调同步执行（mount 后 nextTick 即渲染完成）。
const _originalRAF = globalThis.requestAnimationFrame
const _originalCAF = globalThis.cancelAnimationFrame
beforeAll(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterAll(() => {
  globalThis.requestAnimationFrame = _originalRAF
  globalThis.cancelAnimationFrame = _originalCAF
})

/** MermaidRenderer stub（ui 包内部相对 import，按组件名 stub） */
const MermaidStub = {
  name: 'MermaidRenderer',
  props: ['source'],
  setup(props: { source: string }) {
    return () => h('div', { class: 'stub-mermaid' }, props.source)
  },
}

/** AmbiguousFilePopover stub（返回注释 vnode，不占 .md-render 直接子节点） */
const AmbiguousPopoverStub = { name: 'AmbiguousFilePopover', render: () => null }

/** 让 mockRenderMarkdown 返回 markdown 结构段（模拟 markdown-it 解析结果） */
function mockMarkdownSegments(html: string): void {
  mockRenderMarkdown.mockReturnValue([{ type: 'text', content: html }])
}

/** mount 公共 deps（renderMarkdown mock + 子组件 stub）。
 *  [D6 收敛] renderMarkdownIncremental 必填后渲染走增量通道：桥接 mockRenderMarkdown 输出
 *  为单帧增量 tail，使 mockMarkdownSegments 喂的段真实进渲染树。 */
function mountWithDeps(comp: unknown, props: Record<string, unknown>) {
  const renderMarkdownIncremental = vi.fn(
    async (source: string, cache: IncrementalMarkdownCache | null): Promise<IncrementalMarkdownResult & { cache: IncrementalMarkdownCache }> => ({
      prefixSegments: [],
      tailSegments: await mockRenderMarkdown(source),
      stableBoundary: 0,
      mode: 'incremental' as const,
      cache: cache ?? { boundary: 0, prefixText: '', prefixSegments: [], nextSegId: 0 },
    }),
  )
  return mount(comp as never, {
    props,
    global: {
      provide: mockChatProvide({ renderMarkdown: mockRenderMarkdown, renderMarkdownIncremental }),
      stubs: { MermaidRenderer: MermaidStub, AmbiguousFilePopover: AmbiguousPopoverStub },
    },
  })
}

describe('W1: MarkdownRenderer variant="thinking" 降级样式', () => {
  it('variant="thinking" → root div 含 .md-render--thinking class', async () => {
    mockMarkdownSegments('<p>test</p>')
    const wrapper = mountWithDeps(MarkdownRenderer, { content: 'test', variant: 'thinking' })
    await nextTick()
    await nextTick()
    // 关键断言：thinking 变体在 root 加 class（当前无 variant prop，红灯）
    expect(wrapper.find('.md-render--thinking').exists()).toBe(true)
  })

  it('默认（无 variant）→ root 不含 .md-render--thinking class（向后兼容）', async () => {
    mockMarkdownSegments('<p>test</p>')
    const wrapper = mountWithDeps(MarkdownRenderer, { content: 'test' })
    await nextTick()
    await nextTick()
    // 无 variant 时不应加 thinking class（现有 7 处调用零影响）
    expect(wrapper.find('.md-render--thinking').exists()).toBe(false)
  })
})

describe('W2: Block thinking 块走 MarkdownRenderer（不再纯文本插值）', () => {
  it('thinking 内容 **粗体** → 渲染为 <strong> 元素（非字面星号）', async () => {
    mockMarkdownSegments('<p>这是<strong>粗体</strong>内容</p>')
    // working=false + collapsed=false 才会渲染 .trace-think-body（MarkdownRenderer）
    // working=true 时内容在 header 行内联显示（plain text），不走 MarkdownRenderer
    const wrapper = mountWithDeps(Block, {
      type: 'thinking',
      content: '这是**粗体**内容',
      working: false,
      collapsed: false,
    })
    await nextTick()
    await nextTick()
    // 关键断言：thinking 内容走 markdown 渲染后，<strong> 元素存在于 DOM
    expect(wrapper.find('strong').exists()).toBe(true)
    expect(wrapper.text()).toContain('粗体')
    // 展开后预览文本用 invisible 隐藏（占位不显示），原始 ** 仍在 DOM 但不可见
    // 检查 preview span 有 invisible class（而非断言 ** 不在文本中）
    const previewSpan = wrapper.find('.text-neutral-dim.invisible')
    expect(previewSpan.exists()).toBe(true)
  })

  it('thinking 内容无全局 italic（md 结构 + italic 可读性差）', async () => {
    mockMarkdownSegments('<p>test</p>')
    // working=false + collapsed=false 才渲染 .trace-think-body
    const wrapper = mountWithDeps(Block, {
      type: 'thinking',
      content: 'test',
      working: false,
      collapsed: false,
    })
    await nextTick()
    await nextTick()
    // 当前实现有 italic class（红灯——改后应移除）
    const italicEls = wrapper.findAll('.italic')
    expect(italicEls.length).toBe(0)
  })
})
