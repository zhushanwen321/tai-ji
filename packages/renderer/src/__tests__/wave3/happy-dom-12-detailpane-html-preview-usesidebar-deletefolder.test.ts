import DetailPane from '@/components/panel/DetailPane.vue';
import { useSidebar } from '@/composables/features/sidebar/useSidebar';
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState';
import { useNavigationStore } from '@/stores/navigation';
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel';
import { useSessionStore } from '@/stores/session';
import type { SessionGroup, SessionSummary } from '@taiji/shared';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { effectScope } from 'vue';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/composables/useSidebar-deletefolder.test.ts
 * - composables/features/file-tree/__tests__/DetailPane-html-preview.test.ts
 */

// ======================================================================
// ← __tests__/composables/useSidebar-deletefolder.test.ts
// ======================================================================

// ── mock fileTree store：捕获 clearSession（cleanupSessionState 副作用）──
// selectSession 会经 useFileTree.loadTree 深度连锁（getTree/setNodeState/fileApi.tree...），
// 用宽松 mock 避免打地鼠——loadTree 由 useFileTree composable 调用，store 侧只 stub clearSession + getTree。
const clearSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () =>
    new Proxy(
      { clearSession: clearSessionMock, getTree: () => null },
      { get: (t, p) => (p in t ? t[p as keyof typeof t] : () => {}) },
    ),
}))

// ── mock useFileTree composable：selectSession 连锁调 loadTree，stub 为 no-op ──
vi.mock('@/composables/features/file-tree/useFileTree', () => ({
  useFileTree: () => ({ loadTree: () => Promise.resolve() }),
}))

// ── mock useChat composable：捕获 disposeSession（cleanupSessionState 副作用）──
// 补全 useChat 返回方法（与生产 useChat composable 返回签名对齐），确保 selectSession
// 走「hydrate 成功」路径而非 catch 回退；未来重构移除 try/catch 也不会静默失败。
const useChatDisposeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    editAndResend: vi.fn(),
    hydrateHistory: vi.fn(() => Promise.resolve()),
    loadMoreHistory: vi.fn(() => Promise.resolve()),
    hasMoreHistory: vi.fn(() => false),
    disposeSession: useChatDisposeMock,
  }),
  ensureStreamSubscription: vi.fn(),
}))

// ── mock api 域：removeByCwd 是 deleteFolder 的核心 WS 调用 ──
const removeByCwdMock = vi.hoisted(() => vi.fn())
const switchSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    getHistory: vi.fn(() => Promise.resolve({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })),
    streamSubscribe: vi.fn(() => () => {}),
  },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: switchSessionMock,
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    removeByCwd: removeByCwdMock,
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
    // selectSession 真实连锁会调这些——补 mock 避免 unhandled rejection（新用例走 selectSession(s3.id) 分支）
    getContext: vi.fn(() => Promise.resolve({})),
    getSubagents: vi.fn(() => Promise.resolve([])),
    getWorkflows: vi.fn(() => Promise.resolve([])),
    getAgentCallHistory: vi.fn(() => Promise.resolve([])),
  },
}))

// ── useCommandStore 壳单例 mock（[G1] clearSlashCommands hook 接线配套；见文件头 mock 策略）──
vi.mock('@/composables/features/command/useCommandStore', () => ({
  useCommandStore: () => ({
    appCommands: { value: [] },
    shortcutOverrides: { value: {} },
    clearCommands: vi.fn(),
  }),
}))

function makeSummary(id: string, cwd = '/p'): SessionSummary {
  return { id, label: id, cwd, status: 'idle', lastActiveAt: 1 }
}

/** 种入指定 cwd 下若干 session（单组）—— seed pinia session store（ADR-0059） */
function seedSessions(_sidebar: ReturnType<typeof useSidebar>, ids: string[], cwd = '/p'): void {
  const group: SessionGroup = { cwd, sessions: ids.map((id) => makeSummary(id, cwd)) }
  useSessionStore().applySnapshot({ groups: [group] })
}

beforeEach(() => {
  __clearSessionCleanupRegistryForTest()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  switchSessionMock.mockResolvedValue(undefined)
})

describe('useSidebar.deleteFolder 全成功（W2TC2）', () => {
  it('对 res.deleted 逐个 cleanupSessionState（clearSession/disposeSession 各 2 次），wasActiveInFolder 回退到 next', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // folder('/p') 下 2 session：s1 persisted + s2 active
    seedSessions(sidebar, ['s1', 's2'])
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's2')
    useSessionStore().setActiveId('s2')

    removeByCwdMock.mockResolvedValueOnce({
      cwd: '/p',
      deleted: ['s1', 's2'],
      failed: [],
    })
    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    const res = await sidebar.deleteFolder('/p')

    // WS 调用正确
    expect(removeByCwdMock).toHaveBeenCalledWith('/p')
    // 返回 BatchDeleteResult
    expect(res).toEqual({ cwd: '/p', deleted: ['s1', 's2'], failed: [] })
    // cleanupSessionState 对 s1 / s2 各调一次（clearSession + disposeSession 各 2 次）
    expect(clearSessionMock).toHaveBeenCalledWith('s1')
    expect(clearSessionMock).toHaveBeenCalledWith('s2')
    expect(useChatDisposeMock).toHaveBeenCalledWith('s1')
    expect(useChatDisposeMock).toHaveBeenCalledWith('s2')
    // wasActiveInFolder=true（s2 是 active 且在 folder 内）→ 回退（list 已空 → push chat）
    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })

    scope.stop()
  })

  it('wasActiveInFolder=true 且删除后有剩余 session → selectSession(next.id)（非 push chat 空态分支）', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // folder('/p') 下 2 session（s1 + active 的 s2），另一 cwd 有 s3（删除后仍留存）
    useSessionStore().applySnapshot({ groups: [
      { cwd: '/p', sessions: [makeSummary('s1', '/p'), makeSummary('s2', '/p')] },
      { cwd: '/other', sessions: [makeSummary('s3', '/other')] },
    ] })
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's2')
    useSessionStore().setActiveId('s2')

    removeByCwdMock.mockResolvedValueOnce({ cwd: '/p', deleted: ['s1', 's2'], failed: [] })
    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    const res = await sidebar.deleteFolder('/p')

    expect(res).toEqual({ cwd: '/p', deleted: ['s1', 's2'], failed: [] })
    // cleanupSessionState 对 s1/s2 各调一次
    expect(clearSessionMock).toHaveBeenCalledWith('s1')
    expect(clearSessionMock).toHaveBeenCalledWith('s2')
    // s3 未删，不被清理
    expect(clearSessionMock).not.toHaveBeenCalledWith('s3')
    // wasActiveInFolder=true → list 非空（s3 留存）→ selectSession(s3.id) 分支
    //（cleanupSessionState 内 removeFromList 已把 activeId 重置，selectSession 切到 s3）
    expect(switchSessionMock).toHaveBeenCalledWith('s3')
    // S6：消除「选中下一个」vs「catch 回退空态」歧义——确认走 selectSession 成功分支：
    // selectSession 内部 navigation.push 带 sessionId（{ view:'chat', sessionId:'s3' }）；
    // catch 回退分支 push 的是无 sessionId 的 { view:'chat' }。两者通过有无 sessionId 区分。
    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat', sessionId: 's3' })
    expect(pushSpy).not.toHaveBeenCalledWith({ view: 'chat' })

    scope.stop()
  })
})

describe('useSidebar.deleteFolder 部分失败（W2TC3）', () => {
  it('deleteFolder 不 reject，返回 failed.length=1，cleanupSessionState 仅对 deleted 调用', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions(sidebar, ['s1', 's2'])
    // active 不在此 folder → wasActiveInFolder=false，不触发回退
    useSessionStore().setActiveId('other')

    removeByCwdMock.mockResolvedValueOnce({
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM' }],
    })
    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    const res = await sidebar.deleteFolder('/p')

    // 不 reject（deleteFolder resolve）
    expect(res.cwd).toBe('/p')
    expect(res.deleted).toEqual(['s1'])
    expect(res.failed).toEqual([{ sessionId: 's2', error: 'EPERM' }])
    expect(res.failed.length).toBe(1)
    // cleanupSessionState 仅对 deleted 中的 's1' 调用（s2 在 failed，未删）
    expect(clearSessionMock).toHaveBeenCalledTimes(1)
    expect(clearSessionMock).toHaveBeenCalledWith('s1')
    expect(clearSessionMock).not.toHaveBeenCalledWith('s2')
    // wasActiveInFolder=false → 不回退
    expect(pushSpy).not.toHaveBeenCalled()

    scope.stop()
  })
})

describe('useSidebar.deleteFolder 网络异常（W2TC4）', () => {
  it('removeByCwd reject → deleteFolder rejects，cleanupSessionState 不被调', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions(sidebar, ['s1', 's2'])

    removeByCwdMock.mockRejectedValueOnce(new Error('network'))

    await expect(sidebar.deleteFolder('/p')).rejects.toThrow('network')

    // WS 删除失败 → 不做任何本地清理
    expect(clearSessionMock).not.toHaveBeenCalled()
    expect(useChatDisposeMock).not.toHaveBeenCalled()

    scope.stop()
  })
})

// ======================================================================
// ← composables/features/file-tree/__tests__/DetailPane-html-preview.test.ts
// ======================================================================

vi.mock('@/composables/features/file-tree/useDetailPane', async () => {
  const { ref } = await import('vue')
  const state = ref({
    path: 'report.html',
    status: 'content',
    content: '<html><body>hi</body></html>',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'code',
  })
  return {
    useDetailPane: () => ({
      // main W3 per-tab 契约范围：tabs/activePath + 实例编排函数（本文件只断言 state 驱动的
      // 内容区与退役足迹，tab 条给空数组即不渲染）
      tabs: ref([]),
      activePath: ref('report.html'),
      state,
      openPreview: vi.fn(),
      toggleView: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
      saveScroll: vi.fn(),
      sessionCwd: () => '/Users/demo',
    }),
    __fixture: { state },
  }
})

type Fixture = {  // oe-exempt:20261027:test:
  state: { value: Record<string, unknown> }
}

async function fixture(): Promise<Fixture> {
  const mod = (await import('@/composables/features/file-tree/useDetailPane')) as unknown as { __fixture: Fixture }
  return mod.__fixture
}

function mountDetailPane() {
  return mount(DetailPane, {
    props: { sessionId: 's1' },
    global: {
      stubs: {
        MarkdownRenderer: { template: '<div data-testid="markdown-stub" />' },
        CodeBlock: { template: '<div data-testid="codeblock-stub" />' },
        DiffView: { template: '<div data-testid="diffview-stub" />' },
        HoverCard: { template: '<div class="hover-card-stub"><slot /></div>' },
        HoverCardTrigger: { template: '<div class="hover-card-trigger-stub"><slot /></div>' },
        HoverCardContent: { template: '<div class="hover-card-content-stub"><slot /></div>' },
      },
    },
  })
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const fx = await fixture()
  fx.state.value = {
    path: 'report.html',
    status: 'content',
    content: '<html><body>hi</body></html>',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'code',
  }
})

describe('DetailPane · .html 恢复源码高亮（渲染态退役回归）', () => {
  it('.html（kind=code）→ CodeBlock 源码高亮，渲染态 DOM 足迹全部消失', () => {
    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-code"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="codeblock-stub"]').exists()).toBe(true)
    // 渲染态足迹：切换 / iframe / 刷新 / 渲染态内容区容器均不存在
    expect(wrapper.find('[data-testid="detail-html-view-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-html-frame"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-html-refresh"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-html-preview"]').exists()).toBe(false)
  })

  it('渲染态退役后无「预览 | 源码」html 切换按钮（源码态是唯一形态）', () => {
    const wrapper = mountDetailPane()
    const header = wrapper.find('[data-testid="detail-pane"]')
    expect(header.exists()).toBe(true)
    // 既有 diff/preview toggle（git 改动语境）保留由其他用例覆盖；此处断言 html 专属切换不存在
    expect(wrapper.text()).not.toContain('panel.detail.htmlTabSource')
  })

  it('加载态 / 错误态不被 html 特殊分支拦截（互斥链回归）', async () => {
    const fx = await fixture()
    fx.state.value = { ...fx.state.value, status: 'loading' }
    const wrapper = mountDetailPane()
    expect(wrapper.find('[data-testid="detail-loading"]').exists()).toBe(true)

    fx.state.value = { ...fx.state.value, status: 'error', error: 'boom' }
    const wrapper2 = mountDetailPane()
    expect(wrapper2.find('[data-testid="detail-error"]').exists()).toBe(true)
    expect(wrapper2.find('[data-testid="detail-html-preview"]').exists()).toBe(false)
  })
})
