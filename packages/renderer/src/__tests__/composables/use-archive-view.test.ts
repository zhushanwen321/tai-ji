/**
 * useArchiveView 归档视图编排测试（session-archive 设计 D10/D11，u-renderer-entry）。
 *
 * 覆盖验收条款「恢复成功切回会话列表」+ 归档列表拉取/选中编排：
 * - restoreArchive 成功：切回会话列表（viewOpen=false）+ 主区导航回 chat + selected 清空
 *   + 归档列表刷新（会话列表刷新走 runtime 广播回流，owner 纪律零 store 直呼）
 * - restoreArchive 失败（RPC reject）：viewOpen 保持 + toast 错误
 * - openSummary：登记 selected + navigation.push({view:'archive'})
 * - refreshArchives：拉取产物落地 + archiveCount 对账；失败置 listError
 * - purgeArchiveEntry keep-all 分支：keptSubagentsDir 携带 → warning toast（D5 步骤 7
 *   失败显式上报）；主区呈现该条目时同步离开
 *
 * mock：@/api（session 域四函数）+ toast；store/navigation/session 用真实 pinia
 * （模块级单例编排消费 pinia 单例——函数级测试形态）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-archive-view.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

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

import { useArchiveView } from '@/composables/features/sidebar/useArchiveView'
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
})

describe('restoreArchive（验收条款：恢复成功切回会话列表）', () => {
  it('成功：viewOpen=false + 主区回 chat + selected 清空 + 归档列表刷新 + 成功 toast', async () => {
    const { restoreArchive, openArchiveView, openSummary } = useArchiveView()
    const archive = makeArchive()
    const store = useArchiveStore()
    const navigation = useNavigationStore()
    // 前置：归档列表视图打开 + 主区正在呈现该条目
    openArchiveView()
    openSummary(archive)
    expect(store.viewOpen).toBe(true)

    apiMocks.unarchive.mockResolvedValue({ sessionId: 'arc-1', session: { id: 'arc-1' } })
    apiMocks.listArchives.mockResolvedValue([])

    await restoreArchive(archive)

    // 切回会话列表（D10 验收条款）
    expect(store.viewOpen).toBe(false)
    // 主区离开摘要视图（selected 清空 + 导航回 chat）
    expect(store.selected).toBeNull()
    expect(navigation.current.view).toBe('chat')
    // 会话列表刷新走 runtime 广播回流（owner 唯一写通道，本编排零 sessionStore 直呼）
    expect(apiMocks.list).not.toHaveBeenCalled()
    expect(apiMocks.listArchives).toHaveBeenCalledTimes(2) // openArchiveView 首拉 + 恢复后刷新
    expect(toastMocks.info).toHaveBeenCalledWith('已恢复「v0.10 renderer 重构」，已回到原项目分组')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('失败（RPC reject）：视图保持 + 错误 toast', async () => {
    const { restoreArchive, openArchiveView, openSummary } = useArchiveView()
    const archive = makeArchive()
    openArchiveView()
    openSummary(archive)
    apiMocks.unarchive.mockRejectedValue(new Error('恢复失败：原路径已存在同名会话文件 (archive_restore_conflict)'))

    await restoreArchive(archive)

    const store = useArchiveStore()
    expect(store.viewOpen).toBe(true)
    expect(store.selected).toEqual(archive)
    expect(toastMocks.error).toHaveBeenCalledWith(
      '恢复失败：恢复失败：原路径已存在同名会话文件 (archive_restore_conflict)',
    )
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
