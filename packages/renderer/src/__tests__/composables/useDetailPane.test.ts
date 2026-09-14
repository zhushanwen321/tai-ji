/**
 * useDetailPane composable 单测（detail pane 预览编排）。
 *
 * 覆盖：
 * - untracked 文件 git diff 为空 → 自动降级 preview（补取 file.read）
 * - modified 文件 git diff 非空 → 保持 diff 模式
 * - 无 git 改动文件 → 直接 preview（file.read）
 * - 用户手动 toggle 切回 Diff（空 patch）→ 不降级，显示空 diff 内容
 *
 * mock 策略：vi.mock('@/api') 聚合门面覆盖 file.read + git.getDiff，
 * vi.mock('@/stores/session')（sessionCwd 查 cwd 用）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/useDetailPane.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
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

import { useDetailPane } from '@/composables/features/file-tree/useDetailPane'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer'

/** 准备一个 session + gitOverlay 记录，返回 store */
function setupSession(sid: string, path: string, status: string) {
  const store = useFileTreeStore()
  store.setGitOverlay(sid, [{ path, xyCode: '??', status }])
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
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
    const { state } = useDetailPane(sessionId)
    // openPreview 由 watch(selectedPath) 触发，设 selectedPath 驱动
    const store = useFileTreeStore()
    store.selectFile(path)
    await nextTick()
    // 等 watch 触发的 openPreview（含两次 await getDiff + read）完成
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

    const patch = 'diff --git a/src/modified.ts b/src/modified.ts\nindex 111..222\n@@ -1 +1,2 @@\n line1\n+new line'
    mockGitGetDiff.mockResolvedValueOnce({ patch, binary: false })

    const sessionId = ref<string | null>(sid)
    const { state } = useDetailPane(sessionId)
    const store = useFileTreeStore()
    store.selectFile(path)
    await nextTick()
    await vi.waitFor(() => expect(state.value.status).toBe('content'))

    expect(state.value.viewMode).toBe('diff')
    expect(state.value.content).toBe(patch)
    // diff 非空时不补取 file.read
    expect(mockFileRead).not.toHaveBeenCalled()
  })

  it('无 git 改动文件 → 直接 preview（file.read，不调 git.getDiff）', async () => {
    const sid = 's1'
    const path = 'clean.txt'
    // 不设 gitOverlay 记录 → hasGitChange=false → mode=preview
    setActivePinia(createPinia())
    mockFileRead.mockResolvedValueOnce({ content: 'clean content', truncated: false })

    const sessionId = ref<string | null>(sid)
    const { state } = useDetailPane(sessionId)
    const store = useFileTreeStore()
    store.selectFile(path)
    await nextTick()
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
    const { state, toggleView } = useDetailPane(sessionId)
    const store = useFileTreeStore()
    store.selectFile(path)
    await nextTick()
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

describe('U6: useDetailPane 并发守卫（W3 / L3）', () => {
  // 原独立文件 useDetailPane-concurrency.test.ts 并入（同 SUT 同 mock 面）
  it('快速切换文件时旧请求的慢响应不覆盖新内容（stale write 防护）', async () => {
    vi.useFakeTimers()
    try {
      const sid = 's1'
      const sessionId = ref<string | null>(sid)

      // 第一个文件 read 延迟返回 'old-content'，第二个立即返回 'new-content'
      // 用 promise 手动控制延迟
      let resolveFirst: (val: unknown) => void = () => {}
      const firstPromise = new Promise((r) => { resolveFirst = r })
      mockFileRead.mockImplementationOnce(() => firstPromise)
      mockFileRead.mockResolvedValueOnce({ content: 'new-content', truncated: false })
      mockGitGetDiff.mockResolvedValue({ patch: '', binary: false })

      const { state, openPreview } = useDetailPane(sessionId)

      // 连续调 openPreview，不等第一个完成
      void openPreview(sid, 'file-a')
      void openPreview(sid, 'file-b')

      // 等第二个（立即返回）resolve
      await vi.advanceTimersByTimeAsync(0)

      // 第二个请求已完成，content 应为 'new-content'
      expect(state.value.content).toBe('new-content')

      // 现在让第一个（延迟）resolve —— 旧请求的 'old-content' 应被丢弃
      resolveFirst({ content: 'old-content', truncated: false })
      await vi.advanceTimersByTimeAsync(0)

      // content 仍为 'new-content'（旧请求未覆盖）
      expect(state.value.content).toBe('new-content')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useDetailPane 变更集卡入口（detailFilePath）', () => {
  /**
   * 回归测试：DetailPane 是在 SideDrawer 内 v-else-if="activeTab==='detail'" 条件挂载的，
   * 首次从变更集卡点文件时，drawer.open('detail', { filePath }) 同步设置 detailFilePath，
   * 但此时 DetailPane（及 useDetailPane 的 watch）尚未建立。
   * 等 Vue 渲染完成、watch 建立时，detailFilePath 早已是目标值——
   * 若 watch 无 immediate，建立时不会对已存在的值触发回调 → 首次打开 drawer 显示空态。
   */
  it('useDetailPane 在 detailFilePath 已被设置后调用（首挂载场景）→ immediate 消费加载内容', async () => {
    resetSideDrawer()
    const sid = 's1'
    const path = 'src/from-changeset.ts'
    setupSession(sid, path, 'modified')

    const patch = 'diff --git a/src/from-changeset.ts b/src/from-changeset.ts\n@@ -1 +1,2 @@\n-old\n+new'
    mockGitGetDiff.mockResolvedValueOnce({ patch, binary: false })

    // 模拟变更集卡点击：先 drawer.open 同步设置 detailFilePath
    // （此时 useDetailPane 尚未调用，对应 DetailPane 还没挂载）
    const drawer = useSideDrawer()
    drawer.open('detail', { filePath: path })
    expect(drawer.detailFilePath.value).toBe(path)

    // 「挂载」DetailPane：调用 useDetailPane → watch 建立
    // immediate=true 应立即消费当前 detailFilePath，触发 openPreview(forceDiff=true)
    const sessionId = ref<string | null>(sid)
    const { state } = useDetailPane(sessionId)
    await nextTick()
    await vi.waitFor(() => expect(state.value.status).toBe('content'))

    expect(state.value.path).toBe(path)
    // forceDiff 生效：变更集文件必走 diff 模式（不依赖 gitOverlay 判定）
    expect(state.value.viewMode).toBe('diff')
    expect(state.value.content).toBe(patch)
    expect(mockGitGetDiff).toHaveBeenCalled()
    // 消费后清空，避免下次 DetailPane 挂载时被残留值劫持
    expect(drawer.detailFilePath.value).toBeNull()

    resetSideDrawer()
  })
})
