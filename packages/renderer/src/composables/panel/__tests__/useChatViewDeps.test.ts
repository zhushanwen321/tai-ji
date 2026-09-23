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
import { mount, flushPromises } from '@vue/test-utils'
import { computed, defineComponent, h, inject, provide, nextTick, effectScope, ref, type EffectScope, type ComputedRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { ChatViewDepsKey, type ChatViewDeps } from '@taiji/ui'
import type { FileNode } from '@taiji/shared'

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
// 共享可控 load mock（RD-1#1 迟到返回用例需要手控 resolve 时序；vi.hoisted 供 mock 工厂引用）
const mockLoad = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: mockLoad }),
}))
vi.mock('@/composables/panel/useForkModeChannel', () => ({ triggerEnterForkMode: vi.fn() }))
vi.mock('@/composables/panel/useHandoffModeChannel', () => ({ triggerEnterHandoffMode: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'

/** FileNode 便捷构造（collectFilePaths/collectBasenames 只消费 type/name/path） */
function fileNode(name: string, path: string): FileNode {
  return { type: 'file', name, path } as FileNode
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 共享 load mock 复位 + 默认空结果（既有用例依赖「load 恒成功返回空」行为）
  mockLoad.mockReset()
  mockLoad.mockResolvedValue([])
})

/** 装配器在组件 setup 外直调：effectScope 提供响应式上下文（onScopeDispose 等不告警），用完 stop */
let scope: EffectScope | null = null
function assemble(sid: ReturnType<typeof ref<string>>, override?: { resourceBaseDir?: ComputedRef<string | undefined> }) {
  scope = effectScope()
  return scope.run(() => useChatViewDeps(sid, override))!
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

describe('useChatViewDeps — sessionCwdOf deps 字段 + override 传值矩阵（设计 D4 双通道）', () => {
  it('deps.sessionCwdOf 按 id 查 cwd（与 env 装配同源）；未知/空 sid → undefined', () => {
    const deps = assemble(ref('s1'))
    expect(deps.sessionCwdOf).toBeTypeOf('function')
    expect(deps.sessionCwdOf?.('s1')).toBe('/home/demo/project-a')
    expect(deps.sessionCwdOf?.('s2')).toBe('/home/demo/project-b')
    expect(deps.sessionCwdOf?.('unknown')).toBeUndefined()
    expect(deps.sessionCwdOf?.('')).toBeUndefined()
  })

  it('override 传入 → env 通道用覆盖值（drawer 文件目录语义，session cwd 被覆盖）', async () => {
    const deps = assemble(ref('s1'), { resourceBaseDir: computed(() => '/home/demo/project-a/docs') })
    await deps.renderMarkdown('hello')
    expect(mockRenderMarkdownSegments).toHaveBeenCalledWith('hello', {
      filePaths: expect.any(Set),
      localFiles: expect.any(Set),
      resourceBaseDir: '/home/demo/project-a/docs',
    })
  })

  it('override computed 变化 → env 跟随（直用调用方 computed 不包层，仍响应式）', async () => {
    const dir = ref('/dir-1')
    const deps = assemble(ref('s1'), { resourceBaseDir: computed(() => dir.value) })
    await deps.renderMarkdown('a')
    expect((mockRenderMarkdownSegments.mock.calls[0]?.[1] as { resourceBaseDir?: string }).resourceBaseDir).toBe('/dir-1')
    dir.value = '/dir-2'
    await deps.renderMarkdown('b')
    expect((mockRenderMarkdownSegments.mock.calls[1]?.[1] as { resourceBaseDir?: string }).resourceBaseDir).toBe('/dir-2')
  })

  it('未传 override → env 保持 session cwd（MessageStream 主 provide / CommandDocPanel 形态不回归）', async () => {
    const deps = assemble(ref('s1'))
    await deps.renderMarkdown('hello')
    expect((mockRenderMarkdownSegments.mock.calls[0]?.[1] as { resourceBaseDir?: string }).resourceBaseDir).toBe('/home/demo/project-a')
  })

  it('面板 provide 作用域集成：宿主 provide 工厂 deps → 子组件 inject 到的 renderMarkdown env 携带 cwd（CommandDocPanel.vue:143 / DetailPane.vue:284 同范式）', async () => {
    let injected: ChatViewDeps | undefined
    const Probe = defineComponent({
      setup() {
        injected = inject(ChatViewDepsKey)
        return () => null
      },
    })
    const Host = defineComponent({
      setup() {
        provide(ChatViewDepsKey, useChatViewDeps(ref('s1')))
        return () => h(Probe)
      },
    })
    const wrapper = mount(Host)
    await injected!.renderMarkdown('hello')
    expect((mockRenderMarkdownSegments.mock.calls[0]?.[1] as { resourceBaseDir?: string }).resourceBaseDir).toBe('/home/demo/project-a')
    wrapper.unmount()
  })
})

describe('useChatViewDeps — 文件白名单代际守卫（RD-1#1：迟到 file.search 不覆盖新 session）', () => {
  it('A session 的 file.search 迟到返回，不覆盖 B session 已落位的白名单（跨 session 串台守卫）', async () => {
    // s1 的 load 挂起（手控 resolve），s2 的 load 立即返回
    let resolveS1!: (nodes: FileNode[]) => void
    mockLoad.mockImplementation((sid: string) => {
      if (sid === 's1') {
        return new Promise<FileNode[]>((resolve) => { resolveS1 = resolve })
      }
      return Promise.resolve([fileNode('s2-file.ts', '/proj-b/s2-file.ts')])
    })
    const sid = ref('s1')
    const deps = assemble(sid)
    // 切到 s2：s2 白名单经 async 链落位
    sid.value = 's2'
    await flushPromises()
    await deps.renderMarkdown('after-switch')
    let env = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string> }
    expect([...env.filePaths]).toEqual(['/proj-b/s2-file.ts'])
    // s1 的 file.search 此时才迟到返回 → 必须被代际守卫丢弃，不得回写白名单
    resolveS1([fileNode('s1-file.ts', '/proj-a/s1-file.ts')])
    await flushPromises()
    await deps.renderMarkdown('after-late')
    env = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string> }
    expect([...env.filePaths]).toEqual(['/proj-b/s2-file.ts'])
    expect(env.filePaths.has('/proj-a/s1-file.ts')).toBe(false)
  })

  it('未切 session 时迟到返回正常落位（守卫不误杀同 session 的正常异步写入）', async () => {
    let resolveS1!: (nodes: FileNode[]) => void
    mockLoad.mockImplementation(() => new Promise<FileNode[]>((resolve) => { resolveS1 = resolve }))
    const deps = assemble(ref('s1'))
    await flushPromises() // 首订 load 已发起但未 resolve
    resolveS1([fileNode('s1-file.ts', '/proj-a/s1-file.ts')])
    await flushPromises()
    await deps.renderMarkdown('after-late')
    const env = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string> }
    expect([...env.filePaths]).toEqual(['/proj-a/s1-file.ts'])
  })

  it('A session 的 load 失败迟到发生，不清空 B session 已落位的白名单（catch 路径同受守卫约束）', async () => {
    let rejectS1!: (e: unknown) => void
    mockLoad.mockImplementation((sid: string) => {
      if (sid === 's1') {
        return new Promise<FileNode[]>((_resolve, reject) => { rejectS1 = reject })
      }
      return Promise.resolve([fileNode('s2-file.ts', '/proj-b/s2-file.ts')])
    })
    const sid = ref('s1')
    const deps = assemble(sid)
    sid.value = 's2'
    await flushPromises()
    // s1 的 load 迟到失败：不得把 s2 白名单清成空集
    rejectS1(new Error('late failure'))
    await flushPromises()
    await deps.renderMarkdown('after-late-failure')
    const env = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string> }
    expect([...env.filePaths]).toEqual(['/proj-b/s2-file.ts'])
  })
})
