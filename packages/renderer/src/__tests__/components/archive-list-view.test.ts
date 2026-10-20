/**
 * ArchiveListView 组件测试（session-archive 设计 D10，u-renderer-entry）。
 *
 * 覆盖验收条款「归档列表行结构与空态」+ 悬停双钮/两段彻底删除：
 * - 行结构：名称 / 原项目标签（projectId 解析）/ 压缩信息（`12.4 MB → 2.5 MB · -80%`）
 *   / 归档时间 / staging「压缩中」标注
 * - 空态：archives 空且非 loading → 「暂无归档会话」居中占位；loading 中不闪空态
 * - 拉取失败态 + 重试 emit
 * - 悬停双钮：恢复（accent）/ 彻底删除（danger 两段确认）
 * - 点击行 emit select / 返回钮 emit back / 恢复钮 emit restore
 * - name 空串回退「未命名会话」（D3 合法簿记形态）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/archive-list-view.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ArchiveSummary } from '@taiji/shared'
import ArchiveListView from '@/components/sidebar/ArchiveListView.vue'
import { useProjectStore } from '@/stores/project'

const MB = 1024 * 1024

/** archived 态条目（rawBytes/compressedBytes 取干净换算值）。 */
function makeArchived(over: Partial<Extract<ArchiveSummary, { status: 'archived' }>> = {}): ArchiveSummary {
  return {
    sessionId: 'arc-1',
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
    projectId: 'proj-1',
    ...over,
  }
}

function makeStaging(): ArchiveSummary {
  return {
    sessionId: 'arc-staging',
    name: '压缩中的会话',
    originalFile: '2026-10-20T11-00-00_e5f6a7b8.jsonl',
    cwd: '/Users/demo/proj',
    archivedAt: '2026-10-20T12:00:00.000Z',
    rawBytes: 1024,
    status: 'staging',
    summary: null,
  }
}

function mountList(archives: ArchiveSummary[], opts: { loading?: boolean; listError?: string | null } = {}) {
  return mount(ArchiveListView, {
    props: {
      archives,
      loading: opts.loading ?? false,
      listError: opts.listError ?? null,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  // projectId → 项目名解析数据源（proj-1 → taiji 项目）；默认项目（id 常量）恒在
  useProjectStore().projects = [
    { id: 'proj-1', name: 'taiji 项目', lastUsedAt: 0 },
    { id: 'proj-2', name: 'Beta', lastUsedAt: 0 },
  ]
})

describe('ArchiveListView 行结构（D10）', () => {
  it('archived 行：名称 + 原项目标签 + 压缩信息（12.4 MB → 2.5 MB · -80%）+ 归档时间', () => {
    const wrapper = mountList([makeArchived()])

    expect(wrapper.find('[data-testid="archive-row-arc-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="archive-row-arc-1"]').text()).toContain('v0.10 renderer 重构')
    expect(wrapper.find('[data-testid="archive-row-project-arc-1"]').text()).toBe('taiji 项目')
    const compression = wrapper.find('[data-testid="archive-row-compression-arc-1"]').text()
    expect(compression).toContain('12.4 MB → 2.5 MB')
    expect(compression).toMatch(/-\d+%$/)
    expect(wrapper.find('[data-testid="archive-row-time-arc-1"]').exists()).toBe(true)
    // 非 staging 行不渲染「压缩中」标注
    expect(wrapper.find('[data-testid="archive-row-compressing"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('staging 行：压缩信息显示「压缩中」+ 行内「压缩中」标注（V10 可见性）', () => {
    const wrapper = mountList([makeStaging()])

    expect(wrapper.find('[data-testid="archive-row-compressing"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="archive-row-compression-arc-staging"]').text()).toBe('压缩中')
    wrapper.unmount()
  })

  it('name 空串（提取失败合法形态）→ 未命名会话占位；未归类无项目标签段', () => {
    const wrapper = mountList([makeArchived({ name: '', projectId: undefined })])

    const row = wrapper.find('[data-testid="archive-row-arc-1"]')
    expect(row.text()).toContain('未命名会话')
    expect(wrapper.find('[data-testid="archive-row-project-arc-1"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ArchiveListView 空态与失败态（D10）', () => {
  it('空列表 + 非 loading → 居中「暂无归档会话」占位', () => {
    const wrapper = mountList([])
    expect(wrapper.find('[data-testid="archive-list-empty"]').text()).toBe('暂无归档会话')
    wrapper.unmount()
  })

  it('loading 中不闪空态（空态判定含非 loading 条件）', () => {
    const wrapper = mountList([], { loading: true })
    expect(wrapper.find('[data-testid="archive-list-empty"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('拉取失败 → 失败态 + 重试钮 emit retry', async () => {
    const wrapper = mountList([], { listError: 'transport unavailable' })
    expect(wrapper.find('[data-testid="archive-list-error"]').exists()).toBe(true)

    await wrapper.find('[data-testid="archive-list-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('ArchiveListView 行交互（D10 悬停双钮 + 事件）', () => {
  it('点击行 emit select(archive)；返回钮 emit back', async () => {
    const archive = makeArchived()
    const wrapper = mountList([archive])

    await wrapper.find('[data-testid="archive-row-arc-1"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([[archive]])

    await wrapper.find('[data-testid="archive-back-btn"]').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
    wrapper.unmount()
  })

  it('恢复钮（accent）emit restore', async () => {
    const archive = makeArchived()
    const wrapper = mountList([archive])

    expect(wrapper.find('[data-testid="archive-row-restore-btn"]').classes()).toContain('text-accent')
    await wrapper.find('[data-testid="archive-row-restore-btn"]').trigger('click')
    expect(wrapper.emitted('restore')).toEqual([[archive]])
    wrapper.unmount()
  })

  it('彻底删除两段确认（D6 两段红确认）：首击进 danger 确认态不 emit；再击 emit purge', async () => {
    const archive = makeArchived()
    const wrapper = mountList([archive])
    const btn = wrapper.find('[data-testid="archive-row-purge-btn"]')

    await btn.trigger('click')
    expect(btn.classes()).toContain('bg-danger')
    expect(btn.attributes('title')).toBe('确认彻底删除？')
    expect(wrapper.emitted('purge')).toBeUndefined()

    await btn.trigger('click')
    expect(wrapper.emitted('purge')).toEqual([[archive]])
    expect(btn.classes()).not.toContain('bg-danger')
    wrapper.unmount()
  })
})
