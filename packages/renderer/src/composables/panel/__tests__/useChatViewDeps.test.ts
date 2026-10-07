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
import * as events from '@taiji/core/transport/api'
import type { FileNode } from '@taiji/shared'

const mockRenderMarkdownSegments = vi.fn(async () => [{ type: 'text', content: '<p>x</p>' }])
const mockRenderIncremental = vi.fn(async () => ({
  prefixSegments: [],
  tailSegments: [],
  stableBoundary: 0,
  mode: 'incremental' as const,
}))
const mockServable = vi.fn()
const mockLocalFileRead = vi.fn()

vi.mock('@/lib/ipc', () => ({
  localFileServable: (...args: unknown[]) => mockServable(...(args as [string])),
  localFileRead: (...args: unknown[]) => mockLocalFileRead(...(args as [string])),
}))

vi.mock('@taiji/ui/features/chat/markdown', () => ({
  renderMarkdownSegments: (...args: unknown[]) => mockRenderMarkdownSegments(...(args as [string, unknown])),
}))
vi.mock('@taiji/ui/features/chat/markdown-incremental', () => ({
  createIncrementalRenderCache: () => ({ boundary: 0, prefixText: '', prefixSegments: [], nextSegId: 0 }),
  renderIncremental: (...args: unknown[]) => mockRenderIncremental(...(args as [string, unknown, unknown, unknown])),
  STREAMING_FENCE_SILENCE_MS: 200,
}))
vi.mock('@taiji/ui/features/chat/mermaid', () => ({
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
function assemble(
  sid: ReturnType<typeof ref<string>>,
  override?: {
    resourceBaseDir?: ComputedRef<string | undefined>
    mainSessionId?: ComputedRef<string | undefined>
  },
) {
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
      copyLabel: '复制',
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
        copyLabel: '复制',
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
      copyLabel: '复制',
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
    // 经 assemble（effectScope）装配：装配器现在持有 events.on 订阅（turn-settle 刷新），
    // 裸调会在本用例结束时泄漏事件注册表条目（无 scope 承接 onScopeDispose）
    const deps = assemble(sid)
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
      copyLabel: '复制',
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

describe('useChatViewDeps — turn settled 白名单刷新（agent 落盘文件进入链接白名单）', () => {
  it('message.complete（本 session）→ 重拉 file.search，turn 内新建文件进入 filePaths 白名单', async () => {
    const deps = assemble(ref('s1'))
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledTimes(1) // 挂载时首拉
    // turn 内 agent 新建文件：下一帧 complete 时 file.search 返回包含新文件的结果
    mockLoad.mockResolvedValueOnce([fileNode('new-doc.md', '/proj-a/docs/todo/new-doc.md')])
    events.dispatchSession('s1', { type: 'message.complete', payload: { sessionId: 's1' } })
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledTimes(2)
    await deps.renderMarkdown('after-turn')
    const env = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string> }
    expect(env.filePaths.has('/proj-a/docs/todo/new-doc.md')).toBe(true)
  })

  it('message.error（本 session）同样触发刷新（turn 异常收口，写盘可能已发生）', async () => {
    assemble(ref('s1'))
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledTimes(1)
    mockLoad.mockResolvedValueOnce([fileNode('w.md', '/proj-a/w.md')])
    events.dispatchSession('s1', { type: 'message.error', payload: { sessionId: 's1', message: 'x' } })
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledTimes(2)
  })

  it('其他 session 的 complete 不触发本装配器刷新（订阅按 sid 隔离）', async () => {
    assemble(ref('s1'))
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledTimes(1)
    events.dispatchSession('s2', { type: 'message.complete', payload: { sessionId: 's2' } })
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledTimes(1)
  })

  it('内容等价守卫：无文件变化的 turn 重拉但 Set 引用恒等（增量渲染缓存不失效、零重渲染）', async () => {
    mockLoad.mockResolvedValue([fileNode('a.ts', '/proj-a/a.ts')])
    const deps = assemble(ref('s1'))
    await flushPromises()
    await deps.renderMarkdown('before')
    const envBefore = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string> }
    events.dispatchSession('s1', { type: 'message.complete', payload: { sessionId: 's1' } })
    await flushPromises()
    await deps.renderMarkdown('after')
    const envAfter = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string> }
    expect(mockLoad).toHaveBeenCalledTimes(2) // 刷新发生了
    expect(envAfter.filePaths).toBe(envBefore.filePaths) // 但引用恒等 → env 签名不变 → 不重建
  })

  it('切 session 后旧 sid 的 complete 不再触发刷新（重订退订），新 sid 正常触发', async () => {
    const sid = ref('s1')
    assemble(sid)
    await flushPromises()
    sid.value = 's2'
    await flushPromises()
    const callsAfterSwitch = mockLoad.mock.calls.length
    events.dispatchSession('s1', { type: 'message.complete', payload: { sessionId: 's1' } })
    await flushPromises()
    expect(mockLoad.mock.calls.length).toBe(callsAfterSwitch)
    events.dispatchSession('s2', { type: 'message.complete', payload: { sessionId: 's2' } })
    await flushPromises()
    expect(mockLoad.mock.calls.length).toBe(callsAfterSwitch + 1)
  })

  it('scope 销毁后退订（onScopeDispose）：complete 帧不再触发 load（无跨用例 handler 泄漏）', async () => {
    assemble(ref('s1'))
    await flushPromises()
    scope?.stop()
    const callsAfterStop = mockLoad.mock.calls.length
    events.dispatchSession('s1', { type: 'message.complete', payload: { sessionId: 's1' } })
    await flushPromises()
    expect(mockLoad.mock.calls.length).toBe(callsAfterStop)
  })
})

describe('useChatViewDeps — 虚拟 id 解析（fileSearch vid 修复：需要真实 id 的 RPC 调用方先解析）', () => {
  it('agentcall vid + mainSessionId override → file.search 收到真实归属 sid（非 vid）', async () => {
    mockLoad.mockResolvedValue([fileNode('f.md', '/proj-a/f.md')])
    const deps = assemble(ref('agentcall:acs-1'), { mainSessionId: computed(() => 's1') })
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledWith('s1')
    // 白名单与 resourceBaseDir 都按归属 session 落位（不再降级空集/undefined）
    await deps.renderMarkdown('after-load')
    const env = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string>; resourceBaseDir?: string }
    expect(env.filePaths.has('/proj-a/f.md')).toBe(true)
    expect(env.resourceBaseDir).toBe('/home/demo/project-a')
  })

  it('agentcall vid 无 override → 不发起必失败的 file.search（零 RPC 零 warn）+ 白名单空集', async () => {
    const deps = assemble(ref('agentcall:acs-1'))
    await flushPromises()
    expect(mockLoad).not.toHaveBeenCalled()
    await deps.renderMarkdown('degraded')
    const env = mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { filePaths: Set<string>; resourceBaseDir?: string }
    expect(env.filePaths.size).toBe(0)
    expect(env.resourceBaseDir).toBeUndefined()
  })

  it('subagent 三段式 vid → 从 vid 自解析 mainSid 发起 file.search（无需 override）', async () => {
    const deps = assemble(ref('subagent:s1:sub-1'))
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledWith('s1')
    await deps.renderMarkdown('x')
    expect((mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { resourceBaseDir?: string }).resourceBaseDir).toBe('/home/demo/project-a')
  })

  it('btw 两段式 vid → 解析到内嵌线 pi session id', async () => {
    const deps = assemble(ref('btw:s2'))
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledWith('s2')
    await deps.renderMarkdown('x')
    expect((mockRenderMarkdownSegments.mock.calls.at(-1)![1] as { resourceBaseDir?: string }).resourceBaseDir).toBe('/home/demo/project-b')
  })

  it('真实 sid 直通不回归：file.search 收到原样 sid', async () => {
    assemble(ref('s1'))
    await flushPromises()
    expect(mockLoad).toHaveBeenCalledWith('s1')
  })

  it('deps.sessionCwdOf 对 vid 解析后查 cwd（MarkdownRenderer ④路点击消费面）', () => {
    const deps = assemble(ref('s1'), { mainSessionId: computed(() => 's1') })
    expect(deps.sessionCwdOf?.('subagent:s1:sub-9')).toBe('/home/demo/project-a')
    expect(deps.sessionCwdOf?.('agentcall:acs-1')).toBe('/home/demo/project-a')
    expect(deps.sessionCwdOf?.('btw:s2')).toBe('/home/demo/project-b')
    // agentcall vid 一律解析到挂载链 owner（第二段 acsId 不参与归属判定——同视图分区共享归属）
    expect(deps.sessionCwdOf?.('agentcall:other')).toBe('/home/demo/project-a')
  })

  it('mainSessionId override 响应式：owner 变化后解析跟随（sessionCwdOf 读 .value）', () => {
    const owner = ref('s1')
    const deps = assemble(ref('agentcall:acs-1'), { mainSessionId: computed(() => owner.value) })
    expect(deps.sessionCwdOf?.('agentcall:acs-1')).toBe('/home/demo/project-a')
    owner.value = 's2'
    expect(deps.sessionCwdOf?.('agentcall:acs-1')).toBe('/home/demo/project-b')
  })
})

describe('useChatViewDeps — 产物预检与源码读取接线（chat-html-support §6.3 D3 / §6.9 D9）', () => {
  it('probeArtifact 委托 lib/ipc.localFileServable（产物目录 cwd 外，预检落主进程）', async () => {
    mockServable.mockResolvedValue({ servable: true, size: 2048 })
    const deps = assemble(ref('s1'))
    await expect(deps.probeArtifact('/data/artifacts/s1/x.html')).resolves.toEqual({ servable: true, size: 2048 })
    expect(mockServable).toHaveBeenCalledWith('/data/artifacts/s1/x.html')
  })

  it('readArtifact 白名单命中 → { content }（HtmlPreviewInline 源码态消费）', async () => {
    mockLocalFileRead.mockResolvedValue({ ok: true, content: '<html>x</html>', truncated: false })
    const deps = assemble(ref('s1'))
    await expect(deps.readArtifact('/data/artifacts/s1/x.html')).resolves.toEqual({ content: '<html>x</html>' })
    expect(mockLocalFileRead).toHaveBeenCalledWith('/data/artifacts/s1/x.html')
  })

  it('readArtifact 结构化失败（not_found）→ reject 附 reason 结构化属性 + message 保留诊断（容器按原因显文案）', async () => {
    mockLocalFileRead.mockResolvedValue({ ok: false, reason: 'not_found' })
    const deps = assemble(ref('s1'))
    // 结构化透传：容器（HtmlPreviewInline）按 err.reason 显具体原因文案（panel.detail.htmlReason*）
    await expect(deps.readArtifact('/data/artifacts/s1/gone.html')).rejects.toMatchObject({ reason: 'not_found' })
    // message 保留：console 诊断仍可见原始原因
    await expect(deps.readArtifact('/data/artifacts/s1/gone.html')).rejects.toThrow('not_found')
  })
})
