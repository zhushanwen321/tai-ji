/**
 * ArchiveListView 组件测试（session-archive 设计 D10，u-renderer-entry）。
 *
 * 覆盖验收条款「归档列表行结构与空态」+ 悬停双钮/两段彻底删除 + 时间筛选行：
 * - 行结构：名称 / 原项目标签（projectId 解析）/ 压缩信息（`12.4 MB → 2.5 MB · -80%`）
 *   / 归档时间 / staging「压缩中」标注
 * - 空态：archives 空且非 loading → 「暂无归档会话」居中占位；loading 中不闪空态；
 *   筛选档下无结果 → 「该时间范围内暂无归档」
 * - 拉取失败态 + 重试 emit
 * - 悬停双钮：恢复（accent）/ 彻底删除（danger 两段确认）
 * - 点击行 emit select / 返回钮 emit back / 恢复钮 emit restore
 * - name 空串回退「未命名会话」（D3 合法簿记形态）
 * - 时间筛选行：档位过滤（互斥四档 + 全部）/ 计数与总体积联动（staging 按原文件计）/
 *   批量清理钮显隐 + 两段确认 emit purgeBatch / 档位切换复位确认态 /
 *   确认态随钮卸载复位（后台刷新卸载重现后首击不得执行）
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
const HOUR = 3_600_000

/** 距今 n 小时的 ISO 时刻（筛选档位判定与构造同源相对 now，无 fake timers 依赖）。 */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * HOUR).toISOString()
}

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

function mountList(
  archives: ArchiveSummary[],
  opts: { loading?: boolean; listError?: string | null; batchPurging?: boolean } = {},
) {
  return mount(ArchiveListView, {
    props: {
      archives,
      loading: opts.loading ?? false,
      listError: opts.listError ?? null,
      restoringSessionId: null,
      purgingSessionId: null,
      batchPurging: opts.batchPurging ?? false,
    },
  })
}

/**
 * 两段确认态实底红样式断言（行级 purge 钮与批量钮同款）：底色 bg-danger + 悬停压色
 * hover:bg-danger（vision 验收缺陷回归锚点：确认态须抵消 ghost variant 的
 * hover:bg-surface-hover——点击后指针悬停在钮上，灰底曾覆盖红底）+ 实底前景语义
 * 令牌 text-danger-fg（token 层修复后的终态：--danger-fg 暗色族即亮字）。
 */
function expectConfirmDangerStyle(btn: { classes(): string[] }): void {
  expect(btn.classes()).toContain('bg-danger')
  expect(btn.classes()).toContain('hover:bg-danger')
  expect(btn.classes()).toContain('text-danger-fg')
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
    expectConfirmDangerStyle(btn)
    expect(btn.attributes('title')).toBe('确认彻底删除？')
    expect(wrapper.emitted('purge')).toBeUndefined()

    await btn.trigger('click')
    expect(wrapper.emitted('purge')).toEqual([[archive]])
    expect(btn.classes()).not.toContain('bg-danger')
    wrapper.unmount()
  })
})

describe('ArchiveListView 时间筛选行（mono 短码档位 + 总体积 + 批量清理）', () => {
  /** 四档各一条（互斥时间段的代表值：1 天内 3h / 2-3 天 50h / 4-7 天 5d / 7 天外 12d）。 */
  function makeFourBuckets(): ArchiveSummary[] {
    return [
      makeArchived({ sessionId: 'arc-d1', archivedAt: hoursAgo(3), rawBytes: 8 * MB, compressedBytes: 2 * MB }),
      makeArchived({ sessionId: 'arc-d23', archivedAt: hoursAgo(50), rawBytes: 12 * MB, compressedBytes: 3 * MB }),
      makeArchived({ sessionId: 'arc-d47', archivedAt: hoursAgo(5 * 24), rawBytes: 20 * MB, compressedBytes: 4 * MB }),
      makeArchived({ sessionId: 'arc-older', archivedAt: hoursAgo(12 * 24), rawBytes: 32 * MB, compressedBytes: 8 * MB }),
    ]
  }

  it('全部档（缺省）：四条全显 + 总体积 = 压缩后体积合计 + 批量钮不渲染', () => {
    const wrapper = mountList(makeFourBuckets())

    expect(wrapper.find('[data-testid="archive-list-count"]').text()).toBe('4')
    expect(wrapper.find('[data-testid="archive-total-size"]').text()).toBe('17.0 MB') // 2+3+4+8
    expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('切「2-3d」档：仅该档条目可见；计数/总体积联动；批量钮出现且待发态文案为「N 项」', async () => {
    const wrapper = mountList(makeFourBuckets())

    await wrapper.find('[data-testid="archive-filter-d23"]').trigger('click')

    expect(wrapper.find('[data-testid="archive-row-arc-d1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="archive-row-arc-d23"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="archive-list-count"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="archive-total-size"]').text()).toBe('3.0 MB')
    const btn = wrapper.find('[data-testid="archive-batch-purge-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('1 项') // 待发态精简文案（垃圾桶图标承载删除语义）
    wrapper.unmount()
  })

  it('staging 条目体积按原文件计（磁盘上是明文）', async () => {
    const staging: ArchiveSummary = {
      sessionId: 'arc-staging',
      name: '压缩中',
      originalFile: 'f.jsonl',
      cwd: '/p',
      archivedAt: hoursAgo(2),
      rawBytes: 5 * MB,
      status: 'staging',
      summary: null,
    }
    const wrapper = mountList([staging])

    await wrapper.find('[data-testid="archive-filter-d1"]').trigger('click')

    expect(wrapper.find('[data-testid="archive-list-count"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="archive-total-size"]').text()).toBe('5.0 MB') // rawBytes 而非（不存在的）compressedBytes
    wrapper.unmount()
  })

  it('批量清理两段确认：首击进确认态（完整文案防误触）不 emit；再击 emit purgeBatch 携带可见条目', async () => {
    const entries = makeFourBuckets().filter((a) => a.sessionId === 'arc-older')
    const wrapper = mountList(makeFourBuckets())
    await wrapper.find('[data-testid="archive-filter-older"]').trigger('click')
    const btn = wrapper.find('[data-testid="archive-batch-purge-btn"]')

    await btn.trigger('click')
    expect(btn.text()).toBe('确认删除 1 项？')
    expectConfirmDangerStyle(btn) // 同行级钮：确认态实底红（悬停压色 + 实底前景字色）
    expect(wrapper.emitted('purgeBatch')).toBeUndefined()

    await btn.trigger('click')
    expect(wrapper.emitted('purgeBatch')).toEqual([[entries]])
    expect(btn.classes()).not.toContain('bg-danger')
    wrapper.unmount()
  })

  it('档位切换复位确认态；批量在途（batchPurging）钮禁用', async () => {
    const wrapper = mountList(makeFourBuckets())
    await wrapper.find('[data-testid="archive-filter-older"]').trigger('click')
    const btn = wrapper.find('[data-testid="archive-batch-purge-btn"]')

    await btn.trigger('click') // 进入确认态
    await wrapper.find('[data-testid="archive-filter-d1"]').trigger('click') // 切档复位
    const btn2 = wrapper.find('[data-testid="archive-batch-purge-btn"]')
    expect(btn2.text()).toBe('1 项') // 回到待发态（非确认态）
    expect(wrapper.emitted('purgeBatch')).toBeUndefined()

    await wrapper.setProps({ batchPurging: true })
    expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('确认态下钮经后台刷新卸载重现：确认态随卸载复位，重现后首击不得执行', async () => {
    // 快照数组只构造一次复用（hoursAgo 依赖 Date.now()，两次构造毫秒不同会破坏 toEqual 比对）
    const buckets = makeFourBuckets()
    const entries = buckets.filter((a) => a.sessionId === 'arc-older')
    const wrapper = mountList(buckets)
    await wrapper.find('[data-testid="archive-filter-older"]').trigger('click')
    await wrapper.find('[data-testid="archive-batch-purge-btn"]').trigger('click') // 进入确认态
    expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').text()).toBe('确认删除 1 项？')

    // 后台刷新序列（归档域广播 → refreshArchives）：可见集空 → 钮卸载；快照恢复 → 钮重现
    await wrapper.setProps({ archives: [] })
    expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').exists()).toBe(false)
    await wrapper.setProps({ archives: buckets })
    const btn = wrapper.find('[data-testid="archive-batch-purge-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('1 项') // 重现为待发态，不携带 danger 确认态

    await btn.trigger('click') // 重现后首击：两段确认的第一段，不得执行
    expect(wrapper.emitted('purgeBatch')).toBeUndefined()
    expect(btn.text()).toBe('确认删除 1 项？') // 首击进确认态

    await btn.trigger('click') // 再击确认才执行
    expect(wrapper.emitted('purgeBatch')).toEqual([[entries]])
    wrapper.unmount()
  })

  it('筛选档下无结果：空态文案区分（「该时间范围内暂无归档」+ 专属 testid；总体积「—」）', async () => {
    const wrapper = mountList([makeArchived({ archivedAt: hoursAgo(12 * 24) })])

    await wrapper.find('[data-testid="archive-filter-d1"]').trigger('click')

    expect(wrapper.find('[data-testid="archive-list-empty-filtered"]').text()).toContain('该时间范围内暂无归档')
    expect(wrapper.find('[data-testid="archive-list-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="archive-total-size"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="archive-batch-purge-btn"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
