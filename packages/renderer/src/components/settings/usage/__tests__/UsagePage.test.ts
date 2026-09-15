/**
 * UsagePage 首屏冒烟测试（用量统计页审查修复收尾）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsagePage.test.ts
 *
 * 覆盖页面四态 + 重试交互：
 *   - 数据态：rows 含 compaction 虚拟桶（costUSD=0，D1/D2）→ usage-ledger /
 *     usage-detail-section / metric·range 切换渲染
 *   - 全空态：rows=[] && sessionCount=0 → usage-empty-state（无「已扫描」行）
 *   - 零用量盲区：rows=[] && sessionCount>0（扫描过但无 usage 行）→ usage-empty-state
 *     且带「已扫描 {count} 个会话文件」（emptyScanned 分支）
 *   - 错误态：getUsageStats reject → usage-error-state + usage-retry-btn
 *   - 重试交互：点击 retry → getUsageStats 再次调用并恢复数据态
 *
 * mock 策略（对齐 PluginContributionsPage.test.ts 装配方式）：
 *   - vue-i18n 由 vitest.config.ts setupFiles（vitest-i18n-setup.ts）全局 mock，
 *     t() 从 zh-CN locale 取值，无需在测试里 app.use(i18n)
 *   - vi.mock('@taiji/core/transport/api/domains/usage') 替掉 WS RPC 门面（onMounted 即拉数据）
 *   - 仅 stub UsageDailyChart（内部用 ResizeObserver，happy-dom 无实现）；其余子组件
 *     （UsageLedger/UsageDetailTable 等）真实渲染，保证 testid 断言来自真实聚合管线
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { UsageRow, UsageStatsResult } from '@taiji/shared'

vi.mock('@taiji/core/transport/api/domains/usage', () => ({
  getUsageStats: vi.fn(),
}))

import UsagePage from '@/components/settings/usage/UsagePage.vue'
import { getUsageStats } from '@taiji/core/transport/api/domains/usage'

const mockedGetUsageStats = vi.mocked(getUsageStats)

/** 构造单条用量行（指标默认非零，便于聚合管线走正常分支）。 */
function makeRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 300,
    costUSD: 0.01,
    messages: 2,
    date: '2026-08-25',
    provider: 'anthropic',
    model: 'claude-x',
    project: 'demo',
    ...overrides,
  }
}

/** 构造 getStats 返回体。 */
function makeResult(rows: UsageRow[], sessionCount: number): UsageStatsResult {
  return {
    rows,
    sessionCount,
    skippedLines: 0,
    scannedAt: Date.now(),
  }
}

/** 挂载页面；只 stub ResizeObserver 依赖的图表子组件。 */
function mountPage() {
  return mount(UsagePage, {
    global: {
      stubs: {
        UsageDailyChart: { template: '<div />' },
      },
    },
  })
}

describe('UsagePage 首屏冒烟', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('数据态：含 compaction 桶（cost=0）的 rows → 台账 + 明细区 + 切换器渲染', async () => {
    mockedGetUsageStats.mockResolvedValue(
      makeResult(
        [
          makeRow({
            date: '2026-08-24',
            provider: 'kimi-coding',
            model: 'k3',
            project: 'taiji',
            costUSD: 0.42,
          }),
          makeRow({ date: '2026-08-25', provider: 'anthropic', model: 'claude-x', costUSD: 0 }),
          // compaction 虚拟桶：provider/model 固定 'compaction'，费用记 0（D1/D2）
          makeRow({
            date: '2026-08-25',
            provider: 'compaction',
            model: 'compaction',
            project: 'demo',
            costUSD: 0,
            messages: 1,
          }),
        ],
        2,
      ),
    )
    const wrapper = mountPage()
    await flushPromises()

    // 加载结束、无错误
    expect(wrapper.find('[data-testid="usage-error-state"]').exists()).toBe(false)
    // 摘要台账 + 明细台账区
    expect(wrapper.find('[data-testid="usage-ledger"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-detail-section"]').exists()).toBe(true)
    // 工具栏切换器
    expect(wrapper.find('[data-testid="usage-metric-toggle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-range-toggle"]').exists()).toBe(true)
    // compaction 虚拟桶进入图例 chips
    expect(wrapper.find('[data-testid="usage-legend-compaction"]').exists()).toBe(true)
    // 空态不渲染
    expect(wrapper.find('[data-testid="usage-empty-state"]').exists()).toBe(false)
  })

  it('全空态：rows=[] && sessionCount=0 → usage-empty-state（无「已扫描」行）', async () => {
    mockedGetUsageStats.mockResolvedValue(makeResult([], 0))
    const wrapper = mountPage()
    await flushPromises()

    const empty = wrapper.find('[data-testid="usage-empty-state"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('还没有会话记录')
    // 未扫描过任何 session：不带 emptyScanned 计数行
    expect(empty.text()).not.toContain('已扫描')
  })

  it('零用量盲区：rows=[] 但 sessionCount>0 → usage-empty-state 且带已扫描计数', async () => {
    // 扫描了 2 个 session 文件但没有任何 usage 行——与全空态共用 testid、不同文案分支
    mockedGetUsageStats.mockResolvedValue(makeResult([], 2))
    const wrapper = mountPage()
    await flushPromises()

    const empty = wrapper.find('[data-testid="usage-empty-state"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('已扫描 2 个会话文件')
  })

  it('错误态：getUsageStats reject → usage-error-state + usage-retry-btn + 错误文案', async () => {
    mockedGetUsageStats.mockRejectedValue(new Error('usage rpc down'))
    const wrapper = mountPage()
    await flushPromises()

    const errorBox = wrapper.find('[data-testid="usage-error-state"]')
    expect(errorBox.exists()).toBe(true)
    expect(errorBox.text()).toContain('usage rpc down')
    expect(wrapper.find('[data-testid="usage-retry-btn"]').exists()).toBe(true)
    // 数据态不渲染
    expect(wrapper.find('[data-testid="usage-ledger"]').exists()).toBe(false)
  })

  it('重试交互：点击 usage-retry-btn → getUsageStats 再次调用并恢复数据态', async () => {
    mockedGetUsageStats.mockRejectedValueOnce(new Error('usage rpc down'))
    mockedGetUsageStats.mockResolvedValue(makeResult([makeRow()], 1))
    const wrapper = mountPage()
    await flushPromises()

    expect(mockedGetUsageStats).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="usage-error-state"]').exists()).toBe(true)

    await wrapper.find('[data-testid="usage-retry-btn"]').trigger('click')
    await flushPromises()

    expect(mockedGetUsageStats).toHaveBeenCalledTimes(2)
    // 错误清除、恢复数据态
    expect(wrapper.find('[data-testid="usage-error-state"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="usage-ledger"]').exists()).toBe(true)
  })
})
