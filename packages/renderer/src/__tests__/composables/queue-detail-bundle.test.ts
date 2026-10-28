/**
 * 队列区 / 详情面板 / 侧栏计数合并产物（round 5-G U8）：四文件同产物，环境全默认
 * （happy-dom；useDetailPane / useBrowserFocusSync 原为 node 环境，纯 ref/watch/pinia
 * 逻辑无 DOM 依赖，迁移实证兼容）。
 *
 * 并入来源（基名）：
 *  - composables/useDetailPane（detail pane 预览编排 + 多文件 tab，19 例；原 node）
 *  - panel/use-queue-rows（投递队列区单源化，29 例；跨目录自 composables/panel/ 搬入）
 *  - composables/useSidebarCounts（tab 计数口径，6 例）
 *  - composables/useBrowserFocusSync（browser focus 同步，4 例；原 node）
 *
 * mock 注册与 U8 解锁改造记录：
 *  - '@/api'（useDetailPane 节窄 mock：project / file.read / git.getDiff）——已核
 *    useSidebarCounts / useQueueRows（走 delivery 深路径）/ useBrowserFocusSync 链均不
 *    消费 @/api 门面，无泄漏危害。
 *  - **改造**（原 useDetailPane 的 '@/stores/session' 窄 mock（useSessionStore 仅返回
 *    list）撤销）——useSidebarCounts 节要真实 session store 的 applySnapshot（波 1 登记的
 *    互斥根因）。useDetailPane 节改在 beforeEach 给真实 store 实例的 list 赋 mockSessionList
 *    （pinia state 可直写，原「sessionCwd 查 cwd」语义不变，用例 push 注入路径不变）。
 *  - '@taiji/core/domain/drawer'（spread + closeDrawerIfTabsEmpty 覆写，useDetailPane 节）
 *    与 '@/api/domains/delivery' / '@/composables/useToast' / '@/stores/chat'
 *    （use-queue-rows 节三窄 mock）与 '@/lib/ipc' / '@/stores/panel'
 *    （useBrowserFocusSync 节两窄 mock）：各域互异，已核交叉链零消费
 *    （useDetailPane 链不用 chat store；useSidebarCounts 链不用 @/api / chat / panel）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/composables/queue-detail-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computed, effectScope, reactive, ref, nextTick, type EffectScope, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { apiProjectMock } from '@/__tests__/helpers/api-facade-mock'
import { deliveryQueueEntries, getDeliveryProjectionRef } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'

// ── useDetailPane 节的 mock ──
// mock @/api 聚合门面：useDetailPane 源码 import { file, git } from '@/api'，
// vitest VITE_MOCK=true 下 @/api 默认指向 mockApi fixture，须在此聚合门面层
// 覆盖 file/git 导出，否则 mock 不生效（会走 mockApi 基于文件名的 fixture 内容）。
const mockFileRead = vi.fn()
const mockGitGetDiff = vi.fn()
vi.mock('@/api', () => ({
  project: apiProjectMock(),
  file: { read: (...args: unknown[]) => mockFileRead(...(args as [string, string?])) },
  git: { getDiff: (...args: unknown[]) => mockGitGetDiff(...(args as [string, string])) },
}))
// drawer 域 importOriginal 部分 mock（真模块 headless 零副作用，只覆写关空收敛通道）：
// closeTab 的关空分支经 core closeDrawerIfTabsEmpty（规则单一落点），桩化后可断言
// 「关空 → true / 非空 → false」的调用序列。
vi.mock('@taiji/core/domain/drawer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/domain/drawer')>()
  return {
    ...actual,
    closeDrawerIfTabsEmpty: vi.fn(),
  }
})

// ── use-queue-rows 节的 mock ──
const deliveryMock = vi.hoisted(() => ({
  cancelDelivery: vi.fn(),
  resyncDelivery: vi.fn(),
  drainDelivery: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
const phaseMock = vi.hoisted(() => vi.fn(() => ({ compacting: false, bash: false, turn: 'idle' })))

vi.mock('@/api/domains/delivery', () => ({ delivery: deliveryMock }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMock }))
vi.mock('@/stores/chat', () => ({ useChatStore: () => ({ sessionPhase: phaseMock }) }))

// ── useBrowserFocusSync 节的 mock ──
// mock lib/ipc：捕获 browserFocus
const mockBrowserFocus = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/ipc', () => ({
  browserFocus: (sid: string) => mockBrowserFocus(sid),
}))
// mock panel store：模拟 Pinia store 的 ref 自动 unwrap 行为。
// composable 经 storeToRefs(panel) 读 focusedSessionId（panel store 暴露的 computed，
// 单 panel 下直接读 layout.value.sessionId）。mock 提供可控的 focusedSessionId ref。
const focusedSessionIdRef = ref<string | null>(null)
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    // storeToRefs 读 ref/computed：返回真实 ref 让 watch 依赖追踪正常工作
    focusedSessionId: focusedSessionIdRef,
  }),
}))

import { useDetailPane, __loadTokenKeyCountForTest } from '@/composables/features/file-tree/useDetailPane'
import { useFileTreeStore } from '@/stores/fileTree'
import { useSideDrawer, resetSideDrawer } from '@/composables/features/drawer/useSideDrawer'
import { closeDrawerIfTabsEmpty } from '@taiji/core/domain/drawer'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'
import { useSessionStore } from '@/stores/session'
// deliveryQueueEntries 谓词自 U20 下沉 core（行为不变断言同迁——原断言改引 core 导出，
// 队列区过滤行为锁定不变）；useQueueRows/foldQueueRows 仍是 renderer 壳层编排出处
import { useQueueRows, foldQueueRows, QUEUE_VISIBLE_MAX } from '@/composables/panel/useQueueRows'
import { useSidebarCounts } from '@/composables/features/sidebar/useSidebarCounts'
import { toggleMarkedDone, __resetCacheForTest } from '@/composables/useSessionMarkers'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import { useBrowserFocusSync } from '@/composables/features/browser/useBrowserFocusSync'

// ══════════ 来源节：composables/useDetailPane（原 node 环境文件；U8 改造：
// @/stores/session 窄 mock 撤销，beforeEach 直写真实 store.list）══════════

describe('useDetailPane（useDetailPane 合并节）', () => {
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

  /** 准备一个 session + gitOverlay 记录，返回 store */
  function setupSession(sid: string, path: string, status: string) {
    const store = useFileTreeStore()
    store.setGitOverlay(sid, [{ path, xyCode: '??', status }])
    return store
  }

  const PATCH =
    'diff --git a/src/modified.ts b/src/modified.ts\nindex 111..222\n@@ -1 +1,2 @@\n line1\n+new line'

  // sessionStore.list 查 cwd（sessionCwd）：默认空列表（session 不在册 → cwd null → 位置分流
  // 走 cwd 外/preview 分支）；需要 cwd 内分支的用例（双通道 forceDiff 位置分流）向
  // mockSessionList push { id, cwd } 注入。U8 改造：list 是 groups 派生的 computed（只读），
  // 注入走 applySnapshot 写 groups 真源；mockSessionList 须为 reactive 数组——push 才能触发
  // 派生重算（普通数组的绕代理 mutate 不失效 computed 缓存）。
  const mockSessionList: Array<{ id: string; cwd?: string }> = reactive([])

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockSessionList.length = 0
    // U8 改造：原模块窄 mock（useSessionStore 仅返回 list）撤销——useSidebarCounts 节需要
    // 真实 session store（applySnapshot）；本节改经 applySnapshot 把 mockSessionList 写进
    // 真实 store 的 groups 真源（「sessionCwd 查 cwd」语义与用例 push 注入路径不变）。
    useSessionStore().applySnapshot({ groups: [{ cwd: '', sessions: mockSessionList }] })
    resetSideDrawer()
  })

  afterEach(() => {
    for (const scope of liveScopes.splice(0)) scope.stop()
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
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })

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
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })

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
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })

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
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })
      expect(state.value.viewMode).toBe('preview')

      // 用户手动 toggle 切回 Diff —— 第二次 git.getDiff 仍返回空，但不降级（toggleView 不走降级分支）
      mockGitGetDiff.mockResolvedValueOnce({ patch: '', binary: false })
      await toggleView('diff')
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })

      expect(state.value.viewMode).toBe('diff')
      expect(state.value.content).toBe('') // 空 patch（用户主动选择，保留空态）
    })
  })

  describe('U6: useDetailPane 并发检查（W3 / L3，per-tab 粒度）', () => {
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

    it('同 tab 加载被模式切换抢占 → 旧请求 stale write 丢弃（token 检查）', async () => {
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
      await vi.waitFor(() => expect(state.value.status).toBe('loading'), { interval: 1 })
      await toggleView('diff')
      expect(state.value.status).toBe('content')
      expect(state.value.viewMode).toBe('diff')

      // 慢 read 迟到 → token 不匹配，stale write 丢弃
      resolveRead({ content: 'stale content', truncated: false })
      await vi.waitFor(() => expect(mockFileRead).toHaveBeenCalled(), { interval: 1 })
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
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })
      store.selectFile(sid, 'b.txt')
      await vi.waitFor(() => expect(state.value.path).toBe('b.txt'), { interval: 1 })

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
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })
      mockFileRead.mockResolvedValueOnce({ content: 'b content', truncated: false })
      store.selectFile(sid, 'b.txt')
      await vi.waitFor(() => expect(state.value.path).toBe('b.txt'), { interval: 1 })
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
      await vi.waitFor(() => expect(tabs.value.length).toBe(12), { interval: 1 })
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
      await vi.waitFor(() => expect(state.value.path).toBe('other.txt'), { interval: 1 })
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
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })
      store.selectFile(sid, 'b.txt')
      await vi.waitFor(() => expect(state.value.path).toBe('b.txt'), { interval: 1 })

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
      await vi.waitFor(() => expect(tabs.value.length).toBe(3), { interval: 1 })
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

      // 关最后一个 → 空态 + 抽屉关空收敛（前两次关非最后为 false，最后一次 true——
      // 规则单一落点 core closeDrawerIfTabsEmpty）
      closeTab('a.txt')
      await nextTick()
      expect(tabs.value.length).toBe(0)
      expect(activePath.value).toBeNull()
      expect(state.value.path).toBe('')
      expect(state.value.status).toBe('idle')
      expect(closeDrawerIfTabsEmpty).toHaveBeenCalledTimes(3)
      expect(closeDrawerIfTabsEmpty).toHaveBeenNthCalledWith(1, false)
      expect(closeDrawerIfTabsEmpty).toHaveBeenNthCalledWith(2, false)
      expect(closeDrawerIfTabsEmpty).toHaveBeenNthCalledWith(3, true)
    })

    it('S4 关闭非激活 tab：激活不变、选中态不动', async () => {
      const sid = 's1'
      mockFileRead.mockResolvedValue({ content: 'c', truncated: false })
      const sessionId = ref<string | null>(sid)
      const { activePath, closeTab } = useDetailPaneScoped(sessionId)
      const store = useFileTreeStore()

      store.selectFile(sid, 'a.txt')
      store.selectFile(sid, 'b.txt')
      await vi.waitFor(() => expect(activePath.value).toBe('b.txt'), { interval: 1 })

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
      await vi.waitFor(() => expect(tabs.value.length).toBe(2), { interval: 1 })
      expect(activePath.value).toBe('a2.txt')

      // 切到 B：A 的内容不串线（旧全局 selectedPath 单值会把 a2 塞进 B 的展示链）
      sessionId.value = 's2'
      await nextTick()
      expect(tabs.value.length).toBe(0)
      expect(state.value.path).toBe('')

      // B 开自己的文件
      store.selectFile('s2', 'b1.txt')
      await vi.waitFor(() => expect(state.value.path).toBe('b1.txt'), { interval: 1 })
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
      await vi.waitFor(() => expect(tabs.value.length).toBe(1), { interval: 1 })

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
      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })

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
      // [位置分流 useDetailPane] 注入在册 session cwd：路径为 cwd 内相对形态（resolvePreviewPath
      // 的 relative 非 null）→ drawer 通道按位置分流走 cwd 内分支，forceDiff 升级生效（旧实现
      // forceDiff 无条件生效，位置分流后 cwd 外/session 不在册走 preview——本用例锁定 cwd 内分支）
      mockSessionList.push({ id: sid, cwd: '/proj' })
      // overlay 未刷新（无 gitOverlay 记录）——forceDiff 是唯一 diff 依据
      mockGitGetDiff.mockResolvedValueOnce({ patch: PATCH, binary: false })

      const sessionId = ref<string | null>(sid)
      const { state, tabs } = useDetailPaneScoped(sessionId)
      const store = useFileTreeStore()
      const drawer = useSideDrawer()

      // 同 tick 双通道（ui MarkdownRenderer 链接点击的实然序列）
      store.selectFile(sid, path)
      drawer.open('detail', { filePath: path })

      await vi.waitFor(() => expect(state.value.status).toBe('content'), { interval: 1 })
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
      await vi.waitFor(() => expect(pane.state.value.status).toBe('content'), { interval: 1 })

      // 关闭 tab：记账键随实例销毁释放（此前只 set 不删，长寿会话反复预览无界累积）
      const before = __loadTokenKeyCountForTest()
      pane.closeTab(path)
      await nextTick()
      expect(__loadTokenKeyCountForTest()).toBe(before - 1)

      // 重开同文件：记账键重建（token 从 1 重新起算），加载照常完成（清键不破坏后续加载）
      store.selectFile(sid, path)
      await vi.waitFor(() => expect(pane.state.value.status).toBe('content'), { interval: 1 })
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
      await vi.waitFor(() => expect(pane.state.value.status).toBe('content'), { interval: 1 })
      await vi.waitFor(
        () => expect(store.getDetailTab(sid, pathB)?.status).toBe('content'),
        { interval: 1 },
      )

      const before = __loadTokenKeyCountForTest()
      triggerSessionCleanups(sid)
      expect(__loadTokenKeyCountForTest()).toBe(before - 2)
    })
  })
})

// ══════════ 来源节：panel/use-queue-rows（原文件顶层 beforeEach 下沉包裹层内）══════════

describe('useQueueRows（use-queue-rows 合并节）', () => {
  function entry(
    clientUuid: string,
    state: DeliveryFrameEntry['state'],
    lane: DeliveryFrameEntry['lane'],
    preview = clientUuid,
  ): DeliveryFrameEntry {
    return { clientUuid, preview, state, lane }
  }

  /** 写 core 派生视图（帧消费链路由 core useChat handler 承担，本层只读派生视图） */
  function setProjection(sid: string, entries: DeliveryFrameEntry[]): void {
    const ref = getDeliveryProjectionRef()
    const next = new Map(ref.value)
    next.set(sid, entries)
    ref.value = next
  }

  function setup(sessionId: string | null, restoreDraft = vi.fn()) {
    const rows = useQueueRows(computed(() => sessionId), { restoreDraft })
    return { ...rows, restoreDraft }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    getDeliveryProjectionRef().value = new Map()
    phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'idle' })
    deliveryMock.cancelDelivery.mockResolvedValue({ clientUuid: 'u-1', cancelled: true, content: '被撤销的文本' })
    deliveryMock.resyncDelivery.mockResolvedValue({ sessionId: 's1', deduped: [] })
  })

  describe('useQueueRows · 单源派生视图过滤（D7）', () => {
    it('只收「非 direct 且未 delivered」条目，帧序保持（内核 FIFO 发送序）', () => {
      setProjection('s1', [
        entry('d1', 'in-flight', 'direct'), // direct 投递路径：乐观气泡原位保留 → 不进队列区
        entry('q1', 'queued', 'queued', '排队消息'),
        entry('f1', 'in-flight', 'steer', '投递中消息'),
        entry('x1', 'delivered', 'steer'), // 已送达：transcript 已入流 → 隐去
        entry('q2', 'failed', 'queued', '失败消息'),
      ])
      const { rows } = setup('s1')
      expect(rows.value.map((r) => r.clientUuid)).toEqual(['q1', 'f1', 'q2'])
      expect(rows.value.map((r) => r.state)).toEqual(['queued', 'in-flight', 'failed'])
      expect(rows.value[0]!.preview).toBe('排队消息')
    })

    it('preview 直用帧值不二次加工（剥标记 SSOT = runtime 装配 deliveryPreview，帧契约测试断言无标记）', () => {
      setProjection('s1', [
        entry('q1', 'queued', 'queued', '排队消息 帧侧已剥标记'),
      ])
      const { rows } = setup('s1')
      expect(rows.value[0]!.preview).toBe('排队消息 帧侧已剥标记')
    })

    it('deliveryQueueEntries 是过滤口径唯一定义点（core 下沉导出——QueueBubble 行渲染、ActivityStrip 计数与移动壳共用）', () => {
      const entries = [
        entry('d1', 'in-flight', 'direct'),
        entry('q1', 'queued', 'queued'),
        entry('x1', 'delivered', 'queued'),
      ]
      expect(deliveryQueueEntries(entries).map((e) => e.clientUuid)).toEqual(['q1'])
    })

    it('sessionId 为 null → 空行 + hint 走默认档（不触 store）', () => {
      setProjection('s1', [entry('q1', 'queued', 'queued')])
      const { rows, hint } = setup(null)
      expect(rows.value).toEqual([])
      expect(hint.value).toBe('占用结束后发送')
      expect(phaseMock).not.toHaveBeenCalled()
    })

    it('hint 分档：compacting > bash > 交接（handingOff）> settling（turn 非 idle）> 默认', () => {
      phaseMock.mockReturnValue({ compacting: true, bash: true, turn: 'idle' })
      expect(setup('s1').hint.value).toBe('等待上下文压缩完成后发送')
      phaseMock.mockReturnValue({ compacting: false, bash: true, turn: 'idle' })
      expect(setup('s1').hint.value).toBe('等待命令执行结束后发送')
      phaseMock.mockReturnValue({ compacting: false, bash: false, handingOff: true, turn: 'generating' })
      expect(setup('s1').hint.value).toBe('交接中，结束后投递')
      phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'settling' })
      expect(setup('s1').hint.value).toBe('等待当前回合结束后发送')
      phaseMock.mockReturnValue({ compacting: false, bash: false, turn: 'idle' })
      expect(setup('s1').hint.value).toBe('占用结束后发送')
    })
  })

  describe('foldQueueRows · 折叠口径唯一定义点（failed 置顶恒可见，QueueBubble 消费）', () => {
    it('failed 行置顶（组内保持帧序），其余行保持帧序跟随', () => {
      const rows = [
        { clientUuid: 'q1', preview: 'm1', state: 'queued' as const },
        { clientUuid: 'f1', preview: 'm2', state: 'failed' as const },
        { clientUuid: 'i1', preview: 'm3', state: 'in-flight' as const },
      ]
      const { visible, overflowCount } = foldQueueRows(rows)
      expect(visible.map((r) => r.clientUuid)).toEqual(['f1', 'q1', 'i1'])
      expect(overflowCount).toBe(0)
    })

    it('failed 行不折叠（恒可见可重试）：failed 数超可见上限仍全显，可见位全给 failed', () => {
      const rows = [
        { clientUuid: 'f1', preview: 'm1', state: 'failed' as const },
        { clientUuid: 'f2', preview: 'm2', state: 'failed' as const },
        { clientUuid: 'f3', preview: 'm3', state: 'failed' as const },
        { clientUuid: 'f4', preview: 'm4', state: 'failed' as const },
        { clientUuid: 'q1', preview: 'm5', state: 'queued' as const },
      ]
      const { visible, overflowCount } = foldQueueRows(rows)
      expect(visible.map((r) => r.clientUuid)).toEqual(['f1', 'f2', 'f3', 'f4'])
      expect(overflowCount).toBe(1)
    })

    it('「+N」只计被折叠的非 failed 行（failed 恒可见 → 溢出计数不含 failed）', () => {
      const rows = [
        { clientUuid: 'f1', preview: 'm1', state: 'failed' as const },
        { clientUuid: 'q1', preview: 'm2', state: 'queued' as const },
        { clientUuid: 'q2', preview: 'm3', state: 'queued' as const },
        { clientUuid: 'q3', preview: 'm4', state: 'queued' as const },
        { clientUuid: 'i1', preview: 'm5', state: 'in-flight' as const },
      ]
      const { visible, overflowCount } = foldQueueRows(rows)
      // failed 行全量可见（f1 在首位的置顶序），「+N」= 被折叠的 q3/i1 两行（不含 failed）
      expect(visible.map((r) => r.clientUuid)).toEqual(['f1', 'q1', 'q2'])
      expect(overflowCount).toBe(2)
    })

    it('无 failed → 前 N 条按帧序（与既有 v6 §8.5 行为一致，回归锚）', () => {
      const rows = [
        { clientUuid: 'q1', preview: 'm1', state: 'queued' as const },
        { clientUuid: 'q2', preview: 'm2', state: 'queued' as const },
        { clientUuid: 'q3', preview: 'm3', state: 'queued' as const },
        { clientUuid: 'q4', preview: 'm4', state: 'queued' as const },
      ]
      const { visible, overflowCount } = foldQueueRows(rows)
      expect(visible.map((r) => r.clientUuid)).toEqual(['q1', 'q2', 'q3'])
      expect(overflowCount).toBe(1)
      expect(QUEUE_VISIBLE_MAX).toBe(3)
    })

    it('空输入 → 空可见 + 零溢出', () => {
      expect(foldQueueRows([])).toEqual({ visible: [], overflowCount: 0 })
    })

    it('expanded=true → 全部行可见（failed 置顶序保持）+ 溢出归零（Q2 +N 展开开关）', () => {
      const rows = [
        { clientUuid: 'f1', preview: 'm1', state: 'failed' as const },
        { clientUuid: 'q1', preview: 'm2', state: 'queued' as const },
        { clientUuid: 'q2', preview: 'm3', state: 'queued' as const },
        { clientUuid: 'q3', preview: 'm4', state: 'queued' as const },
        { clientUuid: 'q4', preview: 'm5', state: 'in-flight' as const },
      ]
      const { visible, overflowCount } = foldQueueRows(rows, { expanded: true })
      expect(visible.map((r) => r.clientUuid)).toEqual(['f1', 'q1', 'q2', 'q3', 'q4'])
      expect(overflowCount).toBe(0)
    })

    it('expanded 缺省 → 折叠行为逐字节不变（既有调用方与测试零改动锚）', () => {
      const rows = [
        { clientUuid: 'q1', preview: 'm1', state: 'queued' as const },
        { clientUuid: 'q2', preview: 'm2', state: 'queued' as const },
        { clientUuid: 'q3', preview: 'm3', state: 'queued' as const },
        { clientUuid: 'q4', preview: 'm4', state: 'queued' as const },
      ]
      expect(foldQueueRows(rows)).toEqual(foldQueueRows(rows, {}))
      expect(foldQueueRows(rows)).toEqual(foldQueueRows(rows, { expanded: false }))
    })
  })

  describe('useQueueRows · × 撤销（V9/V10：delivery.cancel）', () => {
    it('撤销成功 → cancelDelivery(sid, clientUuid) + 全文/segments 交 restoreDraft 回草稿', async () => {
      const segments = [{ type: 'text' as const, text: '被撤销的文本' }]
      deliveryMock.cancelDelivery.mockResolvedValueOnce({
        clientUuid: 'u-1',
        cancelled: true,
        content: '被撤销的文本',
        segments,
      })
      const { onCancelEntry, restoreDraft } = setup('s1')

      await onCancelEntry('u-1')

      expect(deliveryMock.cancelDelivery).toHaveBeenCalledWith('s1', 'u-1')
      expect(restoreDraft).toHaveBeenCalledWith({ text: '被撤销的文本', segments })
      expect(toastMock.error).not.toHaveBeenCalled()
    })

    it('不可撤（cancelled=false）→ toast 明确反馈（含 runtime 给出的原因），不回草稿', async () => {
      deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-2', cancelled: false, reason: 'already delivered' })
      const { onCancelEntry, restoreDraft } = setup('s1')

      await onCancelEntry('u-2')

      expect(toastMock.error).toHaveBeenCalledWith('无法撤销：already delivered')
      expect(restoreDraft).not.toHaveBeenCalled()
    })

    it('不可撤且无原因 → 兜底文案「消息已投递，无法撤销」', async () => {
      deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-3', cancelled: false })
      const { onCancelEntry } = setup('s1')
      await onCancelEntry('u-3')
      expect(toastMock.error).toHaveBeenCalledWith('消息已投递，无法撤销')
    })

    it('RPC 失败 → toast「撤销失败：{原因}」（不吞错，用户可重试）', async () => {
      deliveryMock.cancelDelivery.mockRejectedValueOnce(new Error('ws disconnected'))
      const { onCancelEntry, restoreDraft } = setup('s1')

      await onCancelEntry('u-4')

      expect(toastMock.error).toHaveBeenCalledWith('撤销失败：ws disconnected')
      expect(restoreDraft).not.toHaveBeenCalled()
    })

    it('回草稿抛错 → 独立文案「已撤销，但恢复到输入框失败」（不误标撤销失败——撤销已成功）', async () => {
      const { onCancelEntry, restoreDraft } = setup('s1')
      restoreDraft.mockImplementationOnce(() => {
        throw new Error('input readonly')
      })

      await onCancelEntry('u-9')

      expect(toastMock.error).toHaveBeenCalledTimes(1)
      expect(toastMock.error).toHaveBeenCalledWith('已撤销，但恢复到输入框失败：input readonly')
      expect(toastMock.error).not.toHaveBeenCalledWith(expect.stringContaining('撤销失败'))
    })

    it('cancelled=true 但 content 缺失（runtime 契约违规）→ 出声「原文未能取回」，不静默回空草稿', async () => {
      deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-10', cancelled: true })
      const { onCancelEntry, restoreDraft } = setup('s1')

      await onCancelEntry('u-10')

      expect(toastMock.error).toHaveBeenCalledWith('消息已撤销，但原文未能取回——请重新输入')
      expect(restoreDraft).not.toHaveBeenCalled()
    })

    it('cancelled=true 但 content 空串/空白 → 同样出声（不把空文本当合法草稿恢复）', async () => {
      deliveryMock.cancelDelivery.mockResolvedValueOnce({ clientUuid: 'u-11', cancelled: true, content: '   ' })
      const { onCancelEntry, restoreDraft } = setup('s1')

      await onCancelEntry('u-11')

      expect(toastMock.error).toHaveBeenCalledWith('消息已撤销，但原文未能取回——请重新输入')
      expect(restoreDraft).not.toHaveBeenCalled()
    })

    it('null session → no-op（不触 RPC，不触 toast）', async () => {
      const { onCancelEntry } = setup(null)
      await onCancelEntry('u-5')
      expect(deliveryMock.cancelDelivery).not.toHaveBeenCalled()
      expect(toastMock.error).not.toHaveBeenCalled()
    })

    it('会话级撤销单飞（Q10）：在途取消未完成时第二次点击被忽略（不发第二条 cancel RPC）', async () => {
      let resolveFirst: ((v: { cancelled: boolean; content?: string }) => void) | undefined
      deliveryMock.cancelDelivery.mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve }),
      )
      const { onCancelEntry } = setup('s1')

      const first = onCancelEntry('u-20')
      const second = onCancelEntry('u-21') // 在途窗口内的连点：忽略（UX 防抖）
      resolveFirst!({ cancelled: true, content: '第一条' })
      await Promise.all([first, second])

      expect(deliveryMock.cancelDelivery).toHaveBeenCalledTimes(1)
      expect(deliveryMock.cancelDelivery).toHaveBeenCalledWith('s1', 'u-20')
    })

    it('会话级撤销单飞（Q10）：在途取消完成后复位，后续点击正常受理', async () => {
      const { onCancelEntry } = setup('s1')
      await onCancelEntry('u-22')
      expect(deliveryMock.cancelDelivery).toHaveBeenCalledTimes(1)
      // 复位断言（finally 复位不泄漏）：第二次点击发出第二条 RPC
      await onCancelEntry('u-23')
      expect(deliveryMock.cancelDelivery).toHaveBeenCalledTimes(2)
      expect(deliveryMock.cancelDelivery).toHaveBeenLastCalledWith('s1', 'u-23')
    })
  })

  describe('useQueueRows · failed 行重试（delivery.resync 单条重报，§3.4）', () => {
    it('重试 → resyncDelivery(sid, [clientUuid])，成功静默（权威状态经帧收敛）', async () => {
      const { onRetryEntry } = setup('s1')

      await onRetryEntry('u-6')

      expect(deliveryMock.resyncDelivery).toHaveBeenCalledWith('s1', ['u-6'])
      expect(toastMock.error).not.toHaveBeenCalled()
    })

    it('重试 RPC 失败 → toast「重试失败：{原因}」', async () => {
      deliveryMock.resyncDelivery.mockRejectedValueOnce(new Error('rpc timeout'))
      const { onRetryEntry } = setup('s1')

      await onRetryEntry('u-7')

      expect(toastMock.error).toHaveBeenCalledWith('重试失败：rpc timeout')
    })

    it('null session → no-op', async () => {
      const { onRetryEntry } = setup(null)
      await onRetryEntry('u-8')
      expect(deliveryMock.resyncDelivery).not.toHaveBeenCalled()
    })
  })

  describe('useQueueRows · 重试全部失败项（Q5：一次 resync 按显示序传全部 failedIds）', () => {
    it('failed ≥2 → resyncDelivery(sid, failedIds)（failed 组内保持帧序），成功静默', async () => {
      setProjection('s1', [
        entry('q1', 'queued', 'queued'),
        entry('f2', 'failed', 'queued', '失败二'),
        entry('f1', 'failed', 'queued', '失败一'),
      ])
      const { onRetryAllFailed } = setup('s1')
      await onRetryAllFailed()
      expect(deliveryMock.resyncDelivery).toHaveBeenCalledWith('s1', ['f2', 'f1'])
      expect(toastMock.error).not.toHaveBeenCalled()
    })

    it('无 failed → no-op（组件层按 failedCount ≥2 控制入口，本层双保险）', async () => {
      setProjection('s1', [entry('q1', 'queued', 'queued')])
      const { onRetryAllFailed } = setup('s1')
      await onRetryAllFailed()
      expect(deliveryMock.resyncDelivery).not.toHaveBeenCalled()
    })

    it('重试全部 RPC 失败 → toast「重试失败：{原因}」', async () => {
      setProjection('s1', [entry('f1', 'failed', 'queued')])
      deliveryMock.resyncDelivery.mockRejectedValueOnce(new Error('rpc down'))
      const { onRetryAllFailed } = setup('s1')
      await onRetryAllFailed()
      expect(toastMock.error).toHaveBeenCalledWith('重试失败：rpc down')
    })
  })

  describe('useQueueRows · +N 展开开关（Q2：per-session 分区持有展开态）', () => {
    it('toggleExpanded 切换 expanded；不同会话分区互不影响（ADR-0049 分区语义）', () => {
      const a = setup('s1')
      const b = setup('s2')
      expect(a.expanded.value).toBe(false)
      a.toggleExpanded()
      expect(a.expanded.value).toBe(true)
      expect(b.expanded.value).toBe(false) // s2 分区独立
      a.toggleExpanded()
      expect(a.expanded.value).toBe(false)
    })
  })
})

// ══════════ 来源节：composables/useSidebarCounts（原文件顶层 beforeEach 下沉包裹层内）══════════

describe('useSidebarCounts（useSidebarCounts 合并节）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('useSidebarCounts fileCount（文件树根层条目数）', () => {
    it('无焦点 session（null）→ 0；焦点 session 无树 → 0', () => {
      const sid = ref<string | null>(null)
      const counts = useSidebarCounts(sid)
      expect(counts.fileCount.value).toBe(0)

      sid.value = 'sess-no-tree'
      expect(counts.fileCount.value).toBe(0)
    })

    it('焦点 session 根层条目数（目录计入，不递归子树）', () => {
      const sid = ref<string | null>('sess-file-count')
      const fileTreeStore = useFileTreeStore()
      fileTreeStore.setTree('sess-file-count', [
        { name: 'src', path: 'src', type: 'dir', children: [
          { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 1 },
        ] },
        { name: 'README.md', path: 'README.md', type: 'file', size: 2 },
      ])

      const counts = useSidebarCounts(sid)
      // 根层两条（子节点 index.ts 不计入——根层口径，非递归）
      expect(counts.fileCount.value).toBe(2)
    })
  })

  // ── sessionCount（§2.3 口径）──
  // 口径 = 侧边栏全量会话数 − 已归档（markedDone）数；死会话计入；全局口径不随焦点变化。
  // markers 隔离：useSessionMarkers 是模块级 cache + localStorage 持久化，跨用例残留会污染
  // 归档断言——沿用 useSessionMarkers.test.ts 的隔离模式（localStorage.clear + __resetCacheForTest）。
  describe('useSidebarCounts sessionCount（tab 计数口径）', () => {
    const MARKERS_STORAGE_KEY = 'taiji:session-markers'

    function makeSummary(id: string, status: SessionSummary['status'] = 'idle'): SessionSummary {
      return { id, label: id, cwd: '/proj', status, lastActiveAt: 1 }
    }

    function seedSessions(sessions: SessionSummary[]): void {
      useSessionStore().applySnapshot({ groups: [{ cwd: '/proj', sessions }] satisfies SessionGroup[] })
    }

    beforeEach(() => {
      localStorage.clear()
      __resetCacheForTest()
    })

    it('无归档时 = session.list 长度；列表为空 → 0', () => {
      const sid = ref<string | null>('sess-count-a')
      const counts = useSidebarCounts(sid)

      // 空列表（加载失败 / 未加载时 groups 为空同形态）→ 0
      expect(counts.sessionCount.value).toBe(0)

      seedSessions([makeSummary('s1'), makeSummary('s2'), makeSummary('s3')])
      expect(counts.sessionCount.value).toBe(3)
    })

    it('归档一条后 −1，取消归档恢复（markers cache 响应式联动）', () => {
      const sid = ref<string | null>('sess-count-b')
      seedSessions([makeSummary('s1'), makeSummary('s2'), makeSummary('s3')])

      const counts = useSidebarCounts(sid)
      expect(counts.sessionCount.value).toBe(3)

      // 写入口 = useSessionMarkers.toggleMarkedDone（SessionItem Archive 按钮同源链路），
      // 替换 cache.value 触发 computed 重算
      toggleMarkedDone('s2')
      expect(counts.sessionCount.value).toBe(2)

      toggleMarkedDone('s2')
      expect(counts.sessionCount.value).toBe(3)
    })

    it('死会话（dead）计入——侧边栏列表仍渲染（置灰降权），数字与列表一致不穿帮', () => {
      const sid = ref<string | null>('sess-count-c')
      seedSessions([makeSummary('s1', 'dead'), makeSummary('s2', 'idle'), makeSummary('s3', 'idle')])

      const counts = useSidebarCounts(sid)
      expect(counts.sessionCount.value).toBe(3)
    })

    it('markers 未 hydrate 首读正确：localStorage 已有归档标记，首次计算即扣减', () => {
      // beforeEach 已 __resetCacheForTest（hydrated=false），此处先落盘再读——
      // 走 isMarkedDone → ensureCache 的首次 hydrate 路径，不允许依赖任何前置读取
      localStorage.setItem(
        MARKERS_STORAGE_KEY,
        JSON.stringify({ s2: { markedDone: true }, s1: { unread: true } }),
      )
      seedSessions([makeSummary('s1'), makeSummary('s2'), makeSummary('s3')])

      const sid = ref<string | null>('sess-count-d')
      const counts = useSidebarCounts(sid)
      // 仅 s2 markedDone 扣减；s1 只 unread 不影响归档口径
      expect(counts.sessionCount.value).toBe(2)
    })
  })
})

// ══════════ 来源节：composables/useBrowserFocusSync（原 node 环境文件；
// 原文件顶层 hook 下沉包裹层内）══════════

describe('useBrowserFocusSync（useBrowserFocusSync 合并节）', () => {
  /** 当前测试的 effectScope（beforeEach 时 stop 上一轮的，防 watch 泄漏到下一个测试） */
  let currentScope: ReturnType<typeof effectScope> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    // stop 上一轮 scope，确保上一个测试的 watch 不响应本轮 ref 重置（否则 mock 被多调）
    currentScope?.stop()
    currentScope = null
    vi.clearAllMocks()
    focusedSessionIdRef.value = null
  })

  afterEach(() => {
    currentScope?.stop()
    currentScope = null
  })

  /**
   * 在 effectScope 内调 composable。composable 内部用 watch，跟随 active scope 生命周期。
   * scope 在 beforeEach/afterEach 自动 stop，测试内无需手动清理。
   */
  function setupFocusSync(): void {
    const scope = effectScope()
    scope.run(() => {
      useBrowserFocusSync()
    })
    currentScope = scope
  }

  describe('useBrowserFocusSync（Wave 4）', () => {
    it('immediate: 首次挂载时已有 session → 立即调 browserFocus(sid)', async () => {
      focusedSessionIdRef.value = 'sess-A'

      setupFocusSync()
      // watch immediate 回调是同步的，但 browserFocus 返回 Promise（void），flush 后断言
      await Promise.resolve()

      expect(mockBrowserFocus).toHaveBeenCalledWith('sess-A')
    })

    it('focusedSessionId 变化 → 调 browserFocus(newSid)', async () => {
      focusedSessionIdRef.value = 'sess-A'

      setupFocusSync()
      await Promise.resolve()
      expect(mockBrowserFocus).toHaveBeenCalledTimes(1)

      // 切到 sess-B
      focusedSessionIdRef.value = 'sess-B'
      await Promise.resolve()

      expect(mockBrowserFocus).toHaveBeenCalledWith('sess-B')
      expect(mockBrowserFocus).toHaveBeenCalledTimes(2)
    })

    it('focusedSessionId 变 null（无 session）→ 不调 browserFocus', async () => {
      focusedSessionIdRef.value = 'sess-A'

      setupFocusSync()
      await Promise.resolve()
      expect(mockBrowserFocus).toHaveBeenCalledTimes(1)

      // focusedSessionId 变 null（无 session）
      focusedSessionIdRef.value = null
      await Promise.resolve()

      // null sid 时 watch 回调跳过，不调 browserFocus
      expect(mockBrowserFocus).toHaveBeenCalledTimes(1)
    })

    it('首次挂载时无 session（focusedSessionId=null）→ 不调 browserFocus', async () => {
      setupFocusSync()
      await Promise.resolve()

      expect(mockBrowserFocus).not.toHaveBeenCalled()
    })
  })
})
