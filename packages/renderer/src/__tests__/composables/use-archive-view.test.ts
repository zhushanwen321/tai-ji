/**
 * useArchiveView 归档视图编排测试（session-archive 设计 D10/D11，u-renderer-entry）。
 *
 * 覆盖验收条款「恢复成功切回会话列表」+ 归档列表拉取/选中编排：
 * - restoreArchive 成功：切回会话列表（viewOpen=false）+ 主区导航回 chat + selected 清空
 *   + reply.id 登记恢复高亮（D5 步骤 7 前端消费点——restoredSessionId 置位）+ 归档列表
 *   刷新（会话列表刷新走 runtime 广播回流，owner 纪律零 store 直呼）
 * - restoreArchive 失败（RPC reject）：viewOpen 保持 + toast 错误 + 无恢复高亮
 * - openSummary：登记 selected + navigation.push({view:'archive'})
 * - refreshArchives：拉取产物落地 + archiveCount 对账；失败置 listError
 * - handleConfigSessionsFrame（压缩完成帧的 renderer 消费点，D11）：视图关闭仅更新
 *   角标；归档视图/摘要视图打开时顺带刷新归档列表——selected 持 staging 对象时
 *   重拉后按 sessionId 重锚为 archived 态新对象（「摘要生成中」占位清除的判据），
 *   条目消失置 null（主区空态占位）
 * - purgeArchiveEntry keep-all 分支：keptSubagentsDir 携带 → warning toast（D5 步骤 7
 *   失败显式上报）；主区呈现该条目时同步离开
 *
 * mock：@/api（session 域四函数）+ toast；store/navigation/session 用真实 pinia
 * （模块级单例编排消费 pinia 单例——函数级测试形态）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-archive-view.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'

const apiMocks = vi.hoisted(() => ({
  listArchives: vi.fn(),
  unarchive: vi.fn(),
  purgeArchive: vi.fn(),
  list: vi.fn(),
}))

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@/api', () => ({
  session: apiMocks,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMocks,
}))

import { useArchiveView, useArchiveCountBroadcast } from '@/composables/features/sidebar/useArchiveView'
import { dispatchGlobal } from '@taiji/core/transport/api'
import { useArchiveStore } from '@/stores/archive'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import type { ArchiveSummary } from '@taiji/shared'

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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMocks.listArchives.mockResolvedValue([])
  apiMocks.list.mockResolvedValue([])
})

describe('openSummary / refreshArchives（D11 摘要视图入口 + D10 列表拉取）', () => {
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
  it('干净删除：info toast + 归档列表刷新', async () => {
    const { purgeArchiveEntry } = useArchiveView()
    apiMocks.purgeArchive.mockResolvedValue({ sessionId: 'arc-1' })
    apiMocks.listArchives.mockResolvedValue([])

    await purgeArchiveEntry(makeArchive())

    expect(toastMocks.info).toHaveBeenCalledWith('已彻底删除「v0.10 renderer 重构」')
    expect(toastMocks.warning).not.toHaveBeenCalled()
  })

  it('keep-all 分支（keptSubagentsDir 携带）：warning toast 含残留目录指引；主区呈现该条目时同步离开', async () => {
    const { purgeArchiveEntry, openSummary } = useArchiveView()
    const archive = makeArchive()
    openSummary(archive)
    const navigation = useNavigationStore()
    expect(navigation.current.view).toBe('archive')

    apiMocks.purgeArchive.mockResolvedValue({ sessionId: 'arc-1', keptSubagentsDir: '/data/ext-sessions/arc-1/subagents' })
    apiMocks.listArchives.mockResolvedValue([])

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
