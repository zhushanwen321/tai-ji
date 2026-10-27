/**
 * sidebar 会话动作 + 归档视图合并产物（round 6 renderer 测试压缩）：三文件同产物，
 * 环境默认（happy-dom；archive-view mount 需要 DOM）。
 *
 * 并入来源（基名）：
 *  - use-sidebar-session-actions-export-jsonl（onExportSessionJsonl，3 例）
 *  - use-sidebar-session-actions-forcequit（onForceQuitSession 强杀分流，2 例）
 *  - use-archive-view（归档列表/恢复/批量删除编排，23 例）
 *
 * mock 注册与互斥核查（三源统一）：
 *  - '@/api'：forcequit（session.forceQuit 砍成员）与 archive（session 四成员砍成员）
 *    双工厂 → 统一为 spread actual + session 域覆写五成员（forceQuit/listArchives/
 *    unarchive/purgeArchive/list）；export-jsonl 节原走真门面，spread 保留真成员不受
 *    截断（session-export 深路径另立 mock）。
 *  - '@/composables/useToast'：三源统一为四键单例工厂（error/success/info 驻
 *    helpers/sidebar-mount 的 sidebarToastTripleMocks，warning 为本产物新增单例——
 *    archive 节断言 toastMocks.warning，triple 原缺该键）；archive 的 toastMocks
 *    别名指向同一批实例。export-jsonl/forcequit 的 toastError/Success/Info 别名
 *    合并去重（同引用）。
 *  - useChat mock（forcequit：仅 abort）——useSidebarSessionActions 源码面消费仅
 *    abort（grep 核实）；export-jsonl 节原真 useChat 未触 abort 路径，mock 在场无害；
 *    useArchiveView 不消费 useChat。
 *  - delivery / session-export 深路径 mock 独立 spec，无冲突。
 *  - 各文件级 beforeEach/afterEach 已下沉进各自 describe。
 *
 * 互斥登记：useForkActions（真 useToast 单例 + clearToasts 队列断言，与本产物 useToast
 * mock 结构性互斥）保留独立；useSidebar / useSidebar-deletefolder（15+ mock 生态，
 * 与本产物 @/api/useToast/useChat 工厂全面冲突，统一改造成本大于收益）保留独立。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/composables/sidebar-actions-bundle.test.ts
 */
import { sidebarToastTripleMocks } from '../helpers/sidebar-mount'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, ref } from 'vue'

// ── 共享替身 ──
const exportSessionJsonlMock = vi.hoisted(() => vi.fn())
const forceQuitMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const apiMocks = vi.hoisted(() => ({
  listArchives: vi.fn(),
  unarchive: vi.fn(),
  purgeArchive: vi.fn(),
  list: vi.fn(),
}))
// toast 四键单例：三键驻 sidebar-mount triple，warning 为本产物新增（archive 节断言面）
const toastWarningMock = vi.hoisted(() => vi.fn())
const toastErrorMock = sidebarToastTripleMocks.error
const toastSuccessMock = sidebarToastTripleMocks.success
const toastInfoMock = sidebarToastTripleMocks.info
const toastMocks = { error: toastErrorMock, info: toastInfoMock, warning: toastWarningMock }

vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    session: {
      ...actual.session,
      forceQuit: forceQuitMock,
      listArchives: apiMocks.listArchives,
      unarchive: apiMocks.unarchive,
      purgeArchive: apiMocks.purgeArchive,
      list: apiMocks.list,
    },
  }
})

vi.mock('@/api/domains/session-export', () => ({
  exportSessionJsonl: exportSessionJsonlMock,
}))

// [u3c/D10] forceQuit 全量回收改走内核 drain（delivery.drain RPC）；本文件只锁 RPC 编排，
// 返回空条目集（文本回收与提示断言见 __tests__/sidebar/force-quit-queue-recovery.test.ts）
vi.mock('@/api/domains/delivery', () => ({
  delivery: { drainDelivery: vi.fn(async (sessionId: string) => ({ sessionId, entries: [] })) },
}))

vi.mock('@/composables/features/chat/useChat', () => ({
  // [u5a] 前身 clearQueueState stub（session-dead G1）已删：该 API 随 queueStates 分区退役
  useChat: () => ({ abort: vi.fn() }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    error: toastErrorMock,
    success: toastSuccessMock,
    info: toastInfoMock,
    warning: toastWarningMock,
  }),
}))

import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'
import { consumeForcedExit, resetForcedExitMarks } from '@/composables/effects/forced-exit-marks'
import { useArchiveView, useArchiveCountBroadcast } from '@/composables/features/sidebar/useArchiveView'
import { dispatchGlobal } from '@taiji/core/transport/api'
import { useArchiveStore } from '@/stores/archive'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import type { ArchiveSummary } from '@taiji/shared'


// ═══════════ 来源节：use-sidebar-session-actions-export-jsonl ═══════════

function makeOptions() {
  return {
    selectSession: vi.fn(),
    restoreSession: vi.fn(),
    newSession: vi.fn(),
    loadSessions: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteFolder: vi.fn(),
    assignSessionToProject: vi.fn(),
    renameOpen: ref(false),
    targetSessionId: ref(''),
  }
}

const PAYLOAD = {
  sessionId: 'exp-1',
  sessionFile: '/data/agent/sessions/c-p/exp-1.jsonl',
  suggestedName: '我的会话.jsonl',
}

describe('useSidebarSessionActions.onExportSessionJsonl', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('EXH1: exported → IPC 域函数收到原样 payload + toast「会话已导出到 <path>」', async () => {
    exportSessionJsonlMock.mockResolvedValueOnce({ status: 'exported', path: '/Users/x/导出.jsonl', bytes: 128 })
    const actions = useSidebarSessionActions(makeOptions())

    await actions.onExportSessionJsonl(PAYLOAD)

    expect(exportSessionJsonlMock).toHaveBeenCalledWith(PAYLOAD)
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(String(toastInfoMock.mock.calls[0][0])).toContain('会话已导出到')
    expect(String(toastInfoMock.mock.calls[0][0])).toContain('/Users/x/导出.jsonl')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('EXH2: error → toast「导出失败（<code>）：<message>」，不向上抛', async () => {
    exportSessionJsonlMock.mockResolvedValueOnce({
      status: 'error',
      error: { code: 'EPATH', message: '会话文件路径不在会话数据目录内，已拒绝导出' },
    })
    const actions = useSidebarSessionActions(makeOptions())

    await expect(actions.onExportSessionJsonl(PAYLOAD)).resolves.toBeUndefined()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('导出失败')
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('EPATH')
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('EXH3: canceled → 静默（双 toast 通道均不出声）', async () => {
    exportSessionJsonlMock.mockResolvedValueOnce({ status: 'canceled' })
    const actions = useSidebarSessionActions(makeOptions())

    await actions.onExportSessionJsonl(PAYLOAD)

    expect(toastInfoMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })
})

// ═══════════ 来源节：use-sidebar-session-actions-forcequit ═══════════

function makeForceQuitOptions() {
  return {
    selectSession: vi.fn(),
    restoreSession: vi.fn(),
    newSession: vi.fn(),
    loadSessions: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteFolder: vi.fn(),
    assignSessionToProject: vi.fn(),
    renameOpen: ref(false),
    targetSessionId: ref(''),
  }
}

describe('useSidebarSessionActions.onForceQuitSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => {
    // forced-exit 标记是模块级 Set：复位防跨用例泄漏（FQH1 断言本身已 consume，双保险）
    resetForcedExitMarks()
  })

  it('FQH1: 成功 → 调 sessionApi.forceQuit(sessionId)，播种意图标记且不被 handler 消费，无 toast', async () => {
    const actions = useSidebarSessionActions(makeForceQuitOptions())

    await actions.onForceQuitSession('fq-1')

    expect(forceQuitMock).toHaveBeenCalledWith('fq-1')
    // 标记读写对：handler 进入时 markForcedExit 播种；成功路径不消费（消费归 session.exited
    // 帧的 handleSessionExited，读后即清）——consume 命中 = 播种存在且未被 handler 提前消费
    expect(consumeForcedExit('fq-1')).toBe(true)
    // FQH1「无 toast」完整面：error/success/info 三通道均不得出声（UI 收敛靠 session.exited 广播）
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(toastSuccessMock).not.toHaveBeenCalled()
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('FQH2: RPC reject → 撤销意图标记 + toast「强制退出失败：<msg>」，不向上抛', async () => {
    forceQuitMock.mockRejectedValueOnce(new Error('session not active'))
    const actions = useSidebarSessionActions(makeForceQuitOptions())

    await expect(actions.onForceQuitSession('fq-2')).resolves.toBeUndefined()

    // 标记读写对：失败路径 consumeForcedExit 撤销播种——consume 未命中 = 标记已被 handler
    // 撤销（无残留把该 session 下次意外崩溃误判为强制退出）
    expect(consumeForcedExit('fq-2')).toBe(false)
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('强制退出失败')
    expect(String(toastErrorMock.mock.calls[0][0])).toContain('session not active')
  })
})

// ═══════════ 来源节：use-archive-view ═══════════

const MB = 1024 * 1024

function makeArchive(sessionId = 'arc-1'): ArchiveSummary {
  return {
    sessionId,
    name: 'v0.10 renderer 重构',
    originalFile: '2026-10-20T10-00-00_a1b2c3d4.jsonl',
    cwd: '/Users/demo/proj',
    archivedAt: '2026-10-20T12:34:56.789Z',
    rawBytes: 12.4 * MB,
    status: 'archived',
    codec: 'zstd-3',
    compressedBytes: 2.5 * MB,
    sha256: 'a'.repeat(64),
    summary: { turns: [] },
  }
}

/** staging 态条目（D5 同步段骨架：搬移完成、压缩/摘要未完成——summary 显式 null、无压缩产物字段）。 */
function makeStagingArchive(sessionId = 'arc-1'): ArchiveSummary {
  return {
    sessionId,
    name: 'v0.10 renderer 重构',
    originalFile: '2026-10-20T10-00-00_a1b2c3d4.jsonl',
    cwd: '/Users/demo/proj',
    archivedAt: '2026-10-20T12:34:56.789Z',
    rawBytes: 12.4 * MB,
    status: 'staging',
    summary: null,
  }
}

/**
 * 主区摘要视图布景（openSummary 呈现该条目）+ purge 成功回复与列表刷新 mock 置备，
 * 返回条目与导航 store 供删除编排与离开断言（单条 purgeArchiveEntry / 批量
 * purgeArchivesBatch 的 selected 联动用例同布景）。
 */
function stageSummaryViewForPurge(purgeReply: Record<string, unknown>) {
  const archive = makeArchive()
  useArchiveView().openSummary(archive)
  const navigation = useNavigationStore()
  expect(navigation.current.view).toBe('archive')
  apiMocks.purgeArchive.mockResolvedValue(purgeReply)
  apiMocks.listArchives.mockResolvedValue([])
  return { archive, navigation }
}

describe('openSummary / refreshArchives（D11 摘要视图入口 + D10 列表拉取）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    apiMocks.listArchives.mockResolvedValue([])
    apiMocks.list.mockResolvedValue([])
  })

  it('openSummary：登记 selected + navigation.push({view:"archive"})', () => {
    const { openSummary } = useArchiveView()
    const archive = makeArchive()
    const navigation = useNavigationStore()

    openSummary(archive)

    expect(useArchiveStore().selected).toEqual(archive)
    expect(navigation.current.view).toBe('archive')
  })

  it('refreshArchives：拉取产物落地 + archiveCount 对账（列表即事实源）', async () => {
    const { refreshArchives } = useArchiveView()
    apiMocks.listArchives.mockResolvedValue([makeArchive(), makeArchive('arc-2')])

    await refreshArchives()

    const store = useArchiveStore()
    expect(store.archives).toHaveLength(2)
    expect(store.archiveCount).toBe(2)
    expect(store.listError).toBeNull()
  })

  it('refreshArchives 失败：置 listError（供列表重试入口）', async () => {
    const { refreshArchives } = useArchiveView()
    apiMocks.listArchives.mockRejectedValue(new Error('net down'))

    await refreshArchives()

    expect(useArchiveStore().listError).toBe('net down')
  })

  it('refreshArchives 在途期间再触发：去重并发 + 完成后自动补拉一轮（trailing 收敛到最新快照）', async () => {
    const { refreshArchives } = useArchiveView()
    // 两轮拉取均受控挂起（慢 RPC 形态），分别返回新旧快照——补拉轮返回新触发时点的数据
    let resolveFirst!: (v: ArchiveSummary[]) => void
    let resolveSecond!: (v: ArchiveSummary[]) => void
    apiMocks.listArchives.mockImplementationOnce(
      () => new Promise<ArchiveSummary[]>((res) => { resolveFirst = res }),
    )
    apiMocks.listArchives.mockImplementationOnce(
      () => new Promise<ArchiveSummary[]>((res) => { resolveSecond = res }),
    )

    const first = refreshArchives()
    const second = refreshArchives() // 在途期间新触发（帧密集到达形态）：复用在途 promise
    expect(apiMocks.listArchives).toHaveBeenCalledTimes(1) // 不并发、不丢弃

    resolveFirst([makeArchive()])
    await Promise.all([first, second])
    // 首轮结果落地（触发者复用同一 promise）；补拉轮已由工具自动发起（挂起中）
    expect(useArchiveStore().archives.map((a) => a.sessionId)).toEqual(['arc-1'])
    expect(apiMocks.listArchives).toHaveBeenCalledTimes(2)

    resolveSecond([makeArchive('arc-2')])
    await vi.waitFor(() => expect(useArchiveStore().archives.map((a) => a.sessionId)).toEqual(['arc-2']))
    expect(useArchiveStore().loading).toBe(false)
  })
})

describe('restoreArchive（验收条款：恢复成功切回会话列表）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    apiMocks.listArchives.mockResolvedValue([])
    apiMocks.list.mockResolvedValue([])
  })

  it('成功：viewOpen=false + 主区回 chat + selected 清空 + 恢复高亮登记（reply.id 消费）+ 归档列表刷新 + 成功 toast', async () => {
    const { restoreArchive, openArchiveView, openSummary } = useArchiveView()
    const archive = makeArchive()
    const store = useArchiveStore()
    const navigation = useNavigationStore()
    // 前置：归档列表视图打开 + 主区正在呈现该条目
    openArchiveView()
    openSummary(archive)
    expect(store.viewOpen).toBe(true)

    // api 层返回解包后的 SessionSummary（core session.ts unarchive 解包 reply.session）
    apiMocks.unarchive.mockResolvedValue({ id: 'arc-1', label: 'v0.10 renderer 重构', status: 'idle' })
    apiMocks.listArchives.mockResolvedValue([])

    await restoreArchive(archive)

    // 切回会话列表（D10 验收条款）
    expect(store.viewOpen).toBe(false)
    // 主区离开摘要视图（selected 清空 + 导航回 chat）
    expect(store.selected).toBeNull()
    expect(navigation.current.view).toBe('chat')
    // 恢复高亮登记：reply 的 SessionSummary.id 消费点（D5 步骤 7 前端高亮置顶——
    // 置顶由恢复重写主文件的 mtime 语义构造性成立，本字段驱动行 accent-soft 渐隐）
    expect(store.restoredSessionId).toBe('arc-1')
    // 会话列表刷新走 runtime 广播回流（owner 唯一写通道，本编排零 sessionStore 直呼）
    expect(apiMocks.list).not.toHaveBeenCalled()
    expect(apiMocks.listArchives).toHaveBeenCalledTimes(2) // openArchiveView 首拉 + 恢复后刷新
    expect(toastMocks.info).toHaveBeenCalledWith('已恢复「v0.10 renderer 重构」，已回到原项目分组')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('失败（RPC reject）：视图保持 + 错误 toast + 无恢复高亮', async () => {
    const { restoreArchive, openArchiveView, openSummary } = useArchiveView()
    const archive = makeArchive()
    // 首拉列表含该条目（真实时序：行可点 = 列表已含该条目；空列表会使重锚清空 selected）
    apiMocks.listArchives.mockResolvedValue([archive])
    openArchiveView()
    openSummary(archive)
    // 生产信封形态：message 为 runtime 原文（不含 toast 前缀），code 挂 Error.code。
    apiMocks.unarchive.mockRejectedValue(
      Object.assign(new Error('原路径已存在同名会话文件'), { code: 'archive_restore_conflict' }),
    )

    await restoreArchive(archive)

    const store = useArchiveStore()
    expect(store.viewOpen).toBe(true)
    expect(store.selected).toEqual(archive)
    expect(store.restoredSessionId).toBeNull()
    expect(store.restoringSessionId).toBeNull()
    // §5.2 界面表现 + 恢复指引（code 分流，单前缀；i18n zh-CN）
    expect(toastMocks.error).toHaveBeenCalledWith(
      '恢复失败：原路径已存在同名会话文件（archive_restore_conflict）。请先处理该同名会话（删除或归档它），再恢复本条',
    )
  })
})

describe('markRestored 恢复高亮生命周期（§5.1「accent-soft 高亮渐隐」）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    apiMocks.listArchives.mockResolvedValue([])
    apiMocks.list.mockResolvedValue([])
  })

  it('置位后 5s 自动清除（渐隐触发）；重复恢复重置计时', async () => {
    vi.useFakeTimers()
    try {
      const store = useArchiveStore()
      store.markRestored('arc-1')
      expect(store.restoredSessionId).toBe('arc-1')

      vi.advanceTimersByTime(3_000)
      store.markRestored('arc-2') // 重置计时（前一个未到期即被替换）
      expect(store.restoredSessionId).toBe('arc-2')

      vi.advanceTimersByTime(3_000) // 距 arc-1 登记 6s 但距 arc-2 仅 3s
      expect(store.restoredSessionId).toBe('arc-2')

      vi.advanceTimersByTime(2_000) // 距 arc-2 登记 5s → 清除
      expect(store.restoredSessionId).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('config.sessions 帧消费（D11 压缩完成刷新 + 角标更新）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    apiMocks.listArchives.mockResolvedValue([])
    apiMocks.list.mockResolvedValue([])
  })

  /** 挂载一个调用 useArchiveCountBroadcast 的空组件（setup 顶层订阅真实事件总线）。 */
  function mountSubscriber() {
    return mount(defineComponent({ setup: () => { useArchiveCountBroadcast(); return () => null } }))
  }

  it('视图关闭：仅更新角标，不拉取归档列表', async () => {
    apiMocks.listArchives.mockClear()
    const wrapper = mountSubscriber()

    dispatchGlobal({ id: 'push_broadcast_1', type: 'config.sessions', payload: { groups: [], archiveCount: 3 } })
    await Promise.resolve()

    expect(useArchiveStore().archiveCount).toBe(3)
    expect(apiMocks.listArchives).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('归档视图打开（viewOpen）：收帧顺带刷新归档列表——「压缩中」标注随压缩完成帧刷新（D11）', async () => {
    useArchiveStore().openView()
    apiMocks.listArchives.mockClear()
    apiMocks.listArchives.mockResolvedValue([makeArchive()])
    const wrapper = mountSubscriber()

    dispatchGlobal({ id: 'push_broadcast_2', type: 'config.sessions', payload: { groups: [], archiveCount: 1 } })
    await vi.waitFor(() => expect(apiMocks.listArchives).toHaveBeenCalledTimes(1))

    expect(useArchiveStore().archives).toHaveLength(1)
    wrapper.unmount()
  })

  it('摘要视图打开（selected 持 staging 对象）而侧栏已返回：完成帧重拉后 selected 换为 archived 态新对象——「摘要生成中」占位清除（D11）', async () => {
    const store = useArchiveStore()
    store.selectArchive(makeStagingArchive()) // 主区摘要视图呈现 staging 态（viewOpen=false），「摘要生成中」全区占位
    const archived = makeArchive() // 压缩完成后 config.archives 返回的 archived 态新对象（后台任务簿记重写）
    apiMocks.listArchives.mockClear()
    apiMocks.listArchives.mockResolvedValue([archived])
    const wrapper = mountSubscriber()

    dispatchGlobal({ id: 'push_broadcast_3', type: 'config.sessions', payload: { groups: [], archiveCount: 1 } })
    // 占位清除判据（D11）：ArchiveMainView 以 selected 驱动 ArchiveSummaryView，selected
    // 持旧 staging 引用则 isArchived 恒 false、「摘要生成中」占位永不消失——重锚后
    // status 须为 archived（pinia store 读出对象为 reactive proxy，引用断言不可靠，
    // 以判别字段 status 为准；无重锚逻辑时此处恒 'staging' 必红）
    await vi.waitFor(() => expect(store.selected?.status).toBe('archived'))

    wrapper.unmount()
  })

  it('摘要视图打开但条目已在新快照消失（远端窗口恢复/删除）：selected 置 null——主区空态占位', async () => {
    const store = useArchiveStore()
    store.selectArchive(makeStagingArchive('arc-gone'))
    apiMocks.listArchives.mockClear()
    apiMocks.listArchives.mockResolvedValue([])
    const wrapper = mountSubscriber()

    dispatchGlobal({ id: 'push_broadcast_5', type: 'config.sessions', payload: { groups: [], archiveCount: 0 } })
    await vi.waitFor(() => expect(store.selected).toBeNull())

    wrapper.unmount()
  })

  it('帧无 archiveCount 字段（旧 runtime）：不覆盖现值、视图关闭不拉取', async () => {
    const store = useArchiveStore()
    store.setCount(7)
    apiMocks.listArchives.mockClear()
    const wrapper = mountSubscriber()

    dispatchGlobal({ id: 'push_broadcast_4', type: 'config.sessions', payload: { groups: [] } })
    await Promise.resolve()

    expect(store.archiveCount).toBe(7) // 缺省不覆盖（拉取对账另按列表事实源收敛）
    expect(apiMocks.listArchives).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('purgeArchiveEntry（D5 步骤 7：keep-all 保守分支显式上报）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    apiMocks.listArchives.mockResolvedValue([])
    apiMocks.list.mockResolvedValue([])
  })

  it('干净删除：info toast + 归档列表刷新', async () => {
    const { purgeArchiveEntry } = useArchiveView()
    apiMocks.purgeArchive.mockResolvedValue({ sessionId: 'arc-1' })
    apiMocks.listArchives.mockResolvedValue([])

    await purgeArchiveEntry(makeArchive())

    expect(toastMocks.info).toHaveBeenCalledWith('已彻底删除「v0.10 renderer 重构」')
    expect(toastMocks.warning).not.toHaveBeenCalled()
  })

  it('keep-all 分支（keptSubagentsDir 携带）：warning toast 含残留目录指引；主区呈现该条目时同步离开', async () => {
    const { purgeArchiveEntry } = useArchiveView()
    const { archive, navigation } = stageSummaryViewForPurge({
      sessionId: 'arc-1',
      keptSubagentsDir: '/data/ext-sessions/arc-1/subagents',
    })

    await purgeArchiveEntry(archive)

    expect(toastMocks.warning).toHaveBeenCalledWith(
      '已彻底删除「v0.10 renderer 重构」；子代理记录因归档数据不可读已保守保留（/data/ext-sessions/arc-1/subagents）',
    )
    expect(useArchiveStore().selected).toBeNull()
    expect(navigation.current.view).toBe('chat')
  })

  it('失败：错误 toast + 状态不动', async () => {
    const { purgeArchiveEntry } = useArchiveView()
    apiMocks.purgeArchive.mockRejectedValue(new Error('彻底删除失败：归档记录不存在 (archive_not_found)'))

    await purgeArchiveEntry(makeArchive())

    expect(toastMocks.error).toHaveBeenCalled()
    expect(apiMocks.listArchives).not.toHaveBeenCalled()
  })
})

describe('purgeArchivesBatch（筛选行批量彻底删除：串行循环 + 结果分流）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    apiMocks.listArchives.mockResolvedValue([])
    apiMocks.list.mockResolvedValue([])
  })

  it('全部成功：串行逐条 purgeArchive + info toast + 列表刷新 + batchPurging 全程置位后复位', async () => {
    const { purgeArchivesBatch } = useArchiveView()
    const store = useArchiveStore()
    const entries = [makeArchive(), makeArchive('arc-2'), makeArchive('arc-3')]
    apiMocks.purgeArchive.mockResolvedValue({ sessionId: 'x' })
    apiMocks.listArchives.mockResolvedValue([])

    const promise = purgeArchivesBatch(entries)
    expect(store.batchPurging).toBe(true) // 在途置位（钮禁用的数据源）
    await promise

    expect(apiMocks.purgeArchive).toHaveBeenCalledTimes(3)
    expect(store.batchPurging).toBe(false)
    expect(toastMocks.info).toHaveBeenCalledWith('已彻底删除 3 个归档会话')
    expect(toastMocks.warning).not.toHaveBeenCalled()
    expect(apiMocks.listArchives).toHaveBeenCalled() // 结束统一刷新一次
  })

  it('部分失败：单条失败不中断整批 + warning toast 汇总成功/失败数并附首个失败原因文案', async () => {
    const { purgeArchivesBatch } = useArchiveView()
    apiMocks.purgeArchive
      .mockResolvedValueOnce({ sessionId: 'arc-1' })
      .mockRejectedValueOnce(new Error('会话目录被占用'))
      .mockResolvedValueOnce({ sessionId: 'arc-3' })

    await purgeArchivesBatch([makeArchive(), makeArchive('arc-2'), makeArchive('arc-3')])

    expect(apiMocks.purgeArchive).toHaveBeenCalledTimes(3)
    // 未知码回退操作级通用模板（archive.entry.purgeFailed）——原因文案随汇总 toast 附带
    expect(toastMocks.warning).toHaveBeenCalledWith(
      '已彻底删除 2 个、失败 1 个；彻底删除失败：会话目录被占用；列表已刷新，可重试剩余项',
    )
    expect(toastMocks.info).not.toHaveBeenCalled()
  })

  it('archive_not_found 幂等达成：计成功口径不入 failed（不触发「可重试」误导指引），warning 只汇总真实失败并附首因', async () => {
    const { purgeArchivesBatch } = useArchiveView()
    // 第 2 条列表过期（并发单条删除/陈旧快照形态）：code 信封挂 Error.code，archiveErrorKey 命中映射
    apiMocks.purgeArchive
      .mockResolvedValueOnce({ sessionId: 'arc-1' })
      .mockRejectedValueOnce(Object.assign(new Error('归档记录不存在'), { code: 'archive_not_found' }))
      .mockRejectedValueOnce(Object.assign(new Error('disk io hung'), { code: 'archive_io_error' }))

    await purgeArchivesBatch([makeArchive(), makeArchive('arc-2'), makeArchive('arc-3')])

    expect(apiMocks.purgeArchive).toHaveBeenCalledTimes(3)
    // ok=2（真实成功 + 幂等达成）、failed=1（仅 archive_io_error）；首因取 ioError 映射文案
    expect(toastMocks.warning).toHaveBeenCalledWith(
      '已彻底删除 2 个、失败 1 个；操作失败：disk io hung（archive_io_error）。session 状态以磁盘为准，启动自愈会归位，重试或检查磁盘；列表已刷新，可重试剩余项',
    )
    expect(toastMocks.info).not.toHaveBeenCalled()
  })

  it('全部 archive_not_found（列表过期形态）：幂等达成全计成功口径，info toast 不出 warning', async () => {
    const { purgeArchivesBatch } = useArchiveView()
    apiMocks.purgeArchive.mockRejectedValue(
      Object.assign(new Error('归档记录不存在'), { code: 'archive_not_found' }),
    )
    apiMocks.listArchives.mockResolvedValue([])

    await purgeArchivesBatch([makeArchive(), makeArchive('arc-2')])

    expect(toastMocks.info).toHaveBeenCalledWith('已彻底删除 2 个归档会话')
    expect(toastMocks.warning).not.toHaveBeenCalled()
  })

  it('keep-all 保守分支（keptSubagentsDir 携带）：warning toast 出声（与单条 purge 同语义）', async () => {
    const { purgeArchivesBatch } = useArchiveView()
    apiMocks.purgeArchive
      .mockResolvedValueOnce({ sessionId: 'arc-1', keptSubagentsDir: '/data/ext-sessions/arc-1/subagents' })
      .mockResolvedValueOnce({ sessionId: 'arc-2' })

    await purgeArchivesBatch([makeArchive(), makeArchive('arc-2')])

    expect(toastMocks.warning).toHaveBeenCalledWith(
      '已彻底删除 2 个归档会话；1 条的子代理记录因数据不可读已保守保留',
    )
  })

  it('防重入：batchPurging 在途期间新触发直接忽略（零 RPC）', async () => {
    const { purgeArchivesBatch } = useArchiveView()
    const store = useArchiveStore()
    let release!: () => void
    apiMocks.purgeArchive.mockImplementationOnce(
      () => new Promise<{ sessionId: string }>((res) => { release = () => res({ sessionId: 'arc-1' }) }),
    )
    apiMocks.listArchives.mockResolvedValue([])

    const first = purgeArchivesBatch([makeArchive()])
    await purgeArchivesBatch([makeArchive('arc-2')]) // 在途期间再触发：直接返回
    expect(apiMocks.purgeArchive).toHaveBeenCalledTimes(1)

    release()
    await first
    expect(store.batchPurging).toBe(false)
  })

  it('主区 selected 落在被删集合：清空选中 + 导航回 chat（对齐单条 purge 编排）', async () => {
    const { purgeArchivesBatch } = useArchiveView()
    const { archive, navigation } = stageSummaryViewForPurge({ sessionId: 'arc-1' })

    await purgeArchivesBatch([archive, makeArchive('arc-2')])

    expect(useArchiveStore().selected).toBeNull()
    expect(navigation.current.view).toBe('chat')
  })

  it('主区 selected 条目删除失败：选中保留、不导航回 chat（对齐单条失败分支），失败汇总 toast 照常', async () => {
    const { purgeArchivesBatch, openSummary } = useArchiveView()
    const archive = makeArchive()
    openSummary(archive)
    const navigation = useNavigationStore()

    apiMocks.purgeArchive
      .mockRejectedValueOnce(new Error('会话目录被占用'))
      .mockResolvedValueOnce({ sessionId: 'arc-2' })
    // 刷新后失败条目仍在列表（删除失败 = 磁盘未动，列表即事实源）——store 对账不清选中
    apiMocks.listArchives.mockResolvedValue([archive])

    await purgeArchivesBatch([archive, makeArchive('arc-2')])

    expect(useArchiveStore().selected?.sessionId).toBe('arc-1')
    expect(navigation.current.view).toBe('archive')
    expect(toastMocks.warning).toHaveBeenCalledWith(
      '已彻底删除 1 个、失败 1 个；彻底删除失败：会话目录被占用；列表已刷新，可重试剩余项',
    )
  })
})
