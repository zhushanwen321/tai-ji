// @vitest-environment jsdom
// jsdom：本文件断言 renderMarkdown env 透传（mock 层），无 DOM 断言；与管线测试族同环境
// 惯例（U1 起管线族钉 jsdom），避免 happy-dom/jsdom 混跑同一装配器时环境漂移。
/**
 * useChatViewDeps 装配器单测（U3：resourceBaseDir 传值矩阵——对话流 cwd 装配面）。
 *
 * 覆盖（设计 markdown-html-sanitize-render D4 传值矩阵「对话流」行）：
 * - renderMarkdown 的 env 携带 session cwd（sessionStore.list 按 id 查，与 filePaths/localFiles 同层）
 * - renderMarkdownIncremental 的 env 同层携带（增量轴 env 签名的数据源）
 * - 未知 sid / 空 sessionId → resourceBaseDir undefined（该消息不做相对资源解析）
 * - sessionId ref 变化（切 session）→ 下次装配取新 cwd（响应式）
 *
 * mock 策略：store/composable 全部 mock 为零依赖 stub（装配器是纯编排层，测试目标只有
 * env 装配正确性）；markdown/incremental 渲染函数 mock 捕获 env 参数断言（不跑真管线）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, nextTick, effectScope, type EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const mockRenderMarkdownSegments = vi.fn(async () => [{ type: 'text', content: '<p>x</p>' }])
const mockRenderIncremental = vi.fn(async () => ({
  prefixSegments: [],
  tailSegments: [],
  stableBoundary: 0,
  mode: 'incremental' as const,
}))

vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdownSegments: (...args: unknown[]) => mockRenderMarkdownSegments(...(args as [string, unknown])),
}))
vi.mock('@/composables/logic/markdown-incremental', () => ({
  createIncrementalRenderCache: () => ({ boundary: 0, prefixText: '', prefixSegments: [], nextSegId: 0 }),
  renderIncremental: (...args: unknown[]) => mockRenderIncremental(...(args as [string, unknown, unknown, unknown])),
  shouldFinalizeStreamingFence: () => true,
  STREAMING_FENCE_SILENCE_MS: 200,
}))
vi.mock('@/composables/logic/mermaid', () => ({
  renderMermaid: vi.fn(async () => ({ svg: '' })),
}))
vi.mock('@/composables/logic/messageFormat', () => ({
  assistantToMarkdown: vi.fn(() => ''),
}))

/** sessionStore.list fixture：两 session 两 cwd（切 session 断言用） */
const sessionList = [
  { id: 's1', cwd: '/home/demo/project-a' },
  { id: 's2', cwd: '/home/demo/project-b' },
]
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ list: sessionList }),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    getMessages: () => [],
    isActive: () => false,
    isHandingOff: () => false,
    getChangeSetStatus: () => undefined,
    isPendingSend: () => false,
  }),
}))
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ abortBash: vi.fn(), editAndResend: vi.fn() }),
}))
vi.mock('@/composables/panel/useTurnExpansion', () => ({
  useTurnExpansion: () => ({ isExpanded: () => false, toggle: vi.fn(), collapse: vi.fn(), isTakeover: () => false, setTakeover: vi.fn() }),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), handoff: vi.fn() }),
}))
vi.mock('@/composables/features/drawer/useSideDrawer', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/features/drawer/useSideDrawer')>()
  return { ...original, useSideDrawer: () => ({ open: vi.fn() }) }
})
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ selectFile: vi.fn() }),
}))
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: vi.fn().mockResolvedValue([]) }),
}))
vi.mock('@/composables/panel/useForkModeChannel', () => ({ triggerEnterForkMode: vi.fn() }))
vi.mock('@/composables/panel/useHandoffModeChannel', () => ({ triggerEnterHandoffMode: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 装配器在组件 setup 外直调：effectScope 提供响应式上下文（onScopeDispose 等不告警），用完 stop */
let scope: EffectScope | null = null
function assemble(sid: ReturnType<typeof ref<string>>) {
  scope = effectScope()
  return scope.run(() => useChatViewDeps(sid))!
}
afterEach(() => {
  scope?.stop()
  scope = null
})

describe('useChatViewDeps — resourceBaseDir 传值矩阵（对话流 cwd 装配，设计 D4）', () => {
  it('renderMarkdown env 携带 session cwd（sessionStore.list 按 id 查，与 filePaths/localFiles 同层）', async () => {
    const deps = assemble(ref('s1'))
    await deps.renderMarkdown('hello', 's1')
    expect(mockRenderMarkdownSegments).toHaveBeenCalledWith('hello', {
      filePaths: expect.any(Set),
      localFiles: expect.any(Set),
      resourceBaseDir: '/home/demo/project-a',
    })
  })

  it('renderMarkdownIncremental env 同层携带（增量轴 env 签名的数据源）', async () => {
    const deps = assemble(ref('s2'))
    await deps.renderMarkdownIncremental('hello', null, 's2')
    expect(mockRenderIncremental).toHaveBeenCalledWith(
      'hello',
      expect.anything(),
      {
        filePaths: expect.any(Set),
        localFiles: expect.any(Set),
        resourceBaseDir: '/home/demo/project-b',
      },
      undefined,
    )
  })

  it('未知 sid → resourceBaseDir undefined（该消息不做相对资源解析）', async () => {
    const deps = assemble(ref('unknown-sid'))
    await deps.renderMarkdown('hello')
    expect(mockRenderMarkdownSegments).toHaveBeenCalledWith('hello', {
      filePaths: expect.any(Set),
      localFiles: expect.any(Set),
      resourceBaseDir: undefined,
    })
  })

  it('空 sessionId → resourceBaseDir undefined', async () => {
    const deps = assemble(ref(''))
    await deps.renderMarkdown('hello')
    const env = mockRenderMarkdownSegments.mock.calls[0]?.[1] as { resourceBaseDir?: string }
    expect(env.resourceBaseDir).toBeUndefined()
  })

  it('sessionId ref 变化（切 session）→ 下次装配取新 cwd（响应式）', async () => {
    const sid = ref('s1')
    const deps = useChatViewDeps(sid)
    await deps.renderMarkdown('a')
    expect((mockRenderMarkdownSegments.mock.calls[0]?.[1] as { resourceBaseDir?: string }).resourceBaseDir).toBe('/home/demo/project-a')
    sid.value = 's2'
    await nextTick()
    await deps.renderMarkdown('b')
    expect((mockRenderMarkdownSegments.mock.calls[1]?.[1] as { resourceBaseDir?: string }).resourceBaseDir).toBe('/home/demo/project-b')
  })
})
