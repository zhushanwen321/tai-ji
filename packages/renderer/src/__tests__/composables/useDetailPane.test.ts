// @vitest-environment node

/**
 * useDetailPane composable 单测（detail pane 预览编排 + 多文件 tab，display-containers W3）。
 *
 * 覆盖：
 * - untracked 文件 git diff 为空 → 自动降级 preview（补取 file.read）
 * - modified 文件 git diff 非空 → 保持 diff 模式
 * - 无 git 改动文件 → 直接 preview（file.read）
 * - 用户手动 toggle 切回 Diff（空 patch）→ 不降级，显示空 diff 内容
 * - U6 并发守卫（per-tab stale write + 跨 tab 不互相覆盖）
 * - S4 注入语义：未开新增并激活 / 已开仅激活（tab 计数不变、不重载）/ 不设上限
 * - S4 tab 切换关闭：激活转移右邻/左邻、全关空态、关闭清选中态
 * - S4 keep-alive 多实例：切 tab 不丢滚动锚点与面板内模式态（diff/preview）
 * - S4 selectedPath 串线终局解：per-session 分区互不干扰 + 切回恢复文件详情
 * - 变更集卡入口（detailFilePath）：首挂载 immediate 消费 + 双通道同 tick forceDiff 生效
 *
 * mock 策略：vi.mock('@/api') 聚合门面覆盖 file.read + git.getDiff，
 * vi.mock('@/stores/session')（sessionCwd 查 cwd 用）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/composables/useDetailPane.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref, nextTick, type EffectScope, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// mock @/api 聚合门面：useDetailPane 源码 import { file, git } from '@/api'，
// vitest VITE_MOCK=true 下 @/api 默认指向 mockApi fixture，须在此聚合门面层
// 覆盖 file/git 导出，否则 mock 不生效（会走 mockApi 基于文件名的 fixture 内容）。
const mockFileRead = vi.fn()
const mockGitGetDiff = vi.fn()
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  file: { read: (...args: unknown[]) => mockFileRead(...(args as [string, string?])) },
  git: { getDiff: (...args: unknown[]) => mockGitGetDiff(...(args as [string, string])) },
}))
// sessionStore.list 查 cwd（sessionCwd），此处给空列表即可（测试不涉及图片 URL）
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ list: [] }),
}))

import { useDetailPane, __loadTokenKeyCountForTest } from '@/composables/features/file-tree/useDetailPane'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'

/**
 * 在独立 effectScope 中创建 useDetailPane（watcher 泄漏防护）：
 * composable 内的 watch/watchEffect 无组件作用域时不自处置——泄漏的 watch 会继续消费
 * 共享的 detailFilePath 瞬时参数通道、并与后续用例共用模块级 loadTokens 造成跨用例干扰
 * （曾致「双通道注入」用例被前例泄漏 watch 抢先消费注入）。scope 统一 afterEach 停止。
 */
const liveScopes: EffectScope[] = []
function useDetailPaneScoped(sessionId: Ref<string | null>) {
  const scope = effectScope()
  liveScopes.push(scope)
  return scope.run(() => useDetailPane(sessionId))!
}

afterEach(() => {
  for (const scope of liveScopes.splice(0)) scope.stop()
})

/** 准备一个 session + gitOverlay 记录，返回 store */
function setupSession(sid: string, path: string, status: string) {
  const store = useFileTreeStore()
  store.setGitOverlay(sid, [{ path, xyCode: '??', status }])
  return store
}

const PATCH =
  'diff --git a/src/modified.ts b/src/modified.ts\nindex 111..222\n@@ -1 +1,2 @@\n line1\n+new line'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  resetSideDrawer()
})

describe('useDetailPane diff 空 → 自动降级 preview', () => {
  it('untracked 文件 git diff 为空 → 降级 preview + 补取 file.read', async () => {
    const sid = 's1'
    const path = 'untracked.log'
    setupSession(sid, path, 'untracked')

    // git diff 对 untracked 必空（真实 runtime 行为）
    mockGitGetDiff.mockResolvedValueOnce({ patch: '', binary: false })
    mockFileRead.mockResolvedValueOnce({ content: 'file content here', truncated: false })

    const sessionId = ref<string | null>(sid)
    const { state } = useDetailPaneScoped(sessionId)
    // 注入由 store.selectFile 同步落位（W3：不依赖组件 watch），useDetailPane 拉起加载
    const store = useFileTreeStore()
    store.selectFile(sid, path)
    await vi.waitFor(() => expect(state.value.status).toBe('content'))

    expect(state.value.viewMode).toBe('preview')
    expect(state.value.hasGitChange).toBe(true)
    expect(state.value.content).toBe('file content here')
    expect(mockGitGetDiff).toHaveBeenCalledWith(sid, path)
    expect(mockFileRead).toHaveBeenCalledWith(path, sid)
  })

  it('modified 文件 git diff 非空 → 保持 diff 模式（不补取 file.read）', async () => {
    const sid = 's1'
    const path = 'src/modified.ts'
    setupSession(sid, path, 'modified')

    mockGitGetDiff.mockResolvedValueOnce({ patch: PATCH, binary: false })

    const sessionId = ref<string | null>(sid)
    const { state } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()
    store.selectFile(sid, path)
    await vi.waitFor(() => expect(state.value.status).toBe('content'))

    expect(state.value.viewMode).toBe('diff')
    expect(state.value.content).toBe(PATCH)
    // diff 非空时不补取 file.read
    expect(mockFileRead).not.toHaveBeenCalled()
  })

  it('无 git 改动文件 → 直接 preview（file.read，不调 git.getDiff）', async () => {
    const sid = 's1'
    const path = 'clean.txt'
    // 不设 gitOverlay 记录 → hasGitChange=false → mode=preview
    mockFileRead.mockResolvedValueOnce({ content: 'clean content', truncated: false })

    const sessionId = ref<string | null>(sid)
    const { state } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()
    store.selectFile(sid, path)
    await vi.waitFor(() => expect(state.value.status).toBe('content'))

    expect(state.value.viewMode).toBe('preview')
    expect(state.value.hasGitChange).toBe(false)
    expect(state.value.content).toBe('clean content')
    expect(mockGitGetDiff).not.toHaveBeenCalled()
    expect(mockFileRead).toHaveBeenCalledWith(path, sid)
  })

  it('用户手动 toggle 切回 Diff（空 patch）→ 不降级，保留空 diff 内容', async () => {
    const sid = 's1'
    const path = 'untracked2.log'
    setupSession(sid, path, 'untracked')

    // 第一次：自动加载 → diff 空 → 降级 preview
    mockGitGetDiff.mockResolvedValueOnce({ patch: '', binary: false })
    mockFileRead.mockResolvedValueOnce({ content: 'preview content', truncated: false })

    const sessionId = ref<string | null>(sid)
    const { state, toggleView } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()
    store.selectFile(sid, path)
    await vi.waitFor(() => expect(state.value.status).toBe('content'))
    expect(state.value.viewMode).toBe('preview')

    // 用户手动 toggle 切回 Diff —— 第二次 git.getDiff 仍返回空，但不降级（toggleView 不走降级分支）
    mockGitGetDiff.mockResolvedValueOnce({ patch: '', binary: false })
    await toggleView('diff')
    await vi.waitFor(() => expect(state.value.status).toBe('content'))

    expect(state.value.viewMode).toBe('diff')
    expect(state.value.content).toBe('') // 空 patch（用户主动选择，保留空态）
  })
})

describe('U6: useDetailPane 并发守卫（W3 / L3，per-tab 粒度）', () => {
  it('慢文件的迟到响应只落在自己的 tab 实例（跨 tab 不互相覆盖）', async () => {
    vi.useFakeTimers()
    try {
      const sid = 's1'
      const sessionId = ref<string | null>(sid)

      // 第一个文件 read 延迟返回 'old-content'，第二个立即返回 'new-content'
      let resolveFirst: (val: unknown) => void = () => {}
      const firstPromise = new Promise((r) => { resolveFirst = r })
      mockFileRead.mockImplementationOnce(() => firstPromise)
      mockFileRead.mockResolvedValueOnce({ content: 'new-content', truncated: false })
      mockGitGetDiff.mockResolvedValue({ patch: '', binary: false })

      const { state, openPreview } = useDetailPaneScoped(sessionId)
      const store = useFileTreeStore()

      // 连续开两个文件（两个 tab 实例），不等第一个完成
      void openPreview(sid, 'file-a')
      void openPreview(sid, 'file-b')

      // 等第二个（立即返回）resolve
      await vi.advanceTimersByTimeAsync(0)

      // 激活实例是 file-b，content 为 'new-content'
      expect(state.value.path).toBe('file-b')
      expect(state.value.content).toBe('new-content')

      // 现在让第一个（延迟）resolve —— 迟到内容落 file-a 自己的实例，不覆盖激活实例
      resolveFirst({ content: 'old-content', truncated: false })
      await vi.advanceTimersByTimeAsync(0)

      expect(state.value.content).toBe('new-content')
      expect(store.getDetailTab(sid, 'file-a')?.content).toBe('old-content')
    } finally {
      vi.useRealTimers()
    }
  })

  it('同 tab 加载被模式切换抢占 → 旧请求 stale write 丢弃（token 守卫）', async () => {
    const sid = 's1'
    const path = 'race.txt'

    // 初始 preview 加载（慢 read 在途），随后 toggle diff（快 getDiff）
    let resolveRead: (val: unknown) => void = () => {}
    const slowRead = new Promise((r) => { resolveRead = r })
    mockFileRead.mockImplementationOnce(() => slowRead)
    mockGitGetDiff.mockResolvedValueOnce({ patch: PATCH, binary: false })

    const sessionId = ref<string | null>(sid)
    const { state, openPreview, toggleView } = useDetailPaneScoped(sessionId)

    void openPreview(sid, path)
    await vi.waitFor(() => expect(state.value.status).toBe('loading'))
    await toggleView('diff')
    expect(state.value.status).toBe('content')
    expect(state.value.viewMode).toBe('diff')

    // 慢 read 迟到 → token 不匹配，stale write 丢弃
    resolveRead({ content: 'stale content', truncated: false })
    await vi.waitFor(() => expect(mockFileRead).toHaveBeenCalled())
    expect(state.value.content).toBe(PATCH)
  })
})

describe('S4: detail 多文件 tab 注入语义（§6.3：未开新增并激活 / 已开仅激活 / 不设上限）', () => {
  it('未开文件 → 新增 tab 并激活（tab 计数 +1）', async () => {
    const sid = 's1'
    mockFileRead.mockResolvedValue({ content: 'c1', truncated: false })
    const sessionId = ref<string | null>(sid)
    const { state, tabs, activePath } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    store.selectFile(sid, 'a.txt')
    await vi.waitFor(() => expect(state.value.status).toBe('content'))
    store.selectFile(sid, 'b.txt')
    await vi.waitFor(() => expect(state.value.path).toBe('b.txt'))

    expect(tabs.value.map((t) => t.path)).toEqual(['a.txt', 'b.txt'])
    expect(activePath.value).toBe('b.txt')
    expect(store.getSelectedPath(sid)).toBe('b.txt')
  })

  it('已开文件再次命中 → 仅激活（tab 计数不变、不重载、内容保持）', async () => {
    const sid = 's1'
    mockFileRead.mockResolvedValueOnce({ content: 'a content', truncated: false })
    const sessionId = ref<string | null>(sid)
    const { state, tabs, activePath } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    store.selectFile(sid, 'a.txt')
    await vi.waitFor(() => expect(state.value.status).toBe('content'))
    mockFileRead.mockResolvedValueOnce({ content: 'b content', truncated: false })
    store.selectFile(sid, 'b.txt')
    await vi.waitFor(() => expect(state.value.path).toBe('b.txt'))
    expect(mockFileRead).toHaveBeenCalledTimes(2)

    // 再次命中已开的 a.txt → 仅激活
    store.selectFile(sid, 'a.txt')
    await nextTick()

    expect(tabs.value.length).toBe(2) // tab 计数不变
    expect(activePath.value).toBe('a.txt')
    expect(state.value.content).toBe('a content') // keep-alive：内容保持
    expect(mockFileRead).toHaveBeenCalledTimes(2) // 不重载
  })

  it('不设打开上限：连续打开 12 个文件 tab 全部共存', async () => {
    const sid = 's1'
    mockFileRead.mockResolvedValue({ content: 'x', truncated: false })
    const sessionId = ref<string | null>(sid)
    const { tabs, activePath } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    for (let i = 1; i <= 12; i++) {
      store.selectFile(sid, `f${i}.txt`)
    }
    await vi.waitFor(() => expect(tabs.value.length).toBe(12))
    expect(activePath.value).toBe('f12.txt')
    expect(tabs.value.every((t) => t.path.length > 0)).toBe(true)
  })

  it('S4 切 tab 不丢面板内模式态（diff/preview keep-alive）', async () => {
    const sid = 's1'
    setupSession(sid, 'm.ts', 'modified')
    mockGitGetDiff.mockResolvedValue({ patch: PATCH, binary: false })
    mockFileRead.mockResolvedValue({ content: 'preview text', truncated: false })

    const sessionId = ref<string | null>(sid)
    const { state, openPreview, toggleView, activateTab } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    await openPreview(sid, 'm.ts')
    expect(state.value.viewMode).toBe('diff')
    await toggleView('preview')
    expect(state.value.viewMode).toBe('preview')

    // 切到别的 tab 再切回：模式态保持、不重载（keep-alive）
    store.selectFile(sid, 'other.txt')
    await vi.waitFor(() => expect(state.value.path).toBe('other.txt'))
    const diffCalls = mockGitGetDiff.mock.calls.length
    const readCalls = mockFileRead.mock.calls.length
    activateTab('m.ts')
    await nextTick()
    expect(state.value.path).toBe('m.ts')
    expect(state.value.viewMode).toBe('preview')
    // 切 tab 不重载（keep-alive：实例内容/模式态原样保持）
    expect(mockGitGetDiff.mock.calls.length).toBe(diffCalls)
    expect(mockFileRead.mock.calls.length).toBe(readCalls)
  })

  it('S4 切 tab 不丢滚动位置（滚动锚点 saveScroll/恢复）', async () => {
    const sid = 's1'
    mockFileRead.mockResolvedValue({ content: 'body', truncated: false })
    const sessionId = ref<string | null>(sid)
    const { state, saveScroll, activateTab } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    store.selectFile(sid, 'a.txt')
    await vi.waitFor(() => expect(state.value.status).toBe('content'))
    store.selectFile(sid, 'b.txt')
    await vi.waitFor(() => expect(state.value.path).toBe('b.txt'))

    // a 滚动到 120（DetailPane @scroll 即存）
    activateTab('a.txt')
    await nextTick()
    saveScroll(120)

    // 切走再切回：锚点保持（DetailPane watch(activePath) 据此恢复 DOM scrollTop）
    activateTab('b.txt')
    await nextTick()
    expect(state.value.scrollTop).toBe(0)
    activateTab('a.txt')
    await nextTick()
    expect(state.value.scrollTop).toBe(120)
  })

  it('S4 tab 关闭：激活者关闭激活右邻（无则左邻）；全关空态；关闭选中文件清选中态', async () => {
    const sid = 's1'
    mockFileRead.mockResolvedValue({ content: 'c', truncated: false })
    const sessionId = ref<string | null>(sid)
    const { state, tabs, activePath, closeTab } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    store.selectFile(sid, 'a.txt')
    store.selectFile(sid, 'b.txt')
    store.selectFile(sid, 'c.txt')
    await vi.waitFor(() => expect(tabs.value.length).toBe(3))
    expect(activePath.value).toBe('c.txt')

    // 关激活 tab（c）→ 激活右邻不存在 → 左邻 b
    closeTab('c.txt')
    await nextTick()
    expect(tabs.value.map((t) => t.path)).toEqual(['a.txt', 'b.txt'])
    expect(activePath.value).toBe('b.txt')
    // 关闭的正是选中文件 → 选中态同步清（防 DetailPane 重挂载复活已关 tab）
    expect(store.getSelectedPath(sid)).toBeNull()

    // 关中间 tab（b，激活中）→ 激活右邻不存在 → 左邻 a
    closeTab('b.txt')
    await nextTick()
    expect(activePath.value).toBe('a.txt')

    // 关最后一个 → 空态
    closeTab('a.txt')
    await nextTick()
    expect(tabs.value.length).toBe(0)
    expect(activePath.value).toBeNull()
    expect(state.value.path).toBe('')
    expect(state.value.status).toBe('idle')
  })

  it('S4 关闭非激活 tab：激活不变、选中态不动', async () => {
    const sid = 's1'
    mockFileRead.mockResolvedValue({ content: 'c', truncated: false })
    const sessionId = ref<string | null>(sid)
    const { activePath, closeTab } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    store.selectFile(sid, 'a.txt')
    store.selectFile(sid, 'b.txt')
    await vi.waitFor(() => expect(activePath.value).toBe('b.txt'))

    closeTab('a.txt')
    await nextTick()
    expect(activePath.value).toBe('b.txt')
    expect(store.getSelectedPath(sid)).toBe('b.txt')
  })
})

describe('S4: detail 展示态 per-session 分区（selectedPath 串线终局解 + 切回恢复）', () => {
  it('A/B 会话各自的 tab 分区互不干扰；切回 A 恢复 A 的文件详情', async () => {
    mockFileRead.mockResolvedValue({ content: 'c', truncated: false })
    const sessionId = ref<string | null>('s1')
    const { state, tabs, activePath } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    // A 会话开两个文件
    store.selectFile('s1', 'a1.txt')
    store.selectFile('s1', 'a2.txt')
    await vi.waitFor(() => expect(tabs.value.length).toBe(2))
    expect(activePath.value).toBe('a2.txt')

    // 切到 B：A 的内容不串线（旧全局 selectedPath 单值会把 a2 塞进 B 的展示链）
    sessionId.value = 's2'
    await nextTick()
    expect(tabs.value.length).toBe(0)
    expect(state.value.path).toBe('')

    // B 开自己的文件
    store.selectFile('s2', 'b1.txt')
    await vi.waitFor(() => expect(state.value.path).toBe('b1.txt'))
    expect(tabs.value.map((t) => t.path)).toEqual(['b1.txt'])

    // 切回 A：恢复 A 的 tabs 与激活态（单实例清空问题终局解）
    sessionId.value = 's1'
    await nextTick()
    expect(tabs.value.map((t) => t.path)).toEqual(['a1.txt', 'a2.txt'])
    expect(activePath.value).toBe('a2.txt')
    expect(state.value.content).toBe('c') // keep-alive 内容不丢
    // B 的分区不受影响
    expect(store.getDetailTabs('s2').map((t) => t.path)).toEqual(['b1.txt'])
  })

  it('session 清理释放 detail 分区（防大 diff 实例泄漏，§11-9）', async () => {
    mockFileRead.mockResolvedValue({ content: 'c', truncated: false })
    const sessionId = ref<string | null>('s1')
    const { tabs } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()

    store.selectFile('s1', 'big.diff')
    await vi.waitFor(() => expect(tabs.value.length).toBe(1))

    store.clearSession('s1')
    await nextTick()
    expect(store.getDetailTabs('s1')).toEqual([])
    expect(store.getSelectedPath('s1')).toBeNull()
  })
})

describe('useDetailPane 变更集卡入口（detailFilePath）', () => {
  /**
   * 回归测试：DetailPane 是在抽屉内 v-else-if="drawerTab==='detail'" 条件挂载的，
   * 首次从变更集卡点文件时，drawer.open('detail', { filePath }) 同步设置 detailFilePath，
   * 但此时 DetailPane（及 useDetailPane 的 watch）尚未建立。
   * 等 Vue 渲染完成、watch 建立时，detailFilePath 早已是目标值——
   * 若 watch 无 immediate，建立时不会对已存在的值触发回调 → 首次打开 drawer 显示空态。
   */
  it('useDetailPane 在 detailFilePath 已被设置后调用（首挂载场景）→ immediate 消费加载内容', async () => {
    const sid = 's1'
    const path = 'src/from-changeset.ts'
    setupSession(sid, path, 'modified')

    mockGitGetDiff.mockResolvedValueOnce({ patch: PATCH, binary: false })

    // 模拟变更集卡点击：先 drawer.open 同步设置 detailFilePath
    // （此时 useDetailPane 尚未调用，对应 DetailPane 还没挂载）
    const drawer = useSideDrawer()
    drawer.open('detail', { filePath: path })
    expect(drawer.detailFilePath.value).toBe(path)

    // 「挂载」DetailPane：调用 useDetailPane → watch 建立
    // immediate=true 应立即消费当前 detailFilePath，以 forceDiff 注入并加载
    const sessionId = ref<string | null>(sid)
    const { state, tabs } = useDetailPaneScoped(sessionId)
    await vi.waitFor(() => expect(state.value.status).toBe('content'))

    expect(state.value.path).toBe(path)
    // forceDiff 生效：变更集文件必走 diff 模式（不依赖 gitOverlay 判定）
    expect(state.value.viewMode).toBe('diff')
    expect(state.value.content).toBe(PATCH)
    expect(mockGitGetDiff).toHaveBeenCalled()
    // 消费后清空，避免下次 DetailPane 挂载时被残留值劫持
    expect(drawer.detailFilePath.value).toBeNull()
    expect(tabs.value.length).toBe(1)
  })

  it('双通道同 tick 注入（消息链接 = selectFile + detailFilePath）→ forceDiff 升级生效、不新增 tab', async () => {
    const sid = 's1'
    const path = 'src/link.ts'
    // overlay 未刷新（无 gitOverlay 记录）——forceDiff 是唯一 diff 依据
    mockGitGetDiff.mockResolvedValueOnce({ patch: PATCH, binary: false })

    const sessionId = ref<string | null>(sid)
    const { state, tabs } = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()
    const drawer = useSideDrawer()

    // 同 tick 双通道（ui MarkdownRenderer 链接点击的实然序列）
    store.selectFile(sid, path)
    drawer.open('detail', { filePath: path })

    await vi.waitFor(() => expect(state.value.status).toBe('content'))
    // forceDiff 收敛（事件序无关，ensureDiffMode）：最终恒为 diff 模式
    expect(state.value.viewMode).toBe('diff')
    expect(state.value.content).toBe(PATCH)
    expect(tabs.value.length).toBe(1) // 已开仅激活，不新增第二个 tab
    expect(drawer.detailFilePath.value).toBeNull()
  })
})

describe('useDetailPane loadTokens 记账清理（greptile PR #30 发现 4：无界累积修复）', () => {
  it('关闭 tab → 该 tab 记账键删除；重开同文件加载不受影响', async () => {
    const sid = 's-tokenclose'
    const path = 'src/token-close.ts'
    setupSession(sid, path, 'modified')
    mockGitGetDiff.mockResolvedValue({ patch: PATCH, binary: false })

    const sessionId = ref<string | null>(sid)
    const pane = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()
    store.selectFile(sid, path)
    await vi.waitFor(() => expect(pane.state.value.status).toBe('content'))

    // 关闭 tab：记账键随实例销毁释放（此前只 set 不删，长寿会话反复预览无界累积）
    const before = __loadTokenKeyCountForTest()
    pane.closeTab(path)
    await nextTick()
    expect(__loadTokenKeyCountForTest()).toBe(before - 1)

    // 重开同文件：记账键重建（token 从 1 重新起算），加载照常完成（清键不破坏后续加载）
    store.selectFile(sid, path)
    await vi.waitFor(() => expect(pane.state.value.status).toBe('content'))
    expect(pane.state.value.path).toBe(path)
    expect(__loadTokenKeyCountForTest()).toBe(before)
  })

  it('session 删除清理（triggerSessionCleanups）→ 该 session 全部记账键删除', async () => {
    const sid = 's-tokencleanup'
    const pathA = 'src/token-a.ts'
    const pathB = 'src/token-b.ts'
    mockGitGetDiff.mockResolvedValue({ patch: PATCH, binary: false })

    const sessionId = ref<string | null>(sid)
    const pane = useDetailPaneScoped(sessionId)
    const store = useFileTreeStore()
    store.setGitOverlay(sid, [
      { path: pathA, xyCode: 'M', status: 'modified' },
      { path: pathB, xyCode: 'M', status: 'modified' },
    ])
    store.selectFile(sid, pathA)
    store.openDetailTab(sid, pathB) // 第二个 tab：watchEffect 拉起，同 sid 两枚记账键
    await vi.waitFor(() => expect(pane.state.value.status).toBe('content'))
    await vi.waitFor(() =>
      expect(store.getDetailTab(sid, pathB)?.status).toBe('content'),
    )

    const before = __loadTokenKeyCountForTest()
    triggerSessionCleanups(sid)
    expect(__loadTokenKeyCountForTest()).toBe(before - 2)
  })
})
