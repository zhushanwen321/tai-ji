/**
 * ArchiveMainView 容器组件测试（session-archive 设计 D11 挂载编排，u-renderer-entry）。
 *
 * 覆盖：
 * - selected 在档 → ArchiveSummaryView 渲染 + archive 注入
 * - 卡壳形态：根节点 = 对话流卡片同规格（rounded-card + hairline 边 + bg-surface）
 * - selected 为 null（恢复/彻底删除后编排清空、或异常直达）→ archive-main-empty 占位（卡内）
 * - restore 事件接 useArchiveView.restoreArchive（载荷 = 当前 selected）
 *
 * pinia 真实 store（archive）；useArchiveView 只替换 restoreArchive 出口
 * （编排内含 RPC，容器测试只锁接线），其余导出保留原实现。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/archive-main-view.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ArchiveSummary } from '@taiji/shared'
import ArchiveMainView from '@/components/archive/ArchiveMainView.vue'
import ArchiveSummaryView from '@/components/archive/ArchiveSummaryView.vue'
import { useArchiveStore } from '@/stores/archive'

const { mockRestoreArchive } = vi.hoisted(() => ({ mockRestoreArchive: vi.fn() }))

vi.mock('@/composables/features/sidebar/useArchiveView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/features/sidebar/useArchiveView')>()
  return { ...actual, useArchiveView: () => ({ restoreArchive: mockRestoreArchive }) }
})

/** archived 态条目（容器只透传，summary 形态最小即足）。 */
function makeArchived(over: Partial<Extract<ArchiveSummary, { status: 'archived' }>> = {}): ArchiveSummary {
  return {
    sessionId: 'arc-main-1',
    name: 'v0.10 renderer 重构',
    originalFile: '2026-10-20T10-00-00_a1b2c3d4.jsonl',
    cwd: '/Users/demo/proj',
    archivedAt: '2026-10-20T12:34:56.789Z',
    rawBytes: 1024,
    status: 'archived',
    codec: 'zstd-3',
    compressedBytes: 256,
    sha256: 'a'.repeat(64),
    summary: { turns: [] },
    projectId: 'proj-1',
    ...over,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockRestoreArchive.mockClear()
})

describe('ArchiveMainView · 摘要视图挂载（D11）', () => {
  it('selected 在档 → ArchiveSummaryView 渲染 + archive 注入', () => {
    useArchiveStore().selectArchive(makeArchived())

    const wrapper = mount(ArchiveMainView)

    const summary = wrapper.findComponent(ArchiveSummaryView)
    expect(summary.exists()).toBe(true)
    expect(summary.props('archive')).toMatchObject({ sessionId: 'arc-main-1' })
    // 空态占位不渲染（互斥分支）
    expect(wrapper.find('[data-testid="archive-main-empty"]').exists()).toBe(false)
  })

  it('卡壳与对话流卡片同规格（rounded-card + hairline 边 + bg-surface）', () => {
    useArchiveStore().selectArchive(makeArchived())

    const wrapper = mount(ArchiveMainView)

    const root = wrapper.find('[data-testid="archive-main-view"]')
    expect(root.classes()).toContain('rounded-[var(--radius-card)]')
    expect(root.classes()).toContain('border-hairline')
    expect(root.classes()).toContain('bg-surface')
  })

  it('selected 为 null → archive-main-empty 占位（不自动回跳，用户经侧栏重新选择）', () => {
    const wrapper = mount(ArchiveMainView)

    expect(wrapper.find('[data-testid="archive-main-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="archive-main-empty"]').text()).toContain('在侧栏归档列表中选择一个会话查看摘要')
    expect(wrapper.findComponent(ArchiveSummaryView).exists()).toBe(false)
  })

  it('restore 事件 → useArchiveView.restoreArchive 以当前 selected 调用（接线锁）', async () => {
    const archive = makeArchived()
    useArchiveStore().selectArchive(archive)

    const wrapper = mount(ArchiveMainView)
    wrapper.findComponent(ArchiveSummaryView).vm.$emit('restore')
    await wrapper.vm.$nextTick()

    expect(mockRestoreArchive).toHaveBeenCalledTimes(1)
    expect(mockRestoreArchive).toHaveBeenCalledWith(archive)
  })

  it('selected 为 null 时 restore 不可能触发（占位无 restore 出口——分支 guard 锁）', () => {
    const wrapper = mount(ArchiveMainView)

    // 占位分支不存在 ArchiveSummaryView 实例，restore 事件无从产生
    expect(wrapper.findComponent(ArchiveSummaryView).exists()).toBe(false)
    expect(mockRestoreArchive).not.toHaveBeenCalled()
  })
})
