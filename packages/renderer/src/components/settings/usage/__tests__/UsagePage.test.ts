/**
 * settings/usage 家族 colocated 合并产物（round5-f C1；round5-h 追加 filters 节）。
 *
 * 来源（本目录同源七件，全部零 vi.mock、环境均为 vitest 默认）：
 *   - UsageDailyChart.test.ts（SVG 结构 + hover 交互 + 峰值标注 + 容器自适应/卸载）
 *   - UsageDetailTable.test.ts（分组折叠交互 + 合计行 + groups 刷新重置 D5 + 取色 V4）
 *   - UsageHeatCalendar.test.ts（16 周网格 + 分档着色 + hover tooltip）
 *   - UsageModelRank.test.ts（排名渲染 + isolate 单看交互 + 复合键行标识）
 *   - UsagePage.test.ts（页面四态 + 重试交互；SettingsTransport seam 桩经
 *     helpers/usage-page-mock 单源接线，调用收在节内保持原文件级作用域）
 *   - UsagePage.filters.test.ts（工具栏交互：图例过滤 / isolate 单看 / 指标与范围切换；
 *     全组件真实渲染 + fake timers 固定窗口，round5-h 并入）
 *   - UsageProjectRank.test.ts（排名渲染 + 堆叠条取色）
 *
 * 合并纪律：describe/it 名零改动；UsageDailyChart 节外包一层同名 describe 承接原
 * 文件级 beforeAll/afterAll（DOM 环境补丁只作用于本节）；UsageProjectRank 节私有
 * helper 改名（metrics→projMetrics、mountRank→mountProjRank）消除与
 * UsageModelRank 节的同名冲突；round5-h 追加的 UsagePage.filters 节整体包基名
 * describe（原文件级 beforeAll/afterAll 与 setupUsagePageTest 调用随节下沉，fake
 * timers 保持在各子 describe 的 beforeEach/afterEach 内）；vue-i18n 由
 * vitest.config.ts setupFiles 全局 mock。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { UsageRow, UsageStatsResult } from '@taiji/shared'
import { aggregate, newMetrics, accumulate } from '@taiji/core'
import type { DayView, AggMetrics, PerModelEntry, RankRow } from '@taiji/core'
import { mockedGetUsageStats, setupUsagePageTest } from '@/__tests__/helpers/usage-page-mock'

import UsageDailyChart from '../UsageDailyChart.vue'
import UsageDetailTable from '../UsageDetailTable.vue'
import UsageHeatCalendar from '../UsageHeatCalendar.vue'
import UsageModelRank from '../UsageModelRank.vue'
import UsagePage from '../UsagePage.vue'
import UsageProjectRank from '../UsageProjectRank.vue'

/* ════════ 来源：UsageDailyChart.test.ts ════════ */

/* ── DOM 环境补丁：ResizeObserver + clientWidth（仅本节，原文件级钩子下沉） ── */
describe('UsageDailyChart', () => {
  const clientWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

  /** 记录每个组件实例注册的 ResizeObserver 回调（测试手动派发 contentRect 变化） */
  const roCallbacks: ResizeObserverCallback[] = []
  /** disconnect 调用计数（unmount 时 onBeforeUnload 应断开观察者） */
  const roDisconnectSpy = vi.fn()

  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          roCallbacks.push(cb)
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {
          roDisconnectSpy()
        }
      },
    )
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 600,
    })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
    if (clientWidthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDesc)
  })

  /* ── props 构造 ── */

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

  /** 经真实 aggregate 管线构造 perDay/perProv（range=0 路径，不依赖当前日期）。 */
  function makeAgg(rows: UsageRow[], metric: 'tokens' | 'cost' = 'tokens') {
    return aggregate(rows, { offProv: new Set(), isolate: null, range: 0, metric })
  }

  /** 真实 aggregate 管线产出的 providerColors（p-big→p1、p-small→p2），与 UsagePage 传参同源 */
  function realColors(): Record<string, string> {
    return makeAgg([
      makeRow({ provider: 'p-big' }),
      makeRow({ provider: 'p-small', input: 10 }),
    ]).providerColors
  }

  /** 手工构造单日 DayView（峰值标注等用例需要精确控制每日值）。 */
  function day(dateStr: string, provs: Record<string, Partial<ReturnType<typeof newMetrics>>>): DayView {
    const provsFull: DayView['provs'] = {}
    const dTot = newMetrics()
    for (const [pid, u] of Object.entries(provs)) {
      const full = newMetrics()
      accumulate(full, { ...newMetrics(), ...u } as ReturnType<typeof newMetrics>)
      provsFull[pid] = full
      accumulate(dTot, full)
    }
    const [y, m, d] = dateStr.split('-').map(Number)
    return { date: new Date(y, m - 1, d), dateStr, provs: provsFull, dTot }
  }

  function mountChart(
    perDay: DayView[],
    metric: 'tokens' | 'cost' = 'tokens',
    providerColors: Record<string, string> = {},
  ) {
    return mount(UsageDailyChart, {
      props: {
        perDay,
        perProv: {},
        metric,
        providerColors,
      },
    })
  }

  describe('UsageDailyChart SVG 结构', () => {
    beforeEach(() => {
      roCallbacks.length = 0
    })

    it('同日双 provider → 4 条 gridline + 5 个 Y 轴刻度 + 底部 border + 2 段堆叠柱（色阶降序）', () => {
      const wrapper = mountChart(
        [day('2026-08-25', { 'p-big': { input: 800 }, 'p-small': { input: 200 } })],
        'tokens',
        realColors(),
      )

      const lines = wrapper.findAll('svg line')
      // 4 gridline + 1 底部 border
      expect(lines).toHaveLength(5)
      // Y 轴刻度 4 个 text（v-for i in 4，不含 0 刻度；此时无月份/峰值标注 text）
      const axisTexts = wrapper.findAll('svg text').map((n) => n.text())
      // maxVal=niceMax(1000)=1000 → 刻度 250/500/750/1k + 单月份标签 8月
      expect(axisTexts).toEqual(['250', '500', '750', '1k', '8月'])

      // 堆叠柱：两个 provider 两段 rect，色阶 p1/p2（值大者优先着色）
      const bars = wrapper.findAll('svg rect')
      expect(bars).toHaveLength(2)
      const fills = bars.map((b) => b.attributes('style')).sort()
      expect(fills[0]).toContain('var(--chart-p1)')
      expect(fills[1]).toContain('var(--chart-p2)')
    })

    it('cost 指标 → Y 轴刻度带 $ 前缀', () => {
      const wrapper = mountChart([day('2026-08-25', { 'p-big': { cost: 8 } })], 'cost')
      const axisTexts = wrapper.findAll('svg text')
      // 顶部刻度 = $8（niceMax(8)=10 → 刻度 0/2.5/5/7.5/10）
      expect(axisTexts.some((n) => n.text() === '$10')).toBe(true)
      expect(axisTexts.some((n) => n.text().startsWith('$'))).toBe(true)
    })

    it('跨月 perDay → 月份标签渲染 7月 / 8月', () => {
      const wrapper = mountChart([
        day('2026-07-30', { 'p-big': { input: 100 } }),
        day('2026-07-31', { 'p-big': { input: 100 } }),
        day('2026-08-01', { 'p-big': { input: 100 } }),
      ])
      const texts = wrapper.findAll('svg text').map((n) => n.text())
      expect(texts).toContain('7月')
      expect(texts).toContain('8月')
    })

    it('空 perDay → 无柱形、无月份标签、无峰值标注', () => {
      const wrapper = mountChart([])
      expect(wrapper.findAll('svg rect')).toHaveLength(0)
      // 只剩 4 个 Y 轴刻度（maxVal 回退 niceMax(0)=1，不崩溃），无月份标签
      const texts = wrapper.findAll('svg text').map((n) => n.text())
      expect(texts).toHaveLength(4)
      expect(texts).not.toContain('7月')
      expect(texts).not.toContain('8月')
      expect(wrapper.find('svg polygon').exists()).toBe(false)
    })
  })

  describe('UsageDailyChart hover tooltip', () => {
    it('mousemove 到首列 → tooltip 显示日期/总量/provider 行/输入/缓存命中/输出', async () => {
      const wrapper = mountChart([
        day('2026-08-25', { 'p-big': { input: 3000, output: 1000, cacheRead: 2000 } }),
        day('2026-08-26', { 'p-big': { input: 10 } }),
      ])

      // width=600, padL=48, plotW=540, 2 天 slot=270 → clientX=100 命中第 0 列
      await wrapper.find('svg').trigger('mousemove', { clientX: 100, clientY: 60 })

      const tip = wrapper.find('div.absolute')
      expect(tip.exists()).toBe(true)
      const text = tip.text()
      // 日期 + 周二（2026-08-25）
      expect(text).toContain('2026-08-25')
      expect(text).toContain('周二')
      // provider 行出现 pid
      expect(text).toContain('p-big')
      // 输入/缓存命中/输出三值区（i18n zh-CN）
      expect(text).toContain('输入')
      expect(text).toContain('缓存命中')
      expect(text).toContain('输出')
      // 总量 3000+1000+2000=6k（tokens 指标 fmtInt）
      expect(text).toContain('6,000')

      // hover 列高亮 rect 出现（带 hover-col class）
      const hoverCol = wrapper.findAll('svg rect').find((n) => n.classes().includes('hover-col'))
      expect(hoverCol).toBeDefined()
    })

    it('cost 指标 hover → 总量按 fmtUSD 展示且 provider 行带百分比（tooltip 行取色同源 V4）', async () => {
      const wrapper = mountChart(
        [day('2026-08-25', { 'p-big': { cost: 6 }, 'p-small': { cost: 3 } })],
        'cost',
        realColors(),
      )
      await wrapper.find('svg').trigger('mousemove', { clientX: 100, clientY: 60 })

      const tip = wrapper.find('div.absolute')
      expect(tip.exists()).toBe(true)
      // 总量 $9.00；占比 66.7% / 33.3%
      expect(tip.text()).toContain('$9.00')
      expect(tip.text()).toContain('66.7%')
      expect(tip.text()).toContain('33.3%')

      // V4：tooltip 行色块与堆叠柱同源（providerColors 降序 → p-big=p1、p-small=p2）
      const tipDots = tip.findAll('span.w-2')
      expect(tipDots).toHaveLength(2)
      expect(tipDots[0].attributes('style')).toContain('background: var(--chart-p1)')
      expect(tipDots[1].attributes('style')).toContain('background: var(--chart-p2)')
    })

    it('mousemove 移出数据列（x < padL）→ tooltip 不出现；mouseleave → 关闭', async () => {
      const wrapper = mountChart([day('2026-08-25', { 'p-big': { input: 100 } })])

      // 靠左 padding 区：idx<0 → 无 tooltip
      await wrapper.find('svg').trigger('mousemove', { clientX: 10, clientY: 60 })
      expect(wrapper.find('div.absolute').exists()).toBe(false)

      // 命中列出现后再 mouseleave 消失
      await wrapper.find('svg').trigger('mousemove', { clientX: 100, clientY: 60 })
      expect(wrapper.find('div.absolute').exists()).toBe(true)
      await wrapper.find('svg').trigger('mouseleave')
      expect(wrapper.find('div.absolute').exists()).toBe(false)
    })
  })

  describe('UsageDailyChart 峰值标注', () => {
    it('n>=14 天 → 峰值日三角 polygon + MM/DD 文本指向最大值日', () => {
      const perDay: DayView[] = []
      for (let i = 1; i <= 14; i++) {
        const dateStr = `2026-08-${String(i).padStart(2, '0')}`
        // 08-08 为峰值
        perDay.push(day(dateStr, { 'p-big': { input: i === 8 ? 5000 : 100 } }))
      }
      const wrapper = mountChart(perDay)

      const polygon = wrapper.find('svg polygon')
      expect(polygon.exists()).toBe(true)
      expect(polygon.attributes('points')).toBeTruthy()
      // 峰值日文本 8/8
      const texts = wrapper.findAll('svg text').map((n) => n.text())
      expect(texts).toContain('8/8')
    })

    it('n<14 天 → 不显示峰值标注（即使有峰值）', () => {
      const perDay = [day('2026-08-01', { 'p-big': { input: 100 } }), day('2026-08-02', { 'p-big': { input: 900 } })]
      const wrapper = mountChart(perDay)
      expect(wrapper.find('svg polygon').exists()).toBe(false)
    })
  })

  describe('UsageDailyChart 容器自适应与卸载', () => {
    beforeEach(() => {
      roCallbacks.length = 0
    })

    it('ResizeObserver 派发更窄宽度 → gridline 右端随 plotW 收窄', async () => {
      const wrapper = mountChart([day('2026-08-25', { 'p-big': { input: 900 } })])
      expect(roCallbacks.length).toBeGreaterThanOrEqual(1)

      // 容器从 600 收窄到 480：x2 = width - padR = 480 - 12
      roCallbacks[roCallbacks.length - 1]([{ contentRect: { width: 480 } } as unknown as ResizeObserverEntry])
      await wrapper.vm.$nextTick()

      const gridline = wrapper.findAll('svg line')[0]
      expect(gridline.attributes('x2')).toBe('468')
    })

    it('unmount → 图表从文档移除且观察者断开', () => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const wrapper = mount(UsageDailyChart, {
        props: {
          perDay: [day('2026-08-25', { 'p-big': { input: 900 } })],
          perProv: {},
          metric: 'tokens',
          providerColors: realColors(),
        },
        attachTo: host,
      })
      expect(host.querySelector('svg')).not.toBeNull()

      wrapper.unmount()
      // 图表节点从文档移除
      expect(host.querySelector('svg')).toBeNull()
      // onBeforeUnmount 断开 ResizeObserver（无泄漏观察者）
      expect(roDisconnectSpy).toHaveBeenCalled()
      document.body.removeChild(host)
    })
  })
})

/* ════════ 来源：UsageDetailTable.test.ts ════════ */

/** 构造单 provider 分组（含 1 个 model 行）。 */
function group(pid: string, input: number, model: string): {
  pid: string
  u: AggMetrics
  models: { model: string; u: AggMetrics }[]
} {
  const u = newMetrics()
  accumulate(u, { ...newMetrics(), input } as AggMetrics)
  return { pid, u, models: [{ model, u }] }
}

function mountTable(groups: ReturnType<typeof group>[], tot: AggMetrics, providerColors: Record<string, string> = {}) {
  return mount(UsageDetailTable, { props: { groups, tot, providerColors } })
}

describe('UsageDetailTable 分组折叠', () => {
  const groups = [
    group('p1', 300, 'm1'),
    group('p2', 200, 'm2'),
    group('p3', 100, 'm3'),
  ]
  const tot = newMetrics()
  accumulate(tot, { ...newMetrics(), input: 600 } as AggMetrics)

  it('前两组默认展开、第三组默认收起', () => {
    const wrapper = mountTable(groups, tot)
    const text = wrapper.text()
    expect(text).toContain('m1')
    expect(text).toContain('m2')
    expect(text).not.toContain('m3')
    // 分组头显示 provider 名与模型计数
    expect(text).toContain('p1')
    expect(text).toContain('p3')
  })

  it('点击第一组分组头 → 折叠（m1 消失）；再点 → 展开', async () => {
    const wrapper = mountTable(groups, tot)
    const header1 = wrapper.findAll('div.cursor-pointer')[0]

    await header1.trigger('click')
    expect(wrapper.text()).not.toContain('m1')
    expect(wrapper.text()).toContain('m2') // 其他组不受影响

    await header1.trigger('click')
    expect(wrapper.text()).toContain('m1')
  })

  it('点击第三组分组头 → 展开（m3 出现）', async () => {
    const wrapper = mountTable(groups, tot)
    const header3 = wrapper.findAll('div.cursor-pointer')[2]

    await header3.trigger('click')
    expect(wrapper.text()).toContain('m3')
  })

  it('合计行渲染总 token（千分位）与总费用', () => {
    const t = newMetrics()
    accumulate(t, { ...newMetrics(), input: 1234, cost: 2.5 } as AggMetrics)
    const wrapper = mountTable([group('p1', 1234, 'm1')], t)
    const text = wrapper.text()
    expect(text).toContain('合计')
    expect(text).toContain('1,234')
    expect(text).toContain('$2.50')
  })

  it('分组头色点取色来自 providerColors 映射（V4：同 pid 同色）', () => {
    const wrapper = mountTable(groups, tot, { p1: 'var(--chart-p1)', p2: 'var(--chart-p2)', p3: 'var(--chart-p3)' })
    const dots = wrapper.findAll('span.size-2')
    expect(dots).toHaveLength(3)
    expect(dots[0].attributes('style')).toContain('background: var(--chart-p1)')
    expect(dots[1].attributes('style')).toContain('background: var(--chart-p2)')
    expect(dots[2].attributes('style')).toContain('background: var(--chart-p3)')
  })
})

describe('UsageDetailTable groups 刷新重置展开态（D5）', () => {
  const groupsA = [group('p1', 300, 'm1'), group('p2', 200, 'm2'), group('p3', 100, 'm3')]
  const tot = newMetrics()
  accumulate(tot, { ...newMetrics(), input: 600 } as AggMetrics)

  it('用户改过展开态后 groups 换新引用 → 重置为新 groups 前两组展开', async () => {
    const wrapper = mountTable(groupsA, tot)
    // 收起第一组（展开态被用户改动）
    await wrapper.findAll('div.cursor-pointer')[0].trigger('click')
    expect(wrapper.text()).not.toContain('m1')

    // 数据刷新：groups 换成不同 pid 的新引用 → 重置为新前两组展开（q1/q2 模型行直接可见）
    const groupsB = [group('q1', 500, 'x1'), group('q2', 400, 'x2'), group('q3', 300, 'x3')]
    await wrapper.setProps({ groups: groupsB })
    expect(wrapper.text()).toContain('x1')
    expect(wrapper.text()).toContain('x2')
    expect(wrapper.text()).not.toContain('x3')
  })

  it('同 pid 新数组刷新后同样重置（旧折叠态不残留）', async () => {
    const wrapper = mountTable(groupsA, tot)
    await wrapper.findAll('div.cursor-pointer')[0].trigger('click')
    expect(wrapper.text()).not.toContain('m1')

    // 同 pid、新数组引用（筛选变化后 groups 重算的形态）→ 展开态仍重置为前两组
    const refreshed = [group('p1', 300, 'm1'), group('p2', 200, 'm2'), group('p3', 100, 'm3')]
    await wrapper.setProps({ groups: refreshed })
    expect(wrapper.text()).toContain('m1')
    expect(wrapper.text()).toContain('m2')
  })
})

/* ════════ 来源：UsageHeatCalendar.test.ts ════════ */

function mountCalendar(heatmapData: Map<string, number>) {
  return mount(UsageHeatCalendar, { props: { heatmapData } })
}

/** 网格容器（grid-auto-flow:column 的 112 格容器）。 */
function gridCells(wrapper: ReturnType<typeof mountCalendar>) {
  return wrapper.find('div[style*="grid-auto-flow"]').findAll('div')
}

describe('UsageHeatCalendar 网格渲染', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0)) // 2026-08-25 周二
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('16 周 × 7 天 = 112 格；月份标签覆盖 5..8 月；星期标签 一/三/五；底部图例 少/多', () => {
    const wrapper = mountCalendar(new Map())
    expect(gridCells(wrapper)).toHaveLength(112)

    // 月份标签：窗口 2026-05-11..08-30 → 5/6/7/8 四个月
    const monthRow = wrapper.find('div.relative')
    const monthTexts = monthRow.findAll('span').map((n) => n.text())
    expect(monthTexts).toEqual(['5月', '6月', '7月', '8月'])

    // 星期标签（i18n zh-CN）
    const wrapperText = wrapper.text()
    expect(wrapperText).toContain('一')
    expect(wrapperText).toContain('三')
    expect(wrapperText).toContain('五')
    // 底部图例
    expect(wrapperText).toContain('少')
    expect(wrapperText).toContain('多')
  })

  it('有数格按分位档着色：峰值 heat-5、低值 heat-1、无数据 heat-0、未来格降透明度', () => {
    const wrapper = mountCalendar(
      new Map([
        ['2026-08-25', 5000], // 峰值 → heat-5
        ['2026-08-24', 100], // 低值 → heat-1
        ['2026-05-11', 100], // 低值 → heat-1
      ]),
    )
    const cells = gridCells(wrapper)
    const byLevel = (cls: string) => cells.filter((n) => n.classes().includes(cls))
    expect(byLevel('bg-[var(--heat-5)]')).toHaveLength(1)
    expect(byLevel('bg-[var(--heat-1)]')).toHaveLength(2)
    expect(byLevel('bg-[var(--heat-0)]')).toHaveLength(112 - 3)
    // 未来格（2026-08-26..30 共 5 格）降透明度
    expect(cells.filter((n) => n.classes().includes('opacity-[0.28]'))).toHaveLength(5)
  })

  it('mouseenter 有数格 → tooltip 显示日期 + 周几 + token 数；mouseleave → 关闭', async () => {
    const wrapper = mountCalendar(new Map([['2026-08-25', 5000]]))

    // 2026-08-25 是窗口内第 15 周 × 7 + 第 1 天 = 索引 15*7+1=106
    await gridCells(wrapper)[106].trigger('mouseenter', { clientX: 20, clientY: 30 })

    const tip = document.body.querySelector('div.fixed')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('2026-08-25')
    expect(tip!.textContent).toContain('周二')
    expect(tip!.textContent).toContain('5,000')
    expect(tip!.textContent).toContain('tokens')

    await gridCells(wrapper)[106].trigger('mouseleave')
    expect(document.body.querySelector('div.fixed')).toBeNull()
  })

  it('mouseenter 空格 → tooltip 显示「无消耗」', async () => {
    const wrapper = mountCalendar(new Map([['2026-08-25', 5000]]))

    await gridCells(wrapper)[0].trigger('mouseenter', { clientX: 20, clientY: 30 })
    const tip = document.body.querySelector('div.fixed')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('2026-05-11')
    expect(tip!.textContent).toContain('无消耗')
  })
})

/* ════════ 来源：UsageModelRank.test.ts ════════ */

function metrics(input: number, cost = 0): AggMetrics {
  const u = newMetrics()
  accumulate(u, { ...newMetrics(), input, cost } as AggMetrics)
  return u
}

/** 复合键值结构条目 */
function entry(provider: string, model: string, input: number, cost = 0): PerModelEntry {
  return { provider, model, u: metrics(input, cost) }
}

function mountRank(
  perModel: Record<string, PerModelEntry>,
  isolate: string | null = null,
  providerColors: Record<string, string> = {},
) {
  return mount(UsageModelRank, {
    props: {
      perModel,
      metric: 'tokens' as const,
      isolate,
      providerColors,
    },
  })
}

describe('UsageModelRank 排名渲染', () => {
  it('按 token 降序渲染 01/02 序号与 provider/model 分量文本', () => {
    const wrapper = mountRank({
      'p2/small': entry('p2', 'small', 100),
      'p1/big': entry('p1', 'big', 900),
    })
    const text = wrapper.text()
    expect(text).toContain('01')
    expect(text).toContain('02')
    // 排名靠前的 big 模型整行在前
    expect(text.indexOf('big')).toBeLessThan(text.indexOf('small'))
    // 分量渲染（provider 灰前缀 + 裸 model）
    expect(text).toContain('p1/big')
    expect(text).toContain('p2/small')
  })

  it('跨 provider 同名模型 → 两行独立（复合键行标识区分 testid）', () => {
    const wrapper = mountRank({
      'p1/m': entry('p1', 'm', 100),
      'p2/m': entry('p2', 'm', 300),
    })
    expect(wrapper.find('[data-testid="usage-model-p1/m"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-model-p2/m"]').exists()).toBe(true)
  })

  it('条形取色来自 providerColors 映射（V4：同 provider 同色）', () => {
    const wrapper = mountRank(
      {
        'p1/big': entry('p1', 'big', 900),
        'p2/small': entry('p2', 'small', 100),
      },
      null,
      { p1: 'var(--chart-p1)', p2: 'var(--chart-p2)' },
    )
    const fills = wrapper.findAll('span.absolute')
    expect(fills).toHaveLength(2)
    // 排名降序：p1/big(900) 在前 → 第一条 p1 色，第二条 p2 色
    expect(fills[0].attributes('style')).toContain('background: var(--chart-p1)')
    expect(fills[1].attributes('style')).toContain('background: var(--chart-p2)')
  })
})

describe('UsageModelRank isolate 单看交互', () => {
  it('点击行 → emit update:isolate(复合键)', async () => {
    const wrapper = mountRank({ 'p1/big': entry('p1', 'big', 900) })
    await wrapper.find('[data-testid="usage-model-p1/big"]').trigger('click')
    expect(wrapper.emitted('update:isolate')).toEqual([['p1/big']])
  })

  it('isolate 态再点同一行 → emit update:isolate(null)，行高亮 accent（复合键比较）', async () => {
    const wrapper = mountRank({ 'p1/big': entry('p1', 'big', 900) }, 'p1/big')
    const row = wrapper.find('[data-testid="usage-model-p1/big"]')
    // 选中行 accent 高亮
    expect(row.classes()).toContain('bg-[var(--accent-soft)]')

    await row.trigger('click')
    expect(wrapper.emitted('update:isolate')).toEqual([[null]])
  })

  it('isolate 指向另一复合键 → 当前行不高亮（同名模型不串高亮）', () => {
    const wrapper = mountRank(
      {
        'p1/m': entry('p1', 'm', 100),
        'p2/m': entry('p2', 'm', 300),
      },
      'p2/m',
    )
    expect(wrapper.find('[data-testid="usage-model-p2/m"]').classes()).toContain('bg-[var(--accent-soft)]')
    expect(wrapper.find('[data-testid="usage-model-p1/m"]').classes()).not.toContain('bg-[var(--accent-soft)]')
  })
})

/* ════════ 来源：UsagePage.test.ts（主文件） ════════ */

/** 构造 n 天前的本地日期串（YYYY-MM-DD）。页面默认 range=30 按当天滚动构造窗口，写死日期会在 30 天后滑出窗口静默变红——测试日期一律相对当天。 */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 构造单条用量行（指标默认非零，便于聚合管线走正常分支）。 */
function makeRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 300,
    costUSD: 0.01,
    messages: 2,
    date: daysAgo(1),
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
  // [C3] getUsageStats seam 桩接线单源在 helpers/usage-page-mock；
  // 调用收在节内（原文件为单文件顶层，语义等价于只对本节 beforeEach 生效）
  setupUsagePageTest()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('数据态：含 compaction 桶（cost=0）的 rows → 登记清单 + 明细区 + 切换器渲染', async () => {
    mockedGetUsageStats.mockResolvedValue(
      makeResult(
        [
          makeRow({
            date: daysAgo(2),
            provider: 'kimi-coding',
            model: 'k3',
            project: 'taiji',
            costUSD: 0.42,
          }),
          makeRow({ date: daysAgo(1), provider: 'anthropic', model: 'claude-x', costUSD: 0 }),
          // compaction 虚拟桶：provider/model 固定 'compaction'，费用记 0（D1/D2）
          makeRow({
            date: daysAgo(1),
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
    // 摘要登记清单 + 明细登记清单区
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

/* ════════ 来源：UsageProjectRank.test.ts（私有 helper 改名消冲突：metrics→projMetrics、mountRank→mountProjRank） ════════ */

function projMetrics(input: number, cost = 0): AggMetrics {
  const u = newMetrics()
  accumulate(u, { ...newMetrics(), input, cost } as AggMetrics)
  return u
}

function row(name: string, provs: Record<string, AggMetrics>): RankRow {
  const total = newMetrics()
  for (const u of Object.values(provs)) accumulate(total, u)
  return { name, metrics: total, provs }
}

function mountProjRank(
  projects: RankRow[],
  metric: 'tokens' | 'cost' = 'tokens',
  providerColors: Record<string, string> = {},
) {
  return mount(UsageProjectRank, {
    props: {
      projects,
      metric,
      totalMetric: projects.reduce((s, r) => s + (r.metrics.input + r.metrics.output + r.metrics.cacheRead + r.metrics.cacheWrite), 0),
      providerColors,
    },
  })
}

describe('UsageProjectRank 排名渲染', () => {
  it('按传入顺序渲染 01/02 序号 + 项目名 + 数值文本', () => {
    const wrapper = mountProjRank([
      row('beta', { p1: projMetrics(100) }),
      row('alpha', { p1: projMetrics(900) }),
    ])
    const text = wrapper.text()
    expect(text).toContain('01')
    expect(text).toContain('02')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    // alpha 行 900 tokens（fmtCompact 千位缩写）
    expect(text).toContain('900')
  })

  it('条形取色来自 providerColors 映射（V4：同 provider 同色，段按占比降序）', () => {
    const wrapper = mountProjRank(
      [row('demo', { p1: projMetrics(900), p2: projMetrics(100) })],
      'tokens',
      { p1: 'var(--chart-p1)', p2: 'var(--chart-p2)' },
    )
    const track = wrapper.find('span.stack-track')
    // 段 span = h-full + shrink-0（外层轨道容器 span.flex.h-full 不带 shrink-0，不误命中）
    const segs = track.findAll('span.h-full.shrink-0')
    expect(segs).toHaveLength(2)
    // 占比降序：p1(90%) 在前 → 第一段 p1 色，第二段 p2 色
    expect(segs[0].attributes('style')).toContain('background: var(--chart-p1)')
    expect(segs[1].attributes('style')).toContain('background: var(--chart-p2)')
  })
})

/* ════════ 来源：UsagePage.filters.test.ts（round5-h 追加节） ════════ */

describe('UsagePage.filters', () => {
  // [C3] getUsageStats seam 桩接线单源在 helpers/usage-page-mock；调用收在节内
  //（与上方 UsagePage 主节同款处理，beforeEach 按节作用域叠加执行）
  setupUsagePageTest()

  /* ── DOM 环境补丁：ResizeObserver + clientWidth（图表真实渲染；原文件级钩子下沉节内） ── */
  const clientWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 600,
    })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
    if (clientWidthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDesc)
  })

  /** 构造单条用量行。 */
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

  function makeResult(rows: UsageRow[], sessionCount = rows.length): UsageStatsResult {
    return { rows, sessionCount, skippedLines: 0, scannedAt: Date.now() }
  }

  /** 三 provider × 三 model 的当日数据（图例过滤 / isolate 联动用）。 */
  function threeProviderRows(): UsageRow[] {
    return [
      makeRow({ provider: 'p1', model: 'm1', input: 300 }),
      makeRow({ provider: 'p2', model: 'm2', input: 200 }),
      makeRow({ provider: 'p3', model: 'm3', input: 100 }),
    ]
  }

  async function mountPage(rows: UsageRow[]) {
    mockedGetUsageStats.mockResolvedValue(makeResult(rows))
    const wrapper = mount(UsagePage)
    await flushPromises()
    return wrapper
  }

  describe('UsagePage 图例过滤交互', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0))
    })
    afterEach(() => {
      vi.useRealTimers()
      document.body.innerHTML = ''
    })

    it('点击 legend chip 关闭 provider → chip 置灰保留原位、可单独恢复；「至少保留一个」检查生效', async () => {
      const wrapper = await mountPage(threeProviderRows())

      // 初始三个图例 chip 齐全且均未置灰（perProvFull 全量恒显）
      for (const pid of ['p1', 'p2', 'p3']) {
        const chip = wrapper.find(`[data-testid="usage-legend-${pid}"]`)
        expect(chip.exists()).toBe(true)
        expect(chip.classes()).not.toContain('opacity-[0.38]')
      }

      // 关闭 p1 → chip 置灰（opacity-[0.38]）但保留原位：DOM 中仍在且顺序不变（排除 reset 按钮）
      await wrapper.find('[data-testid="usage-legend-p1"]').trigger('click')
      const order = wrapper
        .findAll('[data-testid^="usage-legend-"]')
        .map((n) => n.attributes('data-testid'))
        .filter((tid) => tid !== 'usage-legend-reset')
      expect(order).toEqual(['usage-legend-p1', 'usage-legend-p2', 'usage-legend-p3'])
      expect(wrapper.find('[data-testid="usage-legend-p1"]').classes()).toContain('opacity-[0.38]')
      expect(wrapper.find('[data-testid="usage-legend-p2"]').classes()).not.toContain('opacity-[0.38]')

      // 可单独恢复：再点 p1 → 置灰解除
      await wrapper.find('[data-testid="usage-legend-p1"]').trigger('click')
      expect(wrapper.find('[data-testid="usage-legend-p1"]').classes()).not.toContain('opacity-[0.38]')

      // 连关 p1、p2 后仅剩 p3 启用 → 检查拦截 p3 的关闭（不置灰，基数 = perProvFull 全量三 provider）
      await wrapper.find('[data-testid="usage-legend-p1"]').trigger('click')
      await wrapper.find('[data-testid="usage-legend-p2"]').trigger('click')
      expect(wrapper.find('[data-testid="usage-legend-p1"]').classes()).toContain('opacity-[0.38]')
      expect(wrapper.find('[data-testid="usage-legend-p2"]').classes()).toContain('opacity-[0.38]')
      expect(wrapper.find('[data-testid="usage-legend-p3"]').classes()).not.toContain('opacity-[0.38]')
    })

    it('关闭 provider 后 reset 按钮出现，点击后置灰全部解除', async () => {
      const wrapper = await mountPage([
        makeRow({ provider: 'p1', model: 'm1' }),
        makeRow({ provider: 'p2', model: 'm2' }),
      ])

      // 无过滤时不显示重置
      expect(wrapper.find('[data-testid="usage-legend-reset"]').exists()).toBe(false)

      await wrapper.find('[data-testid="usage-legend-p1"]').trigger('click')
      // chip 置灰保留，reset 出现
      expect(wrapper.find('[data-testid="usage-legend-p1"]').classes()).toContain('opacity-[0.38]')
      const reset = wrapper.find('[data-testid="usage-legend-reset"]')
      expect(reset.exists()).toBe(true)
      expect(reset.text()).toContain('重置')

      await reset.trigger('click')
      expect(wrapper.find('[data-testid="usage-legend-p1"]').classes()).not.toContain('opacity-[0.38]')
      expect(wrapper.find('[data-testid="usage-legend-reset"]').exists()).toBe(false)
    })
  })

  describe('UsagePage isolate 单看交互', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0))
    })
    afterEach(() => {
      vi.useRealTimers()
      document.body.innerHTML = ''
    })

    it('点击模型行 → isolate chip 出现（分量渲染）；点击 clear → 消失', async () => {
      const wrapper = await mountPage([
        makeRow({ provider: 'p1', model: 'm1' }),
        makeRow({ provider: 'p2', model: 'm2' }),
      ])

      // 点击模型谱第一行（真实 UsageModelRank 渲染，按值降序 m1 在前；行 testid = 复合键）
      await wrapper.find('[data-testid="usage-model-p1/m1"]').trigger('click')
      const chip = wrapper.find('[data-testid="usage-isolate-chip"]')
      expect(chip.exists()).toBe(true)
      // chip 展示 provider 灰前缀 + 裸 model 分量（不显示裸复合键串之外的额外内容）
      expect(chip.text()).toContain('p1/m1')

      // 再点同一行 → isolate 取消（emit null）
      await wrapper.find('[data-testid="usage-model-p1/m1"]').trigger('click')
      expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(false)

      // 重新 isolate 后通过 clear 按钮清除
      await wrapper.find('[data-testid="usage-model-p1/m1"]').trigger('click')
      await wrapper.find('[data-testid="usage-isolate-clear"]').trigger('click')
      expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(false)
    })

    it('isolate 单看时图例仍显示全部 provider chips（恒显）', async () => {
      const wrapper = await mountPage(threeProviderRows())

      await wrapper.find('[data-testid="usage-model-p1/m1"]').trigger('click')
      expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(true)

      // isolate 生效后图例仍显示全部 provider（含非当前模型所属）
      for (const pid of ['p1', 'p2', 'p3']) {
        expect(wrapper.find(`[data-testid="usage-legend-${pid}"]`).exists()).toBe(true)
      }
    })

    it('关闭 isolate 模型所属 provider → isolate 联动清除（chip 消失）；关其他 provider 不误清', async () => {
      // 三 provider fixture：关 p2 后 p1 非最后一个启用 provider，不被「至少保留一个」检查拦截
      const wrapper = await mountPage(threeProviderRows())

      await wrapper.find('[data-testid="usage-model-p1/m1"]').trigger('click')
      expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(true)

      // 负例：关闭非 isolate 所属 provider（p2）→ isolate 保留（复合键查表不误清）
      await wrapper.find('[data-testid="usage-legend-p2"]').trigger('click')
      expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(true)

      // m1 属于 p1（全量 rows 派生的复合键表）：关闭 p1 → isolate 同步清空
      await wrapper.find('[data-testid="usage-legend-p1"]').trigger('click')
      expect(wrapper.find('[data-testid="usage-isolate-chip"]').exists()).toBe(false)
    })
  })

  describe('UsagePage 指标/范围切换', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0))
    })
    afterEach(() => {
      vi.useRealTimers()
      document.body.innerHTML = ''
    })

    it('指标切到 cost → 每日图 Y 轴刻度带 $ 前缀', async () => {
      const wrapper = await mountPage([makeRow({ provider: 'p1', model: 'm1', costUSD: 8 })])

      // tokens 指标：刻度无 $ 前缀
      const textsBefore = wrapper.findAll('svg text').map((n) => n.text())
      expect(textsBefore.some((t) => t.startsWith('$'))).toBe(false)

      await wrapper.find('[data-testid="usage-metric-cost"]').trigger('click')
      const textsAfter = wrapper.findAll('svg text').map((n) => n.text())
      // niceMax(8)=10 → 顶部刻度 $10
      expect(textsAfter).toContain('$10')
    })

    it('范围切到全部 → 30 天窗口外的 6 月数据出现月份标签', async () => {
      const wrapper = await mountPage([
        makeRow({ provider: 'p1', model: 'm1', date: '2026-06-15' }),
        makeRow({ provider: 'p1', model: 'm1', date: '2026-08-24' }),
      ])

      // 默认 30 天窗口：6 月数据在窗外，无 6月 标签
      expect(wrapper.findAll('svg text').map((n) => n.text())).not.toContain('6月')

      // 点击「全部」范围按钮
      const rangeAll = wrapper
        .findAll('[data-testid="usage-range-toggle"] button')
        .find((b) => b.text() === '全部')
      expect(rangeAll).toBeDefined()
      await rangeAll!.trigger('click')

      // 全量日期轴：6月 标签出现
      expect(wrapper.findAll('svg text').map((n) => n.text())).toContain('6月')
    })
  })
})
